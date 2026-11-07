// Local cost arithmetic: the byte copy of gate.usageMicros, token pricing with its flags, settlement by kind and runtime
// (own-runtime OpenRouter at the reported cost, tokens only without one) and the static bound a probe uses. The
// arithmetic is pure. One case runs the real ledger on a temp database with a mock Key read, to show why an
// OpenRouter settlement must not exceed the reported cost. No network.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  COST_ABOVE_COMPUTED_ALERT, computeMicros, FAST_MULTIPLIER, GEO_US_MULTIPLIER, REPORTED_ABOVE_COMPUTED_MARGIN, settleMicros, usageMicros, worstCaseMicros,
} from '../../src/clo-plugin/lib/core/providers/cost.js';
import { usageMicros as gateUsageMicros } from '../../src/clo-plugin/lib/core/gate.js';
import { createLedger } from '../../src/clo-plugin/lib/core/ledger.js';
import { createLog } from '../../src/clo-plugin/lib/core/log.js';
import { openStore } from '../../src/clo-plugin/lib/core/store.js';
import { FAKE_OPENROUTER_KEY } from '../harness/fake-keys.mjs';

// The price book's figures for the two models, per million tokens.
const OPUS = { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2, cacheWritePerM: 5, cacheWrite1hPerM: 8 };
const HAIKU = {
  inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01, cacheWritePerM: 0.125, cacheWrite1hPerM: 0.2,
  long: { aboveTokens: 100000, inputPerM: 0.5, outputPerM: 2.5, cacheReadPerM: 0.05, cacheWritePerM: 0.625, cacheWrite1hPerM: 1 },
};
// The OpenRouter lock's shape: no 1h rate, no long card.
const OR_PRICE = { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2, cacheWritePerM: 5 };
const std = (over = {}) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, geo: 'global', speed: 'standard', ...over });

test('usageMicros is the gate function, byte for byte and on every input', () => {
  assert.equal(usageMicros.toString(), gateUsageMicros.toString());
  const prices = [OR_PRICE, OPUS, { inputPerM: 4, outputPerM: 20 }, null, undefined];
  const usages = [
    null, undefined, {}, { costUsd: 0.0123 }, { costUsd: 0, input: 100 }, { costUsd: -1, output: 5 }, { costUsd: 'x', input: 3 },
    { costUsd: 0.0000001 }, { input: 50, output: 40, cacheRead: 1000, cacheWrite: 150, costUsd: null },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, { input: 1, output: 1 }, { cacheRead: 7 }, { cacheWrite: 9 },
    { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 4000, cacheWrite1h: 3000, geo: 'us', speed: 'fast' },
  ];
  let computed = 0;
  let reported = 0;
  for (const p of prices) {
    for (const u of usages) {
      const got = usageMicros(u, p);
      assert.deepEqual(got, gateUsageMicros(u, p), JSON.stringify([u, p]));
      if (got?.source === 'computed') computed += 1;
      if (got?.source === 'model.usage') reported += 1;
    }
  }
  // Both branches ran, so the equality covered both.
  assert.ok(computed > 0 && reported > 0);
  // Reported first: it ignores geo, speed and 1h writes.
  assert.deepEqual(usageMicros({ costUsd: 0.0123, input: 9e9, geo: 'us' }, OPUS), { micros: 12300, source: 'model.usage' });
});

test('computeMicros: Opus at the standard rates', () => {
  assert.deepEqual(computeMicros(std({ input: 1000, output: 500, cacheRead: 2000, cacheWrite: 4000 }), OPUS),
    { micros: 1000 * 4 + 500 * 20 + 2000 * 0.2 + 4000 * 5, source: 'computed', flags: [] });
  // output already holds the thinking tokens; nothing is added for them.
  assert.equal(computeMicros(std({ output: 1000 }), OPUS).micros, 20000);
  // Fractions round up to the next micro.
  assert.equal(computeMicros(std({ cacheRead: 3 }), OPUS).micros, 1);
});

test('computeMicros: five-minute and one-hour writes, and writes with no split', () => {
  const five = computeMicros(std({ cacheWrite: 4000 }), OPUS);
  assert.deepEqual(five, { micros: 20000, source: 'computed', flags: [] });
  const hour = computeMicros(std({ cacheWrite1h: 4000 }), OPUS);
  assert.deepEqual(hour, { micros: 32000, source: 'computed', flags: ['cache_1h'] });
  const both = computeMicros(std({ cacheWrite: 1000, cacheWrite1h: 1000 }), OPUS);
  assert.deepEqual(both, { micros: 5000 + 8000, source: 'computed', flags: ['cache_1h'] });
  // Reported without the split: all of it at the dearer rate, and flagged.
  const unsplit = computeMicros(std({ cacheWrite: 4000, cacheWrite1h: null }), OPUS);
  assert.deepEqual(unsplit, { micros: 32000, source: 'computed', flags: ['cache_unsplit'] });
  // No split concept at all (the OpenRouter usage shape): five minutes, no flag.
  const { cacheWrite1h, ...noSplit } = std({ cacheWrite: 4000 });
  assert.equal(cacheWrite1h, 0);
  assert.deepEqual(computeMicros(noSplit, OPUS), { micros: 20000, source: 'computed', flags: [] });
  // A null split with no writes has nothing to flag.
  assert.deepEqual(computeMicros(std({ input: 10, cacheWrite1h: null }), OPUS).flags, []);
});

test('computeMicros: the Haiku long-prompt card starts above 100000 prompt tokens', () => {
  assert.deepEqual(computeMicros(std({ input: 100000, output: 100 }), HAIKU), { micros: 10000 + 50, source: 'computed', flags: [] });
  assert.deepEqual(computeMicros(std({ input: 100001, output: 100 }), HAIKU), { micros: Math.ceil(100001 * 0.5 + 100 * 2.5), source: 'computed', flags: [] });
  // The prompt counts cached tokens too.
  const mixed = computeMicros(std({ input: 50000, cacheRead: 50001 }), HAIKU);
  assert.equal(mixed.micros, Math.ceil(50000 * 0.5 + 50001 * 0.05));
  const under = computeMicros(std({ input: 50000, cacheRead: 50000 }), HAIKU);
  assert.equal(under.micros, Math.ceil(50000 * 0.1 + 50000 * 0.01));
  // Opus has no long card: the same count stays on its one card.
  assert.equal(computeMicros(std({ input: 200000 }), OPUS).micros, 800000);
});

test('computeMicros: US-only inference is x1.1, fast mode x2, and both are flagged', () => {
  assert.equal(GEO_US_MULTIPLIER, 1.1);
  assert.equal(FAST_MULTIPLIER, 2);
  const base = computeMicros(std({ input: 1000 }), OPUS);
  assert.deepEqual(base, { micros: 4000, source: 'computed', flags: [] });
  assert.deepEqual(computeMicros(std({ input: 1000, geo: 'us' }), OPUS), { micros: 4400, source: 'computed', flags: ['geo_us'] });
  assert.deepEqual(computeMicros(std({ input: 1000, speed: 'fast' }), OPUS), { micros: 8000, source: 'computed', flags: ['speed_fast'] });
  assert.deepEqual(computeMicros(std({ input: 1000, geo: 'us', speed: 'fast' }), OPUS), { micros: 8800, source: 'computed', flags: ['geo_us', 'speed_fast'] });
  // Reported but unreadable is priced at the dearer known rate, and flagged as unknown.
  assert.deepEqual(computeMicros(std({ input: 1000, geo: null }), OPUS).flags, ['geo_unknown']);
  assert.equal(computeMicros(std({ input: 1000, geo: 'eu' }), OPUS).micros, 4400);
  assert.deepEqual(computeMicros(std({ input: 1000, speed: null }), OPUS), { micros: 8000, source: 'computed', flags: ['speed_unknown'] });
  // Not reported at all (absent): the standard rate, as for a provider that has no such field.
  const { geo, speed, ...bare } = std({ input: 1000 });
  assert.ok(geo && speed);
  assert.deepEqual(computeMicros(bare, OPUS), base);
});

test('computeMicros: zero or missing usage and an unusable price give null, never zero', () => {
  for (const u of [null, undefined, 'x', {}, std(), std({ geo: 'us' }), std({ input: -5, output: Number.NaN, cacheRead: Infinity })]) {
    assert.equal(computeMicros(u, OPUS), null, JSON.stringify(u));
  }
  for (const p of [null, undefined, {}, { inputPerM: 4 }, { outputPerM: 20 }, { inputPerM: 'x', outputPerM: 20 }, { inputPerM: -1, outputPerM: 20 }]) {
    assert.equal(computeMicros(std({ input: 10 }), p), null, JSON.stringify(p));
  }
  // A long card that cannot be read prices nothing, above or below its threshold.
  assert.equal(computeMicros(std({ input: 200000 }), { ...HAIKU, long: { aboveTokens: 100000, inputPerM: 0.5 } }), null);
  assert.equal(computeMicros(std({ input: 10 }), { ...HAIKU, long: { inputPerM: 0.5, outputPerM: 2.5 } }), null);
  // Positive control: the same usage with a usable price is priced.
  assert.equal(computeMicros(std({ input: 10 }), OPUS).micros, 40);
  assert.equal(computeMicros(std({ input: 200000 }), HAIKU).micros, 100000);
});

test('computeMicros: rates missing from the book fall back to the documented multiples of the input rate', () => {
  const thin = { inputPerM: 4, outputPerM: 20 };
  assert.equal(computeMicros(std({ cacheRead: 1000 }), thin).micros, 4000);
  assert.equal(computeMicros(std({ cacheWrite: 1000 }), thin).micros, 5000);
  assert.equal(computeMicros(std({ cacheWrite1h: 1000 }), thin).micros, 8000);
});

test('settleMicros, no runtime named: OpenRouter is today\'s reported-first order; Anthropic prices tokens', () => {
  const reported = { input: 50, output: 40, cacheRead: 1000, cacheWrite: 150, costUsd: 0.0123, model: 'anthropic/claude-opus-5.5' };
  assert.deepEqual(settleMicros(reported, OR_PRICE, { kind: 'openrouter' }), { micros: 12300, source: 'model.usage', flags: [] });
  const tokensOnly = { ...reported, costUsd: null };
  assert.deepEqual(settleMicros(tokensOnly, OR_PRICE, { kind: 'openrouter' }), { ...gateUsageMicros(tokensOnly, OR_PRICE), flags: [] });
  assert.equal(settleMicros({ ...reported, costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, OR_PRICE, { kind: 'openrouter' }), null);
  // Anthropic reports no cost; a costUsd that turned up anyway is not trusted over the tokens.
  const an = std({ input: 1000, output: 100, geo: 'us' });
  assert.deepEqual(settleMicros({ ...an, costUsd: 0.000001 }, OPUS, { kind: 'anthropic' }), computeMicros(an, OPUS));
  assert.deepEqual(settleMicros(an, OPUS, { kind: 'anthropic' }), { micros: 6600, source: 'computed', flags: ['geo_us'] });
  assert.equal(settleMicros(std(), OPUS, { kind: 'anthropic' }), null);
  // An unknown kind settles nothing.
  assert.equal(settleMicros(reported, OR_PRICE, { kind: 'openai' }), null);
  assert.equal(settleMicros(reported, OR_PRICE), null);
});

test('worstCaseMicros: every input token at the dearer input-side rate, times 1.1 unless told otherwise', () => {
  assert.equal(worstCaseMicros({ input: 5000, output: 1200 }, OPUS, { geoUs: false }), 5000 * 5 + 1200 * 20);
  assert.equal(worstCaseMicros({ input: 5000, output: 1200 }, OPUS), 53900, 'the float 53900.00000000001 is not a micro more');
  assert.equal(worstCaseMicros({ input: 10500, output: 200 }, HAIKU), 1554);
  // Above 100000 input tokens, the long card.
  assert.equal(worstCaseMicros({ input: 100001, output: 0 }, HAIKU, { geoUs: false }), 62501);
  // Two Opus turns and one Haiku decision at 5000/1200 pass $0.10 once the 1.1 is in; at 4500/1000 they do not.
  const plan = (input, output) => 2 * worstCaseMicros({ input, output }, OPUS) + worstCaseMicros({ input: 10500, output: 200 }, HAIKU);
  assert.ok(plan(5000, 1200) > 100000);
  assert.ok(plan(4500, 1000) <= 100000);
  assert.throws(() => worstCaseMicros({ input: 1, output: 1 }, null), /price is not locked/);
});

test('computeMicros: a required count that is missing or not a number settles nothing, never below the bill', () => {
  const full = { input: 4000, output: 3000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, geo: 'global', speed: 'standard' };
  // Positive control: every count present prices the output too.
  assert.deepEqual(computeMicros(full, OPUS), { micros: 4000 * 4 + 3000 * 20, source: 'computed', flags: [] });
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    const { [field]: dropped, ...missing } = full;
    assert.equal(typeof dropped, 'number');
    assert.equal(computeMicros(missing, OPUS), null, `${field} missing`);
    for (const bad of ['3000', null, -1, Number.NaN, Infinity, {}]) assert.equal(computeMicros({ ...full, [field]: bad }, OPUS), null, `${field}: ${String(bad)}`);
  }
  // The split is optional, but present and unreadable is not read as no split or as 0.
  for (const bad of ['10', -1, Number.NaN, {}]) assert.equal(computeMicros({ ...full, cacheWrite1h: bad }, OPUS), null, String(bad));
  assert.notEqual(computeMicros({ ...full, cacheWrite1h: null }, OPUS), null);
  // Zero is a count: a call billed only for output has 0 input.
  assert.equal(computeMicros({ ...full, input: 0 }, OPUS).micros, 60000);
  assert.equal(settleMicros({ ...full, output: undefined }, OPUS, { kind: 'anthropic' }), null);
});

test('worstCaseMicros: a count it cannot read throws instead of counting as 0', () => {
  assert.equal(worstCaseMicros({ input: 0, output: 10 }, OPUS, { geoUs: false }), 200);
  for (const bad of [undefined, '10', -1, Number.NaN]) {
    assert.throws(() => worstCaseMicros({ input: bad, output: 10 }, OPUS), TypeError, String(bad));
    assert.throws(() => worstCaseMicros({ input: 10, output: bad }, OPUS), TypeError, String(bad));
  }
});

// OpenRouter usage as its adapter maps it: no split by lifetime, no geo, no speed. 1000 input at $4/M, 100 output at
// $20/M, 2000 five-minute writes at $5/M: 4000 + 2000 + 10000.
const OR_USAGE = Object.freeze({ input: 1000, output: 100, cacheRead: 0, cacheWrite: 2000, costUsd: null, model: 'anthropic/claude-opus-5.5' });
const OR_COMPUTED = 16000;
const own = (usage, price = OR_PRICE) => settleMicros(usage, price, { kind: 'openrouter', runtime: 'own' });

test('settleMicros, own runtime on OpenRouter: a reported cost settles, above or below the tokens at the lock', () => {
  assert.equal(computeMicros(OR_USAGE, OR_PRICE).micros, OR_COMPUTED);
  // Reported above computed: the reported figure.
  assert.deepEqual(own({ ...OR_USAGE, costUsd: 0.017 }), { micros: 17000, source: 'model.usage', flags: [] });
  // Reported below computed: still the reported figure, which is what the Key is charged. The tokens are dearer here,
  // so the equality is not vacuous.
  assert.ok(computeMicros({ ...OR_USAGE, costUsd: 0.012 }, OR_PRICE).micros > 12000);
  assert.deepEqual(own({ ...OR_USAGE, costUsd: 0.012 }), { micros: 12000, source: 'model.usage', flags: [] });
  assert.deepEqual(own({ ...OR_USAGE, costUsd: 0.001 }), { micros: 1000, source: 'model.usage', flags: [] });
  // A tie is the reported figure.
  assert.deepEqual(own({ ...OR_USAGE, costUsd: 0.016 }), { micros: OR_COMPUTED, source: 'model.usage', flags: [] });
  // Reported rounds up as usageMicros rounds it.
  assert.equal(own({ ...OR_USAGE, costUsd: 0.0160000001 }).micros, 16001);
});

test('settleMicros, own runtime on OpenRouter: one figure alone settles at it, none settles nothing', () => {
  // No cost reported (null, 0, negative, not a number): the tokens.
  for (const costUsd of [null, undefined, 0, -1, 'x']) {
    assert.deepEqual(own({ ...OR_USAGE, costUsd }), { micros: OR_COMPUTED, source: 'computed', flags: [] }, String(costUsd));
  }
  // Tokens that cannot be priced (no counts, or no price): the reported cost.
  assert.deepEqual(own({ costUsd: 0.0123 }), { micros: 12300, source: 'model.usage', flags: [] });
  assert.deepEqual(own({ ...OR_USAGE, costUsd: 0.0123 }, null), { micros: 12300, source: 'model.usage', flags: [] });
  // Neither: null, never zero.
  for (const u of [null, undefined, {}, { costUsd: 0 }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null }]) assert.equal(own(u), null, JSON.stringify(u));
  assert.equal(own({ ...OR_USAGE, costUsd: null }, null), null);
  // Positive control: the same usage with a price or a cost settles.
  assert.notEqual(own({ ...OR_USAGE, costUsd: null }), null);
  assert.notEqual(own({ costUsd: 0.000001 }), null);
});

test('settleMicros, own runtime on OpenRouter: reported above 1.1x computed raises cost_above_computed, and no flag', () => {
  assert.equal(COST_ABOVE_COMPUTED_ALERT, 'cost_above_computed');
  assert.equal(REPORTED_ABOVE_COMPUTED_MARGIN, 1.1);
  // Exactly 1.1x is not above it.
  const at = own({ ...OR_USAGE, costUsd: 0.0176 });
  assert.deepEqual(at, { micros: 17600, source: 'model.usage', flags: [] });
  assert.equal(at.alerts, undefined);
  // One micro above is.
  assert.deepEqual(own({ ...OR_USAGE, costUsd: 0.017601 }), { micros: 17601, source: 'model.usage', flags: [], alerts: ['cost_above_computed'] });
  assert.deepEqual(own({ ...OR_USAGE, costUsd: 0.05 }).alerts, ['cost_above_computed']);
  // Computed above reported raises nothing: the route was cheaper than the lock, and the bill settles.
  assert.equal(own({ ...OR_USAGE, costUsd: 0.001 }).alerts, undefined);
  // A reported cost with no computed figure to compare against raises nothing.
  assert.equal(own({ costUsd: 0.5 }).alerts, undefined);
  // Flags are what pause paid work; an OpenRouter settlement never carries one, alert or not.
  for (const costUsd of [null, 0.001, 0.016, 0.0176, 0.017601, 0.05]) assert.deepEqual(own({ ...OR_USAGE, costUsd }).flags, [], String(costUsd));
});

test('settleMicros on OpenRouter: the OpenClaw runtime, or no runtime named, is exactly usageMicros (control: own differs)', () => {
  const usages = [
    { ...OR_USAGE, costUsd: 0.012 }, { ...OR_USAGE, costUsd: 0.05 }, { ...OR_USAGE, costUsd: null }, { costUsd: 0.0123 }, null, {},
    { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 4000, cacheWrite1h: 3000, geo: 'us', speed: 'fast', costUsd: 0.001 },
    // Counts missing and no cost: usageMicros reads them as 0, computeMicros prices nothing.
    { input: 1000, output: 100 },
  ];
  let differs = 0;
  for (const u of usages) {
    const today = usageMicros(u, OR_PRICE);
    const want = today ? { ...today, flags: [] } : null;
    assert.deepEqual(settleMicros(u, OR_PRICE, { kind: 'openrouter', runtime: 'openclaw' }), want, JSON.stringify(u));
    assert.deepEqual(settleMicros(u, OR_PRICE, { kind: 'openrouter' }), want, JSON.stringify(u));
    if (JSON.stringify(own(u)) !== JSON.stringify(want)) differs += 1;
  }
  // The same inputs give a different figure on the own runtime, so the equality above is not vacuous.
  assert.ok(differs >= 2);
  // Anthropic is priced the same way on either runtime.
  const an = std({ input: 1000, output: 100, geo: 'us' });
  assert.deepEqual(settleMicros(an, OPUS, { kind: 'anthropic', runtime: 'own' }), settleMicros(an, OPUS, { kind: 'anthropic', runtime: 'openclaw' }));
  assert.equal(settleMicros({ ...OR_USAGE, costUsd: 0.05 }, OR_PRICE, { kind: 'openai', runtime: 'own' }), null);
});

// The ledger explains the Key's figure with the settled rows. A reply settled above its bill leaves a surplus that
// covers later charges: a lost row the Key did charge is cleared at 0, and no residual is written.
const dir = mkdtempSync(join(tmpdir(), 'clo-provider-cost-'));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
const LEDGER_BUDGET = { dailyUsd: 2.5, interjectUsd: 0.75, searchUsd: 2.1, namedUsd: 2.25, addressedUsd: 2.5, residualMinUsd: 0.25, residualPct: 0.15, providerFailStreakPause: 3 };
let dbs = 0;

// 50 replies each billed $0.03, settled at `figure`; then a turn whose usage was lost while the Key charged $0.04 for it.
async function lostRowAfterReplies(figure) {
  const MIN = 60000;
  const clock = { t: Date.UTC(2026, 10, 3, 4, 0, 0) };
  const n = ++dbs;
  const store = openStore(join(dir, `c${n}.db`), { runGen: `g${n}`, now: () => clock.t });
  const eff = {
    runtime: 'own', mode: 'live', budget: { ...LEDGER_BUDGET }, openrouter: { baseUrl: 'http://mock/api/v1' },
    apiProvider: { name: 'or-main', kind: 'openrouter', baseUrl: 'http://mock/api/v1' },
  };
  const key = { usage: 10, limit: 3.25, limit_remaining: 3.25, limit_reset: 'daily', usage_daily: 0 };
  const fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { ...key } }) });
  const ledger = createLedger({ store, getEffective: () => eff, fetch, getKey: () => FAKE_OPENROUTER_KEY, log: createLog(join(dir, `c${n}.jsonl`)), now: () => clock.t, runtime: 'own' });
  try {
    await ledger.reconcile(clock.t);
    for (let i = 0; i < 50; i += 1) {
      const { id } = ledger.reserve({ tier: 'addressed', category: 'reply', heldMicros: 360000, eventKey: `R${i}` });
      ledger.settle(id, { actualMicros: figure.micros, source: figure.source, model: 'm' });
      key.usage = Number((key.usage + 0.03).toFixed(6));
    }
    clock.t += MIN;
    await ledger.reconcile(clock.t);
    const { id: lost } = ledger.reserve({ tier: 'addressed', category: 'reply', heldMicros: 360000, eventKey: 'LOST' });
    ledger.markUnsettled(lost);
    key.usage = Number((key.usage + 0.04).toFixed(6));
    for (let i = 0; i < 20; i += 1) {
      clock.t += MIN;
      await ledger.reconcile(clock.t);
    }
    const r = store.q('SELECT status, actual_micros, source FROM reservations WHERE id=?').get(lost);
    return { status: r.status, micros: r.actual_micros, source: r.source };
  } finally {
    store.close();
  }
}

test('own-runtime OpenRouter settlement keeps the ledger reconcilable: a lost billed row settles at the Key delta', async () => {
  // Reported $0.03 against tokens at the lock of $0.04 (1000 input at $4/M, 1800 output at $20/M).
  const usage = { input: 1000, output: 1800, cacheRead: 0, cacheWrite: 0, costUsd: 0.03 };
  const price = { inputPerM: 4, outputPerM: 20 };
  const figure = settleMicros(usage, price, { kind: 'openrouter', runtime: 'own' });
  assert.deepEqual(figure, { micros: 30000, source: 'model.usage', flags: [] });
  assert.deepEqual(await lostRowAfterReplies(figure), { status: 'settled', micros: 40000, source: 'key_delta' });
  // Control: the same replies settled at the larger, computed figure hide the lost charge, so the case has teeth.
  const computed = computeMicros(usage, price);
  assert.equal(computed.micros, 40000);
  assert.deepEqual(await lostRowAfterReplies(computed), { status: 'settled', micros: 0, source: 'key_delta_none' });
});
