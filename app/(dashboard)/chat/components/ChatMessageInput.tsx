import type { KeyboardEvent } from 'react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';

import type { useChat } from '@ai-sdk/react';
import type { UIMessagePart } from 'ai';
import type { UITools } from '../types/tooltypes';

import {
  Send,
  Loader2,
  ChevronDown,
  Paperclip,
  Square,
  X,
  FileIcon,
  Plus
} from 'lucide-react';

import { ChatHistoryButton } from './ChatHistoryButton';
import Link from 'next/link';
import type { ChatModelOption } from '@/lib/model-config';
import {
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENTS_PER_MESSAGE,
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES
} from '@/lib/chat-attachment-limits';

type ChatHelpers = ReturnType<typeof useChat>;

interface MessageInputProps {
  chatId: string;
  selectedOption: string;
  handleOptionChange: (value: string) => void;
  sendMessage: ChatHelpers['sendMessage'];
  status: ChatHelpers['status'];
  stop: ChatHelpers['stop'];
}

type ModelsApiResponse = {
  defaultModel: string | null;
  googleFreeOnly: boolean;
  providers: { openai: boolean; anthropic: boolean; google: boolean };
  models: ChatModelOption[];
  webSearchConfigured: boolean;
};

// FilePreview component stays the same
const FilePreview = React.memo(
  ({
    file,
    onRemove,
    disabled
  }: {
    file: File;
    onRemove: () => void;
    disabled: boolean;
  }) => {
    const [previewUrl, setPreviewUrl] = useState<string>('');

    React.useEffect(() => {
      const url = URL.createObjectURL(file);
      setPreviewUrl(url);
      return () => {
        URL.revokeObjectURL(url);
      };
    }, [file]);

    return (
      <div className="group/thumbnail relative">
        <div
          className="rounded-lg overflow-hidden border-0.5 border-border-300/25 shadow-sm shadow-always-black/5 can-focus-within rounded-lg cursor-pointer hover:border-border-200/50 hover:shadow-always-black/10"
          style={{ width: 120, height: 120, minWidth: 120, minHeight: 120 }}
        >
          <div
            className="relative bg-bg-000"
            style={{ width: '100%', height: '100%' }}
          >
            {previewUrl && file.type === 'application/pdf' ? (
              <iframe
                src={previewUrl}
                title={`Preview of ${file.name}`}
                className="w-full h-full pointer-events-none"
                style={{
                  transform: 'scale(0.2)',
                  transformOrigin: 'top left',
                  width: '500%',
                  height: '500%'
                }}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-gray-100 dark:bg-gray-800">
                <FileIcon className="w-12 h-12 text-gray-400" />
              </div>
            )}
          </div>
          <div className="absolute bottom-2 left-0 right-0 px-2.5 overflow-x-hidden overflow-y-visible">
            <div className="relative flex flex-row items-center gap-1 justify-between">
              <div
                className="flex flex-row gap-1 shrink min-w-0"
                style={{ opacity: 1 }}
              >
                <div className="min-w-0 overflow-hidden h-[18px] flex flex-row items-center justify-center gap-0.5 px-1 border-0.5 border-border-300/25 shadow-sm rounded bg-bg-000/70 backdrop-blur-sm font-medium">
                  <p className="uppercase truncate font-styrene text-text-300 text-[11px] leading-[13px] overflow-hidden">
                    pdf
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRemove}
          disabled={disabled}
          className="transition-all hover:bg-bg-000/50 text-text-500 hover:text-text-200 group-focus-within/thumbnail:opacity-100 group-hover/thumbnail:opacity-100 opacity-0 w-5 h-5 absolute -top-2 -left-2 rounded-full border-0.5 border-border-300/25 bg-bg-000/90 backdrop-blur-sm flex items-center justify-center"
        >
          <X className="w-3 h-3" />
        </Button>
      </div>
    );
  }
);

FilePreview.displayName = 'FilePreview';

const MessageInput: React.FC<MessageInputProps> = ({
  chatId,
  selectedOption,
  handleOptionChange,
  sendMessage,
  status,
  stop
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const attachedFilesRef = useRef<File[]>([]);
  const submissionRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [input, setInput] = useState('');

  const [modelOptions, setModelOptions] = useState<ChatModelOption[]>([]);
  const [modelsStatus, setModelsStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading'
  );
  const [modelsLoadAttempt, setModelsLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function loadModels() {
      setModelsStatus('loading');
      setModelOptions([]);
      try {
        const res = await fetch('/api/models', { cache: 'no-store' });
        if (!res.ok) throw new Error(`Failed to load models: ${res.status}`);
        const data: ModelsApiResponse = await res.json();

        if (cancelled) return;

        const serverModels = Array.isArray(data.models) ? data.models : [];
        setModelOptions(serverModels);
        setModelsStatus('ready');
        if (serverModels.length > 0) {

          // If cookie contains an old/hidden model, auto-switch to server default
          const allowed = new Set<string>(serverModels.map((m) => m.value));
          if (!allowed.has(selectedOption)) {
            handleOptionChange(
              data.defaultModel && allowed.has(data.defaultModel)
                ? data.defaultModel
                : serverModels[0].value
            );
          }
        }
      } catch (err) {
        if (cancelled) return;
        setModelOptions([]);
        setModelsStatus('error');
        console.warn(err);
      }
    }

    loadModels();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelsLoadAttempt]);

  const modelAvailable =
    modelsStatus === 'ready' &&
    modelOptions.some((option) => option.value === selectedOption);
  const canSend = modelAvailable && (status === 'ready' || status === 'error');
  const modelStatusText =
    modelsStatus === 'loading'
      ? 'Loading models...'
      : modelsStatus === 'error'
        ? 'Models unavailable — click to retry'
        : modelOptions.length === 0
          ? 'Chat unavailable — no models configured'
          : null;

  const selectedLabel = useMemo(() => {
    return (
      modelStatusText ??
      modelOptions.find((o) => o.value === selectedOption)?.label ??
      selectedOption
    );
  }, [modelOptions, selectedOption, modelStatusText]);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (submissionRef.current) return;
    setInput(e.target.value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && event.shiftKey) {
      // newline
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (!canSend) return;
      handleFormSubmit(event);
    }
  };

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    if (submissionRef.current) return;
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.type !== 'application/pdf') {
      toast.error('Only PDF files are allowed');
      return;
    }

    if (file.size > MAX_CHAT_ATTACHMENT_BYTES) {
      toast.error('File is too large. Choose a PDF no larger than 3 MiB.');
      return;
    }

    const currentFiles = attachedFilesRef.current;
    if (currentFiles.length >= MAX_CHAT_ATTACHMENTS_PER_MESSAGE) {
      toast.error('A message can contain at most 4 PDFs. Remove a file first.', {
        id: 'chat-attachment-count-limit'
      });
      return;
    }

    const totalBytes = currentFiles.reduce(
      (total, attached) => total + attached.size,
      0
    );
    if (totalBytes + file.size > MAX_CHAT_ATTACHMENT_TOTAL_BYTES) {
      toast.error(
        'PDFs must total 3 MiB or less per message. Remove a file or choose a smaller PDF.',
        { id: 'chat-attachment-total-limit' }
      );
      return;
    }

    const nextFiles = [...currentFiles, file];
    attachedFilesRef.current = nextFiles;
    setAttachedFiles(nextFiles);
  };

  const removeFile = (index: number) => {
    if (submissionRef.current) return;
    const nextFiles = attachedFilesRef.current.filter((_, i) => i !== index);
    attachedFilesRef.current = nextFiles;
    setAttachedFiles(nextFiles);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const filesToBase64 = async (files: File[]) => {
    const promises = files.map((file) => {
      return new Promise<any>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = reader.result as string;
          resolve({
            type: 'file',
            filename: file.name,
            mediaType: file.type,
            url: base64
          });
        };
        reader.onerror = reject;
        reader.onabort = reject;
        reader.readAsDataURL(file);
      });
    });
    return Promise.all(promises);
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSend || submissionRef.current) return;
    const files = attachedFilesRef.current;
    if (!input.trim() && files.length === 0) return;

    submissionRef.current = true;
    setIsSubmitting(true);
    try {
      const parts: UIMessagePart<ChatHelpers, UITools>[] = [
        { type: 'text', text: input }
      ];

      if (files.length > 0) {
        try {
          const fileParts = await filesToBase64(files);
          parts.push(...fileParts);
        } catch {
          toast.error(
            'Unable to read the attached PDFs. Try again or remove a file.'
          );
          return;
        }
      }

      const submission = sendMessage(
        { role: 'user', parts },
        { body: { chatId, option: selectedOption } }
      );

      setInput('');
      attachedFilesRef.current = [];
      setAttachedFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = '';
      await submission;
    } catch {
      // Dispatched request errors are reported by the parent SDK onError handler.
    } finally {
      submissionRef.current = false;
      setIsSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleFormSubmit}
      className="relative max-w-[720px] mx-auto mb-1 backdrop-blur-sm rounded-2xl overflow-hidden border-1 shadow-sm flex flex-col transition-all duration-200 shadow-md dark:shadow-lg focus-within:shadow-lg dark:focus-within:shadow-xl hover:border-gray-300 dark:hover:border-gray-700 focus-within:border-gray-300 dark:focus-within:border-gray-700 cursor-text"
    >
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        disabled={isSubmitting}
        accept=".pdf,application/pdf"
        className="hidden"
      />

      <Textarea
        value={input}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        placeholder={modelStatusText ?? 'Type your message...'}
        disabled={!canSend || isSubmitting}
        className="w-full pt-3 pb-1.5 min-h-0 max-h-40 resize-none border-0 shadow-none focus:ring-0 focus-visible:ring-0 focus:outline-none bg-transparent focus:bg-transparent dark:bg-transparent dark:focus:bg-transparent"
        rows={1}
      />

      <div className="flex px-2.5 pb-1 pt-1.5 items-center gap-2 justify-between">
        <div className="flex items-center gap-2">
          <ChatHistoryButton />

          <div className="flex-1 ml-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={
                    modelsStatus === 'loading' ||
                    (modelsStatus === 'ready' && modelOptions.length === 0)
                  }
                  onClick={() => {
                    if (modelsStatus === 'error') {
                      setModelsLoadAttempt((attempt) => attempt + 1);
                    }
                  }}
                  className="w-full h-8 justify-between text-xs"
                >
                  <span className="truncate">{selectedLabel}</span>
                  <ChevronDown className="h-3 w-3 ml-2 flex-shrink-0 opacity-70" />
                </Button>
              </DropdownMenuTrigger>

              <DropdownMenuContent className="w-72">
                {modelOptions.map((option) => (
                  <DropdownMenuItem
                    key={option.value}
                    onClick={() => handleOptionChange(option.value)}
                    className={`text-xs flex items-center justify-between ${
                      selectedOption === option.value
                        ? 'bg-primary/20 dark:bg-primary/30 text-primary dark:text-primary-foreground'
                        : ''
                    }`}
                  >
                    <span>{option.label}</span>
                    <span className="text-[10px] opacity-70 ml-3">
                      {option.provider.toUpperCase()} •{' '}
                      {option.tier.toUpperCase()}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {attachedFiles.length === 0 && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={() => fileInputRef.current?.click()}
              className="h-8 w-8 sm:h-10 sm:w-10 hover:bg-primary/10 dark:hover:bg-primary/20 transition-colors border border-primary/30 rounded-lg cursor-pointer"
              disabled={!canSend || isSubmitting}
            >
              <Paperclip className="text-primary w-5 h-5 sm:w-6 sm:h-6" />
            </Button>
          )}

          <Button
            asChild
            size="icon"
            variant="ghost"
            className="h-8 w-8 sm:h-10 sm:w-10 hover:bg-primary/10 dark:hover:bg-primary/20 transition-colors border border-primary/30 rounded-lg"
          >
            <Link href="/chat">
              <Plus className="text-primary w-5 h-5 sm:w-6 sm:h-6" />
            </Link>
          </Button>

          {status !== 'ready' && status !== 'error' ? (
            <button
              type="button"
              aria-label="Stop response"
              title="Stop response"
              className="h-8 w-8 sm:h-10 sm:w-10 flex items-center justify-center border border-primary/30 cursor-pointer relative group rounded-lg bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              onClick={stop}
            >
              <Loader2
                aria-hidden="true"
                className="absolute w-5 h-5 sm:w-6 sm:h-6 text-primary animate-spin"
              />
              <Square
                aria-hidden="true"
                size={10}
                className="text-red-500 sm:h-3 sm:w-3"
              />
            </button>
          ) : (
            <Button
              type="submit"
              size="icon"
              variant="ghost"
              disabled={
                !canSend ||
                isSubmitting ||
                (!input.trim() && attachedFiles.length === 0)
              }
              className="h-8 w-8 sm:h-10 sm:w-10 hover:bg-primary/10 dark:hover:bg-primary/20 transition-colors border border-primary/30 rounded-lg cursor-pointer"
            >
              <Send className="text-primary w-5 h-5 sm:w-8 sm:h-8" />
            </Button>
          )}
        </div>
      </div>

      {attachedFiles.length > 0 && (
        <div className="overflow-hidden border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 rounded-b-2xl">
          <div className="flex flex-row overflow-x-auto gap-3 px-3.5 py-2.5">
            {attachedFiles.map((file, index) => (
              <FilePreview
                key={file.name + index}
                file={file}
                onRemove={() => removeFile(index)}
                disabled={isSubmitting}
              />
            ))}
          </div>
        </div>
      )}
    </form>
  );
};

export default MessageInput;
