const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const assert = require('node:assert/strict'),
  ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const owner = '11111111-1111-4111-8111-111111111111',
  foreign = '99999999-9999-4999-8999-999999999999';
const id = '22222222-2222-4222-8222-222222222222',
  doc = '33333333-3333-4333-8333-333333333333';
const source = `${owner}/44444444-4444-4444-8444-444444444444.pdf`;
let currentUser,
  job,
  events,
  queries,
  startFailure,
  maintenanceFailure,
  adminCalls;
function reset() {
  currentUser = owner;
  job = {
    id,
    user_id: owner,
    document_id: doc,
    file_name: 'fixture.pdf',
    file_path: source,
    status: 'queued',
    generation: 1,
    run_id: null,
    parser_job_id: null,
    parser_submit_started_at: null,
    error_code: null,
    total_pages: null,
    completed_pages: 0,
    created_at: '2026-01-01',
    updated_at: '2026-01-01'
  };
  events = [];
  queries = [];
  startFailure = false;
  maintenanceFailure = false;
  adminCalls = 0;
}
function query() {
  const q = {
    filters: [],
    select(columns) {
      q.columns = columns;
      return q;
    },
    eq(k, v) {
      q.filters.push([k, v]);
      return q;
    },
    or(v) {
      q.filter = v;
      return q;
    },
    order(k, o) {
      q.ordering = [k, o];
      return q;
    },
    limit(v) {
      q.maximum = v;
      return q;
    },
    async maybeSingle() {
      queries.push(q);
      return {
        data: q.filters.every(([k, v]) => job[k] === v)
          ? structuredClone(job)
          : null,
        error: null
      };
    },
    then(resolve, reject) {
      queries.push(q);
      return Promise.resolve({
        data: q.filters.every(([k, v]) => job[k] === v)
          ? [structuredClone(job)]
          : [],
        error: null
      }).then(resolve, reject);
    }
  };
  return q;
}
const userClient = {
  auth: {
    getUser: async () => ({
      data: { user: currentUser ? { id: currentUser } : null },
      error: null
    })
  },
  from: query
};
const admin = {
  from: query,
  rpc: async (name, args) => {
    events.push(name);
    if (name === 'reserve_document_job')
      return { data: [structuredClone(job)], error: null };
    assert.equal(name, 'control_document_job');
    job.generation++;
    job.run_id = null;
    job.status = args.p_action === 'cancel' ? 'cancelled' : 'queued';
    return { data: [structuredClone(job)], error: null };
  }
};
function load(file) {
  const exports = {};
  const mocks = {
    'server-only': {},
    '@/lib/server/server': {
      createServerSupabaseClient: async () => userClient
    },
    '@/lib/server/admin': {
      createAdminClient: () => {
        adminCalls++;
        return admin;
      }
    },
    '@/lib/server/document-job-maintenance-start': {
      ensureDocumentJobMaintenance: async () => {
        events.push('maintenance');
        if (maintenanceFailure) throw Error('private detail');
      }
    },
    '@/workflows/document-processing': {
      documentProcessingWorkflow: 'workflow'
    },
    'workflow/api': {
      start: async () => {
        events.push('start');
        if (startFailure) throw Error('private start detail');
      },
      getRun: () => ({
        cancel: async () => {
          events.push('cancel-run');
          throw Error('cancel unavailable');
        }
      })
    }
  };
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022
      }
    }).outputText,
    {
      exports,
      Error,
      Date,
      require: (n) =>
        n in mocks
          ? mocks[n]
          : n.startsWith('@/')
            ? load(n.slice(2) + '.ts')
            : require(n)
    }
  );
  return exports;
}
async function main() {
  reset();
  const dal = load('lib/server/document-jobs.ts');
  const queued = await dal.queueDocumentJob(owner, 'fixture.pdf', source);
  assert.equal(queued.job.id, id);
  assert.equal(queued.dispatchPending, false);
  assert.deepEqual(events, ['maintenance', 'reserve_document_job', 'start']);
  reset();
  startFailure = true;
  assert.equal(
    (await dal.queueDocumentJob(owner, 'fixture.pdf', source)).dispatchPending,
    true
  );
  assert.equal(job.status, 'queued');
  reset();
  maintenanceFailure = true;
  await assert.rejects(
    dal.queueDocumentJob(owner, 'fixture.pdf', source),
    /Unable to queue/
  );
  assert.deepEqual(events, ['maintenance']);
  assert.equal(adminCalls, 0);
  reset();
  currentUser = foreign;
  await assert.rejects(dal.queueDocumentJob(owner, 'fixture.pdf', source));
  assert.equal(adminCalls, 0);
  reset();
  await assert.rejects(
    dal.queueDocumentJob(owner, 'fixture.pdf', source.replace(owner, foreign))
  );
  assert.equal(adminCalls, 0);
  reset();
  const visible = await dal.getOwnedDocumentJob(owner, id);
  assert.equal(visible.fileName, 'fixture.pdf');
  for (const key of [
    'parser_job_id',
    'file_path',
    'run_id',
    'source_sha256',
    'metadata'
  ])
    assert.equal(key in visible, false);
  reset();
  currentUser = foreign;
  assert.equal(await dal.getOwnedDocumentJob(foreign, id), null);
  assert.equal(adminCalls, 0);
  reset();
  await dal.listOwnedDocumentJobs(owner, [doc.toUpperCase(), doc]);
  let q = queries.at(-1);
  assert.equal(q.maximum, 40);
  assert.equal(q.ordering[0], 'updated_at');
  assert.equal(
    q.filter,
    `document_id.in.(${doc}),status.in.(queued,parsing,metadata,indexing)`
  );
  assert.ok(q.filters.some(([k, v]) => k === 'user_id' && v === owner));
  await dal.listOwnedDocumentJobs(owner);
  assert.equal(queries.at(-1).maximum, 20);
  assert.equal(queries.at(-1).filter, undefined);
  const before = queries.length;
  await assert.rejects(
    dal.listOwnedDocumentJobs(owner, ['bad),user_id.eq.other'])
  );
  assert.equal(queries.length, before);
  reset();
  job.status = 'failed';
  job.error_code = 'parser_submission_unknown';
  assert.equal((await dal.getOwnedDocumentJob(owner, id)).canResume, false);
  await assert.rejects(dal.controlDocumentJob(owner, id, 'resume'));
  assert.equal(events.length, 0);
  reset();
  job.status = 'failed';
  job.error_code = 'parse_result_invalid';
  job.parser_job_id = 'saved-invalid-result';
  job.parser_submit_started_at = 'started';
  const invalidResult = await dal.getOwnedDocumentJob(owner, id);
  assert.equal(invalidResult.canResume, false);
  assert.match(invalidResult.message, /different valid, readable PDF/);
  await assert.rejects(dal.controlDocumentJob(owner, id, 'resume'));
  assert.deepEqual(events, [], 'Invalid immutable parser results must not dispatch another workflow');
  for (const code of ['parser_timeout', 'metadata_failed', 'workflow_interrupted']) {
    reset();
    job.status = 'failed';
    job.error_code = code;
    job.parser_job_id = 'saved';
    job.parser_submit_started_at = 'started';
    assert.equal((await dal.getOwnedDocumentJob(owner, id)).canResume, true);
    await dal.controlDocumentJob(owner, id, 'resume');
    assert.deepEqual(events, ['maintenance', 'control_document_job', 'start']);
  }
  reset();
  job.status = 'cancelled';
  job.parser_job_id = 'saved';
  job.parser_submit_started_at = 'started';
  await dal.controlDocumentJob(owner, id, 'resume');
  assert.deepEqual(events, ['maintenance', 'control_document_job', 'start']);
  reset();
  job.status = 'failed';
  job.parser_submit_started_at = 'started';
  await assert.rejects(dal.controlDocumentJob(owner, id, 'resume'));
  assert.equal(events.length, 0, 'unknown parser receipt resumed');
  reset();
  job.status = 'failed';
  job.error_code = 'indexing_failed';
  job.parser_job_id = 'saved';
  job.parser_submit_started_at = 'started';
  await dal.controlDocumentJob(owner, id, 'resume');
  assert.deepEqual(events, ['maintenance', 'control_document_job', 'start']);
  reset();
  job.run_id = 'old-run';
  await dal.controlDocumentJob(owner, id, 'cancel');
  assert.equal(job.status, 'cancelled');
  assert.deepEqual(
    events,
    ['control_document_job', 'cancel-run'],
    'DB fence must precede best-effort SDK cancellation'
  );
  reset();
  currentUser = foreign;
  assert.equal(await dal.controlDocumentJob(foreign, id, 'cancel'), null);
  assert.equal(adminCalls, 0);
  console.log(
    'PASS actual document job DAL: owner-before-admin, acknowledged maintenance, dispatch recovery, safe views, validated filters, parser-unknown hold and cancellation fence ordering'
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
