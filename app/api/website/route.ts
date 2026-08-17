// app/api/proxy-preview/route.ts
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
      maxBytes: 5 * 1024 * 1024,
      timeoutMs: 10_000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      }
    });

    const content = new TextDecoder().decode(result.body);

    // Inject base tag to handle relative URLs
    const baseUrl = result.url.origin;
    const escapedBaseUrl = baseUrl.replace(/[&<>"']/g, (character) => {
      const entities: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      };
      return entities[character];
    });
    const baseTag = `<base href="${escapedBaseUrl}/">`;
    const modifiedContent = /<head\b[^>]*>/i.test(content)
      ? content.replace(/<head\b[^>]*>/i, (head) => `${head}${baseTag}`)
      : `${baseTag}${content}`;

    return new NextResponse(modifiedContent, {
      headers: {
        'Content-Type': 'text/html',
        'Cache-Control': 'private, no-store',
        'Content-Security-Policy':
          "sandbox; default-src https: data: blob:; img-src https: data: blob:; style-src https: 'unsafe-inline'; font-src https: data:; media-src https: data: blob:; script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; connect-src 'none'",
        'X-Content-Type-Options': 'nosniff'
      }
    });
  } catch (error) {
    console.error('Preview proxy error:', error);
    if (error instanceof SafeProxyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: 'Failed to fetch preview' },
      { status: 500 }
    );
  }
}
