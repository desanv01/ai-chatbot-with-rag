// Requires a completed Next build. Uses localhost fixtures and a temporary Local
// World directory only: no Supabase project, provider or Vercel deployment calls.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const root = path.resolve(__dirname, '../..');
const objectPath =
  '11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333/' +
  'a'.repeat(64) +
  '.pdf';
let removes = 0,
  finishes = 0,
  ownerChecks = 0;
const fixture = http.createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  const url = new URL(request.url, 'http://localhost');
  response.setHeader('Content-Type', 'application/json');
  if (url.pathname === '/rest/v1/rpc/claim_chat_attachment_maintenance') {
    ownerChecks++;
    response.end(JSON.stringify(finishes === 0));
  } else if (url.pathname === '/rest/v1/rpc/claim_chat_attachment_cleanup') {
    response.end(JSON.stringify([{ object_path: objectPath }]));
  } else if (url.pathname === '/rest/v1/chat_attachment_objects') {
    response.end('[]');
  } else if (
    url.pathname === '/storage/v1/object/chat-attachments' &&
    request.method === 'DELETE'
  ) {
    assert.deepEqual(JSON.parse(body).prefixes, [objectPath]);
    removes++;
    response.end(JSON.stringify([{ name: objectPath }]));
  } else if (url.pathname === '/rest/v1/rpc/finish_chat_attachment_cleanup') {
    assert.equal(JSON.parse(body).p_success, true);
    finishes++;
    response.end('true');
  } else {
    response.statusCode = 500;
    response.end(
      JSON.stringify({ message: 'Unexpected localhost fixture request' })
    );
  }
});
const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  );
let next,
  log = '',
  run;
async function waitFor(check, label, timeout = 60_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(250);
  }
  throw new Error(`Timed out: ${label}; local server log: ${log.slice(-2500)}`);
}
async function stopNext() {
  if (!next || next.exitCode !== null) return;
  const processToStop = next;
  const stopped = new Promise((resolve) => processToStop.once('exit', resolve));
  processToStop.kill();
  await Promise.race([stopped, delay(5000)]);
  if (processToStop.exitCode === null) processToStop.kill('SIGKILL');
}
async function main() {
  const fixturePort = await listen(fixture);
  const portProbe = http.createServer();
  const appPort = await listen(portProbe);
  await new Promise((resolve) => portProbe.close(resolve));
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'v1-attachment-workflow-')
  );
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (
      key === 'VERCEL' ||
      /^(SUPABASE_|GOOGLE_|LLAMA_|VOYAGE_|OPENAI_|ANTHROPIC_|EXA_|DOCUMENT_JOB_|VERCEL_|WORKFLOW_)/.test(
        key
      )
    )
      delete environment[key];
  }
  Object.assign(environment, {
    SUPABASE_URL: `http://127.0.0.1:${fixturePort}`,
    SUPABASE_SERVICE_ROLE_KEY: 'local-fixture-only',
    SUPABASE_ANON_KEY: 'local-fixture-only',
    WORKFLOW_TARGET_WORLD: 'local',
    WORKFLOW_LOCAL_DATA_DIR: dataDir,
    WORKFLOW_LOCAL_BASE_URL: `http://127.0.0.1:${appPort}`,
    PORT: String(appPort)
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
    next.stdout.on('data', (chunk) => {
      log += chunk;
    });
    next.stderr.on('data', (chunk) => {
      log += chunk;
    });
    await waitFor(
      () => log.includes('Ready in'),
      'local Next server readiness'
    );
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
        'workflow//./workflows/chat-attachment-maintenance//chatAttachmentMaintenance'
    },
    [null]
  );
  await waitFor(
    () => finishes === 1,
    'first actual Workflow step and Storage cleanup'
  );
  assert.equal(removes, 1);
  // Restart the serving process while the workflow is durably sleeping.
  await stopNext();
  await startNext();
  await getRun(run.runId).wakeUp();
  await waitFor(
    async () => (await getRun(run.runId).status) === 'completed',
    'persisted Workflow resumption after restart'
  );
  const result = await getRun(run.runId).returnValue;
  assert.deepEqual(result, { removed: 1, failed: 0 });
  assert.equal(removes, 1, 'replay duplicated the completed Storage step');
  assert.ok(ownerChecks >= 2);
  console.log(
    'PASS actual installed Workflow/Next runtime: queued step, private-bucket cleanup, durable sleep, server restart and replay without repeated deletion; localhost fixtures only'
  );
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      if (run) {
        const { getRun } = await import('workflow/api');
        await getRun(run.runId).cancel();
      }
    } catch {
      // A completed or already cancelled fixture run needs no further cancellation.
    }
    await stopNext();
    fixture.closeAllConnections();
    await new Promise((resolve) => fixture.close(resolve));
    process.exit(process.exitCode || 0);
  });
