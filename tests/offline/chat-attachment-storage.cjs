const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const owner = '11111111-1111-4111-8111-111111111111';
const foreign = '22222222-2222-4222-8222-222222222222';
const chat = '33333333-3333-4333-8333-333333333333';
let currentUser = owner,
  metadataFailure = false,
  adminCalls = 0,
  uploads = 0;
let maintenanceFailure = false,
  uploadFailure = false;
const chats = new Map([[chat, { id: chat, user_id: owner }]]);
const objects = new Map(),
  metadata = new Map(),
  removed = [],
  savedParts = [];
function table(name) {
  const filters = [];
  const chain = {
    select() {
      return chain;
    },
    eq(key, value) {
      filters.push([key, value]);
      return chain;
    },
    async maybeSingle() {
      const rows =
        name === 'chat_sessions' ? [...chats.values()] : [...metadata.values()];
      return {
        data:
          rows.find((row) =>
            filters.every(([key, value]) => row[key] === value)
          ) || null,
        error: null
      };
    },
    async upsert(value) {
      if (name === 'chat_sessions') {
        const previous = chats.get(value.id);
        if (previous && previous.user_id !== currentUser)
          return { error: { code: '42501' } };
        chats.set(value.id, value);
      } else if (name === 'message_parts') savedParts.push(...value);
      else {
        if (metadataFailure)
          return { error: { message: 'private database detail' } };
        if (!metadata.has(value.object_path))
          metadata.set(value.object_path, structuredClone(value));
      }
      return { error: null };
    }
  };
  return chain;
}
const userClient = {
  auth: {
    async getUser() {
      return {
        data: { user: currentUser ? { id: currentUser } : null },
        error: null
      };
    }
  },
  from: table
};
const admin = {
  from: table,
  async rpc(name, args) {
    assert.equal(name, 'reserve_chat_attachment');
    if (metadataFailure)
      return { data: null, error: { message: 'private database detail' } };
    const objectPath = `${args.p_user_id}/${args.p_chat_id}/${args.p_sha256}.pdf`;
    if (!metadata.has(objectPath))
      metadata.set(objectPath, {
        object_path: objectPath,
        user_id: args.p_user_id,
        chat_session_id: args.p_chat_id,
        filename: args.p_filename,
        media_type: 'application/pdf',
        byte_size: args.p_byte_size,
        sha256: args.p_sha256
      });
    return { data: [metadata.get(objectPath)], error: null };
  },
  storage: {
    from(bucket) {
      assert.equal(bucket, 'chat-attachments');
      return {
        async upload(objectPath, bytes, options) {
          uploads++;
          assert.equal(options.upsert, false);
          assert.ok(
            metadata.has(objectPath),
            'bytes uploaded without durable metadata'
          );
          if (uploadFailure)
            return { error: { message: 'private upload detail' } };
          if (objects.has(objectPath)) return { error: { statusCode: '409' } };
          objects.set(objectPath, Buffer.from(bytes));
          return { data: { path: objectPath }, error: null };
        },
        async download(objectPath) {
          return objects.has(objectPath)
            ? { data: new Blob([objects.get(objectPath)]), error: null }
            : { data: null, error: { message: 'private Storage detail' } };
        },
        async remove(paths) {
          paths.forEach((item) => {
            removed.push(item);
            objects.delete(item);
          });
          return { error: null };
        }
      };
    }
  }
};
const mocks = {
  'server-only': {},
  '@/lib/server/server': { createServerSupabaseClient: async () => userClient },
  '@/lib/server/admin': {
    createAdminClient() {
      adminCalls++;
      return admin;
    }
  },
  '@/lib/server/chat-attachment-maintenance-start': {
    async ensureChatAttachmentMaintenance() {
      if (maintenanceFailure) throw new Error('private queue detail');
    }
  },
  '@/lib/server/supabase': {
    getSession: async () => (currentUser ? { sub: currentUser } : null)
  },
  'next/server': {
    NextResponse: class extends Response {
      static json(data, init) {
        return new Response(JSON.stringify(data), {
          ...init,
          headers: { 'Content-Type': 'application/json', ...init?.headers }
        });
      }
    }
  }
};
const loaded = new Map();
function load(file) {
  if (loaded.has(file)) return loaded.get(file);
  const exports = {};
  loaded.set(file, exports);
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022
      }
    }).outputText,
    {
      exports,
      Buffer,
      Blob,
      Uint8Array,
      URL,
      URLSearchParams,
      console,
      Date,
      require: (name) =>
        name in mocks
          ? mocks[name]
          : name.startsWith('@/')
            ? load(name.slice(2) + '.ts')
            : require(name)
    }
  );
  return exports;
}
const input = (bytes) => ({
  type: 'file',
  url: `data:application/pdf;base64,${bytes.toString('base64')}`,
  filename: 'fixture.pdf',
  mediaType: 'application/pdf'
});
async function main() {
  const storage = load('lib/server/chat-attachment-storage.ts');
  const bytes = Buffer.from('%PDF-1.4\nprivate synthetic fixture');
  const first = await storage.storeChatAttachment(input(bytes), owner, chat);
  assert.equal(metadata.size, 1);
  assert.equal(objects.size, 1);
  const reused = await storage.storeChatAttachment(
    { ...input(bytes), filename: 'renamed.pdf' },
    owner,
    chat
  );
  assert.equal(reused.reference, first.reference);
  assert.equal(reused.filename, 'fixture.pdf');
  assert.equal(objects.size, 1);
  assert.equal(
    (
      await storage.readChatAttachment(first.reference, owner, chat)
    ).bytes.equals(bytes),
    true
  );
  const beforeForeign = adminCalls;
  currentUser = foreign;
  await assert.rejects(
    storage.readChatAttachment(first.reference, foreign, chat)
  );
  await assert.rejects(
    storage.storeChatAttachment(input(bytes), foreign, chat)
  );
  assert.equal(
    adminCalls,
    beforeForeign,
    'foreign caller reached privileged client'
  );
  currentUser = owner;
  const objectPath = first.reference.slice('attachment://'.length);
  objects.set(objectPath, Buffer.from('%PDF-tampered'));
  await assert.rejects(
    storage.readChatAttachment(first.reference, owner, chat)
  );
  await assert.rejects(storage.storeChatAttachment(input(bytes), owner, chat));
  objects.set(objectPath, bytes);
  metadataFailure = true;
  const beforeCleanup = removed.length;
  const beforeReservationFailure = uploads;
  await assert.rejects(
    storage.storeChatAttachment(
      input(Buffer.from('%PDF-different fixture')),
      owner,
      chat
    )
  );
  assert.equal(removed.length, beforeCleanup);
  assert.equal(
    uploads,
    beforeReservationFailure,
    'failed reservation uploaded bytes'
  );
  await assert.rejects(storage.storeChatAttachment(input(bytes), owner, chat));
  assert.equal(
    removed.length,
    beforeCleanup,
    'failed reservation deleted reused object'
  );
  assert.equal(objects.has(objectPath), true);
  metadataFailure = false;
  maintenanceFailure = true;
  await assert.rejects(
    storage.storeChatAttachment(
      input(Buffer.from('%PDF-queue fixture')),
      owner,
      chat
    )
  );
  assert.equal(
    uploads,
    beforeReservationFailure,
    'unacknowledged cleanup queue uploaded bytes'
  );
  maintenanceFailure = false;
  uploadFailure = true;
  const retryBytes = Buffer.from('%PDF-upload interrupted');
  await assert.rejects(
    storage.storeChatAttachment(input(retryBytes), owner, chat)
  );
  const reservedCount = metadata.size;
  uploadFailure = false;
  await storage.storeChatAttachment(input(retryBytes), owner, chat);
  assert.equal(
    metadata.size,
    reservedCount,
    'retry created another reservation'
  );
  const messaging = load('lib/server/chat-attachment-messages.ts');
  const messages = [
    {
      id: 'fixture-user-message',
      role: 'user',
      metadata: { note: 'preserve' },
      parts: [{ type: 'text', text: 'Question' }, input(bytes)]
    }
  ];
  const persisted = await messaging.persistChatMessageAttachments(
    messages,
    owner,
    chat
  );
  assert.equal(persisted[0].parts[1].url, first.reference);
  assert.ok(messages[0].parts[1].url.startsWith('data:'));
  assert.equal(persisted[0].id, messages[0].id);
  assert.equal(persisted[0].metadata.note, 'preserve');
  const uiMessages = [
    {
      ...persisted[0],
      parts: [
        {
          ...persisted[0].parts[1],
          url: storage.getChatAttachmentUrl(first.reference)
        }
      ]
    }
  ];
  const model = await messaging.resolveChatMessageAttachments(
    uiMessages,
    owner,
    chat
  );
  assert.equal(model[0].parts[0].url, input(bytes).url);
  assert.ok(uiMessages[0].parts[0].url.startsWith('/api/chat/attachment?'));
  const beforeRejected = uploads;
  await assert.rejects(
    messaging.persistChatMessageAttachments(
      [{ ...messages[0], parts: Array(5).fill(input(bytes)) }],
      owner,
      chat
    )
  );
  await assert.rejects(
    messaging.persistChatMessageAttachments(
      [
        {
          ...messages[0],
          parts: [
            input(bytes),
            { ...input(bytes), url: 'https://example.invalid/file.pdf' }
          ]
        }
      ],
      owner,
      chat
    )
  );
  assert.equal(uploads, beforeRejected, 'invalid batch wrote an attachment');
  const large = Buffer.alloc(2 * 1024 * 1024, 32);
  large.write('%PDF-');
  await assert.rejects(
    messaging.persistChatMessageAttachments(
      [{ ...messages[0], parts: [input(large), input(large)] }],
      owner,
      chat
    )
  );
  assert.equal(uploads, beforeRejected);
  await assert.rejects(
    messaging.resolveChatMessageAttachments(
      Array.from({ length: 7 }, (_, i) => ({
        id: `history-${i}`,
        role: 'user',
        parts: [input(large)]
      })),
      owner,
      chat
    ),
    /Start a new chat/
  );
  const route = load('app/api/chat/attachment/route.ts');
  const request = (reference) => ({
    nextUrl: new URL(
      'https://app.example.invalid/api/chat/attachment?reference=' +
        encodeURIComponent(reference)
    )
  });
  const response = await route.GET(request(first.reference));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(
    response.headers
      .get('content-disposition')
      .includes("filename*=UTF-8''fixture.pdf")
  );
  assert.equal(Buffer.from(await response.arrayBuffer()).equals(bytes), true);
  currentUser = foreign;
  assert.equal((await route.GET(request(first.reference))).status, 404);
  currentUser = null;
  assert.equal((await route.GET(request(first.reference))).status, 401);
  currentUser = owner;
  const duplicate = request(first.reference);
  duplicate.nextUrl.searchParams.append('reference', first.reference);
  assert.equal((await route.GET(duplicate)).status, 400);
  const saver = load('app/api/chat/SaveToDbIncremental.ts');
  await saver.saveMessagesToDB({
    chatSessionId: chat,
    userId: owner,
    messages,
    isFirstStep: true
  });
  const fileRow = savedParts.find((part) => part.type === 'file');
  assert.equal(fileRow.file_url, first.reference);
  assert.ok(!fileRow.file_url.includes('base64'));
  console.log(
    'PASS actual attachment adapter/messages/download/saver: owner isolation, reservation-before-bytes, queue acknowledgement, retry, tamper rejection, bounded validation and reference-only persistence; mocked Storage/DB'
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
