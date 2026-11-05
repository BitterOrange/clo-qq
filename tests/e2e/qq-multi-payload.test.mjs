// TQ25. Assumptions A1 and A2 on the real host: run() resolves after every deliver, and a buffering
// deliver that reports visibleReplySent stops the required-reply retry.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fullAt, nextId, push } from '../fixtures/qq-events.mjs';
import { assertEveryPostLegal, sleep, startStack, unexpectedNetAttempts } from '../harness/gateway.mjs';

let s;

before(async () => {
  s = await startStack({ label: 'multi' });
  await s.waitConnected();
});

after(async () => {
  await s?.stop();
  s?.cleanup();
});

// Text before a tool call, then text after it, is how a real run can yield two pieces of text.
function textThenToolThenText(first, second) {
  let n = 0;
  return () => {
    n += 1;
    return n === 1 ? { text: first, toolCall: { name: 'clo_feature_status', arguments: {} } } : { text: second };
  };
}

test('A2: a buffered reply is enough: one model call, one POST, no required-reply retry', async () => {
  s.model.setScript(() => ({ text: '一段回复。' }));
  const id = nextId();
  push(s, fullAt('一问', { id }));
  const row = await s.waitRow(id);
  assert.equal(`${row.state}:${row.reason}`, 'completed:sent');
  assert.equal(s.model.agentRequests().length, 1);
  assert.equal(s.messagePosts().length, 1);
});

// Observed on 2026.10.9: five reply shapes (text around tool calls, reply directives, long and multi-paragraph
// text) all gave one final payload holding only the last assistant text. Two finals could not be provoked, so the
// join across payloads is proven in unit/qq-policy-exit. These assert the single-final fact, so an upgrade that
// changes it fails here rather than silently changing what the policy check sees.
test('text before a tool call never reaches QQ: one final payload, and only the last text', async () => {
  s.model.setScript(textThenToolThenText('前半句。', '后半句。'));
  const posts = s.messagePosts().length;
  const id = nextId();
  push(s, fullAt('二问', { id }));
  const row = await s.waitRow(id);
  assert.equal(`${row.state}:${row.reason}`, 'completed:sent');
  assert.equal(s.event('exit_collect').filter((e) => e.eventKey === s.key(id)).length, 1, 'one final payload');
  assert.deepEqual(s.postBodies().slice(posts).map((p) => p.content), ['后半句。']);
});

test('a forbidden phrase before a tool call stays out: the host does not deliver that text at all', async () => {
  s.model.setScript(textThenToolThenText('可以 加我 约炮', '这才是回答。'));
  const posts = s.messagePosts().length;
  const id = nextId();
  push(s, fullAt('三问', { id }));
  const row = await s.waitRow(id);
  await sleep(300);
  assert.equal(row.state, 'completed');
  assert.deepEqual(s.postBodies().slice(posts).map((p) => p.content), ['这才是回答。']);
});

test('a forbidden phrase in one payload is dropped with the fixed line (positive control for the case above)', async () => {
  s.model.setScript(() => ({ text: '可以 加我 约炮' }));
  const posts = s.messagePosts().length;
  const id = nextId();
  push(s, fullAt('四问', { id }));
  const row = await s.waitRow(id);
  assert.equal(row.state, 'policy_dropped');
  const fresh = s.postBodies().slice(posts);
  assert.equal(fresh.length, 1);
  assert.ok(!fresh[0].content.includes('约炮'));
});

test('a long reply splits into ordered parts within the cap', async () => {
  const sentence = '这是一句用来测试分段的普通句子。';
  s.model.setScript(() => ({ text: sentence.repeat(300) }));
  const posts = s.messagePosts().length;
  const id = nextId();
  push(s, fullAt('五问', { id }));
  const row = await s.waitRow(id);
  assert.equal(`${row.state}:${row.reason}`, 'completed:sent');
  const fresh = s.postBodies().slice(posts);
  assert.ok(fresh.length >= 2 && fresh.length <= 5, `parts: ${fresh.length}`);
  assert.deepEqual(fresh.map((p) => p.msg_seq), fresh.map((_, i) => i + 1));
  for (const p of fresh) assert.ok([...p.content].length <= 1500);
});

test('last: every POST on this stack is legal', () => {
  assertEveryPostLegal(s, { minPosts: 3 });
  assert.deepEqual(unexpectedNetAttempts(s.gw), []);
});
