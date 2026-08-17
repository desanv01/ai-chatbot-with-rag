import { type NextRequest, NextResponse } from 'next/server';
import type { UIMessage } from 'ai';
import { streamText, convertToModelMessages, stepCountIs } from 'ai';
import { saveMessagesToDB } from './SaveToDbIncremental';

import type { OpenAIResponsesProviderOptions } from '@ai-sdk/openai';
import { openai } from '@ai-sdk/openai';

import type { AnthropicProviderOptions } from '@ai-sdk/anthropic';
import { anthropic } from '@ai-sdk/anthropic';

import { google } from '@ai-sdk/google';
import type { GoogleGenerativeAIProviderOptions } from '@ai-sdk/google';

import type { SharedV2ProviderMetadata } from '@ai-sdk/provider';

import { getSession } from '@/lib/server/supabase';
import { searchUserDocument } from './tools/documentChat';
import { websiteSearchTool } from './tools/WebsiteSearchTool';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const systemPrompt = `You are a helpful assistant. Answer all questions to the best of your ability. Use tools when necessary. Strive to only use a tool one time per question.

You have access to a searchUserDocument tool that can search through the user's uploaded documents. Use this tool when:
- The user asks questions about their documents
- The user references specific files or uploads
- The question seems related to content that might be in their documents

FORMATTING: Your responses are rendered using react-markdown with the following capabilities:
- GitHub Flavored Markdown (GFM) support through remarkGfm plugin
- Syntax highlighting for code blocks through rehypeHighlight plugin
- All standard markdown formatting`;

function errorHandler(error: unknown) {
  if (error == null) return 'Unknown error';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;

  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown error';
  }
}

function isGeminiQuotaError(err: any): boolean {
  const msg = err?.message?.toString?.() ?? '';
  const body = err?.data?.error?.message?.toString?.() ?? '';
  const combined = `${msg}\n${body}`.toLowerCase();

  return (
    combined.includes('quota exceeded') ||
    combined.includes('resource_exhausted') ||
    combined.includes('generate_content_free_tier') ||
    err?.statusCode === 429
  );
}

function isGeminiNotFoundError(err: any): boolean {
  const msg = err?.message?.toString?.() ?? '';
  const body = err?.data?.error?.message?.toString?.() ?? '';
  const combined = `${msg}\n${body}`.toLowerCase();
  return (
    err?.statusCode === 404 ||
    combined.includes('is not found for api version') ||
    combined.includes('not supported for generatecontent') ||
    combined.includes('models/')
  );
}

function readSelectedModel(body: any): string {
  return (
    body?.option ||
    body?.model ||
    body?.selectedModel ||
    body?.providerModel ||
    'gpt-5'
  );
}

/**
 * ✅ Allowlist of UI values the backend will accept.
 * Anything else will fall back safely.
 */
const ALLOWED_UI_MODELS = new Set([
  // OpenAI
  'gpt-5',
  'gpt-5-mini',
  'o3',

  // Anthropic
  'claude-4-sonnet',

  // Google (ONLY preview IDs!)
  'gemini-3-flash-preview',
  'gemini-3-pro-preview',
  'gemini-2.5-flash-preview-09-2025'
]);

/**
 * Normalize Google model ids.
 * ✅ IMPORTANT: Use only ids that work with v1beta generateContent.
 */
function normalizeGoogleModelId(selectedModel: string): string {
  const raw = (selectedModel ?? '').trim();

  const map: Record<string, string> = {
    // Correct IDs:
    'gemini-3-flash-preview': 'gemini-3-flash-preview',
    'gemini-3-pro-preview': 'gemini-3-pro-preview',
    'gemini-2.5-flash-preview-09-2025': 'gemini-2.5-flash-preview-09-2025',

    // Legacy IDs seen in older UI/code:
    'gemini-3-flash': 'gemini-3-flash-preview',
    'gemini-3-pro': 'gemini-3-pro-preview',
    'gemini-2.5-flash': 'gemini-2.5-flash-preview-09-2025',

    // Friendly labels:
    'Gemini 3 Flash': 'gemini-3-flash-preview',
    'Gemini 3 Pro': 'gemini-3-pro-preview',
    'Gemini 2.5 Flash': 'gemini-2.5-flash-preview-09-2025'
  };

  return map[raw] ?? raw;
}

/**
 * If GOOGLE_FREE_TIER_ONLY=true, force to a Flash model.
 * Otherwise allow Flash + Pro.
 */
function pickSafeGoogleModel(selectedModel: string): string {
  const freeOnly =
    (process.env.GOOGLE_FREE_TIER_ONLY ?? '').toLowerCase() === 'true';

  // ✅ Env must also be preview IDs (we normalize anyway)
  const defaultModel = normalizeGoogleModelId(
    process.env.GOOGLE_DEFAULT_MODEL || 'gemini-3-flash-preview'
  );
  const fallbackModel = normalizeGoogleModelId(
    process.env.GOOGLE_FALLBACK_MODEL || 'gemini-3-flash-preview'
  );

  const normalized = normalizeGoogleModelId(selectedModel);

  // When not free-only, allow Flash + Pro + (optional) 2.5 flash preview
  if (!freeOnly) {
    const allowedPaid = new Set([
      'gemini-3-flash-preview',
      'gemini-3-pro-preview',
      'gemini-2.5-flash-preview-09-2025'
    ]);
    return allowedPaid.has(normalized) ? normalized : defaultModel;
  }

  // Free-only: allow flash models only
  const allowedFree = new Set([
    'gemini-3-flash-preview',
    'gemini-2.5-flash-preview-09-2025'
  ]);

  if (allowedFree.has(normalized)) return normalized;

  // Force to default/fallback if user selected Pro
  if (allowedFree.has(defaultModel)) return defaultModel;
  return allowedFree.has(fallbackModel) ? fallbackModel : 'gemini-3-flash-preview';
}

/**
 * Convert selected model -> provider model instance
 */
function getModel(selectedModel: string) {
  switch (selectedModel) {
    case 'claude-4-sonnet':
      return anthropic('claude-sonnet-4-5');

    case 'gpt-5':
      return openai('gpt-5.1');

    case 'gpt-5-mini':
      return openai('gpt-5-mini');

    case 'o3':
      return openai('o3-2025-04-16');

    default: {
      // Any gemini selection lands here
      if (selectedModel.toLowerCase().includes('gemini')) {
        const safeGoogleModel = pickSafeGoogleModel(selectedModel);
        return google(safeGoogleModel);
      }

      console.error(
        'Invalid model selected:',
        selectedModel,
        'Falling back to gpt-5.1'
      );
      return openai('gpt-5.1');
    }
  }
}

export async function POST(req: NextRequest) {
  const session = await getSession();

  if (!session) {
    return new NextResponse(JSON.stringify({ message: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const body = await req.json();
  const messages: UIMessage[] = body.messages ?? [];
  const chatSessionId = body.chatId;
  const signal = body.signal;

  if (!chatSessionId) {
    return new NextResponse(
      JSON.stringify({ message: 'Chat session ID is empty.' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }

  const rawSelectedModel = readSelectedModel(body);
  const userId = session.sub;

  // ✅ First normalize possible legacy gemini values
  const normalizedIncoming = rawSelectedModel.toLowerCase().includes('gemini')
    ? normalizeGoogleModelId(rawSelectedModel)
    : rawSelectedModel;

  // ✅ Enforce allowlist (prevents old values like "gemini-3-flash" leaking)
  const safeIncoming = ALLOWED_UI_MODELS.has(normalizedIncoming)
    ? normalizedIncoming
    : 'gpt-5';

  // ✅ Then apply free-tier enforcement for Gemini
  const selectedModel = safeIncoming.toLowerCase().includes('gemini')
    ? pickSafeGoogleModel(safeIncoming)
    : safeIncoming;

  const providerOptions: SharedV2ProviderMetadata = {};

  if (selectedModel === 'claude-4-sonnet') {
    providerOptions.anthropic = {
      thinking: { type: 'enabled', budgetTokens: 12000 }
    } satisfies AnthropicProviderOptions;
  }

  if (selectedModel.toLowerCase().includes('gemini')) {
    providerOptions.google = {
      thinkingConfig: {
        thinkingBudget: 1024,
        includeThoughts: true
      }
    } satisfies GoogleGenerativeAIProviderOptions;
  }

  if (selectedModel === 'o3') {
    providerOptions.openai = {
      reasoningEffort: 'high'
    } satisfies OpenAIResponsesProviderOptions;
  }

  if (selectedModel === 'gpt-5' || selectedModel === 'gpt-5-mini') {
    providerOptions.openai = {
      reasoningEffort: 'low',
      reasoningSummary: 'auto',
      textVerbosity: 'medium'
    } satisfies OpenAIResponsesProviderOptions;
  }

  let stepCount = 0;
  let userMessageSaved = false;
  const assistantMessageId = crypto.randomUUID();

  const result = streamText({
    model: getModel(selectedModel),
    system: systemPrompt,
    messages: await convertToModelMessages(messages),
    abortSignal: signal,
    providerOptions,

    maxRetries: 0,

    tools: {
      websiteSearchTool,
      searchUserDocument: searchUserDocument({ userId })
    },
    activeTools: ['websiteSearchTool', 'searchUserDocument'],
    stopWhen: stepCountIs(5),

    onStepFinish: async (stepResult) => {
      try {
        const messagesToSave: UIMessage[] = [];

        if (stepCount === 0 && !userMessageSaved) {
          const lastMessage = messages[messages.length - 1];
          if (lastMessage) {
            messagesToSave.push(lastMessage);
            userMessageSaved = true;
          }
        }

        const uiMessage: UIMessage = {
          id: assistantMessageId,
          role: 'assistant',
          parts: []
        };

        stepResult.content.forEach((content) => {
          if (content.type === 'text') {
            uiMessage.parts.push({
              type: 'text',
              text: content.text,
              providerMetadata: content.providerMetadata
            } as any);
          } else if (content.type === 'reasoning') {
            uiMessage.parts.push({
              type: 'reasoning',
              text: content.text,
              providerMetadata: content.providerMetadata
            } as any);
          } else if (content.type === 'source') {
            if ('url' in content && 'title' in content) {
              uiMessage.parts.push({
                type: 'source-url',
                sourceId: content.id,
                url: (content as any).url,
                title: (content as any).title,
                providerMetadata: content.providerMetadata
              } as any);
            } else if ('mediaType' in content && 'filename' in content) {
              uiMessage.parts.push({
                type: 'source-document',
                sourceId: content.id,
                mediaType: (content as any).mediaType,
                title: (content as any).title || '',
                filename: (content as any).filename,
                providerMetadata: content.providerMetadata
              } as any);
            }
          } else if (content.type === 'file') {
            uiMessage.parts.push({
              type: 'file',
              url: content.file.base64
                ? `data:${content.file.mediaType};base64,${content.file.base64}`
                : '',
              mediaType: content.file.mediaType,
              filename: undefined,
              providerMetadata: content.providerMetadata
            } as any);
          } else if (content.type === 'tool-result') {
            uiMessage.parts.push({
              type: `tool-${content.toolName}`,
              toolCallId: content.toolCallId,
              state: 'output-available',
              input: content.input,
              output: content.output,
              providerExecuted: content.providerExecuted
            } as any);
          } else if (content.type === 'tool-error') {
            uiMessage.parts.push({
              type: `tool-${content.toolName}`,
              toolCallId: content.toolCallId,
              state: 'output-error',
              input: content.input,
              errorText: content.error?.toString() || 'Tool error occurred',
              providerExecuted: content.providerExecuted
            } as any);
          }
        });

        if (uiMessage.parts.length > 0) messagesToSave.push(uiMessage);

        if (messagesToSave.length > 0) {
          await saveMessagesToDB({
            chatSessionId,
            userId,
            messages: messagesToSave,
            isFirstStep: stepCount === 0,
            assistantMessageId
          });
        }

        stepCount++;
      } catch (error) {
        console.error(`Error saving step ${stepCount} to database:`, error);
      }
    },

    onError: async (err) => {
      if (isGeminiQuotaError(err)) {
        console.error(
          `Gemini quota/rate limit. User selected="${rawSelectedModel}", normalized="${normalizedIncoming}", backend used="${selectedModel}".`,
          err
        );
      } else if (isGeminiNotFoundError(err)) {
        console.error(
          `Gemini NOT_FOUND/unsupported model. User selected="${rawSelectedModel}", normalized="${normalizedIncoming}", backend used="${selectedModel}". ` +
            `Fix by using *preview* model ids and env defaults.`,
          err
        );
      } else {
        console.error('Error processing chat:', err);
      }
    }
  });

  result.consumeStream();

  return result.toUIMessageStreamResponse({
    sendReasoning: true,
    sendSources: true,
    onError: errorHandler
  });
}
