# Durable document jobs

Status as of 18 October 2026: migration `20261016152540` was applied once and is **LIVE**. Main verified scoped hosted durable-job evidence below; remaining live gates are **PENDING**. Local SQL rollback, native Workflow restart and offline checks passed. PR52 merged at `4411` with candidate/final CI passed; PR53 copy changes merged at `cf1832af1476902b3ea014ff20130734a0562ddd`, final-main CI39093081890 SUCCESS. Main owns review, CI and rollout. Providers remain unchanged; all automatic deployment guards remain false, with Preview-only scope and no Production settings changes.

One protected Preview, `dpl_D6PHRbSqRr7fVZydtcs7HujKCd9z`, is READY at exact `cf1832af1476902b3ea014ff20130734a0562ddd`, target NULL (Preview), with SSO retained and live=false. The earlier `64b82c4` Preview processed the synthetic Aurora upload to Ready across three physical pages after queue acknowledgement and leaving File Management. Reopening showed Ready 3 of 3. Vectors covered only physical pages 1 and 3, with 1,024 dimensions; the 2,743-byte source SHA matched. Cross-account document, vector, job and Storage access was denied, and temporary cached pages were cleared. One hosted Google/Voyage Malay answer returned the correct fixture code, Cobalt47Hana, Copper82Idris and Pearl not stated, with citations to physical pages 1 and 3. These source-bounded results are scoped evidence, not complete failure/resume or replacement acceptance.

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

Migration `20261016152540` is already applied; do not reapply it. Hosted acknowledgement followed by leaving File Management and reopening to Ready is verified for the Aurora fixture; this receipt does not establish a full browser-close case. Full close-browser continuation, cancellation/resume, failed-replacement preservation of the old active version, actual replacement promotion, old citations, OCR and embedded-visual checks remain **PENDING** under the main-owned live gate. Preserve existing data and original documents throughout review and rollout.
