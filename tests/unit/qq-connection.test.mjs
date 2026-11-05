// Connection loop and liveness on the real SDK against mock-qq. Fast versions of what e2e/qq-lifecycle
// shows on the real Gateway. Real half-open sockets have not been seen: this drives the decision logic.
import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { createDownWatch, createLivenessMonitor, DOWN_ALERT_AFTER_MS, DOWN_CONTINUITY_MS, isFatalClose, QQ_INTENTS, runConnection } from '../../src/clo-plugin/lib/channels/qq/connection.js';
import { startMockQq } from '../harness/mock-qq.mjs';

const mocks = [];
after(async () => {
  for (const m of mocks) await m.stop();
});

// A failed assertion must not leave a connection open, or the test process never exits.
const live = [];
afterEach(() => {
  for (const c of live.splice(0)) c.abort();
});

const until = async (cond, what, ms = 15000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

// Taken now: two tests below shorten the global timer, and this deadline must not shrink with it.
const realTimer = globalThis.setTimeout;

// Settles to the error the run ended with, or null. A run still going at the deadline fails by name.
async function ending(run, what, ms = 15000) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = realTimer(() => reject(new assert.AssertionError({ message: `${what}: still running after ${ms} ms` })), ms);
  });
  try {
    return await Promise.race([run.then(() => null, (err) => err), late]);
  } finally {
    clearTimeout(timer);
  }
}

const endsCleanly = async (run, what) => {
  const err = await ending(run, what);
  assert.equal(err, null, `${what}: must not throw`);
};

const endsWithClose = async (run, code) => {
  const err = await ending(run, `close ${code}`);
  assert.equal(err?.closeCode, code, `the run must reject with close code ${code}`);
  assert.ok(isFatalClose(err));
};

async function connect(mock, extra = {}) {
  const ctl = new AbortController();
  live.push(ctl);
  const logs = [];
  const statuses = [];
  const inbound = [];
  const alerts = [];
  let exit = null;
  const done = runConnection({
    account: { appId: 'APP', clientSecret: 'SECRET-FAKE', accountId: 'default', apiBaseUrl: mock.base, tokenBaseUrl: mock.base },
    abortSignal: ctl.signal,
    onInbound: async (evt) => { inbound.push(evt); },
    exitDeps: { store: {}, policy: {}, getEffective: () => null, log: () => {} },
    onExit: (e) => { exit = e; },
    onStatus: (s) => statuses.push(s),
    onAlert: (kind, detail) => alerts.push({ kind, detail }),
    log: (event, data) => logs.push({ event, ...data }),
    userAgent: 'test',
    ...extra,
  });
  return { ctl, logs, statuses, inbound, alerts, done, exit: () => exit };
}

test('connects with bit 25 only; status connected only from READY; abort closes and resolves', async () => {
  const mock = await startMockQq({ ready: false });
  mocks.push(mock);
  const c = await connect(mock);
  await until(() => mock.identifies.length === 1, 'identify');
  assert.equal(mock.identifies[0].intents, QQ_INTENTS);
  assert.equal(QQ_INTENTS, 1 << 25);
  assert.equal(c.statuses.filter((s) => s.connected).length, 0, 'a socket is not READY');
  mock.setUsername('清冷的名字');
  mock.sendReady();
  await until(() => c.statuses.some((s) => s.connected), 'READY');
  const ready = c.statuses.find((s) => s.connected);
  assert.ok(ready.lastReadyAt > 0);
  assert.equal(ready.username, '清冷的名字');
  c.ctl.abort();
  await endsCleanly(c.done, 'an aborted connection');
  await until(() => mock.connected() === 0, 'socket closed');
  assert.equal(c.logs.at(-1).event, 'connection_closed');
});

test('a dropped socket reports disconnected with the code, then RESUMED sets connected again', async () => {
  const mock = await startMockQq();
  mocks.push(mock);
  const c = await connect(mock);
  await until(() => c.statuses.some((s) => s.connected), 'ready');
  mock.closeAll(1000);
  await until(() => c.statuses.some((s) => s.lastDisconnectCode === 1000 && !s.connected), 'disconnect');
  await until(() => mock.resumes.length === 1, 'resume sent', 20000);
  await until(() => c.statuses.at(-1).connected && c.statuses.at(-1).lastResumedAt, 'resumed');
  assert.equal(c.alerts.length, 0);
  c.ctl.abort();
  await endsCleanly(c.done, 'an aborted connection');
});

for (const code of [4914, 4915]) {
  test(`close ${code} rejects with that code and does not reconnect`, async () => {
    const mock = await startMockQq();
    mocks.push(mock);
    const c = await connect(mock);
    await until(() => c.statuses.some((s) => s.connected), 'ready');
    const opened = mock.opened();
    mock.closeAll(code);
    await endsWithClose(c.done, code);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(mock.opened(), opened);
    assert.equal(c.statuses.at(-1).connected, false);
    c.ctl.abort();
  });
}

test('a failing start is retried without limit by this loop: past the old cap, and an abort still ends it', async () => {
  const mock = await startMockQq();
  mocks.push(mock);
  // Each failed token request is one failed start. Eleven passes the alert line and the trial's cap of 5.
  mock.failToken(1000);
  const ctl = new AbortController();
  live.push(ctl);
  const logs = [];
  const alerts = [];
  let exit = null;
  const realSetTimeout = globalThis.setTimeout;
  // The real delays are 5 to 60 s. Only timers set by this loop's backoff are shortened.
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms >= 5000 ? 5 : ms, ...rest);
  try {
    const done = runConnection({
      account: { appId: 'APP', clientSecret: 'SECRET-FAKE', accountId: 'default', apiBaseUrl: mock.base, tokenBaseUrl: mock.base },
      abortSignal: ctl.signal,
      onInbound: async () => {},
      exitDeps: { store: {}, policy: {}, getEffective: () => null, log: () => {} },
      onExit: (e) => { exit = e; },
      onStatus: () => {},
      onAlert: (kind) => alerts.push(kind),
      log: (event, data) => logs.push({ event, ...data }),
      userAgent: 'test',
    });
    await until(() => logs.filter((l) => l.event === 'connection_start_failed').length >= 11, 'eleven failures', 20000);
    assert.equal(alerts.filter((k) => k === 'connection_failing').length, 1, 'one alert at ten');
    mock.failToken(0);
    await until(() => mock.connected() === 1, 'recovers once the token works', 20000);
    ctl.abort();
    await endsCleanly(done, 'an aborted retry loop');
    assert.ok(exit, 'the exit was handed out');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

const nameEvent = (id, group) => ({ id, content: '<@all> 你好', timestamp: new Date().toISOString(), group_openid: group, group_id: group, author: { member_openid: 'U', bot: false, username: 'NAME' }, mentions: [{ scope: 'all', is_you: true, username: 'MENTIONED' }] });

test('the handler copies the payload, and with no group switch on no display name passes', async () => {
  const mock = await startMockQq();
  mocks.push(mock);
  const c = await connect(mock);
  await until(() => c.statuses.some((s) => s.connected), 'ready');
  mock.push('GROUP_MESSAGE_CREATE', nameEvent('M1', 'G'));
  await until(() => c.inbound.length === 1, 'inbound');
  assert.equal(c.inbound[0].text, '@所有人 你好');
  assert.equal(JSON.stringify(c.inbound[0]).includes('NAME'), false);
  c.ctl.abort();
  await endsCleanly(c.done, 'an aborted connection');
});

test('real SDK shape: author.username reaches the raw event only for a group with the switch on, read per message', async () => {
  const mock = await startMockQq();
  mocks.push(mock);
  const groups = { ON: { displayNames: true }, OFF: { displayNames: false }, UNSET: {} };
  const c = await connect(mock, { exitDeps: { store: {}, policy: {}, getEffective: () => ({ qq: { groups } }), log: () => {} } });
  await until(() => c.statuses.some((s) => s.connected), 'ready');
  for (const [i, g] of ['ON', 'OFF', 'UNSET', 'NOT_ADMITTED', 'hasOwnProperty'].entries()) mock.push('GROUP_MESSAGE_CREATE', nameEvent(`N${i}`, g));
  await until(() => c.inbound.length === 5, 'inbound');
  assert.deepEqual(c.inbound.map((e) => e.displayNameRaw), ['NAME', undefined, undefined, undefined, undefined]);
  assert.ok(!JSON.stringify(c.inbound).includes('MENTIONED'), 'mentions[].username never passes');
  groups.ON = { displayNames: false };
  groups.OFF = { displayNames: true };
  mock.push('GROUP_MESSAGE_CREATE', nameEvent('N5', 'ON'));
  mock.push('GROUP_MESSAGE_CREATE', nameEvent('N6', 'OFF'));
  await until(() => c.inbound.length === 7, 'after the switch moved');
  assert.deepEqual(c.inbound.slice(5).map((e) => e.displayNameRaw), [undefined, 'NAME'], 'no restart needed');
  c.ctl.abort();
  await endsCleanly(c.done, 'an aborted connection');
});

test('liveness: isolated probe failures on a lossy path never restart a working socket', async () => {
  // REST flapping while the socket stays up.
  const results = [false, true, false, false, true, false, true, false, false, true];
  let restarts = 0;
  const logs = [];
  const m = createLivenessMonitor({
    probe: async () => results.shift(),
    isConnected: () => true,
    restart: () => { restarts += 1; },
    takeRestartSlot: () => true,
    log: (event, data) => logs.push({ event, ...data }),
  });
  for (let i = 0; i < 10; i += 1) await m.tick();
  assert.equal(restarts, 0);
  assert.deepEqual(logs, [], 'not even reported as failing');
});

test('liveness: a run of failed probes then a recovery, while the SDK still thinks it is connected, restarts once', async () => {
  const results = [false, false, false, true, true];
  let restarts = 0;
  const logs = [];
  const m = createLivenessMonitor({
    probe: async () => results.shift(),
    isConnected: () => true,
    restart: () => { restarts += 1; },
    takeRestartSlot: () => true,
    log: (event, data) => logs.push({ event, ...data }),
  });
  await m.tick();
  await m.tick();
  assert.deepEqual(logs, [], 'two failures are not yet suspect');
  await m.tick();
  assert.equal(restarts, 0, 'not while it is failing');
  assert.equal(logs[0].state, 'failing');
  await m.tick();
  assert.equal(restarts, 1);
  await m.tick();
  assert.equal(restarts, 1, 'not again on a steady probe');
});

test('liveness: a healthy probe never restarts (control); nor does recovery when the SDK already saw the drop', async () => {
  let restarts = 0;
  const healthy = createLivenessMonitor({ probe: async () => true, isConnected: () => true, restart: () => { restarts += 1; }, takeRestartSlot: () => true });
  await healthy.tick();
  await healthy.tick();
  assert.equal(restarts, 0);
  const results = [false, false, false, true];
  const logs = [];
  const down = createLivenessMonitor({ probe: async () => results.shift(), isConnected: () => false, restart: () => { restarts += 1; }, takeRestartSlot: () => true, log: (event, data) => logs.push(data.state) });
  for (let i = 0; i < 4; i += 1) await down.tick();
  assert.deepEqual(logs, ['failing', 'recovered'], 'the recovery was reached, so the no-restart below is about the drop');
  assert.equal(restarts, 0);
});

test('liveness: restarts stop at the session cap', async () => {
  let restarts = 0;
  let slots = 2;
  const flips = [false, false, false, true, false, false, false, true, false, false, false, true];
  const logs = [];
  const m = createLivenessMonitor({
    probe: async () => flips.shift(),
    isConnected: () => true,
    restart: () => { restarts += 1; },
    takeRestartSlot: () => (slots-- > 0),
    log: (event, data) => logs.push({ event, ...data }),
  });
  for (let i = 0; i < 12; i += 1) await m.tick();
  assert.equal(restarts, 2);
  assert.ok(logs.some((l) => l.event === 'liveness_restart' && l.state === 'cap_reached'));
});

test('liveness restart on the real SDK: one new identify, one socket, peak 1', async () => {
  const mock = await startMockQq();
  mocks.push(mock);
  const c = await connect(mock, { probeIntervalMs: 30, takeRestartSlot: () => true });
  await until(() => c.statuses.some((s) => s.connected), 'ready');
  // A probe failing while the socket stays up is what a half-open connection looks like from here.
  const exit = c.exit();
  const realProbe = exit.probe;
  const flips = [false, false, false];
  exit.probe = async () => (flips.length ? flips.shift() : realProbe());
  await until(() => mock.identifies.length === 2 || mock.resumes.length === 1, 'a rebuilt session', 15000);
  await until(() => mock.connected() === 1, 'one socket', 15000);
  assert.ok(c.logs.some((l) => l.event === 'liveness_restart' && l.state === 'restarting'));
  c.ctl.abort();
  await endsCleanly(c.done, 'an aborted connection');
  assert.equal(mock.peak(), 1);
});

test('liveness: a READY or RESUMED newer than the first failed probe is not rebuilt; an older one is', async () => {
  let t = 1000;
  const run = async (connectedAt) => {
    const results = [false, false, false, true];
    let restarts = 0;
    const logs = [];
    const m = createLivenessMonitor({
      probe: async () => results.shift(),
      isConnected: () => true,
      restart: () => { restarts += 1; },
      takeRestartSlot: () => true,
      lastConnectedAt: () => connectedAt,
      now: () => t,
      log: (event, data) => logs.push(`${event}:${data.state}`),
    });
    for (let i = 0; i < 4; i += 1) {
      t += 60000;
      await m.tick();
    }
    return { restarts, logs };
  };
  // The first failed probe runs at 61000 in each pass.
  const newer = await run(61001);
  assert.equal(newer.restarts, 0);
  assert.ok(newer.logs.includes('liveness_restart:already_reconnected'));
  t = 1000;
  const older = await run(60999);
  assert.equal(older.restarts, 1);
  assert.ok(older.logs.includes('liveness_restart:restarting'));
  t = 1000;
  assert.equal((await run(null)).restarts, 1, 'never connected on record');
});

test('liveness: the failing mark starts with the first failure of the run, not an earlier broken-off one', async () => {
  let t = 0;
  const results = [false, true, false, false, false, true];
  let restarts = 0;
  const m = createLivenessMonitor({
    probe: async () => results.shift(),
    isConnected: () => true,
    restart: () => { restarts += 1; },
    takeRestartSlot: () => true,
    // After the broken-off failure at 100, before the real run starts at 300.
    lastConnectedAt: () => 150,
    now: () => t,
  });
  for (let i = 0; i < 6; i += 1) {
    t += 100;
    await m.tick();
  }
  assert.equal(restarts, 1, 'that READY is older than this run, so the socket is still suspect');
});

test('real SDK: REST down, the socket dropped and RESUMED during it, then REST back: no rebuild, no session spent', async () => {
  const mock = await startMockQq();
  mocks.push(mock);
  let slots = 0;
  const c = await connect(mock, { probeIntervalMs: 30, takeRestartSlot: () => { slots += 1; return true; } });
  await until(() => c.statuses.some((s) => s.connected), 'ready');
  const exit = c.exit();
  const realProbe = exit.probe;
  let down = true;
  exit.probe = async () => (down ? false : realProbe());
  await until(() => c.logs.some((l) => l.event === 'liveness_probe' && l.state === 'failing'), 'failing');
  mock.closeAll(1000);
  await until(() => mock.resumes.length === 1, 'resume sent', 20000);
  await until(() => c.statuses.at(-1).connected && c.statuses.at(-1).lastResumedAt, 'resumed');
  const identifies = mock.identifies.length;
  down = false;
  await until(() => c.logs.some((l) => l.event === 'liveness_probe' && l.state === 'recovered'), 'recovered');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(slots, 0);
  assert.equal(mock.identifies.length, identifies);
  assert.equal(mock.resumes.length, 1);
  assert.ok(c.logs.some((l) => l.event === 'liveness_restart' && l.state === 'already_reconnected'));
  c.ctl.abort();
  await endsCleanly(c.done, 'an aborted connection');
});

for (const code of [4914, 4915]) {
  test(`close ${code} still rejects with its code when the status callback throws`, async () => {
    const mock = await startMockQq();
    mocks.push(mock);
    let up = false;
    const c = await connect(mock, { onStatus: (s) => {
      if (s.connected) { up = true; return; }
      throw new Error('database is locked');
    } });
    await until(() => up, 'ready');
    const opened = mock.opened();
    mock.closeAll(code);
    await endsWithClose(c.done, code);
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(mock.opened(), opened);
  });
}

test('a throwing status or alert callback does not end the retry loop', async () => {
  const mock = await startMockQq();
  mocks.push(mock);
  mock.failToken(1000);
  const ctl = new AbortController();
  live.push(ctl);
  const logs = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms >= 5000 ? 5 : ms, ...rest);
  try {
    const done = runConnection({
      account: { appId: 'APP', clientSecret: 'SECRET-FAKE', accountId: 'default', apiBaseUrl: mock.base, tokenBaseUrl: mock.base },
      abortSignal: ctl.signal,
      onInbound: async () => {},
      exitDeps: { store: {}, policy: {}, getEffective: () => null, log: () => {} },
      onExit: () => {},
      onStatus: () => { throw new Error('database is locked'); },
      onAlert: () => { throw new Error('database is locked'); },
      log: (event, data) => logs.push({ event, ...data }),
      userAgent: 'test',
    });
    await until(() => logs.filter((l) => l.event === 'connection_start_failed').length >= 12, 'past the alert line', 20000);
    assert.ok(logs.some((l) => l.event === 'status_error' && l.reason === 'alert'));
    assert.ok(logs.some((l) => l.event === 'status_error' && l.reason === 'publish'));
    ctl.abort();
    await endsCleanly(done, 'an aborted retry loop');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

function memoryControl() {
  const control = new Map();
  const alerts = [];
  return {
    alerts,
    control,
    getControl: (k) => control.get(k) ?? null,
    setControl: (k, v) => { control.set(k, String(v)); },
    delControl: (k) => { control.delete(k); },
    addAlert: (kind, detail) => { alerts.push({ kind, ...detail }); },
  };
}

test('down watch: survives a fresh watch per host restart, and alerts once per outage', () => {
  let t = 1000000;
  const store = memoryControl();
  const fresh = () => createDownWatch({ store, now: () => t });
  let w = fresh();
  w.begin(null);
  w.check(false);
  t += DOWN_ALERT_AFTER_MS - 1;
  w.check(false);
  assert.equal(store.alerts.length, 0, 'not before the line');
  // Host restart: nothing local survives, and the heartbeat is recent.
  w = fresh();
  w.begin(t - 1000);
  t += 1;
  w.check(false);
  assert.equal(store.alerts.length, 1);
  assert.equal(store.alerts[0].kind, 'connection_down');
  assert.equal(store.alerts[0].durationMs, DOWN_ALERT_AFTER_MS);
  w = fresh();
  w.begin(t - 1000);
  t += DOWN_ALERT_AFTER_MS * 3;
  w.check(false);
  assert.equal(store.alerts.length, 1, 'once for this outage');
  w.check(true);
  assert.equal(store.getControl('conn_down_since'), null);
  w.check(false);
  t += DOWN_ALERT_AFTER_MS;
  w.check(false);
  assert.equal(store.alerts.length, 2, 'a new outage alerts again');
});

test('down watch: a heartbeat older than the continuity line starts over; unknown or missing too', () => {
  const t = 1000000000;
  const store = memoryControl();
  const w = createDownWatch({ store, now: () => t });
  store.setControl('conn_down_since', t - DOWN_ALERT_AFTER_MS * 5);
  w.begin(String(t - DOWN_CONTINUITY_MS));
  assert.notEqual(store.getControl('conn_down_since'), null, 'at the line it is the same outage');
  w.begin(String(t - DOWN_CONTINUITY_MS - 1));
  assert.equal(store.getControl('conn_down_since'), null);
  store.setControl('conn_down_since', t - DOWN_ALERT_AFTER_MS * 5);
  w.begin(null);
  assert.equal(store.getControl('conn_down_since'), null);
  store.setControl('conn_down_since', t - DOWN_ALERT_AFTER_MS * 5);
  w.begin('not a number');
  assert.equal(store.getControl('conn_down_since'), null);
});

test('down watch: store failures are logged, never thrown, and a lost alert is retried', () => {
  const t = 1000000;
  const store = memoryControl();
  const logs = [];
  const w = createDownWatch({ store, now: () => t, log: (e) => logs.push(e) });
  store.setControl('conn_down_since', t - DOWN_ALERT_AFTER_MS);
  const realAlert = store.addAlert;
  store.addAlert = () => { throw new Error('database is locked'); };
  w.check(false);
  assert.deepEqual(logs, ['status_error']);
  assert.equal(store.getControl('conn_down_alerted'), null);
  store.addAlert = realAlert;
  w.check(false);
  assert.equal(store.alerts.length, 1);
  // A clear lost while connected is made up by the next check.
  const realDel = store.delControl;
  store.delControl = () => { throw new Error('database is locked'); };
  w.check(true);
  store.delControl = realDel;
  w.check(true);
  assert.equal(store.getControl('conn_down_since'), null);
});
