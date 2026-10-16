const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
class FatalError extends Error {}
class RetryableError extends Error {}
const owner = '11111111-1111-4111-8111-111111111111';
const jobId = '22222222-2222-4222-8222-222222222222';
const sourcePath = `${owner}/33333333-3333-4333-8333-333333333333.pdf`;
const originalBytes = Buffer.from('%PDF-1.4\nSynthetic durable test');
const safeMetadata = {
  descriptiveTitle: 'Synthetic',
  shortDescription: 'Test only',
  mainTopics: ['Test'],
  keyEntities: [],
  primaryLanguage: 'English'
};
let job,
  pages,
  bytes,
  storageError,
  networkMode,
  parserResult,
  requests,
  rpcCalls,
  embeddings,
  metadataInputs,
  preliminaryFailure;
const env = {
  GOOGLE_GENERATIVE_AI_API_KEY: 'test-only',
  VOYAGE_API_KEY: 'test-only',
  LLAMA_CLOUD_API_KEY: 'test-only'
};
function reset() {
  job = {
    id: jobId,
    user_id: owner,
    document_id: 'doc',
    file_name: 'synthetic.pdf',
    file_path: sourcePath,
    generation: 1,
    run_id: 'run-A',
    status: 'queued',
    parser_job_id: null,
    parser_submit_started_at: null,
    source_sha256: null,
    source_size: null,
    metadata: null,
    total_pages: null,
    completed_pages: 0
  };
  pages = [];
  bytes = originalBytes;
  storageError = null;
  networkMode = 'normal';
  parserResult = {
    pages: [
      { page: 1, md: 'First' },
      { page: 2, md: '' },
      { page: 3, md: 'Third' }
    ]
  };
  requests = [];
  rpcCalls = [];
  embeddings = [];
  metadataInputs = [];
  preliminaryFailure = false;
}
function query(table) {
  const filters = [];
  let ordering = null,
    take = null;
  const q = {
    select() {
      return q;
    },
    eq(k, v) {
      filters.push((r) => r[k] === v);
      return q;
    },
    neq(k, v) {
      filters.push((r) => r[k] !== v);
      return q;
    },
    order(k, o) {
      ordering = [k, o.ascending];
      return q;
    },
    limit(n) {
      take = n;
      return q;
    },
    async maybeSingle() {
      return { data: rows()[0] ?? null, error: null };
    },
    then(resolve, reject) {
      return Promise.resolve({ data: rows(), error: null }).then(
        resolve,
        reject
      );
    }
  };
  function rows() {
    let rs = (table === 'document_processing_jobs' ? [job] : pages).filter(
      (r) => filters.every((f) => f(r))
    );
    if (ordering)
      rs.sort(
        (a, b) => (a[ordering[0]] - b[ordering[0]]) * (ordering[1] ? 1 : -1)
      );
    if (take !== null) rs = rs.slice(0, take);
    return structuredClone(rs);
  }
  return q;
}
const admin = {
  from: query,
  storage: {
    from(bucket) {
      assert.equal(bucket, 'userfiles');
      return {
        async download(p) {
          assert.equal(p, sourcePath);
          return storageError
            ? { data: null, error: storageError }
            : { data: new Blob([bytes]), error: null };
        }
      };
    }
  },
  rpc(name, args) {
    const result = async () => {
      rpcCalls.push({ name, args: structuredClone(args) });
      if (args.p_generation !== job.generation || args.p_run_id !== job.run_id)
        return { data: false, error: null };
      if (name === 'begin_document_parser_submission') {
        if (job.parser_submit_started_at || job.parser_job_id)
          return { data: false, error: null };
        job.parser_submit_started_at = 'started';
        job.status = 'parsing';
      } else if (name === 'checkpoint_document_job')
        Object.assign(job, structuredClone(args.p_patch));
      else if (name === 'store_document_job_pages') {
        for (const p of args.p_pages)
          if (!pages.some((x) => x.page_number === p.page_number))
            pages.push({ job_id: jobId, indexed: false, ...p });
      } else if (name === 'commit_document_job_page') {
        const p = pages.find((p) => p.page_number === args.p_page_number);
        p.indexed = true;
        return { data: pages.filter((p) => p.indexed).length, error: null };
      } else if (name === 'complete_document_job') job.status = 'ready';
      else if (name === 'fail_document_job') job.status = 'failed';
      else if (name !== 'claim_document_job')
        throw new Error(`Unexpected RPC ${name}`);
      return { data: true, error: null };
    };
    return {
      abortSignal() {
        return this;
      },
      then(resolve, reject) {
        return result().then(resolve, reject);
      }
    };
  }
};
const mocks = {
  'server-only': {},
  workflow: { FatalError, RetryableError },
  '@/lib/server/admin': { createAdminClient: () => admin },
  'voyage-ai-provider': {
    voyage: (name) => {
      assert.equal(name, 'voyage-3-large');
      return 'test-voyage';
    }
  },
  ai: {
    embed: async (options) => {
      embeddings.push(options);
      return { embedding: Array(1024).fill(0.1) };
    }
  },
  '@/app/api/processdoc/agentchains': {
    generateDocumentMetadata: async (content) => {
      metadataInputs.push(content);
      return { output: safeMetadata };
    },
    preliminaryAnswerChainAgent: async () => {
      if (preliminaryFailure) throw new Error('private upstream message');
      return {
        output: {
          preliminary_answer_1: 'One',
          preliminary_answer_2: 'Two',
          tags: ['Test'],
          hypothetical_question_1: 'Why',
          hypothetical_question_2: 'How'
        }
      };
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
      Buffer,
      Blob,
      FormData,
      AbortSignal,
      Error,
      Uint8Array,
      console,
      process: { env },
      require: (n) =>
        n in mocks
          ? mocks[n]
          : n.startsWith('@/')
            ? load(n.slice(2) + '.ts')
            : require(n),
      fetch: async (url, options) => {
        requests.push({ url, method: options.method ?? 'GET' });
        if (networkMode === 'throw')
          throw new Error('private network upstream detail');
        if (networkMode === '429') return { status: 429, ok: false };
        return {
          status: 200,
          ok: true,
          json: async () =>
            url.endsWith('/upload')
              ? { id: 'parser-A' }
              : url.endsWith('/result/json')
                ? parserResult
                : { status: 'SUCCESS' }
        };
      }
    }
  );
  return exports;
}
async function rejectCode(p, klass, code) {
  await assert.rejects(p, (e) => e instanceof klass && e.message === code);
}
async function main() {
  reset();
  const steps = load('lib/server/document-processing-steps.ts');
  const args = [jobId, 1, 'run-A'];
  await steps.submitDocumentParserStep(...args);
  assert.equal(job.parser_job_id, 'parser-A');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.equal(
    job.source_sha256,
    createHash('sha256').update(originalBytes).digest('hex')
  );
  await steps.submitDocumentParserStep(...args);
  assert.equal(requests.length, 1, 'known parser was resubmitted');
  bytes = Buffer.from('%PDF-1.4\nDifferent source');
  await rejectCode(
    steps.submitDocumentParserStep(...args),
    FatalError,
    'source_invalid'
  );
  assert.equal(requests.length, 1, 'changed source reached parser');
  reset();
  networkMode = 'throw';
  await rejectCode(
    steps.submitDocumentParserStep(...args),
    FatalError,
    'parser_submission_unknown'
  );
  assert.ok(job.parser_submit_started_at);
  assert.equal(requests.length, 1);
  await rejectCode(
    steps.submitDocumentParserStep(...args),
    FatalError,
    'parser_submission_unknown'
  );
  assert.equal(requests.length, 1, 'ambiguous parser POST repeated');
  reset();
  delete env.VOYAGE_API_KEY;
  await rejectCode(
    steps.submitDocumentParserStep(...args),
    RetryableError,
    'workflow_interrupted'
  );
  assert.equal(job.parser_submit_started_at, null);
  assert.equal(requests.length, 0);
  env.VOYAGE_API_KEY = 'test-only';
  reset();
  storageError = { status: 404 };
  await rejectCode(
    steps.submitDocumentParserStep(...args),
    FatalError,
    'source_invalid'
  );
  reset();
  storageError = { status: 503, message: 'private storage detail' };
  await rejectCode(
    steps.submitDocumentParserStep(...args),
    RetryableError,
    'workflow_interrupted'
  );
  assert.equal(job.parser_submit_started_at, null);
  reset();
  job.generation = 2;
  await rejectCode(
    steps.submitDocumentParserStep(...args),
    FatalError,
    'workflow_interrupted'
  );
  assert.equal(requests.length, 0);
  reset();
  job.parser_job_id = 'parser-A';
  job.parser_submit_started_at = 'saved';
  job.status = 'parsing';
  networkMode = '429';
  await rejectCode(
    steps.pollDocumentParserStep(...args),
    RetryableError,
    'parser_failed'
  );
  networkMode = 'normal';
  assert.equal(await steps.pollDocumentParserStep(...args), 'success');
  assert.equal((await steps.stageDocumentPagesStep(...args)).totalPages, 3);
  assert.equal(pages[1].markdown, '');
  const before = requests.length;
  await steps.stageDocumentPagesStep(...args);
  assert.equal(requests.length, before);
  await steps.prepareDocumentMetadataStep(...args);
  assert.equal(job.status, 'indexing');
  assert.equal(metadataInputs.length, 1);
  await steps.prepareDocumentMetadataStep(...args);
  assert.equal(metadataInputs.length, 1, 'metadata regenerated on resume');
  await steps.indexDocumentPageStep(...args, 2);
  assert.equal(embeddings.length, 0, 'blank page embedded');
  preliminaryFailure = true;
  await steps.indexDocumentPageStep(...args, 1);
  assert.equal(embeddings.length, 1);
  assert.equal(embeddings[0].maxRetries, 0);
  assert.equal(embeddings[0].providerOptions.voyage.outputDimension, 1024);
  assert.equal(embeddings[0].providerOptions.voyage.truncation, false);
  await steps.indexDocumentPageStep(...args, 1);
  assert.equal(embeddings.length, 1, 'committed page re-embedded');
  await steps.indexDocumentPageStep(...args, 3);
  await steps.completeDocumentJobStep(...args);
  assert.equal(job.status, 'ready');
  reset();
  job.parser_job_id = 'parser-A';
  job.parser_submit_started_at = 'saved';
  parserResult = { pages: [{ page: 1, md: ' ' }] };
  await rejectCode(
    steps.stageDocumentPagesStep(...args),
    FatalError,
    'parse_result_invalid'
  );
  assert.equal(job.total_pages, null);
  // Sampling must reach real last pages rather than the PostgREST default first 1000.
  reset();
  job.total_pages = 1100;
  job.status = 'metadata';
  pages = Array.from({ length: 1100 }, (_, i) => ({
    job_id: jobId,
    page_number: i + 1,
    markdown: `page-${i + 1}`,
    indexed: false
  }));
  await steps.prepareDocumentMetadataStep(...args);
  assert.ok(metadataInputs[0].includes('page-1100'));
  assert.ok(!metadataInputs[0].includes('page-500'));
  assert.equal(metadataInputs[0].split('\n\n').length, 20);
  console.log(
    'PASS document workflow steps: one parser POST, ambiguous outcome hold, immutable resumed source, safe errors, cached metadata/pages, physical blanks and checkpointed embeddings'
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
