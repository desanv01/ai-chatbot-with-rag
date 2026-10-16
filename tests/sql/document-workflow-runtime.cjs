// Requires a completed Next build. Local World and localhost SDK fixtures only.
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  http = require('node:http');
const { spawn } = require('node:child_process'),
  assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const root = path.resolve(__dirname, '../..');
const id = '22222222-2222-4222-8222-222222222222',
  owner = '11111111-1111-4111-8111-111111111111';
const job = {
  id,
  user_id: owner,
  document_id: '33333333-3333-4333-8333-333333333333',
  file_name: 'runtime.pdf',
  file_path: `${owner}/44444444-4444-4444-8444-444444444444.pdf`,
  generation: 1,
  run_id: null,
  status: 'queued',
  parser_job_id: null,
  parser_submit_started_at: null,
  source_sha256: null,
  source_size: null,
  metadata: null,
  total_pages: null,
  completed_pages: 0,
  error_code: null
};
let pages = [],
  submits = 0,
  polls = 0,
  metadataCalls = 0,
  enrichmentCalls = 0,
  embeddings = 0,
  commits = 0,
  completions = 0,
  unexpected = [];
const fixture = http.createServer(async (req, res) => {
  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Content-Type', 'application/json');
    const send = (value) => res.end(JSON.stringify(value));
    if (url.pathname === '/provider') {
      const upstream = new URL(url.searchParams.get('url'));
      if (upstream.hostname === 'api.cloud.llamaindex.ai') {
        if (upstream.pathname.endsWith('/upload')) {
          submits++;
          return send({ id: 'parser-runtime' });
        }
        if (upstream.pathname.endsWith('/result/json'))
          return send({
            pages: [
              { page: 1, md: 'Synthetic runtime first page' },
              { page: 2, md: '' }
            ]
          });
        polls++;
        return send({ status: polls === 1 ? 'PENDING' : 'SUCCESS' });
      }
      if (upstream.hostname === 'generativelanguage.googleapis.com') {
        const input = JSON.parse(body),
          isMetadata = JSON.stringify(
            input.systemInstruction ?? input
          ).includes('generate helpful metadata');
        if (isMetadata) metadataCalls++;
        else enrichmentCalls++;
        const output = isMetadata
          ? {
              descriptiveTitle: 'Runtime',
              shortDescription: 'Synthetic only',
              mainTopics: ['Runtime'],
              keyEntities: [],
              primaryLanguage: 'English'
            }
          : {
              preliminary_answer_1: 'One',
              preliminary_answer_2: 'Two',
              tags: ['Runtime'],
              hypothetical_question_1: 'Why',
              hypothetical_question_2: 'How'
            };
        return send({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: JSON.stringify(output) }]
              },
              finishReason: 'STOP'
            }
          ],
          usageMetadata: {
            promptTokenCount: 1,
            candidatesTokenCount: 1,
            totalTokenCount: 2
          },
          modelVersion: 'fixture'
        });
      }
      if (upstream.hostname === 'api.voyageai.com') {
        embeddings++;
        return send({
          data: [
            { object: 'embedding', embedding: Array(1024).fill(0.1), index: 0 }
          ],
          model: 'voyage-3-large',
          usage: { total_tokens: 1 }
        });
      }
    }
    if (url.pathname.startsWith('/storage/v1/object/')) {
      res.setHeader('Content-Type', 'application/pdf');
      return res.end('%PDF-1.4\nSynthetic runtime source');
    }
    if (url.pathname === '/rest/v1/document_processing_jobs')
      return send([job]);
    if (url.pathname === '/rest/v1/document_processing_pages') {
      let rows = pages.slice();
      const page = url.searchParams.get('page_number');
      if (page)
        rows = rows.filter((p) => p.page_number === Number(page.slice(3)));
      if (url.searchParams.get('markdown') === 'neq.')
        rows = rows.filter((p) => p.markdown !== '');
      if (url.searchParams.get('order')?.includes('desc')) rows.reverse();
      const limit = Number(url.searchParams.get('limit'));
      if (limit) rows = rows.slice(0, limit);
      return send(rows);
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const name = url.pathname.split('/').at(-1),
        args = JSON.parse(body);
      if (name === 'claim_document_job') {
        if (job.run_id && job.run_id !== args.p_run_id) return send(false);
        job.run_id = args.p_run_id;
        return send(true);
      }
      if (name === 'begin_document_parser_submission') {
        assert.equal(job.parser_submit_started_at, null);
        job.parser_submit_started_at = 'started';
        job.status = 'parsing';
        return send(true);
      }
      if (name === 'checkpoint_document_job') {
        Object.assign(job, args.p_patch);
        return send(true);
      }
      if (name === 'store_document_job_pages') {
        for (const p of args.p_pages)
          if (!pages.some((x) => x.page_number === p.page_number))
            pages.push({ job_id: id, indexed: false, ...p });
        return send(true);
      }
      if (name === 'commit_document_job_page') {
        const p = pages.find((p) => p.page_number === args.p_page_number);
        assert.equal(Boolean(args.p_embedding), Boolean(p.markdown));
        if (!p.indexed) commits++;
        p.indexed = true;
        job.completed_pages = pages.filter((p) => p.indexed).length;
        return send(job.completed_pages);
      }
      if (name === 'complete_document_job') {
        assert.ok(pages.every((p) => p.indexed));
        job.status = 'ready';
        completions++;
        return send(true);
      }
      if (name === 'fail_document_job') {
        job.status = 'failed';
        job.error_code = args.p_error_code;
        return send(true);
      }
    }
    unexpected.push(req.method + ' ' + url.pathname);
    res.statusCode = 500;
    send({ message: 'Unexpected localhost fixture request' });
  } catch (e) {
    unexpected.push(e.message);
    res.statusCode = 500;
    res.end(JSON.stringify({ message: 'Fixture assertion failed' }));
  }
});
const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  );
let next,
  log = '',
  run;
async function waitFor(check, label, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(200);
  }
  throw Error(
    `Timed out ${label}; job=${job.status}/${job.error_code}; unexpected=${unexpected}; ${log.slice(-1800)}`
  );
}
async function stopNext() {
  if (!next || next.exitCode !== null) return;
  const child = next,
    stopped = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await Promise.race([stopped, delay(5000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
async function main() {
  const fixturePort = await listen(fixture),
    probe = http.createServer(),
    appPort = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'v1-document-workflow-')
    ),
    environment = { ...process.env };
  for (const key of Object.keys(environment))
    if (
      key === 'VERCEL' ||
      /^(SUPABASE_|GOOGLE_|LLAMA_|VOYAGE_|OPENAI_|ANTHROPIC_|EXA_|DOCUMENT_JOB_|VERCEL_|WORKFLOW_)/.test(
        key
      )
    )
      delete environment[key];
  Object.assign(environment, {
    SUPABASE_URL: `http://127.0.0.1:${fixturePort}`,
    SUPABASE_SERVICE_ROLE_KEY: 'local-fixture-only',
    SUPABASE_ANON_KEY: 'local-fixture-only',
    GOOGLE_GENERATIVE_AI_API_KEY: 'local-fixture-only',
    LLAMA_CLOUD_API_KEY: 'local-fixture-only',
    VOYAGE_API_KEY: 'local-fixture-only',
    WORKFLOW_TARGET_WORLD: 'local',
    WORKFLOW_LOCAL_DATA_DIR: dataDir,
    WORKFLOW_LOCAL_BASE_URL: `http://127.0.0.1:${appPort}`,
    V1_DOCUMENT_FIXTURE_URL: `http://127.0.0.1:${fixturePort}`,
    PORT: String(appPort),
    NODE_OPTIONS: `--require "${path.join(__dirname, 'document-workflow-network.cjs').replaceAll('\\', '/')}"`
  });
  async function startNext() {
    log = '';
    next = spawn(
      process.execPath,
      [
        path.join(root, 'node_modules/next/dist/bin/next'),
        'start',
        '--hostname',
        '127.0.0.1',
        '--port',
        String(appPort)
      ],
      {
        cwd: root,
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      }
    );
    next.stdout.on('data', (b) => {
      log += b;
    });
    next.stderr.on('data', (b) => {
      log += b;
    });
    await waitFor(() => log.includes('Ready in'), 'Next readiness');
  }
  Object.assign(process.env, {
    WORKFLOW_TARGET_WORLD: 'local',
    WORKFLOW_LOCAL_DATA_DIR: dataDir,
    WORKFLOW_LOCAL_BASE_URL: environment.WORKFLOW_LOCAL_BASE_URL,
    PORT: String(appPort)
  });
  const { start, getRun } = await import('workflow/api');
  await startNext();
  run = await start(
    {
      workflowId:
        'workflow//./workflows/document-processing//documentProcessingWorkflow'
    },
    [id, 1]
  );
  await waitFor(() => polls === 1, 'parser pending checkpoint');
  assert.equal(submits, 1);
  await stopNext();
  await startNext();
  await getRun(run.runId).wakeUp();
  await waitFor(
    async () => (await getRun(run.runId).status) === 'completed',
    'durable processing completion'
  );
  assert.deepEqual(await getRun(run.runId).returnValue, { status: 'ready' });
  assert.equal(job.status, 'ready');
  assert.equal(submits, 1, 'restart repeated parser submission');
  assert.equal(metadataCalls, 1);
  assert.equal(enrichmentCalls, 1);
  assert.equal(embeddings, 1);
  assert.equal(commits, 2);
  assert.equal(completions, 1);
  assert.deepEqual(unexpected, []);
  console.log(
    'PASS installed document Workflow/Next/provider SDKs: submit once, pending sleep, process restart/replay, metadata, one embedding, physical blank progress and completion; all external transport redirected to localhost'
  );
}
main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      if (run) {
        const { getRun } = await import('workflow/api');
        await getRun(run.runId).cancel();
      }
    } catch {
      // A completed or already cancelled fixture needs no further cancellation.
    }
    await stopNext();
    fixture.closeAllConnections();
    await new Promise((resolve) => fixture.close(resolve));
    process.exit(process.exitCode || 0);
  });
