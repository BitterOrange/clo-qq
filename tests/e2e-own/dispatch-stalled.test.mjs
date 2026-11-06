// A model call that would outlast the passive window, on the own runtime. The turn's deadline comes from the message
// timestamp, so an old timestamp stands in for minutes of waiting. The runner cuts its own call off in time to leave
// room for delivery, and the gate aborts at the window's end whatever the runner does. Nothing here is real QQ or a
// real model.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { fullAt, nextId, push } from '../fixtures/qq-events.mjs';
import { MEMBER, MEMBER2, netAttempts, startOwnStack, until } from '../harness/own.mjs';

const PASSIVE_WINDOW_MS = 285000;
const STALL_MS = 120000;
const REPLY = '正常回答。';
const FAILED = JSON.parse(readFileSync(new URL('../../persona/policy-lines.zh.json', import.meta.url), 'utf8')).modelFailed;

let s;

before(async () => {
  s = await startOwnStack({
    label: 'stalled',
    script: () => ({ text: REPLY }),
    effective: { window: { staleMs: PASSIVE_WINDOW_MS + 60000 } },
  });
  const warm = nextId();
  push(s, fullAt('先聊一句', { id: warm }));
  assert.equal((await s.waitRow(warm, 60000)).state, 'completed', 'positive control: the bot answers');
});

after(async () => {
  await s?.stop();
  s?.cleanup();
});

const callOf = (row) => s.event('turn_model').filter((e) => e.eventKey === row.event_key);

// The next @ is answered: the group's lane is free again.
async function nextIsAnswered() {
  s.model.setScript(() => ({ text: REPLY }));
  const next = nextId();
  const sentBefore = s.postBodies().length;
  push(s, fullAt('接着问', { id: next, member: MEMBER2 }));
  const row = await s.waitRow(next, 60000);
  assert.equal(`${row.state}:${row.reason}`, 'completed:sent', 'the lane is free again');
  assert.equal(s.postBodies().length, sentBefore + 1);
  assert.equal(s.postBodies().at(-1).msg_id, next);
}

test('a stall with time left: the call is cut off in time, the failure line goes out inside the window, nothing pauses', async () => {
  const timeLeft = 30000;
  const stalled = nextId();
  const requests = s.model.agentRequests().length;
  const posts = s.postBodies().length;
  s.model.setScript(() => ({ text: '这句来得太晚。', delayMs: STALL_MS }));
  const sentAt = Date.now();
  const deadline = sentAt + timeLeft;
  push(s, fullAt('慢一点', { id: stalled, member: MEMBER, timestamp: new Date(sentAt - PASSIVE_WINDOW_MS + timeLeft).toISOString() }));
  await until(() => s.model.agentRequests().length > requests, 'the slow call started', 30000);

  const row = await s.waitRow(stalled, timeLeft + 30000);
  assert.ok(Date.now() < deadline, 'the turn ended inside the passive window');
  assert.equal(row.state, 'failed');
  assert.deepEqual(callOf(row).map((e) => `${e.kind}:${e.reason}`), ['error:timeout'], 'the runner cut its own call off');
  const fresh = s.postBodies().slice(posts);
  assert.deepEqual(fresh.map((p) => [p.msg_id, p.content]), [[stalled, FAILED]], 'only the failure line, passive, and once');

  assert.equal(s.control('paid_paused'), null, 'a stall is not a reason to pause paid work');
  assert.equal(s.counter('provider_fail_streak'), 0, 'a call cut early to keep the window says nothing about the provider');
  assert.deepEqual(s.reservations(stalled).map((r) => r.status), ['unsettled'], 'the call may have cost money, so the hold is kept');
  await s.acceptUnsettled();
  await nextIsAnswered();
});

test('a stall with almost no time left: the call ends at the window end and nothing is sent past it', async (t) => {
  const timeLeft = 8000;
  const stalled = nextId();
  const requests = s.model.agentRequests().length;
  const posts = s.postBodies().length;
  s.model.setScript(() => ({ text: '这句来得太晚。', delayMs: STALL_MS }));
  const sentAt = Date.now();
  push(s, fullAt('慢一点', { id: stalled, member: MEMBER, timestamp: new Date(sentAt - PASSIVE_WINDOW_MS + timeLeft).toISOString() }));
  await until(() => s.model.agentRequests().length > requests, 'the slow call started', 30000);

  const row = await s.waitRow(stalled, timeLeft + 30000);
  assert.ok(Date.now() - sentAt < STALL_MS, 'ended well before the model would have answered');
  assert.equal(row.state, 'failed');
  // The runner's cut and the gate's abort fall on the same moment here; either one ends the call.
  assert.equal(callOf(row).length, 1);
  assert.ok(['error:timeout', 'aborted:aborted'].includes(`${callOf(row)[0].kind}:${callOf(row)[0].reason}`), JSON.stringify(callOf(row)[0]));
  t.diagnostic(`ended as ${row.state}:${row.reason}, call ${callOf(row)[0].kind}:${callOf(row)[0].reason}`);
  assert.deepEqual(s.postBodies().slice(posts), [], 'nothing is sent past the window');
  assert.equal(s.control('paid_paused'), null);
  assert.equal(s.counter('provider_fail_streak'), 0);
  assert.deepEqual(s.reservations(stalled).map((r) => r.status), ['unsettled']);
  await s.acceptUnsettled();
  await nextIsAnswered();
});

test('the run stays off the network', () => {
  assert.deepEqual(netAttempts(s), []);
});
