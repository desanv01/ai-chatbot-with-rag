// Test-process-only transport: provider SDK calls are redirected to localhost.
// Unexpected outbound requests fail, including accidental real Supabase access.
const nativeFetch = globalThis.fetch;
const hosts = new Set([
  'api.cloud.llamaindex.ai',
  'generativelanguage.googleapis.com',
  'api.voyageai.com'
]);
globalThis.fetch = async (input, init) => {
  const url = new URL(
    typeof input === 'string' || input instanceof URL ? input : input.url
  );
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
    return nativeFetch(input, init);
  if (!hosts.has(url.hostname))
    throw new Error('Unexpected outbound request in document Workflow fixture');
  const request = new Request(input, init);
  return nativeFetch(
    new Request(
      process.env.V1_DOCUMENT_FIXTURE_URL +
        '/provider?url=' +
        encodeURIComponent(url.href),
      request
    )
  );
};
