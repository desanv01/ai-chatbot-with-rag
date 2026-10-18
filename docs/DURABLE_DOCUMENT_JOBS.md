# Durable document jobs

Status as of 18 October 2026: migration `20261016152540` was applied once and is **LIVE**. Main verified scoped hosted durable-job evidence below; remaining live gates are **PENDING**. Local SQL rollback, native Workflow restart and offline checks passed. PR52 merged at `4411` with candidate/final CI passed; PR53 copy changes merged at `cf1832af1476902b3ea014ff20130734a0562ddd`, final-main CI39093081890 SUCCESS. Main owns review, CI and rollout. Providers remain unchanged; all automatic deployment guards remain false, with Preview-only scope and no Production settings changes.

One protected Preview, `dpl_D6PHRbSqRr7fVZydtcs7HujKCd9z`, is READY at exact `cf1832af1476902b3ea014ff20130734a0562ddd`, target NULL (Preview), with SSO retained and live=false. The earlier `64b82c4` Preview processed the synthetic Aurora upload to Ready across three physical pages after queue acknowledgement and leaving File Management. Reopening showed Ready 3 of 3. Vectors covered only physical pages 1 and 3, with 1,024 dimensions; the 2,743-byte source SHA matched. Cross-account document, vector, job and Storage access was denied, and temporary cached pages were cleared. One hosted Google/Voyage Malay answer returned the correct fixture code, Cobalt47Hana, Copper82Idris and Pearl not stated, with citations to physical pages 1 and 3. These source-bounded results establish the scoped Aurora navigation/reopening and grounded-answer case; separate reliability receipts follow.

## Hosted cancellation and resume - 18 October 2026

In the separate synthetic 52-page Storm case, main used the actual UI to cancel during indexing at 4 of 52 pages. The job became cancelled at generation2. Actual UI Resume advanced it to generation3 and Ready 52 of 52, retaining the SAME parser receipt and submission time, with no new upload or parser POST. Source hash matched, 52 distinct vectors were verified and temporary cached pages were cleared. This proves the scoped indexing cancel/resume case, not provider-side parser termination.

Aurora's blank physical middle page remained present but had no vector. Durable acknowledgement followed by navigation away and reopening to Ready 3 of 3, source identity and the Malay grounded answer are accepted for that fixture. No full browser shutdown, prolonged maximum-duration stress or universal document-quality result is claimed.

Replacement migration history `20261018031259` is applied once. A blank candidate failed with zero vectors while the old version stayed active; scanned Nova completed two physical pages/two 1,024-dimensional vectors and atomically promoted while retaining old source/title/path/vectors. See [DOCUMENT_REPLACEMENTS.md](DOCUMENT_REPLACEMENTS.md) for those scoped checks. The old Aurora citation resolves the old source/page3. After the human-confirmed black pane, PR56 merged at `d5fa362` with final CI39095355088 SUCCESS; the protected Preview at that exact runtime visibly rendered Aurora pages1/3, blank page2, the saved Vega attachment and both scanned Nova pages. Page/zoom/fit controls passed. One Nova answer attempt hit Google429 daily free quota: no answer acceptance, retry, purchase, model or key change.

PR53/54/55 merged with final CI passed. Core local Phases0-8 and attachment scope remain accepted. Current scope is owner-only protected Preview with current providers, no Production release, Auth/sender/security/automatic-deployment changes or V2 work.

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

Migration `20261016152540` is already applied; do not reapply it. The Aurora navigation/reopening, Storm indexing cancellation/resume and specified PDF visuals are verified within the bounds above. Full browser-shutdown continuation and prolonged maximum-duration stress remain unverified. Nova generated-answer acceptance remains quota-blocked; indexed OCR facts do not establish a generated answer. Preserve existing data and original documents; no original-account legacy-answer or all-document quality acceptance is claimed.
