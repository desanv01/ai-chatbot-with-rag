import 'server-only';
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { embed } from 'ai';
import { voyage } from 'voyage-ai-provider';
import { FatalError, RetryableError } from 'workflow';
import { createAdminClient } from '@/lib/server/admin';
import type { JobErrorCode, JobStatus } from '@/lib/document-job-types';
import { MAX_PDF_SIZE } from '@/lib/document-limits';
import { USER_FILES_BUCKET } from '@/lib/document-path';
import { normalizeLlamaParsePages } from '@/lib/llamaparse-pages';
import {
  generateDocumentMetadata,
  preliminaryAnswerChainAgent
} from '@/app/api/processdoc/agentchains';

type Metadata = {
  descriptiveTitle: string;
  shortDescription: string;
  mainTopics: string[];
  keyEntities: string[];
  primaryLanguage: string;
};
type Job = {
  id: string;
  user_id: string;
  document_id: string;
  file_name: string;
  file_path: string;
  generation: number;
  run_id: string | null;
  status: JobStatus;
  parser_job_id: string | null;
  parser_submit_started_at: string | null;
  source_sha256: string | null;
  source_size: number | null;
  metadata: Record<string, unknown> | null;
  total_pages: number | null;
  completed_pages: number;
  error_code: JobErrorCode | null;
  created_at: string;
  updated_at: string;
};
type Page = {
  job_id: string;
  page_number: number;
  markdown: string;
  indexed: boolean;
};
type Fence = { p_job_id: string; p_generation: number; p_run_id: string };
type Patch = {
  status?: 'parsing' | 'metadata' | 'indexing';
  parser_job_id?: string;
  source_sha256?: string;
  source_size?: number;
  metadata?: Metadata;
  total_pages?: number;
};
type JobsDatabase = {
  public: {
    Tables: {
      document_processing_jobs: {
        Row: Job;
        Insert: Job;
        Update: Partial<Job>;
        Relationships: [];
      };
      document_processing_pages: {
        Row: Page;
        Insert: Page;
        Update: Partial<Page>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      claim_document_job: { Args: Fence; Returns: boolean };
      begin_document_parser_submission: { Args: Fence; Returns: boolean };
      checkpoint_document_job: {
        Args: Fence & { p_patch: Patch };
        Returns: boolean;
      };
      store_document_job_pages: {
        Args: Fence & { p_pages: { page_number: number; markdown: string }[] };
        Returns: boolean;
      };
      commit_document_job_page: {
        Args: Fence & { p_page_number: number; p_embedding: string | null };
        Returns: number | null;
      };
      complete_document_job: { Args: Fence; Returns: boolean };
      fail_document_job: {
        Args: Fence & { p_error_code: JobErrorCode };
        Returns: boolean;
      };
    };
  };
};
type Client = SupabaseClient<JobsDatabase>;
const JOB_COLUMNS =
  'id,user_id,document_id,file_name,file_path,generation,run_id,status,parser_job_id,parser_submit_started_at,source_sha256,source_size,metadata,total_pages,completed_pages,error_code,created_at,updated_at';
const ERROR_CODES: readonly JobErrorCode[] = [
  'source_invalid',
  'parser_submission_unknown',
  'parser_failed',
  'parser_timeout',
  'parse_result_invalid',
  'metadata_failed',
  'indexing_failed',
  'workflow_interrupted'
];
const ACTIVE_STATUSES: readonly JobStatus[] = [
  'queued',
  'parsing',
  'metadata',
  'indexing'
];
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SOURCE_PATH = new RegExp(`^${UUID}/${UUID}\\.pdf$`);
const MIB = 1024 * 1024;

function client(): Client {
  return createAdminClient({ requestTimeoutMs: 30_000 }) as unknown as Client;
}

function fence(jobId: string, generation: number, runId: string): Fence {
  return { p_job_id: jobId, p_generation: generation, p_run_id: runId };
}

function retry(code: JobErrorCode): never {
  throw new RetryableError(code, { retryAfter: '30s' });
}

function sanitize(error: unknown, fallback: JobErrorCode): never {
  if (
    error instanceof FatalError &&
    ERROR_CODES.includes(error.message as JobErrorCode)
  ) {
    throw new FatalError(error.message);
  }
  if (
    error instanceof RetryableError &&
    ERROR_CODES.includes(error.message as JobErrorCode)
  ) {
    retry(error.message as JobErrorCode);
  }
  retry(fallback);
}

async function loadJob(
  admin: Client,
  args: Fence,
  allowReady = false
): Promise<Job> {
  const { data, error } = await admin
    .from('document_processing_jobs')
    .select(JOB_COLUMNS)
    .eq('id', args.p_job_id)
    .maybeSingle();
  if (error) retry('workflow_interrupted');
  if (
    data?.id !== args.p_job_id ||
    data.generation !== args.p_generation ||
    data.run_id !== args.p_run_id ||
    (!ACTIVE_STATUSES.includes(data.status) &&
      !(allowReady && data.status === 'ready'))
  ) {
    throw new FatalError('workflow_interrupted');
  }
  return data;
}

async function checkpoint(
  admin: Client,
  args: Fence,
  patch: Patch,
  signal?: AbortSignal
) {
  const request = admin.rpc('checkpoint_document_job', {
    ...args,
    p_patch: patch
  });
  const { data, error } = await (signal
    ? request.abortSignal(signal)
    : request);
  if (error) retry('workflow_interrupted');
  if (data !== true) throw new FatalError('workflow_interrupted');
}

function parserHeaders(): Record<string, string> {
  if (!process.env.LLAMA_CLOUD_API_KEY?.trim()) retry('parser_failed');
  return {
    Authorization: `Bearer ${process.env.LLAMA_CLOUD_API_KEY}`,
    Accept: 'application/json'
  };
}

function parserUrl(job: Job, suffix = ''): string {
  if (!job.parser_job_id || job.parser_job_id.length > 1024) {
    throw new FatalError('parser_failed');
  }
  return `https://api.cloud.llamaindex.ai/api/v1/parsing/job/${encodeURIComponent(job.parser_job_id)}${suffix}`;
}

function metadata(value: unknown): Metadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FatalError('metadata_failed');
  }
  const item = value as Record<string, unknown>;
  const string = (field: string, maximum: number): string => {
    const result = item[field];
    if (
      typeof result !== 'string' ||
      result.length > maximum ||
      result.includes('\u0000')
    ) {
      throw new FatalError('metadata_failed');
    }
    return result;
  };
  const strings = (field: string, maximum: number): string[] => {
    const result = item[field];
    if (
      !Array.isArray(result) ||
      result.length > maximum ||
      result.some(
        (entry) =>
          typeof entry !== 'string' ||
          entry.length > 512 ||
          entry.includes('\u0000')
      )
    )
      throw new FatalError('metadata_failed');
    return result as string[];
  };
  const result = {
    descriptiveTitle: string('descriptiveTitle', 512),
    shortDescription: string('shortDescription', 8192),
    mainTopics: strings('mainTopics', 64),
    keyEntities: strings('keyEntities', 128),
    primaryLanguage: string('primaryLanguage', 128)
  };
  if (!result.descriptiveTitle.trim()) throw new FatalError('metadata_failed');
  return result;
}

export async function claimDocumentJobStep(
  jobId: string,
  generation: number,
  runId: string
): Promise<boolean> {
  'use step';
  try {
    const { data, error } = await client().rpc(
      'claim_document_job',
      fence(jobId, generation, runId)
    );
    if (error || typeof data !== 'boolean') retry('workflow_interrupted');
    return data;
  } catch (error) {
    sanitize(error, 'workflow_interrupted');
  }
}

export async function submitDocumentParserStep(
  jobId: string,
  generation: number,
  runId: string
): Promise<void> {
  'use step';
  try {
    const admin = client();
    const args = fence(jobId, generation, runId);
    const job = await loadJob(admin, args);
    if (job.parser_job_id === null && job.parser_submit_started_at !== null) {
      throw new FatalError('parser_submission_unknown');
    }
    if (
      !SOURCE_PATH.test(job.file_path) ||
      job.file_path.split('/')[0] !== job.user_id
    ) {
      throw new FatalError('source_invalid');
    }
    const { data: source, error: sourceError } = await admin.storage
      .from(USER_FILES_BUCKET)
      .download(job.file_path);
    if (sourceError) {
      const missing =
        ('status' in sourceError && sourceError.status === 404) ||
        ('statusCode' in sourceError && sourceError.statusCode === '404');
      if (missing) throw new FatalError('source_invalid');
      retry('workflow_interrupted');
    }
    if (!source) retry('workflow_interrupted');
    if (source.size < 5 || source.size > MAX_PDF_SIZE)
      throw new FatalError('source_invalid');
    const bytes = Buffer.from(await source.arrayBuffer());
    if (
      bytes.length !== source.size ||
      bytes.length > MAX_PDF_SIZE ||
      !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))
    ) {
      throw new FatalError('source_invalid');
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (
      (job.source_sha256 !== null && job.source_sha256 !== sha256) ||
      (job.source_size !== null && job.source_size !== bytes.length)
    )
      throw new FatalError('source_invalid');
    await checkpoint(admin, args, {
      source_sha256: sha256,
      source_size: bytes.length
    });
    if (job.parser_job_id !== null) return;
    if (
      [
        'GOOGLE_GENERATIVE_AI_API_KEY',
        'VOYAGE_API_KEY',
        'LLAMA_CLOUD_API_KEY'
      ].some((key) => !process.env[key]?.trim())
    )
      retry('workflow_interrupted');
    const { data: begun, error: beginError } = await admin.rpc(
      'begin_document_parser_submission',
      args
    );
    if (beginError) retry('workflow_interrupted');
    if (begun !== true) {
      const current = await loadJob(admin, args);
      if (current.parser_job_id !== null) return;
      if (current.parser_submit_started_at !== null)
        throw new FatalError('parser_submission_unknown');
      throw new FatalError('workflow_interrupted');
    }
    await loadJob(admin, args);
    const form = new FormData();
    form.append('file', source, job.file_name);
    // After the atomic marker, any outcome without a saved parser ID is ambiguous.
    try {
      const response = await fetch(
        'https://api.cloud.llamaindex.ai/api/v1/parsing/upload',
        {
          method: 'POST',
          headers: parserHeaders(),
          body: form,
          redirect: 'error',
          signal: AbortSignal.timeout(45_000)
        }
      );
      if (!response.ok) throw new FatalError('parser_submission_unknown');
      const result: unknown = await response.json();
      const id =
        result && typeof result === 'object' && 'id' in result
          ? result.id
          : null;
      if (typeof id !== 'string' || !id.trim() || id.length > 1024) {
        throw new FatalError('parser_submission_unknown');
      }
      await checkpoint(admin, args, { parser_job_id: id, status: 'parsing' });
    } catch (error) {
      if (
        error instanceof FatalError &&
        error.message === 'workflow_interrupted'
      )
        throw error;
      throw new FatalError('parser_submission_unknown');
    }
  } catch (error) {
    sanitize(error, 'workflow_interrupted');
  }
}

export async function pollDocumentParserStep(
  jobId: string,
  generation: number,
  runId: string
): Promise<'pending' | 'success'> {
  'use step';
  try {
    const job = await loadJob(client(), fence(jobId, generation, runId));
    if (job.total_pages !== null) return 'success';
    const response = await fetch(parserUrl(job), {
      headers: parserHeaders(),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000)
    });
    if (response.status === 429 || response.status >= 500)
      retry('parser_failed');
    if (!response.ok) throw new FatalError('parser_failed');
    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new FatalError('parser_failed');
    }
    const status =
      result && typeof result === 'object' && 'status' in result
        ? result.status
        : null;
    if (status === 'PENDING') return 'pending';
    if (status === 'SUCCESS') return 'success';
    throw new FatalError('parser_failed');
  } catch (error) {
    sanitize(error, 'parser_failed');
  }
}

export async function stageDocumentPagesStep(
  jobId: string,
  generation: number,
  runId: string
): Promise<{ totalPages: number }> {
  'use step';
  const signal = AbortSignal.timeout(240_000);
  try {
    const admin = client();
    const args = fence(jobId, generation, runId);
    const job = await loadJob(admin, args);
    if (job.total_pages !== null) return { totalPages: job.total_pages };
    const response = await fetch(parserUrl(job, '/result/json'), {
      headers: parserHeaders(),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)])
    });
    if (response.status === 429 || response.status >= 500)
      retry('parse_result_invalid');
    if (!response.ok) throw new FatalError('parse_result_invalid');
    let pages: string[];
    try {
      pages = normalizeLlamaParsePages(await response.json()).map((page) =>
        page.trim() ? page : ''
      );
    } catch {
      throw new FatalError('parse_result_invalid');
    }
    if (
      pages.length < 1 ||
      pages.length > 2000 ||
      !pages.some((page) => page !== '')
    ) {
      throw new FatalError('parse_result_invalid');
    }
    let totalBytes = 0;
    for (const page of pages) {
      const size = Buffer.byteLength(page, 'utf8');
      totalBytes += size;
      if (size > 2 * MIB || totalBytes > 16 * MIB || page.includes('\u0000')) {
        throw new FatalError('parse_result_invalid');
      }
    }
    let batch: { page_number: number; markdown: string }[] = [];
    const store = async () => {
      signal.throwIfAborted();
      const { data, error } = await admin
        .rpc('store_document_job_pages', { ...args, p_pages: batch })
        .abortSignal(signal);
      if (error) retry('parse_result_invalid');
      if (data !== true) throw new FatalError('workflow_interrupted');
      batch = [];
    };
    for (let index = 0; index < pages.length; index++) {
      const page = { page_number: index + 1, markdown: pages[index] };
      if (Buffer.byteLength(JSON.stringify([page]), 'utf8') > 2 * MIB)
        throw new FatalError('parse_result_invalid');
      if (
        batch.length &&
        (batch.length === 20 ||
          Buffer.byteLength(JSON.stringify([...batch, page]), 'utf8') > 2 * MIB)
      ) {
        await store();
      }
      batch.push(page);
    }
    if (batch.length) await store();
    await checkpoint(
      admin,
      args,
      { total_pages: pages.length, status: 'metadata' },
      signal
    );
    return { totalPages: pages.length };
  } catch (error) {
    sanitize(error, 'parse_result_invalid');
  }
}

export async function prepareDocumentMetadataStep(
  jobId: string,
  generation: number,
  runId: string
): Promise<void> {
  'use step';
  try {
    const admin = client();
    const args = fence(jobId, generation, runId);
    const job = await loadJob(admin, args);
    let output: Metadata;
    if (job.metadata !== null) {
      output = metadata(job.metadata);
    } else {
      const query = (ascending: boolean) =>
        admin
          .from('document_processing_pages')
          .select('page_number,markdown')
          .eq('job_id', jobId)
          .neq('markdown', '')
          .order('page_number', { ascending })
          .limit(10);
      const [first, last] = await Promise.all([query(true), query(false)]);
      if (first.error || last.error) retry('metadata_failed');
      const selected = new Map<number, string>();
      for (const page of [...(first.data ?? []), ...(last.data ?? [])])
        selected.set(page.page_number, page.markdown);
      if (!selected.size) throw new FatalError('metadata_failed');
      const content = [...selected.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, page]) => page)
        .join('\n\n');
      await loadJob(admin, args);
      const result = await generateDocumentMetadata(
        content,
        AbortSignal.timeout(45_000)
      );
      output = metadata(result.output);
    }
    await checkpoint(admin, args, { metadata: output, status: 'indexing' });
  } catch (error) {
    sanitize(error, 'metadata_failed');
  }
}

export async function indexDocumentPageStep(
  jobId: string,
  generation: number,
  runId: string,
  pageNumber: number
): Promise<void> {
  'use step';
  try {
    const admin = client();
    const args = fence(jobId, generation, runId);
    const job = await loadJob(admin, args);
    if (
      !Number.isInteger(pageNumber) ||
      pageNumber < 1 ||
      job.total_pages === null ||
      pageNumber > job.total_pages
    ) {
      throw new FatalError('indexing_failed');
    }
    const { data: page, error: pageError } = await admin
      .from('document_processing_pages')
      .select('job_id,page_number,markdown,indexed')
      .eq('job_id', jobId)
      .eq('page_number', pageNumber)
      .maybeSingle();
    if (pageError) retry('indexing_failed');
    if (!page) throw new FatalError('indexing_failed');
    if (page.indexed) return;
    let vector: string | null = null;
    if (page.markdown.trim()) {
      const output = metadata(job.metadata);
      let answers = '';
      await loadJob(admin, args);
      try {
        const prompt = `
  Title: ${output.descriptiveTitle}
  Description: ${output.shortDescription}
  Main Topics: ${output.mainTopics.join(', ')}
  Document: ${page.markdown}
  `;
        const result = await preliminaryAnswerChainAgent(
          prompt,
          AbortSignal.timeout(45_000)
        );
        const enriched = result.output;
        answers = [
          enriched.preliminary_answer_1,
          enriched.preliminary_answer_2,
          enriched.tags.join(', ') || '',
          enriched.hypothetical_question_1,
          enriched.hypothetical_question_2
        ].join('\n');
      } catch {
        answers = '';
      }
      await loadJob(admin, args);
      const content = answers
        ? [
            job.file_name,
            output.descriptiveTitle,
            output.shortDescription,
            output.mainTopics.join(', '),
            output.keyEntities.join(', '),
            page.markdown,
            answers
          ].join('\n\n')
        : [output.descriptiveTitle, page.markdown].join('\n\n');
      const { embedding } = await embed({
        model: voyage('voyage-3-large'),
        value: content,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(30_000),
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
      )
        retry('indexing_failed');
      vector = `[${embedding.join(',')}]`;
    }
    const { data, error } = await admin.rpc('commit_document_job_page', {
      ...args,
      p_page_number: pageNumber,
      p_embedding: vector
    });
    if (error) retry('indexing_failed');
    if (data === null || !Number.isInteger(data) || data < 1)
      throw new FatalError('workflow_interrupted');
  } catch (error) {
    sanitize(error, 'indexing_failed');
  }
}

export async function completeDocumentJobStep(
  jobId: string,
  generation: number,
  runId: string
): Promise<void> {
  'use step';
  try {
    const admin = client();
    const args = fence(jobId, generation, runId);
    // A retried completion may observe its own already-committed ready state.
    await loadJob(admin, args, true);
    const { data, error } = await admin.rpc('complete_document_job', args);
    if (error) retry('workflow_interrupted');
    if (data !== true) throw new FatalError('workflow_interrupted');
  } catch (error) {
    sanitize(error, 'workflow_interrupted');
  }
}

export async function failDocumentJobStep(
  jobId: string,
  generation: number,
  runId: string,
  safeCode: JobErrorCode
): Promise<void> {
  'use step';
  try {
    if (!ERROR_CODES.includes(safeCode))
      throw new FatalError('workflow_interrupted');
    // The RPC checks the fence atomically; false means a cancelled/newer job wins.
    const { data, error } = await client().rpc('fail_document_job', {
      ...fence(jobId, generation, runId),
      p_error_code: safeCode
    });
    if (error || typeof data !== 'boolean') retry('workflow_interrupted');
  } catch (error) {
    sanitize(error, 'workflow_interrupted');
  }
}
