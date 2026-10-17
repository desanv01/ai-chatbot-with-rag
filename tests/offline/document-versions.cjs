const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm'),
  assert = require('node:assert/strict'),
  ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const owner = '11111111-1111-4111-8111-111111111111',
  foreign = '99999999-9999-4999-8999-999999999999';
const old = '22222222-2222-4222-8222-222222222222',
  current = '33333333-3333-4333-8333-333333333333',
  series = '44444444-4444-4444-8444-444444444444';
let identity = owner,
  queries = [],
  lookupFailure = false;
const rows = {
  document_replacement_candidates: [
    {
      job_id: series,
      user_id: owner,
      target_document_id: old,
      candidate_document_id: current
    }
  ],
  user_documents: [
    { id: old, user_id: owner, title: 'old.pdf', processing_status: 'ready' },
    {
      id: current,
      user_id: owner,
      title: 'new [v2].pdf',
      processing_status: 'ready'
    }
  ],
  document_series_members: [
    { document_id: old, series_id: series, user_id: owner, version: 1 },
    { document_id: current, series_id: series, user_id: owner, version: 2 }
  ],
  document_series: [
    {
      id: series,
      user_id: owner,
      display_name: 'old.pdf',
      active_document_id: current
    }
  ]
};
function from(table) {
  const filters = [];
  const q = {
    select() {
      return q;
    },
    eq(k, v) {
      filters.push((r) => r[k] === v);
      return q;
    },
    in(k, v) {
      filters.push((r) => v.includes(r[k]));
      return q;
    },
    async maybeSingle() {
      return result(true);
    },
    then(resolve, reject) {
      return Promise.resolve(result()).then(resolve, reject);
    }
  };
  function result(single) {
    queries.push(table);
    const selected = rows[table].filter((r) => filters.every((f) => f(r)));
    return {
      data: single ? (selected[0] ?? null) : selected,
      error: lookupFailure ? { message: 'private DB' } : null
    };
  }
  return q;
}
function load(file, mocks) {
  const exports = {};
  const extra = {
    '@/lib/server/admin': {
      createAdminClient: () => {
        throw Error('Unexpected admin access');
      }
    }
  };
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022
      }
    }).outputText,
    {
      exports,
      Error,
      FormData,
      console: { error() {} },
      require: (n) =>
        n in mocks ? mocks[n] : n in extra ? extra[n] : require(n)
    }
  );
  return exports;
}
async function main() {
  const helper = load('lib/server/document-versions.ts', {
    'server-only': {},
    '@/lib/server/server': {
      createServerSupabaseClient: async () => ({
        auth: {
          getUser: async () => ({
            data: { user: { id: identity } },
            error: null
          })
        },
        from
      })
    }
  });
  assert.equal(await helper.getOwnedReplacementTarget(owner, old), null);
  assert.equal(
    (await helper.getOwnedReplacementTarget(owner, current)).id,
    current
  );
  assert.equal(await helper.isOwnedVersionedDocument(owner, old), true);
  const versions = await helper.getOwnedDocumentVersions(owner, [old, current]);
  assert.equal(versions.length, 2);
  assert.equal(versions[0].isCurrent, false);
  assert.equal(versions[1].isCurrent, true);
  assert.equal(
    await helper.isOwnedReplacementReservation(owner, series, old, current),
    true
  );
  assert.equal(
    await helper.isOwnedReplacementReservation(owner, series, current, current),
    false
  );
  assert.equal(
    await helper.isOwnedReplacementReservation(owner, series, old, old),
    false
  );
  identity = foreign;
  const count = queries.length;
  await assert.rejects(helper.getOwnedReplacementTarget(owner, current));
  assert.equal(
    queries.length,
    count,
    'foreign session reached document lookup'
  );
  assert.equal(await helper.getOwnedReplacementTarget(foreign, current), null);
  assert.equal(await helper.isOwnedVersionedDocument(foreign, old), false);
  identity = owner;
  await assert.rejects(helper.getOwnedDocumentVersions(owner, ['invalid']));
  lookupFailure = true;
  await assert.rejects(helper.isOwnedVersionedDocument(owner, old));
  lookupFailure = false;
  rows.document_series_members = [];
  assert.equal((await helper.getOwnedReplacementTarget(owner, old)).id, old);
  // Both existing delete actions must check membership before deleting source bytes.
  for (const file of [
    'app/(dashboard)/filer/action.ts',
    'app/(dashboard)/chat/actions.ts'
  ]) {
    let removes = 0,
      deleted = 0,
      versioned = true,
      helperError = false;
    const client = {
      from: () => ({
        select() {
          return this;
        },
        eq() {
          return this;
        },
        async maybeSingle() {
          return {
            data: {
              id: old,
              file_path: `${owner}/55555555-5555-4555-8555-555555555555.pdf`
            },
            error: null
          };
        },
        delete() {
          deleted++;
          return this;
        },
        then(resolve) {
          resolve({ data: [{ id: old, title: 'old.pdf' }], error: null });
        }
      }),
      storage: {
        from: () => ({
          remove: async () => {
            removes++;
            return { error: null };
          }
        })
      }
    };
    const mocks = {
      'server-only': {},
      zod: require('zod'),
      'next/cache': { revalidatePath() {}, refresh() {} },
      '@/lib/server/supabase': { getSession: async () => ({ sub: owner }) },
      '@/lib/server/server': { createServerSupabaseClient: async () => client },
      '@/lib/document-path': {
        isUserStoragePath: () => true,
        USER_FILES_BUCKET: 'userfiles'
      },
      '@/lib/server/document-versions': {
        isOwnedVersionedDocument: async () => {
          if (helperError) throw Error('private');
          return versioned;
        }
      },
      '@/lib/server/chat-attachment-maintenance-start': {
        ensureChatAttachmentMaintenanceForChatDeletion: async () => {}
      }
    };
    const actions = load(file, mocks),
      form = new FormData();
    form.set('file_id', old);
    const remove =
      actions.deleteUserFile ?? actions.deleteFilterTagAndDocumentChunks;
    assert.equal((await remove(form)).success, false);
    assert.equal(removes, 0);
    assert.equal(deleted, 0);
    helperError = true;
    assert.equal((await remove(form)).success, false);
    assert.equal(removes, 0);
    helperError = false;
    versioned = false;
    assert.equal((await remove(form)).success, true);
    assert.equal(removes, 1);
    assert.equal(deleted, 1);
  }
  console.log(
    'PASS actual version helpers and both delete actions: current/previous resolution, owner-before-query, fail-closed lookup, historical retention and ordinary deletion compatibility'
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
