// The own runtime counterpart of tests/e2e/qq-load.test.mjs. The host part (the plugin found through
// plugins.load.paths) has no counterpart: the bot is a plain Node entry. What is left to prove is that the pure-ESM SDK
// loads and runs in the bot process, that nothing from the host is loaded there at all, and that READY feeds status.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import { listeningPids, netAttempts, ROOT, startOwnStack, until } from '../harness/own.mjs';

let s;
let modulesFile;
let listenersWhileUp;

// A preload that records every module URL the bot process loads, through the synchronous resolve hook.
function writeModuleRecorder(dir) {
  const out = join(dir, 'modules.txt');
  const file = join(dir, 'module-recorder.mjs');
  writeFileSync(file, `import { appendFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
const OUT = ${JSON.stringify(out)};
registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context);
    try { appendFileSync(OUT, r.url + '\\n'); } catch {}
    return r;
  },
});
`);
  return { file, out };
}

before(async () => {
  s = await startOwnStack({ label: 'load', start: false });
  const rec = writeModuleRecorder(s.tmp);
  modulesFile = rec.out;
  // NODE_OPTIONS is never in the env clo start builds; it is added here only to observe what the process loads.
  await s.start({ env: { NODE_OPTIONS: `--import=${pathToFileURL(rec.file).href}` } });
  await until(() => s.control('heartbeat_at'), 'the first heartbeat', 30000);
  listenersWhileUp = listeningPids();
});

after(async () => {
  await s?.stop();
  s?.cleanup();
});

const loaded = () => (existsSync(modulesFile) ? readFileSync(modulesFile, 'utf8').split('\n').filter(Boolean) : []);

test('the SDK package is pure ESM, so loading it in the bot is meaningful', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'node_modules', '@tencent-connect', 'qqbot-nodejs', 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.exports['.'].require, undefined, 'no require condition: a CommonJS resolver cannot load it');
});

test('the bot process loaded the SDK, and no module of the host or its plugin SDK', () => {
  const urls = loaded();
  assert.ok(urls.some((u) => u.includes('/src/bot/main.mjs')), 'positive control: the recorder saw the entry');
  assert.ok(urls.some((u) => u.includes('/@tencent-connect/qqbot-nodejs/')), 'positive control: the SDK was loaded');
  assert.ok(urls.some((u) => u.includes('/src/clo-plugin/lib/core/turn.js')), 'the own turn runner was loaded');
  const host = urls.filter((u) => /\/node_modules\/openclaw\/|openclaw\/plugin-sdk|\/@openclaw\/|\/\.runtime\/pkg\//i.test(u));
  assert.deepEqual(host, [], 'nothing from the host');
  assert.deepEqual(urls.filter((u) => /\/src\/clo-plugin\/index\.js$/.test(u)), [], 'nor the host plugin entry');
});

test('code from the SDK ran in the bot process: it fetched a token and identified with bit 25 only', () => {
  assert.ok(s.qq.requests.some((r) => r.method === 'POST' && r.path === '/app/getAppAccessToken'));
  assert.equal(s.qq.identifies.length, 1);
  assert.equal(s.qq.identifies[0].intents, 1 << 25);
  const ready = s.event('connection_ready');
  assert.ok(ready.length > 0);
  assert.equal(ready[0].pid, s.bot.pid, 'it ran in the bot process');
  assert.notEqual(ready[0].pid, process.pid, 'not in the test runner');
  assert.equal(s.event('start_account').at(-1)?.kind, 'own');
});

test('status comes from READY: connected and last_ready_at are set, and the bot name is kept for the console', () => {
  assert.equal(s.control('connected'), 'true');
  assert.ok(Number(s.control('last_ready_at')) > 0);
  assert.equal(s.control('ready_username'), 'mock-bot');
  assert.ok(Number(s.control('heartbeat_at')) > 0);
});

test('the bot holds no listening socket, while the mocks in the test runner do (control)', () => {
  assert.ok(listenersWhileUp.has(process.pid), 'positive control: the test runner\'s mock servers are seen listening');
  assert.equal(listenersWhileUp.has(s.bot.pid), false, `the bot listens: ${listenersWhileUp.get(s.bot.pid)}`);
});

test('no network beyond the two mocks', () => {
  assert.deepEqual(netAttempts(s), []);
});
