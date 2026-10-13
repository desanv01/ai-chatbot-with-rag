const fs = require('node:fs'),
  vm = require('node:vm'),
  assert = require('node:assert/strict');
const ts = require('typescript');
const base =
  require('node:path').resolve(__dirname, '../..') + require('node:path').sep;
let mode = 'success',
  calls = 0,
  clock = 100000000;
let verifiedToken;
const signupRequests = [],
  recoveryRequests = [];
function authResult() {
  if (mode === 'throw') throw Error('private upstream error');
  return {
    data: {
      user: mode === 'no-user' || mode === 'failure' ? null : { id: 'fixture' },
      session: mode === 'no-session' || mode === 'failure' ? null : {}
    },
    error: mode === 'failure' || mode === 'error-with-data' ? {} : null
  };
}
class FixtureDate extends Date {
  static now() {
    return clock;
  }
}
const client = {
  auth: {
    verifyOtp: async (args) => {
      calls++;
      verifiedToken = args.token_hash;
      if (mode === 'throw') throw Error('private upstream error');
      if (mode === 'failure')
        return {
          data: { user: null, session: null },
          error: { message: 'private token rejected' }
        };
      if (mode === 'no-session')
        return {
          data: { user: { id: 'fixture' }, session: null },
          error: null
        };
      return {
        data: { user: { id: 'fixture' }, session: {} },
        error: mode === 'error-with-data' ? {} : null
      };
    },
    exchangeCodeForSession: async () => {
      calls++;
      return authResult();
    },
    signUp: async (args) => {
      signupRequests.push(args);
      return { error: null };
    },
    resetPasswordForEmail: async (email, options) => {
      recoveryRequests.push({ email, ...options });
      return { error: null };
    }
  }
};
const mocks = {
  'next/server': {
    NextResponse: {
      redirect: (url) =>
        new Response(null, {
          status: 307,
          headers: { location: url.toString() }
        })
    }
  },
  '@/lib/server/server': {
    createServerSupabaseClient: async () => {
      if (mode === 'client-throw') throw Error('private client error');
      return client;
    }
  },
  zod: require('zod'),
  'next/cache': { revalidatePath() {} },
  'next/navigation': {
    redirect() {
      throw Error('unexpected redirect');
    }
  },
  '@/utils/getBaseUrl': { getBaseUrl: () => 'https://canonical.test/' }
};
function load(file) {
  const exp = {};
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(base + file, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022
      }
    }).outputText,
    {
      exports: exp,
      require: (name) =>
        name === '@/lib/auth-redirect'
          ? load('lib/auth-redirect.ts')
          : name === 'node:crypto'
            ? require(name)
            : mocks[name],
      URL,
      Response,
      FormData,
      Buffer,
      process,
      Date: FixtureDate,
      crypto,
      console: { error() {} }
    }
  );
  return exp;
}
async function run() {
  const safe = load('lib/auth-redirect.ts').getSafeRedirectPath;
  for (const path of [
    'https://evil.test/',
    '//evil.test/',
    '/\\evil.test/',
    'javascript:alert(1)',
    ''
  ])
    assert.equal(safe(path, '/signin'), '/signin');
  assert.equal(safe('/chat?x=1#history', '/'), '/chat?x=1#history');
  const paths = load('lib/document-path.ts');
  assert.equal(paths.isUserStoragePath('owner/fixture.pdf', 'owner'), true);
  for (const path of [
    'other/a.pdf',
    'owner/../a.pdf',
    'owner/./a.pdf',
    'owner//a.pdf',
    'owner/\\a.pdf',
    'owner/'
  ])
    assert.equal(paths.isUserStoragePath(path, 'owner'), false);
  process.env.DOCUMENT_JOB_SECRET =
    'offline-fixture-secret-with-no-real-account';
  const tokenApi = load('lib/server/document-job-token.ts'),
    expected = { jobId: 'job', userId: 'owner', filePath: 'owner/fixture.pdf' };
  const token = tokenApi.createDocumentJobToken(expected);
  assert.equal(tokenApi.verifyDocumentJobToken(token, expected), true);
  for (const patch of [
    { userId: 'other' },
    { jobId: 'other' },
    { filePath: 'owner/other.pdf' }
  ])
    assert.equal(
      tokenApi.verifyDocumentJobToken(token, { ...expected, ...patch }),
      false
    );
  const [payload, signature] = token.split('.');
  const changed = Buffer.from(
    JSON.stringify({
      ...JSON.parse(Buffer.from(payload, 'base64url').toString()),
      userId: 'other'
    })
  ).toString('base64url');
  assert.equal(
    tokenApi.verifyDocumentJobToken(`${changed}.${signature}`, {
      ...expected,
      userId: 'other'
    }),
    false
  );
  clock += 7201000;
  assert.equal(tokenApi.verifyDocumentJobToken(token, expected), false);
  clock -= 7201000;
  process.env.DOCUMENT_JOB_SECRET = 'rotated-offline-fixture';
  assert.equal(tokenApi.verifyDocumentJobToken(token, expected), false);
  const callback = load('app/api/auth/callback/route.ts').GET;
  for (const current of [
    'success',
    'failure',
    'no-session',
    'error-with-data',
    'throw',
    'client-throw'
  ]) {
    mode = current;
    const response = await callback({
      url: 'https://app.test/api/auth/callback?token_hash=fixture&type=email&next=%2Fchat'
    });
    const url = new URL(response.headers.get('location'));
    assert.equal(url.origin, 'https://app.test');
    if (current === 'success') {
      assert.equal(url.pathname, '/chat');
      assert.ok(url.searchParams.get('message'));
    } else {
      assert.equal(url.pathname, '/');
      assert.ok(url.searchParams.get('error'));
      assert.equal(url.searchParams.has('message'), false);
      assert.equal(url.href.includes('private'), false);
    }
  }
  mode = 'success';
  await callback({
    url: 'https://app.test/api/auth/callback?token_hash=otp-hash&code=unrelated-code&type=email'
  });
  assert.equal(verifiedToken, 'otp-hash');
  await callback({
    url: 'https://app.test/api/auth/callback?code=legacy-hash&type=email'
  });
  assert.equal(verifiedToken, 'legacy-hash');
  for (const query of [
    'token_hash=fixture&type=invalid',
    'type=email',
    'token_hash=fixture'
  ]) {
    const prior = calls;
    const response = await callback({
      url: `https://app.test/api/auth/callback?${query}`
    });
    assert.equal(calls, prior);
    assert.ok(
      new URL(response.headers.get('location')).searchParams.get('error')
    );
  }
  for (const next of ['https://evil.test/', '//evil.test/', '/\\evil.test/']) {
    const response = await callback({
      url: `https://app.test/api/auth/callback?token_hash=fixture&type=email&next=${encodeURIComponent(next)}`
    });
    assert.equal(
      new URL(response.headers.get('location')).origin,
      'https://app.test'
    );
  }
  const confirm = load('app/api/auth/confirm/route.ts').GET;
  for (const current of [
    'success',
    'failure',
    'no-session',
    'no-user',
    'error-with-data',
    'throw',
    'client-throw'
  ]) {
    mode = current;
    const response = await confirm({
      url: 'https://app.test/api/auth/confirm?code=fixture&next=%2Fredirect%2Fauth-password-update'
    });
    const url = new URL(response.headers.get('location'));
    assert.equal(url.origin, 'https://app.test');
    assert.equal(url.href.includes('private'), false);
    assert.equal(
      url.pathname,
      current === 'success' ? '/redirect/auth-password-update' : '/signin'
    );
    assert.equal(
      url.searchParams.get('message'),
      current === 'success' ? 'You are now signed in' : 'An error occurred'
    );
  }
  mode = 'success';
  const prior = calls;
  await confirm({ url: 'https://app.test/api/auth/confirm' });
  assert.equal(calls, prior);
  for (const next of ['https://evil.test/', '//evil.test/', '/\\evil.test/']) {
    const response = await confirm({
      url: `https://app.test/api/auth/confirm?code=fixture&next=${encodeURIComponent(next)}`
    });
    const url = new URL(response.headers.get('location'));
    assert.equal(url.origin, 'https://app.test');
    assert.equal(url.pathname, '/signin');
  }
  for (const file of ['app/(frontpage)/action.ts', 'app/@modal/action.ts']) {
    const actions = load(file);
    const form = new FormData();
    form.set('email', 'fixture@example.test');
    form.set('password', 'fixture-password');
    assert.equal((await actions.signup(form)).success, true);
    assert.equal(
      signupRequests.at(-1).options.emailRedirectTo,
      'https://canonical.test/api/auth/confirm'
    );
    assert.equal((await actions.resetPasswordForEmail(form)).success, true);
    const redirect = new URL(recoveryRequests.at(-1).redirectTo);
    assert.equal(redirect.origin, 'https://canonical.test');
    assert.equal(redirect.pathname, '/api/auth/confirm');
    assert.equal(
      redirect.searchParams.get('next'),
      '/redirect/auth-password-update'
    );
    const beforeSignup = signupRequests.length,
      beforeRecovery = recoveryRequests.length;
    form.set('email', 'invalid');
    assert.equal((await actions.signup(form)).success, false);
    assert.equal((await actions.resetPasswordForEmail(form)).success, false);
    assert.equal(signupRequests.length, beforeSignup);
    assert.equal(recoveryRequests.length, beforeRecovery);
  }
  console.log(
    'PASS OTP/PKCE error/null-session/throw/type handling, token precedence, canonical signup/recovery redirects, invalid input, owner paths and real HMAC binding/tamper/expiry/rotation; mocked Auth only'
  );
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
