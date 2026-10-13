const fs = require('node:fs'),
  vm = require('node:vm'),
  assert = require('node:assert/strict');
const ts = require('typescript');
const base =
  require('node:path').resolve(__dirname, '../..') + require('node:path').sep;
let streamed = [];
const enriched = [];
const deadlines = [];
const enrichmentAbort = {
  timeout(ms) {
    deadlines.push(ms);
    return new AbortController().signal;
  },
  any(signals) {
    return AbortSignal.any(signals);
  }
};
const mocks = {
  'next/server': {
    NextResponse: class extends Response {
      static json(data, init) {
        return new Response(JSON.stringify(data), {
          ...init,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
  },
  ai: {
    Output: { object: (value) => value },
    generateText: async (opts) => {
      opts.abortSignal.throwIfAborted();
      enriched.push(opts);
      const output =
        'descriptiveTitle' in opts.output.schema.shape
          ? {
              descriptiveTitle: 'Orchid',
              shortDescription: 'Synthetic project',
              mainTopics: ['project'],
              keyEntities: ['ORCHID'],
              primaryLanguage: 'English'
            }
          : {
              preliminary_answer_1: 'ORCHID',
              preliminary_answer_2: 'Mira Vale',
              tags: ['project'],
              hypothetical_question_1: 'What is the code?',
              hypothetical_question_2: 'Who is the lead?'
            };
      return {
        output: opts.output.schema.parse(output),
        usage: { outputTokens: 20 },
        finishReason: 'stop'
      };
    },
    streamText: (opts) => {
      streamed.push(opts);
      return {
        consumeStream() {},
        toUIMessageStream() {
          return 'mock stream';
        }
      };
    },
    convertToModelMessages: async (m) => m,
    stepCountIs: (n) => n,
    createUIMessageStream: (opts) => {
      opts.execute({ writer: { merge() {} } });
      return 'wrapped stream';
    },
    createUIMessageStreamResponse: () => new Response('mock stream')
  },
  '@ai-sdk/openai': { openai: (id) => ({ provider: 'openai', id }) },
  '@ai-sdk/anthropic': { anthropic: (id) => ({ provider: 'anthropic', id }) },
  '@ai-sdk/google': { google: (id) => ({ provider: 'google', id }) },
  '@/lib/server/supabase': { getSession: async () => ({ sub: 'user' }) },
  './SaveToDbIncremental': { saveMessagesToDB: async () => {} },
  './tools/documentChat': { searchUserDocument: () => ({}) },
  './tools/WebsiteSearchTool': { websiteSearchTool: {} },
  'server-only': {},
  zod: require('zod')
};
function load(file) {
  const out = { exports: {} };
  const context = {
    exports: out.exports,
    module: out,
    require: (name) => {
      if (name === '@/lib/model-config') return load('lib/model-config.ts');
      if (name === '@/lib/server/provider-availability')
        return load('lib/server/provider-availability.ts');
      if (name in mocks) return mocks[name];
      throw Error(name);
    },
    process,
    console,
    Response,
    crypto,
    AbortSignal:
      file === 'app/api/processdoc/agentchains.ts'
        ? enrichmentAbort
        : AbortSignal
  };
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(base + file, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022
      }
    }).outputText,
    context
  );
  return out.exports;
}
const keys = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'EXA_API_KEY',
  'GOOGLE_FREE_TIER_ONLY'
];
function env(values) {
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, values);
  streamed = [];
}
async function request(option) {
  return load('app/api/chat/route.ts').POST({
    json: async () => ({
      chatId: 'chat',
      messages: [],
      ...(option === undefined ? {} : { option })
    }),
    signal: new AbortController().signal
  });
}
(async () => {
  env({});
  assert.equal(
    load('lib/server/provider-availability.ts').getProviderAvailability()
      .defaultModel,
    null
  );
  assert.equal((await request()).status, 503);
  const chains = load('app/api/processdoc/agentchains.ts');
  const controller = new AbortController();
  const metadata = await chains.generateDocumentMetadata(
    'Synthetic ORCHID content',
    controller.signal
  );
  assert.equal(metadata.output.descriptiveTitle, 'Orchid');
  const analysis = await chains.preliminaryAnswerChainAgent(
    'Synthetic ORCHID content',
    controller.signal
  );
  assert.equal(analysis.output.preliminary_answer_1, 'ORCHID');
  assert.equal(enriched.length, 2);
  for (const opts of enriched) {
    assert.equal(opts.model.provider, 'google');
    assert.equal(opts.model.id, 'gemini-3-flash-preview');
    assert.equal(opts.maxRetries, 0);
    assert.ok(opts.maxOutputTokens > 0 && opts.maxOutputTokens <= 1024);
    assert.equal(
      opts.providerOptions.google.thinkingConfig.thinkingLevel,
      'minimal'
    );
    assert.equal(opts.abortSignal.aborted, false);
  }
  assert.ok(deadlines.every((ms) => ms >= 30000 && ms <= 60000));
  controller.abort();
  for (const opts of enriched) assert.equal(opts.abortSignal.aborted, true);
  await assert.rejects(
    chains.generateDocumentMetadata('Synthetic content', controller.signal)
  );
  await assert.rejects(
    chains.preliminaryAnswerChainAgent('Synthetic content', controller.signal)
  );
  assert.equal(enriched.length, 2);
  console.log(
    'PASS bounded Google structured enrichment and caller cancellation; mocked provider only'
  );
  assert.equal(streamed.length, 0);
  env({ GOOGLE_GENERATIVE_AI_API_KEY: 'test-only' });
  assert.equal((await request()).status, 200);
  assert.equal(streamed[0].model.provider, 'google');
  assert.equal('websiteSearchTool' in streamed[0].tools, false);
  assert.equal((await request('gpt-5')).status, 400);
  env({ OPENAI_API_KEY: 'test-only' });
  assert.equal((await request('arbitrary-model')).status, 400);
  assert.equal(streamed.length, 0);
  env({
    GOOGLE_GENERATIVE_AI_API_KEY: 'test-only',
    EXA_API_KEY: 'test-only',
    GOOGLE_FREE_TIER_ONLY: 'true'
  });
  assert.equal((await request('gemini-3-pro')).status, 200);
  assert.equal(streamed[0].model.id, 'gemini-3-flash-preview');
  assert.equal('websiteSearchTool' in streamed[0].tools, true);
  env({ EXA_API_KEY: 'test-only', OPENAI_API_KEY: 'test-only' });
  assert.equal(
    load('lib/server/provider-availability.ts').getProviderAvailability()
      .webSearch,
    false
  );
  env({ GOOGLE_GENERATIVE_AI_API_KEY: '   ' });
  assert.equal((await request()).status, 503);
  console.log(
    'PASS provider guards: no/whitespace keys, Google-only default, disabled/invalid model rejection, aliases/free-only downgrade, Exa+Google gating; zero live API calls'
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
