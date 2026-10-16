const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const source = fs.readFileSync(path.resolve(__dirname, '../../lib/server/chat-attachments.ts'), 'utf8');
const exportsObject = {};
const limits = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../lib/chat-attachment-limits.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS }
}).outputText, { exports: limits });
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, {
  exports: exportsObject, Buffer,
  require: name => name === 'server-only' ? {} : name === '@/lib/chat-attachment-limits' ? limits : require(name)
});
const { parsePdfChatAttachment, createChatAttachmentPath, encodeChatAttachmentReference, parseChatAttachmentReference, MAX_CHAT_ATTACHMENT_BYTES } = exportsObject;
const user = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const chat = '33333333-3333-4333-8333-333333333333';
const data = Buffer.from('%PDF-1.4\nsynthetic attachment');
const input = bytes => ({ url: `data:application/pdf;base64,${bytes.toString('base64')}`, mediaType: 'application/pdf', filename: '  sample\r\n.pdf  ' });
const parsed = parsePdfChatAttachment(input(data));
assert.equal(parsed.bytes.equals(data), true);
assert.equal(parsed.filename, 'sample.pdf');
assert.equal(parsed.sha256, require('node:crypto').createHash('sha256').update(data).digest('hex'));
const objectPath = createChatAttachmentPath(user, chat, parsed.sha256);
const reference = encodeChatAttachmentReference(objectPath);
assert.equal(parseChatAttachmentReference(reference, user, chat), objectPath);
assert.throws(() => parseChatAttachmentReference(reference, other, chat));
assert.throws(() => parseChatAttachmentReference(reference, user, other));
for (const url of ['https://example.invalid/file.pdf', '/api/chat/attachment', 'data:application/pdf;base64,', 'data:application/pdf;base64,!!!!', 'data:text/plain;base64,JVBERi0=']) {
  assert.throws(() => parsePdfChatAttachment({ url, mediaType: 'application/pdf' }));
}
assert.throws(() => parsePdfChatAttachment({ ...input(data), mediaType: 'image/png' }));
assert.throws(() => parsePdfChatAttachment(input(Buffer.from('not a PDF'))));
assert.throws(() => parsePdfChatAttachment({ ...input(data), filename: {} }));
assert.throws(() => parsePdfChatAttachment({ ...input(data), url: input(data).url + '\n' }));
assert.equal(parsePdfChatAttachment({ ...input(data), filename: '\u0000\r\n' }).filename, 'attachment.pdf');
assert.equal(parsePdfChatAttachment({ ...input(data), filename: 'x'.repeat(300) }).filename.length, 255);
for (const bad of [reference + '?x=1', reference + '#x', reference.replace('/' + chat, '//'+chat), reference.replace(chat, '..'), reference.replace('.pdf', '%2Epdf'), objectPath]) {
  assert.throws(() => parseChatAttachmentReference(bad, user));
}
assert.throws(() => createChatAttachmentPath('../user', chat, parsed.sha256));
assert.throws(() => createChatAttachmentPath(user, chat, '../hash'));
const maximum = Buffer.alloc(MAX_CHAT_ATTACHMENT_BYTES, 32);
maximum.write('%PDF-');
assert.equal(parsePdfChatAttachment(input(maximum)).bytes.length, MAX_CHAT_ATTACHMENT_BYTES);
const excessive = Buffer.alloc(MAX_CHAT_ATTACHMENT_BYTES + 1, 32);
excessive.write('%PDF-');
assert.throws(() => parsePdfChatAttachment(input(excessive)));
console.log('PASS private chat attachment parsing, size limits, canonical references and owner/chat isolation');
