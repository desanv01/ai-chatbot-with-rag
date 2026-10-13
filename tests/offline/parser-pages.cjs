const fs = require('node:fs'),
  vm = require('node:vm'),
  assert = require('node:assert/strict');
const ts = require('typescript');
const source = fs.readFileSync(
  require('node:path').resolve(__dirname, '../../lib/llamaparse-pages.ts'),
  'utf8'
);
const output = {};
vm.runInNewContext(
  ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText,
  { exports: output }
);
const parse = output.normalizeLlamaParsePages;
const md = 'first\n---\nrule belongs to the same page';
assert.deepEqual(
  Array.from(
    parse({
      pages: [
        { page: 3, text: 'third' },
        { page: 1, md },
        { page: 2, md: '  ', text: '' }
      ],
      job_metadata: { job_pages: 3 }
    })
  ),
  [md, '', 'third']
);
assert.deepEqual(
  Array.from(parse({ pages: [{ page: 1, md: ' ', text: 'fallback' }] })),
  ['fallback']
);
assert.deepEqual(Array.from(parse({ pages: [{ page: 1, md: '' }] })), ['']);
assert.deepEqual(
  Array.from(parse({pages:[
    {page:1,md:'first'},
    {page:2,text:' NO_CONTENT_HERE ',md:'NO_CONTENT_HERE',noTextContent:true},
    {page:3,md:'third'}
  ]})),
  ['first','','third']
);
for (const page of [
  {page:1,md:'NO_CONTENT_HERE'},
  {page:1,md:'NO_CONTENT_HERE',noTextContent:false},
  {page:1,md:'NO_CONTENT_HERE',noTextContent:'true'},
  {page:1,md:'NO_CONTENT_HERE is printed content',noTextContent:true},
  {page:1,md:'real markdown',text:'NO_CONTENT_HERE',noTextContent:true},
  {page:1,md:'NO_CONTENT_HERE',text:'real plain text',noTextContent:true}
]) assert.notEqual(parse({pages:[page]})[0],'');
assert.deepEqual(Array.from(parse({pages:[{page:1,text:'NO_CONTENT_HERE',md:' ',noTextContent:true}]})),['']);
for (const result of [
  null,
  {},
  { pages: [] },
  { pages: [null] },
  { pages: [{ page: 0, md: 'x' }] },
  { pages: [{ page: 1.5, md: 'x' }] },
  { pages: [{ page: '1', md: 'x' }] },
  {
    pages: [
      { page: 1, md: 'x' },
      { page: 1, md: 'y' }
    ]
  },
  {
    pages: [
      { page: 1, md: 'x' },
      { page: 3, md: 'y' }
    ]
  },
  { pages: [{ page: 1 }] },
  { pages: [{ page: 1, md: 'x' }], job_metadata: null },
  { pages: [{ page: 1, md: 'x' }], job_metadata: { job_pages: 2 } },
  { pages: [{ page: 1, md: 'x' }], job_metadata: { job_pages: '1' } },
  { pages: new Array(10001) }
])
  assert.throws(() => parse(result));
console.log(
  'PASS explicit parser page positions, blanks, horizontal rules, fallback and malformed/missing/duplicate/gap/count rejection; no live PDF claim'
);
