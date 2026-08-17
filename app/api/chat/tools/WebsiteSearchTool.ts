// app/api/chat/tools/WebsiteSearchTool.ts
import { generateText, tool, Output, pruneMessages } from 'ai';
import { z } from 'zod';
import { google } from '@ai-sdk/google';

// Rough token estimate: ~4 characters per token
const MAX_CONTENT_CHARS = 40000; // ~10k tokens

const websiteSearchSchema = z.object({
  queryVariation1: z.string().min(1).describe(
    'A query variation targeted at official government / authority websites. Use precise terms used by official agencies.'
  ),
  queryVariation2: z.string().min(1).describe(
    'A query variation focused on latest updates / recent developments. Include time-based wording.'
  ),
  queryVariation3: z.string().min(1).describe(
    'A query variation focused on practical implementation examples, guides, and best practices.'
  )
});

interface SearchResultURL {
  title: string;
  url: string;
  content: string;
  publishedDate?: string;
}

type ExaSearchResult = {
  id: string;
  title: string;
  url: string;
  publishedDate?: string;
  author?: string;
  text?: string;
};

type ExaAPIResponse = {
  requestId: string;
  autopromptString?: string;
  autoDate?: string;
  resolvedSearchType?: string;
  results: ExaSearchResult[];
};

export const websiteSearchTool = tool({
  description:
    'Search the web for up-to-date information. Returns a small set of high-signal sources and their extracted text.',
  inputSchema: z.object({
    query: z.string().describe('The query to search for on the web')
  }),
  execute: async (args, { messages }) => {
    const currentDate = new Date().toISOString().split('T')[0];

    const prunedMessages = pruneMessages({
      messages,
      reasoning: 'before-last-message',
      toolCalls: 'all',
      emptyMessages: 'remove'
    });

    const queryOptimizationPrompt = `
<metadata>
  <current_date>${currentDate}</current_date>
</metadata>

You are an expert at web search query optimization.
Rewrite the user's query into three variations:

1) Official sources variation:
   - Aim for government / authority sites (ministries, agencies, regulators, etc.)
   - Use official wording

2) Recency variation:
   - Focus on the latest updates, recent changes, and current guidance
   - Include year or "latest" terms

3) Practical variation:
   - Focus on how-to guides, implementation steps, real examples, best practices

User query: ${args.query}
`.trim();

    const { output } = await generateText({
      model: google('gemini-3-flash-preview'),
      system: queryOptimizationPrompt,
      output: Output.object({ schema: websiteSearchSchema }),
      messages: prunedMessages,
      temperature: 0
    });

    const websiteQueries = [
      output.queryVariation1,
      output.queryVariation2,
      output.queryVariation3
    ].filter((q) => q && q.trim() !== '');

    const searchPromises = websiteQueries.map(async (query) => {
      try {
        const response = await fetch('https://api.exa.ai/search', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.EXA_API_KEY || ''
          },
          body: JSON.stringify({
            query,
            type: 'auto',
            numResults: 2,
            excludeDomains: ['lovguiden.dk', 'retsinformation.dk'],
            userLocation: 'DK',
            contents: { text: true }
          })
        });

        if (!response.ok) {
          throw new Error(`Exa API error: ${response.status} ${response.statusText}`);
        }

        const data: ExaAPIResponse = await response.json();

        return data.results.map((result) => ({
          title: result.title,
          url: result.url,
          content: result.text || '',
          publishedDate: result.publishedDate
        }));
      } catch (error) {
        console.error('Error fetching from Exa API:', error);
        return [];
      }
    });

    const searchResultsArray = await Promise.all(searchPromises);

    const uniqueSearchResults = searchResultsArray.flat().reduce((acc, result) => {
      if (!acc.some((r: SearchResultURL) => r.url === result.url)) {
        acc.push(result);
      }
      return acc;
    }, [] as SearchResultURL[]);

    const contextArray = uniqueSearchResults.map((result) => {
      let content = result.content || '';
      if (content.length > MAX_CONTENT_CHARS) content = content.slice(0, MAX_CONTENT_CHARS);

      return {
        type: 'website',
        title: result.title,
        url: result.url,
        content,
        publishedDate: result.publishedDate
      };
    });

    const instructions = `
Use the website context below to answer the user's question.

CITATIONS (required):
- Whenever you use information from a source, cite it inline using Markdown:
  Example: According to [Source Title](https://example.com), ...

Rules:
- Keep citations inline (do not dump all references at the end).
- If sources conflict, say so and cite both.
- If information is missing, ask a clarifying question or suggest a better query.
`.trim();

    return {
      instructions,
      context: contextArray
    };
  }
});
