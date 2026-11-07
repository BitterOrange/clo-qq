// Spawns the own runtime (src/bot/main.mjs) in the foreground with the private Node and per-test temp state.
// The environment and arguments come from the same builders clo start uses (ownEnv, ownArgs). Business config goes
// through the same buildEffective and renderWorkspace the console uses. The stack API follows startStack in
// gateway.mjs, minus what only the host had (openclaw.json, the port, the host CLI).
// The model provider is CLO_TEST_PROVIDER (default openrouter) or the stack's provider option. On anthropic the
// business config gets a providers block on the mock's loopback address, the D2 hard-cap ack and its Key binding, and
// both Keys in the console's secrets, so a test can check that the inactive one never reaches the bot.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { buildEffective, resolvePaths } from '../../src/clo-plugin/lib/core/config.js';
import { hmacKey } from '../../src/clo-plugin/lib/core/ids.js';
import { renderWorkspace, writeAtomic } from '../../src/clo-plugin/lib/core/render.js';
import { hardCapPauseKey, KEY_ENV, LIVE_CODES, providerRulesRecorded } from '../../src/clo-plugin/lib/core/providers/registry.js';
import { ownArgs, ownEnv } from '../../src/cli/lifecycle.mjs';
import { cleanChildEnv } from './clean-env.mjs';
import { FAKE_ANTHROPIC_KEY } from './fake-keys.mjs';
import {
  allocPort, APP_ID, cleanupTmp, deepMerge, FAKE_MODEL_KEY, FAKE_QQ_SECRET, GROUP_A, makeTmp, NODE, OWNER, pidAlive,
  readJsonl, ROOT, TERMINAL, until,
} from './gateway.mjs';
import { keySent, MODEL_IDS, stackKind, startMockModel, testProvider, view } from './model-view.mjs';

// PRIMARY_ID and DECISION_ID are the ids of a stack made without a provider option, which is always OpenRouter.
export {
  allocPort, APP_ID, assertEveryPostLegal, BOT_MEMBER, cleanupTmp, DECISION_ID, deepMerge, FAKE_MODEL_KEY, FAKE_QQ_SECRET, GROUP_A, GROUP_B,
  MEMBER, MEMBER2, OWNER, pidAlive, PRIMARY_ID, readJsonl, ROOT, sleep, TERMINAL, until,
} from './gateway.mjs';
export { FAKE_ANTHROPIC_KEY } from './fake-keys.mjs';
export { keySent, view } from './model-view.mjs';

// The provider this run names (CLO_TEST_PROVIDER, default openrouter), and the ids its mock lock carries. It applies
// only to stacks made with `provider: PROVIDER`: a file opts in once it reads requests and usage through the model view
// or each kind's own checks. Every other file reads the OpenRouter wire shape, so its stacks stay on OpenRouter
// whatever CLO_TEST_PROVIDER says (see stackKind in model-view.mjs). A stack's own ids are in stack.ids.
export const PROVIDER = testProvider();
export const TEST_IDS = MODEL_IDS[PROVIDER];

const NET_GUARD = join(ROOT, 'tests', 'harness', 'net-guard.mjs');
const SYSTEM32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
// The bot's own stop path (src/bot/main.mjs STOP_REQUEST_KEY): it polls every second, then waits out the gate's grace.
const STOP_REQUEST_KEY = 'bot_stop_request';
const GRACEFUL_STOP_MS = 20000;

// The same short-prompt rates on both kinds, so a settled figure reads the same on either mock. The Anthropic lock adds
// the one-hour write rate and the decision model's long-prompt card, as models.locks.anthropic carries them.
const MODEL_LOCKS = {
  openrouter: {
    primary: { id: MODEL_IDS.openrouter.primary, selector: 'opus-latest', price: { inputPerM: 5, outputPerM: 20, cacheReadPerM: 0.5, cacheWritePerM: 6.25 } },
    decision: { id: MODEL_IDS.openrouter.decision, price: { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, cacheWritePerM: 1.25 } },
  },
  anthropic: {
    primary: { id: MODEL_IDS.anthropic.primary, selector: MODEL_IDS.anthropic.primary, price: { inputPerM: 5, outputPerM: 20, cacheReadPerM: 0.5, cacheWritePerM: 6.25, cacheWrite1hPerM: 10 } },
    decision: {
      id: MODEL_IDS.anthropic.decision,
      price: {
        inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, cacheWritePerM: 1.25, cacheWrite1hPerM: 2,
        long: { aboveTokens: 100000, inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5, cacheWrite1hPerM: 4 },
      },
    },
  },
};

// Decision D2's pair, as `clo ack hard-cap` records it.
export const D2_ACK = Object.freeze({ kind: 'workspace_monthly', usd: 20, prepaidNoReload: true, at: '2000-01-01T00:00:00.000Z' });

// Same relaxations as the Gateway harness. Real caps are unit-tested; a test about a cap passes its own `effective`.
const E2E_RELAXED = {
  window: { windowMs: 300 },
  limits: { sendGroupPerMin: 200, sendAccountPerMin: 200, sendAccountPerHour: 2000, perSenderAddressedPerHour: 500, failureLinePerGroupPerHour: 100 },
};

/**
 * Writes a preload for the bot that layers an allowlist over net-guard.mjs: on top of refusing every non-loopback
 * connection and lookup, it refuses loopback connections to any port but the given ones, any pipe connection, and any
 * listening or UDP socket. Each refusal is recorded in CLO_NET_GUARD_LOG with a kind the tests can read.
 * Generated per stack, since the mock ports are only known once the mocks are up.
 */
export function writeAllowlistGuard(file, ports) {
  const allow = [...new Set(ports.map(Number))].filter((p) => Number.isInteger(p) && p > 0);
  if (!allow.length) throw new Error('allowlist guard: no ports');
  const src = `// Generated by tests/harness/own.mjs for one test stack. Do not edit.
import ${JSON.stringify(pathToFileURL(NET_GUARD).href)};
import { appendFileSync } from 'node:fs';
import dgram from 'node:dgram';
import net from 'node:net';

const LOG = process.env.CLO_NET_GUARD_LOG;
const ALLOW = new Set(${JSON.stringify(allow)});
function record(kind, host, port) {
  const stack = new Error().stack.split('\\n').slice(3, 30).map((s) => s.trim());
  if (LOG) appendFileSync(LOG, JSON.stringify({ t: Date.now(), kind, host: String(host ?? ''), port: port ?? null, stack }) + '\\n');
}
const refused = (what, code) => Object.assign(new Error('net-guard allowlist: refused ' + what), { code });

const innerConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function allowlistConnect(...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const opts = typeof first === 'object' && first !== null ? first : { port: first, host: typeof args[1] === 'string' ? args[1] : undefined };
  if (opts.path) {
    record('pipe', opts.path, null);
    queueMicrotask(() => this.destroy(refused('pipe', 'ECONNREFUSED')));
    return this;
  }
  const port = Number(opts.port);
  if (!ALLOW.has(port)) {
    record('port', opts.host ?? 'localhost', Number.isFinite(port) ? port : null);
    queueMicrotask(() => this.destroy(refused('port ' + opts.port, 'ECONNREFUSED')));
    return this;
  }
  return Reflect.apply(innerConnect, this, args);
};

net.Server.prototype.listen = function refusedListen(...args) {
  const first = args[0];
  record('listen', typeof first === 'object' && first !== null ? (first.host ?? first.path ?? '') : (typeof args[1] === 'string' ? args[1] : ''), typeof first === 'number' ? first : (first?.port ?? null));
  queueMicrotask(() => this.emit('error', refused('listen', 'EACCES')));
  return this;
};

for (const name of ['bind', 'send', 'connect']) {
  dgram.Socket.prototype[name] = function refusedUdp(...args) {
    record('udp', typeof args[1] === 'string' ? args[1] : '', typeof args[0] === 'number' ? args[0] : null);
    throw refused('udp ' + name, 'EACCES');
  };
}
`;
  writeFileSync(file, src);
  return file;
}

// PIDs that hold a listening TCP socket or a bound UDP socket, from netstat. A listening TCP row has a foreign address
// of port 0 and a UDP row has *:*, which read the same whatever language the OS shows its state column in.
export function listeningPids() {
  const out = spawnSync(join(SYSTEM32, 'NETSTAT.EXE'), ['-ano'], { cwd: tmpdir(), env: cleanChildEnv(), encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (out.status !== 0) throw new Error(`netstat failed with status ${out.status}`);
  const pids = new Map();
  for (const line of out.stdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] === 'TCP' && cols.length >= 5 && /:0$/.test(cols[2])) pids.set(Number(cols.at(-1)), [...(pids.get(Number(cols.at(-1))) ?? []), `tcp ${cols[1]}`]);
    else if (cols[0] === 'UDP' && cols.length >= 4) pids.set(Number(cols.at(-1)), [...(pids.get(Number(cols.at(-1))) ?? []), `udp ${cols[1]}`]);
  }
  return pids;
}

// pid itself and the processes whose parent is pid, as { pid, ppid, name }. Read only: nothing is signalled.
export function processTree(pid) {
  const script = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::UTF8;"
    + `@(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)} OR ParentProcessId=${Number(pid)}" | ForEach-Object { @{ pid=[int]$_.ProcessId; ppid=[int]$_.ParentProcessId; name=[string]$_.Name } }) | ConvertTo-Json -Compress`;
  const env = {};
  for (const k of ['SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT', 'PSModulePath', 'TEMP', 'TMP', 'USERPROFILE']) if (process.env[k]) env[k] = process.env[k];
  const out = spawnSync(join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], {
    cwd: tmpdir(), env, encoding: 'utf8', windowsHide: true, timeout: 60000,
  });
  if (out.status !== 0) throw new Error(`process list failed with status ${out.status}`);
  const text = out.stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

// The environment clo start builds for the own runtime, from the same builder. Only the temp folders stay in the
// test root, as in the Gateway harness. Built from an allowlist, so nothing from the shell that runs the tests leaks in.
// On anthropic both model Keys are in the secrets, as both would be in .env: ownEnv must hand the bot only the active one.
export function e2eOwnEnv(tmp, paths, extra = {}, kind = 'openrouter') {
  const parent = { CLO_TEST_ROOT: tmp, CLO_NET_GUARD_LOG: join(tmp, 'net-guard.jsonl') };
  for (const k of ['SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS']) {
    if (process.env[k]) parent[k] = process.env[k];
  }
  const secrets = { CLO_QQ_APP_ID: APP_ID, CLO_QQ_APP_SECRET: FAKE_QQ_SECRET, CLO_CHAT_API_KEY: FAKE_MODEL_KEY };
  if (kind === 'anthropic') secrets[KEY_ENV.anthropic] = FAKE_ANTHROPIC_KEY;
  return {
    ...(kind === 'openrouter' ? ownEnv(paths, parent, { secrets }) : ownEnv(paths, parent, { secrets, kind })),
    APPDATA: join(tmp, 'appdata', 'Roaming'),
    LOCALAPPDATA: join(tmp, 'appdata', 'Local'),
    TEMP: join(tmp, 'temp'),
    TMP: join(tmp, 'temp'),
    ...extra,
  };
}

// The arguments clo start passes, from the same builder: Node flags, the guard (test mode), the entry.
export function e2eOwnArgs(tmp, guardFile, { entry } = {}) {
  const env = { CLO_TEST_ROOT: tmp, CLO_TEST_NODE_IMPORT: guardFile, ...(entry ? { CLO_TEST_BOT_ENTRY: entry } : {}) };
  return ownArgs(resolvePaths({ CLO_TEST_ROOT: tmp }), env);
}

/** One bot process, spawned the way clo start spawns it, with output to <tmp>/<label>.log. */
export async function startBot({ tmp, env, args, label = 'bot', cwd }) {
  const logPath = join(tmp, `${label}.log`);
  const spawnedAt = Date.now();
  const child = spawn(NODE, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal, at: Date.now() }; });
  const write = (d) => appendFileSync(logPath, d);
  child.stdout.on('data', write);
  child.stderr.on('data', write);
  const logs = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '');
  return {
    pid: child.pid,
    spawnedAt,
    tmp,
    env,
    logs,
    exited: () => exited,
    netViolations: () => readJsonl(env.CLO_NET_GUARD_LOG),
    /** Hard kill of this handle's own process tree, as clo stop's taskkill fallback does. */
    async kill() {
      if (exited) return exited;
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { cwd: tmpdir(), env: cleanChildEnv(), windowsHide: true });
      await until(() => exited, `bot pid ${child.pid} to exit`, 15000);
      return exited;
    },
    async waitExit(timeoutMs = 60000) {
      await until(() => exited, `bot pid ${child.pid} to exit by itself`, timeoutMs);
      return exited;
    },
  };
}

// The providers block of an Anthropic stack: the implicit OpenRouter entry made explicit, the active Anthropic entry on
// the mock, and the acks the console writes. A null ack leaves the hard-cap ack out.
function anthropicProviders(cfg, model, ack) {
  cfg.providers = {
    openrouter: { kind: 'openrouter', keyEnv: KEY_ENV.openrouter },
    anthropic: { kind: 'anthropic', keyEnv: KEY_ENV.anthropic, baseUrl: model.base, models: { ...MODEL_IDS.anthropic } },
  };
  cfg.activeProvider = 'anthropic';
  cfg.acks.provider = { name: 'anthropic', at: D2_ACK.at };
  if (ack) cfg.acks.hardCap = { anthropic: { ...ack } };
}

function businessConfig({ qq, model, port, groups, mode, over, kind, hardCapAck }) {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config.example.json'), 'utf8'));
  cfg.runtime = 'own';
  cfg.mode = mode;
  // Never the default port: the own runtime listens on none, and this keeps a test from naming the live one.
  cfg.gatewayPort = port;
  // On anthropic too: anything still sent to the OpenRouter base lands in the Anthropic mock's `other`.
  cfg.openrouter = { baseUrl: model.base };
  if (kind === 'anthropic') anthropicProviders(cfg, model, hardCapAck);
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

const portOf = (base) => Number(new URL(base).port);

/**
 * Mocks, temp state and the real own-runtime process for one test file.
 * Options follow startStack: label, groups, mode, config (business config patch), effective (patch after build),
 * script, decision, env (extra child env), ready, start. editPrompt(text) -> text changes the system prompt written to
 * disk; entry points CLO_TEST_BOT_ENTRY at a stand-in.
 * provider: 'openrouter' or 'anthropic'. Default openrouter, never CLO_TEST_PROVIDER: a provider-aware file passes
 * PROVIDER. On anthropic only:
 *   hardCapAck: the ack written to config.json (default D2_ACK; null for none);
 *   hardCapKey: the Key the attestation is bound to (default the Key the bot gets; null for no binding);
 *   liftStartPause: see liftProviderRulesPause below (default true).
 */
export async function startOwnStack({
  label, groups = { [GROUP_A]: {} }, mode = 'live', config = {}, effective = {}, script, decision, env = {}, ready = true, start = true, waitReady = true, editPrompt, entry,
  provider, hardCapAck = D2_ACK, hardCapKey = FAKE_ANTHROPIC_KEY, liftStartPause = true,
} = {}) {
  const kind = stackKind(provider);
  const tmp = makeTmp(`own-${label}`);
  const { startMockQq } = await import('./mock-qq.mjs');
  const qq = await startMockQq({ ready });
  const model = await startMockModel(kind);
  if (script) model.setScript(script);
  if (decision) model.setDecision(decision);
  const port = await allocPort();

  const paths = resolvePaths({ CLO_TEST_ROOT: tmp });
  for (const d of [paths.cloDir, paths.logsDir, paths.gatewayCwd, join(paths.runtime, 'pids')]) mkdirSync(d, { recursive: true });
  const cfg = businessConfig({ qq, model, port, groups, mode, over: config, kind, hardCapAck });
  writeFileSync(paths.configJson, `${JSON.stringify(cfg, null, 2)}\n`);
  const built = buildEffective(cfg, { paths, modelsLock: MODEL_LOCKS[kind], env: { CLO_TEST_ROOT: tmp } });
  const eff = deepMerge(deepMerge(built, E2E_RELAXED), effective);
  const writeEffective = (next) => writeAtomic(paths.effectiveJson, JSON.stringify(next, null, 2));
  writeEffective(eff);
  const rendered = renderWorkspace(ROOT, eff).systemPrompt;
  const systemPrompt = editPrompt ? editPrompt(rendered) : rendered;
  writeAtomic(paths.systemPromptFile, systemPrompt);

  // The store is created and migrated the way the console's first command does, before the bot ever runs. On
  // anthropic the hard-cap attestation is bound to a Key the way `clo ack hard-cap` binds it.
  {
    const { openStore } = await import('../../src/clo-plugin/lib/core/store.js');
    const store = openStore(paths.db, { runGen: 'test-setup' });
    try {
      if (kind === 'anthropic' && hardCapKey) {
        const { createLedger } = await import('../../src/clo-plugin/lib/core/ledger.js');
        const ledger = createLedger({ store, getEffective: () => eff, fetch: async () => { throw new Error('no network here'); }, getKey: () => null, runtime: 'own' });
        ledger.attestHardCap('anthropic', hardCapKey, 'test-setup');
      }
    } finally {
      store.close();
    }
  }

  const guardFile = writeAllowlistGuard(join(tmp, 'own-net-guard.mjs'), [portOf(qq.base), portOf(model.base)]);
  const environment = e2eOwnEnv(tmp, paths, env, kind);
  const args = e2eOwnArgs(tmp, guardFile, { entry });
  let bot = null;
  let generations = 0;
  let readyBase = 0;
  const pids = new Set();
  const boots = [];
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
  const readyCount = () => stack.event('connection_ready').length + stack.event('connection_resumed').length;
  const startPauses = [];

  // Live on Anthropic is refused by provider_rules until the rule rows recording the user's consent land (the
  // registry's LIVE_RULES_RECORDED). So in live mode the bot's start check pauses paid work under the hard-cap control
  // with code provider_rules, and nothing would ever reach the model. Unless the stack was made with
  // liftStartPause: false, the harness waits for that pause, records its code in stack.startPauses, and lifts it as the
  // console's ack would. It lifts only a provider_rules pause: a hard_cap one means the attestation is wrong, and fails
  // the start.
  async function liftProviderRulesPause() {
    if (kind !== 'anthropic' || !liftStartPause || stack.eff.mode !== 'live' || providerRulesRecorded('anthropic')) return;
    const code = await until(() => stack.control(hardCapPauseKey('anthropic')), 'the start check to pause anthropic under provider_rules', 15000, 25);
    startPauses.push(code);
    if (code !== LIVE_CODES.providerRules) throw new Error(`the start check paused anthropic with code ${code}, not provider_rules`);
    await stack.withLedger((ledger) => ledger.liftHardCapPause('anthropic'));
  }

  async function launch(more = {}, wait = waitReady) {
    readyBase = readyCount();
    generations += 1;
    const handle = await startBot({ tmp, env: { ...environment, ...more }, args, label: `bot-${generations}`, cwd: paths.gatewayCwd });
    pids.add(handle.pid);
    bot = handle;
    if (wait) {
      try {
        await until(() => {
          if (handle.exited()) throw new Error(`bot exited early ${JSON.stringify(handle.exited())}:\n${handle.logs().slice(-4000)}`);
          return qq.connected() >= 1 && readyCount() > readyBase;
        }, 'the bot to connect and see READY', 60000, 25);
      } catch (err) {
        await handle.kill().catch(() => {});
        throw err;
      }
      boots.push(Date.now() - handle.spawnedAt);
      try {
        await liftProviderRulesPause();
      } catch (err) {
        await handle.kill().catch(() => {});
        throw err;
      }
    }
    return handle;
  }

  async function endBot({ graceful = true } = {}) {
    if (!bot || bot.exited()) return bot?.exited() ?? null;
    if (graceful) {
      await stack.writeStore((store) => store.setControl(STOP_REQUEST_KEY, String(bot.pid), 'test-console'));
      try {
        await until(() => bot.exited(), `bot pid ${bot.pid} to stop on request`, GRACEFUL_STOP_MS, 50);
        return { ...bot.exited(), how: 'requested' };
      } catch {
        // Falls through to the same hard stop clo stop falls back to.
      }
    }
    return { ...(await bot.kill()), how: 'killed' };
  }

  const stack = {
    tmp,
    qq,
    model,
    kind,
    /** The model ids this stack's lock carries. */
    ids: MODEL_IDS[kind],
    /** The provider-neutral view of a recorded model request (tests/harness/model-view.mjs). */
    view,
    /** Whether a recorded request carried exactly this Key in its kind's header. */
    keySent,
    /** The hard-cap pause codes the start checks raised, one per live start on anthropic, before the harness lifted them. */
    startPauses,
    cfg,
    paths,
    eff,
    systemPrompt,
    guardFile,
    args,
    env: environment,
    get bot() { return bot; },
    /** Milliseconds from spawn to the first READY of each start that waited for it. */
    boots,
    key,
    db: openDb,
    withDb,
    events: () => readJsonl(paths.eventLog),
    event: (name) => readJsonl(paths.eventLog).filter((e) => e.event === name),
    logs: () => bot?.logs() ?? '',
    netViolations: () => readJsonl(environment.CLO_NET_GUARD_LOG),
    /** Pushes one [type, payload] from tests/fixtures/qq-events.mjs to the bot and returns the message ID. */
    send([type, payload]) {
      qq.push(type, payload);
      return payload.id;
    },
    /** Message POSTs only. */
    messagePosts: () => qq.messagePosts(),
    postBodies: () => qq.messagePosts().map((r) => ({ path: r.path, ...JSON.parse(r.body) })),
    async waitPosts(n, timeoutMs = 30000) {
      return until(() => (qq.messagePosts().length >= n ? stack.postBodies() : null), `${n} message POSTs`, timeoutMs, 25);
    },
    /** Every chat request the mock model saw, the main turns, and the judging calls. */
    modelRequests: () => model.requests,
    agentRequests: () => model.agentRequests(),
    decisionRequests: () => model.decisionRequests(),
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
    /** fn(ledger) on a ledger over a short console write, built as the console builds one. */
    async withLedger(fn) {
      const { createLedger } = await import('../../src/clo-plugin/lib/core/ledger.js');
      return stack.writeStore((store) => fn(createLedger({ store, getEffective: () => stack.eff, fetch: async () => { throw new Error('no network here'); }, getKey: () => null, runtime: 'own' })));
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
    async waitRow(messageId, timeoutMs = 60000) {
      return until(() => {
        const r = stack.row(messageId);
        return r && TERMINAL.has(r.state) ? r : null;
      }, `${messageId} to reach a terminal state`, timeoutMs, 25);
    },
    // Counts connections since the last start unless told otherwise, so a dying socket cannot satisfy it.
    async waitConnected(n = readyBase + 1, timeoutMs = 60000) {
      await until(() => qq.connected() === 1 && readyCount() >= n, `connection ${n}`, timeoutMs, 25);
    },
    updateEffective(patch) {
      stack.eff = deepMerge(stack.eff, patch);
      writeEffective(stack.eff);
    },
    /** Rewrites the system prompt file the bot reads at each turn. */
    writeSystemPrompt(text) {
      writeAtomic(paths.systemPromptFile, text);
    },
    /** sha256 of the system prompt file as it is on disk now. */
    systemPromptSha: () => createHash('sha256').update(readFileSync(paths.systemPromptFile, 'utf8'), 'utf8').digest('hex'),
    /** Starts the bot when the stack was made with start:false, or after stop({ keepMocks: true }). */
    async start({ env: more = {}, waitReady: wait = waitReady } = {}) {
      if (bot && !bot.exited()) throw new Error('the bot is already running');
      return launch(more, wait);
    },
    /**
     * Replaces the running bot, keeping every byte of temp state and the mocks. graceful:false kills it the way a
     * crash or clo stop's fallback does.
     */
    async restart({ env: more = {}, waitReady: wait = waitReady, graceful = true } = {}) {
      for (const e of readJsonl(paths.eventLog)) if (e.pid) pids.add(e.pid);
      const ended = await endBot({ graceful });
      await launch(more, wait);
      return ended;
    },
    /** Ends the bot (by its stop request, or killed) and keeps the mocks. Returns how it ended. */
    async stopBot({ graceful = true } = {}) {
      return endBot({ graceful });
    },
    /** Ends the bot and the mocks, and throws if any process this stack started is still alive. */
    async stop({ graceful = true } = {}) {
      for (const e of readJsonl(paths.eventLog)) if (e.pid) pids.add(e.pid);
      let ended = null;
      try {
        ended = await endBot({ graceful });
      } finally {
        await qq.stop();
        await model.stop();
      }
      const alive = [...pids].filter(pidAlive);
      if (alive.length) throw new Error(`bot process still alive after stop: ${alive.join(',')}`);
      return ended;
    },
    cleanup() { cleanupTmp(tmp); },
  };
  if (start) {
    await launch().catch(async (err) => {
      await qq.stop();
      await model.stop();
      throw err;
    });
  }
  return stack;
}

/** Every refusal the guard recorded, as 'kind host:port'. Unlike the Gateway, the bot has no startup lookup to excuse. */
export function netAttempts(s) {
  return s.netViolations().map((v) => `${v.kind} ${v.host}:${v.port ?? ''}`);
}
