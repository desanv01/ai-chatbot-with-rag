import 'server-only';
import { createHash } from 'node:crypto';
import { MAX_CHAT_ATTACHMENT_BYTES } from '@/lib/chat-attachment-limits';

export { MAX_CHAT_ATTACHMENT_BYTES } from '@/lib/chat-attachment-limits';

export const CHAT_ATTACHMENTS_BUCKET = 'chat-attachments';
export const CHAT_ATTACHMENT_REFERENCE_PREFIX = 'attachment://';

export interface ParsedChatAttachment {
  bytes: Buffer;
  sha256: string;
  mediaType: 'application/pdf';
  filename: string;
}

const PDF_DATA_PREFIX = 'data:application/pdf;base64,';
const MAX_ENCODED_LENGTH = Math.ceil(MAX_CHAT_ATTACHMENT_BYTES / 3) * 4;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PATH_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{64}\.pdf$/;

function canonicalUuid(value: string): string {
  if (typeof value !== 'string' || value.length !== 36 || !UUID_PATTERN.test(value)) {
    throw new Error('Invalid attachment owner or chat identifier.');
  }
  return value.toLowerCase();
}

function validateAttachmentPath(path: string): string {
  if (typeof path !== 'string' || path.length !== 142 || !PATH_PATTERN.test(path)) {
    throw new Error('Invalid attachment path.');
  }
  return path;
}

export function parsePdfChatAttachment(input: {
  url: string;
  mediaType: string;
  filename?: string;
}): ParsedChatAttachment {
  if (
    !input ||
    typeof input.url !== 'string' ||
    input.mediaType !== 'application/pdf' ||
    !input.url.startsWith(PDF_DATA_PREFIX) ||
    (input.filename !== undefined && typeof input.filename !== 'string')
  ) {
    throw new Error('Invalid PDF attachment.');
  }

  const encodedLength = input.url.length - PDF_DATA_PREFIX.length;
  if (encodedLength === 0 || encodedLength > MAX_ENCODED_LENGTH) {
    throw new Error('PDF attachment is empty or exceeds the size limit.');
  }

  const encoded = input.url.slice(PDF_DATA_PREFIX.length);
  if (encoded.length % 4 !== 0 || !BASE64_PATTERN.test(encoded)) {
    throw new Error('Invalid PDF attachment encoding.');
  }

  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_CHAT_ATTACHMENT_BYTES) {
    throw new Error('PDF attachment is empty or exceeds the size limit.');
  }
  if (bytes.toString('base64') !== encoded) {
    throw new Error('Invalid PDF attachment encoding.');
  }
  if (bytes.length < 5 || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new Error('Invalid PDF attachment signature.');
  }

  const filename =
    input.filename
      // eslint-disable-next-line no-control-regex -- Strip control characters from attachment filenames.
      ?.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
      .trim()
      .slice(0, 255)
      .trim() || 'attachment.pdf';

  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mediaType: 'application/pdf',
    filename
  };
}

export function createChatAttachmentPath(
  userId: string,
  chatId: string,
  sha256: string
): string {
  const owner = canonicalUuid(userId);
  const chat = canonicalUuid(chatId);
  if (typeof sha256 !== 'string' || sha256.length !== 64 || !SHA256_PATTERN.test(sha256)) {
    throw new Error('Invalid attachment digest.');
  }
  return `${owner}/${chat}/${sha256}.pdf`;
}

export function encodeChatAttachmentReference(path: string): string {
  return CHAT_ATTACHMENT_REFERENCE_PREFIX + validateAttachmentPath(path);
}

export function parseChatAttachmentReference(
  reference: string,
  userId: string,
  chatId?: string
): string {
  const owner = canonicalUuid(userId);
  const chat = chatId === undefined ? undefined : canonicalUuid(chatId);
  if (
    typeof reference !== 'string' ||
    !reference.startsWith(CHAT_ATTACHMENT_REFERENCE_PREFIX)
  ) {
    throw new Error('Invalid attachment reference.');
  }

  const path = validateAttachmentPath(
    reference.slice(CHAT_ATTACHMENT_REFERENCE_PREFIX.length)
  );
  const [pathOwner, pathChat] = path.split('/');
  if (pathOwner !== owner || (chat !== undefined && pathChat !== chat)) {
    throw new Error('Attachment reference does not belong to this user or chat.');
  }
  return path;
}
