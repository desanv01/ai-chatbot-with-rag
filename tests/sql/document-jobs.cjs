// Rollback-only integration test for the isolated local database, never a linked project.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const migration = fs.readFileSync(
  path.join(
    root,
    'supabase/migrations/20261016152540_durable_document_jobs.sql'
  ),
  'utf8'
);
const body = migration.replace(/^BEGIN;\s*/, '').replace(/COMMIT;\s*$/, '');
if (body === migration)
  throw new Error('Expected transaction-wrapped migration');
const assertions = fs.readFileSync(
  path.join(__dirname, 'document-jobs-access-and-state.sql'),
  'utf8'
);
process.stdout.write(`BEGIN;\n${body}\n${assertions}\nROLLBACK;\n`);
