# V1 Phase 0 baseline and preservation checklist

This document records facts verified by the main chat as of 2026-10-03 and defines the limited handoff from Phase 0 preservation to Phase 1 runtime validation. Phase 0 acceptance, review, testing, Git commits, and integration belong to the main chat. No runtime failure has yet been confirmed.

## Repository baseline

- The active application repository is nested at `ai-chatbot-with-rag` within the original project workspace.
- Origin: `https://github.com/desanv01/ai-chatbot-with-rag.git`.
- Baseline branch: `agent/reapply-document-processing-hardening`.
- Baseline commit: `9eba171adc31e3e43f4d85e2fb79b59f0787832e` (`9eba171`).
- Dedicated Phase 0 worktree: `C:/Users/Dv/Desktop/AI CHATBOT PROJECT/V1_EXECUTION/worktrees/phase0`.
- Dedicated branch: `v1/phase0-baseline`, based on the baseline commit above.
- PR 9 was open, draft, and mergeable at the baseline; its validate checks reported `SUCCESS`.
- The repository was public, with `main` as its default branch, when checked on 2026-10-03.

Historical document-processing hardening remains separate from V1 execution. The worker must not merge or deploy; main owns any reviewed phase-only GitHub integration within the human-authorized scope.

## Original workspace preservation

The original workspace has a modified `.gitignore` adding `.env*`, plus untracked `PROJECT_ARCHITECTURE_AND_MIGRATION_ANALYSIS.md` and `.env.local`. Preserve all three in their original location and exclude these existing local changes and files from Phase 0 and Phase 1 commits and integration. Do not copy secret values or private file hashes into documentation or validation records.

## Runtime and configuration evidence

The local runtime is Node.js `24.14.1` with npm `11.19.0`. Choose the Node.js 24 LTS family for Phase 1 alignment. The official Next.js minimum is Node.js `20.9`; Node.js 20 is now end of life. The current local site URL is `http://localhost:3000`; the URL alone does not establish a healthy running application.

The presence of `.env.local` does not establish configured health. Required variable names are present, but the Supabase URL, anon key, service-role key, LlamaCloud, Voyage, and Google key fields all classify as placeholder-like in the main chat's safe pattern scan. Nonempty fields are not evidence of valid configuration. In particular, `SUPABASE_URL` uses the literal placeholder host `your-project-ref.supabase.co`. Optional `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `EXA_API_KEY` are absent.

The intended backend and whether it contains valuable data remain unverified. No live backend queries or API checks are authorized. Configuration validation and setup remain limitations for Phases 2 and 3; Phase 1 proves only build and startup behavior within its stated scope.

## Phase 1 boundary and expected artifacts

Phase 1 is limited to `npm ci`, lint, typecheck, build, development startup, and production startup. Record reproducible commands and observed outcomes. Make narrow runtime fixes when a failure is proven and reproducible. CI/runtime alignment to the installed supported Node 24 LTS family is justified by the existing Node 20 CI end-of-life mismatch. Expected artifacts are those justified fixes, a reproducible startup document, and the main chat's validation record.

Suspected later ingestion, retrieval, persistence, and authentication defects are hypotheses pending reproduction. Keep them distinct from reproduced runtime blockers; none is currently a confirmed runtime failure. Defer Phases 2 through 7, provider calls, migrations, ingestion, and hosted previews. Workers must not merge or deploy. Hosted preview and production deployment remain deferred; main owns reviewed phase-only commits and PR/CI integration.

Requested Fast speed has not been verified by a tool. Do not change global settings to implement that request.

## Branch deployment guard

Main reported that the PR 12 push automatically triggered Vercel deployment `dpl_DU6uYfAP3LeMS9B83YsqNA4NTcgi`, labelled production, which ended in `ERROR` with no successful rollout. GitHub lint and type checks passed. To enforce the deployment boundary, `vercel.json` disables Git-triggered deployments specifically for `v1/phase0-baseline`, `v1/phase1-runtime`, and `agent/reapply-document-processing-hardening`. Unspecified branches retain the default enabled behavior, as described in the [Vercel Git configuration documentation](https://vercel.com/docs/project-configuration/git-configuration) checked by main. Re-enabling deployment for these branches requires later hosted-release authorization.

## Main acceptance checklist

- [x] Confirm the Phase 0 worker changes are limited to docs/v1-phase0-baseline.md and vercel.json on v1/phase0-baseline.
- [x] Confirm the worktree branch and base commit match the recorded baseline.
- [x] Confirm the original modified `.gitignore` and untracked analysis and environment files are preserved and excluded from integration.
- [x] Confirm historical hardening remains separate; the automatic deployment failed and no successful rollout occurred.
- [x] Accept the Node.js 24 LTS family alignment for Phase 1.
- [x] Confirm placeholder-like configuration and unverified backend/data status are recorded without secret values or private file hashes.
- [x] Confirm Phase 1 stays within dependency installation, static checks, build, and development/production startup validation.
- [x] Require a reproduced failure for runtime defect fixes; record the supported-runtime evidence for CI alignment.
- [ ] Require the reproducible startup document and main validation record before Phase 1 acceptance.
- [x] Keep later defect hypotheses and Phases 2 through 7 deferred until separately authorized.

The Phase 0 worker implemented the baseline document and branch deployment guard. Main reviewed and accepted these scoped files; GitHub checks and integration are recorded separately in the phase validation report.
