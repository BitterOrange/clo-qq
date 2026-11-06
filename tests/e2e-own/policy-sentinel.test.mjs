// The own runtime counterpart of tests/e2e/policy-sentinel.test.mjs: a system prompt without the policy block, or with
// its markers wrong, never reaches a model. The bot reads the prompt file at each turn, so one process runs every row,
// with the intact control before and after each broken one. The host rows (its fallback prompt from AGENTS.md, and the
// hook that needs allowConversationAccess) have no counterpart: the own runtime has one prompt and checks it itself.
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { fullAt, nextId } from '../fixtures/qq-events.mjs';
import { assertEveryPostLegal, netAttempts, sleep, startOwnStack } from '../harness/own.mjs';

const LINES = JSON.parse(readFileSync(new URL('../../persona/policy-lines.zh.json', import.meta.url), 'utf8'));
const START = '<!-- clo-policy:1 -->';
const END = '<!-- clo-policy-end:1 -->';
const BLOCKED_TEXT = '这段文字绝不该发出。';
const OK_TEXT = '可以回答。';

const without = (text, mark) => text.split(mark).join('');
const swapped = (text) => text.replace(START, '\u0000').replace(END, START).replace('\u0000', END);
const truncated = (text) => text.slice(0, text.indexOf(END));

const CASES = [
  ['start marker missing', (t) => without(t, START), 'missing-start'],
  ['end marker missing (truncated)', truncated, 'missing-end'],
  ['order swapped', swapped, 'order'],
  ['wrong policy version', (t) => t.replaceAll('clo-policy:1', 'clo-policy:2').replaceAll('clo-policy-end:1', 'clo-policy-end:2'), 'missing-start'],
  ['empty prompt file', () => '', 'no-prompt'],
];

const systemText = (req) => req.body.messages.find((m) => m.role === 'system').content.map((c) => c.text).join('');
const sentinelAlerts = (s) => s.alerts().filter((a) => a.kind === 'policy_sentinel');

// Waits for the row and for the one post it should give, then a little longer, so a second post would be seen.
async function askOnce(s) {
  const posts = s.postBodies().length;
  const id = nextId();
  s.send(fullAt('有个问题', { id }));
  const row = await s.waitRow(id);
  await s.waitPosts(posts + 1);
  await sleep(400);
  return { id, row };
}

describe('one bot, the prompt changed under it', () => {
  let s;
  let intact;

  before(async () => {
    s = await startOwnStack({ label: 'sent', script: () => ({ text: OK_TEXT }) });
    intact = s.systemPrompt;
  });

  after(async () => {
    await s?.stop();
    s?.cleanup();
  });

  async function control() {
    s.writeSystemPrompt(intact);
    s.model.setScript(() => ({ text: OK_TEXT }));
    const calls = s.model.agentRequests().length;
    const posts = s.postBodies().length;
    const alerts = sentinelAlerts(s).length;
    const { id, row } = await askOnce(s);
    assert.equal(`${row.state}:${row.reason}`, 'completed:sent');
    assert.equal(s.model.agentRequests().length, calls + 1, 'the model is called');
    const req = s.model.agentRequests().at(-1);
    const system = systemText(req);
    assert.equal(system, intact, 'the system text sent is the file on disk, byte for byte');
    assert.ok(system.indexOf(START) >= 0 && system.indexOf(START) < system.indexOf(END), 'the markers are in order');
    const fresh = s.postBodies().slice(posts);
    assert.deepEqual(fresh.map((p) => [p.msg_id, p.content]), [[id, OK_TEXT]]);
    assert.equal(sentinelAlerts(s).length, alerts, 'no sentinel alert');
  }

  test('intact (control): the markers are in the prompt, in order, and the model is called', control);

  for (const [label, edit, reason] of CASES) {
    test(`${label}: zero model calls, the failure line once, no model or policy text in QQ; intact again answers`, async () => {
      s.writeSystemPrompt(edit(intact));
      s.model.setScript(() => ({ text: BLOCKED_TEXT }));
      const calls = s.model.agentRequests().length;
      const posts = s.postBodies().length;
      const alerts = sentinelAlerts(s).length;
      const { id, row } = await askOnce(s);
      assert.equal(`${row.state}:${row.reason}`, 'skipped:policy_sentinel');
      assert.equal(s.model.agentRequests().length, calls, 'blocked before the model');
      const fresh = s.postBodies().slice(posts);
      assert.equal(fresh.length, 1, 'exactly one post: the failure line');
      assert.equal(fresh[0].content, LINES.modelFailed);
      assert.equal(fresh[0].msg_id, id);
      assert.ok(!fresh[0].content.includes(BLOCKED_TEXT));
      assert.ok(!fresh[0].content.includes('clo-policy'));
      const added = sentinelAlerts(s).slice(alerts);
      assert.equal(added.length, 1, 'one sentinel alert');
      assert.ok(added[0].detail.includes(reason), `the alert names the reason: ${added[0].detail}`);
      assert.ok(s.event('policy_sentinel').some((e) => e.reason === reason));
      await control();
    });
  }

  test('a missing prompt file blocks as well', async () => {
    rmSync(s.paths.systemPromptFile, { force: true });
    const calls = s.model.agentRequests().length;
    const posts = s.postBodies().length;
    const { id, row } = await askOnce(s);
    assert.equal(`${row.state}:${row.reason}`, 'skipped:policy_sentinel');
    assert.equal(s.model.agentRequests().length, calls);
    assert.deepEqual(s.postBodies().slice(posts).map((p) => [p.msg_id, p.content]), [[id, LINES.modelFailed]]);
    await control();
  });

  test('privacy.replaceSystemPrompt off changes nothing: there is no host prompt to fall back to', async () => {
    s.updateEffective({ privacy: { replaceSystemPrompt: false } });
    s.writeSystemPrompt(without(intact, START));
    const calls = s.model.agentRequests().length;
    const { row } = await askOnce(s);
    assert.equal(`${row.state}:${row.reason}`, 'skipped:policy_sentinel');
    assert.equal(s.model.agentRequests().length, calls, 'still blocked');
    await control();
    s.updateEffective({ privacy: { replaceSystemPrompt: true } });
  });

  test('last: every POST on this stack is legal, and no network beyond the mocks', () => {
    assertEveryPostLegal(s, { minPosts: 8 });
    assert.deepEqual(netAttempts(s), []);
  });
});

describe('broken from the start', () => {
  test('a bot started with a prompt that has no policy block connects, and blocks its first turn', async () => {
    const s = await startOwnStack({ label: 'sent-boot', editPrompt: (t) => without(without(t, START), END), script: () => ({ text: BLOCKED_TEXT }) });
    try {
      const { id, row } = await askOnce(s);
      assert.equal(`${row.state}:${row.reason}`, 'skipped:policy_sentinel');
      assert.equal(s.model.requests.length, 0, 'no model request of any kind');
      assert.deepEqual(s.postBodies().map((p) => [p.msg_id, p.content]), [[id, LINES.modelFailed]]);
      assert.equal(sentinelAlerts(s).length, 1);
    } finally {
      await s.stop();
      s.cleanup();
    }
  });
});
