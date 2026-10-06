import { type NextRequest, NextResponse } from 'next/server';
import { embed } from 'ai';
import { getSession } from '@/lib/server/supabase';
import { createAdminClient } from '@/lib/server/admin';
import {
  preliminaryAnswerChainAgent,
  generateDocumentMetadata
} from './agentchains';
import { voyage } from 'voyage-ai-provider';
import type { TablesInsert } from '@/types/database';
import { revalidatePath } from 'next/cache';
import { isUserStoragePath } from '@/lib/document-path';
import { verifyDocumentJobToken } from '@/lib/server/document-job-token';
import { normalizeLlamaParsePages } from '@/lib/llamaparse-pages';

export const dynamic = 'force-dynamic';

export const maxDuration = 800;

const embeddingModel = voyage('voyage-3-large');

type DocumentVectorRecord = TablesInsert<'user_documents_vec'>;

class DocumentFilenameConflict extends Error {
  constructor() {
    super(
      'This filename or upload job is already registered. Choose a different filename for a new file, or delete the unfinished document and upload it again.'
    );
  }
}

class DocumentProcessingError extends Error {
  constructor(stage: 'metadata' | 'indexing' | 'finalization') {
    super(
      `Document ${stage} failed. Delete the unfinished document and upload it again.`
    );
  }
}

async function processFile(
  pages: string[],
  fileName: string,
  filePath: string,
  userId: string,
  jobId: string,
  signal: AbortSignal
) {
  const expectedPageNumbers = pages.flatMap((page, index) =>
    page.trim() ? [index + 1] : []
  );
  if (expectedPageNumbers.length === 0) {
    throw new DocumentProcessingError('metadata');
  }
  signal.throwIfAborted();
  const supabase = createAdminClient();

  const { data: previousDocument, error: lookupError } = await supabase
    .from('user_documents')
    .select('id')
    .eq('user_id', userId)
    .eq('title', fileName.trim())
    .abortSignal(signal)
    .maybeSingle();
  if (lookupError) {
    console.error('Could not check document filename:', lookupError);
    throw new DocumentProcessingError('metadata');
  }
  if (previousDocument) throw new DocumentFilenameConflict();

  // Reserve title, storage path and parsing job before any metadata provider call.
  const { data: document, error: reservationError } = await supabase
    .from('user_documents')
    .insert({
      user_id: userId,
      title: fileName.trim(),
      file_path: filePath,
      total_pages: pages.length,
      processing_status: 'processing',
      processing_job_id: jobId,
      processing_error: null
    })
    .select('id')
    .abortSignal(signal)
    .single();
  if (reservationError || !document) {
    if (reservationError?.code === '23505')
      throw new DocumentFilenameConflict();
    console.error('Document reservation failed:', reservationError);
    throw new DocumentProcessingError('metadata');
  }

  const documentId = document.id;
  let stage: 'metadata' | 'indexing' | 'finalization' = 'metadata';
  try {
    signal.throwIfAborted();
    const nonblankPages = pages.filter((page) => page.trim());
    const selectedPages =
      nonblankPages.length > 19
        ? [...nonblankPages.slice(0, 10), ...nonblankPages.slice(-10)]
        : nonblankPages;
    const { output } = await generateDocumentMetadata(
      selectedPages.join('\n\n'),
      signal
    );
    signal.throwIfAborted();
    const { data: updatedDocument, error: metadataError } = await supabase
      .from('user_documents')
      .update({
        ai_title: output.descriptiveTitle,
        ai_description: output.shortDescription,
        ai_maintopics: output.mainTopics,
        ai_keyentities: output.keyEntities
      })
      .eq('id', documentId)
      .eq('user_id', userId)
      .eq('processing_job_id', jobId)
      .eq('processing_status', 'processing')
      .select('id')
      .abortSignal(signal)
      .maybeSingle();
    if (metadataError || !updatedDocument) {
      throw new Error('Metadata update did not match a processing document');
    }

    stage = 'indexing';
    const processingBatchSize = 4;
    for (let offset = 0; offset < pages.length; offset += processingBatchSize) {
      signal.throwIfAborted();
      const { data: processingDocument, error: stateError } = await supabase
        .from('user_documents')
        .select('id')
        .eq('id', documentId)
        .eq('user_id', userId)
        .eq('processing_job_id', jobId)
        .eq('processing_status', 'processing')
        .abortSignal(signal)
        .maybeSingle();
      if (stateError || !processingDocument)
        throw new Error('Document is no longer processing');

      // Wait for all in-flight pages before marking failure; no late batch writes.
      const results = await Promise.allSettled(
        pages
          .slice(offset, offset + processingBatchSize)
          .map(async (page, index): Promise<DocumentVectorRecord | null> => {
            if (!page.trim()) return null;
            signal.throwIfAborted();
            const { combinedPreliminaryAnswers } =
              await processDocumentWithAgentChains(
                page,
                output.descriptiveTitle,
                output.shortDescription,
                output.mainTopics,
                signal
              );
            signal.throwIfAborted();
            const combinedContent = combinedPreliminaryAnswers
              ? [
                  fileName,
                  output.descriptiveTitle,
                  output.shortDescription,
                  output.mainTopics.join(', '),
                  output.keyEntities.join(', '),
                  page,
                  combinedPreliminaryAnswers
                ].join('\n\n')
              : [output.descriptiveTitle, page].join('\n\n');
            const { embedding } = await embed({
              model: embeddingModel,
              value: combinedContent,
              maxRetries: 0,
              abortSignal: AbortSignal.any([
                signal,
                AbortSignal.timeout(30_000)
              ]),
              providerOptions: {
                voyage: {
                  inputType: 'document',
                  truncation: false,
                  outputDimension: 1024,
                  outputDtype: 'int8'
                }
              }
            });
            if (
              !Array.isArray(embedding) ||
              embedding.length !== 1024 ||
              !Array.from(embedding).every(
                (value) => typeof value === 'number' && Number.isFinite(value)
              )
            ) {
              throw new Error('Invalid document embedding');
            }
            return {
              document_id: documentId,
              page_number: offset + index + 1,
              text_content: page,
              embedding: `[${embedding.join(',')}]`
            };
          })
      );
      signal.throwIfAborted();
      const vectorRecords: DocumentVectorRecord[] = [];
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
        if (result.value) vectorRecords.push(result.value);
      }
      if (vectorRecords.length > 0) {
        const { error: vectorError } = await supabase
          .from('user_documents_vec')
          .upsert(vectorRecords, { onConflict: 'document_id,page_number' })
          .abortSignal(signal);
        if (vectorError) throw new Error('Could not store document vectors');
      }
    }

    stage = 'finalization';
    signal.throwIfAborted();
    const { error: finalizationError } = await supabase
      .rpc('complete_document_processing', {
        p_document_id: documentId,
        p_user_id: userId,
        p_job_id: jobId,
        p_expected_page_numbers: expectedPageNumbers
      })
      .abortSignal(signal);
    if (finalizationError)
      throw new Error('Could not validate completed document');
  } catch (error) {
    console.error(`Document ${stage} failed:`, error);
    const safeError = new DocumentProcessingError(stage);
    try {
      const { error: failureError } = await supabase
        .from('user_documents')
        .update({
          processing_status: 'failed',
          processing_error: safeError.message
        })
        .eq('id', documentId)
        .eq('user_id', userId)
        .eq('processing_job_id', jobId)
        .eq('processing_status', 'processing')
        .abortSignal(AbortSignal.timeout(5_000));
      if (failureError)
        console.error('Could not record document failure:', failureError);
    } catch (failureError) {
      console.error('Could not record document failure:', failureError);
    }
    throw safeError;
  }
}

async function processDocumentWithAgentChains(
  doc: string,
  ai_title: string,
  ai_description: string,
  ai_maintopics: string[],
  signal?: AbortSignal
): Promise<{
  combinedPreliminaryAnswers: string;
}> {
  const prompt = `
  Title: ${ai_title}
  Description: ${ai_description}
  Main Topics: ${ai_maintopics.join(', ')}
  Document: ${doc}
  `;

  try {
    const result = await preliminaryAnswerChainAgent(prompt, signal);

    const { output } = result;

    // If tags is potentially undefined, use nullish coalescing
    const tagTaxProvisions = output.tags.join(', ') || '';

    const combinedPreliminaryAnswers = [
      output.preliminary_answer_1,
      output.preliminary_answer_2,
      tagTaxProvisions,
      output.hypothetical_question_1,
      output.hypothetical_question_2
    ].join('\n');
    return { combinedPreliminaryAnswers };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'Processing timeout after 15 seconds'
    ) {
      console.error(`Error processing document with agent chains: ${error}`);
    }

    return {
      combinedPreliminaryAnswers: ''
    };
  }
}

export async function POST(req: NextRequest) {
  const signal = AbortSignal.any([
    req.signal,
    AbortSignal.timeout(10 * 60_000)
  ]);
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json(
        { error: 'No active session found' },
        { status: 401 }
      );
    }

    const userId = session.sub;

    const { jobId, fileName, filePath, jobToken } = await req.json();

    if (
      typeof jobId !== 'string' ||
      !jobId.trim() ||
      typeof fileName !== 'string' ||
      !fileName.trim() ||
      !isUserStoragePath(filePath, userId) ||
      !verifyDocumentJobToken(jobToken, {
        jobId,
        userId,
        filePath
      })
    ) {
      return NextResponse.json(
        { error: 'Invalid document processing request' },
        { status: 400 }
      );
    }

    const requiredKeys = [
      'GOOGLE_GENERATIVE_AI_API_KEY',
      'VOYAGE_API_KEY',
      'LLAMA_CLOUD_API_KEY'
    ] as const;
    const missingKeys = requiredKeys.filter((key) => !process.env[key]?.trim());
    if (missingKeys.length > 0) {
      return NextResponse.json(
        {
          error: `Document processing is unavailable. Configure ${missingKeys.join(', ')} on the server and try again.`
        },
        { status: 503 }
      );
    }
    signal.throwIfAborted();

    const parsingResponse = await fetch(
      `https://api.cloud.llamaindex.ai/api/v1/parsing/job/${encodeURIComponent(
        jobId
      )}/result/json`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${process.env.LLAMA_CLOUD_API_KEY}`,
          Accept: 'application/json'
        },
        cache: 'no-store',
        signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)])
      }
    );

    if (!parsingResponse.ok) {
      console.error(
        'Failed to get document parsing result:',
        parsingResponse.statusText
      );
      return NextResponse.json(
        { error: 'Failed to get document parsing result' },
        { status: 502 }
      );
    }

    let pages: string[];
    try {
      pages = normalizeLlamaParsePages(await parsingResponse.json());
    } catch (error) {
      signal.throwIfAborted();
      console.error('Invalid document parsing result:', error);
      return NextResponse.json(
        { error: 'LlamaParse returned invalid document pages' },
        { status: 422 }
      );
    }

    if (!pages.some((page) => page.trim())) {
      return NextResponse.json(
        { error: 'LlamaParse returned no usable document pages' },
        { status: 422 }
      );
    }

    await processFile(pages, fileName.trim(), filePath, userId, jobId, signal);
    revalidatePath('/chat', 'layout');
    return NextResponse.json({ status: 'SUCCESS' });
  } catch (error) {
    console.error('Error in POST request:', error);
    if (error instanceof DocumentFilenameConflict) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof DocumentProcessingError) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
