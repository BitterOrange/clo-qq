// A reply with no usage and no charge on the Key clears by itself on the own runtime, with no console command, on the
// bot's real one-minute ledger tick. Delay and read count are shortened for the test; unit/ledger-reconcile covers the
// defaults. On a provider whose Key cannot be read (CLO_TEST_PROVIDER=anthropic) nothing can clear such a row: it
// stays counted at its hold until the owner runs accept-unsettled (decision D4), and no Key is ever read.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fullAt, nextId, push } from '../fixtures/qq-events.mjs';
import { assertEveryPostLegal, GROUP_A, netAttempts, PROVIDER, sleep, startOwnStack, until } from '../harness/own.mjs';

const OPENROUTER_ONLY = PROVIDER !== 'openrouter' && 'a Key read clears it only where the Key can be read';
const ANTHROPIC_ONLY = PROVIDER !== 'anthropic' && 'runs with CLO_TEST_PROVIDER=anthropic';
// Longer than the bot's one-minute ledger tick, with the start tick inside it.
const PAST_A_TICK_MS = 70000;

let s;

before(async () => {
  s = await startOwnStack({
    provider: PROVIDER,
    label: 'unsettled',
    groups: { [GROUP_A]: {} },
    script: () => ({ text: '没有用量的回答。', usage: null }),
    effective: { budget: { unsettledClearMs: 1000, unsettledClearReads: 1 } },
  });
});

after(async () => {
  await s?.stop();
  s?.cleanup();
});

test('usage missing pauses paid work, then the next clean Key read settles at zero and resumes it', { timeout: 200000, skip: OPENROUTER_ONLY }, async () => {
  const id = nextId();
  push(s, fullAt('没有用量', { id }));
  const row = await s.waitRow(id);
  assert.equal(row.state, 'completed');
  assert.equal(s.reservations(id)[0].status, 'unsettled');
  assert.equal(s.control('paid_paused'), 'usage_missing');

  const blocked = nextId();
  const requests = s.agentRequests().length;
  push(s, fullAt('暂停时', { id: blocked }));
  assert.equal((await s.waitRow(blocked)).reason, 'paid_paused', 'positive control: it did pause');
  assert.equal(s.agentRequests().length, requests, 'no model call while paused');

  await until(() => s.control('paid_paused') === null, 'the pause to clear with no console command', 150000, 500);
  const [hold] = s.reservations(id);
  assert.equal(hold.status, 'settled');
  assert.equal(hold.actual_micros, 0);
  assert.equal(hold.source, 'key_delta_none');
  assert.ok(s.model.other.some((r) => r.url.endsWith('/key')), 'the clear came from a Key read the bot made');

  s.model.setScript(() => ({ text: '恢复了。', usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } }));
  const next = nextId();
  push(s, fullAt('再问一句', { id: next }));
  assert.equal((await s.waitRow(next)).state, 'completed');
  assert.equal(s.postBodies().at(-1).content, '恢复了。');
});

test('anthropic: usage missing pauses paid work and stays counted at its hold past a tick, until accept-unsettled', { timeout: 200000, skip: ANTHROPIC_ONLY }, async () => {
  const id = nextId();
  push(s, fullAt('没有用量', { id }));
  const row = await s.waitRow(id);
  assert.equal(row.state, 'completed');
  assert.equal(s.control('paid_paused'), 'usage_missing');
  const [held] = s.reservations(id);
  assert.equal(held.status, 'unsettled');

  const blocked = nextId();
  const requests = s.agentRequests().length;
  push(s, fullAt('暂停时', { id: blocked }));
  assert.equal((await s.waitRow(blocked)).reason, 'paid_paused', 'positive control: it did pause');
  assert.equal(s.agentRequests().length, requests, 'no model call while paused');

  // The settings that clear it within a tick on OpenRouter are the same here. Nothing reads a Key, so nothing clears.
  await sleep(PAST_A_TICK_MS);
  assert.equal(s.control('paid_paused'), 'usage_missing', 'no clear without the owner');
  assert.equal(s.reservations(id)[0].status, 'unsettled', 'still counted at its hold');
  assert.deepEqual(s.model.other, [], 'no Key read, and nothing else off the messages route');

  const settled = await s.withLedger((ledger) => ledger.acceptUnsettled('test-owner'));
  assert.equal(settled, 1);
  const [hold] = s.reservations(id);
  assert.equal(hold.status, 'settled');
  assert.equal(hold.source, 'manual');
  assert.equal(hold.actual_micros, held.held_micros, 'booked at the hold, never at zero');
  assert.equal(s.control('paid_paused'), null, 'accepting the rows lifts the pause they caused');

  s.model.setScript(() => ({ text: '恢复了。', usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } }));
  const next = nextId();
  push(s, fullAt('再问一句', { id: next }));
  assert.equal((await s.waitRow(next)).state, 'completed');
  assert.equal(s.postBodies().at(-1).content, '恢复了。');
  const [after_] = s.reservations(next);
  assert.equal(after_.source, 'computed', 'settled from tokens at the locked price');
  assert.equal(after_.actual_micros, 7000);
});

test('last: every POST on this stack is legal, and the bot reached nothing but the mocks', () => {
  assertEveryPostLegal(s, { minPosts: 2 });
  assert.deepEqual(netAttempts(s), []);
});
