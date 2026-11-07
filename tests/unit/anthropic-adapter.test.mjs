// The Anthropic Messages adapter's own shapes: headers, body whitelist, thinking rules per model role, stop reasons,
// usage with the cache-write split, the error table, and that no provider text or request id leaves it. Pure calls
// plus a scripted fetch through the real transport. No network, no real Key.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { anthropicAdapter as A, mapUsage } from '../../src/clo-plugin/lib/core/providers/anthropicAdapter.js';
import { createChatClient } from '../../src/clo-plugin/lib/core/providers/modelChat.js';
import { ANTHROPIC_EFFORTS, ANTHROPIC_VERSION } from '../../src/clo-plugin/lib/core/providers/registry.js';
import { checkResult } from '../fixtures/fake-adapter.mjs';
import { FAKE_ANTHROPIC_KEY } from '../harness/fake-keys.mjs';

const SECRET = 'PROVIDER-SECRET-TEXT';
const REQ_ID = 'req_011SECRETREQUESTID';
const BASE = 'http://127.0.0.1:9';
const OPUS = 'claude-opus-5-5';
const HAIKU = 'claude-haiku-5-5';
const SYSTEM = '你叫可洛。\n<!-- clo-content-scope:begin -->\n"引号" \\ 🌙\n<!-- clo-content-scope:end -->\n';
const SCHEMA = { name: 'clo_decision', schema: { type: 'object', additionalProperties: false, required: ['action'], properties: { action: { type: 'string', enum: ['reply', 'skip'] } } } };
const WHITELIST = ['model', 'max_tokens', 'system', 'messages', 'output_config', 'thinking'];
const NEVER = ['stream', 'fallbacks', 'speed', 'inference_geo', 'metadata', 'tools', 'tool_choice', 'temperature', 'top_p', 'top_k', 'service_tier', 'betas', 'stop_sequences'];
const forbiddenIn = (body) => [...Object.keys(body).filter((k) => !WHITELIST.includes(k)), ...NEVER.filter((k) => JSON.stringify(body).includes(`"${k}"`))];

const turn = (over = {}) => A.turnBody({ model: OPUS, effort: 'low', maxTokens: 3000, system: SYSTEM, user: 'hi', ...over });
const decision = (over = {}) => A.decisionBody({ model: HAIKU, effort: 'none', maxTokens: 200, system: 'judge', user: '{"x":1}', schema: SCHEMA, ...over });
const message = (over = {}) => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: OPUS,
  content: [{ type: 'text', text: '好的。' }], stop_reason: 'end_turn', stop_details: null,
  usage: { input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 4000, cache_creation: { ephemeral_5m_input_tokens: 4000, ephemeral_1h_input_tokens: 0 }, inference_geo: 'global', speed: 'standard' },
  ...over,
});
const errorBody = (type, msg = SECRET, extra = {}) => ({ type: 'error', error: { type, message: msg, ...extra }, request_id: REQ_ID });
const leaks = (r) => ['SECRET', REQ_ID, 'sig-'].filter((s) => JSON.stringify(r).includes(s));

test('request: the Messages URL and exactly three headers, the Key in its header only', () => {
  const { url, headers } = A.request(FAKE_ANTHROPIC_KEY, BASE);
  assert.equal(url, `${BASE}/v1/messages`);
  assert.deepEqual(Object.keys(headers).sort(), ['anthropic-version', 'content-type', 'x-api-key']);
  // Never printed, even on failure: compared, not shown.
  assert.ok(headers['x-api-key'] === FAKE_ANTHROPIC_KEY);
  assert.equal(headers['anthropic-version'], ANTHROPIC_VERSION);
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(url.includes(FAKE_ANTHROPIC_KEY), false);
  assert.equal(Object.keys(headers).some((h) => /beta|authorization/i.test(h)), false);
});

test('turn body: the whitelist only, the system string byte-exact in one cached block, no thinking key', () => {
  const body = turn();
  assert.deepEqual(body, {
    model: OPUS,
    max_tokens: 3000,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'hi' }],
    output_config: { effort: 'low' },
  });
  assert.deepEqual(forbiddenIn(body), []);
  assert.equal(Object.hasOwn(body, 'thinking'), false);
  assert.equal(JSON.stringify(body).match(/cache_control/g).length, 1);
  assert.equal(A.systemTextOf(body), SYSTEM);
  assert.equal(JSON.parse(JSON.stringify(body)).system[0].text, SYSTEM);
  // Positive control: the check does see a forbidden key.
  assert.deepEqual(forbiddenIn({ ...body, stream: false }), ['stream', 'stream']);
  assert.ok(forbiddenIn({ ...body, output_config: { effort: 'low', speed: 'fast' } }).includes('speed'));
});

test('turn body: Opus efforts only, never none; Anthropic model ids only', () => {
  for (const effort of ANTHROPIC_EFFORTS.primary) assert.equal(turn({ effort }).output_config.effort, effort);
  for (const effort of ['none', 'minimal', '', undefined, 'LOW']) assert.throws(() => turn({ effort }), TypeError, String(effort));
  for (const model of ['anthropic/claude-opus-5.5', 'claude-opus-latest', 'claude-opus-5-5-20261001', 'gpt-5', 'claude-fable-5-1', '']) {
    assert.throws(() => turn({ model }), TypeError, model);
  }
  for (const maxTokens of [0, -1, 1.5, '3000', null]) assert.throws(() => turn({ maxTokens }), TypeError, String(maxTokens));
  assert.equal(turn({ model: 'claude-sonnet-5-5' }).model, 'claude-sonnet-5-5', 'control: another Anthropic line passes');
});

test('decision body: thinking disabled at effort low with the schema as format, effort none only', () => {
  const body = decision();
  assert.deepEqual(body, {
    model: HAIKU,
    max_tokens: 200,
    system: 'judge',
    messages: [{ role: 'user', content: '{"x":1}' }],
    thinking: { type: 'disabled' },
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA.schema } },
  });
  assert.equal(body.output_config.format.schema, SCHEMA.schema, 'the same schema object, not a copy');
  assert.deepEqual(forbiddenIn(body), []);
  assert.equal(A.systemTextOf(body), 'judge');
  for (const effort of ['low', 'medium', 'high', 'max', undefined]) assert.throws(() => decision({ effort }), TypeError, String(effort));
  assert.throws(() => decision({ schema: { name: 'x' } }), TypeError);
});

test('content: text blocks joined in order; thinking and redacted thinking dropped', () => {
  const r = A.classify(200, message({
    content: [
      { type: 'thinking', thinking: SECRET, signature: 'sig-1' },
      { type: 'text', text: '第一段。' },
      { type: 'redacted_thinking', data: SECRET },
      { type: 'text', text: '第二段。' },
    ],
  }), OPUS);
  assert.equal(r.kind, 'ok');
  assert.deepEqual(r.message, { content: '第一段。第二段。', refusal: false, toolCalls: 0 });
  assert.deepEqual(leaks(r), []);
  assert.deepEqual(checkResult(r), []);
});

test('refusal at 200: a refusal Result, the stop details explanation left behind', () => {
  const body = message({ content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: SECRET } });
  const r = A.classify(200, body, OPUS);
  assert.deepEqual([r.kind, r.reason, r.finishReason], ['refusal', 'refusal', 'refusal']);
  assert.equal(r.message.refusal, true);
  assert.equal(r.message.content, null);
  assert.notEqual(r.usage, null, 'a refusal is billed, so its usage is kept');
  assert.deepEqual(leaks(r), []);
  assert.equal(JSON.stringify(body).includes(SECRET), true, 'control: the body carried the explanation');
});

test('stop reasons: max_tokens is length, tool_use and anything else are errors', () => {
  const length = A.classify(200, message({ stop_reason: 'max_tokens' }), OPUS);
  assert.deepEqual([length.kind, length.finishReason], ['ok', 'length']);
  // Thinking used up the budget before any text.
  const empty = A.classify(200, message({ stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '', signature: 'sig-2' }] }), OPUS);
  assert.deepEqual([empty.kind, empty.finishReason, empty.message.content], ['ok', 'length', null]);
  const tool = A.classify(200, message({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'x', input: { q: SECRET } }] }), OPUS);
  assert.deepEqual([tool.kind, tool.reason, tool.message.toolCalls], ['error', 'tool_calls', 1]);
  assert.deepEqual(leaks(tool), []);
  for (const stop of ['pause_turn', 'stop_sequence', 'model_context_window_exceeded', null, undefined, 42]) {
    const r = A.classify(200, message({ stop_reason: stop }), OPUS);
    assert.deepEqual([r.kind, r.reason], ['error', 'finish_reason'], String(stop));
  }
  assert.equal(A.classify(200, message(), OPUS).finishReason, 'stop', 'control: end_turn is a stop');
});

test('model: a different model echoed back is a mismatch', () => {
  assert.equal(A.classify(200, message({ model: HAIKU }), OPUS).reason, 'model_mismatch');
  assert.equal(A.classify(200, message({ model: undefined }), OPUS).reason, 'model_mismatch');
  assert.equal(A.classify(200, message(), OPUS).kind, 'ok', 'control: the same model');
});

test('bodies with no answer: not JSON is bad_body, no content array is no_choice', () => {
  const bad = A.classify(200, null, OPUS);
  assert.deepEqual([bad.kind, bad.reason, bad.info?.status], ['error', 'bad_body', 200]);
  for (const body of [{}, { content: 'text' }, 7, 'x', []]) {
    const r = A.classify(200, body, OPUS);
    assert.deepEqual([r.kind, r.reason], ['error', 'no_choice'], JSON.stringify(body));
    assert.deepEqual(checkResult(r), []);
  }
});

test('usage: nothing subtracted, the five-minute and one-hour writes split, geo and speed always set', () => {
  assert.deepEqual(mapUsage(message().usage, OPUS), { input: 900, output: 40, cacheRead: 0, cacheWrite: 4000, cacheWrite1h: 0, costUsd: null, model: OPUS, geo: 'global', speed: 'standard' });
  const split = mapUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3000, cache_creation_input_tokens: 700, cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 200 } }, OPUS);
  assert.deepEqual([split.input, split.cacheRead, split.cacheWrite, split.cacheWrite1h, split.geo, split.speed], [10, 3000, 500, 200, null, null]);
  // No split, or a split that does not add up: all of the total, unsplit.
  assert.deepEqual(['cacheWrite', 'cacheWrite1h'].map((k) => mapUsage({ input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 700 }, OPUS)[k]), [700, null]);
  assert.deepEqual(['cacheWrite', 'cacheWrite1h'].map((k) => mapUsage({ input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 700, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 100 } }, OPUS)[k]), [700, null]);
  // The split alone, with no total.
  assert.deepEqual(['cacheWrite', 'cacheWrite1h'].map((k) => mapUsage({ input_tokens: 1, output_tokens: 1, cache_creation: { ephemeral_5m_input_tokens: 9, ephemeral_1h_input_tokens: 1 } }, OPUS)[k]), [9, 1]);
  // Nothing written at all: zero, and no split to report.
  assert.deepEqual(['cacheRead', 'cacheWrite', 'cacheWrite1h'].map((k) => mapUsage({ input_tokens: 1, output_tokens: 1 }, OPUS)[k]), [0, 0, null]);
  assert.deepEqual(['cacheRead', 'cacheWrite'].map((k) => mapUsage({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: null, cache_creation_input_tokens: null }, OPUS)[k]), [0, 0]);
});

test('usage: an unreadable count is never read as 0', () => {
  for (const bad of ['5', -1, Number.NaN, Infinity, {}, null]) {
    const u = mapUsage({ input_tokens: bad, output_tokens: bad }, OPUS);
    assert.deepEqual([u.input, u.output], [null, null], String(bad));
  }
  assert.equal(mapUsage({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: '9' }, OPUS).cacheRead, null);
  assert.equal(mapUsage({ input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: -3 }, OPUS).cacheWrite, null);
  // A split that is there but cannot be read, and no total: the writes are unknown, not zero.
  assert.equal(mapUsage({ input_tokens: 1, output_tokens: 1, cache_creation: { ephemeral_5m_input_tokens: 'x', ephemeral_1h_input_tokens: 0 } }, OPUS).cacheWrite, null);
  assert.equal(mapUsage({ input_tokens: 1, output_tokens: 1, cache_creation: 'x' }, OPUS).cacheWrite, null);
  for (const none of [undefined, null, [], 'x']) assert.equal(mapUsage(none, OPUS), null, 'no usage is null, never free');
  // Geo and speed: short scalars or null, never the raw value.
  const odd = mapUsage({ input_tokens: 1, output_tokens: 1, inference_geo: `us ${SECRET} with spaces`, speed: { x: 1 } }, OPUS);
  assert.deepEqual([odd.geo, odd.speed], [null, null]);
  assert.deepEqual([mapUsage({ input_tokens: 1, output_tokens: 1, inference_geo: 'us', speed: 'fast' }, OPUS).geo, mapUsage({ input_tokens: 1, output_tokens: 1, speed: 'fast' }, OPUS).speed], ['us', 'fast'], 'control: real values pass');
  assert.equal(mapUsage({ input_tokens: 1, output_tokens: 1 }, `bad model ${SECRET}`).model, null);
});

test('errors: each row of the table, and never a refusal', () => {
  const table = [
    [402, errorBody('billing_error'), 'anthropic_credits'],
    [400, errorBody('invalid_request_error', 'Your credit balance is too low to access the Anthropic API.'), 'anthropic_credits'],
    [400, errorBody('invalid_request_error', 'You have reached your specified workspace API usage limits.'), 'anthropic_spend_limit'],
    [429, errorBody('rate_limit_error', SECRET, { details: { error_code: 'enforced_spend_limit_reached' } }), 'anthropic_spend_limit'],
    [403, errorBody('permission_error'), 'anthropic_permission'],
    [403, null, 'anthropic_permission'],
    [400, errorBody('invalid_request_error'), null],
    [401, errorBody('authentication_error'), null],
    [404, errorBody('not_found_error'), null],
    [413, errorBody('request_too_large'), null],
    [429, errorBody('rate_limit_error'), null],
    [500, errorBody('api_error'), null],
    [529, errorBody('overloaded_error'), null],
    [500, null, null],
  ];
  for (const [status, body, limitSource] of table) {
    const r = A.parseError(status, body);
    const label = `${status} ${body?.error?.type ?? 'no body'}`;
    assert.deepEqual([r.kind, r.reason], ['error', 'http'], label);
    assert.equal(r.info.limitSource, limitSource, label);
    assert.equal(r.info.status, status, label);
    assert.equal(r.info.error_type, body?.error?.type ?? null, label);
    assert.deepEqual([r.info.provider_name, r.info.provider_code], [null, null], label);
    assert.deepEqual(leaks(r), [], label);
    assert.deepEqual(checkResult(r), [], label);
  }
  // The prefixes are matched at the start only, and only on a 400.
  assert.equal(A.parseError(400, errorBody('invalid_request_error', `x Your credit balance is too low`)).info.limitSource, null);
  assert.equal(A.parseError(500, errorBody('api_error', 'You have reached your specified limit')).info.limitSource, null);
  // A 2xx carrying an error is provider_error, through classify too.
  assert.deepEqual([A.parseError(200, errorBody('api_error')).reason, A.classify(200, errorBody('api_error'), OPUS).reason], ['provider_error', 'provider_error']);
  // A billed error keeps its usage.
  assert.equal(A.parseError(500, { ...errorBody('api_error'), usage: { input_tokens: 10, output_tokens: 0 } }).usage.input, 10);
  // Positive control: the bodies did carry the text and the request id.
  assert.equal(JSON.stringify(errorBody('api_error')).includes(REQ_ID), true);
});

test('through the transport: the exact bytes and headers go out, 529 and 429 are not retried, a connect retry logs anthropic_retry', async () => {
  const calls = [];
  const logs = [];
  let script = [];
  const c = createChatClient({
    adapter: A,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const next = script.shift();
      if (next instanceof Error) throw next;
      return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } });
    },
    getKey: () => FAKE_ANTHROPIC_KEY,
    getBaseUrl: () => BASE,
    log: (event, data) => logs.push({ event, ...data }),
    retryDelayMs: 0,
  });
  const body = turn();
  const deadlineAt = Date.now() + 60000;

  script = [{ status: 200, body: message() }];
  const ok = await c.post(body, { deadlineAt });
  assert.equal(ok.kind, 'ok');
  assert.equal(calls[0].init.body, JSON.stringify(body));
  assert.ok(isDeepStrictEqual(calls[0].init.headers, A.request(FAKE_ANTHROPIC_KEY, BASE).headers));
  assert.equal(calls[0].init.redirect, 'error');

  for (const [status, type] of [[529, 'overloaded_error'], [429, 'rate_limit_error'], [500, 'api_error']]) {
    calls.length = 0;
    script = [{ status, body: errorBody(type) }, { status: 200, body: message() }];
    const r = await c.post(body, { deadlineAt, beforeRetry: async () => true });
    assert.deepEqual([r.kind, r.reason, calls.length], ['error', 'http', 1], String(status));
  }

  calls.length = 0;
  script = [new TypeError('fetch failed', { cause: Object.assign(new Error(`connect ECONNREFUSED ${SECRET}`), { code: 'ECONNREFUSED', syscall: 'connect' }) }), { status: 200, body: message() }];
  const retried = await c.post(body, { deadlineAt });
  assert.deepEqual([retried.kind, calls.length], ['ok', 2]);
  assert.deepEqual(logs, [{ event: 'anthropic_retry', attempt: 2, reason: 'connect' }]);
  assert.equal(JSON.stringify(logs).includes(SECRET), false);
  assert.equal(JSON.stringify([ok, retried]).includes(FAKE_ANTHROPIC_KEY), false, 'the Key never comes back in a Result');
});
