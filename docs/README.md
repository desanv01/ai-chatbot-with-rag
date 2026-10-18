# Documentation

Start with the current guides below. Acceptance records describe a specific source, environment and fixture; they do not establish a production release or universal document quality.

## Current guides

| Guide | Read it for |
| --- | --- |
| [Getting started](GETTING_STARTED.md) | Local setup and configuration. |
| [Architecture](ARCHITECTURE.md) | Application boundaries and data flow. |
| [Private chat PDF attachments](CHAT_ATTACHMENTS.md) | Attachment limits, private references, access and durable cleanup. |
| [Durable document jobs](DURABLE_DOCUMENT_JOBS.md) | Upload acknowledgement, checkpoints, cancellation, safe resume and maintenance. |
| [Immutable PDF replacements](DOCUMENT_REPLACEMENTS.md) | Replacement promotion and preservation of old sources and citations. |
| [V1 validation checkpoint](V1_VALIDATION.md) | Current scoped evidence, remaining gates and dated acceptance history. |

## Historical guides and receipts

These documents retain earlier implementation and validation history. Some include current guidance at the top; use that guidance and the current feature contracts before following older instructions.

- [Document processing state](V1_PROCESSING.md): current pointer followed by historical processing and runtime receipts. Earlier no-durable-worker and delete/re-upload statements are superseded.
- [V1 local runtime](v1-local-runtime.md): setup details and dated Phase1 runtime receipts; historical acceptance statements are bounded to their recorded source and date.
- [Phase0 baseline](v1-phase0-baseline.md): the original preservation checklist and October 2026 baseline, not the current deployment or configuration state.

Already applied migrations must not be replayed. Preserve original data and immutable version history; do not use historical recovery notes as permission to reset, delete or reindex them.

For repository overview, contribution guidance and private vulnerability reporting, see the [README](../README.md), [CONTRIBUTING.md](../CONTRIBUTING.md) and [SECURITY.md](../SECURITY.md).
