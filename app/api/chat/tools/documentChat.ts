import { tool, zodSchema, type ModelMessage } from 'ai';
import { z } from 'zod';
import { embed } from 'ai';
import { voyage } from 'voyage-ai-provider';
import { createServerSupabaseClient } from '@/lib/server/server';

const embeddingModel = voyage.textEmbeddingModel('voyage-3-large');

// Rough token estimate: ~4 characters per token
const MAX_CONTENT_CHARS = 40000; // ~10k tokens (approx)
const EMBEDDING_DIMENSIONS = 1024;
const RETRIEVAL_FAILURE = 'Document retrieval failed. Please try again.';

function boundedSignal(requestSignal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(30_000);
  return requestSignal ? AbortSignal.any([requestSignal, timeout]) : timeout;
}

interface SearchUserDocumentProps {
  userId: string;
}

const searchUserDocumentInputSchema = z.object({
  query: z
    .string()
    .describe('The search query to find relevant information in documents')
});

const searchUserDocumentOutputSchema = z.object({
  instructions: z
    .string()
    .describe('Instructions for the AI on how to use the search results'),
  context: z
    .array(
      z.object({
        type: z.string(),
        title: z.string(),
        aiTitle: z.string().optional(),
        page: z.number(),
        totalPages: z.number().optional(),
        content: z.string(),
        pdfLink: z.string()
      })
    )
    .describe('Array of document contexts found')
});

type SearchUserDocumentInput = z.infer<typeof searchUserDocumentInputSchema>;
type SearchUserDocumentOutput = z.infer<typeof searchUserDocumentOutputSchema>;

/**
 * Embed query function (Voyage)
 */
async function embedQuery(text: string, requestSignal?: AbortSignal) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Document search query must not be empty.');

  try {
    const { embedding } = await embed({
      model: embeddingModel,
      value: trimmed,
      maxRetries: 0,
      abortSignal: boundedSignal(requestSignal),
      providerOptions: {
        voyage: {
          inputType: 'query',
          truncation: true, // safer for long user queries
          outputDimension: EMBEDDING_DIMENSIONS,
          outputDtype: 'int8'
        }
      }
    });

    validateQueryEmbedding(embedding);
    return embedding;
  } catch (error) {
    console.error('Error embedding document query:', error);
    throw new Error(RETRIEVAL_FAILURE);
  }
}

function validateQueryEmbedding(embedding: number[]) {
  if (
    !Array.isArray(embedding) ||
    embedding.length !== EMBEDDING_DIMENSIONS ||
    !Array.from(embedding).every(
      (value) => typeof value === 'number' && Number.isFinite(value)
    )
  ) {
    throw new Error(RETRIEVAL_FAILURE);
  }
}

function getLastUserText(messages: ModelMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content.trim();
    return message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim();
  }
  return '';
}

/**
 * Get the user's document IDs
 */
async function getUserDocumentIds(
  userId: string,
  requestSignal?: AbortSignal
): Promise<string[]> {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from('user_documents')
    .select('id')
    .eq('user_id', userId)
    .eq('processing_status', 'ready')
    .abortSignal(boundedSignal(requestSignal));

  if (error) {
    console.error('Error fetching user documents:', error);
    throw new Error(RETRIEVAL_FAILURE);
  }

  return data?.map((doc) => doc.id) ?? [];
}

/**
 * Query Supabase vectors via RPC
 */
async function querySupabaseVectors(
  queryEmbedding: number[],
  userId: string,
  documentIds: string[],
  topK: number,
  similarityThreshold: number,
  requestSignal?: AbortSignal
) {
  validateQueryEmbedding(queryEmbedding);
  const supabase = await createServerSupabaseClient();

  // Your RPC expects a string like "[1,2,3]"
  const embeddingString = `[${queryEmbedding.join(',')}]`;

  const { data: matches, error } = await supabase
    .rpc('match_documents', {
      query_embedding: embeddingString,
      match_count: topK,
      filter_user_id: userId,
      file_ids: documentIds,
      similarity_threshold: similarityThreshold
    })
    .abortSignal(boundedSignal(requestSignal));

  if (error) {
    console.error('Error querying vectors:', error);
    throw new Error(RETRIEVAL_FAILURE);
  }

  return (matches ?? []).map((match: any) => ({
    id: match.id,
    text: match.text_content,
    title: match.title,
    timestamp: match.doc_timestamp,
    ai_title: match.ai_title,
    ai_description: match.ai_description,
    ai_maintopics: match.ai_maintopics,
    ai_keyentities: match.ai_keyentities,
    page: match.page_number,
    totalPages: match.total_pages,
    similarity: match.similarity
  }));
}

export const searchUserDocument = ({ userId }: SearchUserDocumentProps) =>
  tool<SearchUserDocumentInput, SearchUserDocumentOutput>({
    description:
      "Search through the user's uploaded documents to find relevant information. Use this when the user asks about their documents, mentions an uploaded file, or the answer likely exists inside their PDFs.",
    inputSchema: zodSchema(searchUserDocumentInputSchema),
    outputSchema: zodSchema(searchUserDocumentOutputSchema),
    execute: async ({ query }, { messages, abortSignal }) => {
      const toolQuery = query.trim();
      if (!toolQuery)
        throw new Error('Document search query must not be empty.');

      const documentIds = await getUserDocumentIds(userId, abortSignal);

      if (documentIds.length === 0) {
        return {
          instructions:
            'The user has no completed, searchable documents. Ask them to check processing in the file manager or upload a PDF and wait for it to become ready before searching.',
          context: []
        };
      }

      const userMessage = getLastUserText(messages);
      const queries = [toolQuery];
      if (userMessage && userMessage !== toolQuery) queries.push(userMessage);

      const queryEmbeddings = await Promise.all(
        queries.map((text) => embedQuery(text, abortSignal))
      );
      const resultGroups = await Promise.all(
        queryEmbeddings.map((embedding) =>
          querySupabaseVectors(embedding, userId, documentIds, 30, 0.3, abortSignal)
        )
      );

      // Keep the highest-similarity occurrence of each returned vector/page.
      const allSearchResults = resultGroups.flat();
      allSearchResults.sort((a, b) => b.similarity - a.similarity);
      const seenKeys = new Set<string>();

      const searchResults = allSearchResults.filter((item) => {
        const key =
          item.id != null
            ? `id:${item.id}`
            : `page:${JSON.stringify([item.title, item.page])}`;
        if (seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
      });

      const contextArray: SearchUserDocumentOutput['context'] = [];
      let remainingChars = MAX_CONTENT_CHARS;
      for (const result of searchResults) {
        if (remainingChars <= 0) break;
        const content = (result.text || '').slice(0, remainingChars);
        remainingChars -= content.length;

        contextArray.push({
          type: 'document',
          title: result.title,
          aiTitle: result.ai_title || undefined,
          page: Number(result.page ?? 1),
          totalPages: result.totalPages ? Number(result.totalPages) : undefined,
          content,
          // Keep your existing “pdf link” pattern
          pdfLink: `<?pdf=${encodeURIComponent(result.title.trim())}&p=${Number(result.page ?? 1)}>`
        });
      }

      const instructions = `
Using the extracted document context below, answer the user's question clearly and accurately.

IMPORTANT: Every time you use information from the PDFs, you MUST cite it using a Markdown link in this format:
[Short description](<?pdf=Document_Title&p=X>)
Use the exact pdfLink provided for each result; filenames in these links are URL-encoded.

Examples:
- [Definition](<?pdf=MyDoc.pdf&p=2>)
- [Section 12](<?pdf=Law.pdf&p=8>)
- [Figure 3.2](<?pdf=Report.pdf&p=15>)

If nothing relevant is found, tell the user and suggest how they can rephrase the question.
Answer in the same language as the user.

Documents found:
${contextArray.map((doc) => `- ${doc.aiTitle || doc.title} (page ${doc.page})`).join('\n')}
`.trim();

      return {
        instructions,
        context: contextArray
      };
    }
  });
