import { type NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/server/supabase';
import { verifyDocumentJobToken } from '@/lib/server/document-job-token';

export const dynamic = 'force-dynamic';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    if (!process.env.LLAMA_CLOUD_API_KEY) {
      console.error('LLAMA_CLOUD_API_KEY is not configured');
      return NextResponse.json(
        {
          error: 'Server configuration error: LLAMA_CLOUD_API_KEY is missing'
        },
        { status: 500 }
      );
    }
    const session = await getSession();
    if (!session) {
      return NextResponse.json(
        { error: 'No active session found' },
        { status: 401 }
      );
    }

    const { jobId, jobToken } = await req.json();

    if (
      typeof jobId !== 'string' ||
      !jobId.trim() ||
      !verifyDocumentJobToken(jobToken, {
        jobId,
        userId: session.sub
      })
    ) {
      return NextResponse.json(
        { error: 'Invalid or expired document job token' },
        { status: 403 }
      );
    }

    const statusResponse = await fetch(
      `https://api.cloud.llamaindex.ai/api/v1/parsing/job/${encodeURIComponent(
        jobId
      )}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.LLAMA_CLOUD_API_KEY}`,
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(15_000)
      }
    );

    if (!statusResponse.ok) {
      console.error('Failed to check job status:', statusResponse.statusText);
      return NextResponse.json(
        { error: `Failed to check job status: ${statusResponse.statusText}` },
        { status: 500 }
      );
    }

    const statusData = await statusResponse.json();
    const status =
      statusData && typeof statusData.status === 'string'
        ? statusData.status
        : 'UNKNOWN';

    if (status === 'PENDING') {
      return NextResponse.json({ status: 'PENDING' });
    } else if (status === 'ERROR') {
      console.error('Parsing job failed for a document processing token');
      return NextResponse.json(
        { error: 'Parsing job failed' },
        { status: 502 }
      );
    } else if (status === 'SUCCESS') {
      return NextResponse.json({ status: 'SUCCESS' });
    }

    return NextResponse.json(
      { error: 'LlamaParse returned an unknown job status' },
      { status: 502 }
    );
  } catch (error) {
    console.error('Error in POST request:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
