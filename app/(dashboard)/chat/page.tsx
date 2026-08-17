import 'server-only';
import ChatComponent from './components/Chat';
import { cookies } from 'next/headers';
import DocumentViewer from './components/PDFViewer';
import WebsiteWiever from './components/WebsiteWiever';
import { v4 as uuidv4 } from 'uuid';
import { getUserInfo } from '@/lib/server/supabase';
import { createClient } from '@/lib/client/client';

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
        <DocumentComponent fileName={decodeURIComponent(searchParams.pdf)} />
      ) : null}
    </div>
  );
}

async function DocumentComponent({ fileName }: { fileName: string }) {
  const session = await getUserInfo();
  const userId = session?.id;

  let signedUrl: string | null = null;

  if (userId) {
    try {
      const supabase = createClient();
      const decodedFileName = decodeURIComponent(fileName);
      const filePath = `${userId}/${decodedFileName}`;

      const { data, error } = await supabase.storage
        .from('userfiles')
        .createSignedUrl(filePath, 3600); // 1 hour expiry

      if (!error && data) signedUrl = data.signedUrl;
    } catch (error) {
      console.error('Error creating signed URL:', error);
    }
  }

  return <DocumentViewer fileName={fileName} signedUrl={signedUrl} />;
}
