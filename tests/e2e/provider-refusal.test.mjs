// TQ31: however the provider refuses or fails, its text never reaches QQ or our event log, and the failure
// line goes out once. One refusal leaves its hold unsettled and does not stop the next person; repeated
// failures do. logging silent and host-output-filter keep the text out of the host's console and file logs.
// Observed limit: the host's own session database still holds it. See DEPLOYMENT.md.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fullAt, nextId, push } from '../fixtures/qq-events.mjs';
import { assertAgentRequest, assertEveryPostLegal, startStack, unexpectedNetAttempts, until } from '../harness/gateway.mjs';

const LINES = JSON.parse(readFileSync(new URL('../../persona/policy-lines.zh.json', import.meta.url), 'utf8'));
const LEAK = 'PROVIDER-SECRET-TEXT';
const METADATA = 'FLAGGEDINPUTCANARY';
const USER_TEXT = 'USERBODYCANARY7741';
const moderation403 = {
  error: { code: 403, message: `Your input was flagged. ${LEAK}`, metadata: { reasons: ['x'], flagged_input: METADATA, provider_name: 'mock', model_slug: 'mock' } },
};

const CASES = [
  ['HTTP 403 moderation', { error: { status: 403, body: moderation403 } }],
  ['HTTP 400 echoing the input', { error: { status: 400, body: { error: { code: 400, message: `bad request ${LEAK} ${USER_TEXT}`, metadata: { raw: METADATA, provider_name: 'mock' } } } } }],
  ['HTTP 200 with message.refusal', { refusal: `I cannot help. ${LEAK}`, finishReason: 'content_filter', usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 } }],
  ['mid-stream error', { text: `半句话 ${LEAK}`, midStreamError: { code: 502, message: `upstream died ${LEAK}`, metadata: { provider_name: 'mock', raw: METADATA } }, usage: null }],
  ['empty text', { text: '', usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 } }],
];

let s;

// The host's file log, where openclaw.json names it (logging.file, under .runtime/logs/host), on every platform.
// Silent, so it stays empty on the main stack. The last test in this file is the positive control in this run: a
// second stack with the level raised through the test-mode seam does write the provider text into this folder.
function hostFileLogs(stack = s) {
  const dir = join(stack.paths.logsDir, 'host');
  assert.equal(stack.config.logging.file, join(dir, 'openclaw-YYYY-MM-DD.log'), 'the folder read here is the one the host was given');
  if (!existsSync(dir)) return '';
  return readdirSync(dir).map((f) => join(dir, f)).filter((f) => statSync(f).isFile()).map((f) => readFileSync(f, 'utf8')).join('\n');
}

before(async () => {
  // acceptUnsettled books each hold at full price, and this file does that many times.
  s = await startStack({ label: 'refusal', script: () => ({ text: '正常回答。' }), effective: { budget: { addressedUsd: 100, dailyUsd: 100 } } });
  await s.waitConnected();
});

after(async () => {
  await s?.stop();
  s?.cleanup();
});

test('positive control: the same stack posts a normal answer', async () => {
  const id = nextId();
  push(s, fullAt('正常问题', { id }));
  const row = await s.waitRow(id);
  assert.equal(`${row.state}:${row.reason}`, 'completed:sent');
  assert.equal(s.postBodies().at(-1).content, '正常回答。');
  assertAgentRequest(s.model.agentRequests()[0]);
});

for (const [label, step] of CASES) {
  test(`${label}: failure line once, provider text nowhere`, async () => {
    await s.acceptUnsettled();
    s.model.setScript(() => step);
    const posts = s.messagePosts().length;
    const id = nextId();
    push(s, fullAt(`触发 ${label}`, { id }));
    const row = await s.waitRow(id);
    const fresh = s.postBodies().slice(posts);
    assert.equal(row.state, 'failed', `${label}: ${row.state}:${row.reason}`);
    assert.equal(fresh.length, 1, label);
    assert.equal(fresh[0].content, LINES.modelFailed);
    assert.equal(fresh[0].msg_id, id);
    for (const r of s.reservations(id)) assert.notEqual(r.status, 'released', 'a model ran, so the money is not zeroed');
    const eventLog = readFileSync(s.paths.eventLog, 'utf8');
    assert.ok(!eventLog.includes(LEAK), 'provider message not in our event log');
    assert.ok(!eventLog.includes(METADATA), 'provider metadata not in our event log');
    assert.ok(s.logs().length > 0, 'positive control: the gateway log is being captured');
    for (const needle of [LEAK, METADATA, USER_TEXT]) {
      assert.ok(!s.logs().includes(needle), `${needle} in the gateway log`);
      assert.ok(!hostFileLogs().includes(needle), `${needle} in the host file log`);
    }
  });
}

test('finish_reason length: the partial text goes out and the host notice does not, on a required turn', async () => {
  await s.acceptUnsettled();
  s.model.setScript(() => ({ text: '半句', finishReason: 'length' }));
  const posts = s.messagePosts().length;
  const id = nextId();
  push(s, fullAt('很长的问题', { id }));
  const row = await s.waitRow(id);
  assert.equal(`${row.state}:${row.reason}`, 'completed:sent');
  assert.deepEqual(s.postBodies().slice(posts).map((p) => p.content), ['半句']);
  assert.ok(s.events().some((e) => e.event === 'exit_drop' && e.reason === 'host-notice'), 'the notice arrived and was dropped');
});

test('one refusal does not stop the next member; three in a row pause paid work', async () => {
  s.model.setScript(() => ({ error: { status: 403, body: moderation403 } }));
  await s.acceptUnsettled();
  const first = nextId();
  push(s, fullAt('一次拒答', { id: first }));
  await s.waitRow(first);
  assert.equal(s.control('paid_paused'), null, 'a single refusal is not a stop for everyone');
  assert.equal(s.reservations(first)[0].status, 'unsettled', 'its cost is unknown, so the hold stays counted');

  s.model.setScript(() => ({ text: '正常回答。' }));
  const next = nextId();
  push(s, fullAt('下一句', { id: next }));
  assert.equal((await s.waitRow(next)).state, 'completed');

  s.model.setScript(() => ({ error: { status: 403, body: moderation403 } }));
  for (let i = 0; i < 3; i += 1) {
    const id = nextId();
    push(s, fullAt(`连续拒答 ${i}`, { id }));
    await s.waitRow(id);
  }
  // The log, not the control row: a clean Key read within the minute may already have cleared it.
  await until(() => s.event('paid_paused').some((e) => e.reason === 'provider_fail'), 'the failure streak to pause paid work', 15000);
  await s.acceptUnsettled();
  s.model.setScript(() => ({ text: '恢复了。' }));
  const again = nextId();
  push(s, fullAt('再问一句', { id: again }));
  assert.equal((await s.waitRow(again)).state, 'completed', 'accepted: paid work resumes');
});

test('no provider text in any POST on this stack', () => {
  for (const p of s.postBodies()) assert.ok(!p.content.includes(LEAK) && !p.content.includes(METADATA) && !p.content.includes('⚠'));
});

test('last: every POST on this stack is legal', () => {
  assertEveryPostLegal(s, { minPosts: 5 });
  assert.deepEqual(unexpectedNetAttempts(s.gw), []);
});

// Positive control for the host file log checks above: the same refusal on a stack whose host log level is raised to
// info (test mode only; clo start never passes it) puts the provider text in the folder hostFileLogs reads. So the
// silent stack's empty log is the level at work, not a scan of the wrong place.
test('positive control: at a raised host log level the same refusal lands in the folder read above', { timeout: 300000 }, async () => {
  const loud = await startStack({ label: 'refusal-loud', script: () => CASES[0][1], parentEnv: { CLO_TEST_HOST_LOG_LEVEL: 'info' } });
  try {
    await loud.waitConnected();
    assert.equal(loud.childEnv.OPENCLAW_LOG_LEVEL, 'info');
    const id = nextId();
    push(loud, fullAt('触发 loud', { id }));
    assert.equal((await loud.waitRow(id)).state, 'failed');
    assert.ok(hostFileLogs(loud).includes(LEAK), 'the provider text is in the raised-level host log');
    assert.ok(!readFileSync(loud.paths.eventLog, 'utf8').includes(LEAK), 'still not in our own event log');
    assert.deepEqual(unexpectedNetAttempts(loud.gw), []);
  } finally {
    await loud.stop();
    loud.cleanup();
  }
});
