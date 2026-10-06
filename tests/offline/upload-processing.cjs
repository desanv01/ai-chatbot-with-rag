const fs = require('node:fs'),
  vm = require('node:vm'),
  assert = require('node:assert/strict');
const ts = require('typescript');
const runtimeRequire = require('node:module').createRequire(
  require('node:path').resolve(__dirname, '../../package.json')
);
const base =
  require('node:path').resolve(__dirname, '../..') + require('node:path').sep;
let state;
function reset(patch = {}) {
  state = {
    existing: false,
    lookupError: false,
    uniqueRace: false,
    total: 0,
    blob: new Blob(['%PDF-fixture']),
    fetches: [],
    lookups: [],
    signed: 0,
    downloads: 0,
    inserted: 0,
    vectors: 0,
    metadata: 0,
    embeddings: 0,
    active: 0,
    maxActive: 0,
    updates: [],
    completed: 0,
    vectorRows: [],
    markdown: 'fixture content',
    ...patch
  };
}
function builder(table, initialMode = 'lookup', initialData) {
  let mode = initialMode,
    data = initialData,
    filters = {},
    signal;
  const result = {
    select() {
      return this;
    },
    eq(key, value) {
      state.lookups.push([key, value]);
      filters[key] = value;
      return this;
    },
    maybeSingle() {
      return this;
    },
    single() {
      return this;
    },
    abortSignal(value) {
      signal = value;
      return this;
    },
    insert(value) {
      mode = 'insert';
      data = value;
      return this;
    },
    update(value) {
      mode = 'update';
      data = value;
      return this;
    },
    upsert(value) {
      mode = 'vectors';
      data = value;
      return this;
    },
    then(resolve, reject) {
      return Promise.resolve()
        .then(() => {
          signal?.throwIfAborted();
          if (mode === 'insert') {
            assert.equal(table, 'user_documents');
            assert.equal(data.user_id, 'owner');
            assert.equal(data.processing_status, 'processing');
            assert.equal(data.processing_job_id, 'job');
            state.inserted++;
            state.reservation = data;
            state.status = 'processing';
            return state.uniqueRace
              ? { data: null, error: { code: '23505', message: 'private db' } }
              : { data: { id: 'new' }, error: null };
          }
          if (mode === 'update') {
            state.updates.push({ data, filters });
            assert.equal(filters.id, 'new');
            assert.equal(filters.user_id, 'owner');
            assert.equal(filters.processing_job_id, 'job');
            assert.equal(filters.processing_status, 'processing');
            if (state.status === filters.processing_status) {
              Object.assign(state, {
                status: data.processing_status ?? state.status
              });
              return { data: { id: 'new' }, error: null };
            }
            return { data: null, error: null };
          }
          if (mode === 'vectors') {
            assert.equal(table, 'user_documents_vec');
            assert.equal(state.status, 'processing');
            state.vectors += data.length;
            state.vectorRows.push(...data);
            return { error: null };
          }
          if (mode === 'rpc') {
            state.completed++;
            assert.deepEqual(
              [...data.p_expected_page_numbers],
              state.vectorRows.map((row) => row.page_number)
            );
            if (state.rpcFailure) return { error: { message: 'private db' } };
            state.status = 'ready';
            return { error: state.lostAck ? { message: 'private db' } : null };
          }
          if (filters.id)
            return {
              data: state.status === 'processing' ? { id: 'new' } : null,
              error: null
            };
          return {
            data: state.existing ? { id: 'old' } : null,
            error: state.lookupError ? { message: 'private db' } : null
          };
        })
        .then(resolve, reject);
    }
  };
  return result;
}
const admin = {
  from: (table) => builder(table),
  rpc: (name, data) => {
    assert.equal(name, 'complete_document_processing');
    return builder('rpc', 'rpc', data);
  },
  storage: {
    from: () => ({
      async list() {
        return { data: [{ metadata: { size: state.total } }], error: null };
      },
      async createSignedUploadUrl(path) {
        state.signed++;
        assert.ok(path.startsWith('owner/'));
        return { data: { signedUrl: 'https://upload.test/new' }, error: null };
      },
      async download() {
        state.downloads++;
        return { data: state.blob, error: null };
      },
      remove() {
        throw Error('Unexpected removal');
      }
    })
  }
};
const mocks = {
  'server-only': {},
  zod: runtimeRequire('zod'),
  'next/server': {
    NextResponse: class extends Response {
      static json(data, init) {
        return new Response(JSON.stringify(data), {
          ...init,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
  },
  'next/cache': { revalidatePath() {} },
  '@/lib/server/supabase': { getSession: async () => ({ sub: 'owner' }) },
  '@/lib/server/admin': { createAdminClient: () => admin },
  '@/lib/server/document-job-token': {
    createDocumentJobToken: () => 'valid',
    verifyDocumentJobToken: (token) => token === 'valid'
  },
  ai: {
    embed: async (options) => {
      assert.equal(options.maxRetries, 0);
      assert.ok(options.abortSignal);
      state.embeddings++;
      const n = state.embeddings;
      state.active++;
      state.maxActive = Math.max(state.maxActive, state.active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      state.active--;
      if (n === state.embedFailAt) throw Error('private provider error');
      return { embedding: state.invalidEmbedding ?? Array(1024).fill(0.5) };
    }
  },
  'voyage-ai-provider': { voyage: () => ({}) },
  './agentchains': {
    generateDocumentMetadata: async () => {
      state.metadata++;
      assert.equal(state.status, 'processing');
      if (state.metadataFailure) throw Error('private provider error');
      return {
        output: {
          descriptiveTitle: 'fixture',
          shortDescription: 'fixture',
          mainTopics: [],
          keyEntities: []
        }
      };
    },
    preliminaryAnswerChainAgent: async () => ({
      output: {
        tags: [],
        preliminary_answer_1: '',
        preliminary_answer_2: '',
        hypothetical_question_1: '',
        hypothetical_question_2: ''
      }
    })
  }
};
function load(file) {
  const mod = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(base + file, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022
      }
    }).outputText,
    {
      module: mod,
      exports: mod.exports,
      require: (name) => {
        if (name === '@/lib/document-limits')
          return load('lib/document-limits.ts');
        if (name === '@/lib/document-path') return load('lib/document-path.ts');
        if (name === '@/lib/llamaparse-pages')
          return load('lib/llamaparse-pages.ts');
        if (name in mocks) return mocks[name];
        throw Error(name);
      },
      process,
      console: { error() {}, warn() {} },
      Response,
      Blob,
      FormData,
      Uint8Array,
      crypto,
      AbortSignal,
      fetch: async (url) => {
        state.fetches.push(url);
        return new Response(
          JSON.stringify(
            url.endsWith('/upload')
              ? { id: 'job' }
              : (state.parserResult ?? {
                  pages: state.markdown
                    .split('\n---\n')
                    .map((md, index) => ({ page: index + 1, md })),
                  job_metadata: {
                    job_pages: state.markdown.split('\n---\n').length
                  }
                })
          ),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }
    }
  );
  return mod.exports;
}
const request = (x) => ({
  json: async () => x,
  signal: new AbortController().signal
});
async function run() {
  process.env.LLAMA_CLOUD_API_KEY = 'test-only';
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test-only';
  process.env.VOYAGE_API_KEY = 'test-only';
  const sign = load('app/api/upload/presigned-url/route.ts').POST;
  const meta = { fileName: 'fixture.pdf', fileSize: 25 * 1024 * 1024 };
  reset();
  assert.equal((await sign(request(meta))).status, 200);
  assert.equal(state.signed, 1);
  assert.ok(state.lookups.some(([k, v]) => k === 'user_id' && v === 'owner'));
  reset();
  assert.equal(
    (await sign(request({ ...meta, fileSize: meta.fileSize + 1 }))).status,
    400
  );
  assert.equal(state.signed, 0);
  reset();
  assert.equal(
    (await sign(request({ ...meta, fileName: 'fixture.html' }))).status,
    400
  );
  reset({ existing: true });
  assert.equal((await sign(request(meta))).status, 409);
  assert.equal(state.signed, 0);
  reset({ lookupError: true });
  const failure = await sign(request(meta));
  assert.equal(failure.status, 500);
  assert.equal((await failure.text()).includes('private db'), false);
  reset({ total: 150 * 1024 * 1024 });
  assert.equal((await sign(request({ ...meta, fileSize: 1 }))).status, 400);
  assert.equal(state.signed, 0);
  console.log(
    'PASS signing PDF/25MiB boundary, 150MiB quota, owner-scoped conflicts and fail-closed lookup'
  );
  const upload = load('app/api/uploaddoc/route.ts').POST;
  const file = { name: 'fixture.pdf', path: 'owner/new.pdf' };
  for (const [label, patch, entry] of [
    ['foreign', {}, { ...file, path: 'other/new.pdf' }],
    ['unsupported', {}, { ...file, name: 'file.html' }],
    ['conflict', { existing: true }, file],
    ['lookup', { lookupError: true }, file],
    ['header', { blob: new Blob(['<html>']) }, file],
    ['size', { blob: new Blob([new Uint8Array(25 * 1024 * 1024 + 1)]) }, file]
  ]) {
    reset(patch);
    const res = await upload(request({ uploadedFiles: [entry] }));
    assert.equal((await res.json()).results[0].status, 'error');
    assert.equal(state.fetches.length, 0, label);
    assert.equal(state.signed, 0);
  }
  reset();
  const good = await upload(request({ uploadedFiles: [file] }));
  assert.equal((await good.json()).results[0].jobToken, 'valid');
  assert.equal(state.fetches.length, 1);
  console.log(
    'PASS parser upload rejects foreign paths, unsupported/oversize/header-invalid files and conflicts before provider calls'
  );
  const processPost = load('app/api/processdoc/route.ts').POST;
  const job = {
    jobId: 'job',
    jobToken: 'valid',
    fileName: 'fixture.pdf',
    filePath: 'owner/new.pdf'
  };
  reset({ existing: true });
  assert.equal((await processPost(request(job))).status, 409);
  assert.equal(state.metadata, 0);
  assert.equal(state.inserted, 0);
  assert.equal(state.embeddings, 0);
  reset({ uniqueRace: true });
  assert.equal((await processPost(request(job))).status, 409);
  assert.equal(state.embeddings, 0);
  assert.equal(state.vectors, 0);
  reset();
  assert.equal(
    (await processPost(request({ ...job, jobToken: 'tampered' }))).status,
    400
  );
  assert.equal(state.fetches.length, 0);
  reset();
  assert.equal(
    (await processPost(request({ ...job, filePath: 'other/new.pdf' }))).status,
    400
  );
  assert.equal(state.fetches.length, 0);
  reset();
  assert.equal((await processPost(request(job))).status, 200);
  assert.equal(state.inserted, 1);
  assert.equal(state.vectors, 1);
  assert.equal(state.status, 'ready');
  assert.equal(state.completed, 1);
  reset({ markdown: 'one\n---\n\n---\nthree' });
  assert.equal((await processPost(request(job))).status, 200);
  assert.deepEqual(
    state.vectorRows.map((row) => row.page_number),
    [1, 3]
  );
  assert.equal(state.reservation.total_pages, 3);
  reset({
    markdown: Array.from({ length: 10 }, (_, i) => `page ${i}`).join('\n---\n')
  });
  assert.equal((await processPost(request(job))).status, 200);
  assert.equal(state.vectors, 10);
  assert.ok(state.maxActive <= 4);
  reset({
    markdown: Array.from({ length: 9 }, (_, i) => `page ${i}`).join('\n---\n'),
    embedFailAt: 5
  });
  const failedBatch = await processPost(request(job));
  assert.equal(failedBatch.status, 500);
  assert.equal(state.status, 'failed');
  assert.equal(state.vectors, 4);
  assert.equal(state.active, 0);
  assert.equal(state.completed, 0);
  assert.ok(!(await failedBatch.text()).includes('private'));
  for (const patch of [
    { metadataFailure: true },
    { invalidEmbedding: [1] },
    { invalidEmbedding: Array(1024).fill(NaN) },
    { rpcFailure: true }
  ]) {
    reset(patch);
    assert.equal((await processPost(request(job))).status, 500);
    assert.equal(state.status, 'failed');
  }
  reset({ lostAck: true });
  assert.equal((await processPost(request(job))).status, 500);
  assert.equal(state.status, 'ready');
  reset({
    parserResult: { pages: [{ page: 1, md: 'rule\n---\nremains same page' }] }
  });
  assert.equal((await processPost(request(job))).status, 200);
  assert.equal(state.vectors, 1);
  assert.equal(
    state.vectorRows[0].text_content,
    'rule\n---\nremains same page'
  );
  for (const parserResult of [
    { markdown: 'legacy ambiguous result' },
    {
      pages: [
        { page: 1, md: 'x' },
        { page: 3, md: 'y' }
      ]
    },
    { pages: [{ page: 1, md: '' }] }
  ]) {
    reset({ parserResult });
    assert.equal((await processPost(request(job))).status, 422);
    assert.equal(state.inserted, 0);
    assert.equal(state.metadata, 0);
    assert.equal(state.embeddings, 0);
  }
  reset();
  delete process.env.VOYAGE_API_KEY;
  assert.equal((await processPost(request(job))).status, 503);
  assert.equal(state.fetches.length, 0);
  process.env.VOYAGE_API_KEY = 'test-only';
  console.log(
    'PASS reserve-before-provider, blank position, bounded batches, safe failures, ready finalization, no ready downgrade and missing-key gate'
  );
  console.log(
    'PASS processing conflict/race prevents replacement or duplicate vectors; token/path guards retained; mock success only'
  );
}
run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
