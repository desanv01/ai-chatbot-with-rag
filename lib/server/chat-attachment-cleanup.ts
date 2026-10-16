import 'server-only';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { RetryableError } from 'workflow';
import { createAdminClient } from '@/lib/server/admin';
import {
  CHAT_ATTACHMENTS_BUCKET,
  CHAT_ATTACHMENT_REFERENCE_PREFIX,
  parseChatAttachmentReference
} from '@/lib/server/chat-attachments';

type CleanupDatabase = {
  public: {
    Tables: {
      chat_attachment_objects: {
        Row: { object_path: string };
        Insert: { object_path: string };
        Update: { object_path?: string };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      claim_chat_attachment_maintenance: {
        Args: { p_run_id: string; p_previous_run_id: string | null };
        Returns: boolean;
      };
      claim_chat_attachment_cleanup: {
        Args: { p_limit: number; p_token: string };
        Returns: { object_path: string }[];
      };
      finish_chat_attachment_cleanup: {
        Args: { p_path: string; p_token: string; p_success: boolean };
        Returns: boolean;
      };
    };
  };
};

export async function maintenanceStep(
  runId: string,
  previousRunId: string | null
): Promise<{ owned: boolean; removed: number; failed: number }> {
  'use step';

  try {
    const admin = createAdminClient({
      requestTimeoutMs: 30_000
    }) as unknown as SupabaseClient<CleanupDatabase>;
    const { data: owned, error: ownershipError } = await admin.rpc(
      'claim_chat_attachment_maintenance',
      {
        p_run_id: runId,
        p_previous_run_id: previousRunId
      }
    );
    if (ownershipError || typeof owned !== 'boolean') throw new Error();
    if (!owned) return { owned: false, removed: 0, failed: 0 };

    const token = randomUUID();
    const { data: claims, error: claimError } = await admin.rpc(
      'claim_chat_attachment_cleanup',
      { p_limit: 5, p_token: token }
    );
    if (
      claimError ||
      !Array.isArray(claims) ||
      claims.length > 5 ||
      claims.some((claim) => !claim || typeof claim.object_path !== 'string')
    ) {
      throw new Error();
    }

    // At most five paths run concurrently. Each request uses the admin client's
    // timeout; finish every path before surfacing any infrastructure failure.
    const outcomes = await Promise.all(
      claims.map(async (claim) => {
        const path = claim.object_path;
        let success = false;
        try {
          const [owner, chat] = path.split('/');
          parseChatAttachmentReference(
            CHAT_ATTACHMENT_REFERENCE_PREFIX + path,
            owner,
            chat
          );

          // Recheck immediately before removal; live metadata always wins.
          const { data: metadata, error: metadataError } = await admin
            .from('chat_attachment_objects')
            .select('object_path')
            .eq('object_path', path)
            .maybeSingle();
          if (metadataError || metadata) throw new Error();

          const { error: removeError } = await admin.storage
            .from(CHAT_ATTACHMENTS_BUCKET)
            .remove([path]);
          success = !removeError;
        } catch {
          // Keep claimed failures retryable through the bounded SQL queue.
          success = false;
        }

        try {
          const { data: finished, error: finishError } = await admin.rpc(
            'finish_chat_attachment_cleanup',
            {
              p_path: path,
              p_token: token,
              p_success: success
            }
          );
          if (finishError || typeof finished !== 'boolean') return null;
          return success && finished;
        } catch {
          return null;
        }
      })
    );

    if (outcomes.some((outcome) => outcome === null)) throw new Error();
    const removed = outcomes.filter((outcome) => outcome === true).length;
    const failed = outcomes.length - removed;

    return { owned: true, removed, failed };
  } catch {
    throw new RetryableError(
      'Attachment maintenance is temporarily unavailable.',
      {
        retryAfter: '5m'
      }
    );
  }
}
