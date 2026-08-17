export const USER_FILES_BUCKET = 'userfiles';

/**
 * Validate a Storage object path that is expected to belong to a user.
 *
 * Storage paths are treated as opaque identifiers. Callers must not rebuild
 * them from a display filename because uploaded filenames can change and are
 * not guaranteed to be unique.
 */
export function isUserStoragePath(
  filePath: unknown,
  userId: string
): filePath is string {
  if (typeof filePath !== 'string' || !userId) return false;

  const normalizedPath = filePath.trim();
  const prefix = `${userId}/`;

  if (!normalizedPath.startsWith(prefix)) return false;

  const objectPath = normalizedPath.slice(prefix.length);
  if (!objectPath || objectPath.includes('\\')) return false;

  return objectPath
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/**
 * Generate the canonical object path for a new PDF upload.
 * The original filename is stored as document metadata, never used as the
 * Storage identity.
 */
export function createUserDocumentPath(userId: string): string {
  return `${userId}/${crypto.randomUUID()}.pdf`;
}
