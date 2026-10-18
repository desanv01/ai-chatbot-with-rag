'use client';

import { useState, useEffect } from 'react';
import { X, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { MAX_CHAT_ATTACHMENT_BYTES } from '@/lib/chat-attachment-limits';
import PdfCanvasViewer from '@/components/pdf/PdfCanvasViewer';
import {
  Tooltip,
  TooltipProvider,
  TooltipTrigger,
  TooltipContent
} from '@/components/ui/tooltip';

export default function UserPdfViewer({
  url,
  fileName
}: {
  url: string;
  fileName: string;
}) {
  const pathname = usePathname();
  const [viewer, setViewer] = useState({
    url: '',
    source: '',
    directUrl: '',
    loading: true,
    error: false
  });
  const isLoading = viewer.url !== url || viewer.loading;
  const blobUrl = viewer.url === url ? viewer.source : '';

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    let directUrl = '';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    const updateViewer = (source: string, loading: boolean, error = false) => {
      queueMicrotask(() => {
        if (!active) return;
        setViewer({ url, source, directUrl, loading, error });
      });
    };

    const prepareSource = async () => {
      updateViewer('', true);
      try {
        let blob: Blob;
        const dataPrefix = 'data:application/pdf;base64,';
        if (url.startsWith(dataPrefix)) {
          const encoded = url.slice(dataPrefix.length);
          if (encoded.length > Math.ceil(MAX_CHAT_ATTACHMENT_BYTES / 3) * 4) {
            throw new Error('Invalid PDF');
          }
          const decoded = atob(encoded);
          if (
            decoded.length < 5 ||
            decoded.length > MAX_CHAT_ATTACHMENT_BYTES
          ) {
            throw new Error('Invalid PDF');
          }
          const bytes = new Uint8Array(decoded.length);
          for (let i = 0; i < decoded.length; i++)
            bytes[i] = decoded.charCodeAt(i);
          blob = new Blob([bytes], { type: 'application/pdf' });
        } else {
          const target = new URL(url, window.location.href);
          const isAttachment =
            target.origin === window.location.origin &&
            target.pathname === '/api/chat/attachment';
          // Only offer an error link to a same-origin URL without URL credentials.
          if (
            target.origin === window.location.origin &&
            !target.username &&
            !target.password
          ) {
            directUrl = target.pathname + target.search + target.hash;
          }
          if (!isAttachment) {
            updateViewer(url, false);
            return;
          }
          const response = await fetch(directUrl, {
            credentials: 'same-origin',
            mode: 'same-origin',
            redirect: 'error',
            signal: controller.signal
          });
          if (
            !response.ok ||
            response.headers
              .get('content-type')
              ?.split(';')[0]
              .trim()
              .toLowerCase() !== 'application/pdf' ||
            Number(response.headers.get('content-length')) >
              MAX_CHAT_ATTACHMENT_BYTES ||
            !response.body
          ) {
            throw new Error('Invalid PDF response');
          }
          const reader = response.body.getReader();
          const chunks: ArrayBuffer[] = [];
          let size = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > MAX_CHAT_ATTACHMENT_BYTES) {
                controller.abort();
                throw new Error('PDF exceeds size limit');
              }
              const chunk = new Uint8Array(value.byteLength);
              chunk.set(value);
              chunks.push(chunk.buffer);
            }
          } finally {
            reader.releaseLock();
          }
          blob = new Blob(chunks, { type: 'application/pdf' });
        }
        const header = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
        if (
          blob.size < 5 ||
          blob.size > MAX_CHAT_ATTACHMENT_BYTES ||
          String.fromCharCode(...header) !== '%PDF-'
        )
          throw new Error('Invalid PDF');
        if (!active) return;
        if (controller.signal.aborted)
          throw new Error('PDF preparation timed out');
        objectUrl = URL.createObjectURL(blob);
        updateViewer(objectUrl, false);
      } catch {
        controller.abort();
        updateViewer('', false, true);
      } finally {
        clearTimeout(timeout);
      }
    };
    void prepareSource();

    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  return (
    <div className="w-[55%] shrink-0 min-w-0 min-h-0 border-l border-slate-200 hidden sm:flex flex-col justify-start items-stretch overflow-hidden relative">
      <div className="shrink-0 z-10 p-2">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                asChild
                className="rounded-md p-1 h-6 w-6 bg-white text-gray-800 transition-all duration-200 border border-slate-200 hover:bg-white hover:shadow-md hover:text-primary hover:border-primary"
              >
                <Link
                  href={pathname}
                  replace
                  prefetch={false}
                  aria-label="Close PDF viewer"
                >
                  <X className="h-4 w-4 font-bold" />
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Close</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {isLoading && (
        <div
          role="status"
          aria-label="Loading PDF"
          className="absolute inset-0 top-10 flex items-center justify-center bg-white"
        >
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      )}

      {!isLoading && blobUrl ? (
        <div className="flex-1 min-w-0 min-h-0">
          <PdfCanvasViewer
            url={blobUrl}
            fileName={fileName}
            maxBytes={MAX_CHAT_ATTACHMENT_BYTES}
          />
        </div>
      ) : !isLoading && viewer.error ? (
        <div className="flex flex-col items-center justify-center h-full p-4">
          <p role="alert">
            Unable to load the PDF preview. Please try opening the PDF directly.
          </p>
          {viewer.directUrl && (
            <a
              href={viewer.directUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 text-blue-600 underline"
            >
              Open PDF
            </a>
          )}
        </div>
      ) : null}
    </div>
  );
}
