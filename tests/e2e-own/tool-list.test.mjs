// The own runtime counterpart of tests/e2e/tool-list.test.mjs. Under the host the model was offered exactly one inert
// tool, and the host's own tools were denied one by one. The own runtime offers none: the request carries no tools
// field at all, and an answer that calls a tool anyway is a failed turn, so nothing it names or carries reaches QQ.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { fullAt, nextId } from '../fixtures/qq-events.mjs';
import { assertEveryPostLegal, netAttempts, sleep, startOwnStack } from '../harness/own.mjs';

const LINES = JSON.parse(readFileSync(new URL('../../persona/policy-lines.zh.json', import.meta.url), 'utf8'));
const TOOL_KEYS = ['tools', 'tool_choice', 'parallel_tool_calls', 'functions', 'function_call', 'plugins', 'web_search_options'];
const systemOf = (rec) => rec.body.messages.filter((m) => m.role === 'system').map((m) => JSON.stringify(m.content)).join('\n');

let s;

before(async () => {
  s = await startOwnStack({ label: 'tools', script: () => ({ text: '工具观察。' }) });
});

after(async () => {
  await s?.stop();
  s?.cleanup();
});

async function ask(text) {
  const posts = s.postBodies().length;
  const id = nextId();
  s.send(fullAt(text, { id }));
  const row = await s.waitRow(id);
  await s.waitPosts(posts + 1);
  await sleep(400);
  return { id, row, fresh: s.postBodies().slice(posts) };
}

test('the request offers no tool of any kind, and the system text names none', async () => {
  const { row, fresh } = await ask('列一下工具');
  assert.equal(`${row.state}:${row.reason}`, 'completed:sent');
  assert.deepEqual(fresh.map((p) => p.content), ['工具观察。'], 'positive control: this stack answers');
  const req = s.model.agentRequests().at(-1);
  for (const k of TOOL_KEYS) assert.equal(Object.hasOwn(req.body, k), false, `${k} is in the request`);
  assert.doesNotMatch(systemOf(req), /tool_search|tool_describe|Deferred Tool|clo_feature_status/);
  assert.deepEqual(s.decisionRequests(), [], 'a plain @ buys no decision');
});

// The text that comes with a tool call is the needle. The control below shows the same text, sent without the call, is posted.
for (const [label, toolCall, needle] of [
  ['a direct message call', { name: 'message', arguments: { action: 'send', target: 'group:x', message: '工具直发' } }, '工具直发'],
  ['message through a tool_call wrapper', { name: 'tool_call', arguments: { id: 'message', name: 'message', args: { action: 'send', message: '包装直发' } } }, '包装直发'],
  ['exec through a tool_call wrapper', { name: 'tool_call', arguments: { id: 'exec', name: 'exec', args: { command: 'whoami' } } }, 'whoami'],
  ['the old inert tool', { name: 'clo_feature_status', arguments: {} }, '功能状态'],
]) {
  test(`${label}: one model call, nothing run, nothing of it in QQ; the @ gets the failure line`, async () => {
    const calls = s.model.agentRequests().length;
    s.model.setScript(() => ({ text: `附带文字${needle}`, toolCall }));
    const { id, row, fresh } = await ask('试试工具');
    assert.equal(s.model.agentRequests().length, calls + 1, 'no second round: the call is not answered with a result');
    assert.equal(row.state, 'failed');
    assert.deepEqual(fresh.map((p) => [p.msg_id, p.content]), [[id, LINES.modelFailed]]);
    assert.ok(!fresh.some((b) => b.content.includes(needle)));
    assert.ok(s.event('turn_model').some((e) => e.eventKey && e.reason === 'tool_calls'), 'the runner saw the tool call');
    assert.ok(!JSON.stringify(s.events()).includes(needle), 'and nothing it carried reached the event log');
    assert.ok(!s.logs().includes(needle), 'nor the process output');
  });
}

test('control: the same text with no tool call is posted', async () => {
  s.model.setScript(() => ({ text: '附带文字工具直发' }));
  const { row, fresh } = await ask('对照');
  assert.equal(`${row.state}:${row.reason}`, 'completed:sent');
  assert.deepEqual(fresh.map((p) => p.content), ['附带文字工具直发']);
});

test('last: every POST on this stack is legal, and no network beyond the mocks', () => {
  assertEveryPostLegal(s, { minPosts: 6 });
  assert.deepEqual(netAttempts(s), []);
});
