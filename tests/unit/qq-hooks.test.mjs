// Usage tracker and hook handlers, with fakes for the host. e2e/qq-settlement and e2e/policy-sentinel show
// the same paths on the real Gateway; the branches the host cannot be made to take are here.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createUsageTracker, registerHooks } from '../../src/clo-plugin/lib/channels/qq/hooks.js';
import { createLedger } from '../../src/clo-plugin/lib/core/ledger.js';
import { openStore } from '../../src/clo-plugin/lib/core/store.js';

const PRICE = { inputPerM: 5, outputPerM: 20, cacheReadPerM: 0.5, cacheWritePerM: 6.25 };

function fakeBus() {
  const listeners = new Set();
  return {
    on: (fn, filter) => {
      listeners.add(fn);
      assert.deepEqual(filter, { include: ['model.usage'] });
      return () => listeners.delete(fn);
    },
    emit: (evt) => { for (const fn of listeners) fn(evt); },
    count: () => listeners.size,
  };
}

function fakeLedger() {
  const calls = [];
  return {
    calls,
    applyLateUsage: (eventKey, data) => calls.push(['late', eventKey, data]),
    release: (id) => calls.push(['release', id]),
    markUnsettled: (id) => calls.push(['unsettled', id]),
  };
}

const usageEvent = (sessionKey, over = {}) => ({ type: 'model.usage', sessionKey, model: 'm', usage: { input: 1000, output: 100 }, ...over });
const tracker = (bus, ledger, over = {}) => createUsageTracker({ onInternalDiagnosticEvent: bus.on, ledger, price: () => PRICE, drainWaitMs: 60, ...over });

test('events for the open turn accumulate across calls, and session keys match in any case', async () => {
  const bus = fakeBus();
  const ledger = fakeLedger();
  const t = tracker(bus, ledger);
  t.open('agent:main:clo-qq:group:gABC', { turnId: 'T1' });
  bus.emit(usageEvent('AGENT:MAIN:CLO-QQ:GROUP:GABC', { costUsd: 0.01 }));
  bus.emit(usageEvent('agent:main:clo-qq:group:gabc', { costUsd: 0.02, usage: { input: 5, output: 5, cacheRead: 7, cacheWrite: 9 } }));
  const u = await t.close('T1');
  assert.equal(u.input, 1005);
  assert.equal(u.output, 105);
  assert.equal(u.cacheRead, 7);
  assert.equal(u.cacheWrite, 9);
  assert.ok(Math.abs(u.costUsd - 0.03) < 1e-9);
  assert.equal(u.model, 'm');
  assert.equal(ledger.calls.length, 0, 'nothing was unattributed');
  t.stop();
});

test('no usage within the drain returns null, and tool holds become unsettled rather than free', async () => {
  const bus = fakeBus();
  const ledger = fakeLedger();
  const t = tracker(bus, ledger);
  const entry = t.open('s', { turnId: 'T2' });
  entry.toolHolds.push('H1');
  assert.equal(await t.close('T2'), null);
  assert.deepEqual(ledger.calls, [['unsettled', 'H1']]);
  t.stop();
});

test('usage arriving during the drain is seen; tool holds end released', async () => {
  const bus = fakeBus();
  const ledger = fakeLedger();
  const t = tracker(bus, ledger, { drainWaitMs: 2000 });
  const entry = t.open('s', { turnId: 'T3' });
  entry.toolHolds.push('H2');
  const closing = t.close('T3');
  setTimeout(() => bus.emit(usageEvent('s')), 30);
  const u = await closing;
  assert.equal(u.input, 1000);
  assert.deepEqual(ledger.calls, [['release', 'H2']]);
  t.stop();
});

test('usage with no open turn is unattributed money, computed at the locked price, never dropped', async () => {
  const bus = fakeBus();
  const ledger = fakeLedger();
  const t = tracker(bus, ledger);
  bus.emit(usageEvent('compaction-session'));
  assert.deepEqual(ledger.calls, [['late', null, { actualMicros: 5000 + 2000, source: 'computed', model: 'm' }]]);
  t.stop();
});

test('usage with a cost figure uses it', () => {
  const bus = fakeBus();
  const ledger = fakeLedger();
  const t = tracker(bus, ledger);
  bus.emit(usageEvent('x', { costUsd: 0.5 }));
  assert.equal(ledger.calls[0][2].actualMicros, 500000);
  assert.equal(ledger.calls[0][2].source, 'model.usage');
  t.stop();
});

test('two generations in one process: only the newest counts an event; the old one is silent until it stops', async () => {
  const bus = fakeBus();
  const oldLedger = fakeLedger();
  const newLedger = fakeLedger();
  const old = tracker(bus, oldLedger);
  const fresh = tracker(bus, newLedger);
  assert.equal(bus.count(), 2);
  bus.emit(usageEvent('unknown'));
  assert.equal(oldLedger.calls.length, 0, 'the replaced generation stays quiet');
  assert.equal(newLedger.calls.length, 1, 'positive control: the event was counted once');
  old.stop();
  assert.equal(bus.count(), 1);
  bus.emit(usageEvent('unknown'));
  assert.equal(newLedger.calls.length, 2, 'stopping the old one does not silence the new one');
  fresh.stop();
  assert.equal(bus.count(), 0);
});

test('non-usage events and a close for an unknown turn are ignored', async () => {
  const bus = fakeBus();
  const ledger = fakeLedger();
  const t = tracker(bus, ledger);
  bus.emit({ type: 'model.failover', sessionKey: 'x' });
  assert.equal(ledger.calls.length, 0);
  assert.equal(await t.close('nope'), null);
  t.stop();
});

function hookStack(over = {}) {
  const handlers = new Map();
  const api = { on: (name, fn) => handlers.set(name, fn) };
  const alerts = [];
  const logs = [];
  const reservations = [];
  const entry = { turn: { tier: 'addressed', eventKey: 'E' }, rounds: 0, toolHolds: [] };
  const services = {
    getEffective: () => ({ contentPolicy: { version: '1' }, privacy: { replaceSystemPrompt: true }, models: { primary: { id: 'm' } } }),
    systemPrompt: () => 'REPLACEMENT',
    store: { addAlert: (kind, detail) => alerts.push({ kind, detail }) },
    log: (event, data) => logs.push({ event, ...data }),
    usage: { turnFor: () => entry },
    ledger: {
      holdMicros: () => 100,
      reserve: (r) => {
        reservations.push(r);
        return { ok: true, id: `R${reservations.length}` };
      },
      noted: [],
      noteProviderOk() { this.noted.push('ok'); },
      noteProviderError() { this.noted.push('error'); },
    },
    ...over,
  };
  registerHooks(api, { getServices: () => services });
  return { handlers, services, alerts, logs, reservations, entry };
}

test('the four typed hooks are registered', () => {
  assert.deepEqual([...hookStack().handlers.keys()].sort(), ['before_agent_run', 'before_prompt_build', 'before_tool_call', 'model_call_ended']);
});

test('before_prompt_build returns the file when on, and nothing when off or unreadable', () => {
  const on = hookStack();
  assert.deepEqual(on.handlers.get('before_prompt_build')({}, {}), { systemPrompt: 'REPLACEMENT' });
  const off = hookStack({ getEffective: () => ({ privacy: { replaceSystemPrompt: false } }) });
  assert.equal(off.handlers.get('before_prompt_build')({}, {}), undefined);
  const gone = hookStack({ systemPrompt: () => null });
  assert.equal(gone.handlers.get('before_prompt_build')({}, {}), undefined);
});

test('before_agent_run: pass when whole, block with no policy text otherwise, and alert', () => {
  const s = hookStack();
  const run = s.handlers.get('before_agent_run');
  assert.deepEqual(run({ systemPrompt: '<!-- clo-policy:1 --> x <!-- clo-policy-end:1 -->' }), { outcome: 'pass' });
  for (const prompt of [undefined, '', 'nothing', '<!-- clo-policy:1 -->', '<!-- clo-policy-end:1 --> <!-- clo-policy:1 -->', '<!-- clo-policy:2 --> <!-- clo-policy-end:2 -->']) {
    assert.deepEqual(run({ systemPrompt: prompt }), { outcome: 'block', reason: 'content-policy-check' }, String(prompt));
  }
  assert.equal(s.alerts.length, 6);
  assert.ok(s.alerts.every((a) => a.kind === 'policy_sentinel'));
});

test('before_agent_run with no readable config blocks', () => {
  const s = hookStack({ getEffective: () => null });
  assert.equal(s.handlers.get('before_agent_run')({ systemPrompt: '<!-- clo-policy:1 --> x <!-- clo-policy-end:1 -->' }).outcome, 'block');
});

test('before_tool_call: only our tool, one hold per round under the turn tier, at most two rounds', () => {
  const s = hookStack();
  const call = s.handlers.get('before_tool_call');
  for (const name of ['message', 'exec', 'read', 'tool_call']) assert.equal(call({ toolName: name }, { sessionKey: 'x' }).block, true, name);
  assert.equal(s.reservations.length, 0);
  assert.equal(call({ toolName: 'clo_feature_status' }, { sessionKey: 'x' }), undefined, 'positive control');
  assert.equal(call({ toolName: 'clo_feature_status' }, { sessionKey: 'x' }), undefined);
  assert.equal(call({ toolName: 'clo_feature_status' }, { sessionKey: 'x' }).blockReason, 'tool round limit');
  assert.deepEqual(s.entry.toolHolds, ['R1', 'R2']);
  assert.equal(s.reservations[0].tier, 'addressed');
  assert.equal(s.reservations[0].category, 'tool_round');
});

test('before_tool_call: no active turn or a refused hold blocks', () => {
  const none = hookStack({ usage: { turnFor: () => null } });
  assert.equal(none.handlers.get('before_tool_call')({ toolName: 'clo_feature_status' }, {}).block, true);
  const refused = hookStack();
  refused.services.ledger.reserve = () => ({ ok: false, reason: 'total' });
  assert.equal(refused.handlers.get('before_tool_call')({ toolName: 'clo_feature_status' }, {}).blockReason, 'budget');
});

test('model_call_ended logs whitelisted fields only and moves the provider streak; an abort does not count', () => {
  const s = hookStack();
  const ended = s.handlers.get('model_call_ended');
  ended({ model: 'm', outcome: 'completed', durationMs: 5, rawError: 'SECRET', upstreamRequestIdHash: 'h' });
  ended({ model: 'm', outcome: 'error', errorCategory: 'auth', durationMs: 5 });
  ended({ model: 'm', outcome: 'error', failureKind: 'aborted', durationMs: 5 });
  assert.deepEqual(s.services.ledger.noted, ['ok', 'error']);
  assert.ok(!JSON.stringify(s.logs).includes('SECRET'));
  assert.equal(s.logs[1].reason, 'auth');
});

test('usage after close goes to the turn that just closed: one settled row and no pause', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clo-hooks-'));
  const store = openStore(join(dir, 'h.db'), { runGen: 'g' });
  const eff = { mode: 'live', budget: { dailyUsd: 2.5, interjectUsd: 0.75, searchUsd: 2.1, namedUsd: 2.25, addressedUsd: 2.5 } };
  const ledger = createLedger({ store, getEffective: () => eff, fetch: async () => { throw new Error('no network'); }, getKey: () => null });
  const bus = fakeBus();
  const t = createUsageTracker({ onInternalDiagnosticEvent: bus.on, ledger, price: () => PRICE, drainWaitMs: 10 });
  const { id } = ledger.reserve({ tier: 'addressed', category: 'reply', heldMicros: 360000, eventKey: 'EV' });
  t.open('S', { turnId: 'T', eventKey: 'EV' });
  assert.equal(await t.close('T'), null);
  ledger.markUnsettled(id);
  ledger.pausePaid('usage_missing', 'gate');
  bus.emit(usageEvent('S'));
  const rows = store.q('SELECT status, actual_micros, source FROM reservations').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ status: 'settled', actual_micros: 7000, source: 'computed' }]);
  assert.equal(store.getControl('paid_paused'), null);
  t.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('usage after the late window, or for a session never seen, stays unattributed', async () => {
  const bus = fakeBus();
  const ledger = fakeLedger();
  let at = 1000;
  const t = tracker(bus, ledger, { now: () => at, lateUsageMs: 500 });
  t.open('S', { turnId: 'T', eventKey: 'EV' });
  await t.close('T');
  bus.emit(usageEvent('S'));
  assert.equal(ledger.calls.at(-1)[1], 'EV', 'positive control: inside the window');
  at += 501;
  bus.emit(usageEvent('S'));
  assert.equal(ledger.calls.at(-1)[1], null);
  bus.emit(usageEvent('OTHER'));
  assert.equal(ledger.calls.at(-1)[1], null);
  t.stop();
});

test('an exhausted Key on the primary path: the real host fields only count, and the Key read names it and holds it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clo-hooks-'));
  const store = openStore(join(dir, 'h.db'), { runGen: 'g' });
  const key = { usage: 0, limit: 3.25, limit_remaining: 0, limit_reset: 'daily', usage_daily: 0 };
  const eff = { mode: 'live', budget: { dailyUsd: 2.5, interjectUsd: 0.75, searchUsd: 2.1, namedUsd: 2.25, addressedUsd: 2.5, residualMinUsd: 0.25, residualPct: 0.15, providerFailStreakPause: 3 }, openrouter: { baseUrl: 'http://mock' } };
  const ledger = createLedger({ store, getEffective: () => eff, fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: { ...key } }) }), getKey: () => 'FAKE' });
  const s = hookStack({ ledger });
  const ended = s.handlers.get('model_call_ended');
  // errorCategory is a JS class name and failureKind is transport only: diagnosticErrorCategory in the host.
  for (let i = 0; i < 2; i += 1) ended({ model: 'm', outcome: 'error', errorCategory: 'Error', durationMs: 5 });
  assert.equal(store.getControl('paid_paused'), null, 'nothing in the event says limit');
  ended({ model: 'm', outcome: 'error', errorCategory: 'Error', durationMs: 5 });
  assert.equal(store.getControl('paid_paused'), 'provider_fail');
  assert.equal((await ledger.reconcile(Date.now())).paused, true, 'a clean read at zero must not resume paid work');
  assert.equal(store.getControl('paid_paused'), 'openrouter_key_limit');
  key.limit_remaining = 1;
  assert.equal((await ledger.reconcile(Date.now() + 1)).paused, false);
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
