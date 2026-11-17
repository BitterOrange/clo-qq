// Search money in the ledger (docs/search-contract.md section 7): the hold, the claim that commits the per-answer count,
// the day's count and the hold together, settlement, search's own pauses, rows that expire at their hold, and the light
// reconciliation against the search Key. A temp database and a stub fetch; no network. Every refusal has its accepted
// control in the same test.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createLedger, usdToMicros } from '../../src/clo-plugin/lib/core/ledger.js';
import { createLog } from '../../src/clo-plugin/lib/core/log.js';
import { HARD_CAP_PAUSE, hardCapPauseKey } from '../../src/clo-plugin/lib/core/providers/registry.js';
import {
  SEARCH_HOLD_INPUT_TOKENS, SEARCH_PAUSE_KEY, SEARCH_ROW_PROVIDER, searchDayCounter, searchEventCounter,
} from '../../src/clo-plugin/lib/core/providers/searchRegistry.js';
import { openStore } from '../../src/clo-plugin/lib/core/store.js';
import { FAKE_ANTHROPIC_KEY, FAKE_OPENROUTER_KEY, FAKE_SEARCH_KEY } from '../harness/fake-keys.mjs';

const dir = mkdtempSync(join(tmpdir(), 'clo-ledger-search-'));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
let n = 0;
const T0 = Date.UTC(2026, 10, 3, 4, 0, 0); // 12:00 Asia/Shanghai, the same date in UTC
const MIN = 60000;
const DAY_SH = '2026-11-03';
const BUDGET = { dailyUsd: 2.5, interjectUsd: 0.75, searchUsd: 2.1, namedUsd: 2.25, addressedUsd: 2.5, residualMinUsd: 0.25, residualPct: 0.15, providerFailStreakPause: 3, searchKeyDailyLimitUsd: 0.5 };
const PRICE = { inputPerM: 3, outputPerM: 15, requestUsd: 0.005 };
// 4000 x 3 + 600 x 15 + 5000: the worst of one call, in micros.
const HOLD = SEARCH_HOLD_INPUT_TOKENS * 3 + 600 * 15 + 5000;
const SEARCH_BASE = 'http://mock-search/api/v1';
const CHAT_BASE = 'http://mock-chat/api/v1';
const searchBlock = (over = {}) => ({
  provider: 'openrouter-sonar', model: 'perplexity/sonar-pro', baseUrl: SEARCH_BASE, perAnswer: 2, perDay: 10, maxTokens: 600,
  resultMaxChars: 1500, queryMaxChars: 80, searchMs: 20000, price: { ...PRICE }, ...over,
});
const effOf = ({ chat = 'openrouter', search = searchBlock(), budget = {}, mode = 'live' } = {}) => ({
  runtime: 'own',
  mode,
  budget: { ...BUDGET, ...budget },
  openrouter: { baseUrl: CHAT_BASE },
  ...(chat === 'anthropic' ? { apiProvider: { name: 'anthropic', kind: 'anthropic', baseUrl: 'http://mock-anthropic' } } : {}),
  ...(search ? { search } : {}),
});

function setup({ runtime = 'own', ...opts } = {}) {
  const clock = { t: T0 };
  const file = join(dir, `s${++n}.db`);
  const store = openStore(file, { runGen: `g${n}`, now: () => clock.t });
  const h = {
    store, clock, file, calls: [], eff: effOf(opts),
    searchKeyBody: { usage: 0, limit: 0.5, limit_remaining: 0.5, limit_reset: 'daily', usage_daily: 0 },
    chatKeyBody: { usage: 0, limit: 3.25, limit_remaining: 3.25, limit_reset: 'daily', usage_daily: 0 },
    state: { searchFail: false, searchStatus: 200 },
    searchKey: FAKE_SEARCH_KEY,
    logFile: join(dir, `s${n}.jsonl`),
  };
  h.fetch = async (url, init) => {
    h.calls.push({ url, auth: init?.headers?.Authorization ?? null, redirect: init?.redirect ?? null });
    if (url.startsWith(SEARCH_BASE)) {
      if (h.state.searchFail) throw new Error('network down');
      if (h.state.searchStatus !== 200) return { ok: false, status: h.state.searchStatus, json: async () => ({ error: { message: 'provider text that must not be logged' } }) };
      return { ok: true, status: 200, json: async () => ({ data: { ...h.searchKeyBody } }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: { ...h.chatKeyBody } }) };
  };
  h.open = () => createLedger({
    store: h.store, getEffective: () => h.eff, fetch: h.fetch, getKey: () => (opts.chat === 'anthropic' ? FAKE_ANTHROPIC_KEY : FAKE_OPENROUTER_KEY),
    getSearchKey: () => h.searchKey, log: createLog(h.logFile), now: () => clock.t, runtime,
  });
  h.ledger = h.open();
  h.restart = () => {
    h.store.close();
    h.store = openStore(file, { runGen: `g${++n}`, now: () => clock.t });
    h.store.recoverOnStart(clock.t);
    h.ledger = h.open();
  };
  return h;
}
const row = (store, id) => store.q('SELECT * FROM reservations WHERE id=?').get(id);
const rows = (store, where = '1=1') => store.q(`SELECT * FROM reservations WHERE ${where} ORDER BY created_at`).all();
const dayCount = (store) => store.peekCounter(searchDayCounter(DAY_SH));
const searchPause = (store) => store.getControl(SEARCH_PAUSE_KEY);
const logText = (h) => {
  try {
    return readFileSync(h.logFile, 'utf8');
  } catch {
    return '';
  }
};

test('the search hold is one call at its worst: the held prompt, the output cap and the per-call fee', () => {
  const h = setup();
  assert.equal(h.ledger.holdMicros('search'), HOLD);
  assert.equal(HOLD, 26000);
  h.eff.search = searchBlock({ maxTokens: 1000 });
  assert.equal(h.ledger.holdMicros('search'), 12000 + 15000 + 5000, 'the output cap is the configured one');
  h.eff.search = searchBlock({ price: null });
  assert.throws(() => h.ledger.holdMicros('search'), /not locked/);
  delete h.eff.search;
  assert.throws(() => h.ledger.holdMicros('search'), /search is off/);
  h.store.close();
});

test('a claim commits the hold and both counts; the row is a search row that no chat Key figure can explain', () => {
  const h = setup();
  const c = h.ledger.claimSearch({ eventKey: 'E1' });
  assert.equal(c.ok, true);
  assert.equal(c.heldMicros, HOLD);
  const r = row(h.store, c.id);
  assert.equal(r.tier, 'search');
  assert.equal(r.category, 'search');
  assert.equal(r.provider, SEARCH_ROW_PROVIDER);
  assert.equal(r.model, 'perplexity/sonar-pro');
  assert.equal(r.status, 'held');
  assert.equal(r.held_micros, HOLD);
  assert.equal(r.utc_day, DAY_SH);
  assert.equal(dayCount(h.store), 1);
  assert.equal(h.store.peekCounter(searchEventCounter('E1')), 1);
  assert.equal(h.ledger.spent().byTier.search, HOLD);
  h.store.close();
});

test('at most perAnswer calls per answer and perDay a day; a refused claim leaves both counts as they were', () => {
  const h = setup({ search: searchBlock({ perDay: 3 }) });
  assert.equal(h.ledger.claimSearch({ eventKey: 'E1' }).ok, true);
  assert.equal(h.ledger.claimSearch({ eventKey: 'E1' }).ok, true, 'control: the second call of one answer');
  assert.deepEqual(h.ledger.claimSearch({ eventKey: 'E1' }), { ok: false, reason: 'answer_cap' });
  assert.equal(dayCount(h.store), 2, 'the refused third call took no day count');
  assert.equal(h.ledger.claimSearch({ eventKey: 'E2' }).ok, true, 'control: another answer, the third of the day');
  assert.deepEqual(h.ledger.claimSearch({ eventKey: 'E3' }), { ok: false, reason: 'day_cap' });
  assert.equal(h.store.peekCounter(searchEventCounter('E3')), 0, 'the refused claim took no per-answer count');
  assert.equal(rows(h.store, "tier='search'").length, 3);
  // The next Shanghai day starts a new count.
  h.clock.t = T0 + 13 * 3600000;
  assert.equal(h.ledger.claimSearch({ eventKey: 'E4' }).ok, true);
  h.store.close();
});

test('a hold the budget refuses rolls the counts back; with room the same claim takes them', () => {
  // Enough for one hold but not two: the search line is the whole day's spend.
  const h = setup({ budget: { searchUsd: (HOLD * 1.5) / 1e6 } });
  assert.equal(h.ledger.claimSearch({ eventKey: 'E1' }).ok, true);
  assert.equal(dayCount(h.store), 1);
  assert.deepEqual(h.ledger.claimSearch({ eventKey: 'E2' }), { ok: false, reason: 'total' });
  assert.equal(dayCount(h.store), 1, 'rolled back');
  assert.equal(h.store.peekCounter(searchEventCounter('E2')), 0, 'rolled back');
  h.eff.budget.searchUsd = 2.1;
  assert.equal(h.ledger.claimSearch({ eventKey: 'E2' }).ok, true, 'control: room again');
  assert.equal(dayCount(h.store), 2);
  h.store.close();
});

test('tier order: spend at searchUsd stops search while names and @ still reserve; at namedUsd names stop and @ goes on', () => {
  const h = setup();
  const fill = (usd) => h.ledger.reserve({ tier: 'addressed', category: 'reply', heldMicros: usdToMicros(usd), eventKey: 'F' });
  assert.equal(fill(2.1 - HOLD / 1e6).ok, true);
  assert.equal(h.ledger.claimSearch({ eventKey: 'E1' }).ok, true, 'control: the last hold that fits under $2.10');
  assert.deepEqual(h.ledger.claimSearch({ eventKey: 'E2' }), { ok: false, reason: 'total' });
  assert.equal(h.ledger.reserve({ tier: 'named', category: 'reply', heldMicros: 10000, eventKey: 'N' }).ok, true, 'names still reserve');
  assert.equal(h.ledger.reserve({ tier: 'addressed', category: 'reply', heldMicros: 10000, eventKey: 'A' }).ok, true, '@ still reserves');
  assert.equal(fill(2.25 - h.ledger.spent().effectiveMicros / 1e6).ok, true);
  assert.deepEqual(h.ledger.reserve({ tier: 'named', category: 'reply', heldMicros: 10000, eventKey: 'N2' }), { ok: false, reason: 'total' });
  assert.equal(h.ledger.reserve({ tier: 'addressed', category: 'reply', heldMicros: 10000, eventKey: 'A2' }).ok, true, '@ goes on to $2.50');
  h.store.close();
});

test('the chat Key\'s figure stands for chat rows only: the day\'s search rows are added on top, never hidden by it', () => {
  const h = setup();
  const snap = (at, usd) => h.store.q('INSERT INTO key_snapshots(taken_at, usage_micros, usage_daily_micros, limit_micros, remaining_micros, limit_reset) VALUES (?, ?, ?, ?, ?, ?)')
    .run(at, usdToMicros(usd), usdToMicros(usd), usdToMicros(3.25), usdToMicros(3.25 - usd), 'daily');
  // Chat rows $1.00 and search rows $0.50 locally.
  assert.equal(h.ledger.reserve({ tier: 'addressed', category: 'reply', heldMicros: usdToMicros(1), eventKey: 'C' }).ok, true);
  const s1 = h.ledger.claimSearch({ eventKey: 'S' });
  assert.equal(s1.ok, true);
  h.ledger.settleSearch(s1.id, { actualMicros: HOLD, source: 'usage.cost', model: 'perplexity/sonar-pro' });
  // The day's search spend as $0.50, for round figures (one settled row stands for many calls).
  h.store.q('UPDATE reservations SET actual_micros=? WHERE id=?').run(usdToMicros(0.5), s1.id);
  // Control: no Key figure yet, the local total.
  assert.equal(h.ledger.spent().effectiveMicros, usdToMicros(1.5));
  // The chat Key read $1.60 today: chat is the larger of $1.00 and $1.60, and search's $0.50 comes on top.
  snap(T0 - 2 * 3600000, 0);
  snap(T0 - MIN, 1.6);
  const s = h.ledger.spent();
  assert.equal(s.providerMicros, usdToMicros(1.6));
  assert.equal(s.localMicros, usdToMicros(1.5), 'local is every row, as before');
  assert.equal(s.effectiveMicros, usdToMicros(2.1), 'not max($1.50, $1.60)');
  // So the search tier at $2.10 is full, and a further search is refused.
  assert.deepEqual(h.ledger.claimSearch({ eventKey: 'S2' }), { ok: false, reason: 'total' });
  // Control: a chat figure below the chat rows leaves the local total.
  snap(T0, 0.4);
  assert.equal(h.ledger.spent().effectiveMicros, usdToMicros(1.5));
  h.store.close();
});

test('search is off without the block, on the OpenClaw runtime, and under the global and hard-cap pauses', () => {
  const on = setup();
  assert.equal(on.ledger.claimSearch({ eventKey: 'E' }).ok, true, 'control');
  on.store.setControl('paid_paused', 'provider_fail', 'test');
  assert.deepEqual(on.ledger.claimSearch({ eventKey: 'E2' }), { ok: false, reason: 'paid_paused' });
  on.store.delControl('paid_paused');
  on.store.setControl(hardCapPauseKey('openrouter'), 'hard_cap', 'test');
  assert.deepEqual(on.ledger.claimSearch({ eventKey: 'E3' }), { ok: false, reason: HARD_CAP_PAUSE });
  assert.equal(dayCount(on.store), 1, 'neither refusal took a count');
  on.store.close();

  const off = setup({ search: null });
  assert.deepEqual(off.ledger.claimSearch({ eventKey: 'E' }), { ok: false, reason: 'search_off' });
  assert.deepEqual(off.ledger.reserve({ tier: 'search', category: 'search', heldMicros: HOLD, eventKey: 'E', provider: 'search' }), { ok: false, reason: 'search_off' });
  off.store.close();

  const host = setup({ runtime: 'openclaw' });
  assert.deepEqual(host.ledger.claimSearch({ eventKey: 'E' }), { ok: false, reason: 'search_off' });
  assert.deepEqual(host.ledger.reserve({ tier: 'search', category: 'search', heldMicros: HOLD, eventKey: 'E', provider: 'search' }), { ok: false, reason: 'search_off' });
  host.store.close();

  const unpriced = setup({ search: searchBlock({ price: null }) });
  assert.deepEqual(unpriced.ledger.claimSearch({ eventKey: 'E' }), { ok: false, reason: 'price' });
  unpriced.store.close();
});

test('reserve takes the search provider only with the search tier, and the search tier always carries it', () => {
  const h = setup();
  assert.throws(() => h.ledger.reserve({ tier: 'named', category: 'reply', heldMicros: 1000, provider: 'search' }), /search tier/);
  assert.throws(() => h.ledger.reserve({ tier: 'search', category: 'search', heldMicros: 1000, provider: 'openrouter' }), /only be search/);
  const r = h.ledger.reserve({ tier: 'search', category: 'search', heldMicros: 1000, eventKey: 'E' });
  assert.equal(row(h.store, r.id).provider, 'search');
  const chat = h.ledger.reserve({ tier: 'named', category: 'reply', heldMicros: 1000, eventKey: 'E' });
  assert.equal(row(h.store, chat.id).provider, null, 'control: a chat row carries the chat kind (the implicit entry)');
  h.store.close();
});

test('settlement: within the hold settles; above it settles at the figure and pauses search; none leaves it unsettled', () => {
  const h = setup();
  const a = h.ledger.claimSearch({ eventKey: 'E1' });
  assert.deepEqual(h.ledger.settleSearch(a.id, { actualMicros: 5600, source: 'model.usage' }), { status: 'settled' });
  assert.equal(row(h.store, a.id).actual_micros, 5600);
  assert.equal(searchPause(h.store), null, 'control: no pause within the hold');
  const b = h.ledger.claimSearch({ eventKey: 'E2' });
  h.ledger.settleSearch(b.id, {});
  assert.equal(row(h.store, b.id).status, 'unsettled', 'no figure is never free');
  const c = h.ledger.claimSearch({ eventKey: 'E3' });
  h.ledger.settleSearch(c.id, { actualMicros: HOLD + 1, source: 'model.usage' });
  assert.equal(row(h.store, c.id).actual_micros, HOLD + 1, 'the figure, not the hold');
  assert.equal(searchPause(h.store), 'cost_above_hold');
  assert.ok(h.store.listAlerts().some((x) => x.kind === 'search_cost_above_hold'));
  assert.equal(h.store.getControl('paid_paused'), null, 'chat goes on');
  const chat = h.ledger.reserve({ tier: 'addressed', category: 'reply', heldMicros: 1000, eventKey: 'C' });
  assert.deepEqual(h.ledger.settleSearch(chat.id, { actualMicros: 5 }), { status: 'unchanged' }, 'a chat row is not a search row');
  assert.equal(row(h.store, chat.id).status, 'held');
  h.store.close();
});

test('search failures stop search only: a streak pauses it, a 402 or a Key limit names the Key, and chat counts nothing', () => {
  const h = setup();
  h.ledger.noteSearchError({ httpStatus: 500 });
  h.ledger.noteSearchError({ httpStatus: null });
  assert.equal(searchPause(h.store), null, 'control: two are not a streak');
  h.ledger.noteSearchOk();
  h.ledger.noteSearchError({});
  h.ledger.noteSearchError({});
  assert.equal(searchPause(h.store), null, 'a success ended the streak');
  h.ledger.noteSearchError({});
  assert.equal(searchPause(h.store), 'fail');
  assert.equal(h.store.getControl('paid_paused'), null);
  assert.equal(h.store.peekCounter('provider_fail_streak'), 0, 'not the primary streak');
  assert.equal(h.store.getControl('decision_paused'), null, 'not the decision breaker');
  assert.deepEqual(h.ledger.claimSearch({ eventKey: 'E' }), { ok: false, reason: 'search_paused' });

  const k = setup();
  k.ledger.noteSearchError({ httpStatus: 402 });
  assert.equal(searchPause(k.store), 'key_limit');
  const k2 = setup();
  k2.ledger.noteSearchError({ httpStatus: 403, limitSource: 'openrouter_key_limit' });
  assert.equal(searchPause(k2.store), 'key_limit');
  const k3 = setup();
  k3.ledger.noteSearchError({ httpStatus: 403 });
  assert.equal(searchPause(k3.store), null, 'control: a 403 with no limit source is one failure');
  for (const x of [h, k, k2, k3]) x.store.close();
});

test('after a failure pause: one trial per wait, a success lifts it, a failed trial starts the wait again', () => {
  const h = setup();
  for (let i = 0; i < 3; i += 1) h.ledger.noteSearchError({});
  assert.equal(searchPause(h.store), 'fail');
  h.clock.t += 9 * MIN;
  assert.deepEqual(h.ledger.claimSearch({ eventKey: 'E1' }), { ok: false, reason: 'search_paused' });
  h.clock.t += 2 * MIN;
  const trial = h.ledger.claimSearch({ eventKey: 'E2' });
  assert.equal(trial.ok, true, 'control: the trial after ten minutes');
  assert.equal(searchPause(h.store), 'fail', 'the pause stands while the trial runs');
  assert.deepEqual(h.ledger.claimSearch({ eventKey: 'E3' }), { ok: false, reason: 'search_paused' }, 'one trial per wait');
  h.ledger.noteSearchError({});
  h.clock.t += 9 * MIN;
  assert.deepEqual(h.ledger.claimSearch({ eventKey: 'E4' }), { ok: false, reason: 'search_paused' }, 'a failed trial waits again');
  h.clock.t += 2 * MIN;
  assert.equal(h.ledger.claimSearch({ eventKey: 'E5' }).ok, true);
  h.ledger.noteSearchOk();
  assert.equal(searchPause(h.store), null);
  assert.equal(h.ledger.claimSearch({ eventKey: 'E6' }).ok, true);
  h.store.close();
});

test('search pause ranks: the owner\'s reason stays; the owner lifts only cost_above_hold and fail', () => {
  const h = setup();
  h.ledger.pauseSearch('cost_above_hold');
  h.ledger.pauseSearch('fail');
  h.ledger.pauseSearch('key_limit');
  assert.equal(searchPause(h.store), 'cost_above_hold');
  assert.deepEqual(h.ledger.clearSearchPause('test'), { cleared: true, reason: 'cost_above_hold' });
  assert.equal(searchPause(h.store), null);
  h.ledger.pauseSearch('fail');
  h.ledger.pauseSearch('key_limit');
  assert.equal(searchPause(h.store), 'key_limit', 'a limit replaces a failure streak');
  assert.deepEqual(h.ledger.clearSearchPause('test'), { cleared: false, reason: 'key_limit' }, 'only a read lifts it');
  assert.deepEqual(h.ledger.clearSearchPause('test'), { cleared: false, reason: 'key_limit' });
  assert.throws(() => h.ledger.pauseSearch('nonsense'), /unknown reason/);
  h.store.close();
});

test('unsettled search rows settle at their hold after the wait, and a crash pause they alone held lifts', () => {
  const h = setup();
  const c = h.ledger.claimSearch({ eventKey: 'E1' });
  h.restart();
  assert.equal(row(h.store, c.id).status, 'unsettled', 'a crash leaves it unknown');
  h.store.setControl('paid_paused', 'crash_unsettled', 'recovery');
  h.clock.t += 14 * MIN;
  assert.equal(h.ledger.settleExpiredSearch(), 0, 'control: not before the wait');
  h.clock.t += 2 * MIN;
  assert.equal(h.ledger.settleExpiredSearch(), 1);
  const r = row(h.store, c.id);
  assert.equal(r.status, 'settled');
  assert.equal(r.actual_micros, HOLD, 'at the hold: over-counts, never under-counts');
  assert.equal(r.source, 'search_hold');
  assert.equal(h.store.getControl('paid_paused'), null, 'nothing unsettled is left');
  h.store.close();

  // A chat row still unknown keeps the pause, and is not touched.
  const k = setup();
  const s = k.ledger.claimSearch({ eventKey: 'E1' });
  const chat = k.ledger.reserve({ tier: 'addressed', category: 'reply', heldMicros: 1000, eventKey: 'E1' });
  k.ledger.markUnsettled(s.id);
  k.ledger.markUnsettled(chat.id);
  k.store.setControl('paid_paused', 'crash_unsettled', 'recovery');
  k.clock.t += 16 * MIN;
  assert.equal(k.ledger.settleExpiredSearch(), 1);
  assert.equal(row(k.store, chat.id).status, 'unsettled');
  assert.equal(k.store.getControl('paid_paused'), 'crash_unsettled');
  k.store.close();
});

test('the search Key is read with the search Key, at the search base, never with the chat Key or into key_snapshots', async () => {
  const h = setup();
  const r = await h.ledger.reconcileSearch(h.clock.t, { atStart: true });
  assert.equal(r.ok, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, `${SEARCH_BASE}/key`);
  assert.equal(h.calls[0].auth, `Bearer ${FAKE_SEARCH_KEY}`);
  assert.equal(h.calls[0].redirect, 'error');
  assert.equal(h.store.q('SELECT COUNT(*) AS n FROM key_snapshots').get().n, 0, 'the chat side\'s snapshots are untouched');
  await h.ledger.reconcile(h.clock.t, { atStart: true });
  assert.equal(h.calls[1].url, `${CHAT_BASE}/key`, 'control: the chat read goes to the chat base');
  assert.equal(h.calls[1].auth, `Bearer ${FAKE_OPENROUTER_KEY}`);
  h.store.close();

  for (const [what, mutate] of [['search off', (x) => { delete x.eff.search; }], ['no search Key', (x) => { x.searchKey = null; }]]) {
    const x = setup();
    mutate(x);
    assert.deepEqual(await x.ledger.reconcileSearch(x.clock.t, { atStart: true }), { ok: false, unsupported: true }, what);
    assert.equal(x.calls.length, 0, what);
    x.store.close();
  }
});

test('a failed read pauses search at start at once, later on the second in a row; no daily figure is a failed read', async () => {
  const h = setup();
  h.state.searchStatus = 500;
  await h.ledger.reconcileSearch(h.clock.t, { atStart: true });
  assert.equal(searchPause(h.store), 'key_read_failed');
  h.state.searchStatus = 200;
  await h.ledger.reconcileSearch(h.clock.t);
  assert.equal(searchPause(h.store), null, 'a clean read lifts it');
  h.state.searchFail = true;
  await h.ledger.reconcileSearch(h.clock.t);
  assert.equal(searchPause(h.store), null, 'one failure later is not enough');
  await h.ledger.reconcileSearch(h.clock.t);
  assert.equal(searchPause(h.store), 'key_read_failed');
  h.state.searchFail = false;
  delete h.searchKeyBody.usage_daily;
  await h.ledger.reconcileSearch(h.clock.t);
  assert.equal(searchPause(h.store), 'key_read_failed', 'no usage_daily: nothing to compare, still failed');
  h.searchKeyBody.usage_daily = 0;
  await h.ledger.reconcileSearch(h.clock.t);
  assert.equal(searchPause(h.store), null);
  assert.equal(h.store.getControl('paid_paused'), null, 'chat was never paused');
  assert.doesNotMatch(logText(h), /provider text|FAKE-SEARCH/);
  h.store.close();
});

test('the light reconciliation: a gap above the threshold twice pauses search; local rows of the UTC day explain the figure', async () => {
  const h = setup();
  const c = h.ledger.claimSearch({ eventKey: 'E1' });
  h.ledger.settleSearch(c.id, { actualMicros: 20000, source: 'model.usage' });
  // Explained: the Key says what the row says.
  h.searchKeyBody.usage_daily = 0.02;
  let r = await h.ledger.reconcileSearch(h.clock.t, { atStart: true });
  assert.equal(r.gapMicros, 0);
  assert.equal(searchPause(h.store), null);
  // Unexplained beyond the floor ($0.25): once is a note, twice a pause.
  h.searchKeyBody.usage_daily = 0.3;
  r = await h.ledger.reconcileSearch(h.clock.t);
  assert.equal(r.gapMicros, 280000);
  assert.equal(searchPause(h.store), null, 'once is not enough');
  await h.ledger.reconcileSearch(h.clock.t);
  assert.equal(searchPause(h.store), 'residual');
  assert.equal(h.store.getControl('paid_paused'), null, 'chat goes on');
  assert.equal(rows(h.store, "category='unattributed'").length, 0, 'nothing is attributed to rows');
  // A held row counts at its hold, so a figure that a call in flight explains is no gap.
  h.searchKeyBody.usage_daily = 0.02 + HOLD / 1e6;
  h.ledger.noteSearchOk();
  h.store.delControl(SEARCH_PAUSE_KEY);
  h.store.setControl(SEARCH_PAUSE_KEY, 'residual', 'ledger');
  h.clock.t += 1;
  const direct = h.ledger.reserve({ tier: 'search', category: 'search', heldMicros: HOLD, eventKey: 'E9', provider: 'search' });
  assert.deepEqual(direct, { ok: false, reason: 'search_paused' }, 'a paused search reserves nothing directly either');
  h.store.q("INSERT INTO reservations(id, local_day, utc_day, tier, category, held_micros, status, event_key, model, run_gen, created_at, provider) VALUES ('held1', ?, ?, 'search', 'search', ?, 'held', 'E9', 'm', 'g', ?, 'search')").run(DAY_SH, DAY_SH, HOLD, h.clock.t);
  r = await h.ledger.reconcileSearch(h.clock.t);
  assert.equal(r.gapMicros, 0);
  assert.equal(searchPause(h.store), null, 'a clean read lifts the residual pause');
  // Yesterday's rows (UTC) explain nothing today.
  const y = setup();
  y.clock.t = T0 - 24 * 3600000;
  const old = y.ledger.claimSearch({ eventKey: 'Y' });
  y.ledger.settleSearch(old.id, { actualMicros: 20000, source: 'model.usage' });
  y.clock.t = T0;
  y.searchKeyBody.usage_daily = 0.02;
  r = await y.ledger.reconcileSearch(y.clock.t, { atStart: true });
  assert.equal(r.gapMicros, 20000, 'a row of another UTC day does not count');
  h.store.close();
  y.store.close();
});

test('a search Key with no room pauses search until a read shows room; a limit unlike the config alerts once', async () => {
  const h = setup();
  h.searchKeyBody.limit_remaining = 0;
  await h.ledger.reconcileSearch(h.clock.t, { atStart: true });
  assert.equal(searchPause(h.store), 'key_limit');
  await h.ledger.reconcileSearch(h.clock.t);
  assert.equal(searchPause(h.store), 'key_limit', 'still none');
  h.searchKeyBody.limit_remaining = 0.2;
  await h.ledger.reconcileSearch(h.clock.t);
  assert.equal(searchPause(h.store), null, 'room again');
  assert.equal(h.store.listAlerts().filter((a) => a.kind === 'search_key_limit_mismatch').length, 0, 'control: the limit matches the config');
  h.searchKeyBody.limit = 0.6;
  await h.ledger.reconcileSearch(h.clock.t);
  await h.ledger.reconcileSearch(h.clock.t);
  assert.equal(h.store.listAlerts().filter((a) => a.kind === 'search_key_limit_mismatch').length, 1);
  h.searchKeyBody.limit = 0.5;
  h.searchKeyBody.limit_reset = 'monthly';
  await h.ledger.reconcileSearch(h.clock.t);
  assert.equal(h.store.listAlerts().filter((a) => a.kind === 'search_key_limit_mismatch').length, 2, 'a reset that is not daily');
  h.store.close();
});

test('the tick: dry-run reads nothing; live reads at the first tick, after new search rows, and every ten minutes', async () => {
  const dry = setup({ mode: 'dry-run' });
  await dry.ledger.searchTick();
  assert.equal(dry.calls.length, 0);
  dry.store.close();

  const h = setup();
  await h.ledger.searchTick();
  assert.equal(h.calls.length, 1, 'the first live tick reads');
  h.clock.t += MIN;
  await h.ledger.searchTick();
  assert.equal(h.calls.length, 1, 'nothing new, not due');
  const c = h.ledger.claimSearch({ eventKey: 'E1' });
  h.clock.t += MIN;
  await h.ledger.searchTick();
  assert.equal(h.calls.length, 2, 'a new search row');
  h.ledger.settleSearch(c.id, { actualMicros: 1000, source: 'model.usage' });
  h.clock.t += MIN;
  await h.ledger.searchTick();
  assert.equal(h.calls.length, 3, 'its settlement');
  h.clock.t += MIN;
  await h.ledger.searchTick();
  assert.equal(h.calls.length, 3);
  h.clock.t += 10 * MIN;
  await h.ledger.searchTick();
  assert.equal(h.calls.length, 4, 'due');
  assert.ok(h.calls.every((x) => x.url === `${SEARCH_BASE}/key`), 'the search tick reads only the search Key');
  h.store.close();
});

test('with an Anthropic chat provider the search rows and the search Key read are the same, and the chat Key is never read', async () => {
  const h = setup({ chat: 'anthropic' });
  const c = h.ledger.claimSearch({ eventKey: 'E1' });
  assert.equal(c.ok, true);
  assert.equal(row(h.store, c.id).provider, 'search');
  const chat = h.ledger.reserve({ tier: 'addressed', category: 'reply', heldMicros: 1000, eventKey: 'E1' });
  assert.equal(row(h.store, chat.id).provider, 'anthropic', 'control: the chat row is the chat kind');
  await h.ledger.searchTick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, `${SEARCH_BASE}/key`);
  assert.equal(h.calls[0].auth, `Bearer ${FAKE_SEARCH_KEY}`);
  assert.deepEqual(await h.ledger.reconcile(h.clock.t), { ok: false, unsupported: true }, 'the Anthropic chat Key is never read');
  assert.equal(h.calls.length, 1);
  h.store.close();
});

test('the snapshot status shows: on, the pause, today\'s count and spend', () => {
  const h = setup();
  const c = h.ledger.claimSearch({ eventKey: 'E1' });
  h.ledger.settleSearch(c.id, { actualMicros: 3000, source: 'model.usage' });
  h.ledger.pauseSearch('key_limit');
  assert.deepEqual(h.ledger.searchSnapshot(), {
    on: true, paused: 'key_limit', countToday: 1, perDay: 10, spentMicros: 3000, searchUsd: 2.1, keyDailyLimitUsd: 0.5, priceLocked: true,
  });
  const snap = h.store.statusSnapshot();
  assert.equal(snap.searchPaused, 'key_limit');
  assert.equal(snap.searchCountToday, 1);
  assert.equal(snap.spendToday.search, 3000);
  assert.equal(h.store.pauseState(null).search, 'key_limit');
  assert.equal(h.store.pauseState(null).paid, null, 'a search pause is not a paid pause');
  h.store.close();
});
