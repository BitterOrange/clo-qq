// startAccount on the real SDK, the real store and the real host policy, against mock-qq. The host itself
// is replaced by a small ctx. What a locked database does here decides whether a closed account stays closed.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, afterEach, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { GROUP_A, makeEffective, OWNER, ROOT, tempDir } from '../fixtures/inbound.mjs';
import { startMockQq } from '../harness/mock-qq.mjs';

// The plugin normally gets the host SDK from the Gateway's loader. Here it comes from the pinned install.
const PKG_PARENT = pathToFileURL(join(ROOT, '.runtime', 'pkg', 'package.json')).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('openclaw/')) return nextResolve(specifier, { ...context, parentURL: PKG_PARENT });
    return nextResolve(specifier, context);
  },
});

const { startAccount, trackRuns } = await import('../../src/clo-plugin/index.js');
const { getServices, stopServices } = await import('../../src/clo-plugin/lib/channels/qq/services.js');

const DIST = join(ROOT, '.runtime', 'pkg', 'node_modules', 'openclaw', 'dist');
const policyFile = readdirSync(DIST).find((n) => /^channel-health-policy-.*\.mjs$/.test(n));
// The bundled export name is a build detail: a host upgrade that renames it fails here, loudly.
const { r: evaluateChannelHealth } = await import(pathToFileURL(join(DIST, policyFile)).href);

const LOCKED_MS = 120000;
// A refused start does no waiting of its own, and one that wrongly connects would run until aborted.
const REFUSES_MS = 5000;

const mocks = [];
after(async () => {
  for (const m of mocks) await m.stop();
});

// Fails with a named assertion when a run does not end in time, or ends by throwing.
async function ends(run, what, ms = 15000) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new assert.AssertionError({ message: `${what}: still running after ${ms} ms` })), ms);
  });
  try {
    return await Promise.race([
      run.catch((err) => assert.fail(`${what}: must not throw, threw "${err?.message}"`)),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// A failed assertion must not leave anything behind, or the test process never exits and the next test's
// services get stopped by this one's late stop. Turns are released first, since stopping waits for them.
const live = [];
const runs = [];
const releases = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const c of live.splice(0)) c.abort();
  try {
    await ends(Promise.allSettled(runs.splice(0)), 'a run told to abort');
  } finally {
    stopServices();
  }
});

const start = (ctx) => {
  const run = startAccount(ctx);
  // A test that failed first may never await this one. The ones that get there assert through ends().
  run.catch(() => {});
  runs.push(run);
  return run;
};

const until = async (cond, what, ms = 15000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

async function mock(opts) {
  const m = await startMockQq(opts);
  mocks.push(m);
  return m;
}

function site(qq) {
  const dir = tempDir('clo-start-');
  const db = join(dir, 'clo.db');
  const eff = makeEffective({ paths: { db, eventLog: join(dir, 'events.jsonl'), systemPromptFile: join(dir, 'none.md') }, openrouter: { baseUrl: `${qq.base}/none` } });
  const effectivePath = join(dir, 'effective.json');
  writeFileSync(effectivePath, JSON.stringify(eff));
  return { dir, db, eff, effectivePath, closeFile: `${db}.terminal_close` };
}

function makeCtx(s, qq, { signal, rt = {} } = {}) {
  const ctl = new AbortController();
  live.push(ctl);
  let status = {};
  const history = [];
  return {
    ctl,
    history,
    account: { accountId: 'default', enabled: true, appId: s.eff.qq.appId, clientSecret: 'SECRET-FAKE', apiBaseUrl: qq.base, tokenBaseUrl: qq.base },
    cfg: { plugins: { entries: { clo: { config: { effectivePath: s.effectivePath } } } } },
    channelRuntime: rt,
    abortSignal: signal ?? ctl.signal,
    getStatus: () => status,
    setStatus: (next) => {
      status = next;
      history.push(next);
    },
  };
}

const failWrites = (store, keys) => {
  const real = store.setControl;
  store.setControl = (key, ...rest) => {
    if (keys.includes(key)) throw new Error('database is locked');
    return real(key, ...rest);
  };
};

const alertKinds = (store) => store.q('SELECT kind FROM alerts').all().map((a) => a.kind);

// A second connection holding the write lock: real SQLITE_BUSY, after the store's real busy timeout.
function holdLock(db) {
  const other = new DatabaseSync(db);
  other.exec('PRAGMA busy_timeout=0');
  other.exec('BEGIN IMMEDIATE');
  return () => {
    other.exec('ROLLBACK');
    other.close();
  };
}

test('a failing status write still reaches the host: connected is reported and the loop keeps running', async () => {
  const qq = await mock();
  const s = site(qq);
  const { store } = getServices(s.effectivePath);
  failWrites(store, ['connected']);
  const ctx = makeCtx(s, qq);
  const done = start(ctx);
  await until(() => qq.identifies.length === 1, 'identify');
  // READY follows identify at once, so the host not hearing of it shows quickly.
  await until(() => ctx.getStatus().connected === true, 'the host hears connected, whatever the status write did', 5000);
  assert.equal(ctx.getStatus().running, true);
  assert.equal(store.getControl('conn_down_since'), null, 'what follows the failed write still runs');
  qq.closeAll(1000);
  await until(() => qq.resumes.length === 1, 'the SDK still reconnects');
  await until(() => ctx.getStatus().connected === true, 'connected again');
  ctx.ctl.abort();
  await ends(done, 'an aborted run');
  assert.equal(ctx.getStatus().running, false);
});

test('4914 with the database write lock held throughout: no code lost, terminal reported, no reconnect until released and acknowledged', { timeout: 180000 }, async () => {
  const qq = await mock();
  const s = site(qq);
  getServices(s.effectivePath);
  const ctx = makeCtx(s, qq);
  const done = start(ctx);
  await until(() => ctx.getStatus().connected === true, 'connected');
  const opened = qq.opened();
  const release = holdLock(s.db);
  try {
    qq.closeAll(4914);
    // Each write waits out the store's real busy timeout before it fails.
    await ends(done, '4914 under the write lock', LOCKED_MS);
    assert.equal(ctx.getStatus().terminalDisconnect, true, 'the host must not auto-restart');
    assert.equal(ctx.getStatus().running, false);
    assert.equal(ctx.getStatus().lastError, 'gateway closed with code 4914');
    assert.ok(existsSync(s.closeFile), 'the code survived outside the database');
    // A restart while the lock is still held.
    const during = makeCtx(s, qq);
    await ends(start(during), 'a restart while the lock is held', LOCKED_MS);
    assert.equal(during.getStatus().terminalDisconnect, true);
    assert.equal(qq.opened(), opened, 'no connection while the lock is held');
  } finally {
    release();
  }
  // The lock is gone: the code moves into the store, which is what clo ack and the exit read.
  const after_ = makeCtx(s, qq);
  await ends(start(after_), 'a restart with the code on file');
  assert.equal(after_.getStatus().terminalDisconnect, true);
  assert.equal(after_.getStatus().lastError, 'gateway closed with code 4914');
  assert.equal(qq.opened(), opened, 'no connection after the restart');
  assert.equal(existsSync(s.closeFile), false);
  const { store } = getServices(s.effectivePath);
  assert.equal(store.getControl('terminal_close'), '4914');
  assert.ok(alertKinds(store).includes('terminal_close'));
  // Positive control: after clo ack terminal the same site connects.
  store.delControl('terminal_close');
  const acked = makeCtx(s, qq);
  const running = start(acked);
  await until(() => acked.getStatus().connected === true, 'connects once acknowledged');
  assert.ok(qq.opened() > opened);
  acked.ctl.abort();
  await ends(running, 'an aborted run');
});

test('a latch file that exists but cannot be read still refuses', async () => {
  const qq = await mock();
  const s = site(qq);
  mkdirSync(s.closeFile);
  const ctx = makeCtx(s, qq);
  await ends(start(ctx), 'a start with an unreadable latch must refuse, not connect', REFUSES_MS);
  assert.equal(ctx.getStatus().terminalDisconnect, true);
  assert.equal(qq.opened(), 0);
  stopServices();
});

test('a non-close failure writes connection_failed, stops and reports terminal', async () => {
  const qq = await mock();
  qq.failToken(1);
  const s = site(qq);
  const { store } = getServices(s.effectivePath);
  // A signal that cannot be listened to makes the backoff wait throw: an error with no close code.
  const ctx = makeCtx(s, qq, { signal: { aborted: false } });
  const seen = [];
  const realAlert = store.addAlert;
  store.addAlert = (kind, detail) => {
    seen.push(kind);
    return realAlert(kind, detail);
  };
  await ends(start(ctx), 'a non-close failure');
  assert.deepEqual(seen, ['connection_failed']);
  assert.equal(ctx.getStatus().terminalDisconnect, true);
  assert.equal(ctx.getStatus().lastError, 'connection failed');
});

test('a non-close failure with the alert and stop writes failing still reports terminal', async () => {
  const qq = await mock();
  qq.failToken(1);
  const s = site(qq);
  const { store } = getServices(s.effectivePath);
  store.addAlert = () => { throw new Error('database is locked'); };
  failWrites(store, ['connected']);
  const ctx = makeCtx(s, qq, { signal: { aborted: false } });
  await ends(start(ctx), 'a non-close failure with its alert and stop writes failing');
  assert.equal(ctx.getStatus().terminalDisconnect, true);
});

test('an outage carried over a host restart alerts once; READY clears it; a long heartbeat gap starts over', async () => {
  const qq = await mock({ ready: false });
  const s = site(qq);
  const { store } = getServices(s.effectivePath);
  const at = Date.now();
  store.setControl('conn_down_since', at - 11 * 60000);
  store.setControl('heartbeat_at', at - 30000);
  const ctx = makeCtx(s, qq);
  const done = start(ctx);
  await until(() => qq.identifies.length === 1, 'identify');
  assert.deepEqual(alertKinds(store).filter((k) => k === 'connection_down'), ['connection_down']);
  assert.equal(store.getControl('connected'), 'false');
  qq.sendReady();
  await until(() => store.getControl('connected') === 'true', 'READY');
  assert.equal(store.getControl('conn_down_since'), null);
  ctx.ctl.abort();
  await ends(done, 'an aborted run');

  const qq2 = await mock({ ready: false });
  const s2 = site(qq2);
  const { store: store2 } = getServices(s2.effectivePath);
  store2.setControl('conn_down_since', at - 11 * 60000);
  store2.setControl('heartbeat_at', at - 6 * 60000);
  const ctx2 = makeCtx(s2, qq2);
  const done2 = start(ctx2);
  await until(() => qq2.identifies.length === 1, 'identify');
  assert.deepEqual(alertKinds(store2).filter((k) => k === 'connection_down'), [], 'the process was off, the channel was not down that long');
  assert.ok(Number(store2.getControl('conn_down_since')) >= at);
  ctx2.ctl.abort();
  await ends(done2, 'an aborted run');
});

const mention = { scope: 'single', bot: true, is_you: true, id: 'BOTMEMBER', member_openid: 'BOTMEMBER', username: 'BOT' };
const ownerCommand = (id) => ({ id, content: '<@BOTMEMBER> /new', timestamp: new Date().toISOString(), group_openid: GROUP_A, group_id: GROUP_A, message_type: 0, author: { member_openid: OWNER, id: OWNER, bot: false }, mentions: [mention] });

test('a turn in flight is busy to the real host policy, through the real gate; a disconnected idle channel is not', async () => {
  const qq = await mock();
  const s = site(qq);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  releases.push(release);
  let reached = false;
  const rt = {
    routing: { resolveAgentRoute: () => ({ agentId: 'clo', accountId: 'default', sessionKey: 'k' }) },
    inbound: { ingress: { resolve: async () => { reached = true; await held; return { ingress: { admission: 'skip' } }; } } },
  };
  const ctx = makeCtx(s, qq, { rt });
  const done = start(ctx);
  await until(() => ctx.getStatus().connected === true, 'connected');
  const policy = { channelId: 'clo-qq', now: Date.now() + 200000, staleEventThresholdMs: 1800000, channelConnectGraceMs: 120000 };
  const disconnectedLongAgo = (st) => ({ ...st, connected: false, lastDisconnect: { at: Date.now(), status: 1006 } });

  assert.equal(evaluateChannelHealth(disconnectedLongAgo(ctx.getStatus()), policy).reason, 'disconnected', 'the host would restart this');
  qq.push('GROUP_MESSAGE_CREATE', ownerCommand('MSGBUSY1'));
  await until(() => reached, 'the turn reached dispatch');
  const busy = ctx.getStatus();
  assert.equal(busy.busy, true, 'a turn in flight is reported busy');
  assert.equal(busy.activeRuns, 1);
  assert.equal(evaluateChannelHealth(disconnectedLongAgo(busy), policy).reason, 'busy');
  release();
  await until(() => ctx.getStatus().busy === false, 'the turn ended');
  assert.equal(ctx.getStatus().activeRuns, 0);
  assert.equal(evaluateChannelHealth(disconnectedLongAgo(ctx.getStatus()), policy).reason, 'disconnected');
  ctx.ctl.abort();
  await ends(done, 'an aborted run');
});

test('trackRuns counts overlapping turns, keeps the first start, and survives a rejected turn', async () => {
  let t = 1000;
  let status = {};
  const ctx = { getStatus: () => status, setStatus: (n) => { status = n; } };
  const gates = [];
  const wrapped = trackRuns(() => new Promise((resolve, reject) => gates.push({ resolve, reject })), ctx, () => t);
  const a = wrapped();
  t = 2000;
  const b = wrapped();
  assert.equal(status.activeRuns, 2);
  assert.equal(status.activeRunStartedAt, 1000);
  assert.equal(status.lastRunActivityAt, 2000);
  gates[0].reject(new Error('turn failed'));
  await assert.rejects(a, /turn failed/);
  assert.equal(status.busy, true);
  gates[1].resolve('ok');
  assert.equal(await b, 'ok');
  assert.equal(status.busy, false);
  assert.equal(status.activeRuns, 0);
  assert.equal(status.activeRunStartedAt, null);
  // A host status call that throws must not change the turn's outcome.
  const throwing = trackRuns(async () => 'done', { getStatus: () => ({}), setStatus: () => { throw new Error('host'); } });
  assert.equal(await throwing(), 'done');
});

// Last in this file: the last-resort latch lasts as long as the module instance, which is the point.
test('4915 with neither the database nor the file writable: terminal is still reported and this instance refuses to reconnect', async () => {
  const qq = await mock();
  const s = site(qq);
  mkdirSync(`${s.closeFile}.tmp`);
  const { store } = getServices(s.effectivePath);
  const ctx = makeCtx(s, qq);
  const done = start(ctx);
  await until(() => ctx.getStatus().connected === true, 'connected');
  const opened = qq.opened();
  failWrites(store, ['terminal_close']);
  store.addAlert = () => { throw new Error('database is locked'); };
  qq.closeAll(4915);
  await ends(done, '4915 with nowhere to save the code');
  assert.equal(ctx.getStatus().terminalDisconnect, true);
  assert.equal(ctx.getStatus().lastError, 'gateway closed with code 4915');
  const again = makeCtx(s, qq);
  await ends(start(again), 'a restart after 4915 must refuse, not connect', REFUSES_MS);
  assert.equal(again.getStatus().terminalDisconnect, true);
  assert.equal(qq.opened(), opened);
  stopServices();
});
