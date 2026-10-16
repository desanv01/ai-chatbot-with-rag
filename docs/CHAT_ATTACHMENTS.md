# Private chat PDF attachments

Status: **UNAPPLIED / UNDEPLOYED WIP**. This document describes the implementation contract, not live acceptance. Main owns release decisions, migration review and test results.

## Storage and message limits

PDFs use the private `chat-attachments` bucket. Downloads require an authenticated session belonging to the attachment owner. Attachment limits are 3 MiB per file, 3 MiB in aggregate per message, four PDFs per message and 12 MiB across the chat history.

Saved messages persist canonical references in the form `attachment://user/chat/SHA.pdf`. Provider bytes are transient and are not the persisted representation. Existing inline PDF messages remain unchanged; there is no bulk rewrite of historical messages or original documents.

Metadata reservation and durable queue acknowledgement must complete before upload. Duplicate handling is immutable and hash-verified; an existing object must not be overwritten with different bytes. Failed uploads or message saves retain metadata with the chat so the operation can be retried until deletion.

## Access and cleanup

Attachment tables and RPCs use RLS and service-only operations; a restrictive Storage policy also blocks client access even if an existing permissive policy grants broader access. An owner/session check is required for PDF download; possession of a reference alone does not grant access. Hosted consumers are queue-only and require Vercel System Environment Variables; a hosted build without `VERCEL_DEPLOYMENT_ID` fails closed.

Metadata deletion, including chat-cascade deletion, queues cleanup. A ten-minute in-flight grace period precedes deletion. Maintenance checks every 30 minutes in batches of five, so cleanup is eventual rather than immediate. Each object has at most ten automatic cleanup attempts; retry backoff is capped at six hours. Service-only failure-queue entries with attempts >=10 require main/operator review. Do not blindly delete or retry original documents.

A permanent completed-path tombstone fences stale cleanup and reuse of recreated chat IDs. Retain that fence rather than treating a completed cleanup record as disposable history.

## Workflow operation

The implementation uses native Workflow 5.2.2 on the existing Vercel setup. Runs cover seven days / 336 cycles, hand off to a child run and use a two-hour database lease. No additional external cron, model or provider is introduced. This contract makes no unverified pricing or allowance claims.

An exhausted transient step retry is caught by the workflow, which rechecks after its normal durable sleep. Completed-path tombstones and conditional lease acknowledgements make repeated delivery safe. The application ensures that the durable consumer is acknowledged before uploading bytes or deleting a chat. New app activity can restart maintenance after a stale lease expires.

## Verification

`npm run test:offline` covers parsing, authorization, persistence, cleanup and actual input callbacks with local fixtures. After `npm run build`, run `npm run test:workflow-runtime` to exercise the installed Next/Workflow runtime through a server restart using localhost Storage/DB fixtures. It starts and stops its own local servers and never calls external providers.

For the SQL integration checks, emit `node tests/sql/chat-attachments.cjs` into `psql -v ON_ERROR_STOP=1` connected only to an isolated, bootstrapped local Supabase database. The emitted transaction applies the new DDL, tests roles, restrictive Storage policies, reservation, cascade, retry leases and tombstones, then rolls back. Do not run these synthetic-user assertions against a linked/live project.

## Deployment and rollback

Apply the reviewed additive DDL before deploying code that writes attachment references. The feature remains unapplied and undeployed until main records the corresponding release and verification results.

Rolling back application code retains the additive bucket, tables, private objects and new rows. Never drop or delete the bucket/tables, remove preserved objects or rewrite originals as a rollback step. Old code cannot read new reference rows: select a feature-aware rollback target when those rows exist. A code rollback does not reverse the data format or establish cleanup acceptance.
