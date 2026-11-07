// TQ31 on the own runtime: however the provider refuses or fails, its text never reaches QQ, our event log, the bot's
// output or any file the bot writes, and the failure line goes out once. One refusal does not stop the next person;
// repeated failures do. On OpenRouter a refusal has no usage, so its hold stays unsettled and it counts toward that
// streak; on Anthropic it carries usage, settles from tokens and counts as an answer.
// The own runtime has no host session database, so unlike the host path nothing on disk keeps the provider's text
// or the member's words: the last test reads every file under the test root.
// Each provider kind has its own failure shapes. On Anthropic a refusal is an HTTP 200 with stop_reason refusal, and its
// provider text also sits in request_id, stop_details and thinking blocks; a 403 there pauses paid work instead
// (provider-anthropic.test.mjs), so it is not among these cases.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fullAt, nextId, push } from '../fixtures/qq-events.mjs';
import { REQUEST_ID_MARKER, STOP_DETAILS_MARKER, THINKING_MARKER } from '../harness/mock-anthropic.mjs';
import { assertEveryPostLegal, netAttempts, PROVIDER, startOwnStack, TEST_IDS, until } from '../harness/own.mjs';

const PRIMARY_ID = TEST_IDS.primary;

const LINES = JSON.parse(readFileSync(new URL('../../persona/policy-lines.zh.json', import.meta.url), 'utf8'));
const LEAK = 'PROVIDER-SECRET-TEXT';
const METADATA = 'FLAGGEDINPUTCANARY';
const USER_TEXT = 'USERBODYCANARY7741';
const moderation403 = {
  error: { code: 403, message: `Your input was flagged. ${LEAK}`, metadata: { reasons: ['x'], flagged_input: METADATA, provider_name: 'mock', model_slug: 'mock' } },
};

// The non-streaming shapes the runner can meet. The host's mid-stream error has two forms here: a 2xx carrying an
// error object, and OpenRouter's finish_reason 'error' on a partial text.
const OPENROUTER_CASES = [
  ['HTTP 403 moderation', { error: { status: 403, body: moderation403 } }],
  ['HTTP 400 echoing the input', { error: { status: 400, body: { error: { code: 400, message: `bad request ${LEAK} ${USER_TEXT}`, metadata: { raw: METADATA, provider_name: 'mock' } } } } }],
  ['HTTP 200 with message.refusal', { refusal: `I cannot help. ${LEAK}`, finishReason: 'content_filter', usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 } }],
  ['HTTP 200 carrying an error object', { error: { status: 200, body: { error: { code: 502, message: `upstream died ${LEAK}`, metadata: { provider_name: 'mock', raw: METADATA } }, choices: [{ index: 0, finish_reason: 'error', message: { role: 'assistant', content: `半句话 ${LEAK}` } }] } } }],
  ['finish_reason error on a partial text', { text: `半句话 ${LEAK}`, finishReason: 'error', usage: null }],
  ['a tool call with text', { text: `先查一下 ${LEAK}`, toolCall: { name: 'exec', arguments: { cmd: METADATA } } }],
  ['a 2xx with no choice', { error: { status: 200, body: { id: 'x', model: PRIMARY_ID, note: LEAK } } }],
  ['content_filter with text', { text: `被截下的 ${LEAK}`, finishReason: 'content_filter' }],
  ['empty text', { text: '', usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 } }],
];

const anthropicError = (status, type, message) => ({ error: { status, body: { type: 'error', error: { type, message }, request_id: `req_${METADATA}` } } });
const ANTHROPIC_CASES = [
  ['HTTP 400 echoing the input', anthropicError(400, 'invalid_request_error', `bad request ${LEAK} ${USER_TEXT}`)],
  ['HTTP 200 with stop_reason refusal', { refusal: `I cannot help. ${LEAK}`, usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 } }],
  ['HTTP 200 carrying an error object', anthropicError(200, 'api_error', `upstream died ${LEAK}`)],
  ['an unknown stop_reason on a partial text', { text: `半句话 ${LEAK}`, stopReason: 'pause_turn' }],
  ['a tool call with text', { text: `先查一下 ${LEAK}`, toolCall: { name: 'exec', arguments: { cmd: METADATA } } }],
  ['a 2xx with no content', { error: { status: 200, body: { id: 'x', type: 'message', model: PRIMARY_ID, note: LEAK } } }],
  ['refusal with text', { text: `被截下的 ${LEAK}`, stopReason: 'refusal' }],
  ['thinking and no text', { thinking: LEAK, usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }],
  ['empty text', { text: '', usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 } }],
];
const CASES = PROVIDER === 'anthropic' ? ANTHROPIC_CASES : OPENROUTER_CASES;
// One refusal of this kind, for the streak test.
const REFUSAL_STEP = PROVIDER === 'anthropic' ? { refusal: `I cannot help. ${LEAK}` } : { error: { status: 403, body: moderation403 } };
// What must never leave the adapter or the mock: the planted texts, and on Anthropic the mock's own markers.
const NEEDLES = PROVIDER === 'anthropic' ? [LEAK, METADATA, USER_TEXT, REQUEST_ID_MARKER, STOP_DETAILS_MARKER, THINKING_MARKER] : [LEAK, METADATA, USER_TEXT];

let s;

function filesUnder(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) filesUnder(p, out);
    else out.push(p);
  }
  return out;
}

before(async () => {
  // acceptUnsettled books each hold at full price, and this file does that many times.
  s = await startOwnStack({ provider: PROVIDER, label: 'refusal', script: () => ({ text: '正常回答。' }), effective: { budget: { addressedUsd: 100, dailyUsd: 100 } } });
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
  assert.equal(s.agentRequests()[0].body.model, PRIMARY_ID);
});

for (const [label, step] of CASES) {
  test(`${label}: failure line once, provider text nowhere`, async () => {
    await s.acceptUnsettled();
    s.model.setScript(() => step);
    const posts = s.messagePosts().length;
    const requests = s.agentRequests().length;
    const id = nextId();
    push(s, fullAt(`触发 ${label} ${USER_TEXT}`, { id }));
    const row = await s.waitRow(id);
    const fresh = s.postBodies().slice(posts);
    assert.equal(row.state, 'failed', `${label}: ${row.state}:${row.reason}`);
    assert.equal(s.agentRequests().length, requests + 1, 'asked once, never again');
    assert.equal(fresh.length, 1, label);
    assert.equal(fresh[0].content, LINES.modelFailed);
    assert.equal(fresh[0].msg_id, id);
    for (const r of s.reservations(id)) assert.notEqual(r.status, 'released', 'a model ran, so the money is not zeroed');
    const eventLog = readFileSync(s.paths.eventLog, 'utf8');
    assert.ok(eventLog.includes(row.event_key), 'positive control: the event log has this turn');
    assert.ok(s.logs().length > 0 || eventLog.length > 0, 'positive control: something is being captured');
    for (const needle of NEEDLES) {
      assert.ok(!eventLog.includes(needle), `${needle} in our event log`);
      assert.ok(!s.logs().includes(needle), `${needle} in the bot's output`);
    }
  });
}

test('finish_reason length: the partial text goes out on a required turn, and nothing else', async () => {
  await s.acceptUnsettled();
  s.model.setScript(() => ({ text: '半句', finishReason: 'length' }));
  const posts = s.messagePosts().length;
  const id = nextId();
  push(s, fullAt('很长的问题', { id }));
  const row = await s.waitRow(id);
  assert.equal(`${row.state}:${row.reason}`, 'completed:sent');
  assert.deepEqual(s.postBodies().slice(posts).map((p) => p.content), ['半句']);
  assert.ok(s.event('turn_length').some((e) => e.eventKey === row.event_key), 'the cut is logged, by reason only');
});

// On OpenRouter a refusal is a 403 with no usage: its cost is unknown, and it counts toward the failure streak.
test('one refusal does not stop the next member; three in a row pause paid work', { skip: PROVIDER === 'anthropic' && 'an Anthropic refusal carries usage: see the next test' }, async () => {
  s.model.setScript(() => REFUSAL_STEP);
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

  s.model.setScript(() => REFUSAL_STEP);
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

// On Anthropic a refusal is an HTTP 200 with stop_reason refusal and usage (contract section 5): the model answered,
// so the row settles from its tokens like any answer (section 7) and the failure streak does not grow. The streak
// itself still works on this kind: three server errors in a row pause paid work, in the same run.
test('stop_reason refusal on Anthropic: settled from tokens, and refusals in a row do not pause; errors in a row do', { skip: PROVIDER !== 'anthropic' && 'runs with CLO_TEST_PROVIDER=anthropic' }, async () => {
  await s.acceptUnsettled();
  s.model.setScript(() => REFUSAL_STEP);
  const first = nextId();
  push(s, fullAt('一次拒答', { id: first }));
  const row = await s.waitRow(first);
  assert.equal(row.state, 'failed');
  const [hold] = s.reservations(first);
  assert.equal(hold.status, 'settled', 'its usage came back, so its cost is known');
  assert.equal(hold.source, 'computed', 'from tokens at the locked price: Anthropic reports no cost');
  // The mock's default usage, 10 input and 2 output tokens, at $5 and $20 per million.
  assert.equal(hold.actual_micros, 90);

  const pausedBefore = s.event('paid_paused').length;
  for (let i = 0; i < 3; i += 1) {
    const id = nextId();
    push(s, fullAt(`连续拒答 ${i}`, { id }));
    assert.equal((await s.waitRow(id)).state, 'failed');
  }
  assert.equal(s.control('paid_paused'), null, 'three refusals in a row stop no one');
  assert.equal(s.event('paid_paused').length, pausedBefore);

  // Positive control: the same count of real failures does pause.
  s.model.setScript(() => ({ apiError500: LEAK }));
  for (let i = 0; i < 3; i += 1) {
    const id = nextId();
    push(s, fullAt(`连续失败 ${i}`, { id }));
    await s.waitRow(id);
  }
  await until(() => s.event('paid_paused').some((e) => e.reason === 'provider_fail'), 'the failure streak to pause paid work', 15000);
  await s.acceptUnsettled();
  s.model.setScript(() => ({ text: '恢复了。' }));
  const again = nextId();
  push(s, fullAt('再问一句', { id: again }));
  assert.equal((await s.waitRow(again)).state, 'completed', 'cleared: paid work resumes');
});

test('no provider text in any POST on this stack', () => {
  assert.ok(s.postBodies().length >= 5, 'positive control: this stack posted');
  for (const p of s.postBodies()) assert.ok(!p.content.includes(LEAK) && !p.content.includes(METADATA) && !p.content.includes('⚠'));
  for (const p of s.postBodies()) for (const needle of NEEDLES) assert.ok(!p.content.includes(needle), needle);
});

test('last: every POST is legal, nothing left the mocks, and no file the bot wrote holds the provider text', async () => {
  assertEveryPostLegal(s, { minPosts: 5 });
  assert.deepEqual(netAttempts(s), []);
  // Stopped first, so the database and its journal are complete on disk.
  const ended = await s.stopBot();
  assert.equal(ended.how, 'requested');
  const files = filesUnder(s.tmp);
  assert.ok(files.some((f) => f.endsWith('clo.db')), 'positive control: the database is among the files read');
  const firstKey = s.allSends()[0].event_key;
  assert.ok(files.some((f) => readFileSync(f).includes(firstKey)), 'positive control: the scan reads what the bot wrote');
  for (const f of files) {
    const bytes = readFileSync(f);
    for (const needle of NEEDLES) assert.ok(!bytes.includes(needle), `${needle} in ${f.slice(s.tmp.length)}`);
  }
});
