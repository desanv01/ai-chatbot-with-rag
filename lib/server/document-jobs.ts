import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getRun, start } from 'workflow/api';
import {
  DOCUMENT_JOB_ERROR_MESSAGES,
  DOCUMENT_JOB_STATUS_MESSAGES,
  type DocumentJobStatusView,
  type JobErrorCode,
  type JobStatus
} from '@/lib/document-job-types';
import { createAdminClient } from '@/lib/server/admin';
import { createServerSupabaseClient } from '@/lib/server/server';
import { ensureDocumentJobMaintenance } from '@/lib/server/document-job-maintenance-start';
import { documentProcessingWorkflow } from '@/workflows/document-processing';

type DocumentJobRow = {
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

type SafeJobRow = Pick<
  DocumentJobRow,
  | 'id'
  | 'user_id'
  | 'document_id'
  | 'file_name'
  | 'status'
  | 'total_pages'
  | 'completed_pages'
  | 'error_code'
  | 'created_at'
  | 'updated_at'
>;

// Narrow local contracts while main updates the authoritative generated schema.
type DocumentJobsDatabase = {
  public: {
    Tables: {
      document_processing_jobs: {
        Row: DocumentJobRow;
        Insert: DocumentJobRow;
        Update: Partial<DocumentJobRow>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      reserve_document_job: {
        Args: { p_user_id: string; p_file_name: string; p_file_path: string };
        Returns: DocumentJobRow[];
      };
      control_document_job: {
        Args: {
          p_job_id: string;
          p_user_id: string;
          p_action: 'resume' | 'cancel';
        };
        Returns: DocumentJobRow[];
      };
    };
  };
};

type JobClient = SupabaseClient<DocumentJobsDatabase>;
type JobDispatchResult = {
  job: DocumentJobStatusView;
  dispatchPending: boolean;
};

const SAFE_COLUMNS =
  'id,user_id,document_id,file_name,status,total_pages,completed_pages,error_code,created_at,updated_at';
const FULL_COLUMNS =
  'id,user_id,document_id,file_name,file_path,generation,run_id,status,parser_job_id,parser_submit_started_at,source_sha256,source_size,metadata,total_pages,completed_pages,error_code,created_at,updated_at';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return (
    typeof value === 'string' && value.length === 36 && UUID_PATTERN.test(value)
  );
}

async function requireOwner(
  userId: string
): Promise<{ userId: string; client: JobClient }> {
  if (!isUuid(userId)) throw new Error('Document job access denied.');
  const client = await createServerSupabaseClient();
  const { data, error } = await client.auth.getUser();
  const owner = userId.toLowerCase();
  if (error || data.user?.id.toLowerCase() !== owner) {
    throw new Error('Document job access denied.');
  }
  return { userId: owner, client: client as unknown as JobClient };
}

function statusView(job: SafeJobRow): DocumentJobStatusView {
  return {
    id: job.id,
    documentId: job.document_id,
    fileName: job.file_name,
    status: job.status,
    totalPages: job.total_pages,
    completedPages: job.completed_pages,
    errorCode: job.error_code,
    message: job.error_code
      ? DOCUMENT_JOB_ERROR_MESSAGES[job.error_code]
      : DOCUMENT_JOB_STATUS_MESSAGES[job.status],
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    canResume:
      (job.status === 'failed' || job.status === 'cancelled') &&
      job.error_code !== 'parser_submission_unknown' &&
      job.error_code !== 'source_invalid',
    canCancel: ['queued', 'parsing', 'metadata', 'indexing'].includes(
      job.status
    )
  };
}

function singleOwnedJob(
  rows: DocumentJobRow[] | null,
  userId: string
): DocumentJobRow {
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    rows[0]?.user_id !== userId
  ) {
    throw new Error('Document job is unavailable.');
  }
  return rows[0];
}

async function dispatch(job: DocumentJobRow): Promise<JobDispatchResult> {
  let dispatchPending = false;
  if (job.status === 'queued' && job.run_id === null) {
    try {
      await start(documentProcessingWorkflow, [job.id, job.generation]);
    } catch {
      // Acknowledged maintenance will redispatch; never delete the reserved job.
      dispatchPending = true;
    }
  }
  return { job: statusView(job), dispatchPending };
}

async function findOwnedJob(client: JobClient, userId: string, jobId: string) {
  if (!isUuid(jobId)) return null;
  const { data, error } = await client
    .from('document_processing_jobs')
    .select(SAFE_COLUMNS)
    .eq('user_id', userId)
    .eq('id', jobId.toLowerCase())
    .maybeSingle();
  if (error) throw new Error('Document job status is unavailable.');
  return data;
}

export async function queueDocumentJob(
  userId: string,
  fileName: string,
  filePath: string
): Promise<JobDispatchResult> {
  try {
    const owner = await requireOwner(userId);
    if (
      typeof fileName !== 'string' ||
      fileName.length === 0 ||
      fileName.length > 255 ||
      fileName !== fileName.trim() ||
      // eslint-disable-next-line no-control-regex -- Reject control characters in document filenames.
      /[\u0000-\u001f\u007f-\u009f]/.test(fileName) ||
      !fileName.toLowerCase().endsWith('.pdf') ||
      /[/\\]/.test(fileName) ||
      typeof filePath !== 'string' ||
      filePath.length !== 77 ||
      !filePath.startsWith(`${owner.userId}/`) ||
      !filePath.endsWith('.pdf') ||
      !isUuid(filePath.slice(37, -4)) ||
      filePath !== filePath.toLowerCase()
    ) {
      throw new Error('Invalid document upload.');
    }
    await ensureDocumentJobMaintenance();
    const admin = createAdminClient({
      requestTimeoutMs: 30_000
    }) as unknown as JobClient;
    const { data, error } = await admin.rpc('reserve_document_job', {
      p_user_id: owner.userId,
      p_file_name: fileName,
      p_file_path: filePath
    });
    if (error) throw new Error('Document job could not be reserved.');
    const job = singleOwnedJob(data, owner.userId);
    if (job.file_name !== fileName || job.file_path !== filePath) {
      throw new Error('Document reservation is invalid.');
    }
    return await dispatch(job);
  } catch {
    throw new Error('Unable to queue document processing. Please retry later.');
  }
}

export async function getOwnedDocumentJob(
  userId: string,
  jobId: string
): Promise<DocumentJobStatusView | null> {
  try {
    const owner = await requireOwner(userId);
    const job = await findOwnedJob(owner.client, owner.userId, jobId);
    return job ? statusView(job) : null;
  } catch {
    throw new Error('Document job status is unavailable.');
  }
}

export async function listOwnedDocumentJobs(
  userId: string,
  documentIds?: string[]
): Promise<DocumentJobStatusView[]> {
  try {
    if (
      documentIds !== undefined &&
      (!Array.isArray(documentIds) ||
        documentIds.length > 20 ||
        documentIds.some((id) => !isUuid(id)))
    ) {
      throw new Error('Invalid document identifiers.');
    }
    const ids =
      documentIds === undefined
        ? undefined
        : [...new Set(documentIds.map((id) => id.toLowerCase()))];
    const owner = await requireOwner(userId);
    let query = owner.client
      .from('document_processing_jobs')
      .select(SAFE_COLUMNS)
      .eq('user_id', owner.userId);
    if (ids !== undefined) {
      const activeFilter = 'status.in.(queued,parsing,metadata,indexing)';
      query = query.or(
        ids.length > 0
          ? `document_id.in.(${ids.join(',')}),${activeFilter}`
          : activeFilter
      );
    }
    const { data, error } = await query
      .order('updated_at', { ascending: false })
      .limit(ids === undefined ? 20 : 40);
    if (error) throw new Error('Document job status is unavailable.');
    return (data ?? []).map(statusView);
  } catch {
    throw new Error('Document job status is unavailable.');
  }
}

export async function controlDocumentJob(
  userId: string,
  jobId: string,
  action: 'resume' | 'cancel'
): Promise<JobDispatchResult | null> {
  try {
    const owner = await requireOwner(userId);
    if (action !== 'resume' && action !== 'cancel') {
      throw new Error('Invalid document job action.');
    }
    const visible = await findOwnedJob(owner.client, owner.userId, jobId);
    if (!visible) return null;
    const admin = createAdminClient({
      requestTimeoutMs: 30_000
    }) as unknown as JobClient;
    const { data: previous, error: readError } = await admin
      .from('document_processing_jobs')
      .select(FULL_COLUMNS)
      .eq('user_id', owner.userId)
      .eq('id', visible.id)
      .maybeSingle();
    if (readError) throw new Error('Document job is unavailable.');
    if (!previous) return null;
    if (action === 'resume') {
      if (
        !statusView(previous).canResume ||
        (previous.parser_submit_started_at !== null &&
          previous.parser_job_id === null)
      ) {
        throw new Error('This document job cannot be resumed.');
      }
      await ensureDocumentJobMaintenance();
    }
    const { data, error } = await admin.rpc('control_document_job', {
      p_job_id: visible.id,
      p_user_id: owner.userId,
      p_action: action
    });
    if (error) throw new Error('Document job could not be updated.');
    const job = singleOwnedJob(data, owner.userId);
    if (job.id !== visible.id) throw new Error('Document job is unavailable.');
    if (action === 'cancel') {
      if (
        job.status === 'cancelled' &&
        job.generation > previous.generation &&
        previous.run_id
      ) {
        try {
          await getRun(previous.run_id).cancel();
        } catch {
          // The committed generation fence is authoritative even if SDK cancellation fails.
        }
      }
      return { job: statusView(job), dispatchPending: false };
    }
    return await dispatch(job);
  } catch {
    throw new Error(
      'Unable to update document processing. Please retry later.'
    );
  }
}
