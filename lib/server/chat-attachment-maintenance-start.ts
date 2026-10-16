import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { start } from 'workflow/api';
import { createAdminClient } from '@/lib/server/admin';
import { chatAttachmentMaintenance } from '@/workflows/chat-attachment-maintenance';

type MaintenanceDatabase = {
  public: {
    Tables: {
      chat_attachment_objects: {
        Row: { object_path: string; user_id: string; chat_session_id: string };
        Insert: {
          object_path: string;
          user_id: string;
          chat_session_id: string;
        };
        Update: { object_path?: string };
        Relationships: [];
      };
      chat_attachment_maintenance: {
        Row: {
          singleton: boolean;
          run_id: string | null;
          lease_until: string | null;
        };
        Insert: {
          singleton: boolean;
          run_id?: string | null;
          lease_until?: string | null;
        };
        Update: { lease_until?: string };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
};

// The caller must verify this chat through the authenticated user's client first.
// Text-only chat deletion does not depend on the Workflow service being available.
export async function ensureChatAttachmentMaintenanceForChatDeletion(
  userId: string,
  chatId: string
): Promise<void> {
  try {
    const admin = createAdminClient({
      requestTimeoutMs: 30_000
    }) as unknown as SupabaseClient<MaintenanceDatabase>;
    const { data, error } = await admin
      .from('chat_attachment_objects')
      .select('object_path')
      .eq('user_id', userId)
      .eq('chat_session_id', chatId)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error('Attachment state unavailable.');
    if (data) await ensureChatAttachmentMaintenance();
  } catch {
    throw new Error(
      'Attachment maintenance is unavailable. Please retry later.'
    );
  }
}

// Called only after authenticated ownership checks. Queue acknowledgement must
// precede new bytes or deletion; the DB outbox then survives request/browser loss.
export async function ensureChatAttachmentMaintenance(): Promise<void> {
  try {
    const admin = createAdminClient({
      requestTimeoutMs: 30_000
    }) as unknown as SupabaseClient<MaintenanceDatabase>;
    const { data, error } = await admin
      .from('chat_attachment_maintenance')
      .select('singleton,run_id,lease_until')
      .eq('singleton', true)
      .maybeSingle();
    if (error) throw new Error('Maintenance state unavailable.');
    if (data?.lease_until && Date.parse(data.lease_until) > Date.now()) return;
    await start(chatAttachmentMaintenance, [null]);
  } catch {
    throw new Error(
      'Attachment maintenance is unavailable. Please retry later.'
    );
  }
}
