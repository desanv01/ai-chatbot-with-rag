# Offline regression checks

Run `npm run test:offline` after `npm ci` using the pinned Node runtime. Each suite runs in a separate process with provider/backend credential variables removed and unexpected HTTP/fetch access blocked. Tests execute the actual TypeScript source through the installed compiler, with explicit local provider, database and React hook fixtures. The stream failure check uses the installed AI SDK with a fake local model.

Coverage includes OTP error handling and redirect safety, signed job expiry/tamper/ownership, provider selection, parser page positions and blanks, upload limits and conflicts, partial processing failures and finalization, repeated UI triggers and polling limits, retrieval errors/context limits/embedding validation, stable persisted part IDs and observable stream-save failure. These assertions check behavior; they do not establish actual account, database, provider or browser health.

Synthetic PostgreSQL validation separately exercised the processing-state migration, owner RLS, grants, vector completeness, uniqueness and deletion cascade. That evidence does not replace live backend verification. Real Auth/email/refresh, private Storage access, provider support, physical PDF citations, ingestion, retrieval, persistence reload and end-to-end workflows remain in Phase8, tracked by [issue19](https://github.com/desanv01/ai-chatbot-with-rag/issues/19). Production release remains separately gated.

