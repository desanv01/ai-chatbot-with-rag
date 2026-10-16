const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const assert = require('node:assert/strict'),
  ts = require('typescript');
const root = path.resolve(__dirname, '../..'),
  id = '22222222-2222-4222-8222-222222222222';
let session = { sub: 'owner' },
  job = { id, status: 'failed', canResume: true, canCancel: false },
  calls = [],
  failure = false;
const mocks = {
  'next/server': {
    NextResponse: {
      json: (x, options) => new Response(JSON.stringify(x), options)
    }
  },
  '@/lib/server/supabase': { getSession: async () => session },
  '@/lib/server/document-jobs': {
    listOwnedDocumentJobs: async (owner, ids) => {
      calls.push(['list', owner, ids]);
      if (failure) throw Error('private SQL details');
      return [];
    },
    getOwnedDocumentJob: async (owner, jobId) => {
      calls.push(['get', owner, jobId]);
      if (failure) throw Error('private lookup details');
      return job;
    },
    controlDocumentJob: async (owner, jobId, action) => {
      calls.push(['control', owner, jobId, action]);
      if (failure) throw Error('private runtime details');
      return { job, dispatchPending: false };
    }
  }
};
function load(file) {
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022
      }
    }).outputText,
    {
      exports,
      Response,
      Error,
      require: (n) => {
        assert.ok(n in mocks, n);
        return mocks[n];
      }
    }
  );
  return exports;
}
const request = (query = '', body) => ({
  nextUrl: new URL('https://app.test/api/document-jobs' + query),
  json: async () => body
});
const context = (jobId) => ({ params: Promise.resolve({ id: jobId }) });
async function check(response, status) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  const text = await response.text();
  assert.ok(
    !text.includes('private SQL') &&
      !text.includes('private lookup') &&
      !text.includes('private runtime')
  );
}
async function main() {
  const list = load('app/api/document-jobs/route.ts'),
    one = load('app/api/document-jobs/[id]/route.ts');
  session = null;
  await check(await list.GET(request()), 401);
  await check(await one.GET(request(), context(id)), 401);
  await check(
    await one.POST(request('', { action: 'resume' }), context(id)),
    401
  );
  assert.equal(calls.length, 0);
  session = { sub: 'owner' };
  for (const q of [
    '?documentIds=x',
    '?documentIds=' + Array(21).fill(id).join(','),
    '?documentIds=' + id + '&documentIds=' + id,
    '?user_id=foreign'
  ])
    await check(await list.GET(request(q)), 400);
  assert.equal(calls.length, 0);
  await check(
    await list.GET(request('?documentIds=' + id.toUpperCase() + ',' + id)),
    200
  );
  assert.equal(calls[0][1], 'owner');
  assert.deepEqual([...calls[0][2]], [id]);
  calls = [];
  await check(await one.GET(request(), context('bad')), 400);
  assert.equal(calls.length, 0);
  job = null;
  await check(await one.GET(request(), context(id)), 404);
  await check(
    await one.POST(request('', { action: 'resume' }), context(id)),
    404
  );
  assert.ok(!calls.some((c) => c[0] === 'control'));
  job = { id, status: 'failed', canResume: false, canCancel: false };
  await check(
    await one.POST(request('', { action: 'resume' }), context(id)),
    409
  );
  for (const body of [
    null,
    [],
    { action: 'delete' },
    { action: 'resume', run_id: 'injected' }
  ])
    await check(await one.POST(request('', body), context(id)), 400);
  job = { id, status: 'failed', canResume: true, canCancel: false };
  await check(
    await one.POST(request('', { action: 'resume' }), context(id)),
    200
  );
  assert.deepEqual(calls.at(-1), ['control', 'owner', id, 'resume']);
  failure = true;
  await check(await list.GET(request()), 503);
  await check(await one.GET(request(), context(id)), 503);
  console.log(
    'PASS document job APIs: session/UUID/query/body validation, owner-only lookup, unavailable action rejection, private no-store responses and sanitized failures'
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
