// app/api/getmetadata/route.ts
import { type NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/server/supabase';
import { fetchSafeUrl, SafeProxyError } from '@/lib/server/safe-proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Extract content using regex instead of cheerio
function extractMetaContent(html: string, pattern: RegExp): string {
  const match = html.match(pattern);
  return match?.[1] ? match[1].trim() : '';
}

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
      maxBytes: 2 * 1024 * 1024,
      timeoutMs: 8_000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      }
    });

    const content = new TextDecoder().decode(result.body);

    // Extract title using regex
    let title = extractMetaContent(content, /<title[^>]*>(.*?)<\/title>/i);
    if (!title) {
      title = extractMetaContent(
        content,
        /<meta\s+property=["']og:title["']\s+content=["'](.*?)["']/i
      );
    }

    // Extract description from meta tags
    let description = extractMetaContent(
      content,
      /<meta\s+name=["']description["']\s+content=["'](.*?)["']/i
    );
    if (!description) {
      description = extractMetaContent(
        content,
        /<meta\s+property=["']og:description["']\s+content=["'](.*?)["']/i
      );
    }

    return NextResponse.json(
      {
        title,
        description,
        url: result.url.toString()
      },
      {
        headers: {
          'Cache-Control': 'private, no-store'
        }
      }
    );
  } catch (error) {
    console.error('Metadata extraction error:', error);
    if (error instanceof SafeProxyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: 'Failed to extract metadata' },
      { status: 500 }
    );
  }
}
