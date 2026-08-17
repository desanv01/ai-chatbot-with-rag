// app/api/upload/presigned-url/route.ts
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/server/admin';
import { getSession } from '@/lib/server/supabase';
import { createUserDocumentPath, USER_FILES_BUCKET } from '@/lib/document-path';
import { z } from 'zod';

const MAX_TOTAL_SIZE = 150 * 1024 * 1024; // 150 MB
const MAX_FILE_SIZE = 50 * 1024 * 1024;

const uploadRequestSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  fileSize: z.number().int().positive().max(MAX_FILE_SIZE),
  fileType: z.string().optional()
});

export async function POST(request: NextRequest) {
  try {
    const parsedBody = uploadRequestSchema.safeParse(await request.json());

    if (!parsedBody.success) {
      return NextResponse.json(
        { message: 'Invalid upload metadata' },
        { status: 400 }
      );
    }

    const { fileSize } = parsedBody.data;

    const session = await getSession();
    if (!session) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }
    const userId = session.sub;
    const supabase = createAdminClient();

    // Check current total size
    const { data: files, error: listError } = await supabase.storage
      .from(USER_FILES_BUCKET)
      .list(userId);

    if (listError) {
      console.error('List error:', listError);
      return NextResponse.json(
        { message: 'Error checking storage limits', error: listError.message },
        { status: 500 }
      );
    }

    const currentTotalSize =
      files?.reduce((total, file) => total + (file.metadata?.size || 0), 0) ||
      0;

    if (currentTotalSize + fileSize > MAX_TOTAL_SIZE) {
      return NextResponse.json(
        {
          message: `Upload would exceed the maximum allowed total size of ${
            MAX_TOTAL_SIZE / (1024 * 1024)
          } MB`
        },
        { status: 400 }
      );
    }

    const filePath = createUserDocumentPath(userId);

    const { data, error } = await supabase.storage
      .from(USER_FILES_BUCKET)
      .createSignedUploadUrl(filePath);

    if (error) {
      console.error('Error creating signed URL:', error);
      return NextResponse.json(
        { message: 'Failed to create upload URL', error: error.message },
        { status: 500 }
      );
    }

    if (!data) {
      console.error('No data returned from createSignedUploadUrl');
      return NextResponse.json(
        { message: 'Failed to create upload URL - no data returned' },
        { status: 500 }
      );
    }

    const response = {
      uploadUrl: data.signedUrl,
      filePath,
      totalSize: currentTotalSize,
      maxSize: MAX_TOTAL_SIZE
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Unexpected error in presigned URL endpoint:', error);
    console.error(
      'Error stack:',
      error instanceof Error ? error.stack : 'No stack'
    );
    return NextResponse.json(
      {
        message: 'Internal server error',
        error: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}
