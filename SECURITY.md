# Security policy

## Supported scope

The latest default-branch source is maintained for the project's owner-only protected Preview. Scoped authentication, ownership and access checks are recorded in [V1 validation](docs/V1_VALIDATION.md); those checks are not a blanket security guarantee or Production approval.

Only the latest default-branch commit receives fixes. Older changelog entries and historical validation receipts do not describe the current security contract.

## Reporting a vulnerability

Do not publish credentials, private documents, user data or exploitable vulnerability details in an issue, pull request, screenshot or log.

Use this repository's private vulnerability-reporting channel when available. If it is unavailable, contact the repository owner privately rather than opening a public report with sensitive details. Include:

- the affected version and route or component;
- reproduction steps using synthetic, non-sensitive data;
- expected and observed behaviour;
- potential impact and any suggested mitigation.

Ordinary non-sensitive bugs can use the [bug report form](https://github.com/desanv01/ai-chatbot-with-rag/issues/new?template=bug_report.yml).

## Handling credentials and data

- Keep `.env.local`, provider keys and Supabase service credentials out of Git and screenshots.
- Keep service credentials server-only; never place them in a `NEXT_PUBLIC_` variable.
- Use synthetic PDFs and disposable accounts for validation. Do not publish database exports, original user documents or chat history.
- If a credential is exposed, treat it as compromised and arrange its revocation/rotation through the owner.
- Review migration history and back up valuable data before any separately authorized schema change. Do not reset linked backends, blindly retry unknown parser submissions or purge retained document versions.

Production configuration, authentication/sender changes, repository visibility and automatic-deployment settings require their own reviewed change. Publishing documentation does not change those controls.
