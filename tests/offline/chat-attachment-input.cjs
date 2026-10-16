const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const assert = require('node:assert/strict'),
  ts = require('typescript');
const root = path.resolve(__dirname, '../..');
let states = [],
  refs = [],
  si = 0,
  ri = 0;
const toasts = [],
  readers = [],
  sent = [];
let releaseSend;
const element = (type, props) => ({ type, props: props || {} });
const react = {
  memo: (f) => f,
  useEffect() {},
  useMemo: (f) => f(),
  useState(initial) {
    const i = si++;
    if (!(i in states)) states[i] = initial;
    return [
      states[i],
      (value) => {
        states[i] = typeof value === 'function' ? value(states[i]) : value;
      }
    ];
  },
  useRef(initial) {
    const i = ri++;
    if (!(i in refs)) refs[i] = { current: initial };
    return refs[i];
  }
};
class FileReader {
  readAsDataURL(file) {
    this.file = file;
    readers.push(this);
  }
}
const exportsObject = {};
const ui = new Proxy(
  { __esModule: true, default: 'UI' },
  { get: (target, key) => (key in target ? target[key] : String(key)) }
);
const limits = {
  MAX_CHAT_ATTACHMENT_BYTES: 3 * 1024 * 1024,
  MAX_CHAT_ATTACHMENTS_PER_MESSAGE: 4,
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES: 3 * 1024 * 1024
};
vm.runInNewContext(
  ts.transpileModule(
    fs.readFileSync(
      path.join(root, 'app/(dashboard)/chat/components/ChatMessageInput.tsx'),
      'utf8'
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true
      }
    }
  ).outputText,
  {
    exports: exportsObject,
    console,
    FileReader,
    URL,
    require: (name) => {
      if (name === 'react')
        return { __esModule: true, default: react, ...react };
      if (name === 'react/jsx-runtime')
        return { jsx: element, jsxs: element, Fragment: 'fragment' };
      if (name === 'sonner')
        return { toast: { error: (message) => toasts.push(message) } };
      if (name === '@/lib/chat-attachment-limits') return limits;
      return ui;
    }
  }
);
const props = {
  chatId: 'fixture-chat',
  selectedOption: 'fixture-model',
  handleOptionChange() {},
  status: 'ready',
  stop() {},
  sendMessage(message) {
    sent.push(message);
    return new Promise((resolve) => {
      releaseSend = resolve;
    });
  }
};
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
function render() {
  si = ri = 0;
  return exportsObject.default(props);
}
function getInput(tree) {
  return nodes(tree).find(
    (node) => node.type === 'input' && node.props.type === 'file'
  );
}
function previews(tree) {
  return nodes(tree).filter((node) => node.props.file && node.props.onRemove);
}
function reset() {
  states = [];
  refs = [];
  render();
  states[3] = [
    {
      value: 'fixture-model',
      label: 'Fixture',
      provider: 'google',
      tier: 'configured'
    }
  ];
  states[4] = 'ready';
  return render();
}
const pdf = (name, size = 50, type = 'application/pdf') => ({
  name,
  size,
  type
});
async function main() {
  let tree = reset(),
    input = getInput(tree);
  await input.props.onChange({
    target: { files: [pdf('bad.txt', 50, 'text/plain')] }
  });
  await input.props.onChange({
    target: { files: [pdf('big.pdf', limits.MAX_CHAT_ATTACHMENT_BYTES + 1)] }
  });
  assert.equal(previews(render()).length, 0);
  for (let i = 0; i < 5; i++)
    await input.props.onChange({ target: { files: [pdf(`small-${i}.pdf`)] } });
  assert.equal(
    previews(render()).length,
    4,
    'rapid pre-render selection bypassed file-count bound'
  );
  assert.ok(toasts.some((message) => message.includes('at most 4')));
  tree = render();
  previews(tree)[0].props.onRemove();
  await input.props.onChange({ target: { files: [pdf('replacement.pdf')] } });
  assert.equal(
    previews(render()).length,
    4,
    'removal did not synchronize limit ref'
  );
  tree = reset();
  input = getInput(tree);
  await input.props.onChange({
    target: { files: [pdf('two.pdf', 2 * 1024 * 1024)] }
  });
  await input.props.onChange({
    target: { files: [pdf('another.pdf', 2 * 1024 * 1024)] }
  });
  assert.equal(previews(render()).length, 1);
  assert.ok(toasts.some((message) => message.includes('total 3 MiB')));
  tree = render();
  nodes(tree)
    .find((node) => node.type === 'Textarea')
    .props.onChange({ target: { value: 'keep this draft' } });
  tree = render();
  const pending = tree.props.onSubmit({ preventDefault() {} });
  await tree.props.onSubmit({ preventDefault() {} });
  assert.equal(readers.length, 1, 'duplicate submit started another file read');
  await getInput(tree).props.onChange({ target: { files: [pdf('late.pdf')] } });
  assert.equal(
    previews(render()).length,
    1,
    'pending conversion accepted an attachment that would be lost'
  );
  readers.pop().onerror(new Error('private read failure'));
  await pending;
  tree = render();
  assert.equal(
    nodes(tree).find((node) => node.type === 'Textarea').props.value,
    'keep this draft'
  );
  assert.equal(previews(tree).length, 1);
  assert.equal(sent.length, 0);
  assert.equal(
    toasts.filter((message) => message.startsWith('Unable to read')).length,
    1
  );
  const accepted = tree.props.onSubmit({ preventDefault() {} });
  const reader = readers.pop();
  reader.result = 'data:application/pdf;base64,JVBERi0=';
  reader.onload();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sent.length, 1);
  await tree.props.onSubmit({ preventDefault() {} });
  assert.equal(sent.length, 1, 'guard released before send settled');
  assert.equal(previews(render()).length, 0);
  releaseSend();
  await accepted;
  tree = render();
  await getInput(tree).props.onChange({ target: { files: [pdf('next.pdf')] } });
  assert.equal(
    previews(render()).length,
    1,
    'submission guard did not release'
  );
  let deletionMode = 'failure',
    mutations = 0,
    navigations = 0;
  const historyExports = {};
  vm.runInNewContext(
    ts.transpileModule(
      fs.readFileSync(
        path.join(
          root,
          'app/(dashboard)/chat/components/ChatHistorySheetContent.tsx'
        ),
        'utf8'
      ),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX,
          esModuleInterop: true
        }
      }
    ).outputText,
    {
      exports: historyExports,
      console: { ...console, error() {} },
      require: (name) => {
        if (name === 'react')
          return { __esModule: true, default: react, ...react };
        if (name === 'react/jsx-runtime')
          return { jsx: element, jsxs: element, Fragment: 'fragment' };
        if (name === 'sonner')
          return { toast: { error: (message) => toasts.push(message) } };
        if (name === 'next/navigation')
          return {
            useParams: () => ({ id: 'fixture-chat' }),
            useRouter: () => ({
              push() {
                navigations++;
              }
            })
          };
        if (name === 'swr/infinite')
          return {
            __esModule: true,
            default: () => ({
              data: [],
              isLoading: false,
              isValidating: false,
              size: 1,
              setSize() {},
              mutate() {
                mutations++;
              }
            })
          };
        if (name === '../actions')
          return {
            async deleteChatData() {
              if (deletionMode === 'throw') throw new Error('private failure');
              return {
                success: deletionMode === 'success',
                message: 'Unable to delete this chat. Please try again.'
              };
            }
          };
        return ui;
      }
    }
  );
  states = [true, 'fixture-chat'];
  const historyRender = () => {
    si = 0;
    return historyExports.default({ onClose() {} });
  };
  const confirmation = () =>
    nodes(historyRender()).find(
      (node) => node.type === 'Button' && node.props.variant === 'destructive'
    );
  await confirmation().props.onClick();
  assert.equal(states[0], true);
  assert.equal(states[1], 'fixture-chat');
  assert.equal(mutations, 0);
  assert.equal(navigations, 0);
  deletionMode = 'throw';
  await confirmation().props.onClick();
  assert.equal(states[0], true);
  assert.equal(mutations, 0);
  assert.equal(navigations, 0);
  assert.ok(!toasts.some((message) => message.includes('private failure')));
  deletionMode = 'success';
  await confirmation().props.onClick();
  assert.equal(mutations, 1);
  assert.equal(navigations, 1);
  assert.equal(states[0], false);
  assert.equal(states[1], null);
  console.log(
    'PASS actual chat-input callbacks: rapid count/total bounds, synchronized removal, single dispatch, conversion-failure draft retention and guard release; local hook/FileReader fixtures'
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
