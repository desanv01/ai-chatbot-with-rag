# Security policy

## Current status

This repository is an active stabilization baseline and is not yet recommended for production deployment. Known security-sensitive areas include privileged Storage access, upload and processing job ownership, arbitrary URL fetching, HTML previews, and schema/RLS verification.

## Reporting a vulnerability

Please do not publish credentials, private documents, user data, or exploitable vulnerability details in a public issue.

Use GitHub's private vulnerability reporting or security advisory flow for this repository. Include:

- the affected route or component;
- reproducible steps using non-sensitive test data;
- expected and observed behavior;
- potential impact;
- a suggested mitigation, if available.

## Secrets

- Never commit `.env.local` or provider credentials.
- Treat `SUPABASE_SERVICE_ROLE_KEY` as a privileged server secret.
- Rotate any key that has been copied into an archive, chat, public log, or repository.
- Keep production secrets in the deployment provider's encrypted environment settings.

## Supported versions

Only the latest commit on the default branch will receive security fixes while the project remains in stabilization.
