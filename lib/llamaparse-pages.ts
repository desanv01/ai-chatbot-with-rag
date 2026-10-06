const MAX_PAGES = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normalize full-document Parse v1 JSON by explicit page number, including blanks. */
export function normalizeLlamaParsePages(result: unknown): string[] {
  if (
    !isRecord(result) ||
    !Array.isArray(result.pages) ||
    result.pages.length === 0 ||
    result.pages.length > MAX_PAGES
  ) {
    throw new Error('Invalid parser pages.');
  }

  const pageCount = result.pages.length;
  if ('job_metadata' in result) {
    if (!isRecord(result.job_metadata)) {
      throw new Error('Invalid parser job metadata.');
    }
    if ('job_pages' in result.job_metadata) {
      const jobPages = result.job_metadata.job_pages;
      if (
        typeof jobPages !== 'number' ||
        !Number.isInteger(jobPages) ||
        jobPages <= 0 ||
        jobPages !== pageCount
      ) {
        throw new Error('Parser page count does not match the full document.');
      }
    }
  }

  const pages = new Map<number, string>();
  for (const page of result.pages) {
    if (
      !isRecord(page) ||
      typeof page.page !== 'number' ||
      !Number.isInteger(page.page) ||
      page.page <= 0 ||
      page.page > pageCount ||
      pages.has(page.page) ||
      (typeof page.md !== 'string' && typeof page.text !== 'string')
    ) {
      throw new Error('Invalid parser page.');
    }

    const content =
      typeof page.md === 'string' && page.md.trim()
        ? page.md
        : typeof page.text === 'string'
          ? page.text
          : (page.md as string);
    pages.set(page.page, content);
  }

  return Array.from({ length: pageCount }, (_, index) => {
    const content = pages.get(index + 1);
    if (content === undefined) throw new Error('Parser pages are not contiguous.');
    return content;
  });
}
