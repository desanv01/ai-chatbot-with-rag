'use client';

import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';
import { decodeBase64 } from '@/utils/base64';
import { useSearchParams, useRouter } from 'next/navigation';
import PdfCanvasViewer from '@/components/pdf/PdfCanvasViewer';

export default function DocumentViewer({
  fileName,
  signedUrl
}: {
  fileName: string;
  signedUrl: string | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const handleClose = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('pdf');
    url.searchParams.delete('p');
    router.replace(url.pathname + url.search);
  };

  const decodedFileName = decodeBase64(fileName);
  const fileExtension = decodedFileName.split('.').pop()?.toLowerCase() ?? '';
  const page = Number(searchParams.get('p')) || 1;

  if (!signedUrl) {
    return (
      <div className="w-[55%] border-l border-border hidden sm:flex flex-col justify-center items-center overflow-hidden relative h-[96vh]">
        <Button
          variant="ghost"
          size="icon"
          onClick={handleClose}
          aria-label="Close PDF viewer"
          className="absolute left-1 top-1 z-50 bg-background/70 hover:bg-background/90"
        >
          <X className="h-4 w-4" />
        </Button>
        <p className="text-foreground text-base">
          There was an error loading the document. Please try again later.
        </p>
      </div>
    );
  }

  const isPdf = fileExtension === 'pdf';
  const isOfficeDocument = ['doc', 'docx'].includes(fileExtension);
  const iframeId = `document-viewer-${fileName.replace(/[^a-zA-Z0-9]/g, '-')}`;

  return (
    <div className="w-[55%] min-w-0 min-h-0 border-l border-border hidden sm:flex flex-row justify-center items-start overflow-hidden relative">
      <Button
        variant="ghost"
        size="icon"
        onClick={handleClose}
        aria-label="Close PDF viewer"
        className="absolute left-1 top-1 z-50 bg-background/70 hover:bg-background/90"
      >
        <X className="h-4 w-4" />
      </Button>

      <div
        className={`relative w-full h-full min-w-0 min-h-0 ${isPdf ? 'pt-10' : ''}`}
      >
        {isPdf ? (
          <PdfCanvasViewer
            url={signedUrl}
            fileName={decodedFileName}
            initialPage={page}
          />
        ) : isOfficeDocument ? (
          <iframe
            id={iframeId}
            src={`https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(
              signedUrl
            )}`}
            className="w-full h-full border-none"
            title="Office Document Viewer"
            referrerPolicy="no-referrer"
            aria-label={`Office document: ${decodedFileName}`}
          />
        ) : (
          <p className="text-foreground text-base">
            This file type is not supported.
          </p>
        )}
      </div>
    </div>
  );
}
