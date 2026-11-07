// Settlement on the own runtime: the usage the bot reads from the same response settles the hold, at the provider's
// cost when it reports one, otherwise at the tokens at the locked price. A required turn holds one worst-case call,
// since there is no host to call again.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { replyHoldMicros } from '../../src/clo-plugin/lib/core/ledger.js';
import { COST_ABOVE_COMPUTED_ALERT, settleMicros } from '../../src/clo-plugin/lib/core/providers/cost.js';
import { fullAt, nextId, plain, push } from '../fixtures/qq-events.mjs';
import { decisionText } from '../harness/mock-openrouter.mjs';
import { assertEveryPostLegal, FAKE_MODEL_KEY, GROUP_A, netAttempts, sleep, startOwnStack } from '../harness/own.mjs';

const TOKENS = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 };
// 1000 input at $5/M and 100 output at $20/M.
const TOKENS_MICROS = 5000 + 2000;

let s;

before(async () => {
  s = await startOwnStack({
    label: 'settle',
    groups: { [GROUP_A]: { interject: true, cooldownMinutes: 0 } },
    script: () => ({ text: '结算回答。', usage: TOKENS }),
    decision: () => ({ text: decisionText({ action: 'reply' }), usage: { cost: 0.0002 } }),
    effective: { quietHours: { start: '00:00', end: '00:00', timezone: 'Asia/Shanghai' } },
  });
});

after(async () => {
  await s?.stop();
  s?.cleanup();
});

test('a dispatched turn settles from the response usage at the locked price', async () => {
  const id = nextId();
  push(s, fullAt('结算测试', { id }));
  await s.waitRow(id);
  const [hold] = s.reservations(id);
  assert.equal(hold.status, 'settled');
  assert.equal(hold.tier, 'addressed');
  assert.equal(hold.category, 'reply');
  assert.equal(hold.source, 'computed', 'the mock reports no cost, so the tokens are priced');
  assert.equal(hold.actual_micros, TOKENS_MICROS);
  assert.ok(hold.actual_micros < hold.held_micros, 'the hold is returned down to the real figure');
  assert.equal(s.control('paid_paused'), null);
});

test('a required reply holds exactly one worst-case call, priced at the cache-write rate', async () => {
  const id = nextId();
  push(s, fullAt('预留多少', { id }));
  await s.waitRow(id);
  const [hold] = s.reservations(id);
  const primary = s.eff.models.primary;
  assert.equal(hold.held_micros, replyHoldMicros('reply_required', primary, 'own'));
  assert.ok(hold.held_micros < replyHoldMicros('reply_required', primary, 'openclaw'), 'less than the two calls the host path holds');
});

test('a provider cost above the token price settles at the provider cost, and pauses nothing', async () => {
  s.model.setScript(() => ({ text: '结算回答。', usage: { ...TOKENS, cost: 0.0123 } }));
  const id = nextId();
  push(s, fullAt('按费用结算', { id }));
  await s.waitRow(id);
  const [hold] = s.reservations(id);
  assert.equal(hold.status, 'settled');
  assert.equal(hold.source, 'model.usage');
  assert.equal(hold.actual_micros, 12300);
  // Far above 1.1x the tokens, yet only the figure changes: no price pause, which is Anthropic's.
  assert.equal(s.control('paid_paused'), null);
  assert.equal(s.alerts().some((a) => a.kind === 'price_unexpected'), false);
  s.model.setScript(() => ({ text: '结算回答。', usage: TOKENS }));
});

// The alert settleMicros returns is recorded by the settlement site, and only above the margin: a reported cost within
// 1.10x of the tokens at the lock settles the same way and raises nothing.
test('a provider cost above 1.1x the token price raises cost_above_computed; one within 1.1x does not', async () => {
  const usage = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, costUsd: 0.0123 };
  assert.deepEqual(settleMicros(usage, s.eff.models.primary.price, { kind: 'openrouter', runtime: 'own' }).alerts, [COST_ABOVE_COMPUTED_ALERT]);
  const count = () => s.alerts().filter((a) => a.kind === COST_ABOVE_COMPUTED_ALERT).length;
  try {
    // 0.0075 is 7500 micros, under 1.1 x 7000.
    s.model.setScript(() => ({ text: '结算回答。', usage: { ...TOKENS, cost: 0.0075 } }));
    const before = count();
    const within = nextId();
    push(s, fullAt('费用接近价格', { id: within }));
    await s.waitRow(within);
    const [near] = s.reservations(within);
    assert.deepEqual({ st: near.status, src: near.source, m: near.actual_micros }, { st: 'settled', src: 'model.usage', m: 7500 });
    assert.equal(count(), before, 'within 1.10x: no alert');
    s.model.setScript(() => ({ text: '结算回答。', usage: { ...TOKENS, cost: 0.0123 } }));
    const id = nextId();
    push(s, fullAt('费用高于价格', { id }));
    await s.waitRow(id);
    const [hold] = s.reservations(id);
    assert.deepEqual({ st: hold.status, src: hold.source, m: hold.actual_micros }, { st: 'settled', src: 'model.usage', m: 12300 });
    assert.equal(count(), before + 1, 'positive control: above 1.10x the alert is recorded');
    assert.equal(s.control('paid_paused'), null, 'and nothing pauses');
  } finally {
    s.model.setScript(() => ({ text: '结算回答。', usage: TOKENS }));
  }
});

test('a provider cost below the token price settles at the provider cost, which is what the Key is charged', async () => {
  // Reported $0.005 against 7000 micros of tokens at the lock. Settling at the tokens would leave 2000 micros the Key
  // never charged, and the ledger would read that surplus as explaining later charges.
  s.model.setScript(() => ({ text: '结算回答。', usage: { ...TOKENS, cost: 0.005 } }));
  const id = nextId();
  push(s, fullAt('按费用结算偏低', { id }));
  await s.waitRow(id);
  const [hold] = s.reservations(id);
  assert.ok(TOKENS_MICROS > 5000, 'the fixture puts the tokens above the reported cost');
  assert.equal(hold.status, 'settled');
  assert.equal(hold.source, 'model.usage');
  assert.equal(hold.actual_micros, 5000);
  assert.equal(s.control('paid_paused'), null);
  s.model.setScript(() => ({ text: '结算回答。', usage: TOKENS }));
});

test('a provider cost equal to the token price settles as the provider cost', async () => {
  s.model.setScript(() => ({ text: '结算回答。', usage: { ...TOKENS, cost: TOKENS_MICROS / 1e6 } }));
  const id = nextId();
  push(s, fullAt('费用相同', { id }));
  await s.waitRow(id);
  const [hold] = s.reservations(id);
  assert.deepEqual({ st: hold.status, src: hold.source, m: hold.actual_micros }, { st: 'settled', src: 'model.usage', m: TOKENS_MICROS });
  s.model.setScript(() => ({ text: '结算回答。', usage: TOKENS }));
});

test('a decision settles from usage.cost; a reply after it settles on its own row under its own tier', async () => {
  const id = nextId();
  push(s, plain('有人知道这个怎么处理吗', { id }));
  await s.waitRow(id);
  const rows = s.reservations(id);
  const decision = rows.find((r) => r.category === 'decision');
  const reply = rows.find((r) => r.category === 'reply');
  assert.equal(decision.status, 'settled');
  assert.equal(decision.source, 'usage.cost');
  assert.equal(decision.actual_micros, 200);
  assert.equal(decision.tier, 'interject');
  assert.equal(reply.status, 'settled');
  assert.equal(reply.tier, 'interject');
  assert.equal(reply.held_micros, replyHoldMicros('reply_optional', s.eff.models.primary, 'own'), 'optional reply holds one call');
});

test('a silent required turn is one call, settled at that call, and never zero', async () => {
  s.model.setScript(() => ({ text: 'NO_REPLY', usage: TOKENS }));
  const requests = s.agentRequests().length;
  const id = nextId();
  push(s, fullAt('沉默结算', { id }));
  await s.waitRow(id);
  const [hold] = s.reservations(id);
  assert.equal(s.agentRequests().length - requests, 1, 'no second call to count');
  assert.equal(hold.status, 'settled');
  assert.equal(hold.actual_micros, TOKENS_MICROS);
  s.model.setScript(() => ({ text: '结算回答。', usage: TOKENS }));
});

test('no usage in the response: unsettled, paid_paused=usage_missing, then a clean settle clears it', async () => {
  s.model.setScript(() => ({ text: '没有用量的回答。', usage: null }));
  const id = nextId();
  push(s, fullAt('没有用量', { id }));
  const row = await s.waitRow(id);
  assert.equal(row.state, 'completed', 'the reply itself still went out');
  const [hold] = s.reservations(id);
  assert.equal(hold.status, 'unsettled');
  assert.equal(s.control('paid_paused'), 'usage_missing');

  const blocked = nextId();
  const requests = s.agentRequests().length;
  push(s, fullAt('下一句', { id: blocked }));
  assert.equal((await s.waitRow(blocked)).reason, 'paid_paused');
  assert.equal(s.agentRequests().length, requests, 'closed until it is settled');
  await s.acceptUnsettled();
  s.model.setScript(() => ({ text: '结算回答。', usage: TOKENS }));
});

test('an owner /reset holds nothing and calls no model', async () => {
  const owner = s.cfg.qq.owner.groupMember[GROUP_A][0];
  const rowsBefore = s.allReservations().length;
  const requests = s.model.requests.length;
  const id = nextId();
  push(s, fullAt('/reset', { id, member: owner }));
  await s.waitRow(id);
  await sleep(500);
  assert.equal(s.allReservations().length - rowsBefore, 0, 'no row at all');
  assert.equal(s.model.requests.length, requests, 'no model request of any kind');
});

test('a restarted bot counts nothing twice: earlier rows stay as they were, a new turn settles once', async () => {
  const snapshot = s.allReservations().map((r) => [r.id, r.status, r.actual_micros]);
  await s.restart();
  const id = nextId();
  push(s, fullAt('重启之后', { id }));
  await s.waitRow(id);
  await sleep(2500);
  const rows = s.reservations(id);
  assert.equal(rows.length, 1, 'one row, no adjustment row');
  assert.equal(rows[0].status, 'settled');
  assert.equal(rows[0].actual_micros, TOKENS_MICROS);
  const now = new Map(s.allReservations().map((r) => [r.id, [r.id, r.status, r.actual_micros]]));
  assert.deepEqual(snapshot.map(([rid]) => now.get(rid)), snapshot, 'no earlier row was touched by the new process');
});

test('the bot records which Key it started with, as a salted hash only', () => {
  assert.equal(s.control('gateway_key'), s.key(FAKE_MODEL_KEY));
  assert.notEqual(s.control('gateway_key'), FAKE_MODEL_KEY);
});

test('last: every POST on this stack is legal, and the bot reached nothing but the mocks', () => {
  assertEveryPostLegal(s, { minPosts: 5 });
  assert.deepEqual(netAttempts(s), []);
});
