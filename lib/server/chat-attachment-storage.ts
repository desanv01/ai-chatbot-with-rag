import 'server-only';
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/server/admin';
import { createServerSupabaseClient } from '@/lib/server/server';
import { ensureChatAttachmentMaintenance } from '@/lib/server/chat-attachment-maintenance-start';
import {
  CHAT_ATTACHMENTS_BUCKET,
  CHAT_ATTACHMENT_REFERENCE_PREFIX,
  MAX_CHAT_ATTACHMENT_BYTES,
  createChatAttachmentPath,
  encodeChatAttachmentReference,
  parseChatAttachmentReference,
  parsePdfChatAttachment
} from '@/lib/server/chat-attachments';

type AttachmentMetadata = {
  object_path: string;
  user_id: string;
  chat_session_id: string;
  filename: string;
  media_type: 'application/pdf';
  byte_size: number;
  sha256: string;
};

// Local table typing until the authoritative generated schema includes this table.
type AttachmentDatabase = {
  public: {
    Tables: {
      chat_attachment_objects: {
        Row: AttachmentMetadata;
        Insert: AttachmentMetadata;
        Update: Partial<AttachmentMetadata>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      reserve_chat_attachment: {
        Args: {
          p_user_id: string;
          p_chat_id: string;
          p_sha256: string;
          p_filename: string;
          p_byte_size: number;
        };
        Returns: AttachmentMetadata[];
      };
    };
  };
};

const METADATA_COLUMNS =
  'object_path,user_id,chat_session_id,filename,media_type,byte_size,sha256';

async function requireOwnedChat(userId: string, chatId: string): Promise<void> {
  const client = await createServerSupabaseClient();
  const { data: auth, error: authError } = await client.auth.getUser();
  if (authError || auth.user?.id.toLowerCase() !== userId) {
    throw new Error('Attachment access denied.');
  }
  const { data, error } = await client
    .from('chat_sessions')
    .select('id,user_id')
    .eq('id', chatId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error || data?.id !== chatId || data.user_id !== userId) {
    throw new Error('Attachment access denied.');
  }
}

function metadataClient(admin: ReturnType<typeof createAdminClient>) {
  return admin as unknown as SupabaseClient<AttachmentDatabase>;
}

async function findMetadata(
  admin: ReturnType<typeof createAdminClient>,
  path: string,
  userId: string,
  chatId: string
): Promise<AttachmentMetadata | null> {
  const { data, error } = await metadataClient(admin)
    .from('chat_attachment_objects')
    .select(METADATA_COLUMNS)
    .eq('object_path', path)
    .eq('user_id', userId)
    .eq('chat_session_id', chatId)
    .maybeSingle();
  if (error) throw new Error('Attachment metadata is unavailable.');
  return data;
}

function validateMetadata(
  metadata: AttachmentMetadata,
  path: string,
  userId: string,
  chatId: string,
  sha256: string,
  byteSize?: number
): void {
  if (
    metadata.object_path !== path ||
    metadata.user_id !== userId ||
    metadata.chat_session_id !== chatId ||
    metadata.sha256 !== sha256 ||
    metadata.media_type !== 'application/pdf' ||
    !Number.isInteger(metadata.byte_size) ||
    metadata.byte_size < 5 ||
    metadata.byte_size > MAX_CHAT_ATTACHMENT_BYTES ||
    (byteSize !== undefined && metadata.byte_size !== byteSize) ||
    typeof metadata.filename !== 'string' ||
    metadata.filename.length === 0 ||
    metadata.filename.length > 255 ||
    metadata.filename !== metadata.filename.trim() ||
    // eslint-disable-next-line no-control-regex -- Reject control characters in stored attachment filenames.
    /[\u0000-\u001f\u007f-\u009f]/.test(metadata.filename)
  ) {
    throw new Error('Attachment metadata is invalid.');
  }
}

async function downloadVerified(
  admin: ReturnType<typeof createAdminClient>,
  path: string,
  sha256: string,
  byteSize?: number
): Promise<Buffer> {
  const { data, error } = await admin.storage
    .from(CHAT_ATTACHMENTS_BUCKET)
    .download(path);
  if (
    error ||
    !data ||
    data.size < 5 ||
    data.size > MAX_CHAT_ATTACHMENT_BYTES ||
    (byteSize !== undefined && data.size !== byteSize)
  ) {
    throw new Error('Attachment content is unavailable.');
  }
  const bytes = Buffer.from(await data.arrayBuffer());
  if (
    bytes.length < 5 ||
    bytes.length > MAX_CHAT_ATTACHMENT_BYTES ||
    (byteSize !== undefined && bytes.length !== byteSize) ||
    !bytes.subarray(0, 5).equals(Buffer.from('%PDF-')) ||
    createHash('sha256').update(bytes).digest('hex') !== sha256
  ) {
    throw new Error('Attachment content is invalid.');
  }
  return bytes;
}

function isDuplicateUpload(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const details = error as {
    status?: unknown;
    statusCode?: unknown;
    error?: unknown;
    code?: unknown;
  };
  return (
    details.status === 409 ||
    details.statusCode === 409 ||
    details.statusCode === '409' ||
    details.error === 'Duplicate' ||
    details.code === 'Duplicate'
  );
}

export async function storeChatAttachment(
  input: { url: string; mediaType: string; filename?: string },
  userId: string,
  chatId: string
): Promise<{
  reference: string;
  filename: string;
  mediaType: 'application/pdf';
}> {
  try {
    const parsed = parsePdfChatAttachment(input);
    const path = createChatAttachmentPath(userId, chatId, parsed.sha256);
    const [owner, chat] = path.split('/');
    await requireOwnedChat(owner, chat);
    const admin = createAdminClient({ requestTimeoutMs: 30_000 });
    // Record ownership before uploading so interrupted writes remain discoverable
    // for retries and eventual chat-deletion cleanup.
    const { data: reserved, error: reservationError } = await metadataClient(
      admin
    ).rpc('reserve_chat_attachment', {
      p_user_id: owner,
      p_chat_id: chat,
      p_sha256: parsed.sha256,
      p_filename: parsed.filename,
      p_byte_size: parsed.bytes.length
    });
    if (
      reservationError ||
      !Array.isArray(reserved) ||
      reserved.length !== 1 ||
      !reserved[0] ||
      typeof reserved[0] !== 'object'
    ) {
      throw new Error('Attachment metadata could not be reserved.');
    }
    const saved = reserved[0];
    validateMetadata(
      saved,
      path,
      owner,
      chat,
      parsed.sha256,
      parsed.bytes.length
    );
    await ensureChatAttachmentMaintenance();

    const { error: uploadError } = await admin.storage
      .from(CHAT_ATTACHMENTS_BUCKET)
      .upload(path, parsed.bytes, {
        contentType: 'application/pdf',
        upsert: false
      });
    if (uploadError) {
      if (!isDuplicateUpload(uploadError)) {
        throw new Error('Attachment upload failed.');
      }
      await downloadVerified(admin, path, parsed.sha256, parsed.bytes.length);
    }

    return {
      reference: encodeChatAttachmentReference(path),
      filename: saved.filename,
      mediaType: 'application/pdf'
    };
  } catch {
    throw new Error('Unable to store chat attachment.');
  }
}

export async function readChatAttachment(
  reference: string,
  userId: string,
  chatId?: string
): Promise<{ bytes: Buffer; filename: string; mediaType: 'application/pdf' }> {
  try {
    const path = parseChatAttachmentReference(reference, userId, chatId);
    const [owner, chat, file] = path.split('/');
    const sha256 = file.slice(0, -4);
    await requireOwnedChat(owner, chat);
    const admin = createAdminClient({ requestTimeoutMs: 30_000 });
    const metadata = await findMetadata(admin, path, owner, chat);
    if (!metadata) throw new Error('Attachment metadata is unavailable.');
    validateMetadata(metadata, path, owner, chat, sha256);
    const bytes = await downloadVerified(
      admin,
      path,
      sha256,
      metadata.byte_size
    );
    return { bytes, filename: metadata.filename, mediaType: 'application/pdf' };
  } catch {
    throw new Error('Unable to read chat attachment.');
  }
}

export function getChatAttachmentUrl(reference: string): string {
  if (typeof reference !== 'string')
    throw new Error('Invalid attachment reference.');
  const owner = reference
    .slice(CHAT_ATTACHMENT_REFERENCE_PREFIX.length)
    .split('/')[0];
  parseChatAttachmentReference(reference, owner);
  return '/api/chat/attachment?reference=' + encodeURIComponent(reference);
}
