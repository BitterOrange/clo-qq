// TQ13: the model is offered exactly one tool. A stack without the tool policy offers `message`, which is
// the control that shows the check could fail. Direct and wrapper tool calls cannot reach QQ.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fullAt, nextId, push } from '../fixtures/qq-events.mjs';
import { assertAgentRequest, assertEveryPostLegal, startStack, unexpectedNetAttempts } from '../harness/gateway.mjs';

const toolNames = (rec) => (rec.body.tools ?? []).map((t) => t.function?.name ?? t.name);
const systemOf = (rec) => rec.body.messages.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

let s;

before(async () => {
  s = await startStack({ label: 'tools', script: () => ({ text: '工具观察。' }) });
  await s.waitConnected();
});

after(async () => {
  await s?.stop();
  s?.cleanup();
});

test('the rendered policy: exactly clo_feature_status, nothing deferred, no forced tool', async () => {
  const id = nextId();
  push(s, fullAt('列一下工具', { id }));
  await s.waitRow(id);
  const req = s.model.agentRequests()[0];
  assertAgentRequest(req);
  assert.deepEqual(toolNames(req), ['clo_feature_status']);
  assert.ok([undefined, 'auto', 'none'].includes(req.body.tool_choice));
  const system = systemOf(req);
  assert.doesNotMatch(system, /tool_search|tool_describe|Deferred Tool/);
  assert.equal(s.messagePosts().length, 1);
});

test('the inert tool works, and costs one tool-round hold that ends with the turn', async () => {
  let calls = 0;
  s.model.setScript(() => {
    calls += 1;
    return calls === 1 ? { toolCall: { name: 'clo_feature_status', arguments: {} } } : { text: '已查看。' };
  });
  const id = nextId();
  push(s, fullAt('看看功能', { id }));
  const row = await s.waitRow(id);
  assert.equal(`${row.state}:${row.reason}`, 'completed:sent');
  assert.equal(calls, 2);
  const rows = s.reservations(id);
  assert.equal(rows.filter((r) => r.category === 'tool_round').length, 1);
  assert.equal(rows.find((r) => r.category === 'tool_round').status, 'released');
  assert.equal(rows.find((r) => r.category === 'reply').status, 'settled');
});

for (const [label, step, needle] of [
  ['a denied direct message call', { toolCall: { name: 'message', arguments: { action: 'send', target: 'group:x', message: '工具直发' } } }, '工具直发'],
  ['message through the tool_call wrapper', { toolCall: { name: 'tool_call', arguments: { id: 'message', name: 'message', args: { action: 'send', message: '包装直发' } } } }, '包装直发'],
  ['exec through the tool_call wrapper', { toolCall: { name: 'tool_call', arguments: { id: 'exec', name: 'exec', args: { command: 'whoami' } } } }, 'whoami'],
]) {
  test(`${label} cannot reach QQ or outbound.sendText`, async () => {
    let calls = 0;
    s.model.setScript(() => {
      calls += 1;
      return calls === 1 ? step : { text: '被拒之后的回复。' };
    });
    const posts = s.messagePosts().length;
    const id = nextId();
    push(s, fullAt('试试工具', { id }));
    await s.waitRow(id);
    const fresh = s.postBodies().slice(posts);
    assert.ok(fresh.length <= 1, 'at most the one final reply');
    assert.ok(!fresh.some((b) => b.content.includes(needle)));
    assert.equal(s.event('outbound_send_attempt').length, 0);
  });
}

test('last: every POST on this stack is legal', () => {
  assertEveryPostLegal(s, { minPosts: 2 });
  assert.deepEqual(unexpectedNetAttempts(s.gw), []);
});

test('control: with the tool policy removed, the same host offers message', async () => {
  // The host's own prompt lists deferred tools, so the replacement prompt is off for this one.
  const c = await startStack({ label: 'tools-ctl', effective: { privacy: { replaceSystemPrompt: false } }, overrides: { tools: undefined }, script: () => ({ text: '对照。' }) });
  try {
    await c.waitConnected();
    const id = nextId();
    push(c, fullAt('对照', { id }));
    await c.waitRow(id);
    const req = c.model.agentRequests()[0];
    const offered = [...toolNames(req), ...systemOf(req).split('\n').filter((l) => /^- \w+ \(/.test(l)).map((l) => l.slice(2).replace(/\s*\(.*$/, ''))];
    assert.ok(offered.includes('message'), `offered: ${offered.join(',')}`);
    assert.ok(offered.length > 1);
  } finally {
    await c.stop();
    c.cleanup();
  }
});
