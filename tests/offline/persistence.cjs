const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const runtimeRequire = require('node:module').createRequire(
  require('node:path').resolve(__dirname, '../../package.json')
);
const uuid = runtimeRequire('uuid');
const base =
  require('node:path').resolve(__dirname, '../..') + require('node:path').sep;
let parts = new Map(),
  payloads = [],
  routeSaves = [],
  streamed = [],
  failSave = false;
const db = {
  from: (table) => ({
    upsert: async (payload, opts) => {
      if (failSave) return { error: new Error('private database detail') };
      if (table === 'message_parts') {
        assert.equal(opts.onConflict, 'id');
        payloads.push(structuredClone(payload));
        for (const p of payload) {
          assert.equal('created_at' in p, false);
          parts.set(p.id, {
            ...parts.get(p.id),
            ...p,
            created_at: parts.get(p.id)?.created_at || 'original timestamp'
          });
        }
      }
      return { error: null };
    }
  })
};
const mocks = {
  'server-only': {},
  uuid: uuid,
  '@/lib/server/server': { createServerSupabaseClient: async () => db },
  '@/lib/server/supabase': { getSession: async () => ({ sub: 'owner' }) },
  'next/navigation': {
    notFound: () => {
      throw Error('not found');
    }
  },
  'next/cache': { unstable_cache: (x) => x },
  'next/server': {
    NextResponse: class extends Response {
      static json(x, init) {
        return new Response(JSON.stringify(x), {
          ...init,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
  },
  react: { cache: (x) => x },
  '@ai-sdk/openai': { openai: (id) => ({ id }) },
  '@ai-sdk/anthropic': { anthropic: (id) => ({ id }) },
  '@ai-sdk/google': { google: (id) => ({ id }) },
  './tools/documentChat': { searchUserDocument: () => ({}) },
  './tools/WebsiteSearchTool': { websiteSearchTool: {} },
  './SaveToDbIncremental': {
    saveMessagesToDB: async (x) => {
      if (failSave) throw Error('private database detail');
      routeSaves.push(structuredClone(x));
    }
  },
  ai: {
    convertToModelMessages: async (x) => x,
    stepCountIs: (x) => x,
    streamText: (opts) => {
      assert.equal(routeSaves.length, 1, 'user save must precede SDK');
      streamed.push(opts);
      return {
        consumeStream() {},
        toUIMessageStreamResponse: (opts) => {
          streamed[0].uiOptions = opts;
          return new Response('mock stream');
        }
      };
    }
  }
};
function load(file) {
  const mod = { exports: {} };
  const req = (name) => {
    if (name === '@/lib/model-config') return load('lib/model-config.ts');
    if (name === '@/lib/server/provider-availability')
      return load('lib/server/provider-availability.ts');
    if (name in mocks) return mocks[name];
    throw Error('Unexpected import: ' + name);
  };
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
      require: req,
      process,
      console: { log() {}, warn() {}, error() {} },
      Response,
      crypto,
      AbortSignal
    }
  );
  return mod.exports;
}
async function run() {
  const save = load('app/api/chat/SaveToDbIncremental.ts').saveMessagesToDB;
  const call = {
    chatSessionId: 'chat-one',
    userId: 'owner',
    isFirstStep: true,
    messages: [
      {
        id: 'client-user-id',
        role: 'user',
        parts: [{ type: 'text', text: 'Q' }]
      }
    ]
  };
  await save(call);
  await save(call);
  assert.equal(parts.size, 1);
  const userRow = [...parts.values()][0];
  const assistantId = crypto.randomUUID();
  const assistant = {
    id: assistantId,
    role: 'assistant',
    parts: [
      { type: 'text', text: 'step one' },
      { type: 'source-url', url: 'https://example.test', sourceId: '' }
    ]
  };
  const assistantCall = {
    ...call,
    isFirstStep: false,
    assistantMessageId: assistantId,
    messages: [assistant]
  };
  await save(assistantCall);
  await save(assistantCall);
  assert.equal(parts.size, 3);
  const firstIds = payloads.at(-1).map((p) => p.id);
  assistant.parts.push({ type: 'text', text: 'step two' });
  await save(assistantCall);
  await save(assistantCall);
  assert.equal(parts.size, 4);
  assert.deepEqual(
    payloads
      .at(-1)
      .slice(0, 2)
      .map((p) => p.id),
    firstIds
  );
  assert.deepEqual(
    payloads.at(-1).map((p) => p.order),
    [0, 1, 2]
  );
  assert.equal(
    [...parts.values()].find((p) => p.type === 'source-url').source_url_id,
    firstIds[1]
  );
  assert.equal(parts.get(userRow.id).created_at, 'original timestamp');
  await save({ ...call, chatSessionId: 'chat-two' });
  assert.equal(parts.size, 5);
  await assert.rejects(
    save({
      ...call,
      messages: [
        { id: '', role: 'user', parts: [{ type: 'text', text: 'invalid' }] }
      ]
    })
  );
  failSave = true;
  await assert.rejects(save(call));
  failSave = false;
  console.log(
    'PASS saver retry IDs, cumulative parts, chat separation, timestamps, missing IDs and DB failures'
  );

  const format = load('app/(dashboard)/chat/[id]/fetch.ts').formatMessages;
  const rows = [
    {
      message_id: 'a',
      role: 'assistant',
      type: 'text',
      text_text: 'one',
      text_state: 'done'
    },
    {
      message_id: 'b',
      role: 'user',
      type: 'text',
      text_text: 'question',
      text_state: 'done'
    },
    {
      message_id: 'a',
      role: 'assistant',
      type: 'text',
      text_text: 'two',
      text_state: 'done'
    }
  ];
  const formatted = format(rows);
  assert.equal(formatted.length, 2);
  assert.equal(formatted[0].id, 'a');
  assert.deepEqual(
    Array.from(formatted[0].parts, (p) => p.text),
    ['one', 'two']
  );
  console.log(
    'PASS interleaved history preserves first-seen message and input part order'
  );

  process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test-only';
  process.env.GOOGLE_FREE_TIER_ONLY = 'true';
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.EXA_API_KEY;
  const request = {
    json: async () => ({ chatId: 'chat-one', messages: call.messages }),
    signal: new AbortController().signal
  };
  const post = load('app/api/chat/route.ts').POST;
  assert.equal((await post(request)).status, 200);
  await streamed[0].onStepFinish({
    content: [{ type: 'text', text: 'first' }]
  });
  await streamed[0].onStepFinish({
    content: [{ type: 'text', text: 'second' }]
  });
  assert.equal(routeSaves.length, 3);
  assert.deepEqual(
    Array.from(routeSaves[2].messages[0].parts, (p) => p.text),
    ['first', 'second']
  );
  assert.equal(
    routeSaves[2].assistantMessageId,
    streamed[0].uiOptions.generateMessageId()
  );
  failSave = true;
  await assert.rejects(
    streamed[0].onStepFinish({ content: [{ type: 'text', text: 'failure' }] }),
    /Unable to save chat history/
  );
  streamed = [];
  routeSaves = [];
  const failed = await post(request);
  assert.equal(failed.status, 500);
  assert.equal(streamed.length, 0);
  assert.equal(
    (await failed.text()).includes('private database detail'),
    false
  );
  console.log(
    'PASS route user-before-generation, cumulative steps, stream ID alignment and observable sanitized save failures; zero live calls'
  );
}
run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
