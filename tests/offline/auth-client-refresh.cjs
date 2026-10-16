const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const assert = require('node:assert/strict'),
  ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const element = (type, props) => ({ type, props: props || {} });
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
const ui = new Proxy(
  { __esModule: true, default: 'UI' },
  { get: (obj, key) => (key in obj ? obj[key] : String(key)) }
);
async function check(file, mode, navigation) {
  let states = [],
    index = 0;
  const events = [],
    stored = [];
  const exports = {};
  const react = {
    useEffect() {},
    useState(initial) {
      const i = index++;
      if (!(i in states)) states[i] = initial;
      return [
        states[i],
        (v) => {
          states[i] = typeof v === 'function' ? v(states[i]) : v;
        }
      ];
    }
  };
  const mocks = {
    react,
    'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'fragment' },
    'react-dom': { useFormStatus: () => ({ pending: false }) },
    'next/navigation': {
      useRouter: () => ({
        back() {
          events.push('back');
        },
        replace(value) {
          assert.equal(value, '/chat');
          events.push('replace');
        }
      })
    },
    '../action': {
      async login() {
        events.push('login');
        return {
          success: mode !== 'invalid',
          message:
            mode === 'invalid'
              ? 'Invalid email or password'
              : 'Successfully logged in'
        };
      }
    },
    swr: {
      async mutate(key) {
        assert.equal(key, '/api/user-data');
        events.push('refresh');
        if (mode === 'cache-failure') throw new Error('private cache failure');
      }
    }
  };
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true
      }
    }).outputText,
    {
      exports,
      console,
      localStorage: {
        getItem: () => null,
        setItem: (key, value) => stored.push({ key, value }),
        removeItem: (key) => stored.push({ key })
      },
      require: (name) => (name in mocks ? mocks[name] : ui)
    }
  );
  index = 0;
  const tree = exports.default();
  const email = nodes(tree).find((node) => node.props.id === 'email');
  assert.equal(
    email.props['aria-label'],
    undefined,
    'redundant label overrides visible Email name'
  );
  assert.ok(nodes(tree).some((node) => node.props.htmlFor === 'email'));
  const form = nodes(tree).find((node) => node.type === 'form');
  const data = new FormData();
  data.set('email', 'fixture@example.invalid');
  data.set('password', 'local-fixture-password');
  await form.props.action(data);
  assert.deepEqual(
    events,
    mode === 'invalid' ? ['login'] : ['login', 'refresh', navigation]
  );
  assert.ok(stored.every((item) => item.key === 'rememberedEmail'));
  index = 0;
  const rendered = exports.default();
  const text = JSON.stringify(rendered);
  assert.ok(!text.includes('private cache failure'));
}
async function main() {
  for (const [file, navigation] of [
    ['app/@modal/(.)signin/SignInCard.tsx', 'back'],
    ['app/(frontpage)/signin/SignInCard.tsx', 'replace']
  ]) {
    for (const mode of ['success', 'invalid', 'cache-failure'])
      await check(file, mode, navigation);
  }
  console.log(
    'PASS actual sign-in callbacks: successful login refreshes shared auth cache before navigation, invalid login stays put, cache failure preserves successful navigation; no live Auth calls'
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
