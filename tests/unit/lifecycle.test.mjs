// Start, stop and status with a stand-in Gateway and project-owned PIDs. The last test uses the real
// Gateway against loopback mocks. Nothing here can reach QQ or OpenRouter; other Node processes must survive.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { digestOf, duplicateEnvNames, duplicateLinesHint, gatewayEnv, inspectGateway, lookupProcess, oldLinesHint, parseEnvFile, inspectStartLock, processInfo, readPidRecord, renamedEnvNames, startGateway, startLockFile, stopGateway, withStartLock } from '../../src/cli/lifecycle.mjs';
import { makeContext } from '../../src/cli/common.mjs';
import { cleanChildEnv } from '../harness/clean-env.mjs';
import { APP_ID, baseConfig, clo, configOf, enabledConfig, fakeProvider, FAKE_KEY, FAKE_SECRET, makeRoot, NET_GUARD, NODE, readJson, ROOT, testEnv, withDb } from './_cli-helper.mjs';

const roots = [];
const cleanups = [];
after(() => {
  for (const fn of cleanups) {
    try { fn(); } catch { /* best effort */ }
  }
  roots.forEach((r) => r.cleanup());
});

const OLD_NAME_VALUE = 'sk-or-v1-OLD-NAME-VALUE-MUST-NOT-BE-USED';
const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
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

// Answers `plugins inspect` the way the host does, and otherwise stays up with a child, like a launcher.
const FAKE_HOST = `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args[0] === 'plugins') {
  console.log(JSON.stringify({ plugin: { status: 'loaded' }, typedHooks: [{ name: 'before_agent_run' }, { name: 'before_prompt_build' }, { name: 'before_tool_call' }], policy: { allowConversationAccess: true } }));
  process.exit(0);
}
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: process.cwd(), env: { SystemRoot: process.env.SystemRoot }, stdio: 'ignore', windowsHide: true });
writeFileSync(join(process.env.CLO_TEST_ROOT, 'fake-gateway.json'), JSON.stringify({ pid: process.pid, childPid: child.pid, cwd: process.cwd(), args, execPath: process.execPath, env: process.env }));
console.log('fake gateway up');
setInterval(() => {}, 1000);
`;
const FAKE_FAILS = "console.error('boom'); process.exit(9);";

async function freePort() {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

async function stack(label, { config = enabledConfig(), host = FAKE_HOST, extraEnv = {} } = {}) {
  const r = makeRoot(label, config);
  roots.push(r);
  const hostFile = join(r.root, 'fake-host.mjs');
  writeFileSync(hostFile, host);
  const cfg = configOf(r.root);
  cfg.gatewayPort = await freePort();
  writeFileSync(join(r.root, 'config.json'), JSON.stringify(cfg, null, 2));
  const env = {
    CLO_TEST_NODE_IMPORT: NET_GUARD,
    CLO_TEST_GATEWAY_ENTRY: hostFile,
    CLO_NET_GUARD_LOG: join(r.root, 'net-guard.jsonl'),
    // A hostile parent: none of these may reach the child.
    HTTP_PROXY: 'http://127.0.0.1:1',
    https_proxy: 'http://127.0.0.1:1',
    OPENROUTER_API_KEY: 'PARENT-KEY-MUST-NOT-PASS',
    CLO_CHAT_API_KEY: 'PARENT-KEY-MUST-NOT-PASS',
    CLO_SEARCH_API_KEY: 'PARENT-KEY-MUST-NOT-PASS',
    PERPLEXITY_API_KEY: 'PARENT-KEY-MUST-NOT-PASS',
    ...extraEnv,
  };
  const run = (argv, opts = {}) => clo(r.root, argv, { env, ...opts });
  assert.equal((await run(['model', 'refresh'], { fetch: fakeProvider().fetch })).code, 0);
  cleanups.push(() => {
    const rec = readPidRecord(makeContext({ env: testEnv(r.root), stdout: { write() {} }, stderr: { write() {} } }).paths);
    if (rec) spawnSync('taskkill', ['/PID', String(rec.pid), '/T', '/F'], { cwd: tmpdir(), env: cleanChildEnv(), windowsHide: true });
  });
  return { root: r.root, run, env };
}

const pidFileOf = (root) => join(root, '.runtime', 'pids', 'gateway.json');
const fakeInfo = (root) => until(() => existsSync(join(root, 'fake-gateway.json')) && readJson(join(root, 'fake-gateway.json')), 'fake gateway to report');

// A Node process this test owns, to prove stop leaves others alone.
function bystander() {
  const child = spawn(NODE, ['-e', 'setInterval(() => {}, 1000)'], { cwd: tmpdir(), env: cleanChildEnv(), stdio: 'ignore', windowsHide: true });
  cleanups.push(() => child.kill());
  return child;
}

test('parseEnvFile reads named keys only, with quotes, BOM and CRLF, and survives a missing file', () => {
  const r = makeRoot('env', null);
  roots.push(r);
  const f = join(r.root, 'x.env');
  writeFileSync(f, `\uFEFF# comment\r\nCLO_QQ_APP_ID="abc"\r\nCLO_QQ_APP_SECRET='s p'\r\nCLO_CHAT_API_KEY= k \r\nOPENROUTER_API_KEY=old\r\nOTHER_SECRET=nope\r\nCLO_SEARCH_API_KEY=nope\r\nCLO_SEARCH_OPENROUTER_KEY=old\r\nHTTP_PROXY=nope\r\n`);
  assert.deepEqual(parseEnvFile(f), { CLO_QQ_APP_ID: 'abc', CLO_QQ_APP_SECRET: 's p', CLO_CHAT_API_KEY: 'k' });
  assert.deepEqual(renamedEnvNames(f).sort(), ['CLO_SEARCH_OPENROUTER_KEY', 'OPENROUTER_API_KEY'], 'old names are found, and only their names come back');
  writeFileSync(f, 'OPENROUTER_API_KEY=\nCLO_SEARCH_OPENROUTER_KEY=\n');
  assert.deepEqual(renamedEnvNames(f), [], 'an empty old line holds nothing to move');
  assert.deepEqual(parseEnvFile(join(r.root, 'none.env')), {});
});

test('the Gateway env is an allowlist: no proxy, no parent key, only what .env gave', () => {
  const r = makeRoot('allow', null);
  roots.push(r);
  const ctx = makeContext({ env: testEnv(r.root), stdout: { write() {} }, stderr: { write() {} } });
  const parent = { ...ctx.env, HTTP_PROXY: 'x', NODE_OPTIONS: '--require=x', OPENROUTER_API_KEY: 'PARENT', CLO_CHAT_API_KEY: 'PARENT', CLO_SEARCH_API_KEY: 'PARENT', CLO_QQ_APP_SECRET: 'PARENT', PERPLEXITY_API_KEY: 'x', USERNAME: 'someone', RANDOM_VAR: 'x' };
  const child = gatewayEnv(ctx.paths, parent, { secrets: { CLO_CHAT_API_KEY: 'FROMFILE' }, token: 'T' });
  assert.equal(child.OPENROUTER_API_KEY, 'FROMFILE', 'the file name is handed on under the host name');
  assert.equal(child.CLO_CHAT_API_KEY, undefined);
  assert.equal(child.CLO_SEARCH_API_KEY, undefined);
  assert.equal(gatewayEnv(ctx.paths, parent, { secrets: { OPENROUTER_API_KEY: 'OLDNAME' }, token: 'T' }).OPENROUTER_API_KEY, undefined, 'the old name is not a way in');
  assert.equal(gatewayEnv(ctx.paths, parent, { token: 'T' }).OPENROUTER_API_KEY, undefined, 'nothing from the parent stands in for the file');
  assert.equal(child.OPENCLAW_GATEWAY_TOKEN, 'T');
  for (const k of ['HTTP_PROXY', 'NODE_OPTIONS', 'CLO_QQ_APP_SECRET', 'PERPLEXITY_API_KEY', 'USERNAME', 'RANDOM_VAR']) assert.equal(child[k], undefined, k);
  assert.ok(child.USERPROFILE.startsWith(r.root));
  assert.ok(child.OPENCLAW_STATE_DIR.startsWith(r.root));
  assert.ok(!child.PATH.toLowerCase().includes('nodejs'), 'the system Node is not on PATH');
});

test('start, status, a second start, stop: own PID only, secrets by env, bystander unharmed', { timeout: 180000 }, async () => {
  const s = await stack('start');
  const other = bystander();
  await until(() => alive(other.pid), 'bystander');

  const started = await s.run(['start']);
  assert.equal(started.code, 0, `${started.out}${started.err}`);
  for (const raw of [FAKE_KEY, FAKE_SECRET]) assert.ok(!`${started.out}${started.err}`.includes(raw), 'printed a secret');

  const info = await fakeInfo(s.root);
  const rec = readJson(pidFileOf(s.root));
  assert.equal(rec.pid, info.pid);
  assert.ok(rec.startTime);
  assert.ok(rec.commandDigest);

  assert.equal(info.cwd.toLowerCase(), join(s.root, '.runtime', 'gateway-cwd').toLowerCase(), 'never the project root');
  assert.equal(info.execPath.toLowerCase(), NODE.toLowerCase(), 'the private Node');
  assert.deepEqual(info.args.slice(0, 2), ['gateway', 'run']);
  assert.ok(info.args.includes('loopback'));
  assert.equal(info.env.CLO_QQ_APP_SECRET, FAKE_SECRET);
  assert.equal(info.env.OPENROUTER_API_KEY, FAKE_KEY, 'from the temp .env, not the parent');
  assert.ok(info.env.OPENCLAW_GATEWAY_TOKEN?.length >= 32);
  for (const k of ['HTTP_PROXY', 'https_proxy', 'PERPLEXITY_API_KEY', 'NODE_OPTIONS', 'CLO_CHAT_API_KEY', 'CLO_SEARCH_API_KEY']) assert.equal(info.env[k], undefined, k);

  const cmd = processInfo(rec.pid).commandLine;
  for (const raw of [FAKE_KEY, FAKE_SECRET, info.env.OPENCLAW_GATEWAY_TOKEN]) assert.ok(!cmd.includes(raw), 'a secret on the command line');
  // No console window for the Gateway: no main window handle at all.
  const handle = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${rec.pid}).MainWindowHandle.ToInt64()`], { cwd: tmpdir(), env: cleanChildEnv({ PSModulePath: process.env.PSModulePath }), encoding: 'utf8', windowsHide: true });
  assert.equal(handle.stdout.trim(), '0', 'the Gateway has a visible window');

  const tokenFile = readFileSync(join(s.root, '.runtime', 'clo', 'gateway.token'), 'utf8');
  assert.ok(!started.out.includes(tokenFile), 'token not printed');

  // Alive needs both the PID and a fresh heartbeat.
  let status = await s.run(['status', '--json']);
  let report = JSON.parse(status.out);
  assert.equal(report.pidState, 'running');
  assert.equal(report.alive, false, 'no heartbeat yet');
  withDb(s.root, (store) => {
    store.setControl('heartbeat_at', Date.now(), 'test');
    store.setControl('connected', 'true', 'test');
  });
  status = await s.run(['status', '--json']);
  report = JSON.parse(status.out);
  assert.equal(report.alive, true);
  assert.equal(report.db.connected, true);

  const second = await s.run(['start']);
  assert.equal(second.code, 1);
  assert.match(second.err, /已在运行/);
  assert.equal(readJson(pidFileOf(s.root)).pid, rec.pid, 'the record is unchanged');

  const stopped = await s.run(['stop']);
  assert.equal(stopped.code, 0, stopped.err);
  assert.equal(alive(info.pid), false, 'the Gateway is gone');
  await until(() => !alive(info.childPid), 'the launcher child to go', 10000);
  assert.equal(existsSync(pidFileOf(s.root)), false);
  assert.equal(alive(other.pid), true, 'another Node process is untouched');
  assert.equal(withDb(s.root, (store) => store.getControl('connected')), 'false');

  const again = await s.run(['stop']);
  assert.equal(again.code, 0);
  assert.match(again.out, /没有 PID 文件/);
  const after_ = JSON.parse((await s.run(['status', '--json'])).out);
  assert.equal(after_.pidState, 'none');
  assert.equal(after_.alive, false);
});

test('stop refuses a reused PID: a process with the wrong identity is left alive', { timeout: 60000 }, async () => {
  const s = await stack('reuse');
  const other = bystander();
  await until(() => alive(other.pid), 'bystander');
  const info = processInfo(other.pid);
  mkdirSync(dirname(pidFileOf(s.root)), { recursive: true });

  writeFileSync(pidFileOf(s.root), JSON.stringify({ pid: other.pid, startTime: info.startTime, commandDigest: 'not-the-same' }));
  let res = await s.run(['stop']);
  assert.equal(res.code, 1);
  assert.match(res.out, /没有动它/);
  assert.equal(alive(other.pid), true);
  assert.equal(existsSync(pidFileOf(s.root)), false);

  writeFileSync(pidFileOf(s.root), JSON.stringify({ pid: other.pid, startTime: '2001-01-01T00:00:00.0000000Z', commandDigest: 'x' }));
  res = await s.run(['stop']);
  assert.equal(res.code, 1);
  assert.equal(alive(other.pid), true, 'the wrong start time is refused too');

  writeFileSync(pidFileOf(s.root), 'garbage');
  assert.equal((await s.run(['stop'])).code, 0, 'an unreadable record kills nothing');
  assert.equal(alive(other.pid), true);
});

test('a dead PID record is cleaned up, and start then works', { timeout: 90000 }, async () => {
  const s = await stack('stale');
  const gone = spawn(NODE, ['-e', ''], { cwd: tmpdir(), env: cleanChildEnv(), stdio: 'ignore', windowsHide: true });
  await new Promise((res) => gone.on('exit', res));
  mkdirSync(dirname(pidFileOf(s.root)), { recursive: true });
  writeFileSync(pidFileOf(s.root), JSON.stringify({ pid: gone.pid, startTime: 'x', commandDigest: 'x' }));
  assert.equal(JSON.parse((await s.run(['status', '--json'])).out).pidState, 'gone');
  const started = await s.run(['start']);
  assert.equal(started.code, 0, `${started.out}${started.err}`);
  assert.notEqual(readJson(pidFileOf(s.root)).pid, gone.pid);
  assert.equal((await s.run(['stop'])).code, 0);
});

test('start refuses when doctor fails, and nothing is spawned', { timeout: 60000 }, async () => {
  const s = await stack('doctorfail', { host: FAKE_HOST.replace("{ name: 'before_agent_run' }, ", '') });
  const res = await s.run(['start']);
  assert.equal(res.code, 1);
  assert.match(res.out, /hook_registered/);
  assert.match(res.err, /doctor 没有通过/);
  assert.equal(existsSync(pidFileOf(s.root)), false);
  assert.equal(existsSync(join(s.root, 'fake-gateway.json')), false);
});

test('start reports a Gateway that dies at once, and leaves no PID file', { timeout: 60000 }, async () => {
  const s = await stack('dies', { host: `const a = process.argv.slice(2); if (a[0] === 'plugins') { ${FAKE_HOST.split('\n').find((l) => l.includes('console.log(JSON'))}; process.exit(0); } ${FAKE_FAILS}` });
  const res = await s.run(['start']);
  assert.equal(res.code, 1);
  assert.match(res.err, /退出码 9/);
  assert.equal(existsSync(pidFileOf(s.root)), false);
});

test('start refuses missing secrets by name, without printing any value', { timeout: 60000 }, async () => {
  const s = await stack('nosecret');
  writeFileSync(join(s.root, '.env'), `CLO_QQ_APP_ID=${APP_ID}\n`);
  const res = await s.run(['start']);
  assert.equal(res.code, 1);
  assert.match(res.err, /CLO_QQ_APP_SECRET/);
  writeFileSync(join(s.root, '.env'), `CLO_QQ_APP_ID=SOMEOTHERAPP\nCLO_QQ_APP_SECRET=${FAKE_SECRET}\n`);
  const mismatch = await s.run(['start']);
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.err, /不一致/);
  assert.ok(!mismatch.err.includes(APP_ID) && !mismatch.err.includes('SOMEOTHERAPP') && !mismatch.err.includes(FAKE_SECRET));
  assert.equal(existsSync(pidFileOf(s.root)), false);
});

test('dry-run needs no OpenRouter key, and passes none on, whatever old line is left in .env', { timeout: 60000 }, async () => {
  const s = await stack('nokey');
  writeFileSync(join(s.root, '.env'), `CLO_QQ_APP_ID=${APP_ID}\nCLO_QQ_APP_SECRET=${FAKE_SECRET}\nOPENROUTER_API_KEY=${OLD_NAME_VALUE}\nCLO_SEARCH_OPENROUTER_KEY=${OLD_NAME_VALUE}\nCLO_SEARCH_API_KEY=${OLD_NAME_VALUE}\n`);
  const res = await s.run(['start']);
  assert.equal(res.code, 0, `${res.out}${res.err}`);
  assert.match(res.out, /OPENROUTER_API_KEY 已不再读取，请把这一行改名为 CLO_CHAT_API_KEY/, 'start says the line is ignored');
  assert.ok(!`${res.out}${res.err}`.includes(OLD_NAME_VALUE), 'printed the old value');
  const info = await fakeInfo(s.root);
  for (const k of ['OPENROUTER_API_KEY', 'CLO_CHAT_API_KEY', 'CLO_SEARCH_API_KEY', 'CLO_SEARCH_OPENROUTER_KEY']) assert.equal(info.env[k], undefined, k);
  assert.equal((await s.run(['stop'])).code, 0);
});

test('a clean .env starts with no reminder about its lines', { timeout: 60000 }, async () => {
  const s = await stack('cleanenv');
  writeFileSync(join(s.root, '.env'), `CLO_QQ_APP_ID=${APP_ID}\nCLO_QQ_APP_SECRET=${FAKE_SECRET}\n`);
  const res = await s.run(['start']);
  assert.equal(res.code, 0, `${res.out}${res.err}`);
  assert.doesNotMatch(res.out, /已不再读取|不止一行/);
  assert.equal((await s.run(['stop'])).code, 0);
});

test('old line next to a filled new name: the advice is to delete it, and following a rename anyway is reported', () => {
  const r = makeRoot('oldhint', null);
  roots.push(r);
  const f = join(r.root, 'x.env');
  writeFileSync(f, `CLO_CHAT_API_KEY=${FAKE_KEY}\nOPENROUTER_API_KEY=${OLD_NAME_VALUE}\nCLO_SEARCH_API_KEY=${FAKE_KEY}\nCLO_SEARCH_OPENROUTER_KEY=${OLD_NAME_VALUE}\n`);
  const both = oldLinesHint(f);
  assert.match(both, /OPENROUTER_API_KEY 已不再读取，可以删掉这一行/);
  assert.match(both, /CLO_SEARCH_OPENROUTER_KEY 已不再读取，可以删掉这一行/);
  assert.doesNotMatch(both, /请把这一行改名/);
  assert.ok(!both.includes(OLD_NAME_VALUE) && !both.includes(FAKE_KEY), 'printed a value');

  writeFileSync(f, `CLO_CHAT_API_KEY=\nOPENROUTER_API_KEY=${OLD_NAME_VALUE}\n`);
  assert.match(oldLinesHint(f), /请把这一行改名为 CLO_CHAT_API_KEY/, 'an empty new line is not a value');
  assert.equal(duplicateLinesHint(f), '', 'one filled line is not a duplicate');

  writeFileSync(f, `CLO_CHAT_API_KEY=${FAKE_KEY}\nCLO_CHAT_API_KEY=${OLD_NAME_VALUE}\nOTHER=a\nOTHER=b\nCLO_QQ_APP_ID=x\n`);
  assert.equal(parseEnvFile(f).CLO_CHAT_API_KEY, OLD_NAME_VALUE, 'the last line wins, which is why this is worth a warning');
  assert.deepEqual(duplicateEnvNames(f), ['CLO_CHAT_API_KEY'], 'only names this project knows');
  assert.match(duplicateLinesHint(f), /CLO_CHAT_API_KEY 写了不止一行/);
  assert.ok(!duplicateLinesHint(f).includes(OLD_NAME_VALUE) && !duplicateLinesHint(f).includes(FAKE_KEY), 'printed a value');
  assert.equal(oldLinesHint(join(r.root, 'none.env')), '');
  assert.equal(duplicateLinesHint(join(r.root, 'none.env')), '');
});

test('live refuses to start on a .env with only the old key name, names the new one and prints no value', { timeout: 60000 }, async () => {
  const s = await stack('oldname');
  const file = join(s.root, 'config.json');
  writeFileSync(file, JSON.stringify({ ...configOf(s.root), mode: 'live' }));
  writeFileSync(join(s.root, '.env'), `CLO_QQ_APP_ID=${APP_ID}\nCLO_QQ_APP_SECRET=${FAKE_SECRET}\nOPENROUTER_API_KEY=${OLD_NAME_VALUE}\n`);
  const res = await s.run(['start']);
  assert.equal(res.code, 1);
  assert.match(res.err, /缺少：CLO_CHAT_API_KEY/);
  assert.match(res.err, /OPENROUTER_API_KEY 已不再读取，请把这一行改名为 CLO_CHAT_API_KEY/);
  assert.ok(!`${res.out}${res.err}`.includes(OLD_NAME_VALUE), 'printed the old value');
  assert.equal(existsSync(pidFileOf(s.root)), false);
  assert.equal(existsSync(join(s.root, 'fake-gateway.json')), false);

  // The parent of stack() holds OPENROUTER_API_KEY and CLO_CHAT_API_KEY. Neither stands in for the file.
  writeFileSync(join(s.root, '.env'), `CLO_QQ_APP_ID=${APP_ID}\nCLO_QQ_APP_SECRET=${FAKE_SECRET}\n`);
  const ambient = await s.run(['start']);
  assert.equal(ambient.code, 1, 'a key in the shell does not count');
  assert.match(ambient.err, /缺少：CLO_CHAT_API_KEY/);
  assert.ok(!ambient.err.includes('已不再读取'), 'no old line, so no rename hint');
  assert.ok(!`${ambient.out}${ambient.err}`.includes('PARENT-KEY'), 'printed the parent value');
  assert.equal(existsSync(pidFileOf(s.root)), false);
});

test('the new name wins over a leftover old line in the key the Gateway gets', () => {
  const r = makeRoot('bothnames', null);
  roots.push(r);
  const ctx = makeContext({ env: testEnv(r.root), stdout: { write() {} }, stderr: { write() {} } });
  writeFileSync(ctx.paths.envFile, `OPENROUTER_API_KEY=${OLD_NAME_VALUE}\nCLO_CHAT_API_KEY=${FAKE_KEY}\n`);
  const child = gatewayEnv(ctx.paths, ctx.env, { secrets: parseEnvFile(ctx.paths.envFile), token: 'T' });
  assert.equal(child.OPENROUTER_API_KEY, FAKE_KEY);
  assert.ok(!Object.values(child).includes(OLD_NAME_VALUE));
});

test('test mode cannot start without the net guard or against a non-loopback endpoint', { timeout: 60000 }, async () => {
  const s = await stack('wired');
  const noGuard = await clo(s.root, ['start'], { env: { ...s.env, CLO_TEST_NODE_IMPORT: '' } });
  assert.equal(noGuard.code, 1);
  assert.match(noGuard.err, /CLO_TEST_NODE_IMPORT/);

  const file = join(s.root, 'config.json');
  const cfg = configOf(s.root);
  cfg.qq.apiBaseUrl = '';
  cfg.qq.tokenBaseUrl = '';
  writeFileSync(file, JSON.stringify(cfg));
  const real = await s.run(['start']);
  assert.equal(real.code, 1);
  assert.match(real.err, /loopback/);
  assert.equal(existsSync(join(s.root, 'fake-gateway.json')), false);
});

test('an occupied port is reported, and the process holding it is left alone', { timeout: 60000 }, async () => {
  const s = await stack('port');
  const holder = createServer();
  await new Promise((res) => { holder.listen(configOf(s.root).gatewayPort, '127.0.0.1', res); });
  cleanups.push(() => holder.close());
  const res = await s.run(['start']);
  assert.equal(res.code, 1);
  assert.match(res.err, /已被占用/);
  assert.equal(holder.listening, true);
  assert.equal(existsSync(pidFileOf(s.root)), false);
  holder.close();
});

test('the token is created once and reused', { timeout: 90000 }, async () => {
  const s = await stack('token');
  assert.equal((await s.run(['start'])).code, 0);
  const first = readFileSync(join(s.root, '.runtime', 'clo', 'gateway.token'), 'utf8');
  await s.run(['stop']);
  assert.equal((await s.run(['start'])).code, 0);
  assert.equal(readFileSync(join(s.root, '.runtime', 'clo', 'gateway.token'), 'utf8'), first);
  await s.run(['stop']);
});

function ps(script, args, env) {
  return spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-File', script, ...args], {
    env, encoding: 'utf8', windowsHide: true, timeout: 120000, cwd: tmpdir(),
  });
}

const psEnv = (root, extra = {}) => {
  const keep = {};
  for (const k of ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'PSModulePath', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']) {
    if (process.env[k]) keep[k] = process.env[k];
  }
  return { ...keep, PATH: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'), CLO_TEST_ROOT: root, CLO_TEST_NODE_IMPORT: NET_GUARD, ...extra };
};

test('the PowerShell wrappers carry output and exit codes, with a temp root that has spaces', { timeout: 180000 }, async () => {
  const r = makeRoot('ps', baseConfig());
  roots.push(r);
  const scripts = join(ROOT, 'scripts');
  const env = psEnv(r.root);

  const usage = ps(join(scripts, 'clo.ps1'), [], env);
  assert.equal(usage.status, 0, usage.stderr);
  assert.match(usage.stdout, /用法：clo/, 'UTF-8 survives the pipe');

  const apply = ps(join(scripts, 'clo.ps1'), ['apply'], env);
  assert.equal(apply.status, 0, apply.stderr);
  assert.ok(existsSync(join(r.root, '.runtime', 'clo', 'effective.json')), 'state went to CLO_TEST_ROOT');

  const added = ps(join(scripts, 'clo.ps1'), ['group', 'add', '有 空 格', '--id', 'SPACEDLABELGROUP'], env);
  assert.equal(added.status, 0, added.stderr);
  assert.equal(configOf(r.root).qq.groups.SPACEDLABELGROUP.label, '有 空 格', 'an argument with spaces arrives whole');

  const status = ps(join(scripts, 'status.ps1'), [], env);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /模式：dry-run/);

  const refused = ps(join(scripts, 'clo.ps1'), ['mode', 'live'], env);
  assert.equal(refused.status, 1, 'the refusal reaches the shell');
  assert.match(refused.stdout, /d3：/);

  const doctor = ps(join(scripts, 'doctor.ps1'), ['--config-only'], env);
  assert.match(doctor.stdout, /doctor：/);

  const stop = ps(join(scripts, 'stop.ps1'), [], env);
  assert.equal(stop.status, 0, stop.stderr);
  assert.match(stop.stdout, /没有 PID 文件/);
});

test('start.ps1 returns promptly and leaves the Gateway up after PowerShell exits; stop.ps1 ends it', { timeout: 180000 }, async () => {
  const s = await stack('pswrap');
  const scripts = join(ROOT, 'scripts');
  const env = psEnv(s.root, { CLO_TEST_GATEWAY_ENTRY: join(s.root, 'fake-host.mjs'), CLO_NET_GUARD_LOG: join(s.root, 'net-guard.jsonl') });
  const t0 = Date.now();
  const started = ps(join(scripts, 'start.ps1'), [], env);
  assert.equal(started.status, 0, `${started.stdout}${started.stderr}`);
  assert.equal(started.error, undefined, 'a caller capturing the output must not wait for the Gateway');
  assert.ok(Date.now() - t0 < 60000, 'returned without waiting for the Gateway');
  assert.match(started.stdout, /已启动/, 'the output still reaches the caller');
  const info = await fakeInfo(s.root);
  assert.equal(info.env.CLO_TEST_ROOT, s.root);
  await sleep(1000);
  assert.equal(alive(info.pid), true, 'outlives the shell that started it');
  const status = ps(join(scripts, 'status.ps1'), [], env);
  assert.match(status.stdout, new RegExp(`进程 ${info.pid} 在运行`));
  const second = ps(join(scripts, 'start.ps1'), [], env);
  assert.equal(second.status, 1);
  assert.match(second.stdout, /已在运行/);
  assert.equal(alive(info.pid), true);
  const stopped = ps(join(scripts, 'stop.ps1'), [], env);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(alive(info.pid), false);
  await until(() => !alive(info.childPid), 'the child to go', 10000);
});

test('_env.ps1 clears proxy variables and moves only project state in test mode', { timeout: 60000 }, () => {
  const r = makeRoot('psenv', null);
  roots.push(r);
  const probe = join(r.root, 'probe.ps1');
  writeFileSync(probe, `. '${join(ROOT, 'scripts', '_env.ps1').replace(/'/g, "''")}'\n[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n@{ rt=$Rt; node=$NodeExe; state=$env:OPENCLAW_STATE_DIR; proxy=$env:HTTP_PROXY; lower=$env:all_proxy } | ConvertTo-Json -Compress\n`);
  const res = ps(probe, [], psEnv(r.root, { HTTP_PROXY: 'http://127.0.0.1:1', all_proxy: 'http://127.0.0.1:1' }));
  assert.equal(res.status, 0, res.stderr);
  const v = JSON.parse(res.stdout);
  assert.equal(v.proxy, null);
  assert.equal(v.lower, null);
  assert.equal(v.rt, join(r.root, '.runtime'));
  assert.equal(v.node, NODE);
  assert.ok(v.state.startsWith(r.root));
});

test('the scripts work from a folder whose path has spaces', { timeout: 60000 }, () => {
  const base = mkdtempSync(join(tmpdir(), 'clo-spaced-'));
  cleanups.push(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const repo = join(base, 'my project (copy)');
  for (const d of ['scripts', join('src', 'cli'), join('.runtime', 'node')]) mkdirSync(join(repo, d), { recursive: true });
  for (const f of ['_env.ps1', 'clo.ps1', 'status.ps1']) writeFileSync(join(repo, 'scripts', f), readFileSync(join(ROOT, 'scripts', f)));
  // A hard link, so this needs no copy of the Node binary. Same volume as temp is expected here.
  try {
    linkSync(NODE, join(repo, '.runtime', 'node', 'node.exe'));
  } catch (e) {
    assert.fail(`cannot link the private Node into temp: ${e.code}`);
  }
  writeFileSync(join(repo, 'src', 'cli', 'clo.mjs'), 'console.log(JSON.stringify(process.argv.slice(2))); process.exit(7);\n');
  const env = psEnv(join(base, 'state'));
  const res = ps(join(repo, 'scripts', 'clo.ps1'), ['a b', '--reason', '两个 词'], env);
  assert.equal(res.status, 7, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), ['a b', '--reason', '两个 词']);
  const st = ps(join(repo, 'scripts', 'status.ps1'), ['--json'], env);
  assert.equal(st.status, 7, st.stderr);
  assert.deepEqual(JSON.parse(st.stdout), ['status', '--json']);

  // start goes through Start-Process, whose argument quoting is its own. The test root must arrive too.
  writeFileSync(join(repo, 'src', 'cli', 'clo.mjs'), "import { appendFileSync } from 'node:fs'; const [flag, file, ...rest] = process.argv.slice(2); appendFileSync(file, JSON.stringify({ flag, rest, testRoot: process.env.CLO_TEST_ROOT, hasFile: Boolean(file) })); process.exit(5);");
  writeFileSync(join(repo, 'scripts', 'start.ps1'), readFileSync(join(ROOT, 'scripts', 'start.ps1')));
  const startRes = ps(join(repo, 'scripts', 'start.ps1'), [], env);
  assert.equal(startRes.status, 5, startRes.stderr);
  const seen = JSON.parse(startRes.stdout);
  assert.equal(seen.flag, '--output-file');
  assert.deepEqual(seen.rest, ['start']);
  assert.equal(seen.testRoot, env.CLO_TEST_ROOT, 'Start-Process passes the environment on');
  const viaClo = ps(join(repo, 'scripts', 'clo.ps1'), ['start'], env);
  assert.equal(viaClo.status, 5, 'clo start takes the same path');
});

test('real Gateway against loopback mocks: start, connected, status, stop, no second connection', { timeout: 300000 }, async () => {
  const { startMockQq } = await import('../harness/mock-qq.mjs');
  const { startMockOpenRouter } = await import('../harness/mock-openrouter.mjs');
  const qq = await startMockQq();
  const model = await startMockOpenRouter();
  cleanups.push(() => { qq.stop(); model.stop(); });
  const cfg = enabledConfig();
  cfg.qq.apiBaseUrl = qq.base;
  cfg.qq.tokenBaseUrl = qq.base;
  cfg.openrouter = { baseUrl: model.base };
  const s = await stack('real', { config: cfg, extraEnv: { CLO_TEST_GATEWAY_ENTRY: '' } });
  // Keep the base URLs the helper's refresh left in place, and lock against the mock's address.
  const started = await s.run(['start']);
  assert.equal(started.code, 0, `${started.out}${started.err}`);
  const rec = readJson(pidFileOf(s.root));

  await until(() => {
    const report = withDb(s.root, (store) => store.statusSnapshot());
    return report.connected && report.heartbeatAt;
  }, 'the Gateway to connect and beat', 180000);
  const report = JSON.parse((await s.run(['status', '--json'])).out);
  assert.equal(report.pidState, 'running');
  assert.equal(report.alive, true);
  assert.equal(report.db.connected, true);
  assert.equal(qq.peak(), 1, 'one connection');

  assert.equal((await s.run(['stop'])).code, 0);
  assert.equal(alive(rec.pid), false);
  await until(() => qq.connected() === 0, 'the socket to close', 15000);
  const log = readFileSync(join(s.root, '.runtime', 'logs', 'gateway.log'), 'utf8');
  for (const raw of [FAKE_KEY, FAKE_SECRET]) assert.ok(!log.includes(raw), 'a secret in the gateway log');
  const doctor = await s.run(['doctor', '--config-only']);
  assert.ok(doctor.out.includes('[通过] render_fresh'), `the host rewrote openclaw.json behind us\n${doctor.out}`);
  const guard = join(s.root, 'net-guard.jsonl');
  if (existsSync(guard)) {
    const hosts = readFileSync(guard, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).host);
    assert.deepEqual(hosts.filter((h) => h !== 'clawhub.ai'), [], 'only the known startup lookup was refused');
  }
  await qq.stop();
  await model.stop();
});

test('the test file itself sits in the repo it claims', () => {
  assert.equal(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), ROOT);
});

test('a failed process lookup is not read as gone: the record stays, nothing is signalled, stop and start say so', { timeout: 90000 }, async () => {
  const s = await stack('lookup');
  const other = bystander();
  await until(() => alive(other.pid), 'bystander');
  const info = processInfo(other.pid);
  mkdirSync(dirname(pidFileOf(s.root)), { recursive: true });
  writeFileSync(pidFileOf(s.root), JSON.stringify({ pid: other.pid, startTime: info.startTime, commandDigest: digestOf(info.commandLine), port: 1 }));
  const ctx = makeContext({ env: testEnv(s.root), stdout: { write() {} }, stderr: { write() {} } });
  assert.equal(inspectGateway(ctx.paths, ctx.env).state, 'running', 'positive control: the lookup works');

  const broken = { SystemRoot: join(s.root, 'no-such-windows') };
  assert.equal(lookupProcess(other.pid, broken).outcome, 'unknown');
  assert.equal(inspectGateway(ctx.paths, broken).state, 'unknown');
  const stopped = await s.run(['stop'], { env: { ...s.env, ...broken } });
  assert.equal(stopped.code, 1);
  assert.match(stopped.out, /PID 文件保留/);
  assert.equal(existsSync(pidFileOf(s.root)), true);
  assert.equal(alive(other.pid), true);
  const started = await s.run(['start'], { env: { ...s.env, ...broken } });
  assert.equal(started.code, 1);
  assert.match(started.err, /可能还在运行/);
  assert.equal(existsSync(pidFileOf(s.root)), true, 'start does not forget it either');
  assert.equal(JSON.parse((await s.run(['status', '--json'], { env: { ...s.env, ...broken } })).out).pidState, 'unknown');

  rmSync(pidFileOf(s.root));
  const gone = spawn(NODE, ['-e', ''], { cwd: tmpdir(), env: cleanChildEnv(), stdio: 'ignore', windowsHide: true });
  await new Promise((res) => gone.on('exit', res));
  assert.equal(lookupProcess(gone.pid).outcome, 'gone', 'a process that really ended is gone');
});

test('start kills what it spawned when it cannot record the PID, so nothing is left running with no record', { timeout: 60000 }, async () => {
  const s = await stack('startlookup');
  const ctx = makeContext({ env: { ...testEnv(s.root), ...s.env }, stdout: { write() {} }, stderr: { write() {} } });
  const cfg = configOf(s.root);
  await assert.rejects(startGateway(ctx, cfg, { secrets: {}, lookup: () => null }), /已结束刚启动的进程/);
  assert.equal(existsSync(pidFileOf(s.root)), false);
  const { pid } = await fakeInfo(s.root);
  await until(() => !alive(pid), 'the stand-in to be gone');
});

test('the Gateway is started with the output filter loaded', { timeout: 60000 }, async () => {
  const s = await stack('filterarg');
  assert.equal((await s.run(['start'])).code, 0);
  const rec = readJson(pidFileOf(s.root));
  assert.match(processInfo(rec.pid).commandLine, /host-output-filter\.mjs/);
  assert.equal((await s.run(['stop'])).code, 0);
});

// Lock tests use a bare context: the lock needs only the PID file's folder, the env and a clock.
function lockCtx(label) {
  const dir = mkdtempSync(join(tmpdir(), `clo-lock-${label}-`));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return { paths: { pidFile: join(dir, 'pids', 'gateway.json') }, env: process.env, now: Date.now };
}
function placeLock(ctx, text) {
  mkdirSync(dirname(startLockFile(ctx.paths)), { recursive: true });
  writeFileSync(startLockFile(ctx.paths), text);
}
const SELF_FOUND = { outcome: 'found', info: { startTime: 'self-start', commandLine: 'x' } };
async function endedPid() {
  const gone = spawn(NODE, ['-e', ''], { cwd: tmpdir(), env: cleanChildEnv(), stdio: 'ignore', windowsHide: true });
  await new Promise((res) => gone.on('exit', res));
  return gone.pid;
}

test('a process whose command line the OS withholds is unknown: the record stays and nothing is signalled', { timeout: 90000 }, async () => {
  const s = await stack('cmdline');
  const ctx = makeContext({ env: testEnv(s.root), stdout: { write() {} }, stderr: { write() {} } });
  // The System process is the one every caller can see only partly: a start time and no command line.
  const info = processInfo(4);
  assert.ok(info?.startTime, 'positive control: the start time is readable');
  assert.equal(info.commandLine, null, 'positive control: the command line is withheld');
  mkdirSync(dirname(pidFileOf(s.root)), { recursive: true });

  writeFileSync(pidFileOf(s.root), JSON.stringify({ pid: 4, startTime: info.startTime, commandDigest: 'digest-from-when-it-could-be-read' }));
  const seen = inspectGateway(ctx.paths, ctx.env);
  assert.equal(seen.state, 'unknown');
  assert.equal(seen.cause, 'cmdline_unreadable');
  const stopped = stopGateway(ctx);
  assert.equal(stopped.reason, 'lookup_failed', 'the reason the CLI already handles');
  assert.equal(stopped.cause, 'cmdline_unreadable');
  assert.equal(existsSync(pidFileOf(s.root)), true, 'the record is kept');

  writeFileSync(pidFileOf(s.root), JSON.stringify({ pid: 4, startTime: '2001-01-01T00:00:00.0000000Z', commandDigest: 'x' }));
  assert.equal(inspectGateway(ctx.paths, ctx.env).state, 'mismatch', 'another start time still proves the PID changed hands');
});

test('start lock: runs fn, returns its value, holds the file meanwhile, and releases after a throw too', async () => {
  const ctx = lockCtx('basic');
  const lookup = () => SELF_FOUND;
  const value = await withStartLock(ctx, async () => {
    const rec = readJson(startLockFile(ctx.paths));
    assert.equal(rec.pid, process.pid);
    assert.equal(rec.startTime, 'self-start');
    return 'done';
  }, { lookup });
  assert.equal(value, 'done');
  assert.equal(existsSync(startLockFile(ctx.paths)), false);
  await assert.rejects(withStartLock(ctx, async () => { throw new Error('inner'); }, { lookup }), /inner/);
  assert.equal(existsSync(startLockFile(ctx.paths)), false);
});

test('start lock: a second caller is refused and its fn never runs', async () => {
  const ctx = lockCtx('second');
  const lookup = () => SELF_FOUND;
  let ran = false;
  await withStartLock(ctx, async () => {
    await assert.rejects(withStartLock(ctx, async () => { ran = true; }, { lookup }), /另一个 clo start 正在运行/);
    assert.equal(inspectStartLock(ctx, { lookup }).state, 'held');
    assert.equal(existsSync(startLockFile(ctx.paths)), true, 'the refused caller leaves the lock alone');
  }, { lookup });
  assert.equal(ran, false);
  assert.equal(inspectStartLock(ctx, { lookup }).state, 'free');
});

test('start lock: only a provable end frees it: a gone or reused PID does, an unknown or unreadable holder does not', { timeout: 60000 }, async () => {
  const ctx = lockCtx('stale');
  let ran = 0;
  const enter = async () => { ran += 1; };

  // The real lookup, on a process that really ended.
  placeLock(ctx, JSON.stringify({ pid: await endedPid(), startTime: 'x' }));
  assert.equal(inspectStartLock(ctx).state, 'stale');
  await withStartLock(ctx, enter);
  assert.equal(ran, 1);

  // The real lookup, on a live process with another start time: its PID was reused, and it is left alive.
  const other = bystander();
  await until(() => alive(other.pid), 'bystander');
  placeLock(ctx, JSON.stringify({ pid: other.pid, startTime: '2001-01-01T00:00:00.0000000Z' }));
  await withStartLock(ctx, enter);
  assert.equal(ran, 2);
  assert.equal(alive(other.pid), true);

  // The same process, its start time matching: held.
  placeLock(ctx, JSON.stringify({ pid: other.pid, startTime: processInfo(other.pid).startTime }));
  await assert.rejects(withStartLock(ctx, enter), /另一个 clo start 正在运行/);

  // No start time on record, so a live PID proves nothing.
  placeLock(ctx, JSON.stringify({ pid: other.pid, startTime: null }));
  await assert.rejects(withStartLock(ctx, enter), /另一个 clo start 正在运行/);

  // A lookup that failed says nothing about the holder.
  placeLock(ctx, JSON.stringify({ pid: other.pid, startTime: 'x' }));
  await assert.rejects(withStartLock(ctx, enter, { lookup: () => ({ outcome: 'unknown' }) }), /查不到持有启动锁/);
  assert.equal(existsSync(startLockFile(ctx.paths)), true);

  // A holder may be between creating the file and writing it.
  for (const text of ['', 'garbage', '{"pid":"x"}']) {
    placeLock(ctx, text);
    await assert.rejects(withStartLock(ctx, enter, { lookup: () => SELF_FOUND }), /启动锁读不出内容/);
    assert.equal(readFileSync(startLockFile(ctx.paths), 'utf8'), text);
  }
  assert.equal(ran, 2);
});

test('start lock: a lock that changed after it was judged stale is not removed', async () => {
  const ctx = lockCtx('reclaimrace');
  const fresh = JSON.stringify({ pid: 222, startTime: 'fresh' });
  placeLock(ctx, JSON.stringify({ pid: 111, startTime: 'old' }));
  let swapped = false;
  const lookup = (pid) => {
    if (pid === process.pid) return SELF_FOUND;
    if (pid === 111) {
      // The other start has just reclaimed the same stale lock and taken it.
      if (!swapped) { swapped = true; placeLock(ctx, fresh); }
      return { outcome: 'gone' };
    }
    return { outcome: 'found', info: { startTime: 'fresh', commandLine: 'x' } };
  };
  let ran = false;
  await assert.rejects(withStartLock(ctx, async () => { ran = true; }, { lookup }), /另一个 clo start 正在运行/);
  assert.equal(ran, false);
  assert.equal(readFileSync(startLockFile(ctx.paths), 'utf8'), fresh);
  assert.equal(existsSync(`${startLockFile(ctx.paths)}.reclaim`), false);
});

test('start lock: release leaves a lock that is no longer its own', async () => {
  const ctx = lockCtx('release');
  const other = JSON.stringify({ pid: 222, startTime: 'other' });
  await withStartLock(ctx, async () => { placeLock(ctx, other); }, { lookup: () => SELF_FOUND });
  assert.equal(readFileSync(startLockFile(ctx.paths), 'utf8'), other);
});

test('start lock across real processes: one wins, the rest are refused, and a killed holder can be reclaimed', { timeout: 120000 }, async () => {
  const ctx = lockCtx('procs');
  const dir = dirname(dirname(startLockFile(ctx.paths)));
  const lifecycleUrl = new URL('../../src/cli/lifecycle.mjs', import.meta.url).href;
  const script = `
    import { existsSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { withStartLock } from ${JSON.stringify(lifecycleUrl)};
    const dir = process.argv[1];
    const ctx = { paths: { pidFile: join(dir, 'pids', 'gateway.json') }, env: process.env, now: Date.now };
    try {
      await withStartLock(ctx, async () => {
        writeFileSync(join(dir, 'winner-' + process.pid), '');
        while (!existsSync(join(dir, 'release'))) await new Promise((r) => { setTimeout(r, 50); });
      });
    } catch (e) {
      console.log(e.message);
      process.exit(3);
    }
  `;
  const contender = () => {
    const child = spawn(NODE, ['--input-type=module', '-e', script, dir], { cwd: tmpdir(), env: cleanChildEnv(), stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    cleanups.push(() => child.kill());
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const exit = new Promise((res) => { child.on('exit', (code) => res({ code, out: () => out })); });
    return { child, exit };
  };
  const winners = () => readdirSync(dir).filter((n) => n.startsWith('winner-'));

  const all = [contender(), contender(), contender()];
  await until(() => winners().length > 0, 'a winner', 60000);
  const winnerPid = Number(winners()[0].slice('winner-'.length));
  const losers = all.filter((c) => c.child.pid !== winnerPid);
  assert.equal(losers.length, 2);
  for (const l of losers) {
    const { code, out } = await l.exit;
    assert.equal(code, 3);
    assert.match(out(), /另一个 clo start 正在运行/);
  }
  assert.equal(winners().length, 1);

  // The holder dies without releasing. The next one proves that and takes over.
  all.find((c) => c.child.pid === winnerPid).child.kill();
  await all.find((c) => c.child.pid === winnerPid).exit;
  assert.equal(existsSync(startLockFile(ctx.paths)), true);
  const next = contender();
  await until(() => winners().length === 2, 'the next start to take over', 60000);
  writeFileSync(join(dir, 'release'), '');
  assert.equal((await next.exit).code, 0);
  assert.equal(existsSync(startLockFile(ctx.paths)), false);
});

// Registered before anything is asserted, so a failing run still ends both processes and the test file can exit.
async function cleanUpStandIn(root) {
  const { pid, childPid } = await fakeInfo(root);
  for (const p of [childPid, pid]) cleanups.push(() => spawnSync('taskkill', ['/PID', String(p), '/F'], { cwd: tmpdir(), env: cleanChildEnv(), windowsHide: true }));
  return pid;
}

test('start ends what it spawned when the PID file cannot be written, and reports it', { timeout: 60000 }, async () => {
  const s = await stack('pidwrite');
  const ctx = makeContext({ env: { ...testEnv(s.root), ...s.env }, stdout: { write() {} }, stderr: { write() {} } });
  mkdirSync(pidFileOf(s.root), { recursive: true }); // A folder in its place, so the final rename fails.
  const failure = await startGateway(ctx, configOf(s.root), { secrets: {} }).then(() => null, (e) => e);
  const pid = await cleanUpStandIn(s.root);
  assert.match(String(failure?.message), /写不进 PID 文件.*已结束刚启动的进程/);
  await until(() => !alive(pid), 'the stand-in to be gone');
});

test('start treats a lookup with no command line as no information: it ends the child and writes no record', { timeout: 60000 }, async () => {
  const s = await stack('startnocmd');
  const ctx = makeContext({ env: { ...testEnv(s.root), ...s.env }, stdout: { write() {} }, stderr: { write() {} } });
  const failure = await startGateway(ctx, configOf(s.root), { secrets: {}, lookup: () => ({ startTime: 'x', commandLine: null }) }).then(() => null, (e) => e);
  const pid = await cleanUpStandIn(s.root);
  assert.match(String(failure?.message), /已结束刚启动的进程/);
  assert.equal(existsSync(pidFileOf(s.root)), false);
  await until(() => !alive(pid), 'the stand-in to be gone');
});
