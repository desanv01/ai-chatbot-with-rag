// app/api/upload/presigned-url/route.ts
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/server/admin';
import { getSession } from '@/lib/server/supabase';
import { createUserDocumentPath, USER_FILES_BUCKET } from '@/lib/document-path';
import { z } from 'zod';
import { MAX_PDF_SIZE, MAX_TOTAL_DOCUMENT_SIZE } from '@/lib/document-limits';

const MAX_TOTAL_SIZE = MAX_TOTAL_DOCUMENT_SIZE;

const uploadRequestSchema = z.object({
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/\.pdf$/i),
  fileSize: z.number().int().positive().max(MAX_PDF_SIZE),
  fileType: z.string().optional()
});

export async function POST(request: NextRequest) {
  try {
    const parsedBody = uploadRequestSchema.safeParse(await request.json());

    if (!parsedBody.success) {
      return NextResponse.json(
        {
          message:
            'Upload requires a PDF filename and a file no larger than 25 MiB'
        },
        { status: 400 }
      );
    }

    const { fileName, fileSize } = parsedBody.data;

    const session = await getSession();
    if (!session) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }
    const userId = session.sub;
    const supabase = createAdminClient();

    const { data: existingDocument, error: lookupError } = await supabase
      .from('user_documents')
      .select('id')
      .eq('user_id', userId)
      .eq('title', fileName)
      .maybeSingle();

    if (lookupError) {
      console.error('Error checking document filename:', lookupError);
      return NextResponse.json(
        { message: 'Could not check document filename' },
        { status: 500 }
      );
    }
    if (existingDocument) {
      return NextResponse.json(
        {
          message:
            'A document with this filename already exists. Choose a different filename.'
        },
        { status: 409 }
      );
    }

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
