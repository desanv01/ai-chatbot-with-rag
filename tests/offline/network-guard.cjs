// Every suite must use explicit local fixtures. Unexpected outbound calls fail.
const blocked = () => {
  throw new Error('Network access is forbidden in offline regression tests.');
};
globalThis.fetch = blocked;
for (const name of ['node:http', 'node:https']) {
  const transport = require(name);
  transport.request = blocked;
  transport.get = blocked;
}
