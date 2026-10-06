const assert = require('node:assert/strict');
const runtimeRequire = require('node:module').createRequire(
  require('node:path').resolve(__dirname, '../../package.json')
);
const { streamText } = runtimeRequire('ai');
const model = {
  specificationVersion: 'v3',
  provider: 'local-test',
  modelId: 'fixture',
  supportedUrls: {},
  async doStream() {
    const events = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'text-0' },
      { type: 'text-delta', id: 'text-0', delta: 'fixture response' },
      { type: 'text-end', id: 'text-0' },
      {
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 }
        }
      }
    ];
    return {
      stream: new ReadableStream({
        start(controller) {
          for (const e of events) controller.enqueue(e);
          controller.close();
        }
      })
    };
  }
};
async function run() {
  let seen = false;
  const result = streamText({
    model,
    prompt: 'local fixture',
    maxRetries: 0,
    onStepFinish: async () => {
      seen = true;
      throw Error('Unable to save chat history. Please try again.');
    }
  });
  result.consumeStream();
  const response = result.toUIMessageStreamResponse({
    onError: (e) => e.message
  });
  let timer;
  try {
    await assert.rejects(
      Promise.race([
        response.text(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('TEST_TIMEOUT')), 3000);
        })
      ]),
      /Unable to save chat history/
    );
    assert.equal(seen, true);
    console.log(
      'PASS installed AI SDK6 stream fails observably when persistence callback rejects; fake local model only'
    );
  } finally {
    clearTimeout(timer);
  }
}
run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
