const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const taskCrypto = require('node:crypto');
const ts = require('typescript');
const sdk = require('ai');
const { Chat } = require('@ai-sdk/react');
const saveError = 'Unable to save chat history. Please try again.';
const model = {
  specificationVersion: 'v3', provider: 'local-test', modelId: 'fixture', supportedUrls: {},
  async doStream() {
    const events = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'text' },
      { type: 'text-delta', id: 'text', delta: 'Synthetic streamed response.' },
      { type: 'text-end', id: 'text' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } }
    ];
    return { stream: new ReadableStream({ start(controller) { events.forEach(event => controller.enqueue(event)); controller.close(); } }) };
  }
};
async function makeResponse(failSave) {
  const attempts = [], saved = [];
  const selected = 'gemini-3-flash-preview';
  const mocks = {
    ai: sdk,
    'next/server': { NextResponse: class extends Response { static json(body, init) { return new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json' } }); } } },
    '@ai-sdk/google': { google: () => model },
    '@ai-sdk/openai': { openai: () => { throw Error('Unexpected provider'); } },
    '@ai-sdk/anthropic': { anthropic: () => { throw Error('Unexpected provider'); } },
    '@/lib/server/supabase': { getSession: async () => ({ sub: 'controlled-fixture' }) },
    '@/lib/server/provider-availability': { getProviderAvailability: () => ({ defaultModel: selected, models: [{ value: selected }], providers: { google: true, openai: false, anthropic: false }, googleFreeOnly: true, webSearch: false }) },
    '@/lib/model-config': { isChatModelValue: value => value === selected, isGoogleChatModel: value => value === selected, isGoogleFreeChatModel: value => value === selected, normalizeGoogleModelId: value => value, sanitizeChatModel: () => selected },
    './tools/documentChat': { searchUserDocument: () => sdk.tool({ inputSchema: sdk.jsonSchema({ type: 'object', properties: {} }), execute: async () => ({ context: [] }) }) },
    './tools/WebsiteSearchTool': { websiteSearchTool: {} },
    './SaveToDbIncremental': { saveMessagesToDB: async value => { attempts.push(structuredClone(value)); if (failSave && !value.isFirstStep) throw Error('Private database detail must not reach client'); saved.push(structuredClone(value)); } }
  };
  const fixtureModule = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../app/api/chat/route.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module: fixtureModule, exports: fixtureModule.exports,
    require: name => { if (name in mocks) return mocks[name]; throw Error('Unexpected import: ' + name); },
    Response, crypto: taskCrypto, Error, process: { env: { GOOGLE_FREE_TIER_ONLY: 'true' } }, console: { log() {}, warn() {}, error() {} }
  });
  const response = await fixtureModule.exports.POST({ signal: new AbortController().signal, json: async () => ({ chatId: 'synthetic-chat', option: selected, messages: [{ id: 'synthetic-user', role: 'user', parts: [{ type: 'text', text: 'Synthetic local request' }] }] }) });
  return { response, attempts, saved };
}
async function main() {
  for (const failure of [true, false]) {
    const { response, attempts, saved } = await makeResponse(failure);
    const raw = response.clone(); let clientError, finish;
    const chat = new Chat({ transport: new sdk.DefaultChatTransport({ api: 'https://example.invalid/local-fixture', fetch: async url => { assert.equal(url, 'https://example.invalid/local-fixture'); return response; } }), onError: error => { clientError = error.message; }, onFinish: flags => { finish = flags; } });
    await chat.sendMessage({ text: 'Synthetic local request' });
    const text = await raw.text();
    assert.equal(text.includes('Private database detail'), false);
    assert.equal(attempts.length, 2); assert.equal(saved.length, failure ? 1 : 2);
    const events = text.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6)));
    assert.equal(events.find(event => event.type === 'start').messageId, attempts[1].assistantMessageId);
    if (failure) {
      assert.equal(clientError, saveError); assert.equal(chat.status, 'error'); assert.equal(finish.isError, true);
      assert.deepEqual(events.filter(event => event.type === 'error').map(event => event.errorText), [saveError]);
      assert.equal(events.some(event => event.type === 'finish'), false, 'Failed persistence signalled successful completion');
    } else {
      assert.equal(clientError, undefined); assert.equal(chat.status, 'ready'); assert.equal(finish.isError, false);
      assert.equal(finish.message.id, saved[1].assistantMessageId); assert.equal(events.filter(event => event.type === 'finish').length, 1);
    }
  }
  console.log('PASS actual route with installed SDK: mid-stream save failure delivers one sanitized client error without false finish; successful persistence and assistant identity preserved; fake local provider/database only');
}
module.exports = { makeResponse };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
