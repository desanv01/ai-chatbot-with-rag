# Document processing state

The migration source `supabase/migrations/20261006232436_v1_document_processing_state.sql` MUST be reviewed and applied before running this code against a live backend. Live application remains gated on main-owned review and authorization. Regenerate database types from the reviewed schema before validation. This code and migration source do not establish Phase8 live acceptance.

New documents reserve their filename, storage path and parsing job before Google enrichment. They remain `processing` while metadata and page vectors are written. Only the service-role finalization RPC can mark them `ready` after validating the exact expected nonblank page indices, nonnull embeddings and nonblank vector text. Both the app lookup and similarity RPC search only ready documents.

New processing fetches the LlamaParse v1 JSON result and maps each explicit `pages[].page` to its document page position, using nonblank `md` or string `text`. Blank pages retain their positions; markdown horizontal rules never split pages. Results must contain 1 through N exactly once, at most 10,000 pages, and an optional `job_metadata.job_pages` must be a positive integer matching N. Malformed or unusable results return 422 before reservation or enrichment. This mapping follows the [official v1 metadata contract](https://developers.llamaindex.ai/llamaparse/parse/v1/features/metadata/). Real PDF page alignment and legacy vector provenance remain unverified until Phase8; existing legacy rows are not reindexed. The v1 API is deprecated, and live endpoint compatibility must also be checked in Phase8.

Clients cannot mutate vectors directly; normal document deletion still cascades to its vectors through the existing foreign key.

Metadata, indexing or finalization errors best-effort mark the exact still-processing document `failed` with safe guidance. Request cancellation or termination may leave it `processing`; it stays unsearchable. Delete the unfinished document deliberately in the file manager and upload it again. There is no durable background worker or automatic resume. Existing vectors and registered objects are not erased by processor failure.

Legacy documents become ready only when positive declared page counts match a complete, valid vector set spanning page 1 through the declared final page. Others are marked failed for review, without deletion or reindexing. Review and back up existing legacy documents before any deliberate deletion and re-upload; no automatic deletion is performed. Duplicate legacy storage paths cause the entire transactional migration to fail for manual review; never auto-delete or deduplicate them.

Processing requires server-side `GOOGLE_GENERATIVE_AI_API_KEY`, `VOYAGE_API_KEY`, and `LLAMA_CLOUD_API_KEY`. Missing keys produce an actionable 503 after authentication and job-token validation. Key presence does not prove provider health. The request has a ten-minute cancellation bound, four-page concurrency, no automatic model retries, 15-second agent bounds and 30-second embedding bounds.

Document retrieval also bounds each document-ID lookup, vector RPC and query embedding call to 30 seconds, composed with the chat tool's request cancellation signal. Query embeddings disable automatic retries and require 1,024 finite values, including rejection of sparse arrays.
