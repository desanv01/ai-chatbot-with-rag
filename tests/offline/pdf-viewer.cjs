const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const assert = require('node:assert/strict'),
  ts = require('typescript');
const root = path.resolve(__dirname, '../..'),
  LIMIT = 3 * 1024 * 1024;
const element = (type, props) => ({ type, props: props ?? {} });
function nodes(t) {
  if (!t || typeof t !== 'object') return [];
  if (Array.isArray(t)) return t.flatMap(nodes);
  return [t, ...nodes(t.props?.children)];
}
const ui = new Proxy(
  { __esModule: true, default: 'UI' },
  { get: (o, k) => (k in o ? o[k] : String(k)) }
);
async function scenario(source, mode = 'success') {
  let state,
    effect,
    cleanup,
    resolveFetch,
    requests = [],
    created = [],
    revoked = [],
    timer;
  class Url extends URL {
    static createObjectURL(blob) {
      assert.ok(blob.size <= LIMIT);
      const u = `blob:fixture-${created.length}`;
      created.push(u);
      return u;
    }
    static revokeObjectURL(u) {
      revoked.push(u);
    }
  }
  const exports = {},
    mocks = {
      react: {
        useState(init) {
          state ??= init;
          return [
            state,
            (v) => {
              state = typeof v === 'function' ? v(state) : v;
            }
          ];
        },
        useEffect(f) {
          effect = f;
        }
      },
      'react/jsx-runtime': {
        jsx: element,
        jsxs: element,
        Fragment: 'fragment'
      },
      'next/navigation': { usePathname: () => '/chat/saved' },
      '@/lib/chat-attachment-limits': { MAX_CHAT_ATTACHMENT_BYTES: LIMIT }
    };
  vm.runInNewContext(
    ts.transpileModule(
      fs.readFileSync(
        path.join(root, 'app/(dashboard)/chat/components/UserPdfFiles.tsx'),
        'utf8'
      ),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX
        }
      }
    ).outputText,
    {
      exports,
      require: (n) => mocks[n] ?? ui,
      Blob,
      Uint8Array,
      URL: Url,
      AbortController,
      Error,
      atob,
      queueMicrotask,
      window: {
        location: {
          href: 'https://app.test/chat/saved',
          origin: 'https://app.test'
        }
      },
      setTimeout(fn, ms) {
        assert.equal(ms, 30000);
        timer = fn;
        return 1;
      },
      clearTimeout() {},
      fetch: async (url, opts) => {
        requests.push({ url, opts });
        if (mode === 'stale')
          return new Promise((resolve) => {
            resolveFetch = resolve;
          });
        if (mode === 'timeout')
          return new Promise((_, reject) =>
            opts.signal.addEventListener('abort', () =>
              reject(new Error('private timeout'))
            )
          );
        if (mode === 'denied')
          return new Response('private response', { status: 404 });
        if (mode === 'type')
          return new Response('<html>', {
            headers: { 'content-type': 'text/html' }
          });
        if (mode === 'oversize')
          return new Response(new Uint8Array(LIMIT + 1), {
            headers: { 'content-type': 'application/pdf' }
          });
        return new Response('%PDF-1.4\nfixture', {
          headers: { 'content-type': 'application/pdf' }
        });
      }
    }
  );
  const render = () =>
    exports.default({ url: source, fileName: 'fixture.pdf' });
  assert.ok(nodes(render()).some((n) => n.props.role === 'status'));
  cleanup = effect();
  if (mode === 'timeout') timer();
  if (mode === 'stale') {
    cleanup();
    resolveFetch(
      new Response('%PDF-1.4\nfixture', {
        headers: { 'content-type': 'application/pdf' }
      })
    );
  }
  for (let i = 0; i < 8; i++)
    await new Promise((resolve) => setImmediate(resolve));
  return { nodes: nodes(render()), requests, created, revoked, cleanup };
}
async function main() {
  const source = '/api/chat/attachment?reference=attachment%3Afixture';
  let r = await scenario(source);
  assert.equal(r.requests.length, 1);
  assert.equal(r.requests[0].opts.credentials, 'same-origin');
  assert.equal(r.requests[0].opts.redirect, 'error');
  assert.equal(
    r.nodes.filter((n) => n.props.role === 'status').length,
    0,
    'PDF plugin load still required'
  );
  assert.ok(
    r.nodes.some(
      (n) =>
        n.type === 'object' &&
        n.props.data === 'blob:fixture-0' &&
        !n.props.onLoad
    )
  );
  assert.ok(r.nodes.some((n) => n.props['aria-label'] === 'Close PDF viewer'));
  r.cleanup();
  assert.deepEqual(r.revoked, r.created);
  for (const mode of ['denied', 'type', 'oversize', 'timeout']) {
    r = await scenario(source, mode);
    assert.ok(
      r.nodes.some((n) => n.props.role === 'alert'),
      mode
    );
    assert.ok(
      r.nodes.some(
        (n) =>
          n.type === 'a' &&
          n.props.href === source &&
          n.props.children === 'Open PDF'
      )
    );
    assert.equal(r.created.length, 0);
    r.cleanup();
  }
  r = await scenario(
    'data:application/pdf;base64,' +
      Buffer.from('%PDF-1.4\nlegacy').toString('base64')
  );
  assert.equal(r.requests.length, 0);
  assert.equal(r.created.length, 1);
  r.cleanup();
  assert.deepEqual(r.revoked, r.created);
  r = await scenario('https://storage.test/signed.pdf');
  assert.equal(r.requests.length, 0);
  assert.ok(
    r.nodes.some(
      (n) =>
        n.type === 'object' &&
        n.props.data === 'https://storage.test/signed.pdf'
    )
  );
  r.cleanup();
  r = await scenario(source, 'stale');
  assert.equal(r.created.length, 0, 'stale response leaked URL');
  console.log(
    'PASS actual PDF viewer effects: bounded authenticated preparation, no plugin-load overlay dependency, safe fallback, legacy conversion and stale/revoked blob cleanup'
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
