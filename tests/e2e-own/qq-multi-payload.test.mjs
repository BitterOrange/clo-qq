// What the host's multi-payload assumptions guarded, on the own runtime. The host could yield text around tool calls
// and called again when a required turn was silent. The bot makes one request with no tools and hands the exit one
// final text at most, so: one model call per turn, nothing from a tool-call answer reaches QQ, and the policy check sees
// the whole text that is posted.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fullAt, nextId, push } from '../fixtures/qq-events.mjs';
import { assertEveryPostLegal, netAttempts, sleep, startOwnStack } from '../harness/own.mjs';

let s;

before(async () => {
  s = await startOwnStack({ label: 'multi' });
});

after(async () => {
  await s?.stop();
  s?.cleanup();
});

// A provider answer that carries text and a tool call, although the request offered no tool.
const textWithToolCall = (text) => () => ({ text, toolCall: { name: 'clo_feature_status', arguments: {} } });

async function ask(text) {
  const id = nextId();
  const posts = s.messagePosts().length;
  const model = s.agentRequests().length;
  push(s, fullAt(text, { id }));
  const row = await s.waitRow(id);
  await sleep(300);
  return {
    id,
    row,
    fresh: s.postBodies().slice(posts),
    requests: s.agentRequests().slice(model),
    collects: s.event('exit_collect').filter((e) => e.eventKey === s.key(id)).length,
  };
}

test('a reply is one model call and one POST, and the request offers no tool', async () => {
  s.model.setScript(() => ({ text: '一段回复。' }));
  const { row, fresh, requests, collects } = await ask('一问');
  assert.equal(`${row.state}:${row.reason}`, 'completed:sent');
  assert.equal(requests.length, 1);
  assert.equal(collects, 1, 'one final text');
  assert.deepEqual(fresh.map((p) => p.content), ['一段回复。']);
  for (const k of ['tools', 'tool_choice', 'functions']) assert.equal(requests[0].body[k], undefined, `no ${k}`);
});

test('a silent answer to a required turn is not asked again: one model call, nothing collected', async () => {
  s.model.setScript(() => ({ text: 'NO_REPLY' }));
  const { id, row, fresh, requests, collects } = await ask('二问');
  assert.equal(`${row.state}:${row.reason}`, 'failed:required_no_text');
  assert.equal(requests.length, 1, 'no second call, unlike the host');
  assert.equal(collects, 0);
  assert.ok(!fresh.some((p) => p.content.includes('NO_REPLY')), 'the silent token is never posted');
  assert.deepEqual(s.sends(id).map((r) => r.kind), ['fixed_line'], 'a required turn gets the failure line');
});

test('text that came with a tool call never reaches QQ, and there is no second round', async () => {
  s.model.setScript(textWithToolCall('前半句。'));
  const { id, row, fresh, requests, collects } = await ask('三问');
  assert.equal(`${row.state}:${row.reason}`, 'failed:host_error');
  assert.deepEqual(s.sends(id).map((r) => r.kind), ['fixed_line'], 'only the failure line went out');
  assert.equal(requests.length, 1, 'no tool result is sent back');
  assert.equal(collects, 0, 'nothing handed to the exit');
  assert.ok(!fresh.some((p) => p.content.includes('前半句')), 'the text is not posted');
});

test('a forbidden phrase that came with a tool call stays out too', async () => {
  s.model.setScript(textWithToolCall('可以 加我 约炮'));
  const { row, fresh, requests, collects } = await ask('四问');
  assert.equal(`${row.state}:${row.reason}`, 'failed:host_error');
  assert.equal(requests.length, 1);
  assert.equal(collects, 0);
  assert.equal(fresh.length, 1, 'the failure line only');
  assert.ok(!fresh.some((p) => p.content.includes('约炮')));
});

test('a forbidden phrase in the final text is dropped with the fixed line (positive control for the cases above)', async () => {
  s.model.setScript(() => ({ text: '可以 加我 约炮' }));
  const { row, fresh, collects } = await ask('五问');
  assert.equal(row.state, 'policy_dropped');
  assert.equal(collects, 1, 'positive control: this text did reach the exit');
  assert.equal(fresh.length, 1);
  assert.ok(!fresh[0].content.includes('约炮'));
});

test('a long reply splits into ordered parts within the cap', async () => {
  const sentence = '这是一句用来测试分段的普通句子。';
  s.model.setScript(() => ({ text: sentence.repeat(300) }));
  const { row, fresh, requests } = await ask('六问');
  assert.equal(`${row.state}:${row.reason}`, 'completed:sent');
  assert.equal(requests.length, 1);
  assert.ok(fresh.length >= 2 && fresh.length <= 5, `parts: ${fresh.length}`);
  assert.deepEqual(fresh.map((p) => p.msg_seq), fresh.map((_, i) => i + 1));
  for (const p of fresh) assert.ok([...p.content].length <= 1500);
});

test('last: every POST on this stack is legal, and the bot reached nothing but the mocks', () => {
  assertEveryPostLegal(s, { minPosts: 3 });
  assert.deepEqual(netAttempts(s), []);
});
