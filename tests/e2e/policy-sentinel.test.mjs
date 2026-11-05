// TQ27: a prompt without the policy block, or with its markers wrong, never reaches a model.
// Each row has its own Gateway, so each has the intact control first on a separate stack.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { fullAt, nextId, push } from '../fixtures/qq-events.mjs';
import { startStack } from '../harness/gateway.mjs';

const LINES = JSON.parse(readFileSync(new URL('../../persona/policy-lines.zh.json', import.meta.url), 'utf8'));
const START = '<!-- clo-policy:1 -->';
const END = '<!-- clo-policy-end:1 -->';

const without = (text, mark) => text.split(mark).join('');
const swapped = (text) => text.replace(START, '\u0000').replace(END, START).replace('\u0000', END);
const truncated = (text) => text.slice(0, text.indexOf(END));

const CASES = [
  ['start marker missing', (w) => ({ ...w, systemPrompt: without(w.systemPrompt, START) })],
  ['end marker missing (truncated)', (w) => ({ ...w, systemPrompt: truncated(w.systemPrompt) })],
  ['order swapped', (w) => ({ ...w, systemPrompt: swapped(w.systemPrompt) })],
];

async function askOnce(s) {
  const id = nextId();
  push(s, fullAt('有个问题', { id }));
  return { id, row: await s.waitRow(id) };
}

describe('intact (control)', () => {
  let s;
  before(async () => {
    s = await startStack({ label: 'sent-ok', script: () => ({ text: '可以回答。' }) });
    await s.waitConnected();
  });
  after(async () => {
    await s?.stop();
    s?.cleanup();
  });

  test('the markers are in the prompt, in order, and the model is called', async () => {
    const { row } = await askOnce(s);
    assert.equal(`${row.state}:${row.reason}`, 'completed:sent');
    assert.equal(s.model.agentRequests().length, 1);
    const system = JSON.stringify(s.model.agentRequests()[0].body.messages.filter((m) => m.role === 'system'));
    assert.ok(system.indexOf('clo-policy:1') >= 0);
    assert.ok(system.indexOf('clo-policy:1') < system.indexOf('clo-policy-end:1'));
    assert.equal(s.alerts().filter((a) => a.kind === 'policy_sentinel').length, 0);
  });
});

for (const [label, edit] of CASES) {
  describe(label, () => {
    let s;
    before(async () => {
      s = await startStack({ label: 'sent-bad', script: () => ({ text: '这段文字绝不该发出。' }), editWorkspace: edit });
      await s.waitConnected();
    });
    after(async () => {
      await s?.stop();
      s?.cleanup();
    });

    test('zero model calls; failure line once; provider and policy text stay out', async () => {
      const { id, row } = await askOnce(s);
      assert.equal(row.state, 'failed');
      assert.equal(s.model.agentRequests().length, 0, 'blocked before the model');
      const posts = s.postBodies();
      assert.equal(posts.length, 1);
      assert.equal(posts[0].content, LINES.modelFailed);
      assert.equal(posts[0].msg_id, id);
      assert.ok(s.alerts().some((a) => a.kind === 'policy_sentinel'));
    });
  });
}

describe('host fallback prompt (replaceSystemPrompt off)', () => {
  test('AGENTS.md carries the block, so an intact fallback passes (control)', async () => {
    const s = await startStack({ label: 'sent-host', effective: { privacy: { replaceSystemPrompt: false } }, script: () => ({ text: '回退提示词。' }) });
    try {
      await s.waitConnected();
      const { row } = await askOnce(s);
      assert.equal(`${row.state}:${row.reason}`, 'completed:sent');
      assert.equal(s.model.agentRequests().length, 1);
    } finally {
      await s.stop();
      s.cleanup();
    }
  });

  test('with no policy in AGENTS.md the fallback prompt blocks as well', async () => {
    const s = await startStack({
      label: 'sent-host2',
      effective: { privacy: { replaceSystemPrompt: false } },
      script: () => ({ text: '绝不该发出。' }),
      editWorkspace: (w) => ({ ...w, files: { ...w.files, 'AGENTS.md': '# 没有内容范围\n' } }),
    });
    try {
      await s.waitConnected();
      const { row } = await askOnce(s);
      assert.equal(row.state, 'failed');
      assert.equal(s.model.agentRequests().length, 0);
    } finally {
      await s.stop();
      s.cleanup();
    }
  });
});

describe('allowConversationAccess removed', () => {
  test('the hook does not run, so the fallback prompt reaches the model: that is why doctor checks it', async () => {
    const s = await startStack({
      label: 'sent-noaccess',
      effective: { privacy: { replaceSystemPrompt: false } },
      overrides: { plugins: { entries: { clo: { hooks: { allowConversationAccess: false } } } } },
      script: () => ({ text: '没有哨兵。' }),
      editWorkspace: (w) => ({ ...w, files: { ...w.files, 'AGENTS.md': '# 没有内容范围\n' } }),
    });
    try {
      await s.waitConnected();
      const { row } = await askOnce(s);
      assert.equal(s.model.agentRequests().length, 1, 'observed: without access no sentinel check runs');
      assert.equal(row.state, 'completed');
      assert.equal(s.alerts().filter((a) => a.kind === 'policy_sentinel').length, 0);
    } finally {
      await s.stop();
      s.cleanup();
    }
  });
});
