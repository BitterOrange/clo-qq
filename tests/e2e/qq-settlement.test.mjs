// A5 on the real host: model.usage reaches the ledger through the diagnostic event, and settles the hold.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fullAt, nextId, plain, push } from '../fixtures/qq-events.mjs';
import { decisionText } from '../harness/mock-openrouter.mjs';
import { assertEveryPostLegal, deepMerge, FAKE_MODEL_KEY, GROUP_A, sleep, startStack, unexpectedNetAttempts, until } from '../harness/gateway.mjs';

let s;

before(async () => {
  s = await startStack({
    label: 'settle',
    groups: { [GROUP_A]: { interject: true, cooldownMinutes: 0 } },
    script: () => ({ text: '结算回答。', usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } }),
    decision: () => ({ text: decisionText({ action: 'reply' }), usage: { cost: 0.0002 } }),
    effective: { quietHours: { start: '00:00', end: '00:00', timezone: 'Asia/Shanghai' } },
  });
  await s.waitConnected();
});

after(async () => {
  await s?.stop();
  s?.cleanup();
});

test('a dispatched turn settles from model.usage, from host cost or tokens at the locked price', async () => {
  const id = nextId();
  push(s, fullAt('结算测试', { id }));
  await s.waitRow(id);
  const [hold] = s.reservations(id);
  assert.equal(hold.status, 'settled');
  assert.equal(hold.tier, 'addressed');
  assert.equal(hold.category, 'reply');
  assert.ok(hold.held_micros >= 360000, 'required reply holds two worst-case calls');
  assert.ok(hold.actual_micros > 0);
  assert.ok(hold.actual_micros < hold.held_micros, 'the hold is returned down to the real figure');
  assert.ok(['model.usage', 'computed'].includes(hold.source), hold.source);
  // 1000 input at $5/M and 100 output at $20/M.
  assert.equal(hold.actual_micros, 5000 + 2000);
  assert.equal(s.control('paid_paused'), null);
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
  assert.ok(reply.held_micros < rows.find((r) => r.category === 'decision').held_micros + 200000, 'optional reply holds one call');
});

test('a NO_REPLY required turn counts both calls, and is never zero', async () => {
  s.model.setScript(() => ({ text: 'NO_REPLY', usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } }));
  const id = nextId();
  push(s, fullAt('沉默结算', { id }));
  await s.waitRow(id);
  const [hold] = s.reservations(id);
  assert.equal(hold.status, 'settled');
  assert.ok(hold.actual_micros >= 7000, `settled ${hold.actual_micros}`);
  s.model.setScript(() => ({ text: '结算回答。' }));
});

test('no usage within the drain: unsettled, paid_paused=usage_missing, then a clean settle clears it', async () => {
  s.model.setScript(() => ({ text: '没有用量的回答。', usage: null }));
  const id = nextId();
  push(s, fullAt('没有用量', { id }));
  const row = await s.waitRow(id);
  assert.equal(row.state, 'completed', 'the reply itself still went out');
  const [hold] = s.reservations(id);
  assert.equal(hold.status, 'unsettled');
  assert.equal(s.control('paid_paused'), 'usage_missing');

  const blocked = nextId();
  const requests = s.model.agentRequests().length;
  push(s, fullAt('下一句', { id: blocked }));
  assert.equal((await s.waitRow(blocked)).reason, 'paid_paused');
  assert.equal(s.model.agentRequests().length, requests, 'closed until it is settled');
  await s.acceptUnsettled();
  s.model.setScript(() => ({ text: '结算回答。' }));
});

// The unattributed path itself is driven in unit/qq-hooks: nothing here makes the host bill with no open turn.
test('an owner /reset holds nothing, and anything it did cost would land as a settled row', async () => {
  const owner = s.cfg.qq.owner.groupMember[GROUP_A][0];
  const before_ = s.allReservations().length;
  const id = nextId();
  push(s, fullAt('/reset', { id, member: owner }));
  await s.waitRow(id);
  await sleep(500);
  assert.equal(s.allReservations().length - before_, 0, 'no row at all');
});

test('a plugin generation swap does not count one usage event twice', async () => {
  const opened = s.qq.opened();
  s.gw.writeConfig(deepMerge(s.gw.readConfig(), { plugins: { entries: { clo: { config: { generationTag: 'swap1' } } } } }));
  await until(() => s.qq.opened() > opened && s.qq.connected() === 1, 'reconnect after swap', 60000);
  await until(() => s.control('connected') === 'true', 'connected', 30000);
  await sleep(1000);
  s.model.setScript(() => ({ text: '结算回答。', usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } }));
  const id = nextId();
  push(s, fullAt('换代之后', { id }));
  await s.waitRow(id);
  await sleep(2500);
  const rows = s.reservations(id);
  assert.equal(rows.length, 1, 'one row, no adjustment from a second listener');
  assert.equal(rows[0].status, 'settled');
  assert.equal(rows[0].actual_micros, 7000);
});

test('the Gateway records which Key it started with, as a salted hash only', () => {
  assert.equal(s.control('gateway_key'), s.key(FAKE_MODEL_KEY));
  assert.notEqual(s.control('gateway_key'), FAKE_MODEL_KEY);
});

test('last: every POST on this stack is legal', () => {
  assertEveryPostLegal(s, { minPosts: 3 });
  assert.deepEqual(unexpectedNetAttempts(s.gw), []);
});
