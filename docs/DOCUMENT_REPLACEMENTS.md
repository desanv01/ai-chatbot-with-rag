# Immutable PDF replacements

Status as of 18 October 2026: replacement migration source `20261016162416` was applied **ONCE** at 03:12 UTC, recorded under backend history version `20261018031259`. PR52 merged at `4411`; candidate and final-main CI passed. PR53 copy changes merged at `cf1832af1476902b3ea014ff20130734a0562ddd`, final-main CI39093081890 SUCCESS. The prerequisite durable-jobs migration `20261016152540` was already applied once and is live. Main reviewed the implementation and passed 22 offline suites, lint, type checks, a placeholder build, isolated rollback SQL and both installed Workflow/Next localhost restart fixtures. Scoped hosted replacement promotion, failure preservation and the repaired PDF visuals now PASS. The separate Nova generated-answer case remains quota-blocked.

Main verified one protected Preview, `dpl_D6PHRbSqRr7fVZydtcs7HujKCd9z`, READY at exact `cf1832af1476902b3ea014ff20130734a0562ddd`, target NULL (Preview), with SSO retained, live=false and all automatic deployment guards false. Post-migration checks preserved the existing 11 documents and 135 vectors; new series, members and candidates remained empty. RLS was enabled on all three replacement tables; owner SELECT passed, client writes and reservation/promotion RPC access were denied, and service access passed. That earlier receipt established migration/access scope; the later hosted replacement evidence below establishes a scoped promotion.

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

## Hosted reliability evidence - 18 October 2026

Main verified a blank synthetic replacement failed with `parse_result_invalid`, produced zero vectors and left the old version active. A scanned Nova replacement completed two physical pages with two 1,024-dimensional vectors and atomically became current. The old title, path, vectors and source bytes were retained; default current-only retrieval excluded the old version. Cross-account metadata, document, vector and Storage access was denied. OCR table content and Malay facts were verified in the indexed content; this is not universal OCR or answer-quality acceptance.

An older saved Aurora citation resolved the correct OLD filename, source and physical page3 after replacement. Human confirmation initially found the actual PDF pane black. [PR56](https://github.com/desanv01/ai-chatbot-with-rag/pull/56) repaired that display path with a locally bundled PDF.js canvas renderer. At exact runtime `d5fa362abf91c8373bdc5ef9992c97e5a322b339`, main verified readable old Aurora pages1/3, the white blank physical page2, page navigation, zoom/fit and page-input clamping. The saved private Vega attachment and both scanned Nova pages also rendered visibly with ready status, without another provider upload or answer. Its 24 offline suites, lint, types, placeholder build, candidate CI and final-main CI39095355088 passed. These are scoped visual checks, not universal PDF compatibility.

One Nova grounded-answer question failed with Google `429` daily free quota. There is no Nova answer acceptance, no retry and no purchase, model or key change. PR53, PR54 and PR55 merged with final CI passed. Existing core local Phases0-8 and attachment scope remain accepted. Scope remains owner-only protected Preview, with current providers, no Production release, Auth/sender/security/automatic-deployment changes or V2 work.

## Verification and remaining gate

Main owns execution, review and interpretation of:

```sh
node tests/sql/document-replacements.cjs
npm run test:offline
npm run typecheck
npm run build
```

The SQL command emits an isolated rollback test. Replacement DDL was applied once under history `20261018031259`; do not reapply it. Scoped promotion, failed-candidate preservation, current-only retrieval, retained old-source identity, indexed OCR/table/Malay facts and the specified hosted PDF visuals are verified as described above. The separate durable-job cancel/resume result is recorded in [DURABLE_DOCUMENT_JOBS.md](DURABLE_DOCUMENT_JOBS.md); it does not by itself prove cancellation of a replacement candidate. Nova generated-answer acceptance remains quota-blocked. No all-document, universal-quality or original-account legacy-answer acceptance is claimed.
