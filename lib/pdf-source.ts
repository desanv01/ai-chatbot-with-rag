export const MAX_PDF_PREVIEW_BYTES = 25 * 1024 * 1024;

export async function readPdfBytes(
  source: string,
  options: { signal: AbortSignal; maxBytes?: number }
): Promise<Uint8Array> {
  const maxBytes =
    options.maxBytes === undefined ? MAX_PDF_PREVIEW_BYTES : options.maxBytes;
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_PDF_PREVIEW_BYTES
  ) {
    throw new Error('Invalid PDF size limit.');
  }
  if (
    typeof window === 'undefined' ||
    typeof source !== 'string' ||
    !source.trim()
  ) {
    throw new Error('Invalid PDF source.');
  }

  let target: URL;
  try {
    target = new URL(source, window.location.href);
  } catch {
    throw new Error('Invalid PDF source.');
  }
  const sameOrigin = target.origin === window.location.origin;
  const sameOriginSource =
    sameOrigin && ['http:', 'https:', 'blob:'].includes(target.protocol);
  const signedStorageSource =
    target.protocol === 'https:' &&
    target.hostname.endsWith('.supabase.co') &&
    target.pathname.startsWith('/storage/v1/object/sign/');
  let blobHasCredentials = false;
  if (target.protocol === 'blob:') {
    try {
      const embedded = new URL(target.pathname);
      blobHasCredentials = Boolean(embedded.username || embedded.password);
    } catch {
      throw new Error('Invalid PDF source.');
    }
  }
  if (
    target.username ||
    target.password ||
    blobHasCredentials ||
    (!sameOriginSource && !signedStorageSource)
  ) {
    throw new Error('Invalid PDF source.');
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) abort();
  const timeout = setTimeout(abort, 30_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let complete = false;

  try {
    if (controller.signal.aborted) throw new Error('PDF loading cancelled.');
    const response = await fetch(target.href, {
      credentials: sameOrigin ? 'same-origin' : 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      signal: controller.signal
    });
    const mediaType = response.headers
      .get('content-type')
      ?.split(';')[0]
      .trim()
      .toLowerCase();
    if (!response.ok || mediaType !== 'application/pdf' || !response.body) {
      throw new Error('Invalid PDF response.');
    }

    // Acquire the reader before validation so failures also cancel the body.
    reader = response.body.getReader();
    const lengthHeader = response.headers.get('content-length');
    if (lengthHeader !== null) {
      const length = Number(lengthHeader);
      if (
        !/^[0-9]+$/.test(lengthHeader) ||
        !Number.isSafeInteger(length) ||
        length < 5 ||
        length > maxBytes
      ) {
        throw new Error('Invalid PDF size.');
      }
    }

    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (controller.signal.aborted) throw new Error('PDF loading cancelled.');
      if (done) break;
      if (value.byteLength > maxBytes - size) {
        throw new Error('PDF exceeds size limit.');
      }
      size += value.byteLength;
      // Keep only an exact-sized copy, independent of the stream's backing buffer.
      if (value.byteLength > 0) chunks.push(new Uint8Array(value));
    }
    if (size < 5) throw new Error('Invalid PDF content.');

    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (
      bytes[0] !== 0x25 ||
      bytes[1] !== 0x50 ||
      bytes[2] !== 0x44 ||
      bytes[3] !== 0x46 ||
      bytes[4] !== 0x2d
    ) {
      throw new Error('Invalid PDF content.');
    }
    if (controller.signal.aborted) throw new Error('PDF loading cancelled.');
    complete = true;
    return bytes;
  } catch {
    controller.abort();
    throw new Error('Unable to load PDF.');
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener('abort', abort);
    if (reader) {
      try {
        if (!complete) await reader.cancel();
      } catch {
        // Aborting the request may already have closed the stream.
      } finally {
        reader.releaseLock();
      }
    }
  }
}
