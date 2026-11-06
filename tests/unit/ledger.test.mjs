import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { estimateTokens } from '../../src/clo-plugin/lib/core/context.js';
import { buildRequest } from '../../src/clo-plugin/lib/core/decision.js';
import { createLedger, replyHoldMicros, usdToMicros } from '../../src/clo-plugin/lib/core/ledger.js';
import { openStore } from '../../src/clo-plugin/lib/core/store.js';

const dir = mkdtempSync(join(tmpdir(), 'clo-ledger-'));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
let n = 0;
const T0 = Date.UTC(2026, 10, 3, 4, 0, 0);

const PRIMARY = { id: 'anthropic/claude-opus-5.5', effort: 'low', maxTokens: 3000, contextTokens: 24000, price: { inputPerM: 5, outputPerM: 20, cacheReadPerM: 0.5, cacheWritePerM: 6.25 } };
const DECISION = { id: 'anthropic/claude-haiku-5.5', effort: 'none', maxTokens: 200, price: { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, cacheWritePerM: 1.25 } };
const budget = (over = {}) => ({ dailyUsd: 2.5, interjectUsd: 0.75, searchUsd: 2.1, namedUsd: 2.25, addressedUsd: 2.5, residualMinUsd: 0.25, residualPct: 0.15, providerFailStreakPause: 3, ...over });

function setup(over = {}, { runtime } = {}) {
  const clock = { t: T0 };
  const store = openStore(join(dir, `l${++n}.db`), { runGen: 'g', now: () => clock.t });
  const eff = { mode: 'live', budget: budget(over), models: { primary: PRIMARY, decision: DECISION }, openrouter: { baseUrl: 'http://mock' } };
  const ledger = createLedger({ store, getEffective: () => eff, fetch: async () => { throw new Error('no network in this test'); }, getKey: () => 'FAKE', now: () => clock.t, ...(runtime ? { runtime } : {}) });
  return { store, ledger, clock, eff };
}
const row = (store, id) => store.q('SELECT * FROM reservations WHERE id=?').get(id);
const reserve = (ledger, tier, usd, extra = {}) => ledger.reserve({ tier, category: 'reply', heldMicros: usdToMicros(usd), eventKey: 'E', ...extra });

test('the decision hold covers the largest input the request can carry, with the real prompt', () => {
  const { ledger, store } = setup();
  const prompt = readFileSync(new URL('../../persona/decision-prompt.zh.md', import.meta.url), 'utf8');
  const eff = { models: { decision: DECISION }, retention: { decisionLines: 15, decisionLineChars: 200, decisionCurrentChars: 800 } };
  const lines = Array.from({ length: 20 }, (_, i) => ({ sender: `U${1000 + i}`, text: '长'.repeat(500) }));
  const body = buildRequest(eff, prompt, { trigger: 'crisis_route', lines, current: { sender: 'U9999', text: '长'.repeat(2000) } });
  const sent = JSON.parse(body.messages[1].content);
  assert.equal(sent.lines.length, 15, 'positive control: this is the largest payload');
  assert.equal(sent.current.text.length, 800);
  const worst = estimateTokens(JSON.stringify(body.messages));
  // DECISION costs $1 per million in and $5 out, so tokens are the hold less the output part.
  const heldInput = ledger.holdMicros('decision') - DECISION.maxTokens * DECISION.price.outputPerM;
  assert.ok(worst <= heldInput, `input of ${worst} tokens, ${heldInput} held`);
  store.close();
});

test('holds use the locked price: worst call is $0.18, required turns hold two', () => {
  const { ledger, store, eff } = setup();
  assert.equal(ledger.holdMicros('reply_optional'), 180000);
  assert.equal(ledger.holdMicros('tool_round'), 180000);
  assert.equal(ledger.holdMicros('reply_required'), 360000);
  assert.equal(ledger.holdMicros('decision'), 10500 + 1000);
  eff.models = { primary: { ...PRIMARY, price: null }, decision: { ...DECISION, price: null } };
  assert.throws(() => ledger.holdMicros('reply_required'), /not locked/);
  assert.throws(() => ledger.holdMicros('decision'), /not locked/);
  assert.throws(() => ledger.holdMicros('other'), /unknown kind/);
  store.close();
});

test('interject tier: its own cap, then the search stop on the whole day', () => {
  const { ledger, store } = setup();
  assert.equal(reserve(ledger, 'interject', 0.5).ok, true);
  assert.equal(reserve(ledger, 'interject', 0.25).ok, true);
  assert.deepEqual(reserve(ledger, 'interject', 0.01), { ok: false, reason: 'tier' });
  store.close();

  const b = setup();
  assert.equal(reserve(b.ledger, 'addressed', 2.0).ok, true);
  assert.equal(reserve(b.ledger, 'interject', 0.1).ok, true, 'exactly at the search stop is allowed');
  assert.deepEqual(reserve(b.ledger, 'interject', 0.01), { ok: false, reason: 'total' });
  b.store.close();
});

test('named and addressed tiers stop at their own totals, in the plan order', () => {
  const { ledger, store } = setup();
  assert.equal(reserve(ledger, 'addressed', 2.25).ok, true);
  assert.deepEqual(reserve(ledger, 'named', 0.01), { ok: false, reason: 'total' });
  assert.equal(reserve(ledger, 'addressed', 0.25).ok, true, '@ can still spend up to the daily total');
  assert.deepEqual(reserve(ledger, 'addressed', 0.01), { ok: false, reason: 'total' });
  store.close();
});

test('a spent interject tier cannot silence a name address or an @', () => {
  const { ledger, store } = setup();
  assert.equal(reserve(ledger, 'interject', 0.75).ok, true);
  assert.equal(reserve(ledger, 'interject', 0.01).ok, false);
  assert.equal(reserve(ledger, 'named', 0.5).ok, true);
  assert.equal(reserve(ledger, 'addressed', 0.5).ok, true);
  store.close();
});

test('paid_paused refuses every tier; tier none and bad holds are refused', () => {
  const { ledger, store } = setup();
  store.setControl('paid_paused', 'residual', 'test');
  for (const tier of ['interject', 'named', 'addressed']) assert.deepEqual(reserve(ledger, tier, 0.01), { ok: false, reason: 'paid_paused' });
  store.delControl('paid_paused');
  assert.deepEqual(reserve(ledger, 'none', 0.01), { ok: false, reason: 'tier' });
  assert.throws(() => ledger.reserve({ tier: 'addressed', category: 'reply', heldMicros: 0 }), /positive integer/);
  assert.throws(() => ledger.reserve({ tier: 'addressed', category: 'reply', heldMicros: 1.5 }), /positive integer/);
  store.close();
});

test('no effective config fails closed', () => {
  const { store } = setup();
  const ledger = createLedger({ store, getEffective: () => null, fetch: async () => {}, getKey: () => null, now: () => T0 });
  assert.equal(ledger.reserve({ tier: 'addressed', category: 'reply', heldMicros: 1 }).ok, false);
  assert.throws(() => ledger.holdMicros('decision'), /no effective/);
  store.close();
});

test('state machine: settle uses actual, release frees, unsettled keeps the hold counted', () => {
  const { ledger, store } = setup();
  const a = reserve(ledger, 'addressed', 0.36).id;
  assert.equal(ledger.spent().localMicros, 360000);
  assert.deepEqual(ledger.settle(a, { actualMicros: 50000, source: 'model.usage', model: 'm' }), { status: 'settled' });
  assert.equal(ledger.spent().localMicros, 50000);
  assert.equal(row(store, a).source, 'model.usage');
  assert.equal(row(store, a).model, 'm');
  assert.deepEqual(ledger.settle(a, { actualMicros: 7, source: 'x' }), { status: 'unchanged' }, 'settled stays settled');

  const b = reserve(ledger, 'addressed', 0.1).id;
  assert.equal(ledger.release(b), true);
  assert.equal(ledger.spent().localMicros, 50000);
  assert.equal(ledger.release(b), false);

  const c = reserve(ledger, 'addressed', 0.2).id;
  assert.equal(ledger.markUnsettled(c), true);
  assert.equal(ledger.spent().localMicros, 250000);
  assert.equal(ledger.spent().unsettled, 1);
  assert.equal(ledger.release(c), false, 'a model that may have run cannot be released');
  assert.deepEqual(ledger.settle(c, { actualMicros: 1000, source: 'key_delta' }), { status: 'settled' });
  assert.equal(ledger.spent().unsettled, 0);
  store.close();
});

test('zero or missing usage is never free', () => {
  const { ledger, store } = setup();
  for (const actualMicros of [0, null, undefined, NaN, 1.5, -3]) {
    const id = reserve(ledger, 'addressed', 0.1).id;
    assert.deepEqual(ledger.settle(id, { actualMicros, source: 'usage.cost' }), { status: 'unsettled' });
    assert.equal(row(store, id).status, 'unsettled');
    assert.equal(row(store, id).held_micros, 100000);
  }
  const manual = reserve(ledger, 'addressed', 0.1).id;
  assert.deepEqual(ledger.settle(manual, { actualMicros: 0, source: 'manual' }), { status: 'settled' });
  store.close();
});

test('spent reports tiers for the Shanghai day and rolls over at its midnight', () => {
  const { ledger, store, clock } = setup();
  reserve(ledger, 'interject', 0.1);
  reserve(ledger, 'named', 0.2);
  reserve(ledger, 'addressed', 0.3);
  assert.deepEqual(ledger.spent().byTier, { interject: 100000, named: 200000, addressed: 300000 });
  clock.t = Date.UTC(2026, 10, 3, 15, 59, 59);
  assert.equal(ledger.spent().localMicros, 600000, 'still 23:59 in Shanghai');
  clock.t = Date.UTC(2026, 10, 3, 16, 0, 0);
  assert.equal(ledger.spent().localMicros, 0, 'a new Shanghai day');
  store.close();
});

test('applyLateUsage settles an unsettled row, adds to a settled one, and never drops money', () => {
  const { ledger, store } = setup();
  const id = reserve(ledger, 'addressed', 0.3).id;
  ledger.markUnsettled(id);
  assert.deepEqual(ledger.applyLateUsage('E', { actualMicros: 12345, source: 'model.usage', model: 'm' }), { status: 'settled', id });
  assert.equal(row(store, id).actual_micros, 12345);

  const adj = ledger.applyLateUsage('E', { actualMicros: 100, source: 'model.usage' });
  assert.equal(adj.status, 'adjusted');
  assert.equal(row(store, adj.id).category, 'adjustment');
  assert.equal(row(store, adj.id).tier, 'addressed');

  const un = ledger.applyLateUsage(null, { actualMicros: 200, source: 'model.usage' });
  assert.equal(un.status, 'unattributed');
  assert.equal(row(store, un.id).tier, 'none');
  assert.equal(row(store, un.id).category, 'unattributed');
  const gone = ledger.applyLateUsage('UNKNOWN', { actualMicros: 300, source: 'model.usage' });
  assert.equal(gone.status, 'unattributed');
  assert.equal(ledger.spent().localMicros, 12345 + 100 + 200 + 300, 'tier none counts in the day total');
  assert.deepEqual(ledger.applyLateUsage(null, { actualMicros: 0 }), { status: 'ignored' });
  store.close();
});

test('unattributed spend counts against the tiers', () => {
  const { ledger, store } = setup();
  ledger.applyLateUsage(null, { actualMicros: usdToMicros(2.25), source: 'model.usage' });
  assert.deepEqual(reserve(ledger, 'named', 0.01), { ok: false, reason: 'total' });
  store.close();
});

test('acceptUnsettled settles at the hold and clears only the settlement pauses', () => {
  const { ledger, store } = setup();
  const id = reserve(ledger, 'addressed', 0.3).id;
  ledger.markUnsettled(id);
  store.setControl('paid_paused', 'crash_unsettled', 'recovery');
  assert.equal(ledger.acceptUnsettled('owner'), 1);
  assert.equal(row(store, id).status, 'settled');
  assert.equal(row(store, id).source, 'manual');
  assert.equal(row(store, id).actual_micros, 300000);
  assert.equal(store.getControl('paid_paused'), null);

  store.setControl('paid_paused', 'openrouter_credits', 'test');
  assert.equal(ledger.acceptUnsettled('owner'), 0);
  assert.equal(store.getControl('paid_paused'), 'openrouter_credits');
  store.close();
});

test('pausePaid keeps the stickier reason and alerts once', () => {
  const { ledger, store } = setup();
  ledger.pausePaid('usage_unavailable');
  ledger.pausePaid('residual');
  assert.equal(store.getControl('paid_paused'), 'usage_unavailable');
  store.delControl('paid_paused');
  ledger.pausePaid('residual');
  ledger.pausePaid('residual');
  assert.equal(store.listAlerts().filter((a) => a.kind === 'paid_paused' && a.detail.reason === 'residual').length, 1);
  store.close();
});

test('provider errors: limit sources pause at once, other failures count a streak', () => {
  const { ledger, store } = setup();
  ledger.noteProviderError({ httpStatus: 402, limitSource: 'openrouter_key_limit' });
  assert.equal(store.getControl('paid_paused'), 'openrouter_key_limit');
  store.delControl('paid_paused');
  ledger.noteProviderError({ httpStatus: 403, limitSource: 'openrouter_credits' });
  assert.equal(store.getControl('paid_paused'), 'openrouter_credits');
  store.delControl('paid_paused');

  ledger.noteProviderError({ httpStatus: 403 });
  assert.equal(store.getControl('paid_paused'), null, 'one 403 only alerts');
  assert.equal(store.listAlerts().filter((a) => a.kind === 'provider_403').length, 1);
  ledger.noteProviderOk();
  ledger.noteProviderError({ httpStatus: 500 });
  ledger.noteProviderError({ httpStatus: 500 });
  assert.equal(store.getControl('paid_paused'), null, 'a success resets the streak');
  ledger.noteProviderError({ httpStatus: 500 });
  assert.equal(store.getControl('paid_paused'), 'provider_fail');
  store.close();
});

test('a 402 with no recognised limit source is a credits pause, not a step in the streak', () => {
  for (const limitSource of [null, undefined, 'something_new']) {
    const { ledger, store } = setup();
    ledger.noteProviderError({ httpStatus: 402, limitSource });
    assert.equal(store.getControl('paid_paused'), 'openrouter_credits', String(limitSource));
    assert.equal(store.peekCounter('provider_fail_streak'), 0);
    store.close();
  }
  const { ledger, store } = setup();
  ledger.noteProviderError({ httpStatus: 403, limitSource: 'something_new' });
  assert.equal(store.getControl('paid_paused'), null, 'a 403 still needs a recognised source');
  assert.equal(store.peekCounter('provider_fail_streak'), 1);
  store.close();
});

test('own runtime: a required turn holds one worst call, its input at the cache-write rate', () => {
  const { ledger, store, eff } = setup({}, { runtime: 'own' });
  eff.runtime = 'own';
  // 24000 tokens in at max(5, 6.25) per million, 3000 out at 20.
  assert.equal(ledger.holdMicros('reply_required'), 210000);
  assert.equal(ledger.holdMicros('reply_optional'), 210000);
  assert.equal(ledger.holdMicros('decision'), 10500 + 1000, 'decisions are unchanged');
  eff.models = { ...eff.models, primary: { ...PRIMARY, price: { ...PRIMARY.price, cacheWritePerM: 4 } } };
  assert.equal(ledger.holdMicros('reply_required'), 180000, 'a cache write cheaper than input is priced at input');
  eff.runtime = 'openclaw';
  assert.equal(ledger.holdMicros('reply_required'), 180000, 'the bot process keeps its own hold whatever the file says');
  store.close();
  const host = setup();
  assert.equal(host.ledger.holdMicros('reply_required'), 360000, 'positive control: the host path still holds two');
  host.eff.runtime = 'own';
  assert.equal(host.ledger.holdMicros('reply_required'), 360000, 'a file saying own does not shrink the hold of the host process');
  delete host.eff.runtime;
  assert.equal(host.ledger.holdMicros('reply_required'), 360000, 'no runtime means openclaw');
  assert.throws(() => createLedger({ store: host.store, getEffective: () => host.eff, getKey: () => null, runtime: 'other' }), /runtime must be/);
  host.store.close();
  assert.equal(replyHoldMicros('reply_required', PRIMARY, 'own'), 210000);
  assert.throws(() => replyHoldMicros('reply_required', { ...PRIMARY, price: null }, 'own'), /not locked/);
  assert.throws(() => replyHoldMicros('other', PRIMARY, 'own'), /unknown kind/);
});
