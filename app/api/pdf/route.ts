import { type NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/server/supabase';
import { fetchSafeUrl, SafeProxyError } from '@/lib/server/safe-proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const url = searchParams.get('url');

    if (!url) {
      return NextResponse.json(
        { error: 'URL parameter is required' },
        { status: 400 }
      );
    }

    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const result = await fetchSafeUrl(url, {
      maxBytes: 25 * 1024 * 1024,
      timeoutMs: 15_000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        Accept: 'application/pdf,*/*'
      }
    });

    const contentType = result.response.headers.get('content-type')?.toLowerCase();
    const isPdfContent =
      contentType?.includes('application/pdf') ||
      contentType?.includes('application/octet-stream') ||
      result.body[0] === 0x25 &&
        result.body[1] === 0x50 &&
        result.body[2] === 0x44 &&
        result.body[3] === 0x46 &&
        result.body[4] === 0x2d;

    if (!isPdfContent) {
      throw new SafeProxyError('Upstream resource is not a PDF', 415);
    }

    return new NextResponse(Buffer.from(result.body), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  } catch (error) {
    console.error('PDF proxy error:', error);
    if (error instanceof SafeProxyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: 'Failed to fetch PDF' }, { status: 500 });
  }
}
