# V1 local runtime guide

Use Node.js 24 LTS and npm 11 for the existing application stack. The repository's `.nvmrc` selects Node 24, and CI reads that file. Google remains the current model provider; this phase does not replace providers or change dependency versions.

See the official [Node.js release schedule](https://nodejs.org/en/about/previous-releases) for LTS status and the [Next.js installation documentation](https://nextjs.org/docs/app/getting-started/installation) for framework setup and system requirements.

## Install locked dependencies

From the repository root, select Node 24 using your Node version manager, then install exactly the dependencies recorded in `package-lock.json`:

```sh
npm ci --no-audit --no-fund
```

Keep the existing lockfile. Dependency installation is setup and does not establish acceptance or operational health. The Phase 1 installation log is stored outside this worktree at `V1_EXECUTION/phase1-install.log` in the parent project.

## Local configuration

Preserve an existing `.env.local`. Only if that file is absent, copy `.env.example` to `.env.local` and configure it locally. Never commit or print secret values.

The required configuration names for the intended local workflow are:

- Site: `NEXT_PUBLIC_SITE_URL`
- Supabase: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- Document jobs: `DOCUMENT_JOB_SECRET`
- LlamaCloud: `LLAMA_CLOUD_API_KEY`
- Voyage: `VOYAGE_API_KEY`
- Google: `GOOGLE_GENERATIVE_AI_API_KEY`

Optional provider and search credentials are `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `EXA_API_KEY`. The template also exposes Google configuration controls: `GOOGLE_FREE_TIER_ONLY`, `GOOGLE_DEFAULT_MODEL`, and `GOOGLE_FALLBACK_MODEL`. Retain the current stack and configured Google behavior.

This local environment has placeholder-like service configuration. Presence of configuration, installation success, or a successful local build cannot prove that authentication, database access, document ingestion, embeddings, search, or model responses are operational. Live provider calls, database operations, and ingestion are outside this implementation phase.

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
