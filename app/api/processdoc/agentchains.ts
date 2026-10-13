import 'server-only';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { google } from '@ai-sdk/google';

const ENRICHMENT_TIMEOUT_MS = 45_000;
const ENRICHMENT_MAX_OUTPUT_TOKENS = 1024;
const ENRICHMENT_PROVIDER_OPTIONS = {
  google: {
    thinkingConfig: { thinkingLevel: 'minimal' }
  }
} as const;

const contentAnalysisSchema = z.object({
  preliminary_answer_1: z.string(),
  preliminary_answer_2: z.string(),
  tags: z.array(z.string()),
  hypothetical_question_1: z.string(),
  hypothetical_question_2: z.string()
});

export const preliminaryAnswerChainAgent = async (
  content: string,
  outerSignal?: AbortSignal
) => {
  const SystemPrompt =
    'Given the content below, perform an analysis. Generate two preliminary answers, tag key concepts, and generate two hypothetical questions. Keep outputs relevant to the text. Answer in the same language as the input.';

  const { output, usage } = await generateText({
    model: google('gemini-3-flash-preview'),
    system: SystemPrompt,
    prompt: content,
    output: Output.object({ schema: contentAnalysisSchema }),
    maxRetries: 0,
    maxOutputTokens: ENRICHMENT_MAX_OUTPUT_TOKENS,
    providerOptions: ENRICHMENT_PROVIDER_OPTIONS,
    abortSignal: AbortSignal.any([
      AbortSignal.timeout(ENRICHMENT_TIMEOUT_MS),
      ...(outerSignal ? [outerSignal] : [])
    ]),
    temperature: 0
  });

  return { output, usage };
};

const documentMetadataSchema = z.object({
  descriptiveTitle: z.string(),
  shortDescription: z.string(),
  mainTopics: z.array(z.string()),
  keyEntities: z.array(z.string()),
  primaryLanguage: z.string()
});

export const generateDocumentMetadata = async (
  content: string,
  outerSignal?: AbortSignal
) => {
  const SystemPrompt = `
Analyze the document content and generate helpful metadata for search and question answering.
Answer in the same language as the input text.
`.trim();

  const { output, usage, finishReason } = await generateText({
    model: google('gemini-3-flash-preview'),
    system: SystemPrompt,
    prompt: content,
    output: Output.object({ schema: documentMetadataSchema }),
    maxRetries: 0,
    maxOutputTokens: ENRICHMENT_MAX_OUTPUT_TOKENS,
    providerOptions: ENRICHMENT_PROVIDER_OPTIONS,
    abortSignal: AbortSignal.any([
      AbortSignal.timeout(ENRICHMENT_TIMEOUT_MS),
      ...(outerSignal ? [outerSignal] : [])
    ]),
    temperature: 0
  });

  return { output, usage, finishReason };
};
