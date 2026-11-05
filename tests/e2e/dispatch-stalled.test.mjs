// A model call that outlasts the passive window, on the real Gateway. The turn's deadline comes from the message
// timestamp, so an old timestamp stands in for minutes of waiting. Nothing here is real QQ or a real model.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fullAt, nextId, push } from '../fixtures/qq-events.mjs';
import { MEMBER, MEMBER2, startStack, unexpectedNetAttempts, until } from '../harness/gateway.mjs';

const PASSIVE_WINDOW_MS = 285000;
const TIME_LEFT_MS = 30000;
const STALL_MS = 120000;
const REPLY = '正常回答。';

let s;

before(async () => {
  s = await startStack({
    label: 'stalled',
    script: () => ({ text: REPLY }),
    effective: { window: { staleMs: PASSIVE_WINDOW_MS + 60000 } },
  });
  await s.waitConnected();
  const warm = nextId();
  const pushedAt = Date.now();
  push(s, fullAt('先聊一句', { id: warm }));
  const row = await s.waitRow(warm, 150000);
  assert.equal(row.state, 'completed', 'positive control: the host answers, and the session exists');
  // Telling an overstayed run from the next turn's run rests on the host giving each usage event the run's age.
  const seen = s.event('turn_usage').find((e) => e.eventKey === row.event_key);
  assert.ok(seen.durationMs > 0 && seen.t - seen.durationMs >= pushedAt, 'the usage event carries the age of a run that began after the message');
});

after(async () => {
  await s?.stop();
  s?.cleanup();
});

test('a stalled turn is really aborted at its deadline: the run ends, nothing pauses, no streak, and the next @ gets its answer', async () => {
  const stalled = nextId();
  const requests = s.model.agentRequests().length;
  const posts = s.postBodies().length;
  s.model.setScript(() => ({ text: '这句来得太晚。', delayMs: STALL_MS }));
  const sentAt = Date.now();
  push(s, fullAt('慢一点', { id: stalled, member: MEMBER, timestamp: new Date(sentAt - PASSIVE_WINDOW_MS + TIME_LEFT_MS).toISOString() }));
  await until(() => s.model.agentRequests().length > requests, 'the slow call started', 60000);

  const row = await s.waitRow(stalled, TIME_LEFT_MS + 40000);
  assert.equal(`${row.state}:${row.reason}`, 'failed:aborted');
  assert.ok(Date.now() - sentAt < STALL_MS, 'ended well before the model would have answered');

  const watchdog = s.event('turn_watchdog').filter((e) => e.eventKey === row.event_key);
  assert.equal(watchdog.length, 1);
  assert.equal(watchdog[0].state, 'ended', 'the host carried the abort through to the end of the run');

  assert.equal(s.control('paid_paused'), null, 'a stall is not a reason to pause paid work');
  assert.equal(s.counter('provider_fail_streak'), 0, 'our own abort is not a provider failure');
  assert.deepEqual(s.postBodies().slice(posts), [], 'nothing is sent past the window');
  assert.deepEqual(s.reservations(stalled).map((r) => r.status), ['unsettled'], 'the call may have cost money, so the hold is kept');

  await s.acceptUnsettled();
  s.model.setScript(() => ({ text: REPLY }));
  const next = nextId();
  const sentBefore = s.postBodies().length;
  push(s, fullAt('接着问', { id: next, member: MEMBER2 }));
  const nextRow = await s.waitRow(next, 60000);
  assert.equal(`${nextRow.state}:${nextRow.reason}`, 'completed:sent', 'the session is free again');
  assert.equal(s.event('turn_deferred').length, 0);
  assert.equal(s.postBodies().length, sentBefore + 1);
  assert.equal(s.postBodies().at(-1).msg_id, next);
});

test('the run stays off the network', () => {
  assert.deepEqual(unexpectedNetAttempts(s.gw), []);
});
