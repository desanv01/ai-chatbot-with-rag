import { type NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/server/supabase';
import {
  controlDocumentJob,
  getOwnedDocumentJob
} from '@/lib/server/document-jobs';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const headers = { 'Cache-Control': 'private, no-store' };
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Context = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, context: Context) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json(
        { error: 'No active session found' },
        { status: 401, headers }
      );
    }
    const { id } = await context.params;
    if (typeof id !== 'string' || id.length !== 36 || !UUID_PATTERN.test(id)) {
      return NextResponse.json(
        { error: 'Invalid document job identifier' },
        { status: 400, headers }
      );
    }
    const job = await getOwnedDocumentJob(session.sub, id);
    if (!job) {
      return NextResponse.json(
        { error: 'Document job not found' },
        { status: 404, headers }
      );
    }
    return NextResponse.json({ job }, { headers });
  } catch {
    return NextResponse.json(
      { error: 'Document job status is unavailable. Please retry later.' },
      { status: 503, headers }
    );
  }
}

export async function POST(req: NextRequest, context: Context) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json(
        { error: 'No active session found' },
        { status: 401, headers }
      );
    }
    const { id } = await context.params;
    if (typeof id !== 'string' || id.length !== 36 || !UUID_PATTERN.test(id)) {
      return NextResponse.json(
        { error: 'Invalid document job identifier' },
        { status: 400, headers }
      );
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: 'Invalid document job action' },
        { status: 400, headers }
      );
    }
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !('action' in body) ||
      (body.action !== 'resume' && body.action !== 'cancel')
    ) {
      return NextResponse.json(
        { error: 'Invalid document job action' },
        { status: 400, headers }
      );
    }
    const job = await getOwnedDocumentJob(session.sub, id);
    if (!job) {
      return NextResponse.json(
        { error: 'Document job not found' },
        { status: 404, headers }
      );
    }
    if (
      (body.action === 'resume' && !job.canResume) ||
      (body.action === 'cancel' && !job.canCancel)
    ) {
      return NextResponse.json(
        {
          error: 'This document job action is unavailable in its current state.'
        },
        { status: 409, headers }
      );
    }
    const result = await controlDocumentJob(session.sub, id, body.action);
    if (!result) {
      return NextResponse.json(
        { error: 'Document job not found' },
        { status: 404, headers }
      );
    }
    return NextResponse.json(result, { headers });
  } catch {
    return NextResponse.json(
      { error: 'Unable to update document processing. Please retry later.' },
      { status: 503, headers }
    );
  }
}
