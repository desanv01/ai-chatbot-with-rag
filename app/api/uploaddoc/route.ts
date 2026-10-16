import { type NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/server/supabase';
import { createAdminClient } from '@/lib/server/admin';
import { isUserStoragePath, USER_FILES_BUCKET } from '@/lib/document-path';
import { createDocumentJobToken } from '@/lib/server/document-job-token';
import { MAX_PDF_SIZE } from '@/lib/document-limits';
import {
  getOwnedDocumentJob,
  queueDocumentJob
} from '@/lib/server/document-jobs';
import type { DocumentJobStatusView } from '@/lib/document-job-types';

export const dynamic = 'force-dynamic';

export const maxDuration = 120;

const supabaseAdmin = createAdminClient();
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function durableAcknowledgment(
  userId: string,
  fileName: string,
  filePath: string,
  job: DocumentJobStatusView,
  dispatchPending: boolean
) {
  return {
    file: fileName,
    filePath,
    status: 'success',
    jobId: job.id,
    jobToken: createDocumentJobToken({ jobId: job.id, userId, filePath }),
    durable: true,
    documentId: job.documentId,
    jobStatus: job.status,
    dispatchPending
  };
}

export async function POST(req: NextRequest) {
  try {
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
    if (uploadedFiles.length !== 1) {
      return NextResponse.json(
        { error: 'Upload one PDF file at a time' },
        { status: 400 }
      );
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
            .select('id,file_path,processing_job_id')
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
          if (
            existingDocument.file_path === file.path &&
            typeof existingDocument.processing_job_id === 'string' &&
            existingDocument.processing_job_id.length === 36 &&
            UUID_PATTERN.test(existingDocument.processing_job_id)
          ) {
            const job = await getOwnedDocumentJob(
              session.sub,
              existingDocument.processing_job_id
            );
            if (
              job?.documentId === existingDocument.id &&
              job.fileName === file.name.trim()
            ) {
              results.push(
                durableAcknowledgment(
                  session.sub,
                  file.name,
                  file.path,
                  job,
                  job.status === 'queued'
                )
              );
              continue;
            }
          }
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

        const { job, dispatchPending } = await queueDocumentJob(
          session.sub,
          file.name.trim(),
          file.path
        );
        results.push(
          durableAcknowledgment(
            session.sub,
            file.name,
            file.path,
            job,
            dispatchPending
          )
        );
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
