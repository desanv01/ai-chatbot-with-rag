const { execFileSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const environment = { ...process.env };
for (const name of Object.keys(environment)) {
  if (
    /^(SUPABASE_|GOOGLE_|LLAMA_|VOYAGE_|OPENAI_|ANTHROPIC_|EXA_|DOCUMENT_JOB_)/.test(
      name
    )
  ) {
    delete environment[name];
  }
}
const suites = [
  'auth-security',
  'provider-guards',
  'parser-pages',
  'upload-processing',
  'upload-ui',
  'retrieval',
  'persistence',
  'sdk-persistence-failure'
];
for (const suite of suites) {
  execFileSync(
    process.execPath,
    [
      '--require',
      path.join(__dirname, 'network-guard.cjs'),
      path.join(__dirname, `${suite}.cjs`)
    ],
    { cwd: root, env: environment, stdio: 'inherit', timeout: 15_000 }
  );
}
console.log(
  `PASS ${suites.length} offline suites; live acceptance remains separate.`
);
