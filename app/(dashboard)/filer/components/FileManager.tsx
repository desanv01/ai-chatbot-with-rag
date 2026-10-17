'use client';

import { useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  useDropzone,
  type FileRejection,
  type FileWithPath
} from 'react-dropzone';
import useSWR, { mutate } from 'swr';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog';
import {
  FileText,
  Upload,
  Trash2,
  Calendar,
  Loader,
  X,
  FileStack
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { enUS } from 'date-fns/locale';
import Link from 'next/link';
import { deleteUserFile } from '../action';
import { encodeBase64 } from '@/utils/base64';
import { MAX_PDF_SIZE } from '@/lib/document-limits';
import type { DocumentJobStatusView } from '@/lib/document-job-types';
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious
} from '@/components/ui/pagination';

function getDocUrl(documentId: string): string {
  const encoded = encodeBase64(documentId);
  return `/filer?doc=${encodeURIComponent(encoded)}`;
}

interface UserDocument {
  id: string;
  title: string;
  created_at: string;
  total_pages: number | null;
  file_path: string | null;
  processing_status: string;
  processing_error: string | null;
  versionNumber?: number | null;
  versionSeriesId?: string | null;
  isCurrentVersion?: boolean;
  versionDisplayName?: string | null;
}

interface FileManagerProps {
  documents: UserDocument[];
  selectedDocFileName: string | null;
  currentPage: number;
}

const ITEMS_PER_PAGE = 10;

const SUPPORTED_FILE_TYPES: Record<string, string[]> = {
  'application/pdf': ['.pdf', '.PDF']
};
const MAX_STATUS_POLLS = 120;
const isActiveDocumentJob = (job: DocumentJobStatusView) =>
  ['queued', 'parsing', 'metadata', 'indexing'].includes(job.status);
export function FileManager({
  documents,
  selectedDocFileName,
  currentPage
}: FileManagerProps) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement | null>(null);

  // Pagination
  const totalPages = Math.ceil(documents.length / ITEMS_PER_PAGE);
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const paginatedDocuments = documents.slice(
    startIndex,
    startIndex + ITEMS_PER_PAGE
  );

  const getPageUrl = (page: number) => {
    const params = new URLSearchParams();
    if (page > 1) params.set('page', page.toString());
    if (selectedDocFileName) params.set('doc', selectedDocFileName);
    const queryString = params.toString();
    return `/filer${queryString ? `?${queryString}` : ''}`;
  };

  // Upload state
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatus, setUploadStatus] = useState('');
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [currentJobToken, setCurrentJobToken] = useState<string | null>(null);
  const [currentFileName, setCurrentFileName] = useState<string | null>(null);
  const [currentFilePath, setCurrentFilePath] = useState<string | null>(null);
  const [shouldCheckStatus, setShouldCheckStatus] = useState(false);
  const uploadInFlightRef = useRef(false);
  const activeJobRef = useRef<string | null>(null);
  const processedJobRef = useRef<string | null>(null);
  const statusPollCountRef = useRef(0);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [replacementTarget, setReplacementTarget] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const replacementTargetRef = useRef<{ id: string; title: string } | null>(
    null
  );
  const durableUploadRef = useRef(false);
  const ownedJobsRef = useRef<DocumentJobStatusView[]>([]);
  const pendingJobActionsRef = useRef(new Set<string>());
  const [pendingJobActions, setPendingJobActions] = useState<string[]>([]);
  const [jobActionError, setJobActionError] = useState('');
  const jobSnapshotRef = useRef('');
  const documentIds = paginatedDocuments.map((doc) => doc.id).join(',');
  const jobsKey = documentIds
    ? `/api/document-jobs?documentIds=${encodeURIComponent(documentIds)}`
    : '/api/document-jobs';
  const {
    data: jobsData,
    error: jobsError,
    isLoading: jobsLoading,
    mutate: refreshJobs
  } = useSWR<{ jobs: DocumentJobStatusView[] }>(
    jobsKey,
    async (url: string) => {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok)
        throw new Error('Document processing status is unavailable.');
      const data = await response.json();
      if (!Array.isArray(data.jobs)) {
        throw new Error('Document processing status is unavailable.');
      }
      return data;
    },
    {
      refreshInterval: (data) =>
        data?.jobs.some(isActiveDocumentJob) ? 5000 : 0,
      revalidateOnMount: true,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      shouldRetryOnError: false,
      onSuccess: (data) => {
        ownedJobsRef.current = data.jobs;
        durableUploadRef.current = false;
        const snapshot = JSON.stringify(
          data.jobs.map((job) => [
            job.id,
            job.status,
            job.completedPages,
            job.updatedAt
          ])
        );
        if (jobSnapshotRef.current && jobSnapshotRef.current !== snapshot) {
          router.refresh();
        }
        jobSnapshotRef.current = snapshot;
      }
    }
  );
  const jobs = jobsData?.jobs ?? [];
  const hasActiveDurableJob = jobs.some(isActiveDocumentJob);
  const uploadBlocked =
    isUploading ||
    jobsLoading ||
    Boolean(jobsError) ||
    hasActiveDurableJob ||
    pendingJobActions.length > 0;

  const controlJob = async (
    job: DocumentJobStatusView,
    action: 'resume' | 'cancel'
  ) => {
    if (pendingJobActionsRef.current.has(job.id)) return;
    const latestJob = ownedJobsRef.current.find((item) => item.id === job.id);
    if (!latestJob) return;
    if (
      action === 'resume' &&
      (!latestJob.canResume ||
        latestJob.errorCode === 'source_invalid' ||
        latestJob.errorCode === 'parser_submission_unknown' ||
        durableUploadRef.current ||
        uploadInFlightRef.current ||
        pendingJobActionsRef.current.size > 0 ||
        ownedJobsRef.current.some(
          (other) => other.id !== job.id && isActiveDocumentJob(other)
        ))
    )
      return;
    if (action === 'cancel' && !latestJob.canCancel) return;
    pendingJobActionsRef.current.add(job.id);
    setPendingJobActions([...pendingJobActionsRef.current]);
    setJobActionError('');
    try {
      const response = await fetch(`/api/document-jobs/${job.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
      if (!response.ok) {
        setJobActionError(
          'Unable to update document processing. Refresh the status and try again.'
        );
      }
    } catch {
      setJobActionError(
        'Unable to update document processing. Refresh the status before trying again.'
      );
    } finally {
      try {
        await refreshJobs();
      } catch {
        setJobActionError(
          'Document processing status is unavailable. Refresh before trying again.'
        );
      }
      router.refresh();
      pendingJobActionsRef.current.delete(job.id);
      setPendingJobActions([...pendingJobActionsRef.current]);
    }
  };

  // Delete state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [documentToDelete, setDocumentToDelete] = useState<UserDocument | null>(
    null
  );
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const resetUploadState = useCallback(
    (status = '', clearReplacement = false) => {
      uploadInFlightRef.current = false;
      activeJobRef.current = null;
      setShouldCheckStatus(false);
      setIsUploading(false);
      setUploadProgress(0);
      setUploadStatus(status);
      setCurrentJobId(null);
      setCurrentJobToken(null);
      setCurrentFileName(null);
      setCurrentFilePath(null);
      setSelectedFile(null);
      if (clearReplacement) {
        replacementTargetRef.current = null;
        setReplacementTarget(null);
      }
      formRef.current?.reset();
    },
    []
  );

  // Explicit mutation: each successful parser job is processed once in this UI.
  const processCurrentJob = async () => {
    if (
      !currentJobId ||
      !currentJobToken ||
      !currentFilePath ||
      !currentFileName ||
      activeJobRef.current !== currentJobId ||
      processedJobRef.current === currentJobId
    )
      return;
    const jobId = currentJobId;
    processedJobRef.current = jobId;
    try {
      const response = await fetch('/api/processdoc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId,
          jobToken: currentJobToken,
          fileName: currentFileName,
          filePath: currentFilePath
        })
      });
      const data = await response.json();
      if (!response.ok || data.status !== 'SUCCESS') {
        throw new Error(data.error || 'Failed to process document');
      }
      if (activeJobRef.current !== jobId) return;
      setUploadProgress(100);
      setUploadStatus('Upload complete!');
      mutate('userFiles');
      router.refresh();
      setTimeout(() => {
        if (activeJobRef.current === jobId) resetUploadState('', true);
      }, 2000);
    } catch (error) {
      if (activeJobRef.current === jobId) {
        router.refresh();
        resetUploadState(
          error instanceof Error ? error.message : 'Error processing file.'
        );
      }
    }
  };

  // Check if a document is selected based on URL
  const isDocSelected = (doc: UserDocument) => {
    if (!selectedDocFileName) return false;
    return (
      encodeBase64(doc.id) === selectedDocFileName ||
      encodeBase64(doc.title) === selectedDocFileName
    );
  };

  // SWR for checking document processing status
  useSWR(
    shouldCheckStatus && currentJobId && currentJobToken
      ? [`/api/checkdoc`, currentJobId, currentJobToken]
      : null,
    async ([url, jobId, jobToken]) => {
      try {
        if (
          activeJobRef.current !== jobId ||
          statusPollCountRef.current >= MAX_STATUS_POLLS
        ) {
          throw new Error(
            'Analysis timed out after 120 status checks. Select a file to start a fresh upload.'
          );
        }
        statusPollCountRef.current += 1;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId, jobToken })
        });
        if (!response.ok) throw new Error('Failed to fetch processing status');
        return { ...(await response.json()), polledJobId: jobId };
      } catch (error) {
        throw Object.assign(
          new Error(
            error instanceof Error ? error.message : 'Error analyzing file.'
          ),
          { jobId }
        );
      }
    },
    {
      refreshInterval: 5000,
      // Keep active-job polling in background tabs within the job key and 120-poll cap.
      refreshWhenHidden: true,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      shouldRetryOnError: false,
      onSuccess: (data) => {
        if (
          data.polledJobId !== activeJobRef.current ||
          processedJobRef.current === data.polledJobId
        )
          return;
        if (data.status === 'SUCCESS') {
          setUploadProgress(75);
          setUploadStatus('Finishing processing...');
          setShouldCheckStatus(false);
          void processCurrentJob();
        } else if (data.status === 'PENDING') {
          if (statusPollCountRef.current >= MAX_STATUS_POLLS) {
            resetUploadState(
              'Analysis timed out after 120 status checks. Select a file to start a fresh upload.'
            );
            return;
          }
          setUploadStatus('Analyzing file...');
        } else {
          resetUploadState('Error analyzing file.');
        }
      },
      onError: (error: Error & { jobId?: string }) => {
        if (activeJobRef.current === error.jobId)
          resetUploadState(error.message);
      }
    }
  );

  const uploadFile = useCallback(
    async (file: File) => {
      if (
        uploadInFlightRef.current ||
        uploadBlocked ||
        durableUploadRef.current ||
        pendingJobActionsRef.current.size > 0 ||
        ownedJobsRef.current.some(isActiveDocumentJob)
      )
        return;
      const replacement = replacementTargetRef.current;
      if (
        replacement &&
        !documents.some(
          (doc) =>
            doc.id === replacement.id &&
            doc.processing_status === 'ready' &&
            doc.isCurrentVersion !== false
        )
      ) {
        setUploadStatus(
          'This document is no longer available for replacement. Cancel replacement and select a current ready document.'
        );
        return;
      }
      uploadInFlightRef.current = true;
      const replacementDocumentId = replacementTargetRef.current?.id;
      setIsUploading(true);
      setUploadProgress(0);
      setUploadStatus('Uploading...');

      let uploadedFilePath: string | null = null;
      let queueAttempted = false;

      try {
        // Original name used for display/title in your app
        const originalFileName = file.name.trim();
        if (
          !/\.pdf$/i.test(originalFileName) ||
          file.size > MAX_PDF_SIZE ||
          file.size === 0
        ) {
          throw new Error('Select a PDF no larger than 25 MiB');
        }

        const presignedResponse = await fetch('/api/upload/presigned-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: originalFileName,
            fileSize: file.size,
            fileType: file.type,
            ...(replacementDocumentId ? { replacementDocumentId } : {})
          })
        });

        if (!presignedResponse.ok) {
          const error = await presignedResponse.json();
          throw new Error(error.message || 'Could not get upload URL');
        }

        const { uploadUrl, filePath, totalSize, maxSize } =
          await presignedResponse.json();

        if (totalSize + file.size > maxSize) {
          throw new Error(`Max size exceeded (${maxSize / (1024 * 1024)} MB)`);
        }

        uploadedFilePath = filePath;
        setUploadProgress(20);

        const uploadResponse = await fetch(uploadUrl, {
          method: 'PUT',
          body: file,
          headers: { 'Content-Type': file.type || 'application/octet-stream' }
        });

        if (!uploadResponse.ok) {
          throw new Error('Could not upload file');
        }

        setUploadProgress(40);
        setUploadStatus('Preparing analysis...');

        // Once queue submission begins, a lost browser response cannot prove
        // that the server did not accept ownership of the source file.
        queueAttempted = true;
        const processResponse = await fetch('/api/uploaddoc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            uploadedFiles: [
              // IMPORTANT:
              // - name: keep ORIGINAL name so your UI/doc title stays clean
              // - path: unique file path returned from presigned endpoint
              {
                name: originalFileName,
                path: uploadedFilePath,
                ...(replacementDocumentId ? { replacementDocumentId } : {})
              }
            ]
          })
        });

        if (!processResponse.ok) {
          throw new Error('Error processing file');
        }

        const result = await processResponse.json();
        if (result.results?.[0]?.durable === true) {
          durableUploadRef.current = true;
          void mutate('userFiles').catch(() => {
            // The owned server job remains accepted if this optional cache refresh fails.
          });
          router.refresh();
          try {
            const refreshed = await refreshJobs();
            if (refreshed) {
              ownedJobsRef.current = refreshed.jobs;
              durableUploadRef.current = false;
            }
          } catch {
            // The accepted server job retains ownership even if status refresh fails.
          } finally {
            resetUploadState(
              replacementDocumentId
                ? 'Processing continues on the server; you can leave this page. The previous version stays current until the new PDF is ready.'
                : 'Processing continues on the server; you can leave this page.',
              true
            );
          }
          return;
        }
        setUploadProgress(50);
        setUploadStatus('Analyzing file...');

        if (result.results?.[0]?.jobId && result.results?.[0]?.jobToken) {
          activeJobRef.current = result.results[0].jobId;
          statusPollCountRef.current = 0;
          setCurrentJobId(result.results[0].jobId);
          setCurrentJobToken(result.results[0].jobToken);
          setCurrentFilePath(uploadedFilePath);

          // Keep ORIGINAL name here (usually used just for tracking/display)
          setCurrentFileName(originalFileName);

          setShouldCheckStatus(true);
        } else {
          throw new Error(
            result.results?.[0]?.message || 'No signed processing job received'
          );
        }
      } catch (error) {
        console.error('Upload error:', error);

        if (uploadedFilePath && !queueAttempted) {
          try {
            await fetch('/api/upload/cleanup', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ filePath: uploadedFilePath })
            });
          } catch {
            // Preserve the original upload error if staged-object cleanup fails.
          }
        }

        if (queueAttempted) {
          durableUploadRef.current = true;
          router.refresh();
          try {
            const refreshed = await refreshJobs();
            if (refreshed) {
              ownedJobsRef.current = refreshed.jobs;
              durableUploadRef.current = false;
            }
          } catch {
            // Keep the source and require status recovery before another upload.
          }
        }
        resetUploadState(
          queueAttempted
            ? 'The processing acknowledgment could not be confirmed. Refresh processing status before uploading again; the source file has been preserved.'
            : error instanceof Error
              ? error.message
              : 'Upload failed'
        );
      }
    },
    [resetUploadState, uploadBlocked, refreshJobs, router, documents]
  );

  const onDrop = useCallback(
    (acceptedFiles: FileWithPath[], fileRejections: FileRejection[]) => {
      if (
        uploadBlocked ||
        durableUploadRef.current ||
        uploadInFlightRef.current
      )
        return;
      if (fileRejections.length > 0) {
        setUploadStatus('Select a PDF no larger than 25 MiB');
        return;
      }
      const file = acceptedFiles[0];
      if (file) {
        setUploadStatus('');
        setSelectedFile(file);
      }
    },
    [uploadBlocked]
  );

  const handleUploadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedFile && !uploadBlocked) {
      await uploadFile(selectedFile);
    }
  };

  const handleRemoveSelectedFile = () => {
    if (uploadInFlightRef.current) return;
    setSelectedFile(null);
    resetUploadState();
    formRef.current?.reset();
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: SUPPORTED_FILE_TYPES,
    maxSize: MAX_PDF_SIZE,
    disabled: uploadBlocked,
    multiple: false,
    noClick: selectedFile !== null || uploadBlocked
  });

  // Delete handlers
  const handleSelectReplacement = (doc: UserDocument) => {
    if (
      uploadBlocked ||
      uploadInFlightRef.current ||
      durableUploadRef.current ||
      pendingJobActionsRef.current.size > 0 ||
      ownedJobsRef.current.some(isActiveDocumentJob) ||
      doc.processing_status !== 'ready' ||
      doc.isCurrentVersion === false ||
      replacementTargetRef.current
    )
      return;
    replacementTargetRef.current = { id: doc.id, title: doc.title };
    setReplacementTarget({ id: doc.id, title: doc.title });
    resetUploadState(
      `Replace ${doc.title}; old version stays available until the new PDF is ready.`
    );
  };

  const handleCancelReplacement = () => {
    if (uploadInFlightRef.current || isUploading) return;
    resetUploadState('', true);
  };

  const handleDeleteClick = (doc: UserDocument, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (doc.versionSeriesId) return;
    setDocumentToDelete(doc);
    setDeleteDialogOpen(true);
  };

  const handleConfirmDelete = async () => {
    const document = documentToDelete;
    if (!document || document.versionSeriesId) return;

    setDeletingId(document.id);
    setDeleteDialogOpen(false);

    const formData = new FormData();
    formData.append('file_id', document.id);

    const result = await deleteUserFile(formData);
    if (result.success) {
      // If deleted doc was selected, clear URL
      if (isDocSelected(document)) {
        router.push('/filer');
      }
      router.refresh();
    }
    setDeletingId(null);
    setDocumentToDelete(null);
  };

  return (
    <>
      <div className="w-[400px] flex flex-col border rounded-lg bg-card">
        {/* Upload Area */}
        <form
          onSubmit={handleUploadSubmit}
          ref={formRef}
          className="p-4 border-b"
        >
          {replacementTarget && (
            <div className="space-y-2 mb-3">
              <p
                role="status"
                aria-live="polite"
                className="text-xs text-muted-foreground"
              >
                Replace {replacementTarget.title}; old version stays available
                until the new PDF is ready.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isUploading}
                onClick={handleCancelReplacement}
              >
                Cancel replacement
              </Button>
            </div>
          )}
          {!selectedFile && !isUploading ? (
            <div
              {...getRootProps()}
              className={`border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors ${
                isDragActive
                  ? 'border-primary bg-primary/5'
                  : 'border-muted hover:border-primary/50'
              }`}
            >
              <input {...getInputProps()} />
              <Upload
                className={`w-6 h-6 mx-auto mb-2 ${
                  isDragActive ? 'text-primary' : 'text-muted-foreground'
                }`}
              />
              <p className="text-sm font-medium">
                {isDragActive ? 'Drop file here' : 'Drag file here or click'}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                PDF, max 25 MiB
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
                <FileText className="w-5 h-5 text-primary flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">
                    {selectedFile?.name}
                  </p>
                  {isUploading && (
                    <div className="mt-2">
                      <Progress value={uploadProgress} className="h-1.5" />
                      <p
                        role="status"
                        aria-live="polite"
                        className="text-xs text-muted-foreground mt-1 flex items-center gap-1"
                      >
                        {uploadStatus}
                        {uploadProgress < 100 && (
                          <Loader className="w-3 h-3 animate-spin" />
                        )}
                      </p>
                    </div>
                  )}
                </div>
                {!isUploading && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={handleRemoveSelectedFile}
                    aria-label="Remove selected PDF"
                  >
                    <X className="w-4 h-4" />
                  </Button>
                )}
              </div>
              {!isUploading && (
                <Button
                  type="submit"
                  size="sm"
                  className="w-full"
                  disabled={uploadBlocked}
                >
                  <Upload className="w-4 h-4 mr-2" />
                  Upload
                </Button>
              )}
            </div>
          )}
          {!isUploading && uploadStatus && (
            <p
              role="status"
              aria-live="polite"
              className="text-xs text-muted-foreground mt-2"
            >
              {uploadStatus}
            </p>
          )}
          {hasActiveDurableJob && (
            <p
              role="status"
              aria-live="polite"
              className="text-xs text-muted-foreground mt-2"
            >
              A document is processing on the server. Wait for it to finish or
              cancel it before uploading another PDF.
            </p>
          )}
          {(jobsError || jobActionError) && (
            <div
              role="status"
              aria-live="polite"
              className="text-xs text-muted-foreground mt-2"
            >
              <p>
                {jobActionError ||
                  'Document processing status is unavailable. Refresh before uploading another PDF.'}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setJobActionError('');
                  void refreshJobs()
                    .then((data) => {
                      if (data) {
                        ownedJobsRef.current = data.jobs;
                        durableUploadRef.current = false;
                      }
                    })
                    .catch(() => {
                      setJobActionError(
                        'Document processing status is unavailable. Please try again.'
                      );
                    });
                }}
              >
                Refresh processing status
              </Button>
            </div>
          )}
        </form>

        {/* File List */}
        <ScrollArea className="flex-1">
          {documents.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full p-8 text-center">
              <FileStack className="w-12 h-12 text-muted-foreground/50 mb-3" />
              <p className="text-sm text-muted-foreground">
                No documents uploaded yet
              </p>
            </div>
          ) : (
            <div className="p-2 space-y-1">
              {paginatedDocuments.map((doc) => {
                const isSelected = isDocSelected(doc);
                const isDeleting = deletingId === doc.id;
                const docUrl = getDocUrl(doc.id);
                const job = jobs.find((item) => item.documentId === doc.id);
                const canResume =
                  job?.canResume &&
                  job.errorCode !== 'source_invalid' &&
                  job.errorCode !== 'parser_submission_unknown';
                const jobPending = job
                  ? pendingJobActions.includes(job.id)
                  : false;
                const timeAgo = formatDistanceToNow(new Date(doc.created_at), {
                  addSuffix: true,
                  locale: enUS
                });

                const content = (
                  <>
                    <div
                      className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${
                        isSelected
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted'
                      }`}
                    >
                      <FileText className="w-4 h-4" />
                    </div>
                    <div className="min-w-0 flex-1 overflow-hidden">
                      <p
                        className="text-sm font-medium truncate max-w-[240px]"
                        title={doc.title}
                      >
                        {doc.title}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Version {doc.versionNumber ?? 1} ·{' '}
                        {doc.isCurrentVersion !== false
                          ? 'Current'
                          : doc.processing_status !== 'ready'
                            ? doc.processing_status === 'failed'
                              ? 'Inactive new version; previous version remains current'
                              : 'Pending new version — not active; previous version remains current'
                            : 'Previous'}
                      </p>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Calendar className="w-3 h-3 flex-shrink-0" />
                        <span className="truncate">{timeAgo}</span>
                        {doc.total_pages && (
                          <>
                            <span>·</span>
                            <span className="flex-shrink-0">
                              {doc.total_pages} pages
                            </span>
                          </>
                        )}
                      </div>
                      {!job && (
                        <p className="text-xs text-muted-foreground mt-1">
                          {doc.processing_status === 'ready'
                            ? 'Ready'
                            : doc.processing_status === 'failed'
                              ? 'Failed'
                              : 'Processing - not searchable'}
                        </p>
                      )}
                      {!job && doc.processing_status === 'failed' && (
                        <p className="text-xs text-muted-foreground mt-1">
                          {doc.processing_error?.startsWith(
                            'Legacy document requires review.'
                          )
                            ? 'Review and back up this existing document before deliberately deleting it and uploading it again.'
                            : 'Legacy processing did not complete. Review the existing job before deliberately retrying.'}
                        </p>
                      )}
                      {!job && doc.processing_status === 'processing' && (
                        <p className="text-xs text-muted-foreground mt-1">
                          This legacy job cannot be resumed here. Check its
                          existing processing outcome before retrying.
                        </p>
                      )}
                    </div>
                    {!doc.versionSeriesId && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="flex-shrink-0 opacity-0 group-hover:opacity-100 h-8 w-8 text-muted-foreground hover:text-destructive"
                        onClick={(e) => handleDeleteClick(doc, e)}
                        disabled={isDeleting}
                        aria-label={`Delete document: ${doc.title}`}
                      >
                        {isDeleting ? (
                          <Loader className="w-4 h-4 animate-spin" />
                        ) : (
                          <Trash2 className="w-4 h-4" />
                        )}
                      </Button>
                    )}
                  </>
                );

                const className = `group flex items-center gap-3 p-3 rounded-lg transition-colors ${
                  isSelected
                    ? 'bg-primary/10 border border-primary/20'
                    : 'hover:bg-muted/50'
                } ${isDeleting ? 'opacity-50 pointer-events-none' : ''}`;

                return (
                  <div key={doc.id}>
                    <Link href={docUrl} className={className}>
                      {content}
                    </Link>
                    {doc.processing_status === 'ready' &&
                      doc.isCurrentVersion !== false && (
                        <div className="px-3 pb-3">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            aria-label={`Replace PDF: ${doc.title}`}
                            disabled={
                              uploadBlocked || replacementTarget !== null
                            }
                            onClick={() => handleSelectReplacement(doc)}
                          >
                            Replace PDF
                          </Button>
                        </div>
                      )}
                    {job && (
                      <div className="px-3 pb-3 space-y-2">
                        <div
                          role="status"
                          aria-live="polite"
                          className="text-xs text-muted-foreground"
                        >
                          <p>Stage: {job.status}</p>
                          <p>{job.message}</p>
                          <p>
                            {job.totalPages !== null
                              ? `${job.completedPages} of ${job.totalPages} physical pages completed`
                              : `${job.completedPages} physical pages completed; total pending`}
                          </p>
                        </div>
                        {(canResume || job.canCancel) && (
                          <div className="flex items-center gap-2">
                            {canResume && (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                aria-label={`Resume processing: ${doc.title}`}
                                disabled={
                                  jobPending ||
                                  isUploading ||
                                  Boolean(jobsError) ||
                                  pendingJobActions.length > 0 ||
                                  jobs.some(
                                    (other) =>
                                      other.id !== job.id &&
                                      isActiveDocumentJob(other)
                                  )
                                }
                                onClick={() => void controlJob(job, 'resume')}
                              >
                                Resume
                              </Button>
                            )}
                            {job.canCancel && (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                aria-label={`Cancel processing: ${doc.title}`}
                                disabled={jobPending}
                                onClick={() => void controlJob(job, 'cancel')}
                              >
                                Cancel
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>

        {/* Footer with pagination */}
        <div className="p-3 border-t">
          {totalPages > 1 ? (
            <Pagination>
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    href={currentPage > 1 ? getPageUrl(currentPage - 1) : '#'}
                    className={
                      currentPage <= 1 ? 'pointer-events-none opacity-50' : ''
                    }
                  />
                </PaginationItem>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map(
                  (page) => (
                    <PaginationItem key={page}>
                      <PaginationLink
                        href={getPageUrl(page)}
                        isActive={page === currentPage}
                      >
                        {page}
                      </PaginationLink>
                    </PaginationItem>
                  )
                )}
                <PaginationItem>
                  <PaginationNext
                    href={
                      currentPage < totalPages
                        ? getPageUrl(currentPage + 1)
                        : '#'
                    }
                    className={
                      currentPage >= totalPages
                        ? 'pointer-events-none opacity-50'
                        : ''
                    }
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          ) : (
            <p className="text-xs text-muted-foreground text-center">
              {documents.length} document{documents.length !== 1 ? 's' : ''}
            </p>
          )}
        </div>
      </div>

      {/* Delete Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete document?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{documentToDelete?.title}
              &quot;? This will also remove the document from your chat context.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete Document
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
