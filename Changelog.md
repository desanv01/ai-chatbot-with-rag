# Changelog

Current project delivery notes are grouped by date. These entries describe implemented changes, not a new tagged release or a promise of Production availability.

## 2026-10-18 — V1 reliability and repository presentation

### Delivered

- Durable PDF jobs with acknowledged background processing, persisted progress, safe resume/cancellation and generation fences.
- Immutable PDF replacement with atomic promotion, failed-candidate protection, current-only retrieval and retained historical citations.
- Private chat PDF attachments with reference-only saved history, authenticated download and eventual cleanup.
- Direct PDF.js page rendering for chat citations, saved attachments and File Management; page navigation, zoom and bounded source loading.
- Accurate invalid-parser guidance, failed-version labels, chat copy and regenerated database types.
- Scoped hosted checks for blank physical pages, Malay content, scanned table OCR, owner isolation and a 52-page indexing cancel/resume case.
- Product-first README and genuine synthetic-demo screenshots, current setup and architecture guides, a documentation index, contribution guidance and GitHub issue/PR templates.
- Removed the outdated roadmap and upstream project branding from the README. Required third-party notices remain in their dedicated file.

### Validation and boundaries

The reliability implementation passed 24 offline suites, lint, type checking, builds and installed Workflow restart fixtures. Specified PDF visuals and hosted reliability cases passed within their documented source bounds. One scanned-document generated-answer case remains blocked by a provider daily-quota response; indexed OCR facts and readable PDF pages do not substitute for that answer test.

See [V1 validation](docs/V1_VALIDATION.md) for receipts and limitations. The selected deployment scope is owner-only protected Preview. Production, sender/Auth/security settings and automatic deployments remain separate decisions.

## Earlier project history

The previous version-labelled notes are preserved unchanged in [the historical changelog](docs/history/CHANGELOG_LEGACY.md). Those entries describe their original implementation period and are not the current setup or validation contract.
