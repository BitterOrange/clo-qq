// Spawns the real Gateway in the foreground with the private Node and per-test temp state.
// Business config goes through the same buildEffective and render the console uses.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hmacKey } from '../../src/clo-plugin/lib/core/ids.js';
import { cleanChildEnv } from './clean-env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..');
export const NODE = join(ROOT, '.runtime', 'node', 'node.exe');
export const OPENCLAW = join(ROOT, '.runtime', 'pkg', 'node_modules', 'openclaw', 'openclaw.mjs');
export const PLUGIN_DIR = join(ROOT, 'src', 'clo-plugin');
const NET_GUARD = join(HERE, 'net-guard.mjs');
const OUTPUT_FILTER = join(ROOT, 'src', 'cli', 'host-output-filter.mjs');
const COMPILE_CACHE = join(tmpdir(), 'clo-e2e-compile-cache');
export const FAKE_MODEL_KEY = 'sk-or-v1-FAKE-KEY-FOR-LOCAL-MOCK-ONLY';
export const FAKE_QQ_SECRET = 'FAKE-QQ-SECRET-FOR-LOCAL-MOCK-ONLY';
const FAKE_GATEWAY_TOKEN = 'FAKE-GATEWAY-TOKEN-FOR-LOCAL-MOCK-ONLY';
export const APP_ID = 'FAKEAPPID000111';
export const GROUP_A = 'GROUPAAAA11112222333344445555AAAA';
export const GROUP_B = 'GROUPBBBB11112222333344445555BBBB';
export const OWNER = 'OWNERMEMBER1111222233334444555566';
export const MEMBER = 'PLAINMEMBER1111222233334444555566';
export const MEMBER2 = 'OTHERMEMBER1111222233334444555566';
export const BOT_MEMBER = 'BOTMEMBERID11112222333344445555BB';
export const PRIMARY_ID = 'anthropic/claude-opus-5.5';
export const DECISION_ID = 'anthropic/claude-haiku-5.5';
const MODEL_LOCK = {
  primary: { id: PRIMARY_ID, selector: 'opus-latest', price: { inputPerM: 5, outputPerM: 20, cacheReadPerM: 0.5, cacheWritePerM: 6.25 } },
  decision: { id: DECISION_ID, price: { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, cacheWritePerM: 1.25 } },
};
export const TERMINAL = new Set(['ignored', 'stale', 'merged', 'paused', 'dry_run', 'skipped', 'completed', 'silent',
  'policy_dropped', 'failed', 'restart_dropped', 'crash_unknown']);

// Real caps are unit-tested. A test that is about a cap passes its own `effective`.
const E2E_RELAXED = {
  window: { windowMs: 300 },
  limits: { sendGroupPerMin: 200, sendAccountPerMin: 200, sendAccountPerHour: 2000, perSenderAddressedPerHour: 500, failureLinePerGroupPerHour: 100 },
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(cond, what, timeoutMs = 60000, stepMs = 100) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(stepMs);
  }
}

export function allocPort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

function portOpen(port) {
  return new Promise((res) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      res(true);
    });
    socket.once('error', () => res(false));
  });
}

export function deepMerge(a, b) {
  if (Array.isArray(b) || typeof b !== 'object' || b === null) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = typeof out[k] === 'object' && out[k] !== null && !Array.isArray(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function childEnv(tmp, paths, extra = {}) {
  const keep = {};
  for (const k of ['SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS']) {
    if (process.env[k]) keep[k] = process.env[k];
  }
  // Built from an allowlist, so no proxy variable or real key in the parent can reach the child.
  return {
    ...keep,
    PATH: `${dirname(NODE)};${process.env.SystemRoot ?? 'C:\\Windows'}\\System32`,
    HOME: paths.home,
    USERPROFILE: paths.home,
    APPDATA: join(tmp, 'appdata', 'Roaming'),
    LOCALAPPDATA: join(tmp, 'appdata', 'Local'),
    TEMP: join(tmp, 'temp'),
    TMP: join(tmp, 'temp'),
    OPENCLAW_HOME: paths.home,
    OPENCLAW_STATE_DIR: paths.stateDir,
    OPENCLAW_CONFIG_PATH: paths.openclawJson,
    OPENCLAW_WORKSPACE_DIR: paths.workspace,
    OPENCLAW_GATEWAY_TOKEN: FAKE_GATEWAY_TOKEN,
    OPENCLAW_NO_AUTO_UPDATE: '1',
    OPENCLAW_DISABLE_BONJOUR: '1',
    OPENCLAW_OFFLINE: '1',
    OPENCLAW_NO_RESPAWN: '1',
    OPENCLAW_EXEC_SHELL_SNAPSHOT: '0',
    NODE_COMPILE_CACHE: COMPILE_CACHE,
    CLO_NET_GUARD_LOG: join(tmp, 'net-guard.jsonl'),
    CLO_TEST_ROOT: tmp,
    CLO_QQ_APP_ID: APP_ID,
    CLO_QQ_APP_SECRET: FAKE_QQ_SECRET,
    OPENROUTER_API_KEY: FAKE_MODEL_KEY,
    NODE_NO_WARNINGS: '1',
    ...extra,
  };
}

export function makeTmp(label) {
  const tmp = mkdtempSync(join(tmpdir(), `clo-e2e-${label}-`));
  for (const d of ['temp', 'appdata/Roaming', 'appdata/Local']) mkdirSync(join(tmp, d), { recursive: true });
  return tmp;
}

export function cleanupTmp(tmp) {
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // A locked file in temp is not worth failing a test over.
  }
}

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export function pidAlive(pid) {
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { cwd: tmpdir(), env: cleanChildEnv(), encoding: 'utf8', windowsHide: true });
  return r.stdout.includes(`"${pid}"`);
}

export async function startGateway({ tmp, env, port, label = 'gateway', waitReady = true, cwd }) {
  const logPath = join(tmp, `${label}.log`);
  const guardArg = `--import=${pathToFileURL(NET_GUARD).href}`;
  const filterArg = `--import=${pathToFileURL(OUTPUT_FILTER).href}`;
  const child = spawn(NODE, [filterArg, guardArg, OPENCLAW, 'gateway', 'run', '--port', String(port), '--bind', 'loopback'], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  const write = (d) => appendFileSync(logPath, d);
  child.stdout.on('data', write);
  child.stderr.on('data', write);

  const logs = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '');
  const gw = {
    pid: child.pid,
    tmp,
    port,
    env,
    configPath: env.OPENCLAW_CONFIG_PATH,
    logs,
    exited: () => exited,
    netViolations: () => readJsonl(env.CLO_NET_GUARD_LOG),
    writeConfig(next) { writeFileSync(env.OPENCLAW_CONFIG_PATH, JSON.stringify(next, null, 2)); },
    readConfig() { return JSON.parse(readFileSync(env.OPENCLAW_CONFIG_PATH, 'utf8')); },
    /** Runs one CLI command against this Gateway's state and waits for it. */
    cli(cliArgs, { timeoutMs = 90000 } = {}) {
      const r = spawnSync(NODE, [guardArg, OPENCLAW, ...cliArgs], { cwd, env, encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    },
    async stop() {
      if (exited) return exited;
      // /T covers a launcher respawn child. Only this handle's own process tree is touched.
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { cwd: tmpdir(), env: cleanChildEnv(), windowsHide: true });
      await until(() => exited, `gateway pid ${child.pid} to exit`, 15000);
      return exited;
    },
    async waitExit(timeoutMs = 60000) {
      await until(() => exited, `gateway pid ${child.pid} to exit by itself`, timeoutMs);
      return exited;
    },
  };

  if (waitReady) {
    try {
      // Not /readyz or the "ready" line: neither arrives while a channel is down, which some tests do on purpose.
      // The rendered log level hides the host's startup lines, so readiness is the port answering.
      await until(async () => {
        if (exited) throw new Error(`gateway exited early ${JSON.stringify(exited)}:\n${logs().slice(-4000)}`);
        return portOpen(port);
      }, 'gateway port to answer', 120000, 250);
    } catch (err) {
      await gw.stop().catch(() => {});
      throw err;
    }
  }
  return gw;
}

function businessConfig({ qq, model, port, groups, mode, over }) {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config.example.json'), 'utf8'));
  cfg.mode = mode;
  cfg.gatewayPort = port;
  cfg.openrouter = { baseUrl: model.base };
  cfg.qq.enabled = true;
  cfg.qq.appId = APP_ID;
  cfg.qq.apiBaseUrl = qq.base;
  cfg.qq.tokenBaseUrl = qq.base;
  cfg.qq.allowedGroupIds = Object.keys(groups);
  cfg.qq.groups = {};
  cfg.qq.owner.groupMember = {};
  for (const [id, g] of Object.entries(groups)) {
    cfg.qq.groups[id] = { label: g.label ?? id, interject: g.interject ?? false, nameMention: g.nameMention ?? false, noticeGiven: true };
    for (const k of ['cooldownMinutes', 'perHour', 'perDay', 'displayNames']) if (g[k] !== undefined) cfg.qq.groups[id][k] = g[k];
    cfg.qq.owner.groupMember[id] = g.owners ?? [OWNER];
  }
  return deepMerge(cfg, over);
}

/** Mocks, temp state and the real Gateway for one test file. */
export async function startStack({ label, groups = { [GROUP_A]: {} }, mode = 'live', config = {}, effective = {}, overrides = {}, script, decision, env = {}, ready = true, start = true, editWorkspace } = {}) {
  const tmp = makeTmp(label);
  const { startMockQq } = await import('./mock-qq.mjs');
  const { startMockOpenRouter } = await import('./mock-openrouter.mjs');
  const qq = await startMockQq({ ready });
  const model = await startMockOpenRouter();
  if (script) model.setScript(script);
  if (decision) model.setDecision(decision);
  const port = await allocPort();

  const { buildEffective, resolvePaths } = await import('../../src/clo-plugin/lib/core/config.js');
  const { renderOpenclaw, renderWorkspace, writeAtomic } = await import('../../src/clo-plugin/lib/core/render.js');
  const paths = resolvePaths({ CLO_TEST_ROOT: tmp });
  for (const d of [paths.home, paths.stateDir, paths.workspace, paths.cloDir, paths.logsDir, paths.gatewayCwd]) mkdirSync(d, { recursive: true });
  const cfg = businessConfig({ qq, model, port, groups, mode, over: config });
  const built = buildEffective(cfg, { paths, modelsLock: MODEL_LOCK, env: { CLO_TEST_ROOT: tmp } });
  const eff = deepMerge(deepMerge(built, E2E_RELAXED), effective);
  const writeEffective = (next) => writeAtomic(paths.effectiveJson, JSON.stringify(next, null, 2));
  writeEffective(eff);
  const rendered = renderWorkspace(ROOT, eff);
  const edited = editWorkspace ? editWorkspace(rendered) : rendered;
  for (const [name, text] of Object.entries(edited.files)) writeAtomic(join(paths.workspace, name), text);
  writeAtomic(paths.systemPromptFile, edited.systemPrompt);
  const openclaw = deepMerge(renderOpenclaw(cfg, eff, paths, { testMode: { apiKey: FAKE_MODEL_KEY } }), overrides);
  writeAtomic(paths.openclawJson, JSON.stringify(openclaw, null, 2));

  const environment = childEnv(tmp, paths, env);
  let gw = null;
  let generations = 0;
  let readyBase = 0;
  const pids = new Set();
  const openDb = () => new DatabaseSync(paths.db, { readOnly: true });
  const withDb = (fn) => {
    const db = openDb();
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };
  const key = (rawId) => withDb((db) => hmacKey(db.prepare("SELECT value FROM meta WHERE key='hmac_salt'").get().value, rawId));

  const stack = {
    tmp,
    qq,
    model,
    port,
    config: openclaw,
    cfg,
    paths,
    eff,
    get gw() { return gw; },
    key,
    db: openDb,
    withDb,
    events: () => readJsonl(paths.eventLog),
    event: (name) => readJsonl(paths.eventLog).filter((e) => e.event === name),
    logs: () => gw?.logs() ?? '',
    /** Message POSTs only. */
    messagePosts: () => qq.messagePosts(),
    postBodies: () => qq.messagePosts().map((r) => ({ path: r.path, ...JSON.parse(r.body) })),
    dbExists: () => existsSync(paths.db),
    row: (messageId) => (existsSync(paths.db) ? withDb((db) => db.prepare('SELECT * FROM events WHERE event_key=?').get(key(messageId)) ?? null) : null),
    rowCount: () => (existsSync(paths.db) ? withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM events').get().n) : 0),
    sends: (messageId) => withDb((db) => db.prepare('SELECT * FROM sends WHERE event_key=? ORDER BY msg_seq').all(key(messageId))),
    allSends: () => withDb((db) => db.prepare('SELECT * FROM sends ORDER BY created_at, msg_seq').all()),
    reservations: (messageId) => withDb((db) => db.prepare('SELECT * FROM reservations WHERE event_key=? ORDER BY created_at').all(key(messageId))),
    allReservations: () => withDb((db) => db.prepare('SELECT * FROM reservations ORDER BY created_at').all()),
    claims: () => withDb((db) => db.prepare('SELECT * FROM interject_log ORDER BY at').all()),
    control: (name) => withDb((db) => db.prepare('SELECT value FROM control WHERE key=?').get(name)?.value ?? null),
    alerts: () => withDb((db) => db.prepare('SELECT kind, detail FROM alerts').all()),
    counter: (name) => withDb((db) => db.prepare('SELECT value FROM counters WHERE key=?').get(name)?.value ?? 0),
    /** Short writes from the test, as the console would make them. */
    async writeStore(fn) {
      const { openStore } = await import('../../src/clo-plugin/lib/core/store.js');
      const store = openStore(paths.db, { runGen: 'test-console' });
      try {
        return fn(store);
      } finally {
        store.close();
      }
    },
    /** Clears a paid pause and whatever unsettled rows caused it, as `clo budget accept-unsettled` does. */
    async acceptUnsettled() {
      const { createLedger } = await import('../../src/clo-plugin/lib/core/ledger.js');
      return stack.writeStore((store) => {
        const ledger = createLedger({ store, getEffective: () => stack.eff, fetch: async () => { throw new Error('no network here'); }, getKey: () => null });
        ledger.acceptUnsettled('test');
        store.delControl('paid_paused');
        store.q('DELETE FROM counters WHERE key=?').run('provider_fail_streak');
      });
    },
    async waitRow(messageId, timeoutMs = 120000) {
      return until(() => {
        const r = stack.row(messageId);
        return r && TERMINAL.has(r.state) ? r : null;
      }, `${messageId} to reach a terminal state`, timeoutMs, 100);
    },
    // Counts connections since the last restart unless told otherwise, so a dying socket cannot satisfy it.
    async waitConnected(n = readyBase + 1, timeoutMs = 90000) {
      await until(() => qq.connected() === 1 && stack.event('connection_ready').length + stack.event('connection_resumed').length >= n, `connection ${n}`, timeoutMs);
    },
    updateEffective(patch) {
      stack.eff = deepMerge(stack.eff, patch);
      writeEffective(stack.eff);
    },
    /** Replaces the running Gateway, keeping every byte of temp state and the mocks. */
    async restart({ env: more = {}, waitReady = true } = {}) {
      for (const e of readJsonl(paths.eventLog)) pids.add(e.pid);
      if (gw) {
        pids.add(gw.pid);
        await gw.stop();
      }
      readyBase = stack.event('connection_ready').length + stack.event('connection_resumed').length;
      generations += 1;
      gw = await startGateway({ tmp, env: { ...environment, ...more }, port, label: `gateway-${generations}`, waitReady, cwd: paths.gatewayCwd });
      pids.add(gw.pid);
      return gw;
    },
    async stop() {
      for (const e of readJsonl(paths.eventLog)) pids.add(e.pid);
      if (gw) {
        pids.add(gw.pid);
        await gw.stop();
      }
      await qq.stop();
      await model.stop();
      const alive = [...pids].filter(pidAlive);
      if (alive.length) throw new Error(`gateway process still alive after stop: ${alive.join(',')}`);
    },
    cleanup() { cleanupTmp(tmp); },
  };
  if (start) {
    gw = await startGateway({ tmp, env: environment, port, cwd: paths.gatewayCwd }).catch(async (err) => {
      await qq.stop();
      await model.stop();
      throw err;
    });
    pids.add(gw.pid);
  }
  return stack;
}

/** Everything the net guard refused, except the Gateway's own unconditional startup catalog lookup. */
export function unexpectedNetAttempts(gw) {
  return gw.netViolations().filter((v) => v.host !== 'clawhub.ai').map((v) => `${v.kind} ${v.host}`);
}

// R4: every model call carries the locked model, the output cap, the effort, and no fallback list.
export function assertAgentRequest(rec) {
  assert.equal(rec.body.model, PRIMARY_ID);
  assert.equal(rec.body.max_completion_tokens ?? rec.body.max_tokens, 3000);
  if (rec.body.reasoning) assert.equal(rec.body.reasoning.effort, 'low');
  assert.equal(rec.body.fallbacks, undefined);
  assert.equal(rec.body.models, undefined);
}

export function assertDecisionRequest(rec) {
  assert.equal(rec.body.model, DECISION_ID);
  assert.equal(rec.body.stream, false);
  assert.equal(rec.body.max_tokens, 200);
  assert.deepEqual(rec.body.reasoning, { effort: 'none' });
  assert.equal(rec.body.tools, undefined);
}

// R3: run last. Each message POST maps to one row in a settled send state, carries msg_id, and msg_seq only rises.
export function assertEveryPostLegal(s, { minPosts = 1 } = {}) {
  const posts = s.postBodies();
  assert.ok(posts.length >= minPosts, `positive control: this stack did post (${posts.length})`);
  const bySha = new Map();
  for (const r of s.allSends()) {
    if (!['sent', 'failed', 'uncertain'].includes(r.state)) continue;
    const list = bySha.get(r.text_sha) ?? [];
    list.push(r);
    bySha.set(r.text_sha, list);
  }
  const lastSeq = new Map();
  for (const p of posts) {
    assert.ok(p.msg_id, 'msg_id is always present');
    assert.equal(p.msg_type, 0);
    assert.match(p.path, /^\/v2\/groups\/[^/]+\/messages$/);
    const sha = createHash('sha256').update(p.content, 'utf8').digest('hex');
    const list = bySha.get(sha);
    assert.ok(list?.length, 'a sends row exists for this POST');
    const row = list.shift();
    assert.equal(row.msg_seq, p.msg_seq);
    assert.ok(p.msg_seq > (lastSeq.get(p.msg_id) ?? 0), 'msg_seq rises per msg_id');
    lastSeq.set(p.msg_id, p.msg_seq);
  }
}
