// The own runtime on the Anthropic kind, end to end: the real bot process, mock QQ and the Anthropic mock. It runs on
// Anthropic whatever CLO_TEST_PROVIDER says, with an OpenRouter stack beside it as the control for what only
// OpenRouter does (a Key read, a Key in the child env under its own name, a provider_fail the owner cannot clear).
// Covered: a reply settled from tokens at the locked price, the price flags, a refusal, the 403 permission pause, the
// 429/529 streak and its owner clear, the spend-limit and credit shapes (unverified: the paid probe confirms them),
// the start check (no ack, another Key, a weaker ack, and provider_rules), and no reconciliation at all.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { CHILD_KEY, hardCapPauseKey, HARD_CAP_PAUSE, PRICE_ALERT, PRICE_PAUSE, providerRulesRecorded } from '../../src/clo-plugin/lib/core/providers/registry.js';
import { fullAt, nextId, push } from '../fixtures/qq-events.mjs';
import { REQUEST_ID_MARKER, STOP_DETAILS_MARKER, THINKING_MARKER } from '../harness/mock-anthropic.mjs';
import { MODEL_IDS } from '../harness/model-view.mjs';
import { assertEveryPostLegal, D2_ACK, FAKE_ANTHROPIC_KEY, FAKE_MODEL_KEY, netAttempts, startOwnStack, until } from '../harness/own.mjs';
import { clo } from '../unit/_cli-helper.mjs';

const LINES = JSON.parse(readFileSync(new URL('../../persona/policy-lines.zh.json', import.meta.url), 'utf8'));
const STEPLEAK = 'ANTHROPICSTEPLEAK5521';
const MARKERS = [REQUEST_ID_MARKER, STOP_DETAILS_MARKER, THINKING_MARKER, STEPLEAK];
const OTHER_ANTHROPIC_KEY = 'sk-ant-FAKE-OTHER-KEY-FOR-LOCAL-MOCK-ONLY';
// Paid work refused under any pause name the gate may give a hold refused for a pause; never a budget refusal.
const PAUSED_REASONS = ['paid_paused', HARD_CAP_PAUSE];
// Many holds are accepted at full price in this file.
const ROOMY = { budget: { addressedUsd: 100, dailyUsd: 100 } };

// Whether the rule rows recording the user's consent to live on Anthropic have landed (the registry's
// LIVE_RULES_RECORDED). Until they do, live is refused at start under provider_rules; once they do, nothing pauses.
const RULES_RECORDED = providerRulesRecorded('anthropic');

// The database as the running bot leaves it: the main file and its write-ahead log, where recent writes still sit.
const dbBytes = (s) => [s.paths.db, `${s.paths.db}-wal`].filter((f) => existsSync(f)).map((f) => readFileSync(f).toString('latin1')).join('\n');

const turnCalls = (s, row) => s.event('turn_model').filter((e) => e.eventKey === row.event_key).map((e) => `${e.kind}:${e.reason}`);

// The owner's order on a provider whose Key cannot be read: accept the unknown rows first, then clear the pause.
async function ownerClears(s) {
  await s.withLedger((ledger) => ledger.acceptUnsettled('test-owner'));
  return s.withLedger((ledger) => ledger.clearOwnerPause());
}

async function ask(s, text) {
  const id = nextId();
  push(s, fullAt(text, { id }));
  return s.waitRow(id);
}

// Everything a member or the machine could read afterwards: what went to QQ, the event log and the bot's own output.
const visible = (s) => [JSON.stringify(s.postBodies()), readFileSync(s.paths.eventLog, 'utf8'), s.logs()].join('\n');

describe('Anthropic active, attested and bound to the Key the bot holds', () => {
  let s;
  let o;
  before(async () => {
    s = await startOwnStack({ label: 'anth', provider: 'anthropic', effective: ROOMY, script: () => ({ text: '正常回答。' }) });
    o = await startOwnStack({ label: 'anth-or', provider: 'openrouter', script: () => ({ text: '对照回答。' }) });
  });
  after(async () => {
    await s?.stop();
    s?.cleanup();
    await o?.stop();
    o?.cleanup();
  });

  test('the start check paused paid work under provider_rules until the rule rows land, and only that; the bot holds the Anthropic Key alone', () => {
    const startAlert = s.alerts().some((a) => a.kind === 'paid_paused' && JSON.parse(a.detail).reason === HARD_CAP_PAUSE);
    if (RULES_RECORDED) {
      assert.deepEqual(s.startPauses, [], 'the rule rows are recorded, so live starts with no pause');
      assert.equal(startAlert, false, 'and raises no start alert');
    } else {
      assert.deepEqual(s.startPauses, ['provider_rules'], 'the rule rows are not recorded yet, so live is refused at start');
      assert.ok(startAlert, 'the start pause raised its alert');
    }
    assert.equal(s.control(hardCapPauseKey('anthropic')), null, 'lifted by the harness as an ack would');
    assert.equal(s.env[CHILD_KEY.anthropic], FAKE_ANTHROPIC_KEY);
    assert.equal(s.env[CHILD_KEY.openrouter], undefined, 'the inactive Key never reaches the bot');
    assert.ok(!Object.values(s.env).includes(FAKE_MODEL_KEY));
    // Control: on OpenRouter the Key goes under its own name, and nothing pauses at start.
    assert.equal(o.env[CHILD_KEY.openrouter], FAKE_MODEL_KEY);
    assert.equal(o.env[CHILD_KEY.anthropic], undefined);
    assert.deepEqual(o.startPauses, []);
  });

  test('an @ is answered and settled from tokens at the locked price, cache tokens included', async () => {
    s.model.setScript(() => ({
      text: '可洛的回答。',
      thinking: '想一想',
      usage: { prompt_tokens: 1000, completion_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 400, cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 0 } },
    }));
    const row = await ask(s, '今天怎么样');
    assert.equal(`${row.state}:${row.reason}`, 'completed:sent');
    assert.equal(s.postBodies().at(-1).content, '可洛的回答。', 'the thinking block stays behind');
    const req = s.model.agentRequests().at(-1);
    assert.equal(s.view(req).model, MODEL_IDS.anthropic.primary);
    assert.ok(s.keySent(req, FAKE_ANTHROPIC_KEY));
    assert.equal(req.headers.authorization, undefined);
    assert.deepEqual(s.model.rejected(), [], 'the mock refused nothing the bot sent');
    const settled = s.allReservations().filter((r) => r.event_key === row.event_key);
    assert.equal(settled.length, 1);
    assert.equal(settled[0].status, 'settled');
    assert.equal(settled[0].source, 'computed', 'Anthropic reports no cost');
    // 1000 x $5 + 100 x $20 + 2000 x $0.5 + 400 x $6.25, per million.
    assert.equal(settled[0].actual_micros, 10500);
    assert.equal(s.control('paid_paused'), null);
    assert.ok(!s.alerts().some((a) => a.kind === PRICE_ALERT), 'standard geo and speed raise nothing');
  });

  test('a US-only answer settles at 1.1x, alerts and pauses; the owner clears it', async () => {
    s.model.setScript(() => ({ text: '美国区的回答。', geoUs: true, usage: { prompt_tokens: 1000, completion_tokens: 100 } }));
    const row = await ask(s, '换个区');
    assert.equal(row.state, 'completed');
    const [hold] = s.allReservations().filter((r) => r.event_key === row.event_key);
    assert.equal(hold.source, 'computed');
    assert.equal(hold.actual_micros, 7700, 'settled at its computed figure, 7000 x 1.1');
    const alert = s.alerts().find((a) => a.kind === PRICE_ALERT);
    assert.ok(alert, 'the price flag raised an alert');
    // Alert details keep only log keys, so the gate sends the flags as one string under reason.
    assert.deepEqual(JSON.parse(alert.detail).reason.split(' '), ['geo_us']);
    assert.equal(s.control('paid_paused'), PRICE_PAUSE);
    assert.equal((await ownerClears(s)).cleared, true);
    assert.equal(s.control('paid_paused'), null);
  });

  test('stop_reason refusal: the failure line once, the provider text nowhere, and one refusal stops no one', async () => {
    s.model.setScript(() => ({ refusal: `no ${STEPLEAK}`, usage: { prompt_tokens: 5, completion_tokens: 0 } }));
    const posts = s.messagePosts().length;
    const row = await ask(s, '一个会被拒的问题');
    assert.equal(row.state, 'failed');
    assert.deepEqual(turnCalls(s, row), ['refusal:refusal']);
    const [hold] = s.allReservations().filter((r) => r.event_key === row.event_key);
    assert.equal(hold.status, 'settled', 'a refusal carries usage, so its cost is known');
    assert.equal(hold.source, 'computed');
    // 5 input and 0 output tokens at $5 per million.
    assert.equal(hold.actual_micros, 25);
    assert.deepEqual(s.postBodies().slice(posts).map((p) => p.content), [LINES.modelFailed]);
    assert.equal(s.control('paid_paused'), null);
    for (const m of MARKERS) assert.ok(!visible(s).includes(m), `${m} left the adapter`);
  });

  test('403 permission_error pauses anthropic_permission, never as a refusal; accept-unsettled alone keeps it, the owner clear lifts it', async () => {
    s.model.setScript(() => ({ permission403: STEPLEAK }));
    const row = await ask(s, '地区不对');
    assert.deepEqual(turnCalls(s, row), ['error:http'], 'an error, not a refusal');
    await until(() => s.control('paid_paused') === 'anthropic_permission', 'the permission pause', 15000);
    const before_ = s.model.agentRequests().length;
    const blocked = await ask(s, '暂停时');
    assert.ok(PAUSED_REASONS.includes(blocked.reason), blocked.reason);
    assert.equal(s.model.agentRequests().length, before_, 'no model call while paused');
    await s.withLedger((ledger) => ledger.acceptUnsettled('test-owner'));
    assert.equal(s.control('paid_paused'), 'anthropic_permission', 'accepting the rows does not lift a provider pause');
    assert.equal((await s.withLedger((ledger) => ledger.clearOwnerPause())).cleared, true);
    s.model.setScript(() => ({ text: '恢复了。' }));
    assert.equal(`${(await ask(s, '再问')).state}`, 'completed', 'positive control: paid work resumes');
  });

  test('429 and 529 count in the provider_fail streak; the owner clears it on this kind, one short of the limit', async () => {
    await ownerClears(s);
    const steps = [{ rateLimit429: STEPLEAK }, { overloaded529: STEPLEAK }, { rateLimit429: STEPLEAK }];
    for (const [i, step] of steps.entries()) {
      s.model.setScript(() => step);
      const row = await ask(s, `失败 ${i}`);
      assert.equal(row.state, 'failed');
      if (i < steps.length - 1) assert.equal(s.control('paid_paused'), null, `not yet after ${i + 1}`);
    }
    await until(() => s.control('paid_paused') === 'provider_fail', 'the streak to pause paid work', 15000);
    assert.equal((await ownerClears(s)).cleared, true, 'D5: the owner clears provider_fail where no Key read can');
    s.model.setScript(() => ({ overloaded529: STEPLEAK }));
    await ask(s, '又失败');
    await until(() => s.control('paid_paused') === 'provider_fail', 'one more failure to pause again at once', 15000);
    assert.equal((await ownerClears(s)).cleared, true);
    s.model.setScript(() => ({ text: '好了。' }));
    assert.equal((await ask(s, '好了吗')).state, 'completed');
  });

  test('spend-limit and credit shapes pause under their own names (shapes unverified until the paid probe)', async () => {
    const cases = [['spendLimit400', 'anthropic_spend_limit'], ['enforced429', 'anthropic_spend_limit'], ['credits402', 'anthropic_credits'], ['credits400', 'anthropic_credits']];
    for (const [step, reason] of cases) {
      await ownerClears(s);
      assert.equal(s.control('paid_paused'), null, `${step}: starts clear`);
      s.model.setScript(() => ({ [step]: STEPLEAK }));
      await ask(s, `限额 ${step}`);
      await until(() => s.control('paid_paused') === reason, `${step} to pause ${reason}`, 15000);
    }
    assert.equal((await ownerClears(s)).cleared, true);
    s.model.setScript(() => ({ text: '额度回来了。' }));
    assert.equal((await ask(s, '还在吗')).state, 'completed', 'positive control: cleared, paid work resumes');
  });

  test('no reconciliation: nothing reads a Key, the ledger says so, and status shows it; OpenRouter reads its Key', async () => {
    assert.deepEqual(s.model.other, [], 'no /key and nothing else off the messages route');
    const snap = await s.withLedger((ledger) => ledger.snapshot());
    assert.equal(snap.provider, 'anthropic');
    assert.equal(snap.keyReadable, false);
    await until(() => o.model.other.some((r) => r.url.endsWith('/key')), 'control: the OpenRouter bot to read its Key', 90000, 250);
    assert.equal((await o.withLedger((ledger) => ledger.snapshot())).keyReadable, true);
    const status = await clo(s.tmp, ['status'], { fetch: globalThis.fetch });
    assert.match(status.out, /对账：不可用/);
    const control = await clo(o.tmp, ['status'], { fetch: globalThis.fetch });
    assert.doesNotMatch(control.out, /对账：不可用/, 'control: OpenRouter reconciles');
    assert.deepEqual(s.model.other, [], 'status read no Key either');
  });

  test('on OpenRouter the owner cannot clear provider_fail: a clean Key read does (control for D5)', async () => {
    await o.writeStore((store) => store.setControl('paid_paused', 'provider_fail', 'test'));
    const r = await o.withLedger((ledger) => ledger.clearOwnerPause());
    assert.equal(r.cleared, false);
    await o.writeStore((store) => store.delControl('paid_paused'));
  });

  test('last: the sk-ant- fake and the provider markers never reached QQ, a log or the database', async () => {
    assert.ok(s.model.requests.some((r) => r.headers['x-api-key'] === FAKE_ANTHROPIC_KEY), 'positive control: the Key was sent, in its header');
    assert.ok(s.env[CHILD_KEY.anthropic] === FAKE_ANTHROPIC_KEY, 'positive control: the child env held it');
    const text = visible(s);
    assert.ok(text.includes('正常回答') || text.includes('可洛的回答'), 'positive control: the scan reads what was posted');
    for (const needle of ['sk-ant-', FAKE_ANTHROPIC_KEY, FAKE_MODEL_KEY, ...MARKERS]) assert.ok(!text.includes(needle), `${needle} is visible`);
    // The bot is still running, so recent writes sit in the write-ahead log: the scan reads it with the main file.
    // Positive control: a canary the console writes now, before any checkpoint, is found by the same scan.
    await s.writeStore((store) => store.addAlert('test_canary', { reason: 'WALSCANCANARY4417' }));
    const db = dbBytes(s);
    assert.ok(db.includes('WALSCANCANARY4417'), 'positive control: the scan reads what was just written');
    for (const needle of ['sk-ant-', ...MARKERS]) assert.ok(!db.includes(needle), `${needle} in the database`);
    assertEveryPostLegal(s, { minPosts: 5 });
    assert.deepEqual(netAttempts(s), []);
    assert.deepEqual(netAttempts(o), []);
  });
});

// Each stack below is live on Anthropic with something wrong at start. Nothing lifts the pause, so nothing is spent.
for (const [label, opts, why] of [
  ['no hard-cap ack', { hardCapAck: null }, 'live is refused without the D2 attestation'],
  ['the attestation bound to another Key', { hardCapKey: OTHER_ANTHROPIC_KEY }, 'a Key swapped into .env is not the attested one'],
  ['a weaker ack (auto-reload not ruled out)', { hardCapAck: { ...D2_ACK, prepaidNoReload: false } }, 'only the D2 pair is an ack'],
  ['no binding at all', { hardCapKey: null }, 'an ack with no Key fingerprint vouches for nothing'],
]) {
  describe(`start check: ${label}`, () => {
    let s;
    before(async () => {
      s = await startOwnStack({ label: 'anth-cap', provider: 'anthropic', liftStartPause: false, ...opts, script: () => ({ text: '不该发出。' }) });
    });
    after(async () => {
      await s?.stop();
      s?.cleanup();
    });

    test(`${why}: paid work pauses under hard_cap at start, and an @ reaches no model`, async () => {
      const code = await until(() => s.control(hardCapPauseKey('anthropic')), 'the start check to pause', 15000, 25);
      assert.equal(code, 'hard_cap', 'the hard cap fails before the rules are even looked at');
      const row = await ask(s, '能回答吗');
      assert.ok(PAUSED_REASONS.includes(row.reason), `${row.state}:${row.reason}`);
      assert.equal(s.model.requests.length, 0, 'no model call');
      assert.deepEqual(s.model.other, []);
      assert.equal(s.control(hardCapPauseKey('anthropic')), 'hard_cap', 'nothing but an ack lifts it');
    });
  });
}
