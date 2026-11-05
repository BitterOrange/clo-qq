// /stop on the real host, which refuses any turn no newer than the stop and still reports a clean run. What has not
// started by then must not reach it: a refused @ would post the failure line, a refused interjection would pause paid work.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { fullAt, nextId, plain, push } from '../fixtures/qq-events.mjs';
import { decisionText } from '../harness/mock-openrouter.mjs';
import { GROUP_A, MEMBER, MEMBER2, OWNER, sleep, startStack, until } from '../harness/gateway.mjs';

const REPLY = '普通回答。';
const FAILED = JSON.parse(readFileSync(new URL('../../persona/policy-lines.zh.json', import.meta.url), 'utf8')).modelFailed;
let s;

before(async () => {
  s = await startStack({
    label: 'stop-host',
    groups: { [GROUP_A]: { owners: [OWNER], interject: true, cooldownMinutes: 8, perHour: 6, perDay: 8 } },
    script: () => ({ text: REPLY }),
    decision: () => ({ text: decisionText({ action: 'reply' }) }),
    // Long enough that the stop lands while the window is still open.
    effective: { quietHours: { start: '00:00', end: '00:00', timezone: 'Asia/Shanghai' }, window: { windowMs: 3000 } },
  });
  await s.waitConnected();
  const warm = nextId();
  push(s, fullAt('先聊一句', { id: warm, member: OWNER }));
  assert.equal((await s.waitRow(warm, 150000)).state, 'completed', 'positive control: the host answers, and the session exists');
});

after(async () => {
  await s?.stop();
  s?.cleanup();
});

const end = (row) => `${row.state}:${row.reason}`;

test('an @ queued behind /stop gets no failure line, no hold and no alert', async () => {
  s.model.setScript(() => ({ text: '慢回答。', delayMs: 15000 }));
  const [slow, queued, stop] = [nextId(), nextId(), nextId()];
  const posts = s.postBodies().length;
  const requests = s.model.agentRequests().length;
  push(s, fullAt('慢一点', { id: slow, member: MEMBER }));
  await until(() => s.model.agentRequests().length > requests, 'the slow call started', 90000);
  push(s, fullAt('排队的问题', { id: queued, member: MEMBER2 }));
  await until(() => s.row(queued)?.state === 'queued', 'the second @ is in the lane', 30000);
  await sleep(1100);
  push(s, fullAt('/stop', { id: stop, member: OWNER }));
  assert.equal(end(await s.waitRow(stop, 60000)), 'completed:cmd_owner');
  assert.equal(end(await s.waitRow(slow, 60000)), 'failed:aborted');
  assert.equal(end(await s.waitRow(queued, 60000)), 'skipped:owner_stop');
  await sleep(1000);
  assert.deepEqual(s.postBodies().slice(posts).map((p) => p.msg_id), [stop], 'only the ack');
  assert.equal(s.reservations(queued).length, 0);
  assert.equal(s.alerts().some((a) => a.kind === 'model_failed'), false);
  assert.equal(s.model.agentRequests().length, requests + 1);
  s.model.setScript(() => ({ text: REPLY }));
  await s.acceptUnsettled();
});

test('a running turn for a person in danger, aborted by /stop: the failure line goes out once and the operator hears', async () => {
  await sleep(1100);
  s.model.setScript(() => ({ text: '慢回答。', delayMs: 15000 }));
  const [danger, stop] = [nextId(), nextId()];
  const posts = s.postBodies().length;
  const alerts = s.alerts().filter((a) => a.kind === 'crisis_refused').length;
  const requests = s.model.agentRequests().length;
  push(s, fullAt('我真的不想活了', { id: danger, member: MEMBER }));
  await until(() => s.model.agentRequests().length > requests, 'the slow call started', 90000);
  await sleep(1100);
  push(s, fullAt('/stop', { id: stop, member: OWNER }));
  assert.equal(end(await s.waitRow(stop, 60000)), 'completed:cmd_owner');
  assert.equal(end(await s.waitRow(danger, 60000)), 'failed:aborted');
  await until(() => s.postBodies().slice(posts).some((p) => p.msg_id === danger), 'the failure line', 30000);
  await sleep(1000);
  const sent = s.postBodies().slice(posts);
  assert.deepEqual(sent.filter((p) => p.msg_id === danger).map((p) => p.content), [FAILED]);
  assert.equal(sent.filter((p) => p.msg_id === stop).length, 1, 'the ack');
  assert.equal(s.alerts().filter((a) => a.kind === 'crisis_refused').length, alerts + 1);
  assert.equal(s.control('paid_paused'), null, 'nothing went out of the reply, so one /stop pauses nothing');
  s.model.setScript(() => ({ text: REPLY }));
  await s.acceptUnsettled();
});

test('an ordinary message older than /stop buys nothing, spends no interjection and pauses nothing', async () => {
  const [msg, stop] = [nextId(), nextId()];
  const posts = s.postBodies().length;
  const decisions = s.model.decisionRequests().length;
  push(s, plain('有人知道退货要怎么办吗', { id: msg, member: MEMBER2 }));
  await sleep(1100);
  push(s, fullAt('/stop', { id: stop, member: OWNER }));
  assert.equal(end(await s.waitRow(stop, 60000)), 'completed:cmd_owner');
  assert.equal(end(await s.waitRow(msg, 60000)), 'skipped:owner_stop');
  await sleep(500);
  assert.equal(s.model.decisionRequests().length, decisions);
  assert.deepEqual(s.postBodies().slice(posts).map((p) => p.msg_id), [stop], 'only the ack');
  assert.equal(s.reservations(msg).length, 0);
  assert.equal(s.claims().length, 0);
  assert.equal(s.control('paid_paused'), null);
});

test('an @ said after /stop is answered, and clears the cutoff', async () => {
  await sleep(1100);
  const id = nextId();
  const posts = s.postBodies().length;
  push(s, fullAt('停下之后的问题', { id, member: MEMBER }));
  assert.equal(end(await s.waitRow(id, 90000)), 'completed:sent');
  assert.deepEqual(s.postBodies().slice(posts).map((p) => p.content), [REPLY]);
});
