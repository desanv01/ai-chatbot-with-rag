import { Suspense } from 'react';
import { fetchUserFilesData } from './fetch';
import { FileManager } from './components/FileManager';
import { DocumentViewer } from './components/DocumentViewer';
import { Card, CardContent } from '@/components/ui/card';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { getSession } from '@/lib/server/supabase';
import { createAdminClient } from '@/lib/server/admin';
import { encodeBase64 } from '@/utils/base64';
import { isUserStoragePath, USER_FILES_BUCKET } from '@/lib/document-path';
import { Loader } from 'lucide-react';

type DocumentSummary = {
  id: string;
  title: string;
  file_path: string | null;
};

async function DocumentPreview({
  document
}: {
  document: DocumentSummary;
}) {
  const session = await getSession();
  const userId = session?.sub;

  let signedUrl: string | null = null;

  if (userId && isUserStoragePath(document.file_path, userId)) {
    try {
      const supabase = createAdminClient();

      const { data, error } = await supabase.storage
        .from(USER_FILES_BUCKET)
        .createSignedUrl(document.file_path, 3600);

      if (!error && data) {
        signedUrl = data.signedUrl;
      }
    } catch (error) {
      console.error('Error creating signed URL:', error);
    }
  }

  return <DocumentViewer fileName={document.title} signedUrl={signedUrl} />;
}

function PreviewLoading() {
  return (
    <div className="flex-1 border rounded-lg bg-card flex items-center justify-center">
      <Loader className="w-8 h-8 animate-spin text-primary" />
    </div>
  );
}

interface PageProps {
  searchParams: Promise<{ doc?: string; page?: string }>;
}

export default async function FilerPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const data = await fetchUserFilesData();

  if (!data) {
    return (
      <div className="container max-w-4xl mx-auto py-8 px-4">
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">
              You must be logged in to view this page
            </p>
            <Button asChild className="mt-4">
              <Link href="/login">Sign In</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const selectedDoc = params.doc || null;
  const selectedDocument = selectedDoc
    ? data.userDocuments.find(
        (document) =>
          encodeBase64(document.id) === selectedDoc ||
          encodeBase64(document.title) === selectedDoc
      ) ?? null
    : null;
  const currentPage = Math.max(1, parseInt(params.page || '1', 10) || 1);

  return (
    <div className="flex h-screen gap-4">
      <FileManager
        documents={data.userDocuments}
        selectedDocFileName={selectedDoc}
        currentPage={currentPage}
      />

      {selectedDocument ? (
        <Suspense fallback={<PreviewLoading />}>
          <DocumentPreview document={selectedDocument} />
        </Suspense>
      ) : (
        <DocumentViewer fileName={null} signedUrl={null} />
      )}
    </div>
  );
}
