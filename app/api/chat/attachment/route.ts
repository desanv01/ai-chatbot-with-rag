import { type NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/server/supabase';
import { parseChatAttachmentReference } from '@/lib/server/chat-attachments';
import { readChatAttachment } from '@/lib/server/chat-attachment-storage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers: { 'Cache-Control': 'private, no-store' } }
      );
    }

    const searchParams = request.nextUrl.searchParams;
    const references = searchParams.getAll('reference');
    if (
      references.length !== 1 ||
      !references[0] ||
      references[0].length > 256 ||
      Array.from(searchParams.keys()).some((key) => key !== 'reference')
    ) {
      return NextResponse.json(
        { error: 'A single attachment reference is required.' },
        { status: 400, headers: { 'Cache-Control': 'private, no-store' } }
      );
    }

    const reference = references[0];
    parseChatAttachmentReference(reference, session.sub);
    const { bytes, filename } = await readChatAttachment(reference, session.sub);
    const encodedFilename = encodeURIComponent(filename).replace(
      /['()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    );

    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename*=UTF-8''${encodedFilename}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  } catch {
    return NextResponse.json(
      { error: 'Attachment not found or unavailable.' },
      { status: 404, headers: { 'Cache-Control': 'private, no-store' } }
    );
  }
}
