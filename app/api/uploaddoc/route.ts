import { type NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/server/supabase';
import { createAdminClient } from '@/lib/server/admin';
import { isUserStoragePath, USER_FILES_BUCKET } from '@/lib/document-path';
import { createDocumentJobToken } from '@/lib/server/document-job-token';
import { MAX_PDF_SIZE } from '@/lib/document-limits';

export const dynamic = 'force-dynamic';

export const maxDuration = 60;

const supabaseAdmin = createAdminClient();

export async function POST(req: NextRequest) {
  try {
    // Check for Llama Cloud API key
    if (!process.env.LLAMA_CLOUD_API_KEY) {
      console.error('LLAMA_CLOUD_API_KEY is not configured');
      return NextResponse.json(
        { error: 'Server configuration error: LLAMA_CLOUD_API_KEY is missing' },
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

    const { uploadedFiles } = await req.json();

    if (!Array.isArray(uploadedFiles) || uploadedFiles.length === 0) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 });
    }

    const results = [];

    for (const file of uploadedFiles) {
      try {
        if (
          !file ||
          typeof file.name !== 'string' ||
          !file.name.trim() ||
          !isUserStoragePath(file.path, session.sub)
        ) {
          results.push({
            file: file?.name || 'unknown',
            status: 'error',
            message: 'Invalid document path'
          });
          continue;
        }

        if (!/\.pdf$/i.test(file.name.trim())) {
          results.push({
            file: file.name,
            status: 'error',
            message: 'Only PDF filenames are supported'
          });
          continue;
        }

        const { data: existingDocument, error: lookupError } =
          await supabaseAdmin
            .from('user_documents')
            .select('id')
            .eq('user_id', session.sub)
            .eq('title', file.name.trim())
            .maybeSingle();

        if (lookupError) {
          console.error('Error checking document filename:', lookupError);
          results.push({
            file: file.name,
            status: 'error',
            message: 'Could not check document filename'
          });
          continue;
        }
        if (existingDocument) {
          results.push({
            file: file.name,
            status: 'error',
            message:
              'A document with this filename already exists. Choose a different filename.'
          });
          continue;
        }

        const { data, error } = await supabaseAdmin.storage
          .from(USER_FILES_BUCKET)
          .download(file.path);

        if (error || !data) {
          console.error('Error downloading file:', error);
          results.push({
            file: file.name,
            status: 'error',
            message: 'Download failed'
          });
          continue;
        }

        if (data.size > MAX_PDF_SIZE) {
          results.push({
            file: file.name,
            status: 'error',
            message: 'PDF exceeds the maximum size of 25 MiB'
          });
          continue;
        }
        const header = new Uint8Array(await data.slice(0, 5).arrayBuffer());
        if (
          header.length !== 5 ||
          header.some(
            (byte, index) => byte !== [0x25, 0x50, 0x44, 0x46, 0x2d][index]
          )
        ) {
          results.push({
            file: file.name,
            status: 'error',
            message: 'File does not have a valid PDF header'
          });
          continue;
        }

        const formData = new FormData();
        formData.append('file', data, file.name.trim());

        const uploadResponse = await fetch(
          'https://api.cloud.llamaindex.ai/api/v1/parsing/upload',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${process.env.LLAMA_CLOUD_API_KEY}`,
              Accept: 'application/json'
            },
            signal: AbortSignal.timeout(45_000),
            body: formData
          }
        );

        if (!uploadResponse.ok) {
          throw new Error(
            `Failed to upload file: ${uploadResponse.statusText}`
          );
        }

        const uploadResult = await uploadResponse.json();
        if (!uploadResult || typeof uploadResult.id !== 'string') {
          throw new Error('LlamaParse returned an invalid job identifier');
        }

        const jobToken = createDocumentJobToken({
          jobId: uploadResult.id,
          userId: session.sub,
          filePath: file.path
        });

        results.push({
          file: file.name,
          filePath: file.path,
          status: 'success',
          jobId: uploadResult.id,
          jobToken
        });
      } catch (error) {
        console.error(
          `Error processing file ${file?.name || 'unknown'}:`,
          error
        );
        results.push({
          file: file?.name || 'unknown',
          status: 'error',
          message: 'Processing failed'
        });
      }
    }

    return NextResponse.json({ results });
  } catch (error) {
    console.error('Error in POST request:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
