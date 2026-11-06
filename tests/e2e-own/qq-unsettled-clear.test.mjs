// A reply with no usage and no charge on the Key clears by itself on the own runtime, with no console command, on the
// bot's real one-minute ledger tick. Delay and read count are shortened for the test; unit/ledger-reconcile covers the
// defaults.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fullAt, nextId, push } from '../fixtures/qq-events.mjs';
import { assertEveryPostLegal, GROUP_A, netAttempts, startOwnStack, until } from '../harness/own.mjs';

let s;

before(async () => {
  s = await startOwnStack({
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

test('usage missing pauses paid work, then the next clean Key read settles at zero and resumes it', { timeout: 200000 }, async () => {
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

test('last: every POST on this stack is legal, and the bot reached nothing but the mocks', () => {
  assertEveryPostLegal(s, { minPosts: 2 });
  assert.deepEqual(netAttempts(s), []);
});
