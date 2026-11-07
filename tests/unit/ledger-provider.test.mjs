// The ledger on a provider whose Key cannot be read (contract section 8.1), beside the OpenRouter behaviour it must keep.
// Every negative case has its positive control in the same run.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createLedger } from '../../src/clo-plugin/lib/core/ledger.js';
import { createLog } from '../../src/clo-plugin/lib/core/log.js';
import {
  ANTHROPIC_LIMIT_SOURCES, HARD_CAP_PAUSE, PRICE_PAUSE, hardCapControlKey, hardCapPauseKey, providerOfEffective,
} from '../../src/clo-plugin/lib/core/providers/registry.js';
import { openStore } from '../../src/clo-plugin/lib/core/store.js';
import { FAKE_ANTHROPIC_KEY, FAKE_OPENROUTER_KEY } from '../harness/fake-keys.mjs';

const dir = mkdtempSync(join(tmpdir(), 'clo-ledger-provider-'));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
let n = 0;
const T0 = Date.UTC(2026, 10, 3, 4, 0, 0); // 12:00 Asia/Shanghai
const MIN = 60000;
const BUDGET = { dailyUsd: 2.5, interjectUsd: 0.75, searchUsd: 2.1, namedUsd: 2.25, addressedUsd: 2.5, residualMinUsd: 0.25, residualPct: 0.15, providerFailStreakPause: 3 };

// Effective files of the three shapes: the implicit OpenRouter entry (no runtime, as on the OpenClaw path), an
// OpenRouter entry under another name, and Anthropic. All on the own runtime but the first.
const EFF = {
  implicit: () => ({ mode: 'live', budget: { ...BUDGET }, openrouter: { baseUrl: 'http://mock/api/v1' } }),
  named: () => ({ runtime: 'own', mode: 'live', budget: { ...BUDGET }, openrouter: { baseUrl: 'http://mock/api/v1' }, apiProvider: { name: 'or-main', kind: 'openrouter', baseUrl: 'http://mock/api/v1' } }),
  anthropic: () => ({ runtime: 'own', mode: 'live', budget: { ...BUDGET }, openrouter: { baseUrl: 'http://mock/api/v1' }, apiProvider: { name: 'anthropic', kind: 'anthropic', baseUrl: 'http://mock-anthropic' } }),
};
const KEYS = { implicit: FAKE_OPENROUTER_KEY, named: FAKE_OPENROUTER_KEY, anthropic: FAKE_ANTHROPIC_KEY };

function setup(shape = 'anthropic', { file = join(dir, `p${++n}.db`) } = {}) {
  const clock = { t: T0 };
  const store = openStore(file, { runGen: `g${n}`, now: () => clock.t });
  const h = { store, clock, file, calls: [], keyReads: 0, state: { fail: false }, key: { usage: 0, limit: 3.25, limit_remaining: 3.25, limit_reset: 'daily', usage_daily: 0 } };
  h.eff = EFF[shape]();
  h.logFile = join(dir, `p${n}.jsonl`);
  h.fetch = async (url, init) => {
    h.calls.push({ url, init });
    if (h.state.fail) throw new Error('network down');
    return { ok: true, status: 200, json: async () => ({ data: { ...h.key } }) };
  };
  h.getKey = () => {
    h.keyReads += 1;
    return KEYS[shape];
  };
  h.open = (eff = h.eff) => createLedger({ store, getEffective: () => eff, fetch: h.fetch, getKey: h.getKey, log: createLog(h.logFile), now: () => clock.t, runtime: 'own' });
  h.ledger = h.open();
  return h;
}
const paused = (h) => h.store.getControl('paid_paused');
const row = (store, id) => store.q('SELECT * FROM reservations WHERE id=?').get(id);
const reply = (ledger, usd = 0.2, eventKey = 'E') => ledger.reserve({ tier: 'addressed', category: 'reply', heldMicros: Math.round(usd * 1e6), eventKey });
const logText = (h) => {
  try {
    return readFileSync(h.logFile, 'utf8');
  } catch {
    return '';
  }
};
const streak = (store) => store.peekCounter('provider_fail_streak');

test('the default provider is read from the effective file, and on the OpenClaw path an apiProvider block changes nothing', async () => {
  const openclaw = setup('implicit');
  // A stray block in a file without runtime own: the implicit OpenRouter entry still spends, so the Key is read.
  openclaw.eff.apiProvider = { name: 'anthropic', kind: 'anthropic' };
  assert.equal(providerOfEffective(openclaw.eff).kind, 'openrouter');
  const k = await openclaw.ledger.readKey();
  assert.equal(k.usageMicros, 0);
  assert.equal(openclaw.calls.length, 1, 'positive control: the OpenRouter path reads the Key');
  assert.equal(openclaw.calls[0].url, 'http://mock/api/v1/key');
  openclaw.store.close();

  const own = setup('anthropic');
  await assert.rejects(own.ledger.readKey(), (e) => e.message === 'key read unsupported');
  assert.equal(own.calls.length, 0, 'the Anthropic Key is never sent to /key');
  assert.equal(own.keyReads, 0, 'not even fetched from the environment');
  own.store.close();
});

test('anthropic: no /key fetch at start or in later ticks, no key_read_failed, reconcile unsupported (control: openrouter does both)', async () => {
  const a = setup('anthropic');
  a.state.fail = true;
  a.ledger.reserve({ tier: 'addressed', category: 'reply', heldMicros: 1000, eventKey: 'U' });
  a.ledger.markUnsettled(a.store.q('SELECT id FROM reservations').get().id);
  for (let i = 0; i < 5; i += 1) {
    a.clock.t += 11 * MIN;
    a.store.setControl('connected', 'true', 'test');
    await a.ledger.reconcile(a.clock.t, { atStart: i === 0 });
  }
  a.ledger.startTimers();
  a.ledger.stopTimers();
  assert.deepEqual(await a.ledger.reconcile(a.clock.t, { atStart: true }), { ok: false, unsupported: true });
  assert.equal(a.calls.length, 0);
  assert.equal(a.keyReads, 0);
  assert.equal(paused(a), null, 'nothing paused at start');
  assert.equal(a.store.getMeta('key_baseline'), null);
  assert.equal(a.store.q('SELECT COUNT(*) AS n FROM key_snapshots').get().n, 0);
  assert.ok(!logText(a).includes('key_read_failed'));
  assert.ok(!logText(a).includes(FAKE_ANTHROPIC_KEY));
  assert.deepEqual(a.ledger.snapshot(), { provider: 'anthropic', keyReadable: false, paidPaused: null, hardCapPaused: null });
  a.store.close();

  const o = setup('named');
  o.state.fail = true;
  o.ledger.startTimers();
  o.ledger.stopTimers();
  // startTimers runs the first tick at once; wait for its read to fail.
  for (let i = 0; i < 50 && paused(o) === null; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.equal(o.calls.length, 1, 'positive control: openrouter reads the Key at start');
  assert.equal(paused(o), 'key_read_failed', 'positive control: and a failed first read pauses');
  assert.equal(o.ledger.snapshot().keyReadable, true);
  o.store.close();
});

test('reserve writes the provider kind: NULL for the implicit entry, the kind (not the name) otherwise', () => {
  for (const [shape, want] of [['implicit', null], ['named', 'openrouter'], ['anthropic', 'anthropic']]) {
    const h = setup(shape);
    const { ok, id } = reply(h.ledger);
    assert.equal(ok, true);
    assert.equal(row(h.store, id).provider, want, shape);
    h.store.close();
  }
  const none = setup('anthropic');
  const ledger = createLedger({ store: none.store, getEffective: () => none.eff, fetch: none.fetch, getKey: none.getKey, now: () => none.clock.t, getProvider: () => null });
  assert.deepEqual(ledger.reserve({ tier: 'addressed', category: 'reply', heldMicros: 1000 }), { ok: false, reason: 'provider' }, 'no provider, nothing to spend on');
  assert.equal(none.store.q('SELECT COUNT(*) AS n FROM reservations').get().n, 0);
  none.store.close();
});

test('anthropic: each limit source pauses under its own name at any status, clear-pause lifts it, and it pauses again', () => {
  for (const source of ANTHROPIC_LIMIT_SOURCES) {
    for (const status of [400, 402, 403, 429]) {
      for (const which of ['noteProviderError', 'noteDecisionError']) {
        const h = setup('anthropic');
        h.ledger[which]({ httpStatus: status, limitSource: source });
        assert.equal(paused(h), source, `${which} ${status} ${source}`);
        assert.equal(streak(h.store), 0, 'a limit is not a failure in the streak');
        assert.deepEqual(h.ledger.clearOwnerPause(), { cleared: true, reason: source });
        assert.equal(paused(h), null);
        h.ledger[which]({ httpStatus: status, limitSource: source });
        assert.equal(paused(h), source, 'the next occurrence pauses again at once');
        h.store.close();
      }
    }
  }
  const price = setup('anthropic');
  price.ledger.pausePaid(PRICE_PAUSE);
  assert.deepEqual(price.ledger.clearOwnerPause(), { cleared: true, reason: PRICE_PAUSE });
  // Control: a pause only a Key read lifts is still refused to the owner here.
  price.ledger.pausePaid('residual');
  assert.deepEqual(price.ledger.clearOwnerPause(), { cleared: false, reason: 'residual' });
  price.store.close();
});

test('the limit names of each kind count only while that kind spends', () => {
  // OpenRouter active: an anthropic_* source pauses nothing under its name and counts as a failure...
  const o = setup('named');
  o.ledger.noteProviderError({ httpStatus: 429, limitSource: 'anthropic_spend_limit' });
  o.ledger.noteDecisionError({ httpStatus: 403, limitSource: 'anthropic_permission' });
  assert.equal(paused(o), null);
  assert.equal(streak(o.store), 1);
  // ...positive control: an OpenRouter limit pauses there.
  o.ledger.noteProviderError({ httpStatus: 402, limitSource: 'openrouter_key_limit' });
  assert.equal(paused(o), 'openrouter_key_limit');
  o.store.close();
  // A bare 402 is OpenRouter credits there, and Anthropic credits on Anthropic.
  const o2 = setup('implicit');
  o2.ledger.noteProviderError({ httpStatus: 402 });
  assert.equal(paused(o2), 'openrouter_credits');
  o2.store.close();

  // Anthropic active: an OpenRouter limit name pauses nothing only that Key's read could lift.
  const a = setup('anthropic');
  a.ledger.noteProviderError({ httpStatus: 403, limitSource: 'openrouter_key_limit' });
  a.ledger.noteProviderError({ httpStatus: 403, limitSource: 'openrouter_credits' });
  assert.equal(paused(a), null);
  assert.equal(streak(a.store), 2);
  a.ledger.noteProviderError({ httpStatus: 402 });
  assert.equal(paused(a), 'anthropic_credits');
  a.store.close();
});

test('D11: 429 and 529 count in the provider_fail streak; a 429 spend-limit error is spend_limit instead', () => {
  const a = setup('anthropic');
  a.ledger.noteProviderError({ httpStatus: 429 });
  a.ledger.noteProviderError({ httpStatus: 529 });
  assert.equal(paused(a), null, 'two failures pause nothing yet');
  a.ledger.noteProviderError({ httpStatus: 529 });
  assert.equal(paused(a), 'provider_fail');
  a.store.close();

  const s = setup('anthropic');
  s.ledger.noteProviderError({ httpStatus: 429, limitSource: 'anthropic_spend_limit' });
  assert.equal(paused(s), 'anthropic_spend_limit');
  assert.equal(streak(s.store), 0);
  s.store.close();
});

test('provider_fail is the owner\'s to clear only where no Key read can; the streak is left one short of the limit', () => {
  const a = setup('anthropic');
  for (let i = 0; i < 3; i += 1) a.ledger.noteProviderError({ httpStatus: 500 });
  assert.equal(paused(a), 'provider_fail');
  assert.deepEqual(a.ledger.clearOwnerPause(), { cleared: true, reason: 'provider_fail' });
  assert.equal(paused(a), null);
  assert.equal(streak(a.store), 2);
  assert.equal(reply(a.ledger).ok, true, 'paid work runs again');
  a.ledger.noteProviderError({ httpStatus: 500 });
  assert.equal(paused(a), 'provider_fail', 'one more failure pauses again at once');
  a.store.close();

  const o = setup('named');
  for (let i = 0; i < 3; i += 1) o.ledger.noteProviderError({ httpStatus: 500 });
  assert.equal(paused(o), 'provider_fail');
  assert.deepEqual(o.ledger.clearOwnerPause(), { cleared: false, reason: 'provider_fail' }, 'OpenRouter: a clean read lifts it');
  assert.equal(paused(o), 'provider_fail');
  o.store.close();
});

test('the credits probe relabels a streak only on openrouter', () => {
  for (const [shape, want] of [['named', 'openrouter_credits'], ['anthropic', 'provider_fail']]) {
    const h = setup(shape);
    h.store.setControl('credits_probe', h.clock.t + 3600000, 'ledger');
    for (let i = 0; i < 3; i += 1) h.ledger.noteProviderError({ httpStatus: 500 });
    assert.equal(paused(h), want, shape);
    h.store.close();
  }
});

test('the residual check counts only rows the OpenRouter Key could have charged, under any entry name', async () => {
  const file = join(dir, `mixed${++n}.db`);
  const o = setup('named', { file });
  const anthropicLedger = o.open(EFF.anthropic());
  o.key.usage = 10;
  assert.equal((await o.ledger.reconcile(o.clock.t)).ok, true);
  o.clock.t += 1000;
  const or = reply(o.ledger, 0.2, 'O');
  o.ledger.settle(or.id, { actualMicros: 200000, source: 'model.usage' });
  const an = reply(anthropicLedger, 0.3, 'A');
  anthropicLedger.settle(an.id, { actualMicros: 300000, source: 'computed' });
  assert.equal(row(o.store, or.id).provider, 'openrouter');
  assert.equal(row(o.store, an.id).provider, 'anthropic');
  // Positive control: the OpenRouter row, written under the name or-main, explains its own charge.
  o.clock.t += MIN;
  o.key.usage = 10.2;
  await o.ledger.reconcile(o.clock.t);
  const unattributed = () => o.store.q("SELECT COALESCE(SUM(actual_micros), 0) AS m FROM reservations WHERE category='unattributed'").get().m;
  assert.equal(unattributed(), 0);
  // A further 0.3 on the OpenRouter Key: the Anthropic row of the same amount must not explain it away.
  o.clock.t += MIN;
  o.key.usage = 10.5;
  await o.ledger.reconcile(o.clock.t);
  assert.equal(unattributed(), 300000);
  assert.equal(o.store.q("SELECT provider FROM reservations WHERE category='unattributed'").get().provider, 'openrouter');
  o.store.close();
});

test('rows from before the migration (provider NULL) still explain the OpenRouter figure', async () => {
  const h = setup('implicit');
  h.key.usage = 10;
  await h.ledger.reconcile(h.clock.t);
  h.clock.t += 1000;
  const r = reply(h.ledger, 0.2, 'O');
  h.ledger.settle(r.id, { actualMicros: 200000, source: 'model.usage' });
  h.store.q('UPDATE reservations SET provider=NULL').run();
  h.clock.t += MIN;
  h.key.usage = 10.2;
  await h.ledger.reconcile(h.clock.t);
  assert.equal(h.store.q("SELECT COUNT(*) AS n FROM reservations WHERE category='unattributed'").get().n, 0);
  h.store.close();
});

test('D4: unsettled Anthropic rows stay counted at their hold until accept-unsettled (control: openrouter clears them by Key reads)', async () => {
  const a = setup('anthropic');
  const { id } = reply(a.ledger, 0.18, 'U');
  a.ledger.markUnsettled(id);
  const sent = reply(a.ledger, 0.18, 'N');
  assert.equal(a.ledger.release(sent.id), true, 'a row definitely not sent is released, as today');
  for (let i = 0; i < 6; i += 1) {
    a.clock.t += 10 * MIN;
    await a.ledger.reconcile(a.clock.t);
  }
  assert.equal(row(a.store, id).status, 'unsettled');
  assert.equal(a.ledger.spent(a.clock.t).localMicros, 180000, 'counted at its hold');
  assert.equal(a.ledger.acceptUnsettled('cli'), 1);
  assert.equal(row(a.store, id).status, 'settled');
  assert.equal(row(a.store, id).actual_micros, 180000);
  assert.equal(row(a.store, id).source, 'manual');
  a.store.close();

  const o = setup('named');
  o.key.usage = 10;
  await o.ledger.reconcile(o.clock.t);
  o.clock.t += 1000;
  const u = reply(o.ledger, 0.18, 'U');
  o.ledger.markUnsettled(u.id);
  for (let i = 0; i < 4; i += 1) {
    o.clock.t += 6 * MIN;
    await o.ledger.reconcile(o.clock.t);
  }
  assert.equal(row(o.store, u.id).source, 'key_delta_none', 'positive control: the F13 rule runs where the Key is read');
  assert.equal(row(o.store, u.id).actual_micros, 0);
  o.store.close();
});

test('owner order on anthropic: a cleared pause becomes usage_missing past unsettled rows, accept-unsettled then lifts it', () => {
  const a = setup('anthropic');
  const { id } = reply(a.ledger, 0.18, 'U');
  a.ledger.markUnsettled(id);
  a.ledger.noteProviderError({ httpStatus: 402, limitSource: 'anthropic_credits' });
  assert.deepEqual(a.ledger.clearOwnerPause(), { cleared: true, reason: 'anthropic_credits' });
  assert.equal(paused(a), 'usage_missing');
  assert.deepEqual(a.ledger.clearOwnerPause(), { cleared: false, reason: 'usage_missing' });
  a.ledger.acceptUnsettled('cli');
  assert.equal(paused(a), null);
  assert.equal(reply(a.ledger).ok, true);
  a.store.close();
});

test('resetForProviderSwitch refuses what would carry over, and clears what only the old provider could end', async () => {
  const refuse = [
    ['paid_paused', (h) => h.ledger.pausePaid('provider_fail')],
    ['decision_breaker', (h) => h.store.setControl('decision_paused', 'open', 'ledger')],
    ['reservations', (h) => reply(h.ledger)],
    ['reservations', (h) => h.ledger.markUnsettled(reply(h.ledger).id)],
  ];
  for (const [reason, make] of refuse) {
    const h = setup('named');
    h.store.setControl('residual_over', 1, 'ledger');
    make(h);
    assert.deepEqual(h.ledger.resetForProviderSwitch(), { ok: false, reason });
    assert.equal(h.store.getControl('residual_over'), '1', 'nothing cleared on a refusal');
    h.store.close();
  }

  const h = setup('named');
  h.key.usage = 10;
  await h.ledger.reconcile(h.clock.t);
  assert.notEqual(h.store.getMeta('key_baseline'), null);
  h.store.setControl('residual_over', 2, 'ledger');
  h.store.setControl('credits_probe', h.clock.t + 3600000, 'ledger');
  h.store.setControl('key_limit_seen', 'amount:1:2', 'ledger');
  h.ledger.noteProviderError({ httpStatus: 500 });
  h.ledger.pauseHardCap('anthropic', 'start', 'hard_cap');
  h.store.setControl(hardCapControlKey('anthropic'), 'fp', 'cli');
  // A hard-cap pause never makes it refuse.
  assert.deepEqual(h.ledger.resetForProviderSwitch(), { ok: true });
  for (const c of ['residual_over', 'credits_probe', 'key_limit_seen']) assert.equal(h.store.getControl(c), null, c);
  assert.equal(streak(h.store), 0);
  assert.equal(h.store.getMeta('key_baseline'), null, 'rebaseKey ran');
  assert.equal(h.store.getControl(hardCapPauseKey('anthropic')), 'hard_cap', 'the hard-cap pause stays');
  assert.equal(h.store.getControl(hardCapControlKey('anthropic')), 'fp', 'and the attestation');
  h.store.close();
});

test('after a switch, a stale residual count no longer re-pauses a clear, and the key-failure count starts again', async () => {
  for (const reset of [false, true]) {
    const h = setup('anthropic');
    h.store.setControl('residual_over', 2, 'ledger');
    if (reset) assert.equal(h.ledger.resetForProviderSwitch().ok, true);
    h.ledger.noteProviderError({ httpStatus: 403, limitSource: 'anthropic_permission' });
    h.ledger.clearOwnerPause();
    assert.equal(paused(h), reset ? null : 'residual', reset ? 'cleared with the switch' : 'control: without the reset the stale count re-pauses');
    h.store.close();
  }
  for (const reset of [false, true]) {
    const h = setup('named');
    h.key.usage = 10;
    await h.ledger.reconcile(h.clock.t);
    h.state.fail = true;
    await h.ledger.reconcile(h.clock.t);
    assert.equal(paused(h), null, 'one failed read pauses nothing');
    if (reset) assert.equal(h.ledger.resetForProviderSwitch().ok, true);
    await h.ledger.reconcile(h.clock.t);
    assert.equal(paused(h), reset ? null : 'key_read_failed', reset ? 'the count started again' : 'control: the second failure pauses');
    h.store.close();
  }
});

test('the hard-cap pause blocks only its own kind, never touches paid_paused, and only its lift ends it', async () => {
  const a = setup('anthropic');
  a.ledger.pauseHardCap('anthropic', 'start', 'provider_rules');
  assert.deepEqual(reply(a.ledger), { ok: false, reason: HARD_CAP_PAUSE });
  assert.equal(paused(a), null, 'not a paid_paused reason');
  const alert = a.store.listAlerts().find((x) => x.kind === 'paid_paused');
  assert.deepEqual(alert.detail, { reason: HARD_CAP_PAUSE, code: 'provider_rules' });
  assert.deepEqual(a.ledger.snapshot().hardCapPaused, 'provider_rules');
  a.ledger.pauseHardCap('anthropic', 'start', 'provider_rules');
  assert.equal(a.store.listAlerts().filter((x) => x.kind === 'paid_paused').length, 1, 'the same pause again adds no alert');
  // Nothing else lifts it.
  a.ledger.clearOwnerPause();
  a.ledger.acceptUnsettled('cli');
  await a.ledger.reconcile(a.clock.t);
  assert.equal(a.ledger.hardCapPaused('anthropic'), 'provider_rules');
  // With openrouter active the same store reserves.
  const o = a.open(EFF.named());
  assert.equal(reply(o).ok, true, 'a pause raised for anthropic blocks nothing on openrouter');
  assert.equal(o.snapshot().hardCapPaused, null);
  // Positive control: lifted, with no lower pause, reserve succeeds.
  a.store.q("UPDATE reservations SET status='released'").run();
  a.ledger.liftHardCapPause('anthropic');
  assert.equal(reply(a.ledger).ok, true);
  a.store.close();

  // A lower pause under the hard-cap pause survives its lift.
  const b = setup('anthropic');
  b.ledger.markUnsettled(reply(b.ledger, 0.18, 'U').id);
  b.ledger.pausePaid('usage_missing', 'gate');
  b.ledger.pauseHardCap('anthropic', 'start', 'hard_cap');
  assert.deepEqual(reply(b.ledger), { ok: false, reason: HARD_CAP_PAUSE });
  b.ledger.liftHardCapPause('anthropic');
  assert.equal(paused(b), 'usage_missing');
  assert.deepEqual(reply(b.ledger), { ok: false, reason: 'paid_paused' });
  b.store.close();

  const c = setup('anthropic');
  assert.throws(() => c.ledger.pauseHardCap('other', 'start', 'hard_cap'), TypeError);
  assert.throws(() => c.ledger.pauseHardCap('anthropic', 'start', 'anything'), TypeError);
  assert.equal(c.store.getControl(hardCapPauseKey('anthropic')), null);
  c.store.close();
});

test('attestHardCap binds the ack to the Key fingerprint and lifts the hard-cap pause; another Key does not match', () => {
  const a = setup('anthropic');
  assert.equal(a.ledger.hardCapKeyMatches('anthropic', FAKE_ANTHROPIC_KEY), false, 'no attestation is no match');
  a.ledger.pauseHardCap('anthropic', 'start', 'hard_cap');
  a.ledger.attestHardCap('anthropic', FAKE_ANTHROPIC_KEY);
  assert.equal(a.ledger.hardCapPaused('anthropic'), null);
  const fp = a.store.getControl(hardCapControlKey('anthropic'));
  assert.equal(fp, a.store.key(FAKE_ANTHROPIC_KEY));
  assert.ok(!fp.includes('sk-ant'), 'the control holds a fingerprint, never the Key');
  assert.equal(a.ledger.hardCapKeyMatches('anthropic', FAKE_ANTHROPIC_KEY), true, 'positive control');
  assert.equal(a.ledger.hardCapKeyMatches('anthropic', `${FAKE_ANTHROPIC_KEY}-other`), false);
  assert.equal(a.ledger.hardCapKeyMatches('anthropic', null), false);
  assert.throws(() => a.ledger.attestHardCap('anthropic', ''), (e) => e instanceof TypeError && !e.message.includes('sk-'));
  a.store.close();
});

test('OpenRouter Key reads neither settle nor clear another provider\'s unsettled rows (control: its own rows)', async () => {
  const file = join(dir, `mixed${++n}.db`);
  const o = setup('named', { file });
  const anthropicLedger = o.open(EFF.anthropic());
  o.key.usage = 10;
  await o.ledger.reconcile(o.clock.t);
  o.clock.t += 1000;
  const a = reply(anthropicLedger, 0.18, 'A');
  anthropicLedger.markUnsettled(a.id);
  const r = reply(o.ledger, 0.18, 'O');
  o.ledger.markUnsettled(r.id);
  // A charge on the OpenRouter Key goes to its own unsettled row only.
  o.clock.t += MIN;
  o.key.usage = 10.1;
  await o.ledger.reconcile(o.clock.t);
  assert.equal(row(o.store, r.id).source, 'key_delta');
  assert.equal(row(o.store, r.id).actual_micros, 100000);
  assert.equal(row(o.store, a.id).status, 'unsettled', 'not settled from the OpenRouter figure');
  // Quiet reads past the delay clear nothing of Anthropic's.
  for (let i = 0; i < 5; i += 1) {
    o.clock.t += 6 * MIN;
    await o.ledger.reconcile(o.clock.t);
  }
  assert.equal(row(o.store, a.id).status, 'unsettled');
  // Positive control: an OpenRouter row in the same position is cleared to zero by those reads.
  const r2 = reply(o.ledger, 0.18, 'O2');
  o.ledger.markUnsettled(r2.id);
  for (let i = 0; i < 5; i += 1) {
    o.clock.t += 6 * MIN;
    await o.ledger.reconcile(o.clock.t);
  }
  assert.equal(row(o.store, r2.id).source, 'key_delta_none');
  assert.equal(row(o.store, a.id).status, 'unsettled');
  o.store.close();
});

test('another provider\'s call in flight does not stand for an OpenRouter charge (control: an OpenRouter one does)', async () => {
  for (const which of ['anthropic', 'named']) {
    const o = setup('named', { file: join(dir, `flight${++n}.db`) });
    const other = which === 'anthropic' ? o.open(EFF.anthropic()) : o.ledger;
    o.key.usage = 10;
    await o.ledger.reconcile(o.clock.t);
    o.clock.t += 1000;
    reply(other, 0.18, 'F');
    o.clock.t += MIN;
    o.key.usage = 10.3;
    await o.ledger.reconcile(o.clock.t);
    const m = o.store.q("SELECT COALESCE(SUM(actual_micros), 0) AS m FROM reservations WHERE category='unattributed'").get().m;
    assert.equal(m, which === 'anthropic' ? 300000 : 120000, which);
    o.store.close();
  }
});

test('late usage after a row settled is an adjustment of the provider that ran the event', () => {
  const file = join(dir, `late${++n}.db`);
  const a = setup('anthropic', { file });
  const r = reply(a.ledger, 0.18, 'A');
  a.ledger.settle(r.id, { actualMicros: 100000, source: 'computed' });
  // The OpenRouter ledger on the same db sees the late figure: the adjustment stays Anthropic's.
  const o = a.open(EFF.named());
  assert.equal(o.applyLateUsage('A', { actualMicros: 5000, source: 'computed' }).status, 'adjusted');
  assert.equal(a.store.q("SELECT provider FROM reservations WHERE category='adjustment'").get().provider, 'anthropic');
  // Control: usage nobody waited for carries the provider spending now.
  assert.equal(o.applyLateUsage(null, { actualMicros: 5000, source: 'computed' }).status, 'unattributed');
  assert.equal(a.store.q("SELECT provider FROM reservations WHERE category='unattributed'").get().provider, 'openrouter');
  a.store.close();
});

test('a switch away and back drops the old Key\'s snapshots too: another Key\'s figure is never today\'s charges (control: no switch, key_changed)', async () => {
  const SECOND_KEY = `${FAKE_OPENROUTER_KEY}-SECOND`;
  for (const switched of [true, false]) {
    const h = setup('named');
    let key = FAKE_OPENROUTER_KEY;
    const ledger = createLedger({ store: h.store, getEffective: () => h.eff, fetch: h.fetch, getKey: () => key, now: () => h.clock.t, runtime: 'own' });
    h.key.usage = 10;
    await ledger.reconcile(h.clock.t);
    assert.equal(h.store.q('SELECT COUNT(*) AS n FROM key_snapshots').get().n, 1);
    if (switched) {
      assert.equal(ledger.resetForProviderSwitch().ok, true);
      assert.equal(h.store.q('SELECT COUNT(*) AS n FROM key_snapshots').get().n, 0, 'the snapshots went with the baseline');
    }
    // Two days on the other provider, then back on OpenRouter with another Key whose lifetime figure is higher.
    h.clock.t += 2 * 24 * 3600000;
    if (switched) assert.equal(ledger.resetForProviderSwitch().ok, true);
    key = SECOND_KEY;
    h.key.usage = 40;
    await ledger.reconcile(h.clock.t);
    assert.equal(ledger.spent(h.clock.t).providerMicros, 0, switched ? 'the old Key\'s snapshot is not subtracted' : 'control: the Key change is seen');
    assert.equal(ledger.reserve({ tier: 'addressed', category: 'reply', heldMicros: 100000, eventKey: `S${switched}` }).ok, true);
    const changed = h.store.listAlerts().some((x) => x.kind === 'key_changed');
    assert.equal(changed, !switched, switched ? 'nothing to tell: the switch started afresh' : 'control: without the switch, key_changed');
    // Positive control: the new Key's charges after the fresh start do count.
    h.store.q("UPDATE reservations SET status='released'").run();
    h.clock.t += MIN;
    h.key.usage = 40.5;
    await ledger.reconcile(h.clock.t);
    assert.equal(ledger.spent(h.clock.t).providerMicros, 500000);
    h.store.close();
  }
});

// getEffective answering from a script, then the fallback: a read that fails between two others in one call.
const scripted = (seq, fallback) => {
  let i = 0;
  return () => (i < seq.length ? seq[i++] : fallback);
};

test('one call resolves the provider once: a failed second read never turns Anthropic into the implicit OpenRouter entry', async () => {
  // readKey: the Anthropic Key never reaches /key, whatever the next read gives.
  const a = setup('anthropic');
  const la = createLedger({ store: a.store, getEffective: scripted([a.eff, null], a.eff), fetch: a.fetch, getKey: a.getKey, now: () => a.clock.t, runtime: 'own' });
  await assert.rejects(la.readKey(), (e) => e.message === 'key read unsupported');
  assert.equal(a.calls.length, 0);
  assert.equal(a.keyReads, 0);
  a.store.close();
  // Positive control: the same script on OpenRouter reads the Key once.
  const o = setup('named');
  const lo = createLedger({ store: o.store, getEffective: scripted([o.eff, null], o.eff), fetch: o.fetch, getKey: o.getKey, now: () => o.clock.t, runtime: 'own' });
  assert.equal((await lo.readKey()).usageMicros, 0);
  assert.equal(o.calls.length, 1);
  o.store.close();

  // reserve: the hard-cap pause binds whatever the next read gives.
  for (const lifted of [false, true]) {
    const h = setup('anthropic');
    h.ledger.pauseHardCap('anthropic', 'start', 'hard_cap');
    if (lifted) h.ledger.liftHardCapPause('anthropic');
    const l = createLedger({ store: h.store, getEffective: scripted([h.eff, null], h.eff), fetch: h.fetch, getKey: h.getKey, now: () => h.clock.t, runtime: 'own' });
    const r = l.reserve({ tier: 'addressed', category: 'reply', heldMicros: 1000, eventKey: 'H' });
    if (lifted) {
      assert.equal(r.ok, true, 'positive control: lifted, it reserves');
      assert.equal(row(h.store, r.id).provider, 'anthropic', 'under the provider of the same read');
    } else {
      assert.deepEqual(r, { ok: false, reason: HARD_CAP_PAUSE });
    }
    h.store.close();
  }

  // The first tick: no read, so no key_read_failed that nothing on Anthropic could lift.
  const t = setup('anthropic');
  t.state.fail = true;
  const lt = createLedger({ store: t.store, getEffective: scripted([t.eff, null, null, null], t.eff), fetch: t.fetch, getKey: t.getKey, now: () => t.clock.t, runtime: 'own', setTimer: () => null, clearTimer: () => {} });
  lt.startTimers();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(t.calls.length, 0);
  assert.equal(paused(t), null);
  t.store.close();
  // Positive control: on OpenRouter the first tick reads, and a failed first read pauses.
  const ot = setup('named');
  ot.state.fail = true;
  const lot = createLedger({ store: ot.store, getEffective: () => ot.eff, fetch: ot.fetch, getKey: ot.getKey, now: () => ot.clock.t, runtime: 'own', setTimer: () => null, clearTimer: () => {} });
  lot.startTimers();
  for (let i = 0; i < 50 && paused(ot) === null; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.equal(ot.calls.length, 1);
  assert.equal(paused(ot), 'key_read_failed');
  ot.store.close();
});

test('reconcile drops a figure when the file names another kind by the end of the read (control: the same kind stores it)', async () => {
  for (const changed of [true, false]) {
    const h = setup('named');
    const later = changed ? EFF.anthropic() : h.eff;
    const l = createLedger({ store: h.store, getEffective: scripted([h.eff], later), fetch: h.fetch, getKey: h.getKey, now: () => h.clock.t, runtime: 'own' });
    h.key.usage = 10;
    const out = await l.reconcile(h.clock.t);
    assert.equal(h.calls.length, 1, 'the read itself ran on OpenRouter');
    assert.equal(out.ok, !changed);
    assert.equal(h.store.q('SELECT COUNT(*) AS n FROM key_snapshots').get().n, changed ? 0 : 1);
    assert.equal(h.store.getMeta('key_baseline') === null, changed);
    h.store.close();
  }
});

test('on the own runtime an unreadable file names no provider; on the OpenClaw path it is still the implicit entry', () => {
  for (const runtime of ['own', 'openclaw']) {
    const h = setup('anthropic');
    const l = createLedger({ store: h.store, getEffective: () => null, fetch: h.fetch, getKey: h.getKey, now: () => h.clock.t, runtime });
    const s = l.snapshot();
    if (runtime === 'own') assert.deepEqual([s.provider, s.keyReadable], [null, false]);
    else assert.deepEqual([s.provider, s.keyReadable], ['openrouter', true], 'control: the OpenClaw path keeps its implicit entry');
    // A bare 402 then pauses nothing under OpenRouter's name on the own runtime; it still counts in the streak.
    l.noteProviderError({ httpStatus: 402 });
    assert.equal(paused(h), runtime === 'own' ? null : 'openrouter_credits');
    assert.equal(streak(h.store), runtime === 'own' ? 1 : 0);
    h.store.close();
  }
  // Positive control: with the Anthropic file read, the same 402 pauses under Anthropic's name.
  const a = setup('anthropic');
  a.ledger.noteProviderError({ httpStatus: 402 });
  assert.equal(paused(a), 'anthropic_credits');
  a.store.close();
});
