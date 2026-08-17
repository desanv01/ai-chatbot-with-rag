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
const MAX_FILE_SIZE = 50 * 1024 * 1024;
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
  const [currentFileName, setCurrentFileName] = useState<string | null>(null);
  const [currentFilePath, setCurrentFilePath] = useState<string | null>(null);
  const [shouldCheckStatus, setShouldCheckStatus] = useState(false);
  const [shouldProcessDoc, setShouldProcessDoc] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  // Delete state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [documentToDelete, setDocumentToDelete] = useState<UserDocument | null>(
    null
  );
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const resetUploadState = useCallback(() => {
    setShouldCheckStatus(false);
    setShouldProcessDoc(false);
    mutate([`/api/checkdoc`, currentJobId], null, false);
    mutate(
      ['/api/processdoc', currentJobId, currentFilePath, currentFileName],
      null,
      false
    );
    setIsUploading(false);
    setUploadProgress(0);
    setUploadStatus('');
    setCurrentJobId(null);
    setCurrentFileName(null);
    setCurrentFilePath(null);
    setSelectedFile(null);
  }, [currentJobId, currentFileName, currentFilePath]);

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
    shouldCheckStatus && currentJobId ? [`/api/checkdoc`, currentJobId] : null,
    async ([url, jobId]) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId })
      });
      if (!response.ok) throw new Error('Failed to fetch processing status');
      return response.json();
    },
    {
      refreshInterval: 5000,
      revalidateOnFocus: false,
      onSuccess: (data) => {
        if (data.status === 'SUCCESS') {
          setUploadProgress(75);
          setUploadStatus('Finishing processing...');
          setShouldCheckStatus(false);
          setShouldProcessDoc(true);
        } else if (data.status === 'PENDING') {
          setUploadStatus('Analyzing file...');
        } else {
          setUploadStatus('Error analyzing file.');
          resetUploadState();
        }
      },
      onError: () => {
        setUploadStatus('Error analyzing file.');
        resetUploadState();
      }
    }
  );

  // SWR for processing document
  useSWR(
    shouldProcessDoc && currentJobId && currentFilePath && currentFileName
      ? ['/api/processdoc', currentJobId, currentFilePath, currentFileName]
      : null,
    async ([url, jobId, filePath, fileName]) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, fileName, filePath })
      });
      if (!response.ok) throw new Error('Failed to process document');
      return response.json();
    },
    {
      onSuccess: (data) => {
        if (data.status === 'SUCCESS') {
          setUploadProgress(100);
          setUploadStatus('Upload complete!');
          mutate('userFiles');
          router.refresh();
          setTimeout(() => resetUploadState(), 2000);
        } else {
          setUploadStatus('Error processing file.');
          resetUploadState();
        }
      },
      onError: () => {
        setUploadStatus('Fejl ved behandling af fil.');
        resetUploadState();
      }
    }
  );

  const uploadFile = useCallback(
    async (file: File) => {
      setIsUploading(true);
      setUploadProgress(0);
      setUploadStatus('Uploading...');

      let uploadedFilePath: string | null = null;

      try {
        // Original name used for display/title in your app
        const originalFileName = file.name.trim();

        const presignedResponse = await fetch('/api/upload/presigned-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: originalFileName,
            fileSize: file.size,
            fileType: file.type
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

        const processResponse = await fetch('/api/uploaddoc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            uploadedFiles: [
              // IMPORTANT:
              // - name: keep ORIGINAL name so your UI/doc title stays clean
              // - path: unique file path returned from presigned endpoint
              { name: originalFileName, path: uploadedFilePath }
            ]
          })
        });

        if (!processResponse.ok) {
          throw new Error('Error processing file');
        }

        const result = await processResponse.json();
        setUploadProgress(50);
        setUploadStatus('Analyzing file...');

        if (result.results?.[0]?.jobId) {
          setCurrentJobId(result.results[0].jobId);
          setCurrentFilePath(uploadedFilePath);

          // Keep ORIGINAL name here (usually used just for tracking/display)
          setCurrentFileName(originalFileName);

          setShouldCheckStatus(true);
        } else {
          throw new Error('No job ID received');
        }
      } catch (error) {
        console.error('Upload error:', error);

        if (uploadedFilePath) {
          try {
            await fetch('/api/upload/cleanup', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ filePath: uploadedFilePath })
            });
          } catch {
            // ignore cleanup errors
          }
        }

        setUploadStatus(
          error instanceof Error ? error.message : 'Upload failed'
        );
        setTimeout(() => resetUploadState(), 3000);
      }
    },
    [resetUploadState]
  );

  const onDrop = useCallback(
    (acceptedFiles: FileWithPath[], fileRejections: FileRejection[]) => {
      if (fileRejections.length > 0) return;
      const file = acceptedFiles[0];
      if (file) {
        setSelectedFile(file);
      }
    },
    []
  );

  const handleUploadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedFile && !isUploading) {
      await uploadFile(selectedFile);
    }
  };

  const handleRemoveSelectedFile = () => {
    setSelectedFile(null);
    resetUploadState();
    formRef.current?.reset();
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: SUPPORTED_FILE_TYPES,
    maxSize: MAX_FILE_SIZE,
    multiple: false,
    noClick: selectedFile !== null || isUploading
  });

  // Delete handlers
  const handleDeleteClick = (doc: UserDocument, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDocumentToDelete(doc);
    setDeleteDialogOpen(true);
  };

  const handleConfirmDelete = async () => {
    const document = documentToDelete;
    if (!document) return;

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
                PDF, max 50 MB
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
                      <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
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
                  >
                    <X className="w-4 h-4" />
                  </Button>
                )}
              </div>
              {!isUploading && (
                <Button type="submit" size="sm" className="w-full">
                  <Upload className="w-4 h-4 mr-2" />
                  Upload
                </Button>
              )}
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
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="flex-shrink-0 opacity-0 group-hover:opacity-100 h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={(e) => handleDeleteClick(doc, e)}
                      disabled={isDeleting}
                    >
                      {isDeleting ? (
                        <Loader className="w-4 h-4 animate-spin" />
                      ) : (
                        <Trash2 className="w-4 h-4" />
                      )}
                    </Button>
                  </>
                );

                const className = `group flex items-center gap-3 p-3 rounded-lg transition-colors ${
                  isSelected
                    ? 'bg-primary/10 border border-primary/20'
                    : 'hover:bg-muted/50'
                } ${isDeleting ? 'opacity-50 pointer-events-none' : ''}`;

                return (
                  <Link key={doc.id} href={docUrl} className={className}>
                    {content}
                  </Link>
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
