// CLO_TEST_API_KEY is the paid probe's key. It may sit in .env next to the chat key, but it must never reach the
// Gateway or the bot, by file or by the parent's environment, and doctor must take it without a warning or its value.
// Each negative check has the chat key reaching the same child as its control.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { makeContext } from '../../src/cli/common.mjs';
import { formatDoctor, FULL_LEVEL, runDoctor } from '../../src/cli/doctor.mjs';
import { ensureGatewayEnvClean, gatewayEnv, gatewayEnvForCheck, ownEnv, ownEnvForCheck, parseEnvFile, readPidRecord } from '../../src/cli/lifecycle.mjs';
import { cleanChildEnv } from '../harness/clean-env.mjs';
import { clo, configOf, enabledConfig, fakeProvider, FAKE_KEY, FAKE_SECRET, makeRoot, NET_GUARD, readJson, testEnv } from './_cli-helper.mjs';

const TEST_KEY = 'CLO_TEST_API_KEY';
const FILE_VALUE = 'sk-or-v1-FAKE-PROBE-KEY-FROM-FILE-MUST-NOT-PASS';
const PARENT_VALUE = 'sk-or-v1-FAKE-PROBE-KEY-FROM-PARENT-MUST-NOT-PASS';
const VALUES = [FILE_VALUE, PARENT_VALUE];

const roots = [];
const cleanups = [];
after(() => {
  for (const fn of cleanups) {
    try { fn(); } catch { /* best effort */ }
  }
  roots.forEach((r) => r.cleanup());
});

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
async function until(cond, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

async function freePort() {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

// The probe key, or its value, anywhere in a child env. Empty is the only good answer.
function leaks(env) {
  const out = [];
  if (TEST_KEY in env) out.push(`name ${TEST_KEY}`);
  for (const [k, v] of Object.entries(env)) {
    if (VALUES.some((value) => String(v).includes(value))) out.push(`value under ${k}`);
  }
  return out;
}

function rootWithProbeKey(label, config = enabledConfig()) {
  const r = makeRoot(label, config);
  roots.push(r);
  appendFileSync(join(r.root, '.env'), `${TEST_KEY}=${FILE_VALUE}\n`);
  return r.root;
}

test('the env builders: the chat key passes, the probe key never does, from the file or the parent', () => {
  const root = rootWithProbeKey('builders', null);
  const ctx = makeContext({ env: testEnv(root, { CLO_TEST_NODE_IMPORT: NET_GUARD, CLO_TEST_CRASH_AT: 'x' }), stdout: { write() {} }, stderr: { write() {} } });
  const file = ctx.paths.envFile;
  assert.equal(parseEnvFile(file, [TEST_KEY])[TEST_KEY], FILE_VALUE, 'positive control: the line is there and parses');
  const secrets = parseEnvFile(file);
  assert.equal(secrets.CLO_CHAT_API_KEY, FAKE_KEY, 'positive control: start reads the chat key from the same file');
  assert.equal(secrets[TEST_KEY], undefined, 'start does not read the probe key');

  // Test mode and normal mode: test mode passes a few CLO_TEST_* names, and this one shares the prefix.
  for (const parent of [{ ...ctx.env, [TEST_KEY]: PARENT_VALUE }, { SystemRoot: ctx.env.SystemRoot, [TEST_KEY]: PARENT_VALUE }]) {
    const host = gatewayEnv(ctx.paths, parent, { secrets, token: 'T' });
    const own = ownEnv(ctx.paths, parent, { secrets });
    for (const [label, env] of [['gateway', host], ['bot', own]]) {
      assert.equal(env.OPENROUTER_API_KEY, FAKE_KEY, `${label}: positive control, the chat key arrives`);
      assert.deepEqual(leaks(env), [], label);
    }
    if (parent.CLO_TEST_ROOT) assert.equal(host.CLO_TEST_CRASH_AT, 'x', 'positive control: test mode does pass its own names');
    // Even a caller that hands the probe key in as a secret gets nothing: only the three known names map.
    assert.deepEqual(leaks(gatewayEnv(ctx.paths, parent, { secrets: { ...secrets, [TEST_KEY]: FILE_VALUE } })), []);
  }
  assert.deepEqual(leaks(gatewayEnvForCheck(ctx.paths, { ...ctx.env, [TEST_KEY]: PARENT_VALUE })), []);
  assert.deepEqual(leaks(ownEnvForCheck(ctx.paths, { ...ctx.env, [TEST_KEY]: PARENT_VALUE })), []);

  // Doctor's denylist names it, so a later allowlist change that let it through would fail gateway_env and bot_env.
  assert.deepEqual(ensureGatewayEnvClean({ [TEST_KEY]: 'x', OPENROUTER_API_KEY: 'x', CLO_TEST_ROOT: 'x' }), [TEST_KEY]);
  assert.deepEqual(leaks({ [TEST_KEY]: 'x' }), [`name ${TEST_KEY}`], 'positive control: the leak check sees a name');
  assert.deepEqual(leaks({ X: `a${FILE_VALUE}b` }), ['value under X'], 'positive control: and a value');
});

// Stand-ins for the Gateway and the bot: each reports the env it was started with, then stays up.
const FAKE_HOST = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args[0] === 'plugins') {
  console.log(JSON.stringify({ plugin: { status: 'loaded' }, typedHooks: [{ name: 'before_agent_run' }, { name: 'before_prompt_build' }, { name: 'before_tool_call' }], policy: { allowConversationAccess: true } }));
  process.exit(0);
}
writeFileSync(join(process.env.CLO_TEST_ROOT, 'fake-child.json'), JSON.stringify({ pid: process.pid, env: process.env }));
setInterval(() => {}, 1000);
`;
const FAKE_BOT = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync(join(process.env.CLO_TEST_ROOT, 'fake-child.json'), JSON.stringify({ pid: process.pid, env: process.env }));
setInterval(() => {}, 1000);
`;

async function stack(label, runtime) {
  const root = rootWithProbeKey(label);
  const entries = join(root, 'entries');
  mkdirSync(entries, { recursive: true });
  writeFileSync(join(entries, 'host.mjs'), FAKE_HOST);
  writeFileSync(join(entries, 'bot.mjs'), FAKE_BOT);
  const cfg = configOf(root);
  cfg.gatewayPort = await freePort();
  cfg.runtime = runtime;
  writeFileSync(join(root, 'config.json'), JSON.stringify(cfg, null, 2));
  const env = {
    CLO_TEST_NODE_IMPORT: NET_GUARD,
    CLO_TEST_GATEWAY_ENTRY: join(entries, 'host.mjs'),
    CLO_TEST_BOT_ENTRY: join(entries, 'bot.mjs'),
    CLO_NET_GUARD_LOG: join(root, 'net-guard.jsonl'),
    [TEST_KEY]: PARENT_VALUE,
  };
  const run = (argv, opts = {}) => clo(root, argv, { env, ...opts });
  assert.equal((await run(['model', 'refresh'], { fetch: fakeProvider().fetch })).code, 0);
  cleanups.push(() => {
    const rec = readPidRecord(makeContext({ env: testEnv(root), stdout: { write() {} }, stderr: { write() {} } }).paths);
    if (rec) spawnSync('taskkill', ['/PID', String(rec.pid), '/T', '/F'], { cwd: tmpdir(), env: cleanChildEnv(), windowsHide: true });
  });
  return { root, run };
}

for (const runtime of ['openclaw', 'own']) {
  test(`clo start (${runtime}): the started process gets the chat key and not the probe key`, { timeout: 120000 }, async () => {
    const s = await stack(`start-${runtime}`, runtime);
    const started = await s.run(['start']);
    assert.equal(started.code, 0, `${started.out}${started.err}`);
    const printed = `${started.out}${started.err}`;
    for (const raw of [FAKE_KEY, FAKE_SECRET, ...VALUES]) assert.ok(!printed.includes(raw), 'printed a key');
    const info = await until(() => existsSync(join(s.root, 'fake-child.json')) && readJson(join(s.root, 'fake-child.json')), 'the child to report');
    assert.equal(readJson(join(s.root, '.runtime', 'pids', 'gateway.json')).pid, info.pid, 'the report is from the process start recorded');
    assert.equal(info.env.OPENROUTER_API_KEY, FAKE_KEY, 'positive control: the chat key from the same .env arrives');
    assert.equal(info.env.CLO_TEST_ROOT, s.root, 'positive control: and a test-mode name passes');
    assert.deepEqual(leaks(info.env), []);
    const stopped = await s.run(['stop']);
    assert.equal(stopped.code, 0, `${stopped.out}${stopped.err}`);
  });
}

const HOOKS_ANSWER = () => ({ status: 0, stdout: JSON.stringify({ plugin: { status: 'loaded' }, typedHooks: [{ name: 'before_agent_run' }, { name: 'before_prompt_build' }, { name: 'before_tool_call' }], policy: { allowConversationAccess: true } }) });
const ENV_CHECKS = ['env_file', 'env_old_names', 'env_duplicates', 'gateway_env', 'bot_env'];

for (const runtime of ['openclaw', 'own']) {
  test(`doctor (${runtime}) takes the probe key in .env and in the shell without a warning or its value`, async () => {
    const cfg = enabledConfig();
    cfg.runtime = runtime;
    const root = rootWithProbeKey(`doctor-${runtime}`, cfg);
    assert.equal((await clo(root, ['model', 'refresh'], { fetch: fakeProvider().fetch })).code, 0);
    const ctx = makeContext({ env: testEnv(root, { CLO_TEST_NODE_IMPORT: NET_GUARD, [TEST_KEY]: PARENT_VALUE }), fetch: () => { throw new Error('no network'); }, stdout: { write() {} }, stderr: { write() {} } });
    const doctor = () => runDoctor(ctx, { level: FULL_LEVEL, run: HOOKS_ANSWER });
    assert.match(readFileSync(ctx.paths.envFile, 'utf8'), new RegExp(`^${TEST_KEY}=`, 'm'), 'positive control: the line is in the .env doctor reads');

    const report = doctor();
    const text = formatDoctor(report);
    assert.deepEqual(report.failed, [], text);
    const notOk = report.checks.filter((c) => !c.ok).map((c) => c.id);
    for (const id of ENV_CHECKS) {
      const check = report.checks.find((c) => c.id === id);
      if (check) assert.equal(check.ok, true, `${id}: ${check.detail}`);
    }
    assert.ok(report.checks.some((c) => c.id === 'env_file'), 'positive control: the .env checks ran');
    assert.ok(!notOk.some((id) => /^env_/.test(id)), `an .env warning: ${notOk.join(', ')}`);
    assert.ok(!text.includes(TEST_KEY), 'doctor names the probe key');
    for (const raw of [FAKE_KEY, FAKE_SECRET, ...VALUES]) assert.ok(!text.includes(raw), 'printed a key value');

    // Positive control in the same run: a line doctor does warn about is reported, so the clean result above means
    // something. The probe key's value still never shows.
    appendFileSync(ctx.paths.envFile, `CLO_CHAT_API_KEY=${FAKE_KEY}\n`);
    const warned = doctor();
    const dup = warned.checks.find((c) => c.id === 'env_duplicates');
    assert.equal(dup.ok, false);
    assert.equal(dup.severity, 'warn');
    for (const raw of [FAKE_KEY, FAKE_SECRET, ...VALUES]) assert.ok(!formatDoctor(warned).includes(raw), 'printed a key value');
  });
}

// The other direction from doc-status: every key the template asks for is in the README's .env table and in the
// CLAUDE.md key table, so a user filling in .env from either document learns about the probe key.
test('every key in .env.example is in the README .env table and the CLAUDE.md key table', () => {
  const ROOT = join(import.meta.dirname, '..', '..');
  const read = (f) => readFileSync(join(ROOT, f), 'utf8');
  const template = [...read('.env.example').matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]);
  assert.ok(template.includes(TEST_KEY) && template.includes('CLO_CHAT_API_KEY') && template.includes('CLO_ANTHROPIC_API_KEY'), 'positive control: the template was parsed');
  const readme = read('README.md');
  const section = readme.slice(readme.indexOf('### 2. 填 `.env`'), readme.indexOf('### 3. 改 `config.json`'));
  const readmeKeys = [...section.matchAll(/^\| `([A-Z0-9_]+)` \|/gm)].map((m) => m[1]);
  const guide = read('CLAUDE.md');
  // The table ends at the paragraph on the two model providers that follows it.
  const start = guide.indexOf('**密钥**只放');
  const end = guide.indexOf('**模型接口只有两种：OpenRouter 和 Anthropic。**');
  assert.ok(start >= 0 && end > start, 'positive control: both anchors are in CLAUDE.md, in order');
  const keyTable = guide.slice(start, end);
  const guideKeys = [...keyTable.matchAll(/`([A-Z0-9_]+)`/g)].map((m) => m[1]);
  assert.ok(readmeKeys.includes('CLO_CHAT_API_KEY'), 'positive control: the README table was found');
  assert.ok(guideKeys.includes('CLO_CHAT_API_KEY'), 'positive control: the CLAUDE.md table was found');
  assert.deepEqual(template.filter((k) => !readmeKeys.includes(k)), [], 'keys missing from the README .env table');
  assert.deepEqual(template.filter((k) => !guideKeys.includes(k)), [], 'keys missing from the CLAUDE.md key table');
});
