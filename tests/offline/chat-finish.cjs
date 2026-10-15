const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { Chat } = require('@ai-sdk/react');
const { DefaultChatTransport, createUIMessageStreamResponse } = require('ai');
let options, currentId;
const effects = [];
const generic = new Proxy({ __esModule: true, default: 'fixture' }, { get: (target, key) => target[key] || (() => null) });
const mocks = {
  'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
  react: { useState: value => [value, () => {}], useOptimistic: value => [value, () => {}], useSyncExternalStore: (_subscribe, _getSnapshot, getServerSnapshot) => getServerSnapshot(), startTransition: () => {} },
  '@ai-sdk/react': { useChat: value => { options = value; return { messages: [], status: 'ready' }; } },
  ai: { DefaultChatTransport },
  'next/navigation': { useParams: () => ({ id: currentId }), useRouter: () => ({ push: url => effects.push(['push', url]), refresh: () => effects.push(['refresh']) }) },
  swr: { useSWRConfig: () => ({ mutate: async () => effects.push(['mutate']) }) },
  sonner: { toast: { error: message => effects.push(['toast', message]) } }
};
const fixtureModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../app/(dashboard)/chat/components/Chat.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
  module: fixtureModule, exports: fixtureModule.exports,
  require: name => mocks[name] || generic,
  window: { location: { search: '?pdf=100%25.pdf&p=3' } }, URLSearchParams, console
});
function render(id) {
  currentId = id; effects.length = 0;
  fixtureModule.exports.default({ chatId: 'owned-chat', initialSelectedOption: 'fixture' });
}
const errorText = 'Unable to save chat history. Please try again.';
function stream(events) {
  return createUIMessageStreamResponse({ stream: new ReadableStream({ start(controller) { events.forEach(event => controller.enqueue(event)); controller.close(); } }) });
}
async function exercise(fetch, existingId) {
  render(existingId);
  const chat = new Chat({ transport: new DefaultChatTransport({ api: '/api/chat', fetch }), onFinish: options.onFinish, onError: options.onError });
  await chat.sendMessage({ text: 'synthetic local fixture' });
  await new Promise(resolve => setImmediate(resolve));
  return chat;
}
async function main() {
  const jsonError = JSON.stringify({ message: errorText });
  await exercise(async () => new Response(jsonError, { status: 500, headers: { 'content-type': 'application/json' } }));
  assert.deepEqual(effects, [['toast', jsonError]], 'Actual API JSON error triggered success effects');
  for (const fetch of [async () => new Response(errorText, { status: 500 }), async () => stream([{ type: 'start', messageId: 'response' }, { type: 'error', errorText }])]) {
    for (const id of [undefined, 'owned-chat']) {
      const chat = await exercise(fetch, id);
      assert.equal(chat.status, 'error');
      assert.deepEqual(effects, [['toast', errorText]], 'Failed request triggered success navigation or refresh');
    }
  }
  const success = async () => stream([{ type: 'start', messageId: 'response' }, { type: 'text-start', id: 'text' }, { type: 'text-delta', id: 'text', delta: 'synthetic reply' }, { type: 'text-end', id: 'text' }, { type: 'finish', finishReason: 'stop' }]);
  await exercise(success);
  assert.deepEqual(effects, [['push', '/chat/owned-chat?pdf=100%25.pdf&p=3'], ['mutate'], ['refresh']]);
  await exercise(success, 'owned-chat');
  assert.deepEqual(effects, [['mutate'], ['refresh']]);
  render();
  await options.onFinish({ isError: false, isAbort: true });
  assert.deepEqual(effects, [['push', '/chat/owned-chat?pdf=100%25.pdf&p=3'], ['mutate'], ['refresh']], 'Existing client-abort finish behavior changed');
  console.log('PASS actual chat component with installed SDK: HTTP/stream errors keep notification without success navigation; success and existing abort behavior preserved');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
