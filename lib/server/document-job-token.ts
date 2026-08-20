import { createHmac, timingSafeEqual } from 'node:crypto';

const TOKEN_TTL_SECONDS = 2 * 60 * 60;

export type DocumentJobTokenPayload = {
  jobId: string;
  userId: string;
  filePath: string;
  issuedAt: number;
  expiresAt: number;
};

function getSigningSecret(): string {
  const secret =
    process.env.DOCUMENT_JOB_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!secret) {
    throw new Error(
      'DOCUMENT_JOB_SECRET or SUPABASE_SERVICE_ROLE_KEY is required for document job tokens'
    );
  }

  return secret;
}

function encodePayload(payload: DocumentJobTokenPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function signPayload(encodedPayload: string): string {
  return createHmac('sha256', getSigningSecret())
    .update(encodedPayload)
    .digest('base64url');
}

export function createDocumentJobToken({
  jobId,
  userId,
  filePath
}: Pick<DocumentJobTokenPayload, 'jobId' | 'userId' | 'filePath'>): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload: DocumentJobTokenPayload = {
    jobId,
    userId,
    filePath,
    issuedAt,
    expiresAt: issuedAt + TOKEN_TTL_SECONDS
  };
  const encodedPayload = encodePayload(payload);
  return `${encodedPayload}.${signPayload(encodedPayload)}`;
}

export function verifyDocumentJobToken(
  token: unknown,
  expected: Pick<DocumentJobTokenPayload, 'jobId' | 'userId'> &
    Partial<Pick<DocumentJobTokenPayload, 'filePath'>>
): boolean {
  if (typeof token !== 'string') return false;

  const [encodedPayload, signature, extraPart] = token.split('.');
  if (!encodedPayload || !signature || extraPart) return false;

  try {
    const expectedSignature = signPayload(encodedPayload);
    const providedBytes = Buffer.from(signature, 'base64url');
    const expectedBytes = Buffer.from(expectedSignature, 'base64url');

    if (
      providedBytes.length !== expectedBytes.length ||
      !timingSafeEqual(providedBytes, expectedBytes)
    ) {
      return false;
    }

    const payload = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8')
    ) as Partial<DocumentJobTokenPayload>;
    const now = Math.floor(Date.now() / 1000);

    return (
      typeof payload.jobId === 'string' &&
      typeof payload.userId === 'string' &&
      typeof payload.filePath === 'string' &&
      typeof payload.issuedAt === 'number' &&
      typeof payload.expiresAt === 'number' &&
      payload.issuedAt <= now + 60 &&
      payload.expiresAt >= now &&
      payload.jobId === expected.jobId &&
      payload.userId === expected.userId &&
      (expected.filePath === undefined ||
        payload.filePath === expected.filePath)
    );
  } catch {
    return false;
  }
}
