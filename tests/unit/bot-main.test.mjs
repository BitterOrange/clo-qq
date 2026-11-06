// The own runtime's process entry, on the real SDK, store, ledger, gate and exit against mock-qq and a loopback
// mock OpenRouter. The turn runner and the OpenRouter client are small stubs: these tests are about the process.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { Server } from 'node:net';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GROUP_A, makeEffective, MEMBER, OWNER, ROOT, tempDir } from '../fixtures/inbound.mjs';
import { startMockOpenRouter } from '../harness/mock-openrouter.mjs';
import { startMockQq } from '../harness/mock-qq.mjs';

// The turn runner and the shared client come from other work. Where a file is not on disk yet, a stub that
// refuses everything stands in, so the entry's own import paths are still the ones the contract names.
const STUB_SOURCE = "export const createTurnRunner = () => async () => ({ started: false, reason: 'stub' });"
  + "export const createOpenRouterClient = () => ({ post: async () => ({ kind: 'not_sent' }) });";
const STUB_URL = `data:text/javascript,${encodeURIComponent(STUB_SOURCE)}`;
const CONTRACT_FILE = /\/core\/(turn|openrouterChat)\.js$/;
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (err?.code === 'ERR_MODULE_NOT_FOUND' && CONTRACT_FILE.test(specifier)) return { url: STUB_URL, shortCircuit: true };
      throw err;
    }
  },
});
// The plugin entry takes the host SDK from the pinned install, as the Gateway's loader would give it.
const PKG_PARENT = pathToFileURL(join(ROOT, '.runtime', 'pkg', 'package.json')).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('openclaw/')) return nextResolve(specifier, { ...context, parentURL: PKG_PARENT });
    return nextResolve(specifier, context);
  },
});

const { EXIT, STOP_REQUEST_KEY, errorClass, installProcessHandlers, runBot } = await import('../../src/bot/main.mjs');
const { CONSUMER_LEASE_KEY, LEASE_STALE_MS, stopRun } = await import('../../src/clo-plugin/lib/channels/qq/startup.js');
const { openBotServices } = await import('../../src/bot/services.mjs');
const { openStore } = await import('../../src/clo-plugin/lib/core/store.js');
const { replyHoldMicros } = await import('../../src/clo-plugin/lib/core/ledger.js');

const MAIN = fileURLToPath(new URL('../../src/bot/main.mjs', import.meta.url));
const KEY = 'FAKE-CHAT-KEY-0001';
const SECRET = 'FAKE-QQ-SECRET-0001';
const PROMPT = 'FAKE SYSTEM PROMPT';

const mocks = [];
after(async () => {
  for (const m of mocks) await m.stop();
});

// A failed assertion must not leave a run behind, or the test process never exits.
const live = [];
const runs = [];
const releases = [];
afterEach(async () => {
  for (const r of releases.splice(0)) r();
  for (const c of live.splice(0)) c.abort();
  await Promise.allSettled(runs.splice(0));
});

const until = async (cond, what, ms = 15000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

async function ends(run, what, ms = 15000) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new assert.AssertionError({ message: `${what}: still running after ${ms} ms` })), ms);
  });
  try {
    return await Promise.race([run, late]);
  } finally {
    clearTimeout(timer);
  }
}

async function mockQq(opts) {
  const m = await startMockQq(opts);
  mocks.push(m);
  return m;
}

async function mockOr() {
  const m = await startMockOpenRouter();
  mocks.push(m);
  return m;
}

// runtime: null leaves the field out, which reads as the OpenClaw default.
function site(qq, { runtime = 'own', or = null, over = {} } = {}) {
  const dir = tempDir('clo-bot-');
  const db = join(dir, 'clo.db');
  const promptFile = join(dir, 'system-prompt.md');
  writeFileSync(promptFile, PROMPT);
  const eff = makeEffective({
    paths: { db, eventLog: join(dir, 'events.jsonl'), systemPromptFile: promptFile },
    qq: { apiBaseUrl: qq.base, tokenBaseUrl: qq.base },
    openrouter: { baseUrl: or ? or.base : `${qq.base}/none` },
    ...over,
  });
  if (runtime !== null) eff.runtime = runtime;
  const effectivePath = join(dir, 'effective.json');
  writeFileSync(effectivePath, JSON.stringify(eff));
  return { dir, db, eff, effectivePath, closeFile: `${db}.terminal_close`, eventLog: join(dir, 'events.jsonl') };
}

const envFor = (s, over = {}) => ({ CLO_EFFECTIVE_PATH: s.effectivePath, CLO_QQ_APP_ID: s.eff.qq.appId, CLO_QQ_APP_SECRET: SECRET, OPENROUTER_API_KEY: KEY, ...over });

// Records what the entry hands the contract factories, and what the gate hands the turn runner.
function stubFactories({ onTurn } = {}) {
  const seen = { client: null, runner: null, turns: [] };
  return {
    seen,
    factories: {
      createOpenRouterClient(args) {
        seen.client = args;
        seen.clientObj = { post: async () => ({ kind: 'not_sent' }) };
        return seen.clientObj;
      },
      createTurnRunner(args) {
        seen.runner = args;
        return async (turn, opts) => {
          seen.turns.push({ turn, opts });
          return onTurn ? onTurn(turn, opts, args) : { started: false, reason: 'stub' };
        };
      },
    },
  };
}

function start(s, { env, signal, ...rest } = {}) {
  const ctl = new AbortController();
  live.push(ctl);
  const run = runBot({ env: env ?? envFor(s), signal: signal ?? ctl.signal, ...rest });
  runs.push(run);
  return { ctl, run };
}

// A second connection to the same database, as clo status would open it.
function peek(s, fn) {
  const store = openStore(s.db);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

const events = (s) => (existsSync(s.eventLog) ? readFileSync(s.eventLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const alertKinds = (store) => store.q('SELECT kind FROM alerts').all().map((a) => a.kind);

test('refusals open no connection; the matching environment connects (control)', async () => {
  const qq = await mockQq();
  const cases = [
    ['no runtime: the OpenClaw default', { runtime: null }, {}, 'runtime'],
    ['runtime openclaw', { runtime: 'openclaw' }, {}, 'runtime'],
    ['qq disabled', { over: { qq: { enabled: false } } }, {}, 'qq_disabled'],
    ['no CLO_QQ_APP_ID', {}, { CLO_QQ_APP_ID: undefined }, 'account'],
    ['another CLO_QQ_APP_ID', {}, { CLO_QQ_APP_ID: 'OTHER-APP' }, 'account'],
    ['no secret', {}, { CLO_QQ_APP_SECRET: '' }, 'account'],
  ];
  for (const [what, siteOpts, envOver, reason] of cases) {
    const s = site(qq, siteOpts);
    const { run } = start(s, { env: envFor(s, envOver) });
    const r = await ends(run, what, 5000);
    assert.deepEqual(r, { code: EXIT.refused, reason }, what);
    assert.equal(qq.opened(), 0, `${what}: no connection`);
    if (reason === 'account') peek(s, (store) => assert.ok(alertKinds(store).includes('account_mismatch'), what));
  }
  const missing = await runBot({ env: {} });
  assert.deepEqual(missing, { code: EXIT.config, reason: 'services' });

  const s = site(qq);
  const { ctl, run } = start(s);
  await until(() => qq.identifies.length === 1, 'identify');
  ctl.abort();
  assert.deepEqual(await ends(run, 'an aborted run'), { code: EXIT.ok, reason: 'stopped' });
});

test('the controls clo status and clo mode live read: connected, READY, heartbeat, the Key hash; down on stop', async () => {
  const qq = await mockQq({ ready: false });
  qq.setUsername('mock-bot-name');
  const s = site(qq);
  // An earlier run left this. recoverOnStart sets it false before anything connects.
  peek(s, (store) => store.setControl('connected', 'true', 'test'));
  const { ctl, run } = start(s);
  await until(() => qq.identifies.length === 1, 'identify');
  peek(s, (store) => {
    assert.equal(store.getControl('connected'), 'false', 'recovery ran before connecting');
    assert.ok(Number(store.getControl('heartbeat_at')) > 0);
    assert.equal(store.getControl('gateway_key'), store.key(KEY));
    assert.notEqual(store.getControl('gateway_key'), store.key('ANOTHER-KEY'));
  });
  assert.ok(events(s).some((e) => e.event === 'recovery'));
  qq.sendReady();
  await until(() => peek(s, (store) => store.getControl('connected') === 'true'), 'READY reaches the store');
  peek(s, (store) => {
    assert.equal(store.getControl('ready_username'), 'mock-bot-name');
    assert.ok(Number(store.getControl('last_ready_at')) > 0);
  });
  ctl.abort();
  await ends(run, 'an aborted run');
  peek(s, (store) => assert.equal(store.getControl('connected'), 'false'));

  // No Key in the environment reads as none, which clo mode live never matches.
  const s2 = site(qq);
  const second = start(s2, { env: envFor(s2, { OPENROUTER_API_KEY: undefined }) });
  await until(() => qq.identifies.length === 2, 'identify');
  peek(s2, (store) => assert.equal(store.getControl('gateway_key'), 'none'));
  second.ctl.abort();
  await ends(second.run, 'an aborted run');
});

test('4914 latches: store and alert, no file left, a restart refuses with no connection until acknowledged', async () => {
  const qq = await mockQq();
  const s = site(qq);
  const first = start(s);
  await until(() => peek(s, (store) => store.getControl('connected') === 'true'), 'connected');
  const opened = qq.opened();
  qq.closeAll(4914);
  assert.deepEqual(await ends(first.run, 'a fatal close'), { code: EXIT.terminal, reason: 'terminal', closeCode: 4914 });
  assert.equal(existsSync(s.closeFile), false);
  peek(s, (store) => {
    assert.equal(store.getControl('terminal_close'), '4914');
    assert.ok(alertKinds(store).includes('terminal_close'));
  });
  const again = start(s);
  assert.deepEqual(await ends(again.run, 'a restart after 4914', 5000), { code: EXIT.terminal, reason: 'terminal' });
  assert.equal(qq.opened(), opened, 'no connection after the restart');
  // Positive control: clo ack terminal clears the row and the same site connects.
  peek(s, (store) => store.delControl('terminal_close'));
  const acked = start(s);
  await until(() => qq.opened() > opened, 'connects once acknowledged');
  acked.ctl.abort();
  await ends(acked.run, 'an aborted run');
});

test('a latch only on file is refused and moved into the store; an unreadable one refuses as well', async () => {
  const qq = await mockQq();
  const s = site(qq);
  writeFileSync(s.closeFile, '4915');
  const { run } = start(s);
  assert.deepEqual(await ends(run, 'a start with the code on file', 5000), { code: EXIT.terminal, reason: 'terminal' });
  assert.equal(existsSync(s.closeFile), false);
  peek(s, (store) => assert.equal(store.getControl('terminal_close'), '4915'));

  const s2 = site(qq);
  mkdirSync(s2.closeFile);
  const second = start(s2);
  assert.deepEqual(await ends(second.run, 'a start with an unreadable latch', 5000), { code: EXIT.terminal, reason: 'terminal' });
  assert.equal(qq.opened(), 0);
});

const mention = { scope: 'single', bot: true, is_you: true, id: 'BOTMEMBER', member_openid: 'BOTMEMBER', username: 'BOT' };
const atMessage = (id, text = '你好') => ({ id, content: `<@BOTMEMBER> ${text}`, timestamp: new Date().toISOString(), group_openid: GROUP_A, group_id: GROUP_A, message_type: 0, author: { member_openid: MEMBER, id: MEMBER, bot: false }, mentions: [mention] });
const USAGE = { costUsd: 0.001, input: 100, output: 20, cacheRead: 0, cacheWrite: 0, model: 'anthropic/fake-opus' };

test('an @ goes gate -> turn runner -> exit -> QQ, with the contract arguments', async () => {
  const qq = await mockQq();
  const or = await mockOr();
  const s = site(qq, { or });
  const { seen, factories } = stubFactories({
    onTurn: (turn, _opts, args) => {
      args.getExit().collect(turn.turnId, { text: '这是一条普通的回复。', isError: false }, { kind: 'final' });
      return { started: true, hostError: false, aborted: false, usage: USAGE };
    },
  });
  const { ctl, run } = start(s, { factories });
  await until(() => peek(s, (store) => store.getControl('connected') === 'true'), 'connected');
  // The ledger's first Key read is what lets paid work start.
  await until(() => or.other.some((r) => r.url.endsWith('/key')), 'the start-up Key read');
  await until(() => peek(s, (store) => store.q('SELECT COUNT(*) AS n FROM key_snapshots').get().n > 0), 'a Key snapshot');
  qq.push('GROUP_MESSAGE_CREATE', atMessage('MSGAT0001'));
  await until(() => qq.messagePosts().length === 1, 'the reply reached QQ');
  const body = JSON.parse(qq.messagePosts()[0].body);
  assert.equal(body.content, '这是一条普通的回复。');
  assert.equal(body.msg_id, 'MSGAT0001');
  assert.equal(seen.turns.length, 1);
  assert.equal(typeof seen.turns[0].turn.turnId, 'string');
  assert.equal(seen.client.getKey(), KEY);
  assert.equal(seen.client.getBaseUrl(), or.base);
  assert.equal(typeof seen.client.fetch, 'function');
  assert.equal(seen.runner.readSystemPrompt(), PROMPT);
  assert.equal(seen.runner.client, seen.clientObj, 'the runner gets the shared client');
  assert.equal(typeof seen.runner.getEffective, 'function');
  assert.equal(seen.runner.getEffective().runtime, 'own');
  assert.equal(or.requests.length, 0, 'no model request from the stubs');
  ctl.abort();
  await ends(run, 'an aborted run');
  // One send row per post, and the event finished.
  peek(s, (store) => {
    assert.equal(store.q("SELECT COUNT(*) AS n FROM sends WHERE state='sent'").get().n, 1);
  });
});

test('shutdown waits for a turn in flight before the store closes; the turn ends in a final state', async () => {
  const qq = await mockQq();
  const or = await mockOr();
  const s = site(qq, { or });
  let release;
  const held = new Promise((r) => { release = r; });
  releases.push(release);
  let reached = false;
  const { factories } = stubFactories({
    onTurn: async () => {
      reached = true;
      await held;
      return { started: true, hostError: false, aborted: false, usage: USAGE };
    },
  });
  const { ctl, run } = start(s, { factories });
  await until(() => peek(s, (store) => store.getControl('connected') === 'true'), 'connected');
  await until(() => peek(s, (store) => store.q('SELECT COUNT(*) AS n FROM key_snapshots').get().n > 0), 'a Key snapshot');
  qq.push('GROUP_MESSAGE_CREATE', atMessage('MSGAT0002'));
  await until(() => reached, 'the turn reached the runner');
  ctl.abort();
  let done = false;
  run.then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(done, false, 'the run waits for the turn in flight');
  release();
  await ends(run, 'the run after the turn ended');
  const state = peek(s, (store) => store.getEvent(store.key('MSGAT0002'))?.state);
  assert.ok(state && !['received', 'queued', 'approved', 'dispatching', 'delivering'].includes(state), `final state, got ${state}`);
  peek(s, (store) => assert.equal(store.q("SELECT COUNT(*) AS n FROM reservations WHERE status='held'").get().n, 0, 'no hold left open'));
});

test('a stop request naming this PID stops the run gracefully; one naming another PID does not', async () => {
  const qq = await mockQq();
  const s = site(qq);
  const { run } = start(s, { pid: 4242, stopPollMs: 30 });
  await until(() => qq.identifies.length === 1, 'identify');
  let done = false;
  run.then(() => { done = true; });
  peek(s, (store) => store.setControl(STOP_REQUEST_KEY, '999999', 'cli'));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(done, false, 'another PID is not this process');
  peek(s, (store) => store.setControl(STOP_REQUEST_KEY, '4242', 'cli'));
  assert.deepEqual(await ends(run, 'a requested stop'), { code: EXIT.ok, reason: 'stopped' });
  peek(s, (store) => {
    assert.equal(store.getControl(STOP_REQUEST_KEY), null, 'the request is used up');
    assert.equal(store.getControl('connected'), 'false');
  });
  assert.ok(events(s).some((e) => e.event === 'bot_stop' && e.reason === 'requested'));
});

test('the bot listens on no port (a planted listen is caught: control)', async () => {
  const qq = await mockQq();
  const or = await mockOr();
  const s = site(qq, { or });
  const realListen = Server.prototype.listen;
  const listens = [];
  Server.prototype.listen = function patched(...args) {
    listens.push(args[0]);
    return realListen.apply(this, args);
  };
  try {
    const { ctl, run } = start(s);
    await until(() => peek(s, (store) => store.getControl('connected') === 'true'), 'connected');
    await until(() => or.other.some((r) => r.url.endsWith('/key')), 'the start-up Key read');
    assert.deepEqual(listens, [], 'no listen while running');
    const planted = new Server();
    planted.listen(0, '127.0.0.1');
    await new Promise((r) => planted.once('listening', r));
    planted.close();
    assert.equal(listens.length, 1, 'the spy sees a listen');
    ctl.abort();
    await ends(run, 'an aborted run');
  } finally {
    Server.prototype.listen = realListen;
  }
});

test('stopRun: the gate grace ends before the connected flag and the store close; a throwing step stops nothing after it', async () => {
  const order = [];
  let finishGate;
  const gate = { stop: () => new Promise((r) => { finishGate = () => { order.push('gate_done'); r(); }; }) };
  const store = { setControl: (k, v) => order.push(`${k}=${v}`) };
  const p = stopRun({ controls: { stop: () => order.push('timers') }, getExit: () => ({ stop: () => order.push('exit') }), gate, store, log: () => {}, closeServices: () => order.push('close') });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(order, ['timers', 'exit'], 'nothing closes while the gate waits');
  finishGate();
  await p;
  assert.deepEqual(order, ['timers', 'exit', 'gate_done', 'connected=false', 'close']);

  const logs = [];
  const order2 = [];
  await stopRun({
    controls: null,
    getExit: () => ({ stop: () => { throw new Error('exit'); } }),
    gate: { stop: async () => order2.push('gate') },
    store: { setControl: () => { throw new Error('database is locked'); } },
    log: (e, d) => logs.push(d.reason),
    closeServices: () => order2.push('close'),
  });
  assert.deepEqual(order2, ['close']);
  assert.deepEqual(logs, ['stop', 'connection']);
});

test('errorClass names the class only, never the message', () => {
  const secret = 'PROVIDER-TEXT-CANARY';
  assert.equal(errorClass(new TypeError(secret)), 'TypeError');
  const odd = new Error(secret);
  odd.name = secret;
  assert.equal(errorClass(odd), 'Error');
  class Weird extends Error {}
  Object.defineProperty(Weird, 'name', { value: `${secret} with spaces` });
  assert.equal(errorClass(new Weird('x')), 'Error');
  assert.equal(errorClass(secret), 'string');
  assert.equal(errorClass(null), 'object');
  assert.equal(errorClass(undefined), 'undefined');
});

test('installProcessHandlers logs the class and exits with the fatal code', () => {
  const handlers = {};
  const writes = [];
  const exits = [];
  installProcessHandlers({ proc: { on: (n, f) => { handlers[n] = f; } }, exit: (c) => exits.push(c), write: (s) => writes.push(s) });
  handlers.uncaughtException(new RangeError('CANARY-1'));
  handlers.unhandledRejection(new SyntaxError('CANARY-2'));
  assert.deepEqual(exits, [EXIT.fatal, EXIT.fatal]);
  assert.deepEqual(writes, ['clo-bot: uncaught_exception RangeError\n', 'clo-bot: unhandled_rejection SyntaxError\n']);
});

// The real entry as clo start runs it: as a process, with the handlers on. A fault is forced from --import.
function faultModule(dir) {
  const file = join(dir, 'fault.mjs');
  writeFileSync(file, `
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
const STUB = ${JSON.stringify(STUB_URL)};
registerHooks({ resolve(s, c, n) { try { return n(s, c); } catch (e) { if (e?.code === 'ERR_MODULE_NOT_FOUND' && ${CONTRACT_FILE}.test(s)) return { url: STUB, shortCircuit: true }; throw e; } } });
const began = Date.now();
const t = setInterval(() => {
  // Fires once the entry is running. Without handlers after 3 s, so a missing handler fails on the output, not by hanging.
  if (!existsSync(process.env.FAULT_LOG) || (process.listenerCount('uncaughtException') === 0 && Date.now() - began < 3000)) return;
  clearInterval(t);
  if (process.env.FAULT_MODE === 'throw') setTimeout(() => { throw new TypeError(process.env.FAULT_CANARY); }, 0);
  else Promise.reject(new RangeError(process.env.FAULT_CANARY));
}, 20);
`);
  return file;
}

function runChild(args, env, cwd, ms = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new assert.AssertionError({ message: `child still running after ${ms} ms` }));
    }, ms);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

const baseChildEnv = () => Object.fromEntries(['SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));

for (const mode of ['throw', 'reject']) {
  test(`process level (${mode}): the class reaches stderr and events.jsonl, the message nowhere (a handler-less process leaks it: control)`, { timeout: 60000 }, async () => {
    const qq = await mockQq();
    const s = site(qq);
    const canary = `CANARY-PROVIDER-TEXT-${mode}-7f3a`;
    const fault = faultModule(s.dir);
    const env = { ...baseChildEnv(), ...envFor(s), FAULT_MODE: mode, FAULT_LOG: s.eventLog, FAULT_CANARY: canary };
    const r = await runChild([`--import=${pathToFileURL(fault).href}`, MAIN], env, s.dir);
    const kind = mode === 'throw' ? 'TypeError' : 'RangeError';
    const reason = mode === 'throw' ? 'uncaught_exception' : 'unhandled_rejection';
    assert.equal(r.code, EXIT.fatal);
    assert.match(r.stderr, new RegExp(`clo-bot: ${reason} ${kind}`));
    assert.ok(events(s).some((e) => e.event === 'start_account' && e.kind === 'own'), 'the entry ran main');
    assert.ok(events(s).some((e) => e.event === 'process_error' && e.kind === kind && e.reason === reason));
    assert.equal(r.stdout.includes(canary), false);
    assert.equal(r.stderr.includes(canary), false);
    for (const f of filesUnder(s.dir)) {
      if (f === fault) continue;
      assert.equal(readFileSync(f).includes(canary), false, `canary in ${f}`);
    }
    // Control: the same fault with no handler prints the message, so the scan above can see it.
    const control = await runChild(['-e', `setTimeout(() => { ${mode === 'throw' ? 'throw new TypeError(process.env.FAULT_CANARY)' : 'Promise.reject(new RangeError(process.env.FAULT_CANARY))'}; }, 0)`], env, s.dir);
    assert.notEqual(control.code, 0);
    assert.ok(control.stderr.includes(canary), 'a handler-less process leaks the message');
  });
}

test('the OpenClaw plugin refuses to connect while the own runtime is configured; runtime openclaw connects (control)', async () => {
  const { startAccount } = await import('../../src/clo-plugin/index.js');
  const { stopServices } = await import('../../src/clo-plugin/lib/channels/qq/services.js');
  const qq = await mockQq();
  const makeCtx = (s) => {
    const ctl = new AbortController();
    live.push(ctl);
    let status = {};
    return {
      ctl,
      account: { accountId: 'default', enabled: true, appId: s.eff.qq.appId, clientSecret: 'SECRET-FAKE', apiBaseUrl: qq.base, tokenBaseUrl: qq.base },
      cfg: { plugins: { entries: { clo: { config: { effectivePath: s.effectivePath } } } } },
      channelRuntime: {},
      abortSignal: ctl.signal,
      getStatus: () => status,
      setStatus: (next) => { status = next; },
    };
  };
  try {
    const own = site(qq, { runtime: 'own' });
    const ctx = makeCtx(own);
    await ends(startAccount(ctx), 'a refused plugin start', 5000);
    assert.equal(ctx.getStatus().terminalDisconnect, true);
    assert.equal(ctx.getStatus().lastError, 'another runtime is configured');
    assert.equal(qq.opened(), 0);
    stopServices();

    const oc = site(qq, { runtime: 'openclaw' });
    const ctx2 = makeCtx(oc);
    const running = startAccount(ctx2);
    runs.push(running);
    await until(() => ctx2.getStatus().connected === true, 'the OpenClaw runtime connects');
    ctx2.ctl.abort();
    await ends(running, 'an aborted plugin run');
  } finally {
    stopServices();
  }
});

// A PID that was alive a moment ago and is not now: a bot that died.
async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { env: baseChildEnv(), windowsHide: true, stdio: 'ignore' });
  await new Promise((r) => child.on('exit', r));
  return child.pid;
}

test('one consumer: a second run on the same database is refused before recovery or any connection; the slot frees on stop (control)', async () => {
  const qq = await mockQq();
  const s = site(qq);
  const first = start(s);
  await until(() => qq.identifies.length === 1, 'the first run connects');
  const token = peek(s, (store) => store.getControl(CONSUMER_LEASE_KEY));
  assert.match(String(token), new RegExp(`^${process.pid}:`), 'the lease names this process');
  // A row only recovery would change: a second run's recoverOnStart must not reach it.
  peek(s, (store) => store.setControl('connected', 'true', 'test'));
  const second = start(s);
  assert.deepEqual(await ends(second.run, 'a second run', 5000), { code: EXIT.refused, reason: 'running' });
  assert.equal(qq.opened(), 1, 'no second connection');
  assert.equal(qq.identifies.length, 1);
  assert.equal(events(s).filter((e) => e.event === 'recovery').length, 1, 'no second recovery');
  peek(s, (store) => {
    assert.equal(store.getControl('connected'), 'true', 'the live run’s rows are untouched');
    assert.equal(store.getControl(CONSUMER_LEASE_KEY), token, 'the refused run leaves the lease alone');
  });
  assert.ok(events(s).some((e) => e.event === 'start_refused' && e.reason === 'running' && e.kind === 'bot'));
  first.ctl.abort();
  assert.deepEqual(await ends(first.run, 'the first run'), { code: EXIT.ok, reason: 'stopped' });
  peek(s, (store) => {
    assert.equal(store.getControl(CONSUMER_LEASE_KEY), null, 'a clean stop drops the lease');
    assert.equal(store.getControl('heartbeat_at'), null, 'and its heartbeat');
  });
  // Control: the same site connects once the first run has stopped.
  const third = start(s);
  await until(() => qq.identifies.length === 2, 'a run after the stop connects');
  third.ctl.abort();
  await ends(third.run, 'the third run');
});

test('one consumer: a dead process’s lease is taken over; a fresh heartbeat no lease explains (a Gateway) refuses; a stale one does not', async () => {
  const qq = await mockQq();
  const s = site(qq);
  const gone = await deadPid();
  // A bot that died mid-run: its lease and its heartbeat from the same beat, both fresh.
  peek(s, (store) => {
    store.setControl('heartbeat_at', Date.now(), 'heartbeat');
    store.setControl(CONSUMER_LEASE_KEY, `${gone}:dead-run`, 'bot');
    store.setControl('connected', 'true', 'connection');
  });
  const taken = start(s);
  await until(() => qq.identifies.length === 1, 'takes over a dead lease');
  taken.ctl.abort();
  await ends(taken.run, 'the run that took over');

  // A Gateway beating: a fresh heartbeat and no lease.
  const g = site(qq);
  peek(g, (store) => store.setControl('heartbeat_at', Date.now(), 'heartbeat'));
  const refused = start(g);
  assert.deepEqual(await ends(refused.run, 'a run next to a beating Gateway', 5000), { code: EXIT.refused, reason: 'running' });
  assert.equal(qq.identifies.length, 1, 'no connection next to the Gateway');
  // A dead lease, but something kept beating after its last renewal: not the dead bot's heartbeat.
  peek(g, (store) => {
    store.setControl(CONSUMER_LEASE_KEY, `${gone}:dead-run`, 'bot');
    store.q('UPDATE control SET updated_at=? WHERE key=?').run(Date.now() - 20000, CONSUMER_LEASE_KEY);
  });
  const beside = start(g);
  assert.deepEqual(await ends(beside.run, 'a dead lease with a newer heartbeat', 5000), { code: EXIT.refused, reason: 'running' });
  // Control: the same heartbeat gone stale, as after a Gateway crash, lets the run connect.
  peek(g, (store) => store.setControl('heartbeat_at', Date.now() - LEASE_STALE_MS - 1000, 'heartbeat'));
  const later = start(g);
  await until(() => qq.identifies.length === 2, 'connects once the heartbeat is stale');
  later.ctl.abort();
  await ends(later.run, 'the run after a stale heartbeat');
});

test('one consumer: a run whose lease another run took over stops; one that keeps it runs on (control)', async () => {
  const qq = await mockQq();
  const s = site(qq);
  const { run } = start(s, { stopPollMs: 30 });
  await until(() => qq.identifies.length === 1, 'connected');
  let done = false;
  run.then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(done, false, 'a run that holds its lease keeps running');
  peek(s, (store) => store.setControl(CONSUMER_LEASE_KEY, '1:another-run', 'bot'));
  assert.deepEqual(await ends(run, 'a run that lost its lease'), { code: EXIT.refused, reason: 'lease_lost' });
  assert.ok(events(s).some((e) => e.event === 'bot_stop' && e.reason === 'lease_lost'));
  peek(s, (store) => assert.equal(store.getControl(CONSUMER_LEASE_KEY), '1:another-run', 'the other run’s lease is left alone'));
});

// The services alone, with a runner stub that reports to whatever ledger and alert sink it is handed.
function servicesFor(s, behave) {
  const handed = [];
  const services = openBotServices(s.effectivePath, {
    env: envFor(s),
    fetch: async () => { throw new Error('no network in this test'); },
    factories: {
      createOpenRouterClient: () => ({ post: async () => ({ kind: 'not_sent' }) }),
      createTurnRunner: (args) => {
        handed.push(args);
        return async (turn) => behave(args, turn);
      },
    },
  });
  return { services, handed, dispatch: services.createDispatch(() => null) };
}
const TURN = { turnId: 'T1', eventKey: 'E1', groupKey: 'G1', cls: 'addressed', tier: 'mention' };
const streak = (store) => store.q("SELECT value FROM counters WHERE key='provider_fail_streak'").get()?.value ?? 0;

test('own dispatch: a started provider failure carries its status and limit source for the gate and is not counted here (an ok answer carries none: control)', async () => {
  const qq = await mockQq();
  const s = site(qq);
  const { services, handed, dispatch } = servicesFor(s, (args, turn) => {
    if (turn.turnId === 'OK') {
      args.ledger.noteProviderOk();
      return { started: true, hostError: false, aborted: false, usage: USAGE };
    }
    args.ledger.noteProviderError({ httpStatus: 402, limitSource: 'openrouter_key_limit' });
    return { started: true, hostError: true, aborted: false, usage: null };
  });
  try {
    const failed = await dispatch(TURN);
    assert.deepEqual(failed, { started: true, hostError: true, aborted: false, usage: null, info: { status: 402, limitSource: 'openrouter_key_limit' } });
    assert.notEqual(handed[0].ledger, services.ledger, 'the runner never gets the real ledger: the gate counts started turns');
    assert.equal(streak(services.store), 0);
    assert.equal(services.store.getControl('paid_paused'), null, 'nothing paused from here for a started turn');
    // Control: what the gate does with that info pauses paid work at once.
    services.ledger.noteProviderError({ httpStatus: failed.info.status, limitSource: failed.info.limitSource });
    assert.equal(services.store.getControl('paid_paused'), 'openrouter_key_limit');
    const ok = await dispatch({ ...TURN, turnId: 'OK' });
    assert.deepEqual(ok, { started: true, hostError: false, aborted: false, usage: USAGE });
  } finally {
    services.close();
  }
});

test('own dispatch: a turn that never started but failed at the provider counts toward the streak, three pause paid work (a plain refusal counts nothing: control)', async () => {
  const qq = await mockQq();
  const s = site(qq);
  const { services, dispatch } = servicesFor(s, (args, turn) => {
    if (turn.turnId === 'PLAIN') return { started: false, reason: 'expired_before_dispatch' };
    args.ledger.noteProviderError({ httpStatus: null, limitSource: null });
    return { started: false, reason: 'not_sent' };
  });
  try {
    assert.deepEqual(await dispatch({ ...TURN, turnId: 'PLAIN' }), { started: false, reason: 'expired_before_dispatch' });
    assert.equal(streak(services.store), 0);
    assert.deepEqual(await dispatch(TURN), { started: false, reason: 'not_sent' });
    assert.equal(streak(services.store), 1);
    await dispatch(TURN);
    assert.equal(services.store.getControl('paid_paused'), null, 'two failures pause nothing');
    await dispatch(TURN);
    assert.equal(services.store.getControl('paid_paused'), 'provider_fail');
  } finally {
    services.close();
  }
});

test('own dispatch: the runner gets an alert sink that writes clo status alerts, and a retry check that says no once paused or not live', async () => {
  const qq = await mockQq();
  const s = site(qq);
  let seen = null;
  const { services, dispatch } = servicesFor(s, (args) => {
    seen = args;
    args.addAlert('policy_sentinel', { reason: 'missing' });
    args.addAlert('model_mismatch', {});
    return { started: false, reason: 'policy_sentinel' };
  });
  try {
    await dispatch(TURN);
    assert.deepEqual(alertKinds(services.store).sort(), ['model_mismatch', 'policy_sentinel']);
    assert.equal(typeof seen.beforeRetry, 'function');
    assert.equal(seen.beforeRetry(TURN), true, 'live and nothing paused: the retry may go');
    for (const [key, value] of [['global_paused', '1'], ['group_paused:G1', '1'], ['paid_paused', 'provider_fail'], ['terminal_close', '4914']]) {
      services.store.setControl(key, value, 'test');
      assert.equal(seen.beforeRetry(TURN), false, `${key} stops the retry`);
      services.store.delControl(key);
      assert.equal(seen.beforeRetry(TURN), true, `without ${key} it may go again`);
    }
    // Another group's pause does not stop this group's retry.
    services.store.setControl('group_paused:G2', '1', 'test');
    assert.equal(seen.beforeRetry(TURN), true);
    writeFileSync(s.effectivePath, JSON.stringify({ ...s.eff, mode: 'dry-run' }));
    await until(() => services.getEffective()?.mode === 'dry-run', 'the reader sees dry-run');
    assert.equal(seen.beforeRetry(TURN), false, 'dry-run stops the retry');
  } finally {
    services.close();
  }
});

// The process as clo start runs it, when the token endpoint cannot be reached: the run must wait out its reconnect
// delay and stay up, not drain away with Node's unsettled-await code.
function stubModule(dir) {
  const file = join(dir, 'stub.mjs');
  writeFileSync(file, `
import { registerHooks } from 'node:module';
const STUB = ${JSON.stringify(STUB_URL)};
registerHooks({ resolve(s, c, n) { try { return n(s, c); } catch (e) { if (e?.code === 'ERR_MODULE_NOT_FOUND' && ${CONTRACT_FILE}.test(s)) return { url: STUB, shortCircuit: true }; throw e; } } });
`);
  return file;
}

test('a failed connection start keeps the process up for its retry, and a stop request still ends it cleanly', { timeout: 60000 }, async () => {
  const qq = await mockQq();
  const s = site(qq);
  writeFileSync(s.effectivePath, JSON.stringify({ ...s.eff, qq: { ...s.eff.qq, tokenBaseUrl: 'http://127.0.0.1:1' } }));
  const stub = stubModule(s.dir);
  const child = spawn(process.execPath, [`--import=${pathToFileURL(stub).href}`, MAIN], { cwd: s.dir, env: { ...baseChildEnv(), ...envFor(s) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.resume();
  let exitCode = null;
  const exited = new Promise((r) => child.on('exit', (code) => { exitCode = code; r(code); }));
  try {
    await until(() => events(s).some((e) => e.event === 'connection_start_failed'), 'the first start fails', 20000);
    // The first retry waits 5 s. A process with nothing holding its loop ends well inside this.
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(exitCode, null, `still running while it waits to retry (exit ${exitCode}, ${stderr.trim().split('\n')[0]})`);
    peek(s, (store) => store.setControl(STOP_REQUEST_KEY, String(child.pid), 'cli'));
    assert.equal(await ends(exited, 'the requested stop', 20000), EXIT.ok);
    const names = events(s).map((e) => e.event);
    assert.ok(names.includes('bot_stop') && names.includes('connection_closed'), 'the stop ran its order');
    assert.equal(qq.opened(), 0, 'no connection was ever opened');
  } finally {
    if (exitCode === null) child.kill();
  }
});

// --- The process runs its gate, exit and ledger as the own runtime ---

const ownerAt = (id, text) => ({ ...atMessage(id, text), author: { member_openid: OWNER, id: OWNER, bot: false } });
const FINAL = (state) => Boolean(state) && !['received', 'queued', 'approved', 'dispatching', 'delivering'].includes(state);

async function liveBot(s, factories, opts = {}) {
  const { ctl, run } = start(s, { factories, ...opts });
  await until(() => peek(s, (store) => store.getControl('connected') === 'true'), 'connected');
  await until(() => peek(s, (store) => store.q('SELECT COUNT(*) AS n FROM key_snapshots').get().n > 0), 'a Key snapshot');
  return { ctl, run };
}

test('own wiring: a started 402 at the Key limit pauses paid work at once, the @ holds 1x callWorst, and no runtime mismatch is logged', async () => {
  const qq = await mockQq();
  const or = await mockOr();
  const s = site(qq, { or });
  const { factories } = stubFactories({
    onTurn: (_turn, _opts, args) => {
      args.ledger.noteProviderError({ httpStatus: 402, limitSource: 'openrouter_key_limit' });
      return { started: true, hostError: true, aborted: false, usage: null };
    },
  });
  const { ctl, run } = await liveBot(s, factories);
  assert.equal(peek(s, (store) => store.getControl('paid_paused')), null, 'positive control: nothing paused before the turn');
  qq.push('GROUP_MESSAGE_CREATE', atMessage('MSGOWN0101'));
  await until(() => peek(s, (store) => FINAL(store.getEvent(store.key('MSGOWN0101'))?.state)), 'the turn ended');
  peek(s, (store) => {
    assert.equal(store.getControl('paid_paused'), 'openrouter_key_limit', 'the gate counted the started failure');
    const held = store.q('SELECT held_micros FROM reservations WHERE event_key=?').get(store.key('MSGOWN0101'))?.held_micros;
    const own = replyHoldMicros('reply_required', s.eff.models.primary, 'own');
    assert.notEqual(own, replyHoldMicros('reply_required', s.eff.models.primary, 'openclaw'), 'positive control: the two holds differ');
    assert.equal(held, own);
  });
  const names = events(s).map((e) => e.event);
  assert.ok(names.includes('start_account'), 'positive control: the run logged');
  assert.equal(names.includes('runtime_mismatch'), false);
  ctl.abort();
  await ends(run, 'an aborted run');
});

test('own wiring: an owner /stop aborts the signal the running turn was handed (not aborted before it: control)', async () => {
  const qq = await mockQq();
  const or = await mockOr();
  const s = site(qq, { or });
  let signal = null;
  let abortedBefore = null;
  let abortedAfter = null;
  const { factories } = stubFactories({
    onTurn: async (_turn, opts) => {
      signal = opts?.signal ?? null;
      abortedBefore = signal?.aborted ?? null;
      // Ends on the abort, or after 4 s without one, so a missing abort fails an assertion instead of hanging.
      await new Promise((r) => {
        const timer = setTimeout(r, 4000);
        signal?.addEventListener?.('abort', () => { clearTimeout(timer); r(); }, { once: true });
        releases.push(r);
      });
      abortedAfter = signal?.aborted ?? null;
      return { started: true, hostError: false, aborted: abortedAfter === true, usage: null };
    },
  });
  const { ctl, run } = await liveBot(s, factories);
  qq.push('GROUP_MESSAGE_CREATE', atMessage('MSGOWN0201'));
  await until(() => signal !== null, 'the turn reached the runner');
  assert.equal(abortedBefore, false, 'positive control: the signal starts out live');
  qq.push('GROUP_MESSAGE_CREATE', ownerAt('MSGOWN0202', '/stop'));
  await until(() => abortedAfter !== null, 'the turn ended', 10000);
  assert.equal(abortedAfter, true, 'the /stop aborted the running call');
  ctl.abort();
  await ends(run, 'an aborted run');
});

test('own wiring: her sent reply joins the group memory ring and reaches the next turn as her own line', async () => {
  const qq = await mockQq();
  const or = await mockOr();
  const s = site(qq, { or });
  const { seen, factories } = stubFactories({
    onTurn: (turn, _opts, args) => {
      if (seen.turns.length === 1) args.getExit().collect(turn.turnId, { text: '第一条回复。', isError: false }, { kind: 'final' });
      return { started: true, hostError: false, aborted: false, usage: USAGE };
    },
  });
  const { ctl, run } = await liveBot(s, factories);
  qq.push('GROUP_MESSAGE_CREATE', atMessage('MSGOWN0301', '第一个问题'));
  await until(() => qq.messagePosts().length === 1, 'the first reply reached QQ');
  await until(() => peek(s, (store) => FINAL(store.getEvent(store.key('MSGOWN0301'))?.state)), 'the first turn ended');
  qq.push('GROUP_MESSAGE_CREATE', atMessage('MSGOWN0302', '第二个问题'));
  await until(() => seen.turns.length === 2, 'the second turn reached the runner');
  const history = seen.turns[1].turn.history;
  assert.ok(Array.isArray(history) && history.length > 0, 'positive control: the second turn has a history');
  const mine = history.filter((h) => h.own === true);
  assert.equal(mine.length, 1, JSON.stringify(history.map((h) => ({ own: h.own === true, len: String(h.body ?? '').length }))));
  assert.equal(mine[0].body, '第一条回复。');
  ctl.abort();
  await ends(run, 'an aborted run');
});

test('one consumer: a bot stops itself once effective.json names another runtime (another change keeps it running: control)', async () => {
  const qq = await mockQq();
  const s = site(qq);
  const { run } = start(s, { stopPollMs: 30 });
  await until(() => qq.identifies.length === 1, 'identify');
  let done = false;
  run.then(() => { done = true; });
  writeFileSync(s.effectivePath, JSON.stringify({ ...s.eff, mode: 'dry-run' }));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(done, false, 'another change to the file is no reason to stop');
  writeFileSync(s.effectivePath, JSON.stringify({ ...s.eff, mode: 'dry-run', runtime: 'openclaw' }));
  assert.deepEqual(await ends(run, 'a run whose runtime was switched away', 10000), { code: EXIT.refused, reason: 'runtime' });
  assert.ok(events(s).some((e) => e.event === 'bot_stop' && e.reason === 'runtime'));
  peek(s, (store) => {
    assert.equal(store.getControl(CONSUMER_LEASE_KEY), null, 'the lease is dropped, so the other runtime may connect');
    assert.equal(store.getControl('heartbeat_at'), null);
  });
});

test('one consumer: the OpenClaw plugin refuses to connect while a live bot holds a fresh lease; a dead or stale holder does not block it (control)', async () => {
  const { startAccount } = await import('../../src/clo-plugin/index.js');
  const { stopServices } = await import('../../src/clo-plugin/lib/channels/qq/services.js');
  const qq = await mockQq();
  const makeCtx = (st) => {
    const ctl = new AbortController();
    live.push(ctl);
    let status = {};
    return {
      ctl,
      account: { accountId: 'default', enabled: true, appId: st.eff.qq.appId, clientSecret: 'SECRET-FAKE', apiBaseUrl: qq.base, tokenBaseUrl: qq.base },
      cfg: { plugins: { entries: { clo: { config: { effectivePath: st.effectivePath } } } } },
      channelRuntime: {},
      abortSignal: ctl.signal,
      getStatus: () => status,
      setStatus: (next) => { status = next; },
    };
  };
  const gone = await deadPid();
  try {
    const s = site(qq, { runtime: 'openclaw' });
    // This test process stands in for a bot clo has no record of: alive, and its lease just renewed.
    peek(s, (store) => store.setControl(CONSUMER_LEASE_KEY, `${process.pid}:orphan-run`, 'bot'));
    const ctx = makeCtx(s);
    await ends(startAccount(ctx), 'a refused plugin start', 5000);
    assert.equal(ctx.getStatus().terminalDisconnect, true);
    assert.equal(ctx.getStatus().lastError, 'another consumer holds the account');
    assert.equal(qq.opened(), 0, 'no second consumer');
    assert.ok(events(s).some((e) => e.event === 'start_refused' && e.reason === 'running' && e.kind === 'bot'));
    stopServices();

    // The same lease, but from a process that is gone.
    const d = site(qq, { runtime: 'openclaw' });
    peek(d, (store) => store.setControl(CONSUMER_LEASE_KEY, `${gone}:dead-run`, 'bot'));
    const ctx2 = makeCtx(d);
    const running = startAccount(ctx2);
    runs.push(running);
    await until(() => ctx2.getStatus().connected === true, 'a dead holder does not block the Gateway');
    ctx2.ctl.abort();
    await ends(running, 'an aborted plugin run');
    stopServices();

    // An alive PID whose lease was not renewed for longer than LEASE_STALE_MS.
    const t = site(qq, { runtime: 'openclaw' });
    peek(t, (store) => {
      store.setControl(CONSUMER_LEASE_KEY, `${process.pid}:stale-run`, 'bot');
      store.q('UPDATE control SET updated_at=? WHERE key=?').run(Date.now() - LEASE_STALE_MS - 1000, CONSUMER_LEASE_KEY);
    });
    const ctx3 = makeCtx(t);
    const running3 = startAccount(ctx3);
    runs.push(running3);
    await until(() => ctx3.getStatus().connected === true, 'a stale lease does not block the Gateway');
    ctx3.ctl.abort();
    await ends(running3, 'an aborted plugin run');
  } finally {
    stopServices();
  }
});
