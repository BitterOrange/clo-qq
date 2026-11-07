// The Anthropic mock answers the real adapter in the shapes the adapter reads, refuses what the project must never
// send, keeps its leak markers where tests can look for them, and has no Key route. model-view reads requests of
// both mocks the same way. Loopback only; the Keys are fakes.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { anthropicAdapter } from '../../src/clo-plugin/lib/core/providers/anthropicAdapter.js';
import { createChatClient } from '../../src/clo-plugin/lib/core/providers/modelChat.js';
import { checkAnthropicModels } from '../../src/clo-plugin/lib/core/models.js';
import { checkResult } from '../fixtures/fake-adapter.mjs';
import { FAKE_ANTHROPIC_KEY, FAKE_OPENROUTER_KEY } from '../harness/fake-keys.mjs';
import { decisionText, ERROR_STEP_NAMES, REQUEST_ID_MARKER, startMockAnthropic, STOP_DETAILS_MARKER, THINKING_MARKER } from '../harness/mock-anthropic.mjs';
import { startMockOpenRouter } from '../harness/mock-openrouter.mjs';
import { keySent, testProvider, view } from '../harness/model-view.mjs';

const SCHEMA = { name: 'clo_decision', schema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'], additionalProperties: false } };
const turn = () => anthropicAdapter.turnBody({ model: 'claude-opus-5-5', effort: 'low', maxTokens: 3000, system: 'SYSTEMTEXT clo-policy:1', user: 'USERTEXT' });
const decisionBody = () => anthropicAdapter.decisionBody({ model: 'claude-haiku-5-5', effort: 'none', maxTokens: 200, system: 'DECIDE', user: '{"trigger":"name"}', schema: SCHEMA });
const LEAKS = [REQUEST_ID_MARKER, STOP_DETAILS_MARKER, THINKING_MARKER, 'STEPLEAK'];

let m;
let client;
before(async () => {
  m = await startMockAnthropic();
  client = createChatClient({ adapter: anthropicAdapter, getKey: () => FAKE_ANTHROPIC_KEY, getBaseUrl: () => m.base });
});
after(async () => {
  await m?.stop();
});

// A raw POST to the mock, for requests the adapter would never build.
async function raw(body, headers = {}) {
  const res = await fetch(`${m.base}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': FAKE_ANTHROPIC_KEY, 'anthropic-version': '2026-10-21', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('a turn and a decision from the real adapter: answered, classified ok, settled from tokens, and viewed', async () => {
  m.setScript(() => ({ text: '好的。', usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, cost: 9 }, thinking: 'internal' }));
  const r = await client.post(turn());
  assert.deepEqual(checkResult(r), []);
  assert.equal(r.kind, 'ok', JSON.stringify(r));
  assert.equal(r.message.content, '好的。', 'the thinking block is dropped');
  assert.deepEqual(r.usage, { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costUsd: null, model: 'claude-opus-5-5', geo: 'global', speed: 'standard' });

  const rec = m.agentRequests().at(-1);
  assert.equal(rec.rejected, null);
  assert.ok(keySent(rec, FAKE_ANTHROPIC_KEY), 'the Key went in x-api-key');
  assert.ok(!keySent(rec, FAKE_OPENROUTER_KEY), 'control: another Key does not match');
  assert.deepEqual(
    (({ kind, system, user, model, maxTokens, effort, decision, cacheMarkers, auth }) => ({ kind, system, user, model, maxTokens, effort, decision, cacheMarkers, auth }))(view(rec)),
    { kind: 'anthropic', system: 'SYSTEMTEXT clo-policy:1', user: 'USERTEXT', model: 'claude-opus-5-5', maxTokens: 3000, effort: 'low', decision: false, cacheMarkers: ['.system[0]'], auth: 'x-api-key' },
  );
  assert.equal(rec.headers['anthropic-beta'], undefined);
  assert.deepEqual(rec.reply.usage.input_tokens, 1000, 'the OpenRouter usage vocabulary maps onto Anthropic fields');

  m.setDecision(() => ({ text: decisionText({ action: 'reply' }) }));
  const d = await client.post(decisionBody());
  assert.equal(d.kind, 'ok');
  assert.equal(JSON.parse(d.message.content).action, 'reply');
  assert.equal(m.decisionRequests().length, 1, 'a decision is told apart by output_config.format');
  const dv = view(m.decisionRequests()[0]);
  assert.equal(dv.decision, true);
  assert.deepEqual(dv.thinking, { type: 'disabled' });
  assert.deepEqual(dv.schema, SCHEMA.schema);
  assert.equal(dv.system, 'DECIDE');
});

test('the mock refuses what the project must never send; the same request without it is answered', async () => {
  const ok = await raw(turn());
  assert.equal(ok.status, 200, 'positive control');
  const cases = [
    ['an Authorization header', turn(), { authorization: `Bearer ${FAKE_ANTHROPIC_KEY}` }, 400, 'authorization'],
    ['an anthropic-beta header', turn(), { 'anthropic-beta': 'fast-mode-2026-02-01' }, 400, 'beta'],
    ['no x-api-key', turn(), { 'x-api-key': '' }, 401, 'no_key'],
    ['no anthropic-version', turn(), { 'anthropic-version': '' }, 400, 'no_version'],
    ['stream: true', { ...turn(), stream: true }, {}, 400, 'stream'],
    ['fallbacks', { ...turn(), fallbacks: 'default' }, {}, 400, 'fallbacks'],
    ['a sampling parameter', { ...turn(), temperature: 0.2 }, {}, 400, 'temperature'],
    ['inference_geo', { ...turn(), inference_geo: 'global' }, {}, 400, 'inference_geo'],
    ['a field off the whitelist', { ...turn(), extra: 1 }, {}, 400, 'extra'],
    ['thinking disabled on Opus 5.5', { ...turn(), thinking: { type: 'disabled' } }, {}, 400, 'thinking_opus'],
    ['thinking disabled at effort max on Haiku 5.5', { ...decisionBody(), output_config: { effort: 'max', format: { type: 'json_schema', schema: SCHEMA.schema } } }, {}, 400, 'thinking_haiku'],
  ];
  for (const [label, body, headers, status, why] of cases) {
    const before_ = m.requests.length;
    const res = await raw(body, headers);
    assert.equal(res.status, status, label);
    assert.equal(res.body.type, 'error', label);
    assert.equal(m.requests.length, before_ + 1, `${label}: recorded`);
    assert.equal(m.requests.at(-1).rejected, why, label);
  }
  assert.equal(m.rejected().length, cases.length);
});

test('named error steps read through the adapter: each limit class, with no provider text in the Result', async () => {
  const expected = {
    credits402: [402, 'anthropic_credits'],
    credits400: [400, 'anthropic_credits'],
    spendLimit400: [400, 'anthropic_spend_limit'],
    enforced429: [429, 'anthropic_spend_limit'],
    permission403: [403, 'anthropic_permission'],
    rateLimit429: [429, null],
    overloaded529: [529, null],
    apiError500: [500, null],
    auth401: [401, null],
    notFound404: [404, null],
  };
  assert.deepEqual(Object.keys(expected).sort(), [...ERROR_STEP_NAMES].sort(), 'every named step is covered');
  for (const [name, [status, limitSource]] of Object.entries(expected)) {
    m.setScript(() => ({ [name]: 'STEPLEAK' }));
    const r = await client.post(turn());
    assert.deepEqual(checkResult(r), [], name);
    assert.equal(`${r.kind}/${r.reason}/${r.status}`, `error/http/${status}`, name);
    assert.equal(r.info.limitSource, limitSource, name);
    const text = JSON.stringify(r);
    for (const leak of LEAKS) assert.ok(!text.includes(leak), `${name}: ${leak} left the adapter`);
  }
  // Positive control: the markers are in what the mock sent, so their absence above means the adapter dropped them.
  m.setScript(() => ({ permission403: 'STEPLEAK' }));
  const res = await raw(turn());
  assert.ok(JSON.stringify(res.body).includes('STEPLEAK') && res.body.request_id.includes(REQUEST_ID_MARKER));
});

test('refusal, geo and speed shapes, and the routes beside messages', async () => {
  m.setScript(() => ({ refusal: 'STEPLEAK', usage: { prompt_tokens: 5, completion_tokens: 0 } }));
  const raw_ = await raw(turn());
  assert.equal(raw_.status, 200, 'a refusal is a 200');
  assert.equal(raw_.body.stop_reason, 'refusal');
  assert.ok(raw_.body.stop_details.explanation.includes(STOP_DETAILS_MARKER), 'positive control: the marker is in the answer');
  const r = await client.post(turn());
  assert.equal(`${r.kind}/${r.reason}`, 'refusal/refusal');
  for (const leak of LEAKS) assert.ok(!JSON.stringify(r).includes(leak), leak);

  m.setScript(() => ({ text: 'x', geoUs: true }));
  assert.equal((await client.post(turn())).usage.geo, 'us');
  m.setScript(() => ({ text: 'x', speedFast: true }));
  assert.equal((await client.post(turn())).usage.speed, 'fast');
  m.setScript(() => ({ text: 'x', geoMissing: true }));
  const missing = await client.post(turn());
  assert.equal(missing.usage.geo, null, 'an absent geo field reads as unknown, never as standard');
  assert.equal(missing.usage.speed, null);
  m.setScript(() => ({ text: 'x', usage: null }));
  assert.equal((await client.post(turn())).usage, null, 'no usage is never free');
  m.setScript(() => ({ text: 'x', model: 'claude-opus-5' }));
  assert.equal((await client.post(turn())).reason, 'model_mismatch');
  m.setScript(() => ({ text: 'x', finishReason: 'length' }));
  assert.equal((await client.post(turn())).finishReason, 'length');
  m.setScript(() => ({ text: '先查', toolCall: { name: 'exec', arguments: { cmd: 'STEPLEAK' } } }));
  assert.equal((await client.post(turn())).reason, 'tool_calls');

  // No Key route: an Anthropic Key must never be read at /key.
  assert.throws(() => m.setKey({ limit: 1 }), /no Key route/);
  const otherBefore = m.other.length;
  const keyRes = await fetch(`${m.base}/api/v1/key`, { headers: { authorization: 'Bearer x' } });
  assert.equal(keyRes.status, 404);
  assert.equal(m.other.length, otherBefore + 1);
  assert.equal(m.other.at(-1).url, '/api/v1/key');

  const models = [{ role: 'primary', id: 'claude-opus-5-5', effort: 'low', maxTokens: 3000 }, { role: 'decision', id: 'claude-haiku-5-5', effort: 'none', maxTokens: 200 }];
  const checked = await checkAnthropicModels({ fetch, baseUrl: m.base, key: FAKE_ANTHROPIC_KEY, models });
  assert.deepEqual(checked.problems, [], 'the default models pass the capability checks');
  assert.equal(m.modelReads.length, 2);
  assert.ok(m.modelReads.every((r) => r.headers['x-api-key'] === FAKE_ANTHROPIC_KEY));
  const { defaultModels } = await import('../harness/mock-anthropic.mjs');
  const weak = defaultModels();
  weak['claude-haiku-5-5'].capabilities.structured_outputs.supported = false;
  m.setModels(weak);
  const refused = await checkAnthropicModels({ fetch, baseUrl: m.base, key: FAKE_ANTHROPIC_KEY, models });
  assert.deepEqual(refused.problems, ['decision:capability_missing:structured_outputs']);
  m.setModels(defaultModels());
});

test('model-view reads an OpenRouter request into the same view, and CLO_TEST_PROVIDER is checked', async () => {
  const o = await startMockOpenRouter();
  try {
    const { createOpenRouterClient } = await import('../../src/clo-plugin/lib/core/openrouterChat.js');
    const { buildTurnRequest } = await import('../../src/clo-plugin/lib/core/turn.js');
    const eff = { models: { primary: { id: 'anthropic/claude-opus-5.5', effort: 'low', maxTokens: 3000, cacheRetention: 'short' } } };
    const body = buildTurnRequest(eff, 'SYSTEMTEXT clo-policy:1', { cls: 'at', msgTs: Date.now(), speakerLabel: 'm1', text: 'USERTEXT', history: [] });
    const c = createOpenRouterClient({ getKey: () => FAKE_OPENROUTER_KEY, getBaseUrl: () => o.base });
    assert.equal((await c.post(body)).kind, 'ok');
    const v = view(o.requests[0]);
    assert.equal(v.kind, 'openrouter');
    assert.equal(v.system, 'SYSTEMTEXT clo-policy:1');
    assert.equal(v.model, 'anthropic/claude-opus-5.5');
    assert.equal(v.auth, 'bearer');
    assert.ok(v.user.includes('USERTEXT'));
    assert.ok(keySent(o.requests[0], FAKE_OPENROUTER_KEY));
    assert.ok(!keySent(o.requests[0], FAKE_ANTHROPIC_KEY));
  } finally {
    await o.stop();
  }
  assert.equal(testProvider({}), 'openrouter');
  assert.equal(testProvider({ CLO_TEST_PROVIDER: 'anthropic' }), 'anthropic');
  assert.throws(() => testProvider({ CLO_TEST_PROVIDER: 'anthropc' }), /CLO_TEST_PROVIDER/);
});

test('OpenRouter cache counts move to their Anthropic fields: one script prices the same on both mocks', async () => {
  const { settleMicros } = await import('../../src/clo-plugin/lib/core/providers/cost.js');
  const { mapUsage } = await import('../../src/clo-plugin/lib/core/providers/openrouterAdapter.js');
  const price = { inputPerM: 5, outputPerM: 20, cacheReadPerM: 0.5, cacheWritePerM: 6.25, cacheWrite1hPerM: 10 };
  // smoke.test.mjs's usage: 4000 prompt tokens, 3600 of them five-minute cache writes, and 40 output tokens.
  const writes = { prompt_tokens: 4000, completion_tokens: 40, total_tokens: 4040, cost: 0.0234, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 3600 } };
  m.setScript(() => ({ text: 'x', usage: writes }));
  const w = await client.post(turn());
  assert.equal(w.kind, 'ok');
  assert.deepEqual(m.agentRequests().at(-1).reply.usage.cache_creation, { ephemeral_5m_input_tokens: 3600, ephemeral_1h_input_tokens: 0 });
  assert.deepEqual([w.usage.input, w.usage.cacheRead, w.usage.cacheWrite, w.usage.cacheWrite1h, w.usage.output], [400, 0, 3600, 0, 40]);
  // 400 x $5 + 3600 x $6.25 + 40 x $20, per million.
  assert.deepEqual(settleMicros(w.usage, price, { kind: 'anthropic' }), { micros: 25300, source: 'computed', flags: [] });
  // Positive control: the OpenRouter adapter reads the same usage to the same token split.
  const o = mapUsage(writes, 'anthropic/claude-opus-5.5');
  assert.deepEqual([o.input, o.cacheRead, o.cacheWrite, o.output], [400, 0, 3600, 40]);

  m.setScript(() => ({ text: 'x', usage: { prompt_tokens: 3000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 2000 } } }));
  const r = await client.post(turn());
  assert.deepEqual([r.usage.input, r.usage.cacheRead, r.usage.cacheWrite, r.usage.output], [1000, 2000, 0, 10], 'reads are priced at the read rate, not as input');
  // 1000 x $5 + 2000 x $0.5 + 10 x $20, per million.
  assert.equal(settleMicros(r.usage, price, { kind: 'anthropic' }).micros, 6200);

  // Anthropic-native keys in the step win, and a detail with no translation is an error, never dropped.
  m.setScript(() => ({ text: 'x', usage: { prompt_tokens: 1000, completion_tokens: 100, cache_read_input_tokens: 2000 } }));
  assert.deepEqual(((u) => [u.input, u.cacheRead])((await client.post(turn())).usage), [1000, 2000]);
  for (const bad of [{ prompt_tokens: 10, prompt_tokens_details: { audio_tokens: 1 } }, { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 11 } }, { prompt_tokens_details: { cache_write_tokens: 5 } }]) {
    m.setScript(() => ({ text: 'x', usage: bad }));
    const res = await raw(turn());
    assert.equal(res.status, 500, JSON.stringify(bad));
    assert.equal(m.requests.at(-1).rejected, 'bad_script', JSON.stringify(bad));
    assert.match(m.requests.at(-1).scriptError, /prompt_tokens/);
  }
});

test('a stack picks its provider only from its own option: CLO_TEST_PROVIDER never moves a file that has not opted in', async () => {
  const { stackKind } = await import('../harness/model-view.mjs');
  const saved = process.env.CLO_TEST_PROVIDER;
  process.env.CLO_TEST_PROVIDER = 'anthropic';
  try {
    assert.equal(testProvider(), 'anthropic', 'positive control: the run names anthropic');
    assert.equal(stackKind(testProvider()), 'anthropic', 'a file that opts in with provider: PROVIDER gets it');
    assert.equal(stackKind(undefined), 'openrouter', 'a file that does not stays on the OpenRouter wire shape it reads');
    assert.equal(stackKind('openrouter'), 'openrouter');
    assert.throws(() => stackKind('anthropc'), /provider must be one of/);
  } finally {
    if (saved === undefined) delete process.env.CLO_TEST_PROVIDER;
    else process.env.CLO_TEST_PROVIDER = saved;
  }
});
