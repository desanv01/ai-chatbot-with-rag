const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
let filename;
const references = [];
const element = (type, props) => ({ type, props });
const mocks = {
  'server-only': {},
  'react/jsx-runtime': { jsx: element, jsxs: element },
  'next/headers': { cookies: async () => ({ get: () => undefined }) },
  uuid: { v4: () => 'synthetic-chat' },
  '@/lib/server/admin': { createAdminClient: () => { throw Error('Must not sign unowned fixture'); } },
  '@/lib/server/documents': { getUserDocumentByReference: async (reference) => { references.push(reference); return null; } },
  '@/lib/document-path': { isUserStoragePath: () => false, USER_FILES_BUCKET: 'fixture' },
  '@/utils/base64': { encodeBase64: (value) => Buffer.from(value).toString('base64') },
  '@/lib/model-config': { sanitizeChatModel: () => 'fixture' },
  './fetch': { fetchChat: async () => ({ message_parts: [] }), formatMessages: () => [{ parts: [{ type: 'file', filename, url: 'https://example.invalid/owned-attachment' }] }] }
};
function load(relative) {
  const source = fs.readFileSync(path.resolve(__dirname, '../..', relative), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const fixtureModule = { exports: {} };
  vm.runInNewContext(code, { module: fixtureModule, exports: fixtureModule.exports, require: (name) => {
    if (mocks[name]) return mocks[name];
    if (/components\//.test(name)) return { default: name };
    throw Error(`Unexpected module ${name}`);
  }, console });
  return fixtureModule.exports.default;
}
async function main() {
  const fresh = load('app/(dashboard)/chat/page.tsx');
  const saved = load('app/(dashboard)/chat/[id]/page.tsx');
  for (const value of ['unusual 100% café.pdf', 'literal%2Fname.pdf', 'percent%zz.pdf', '雪 + #.pdf']) {
    filename = value;
    for (const page of [fresh, saved]) {
      // Model the framework's single query decoding, rather than passing encoded strings.
      const decoded = new URL('https://example.invalid/?pdf=' + encodeURIComponent(value)).searchParams.get('pdf');
      const tree = await page({ params: Promise.resolve({ id: 'owned-chat' }), searchParams: Promise.resolve({ pdf: decoded }) });
      const component = tree.props.children[1];
      assert.equal(component.props.fileReference, value);
      const viewer = await component.type(component.props);
      assert.equal(references.at(-1), value);
      assert.equal(viewer.props.fileName, Buffer.from(value).toString('base64'));
      assert.equal(viewer.props.signedUrl, null, 'No unowned source should be signed');
    }
    const tree = await saved({ params: Promise.resolve({ id: 'owned-chat' }), searchParams: Promise.resolve({ file: value }) });
    assert.equal(tree.props.children[1].props.fileName, value);
    assert.equal(tree.props.children[1].props.url, 'https://example.invalid/owned-attachment');
  }
  const url = 'https://example.invalid/a%2Fb?query=100%25';
  for (const page of [fresh, saved]) {
    const decoded = new URL('https://example.invalid/?url=' + encodeURIComponent(url)).searchParams.get('url');
    const tree = await page({ params: Promise.resolve({ id: 'owned-chat' }), searchParams: Promise.resolve({ url: decoded }) });
    assert.equal(tree.props.children[1].props.url, url);
  }
  console.log('PASS fresh/saved citation routes: literal percent, encoded-looking names, Unicode, attachments and nested URL escapes');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
