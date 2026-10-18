# Contributing

Contributions should improve the existing V1 application: Next.js, React and TypeScript with Supabase, Google/Gemini, LlamaCloud and Voyage. Keep optional integrations optional. A provider migration, new platform or V2 application needs a separate scope discussion.

## Before making a change

Read the [getting started guide](docs/GETTING_STARTED.md), [architecture](docs/ARCHITECTURE.md) and [documentation index](docs/README.md). For a bug, describe a reproducible failure and the affected revision. For a feature, explain the workflow it improves before proposing a large implementation. Keep pull requests focused and preserve unrelated local changes.

Preserve existing environment files, the lockfile, original PDFs, stored objects, chats, vectors and version history. A normal contribution does not authorize a database reset, reindex, original-document upload, migration replay, automatic deployment change or production release. Never blindly repeat a parser submission with an unknown outcome. Use synthetic fixtures for development; do not commit private evidence or credentials. Follow [SECURITY.md](SECURITY.md) for vulnerability reports.

## Validation

Use Node.js from `.nvmrc` and the locked npm dependencies. Choose checks that match the change and report what you actually ran:

| Change | Useful validation |
| --- | --- |
| Documentation or copy | Check accuracy, links and the affected wording. Credentials and paid service calls are not required. |
| Application behavior | Run relevant offline regressions, `npm run lint` and `npm run typecheck`; include `npm run build` when compilation or routing is affected. |
| Durable jobs or attachments | Include the relevant offline cases and, after building, `npm run test:workflow-runtime`, which uses localhost fixtures. Consult the feature guide for isolated SQL checks. |

The existing [CI workflow](.github/workflows/ci.yml) runs lint, type checking, `npm run test:offline`, a build with non-secret placeholders and Workflow runtime fixtures. Full CI remains the merge gate; a placeholder build or offline fixture does not prove live provider or hosted acceptance. Record skipped checks and their reason. Live checks, service calls and deployments need an explicitly agreed scope and environment; they are not a prerequisite for a documentation correction.

## Pull requests

Explain the concrete problem, resulting behavior and validation. Include screenshots for visible changes when useful, using synthetic content. Identify schema, configuration or service-call effects when applicable. Do not include `.env.local`, keys, tokens, signed URLs, private PDFs or raw user logs. Maintainers review the change and its evidence before integration; opening a pull request does not authorize deployment.
