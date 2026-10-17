const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm'),
  assert = require('node:assert/strict'),
  ts = require('typescript');
const root = path.resolve(__dirname, '../..');
async function run(mode) {
  let active = 0,
    maximum = 0,
    pages = [],
    failures = [],
    sleeps = 0,
    completed = 0,
    polls = 0,
    submits = 0;
  const steps = {
    claimDocumentJobStep: async () => mode !== 'inactive',
    submitDocumentParserStep: async () => {
      submits++;
    },
    pollDocumentParserStep: async () => {
      polls++;
      return mode === 'timeout' ? 'pending' : 'success';
    },
    stageDocumentPagesStep: async () => ({
      totalPages: mode === 'large' ? 2000 : 8
    }),
    prepareDocumentMetadataStep: async () => {},
    indexDocumentPageStep: async (_id, _generation, _run, page) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setImmediate(resolve));
      pages.push(page);
      active--;
      if (mode === 'batch-failure' && page === 2)
        throw Error('indexing_failed');
    },
    completeDocumentJobStep: async () => {
      assert.equal(active, 0);
      completed++;
    },
    failDocumentJobStep: async (_id, _generation, _run, code) => {
      assert.equal(
        active,
        0,
        'failed state recorded while sibling pages still execute'
      );
      failures.push(code);
    }
  };
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(
      fs.readFileSync(
        path.join(root, 'workflows/document-processing.ts'),
        'utf8'
      ),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022
        }
      }
    ).outputText,
    {
      exports,
      Error,
      require: (n) =>
        n === 'workflow'
          ? {
              getWorkflowMetadata: () => ({ workflowRunId: 'local-run' }),
              sleep: async (interval) => {
                assert.equal(interval, '10s');
                sleeps++;
              }
            }
          : steps
    }
  );
  const result = await exports.documentProcessingWorkflow('local-job', 1);
  assert.ok(maximum <= 4);
  assert.equal(active, 0);
  if (mode === 'inactive') {
    assert.equal(result.status, 'inactive');
    assert.equal(submits, 0);
    assert.equal(polls, 0);
  }
  if (mode === 'large') {
    assert.equal(result.status, 'ready');
    assert.equal(submits, 1);
    assert.equal(completed, 1);
    assert.equal(new Set(pages).size, 2000);
    assert.equal(pages.length, 2000);
    assert.equal(maximum, 4);
  }
  if (mode === 'timeout') {
    assert.equal(result.status, 'failed');
    assert.equal(polls, 360);
    assert.equal(sleeps, 359);
    assert.deepEqual(failures, ['parser_timeout']);
    assert.equal(pages.length, 0);
  }
  if (mode === 'batch-failure') {
    assert.equal(result.status, 'failed');
    assert.deepEqual(failures, ['indexing_failed']);
    assert.equal(pages.length, 4);
    assert.equal(completed, 0);
  }
}
async function main() {
  for (const mode of ['inactive', 'large', 'timeout', 'batch-failure'])
    await run(mode);
  console.log(
    'PASS actual document Workflow orchestration: 2000 physical pages bounded to four concurrent tasks, stale claim exits, bounded 360 polls and settled sibling work before failure; local fixtures only'
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
