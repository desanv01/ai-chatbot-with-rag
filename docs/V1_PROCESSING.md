# Document processing state

## Current guidance - 18 October 2026

Use [DURABLE_DOCUMENT_JOBS.md](DURABLE_DOCUMENT_JOBS.md), [DOCUMENT_REPLACEMENTS.md](DOCUMENT_REPLACEMENTS.md) and [V1_VALIDATION.md](V1_VALIDATION.md) for current contracts and source-bounded acceptance. Historical receipts below retain their original dates and implementation scope; old unapplied-migration, no-durable-worker and delete/re-upload statements are not current instructions. Already applied migrations must not be reapplied.

Finish the binary upload and receive durable queue acknowledgement before leaving. New durable jobs persist owner-visible status and checkpoints with safe resume/cancel controls. UNKNOWN parser-submission outcomes require HOLD and review, never blind deletion, re-upload or parser retry. A `parse_result_invalid` job cannot resume; use a different readable PDF rather than resubmitting that invalid result. Cancellation fences downstream writes; it does not terminate a provider-side parser already running. Legacy jobs are not automatically imported or retried.

Immutable replacements retain old version titles, paths, source bytes and vectors for historical citations; there is no version-purge workflow. Do not recommend deletion of version history. Consult the current validation record for scoped acceptance, including the PDF display repair and the separate quota-blocked Nova generated-answer case.

## Historical processing and runtime receipts

The migration source `supabase/migrations/20261006232436_v1_document_processing_state.sql` MUST be reviewed and applied before running this code against a live backend. Live application remains gated on main-owned review and authorization. Regenerate database types from the reviewed schema before validation. This code and migration source do not establish Phase8 live acceptance.

New documents reserve their filename, storage path and parsing job before Google enrichment. They remain `processing` while metadata and page vectors are written. Only the service-role finalization RPC can mark them `ready` after validating the exact expected nonblank page indices, nonnull embeddings and nonblank vector text. Both the app lookup and similarity RPC search only ready documents.

New processing fetches the LlamaParse v1 JSON result and maps each explicit `pages[].page` to its document page position, using nonblank `md` or string `text`. Blank pages retain their positions; markdown horizontal rules never split pages. Results must contain 1 through N exactly once, at most 10,000 pages, and an optional `job_metadata.job_pages` must be a positive integer matching N. Malformed or unusable results return 422 before reservation or enrichment. This mapping follows the [official v1 metadata contract](https://developers.llamaindex.ai/llamaparse/parse/v1/features/metadata/). Real PDF page alignment and legacy vector provenance remain unverified until Phase8; existing legacy rows are not reindexed. The v1 API is deprecated, and live endpoint compatibility must also be checked in Phase8.

Clients cannot mutate vectors directly; normal document deletion still cascades to its vectors through the existing foreign key.

Metadata, indexing or finalization errors best-effort mark the exact still-processing document `failed` with safe guidance. Request cancellation or termination may leave it `processing`; it stays unsearchable. Historical request-bound recovery guidance recommended deliberate deletion/re-upload and had no durable worker or automatic resume; it is superseded for current jobs by the safety guidance above. Existing vectors and registered objects are not erased by processor failure.

Legacy documents become ready only when positive declared page counts match a complete, valid vector set spanning page 1 through the declared final page. Others are marked failed for review, without deletion or reindexing. The historical legacy review required backup before any separately reviewed cleanup; do not blindly delete/re-upload or purge versioned members; no automatic deletion is performed. Duplicate legacy storage paths cause the entire transactional migration to fail for manual review; never auto-delete or deduplicate them.

Processing requires server-side `GOOGLE_GENERATIVE_AI_API_KEY`, `VOYAGE_API_KEY`, and `LLAMA_CLOUD_API_KEY`. Missing keys produce an actionable 503 after authentication and job-token validation. Key presence does not prove provider health. The request has a ten-minute cancellation bound, four-page concurrency, no automatic model retries, 15-second agent bounds and 30-second embedding bounds.

Document retrieval also bounds each document-ID lookup, vector RPC and query embedding call to 30 seconds, composed with the chat tool's request cancellation signal. Query embeddings disable automatic retries and require 1,024 finite values, including rejection of sparse arrays.
