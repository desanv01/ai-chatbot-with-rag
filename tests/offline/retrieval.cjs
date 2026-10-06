const fs = require('node:fs'),
  vm = require('node:vm'),
  assert = require('node:assert/strict');
const ts = require('typescript'),
  z = require('zod');
const source = fs.readFileSync(
  require('node:path').resolve(
    __dirname,
    '../../app/api/chat/tools/documentChat.ts'
  ),
  'utf8'
);
const js = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
async function scenario(mode) {
  let inputs = [],
    rpcArgs = [],
    lookups = 0;
  const row = (id, similarity, text) => ({
    id,
    similarity,
    text_content: text,
    title: '100% & Buku 日本.pdf',
    page_number: 2,
    total_pages: 3
  });
  const client = {
    from() {
      const q = {
        select() {
          return this;
        },
        eq(k, value) {
          if (k === 'user_id') assert.equal(value, 'userA');
          else {
            assert.equal(k, 'processing_status');
            assert.equal(value, 'ready');
          }
          return this;
        },
        abortSignal(signal) {
          assert.ok(signal);
          lookups++;
          return Promise.resolve({
            data: mode === 'empty' ? [] : [{ id: 'docA' }],
            error: mode === 'lookup-error' || signal.aborted ? {} : null
          });
        }
      };
      return q;
    },
    rpc: (name, args) => {
      assert.equal(name, 'match_documents');
      rpcArgs.push(args);
      return {
        abortSignal(signal) {
          assert.ok(signal);
          return Promise.resolve({
            error: mode === 'rpc-error' ? {} : null,
            data: [
              row('best', 0.9, 'A'.repeat(30000)),
              row('next', 0.8, 'B'.repeat(30000)),
              row('best', 0.7, 'duplicate')
            ]
          });
        }
      };
    }
  };
  const exp = {};
  const mocks = {
    ai: {
      tool: (d) => d,
      zodSchema: (s) => s,
      embed: async ({ value, maxRetries, abortSignal }) => {
        assert.equal(maxRetries, 0);
        assert.ok(abortSignal);
        inputs.push(value);
        if (mode === 'embed-error') throw Error('provider internal');
        return {
          embedding:
            mode === 'bad-dimension'
              ? [1]
              : mode === 'sparse'
                ? new Array(1024)
                : Array(1024).fill(mode === 'nonfinite' ? NaN : 0)
        };
      }
    },
    zod: z,
    'voyage-ai-provider': { voyage: { textEmbeddingModel: () => ({}) } },
    '@/lib/server/server': { createServerSupabaseClient: async () => client }
  };
  vm.runInNewContext(js, {
    exports: exp,
    require: (k) => mocks[k],
    console: { error() {} },
    Number,
    Array,
    Set,
    JSON,
    encodeURIComponent,
    AbortSignal
  });
  const tool = exp.searchUserDocument({ userId: 'userA' });
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'question ' },
        { type: 'file', data: 'ignored' },
        { type: 'text', text: 'detail' }
      ]
    },
    { role: 'assistant', content: 'later assistant' }
  ];
  const call = () =>
    tool.execute(
      { query: mode === 'blank' ? '  ' : 'query' },
      {
        messages,
        abortSignal:
          mode === 'cancelled'
            ? AbortSignal.abort()
            : new AbortController().signal
      }
    );
  if (
    [
      'blank',
      'lookup-error',
      'embed-error',
      'bad-dimension',
      'nonfinite',
      'sparse',
      'rpc-error',
      'cancelled'
    ].includes(mode)
  ) {
    await assert.rejects(call);
    if (['blank', 'lookup-error', 'cancelled'].includes(mode))
      assert.equal(inputs.length, 0);
    if (['bad-dimension', 'nonfinite', 'sparse'].includes(mode))
      assert.equal(rpcArgs.length, 0);
  } else {
    const result = await call();
    if (mode === 'empty') {
      assert.equal(result.context.length, 0);
      assert.equal(inputs.length, 0);
    } else {
      assert.deepEqual(inputs, [
        'query',
        'question \n detail'.replace('\n ', '\n')
      ]);
      assert.equal(
        result.context.reduce((n, c) => n + c.content.length, 0),
        40000
      );
      assert.equal(result.context.length, 2);
      assert.equal(result.context[0].content[0], 'A');
      assert.equal(
        new URLSearchParams(result.context[0].pdfLink.slice(2, -1)).get('pdf'),
        '100% & Buku 日本.pdf'
      );
      for (const a of rpcArgs) {
        assert.equal(a.filter_user_id, 'userA');
        assert.deepEqual(Array.from(a.file_ids), ['docA']);
      }
    }
  }
  assert.equal(lookups, mode === 'blank' ? 0 : 1);
  console.log('PASS retrieval ' + mode);
}
(async () => {
  for (const mode of [
    'success',
    'empty',
    'blank',
    'lookup-error',
    'embed-error',
    'bad-dimension',
    'nonfinite',
    'sparse',
    'rpc-error',
    'cancelled'
  ])
    await scenario(mode);
  for (const title of ['100%.pdf', '%20literal.pdf', '日本 & a#b.pdf']) {
    assert.equal(
      Buffer.from(Buffer.from(title).toString('base64'), 'base64').toString(),
      title
    );
  }
  console.log('PASS filename base64 roundtrip (literal percent/Unicode)');
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
