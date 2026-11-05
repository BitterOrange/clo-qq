// A reply with no usage and no charge on the Key clears by itself, with no console command, on the real host
// and its real one-minute ledger tick. Delay and read count are shortened for the test; unit/ledger-reconcile
// covers the defaults.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fullAt, nextId, push } from '../fixtures/qq-events.mjs';
import { assertEveryPostLegal, GROUP_A, startStack, until } from '../harness/gateway.mjs';

let s;

before(async () => {
  s = await startStack({
    label: 'unsettled',
    groups: { [GROUP_A]: {} },
    script: () => ({ text: '没有用量的回答。', usage: null }),
    effective: { budget: { unsettledClearMs: 1000, unsettledClearReads: 1 } },
  });
  await s.waitConnected();
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
  push(s, fullAt('暂停时', { id: blocked }));
  assert.equal((await s.waitRow(blocked)).reason, 'paid_paused', 'positive control: it did pause');

  await until(() => s.control('paid_paused') === null, 'the pause to clear with no console command', 150000, 500);
  const [hold] = s.reservations(id);
  assert.equal(hold.status, 'settled');
  assert.equal(hold.actual_micros, 0);
  assert.equal(hold.source, 'key_delta_none');

  s.model.setScript(() => ({ text: '恢复了。', usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } }));
  const next = nextId();
  push(s, fullAt('再问一句', { id: next }));
  assert.equal((await s.waitRow(next)).state, 'completed');
  assert.equal(s.postBodies().at(-1).content, '恢复了。');
});

test('last: every POST on this stack is legal', () => {
  assertEveryPostLegal(s, { minPosts: 2 });
});
