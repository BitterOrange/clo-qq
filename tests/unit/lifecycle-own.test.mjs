// The own runtime's side of clo start, stop, apply and status, with a stand-in bot entry and project-owned PIDs.
// Nothing here can reach QQ or OpenRouter; other Node processes must survive.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { makeContext } from '../../src/cli/common.mjs';
import { botEntry, forbiddenOwnArgs, gatewayEnv, GATEWAY_NODE_FLAGS, ownArgs, ownEnv, processInfo, readPidRecord, startLockFile } from '../../src/cli/lifecycle.mjs';
import { CONSUMER_LEASE_KEY, STOP_REQUEST_KEY } from '../../src/clo-plugin/lib/channels/qq/lease.js';
import { cleanChildEnv } from '../harness/clean-env.mjs';
import { clo, configOf, dbOf, effectiveOf, enabledConfig, fakeProvider, FAKE_KEY, FAKE_SECRET, makeRoot, NET_GUARD, NODE, readJson, testEnv, withDb } from './_cli-helper.mjs';

const roots = [];
const cleanups = [];
after(() => {
  for (const fn of cleanups) {
    try { fn(); } catch { /* best effort */ }
  }
  roots.forEach((r) => r.cleanup());
});

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const alive = (pid) => processInfo(pid) !== null;
async function until(cond, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

// Stands in for src/bot/main.mjs: reports what it was started with, then stays up.
const FAKE_BOT = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync(join(process.env.CLO_TEST_ROOT, 'fake-bot.json'), JSON.stringify({ pid: process.pid, cwd: process.cwd(), args: process.argv.slice(2), execArgv: process.execArgv, execPath: process.execPath, env: process.env }));
setInterval(() => {}, 1000);
`;
// Stands in for the Gateway, for the cross-runtime refusals: answers plugins inspect, otherwise stays up.
const FAKE_HOST = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args[0] === 'plugins') {
  console.log(JSON.stringify({ plugin: { status: 'loaded' }, typedHooks: [{ name: 'before_agent_run' }, { name: 'before_prompt_build' }, { name: 'before_tool_call' }], policy: { allowConversationAccess: true } }));
  process.exit(0);
}
writeFileSync(join(process.env.CLO_TEST_ROOT, 'fake-gateway.json'), JSON.stringify({ pid: process.pid, args }));
setInterval(() => {}, 1000);
`;

async function freePort() {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

const pidFileOf = (root) => join(root, '.runtime', 'pids', 'gateway.json');
const openclawJsonOf = (root) => join(root, '.runtime', 'state', 'openclaw.json');
const setRuntime = (root, runtime) => writeFileSync(join(root, 'config.json'), JSON.stringify({ ...configOf(root), runtime }, null, 2));

async function stack(label, { runtime = 'own' } = {}) {
  const r = makeRoot(label, enabledConfig());
  roots.push(r);
  const botDir = join(r.root, 'bot');
  mkdirSync(botDir, { recursive: true });
  writeFileSync(join(botDir, 'main.mjs'), FAKE_BOT);
  writeFileSync(join(r.root, 'fake-host.mjs'), FAKE_HOST);
  const cfg = configOf(r.root);
  cfg.gatewayPort = await freePort();
  cfg.runtime = runtime;
  writeFileSync(join(r.root, 'config.json'), JSON.stringify(cfg, null, 2));
  const env = {
    CLO_TEST_NODE_IMPORT: NET_GUARD,
    CLO_TEST_BOT_ENTRY: join(botDir, 'main.mjs'),
    CLO_TEST_GATEWAY_ENTRY: join(r.root, 'fake-host.mjs'),
    CLO_NET_GUARD_LOG: join(r.root, 'net-guard.jsonl'),
    // A hostile parent: none of these may reach the child.
    HTTP_PROXY: 'http://127.0.0.1:1',
    https_proxy: 'http://127.0.0.1:1',
    NODE_OPTIONS: '--inspect=127.0.0.1:9229',
    OPENROUTER_API_KEY: 'PARENT-KEY-MUST-NOT-PASS',
    CLO_CHAT_API_KEY: 'PARENT-KEY-MUST-NOT-PASS',
    CLO_SEARCH_API_KEY: 'PARENT-KEY-MUST-NOT-PASS',
    PERPLEXITY_API_KEY: 'PARENT-KEY-MUST-NOT-PASS',
    OPENCLAW_STATE_DIR: 'PARENT-MUST-NOT-PASS',
  };
  const run = (argv, opts = {}) => clo(r.root, argv, { env, ...opts });
  assert.equal((await run(['model', 'refresh'], { fetch: fakeProvider().fetch })).code, 0);
  cleanups.push(() => {
    const rec = readPidRecord(makeContext({ env: testEnv(r.root), stdout: { write() {} }, stderr: { write() {} } }).paths);
    if (rec) spawnSync('taskkill', ['/PID', String(rec.pid), '/T', '/F'], { cwd: tmpdir(), env: cleanChildEnv(), windowsHide: true });
  });
  return { root: r.root, run, env };
}

const fakeBot = (root) => until(() => existsSync(join(root, 'fake-bot.json')) && readJson(join(root, 'fake-bot.json')), 'fake bot to report');

function bystander() {
  const child = spawn(NODE, ['-e', 'setInterval(() => {}, 1000)'], { cwd: tmpdir(), env: cleanChildEnv(), stdio: 'ignore', windowsHide: true });
  cleanups.push(() => child.kill());
  return child;
}

test('the bot env is the Gateway allowlist without the host settings, plus the effective path', () => {
  const r = makeRoot('ownenv', null);
  roots.push(r);
  const ctx = makeContext({ env: testEnv(r.root, { CLO_TEST_CRASH_AT: 'x', CLO_NET_GUARD_LOG: 'g' }), stdout: { write() {} }, stderr: { write() {} } });
  const parent = { ...ctx.env, HTTP_PROXY: 'x', NODE_OPTIONS: '--require=x', OPENROUTER_API_KEY: 'PARENT', CLO_CHAT_API_KEY: 'PARENT', CLO_SEARCH_API_KEY: 'PARENT', CLO_QQ_APP_SECRET: 'PARENT', PERPLEXITY_API_KEY: 'x', OPENCLAW_HOME: 'x', USERNAME: 'someone' };
  const secrets = { CLO_CHAT_API_KEY: 'FROMFILE', CLO_QQ_APP_ID: 'APP', CLO_QQ_APP_SECRET: 'SECRET' };
  const host = gatewayEnv(ctx.paths, parent, { secrets, token: 'T' });
  const own = ownEnv(ctx.paths, parent, { secrets });
  assert.ok(Object.keys(host).some((k) => k.startsWith('OPENCLAW_')), 'positive control: the Gateway env has host settings');
  assert.equal(host.OPENCLAW_GATEWAY_TOKEN, 'T', 'positive control: and the token');
  assert.deepEqual(Object.keys(own).filter((k) => k.startsWith('OPENCLAW_')), [], 'no host setting and no token');
  assert.equal(own.OPENROUTER_API_KEY, 'FROMFILE', 'the key keeps the name the Gateway gets');
  assert.equal(own.CLO_QQ_APP_ID, 'APP');
  assert.equal(own.CLO_QQ_APP_SECRET, 'SECRET');
  assert.equal(own.CLO_EFFECTIVE_PATH, ctx.paths.effectiveJson);
  for (const k of ['CLO_TEST_ROOT', 'CLO_TEST_CRASH_AT', 'CLO_NET_GUARD_LOG']) assert.equal(own[k], parent[k], k);
  for (const k of ['HTTP_PROXY', 'NODE_OPTIONS', 'CLO_CHAT_API_KEY', 'CLO_SEARCH_API_KEY', 'PERPLEXITY_API_KEY', 'USERNAME']) assert.equal(own[k], undefined, k);
  // Everything else is exactly what the Gateway gets.
  const { OPENROUTER_API_KEY: _a, CLO_EFFECTIVE_PATH: _b, ...rest } = own;
  const hostRest = Object.fromEntries(Object.entries(host).filter(([k]) => !k.startsWith('OPENCLAW_') && k !== 'OPENROUTER_API_KEY'));
  assert.deepEqual(rest, hostRest);
  assert.equal(ownEnv(ctx.paths, parent).OPENROUTER_API_KEY, undefined, 'nothing from the parent stands in for the file');
});

test('the bot args: the Gateway node flags, the net guard in test mode, the entry, and nothing that listens', () => {
  const r = makeRoot('ownargs', null);
  roots.push(r);
  const ctx = makeContext({ env: testEnv(r.root), stdout: { write() {} }, stderr: { write() {} } });
  const real = ownArgs(ctx.paths, {});
  assert.deepEqual(real, [...GATEWAY_NODE_FLAGS, botEntry(ctx.paths)]);
  assert.match(botEntry(ctx.paths), /[\\/]src[\\/]bot[\\/]main\.mjs$/);
  const guarded = ownArgs(ctx.paths, { ...ctx.env, CLO_TEST_NODE_IMPORT: NET_GUARD, CLO_TEST_BOT_ENTRY: join(r.root, 'x.mjs') });
  assert.ok(guarded.some((a) => /net-guard\.mjs$/.test(a)), 'test mode loads the net guard');
  assert.equal(guarded.at(-1), join(r.root, 'x.mjs'));
  assert.equal(ownArgs(ctx.paths, { CLO_TEST_BOT_ENTRY: join(r.root, 'x.mjs') }).at(-1), botEntry(ctx.paths), 'outside test mode the entry is fixed');
  assert.deepEqual(forbiddenOwnArgs(real), []);
  assert.deepEqual(forbiddenOwnArgs(['--inspect=0', '--use-env-proxy', '--port', '--max-semi-space-size=8']), ['--inspect=0', '--use-env-proxy', '--port'], 'positive control: the check finds them');
});

test('apply under own writes effective.json and the system prompt, and no host file; openclaw still writes them', async () => {
  const s = await stack('apply');
  assert.equal((await s.run(['apply'])).code, 0);
  assert.equal(effectiveOf(s.root).runtime, 'own');
  assert.ok(readFileSync(join(s.root, '.runtime', 'clo', 'system-prompt.md'), 'utf8').includes('<!-- clo-policy:1 -->'));
  assert.equal(existsSync(openclawJsonOf(s.root)), false, 'no openclaw.json');
  assert.equal(existsSync(join(s.root, '.runtime', 'workspace', 'AGENTS.md')), false, 'no host workspace file');

  setRuntime(s.root, 'openclaw');
  const back = await s.run(['apply']);
  assert.equal(back.code, 0, back.err);
  assert.equal(effectiveOf(s.root).runtime, 'openclaw');
  assert.equal(existsSync(openclawJsonOf(s.root)), true, 'positive control: the host runtime renders its config');
  assert.equal(existsSync(join(s.root, '.runtime', 'workspace', 'AGENTS.md')), true);

  const before = readFileSync(openclawJsonOf(s.root), 'utf8');
  setRuntime(s.root, 'own');
  const own = await s.run(['apply']);
  assert.match(own.out, /不生成 openclaw\.json/);
  assert.equal(readFileSync(openclawJsonOf(s.root), 'utf8'), before, 'a switch to own leaves the host file as it was');
});

test('start, status, second start, stop under own: private Node, allowlisted env, no port, own PID only', { timeout: 120000 }, async () => {
  const s = await stack('start');
  const other = bystander();
  await until(() => alive(other.pid), 'bystander');

  const started = await s.run(['start']);
  assert.equal(started.code, 0, `${started.out}${started.err}`);
  assert.match(started.out, /不监听端口/);
  for (const raw of [FAKE_KEY, FAKE_SECRET]) assert.ok(!`${started.out}${started.err}`.includes(raw), 'printed a secret');
  assert.equal(existsSync(openclawJsonOf(s.root)), false, 'start needed no host config');

  const info = await fakeBot(s.root);
  const rec = readJson(pidFileOf(s.root));
  assert.equal(rec.pid, info.pid);
  assert.equal(rec.runtime, 'own');
  assert.equal(rec.port, null);
  assert.ok(rec.startTime && rec.commandDigest);
  assert.equal(info.execPath.toLowerCase(), NODE.toLowerCase(), 'the private Node');
  assert.equal(info.cwd.toLowerCase(), join(s.root, '.runtime', 'gateway-cwd').toLowerCase(), 'never the project root');
  assert.deepEqual(info.args, [], 'no gateway, port or bind argument');
  assert.ok(info.execArgv.includes('--max-semi-space-size=8'));
  assert.ok(info.execArgv.some((a) => /net-guard\.mjs/.test(a)), 'the net guard is loaded');
  assert.ok(!info.execArgv.some((a) => /inspect|use-env-proxy/.test(a)));
  assert.equal(info.env.OPENROUTER_API_KEY, FAKE_KEY, 'from the temp .env, not the parent');
  assert.equal(info.env.CLO_QQ_APP_SECRET, FAKE_SECRET);
  assert.equal(info.env.CLO_EFFECTIVE_PATH.toLowerCase(), join(s.root, '.runtime', 'clo', 'effective.json').toLowerCase());
  assert.equal(info.env.CLO_TEST_ROOT, s.root);
  for (const k of ['HTTP_PROXY', 'https_proxy', 'NODE_OPTIONS', 'PERPLEXITY_API_KEY', 'CLO_CHAT_API_KEY', 'CLO_SEARCH_API_KEY']) assert.equal(info.env[k], undefined, k);
  assert.deepEqual(Object.keys(info.env).filter((k) => k.startsWith('OPENCLAW_')), []);
  assert.ok(!processInfo(rec.pid).commandLine.includes(FAKE_KEY), 'a secret on the command line');

  const report = JSON.parse((await s.run(['status', '--json'])).out);
  assert.equal(report.pidState, 'running');
  assert.equal(report.runtime, 'own');
  assert.equal(report.pidRuntime, 'own');
  assert.match((await s.run(['status'])).out, /可洛进程：进程 \d+ 在运行/);

  const second = await s.run(['start']);
  assert.equal(second.code, 1);
  assert.match(second.err, /已在运行/);
  assert.equal(readJson(pidFileOf(s.root)).pid, rec.pid);

  const stopped = await s.run(['stop']);
  assert.equal(stopped.code, 0, stopped.err);
  assert.match(stopped.out, /已停止 可洛进程/);
  await until(() => !alive(info.pid), 'the bot to go', 10000);
  assert.equal(existsSync(pidFileOf(s.root)), false);
  assert.equal(alive(other.pid), true, 'another Node process is untouched');
});

test('one consumer: a recorded Gateway blocks an own start, and a recorded bot blocks a Gateway start', { timeout: 180000 }, async () => {
  const s = await stack('cross', { runtime: 'openclaw' });
  const gw = await s.run(['start']);
  assert.equal(gw.code, 0, `${gw.out}${gw.err}`);
  const gwRec = readJson(pidFileOf(s.root));
  assert.equal(gwRec.runtime, 'openclaw', 'positive control: the Gateway is recorded');

  setRuntime(s.root, 'own');
  const blocked = await s.run(['start']);
  assert.equal(blocked.code, 1);
  assert.match(blocked.err, /Gateway（openclaw 运行时，进程 \d+）还在运行/);
  assert.match(blocked.err, /只能有一个消费者/);
  assert.equal(existsSync(join(s.root, 'fake-bot.json')), false, 'no bot was spawned');
  assert.deepEqual(readJson(pidFileOf(s.root)), gwRec, 'the record is unchanged');
  assert.equal(alive(gwRec.pid), true, 'the Gateway is left running');
  const st = (await s.run(['status'])).out;
  assert.match(st, /记录的进程是 openclaw/);
  // The running Gateway reads effective.json for each event, so the switch must not reach it.
  const effBefore = readFileSync(join(s.root, '.runtime', 'clo', 'effective.json'), 'utf8');
  const applyBlocked = await s.run(['apply']);
  assert.equal(applyBlocked.code, 1);
  assert.match(applyBlocked.err, /不能在它运行时把运行时换成 own/);
  assert.equal(readFileSync(join(s.root, '.runtime', 'clo', 'effective.json'), 'utf8'), effBefore, 'effective.json is untouched');
  assert.equal(effectiveOf(s.root).runtime, 'openclaw');
  const cfgBefore = readFileSync(join(s.root, 'config.json'), 'utf8');
  const groupBlocked = await s.run(['group', 'set', '测试群', '--interject', 'on']);
  assert.equal(groupBlocked.code, 1, 'every apply path is guarded, not only clo apply');
  assert.equal(readFileSync(join(s.root, 'config.json'), 'utf8'), cfgBefore, 'refused before config.json was written');
  assert.equal(effectiveOf(s.root).runtime, 'openclaw');

  // stop ends whichever runtime is recorded, then the other one starts.
  assert.equal((await s.run(['stop'])).code, 0);
  assert.equal(alive(gwRec.pid), false);
  const own = await s.run(['start']);
  assert.equal(own.code, 0, `${own.out}${own.err}`);
  const botRec = readJson(pidFileOf(s.root));
  assert.equal(botRec.runtime, 'own');

  setRuntime(s.root, 'openclaw');
  const applied = await s.run(['apply']);
  assert.equal(applied.code, 1);
  assert.match(applied.err, /可洛进程（own 运行时，进程 \d+）还在运行，不能在它运行时把运行时换成 openclaw/);
  assert.equal(effectiveOf(s.root).runtime, 'own');
  assert.equal((await s.run(['mode', 'dry-run'])).code, 1, 'mode dry-run still stops replies first, then reports the refusal');
  assert.equal(effectiveOf(s.root).mode, 'dry-run');
  assert.equal(effectiveOf(s.root).runtime, 'own');
  const blocked2 = await s.run(['start']);
  assert.equal(blocked2.code, 1);
  assert.match(blocked2.err, /可洛进程（own 运行时，进程 \d+）还在运行/);
  assert.equal(readJson(pidFileOf(s.root)).pid, botRec.pid);
  assert.equal(alive(botRec.pid), true);
  assert.equal((await s.run(['stop'])).code, 0);
  // Positive control: with nothing running, the switch applies.
  assert.equal((await s.run(['apply'])).code, 0);
  assert.equal(effectiveOf(s.root).runtime, 'openclaw');
});

test('an own start is refused while another clo start holds the shared lock', { timeout: 60000 }, async () => {
  const s = await stack('lock');
  const ctx = makeContext({ env: testEnv(s.root), stdout: { write() {} }, stderr: { write() {} } });
  const self = processInfo(process.pid);
  mkdirSync(dirname(startLockFile(ctx.paths)), { recursive: true });
  writeFileSync(startLockFile(ctx.paths), JSON.stringify({ pid: process.pid, startTime: self.startTime, token: 'x' }));
  const res = await s.run(['start']);
  assert.equal(res.code, 1);
  assert.match(res.err, /另一个 clo start 正在运行/);
  assert.equal(existsSync(join(s.root, 'fake-bot.json')), false);
  // Positive control: the same start goes through once the lock is gone.
  rmSync(startLockFile(ctx.paths));
  assert.equal((await s.run(['start'])).code, 0);
  assert.equal((await s.run(['stop'])).code, 0);
});

test('an own start refuses while something listens on the Gateway port, and leaves it alone', { timeout: 60000 }, async () => {
  const s = await stack('port');
  const holder = createServer();
  await new Promise((res) => { holder.listen(configOf(s.root).gatewayPort, '127.0.0.1', res); });
  cleanups.push(() => holder.close());
  const res = await s.run(['start']);
  assert.equal(res.code, 1);
  assert.match(res.err, /可能是没有记录的 OpenClaw Gateway/);
  assert.equal(holder.listening, true);
  assert.equal(existsSync(pidFileOf(s.root)), false);
  assert.equal(existsSync(join(s.root, 'fake-bot.json')), false);
  await new Promise((r) => { holder.close(r); });
  assert.equal((await s.run(['start'])).code, 0, 'positive control: with the port free it starts');
  assert.equal((await s.run(['stop'])).code, 0);
});

test('an own start with no bot entry is refused by doctor, and nothing is spawned', { timeout: 60000 }, async () => {
  const s = await stack('noentry');
  const res = await s.run(['start'], { env: { ...s.env, CLO_TEST_BOT_ENTRY: join(s.root, 'missing', 'main.mjs') } });
  assert.equal(res.code, 1);
  assert.match(res.out, /bot_entry/);
  assert.match(res.err, /doctor 没有通过/);
  assert.equal(existsSync(pidFileOf(s.root)), false);
});

test('a bot that dies at once is reported under its own name, and leaves no PID file', { timeout: 60000 }, async () => {
  const s = await stack('dies');
  writeFileSync(join(s.root, 'bot', 'main.mjs'), "console.error('boom'); process.exit(7);");
  const res = await s.run(['start']);
  assert.equal(res.code, 1);
  assert.match(res.err, /可洛进程 启动后立刻退出，退出码 7/);
  assert.equal(existsSync(pidFileOf(s.root)), false);
});

test('one consumer: an untracked bot (fresh lease, live PID, no record) blocks a Gateway start; clo stop asks it to stop; once its lease is gone the Gateway starts (control)', { timeout: 120000 }, async () => {
  const s = await stack('untracked', { runtime: 'openclaw' });
  const orphan = bystander();
  await until(() => alive(orphan.pid), 'the stand-in bot');
  mkdirSync(dirname(dbOf(s.root)), { recursive: true });
  withDb(s.root, (store) => store.setControl(CONSUMER_LEASE_KEY, `${orphan.pid}:orphan-run`, 'bot'));

  const blocked = await s.run(['start']);
  assert.equal(blocked.code, 1);
  assert.match(blocked.err, new RegExp(`可洛进程（进程 ${orphan.pid}）还连着这个 AppID，PID 文件里没有它`));
  assert.match(blocked.err, /只能有一个消费者/);
  assert.equal(existsSync(join(s.root, 'fake-gateway.json')), false, 'no Gateway was spawned');
  assert.equal(existsSync(pidFileOf(s.root)), false);

  const stopped = await s.run(['stop']);
  assert.equal(stopped.code, 0, stopped.err);
  assert.match(stopped.out, /已请它自己停下，没有结束任何进程/);
  withDb(s.root, (store) => assert.equal(store.getControl(STOP_REQUEST_KEY), String(orphan.pid), 'the request names the lease holder'));
  assert.equal(alive(orphan.pid), true, 'no process was signalled');

  // The bot's own stop drops its lease. Then the same start goes through.
  withDb(s.root, (store) => store.delControl(CONSUMER_LEASE_KEY));
  const gw = await s.run(['start']);
  assert.equal(gw.code, 0, `${gw.out}${gw.err}`);
  await until(() => existsSync(join(s.root, 'fake-gateway.json')), 'the Gateway to start');
  const plain = await s.run(['stop']);
  assert.equal(plain.code, 0, plain.err);
  assert.match(plain.out, /已停止 Gateway/);
});

test('clo stop drops the consumer lease of the bot it stopped, and leaves a lease naming another live process alone (control)', { timeout: 120000 }, async () => {
  const s = await stack('lease-release');
  const other = bystander();
  await until(() => alive(other.pid), 'bystander');

  // Control first: the lease names a different live process, so this stop must not touch it.
  assert.equal((await s.run(['start'])).code, 0);
  const first = await fakeBot(s.root);
  withDb(s.root, (store) => {
    store.setControl(CONSUMER_LEASE_KEY, `${other.pid}:other-run`, 'bot');
    store.setControl('heartbeat_at', String(Date.now()), 'heartbeat');
  });
  const one = await s.run(['stop']);
  assert.equal(one.code, 0, one.err);
  await until(() => !alive(first.pid), 'the first bot to go', 10000);
  withDb(s.root, (store) => {
    assert.equal(store.getControl('heartbeat_at'), null, 'the stop did note the bot down');
    assert.equal(store.getControl(CONSUMER_LEASE_KEY), `${other.pid}:other-run`, 'another process\'s lease is left alone');
    store.delControl(CONSUMER_LEASE_KEY);
  });
  assert.equal(alive(other.pid), true, 'the other process is untouched');

  // The bot it stops is killed hard and cannot drop its own lease: clo stop does.
  rmSync(join(s.root, 'fake-bot.json'), { force: true });
  assert.equal((await s.run(['start'])).code, 0);
  const second = await fakeBot(s.root);
  withDb(s.root, (store) => store.setControl(CONSUMER_LEASE_KEY, `${second.pid}:gen-1`, 'bot'));
  const two = await s.run(['stop']);
  assert.equal(two.code, 0, two.err);
  assert.equal(alive(second.pid), false);
  withDb(s.root, (store) => assert.equal(store.getControl(CONSUMER_LEASE_KEY), null, 'the stopped bot\'s lease is gone'));
  assert.equal(alive(other.pid), true);
});
