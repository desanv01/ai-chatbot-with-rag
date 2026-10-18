# Immutable PDF replacements

Status as of 18 October 2026: replacement migration source `20261016162416` was applied **ONCE** at 03:12 UTC, recorded under backend history version `20261018031259`. PR52 merged at `4411`; candidate and final-main CI passed. PR53 copy changes merged at `cf1832af1476902b3ea014ff20130734a0562ddd`, final-main CI39093081890 SUCCESS. The prerequisite durable-jobs migration `20261016152540` was already applied once and is live. Main reviewed the implementation and passed 22 offline suites, lint, type checks, a placeholder build, isolated rollback SQL and both installed Workflow/Next localhost restart fixtures. Actual hosted replacement acceptance remains **PENDING**.

Main verified one protected Preview, `dpl_D6PHRbSqRr7fVZydtcs7HujKCd9z`, READY at exact `cf1832af1476902b3ea014ff20130734a0562ddd`, target NULL (Preview), with SSO retained, live=false and all automatic deployment guards false. Post-migration checks preserved the existing 11 documents and 135 vectors; new series, members and candidates remained empty. RLS was enabled on all three replacement tables; owner SELECT passed, client writes and reservation/promotion RPC access were denied, and service access passed. This establishes the checked migration/access scope, not an actual replacement promotion.

## Replacing a current PDF

Select **Replace PDF** on a ready current document. The replacement uploads to a new unique object and creates a new document/job with an immutable version title. The uploaded filename may match the earlier filename; the source object is not overwritten.

The old version stays active until the candidate is fully ready and an atomic compare-and-swap promotion succeeds. A failed or cancelled candidate preserves the old current version. A stale candidate cannot resume after a newer promotion. Replaying a historical completion is idempotent and cannot rewind the active-version pointer.

If the acknowledgment is lost after promotion, the same upload can recover its existing job only when owner, source path, job, original target and candidate-document linkage match. It does not upload to the parser or start processing again.

## Retrieval, citations and retention

Default retrieval uses only the current version. Previous documents, source paths, titles and vectors are retained so earlier citations still resolve. File Management shows all versions with current, previous and pending labels. Both server deletion actions retain versioned members rather than deleting their history.

Every stored version counts toward the 150 MiB quota; each PDF is limited to 25 MiB. Retaining versions consumes storage. This feature includes no version-purge workflow, so deleting history is not an available quota-recovery instruction.

## Integrity and access

Database RESTRICT foreign keys, restrictive user-document UPDATE rules and Storage UPDATE/DELETE policies prevent direct client identity changes, source overwrites and deletion. Reservation and promotion are service-only operations, with owner RLS governing access. There is no backfill or original-document reindexing.

Providers and 1,024-dimensional embeddings remain unchanged. No Production change is included; automatic deployment guards remain false.

## Verification and remaining gate

Main owns execution, review and interpretation of:

```sh
node tests/sql/document-replacements.cjs
npm run test:offline
npm run typecheck
npm run build
```

The SQL command emits an isolated rollback test. Migration application and the recorded candidate/final CI are complete; do not reapply the migration. Local checks and migration verification do not substitute for hosted replacement evidence. Actual promotion, cancellation/resume, preservation of the old active version after failure, old-citation checks, OCR and embedded-visual checks remain **PENDING**. Do not claim complete hosted acceptance until main records those results.
