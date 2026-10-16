// app/api/upload/cleanup/route.ts
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/server/admin';
import { getSession } from '@/lib/server/supabase';
import { isUserStoragePath, USER_FILES_BUCKET } from '@/lib/document-path';

export async function POST(request: NextRequest) {
  try {
    const { filePath } = await request.json();

    const session = await getSession();

    if (!session) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }
    const userId = session.sub;

    // Verify the file path belongs to this user
    if (!isUserStoragePath(filePath, userId)) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 403 });
    }

    const supabase = createAdminClient();

    try {
      const { data: document, error: lookupError } = await supabase
        .from('user_documents')
        .select('id')
        .eq('user_id', userId)
        .eq('file_path', filePath)
        .limit(1)
        .maybeSingle();
      if (lookupError) {
        return NextResponse.json(
          { message: 'File cleanup is unavailable. Please retry later.' },
          { status: 503 }
        );
      }
      if (document) {
        return NextResponse.json(
          { message: 'File is reserved for document processing' },
          { status: 409 }
        );
      }
    } catch {
      return NextResponse.json(
        { message: 'File cleanup is unavailable. Please retry later.' },
        { status: 503 }
      );
    }

    const { error } = await supabase.storage
      .from(USER_FILES_BUCKET)
      .remove([filePath]);

    if (error) {
      console.error('Error deleting file:', error);
      return NextResponse.json(
        { message: 'Failed to cleanup file' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error in cleanup:', error);
    return NextResponse.json(
      { message: 'Internal server error' },
      { status: 500 }
    );
  }
}
