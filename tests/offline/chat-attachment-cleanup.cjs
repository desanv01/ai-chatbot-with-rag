const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const owner = '11111111-1111-4111-8111-111111111111';
const chat = '33333333-3333-4333-8333-333333333333';
const objectPath = `${owner}/${chat}/${'a'.repeat(64)}.pdf`;
let owned = true,
  claims = [],
  liveMetadata = false,
  removeError = false;
let finishError = false,
  ownershipError = false,
  lease = null,
  startError = false;
const removed = [],
  finishes = [],
  starts = [];
class RetryableError extends Error {}
const admin = {
  async rpc(name, args) {
    if (name === 'claim_chat_attachment_maintenance')
      return {
        data: owned,
        error: ownershipError ? { message: 'private SQL detail' } : null
      };
    if (name === 'claim_chat_attachment_cleanup') {
      assert.equal(args.p_limit, 5);
      assert.match(args.p_token, /^[a-f\d-]{36}$/);
      return { data: claims, error: null };
    }
    assert.equal(name, 'finish_chat_attachment_cleanup');
    finishes.push(args);
    return {
      data: !finishError,
      error: finishError ? { message: 'private SQL detail' } : null
    };
  },
  from(name) {
    const chain = {
      select() {
        return chain;
      },
      eq() {
        return chain;
      },
      limit() {
        return chain;
      },
      async maybeSingle() {
        return {
          data:
            name === 'chat_attachment_maintenance'
              ? lease
              : liveMetadata
                ? { object_path: objectPath }
                : null,
          error: null
        };
      }
    };
    return chain;
  },
  storage: {
    from(bucket) {
      assert.equal(bucket, 'chat-attachments');
      return {
        async remove(paths) {
          removed.push(...paths);
          return {
            error: removeError ? { message: 'private Storage detail' } : null
          };
        }
      };
    }
  }
};
let workflowErrors = 0,
  workflowAcquired = false;
let stepCalls = 0,
  sleeps = 0,
  workflowOwned = true;
const mocks = {
  'server-only': {},
  '@/lib/server/admin': {
    createAdminClient(options) {
      assert.equal(options.requestTimeoutMs, 30_000);
      return admin;
    }
  },
  workflow: {
    RetryableError,
    getWorkflowMetadata: () => ({ workflowRunId: 'run-current' }),
    async sleep(duration) {
      assert.equal(duration, '30m');
      sleeps++;
    }
  },
  'workflow/api': {
    async start(workflow, args) {
      if (startError) throw new Error('private queue detail');
      starts.push({ workflow, args });
    }
  },
  '@/lib/server/chat-attachment-cleanup': {
    async maintenanceStep(run, previous) {
      assert.equal(run, 'run-current');
      stepCalls++;
      assert.equal(previous, workflowAcquired ? null : 'run-parent');
      if (workflowErrors) {
        workflowErrors--;
        throw new Error('private transient detail');
      }
      if (workflowOwned) workflowAcquired = true;
      return { owned: workflowOwned, removed: 1, failed: 0 };
    }
  }
};
function load(file) {
  const exports = {};
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
      console,
      Date,
      require: (name) =>
        name === '@/lib/server/document-versions'
          ? { isOwnedVersionedDocument: async () => false }
          : name in mocks
            ? mocks[name]
            : name.startsWith('@/')
              ? load(name.slice(2) + '.ts')
              : require(name)
    }
  );
  return exports;
}
async function main() {
  const { maintenanceStep } = load('lib/server/chat-attachment-cleanup.ts');
  owned = false;
  assert.equal((await maintenanceStep('run-current', null)).owned, false);
  assert.equal(removed.length, 0);
  owned = true;
  claims = [{ object_path: objectPath }];
  let result = await maintenanceStep('run-current', null);
  assert.equal(result.removed, 1);
  assert.equal(result.failed, 0);
  assert.equal(removed[0], objectPath);
  assert.equal(finishes.at(-1).p_success, true);
  liveMetadata = true;
  const removedBefore = removed.length;
  result = await maintenanceStep('run-current', null);
  assert.equal(
    removed.length,
    removedBefore,
    'cleanup removed a live attachment'
  );
  assert.equal(result.failed, 1);
  assert.equal(finishes.at(-1).p_success, false);
  liveMetadata = false;
  claims = [{ object_path: '../userfiles/original.pdf' }];
  await maintenanceStep('run-current', null);
  assert.equal(removed.length, removedBefore, 'malformed path reached Storage');
  claims = [{ object_path: objectPath }];
  removeError = true;
  assert.equal((await maintenanceStep('run-current', null)).failed, 1);
  assert.equal(finishes.at(-1).p_success, false);
  removeError = false;
  finishError = true;
  await assert.rejects(
    maintenanceStep('run-current', null),
    (error) =>
      error instanceof RetryableError && !error.message.includes('private')
  );
  finishError = false;
  ownershipError = true;
  await assert.rejects(maintenanceStep('run-current', null), RetryableError);
  ownershipError = false;
  const { chatAttachmentMaintenance } = load(
    'workflows/chat-attachment-maintenance.ts'
  );
  result = await chatAttachmentMaintenance('run-parent');
  assert.equal(result.removed, 336);
  assert.equal(sleeps, 336);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].args[0], 'run-current');
  stepCalls = 0;
  workflowAcquired = false;
  workflowOwned = false;
  await chatAttachmentMaintenance('run-parent');
  assert.equal(stepCalls, 1);
  assert.equal(
    starts.length,
    1,
    'nonowner spawned a duplicate maintenance chain'
  );
  const {
    ensureChatAttachmentMaintenance,
    ensureChatAttachmentMaintenanceForChatDeletion
  } = load('lib/server/chat-attachment-maintenance-start.ts');
  lease = {
    singleton: true,
    run_id: 'run-current',
    lease_until: new Date(Date.now() + 60_000).toISOString()
  };
  await ensureChatAttachmentMaintenance();
  assert.equal(starts.length, 1);
  lease = null;
  await ensureChatAttachmentMaintenance();
  assert.equal(starts.length, 2);
  assert.equal(starts[1].args[0], null);
  startError = true;
  await ensureChatAttachmentMaintenanceForChatDeletion(owner, chat);
  assert.equal(
    starts.length,
    2,
    'text-only deletion tried to enqueue Workflow'
  );
  await assert.rejects(
    ensureChatAttachmentMaintenance(),
    (error) => !error.message.includes('private')
  );
  startError = false;
  stepCalls = 0;
  workflowAcquired = false;
  workflowOwned = true;
  workflowErrors = 1;
  const startsBeforeOutage = starts.length;
  result = await chatAttachmentMaintenance('run-parent');
  assert.equal(result.removed, 335);
  assert.equal(result.failed, 1);
  assert.equal(
    starts.length,
    startsBeforeOutage + 1,
    'transient step exhaustion stranded the maintenance chain'
  );

  let ownedChat = true,
    deleteCalls = 0,
    queueChecks = 0,
    queueUnavailable = false;
  mocks['@/lib/server/supabase'] = { getSession: async () => ({ sub: owner }) };
  mocks['@/lib/server/server'] = {
    createServerSupabaseClient: async () => ({
      from(name) {
        assert.equal(name, 'chat_sessions');
        const chain = {
          select() {
            return chain;
          },
          eq() {
            return chain;
          },
          async maybeSingle() {
            return { data: ownedChat ? { id: chat } : null, error: null };
          },
          delete() {
            deleteCalls++;
            return chain;
          },
          then(resolve) {
            return Promise.resolve({ error: null }).then(resolve);
          }
        };
        return chain;
      }
    })
  };
  mocks['@/lib/server/chat-attachment-maintenance-start'] = {
    async ensureChatAttachmentMaintenanceForChatDeletion() {
      queueChecks++;
      if (queueUnavailable) throw new Error('unavailable');
    }
  };
  mocks['next/cache'] = { refresh() {} };
  mocks['next/headers'] = { cookies: async () => ({}) };
  const { deleteChatData } = load('app/(dashboard)/chat/actions.ts');
  ownedChat = false;
  await deleteChatData(chat);
  assert.equal(
    queueChecks,
    0,
    'foreign chat reached privileged queue integration'
  );
  assert.equal(deleteCalls, 0);
  ownedChat = true;
  queueUnavailable = true;
  await deleteChatData(chat);
  assert.equal(
    deleteCalls,
    0,
    'chat deleted before durable consumer acknowledgement'
  );
  queueUnavailable = false;
  await deleteChatData(chat);
  assert.equal(deleteCalls, 1);
  console.log(
    'PASS actual cleanup/maintenance code: live-object preservation, fixed-bucket/path validation, failure acknowledgement, lease handoff and bounded child chaining; mocked queue/DB/Storage'
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
