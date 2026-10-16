export type JobStatus =
  | 'queued'
  | 'parsing'
  | 'metadata'
  | 'indexing'
  | 'ready'
  | 'failed'
  | 'cancelled';

export type JobErrorCode =
  | 'source_invalid'
  | 'parser_submission_unknown'
  | 'parser_failed'
  | 'parser_timeout'
  | 'parse_result_invalid'
  | 'metadata_failed'
  | 'indexing_failed'
  | 'workflow_interrupted';

export interface DocumentJobStatusView {
  id: string;
  documentId: string;
  fileName: string;
  status: JobStatus;
  totalPages: number | null;
  completedPages: number;
  errorCode: JobErrorCode | null;
  message: string;
  createdAt: string;
  updatedAt: string;
  canResume: boolean;
  canCancel: boolean;
}

export const DOCUMENT_JOB_ERROR_MESSAGES: Record<JobErrorCode, string> = {
  source_invalid: 'The source file is invalid. Upload a new valid PDF file.',
  parser_submission_unknown:
    'The provider submission outcome needs review. Do not retry submission blindly.',
  parser_failed: 'Document parsing failed. You can resume processing.',
  parser_timeout: 'Document parsing timed out. You can resume processing.',
  parse_result_invalid:
    'The parsed document could not be validated. You can resume processing.',
  metadata_failed:
    'Document metadata could not be prepared. You can resume processing.',
  indexing_failed: 'Document indexing failed. You can resume processing.',
  workflow_interrupted:
    'Document processing was interrupted. You can resume processing.'
};

export const DOCUMENT_JOB_STATUS_MESSAGES: Record<JobStatus, string> = {
  queued: 'Document processing is queued.',
  parsing: 'Parsing the document.',
  metadata: 'Preparing document metadata.',
  indexing: 'Indexing document pages.',
  ready: 'Document is ready.',
  failed: 'Document processing could not be completed.',
  cancelled: 'Document processing was cancelled.'
};
