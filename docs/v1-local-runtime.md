# V1 local runtime guide

Use Node.js 24 LTS and npm 11 for the existing application stack. The repository's `.nvmrc` selects Node 24, and CI reads that file. Google remains the current model provider; this phase does not replace providers or change dependency versions.

This guide preserves the historical Phase1 receipts from 2026-10-03. As of 2026-10-13, current accepted code is `25a4c21` after PR30 merged; post-merge main CI [run38341536457](https://github.com/desanv01/ai-chatbot-with-rag/actions/runs/38341536457) SUCCESS at `25a4c21`. Phase8 PR25–30 are merged. The preceding PR29 final main CI [run38338696792](https://github.com/desanv01/ai-chatbot-with-rag/actions/runs/38338696792) SUCCESS. Historical Phase0–7 acceptance was `3e2d558` with CI [run37549052098](https://github.com/desanv01/ai-chatbot-with-rag/actions/runs/37549052098); PR25–27 acceptance was `1c416a9` with CI [run38336570642](https://github.com/desanv01/ai-chatbot-with-rag/actions/runs/38336570642). Full Phase8 remains INCOMPLETE; generated-corpus/unsupported-answer acceptance is BLOCKED by quota. See [V1 validation](V1_VALIDATION.md) for passed checks and remaining gates.

See the official [Node.js release schedule](https://nodejs.org/en/about/previous-releases) for LTS status and the [Next.js installation documentation](https://nextjs.org/docs/app/getting-started/installation) for framework setup and system requirements.

## Install locked dependencies

From the repository root, select Node 24 using your Node version manager, then install exactly the dependencies recorded in `package-lock.json`:

```sh
npm ci --no-audit --no-fund
```

Keep the existing lockfile. Dependency installation is setup and does not establish acceptance or operational health. The historical Phase1 installation receipt is retained separately by the main review.

## Local configuration

Preserve an existing `.env.local`. Only if that file is absent, copy `.env.example` to `.env.local` and configure it locally. Never commit or print secret values.

The configuration names for the intended live workflow are maintained privately during Phase8:

- Site: `NEXT_PUBLIC_SITE_URL`
- Supabase: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- Document jobs: a dedicated server-only `DOCUMENT_JOB_SECRET`
- LlamaCloud: `LLAMA_CLOUD_API_KEY`
- Voyage: `VOYAGE_API_KEY`
- Google: `GOOGLE_GENERATIVE_AI_API_KEY`

Optional provider and search credentials are `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `EXA_API_KEY`. The template also exposes Google configuration controls: `GOOGLE_FREE_TIER_ONLY`, `GOOGLE_DEFAULT_MODEL`, and `GOOGLE_FALLBACK_MODEL`. Retain the current stack and configured Google behavior.

The historical local checks used placeholder-like service configuration. Presence of configuration, installation success, or a successful local build cannot prove that authentication, database access, document ingestion, embeddings, search, or model responses are operational. Phase2 through Phase7 implementation, offline checks and GitHub review were accepted independently of credentials. Phase8 now has private credentials, but limited connectivity receipts do not establish the full application workflow.

The authoritative sources in `supabase/migrations` remain ordered: `20260819050131_remote_schema.sql`, `20260819050430_reconcile_live_application_schema.sql`, then `20261006232436_v1_document_processing_state.sql`. `database/setup.sql` is historical reference. The approved additive processing-state migration was applied successfully in Phase8, initially under management-generated history version `20261013014844`. Main compared the stored applied SQL with committed source and confirmed exact equality after newline and outer-whitespace normalization. Main then reconciled only that history version to committed source version `20261006232436`, retaining the same name and statements; no schema or data was rerun. This prevents accidental reapplication caused by that version mismatch. Before future schema operations or `db push`, still inspect the target history and source, back up affected data and review the concrete changes; do not blindly rerun an applied migration.

For an existing backend with valuable data, inspect, back up, and review schema/data and migration history before separately authorized migration application. Never automatically reset, deduplicate or delete records, or reindex legacy documents. Duplicate legacy paths require manual review. Live migrations, billable provider use, and release require explicit authorization of concrete actions.

## Phase8 migration and email setup

Before the approved migration, main privately backed up application rows, schema metadata and all three Storage objects. This scoped backup is not a full database or PITR backup. Main confirmed the original rows and fields were preserved except expected document `updated_at` changes; the original two documents and 121 vectors were preserved at that migration checkpoint. Both legacy document records reference paths absent from current object names. Preserve and review these records; do not guess replacement paths or automatically reindex them.

Live Google model-list and LlamaCloud project connectivity returned HTTP 200, and one Voyage document embedding contained 1,024 finite values. These receipts establish only those calls. Full Auth, Storage, provider streaming/enrichment, corpus and workflow acceptance remains pending [issue19](https://github.com/desanv01/ai-chatbot-with-rag/issues/19).

Temporary Gmail SMTP STARTTLS/authentication passed. Human saved the Supabase SMTP configuration and main verified it persisted. Human received and clicked both new controlled signup alias emails; backend email confirmation timestamps and subsequent password login passed. Human received and completed recovery for new controlled account A; main verified new-password login PASS and old-password login denied. That controlled recovery gate is PASSED. The earlier verification failure came from an unquoted `#` truncating the private dotenv value; main quoted only that setting, preserving other configuration bytes. Quote `.env` values containing `#` and never publish their actual values. These are partial Auth receipts, not complete Auth acceptance. Keep sender credentials private. Temporary inboxes provide recipients, not an SMTP sender; Supabase's default SMTP is restricted to project-team recipients ([official SMTP guidance](https://supabase.com/docs/guides/auth/auth-smtp)).

Canonical `emailRedirectTo` targets `/api/auth/confirm`; current configured templates use `/api/auth/callback` with `token_hash` and `type`, plus recovery `next=/redirect/auth-password-update`. The Auth fix is merged in [PR25](https://github.com/desanv01/ai-chatbot-with-rag/pull/25). Review the site URL, email templates and redirect allowlist for the intended origin and destinations, and complete remaining Auth checks. Direct full-page sign-in initially used `router.back` and landed at `about:blank`; the deterministic fix merged in [PR29](https://github.com/desanv01/ai-chatbot-with-rag/pull/29) at `a55b91d`, with final main CI [run38338696792](https://github.com/desanv01/ai-chatbot-with-rag/actions/runs/38338696792) SUCCESS. Fresh Chrome direct-sign-in regression passed: sign-out, new-tab /signin login, then /chat. If mail does not arrive, check persisted SMTP sender settings, sanitized delivery errors, recipient restrictions and generated allowlisted URLs; never publish credentials or token links.

## Phase8 ingestion and chat progress

PR30 exact head `e67f193` passed CI [run38341324953](https://github.com/desanv01/ai-chatbot-with-rag/actions/runs/38341324953) and [run38341351248](https://github.com/desanv01/ai-chatbot-with-rag/actions/runs/38341351248), and merged at `25a4c21c0c036b300e9c1bd0515f086919795bb7`. Post-merge main CI [run38341536457](https://github.com/desanv01/ai-chatbot-with-rag/actions/runs/38341536457) SUCCESS at `25a4c21`; the current nine-suite offline command includes the literal-percent/Unicode correction.

Main verified initial synthetic table, unusual-filename (three physical pages with a blank middle page), and six-page Cedar fixtures processed SUCCESS through real LlamaParse, Google enrichment and Voyage embeddings. The initial unusual fixture incorrectly indexed blank physical page 2 as `NO_CONTENT_HERE` despite `noTextContent=true`; physical page 3 retained index 3. That historical failure prompted [PR28](https://github.com/desanv01/ai-chatbot-with-rag/pull/28), merged at `9840084` with final main CI [run38338439750](https://github.com/desanv01/ai-chatbot-with-rag/actions/runs/38338439750) SUCCESS. Corrected fresh short ingestion passed; corrected unusual three-physical-page PDF vectors contain only pages 1 and 3. Corrected fixture blank exclusion/page indices passed, while browser unusual-citation and broader corpus checks remain pending. Accepted PR27 uses a 45-second enrichment timeout, minimal Google thinking and at most 1,024 output tokens.

One real table chat answered 12/27/Omar with the correct page 1 citation. User, assistant and tool parts were saved, with the streamed assistant identity matching the saved identity; foreign history access was denied. Saved chat browser reload displayed user/assistant/tool parts and the correct citation link. Chrome rendered the cited table PDF page 1 alongside the saved answer; the in-app browser native iframe limitation remains browser-specific. Separate-account document search returned no context. Seventeen positive actual-source retrieval cases passed using real Voyage and authenticated Supabase; these were retrieval checks, not 17 generated answers.

Two simultaneous fresh processing requests returned exactly `200` + `409`. Signed-source exact bytes, tampering rejection and expiration checks passed, as did the full live edge guard matrix. The actual application deletion action, with adapted Next context, denied the foreign account and removed exactly two backed-up synthetic fixtures for the owner, excluding original document IDs; this is not browser delete-button proof. Chrome FileManager uploaded a disposable interruption probe; navigation during processing resulted in `failed`, zero vectors and no searchable content.

Full Phase8 remains INCOMPLETE under [issue19](https://github.com/desanv01/ai-chatbot-with-rag/issues/19): quota-blocked generated 20-question corpus and unsupported-answer acceptance, remaining browser unusual-citation/save-failure/cancel matrix, preserved legacy document-to-Storage mismatch and final evidence/GitHub review remain pending. SMTP, controlled signup and account A recovery passed; these receipts do not close the remaining matrix.

Unsupported-question generation historically encountered a transient Google `503`, then a separate `429` free-request quota receipt with limit 5. The current aggregate 20-question request was denied `429` before retrieval, with only the user part persisted; its free-tier request limit is 20 and retry delay is 20h 48m 49s, ending approximately 2026-10-14 00:00 UTC. Main deferred generation until 00:05 UTC (08:05 Kuala Lumpur), with the existing heartbeat ACTIVE and updated through the app. Generated-corpus/unsupported-answer acceptance remains BLOCKED; no model change or purchase was performed.

An actual Chrome unusual-filename source request reproduced a URI-malformed error for `100%` plus Unicode. The fix removes double decoding of Next's already-decoded query in both chat pages. Main verified nine offline suites plus lint/types PASS for commit `e67f193` / [PR30](https://github.com/desanv01/ai-chatbot-with-rag/pull/30); PR30 exact-head CI accepted and merge complete at `25a4c21`; post-merge main CI [run38341536457](https://github.com/desanv01/ai-chatbot-with-rag/actions/runs/38341536457) SUCCESS at `25a4c21`. Chrome now renders the unusual fixture's physical page 3 with OMEGA-33 and blank page 2 thumbnail without error. This is direct source-query routing proof alongside the existing table chat, not a generated unusual-document answer.

Whole-physical-page local OCR resolved split-image extraction and verified two legacy source candidates: the 81-page candidate has 82.35% cover coverage and 97.59% on other pages; the 40-page candidate has mean same-page coverage 95.78%, with initially sideways page 28 reaching 100% after correct orientation. This strongly supports physical-page identity alignment, not full table-cell or legacy-answer quality acceptance. Exact two-path repair was prepared and its transactional dry run passed with ROLLBACK. Persistent application was automatically rejected pending specific human approval; zero original updates were committed. Preserve existing paths, objects and vectors; exact mappings remain private. Expired Auth, controlled browser failure/cancel and full generated-corpus acceptance remain outstanding.

Additional main-verified checks passed: real password login and refresh for both controlled accounts, invalid-password denial, account B logout revoking refresh, and Chrome account A sign-out/fresh sign-in. Actual controlled owner/foreign/anonymous Storage and table RLS checks passed. An actual API save-failure request with a foreign chat ID returned `500` and sanitized "Unable to save chat history. Please try again." before provider use, preserving foreign parts unchanged/invisible; Chrome showed ChatNotFound for the foreign chat URL. Browser save-failure/cancel and expired-auth matrices remain outstanding.

Latest read-only preservation confirmed the baseline one user, two documents, 121 vectors, two chats and 12 message parts, plus matching byte hashes for all three original Storage objects; expected document `updated_at` changes were excluded. Original fields, vectors and files remain unchanged. Live authenticated readiness/vector/profile-role mutations and the real `complete_document_processing` RPC were denied with `42501`, leaving controlled records unmodified. Legacy broken-link repair remains pending specific human approval; no guessed repointing is accepted. The captured-token expired-Auth check remains pending the 2026-10-13 03:50:36 UTC window (11:50:36 Kuala Lumpur); generation remains deferred until 2026-10-14 00:05 UTC (08:05 Kuala Lumpur).

Release remains separately gated by [issue14](https://github.com/desanv01/ai-chatbot-with-rag/issues/14). The earlier Vercel build failed during page-data collection because Supabase server environment configuration was missing. No Vercel deployment or configuration changes were made for this evidence checkpoint.

## Local commands

The main chat verified the following local results on 2026-10-03:

| Command | Purpose | Phase 1 acceptance result |
| --- | --- | --- |
| `npm ci --no-audit --no-fund` | Install locked dependencies | Pass after network escalation; lockfile preserved |
| `npm run lint` | Run ESLint | Pass |
| `npm run typecheck` | Check TypeScript without emitting files | Pass |
| `npm run build` | Create the production build | Pass after network retry |
| `npm run dev` | Start the development server | Pass after sandbox spawn retry |
| `npm run start` | Serve an existing production build | Pass |

Run `npm run build` before `npm run start`. The build downloads the Google Inter font through `next/font/google` and may require network access. A font download failure should be recorded as a network limitation; do not change fonts or dependencies as part of this phase.

Both development and production servers returned HTTP 200 for `/`, `/signin`, `/docs`, and `/api/models`, with the expected HTML or JSON responses. These checks establish local startup and route responses within the service-placeholder limitations above.

The initial sandboxed installation failed because a required package was unavailable in the cache; installation passed with network escalation. The first sandboxed build could not connect to Google Fonts; its network retry passed. Development startup initially failed with spawn `EPERM`; an escalated retry became ready and passed the route checks. npm reported install-script warnings for `sharp` and `unrs-resolver`; those warnings did not block the production build, and no blanket script approval was performed.

## CI compilation fixture

The main chat also verified a secret-free production build on 2026-10-03 with `.env.local` absent, no provider credentials configured, and only the four non-secret environment values now specified in `.github/workflows/ci.yml`. That local build exited successfully. The CI step runs `npm run build` with the same fixture to validate compilation and prerendering only; it does not establish service health. Never deploy this fixture or its build output. The local result does not claim that a remote CI run has completed.

## Current offline checkpoint and Phase8

The main review accepted merged [Phase6 PR23](https://github.com/desanv01/ai-chatbot-with-rag/pull/23), which adds `npm run test:offline` and its CI step. All eight source/mock regression suites, whole-repository lint and type checking passed locally; synthetic SQL grants, owner isolation, processing completion, and rollback checks also passed. Pre-merge CI [run37548484315](https://github.com/desanv01/ai-chatbot-with-rag/actions/runs/37548484315) and [run37548488577](https://github.com/desanv01/ai-chatbot-with-rag/actions/runs/37548488577) passed all eight offline suites plus lint, types and the placeholder build. Source/CI integration is accepted. Post-merge main CI [run37548674013](https://github.com/desanv01/ai-chatbot-with-rag/actions/runs/37548674013) is verified SUCCESS at merge commit `28c0eccc1cd63dbda2fad72526f4662cb1f5cc0d`. Phase0–7 acceptance is recorded at `3e2d558` with final CI [run37549052098](https://github.com/desanv01/ai-chatbot-with-rag/actions/runs/37549052098) SUCCESS; this new Phase8 guidance remains subject to main-owned review and integration.

Source now includes provider gating, signed canonical jobs/paths, 25 MiB PDF and 150 MiB total storage limits, unique reservations without replacement, protected processing readiness, explicit LlamaParse v1 JSON page mapping preserving blanks, finite 1,024-dimension embeddings, a total 40,000-character document retrieval context bound, and stable incremental persistence with observable failures. These are code and offline evidence, not live service receipts.

The remaining Phase8 gates are tracked in [V1 validation](V1_VALIDATION.md), with passed retrieval/action/guard checks distinguished from generated-answer and browser acceptance. Successful corrected fixtures establish limited live parser/enrichment and blank-page handling, while broader corpus compatibility and legacy page provenance remain unverified. Interrupted requests can leave unsearchable `processing` documents; there is no durable background worker, automatic resume, or automatic model retry.
