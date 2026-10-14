const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const root = path.resolve(__dirname, '../..');
let messages = [], states = [], stateIndex = 0, hydrationComplete = false;
let clock = '2035-04-05T12:45:00Z';
class TestDate extends Date {
  constructor(...args) { super(...(args.length ? args : [clock])); }
}
const hooks = {
  ...React,
  useState(initial) {
    const index = stateIndex++;
    if (!(index in states)) states[index] = initial;
    return [states[index], value => { states[index] = value; }];
  },
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot) {
    assert.equal(typeof subscribe(() => {}), 'function');
    return hydrationComplete ? getSnapshot() : getServerSnapshot();
  },
  useOptimistic: initial => [initial, () => {}]
};
const children = ({ children }) => React.createElement(React.Fragment, null, children);
const generic = new Proxy({ __esModule: true, default: () => null }, {
  get: (object, key) => key in object ? object[key] : () => null
});
const mocks = {
  react: { __esModule: true, default: hooks, ...hooks },
  'react/jsx-runtime': require('react/jsx-runtime'),
  '@ai-sdk/react': { useChat: () => ({ messages, status: 'ready', sendMessage() {}, stop() {} }) },
  ai: { DefaultChatTransport: class {} },
  'next/navigation': { useParams: () => ({ id: 'synthetic-chat' }), useRouter: () => ({ refresh() {}, push() {} }), notFound() {} },
  swr: { useSWRConfig: () => ({ mutate() {} }) },
  '@/components/ui/card': { Card: children, CardHeader: children, CardContent: children },
  '@/components/ui/button': { Button: children },
  '@/lib/server/server': {},
  'server-only': {},
  'next/cache': {}
};
function load(file) {
  const mod = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
  }).outputText, {
    module: mod, exports: mod.exports,
    require: name => mocks[name] || generic,
    Date: TestDate, console, setTimeout
  });
  return mod.exports;
}
const format = load('app/(dashboard)/chat/[id]/fetch.ts').formatMessages;
messages = format([
  { message_id: 'a', role: 'assistant', type: 'text', text_text: 'first', created_at: '2020-01-03T09:30:00Z' },
  { message_id: 'b', role: 'user', type: 'text', text_text: 'question', created_at: 'not a timestamp' },
  { message_id: 'a', role: 'assistant', type: 'text', text_text: 'second', created_at: '2020-01-03T09:35:00Z' }
]);
assert.equal(messages[0].metadata.createdAt, '2020-01-03T09:30:00Z');
assert.deepEqual(Array.from(messages[0].parts, part => part.text), ['first', 'second']);
messages.push({ id: 'live', role: 'user', parts: [{ type: 'text', text: 'no saved timestamp' }] });
const Chat = load('app/(dashboard)/chat/components/Chat.tsx').default;
function render() {
  stateIndex = 0;
  return renderToStaticMarkup(React.createElement(Chat, { currentChat: messages, chatId: 'synthetic-chat', initialSelectedOption: 'gemini-3-flash-preview' }));
}
process.env.TZ = 'UTC';
const server = render();
assert.ok(!server.includes('09:30') && !server.includes('12:45'));
process.env.TZ = 'Asia/Kuala_Lumpur';
assert.equal(render(), server, 'Server and initial client markup must match across time zones');
hydrationComplete = true;
const mounted = render();
assert.ok(mounted.includes('17:30'), 'Mounted display must use the saved timestamp in browser-local time');
assert.ok(!mounted.includes('Invalid Date') && !mounted.includes('20:45'));
clock = '2040-08-09T02:01:00Z';
assert.equal(render(), mounted, 'A later render must not replace saved send times with the current clock');
process.env.TZ = 'UTC';
assert.ok(render().includes('09:30'));
console.log('PASS actual history mapper and chat rendering: first saved send time, stable initial hydration across zones, local display after mount, invalid/missing times omitted, no current-clock fallback');
