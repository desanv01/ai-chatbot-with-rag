import 'server-only';
import type { UIMessage } from 'ai';
import {
  MAX_CHAT_ATTACHMENTS_PER_MESSAGE,
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES,
  MAX_CHAT_ATTACHMENT_HISTORY_BYTES
} from '@/lib/chat-attachment-limits';
import {
  CHAT_ATTACHMENT_REFERENCE_PREFIX,
  encodeChatAttachmentReference,
  parseChatAttachmentReference,
  parsePdfChatAttachment
} from '@/lib/server/chat-attachments';
import {
  getChatAttachmentUrl,
  readChatAttachment,
  storeChatAttachment
} from '@/lib/server/chat-attachment-storage';

export {
  MAX_CHAT_ATTACHMENTS_PER_MESSAGE,
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES,
  MAX_CHAT_ATTACHMENT_HISTORY_BYTES
} from '@/lib/chat-attachment-limits';

type FilePart = Extract<UIMessage['parts'][number], { type: 'file' }>;

interface PreparedAttachment {
  messageIndex: number;
  partIndex: number;
  part: FilePart;
  reference?: string;
  bytes?: Buffer;
  filename?: string;
}

function unwrapReference(url: string, userId: string, chatId: string): string {
  try {
    let reference = url;
    if (url.startsWith('/api/chat/attachment?reference=')) {
      const encoded = url.slice('/api/chat/attachment?reference='.length);
      reference = decodeURIComponent(encoded);
      // Only the application's single-query, canonical relative URL is accepted.
      if (getChatAttachmentUrl(reference) !== url) {
        throw new Error('Invalid chat attachment reference.');
      }
    } else if (!url.startsWith(CHAT_ATTACHMENT_REFERENCE_PREFIX)) {
      throw new Error('Invalid chat attachment reference.');
    }
    return encodeChatAttachmentReference(
      parseChatAttachmentReference(reference, userId, chatId)
    );
  } catch {
    throw new Error('Invalid chat attachment reference.');
  }
}

function enforceMessageSize(bytes: number): void {
  if (bytes > MAX_CHAT_ATTACHMENT_TOTAL_BYTES) {
    throw new Error('Attachments exceed the 3 MiB total per message.');
  }
}

function enforceHistorySize(bytes: number): void {
  if (bytes > MAX_CHAT_ATTACHMENT_HISTORY_BYTES) {
    throw new Error('Attachment history is too large. Start a new chat.');
  }
}

async function prepareAttachments(
  messages: UIMessage[],
  userId: string,
  chatId: string,
  limitHistory: boolean
): Promise<PreparedAttachment[]> {
  const attachments: PreparedAttachment[] = [];
  const messageSizes = messages.map(() => 0);
  let historySize = 0;

  // Validate every new PDF and every reference before any storage write.
  messages.forEach((message, messageIndex) => {
    const files = message.parts.filter((part) => part.type === 'file');
    if (files.length > MAX_CHAT_ATTACHMENTS_PER_MESSAGE) {
      throw new Error('A message can contain at most 4 attachments.');
    }
    message.parts.forEach((part, partIndex) => {
      if (part.type !== 'file') return;
      if (part.mediaType !== 'application/pdf' || typeof part.url !== 'string') {
        throw new Error('Only valid PDF chat attachments are supported.');
      }
      if (part.url.startsWith('data:')) {
        const parsed = parsePdfChatAttachment(part);
        messageSizes[messageIndex] += parsed.bytes.length;
        historySize += parsed.bytes.length;
        enforceMessageSize(messageSizes[messageIndex]);
        if (limitHistory) enforceHistorySize(historySize);
        attachments.push({
          messageIndex,
          partIndex,
          part,
          bytes: parsed.bytes,
          filename: parsed.filename
        });
      } else {
        attachments.push({
          messageIndex,
          partIndex,
          part,
          reference: unwrapReference(part.url, userId, chatId)
        });
      }
    });
  });

  // Resolve existing objects before writes so ownership, existence and all
  // aggregate limits are known before persisting any new attachments.
  for (const attachment of attachments) {
    if (!attachment.reference) continue;
    let stored: Awaited<ReturnType<typeof readChatAttachment>>;
    try {
      stored = await readChatAttachment(attachment.reference, userId, chatId);
    } catch {
      throw new Error('Chat attachment is unavailable or access was denied.');
    }
    attachment.bytes = stored.bytes;
    attachment.filename = stored.filename;
    messageSizes[attachment.messageIndex] += stored.bytes.length;
    historySize += stored.bytes.length;
    enforceMessageSize(messageSizes[attachment.messageIndex]);
    if (limitHistory) enforceHistorySize(historySize);
  }
  return attachments;
}

function copyMessages(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => ({ ...part }))
  }));
}

export async function persistChatMessageAttachments(
  messages: UIMessage[],
  userId: string,
  chatId: string
): Promise<UIMessage[]> {
  const attachments = await prepareAttachments(messages, userId, chatId, false);
  const result = copyMessages(messages);
  for (const attachment of attachments) {
    const stored = attachment.reference
      ? {
          reference: attachment.reference,
          filename: attachment.filename!,
          mediaType: 'application/pdf' as const
        }
      : await storeChatAttachment(attachment.part, userId, chatId);
    result[attachment.messageIndex].parts[attachment.partIndex] = {
      ...attachment.part,
      url: stored.reference,
      filename: stored.filename,
      mediaType: stored.mediaType
    };
  }
  return result;
}

export async function resolveChatMessageAttachments(
  messages: UIMessage[],
  userId: string,
  chatId: string
): Promise<UIMessage[]> {
  const attachments = await prepareAttachments(messages, userId, chatId, true);
  const result = copyMessages(messages);
  for (const attachment of attachments) {
    result[attachment.messageIndex].parts[attachment.partIndex] = {
      ...attachment.part,
      url: `data:application/pdf;base64,${attachment.bytes!.toString('base64')}`,
      filename: attachment.filename!,
      mediaType: 'application/pdf'
    };
  }
  return result;
}
