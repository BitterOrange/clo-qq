// The README's first real step, through the real console and a real Gateway: dry-run, no model lock and no model
// key, then ID capture, group add, owner add, clear. QQ and OpenRouter are loopback mocks; every value is fake.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { osToolEnv } from '../../src/cli/lifecycle.mjs';
import { fullAt, nextId, plain } from '../fixtures/qq-events.mjs';
import { cleanChildEnv } from '../harness/clean-env.mjs';
import { allocPort, GROUP_A, MEMBER, OWNER, pidAlive, readJsonl, until } from '../harness/gateway.mjs';
import { startMockOpenRouter } from '../harness/mock-openrouter.mjs';
import { startMockQq } from '../harness/mock-qq.mjs';
import { APP_ID, baseConfig, clo, configOf, FAKE_KEY, FAKE_SECRET, makeRoot, NET_GUARD, openclawOf, readJson, withDb } from '../unit/_cli-helper.mjs';

let qq;
let model;
let r;
let env;
let gatewayPid;
// The recorded process and every process under it when it was up, each as PID plus start time, so a PID the OS
// later hands to an unrelated process does not count. Stop must leave none of them.
let gatewayRoot;
let gatewayTree = [];
let identifiesAtStart;
// The console's own network calls, so a read that swallows its error is still seen. The Gateway has its own mock.
const consoleFetches = [];
const noNetwork = (url) => {
  consoleFetches.push(String(url));
  throw new Error('this step should make no network call');
};
const run = (argv, opts = {}) => clo(r.root, argv, { env, fetch: noNetwork, ...opts });
const pidFile = () => join(r.root, '.runtime', 'pids', 'gateway.json');
const SYSTEM32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');

// PIDs that hold a listening TCP socket on the port. A listening row has a foreign address of port 0, which reads
// the same whatever language the OS shows its state column in.
function listenerPids(port) {
  const out = spawnSync(join(SYSTEM32, 'NETSTAT.EXE'), ['-ano'], { cwd: tmpdir(), env: cleanChildEnv(), encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(out.status, 0, 'netstat ran');
  const pids = new Set();
  for (const line of out.stdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== 'TCP' || cols.length < 5) continue;
    if (cols[1].endsWith(`:${port}`) && /:0$/.test(cols[2])) pids.add(Number(cols[cols.length - 1]));
  }
  return [...pids];
}

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

// The processes started under pid since it started, with their command lines.
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

// Which of the given processes still run: the same PID with the same start time in a fresh process list.
function stillRunning(procs) {
  const all = processList();
  return procs.filter((p) => all.some((q) => sameProcess(p, q)));
}

// Which of the given processes hold a listening socket on the port. Another test may bind the port once it is
// free, so a listener only counts when it is one of these processes, not merely any process on the port.
function listenersAmong(port, procs) {
  const listening = new Set(listenerPids(port));
  return stillRunning(procs.filter((p) => listening.has(p.pid)));
}

before(async () => {
  qq = await startMockQq();
  model = await startMockOpenRouter();
  const cfg = baseConfig();
  cfg.gatewayPort = await allocPort();
  cfg.openrouter = { baseUrl: model.base };
  cfg.qq.enabled = true;
  cfg.qq.appId = APP_ID;
  cfg.qq.apiBaseUrl = qq.base;
  cfg.qq.tokenBaseUrl = qq.base;
  r = makeRoot('first-run', cfg);
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

test('starts with no model lock and no model key, and connects', { timeout: 300000 }, async () => {
  assert.equal(readJson(join(r.root, 'versions.lock.json')).models?.lock, undefined, 'precondition: nothing is locked');
  const started = await run(['start']);
  assert.equal(started.code, 0, `${started.out}${started.err}`);
  assert.match(started.out, /模式 dry-run/);
  assert.doesNotMatch(started.out, /\d+.\d+ 秒/, 'no connect time is promised: nothing on record backs one');
  assert.equal(existsSync(join(r.root, '.runtime', 'pids', 'start.lock')), false, 'the start lock is released once the start is done');
  const rendered = openclawOf(r.root);
  assert.equal(rendered.agents.defaults.model, undefined, 'no model is rendered before the lock');
  assert.equal(rendered.models.providers, undefined);
  await until(() => {
    const snapshot = withDb(r.root, (store) => store.statusSnapshot());
    return snapshot.connected && snapshot.heartbeatAt;
  }, 'the Gateway to connect and beat', 240000);
  const report = JSON.parse((await run(['status', '--json'])).out);
  assert.equal(report.pidState, 'running');
  assert.equal(report.alive, true);
  assert.equal(report.db.connected, true);
  assert.equal(qq.peak(), 1);
  const bot = withDb(r.root, (store) => store.getControl('ready_username'));
  assert.equal(bot, 'mock-bot', 'the identity check in the README has something to show');
  const rec = readJson(pidFile());
  gatewayPid = rec.pid;
  // The recorded PID is the Gateway itself, not a launcher whose child does the work: it holds the Gateway port,
  // and nothing under it runs the same command line.
  assert.deepEqual(listenerPids(rec.port), [rec.pid], 'the recorded process alone listens on the Gateway port');
  const { root, tree } = processTree(rec.pid);
  assert.ok(root.cmd?.includes('gateway run'), 'positive control: the command line was readable');
  assert.deepEqual(tree.filter((p) => p.cmd === root.cmd).map((p) => p.pid), [], 'no child relaunched with the same command line');
  gatewayRoot = root;
  gatewayTree = tree;
  identifiesAtStart = qq.identifies.length;
});

test('capture: arm, a message from a group not yet admitted, list masked and revealed', { timeout: 120000 }, async () => {
  // Before arming: dropped at admission with no row, and nothing is recorded. The log line shows it did arrive.
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
  const dump = readFileSync(withDbPath(), null);
  assert.ok(!dump.includes('请记录这条'), 'capture keeps no message text');
});

const withDbPath = () => join(r.root, '.runtime', 'clo', 'clo.db');

test('group add, owner add and clear, as the README lists them; the running Gateway reads the new group', { timeout: 120000 }, async () => {
  const added = await run(['group', 'add', '测试群', '--id', GROUP_A]);
  assert.equal(added.code, 0, added.err);
  const owner = await run(['owner', 'add', '测试群', '--id', OWNER]);
  assert.equal(owner.code, 0, owner.err);
  const cleared = await run(['targets', 'clear']);
  assert.equal(cleared.code, 0, cleared.err);
  assert.match((await run(['targets', 'list'])).out, /还没有采集到 ID/);
  const cfg = configOf(r.root);
  assert.deepEqual(cfg.qq.allowedGroupIds, [GROUP_A]);
  assert.deepEqual(cfg.qq.owner.groupMember[GROUP_A], [OWNER]);
  assert.equal(cfg.mode, 'dry-run');

  // No restart. A real @ in the admitted group is classified and goes no further.
  const id = nextId();
  qq.push(...fullAt('现在算准入了吗', { id, group: GROUP_A, member: MEMBER }));
  const row = await until(() => withDb(r.root, (store) => {
    const found = store.q('SELECT state, reason FROM events WHERE event_key=?').get(store.key(id));
    return found?.state === 'dry_run' ? found : null;
  }), 'the @ to be classified', 60000);
  assert.equal(row.reason, 'would_at');
  assert.equal(readJson(pidFile()).pid, gatewayPid, 'the same Gateway process');
  assert.ok(pidAlive(gatewayPid));
  assert.equal(qq.identifies.length, identifiesAtStart, 'and the same QQ session: it never reconnected');
});

test('the whole step used no model, no Key read, no catalog read and no send', () => {
  assert.equal(model.requests.length, 0, 'no model call');
  assert.deepEqual(model.other, [], 'no Key or catalog read by the Gateway');
  assert.deepEqual(consoleFetches, [], 'and none by the console, even one that swallows its error');
  assert.equal(qq.messagePosts().length, 0, 'nothing sent to QQ');
  assert.equal(withDb(r.root, (store) => store.q('SELECT COUNT(*) AS n FROM reservations').get().n), 0);
  assert.ok(qq.identifies.length >= 1, 'positive control: the Gateway did talk to the mock QQ');
});

test('stop ends it, the socket closes, and nothing is left running or outside the guard', { timeout: 120000 }, async (t) => {
  const rec = readJson(pidFile());
  assert.ok(pidAlive(rec.pid), 'positive control: it was running');
  assert.ok(gatewayRoot, 'the start step captured the Gateway process');
  assert.equal(gatewayRoot.pid, rec.pid, 'the captured process is the recorded one');
  const captured = [gatewayRoot, ...gatewayTree];
  t.diagnostic(`captured the Gateway and ${gatewayTree.length} descendant(s)`);
  // Positive controls for the same checks run after stop: the captured Gateway is found by PID plus start time,
  // and it is the listener on its port.
  assert.deepEqual(stillRunning([gatewayRoot]).map((p) => p.pid), [rec.pid], 'positive control: the snapshot finds the running Gateway');
  assert.deepEqual(listenersAmong(rec.port, captured).map((p) => p.pid), [rec.pid], 'positive control: the Gateway is seen listening');
  const stopped = await run(['stop']);
  assert.equal(stopped.code, 0, stopped.err);
  assert.equal(pidAlive(rec.pid), false);
  assert.deepEqual(stillRunning(captured).map((p) => p.pid), [], 'nothing that start left running survives stop');
  assert.deepEqual(listenersAmong(rec.port, captured).map((p) => p.pid), [], 'and none of it listens on the port');
  assert.equal(existsSync(pidFile()), false);
  assert.equal(withDb(r.root, (store) => store.getControl('heartbeat_at')), null, 'a stopped Gateway leaves no heartbeat to read as fresh');
  assert.equal(JSON.parse((await run(['status', '--json'])).out).heartbeatFresh, false);
  await until(() => qq.connected() === 0, 'the socket to close', 15000);
  const doctor = await run(['doctor', '--config-only']);
  assert.ok(doctor.out.includes('[通过] render_fresh'), doctor.out);
  const guard = join(r.root, 'net-guard.jsonl');
  const hosts = existsSync(guard) ? readFileSync(guard, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).host) : [];
  assert.deepEqual(hosts.filter((h) => h !== 'clawhub.ai'), []);
  const log = readFileSync(join(r.root, '.runtime', 'logs', 'gateway.log'), 'utf8');
  for (const raw of [FAKE_KEY, FAKE_SECRET]) assert.ok(!log.includes(raw), 'a secret in the log');
});
