# Durable document jobs

Status at handback: **NOT LIVE; migration `20261016152540` UNAPPLIED; live acceptance gate PENDING.** Main reports local SQL rollback, native Workflow restart and offline checks passed. These are local receipts, not hosted acceptance. Main owns final review, CI and rollout. Providers remain unchanged; all automatic deployment guards remain false, with Preview-only scope and no Production settings changes.

## Upload, progress and reopening

The PDF binary must finish uploading and the durable queue acknowledgement must arrive before the user can rely on processing continuing after closing the browser. Closing the browser earlier is outside that guarantee. A lost HTTP acknowledgement never deletes the reserved source; acknowledgement recovery for a duplicate using the same path is supported.

Owner-visible status and counters are persisted so progress can be checked after reopening. Each owner may have one active job. Physical blank pages count toward page totals but are not embedded. Saved parser, page, metadata and indexing checkpoints are retained on failure. Generation and run fences prevent late writes from an obsolete execution.

## Failure, resume and cancellation

Only safe failed or cancelled jobs may resume. An unknown parser POST outcome blocks resume: never blindly retry a parser request whose outcome is unknown. Legacy jobs are not automatically imported or retried.

Cancellation does not cancel a provider-side parser operation already running. The database fence prevents downstream writes from that cancelled execution; this is the cancellation boundary, not a claim of provider-side termination. Do not reindex original documents to validate this feature. Validation fixtures are synthetic only.

## Execution and limits

The native Workflow dispatcher chains seven-day runs, with a 30-minute dispatch interval and a two-hour lease. Normal queue dispatch is immediate; fallback dispatch may take up to 30 minutes. A job processes up to four pages in parallel. Parser polling is bounded to 360 polls at ten-second intervals.

Limits are 25 MiB per PDF, 2,000 physical pages, 16 MiB of parser output and 2 MiB per page. The implementation adds three RLS-protected job, page and maintenance tables and ten service-only RPCs. Clients receive safe owner-status columns, not parser, run or path fields.

## Local verification and release gate

Main owns execution and interpretation of these commands:

```sh
node tests/sql/document-jobs.cjs
npm run test:offline
npm run build
npm run test:workflow-runtime
```

The SQL command emits rollback SQL for an isolated database. The Workflow runtime command includes attachment and document localhost restart fixtures. Neither command establishes hosted behavior by itself.

Migration `20261016152540` remains unapplied at this checkpoint. Hosted upload acknowledgement, close-browser continuation, persisted progress/reopening, failure/resume and cancellation behavior require the main-owned live gate before hosted acceptance can be recorded. Preserve existing data and original documents throughout review and rollout.
