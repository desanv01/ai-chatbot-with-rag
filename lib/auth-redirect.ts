const LOCAL_REDIRECT_ORIGIN = 'https://local.invalid';

/**
 * Return only an internal application path from a user-controlled redirect.
 * Absolute, protocol-relative, and backslash-based values are rejected so
 * auth callbacks cannot become open redirects.
 */
export function getSafeRedirectPath(
  value: string | null | undefined,
  fallback: string
): string {
  const candidate = value?.trim();

  if (
    !candidate ||
    !candidate.startsWith('/') ||
    candidate.startsWith('//') ||
    candidate.includes('\\')
  ) {
    return fallback;
  }

  try {
    const parsed = new URL(candidate, LOCAL_REDIRECT_ORIGIN);

    if (parsed.origin !== LOCAL_REDIRECT_ORIGIN) return fallback;

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
