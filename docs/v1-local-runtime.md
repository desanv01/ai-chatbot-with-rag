# V1 local runtime guide

Use Node.js 24 LTS and npm 11 for the existing application stack. The repository's `.nvmrc` selects Node 24, and CI reads that file. Google remains the current model provider; this phase does not replace providers or change dependency versions.

This guide preserves the historical Phase1 receipts from 2026-10-03. The current documentation checkpoint is 2026-10-07: Phase0, Phase1 and Phase6 are accepted; Phase6 PR23 is merged with successful pre-merge CI, and Phase7 documentation is prepared and reviewed with merge/CI acceptance owned by main. V1 operational acceptance remains pending Phase8. See [V1 validation](V1_VALIDATION.md) for evidence and the live checklist.

See the official [Node.js release schedule](https://nodejs.org/en/about/previous-releases) for LTS status and the [Next.js installation documentation](https://nextjs.org/docs/app/getting-started/installation) for framework setup and system requirements.

## Install locked dependencies

From the repository root, select Node 24 using your Node version manager, then install exactly the dependencies recorded in `package-lock.json`:

```sh
npm ci --no-audit --no-fund
```

Keep the existing lockfile. Dependency installation is setup and does not establish acceptance or operational health. The historical Phase1 installation receipt is retained separately by the main review.

## Local configuration

Preserve an existing `.env.local`. Only if that file is absent, copy `.env.example` to `.env.local` and configure it locally. Never commit or print secret values.

The configuration names for the intended live workflow, to be supplied privately when Phase8 begins, are:

- Site: `NEXT_PUBLIC_SITE_URL`
- Supabase: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- Document jobs: a dedicated server-only `DOCUMENT_JOB_SECRET`
- LlamaCloud: `LLAMA_CLOUD_API_KEY`
- Voyage: `VOYAGE_API_KEY`
- Google: `GOOGLE_GENERATIVE_AI_API_KEY`

Optional provider and search credentials are `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `EXA_API_KEY`. The template also exposes Google configuration controls: `GOOGLE_FREE_TIER_ONLY`, `GOOGLE_DEFAULT_MODEL`, and `GOOGLE_FALLBACK_MODEL`. Retain the current stack and configured Google behavior.

The historical local checks used placeholder-like service configuration. Presence of configuration, installation success, or a successful local build cannot prove that authentication, database access, document ingestion, embeddings, search, or model responses are operational. Phase2 through Phase7 implementation, offline checks, and GitHub review proceed independently of credentials. All live credential-dependent checks move to Phase8; no keys are requested for this checkpoint.

Before live use, review the target backend and the ordered sources in `supabase/migrations`: `20260819050131_remote_schema.sql`, `20260819050430_reconcile_live_application_schema.sql`, then `20261006232436_v1_document_processing_state.sql`. `database/setup.sql` is historical reference. The new processing-state migration has not been applied live, and current code requires it. Application migrations are a Phase8 prerequisite separate from supplying credentials.

For an existing backend with valuable data, inspect, back up, and review schema/data and migration history before separately authorized migration application. Never automatically reset, deduplicate or delete records, or reindex legacy documents. Duplicate legacy paths require manual review. Live migrations, billable provider use, and release require explicit authorization of concrete actions.

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

The main review accepted merged [Phase6 PR23](https://github.com/desanv01/ai-chatbot-with-rag/pull/23), which adds `npm run test:offline` and its CI step. All eight source/mock regression suites, whole-repository lint and type checking passed locally; synthetic SQL grants, owner isolation, processing completion, and rollback checks also passed. Pre-merge CI [run37548484315](https://github.com/desanv01/ai-chatbot-with-rag/actions/runs/37548484315) and [run37548488577](https://github.com/desanv01/ai-chatbot-with-rag/actions/runs/37548488577) passed all eight offline suites plus lint, types and the placeholder build. Source/CI integration is accepted. Post-merge main CI [run37548674013](https://github.com/desanv01/ai-chatbot-with-rag/actions/runs/37548674013) is verified SUCCESS at merge commit `28c0eccc1cd63dbda2fad72526f4662cb1f5cc0d`. This documentation checkpoint records reviewed setup, evidence and Phase8 boundaries; merge/CI evidence is tracked by its PR.

Source now includes provider gating, signed canonical jobs/paths, 25 MiB PDF and 150 MiB total storage limits, unique reservations without replacement, protected processing readiness, explicit LlamaParse v1 JSON page mapping preserving blanks, finite 1,024-dimension embeddings, a total 40,000-character document retrieval context bound, and stable incremental persistence with observable failures. These are code and offline evidence, not live service receipts.

Phase8 must establish live Auth, grants/RLS and private Storage access with two accounts; provider streaming/tools/enrichment; bounded PDF processing and concurrency/failure behavior; grounding and physical citations; deletion and persistence after reload; and the full end-to-end matrix in [V1 validation](V1_VALIDATION.md). Deprecated LlamaParse v1 compatibility and legacy page provenance remain unverified. Interrupted requests can leave unsearchable `processing` documents; there is no durable background worker, automatic resume, or automatic model retry.
