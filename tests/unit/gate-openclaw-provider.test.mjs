// The host path's reply settlement with a provider block in the effective file. settleReply is shared by both runtimes;
// the host process must settle exactly as before the provider layer, from the host's cost figure, whatever provider a
// file written under it names. The own runtime on the same file is the positive control. Real gate, ledger and SQLite;
// the host run is a fake. No network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anthropicEffective, makeEffective, makeHarness, USAGE } from '../fixtures/inbound.mjs';

// What the host reports: a cost figure, and tokens.
const HOST_USAGE = { ...USAGE };
// Usage with no cost figure and US-only inference, as an Anthropic call would report it.
const BARE_USAGE = { input: 900, output: 40, cacheRead: 0, cacheWrite: 4000, cacheWrite1h: 0, costUsd: null, model: 'claude-opus-5-5', geo: 'us', speed: 'standard' };

const FILES = {
  // What validation refuses, but a hand-written file could still carry: an OpenClaw runtime with a provider block.
  'runtime openclaw with an apiProvider block': () => makeEffective({ runtime: 'openclaw', apiProvider: { name: 'anthropic', kind: 'anthropic', baseUrl: 'http://127.0.0.1:9', hardCap: null } }),
  'no runtime named, with an apiProvider block': () => makeEffective({ apiProvider: { name: 'anthropic', kind: 'anthropic', baseUrl: 'http://127.0.0.1:9', hardCap: null } }),
  // A clo apply that switched the file to the own runtime on Anthropic while the host process still runs.
  'runtime own on anthropic, under the host process': () => anthropicEffective(),
};

async function settle(effective, usage, runtime) {
  const h = makeHarness({ effective, dispatch: async () => ({ started: true, hostError: false, aborted: false, usage }), ...(runtime ? { runtime } : {}) });
  const e = await h.sendAndFlush(h.at({ text: '一个问题' }));
  const rows = h.reservations(e).filter((r) => r.category !== 'decision');
  const out = { rows, paused: h.store.getControl('paid_paused'), alerts: h.store.listAlerts().map((a) => a.kind), state: h.state(e) };
  await h.close();
  return out;
}

for (const [label, file] of Object.entries(FILES)) {
  test(`openclaw, ${label}: the reply settles from the host's costUsd as model.usage`, async () => {
    const { rows, paused, state } = await settle(file(), HOST_USAGE);
    assert.equal(state, 'completed:sent');
    assert.equal(rows.length, 1);
    assert.deepEqual({ s: rows[0].status, m: rows[0].actual_micros, src: rows[0].source }, { s: 'settled', m: 10000, src: 'model.usage' });
    assert.equal(paused, null);
  });

  test(`openclaw, ${label}: usage with no cost figure falls back to tokens as before, with no price flag and no pause`, async () => {
    const eff = file();
    const p = eff.models.primary.price;
    const want = Math.ceil(BARE_USAGE.input * p.inputPerM + BARE_USAGE.output * p.outputPerM + BARE_USAGE.cacheWrite * p.cacheWritePerM);
    const { rows, paused, alerts } = await settle(eff, BARE_USAGE);
    assert.deepEqual({ m: rows[0].actual_micros, src: rows[0].source }, { m: want, src: 'computed' }, 'usageMicros: no geo multiplier');
    assert.equal(paused, null);
    assert.equal(alerts.includes('price_unexpected'), false);
  });
}

test('own on the same anthropic file (positive control): the bot prices the tokens itself, ignores any cost figure, and US-only inference pauses', async () => {
  const withCost = await settle(anthropicEffective(), { ...BARE_USAGE, geo: 'global', costUsd: 0.01 }, 'own');
  // 900 x $4/M + 40 x $20/M + 4000 x $5/M.
  assert.deepEqual({ m: withCost.rows[0].actual_micros, src: withCost.rows[0].source }, { m: 24400, src: 'computed' });
  assert.equal(withCost.paused, null);

  const us = await settle(anthropicEffective(), BARE_USAGE, 'own');
  assert.deepEqual({ m: us.rows[0].actual_micros, src: us.rows[0].source }, { m: 26840, src: 'computed' });
  assert.equal(us.paused, 'anthropic_price_unexpected');
  assert.ok(us.alerts.includes('price_unexpected'));
});

test('own on the implicit openrouter entry: settlement is the host order too, reported cost first (control for the runtime split)', async () => {
  const { rows } = await settle(makeEffective({ runtime: 'own' }), HOST_USAGE, 'own');
  assert.deepEqual({ m: rows[0].actual_micros, src: rows[0].source }, { m: 10000, src: 'model.usage' });
});
