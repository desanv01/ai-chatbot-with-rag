import { type NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/server/supabase';
import { listOwnedDocumentJobs } from '@/lib/server/document-jobs';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'private, no-store' };
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json(
        { error: 'No active session found' },
        { status: 401, headers }
      );
    }
    const params = req.nextUrl.searchParams;
    const values = params.getAll('documentIds');
    const documentIds = values.length === 1 ? values[0].split(',') : undefined;
    if (
      [...params.keys()].some((key) => key !== 'documentIds') ||
      values.length > 1 ||
      (documentIds !== undefined &&
        (documentIds.length > 20 ||
          documentIds.some((id) => id.length !== 36 || !UUID_PATTERN.test(id))))
    ) {
      return NextResponse.json(
        { error: 'Invalid document identifiers' },
        { status: 400, headers }
      );
    }
    const ids =
      documentIds === undefined
        ? undefined
        : [...new Set(documentIds.map((id) => id.toLowerCase()))];
    const jobs = await listOwnedDocumentJobs(session.sub, ids);
    return NextResponse.json({ jobs }, { headers });
  } catch {
    return NextResponse.json(
      { error: 'Document jobs are unavailable. Please retry later.' },
      { status: 503, headers }
    );
  }
}
