import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createLedger } from '../../src/clo-plugin/lib/core/ledger.js';
import { createLog } from '../../src/clo-plugin/lib/core/log.js';
import { openStore } from '../../src/clo-plugin/lib/core/store.js';

const dir = mkdtempSync(join(tmpdir(), 'clo-reconcile-'));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
let n = 0;
const T0 = Date.UTC(2026, 10, 3, 4, 0, 0);
const FAKE_KEY = 'sk-or-v1-FAKE-RECONCILE-KEY';

function setup({ mode = 'live', key = FAKE_KEY } = {}) {
  const clock = { t: T0 };
  const store = openStore(join(dir, `r${++n}.db`), { runGen: 'g', now: () => clock.t });
  const eff = { mode, budget: { dailyUsd: 2.5, interjectUsd: 0.75, searchUsd: 2.1, namedUsd: 2.25, addressedUsd: 2.5, residualMinUsd: 0.25, residualPct: 0.15, providerFailStreakPause: 3 }, openrouter: { baseUrl: 'http://mock/api/v1' } };
  const key_ = { usage: 0, limit: 3.25, limit_remaining: 3.25, limit_reset: 'daily', usage_daily: 0 };
  const calls = [];
  const state = { fail: false, status: 200 };
  const fetchStub = async (url, init) => {
    calls.push({ url, init });
    await state.before?.();
    if (state.fail) throw new Error('network down');
    if (state.status !== 200) return { ok: false, status: state.status, json: async () => ({ error: { message: 'provider text that must not be logged' } }) };
    return { ok: true, status: 200, json: async () => ({ data: { ...key_ } }) };
  };
  const logFile = join(dir, `r${n}.jsonl`);
  const ledger = createLedger({ store, getEffective: () => eff, fetch: fetchStub, getKey: () => key, log: createLog(logFile), now: () => clock.t });
  return { store, ledger, clock, eff, key: key_, calls, state, logFile };
}
const row = (store, id) => store.q('SELECT * FROM reservations WHERE id=?').get(id);
const unsettledHold = (ledger, usd, eventKey = 'E') => {
  const { id } = ledger.reserve({ tier: 'addressed', category: 'reply', heldMicros: Math.round(usd * 1e6), eventKey });
  ledger.markUnsettled(id);
  return id;
};

test('readKey sends the key as a bearer header to /key, and parses money into micros', async () => {
  const { ledger, store, calls, key } = setup();
  key.usage = 1.5;
  key.usage_daily = 0.25;
  const k = await ledger.readKey();
  assert.deepEqual(k, { limitMicros: 3250000, remainingMicros: 3250000, limitReset: 'daily', usageMicros: 1500000, usageDailyMicros: 250000 });
  assert.equal(calls[0].url, 'http://mock/api/v1/key');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${FAKE_KEY}`);
  store.close();
});

test('readKey throws without a key, on HTTP errors, and on a bad body, naming no key or provider text', async () => {
  const none = setup({ key: null });
  await assert.rejects(none.ledger.readKey(), /no key/);
  assert.equal(none.calls.length, 0);
  none.store.close();

  const http = setup();
  http.state.status = 401;
  await assert.rejects(http.ledger.readKey(), (e) => {
    assert.match(e.message, /HTTP 401/);
    assert.ok(!e.message.includes(FAKE_KEY));
    assert.ok(!e.message.includes('provider text'));
    return true;
  });
  http.store.close();
});

test('deltas settle unsettled rows first, oldest first, and the rest becomes unattributed', async () => {
  const { ledger, store, key, clock } = setup();
  key.usage = 10;
  assert.equal((await ledger.reconcile(clock.t)).ok, true);
  const a = unsettledHold(ledger, 0.2, 'A');
  clock.t += 1;
  const b = unsettledHold(ledger, 0.2, 'B');
  clock.t += 60000;
  key.usage = 10.25;
  await ledger.reconcile(clock.t);
  assert.equal(row(store, a).status, 'settled');
  assert.equal(row(store, a).actual_micros, 200000);
  assert.equal(row(store, a).source, 'key_delta');
  assert.equal(row(store, b).status, 'settled');
  assert.equal(row(store, b).actual_micros, 50000);
  assert.equal(ledger.spent().unsettled, 0);

  clock.t += 60000;
  key.usage = 10.35;
  await ledger.reconcile(clock.t);
  const extra = store.q("SELECT * FROM reservations WHERE category='unattributed'").all();
  assert.equal(extra.length, 1);
  assert.equal(extra[0].actual_micros, 100000);
  assert.equal(extra[0].source, 'key_delta');
  assert.equal(extra[0].tier, 'none');
  store.close();
});

test('with no delta, an unsettled row stays unsettled: zero is not free', async () => {
  const { ledger, store, key, clock } = setup();
  key.usage = 1;
  await ledger.reconcile(clock.t);
  const a = unsettledHold(ledger, 0.2);
  clock.t += 60000;
  await ledger.reconcile(clock.t);
  assert.equal(row(store, a).status, 'unsettled');
  store.close();
});

test('spend already settled locally is not attributed twice', async () => {
  const { ledger, store, key, clock } = setup();
  key.usage = 1;
  await ledger.reconcile(clock.t);
  const { id } = ledger.reserve({ tier: 'addressed', category: 'reply', heldMicros: 360000, eventKey: 'E' });
  ledger.settle(id, { actualMicros: 100000, source: 'model.usage' });
  const u = unsettledHold(ledger, 0.2, 'F');
  clock.t += 60000;
  key.usage = 1.1;
  await ledger.reconcile(clock.t);
  assert.equal(row(store, u).status, 'unsettled', 'the delta is the settled call, not this one');
  assert.equal(store.q("SELECT COUNT(*) AS n FROM reservations WHERE category='unattributed'").get().n, 0);
  store.close();
});

test('a call in flight is not read as unexplained', async () => {
  const { ledger, store, key, clock } = setup();
  key.usage = 1;
  await ledger.reconcile(clock.t);
  ledger.reserve({ tier: 'addressed', category: 'reply', heldMicros: 360000, eventKey: 'E' });
  clock.t += 60000;
  key.usage = 1.05;
  const r = await ledger.reconcile(clock.t);
  assert.equal(r.residualMicros, 0);
  assert.equal(store.q("SELECT COUNT(*) AS n FROM reservations WHERE category='unattributed'").get().n, 0);
  store.close();
});

test('the provider figure raises effective spend for the Shanghai day and can stop a tier', async () => {
  const { ledger, store, key, clock } = setup();
  clock.t = Date.UTC(2026, 10, 3, 15, 50, 0); // 23:50 in Shanghai
  key.usage = 5;
  await ledger.reconcile(clock.t);
  clock.t = Date.UTC(2026, 10, 3, 16, 10, 0); // 00:10 in Shanghai
  key.usage = 7.3;
  await ledger.reconcile(clock.t);
  const s = ledger.spent(clock.t);
  assert.equal(s.providerMicros, 2300000);
  assert.equal(s.effectiveMicros, 2300000);
  assert.deepEqual(ledger.reserve({ tier: 'named', category: 'decision', heldMicros: 1 }), { ok: false, reason: 'total' });
  assert.equal(ledger.reserve({ tier: 'addressed', category: 'reply', heldMicros: 100000 }).ok, true);
  store.close();
});

test('a residual pauses only on the second read, then a clean read resumes', async () => {
  const { ledger, store, key, clock, eff } = setup();
  key.usage = 1;
  await ledger.reconcile(clock.t);
  clock.t += 60000;
  key.usage = 1.4;
  const first = await ledger.reconcile(clock.t);
  assert.equal(first.residualMicros, 400000);
  assert.equal(first.paused, false, 'one read over the line is not enough');
  clock.t += 60000;
  const second = await ledger.reconcile(clock.t);
  assert.equal(second.paused, true);
  assert.equal(store.getControl('paid_paused'), 'residual');
  assert.equal(ledger.reserve({ tier: 'addressed', category: 'reply', heldMicros: 1 }).reason, 'paid_paused');

  eff.budget.residualMinUsd = 1;
  clock.t += 60000;
  const third = await ledger.reconcile(clock.t);
  assert.equal(third.paused, false);
  assert.equal(store.getControl('paid_paused'), null);
  store.close();
});

test('the residual threshold is the larger of the floor and the percentage', async () => {
  const { ledger, store, key, clock } = setup();
  key.usage = 1;
  await ledger.reconcile(clock.t);
  clock.t += 60000;
  key.usage = 1.2;
  await ledger.reconcile(clock.t);
  clock.t += 60000;
  const r = await ledger.reconcile(clock.t);
  assert.equal(r.residualMicros, 200000);
  assert.equal(r.paused, false, '$0.20 is under the $0.25 floor');
  store.close();
});

test('read failure at start pauses at once; later only on the second in a row; success resets it', async () => {
  const start = setup();
  start.state.fail = true;
  const r = await start.ledger.reconcile(start.clock.t, { atStart: true });
  assert.deepEqual(r, { ok: false, residualMicros: null, paused: true });
  assert.equal(start.store.getControl('paid_paused'), 'key_read_failed');
  start.state.fail = false;
  assert.equal((await start.ledger.reconcile(start.clock.t + 1)).paused, false, 'auto-resume only on a clean read');
  start.store.close();

  const later = setup();
  later.state.fail = true;
  assert.equal((await later.ledger.reconcile(later.clock.t)).paused, false);
  later.state.fail = false;
  await later.ledger.reconcile(later.clock.t + 1);
  later.state.fail = true;
  assert.equal((await later.ledger.reconcile(later.clock.t + 2)).paused, false, 'the success reset the count');
  assert.equal((await later.ledger.reconcile(later.clock.t + 3)).paused, true);
  later.store.close();
});

test('crash_unsettled clears only when every unsettled row is settled', async () => {
  const { ledger, store, key, clock } = setup();
  key.usage = 1;
  await ledger.reconcile(clock.t);
  unsettledHold(ledger, 0.1, 'A');
  unsettledHold(ledger, 0.1, 'B');
  store.setControl('paid_paused', 'crash_unsettled', 'recovery');
  clock.t += 60000;
  key.usage = 1.1;
  assert.equal((await ledger.reconcile(clock.t)).paused, true, 'one row still unsettled');
  clock.t += 60000;
  key.usage = 1.2;
  assert.equal((await ledger.reconcile(clock.t)).paused, false);
  store.close();
});

test('key limit stays paused until the key has room; usage_unavailable never auto-resumes', async () => {
  const { ledger, store, key, clock } = setup();
  key.usage = 1;
  key.limit_remaining = 0;
  store.setControl('paid_paused', 'openrouter_key_limit', 'test');
  assert.equal((await ledger.reconcile(clock.t)).paused, true);
  key.limit_remaining = 2;
  assert.equal((await ledger.reconcile(clock.t + 1)).paused, false);

  store.setControl('paid_paused', 'usage_unavailable', 'test');
  assert.equal((await ledger.reconcile(clock.t + 2)).paused, true);
  store.close();
});

test('a lower lifetime figure means a new key: rebaseline and alert, attributing nothing', async () => {
  const { ledger, store, key, clock } = setup();
  key.usage = 9;
  await ledger.reconcile(clock.t);
  clock.t += 60000;
  key.usage = 0.5;
  const r = await ledger.reconcile(clock.t);
  assert.equal(r.residualMicros, 0);
  assert.equal(store.listAlerts().filter((a) => a.kind === 'key_changed').length, 1);
  clock.t += 60000;
  key.usage = 0.6;
  await ledger.reconcile(clock.t);
  assert.equal(store.q("SELECT SUM(actual_micros) AS m FROM reservations WHERE category='unattributed'").get().m, 100000);
  store.close();
});

test('reconcile logs neither the key nor provider text', async () => {
  const { ledger, store, state, clock, logFile } = setup();
  state.status = 500;
  await ledger.reconcile(clock.t);
  store.close();
  const text = readFileSync(logFile, 'utf8');
  assert.match(text, /key_read_failed/, 'positive control: the failure was logged');
  assert.ok(!text.includes(FAKE_KEY));
  assert.ok(!text.includes('provider text'));
});

test('timers: dry-run reads nothing; live reads at start, then each tick while unsettled, else every 10 minutes when connected', async () => {
  const flush = () => new Promise((r) => setImmediate(r));
  const fake = () => {
    const box = { fn: null };
    return { box, setTimer: (fn) => { box.fn = fn; return { unref() {} }; }, clearTimer: () => { box.fn = null; } };
  };

  const dry = setup({ mode: 'dry-run' });
  const dt = fake();
  const dl = createLedger({ store: dry.store, getEffective: () => dry.eff, fetch: async (...a) => { dry.calls.push(a); throw new Error('x'); }, getKey: () => FAKE_KEY, now: () => dry.clock.t, setTimer: dt.setTimer, clearTimer: dt.clearTimer });
  dl.startTimers();
  dt.box.fn();
  await flush();
  assert.equal(dry.calls.length, 0, 'dry-run makes no key read');
  dl.stopTimers();
  assert.equal(dt.box.fn, null);
  dry.store.close();

  const { store, clock, eff } = setup();
  const calls = [];
  const ft = fake();
  const fetchOk = async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => ({ data: { usage: 1, limit: 3, limit_remaining: 2, limit_reset: 'daily', usage_daily: 0 } }) }; };
  const ledger = createLedger({ store, getEffective: () => eff, fetch: fetchOk, getKey: () => FAKE_KEY, now: () => clock.t, setTimer: ft.setTimer, clearTimer: ft.clearTimer });
  ledger.startTimers();
  await flush();
  assert.equal(calls.length, 1, 'start read');
  clock.t += 60000;
  ft.box.fn();
  await flush();
  assert.equal(calls.length, 1, 'not connected and nothing unsettled');
  store.setControl('connected', 'true', 'test');
  clock.t += 60000;
  ft.box.fn();
  await flush();
  assert.equal(calls.length, 1, 'connected, but under 10 minutes');
  clock.t += 10 * 60000;
  ft.box.fn();
  await flush();
  assert.equal(calls.length, 2);
  unsettledHold(ledger, 0.1);
  clock.t += 60000;
  ft.box.fn();
  await flush();
  assert.equal(calls.length, 3, 'every 60 s while anything is unsettled');
  ledger.stopTimers();
  store.close();
});

test('provider day is the Shanghai day, not a rolling 24 hours: an older snapshot does not count', async () => {
  const { ledger, store, key, clock } = setup();
  clock.t = Date.UTC(2026, 10, 3, 10, 0, 0); // 18:00 in Shanghai, more than 24 h before the last read
  key.usage = 1;
  await ledger.reconcile(clock.t);
  clock.t = Date.UTC(2026, 10, 3, 15, 50, 0); // 23:50 in Shanghai
  key.usage = 5;
  await ledger.reconcile(clock.t);
  clock.t = Date.UTC(2026, 10, 4, 12, 0, 0); // 20:00 the next Shanghai day
  key.usage = 7;
  await ledger.reconcile(clock.t);
  assert.equal(ledger.spent(clock.t).providerMicros, 2000000, 'since the snapshot before midnight, not 6.00 since the older one');
  store.close();
});

const MIN = 60000;

test('no charge on the Key: after the delay and enough clean reads the row settles at zero and the pause clears', async () => {
  const { ledger, store, key, clock } = setup();
  key.usage = 10;
  await ledger.reconcile(clock.t);
  const a = unsettledHold(ledger, 0.36, 'A');
  store.setControl('paid_paused', 'crash_unsettled', 'recovery');
  for (let i = 0; i < 14; i += 1) {
    clock.t += MIN;
    assert.equal((await ledger.reconcile(clock.t)).paused, true, `still inside the delay at minute ${i + 1}`);
  }
  assert.equal(row(store, a).status, 'unsettled');
  clock.t += MIN;
  assert.equal((await ledger.reconcile(clock.t)).paused, false);
  assert.equal(row(store, a).status, 'settled');
  assert.equal(row(store, a).actual_micros, 0);
  assert.equal(row(store, a).source, 'key_delta_none');
  assert.equal(store.getControl('paid_paused'), null);
  assert.equal(ledger.spent(clock.t).unsettled, 0);
  store.close();
});

test('the delay alone is not enough: too few Key reads since the row leaves it unsettled', async () => {
  const { ledger, store, key, clock } = setup();
  key.usage = 10;
  await ledger.reconcile(clock.t);
  const a = unsettledHold(ledger, 0.36, 'A');
  clock.t += 20 * MIN;
  await ledger.reconcile(clock.t);
  assert.equal(row(store, a).status, 'unsettled', 'one read');
  clock.t += MIN;
  await ledger.reconcile(clock.t);
  assert.equal(row(store, a).status, 'unsettled', 'two reads');
  clock.t += MIN;
  await ledger.reconcile(clock.t);
  assert.equal(row(store, a).status, 'settled', 'three reads');
  store.close();
});

test('a call in flight or a charge on the Key keeps zero-settling off', async () => {
  const flying = setup();
  flying.key.usage = 10;
  await flying.ledger.reconcile(flying.clock.t);
  const a = unsettledHold(flying.ledger, 0.36, 'A');
  flying.ledger.reserve({ tier: 'addressed', category: 'reply', heldMicros: 360000, eventKey: 'B' });
  for (let i = 0; i < 20; i += 1) {
    flying.clock.t += MIN;
    await flying.ledger.reconcile(flying.clock.t);
  }
  assert.equal(row(flying.store, a).status, 'unsettled', 'the charge could be hiding behind the held call');
  flying.store.close();

  const charged = setup();
  charged.key.usage = 10;
  await charged.ledger.reconcile(charged.clock.t);
  const b = unsettledHold(charged.ledger, 0.36, 'B');
  charged.clock.t += 20 * MIN;
  charged.key.usage = 10.007;
  await charged.ledger.reconcile(charged.clock.t);
  assert.equal(row(charged.store, b).source, 'key_delta', 'a real delta settles at the delta, not at zero');
  assert.equal(row(charged.store, b).actual_micros, 7000);
  charged.store.close();
});

test('a row from before the baseline is not cleared by reads after it', async () => {
  const { ledger, store, key, clock } = setup();
  const a = unsettledHold(ledger, 0.36, 'A');
  clock.t += MIN;
  key.usage = 10;
  await ledger.reconcile(clock.t);
  for (let i = 0; i < 20; i += 1) {
    clock.t += MIN;
    await ledger.reconcile(clock.t);
  }
  assert.equal(row(store, a).status, 'unsettled', 'the charge may be inside the baseline itself');
  store.close();
});

test('a charge that shows up after zero-settling still counts, as an unattributed residual', async () => {
  const { ledger, store, key, clock } = setup();
  key.usage = 10;
  await ledger.reconcile(clock.t);
  const a = unsettledHold(ledger, 0.36, 'A');
  for (let i = 0; i < 16; i += 1) {
    clock.t += MIN;
    await ledger.reconcile(clock.t);
  }
  assert.equal(row(store, a).source, 'key_delta_none');
  clock.t += MIN;
  key.usage = 10.3;
  const r = await ledger.reconcile(clock.t);
  assert.equal(r.residualMicros, 300000);
  assert.equal(ledger.spent(clock.t).providerMicros, 300000);
  store.close();
});

test('budget fields can change the delay and the read count, for a calibrated value after Q5', async () => {
  const { ledger, store, key, clock, eff } = setup();
  eff.budget.unsettledClearMs = MIN;
  eff.budget.unsettledClearReads = 1;
  key.usage = 10;
  await ledger.reconcile(clock.t);
  const a = unsettledHold(ledger, 0.36, 'A');
  clock.t += MIN;
  await ledger.reconcile(clock.t);
  assert.equal(row(store, a).source, 'key_delta_none');
  store.close();
});

test('late usage for a known event settles its row whether held or unsettled, and clears a settlement pause', async () => {
  const { ledger, store, clock } = setup();
  const a = unsettledHold(ledger, 0.36, 'LATE');
  store.setControl('paid_paused', 'usage_missing', 'gate');
  assert.equal(ledger.applyLateUsage('LATE', { actualMicros: 7000, source: 'computed', model: 'm' }).status, 'settled');
  assert.equal(row(store, a).actual_micros, 7000);
  assert.equal(store.getControl('paid_paused'), null);
  assert.equal(store.q('SELECT COUNT(*) AS n FROM reservations').get().n, 1, 'no second row');

  const { id } = ledger.reserve({ tier: 'addressed', category: 'reply', heldMicros: 360000, eventKey: 'HELD' });
  ledger.applyLateUsage('HELD', { actualMicros: 8000, source: 'computed', model: 'm' });
  assert.equal(row(store, id).status, 'settled');
  assert.equal(ledger.markUnsettled(id), false, 'the gate learns it is already settled');
  assert.ok(clock.t > 0);
  store.close();
});

const pause = (store, reason) => store.setControl('paid_paused', reason, 'test');
const paidAlerts = (store) => store.listAlerts().filter((a) => a.kind === 'paid_paused').map((a) => a.detail.reason);

test('a read at or below zero relabels any lower reason as the key limit and clears nothing', async () => {
  for (const remaining of [0, -0.5]) {
    for (const reason of ['key_read_failed', 'residual', 'provider_fail', 'crash_unsettled', 'usage_missing', 'openrouter_credits', null]) {
      const { ledger, store, key, clock } = setup();
      key.limit_remaining = remaining;
      if (reason) pause(store, reason);
      const r = await ledger.reconcile(clock.t);
      assert.equal(r.paused, true, `${reason} at ${remaining}`);
      assert.equal(store.getControl('paid_paused'), 'openrouter_key_limit', `${reason} at ${remaining}`);
      assert.deepEqual(paidAlerts(store), ['openrouter_key_limit']);
      store.close();
    }
  }
});

test('usage_unavailable outranks a read at zero, and the key limit is not alerted twice', async () => {
  const { ledger, store, key, clock } = setup();
  key.limit_remaining = 0;
  pause(store, 'usage_unavailable');
  await ledger.reconcile(clock.t);
  assert.equal(store.getControl('paid_paused'), 'usage_unavailable');
  store.delControl('paid_paused');
  await ledger.reconcile(clock.t + 1);
  await ledger.reconcile(clock.t + 2);
  assert.deepEqual(paidAlerts(store), ['openrouter_key_limit']);
  store.close();
});

test('a null remaining figure (no limit on the Key) never reads as exhausted', async () => {
  const { ledger, store, key, clock } = setup();
  key.limit = null;
  key.limit_remaining = null;
  assert.equal((await ledger.reconcile(clock.t)).paused, false);
  store.close();
});

test('provider_fail clears on a clean read with room or no limit, and clears its streak', async () => {
  for (const remaining of [2, null]) {
    const { ledger, store, key, clock } = setup();
    key.limit_remaining = remaining;
    for (let i = 0; i < 3; i += 1) ledger.noteProviderError({});
    assert.equal(store.getControl('paid_paused'), 'provider_fail');
    assert.equal((await ledger.reconcile(clock.t)).paused, false, String(remaining));
    assert.equal(store.peekCounter('provider_fail_streak'), 0);
    store.close();
  }
});

test('an exhausted Key seen only as a primary streak stays paused at zero and clears once there is room', async () => {
  const { ledger, store, key, clock } = setup();
  for (let i = 0; i < 3; i += 1) ledger.noteProviderError({});
  key.limit_remaining = 0;
  await ledger.reconcile(clock.t);
  assert.equal(store.getControl('paid_paused'), 'openrouter_key_limit');
  key.limit_remaining = 2;
  assert.equal((await ledger.reconcile(clock.t + 1)).paused, false);
  assert.equal(store.peekCounter('provider_fail_streak'), 0, 'the streak behind the relabelled pause does not outlive it');
  store.close();
});

test('lower reasons cannot take a limit pause away, so it does not clear early', async () => {
  const { ledger, store, key, clock, state } = setup();
  key.limit_remaining = 0;
  ledger.noteProviderError({ httpStatus: 403, limitSource: 'openrouter_key_limit' });
  for (let i = 0; i < 3; i += 1) ledger.noteProviderError({});
  assert.equal(store.getControl('paid_paused'), 'openrouter_key_limit', 'provider_fail did not overwrite it');
  state.fail = true;
  await ledger.reconcile(clock.t, { atStart: true });
  assert.equal(store.getControl('paid_paused'), 'openrouter_key_limit', 'key_read_failed did not overwrite it');
  state.fail = false;
  key.limit_remaining = null;
  assert.equal((await ledger.reconcile(clock.t + 1)).paused, false, 'positive control: the limit reason clears when the figure allows');
  store.close();
});

test('rank order: settlement reasons give way to a limit, and a limit to usage_unavailable', () => {
  const { ledger, store } = setup();
  ledger.pausePaid('usage_missing', 'gate');
  ledger.noteProviderError({ httpStatus: 402, limitSource: 'openrouter_key_limit' });
  assert.equal(store.getControl('paid_paused'), 'openrouter_key_limit', 'usage_missing must not block the limit');
  ledger.pausePaid('usage_missing', 'gate');
  ledger.pausePaid('crash_unsettled', 'gate');
  assert.equal(store.getControl('paid_paused'), 'openrouter_key_limit');
  ledger.noteProviderError({ httpStatus: 402, limitSource: 'openrouter_credits' });
  assert.equal(store.getControl('paid_paused'), 'openrouter_credits', 'equal rank overwrites');
  ledger.pausePaid('usage_unavailable', 'services');
  ledger.noteProviderError({ httpStatus: 402, limitSource: 'openrouter_key_limit' });
  assert.equal(store.getControl('paid_paused'), 'usage_unavailable');
  store.close();

  const low = setup();
  low.ledger.pausePaid('usage_missing', 'gate');
  low.ledger.pausePaid('provider_fail');
  assert.equal(low.store.getControl('paid_paused'), 'usage_missing', 'settlement stays above everything else');
  low.store.close();
});

test('the rank order is exported from one place', async () => {
  const { pauseRank } = await import('../../src/clo-plugin/lib/core/store.js');
  const order = [['usage_unavailable'], ['openrouter_key_limit', 'openrouter_credits'], ['crash_unsettled', 'usage_missing'], ['provider_fail', 'key_read_failed', 'residual', 'anything_else']];
  for (let i = 0; i < order.length; i += 1) {
    for (const a of order[i]) {
      for (const b of order[i]) assert.equal(pauseRank(a), pauseRank(b), `${a} and ${b}`);
      for (const b of order[i + 1] ?? []) assert.ok(pauseRank(a) > pauseRank(b), `${a} above ${b}`);
    }
  }
});

test('a limit pause clearing past unsettled rows becomes usage_missing, and the settled-clear path ends it', async () => {
  for (const [reason, wait] of [['openrouter_key_limit', 60000], ['openrouter_credits', 3600000]]) {
    const { ledger, store, key, clock } = setup();
    key.usage = 10;
    await ledger.reconcile(clock.t);
    clock.t += 1;
    const a = unsettledHold(ledger, 0.36, 'A');
    pause(store, reason);
    clock.t += wait;
    assert.equal((await ledger.reconcile(clock.t)).paused, true, `${reason}: paid work must not run on`);
    assert.equal(store.getControl('paid_paused'), 'usage_missing', reason);
    assert.deepEqual(ledger.reserve({ tier: 'addressed', category: 'reply', heldMicros: 1000, eventKey: 'B' }), { ok: false, reason: 'paid_paused' });
    assert.deepEqual(paidAlerts(store), ['usage_missing'], 'the owner is told');

    let reads = 0;
    while (store.getControl('paid_paused') !== null && reads < 20) {
      clock.t += 60000;
      await ledger.reconcile(clock.t);
      reads += 1;
    }
    assert.equal(store.getControl('paid_paused'), null, `${reason}: no console command needed`);
    assert.equal(row(store, a).source, 'key_delta_none');
    store.close();
  }
});

test('a limit pause clearing with nothing unsettled just clears', async () => {
  const { ledger, store, key, clock } = setup();
  key.limit_remaining = 2;
  pause(store, 'openrouter_key_limit');
  assert.equal((await ledger.reconcile(clock.t)).paused, false);
  assert.deepEqual(paidAlerts(store), []);
  store.close();
});

test('credits: a clean read alone does not clear; after the wait it does; a failed call pauses again with a fresh time', async () => {
  const { ledger, store, clock } = setup();
  const HOUR = 3600000;
  ledger.noteProviderError({ httpStatus: 402, limitSource: 'openrouter_credits' });
  assert.equal(store.controlUpdatedAt('paid_paused'), clock.t);
  clock.t += HOUR - 1;
  assert.equal((await ledger.reconcile(clock.t)).paused, true, 'one millisecond short');
  assert.equal(store.getControl('paid_paused'), 'openrouter_credits');
  clock.t += 1;
  assert.equal((await ledger.reconcile(clock.t)).paused, false, 'the wait is over');

  clock.t += 60000;
  ledger.noteProviderError({ httpStatus: 402 });
  assert.equal(store.getControl('paid_paused'), 'openrouter_credits');
  assert.equal(store.controlUpdatedAt('paid_paused'), clock.t, 'a fresh time');
  clock.t += HOUR - 1;
  assert.equal((await ledger.reconcile(clock.t)).paused, true, 'the wait starts over');
  store.close();
});

test('credits: budget.creditsRetryMs changes the wait, and a read at zero still names the Key', async () => {
  const { ledger, store, clock, eff, key } = setup();
  eff.budget.creditsRetryMs = 60000;
  ledger.pausePaid('openrouter_credits');
  clock.t += 59999;
  assert.equal((await ledger.reconcile(clock.t)).paused, true);
  clock.t += 1;
  assert.equal((await ledger.reconcile(clock.t)).paused, false);

  ledger.pausePaid('openrouter_credits');
  clock.t += 60000;
  key.limit_remaining = 0;
  assert.equal((await ledger.reconcile(clock.t)).paused, true);
  assert.equal(store.getControl('paid_paused'), 'openrouter_key_limit');
  store.close();
});

test('a Key rotated while paused: the old rows stay counted at their hold and paid work resumes, without a console command', async () => {
  const { ledger, store, key, clock } = setup();
  key.usage = 1.5;
  await ledger.reconcile(clock.t);
  clock.t += 60000;
  const old = unsettledHold(ledger, 0.36, 'OLD');
  key.limit_remaining = 0;
  await ledger.reconcile(clock.t);
  assert.equal(store.getControl('paid_paused'), 'openrouter_key_limit');
  const before = ledger.spent(clock.t).effectiveMicros;

  clock.t += 5 * 60000;
  key.usage = 0;
  key.limit_remaining = 5;
  assert.equal((await ledger.reconcile(clock.t)).paused, false);
  assert.equal(store.getControl('paid_paused'), null);
  assert.equal(store.listAlerts().filter((a) => a.kind === 'key_changed').length, 1);
  const r = row(store, old);
  assert.equal(r.status, 'settled');
  assert.equal(r.source, 'key_changed');
  assert.equal(r.actual_micros, r.held_micros, 'never free');
  assert.equal(ledger.spent(clock.t).localMicros, before, 'the day still counts it');
  assert.equal(ledger.reserve({ tier: 'addressed', category: 'reply', heldMicros: 1000, eventKey: 'NEW' }).ok, true);
  store.close();
});

test('a Key rotated: what the old rows cost explains nothing charged on the new Key', async () => {
  const { ledger, store, key, clock } = setup();
  key.usage = 1.5;
  await ledger.reconcile(clock.t);
  clock.t += 60000;
  unsettledHold(ledger, 0.36, 'OLD');
  clock.t += 60000;
  key.usage = 0;
  await ledger.reconcile(clock.t);
  clock.t += 60000;
  key.usage = 0.1;
  await ledger.reconcile(clock.t);
  const stray = store.q("SELECT actual_micros FROM reservations WHERE category='unattributed'").all();
  assert.deepEqual(stray.map((s) => s.actual_micros), [100000], 'the new charge is seen in full');
  store.close();
});

test('a read started before a limit error cannot clear the pause when it returns', async () => {
  const { ledger, store, key, clock, state } = setup();
  key.limit_remaining = 1;
  await ledger.reconcile(clock.t);
  state.before = async () => {
    clock.t += 1000;
    ledger.noteDecisionError({ httpStatus: 403, limitSource: 'openrouter_key_limit' });
  };
  assert.equal((await ledger.reconcile(clock.t)).paused, true);
  assert.equal(store.getControl('paid_paused'), 'openrouter_key_limit');
  state.before = null;
  clock.t += 60000;
  assert.equal((await ledger.reconcile(clock.t)).paused, false, 'positive control: a read started after it clears it');
  store.close();
});

test('an older read landing after a newer one at zero does not lift what that one set', async () => {
  const { ledger, store, key, clock, state } = setup();
  key.limit_remaining = 1;
  state.before = async () => {
    state.before = null;
    clock.t += 1000;
    key.limit_remaining = 0;
    await ledger.reconcile(clock.t);
    key.limit_remaining = 1;
  };
  assert.equal((await ledger.reconcile(clock.t)).paused, true);
  assert.equal(store.getControl('paid_paused'), 'openrouter_key_limit');
  store.close();
});

test('a credits pause that relabelled provider_fail ends the streak with it', async () => {
  const { ledger, store, clock } = setup();
  for (let i = 0; i < 3; i += 1) ledger.noteProviderError({});
  assert.equal(store.peekCounter('provider_fail_streak'), 3);
  ledger.noteProviderError({ httpStatus: 402 });
  assert.equal(store.getControl('paid_paused'), 'openrouter_credits');
  assert.equal(store.peekCounter('provider_fail_streak'), 3, 'positive control: it was there');
  clock.t += 3600000;
  assert.equal((await ledger.reconcile(clock.t)).paused, false);
  assert.equal(store.peekCounter('provider_fail_streak'), 0);
  ledger.noteProviderOk();
  ledger.noteProviderError({});
  assert.equal(store.getControl('paid_paused'), null, 'one later failure does not pause at once');
  store.close();
});

test('credits: primary failures after the wait pause as credits again with a fresh time, so the wait bounds them too', async () => {
  const { ledger, store, clock } = setup();
  const HOUR = 3600000;
  ledger.pausePaid('openrouter_credits');
  clock.t += HOUR;
  assert.equal((await ledger.reconcile(clock.t)).paused, false);
  clock.t += 1000;
  ledger.noteProviderError({});
  ledger.noteProviderError({});
  assert.equal(store.getControl('paid_paused'), null, 'a failure streak is still three');
  ledger.noteProviderError({});
  assert.equal(store.getControl('paid_paused'), 'openrouter_credits', 'not provider_fail, which the next read would lift');
  assert.equal(store.controlUpdatedAt('paid_paused'), clock.t);
  clock.t += 60000;
  assert.equal((await ledger.reconcile(clock.t)).paused, true, 'a clean read a minute later does not lift it');
  store.close();
});

test('credits: any paid success since the wait means the money is there, and failures are provider_fail again', async () => {
  for (const ok of ['noteProviderOk', 'noteDecisionOk']) {
    const { ledger, store, clock } = setup();
    ledger.pausePaid('openrouter_credits');
    clock.t += 3600000;
    await ledger.reconcile(clock.t);
    ledger[ok]();
    for (let i = 0; i < 3; i += 1) ledger.noteProviderError({});
    assert.equal(store.getControl('paid_paused'), 'provider_fail', ok);
    store.close();
  }
});

test('the owner can lift a credits pause early, and it still will not run past unsettled rows', async () => {
  const clean = setup();
  clean.ledger.pausePaid('openrouter_credits');
  assert.deepEqual(clean.ledger.clearOwnerPause(), { cleared: true, reason: 'openrouter_credits' });
  assert.equal(clean.store.getControl('paid_paused'), null);
  clean.store.close();

  const rows = setup();
  unsettledHold(rows.ledger, 0.36, 'A');
  rows.ledger.pausePaid('openrouter_credits');
  assert.deepEqual(rows.ledger.clearOwnerPause(), { cleared: true, reason: 'openrouter_credits' });
  assert.equal(rows.store.getControl('paid_paused'), 'usage_missing');
  rows.store.close();
});

test('the owner can lift usage_unavailable, and nothing a read could lift', () => {
  const { ledger, store } = setup();
  ledger.pausePaid('usage_unavailable', 'services');
  assert.deepEqual(ledger.clearOwnerPause(), { cleared: true, reason: 'usage_unavailable' });
  assert.equal(store.getControl('paid_paused'), null);
  assert.deepEqual(ledger.clearOwnerPause(), { cleared: false, reason: null });
  for (const reason of ['openrouter_key_limit', 'provider_fail', 'key_read_failed', 'residual', 'usage_missing', 'crash_unsettled']) {
    pause(store, reason);
    assert.deepEqual(ledger.clearOwnerPause(), { cleared: false, reason });
    assert.equal(store.getControl('paid_paused'), reason);
  }
  store.close();
});
