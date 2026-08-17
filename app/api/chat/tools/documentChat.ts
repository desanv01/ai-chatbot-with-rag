import { tool } from 'ai';
import { z } from 'zod';
import { embed } from 'ai';
import { voyage } from 'voyage-ai-provider';
import { createServerSupabaseClient } from '@/lib/server/server';

const embeddingModel = voyage.textEmbeddingModel('voyage-3-large');

// Rough token estimate: ~4 characters per token
const MAX_CONTENT_CHARS = 40000; // ~10k tokens (approx)

interface SearchUserDocumentProps {
  userId: string;
}

/**
 * Embed query function (Voyage)
 */
async function embedQuery(text: string) {
  const trimmed = (text ?? '').toString().trim();

  // If empty, avoid calling embedding provider
  if (!trimmed) return new Array(1024).fill(0);

  const { embedding } = await embed({
    model: embeddingModel,
    value: trimmed,
    providerOptions: {
      voyage: {
        inputType: 'query',
        truncation: true, // safer for long user queries
        outputDimension: 1024,
        outputDtype: 'int8'
      }
    }
  });

  return embedding;
}

/**
 * Get the user's document IDs
 */
async function getUserDocumentIds(userId: string): Promise<string[]> {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from('user_documents')
    .select('id')
    .eq('user_id', userId);

  if (error) {
    console.error('Error fetching user documents:', error);
    return [];
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
  similarityThreshold: number
) {
  const supabase = await createServerSupabaseClient();

  // Your RPC expects a string like "[1,2,3]"
  const embeddingString = `[${queryEmbedding.join(',')}]`;

  const { data: matches, error } = await supabase.rpc('match_documents', {
    query_embedding: embeddingString,
    match_count: topK,
    filter_user_id: userId,
    file_ids: documentIds,
    similarity_threshold: similarityThreshold
  });

  if (error) {
    console.error('Error querying vectors:', error);
    throw error;
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
  tool({
    description:
      "Search through the user's uploaded documents to find relevant information. Use this when the user asks about their documents, mentions an uploaded file, or the answer likely exists inside their PDFs.",
    inputSchema: z.object({
      query: z
        .string()
        .describe('The search query to find relevant information in documents')
    }),
    outputSchema: z.object({
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
    }),
    execute: async ({ query }, { messages }) => {
      const documentIds = await getUserDocumentIds(userId);

      if (documentIds.length === 0) {
        return {
          instructions:
            'The user has no uploaded documents. Ask them to upload a PDF first, then you can search and answer questions from it.',
          context: []
        };
      }

      const toolQuery = (query ?? '').toString();
      const userMessage = messages[messages.length - 1]?.content?.toString() ?? '';

      // Embed both in parallel
      const [toolQueryEmbedding, userMessageEmbedding] = await Promise.all([
        embedQuery(toolQuery),
        embedQuery(userMessage)
      ]);

      // Vector search both embeddings in parallel
      const [toolQueryResults, userMessageResults] = await Promise.all([
        querySupabaseVectors(toolQueryEmbedding, userId, documentIds, 30, 0.3),
        querySupabaseVectors(userMessageEmbedding, userId, documentIds, 30, 0.3)
      ]);

      // Combine + dedupe (by title+page)
      const allSearchResults = [...toolQueryResults, ...userMessageResults];
      const seenKeys = new Set<string>();

      const searchResults = allSearchResults.filter((item) => {
        const key = `${item.title}-${item.page}`;
        if (seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
      });

      // Sort by similarity
      searchResults.sort((a, b) => b.similarity - a.similarity);

      const contextArray = searchResults.map((result) => {
        let content = result.text || '';

        if (content.length > MAX_CONTENT_CHARS) {
          content = content.slice(0, MAX_CONTENT_CHARS);
        }

        return {
          type: 'document',
          title: result.title,
          aiTitle: result.ai_title || undefined,
          page: Number(result.page ?? 1),
          totalPages: result.totalPages ? Number(result.totalPages) : undefined,
          content,
          // Keep your existing “pdf link” pattern
          pdfLink: `<?pdf=${result.title.trim()}&p=${Number(result.page ?? 1)}>`
        };
      });

      const instructions = `
Using the extracted document context below, answer the user's question clearly and accurately.

IMPORTANT: Every time you use information from the PDFs, you MUST cite it using a Markdown link in this format:
[Short description](<?pdf=Document_Title&p=X>)

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
