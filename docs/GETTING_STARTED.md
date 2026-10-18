# Getting started with V1

V1 is the existing Next.js / React / TypeScript document-chat application. It uses Supabase, LlamaCloud parsing, Google/Gemini and Voyage embeddings. This guide covers local setup; it does not authorize changes to a shared backend or a Production deployment.

## Install and configure locally

Use **Node.js 24 and npm 11** (`.nvmrc` selects Node 24). From the repository root, install the existing lockfile without replacing it:

```sh
npm ci
```

Preserve an existing `.env.local`. Create it from the public template only when absent:

```sh
# POSIX shell
if [ ! -e .env.local ]; then cp .env.example .env.local; fi
```

```powershell
# PowerShell
if (-not (Test-Path -LiteralPath '.env.local')) {
  Copy-Item -LiteralPath '.env.example' -Destination '.env.local'
}
```

Edit values privately. Never print, commit or copy credentials into reports. Quote dotenv values containing `#`. The public template is the configuration inventory:

| Variables | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SITE_URL` | Canonical app origin; use `http://localhost:3000` locally. It is public, not a secret. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Existing Supabase endpoint and anonymous key used by server clients. |
| `SUPABASE_SERVICE_ROLE_KEY` | Privileged server-only database and private Storage operations. |
| `DOCUMENT_JOB_SECRET` | Separate long random server-only secret for signed legacy processing tokens. |
| `LLAMA_CLOUD_API_KEY` | Server-only PDF parsing credential. |
| `VOYAGE_API_KEY` | Server-only document/query embeddings; current model is `voyage-3-large`, with **1,024 dimensions**. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Current server-only chat and metadata provider. |
| `GOOGLE_FREE_TIER_ONLY` | Current policy is `true`; model availability also depends on configured credentials. |
| `GOOGLE_DEFAULT_MODEL`, `GOOGLE_FALLBACK_MODEL` | Template defaults are both `gemini-3-flash-preview`; preserve the current model policy. |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `EXA_API_KEY` | Optional, gated providers / website search; leave blank unless deliberately configured and authorized. |

Do not add a `NEXT_PUBLIC_` prefix to any server-only credential. Key presence alone does not establish provider health or quota. Keep the existing Google model and 1,024-dimensional embedding contract; setup is not a model/provider migration.

## Database preparation

`supabase/migrations/` is authoritative. Review these seven files in order for a **new, empty backend** before applying the reviewed schema:

1. `20260819050131_remote_schema.sql`
2. `20260819050430_reconcile_live_application_schema.sql`
3. `20261006232436_v1_document_processing_state.sql`
4. `20261013043248_v1_auth_trigger_execute_acl.sql`
5. `20261016144108_private_chat_attachments.sql`
6. `20261016152540_durable_document_jobs.sql`
7. `20261016162416_immutable_document_replacements.sql`

For an existing backend with valuable data, back up rows, schema/history and source objects, then compare actual migration history and applied SQL with these sources. The existing project backend already has all accepted migrations applied; history versions may differ from source filenames. **Do not reset the database, blindly apply/reapply migrations, reindex originals or overwrite backups.** Reconcile history only after review. `database/setup.sql` is historical reference, not the current bootstrap path. Preserve existing private Storage objects, original files, users, chats and immutable versions.

## Run locally

```sh
npm run dev
```

Open `http://localhost:3000`. Sign-in and confirmation/recovery flows require the intended canonical origin and existing reviewed Auth configuration. This guide does not change shared Auth templates, sender settings, security or redirect allowlists.

For a local production-mode server:

```sh
npm run build
npm run start
```

The build may need access to Google Fonts for the existing Inter font. A font-network failure is not a reason to replace the font or lockfile.

## Workflow runtime and checks

`next.config.ts` wraps Next with native Workflow 5.2.2. Local execution uses Local World; preserve its state directory for a restart scenario. The existing restart fixtures explicitly set `WORKFLOW_TARGET_WORLD=local`, a temporary `WORKFLOW_LOCAL_DATA_DIR` and a localhost `WORKFLOW_LOCAL_BASE_URL`. They manage their own local servers and fake service endpoints; do not copy those fixture credentials into an app deployment.

On Vercel, the build fails closed when `VERCEL=1` but `VERCEL_DEPLOYMENT_ID` is absent. Hosted execution requires genuine Vercel System Environment Variables and the native hosted Workflow runtime. Never fabricate a deployment ID or force filesystem-backed Local World on a host to bypass that guard. Review hosted configuration separately; no Production, automatic deployment, sender or security changes follow from local setup.

The actual repository scripts are:

| Command | What it checks or runs |
| --- | --- |
| `npm run dev` | Next development server. |
| `npm run build` | Next production compilation/prerendering. |
| `npm run start` | Existing production build, locally. |
| `npm run lint` | Repository ESLint checks. |
| `npm run typecheck` | TypeScript without emit or incremental cache. |
| `npm run test:offline` | Currently 24 credential-stripped source/mock suites with unexpected network calls blocked. |
| `npm run test:workflow-runtime` | Attachment and document Workflow restart/replay fixtures against localhost, after a completed build. |

CI's placeholder build proves compilation only. Never deploy its placeholder configuration or output, or treat a build/offline pass as live Auth, Storage, parsing, retrieval or answer acceptance.

The separate emitters `node tests/sql/chat-attachments.cjs`, `node tests/sql/document-jobs.cjs` and `node tests/sql/document-replacements.cjs` print transaction-wrapped rollback tests. Run their output through `psql -v ON_ERROR_STOP=1` **only against an isolated, bootstrapped local test database with the required predecessor schema**. They are not migration-application commands; never connect these synthetic assertions to a linked/live backend.

## First document

In File Management, select a readable PDF and wait for both binary upload completion and the durable queue acknowledgment before leaving. Processing then continues on the server; reopening shows persisted status. Only ready current documents enter default document search. Check citations against their physical PDF pages; answers can be incomplete.

See [architecture and limits](ARCHITECTURE.md), [durable jobs](DURABLE_DOCUMENT_JOBS.md), [immutable replacements](DOCUMENT_REPLACEMENTS.md), [private attachments](CHAT_ATTACHMENTS.md) and the dated [validation record](V1_VALIDATION.md). Current acceptance is scoped to the recorded fixtures and owner-only protected Preview; universal OCR/PDF support, full browser-shutdown continuation and prolonged maximum-load stress are not established.
