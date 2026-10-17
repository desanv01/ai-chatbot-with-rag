// Emit rollback-only assertions for an isolated bootstrapped local database.
const fs = require('node:fs'),
  path = require('node:path');
const root = path.resolve(__dirname, '../..');
const files = [
  '20261016152540_durable_document_jobs.sql',
  '20261016162416_immutable_document_replacements.sql'
];
const sql = files
  .map((file) => {
    const input = fs.readFileSync(
      path.join(root, 'supabase/migrations', file),
      'utf8'
    );
    const body = input.replace(/^BEGIN;\s*/, '').replace(/COMMIT;\s*$/, '');
    if (body === input) throw Error('Expected transaction wrapper');
    return body;
  })
  .join('\n');
process.stdout.write(
  `BEGIN;\n${sql}\n${fs.readFileSync(path.join(__dirname, 'document-replacements-state.sql'), 'utf8')}\nROLLBACK;\n`
);
