# Database migrations

`database/setup.sql` is the idempotent bootstrap for a new Supabase project.
For an existing project, apply the numbered migrations in order after reviewing
them against the live schema.

## Current migration

`0001_reconcile_application_schema.sql` aligns the application contract with
Supabase by adding the `users.role` and `users.stripe_customer_id` columns,
creating the one-to-one `subscriptions` table, hardening ownership policies,
and updating `match_documents` to return the document identity and canonical
Storage path.

The migration intentionally does not create fake Stripe identifiers or
subscription dates. If an existing `subscriptions` table has an incompatible
shape or duplicate users, resolve that data explicitly before applying it.

Run migrations with the Supabase SQL editor or your normal migration runner;
do not commit credentials or service-role keys to the repository.
