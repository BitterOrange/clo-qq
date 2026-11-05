// The pause state machine after a clear: what clear-pause leaves behind, relabelled pauses, the credits probe.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createLedger } from '../../src/clo-plugin/lib/core/ledger.js';
import { openStore } from '../../src/clo-plugin/lib/core/store.js';
import { clo, enabledConfig, fakeProvider, makeRoot, withDb } from './_cli-helper.mjs';

const dir = mkdtempSync(join(tmpdir(), 'clo-fix2-ledger-'));
const roots = [];
after(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  roots.forEach((r) => r.cleanup());
});
let n = 0;
const T0 = Date.UTC(2026, 10, 3, 4, 0, 0);
const HOUR = 3600000;

function setup({ streakPause = 3 } = {}) {
  const clock = { t: T0 };
  const file = join(dir, `l${++n}.db`);
  const store = openStore(file, { runGen: 'g', now: () => clock.t });
  const eff = { mode: 'live', budget: { dailyUsd: 2.5, interjectUsd: 0.75, searchUsd: 2.1, namedUsd: 2.25, addressedUsd: 2.5, residualMinUsd: 0.25, residualPct: 0.15, providerFailStreakPause: streakPause }, openrouter: { baseUrl: 'http://mock/api/v1' } };
  const key = { usage: 0, limit: 3.25, limit_remaining: 3.25, limit_reset: 'daily', usage_daily: 0 };
  const state = { fail: false };
  const fetchStub = async () => {
    if (state.fail) throw new Error('network down');
    return { ok: true, status: 200, json: async () => ({ data: { ...key } }) };
  };
  const open = (s) => createLedger({ store: s, getEffective: () => eff, fetch: fetchStub, getKey: () => 'FAKE', log: () => {}, now: () => clock.t });
  const h = { store, ledger: open(store), clock, key, state };
  h.restart = () => {
    h.store.close();
    h.store = openStore(file, { runGen: `g${++n}`, now: () => clock.t });
    h.store.recoverOnStart(clock.t);
    h.ledger = open(h.store);
  };
  return h;
}
const paused = (store) => store.getControl('paid_paused');
const streak = (store) => store.peekCounter('provider_fail_streak');
const fail = (ledger, times = 1) => { for (let i = 0; i < times; i += 1) ledger.noteProviderError({}); };
const unsettledHold = (ledger, eventKey = 'E') => {
  const { id } = ledger.reserve({ tier: 'addressed', category: 'reply', heldMicros: 360000, eventKey });
  ledger.markUnsettled(id);
  return id;
};

test('clear-pause ends the failure streak, so one failure after a top-up does not pause again', () => {
  const { ledger, store } = setup();
  fail(ledger, 2);
  ledger.noteDecisionError({ httpStatus: 402 });
  assert.equal(paused(store), 'openrouter_credits');
  assert.equal(streak(store), 2, 'positive control: it was there');
  assert.equal(ledger.clearOwnerPause().cleared, true);
  assert.equal(streak(store), 0);
  fail(ledger);
  assert.equal(paused(store), null);
  store.close();
});

test('clear-pause after a streak that had already re-paused needs a full streak to pause again', () => {
  const { ledger, store, clock } = setup();
  ledger.pausePaid('openrouter_credits');
  ledger.clearOwnerPause();
  fail(ledger, 3);
  assert.equal(paused(store), 'openrouter_credits');
  clock.t += 60000;
  ledger.clearOwnerPause();
  fail(ledger, 2);
  assert.equal(paused(store), null, 'a failure streak is still three');
  store.close();
});

test('clearing usage_unavailable ends the streak too', () => {
  const { ledger, store } = setup();
  fail(ledger, 3);
  ledger.pausePaid('usage_unavailable', 'services');
  assert.equal(streak(store), 3, 'positive control: it was there');
  ledger.clearOwnerPause();
  assert.equal(streak(store), 0);
  fail(ledger);
  assert.equal(paused(store), null);
  store.close();
});

test('owner clear sets the probe: three failures pause as credits, and a clean read does not lift that', async () => {
  const { ledger, store, clock } = setup();
  ledger.pausePaid('openrouter_credits');
  ledger.clearOwnerPause();
  fail(ledger, 3);
  assert.equal(paused(store), 'openrouter_credits', 'not provider_fail, which the next read would lift');
  clock.t += 60000;
  assert.equal((await ledger.reconcile(clock.t)).paused, true);
  store.close();
});

test('clearing usage_unavailable sets no probe: three failures are provider_fail', () => {
  const { ledger, store } = setup();
  ledger.pausePaid('usage_unavailable', 'services');
  ledger.clearOwnerPause();
  fail(ledger, 3);
  assert.equal(paused(store), 'provider_fail');
  store.close();
});

test('provider_fail relabelled key_read_failed: the clean read that lifts it ends the streak', async () => {
  const { ledger, store, clock, state } = setup();
  fail(ledger, 3);
  state.fail = true;
  await ledger.reconcile(clock.t);
  await ledger.reconcile(clock.t);
  assert.equal(paused(store), 'key_read_failed');
  assert.equal(streak(store), 3, 'positive control: it was there');
  state.fail = false;
  clock.t += 60000;
  assert.equal((await ledger.reconcile(clock.t)).paused, false);
  assert.equal(streak(store), 0);
  fail(ledger);
  assert.equal(paused(store), null, 'one later failure does not pause at once');
  store.close();
});

test('a short streak carried across a key_read_failed pause keeps counting', async () => {
  const { ledger, store, clock, state } = setup();
  fail(ledger, 2);
  state.fail = true;
  await ledger.reconcile(clock.t);
  await ledger.reconcile(clock.t);
  state.fail = false;
  clock.t += 60000;
  await ledger.reconcile(clock.t);
  assert.equal(paused(store), null);
  assert.equal(streak(store), 2);
  fail(ledger);
  assert.equal(paused(store), 'provider_fail', 'those three failures had no success between them');
  store.close();
});

test('provider_fail relabelled usage_missing: late usage that lifts it ends the streak', () => {
  const { ledger, store } = setup();
  const eventKey = 'E1';
  unsettledHold(ledger, eventKey);
  fail(ledger, 3);
  ledger.pausePaid('usage_missing');
  assert.equal(streak(store), 3, 'positive control: it was there');
  ledger.applyLateUsage(eventKey, { actualMicros: 1000, source: 'host' });
  assert.equal(paused(store), null);
  assert.equal(streak(store), 0);
  fail(ledger);
  assert.equal(paused(store), null);
  store.close();
});

test('provider_fail relabelled crash_unsettled: accept-unsettled that lifts it ends the streak', () => {
  const { ledger, store } = setup();
  fail(ledger, 3);
  ledger.pausePaid('crash_unsettled', 'recovery');
  assert.equal(streak(store), 3, 'positive control: it was there');
  ledger.acceptUnsettled('test');
  assert.equal(paused(store), null);
  assert.equal(streak(store), 0);
  fail(ledger);
  assert.equal(paused(store), null);
  store.close();
});

test('credits relabelled by a read at zero: after the Key resets, failures still pause as credits, under the wait', async () => {
  const { ledger, store, key, clock } = setup();
  ledger.noteDecisionError({ httpStatus: 402 });
  assert.equal(paused(store), 'openrouter_credits');
  clock.t += 60000;
  key.limit_remaining = 0;
  await ledger.reconcile(clock.t);
  assert.equal(paused(store), 'openrouter_key_limit');
  clock.t += 60000;
  key.limit_remaining = 1;
  assert.equal((await ledger.reconcile(clock.t)).paused, false, 'room on the Key still lifts it: a bare 402 is often the Key itself');
  fail(ledger, 3);
  assert.equal(paused(store), 'openrouter_credits', 'not provider_fail, which the next read would lift');
  clock.t += 60000;
  assert.equal((await ledger.reconcile(clock.t)).paused, true, 'the wait bounds the next round');
  store.close();
});

test('credits relabelled by a late 403 naming the Key limit: same bound, with no read at zero', async () => {
  const { ledger, store, clock } = setup();
  ledger.noteDecisionError({ httpStatus: 402 });
  ledger.noteDecisionError({ httpStatus: 403, limitSource: 'openrouter_key_limit' });
  assert.equal(paused(store), 'openrouter_key_limit');
  clock.t += 60000;
  assert.equal((await ledger.reconcile(clock.t)).paused, false);
  fail(ledger, 3);
  assert.equal(paused(store), 'openrouter_credits');
  store.close();
});

test('a Key limit pause with no credits pause behind it sets no probe', async () => {
  const { ledger, store, key, clock } = setup();
  key.limit_remaining = 0;
  await ledger.reconcile(clock.t);
  assert.equal(paused(store), 'openrouter_key_limit');
  clock.t += 60000;
  key.limit_remaining = 1;
  await ledger.reconcile(clock.t);
  fail(ledger, 3);
  assert.equal(paused(store), 'provider_fail');
  store.close();
});

test('the credits probe expires: an outage days after an idle wait is provider_fail, and a clean read lifts it', async () => {
  const { ledger, store, clock } = setup();
  ledger.pausePaid('openrouter_credits');
  clock.t += HOUR;
  assert.equal((await ledger.reconcile(clock.t)).paused, false);
  clock.t += 5 * 24 * HOUR;
  fail(ledger, 3);
  assert.equal(paused(store), 'provider_fail');
  clock.t += 60000;
  assert.equal((await ledger.reconcile(clock.t)).paused, false);
  store.close();
});

test('the probe still holds just inside its life, and is gone exactly at the end of it', async () => {
  for (const [age, want] of [[24 * HOUR - 1, 'openrouter_credits'], [24 * HOUR, 'provider_fail']]) {
    const { ledger, store, clock } = setup();
    ledger.pausePaid('openrouter_credits');
    clock.t += HOUR;
    await ledger.reconcile(clock.t);
    clock.t += age;
    fail(ledger, 3);
    assert.equal(paused(store), want, String(age));
    store.close();
  }
});

test('clear-pause does not lift a credits pause past a residual it was masking', async () => {
  const { ledger, store, key, clock } = setup();
  await ledger.reconcile(clock.t);
  ledger.pausePaid('openrouter_credits');
  key.usage = 1;
  for (let i = 0; i < 2; i += 1) {
    clock.t += 60000;
    await ledger.reconcile(clock.t);
  }
  assert.equal(store.getControl('residual_over'), '2');
  assert.equal(paused(store), 'openrouter_credits', 'positive control: credits outranks residual');
  assert.deepEqual(ledger.clearOwnerPause(), { cleared: true, reason: 'openrouter_credits' });
  assert.equal(paused(store), 'residual');
  assert.equal(ledger.reserve({ tier: 'addressed', category: 'reply', heldMicros: 1000 }).reason, 'paid_paused');
  store.close();
});

test('one read over the threshold pauses nothing, so it does not stop clear-pause either', async () => {
  const { ledger, store, key, clock } = setup();
  await ledger.reconcile(clock.t);
  ledger.pausePaid('openrouter_credits');
  key.usage = 1;
  clock.t += 60000;
  await ledger.reconcile(clock.t);
  assert.equal(store.getControl('residual_over'), '1');
  ledger.clearOwnerPause();
  assert.equal(paused(store), null);
  store.close();
});

// --- the probe's life counts only time paid work could run ---

test('a Key at zero for longer than the probe life: it keeps its life, so failures still pause as credits', async () => {
  const { ledger, store, key, clock } = setup();
  ledger.noteDecisionError({ httpStatus: 402 });
  clock.t += 60000;
  key.limit_remaining = 0;
  await ledger.reconcile(clock.t);
  assert.equal(paused(store), 'openrouter_key_limit');
  clock.t += 25 * HOUR;
  key.limit_remaining = 1;
  assert.equal((await ledger.reconcile(clock.t)).paused, false);
  fail(ledger, 3);
  assert.equal(paused(store), 'openrouter_credits', 'not provider_fail: no paid attempt was possible during those 25 hours');
  clock.t += 60000;
  assert.equal((await ledger.reconcile(clock.t)).paused, true);
  store.close();
});

test('owner clear down to a residual that lasts past the probe life: the pause did not age it', async () => {
  const { ledger, store, key, clock } = setup();
  await ledger.reconcile(clock.t);
  ledger.pausePaid('openrouter_credits');
  key.usage = 1;
  for (let i = 0; i < 2; i += 1) {
    clock.t += 60000;
    await ledger.reconcile(clock.t);
  }
  ledger.clearOwnerPause();
  assert.equal(paused(store), 'residual');
  clock.t += 48 * HOUR;
  assert.equal((await ledger.reconcile(clock.t)).paused, false);
  fail(ledger, 3);
  assert.equal(paused(store), 'openrouter_credits');
  store.close();
});

for (const [how, lift] of [
  ['accept-unsettled', (ledger) => ledger.acceptUnsettled('test')],
  ['late usage', (ledger) => ledger.applyLateUsage('E', { actualMicros: 1000, source: 'host' })],
]) {
  test(`a settlement pause past the probe life, lifted by ${how}, does not age it either`, () => {
    const { ledger, store, clock } = setup();
    unsettledHold(ledger);
    ledger.pausePaid('openrouter_credits');
    ledger.clearOwnerPause();
    assert.equal(paused(store), 'usage_missing');
    clock.t += 30 * HOUR;
    lift(ledger);
    assert.equal(paused(store), null);
    fail(ledger, 3);
    assert.equal(paused(store), 'openrouter_credits');
    store.close();
  });
}

test('a probe still alive when an unrelated pause began comes back at its lift', async () => {
  const { ledger, store, clock, state } = setup();
  ledger.pausePaid('openrouter_credits');
  ledger.clearOwnerPause();
  clock.t += HOUR;
  state.fail = true;
  await ledger.reconcile(clock.t);
  await ledger.reconcile(clock.t);
  assert.equal(paused(store), 'key_read_failed');
  clock.t += 30 * HOUR;
  state.fail = false;
  assert.equal((await ledger.reconcile(clock.t)).paused, false);
  fail(ledger, 3);
  assert.equal(paused(store), 'openrouter_credits');
  store.close();
});

test('a probe that died with paid work open does not come back at a later lift', async () => {
  const { ledger, store, clock, state } = setup();
  ledger.pausePaid('openrouter_credits');
  ledger.clearOwnerPause();
  clock.t += 25 * HOUR;
  state.fail = true;
  await ledger.reconcile(clock.t);
  await ledger.reconcile(clock.t);
  assert.equal(paused(store), 'key_read_failed');
  clock.t += 60000;
  state.fail = false;
  assert.equal((await ledger.reconcile(clock.t)).paused, false);
  fail(ledger, 3);
  assert.equal(paused(store), 'provider_fail');
  store.close();
});

test('usage_unavailable over a credits pause keeps the probe: three failures after the clear are credits', async () => {
  const { ledger, store, clock } = setup();
  ledger.pausePaid('openrouter_credits');
  ledger.pausePaid('usage_unavailable', 'services');
  assert.equal(paused(store), 'usage_unavailable');
  clock.t += 30 * HOUR;
  ledger.clearOwnerPause();
  fail(ledger, 3);
  assert.equal(paused(store), 'openrouter_credits');
  clock.t += 60000;
  assert.equal((await ledger.reconcile(clock.t)).paused, true);
  store.close();
});

// --- a residual behind a settlement pause ---

async function residualAndUnsettled() {
  const h = setup();
  await h.ledger.reconcile(h.clock.t);
  h.ledger.pausePaid('openrouter_credits');
  h.key.usage = 1;
  for (let i = 0; i < 2; i += 1) {
    h.clock.t += 60000;
    await h.ledger.reconcile(h.clock.t);
  }
  assert.equal(h.store.getControl('residual_over'), '2');
  // Written directly: the pause refuses a reservation, and a row from before the charge would have absorbed it.
  h.store.q(`INSERT INTO reservations(id, local_day, utc_day, tier, category, held_micros, status, event_key, run_gen, created_at)
    VALUES ('late', '2026-11-03', '2026-11-03', 'addressed', 'reply', 360000, 'unsettled', 'E', 'g', ?)`).run(h.clock.t);
  h.ledger.clearOwnerPause();
  assert.equal(paused(h.store), 'usage_missing', 'positive control: it outranks the residual');
  return h;
}

for (const [how, settle] of [
  ['accept-unsettled', (ledger) => ledger.acceptUnsettled('test')],
  ['late usage', (ledger) => ledger.applyLateUsage('E', { actualMicros: 1000, source: 'host' })],
]) {
  test(`settling by ${how} does not lift past a residual: it is the reason now, until a new day's read`, async () => {
    const { ledger, store, clock } = await residualAndUnsettled();
    settle(ledger);
    assert.equal(paused(store), 'residual');
    assert.equal(ledger.reserve({ tier: 'addressed', category: 'reply', heldMicros: 1000 }).reason, 'paid_paused');
    clock.t += 24 * HOUR;
    assert.equal((await ledger.reconcile(clock.t)).paused, false);
    assert.equal(ledger.reserve({ tier: 'addressed', category: 'reply', heldMicros: 1000 }).ok, true);
    store.close();
  });

  test(`settling by ${how} with one read over the threshold pauses nothing`, async () => {
    const { ledger, store } = setup();
    unsettledHold(ledger);
    ledger.pausePaid('usage_missing');
    store.setControl('residual_over', '1', 'test');
    settle(ledger);
    assert.equal(paused(store), null);
    store.close();
  });
}

test('a residual stays through later reads the same day, and lifts at the first read of the new Shanghai day', async () => {
  const { ledger, store, key, clock } = setup();
  await ledger.reconcile(clock.t);
  key.usage = 1;
  for (let i = 0; i < 2; i += 1) {
    clock.t += 60000;
    await ledger.reconcile(clock.t);
  }
  assert.equal(paused(store), 'residual');
  // T0 is 12:00 in Shanghai.
  for (const at of [T0 + HOUR, T0 + 4 * HOUR, T0 + 12 * HOUR - 1]) {
    clock.t = at;
    assert.equal((await ledger.reconcile(at)).paused, true, String((at - T0) / HOUR));
  }
  clock.t = T0 + 12 * HOUR;
  assert.equal((await ledger.reconcile(clock.t)).paused, false);
  store.close();
});

// --- a streak below the limit paused nothing, so every lift keeps counting it ---

for (const [how, reason, lift] of [
  ['accept-unsettled', 'crash_unsettled', async ({ ledger }) => ledger.acceptUnsettled('test')],
  ['late usage', 'usage_missing', async ({ ledger }) => ledger.applyLateUsage('E', { actualMicros: 1000, source: 'host' })],
]) {
  test(`a short streak carried across a ${reason} pause lifted by ${how} keeps counting`, async () => {
    const h = setup();
    const { ledger, store } = h;
    unsettledHold(ledger);
    fail(ledger, 2);
    ledger.pausePaid(reason, 'test');
    await lift(h);
    assert.equal(paused(store), null);
    assert.equal(streak(store), 2);
    fail(ledger);
    assert.equal(paused(store), 'provider_fail', 'those three failures had no success between them');
    store.close();
  });

  test(`the configured streak limit decides what ${how} ends: 3 of 5 is kept, 2 of 2 is spent`, async () => {
    const five = setup({ streakPause: 5 });
    unsettledHold(five.ledger);
    fail(five.ledger, 3);
    assert.equal(paused(five.store), null, 'three failures do not pause at a limit of five');
    five.ledger.pausePaid(reason, 'test');
    await lift(five);
    assert.equal(paused(five.store), null);
    assert.equal(streak(five.store), 3);
    fail(five.ledger, 2);
    assert.equal(paused(five.store), 'provider_fail');
    five.store.close();

    const two = setup({ streakPause: 2 });
    unsettledHold(two.ledger);
    fail(two.ledger, 2);
    assert.equal(paused(two.store), 'provider_fail');
    two.ledger.pausePaid(reason, 'test');
    await lift(two);
    assert.equal(paused(two.store), null);
    assert.equal(streak(two.store), 0);
    two.store.close();
  });
}

test('the configured streak limit decides what a clean read ends too: 3 of 5 is kept', async () => {
  const { ledger, store, clock, state } = setup({ streakPause: 5 });
  fail(ledger, 3);
  state.fail = true;
  await ledger.reconcile(clock.t);
  await ledger.reconcile(clock.t);
  assert.equal(paused(store), 'key_read_failed');
  state.fail = false;
  clock.t += 60000;
  await ledger.reconcile(clock.t);
  assert.equal(paused(store), null);
  assert.equal(streak(store), 3);
  store.close();
});

async function cliRoot(label) {
  const made = makeRoot(label, enabledConfig());
  roots.push(made);
  const provider = fakeProvider();
  await clo(made.root, ['model', 'refresh'], { fetch: provider.fetch });
  return made.root;
}
const unsettledRow = (s) => s.q(`INSERT INTO reservations(id, local_day, utc_day, tier, category, held_micros, status, run_gen, created_at)
  VALUES ('r1', '2026-11-03', '2026-11-03', 'decision', 'decision', 10000, 'unsettled', 'g', 1)`).run();

test('clo budget clear-pause says so when paid work is still paused on unsettled rows, and names the way out', async () => {
  const r = await cliRoot('stillpaused');
  withDb(r, (s) => {
    unsettledRow(s);
    s.setControl('paid_paused', 'openrouter_credits', 'test');
  });
  const res = await clo(r, ['budget', 'clear-pause']);
  assert.equal(res.code, 0);
  assert.equal(withDb(r, (s) => s.getControl('paid_paused')), 'usage_missing');
  assert.match(res.out, /还没有恢复/);
  assert.match(res.out, /usage_missing/);
  assert.match(res.out, /accept-unsettled/);
  assert.doesNotMatch(res.out, /已解除付费暂停/);

  const again = await clo(r, ['budget', 'clear-pause']);
  assert.equal(again.code, 1);
  assert.match(again.out, /accept-unsettled/, 'the refusal names the way out too');

  assert.match((await clo(r, ['status'])).out, /usage_missing：.*accept-unsettled/, 'and so does status');
});

test('clo budget clear-pause says so when a masked residual takes over', async () => {
  const r = await cliRoot('residual');
  withDb(r, (s) => {
    s.setControl('residual_over', '2', 'test');
    s.setControl('paid_paused', 'openrouter_credits', 'test');
  });
  const res = await clo(r, ['budget', 'clear-pause']);
  assert.equal(res.code, 0);
  assert.equal(withDb(r, (s) => s.getControl('paid_paused')), 'residual');
  assert.match(res.out, /还没有恢复/);
  assert.match(res.out, /residual/);
  assert.doesNotMatch(res.out, /accept-unsettled/);
  assert.match(res.out, /上海时间零点后的第一次 Key 读取/, 'the real way out');
  assert.doesNotMatch(res.out, /回到阈值内/);

  const again = await clo(r, ['budget', 'clear-pause']);
  assert.equal(again.code, 1);
  assert.match(again.out, /上海时间零点后的第一次 Key 读取/, 'the refusal says it too');
  assert.doesNotMatch(again.out, /accept-unsettled/);

  const status = (await clo(r, ['status'])).out;
  assert.match(status, /付费暂停 residual：.*上海时间零点后的第一次 Key 读取/, 'and so does status');
  assert.doesNotMatch(status, /accept-unsettled/);
});

test('with a residual behind unsettled rows, clear-pause and status name both, and accept-unsettled says it is now the residual', async () => {
  const r = await cliRoot('both');
  withDb(r, (s) => {
    unsettledRow(s);
    s.setControl('residual_over', '2', 'test');
    s.setControl('paid_paused', 'openrouter_credits', 'test');
  });
  const res = await clo(r, ['budget', 'clear-pause']);
  assert.equal(withDb(r, (s) => s.getControl('paid_paused')), 'usage_missing');
  assert.match(res.out, /现在的暂停原因是 usage_missing/);
  assert.match(res.out, /accept-unsettled/);
  assert.match(res.out, /还有 residual.*上海时间零点后的第一次 Key 读取/);

  assert.match((await clo(r, ['budget', 'clear-pause'])).out, /还有 residual/, 'the refusal too');
  assert.match((await clo(r, ['status'])).out, /付费暂停 usage_missing：除了这个原因，还有 residual/, 'and status');

  const accepted = await clo(r, ['budget', 'accept-unsettled']);
  assert.equal(accepted.code, 0);
  assert.equal(withDb(r, (s) => s.getControl('paid_paused')), 'residual');
  assert.match(accepted.out, /还没有恢复：现在的暂停原因是 residual/);
  assert.doesNotMatch(accepted.out, /随之解除/);
});

test('with one read over the threshold, nothing names a residual, and accept-unsettled says the pause is lifted', async () => {
  const r = await cliRoot('noresidual');
  withDb(r, (s) => {
    unsettledRow(s);
    s.setControl('residual_over', '1', 'test');
    s.setControl('paid_paused', 'usage_missing', 'test');
  });
  assert.doesNotMatch((await clo(r, ['budget', 'clear-pause'])).out, /residual/);
  assert.doesNotMatch((await clo(r, ['status'])).out, /还有 residual/);
  const accepted = await clo(r, ['budget', 'accept-unsettled']);
  assert.match(accepted.out, /随之解除/);
  assert.equal(withDb(r, (s) => s.getControl('paid_paused')), null);
});

test('the clear-pause refusal offers accept-unsettled only where it does something', async () => {
  const r = await cliRoot('refusals');
  for (const [reason, helps] of [['usage_missing', true], ['crash_unsettled', true], ['openrouter_key_limit', false], ['provider_fail', false], ['key_read_failed', false], ['residual', false]]) {
    withDb(r, (s) => s.setControl('paid_paused', reason, 'test'));
    const res = await clo(r, ['budget', 'clear-pause']);
    assert.equal(res.code, 1, reason);
    (helps ? assert.match : assert.doesNotMatch)(res.out, /accept-unsettled/, reason);
  }
});

test('status on a credits pause says clear-pause can land on usage_missing, not that it lifts at once', async () => {
  const r = await cliRoot('statuscredits');
  withDb(r, (s) => s.setControl('paid_paused', 'openrouter_credits', 'test'));
  const text = (await clo(r, ['status'])).out;
  assert.match(text, /openrouter_credits：充值后可用 clo budget clear-pause 解除（还有未结算记录时转为 usage_missing）/);
  assert.doesNotMatch(text, /立刻解除/);
});

test('clo budget clear-pause with nothing else in the way still says it is lifted, and usage_unavailable still says restart', async () => {
  const r = await cliRoot('lifted');
  withDb(r, (s) => s.setControl('paid_paused', 'openrouter_credits', 'test'));
  const credits = await clo(r, ['budget', 'clear-pause']);
  assert.match(credits.out, /已解除付费暂停 openrouter_credits/);
  assert.doesNotMatch(credits.out, /还没有恢复/);

  withDb(r, (s) => {
    unsettledRow(s);
    s.setControl('paid_paused', 'usage_unavailable', 'test');
  });
  const unavailable = await clo(r, ['budget', 'clear-pause']);
  assert.match(unavailable.out, /还没有恢复/);
  assert.match(unavailable.out, /需要重启 Gateway/);
});

// --- the probe keeps exactly the life it had ---

const PROBE = 'credits_probe';
// An event in dispatching with a hold: the restart writes crash_unsettled from inside the store.
const crash = (h) => {
  h.store.claimEvent({ eventKey: 'C', groupKey: 'G', msgTs: h.clock.t, receivedAt: h.clock.t });
  h.store.transition('C', ['received'], 'dispatching');
  h.ledger.reserve({ tier: 'addressed', category: 'reply', heldMicros: 360000, eventKey: 'C' });
  h.restart();
  assert.equal(paused(h.store), 'crash_unsettled');
};
const startProbe = async (h) => {
  h.ledger.pausePaid('openrouter_credits');
  h.clock.t += HOUR;
  assert.equal((await h.ledger.reconcile(h.clock.t)).paused, false);
};

test('a short pause gives back what the probe had left, and does not start it again', async () => {
  for (const [wait, want] of [[4 * HOUR - 1, 'openrouter_credits'], [4 * HOUR, 'provider_fail']]) {
    const h = setup();
    await startProbe(h);
    h.clock.t += 20 * HOUR;
    h.state.fail = true;
    await h.ledger.reconcile(h.clock.t);
    await h.ledger.reconcile(h.clock.t);
    assert.equal(paused(h.store), 'key_read_failed');
    h.clock.t += 30 * 60000;
    h.state.fail = false;
    assert.equal((await h.ledger.reconcile(h.clock.t)).paused, false);
    h.clock.t += wait;
    fail(h.ledger, 3);
    assert.equal(paused(h.store), want, String(wait));
    h.store.close();
  }
});

test('a pause the store wrote at recovery does not bring back a probe already dead', async () => {
  const h = setup();
  await startProbe(h);
  h.clock.t += 25 * HOUR;
  crash(h);
  h.ledger.acceptUnsettled('test');
  assert.equal(paused(h.store), null);
  assert.equal(h.store.getControl(PROBE), null);
  fail(h.ledger, 3);
  assert.equal(paused(h.store), 'provider_fail');
  h.store.close();
});

test('a pause the store wrote at recovery stops the clock of a live probe', async () => {
  for (const [wait, want] of [[HOUR - 1, 'openrouter_credits'], [HOUR, 'provider_fail']]) {
    const h = setup();
    await startProbe(h);
    h.clock.t += 23 * HOUR;
    crash(h);
    h.clock.t += 30 * HOUR;
    h.ledger.acceptUnsettled('test');
    h.clock.t += wait;
    fail(h.ledger, 3);
    assert.equal(paused(h.store), want, String(wait));
    h.store.close();
  }
});

test('a store pause relabelled by the ledger counts from when the store wrote it', async () => {
  const h = setup();
  await startProbe(h);
  h.clock.t += 23 * HOUR;
  crash(h);
  h.clock.t += 10 * HOUR;
  h.ledger.pausePaid('usage_unavailable', 'services');
  assert.equal(h.store.getControl(PROBE), `f${HOUR}`);
  h.store.close();
});

test('the time left survives a restart during the pause', async () => {
  for (const [wait, want] of [[4 * HOUR - 1, 'openrouter_credits'], [4 * HOUR, 'provider_fail']]) {
    const h = setup();
    await startProbe(h);
    h.clock.t += 20 * HOUR;
    h.ledger.pausePaid('residual');
    h.restart();
    h.clock.t += 2 * HOUR;
    assert.equal((await h.ledger.reconcile(h.clock.t)).paused, false);
    h.clock.t += wait;
    fail(h.ledger, 3);
    assert.equal(paused(h.store), want, String(wait));
    h.store.close();
  }
});

test('a probe written before the expiry was stored lives from when it was written', async () => {
  for (const [age, want] of [[24 * HOUR - 1, 'openrouter_credits'], [24 * HOUR, 'provider_fail']]) {
    const { ledger, store, clock } = setup();
    store.setControl(PROBE, '1', 'ledger');
    clock.t += age;
    fail(ledger, 3);
    assert.equal(paused(store), want, String(age));
    store.close();
  }
  const h = setup();
  h.store.setControl(PROBE, '1', 'ledger');
  h.clock.t += 25 * HOUR;
  crash(h);
  h.ledger.acceptUnsettled('test');
  assert.equal(h.store.getControl(PROBE), null);
  h.store.close();
});

test('a pause that fails to commit freezes nothing, so the probe keeps running', async () => {
  const h = setup();
  await startProbe(h);
  const running = h.store.getControl(PROBE);
  const addAlert = h.store.addAlert;
  h.store.addAlert = () => { throw new Error('disk'); };
  assert.throws(() => h.ledger.pausePaid('residual'), /disk/);
  h.store.addAlert = addAlert;
  assert.equal(paused(h.store), null);
  assert.equal(h.store.getControl(PROBE), running);
  h.store.close();
});
