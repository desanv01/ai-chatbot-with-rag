const fs = require('node:fs'),
  vm = require('node:vm'),
  assert = require('node:assert/strict');
const ts = require('typescript');
const base =
  require('node:path').resolve(__dirname, '../..') + require('node:path').sep;
let slots = [],
  refs = [],
  si = 0,
  ri = 0,
  drop,
  poll,
  requests = [],
  scenario = 'success';
const jsx = (type, props) => ({ type, props });
const generic = new Proxy(
  { __esModule: true, default: () => null },
  { get: (obj, k) => (k in obj ? obj[k] : () => null) }
);
const mocks = {
  'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
  react: {
    useState: (init) => {
      const i = si++;
      if (!(i in slots)) slots[i] = init;
      return [
        slots[i],
        (v) => {
          slots[i] = typeof v === 'function' ? v(slots[i]) : v;
        }
      ];
    },
    useRef: (init) => {
      const i = ri++;
      if (!(i in refs)) refs[i] = { current: init };
      return refs[i];
    },
    useCallback: (f) => f
  },
  'next/navigation': { useRouter: () => ({ refresh() {}, push() {} }) },
  'react-dropzone': {
    useDropzone: (opts) => {
      drop = opts;
      return {
        getRootProps: () => ({}),
        getInputProps: () => ({}),
        isDragActive: false
      };
    }
  },
  swr: {
    __esModule: true,
    default: (key, fetcher, options) => {
      poll = { key, fetcher, options };
    },
    mutate: () => {}
  },
  '../action': { deleteUserFile: () => {} },
  '@/utils/base64': { encodeBase64: (x) => Buffer.from(x).toString('base64') },
  '@/lib/document-limits': { MAX_PDF_SIZE: 25 * 1024 * 1024 },
  'date-fns': { formatDistanceToNow: () => '' },
  'date-fns/locale': { enUS: {} }
};
const response = (x, status = 200) =>
  new Response(JSON.stringify(x), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
async function fetchMock(url, opts) {
  requests.push({ url, body: opts?.body });
  if (url === '/api/upload/presigned-url')
    return response({
      uploadUrl: 'https://upload.test/staged',
      filePath: 'owner/staged.pdf',
      totalSize: 0,
      maxSize: 150 * 1024 * 1024
    });
  if (url === 'https://upload.test/staged')
    return new Response(null, { status: 200 });
  if (url === '/api/uploaddoc')
    return scenario === 'upload-error'
      ? response({ error: 'fixture' }, 500)
      : response({ results: [{ jobId: 'job', jobToken: 'token' }] });
  if (url === '/api/upload/cleanup') return response({ status: 'ok' });
  if (url === '/api/checkdoc')
    return response({ status: scenario === 'pending' ? 'PENDING' : 'SUCCESS' });
  if (url === '/api/processdoc') return response({ status: 'SUCCESS' });
  throw Error('Unexpected fetch ' + url);
}
const mod = { exports: {} };
vm.runInNewContext(
  ts.transpileModule(
    fs.readFileSync(
      base + 'app/(dashboard)/filer/components/FileManager.tsx',
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
    module: mod,
    exports: mod.exports,
    require: (n) => (n in mocks ? mocks[n] : generic),
    console: { error() {} },
    fetch: fetchMock,
    URLSearchParams,
    File,
    setTimeout: () => 0,
    Error
  }
);
function render() {
  si = ri = 0;
  return mod.exports.FileManager({
    documents: [],
    selectedDocFileName: null,
    currentPage: 1
  });
}
function find(node, test) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const child of node) {
      const result = find(child, test);
      if (result) return result;
    }
    return;
  }
  if (typeof node === 'object') {
    if (test(node)) return node;
    return find(node.props?.children, test);
  }
}
function reset(mode) {
  slots = [];
  refs = [];
  requests = [];
  scenario = mode;
  render();
}
async function start() {
  drop.onDrop(
    [new File(['%PDF-fixture'], 'fixture.pdf', { type: 'application/pdf' })],
    []
  );
  const tree = render();
  const form = find(tree, (n) => n.type === 'form');
  assert.ok(form);
  const ev = { preventDefault() {} };
  await Promise.all([form.props.onSubmit(ev), form.props.onSubmit(ev)]);
  render();
}
async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
}
async function run() {
  reset('success');
  await start();
  assert.equal(
    requests.filter((x) => x.url === '/api/upload/presigned-url').length,
    1,
    'double submit must sign once'
  );
  assert.equal(poll.options.revalidateOnFocus, false);
  assert.equal(poll.options.revalidateOnReconnect, false);
  assert.equal(poll.options.shouldRetryOnError, false);
  const ready = await poll.fetcher(poll.key);
  poll.options.onSuccess(ready);
  poll.options.onSuccess(ready);
  render();
  poll.options.onSuccess(ready);
  await tick();
  assert.equal(
    requests.filter((x) => x.url === '/api/processdoc').length,
    1,
    'duplicate poll callbacks and rerenders must process once'
  );
  console.log(
    'PASS actual FileManager callbacks: double submit and repeated success/rerender trigger one upload and processing mutation'
  );
  reset('upload-error');
  await start();
  const cleanup = requests.filter((x) => x.url === '/api/upload/cleanup');
  assert.equal(cleanup.length, 1);
  assert.equal(JSON.parse(cleanup[0].body).filePath, 'owner/staged.pdf');
  const errorNode = find(render(), (n) => n.props?.role === 'status');
  assert.ok(errorNode);
  assert.equal(errorNode.props.children, 'Error processing file');
  assert.equal(drop.disabled, false);
  console.log(
    'PASS failed initial upload cleans only newly staged path and retains visible error'
  );
  reset('pending');
  await start();
  for (let i = 0; i < 120; i++) {
    const result = await poll.fetcher(poll.key);
    poll.options.onSuccess(result);
  }
  const tree = render();
  assert.equal(poll.key, null);
  const timeout = find(tree, (n) => n.props?.role === 'status');
  assert.match(timeout.props.children, /120 status checks/);
  assert.equal(requests.filter((x) => x.url === '/api/checkdoc').length, 120);
  console.log(
    'PASS polling stops at120 checks, retains timeout and permits new selection; hooks/network are local fixtures'
  );
}
run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
