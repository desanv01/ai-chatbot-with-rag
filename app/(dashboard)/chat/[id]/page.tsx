import ChatComponent from '../components/Chat';
import { cookies } from 'next/headers';
import WebsiteWiever from '../components/WebsiteWiever';
import DocumentViewer from '../components/PDFViewer';
import UserPdfViewer from '../components/UserPdfFiles';
import { fetchChat, formatMessages } from './fetch';
import { createAdminClient } from '@/lib/server/admin';
import { getUserDocumentByReference } from '@/lib/server/documents';
import { isUserStoragePath, USER_FILES_BUCKET } from '@/lib/document-path';
import { encodeBase64 } from '@/utils/base64';
import { sanitizeChatModel } from '@/lib/model-config';

export default async function ChatPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ url?: string; pdf?: string; file?: string }>;
}) {
  const params = await props.params;
  const searchParams = await props.searchParams;
  const { id } = params;

  const chatData = await fetchChat(id);
  const cookieStore = await cookies();

  const selectedOption = sanitizeChatModel(
    cookieStore.get('selectedOption')?.value
  );

  let formattedMessages = undefined;
  let attachmentUrl = undefined;

  if (chatData) {
    formattedMessages = formatMessages(chatData.message_parts);

    if (searchParams.file && formattedMessages) {
      const fileName = decodeURIComponent(searchParams.file);

      for (const message of formattedMessages) {
        const filePart = message.parts?.find(
          (part) => part.type === 'file' && part.filename === fileName
        );

        if (filePart && filePart.type === 'file') {
          attachmentUrl = filePart.url;
          break;
        }
      }
    }
  }

  return (
    <div className="flex w-full">
      <div className="flex-1">
        <ChatComponent
          currentChat={formattedMessages}
          chatId={id}
          initialSelectedOption={selectedOption}
        />
      </div>

      {attachmentUrl ? (
        <UserPdfViewer
          url={attachmentUrl}
          fileName={
            searchParams.file
              ? decodeURIComponent(searchParams.file)
              : 'Document'
          }
        />
      ) : searchParams.url ? (
        <WebsiteWiever url={decodeURIComponent(searchParams.url)} />
      ) : searchParams.pdf ? (
        <DocumentComponent
          fileReference={decodeURIComponent(searchParams.pdf)}
        />
      ) : null}
    </div>
  );
}

async function DocumentComponent({ fileReference }: { fileReference: string }) {
  const document = await getUserDocumentByReference(fileReference);

  let signedUrl: string | null = null;

  if (document && isUserStoragePath(document.file_path, document.user_id)) {
    try {
      const supabase = createAdminClient();

      const { data, error } = await supabase.storage
        .from(USER_FILES_BUCKET)
        .createSignedUrl(document.file_path, 3600); // 1 hour expiry

      if (!error && data) signedUrl = data.signedUrl;
    } catch (error) {
      console.error('Error creating signed URL:', error);
    }
  }

  const displayName = document?.title || fileReference;
  return (
    <DocumentViewer
      fileName={encodeBase64(displayName)}
      signedUrl={signedUrl}
    />
  );
}
