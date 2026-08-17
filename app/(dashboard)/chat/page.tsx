import 'server-only';
import ChatComponent from './components/Chat';
import { cookies } from 'next/headers';
import DocumentViewer from './components/PDFViewer';
import WebsiteWiever from './components/WebsiteWiever';
import { v4 as uuidv4 } from 'uuid';
import { createAdminClient } from '@/lib/server/admin';
import { getUserDocumentByReference } from '@/lib/server/documents';
import { isUserStoragePath, USER_FILES_BUCKET } from '@/lib/document-path';
import { encodeBase64 } from '@/utils/base64';
import { sanitizeChatModel } from '@/lib/model-config';

interface PageProps {
  searchParams: Promise<Record<string, string>>;
}

export default async function ChatPage(props: PageProps) {
  const searchParams = await props.searchParams;
  const cookieStore = await cookies();

  const selectedOption = sanitizeChatModel(
    cookieStore.get('selectedOption')?.value
  );
  const createChatId = uuidv4();

  return (
    <div className="flex w-full">
      <div className="flex-1">
        <ChatComponent
          chatId={createChatId}
          initialSelectedOption={selectedOption}
        />
      </div>

      {searchParams.url ? (
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
