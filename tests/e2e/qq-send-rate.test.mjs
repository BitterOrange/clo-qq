// The real send limits on the real host. Every other e2e stack relaxes them, so this is the only place the
// default 4 per group per minute meets a real reply. It waits on the real clock, about a minute.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fullAt, nextId, push } from '../fixtures/qq-events.mjs';
import { assertEveryPostLegal, GROUP_A, MEMBER, MEMBER2, startStack, unexpectedNetAttempts } from '../harness/gateway.mjs';

const LONG = (n) => '这是一句测试用的句子。'.repeat(n);
let s;

before(async () => {
  s = await startStack({
    label: 'rate',
    groups: { [GROUP_A]: {} },
    script: () => ({ text: LONG(700) }),
    effective: { limits: { sendGroupPerMin: 4, sendAccountPerMin: 12, sendAccountPerHour: 120 } },
  });
  await s.waitConnected();
});

after(async () => {
  await s?.stop();
  s?.cleanup();
});

test('a very long answer goes out in as many parts as one minute allows', async () => {
  const id = nextId();
  push(s, fullAt('讲长一点', { id, member: MEMBER }));
  const row = await s.waitRow(id);
  assert.equal(`${row.state}:${row.reason}`, 'completed:sent');
  assert.equal(s.messagePosts().length, 4);
  assert.deepEqual(s.alerts().filter((a) => a.kind === 'send_rate'), []);
});

test('the next member, with the minute full, waits and then gets the whole answer', { timeout: 150000 }, async () => {
  s.model.setScript(() => ({ text: LONG(200) }));
  const id = nextId();
  const started = Date.now();
  push(s, fullAt('我也问一句', { id, member: MEMBER2 }));
  const row = await s.waitRow(id, 140000);
  assert.equal(`${row.state}:${row.reason}`, 'completed:sent');
  assert.equal(s.messagePosts().length, 6);
  assert.ok(s.event('exit_wait').length >= 1, 'it waited for room');
  assert.ok(Date.now() - started > 20000, 'on the real clock');
  assert.deepEqual(s.alerts().filter((a) => a.kind === 'send_rate'), []);
});

test('last: every POST on this stack is legal', () => {
  assertEveryPostLegal(s, { minPosts: 6 });
  assert.deepEqual(unexpectedNetAttempts(s.gw), []);
});
