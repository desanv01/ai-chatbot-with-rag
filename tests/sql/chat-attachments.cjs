// Emit a rollback-only integration test for an ISOLATED, bootstrapped local DB.
// Pipe to local psql with ON_ERROR_STOP=1; never run against a linked/live project.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const migration = fs.readFileSync(
  path.join(
    root,
    'supabase/migrations/20261016144108_private_chat_attachments.sql'
  ),
  'utf8'
);
const body = migration.replace(/^BEGIN;\s*/, '').replace(/COMMIT;\s*$/, '');
if (body === migration)
  throw new Error('Expected transaction-wrapped migration');
const assertions = ['chat-attachments-access.sql', 'chat-attachments-rpc.sql']
  .map((file) => fs.readFileSync(path.join(__dirname, file), 'utf8'))
  .join('\n');
process.stdout.write(`BEGIN;\n${body}\n${assertions}\nROLLBACK;\n`);
