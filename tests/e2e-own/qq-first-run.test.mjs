// The own runtime counterpart of tests/e2e/qq-first-run.test.mjs: the README's first real step through the real
// console and the real bot process, with config.runtime 'own'. Dry-run, no model lock and no model key, then ID capture,
// group add, owner add, clear, stop. QQ and OpenRouter are loopback mocks; every value is fake. Where the original
// checked the Gateway's port and its host files, this checks that the bot listens on no port and writes no host file.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { osToolEnv } from '../../src/cli/lifecycle.mjs';
import { fullAt, nextId, plain } from '../fixtures/qq-events.mjs';
import { allocPort, GROUP_A, MEMBER, OWNER, pidAlive, readJsonl, until } from '../harness/gateway.mjs';
import { startMockOpenRouter } from '../harness/mock-openrouter.mjs';
import { startMockQq } from '../harness/mock-qq.mjs';
import { listeningPids } from '../harness/own.mjs';
import { APP_ID, baseConfig, clo, configOf, FAKE_KEY, FAKE_SECRET, makeRoot, NET_GUARD, readJson, withDb } from '../unit/_cli-helper.mjs';

let qq;
let model;
let r;
let env;
let botPid;
let botRoot;
let botTree = [];
let identifiesAtStart;
const consoleFetches = [];
const noNetwork = (url) => {
  consoleFetches.push(String(url));
  throw new Error('this step should make no network call');
};
const run = (argv, opts = {}) => clo(r.root, argv, { env, fetch: noNetwork, ...opts });
const pidFile = () => join(r.root, '.runtime', 'pids', 'gateway.json');
const dbPath = () => join(r.root, '.runtime', 'clo', 'clo.db');
const SYSTEM32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');

// Every process on the machine, with parent, command line and start time. Read only: nothing is signalled.
function processList() {
  const script = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::UTF8;"
    + 'Get-CimInstance Win32_Process | ForEach-Object { @{ pid=[int]$_.ProcessId; ppid=[int]$_.ParentProcessId; cmd=$_.CommandLine; start=$_.CreationDate.ToUniversalTime().ToString("o") } } | ConvertTo-Json -Compress';
  const out = spawnSync(join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], {
    cwd: tmpdir(), env: osToolEnv(process.env), encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(out.status, 0, 'the process list was read');
  return JSON.parse(out.stdout);
}

function processTree(pid) {
  const all = processList();
  const root = all.find((p) => p.pid === pid);
  assert.ok(root, 'the recorded process is in the list');
  const tree = [];
  const walk = (parent) => {
    for (const p of all) {
      if (p.ppid === parent.pid && p.start >= parent.start && !tree.includes(p)) {
        tree.push(p);
        walk(p);
      }
    }
  };
  walk(root);
  return { root, tree };
}

const sameProcess = (a, b) => a.pid === b.pid && a.start === b.start;
function stillRunning(procs) {
  const all = processList();
  return procs.filter((p) => all.some((q) => sameProcess(p, q)));
}

before(async () => {
  qq = await startMockQq();
  model = await startMockOpenRouter();
  const cfg = baseConfig();
  cfg.runtime = 'own';
  cfg.gatewayPort = await allocPort();
  cfg.openrouter = { baseUrl: model.base };
  cfg.qq.enabled = true;
  cfg.qq.appId = APP_ID;
  cfg.qq.apiBaseUrl = qq.base;
  cfg.qq.tokenBaseUrl = qq.base;
  r = makeRoot('first-run-own', cfg);
  // The README says only live needs the OpenRouter key.
  writeFileSync(join(r.root, '.env'), `CLO_QQ_APP_ID=${APP_ID}\nCLO_QQ_APP_SECRET=${FAKE_SECRET}\n`);
  env = { CLO_TEST_NODE_IMPORT: NET_GUARD, CLO_NET_GUARD_LOG: join(r.root, 'net-guard.jsonl') };
});

after(async () => {
  if (r) {
    await run(['stop']).catch(() => {});
    r.cleanup();
  }
  await qq?.stop();
  await model?.stop();
});

test('starts the bot with no model lock and no model key, and connects', { timeout: 300000 }, async () => {
  assert.equal(readJson(join(r.root, 'versions.lock.json')).models?.lock, undefined, 'precondition: nothing is locked');
  const started = await run(['start']);
  assert.equal(started.code, 0, `${started.out}${started.err}`);
  assert.match(started.out, /模式 dry-run/);
  assert.doesNotMatch(started.out, /\d+.\d+ 秒/, 'no connect time is promised: nothing on record backs one');
  assert.equal(existsSync(join(r.root, '.runtime', 'pids', 'start.lock')), false, 'the start lock is released once the start is done');
  assert.equal(existsSync(join(r.root, '.runtime', 'state', 'openclaw.json')), false, 'no host config is written');
  assert.equal(readJson(join(r.root, '.runtime', 'clo', 'effective.json')).runtime, 'own');
  await until(() => {
    const snapshot = withDb(r.root, (store) => store.statusSnapshot());
    return snapshot.connected && snapshot.heartbeatAt;
  }, 'the bot to connect and beat', 120000);
  const report = JSON.parse((await run(['status', '--json'])).out);
  assert.equal(report.pidState, 'running');
  assert.equal(report.alive, true);
  assert.equal(report.db.connected, true);
  assert.equal(qq.peak(), 1);
  assert.equal(withDb(r.root, (store) => store.getControl('ready_username')), 'mock-bot', 'the identity check in the README has something to show');
  const rec = readJson(pidFile());
  botPid = rec.pid;
  assert.equal(rec.runtime, 'own');
  assert.equal(rec.port, null, 'no port is recorded: the bot listens on none');
  const listening = listeningPids();
  assert.equal(listening.has(rec.pid), false, `the bot listens: ${listening.get(rec.pid)}`);
  assert.ok(listening.has(process.pid), 'positive control: the mocks in the test runner are seen listening');
  const { root, tree } = processTree(rec.pid);
  assert.ok(root.cmd?.includes('main.mjs'), 'positive control: the command line was readable, and it is the bot entry');
  assert.doesNotMatch(root.cmd, /openclaw|gateway run/i, 'not the host');
  assert.deepEqual(tree.map((p) => p.pid), [], 'the bot starts no child process');
  botRoot = root;
  botTree = tree;
  identifiesAtStart = qq.identifies.length;
});

test('capture: arm, a message from a group not yet admitted, list masked and revealed', { timeout: 120000 }, async () => {
  qq.push(...plain('还没开采集', { id: nextId(), group: GROUP_A, member: MEMBER }));
  await until(() => readJsonl(join(r.root, '.runtime', 'logs', 'events.jsonl')).some((e) => e.event === 'gate_drop'), 'the early event to be dropped', 30000);
  assert.match((await run(['targets', 'list'])).out, /还没有采集到 ID/);
  assert.equal(withDb(r.root, (store) => store.q('SELECT COUNT(*) AS n FROM events').get().n), 0);

  const armed = await run(['targets', 'arm', '--minutes', '5']);
  assert.equal(armed.code, 0, armed.err);
  qq.push(...plain('请记录这条', { id: nextId(), group: GROUP_A, member: OWNER }));
  await until(() => withDb(r.root, (store) => store.listDiscovery().length > 0), 'the capture to record', 30000);

  const masked = await run(['targets', 'list']);
  assert.ok(!masked.out.includes(GROUP_A), 'masked by default');
  assert.ok(!masked.out.includes(OWNER));
  const revealed = await run(['targets', 'list', '--reveal']);
  assert.ok(revealed.out.includes(GROUP_A));
  assert.ok(revealed.out.includes(OWNER));
  assert.ok(!readFileSync(dbPath(), null).includes('请记录这条'), 'capture keeps no message text');
});

test('group add, owner add and clear, as the README lists them; the running bot reads the new group', { timeout: 120000 }, async () => {
  assert.equal((await run(['group', 'add', '测试群', '--id', GROUP_A])).code, 0);
  assert.equal((await run(['owner', 'add', '测试群', '--id', OWNER])).code, 0);
  assert.equal((await run(['targets', 'clear'])).code, 0);
  assert.match((await run(['targets', 'list'])).out, /还没有采集到 ID/);
  const cfg = configOf(r.root);
  assert.deepEqual(cfg.qq.allowedGroupIds, [GROUP_A]);
  assert.deepEqual(cfg.qq.owner.groupMember[GROUP_A], [OWNER]);
  assert.equal(cfg.mode, 'dry-run');
  assert.equal(cfg.runtime, 'own', 'the console keeps the runtime');

  // No restart. A real @ in the admitted group is classified and goes no further.
  const id = nextId();
  qq.push(...fullAt('现在算准入了吗', { id, group: GROUP_A, member: MEMBER }));
  const row = await until(() => withDb(r.root, (store) => {
    const found = store.q('SELECT state, reason FROM events WHERE event_key=?').get(store.key(id));
    return found?.state === 'dry_run' ? found : null;
  }), 'the @ to be classified', 60000);
  assert.equal(row.reason, 'would_at');
  assert.equal(readJson(pidFile()).pid, botPid, 'the same bot process');
  assert.ok(pidAlive(botPid));
  assert.equal(qq.identifies.length, identifiesAtStart, 'and the same QQ session: it never reconnected');
});

test('the whole step used no model, no Key read, no catalog read and no send', () => {
  assert.equal(model.requests.length, 0, 'no model call');
  assert.deepEqual(model.other, [], 'no Key or catalog read by the bot');
  assert.deepEqual(consoleFetches, [], 'and none by the console, even one that swallows its error');
  assert.equal(qq.messagePosts().length, 0, 'nothing sent to QQ');
  assert.equal(withDb(r.root, (store) => store.q('SELECT COUNT(*) AS n FROM reservations').get().n), 0);
  assert.ok(qq.identifies.length >= 1, 'positive control: the bot did talk to the mock QQ');
});

test('stop ends it, the socket closes, and nothing is left running or outside the guard', { timeout: 120000 }, async () => {
  const rec = readJson(pidFile());
  assert.ok(pidAlive(rec.pid), 'positive control: it was running');
  assert.ok(botRoot, 'the start step captured the bot process');
  assert.equal(botRoot.pid, rec.pid);
  const captured = [botRoot, ...botTree];
  assert.deepEqual(stillRunning([botRoot]).map((p) => p.pid), [rec.pid], 'positive control: the snapshot finds the running bot');
  const stopped = await run(['stop']);
  assert.equal(stopped.code, 0, stopped.err);
  assert.equal(pidAlive(rec.pid), false);
  assert.deepEqual(stillRunning(captured).map((p) => p.pid), [], 'nothing that start left running survives stop');
  assert.equal(existsSync(pidFile()), false);
  assert.equal(withDb(r.root, (store) => store.getControl('heartbeat_at')), null, 'a stopped bot leaves no heartbeat to read as fresh');
  assert.equal(JSON.parse((await run(['status', '--json'])).out).heartbeatFresh, false);
  await until(() => qq.connected() === 0, 'the socket to close', 15000);
  const doctor = await run(['doctor', '--config-only']);
  // The host's render_fresh check has nothing to check here; the own runtime's checks take its place.
  for (const check of ['effective_runtime', 'system_prompt', 'bot_env', 'bot_entry', 'bot_no_listen']) {
    assert.ok(doctor.out.includes(`[通过] ${check}`), `${check}:\n${doctor.out}`);
  }
  assert.doesNotMatch(doctor.out, /\[(失败|不通过)\]/, doctor.out);
  const guard = join(r.root, 'net-guard.jsonl');
  const hosts = existsSync(guard) ? readFileSync(guard, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).host) : [];
  assert.deepEqual(hosts, [], 'no lookup or connection outside loopback, not even the host\'s clawhub.ai');
  const log = readFileSync(join(r.root, '.runtime', 'logs', 'gateway.log'), 'utf8');
  for (const raw of [FAKE_KEY, FAKE_SECRET]) assert.ok(!log.includes(raw), 'a secret in the log');
});
