'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type {
  PDFDocumentProxy,
  PDFDocumentLoadingTask,
  RenderTask
} from 'pdfjs-dist';
import { Button } from '@/components/ui/button';
import { readPdfBytes, MAX_PDF_PREVIEW_BYTES } from '@/lib/pdf-source';

interface PdfCanvasViewerProps {
  url: string;
  fileName: string;
  initialPage?: number;
  maxBytes?: number;
}

const MAX_PAGES = 2000;
const MAX_PIXELS = 8_000_000;
const TIMEOUT_MS = 30_000;

function clampPage(value: number, count: number) {
  return Math.max(
    1,
    Math.min(count, Number.isFinite(value) ? Math.trunc(value) : 1)
  );
}

export default function PdfCanvasViewer({
  url,
  fileName,
  initialPage = 1,
  maxBytes = MAX_PDF_PREVIEW_BYTES
}: PdfCanvasViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pageInputId = useId();
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [loaded, setLoaded] = useState<{
    url: string;
    document: PDFDocumentProxy;
    fallbackUrl: string;
  } | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [zoom, setZoom] = useState(1);
  const [status, setStatus] = useState('Loading PDF…');
  const [error, setError] = useState('');
  const [pageText, setPageText] = useState('');
  const [fallback, setFallback] = useState<{
    url: string;
    href: string;
  } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.max(1, Math.floor(entry.contentRect.width - 24)));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    let loadingTask: PDFDocumentLoadingTask | undefined;
    let fallbackUrl: string | undefined;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      if (!active) return;
      active = false;
      controller.abort();
      void loadingTask?.destroy().catch(() => undefined);
      setError('PDF preview timed out. Reopen the document to try again.');
      setStatus('');
    }, TIMEOUT_MS);

    async function load() {
      setLoaded(null);
      setFallback(null);
      setError('');
      setStatus('Loading PDF…');
      setPageText('');
      canvasHostRef.current?.replaceChildren();
      try {
        const bytes = await readPdfBytes(url, {
          signal: controller.signal,
          maxBytes: Math.min(maxBytes, MAX_PDF_PREVIEW_BYTES)
        });
        if (!active) return;
        // Fallback links use only the bytes accepted by the bounded source helper.
        fallbackUrl = URL.createObjectURL(
          new Blob([new Uint8Array(bytes)], { type: 'application/pdf' })
        );
        setFallback({ url, href: fallbackUrl });
        const pdfjs = await import('pdfjs-dist');
        if (!active) return;
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/build/pdf.worker.min.mjs',
          import.meta.url
        ).toString();
        loadingTask = pdfjs.getDocument({
          data: bytes,
          enableXfa: false,
          useWasm: false,
          stopAtErrors: true,
          canvasMaxAreaInBytes: MAX_PIXELS * 4
        });
        const document = await loadingTask.promise;
        if (!active) return;
        if (document.numPages < 1 || document.numPages > MAX_PAGES) {
          throw new Error('Unsupported page count');
        }
        const firstPage = clampPage(initialPage, document.numPages);
        setPageNumber(firstPage);
        setPageInput(String(firstPage));
        setZoom(1);
        setLoaded({ url, document, fallbackUrl });
        window.clearTimeout(timeout);
      } catch {
        if (!active) return;
        setError(
          'Unable to preview this PDF. It may be damaged, password protected or too large.'
        );
        setStatus('');
        window.clearTimeout(timeout);
        void loadingTask?.destroy().catch(() => undefined);
      }
    }
    // Keep initial state changes outside the synchronous effect body.
    void Promise.resolve().then(() => {
      if (active) return load();
    });
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
      void loadingTask?.destroy().catch(() => undefined);
      if (fallbackUrl) URL.revokeObjectURL(fallbackUrl);
    };
  }, [url, initialPage, maxBytes]);

  useEffect(() => {
    if (loaded?.url !== url || width <= 0) return;
    let active = true;
    let renderTask: RenderTask | undefined;
    const canvas = document.createElement('canvas');
    const timeout = window.setTimeout(() => {
      if (!active) return;
      active = false;
      renderTask?.cancel();
      setError(
        'Rendering this page timed out. Try another page or download the PDF.'
      );
      setStatus('');
    }, TIMEOUT_MS);

    async function render() {
      setError('');
      setStatus(`Rendering page ${pageNumber}…`);
      setPageText('');
      canvasHostRef.current?.replaceChildren();
      const page = await loaded!.document.getPage(pageNumber);
      if (!active) {
        page.cleanup();
        return;
      }
      try {
        const base = page.getViewport({ scale: 1 });
        if (
          !Number.isFinite(base.width) ||
          !Number.isFinite(base.height) ||
          base.width <= 0 ||
          base.height <= 0
        ) {
          throw new Error('Invalid page dimensions');
        }
        const requestedScale = (width / base.width) * zoom;
        const ratio = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
        const scale = Math.min(
          requestedScale,
          Math.sqrt((MAX_PIXELS - 10_000) / (base.width * base.height)) / ratio
        );
        const viewport = page.getViewport({ scale });
        canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
        canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
        if (canvas.width * canvas.height > MAX_PIXELS)
          throw new Error('Page exceeds preview limits');
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        canvas.style.backgroundColor = '#ffffff';
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', `${fileName}, page ${pageNumber}`);
        // Every render gets its own canvas; cancelled work never reuses another task's canvas.
        renderTask = page.render({
          canvas,
          viewport,
          transform: [ratio, 0, 0, ratio, 0, 0],
          background: '#ffffff',
          annotationMode: 0
        });
        await renderTask.promise;
        if (!active) return;
        canvasHostRef.current?.replaceChildren(canvas);
        setStatus(`Page ${pageNumber} of ${loaded!.document.numPages} ready.`);
        window.clearTimeout(timeout);
        try {
          const text = await page.getTextContent();
          if (active) {
            setPageText(
              text.items
                .map((item) => ('str' in item ? item.str : ''))
                .join(' ')
                .slice(0, 100_000)
            );
          }
        } catch {
          // A rendered page remains usable when a PDF has no extractable text.
        }
      } finally {
        page.cleanup();
      }
    }
    void Promise.resolve().then(async () => {
      if (!active) return;
      try {
        await render();
      } catch {
        if (active) {
          setError(
            'Unable to render this page. Try another page or download the PDF.'
          );
          setStatus('');
        }
      } finally {
        window.clearTimeout(timeout);
      }
    });
    return () => {
      active = false;
      window.clearTimeout(timeout);
      renderTask?.cancel();
      canvas.remove();
      // Release the backing pixels only after the cancelled renderer has settled.
      void (renderTask?.promise ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => {
          canvas.width = 0;
          canvas.height = 0;
        });
    };
  }, [loaded, url, pageNumber, width, zoom, fileName]);

  const current = loaded?.url === url ? loaded : null;
  const safeFallback = fallback?.url === url ? fallback.href : null;
  const selectPage = (value: number) => {
    if (!current) return;
    const next = clampPage(value, current.document.numPages);
    setPageNumber(next);
    setPageInput(String(next));
  };

  return (
    <div className="flex flex-col flex-1 w-full h-full min-h-0 min-w-0 overflow-hidden bg-background text-foreground">
      <div className="flex flex-wrap items-center gap-2 p-2 border-b">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="Previous PDF page"
          disabled={!current || pageNumber <= 1}
          onClick={() => selectPage(pageNumber - 1)}
        >
          Previous
        </Button>
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            selectPage(Number(pageInput));
          }}
        >
          <label htmlFor={pageInputId} className="sr-only">
            Physical PDF page
          </label>
          <input
            id={pageInputId}
            aria-label="Physical PDF page"
            type="number"
            min={1}
            max={current?.document.numPages ?? 1}
            value={pageInput}
            disabled={!current}
            onChange={(event) => setPageInput(event.target.value)}
            onBlur={() => selectPage(Number(pageInput))}
            className="w-16 rounded border bg-background text-foreground px-2 py-1"
          />
          <span className="text-sm">
            of {current?.document.numPages ?? '…'}
          </span>
        </form>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="Next PDF page"
          disabled={!current || pageNumber >= current.document.numPages}
          onClick={() => selectPage(pageNumber + 1)}
        >
          Next
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="Fit PDF page to width"
          disabled={!current}
          onClick={() => setZoom(1)}
        >
          Fit width
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="Zoom out PDF"
          disabled={!current || zoom <= 0.5}
          onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
        >
          −
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="Zoom in PDF"
          disabled={!current || zoom >= 2}
          onClick={() => setZoom((value) => Math.min(2, value + 0.25))}
        >
          +
        </Button>
        {safeFallback && (
          <>
            <a
              href={safeFallback}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm underline"
            >
              Open PDF
            </a>
            <a
              href={safeFallback}
              download={fileName || 'document.pdf'}
              className="text-sm underline"
            >
              Download PDF
            </a>
          </>
        )}
      </div>
      <p role="status" aria-live="polite" className="text-sm px-3 py-2">
        {error || status}
      </p>
      <div
        ref={containerRef}
        className="flex-1 min-h-0 min-w-0 overflow-auto p-3"
      >
        <div ref={canvasHostRef} className="w-fit mx-auto" />
        <p className="sr-only" aria-label={`Text of PDF page ${pageNumber}`}>
          {pageText}
        </p>
      </div>
    </div>
  );
}
