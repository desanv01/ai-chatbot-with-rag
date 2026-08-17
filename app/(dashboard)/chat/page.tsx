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

interface PageProps {
  searchParams: Promise<Record<string, string>>;
}

const ALLOWED_MODEL_VALUES = new Set([
  'gpt-5',
  'gpt-5-mini',
  'o3',
  'claude-4-sonnet',
  'gemini-3-flash-preview',
  'gemini-3-pro-preview',
  'gemini-2.5-flash-preview-09-2025'
]);

function sanitizeModel(value: string | undefined) {
  if (!value) return 'gpt-5';
  return ALLOWED_MODEL_VALUES.has(value) ? value : 'gpt-5';
}

export default async function ChatPage(props: PageProps) {
  const searchParams = await props.searchParams;
  const cookieStore = await cookies();

  const selectedOption = sanitizeModel(cookieStore.get('selectedOption')?.value);
  const createChatId = uuidv4();

  return (
    <div className="flex w-full">
      <div className="flex-1">
        <ChatComponent chatId={createChatId} initialSelectedOption={selectedOption} />
      </div>

      {searchParams.url ? (
        <WebsiteWiever url={decodeURIComponent(searchParams.url)} />
      ) : searchParams.pdf ? (
        <DocumentComponent fileReference={decodeURIComponent(searchParams.pdf)} />
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
