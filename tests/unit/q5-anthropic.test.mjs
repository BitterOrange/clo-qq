// The Anthropic Q5 probe, offline. A fake fetch stands in for the Anthropic API: nothing here can reach the network,
// and every Key is a fake one. Each refusal is checked against a run that sends, in the same file.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { anthropicAdapter } from '../../src/clo-plugin/lib/core/providers/anthropicAdapter.js';
import { GEO_US_MULTIPLIER } from '../../src/clo-plugin/lib/core/providers/cost.js';
import { ANTHROPIC_VERSION } from '../../src/clo-plugin/lib/core/providers/registry.js';
import {
  buildPlan, createProbeFetch, DECISION_ID, DECISION_MAX_TOKENS, FIXED, main, parseCli, presendRefusal, PRIMARY_ID, PROBE_CAP_MICROS, PROBE_KEY_NAME,
  PROBE_MAX_TOKENS, printPlan, resolveEndpoint, RESULT_FILE, runProbe, sanitizeResult, TEST_BASE_ENV,
} from '../../src/tools/q5-anthropic.mjs';
import { cleanChildEnv } from '../harness/clean-env.mjs';
import { FAKE_ANTHROPIC_KEY, FAKE_ANTHROPIC_PROBE_KEY, FAKE_OPENROUTER_KEY } from '../harness/fake-keys.mjs';
import { ROOT } from './_cli-helper.mjs';

const BASE = 'http://127.0.0.1:9';
// Provider text that must never reach a result, a log line or the console.
const CANARY = 'CANARY-ANSWER-可洛不该落盘';
const LEAK = 'LEAK-PROVIDER-MESSAGE';
const REQUEST_ID = 'req_LEAKREQUESTID';

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
const tempDir = (label) => {
  const d = mkdtempSync(join(tmpdir(), `clo-q5a-${label}-`));
  dirs.push(d);
  return d;
};

const plan = buildPlan(ROOT);
// Float sums are rounded to a millionth of a micro-USD before rounding up, as cost.js does.
const ceilMicros = (x) => Math.ceil(Math.round(x * 1e6) / 1e6);

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const modelBody = (id) => ({
  type: 'model', id, max_tokens: 128000,
  capabilities: {
    effort: { low: { supported: true }, medium: { supported: true }, high: { supported: true } },
    structured_outputs: { supported: true },
    thinking: { types: { disabled: { supported: true }, adaptive: { supported: true } } },
  },
});
// Near the real shape: the cold turn writes the system text to the cache, the warm one reads it.
const turnUsage = (warm) => ({
  input_tokens: 40,
  output_tokens: 120,
  cache_read_input_tokens: warm ? 1500 : 0,
  cache_creation_input_tokens: warm ? 0 : 1500,
  cache_creation: { ephemeral_5m_input_tokens: warm ? 0 : 1500, ephemeral_1h_input_tokens: 0 },
  output_tokens_details: { thinking_tokens: 80 },
  inference_geo: 'global',
  speed: 'standard',
});
const DECISION_TEXT = JSON.stringify({ action: 'skip', skip_class: 'none', crisis: false, need_search: false });
const message = (body, { usage, text = CANARY, stop = 'end_turn', model = body.model } = {}) => ({
  id: 'msg_fake', type: 'message', role: 'assistant', model,
  content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text }],
  stop_reason: stop, stop_details: stop === 'refusal' ? { explanation: LEAK } : null,
  ...(usage === null ? {} : { usage }),
});
function defaultAnswer(body, n) {
  if (body.model === DECISION_ID) return json(200, message(body, { text: DECISION_TEXT, usage: { input_tokens: 900, output_tokens: 20, inference_geo: 'global', speed: 'standard' } }));
  return json(200, message(body, { usage: turnUsage(n > 1) }));
}

// The fake API. onPost(body, n) answers the n-th POST /v1/messages; onGet(id) a model read.
function fakeApi({ onPost = defaultAnswer, onGet = (id) => json(200, modelBody(id)) } = {}) {
  const seen = [];
  let posts = 0;
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    seen.push({ method: init.method ?? 'GET', origin: u.origin, path: u.pathname, headers: { ...init.headers }, body: init.body ?? null, url: String(url), redirect: init.redirect });
    const m = /^\/v1\/models\/([^/]+)$/.exec(u.pathname);
    if ((init.method ?? 'GET') === 'GET' && m) return onGet(decodeURIComponent(m[1]));
    if (init.method === 'POST' && u.pathname === '/v1/messages') {
      posts += 1;
      return onPost(JSON.parse(init.body), posts);
    }
    return json(404, { type: 'error', error: { type: 'not_found_error', message: LEAK } });
  };
  return { fetch, seen, posts: () => seen.filter((s) => s.method === 'POST') };
}

async function run(over = {}, apiOver = {}) {
  const api = over.api ?? fakeApi(apiOver);
  const dir = tempDir('run');
  const resultPath = join(dir, 'captures', 'q5-anthropic.jsonl');
  const out = [];
  const result = await runProbe({ plan, baseUrl: BASE, key: FAKE_ANTHROPIC_PROBE_KEY, maxUsd: 0.1, resultPath, say: (t) => out.push(t), fetchImpl: api.fetch, ...over.opts });
  const text = existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : '';
  const records = text.trim() ? text.trim().split('\n').map((l) => JSON.parse(l)) : [];
  return { ...result, api, out: out.join('\n'), text, records, calls: records.filter((r) => r.kind === 'call') };
}

const noLeak = (r) => {
  for (const s of [CANARY, LEAK, REQUEST_ID, FAKE_ANTHROPIC_PROBE_KEY, FAKE_ANTHROPIC_KEY, 'sk-ant-']) {
    assert.ok(!r.text.includes(s), `results hold ${s}`);
    assert.ok(!r.out.includes(s), `output holds ${s}`);
  }
};

// --- the plan and its bound ---

test('the plan: two Opus turns on one system text, then one Haiku decision, with the exact bodies the adapter builds', () => {
  assert.deepEqual(plan.calls.map((c) => [c.id, c.role]), [['turn_cold', 'primary'], ['turn_warm', 'primary'], ['decision', 'decision']]);
  assert.equal(plan.primaryId, 'claude-opus-5-5');
  assert.equal(plan.decisionId, 'claude-haiku-5-5');
  const [cold, warm, decision] = plan.calls.map((c) => c.body);
  for (const b of [cold, warm]) {
    assert.deepEqual(Object.keys(b).sort(), ['max_tokens', 'messages', 'model', 'output_config', 'system']);
    assert.equal(b.model, PRIMARY_ID);
    assert.equal(b.max_tokens, PROBE_MAX_TOKENS);
    // D9: no thinking field on Opus 5.5, effort is the control.
    assert.equal(b.thinking, undefined);
    assert.deepEqual(b.output_config, { effort: 'low' });
    assert.deepEqual(b.system, [{ type: 'text', text: plan.texts.system, cache_control: { type: 'ephemeral' } }]);
    assert.equal(JSON.stringify(b).split('cache_control').length - 1, 1, 'one cache_control');
  }
  assert.equal(cold.system[0].text, warm.system[0].text, 'the same system text, so the warm turn can read the cache');
  assert.equal(plan.texts.system, readFileSync(join(ROOT, 'persona', 'CONTENT-POLICY.md'), 'utf8'));
  assert.ok(cold.messages[0].content.includes(FIXED.turns[0]));
  assert.ok(warm.messages[0].content.includes(FIXED.turns[1]));
  // D9 on Haiku: thinking disabled, effort low.
  assert.deepEqual(decision.thinking, { type: 'disabled' });
  assert.equal(decision.output_config.effort, 'low');
  assert.equal(decision.output_config.format.type, 'json_schema');
  assert.equal(decision.max_tokens, DECISION_MAX_TOKENS);
  assert.equal(decision.system, plan.texts.decisionPrompt);
  assert.equal(JSON.parse(decision.messages[0].content).current.text, FIXED.decisionInput.current.text);
  for (const b of [cold, warm, decision]) {
    for (const k of ['stream', 'fallbacks', 'tools', 'tool_choice', 'speed', 'inference_geo', 'metadata', 'temperature']) assert.equal(b[k], undefined, k);
  }
});

test('the static bound includes the 1.1x US-only multiplier and stays at or below $0.10', () => {
  let sum = 0;
  for (const c of plan.calls) {
    const p = plan.prices[c.role];
    const preGeo = c.inputTokens * Math.max(p.inputPerM, p.cacheWritePerM) + c.maxTokens * p.outputPerM;
    assert.equal(c.inputTokens, Buffer.byteLength(JSON.stringify(c.body)) + c.overhead, `${c.id}: bytes plus the allowance`);
    assert.equal(c.preGeoMicros, Math.ceil(preGeo));
    assert.equal(c.boundMicros, ceilMicros(preGeo * GEO_US_MULTIPLIER), `${c.id}: x1.1`);
    sum += c.boundMicros;
  }
  assert.equal(plan.totalWorstMicros, sum);
  assert.ok(plan.totalWorstMicros > plan.totalPreGeoMicros);
  assert.ok(plan.totalWorstMicros <= PROBE_CAP_MICROS, `bound ${plan.totalWorstMicros}`);
  assert.equal(PROBE_CAP_MICROS, 100000);
  // Prices from the book, not guessed.
  const book = JSON.parse(readFileSync(join(ROOT, 'versions.lock.json'), 'utf8')).models.priceBooks.anthropic.models;
  assert.deepEqual(plan.prices.primary, book[PRIMARY_ID]);
  assert.deepEqual(plan.prices.decision, book[DECISION_ID]);
});

test('a plan whose bound passes $0.10 only once the 1.1x multiplier is in is refused', () => {
  // max_tokens 1200 fits under $0.10 before the multiplier and not after it.
  const loose = buildPlan(ROOT, { maxTokens: 1200, capMicros: 1e6 });
  assert.ok(loose.totalPreGeoMicros <= PROBE_CAP_MICROS, 'before the multiplier it would fit');
  assert.ok(loose.totalWorstMicros > PROBE_CAP_MICROS, 'with it, it does not');
  assert.throws(() => buildPlan(ROOT, { maxTokens: 1200 }), /above the agreed/);
  assert.doesNotThrow(() => buildPlan(ROOT), 'control: the default plan is within the cap');
});

test('the printed plan shows the arithmetic, the texts and the missing per-key limit', () => {
  const lines = [];
  printPlan(plan, (t) => lines.push(t));
  const out = lines.join('\n');
  for (const c of plan.calls) {
    assert.ok(out.includes(`${c.inputTokens} tokens x $`), c.id);
    assert.ok(out.includes(`x 1.1 = $${(c.boundMicros / 1e6).toFixed(6)}`), c.id);
  }
  assert.ok(out.includes(`(${plan.totalWorstMicros} micro-USD)`));
  assert.match(out, /Anthropic enforces no per-key daily limit/);
  assert.match(out, /--hard-cap-attested/);
  assert.ok(out.includes(plan.texts.system.trim().split('\n')[2]), 'the system text is printed');
  assert.ok(out.includes(FIXED.turns[0]) && out.includes(FIXED.turns[1]));
  assert.ok(out.includes(ANTHROPIC_VERSION));
});

test('runProbe refuses a --max-usd below the bound before anything is requested', async () => {
  const api = fakeApi();
  await assert.rejects(runProbe({ plan, baseUrl: BASE, key: FAKE_ANTHROPIC_PROBE_KEY, maxUsd: 0.05, resultPath: join(tempDir('cap'), 'r.jsonl'), say: () => {}, fetchImpl: api.fetch }), /above --max-usd/);
  assert.equal(api.seen.length, 0);
});

// --- a full run, the positive control for everything below ---

test('a clean run: two model reads, three posts, numbers only, cache read on the warm turn', async () => {
  const r = await run();
  assert.equal(r.stopReason, null, r.out);
  assert.deepEqual(r.requested, ['GET:/v1/models/claude-opus-5-5', 'GET:/v1/models/claude-haiku-5-5', 'POST:/v1/messages', 'POST:/v1/messages', 'POST:/v1/messages']);
  assert.equal(r.api.posts().length, 3);
  for (const s of r.api.seen) {
    assert.equal(s.origin, BASE);
    assert.equal(s.redirect, 'error');
    assert.equal(s.headers['x-api-key'], FAKE_ANTHROPIC_PROBE_KEY, 'positive control: the probe Key is in the header');
    assert.equal(s.headers['anthropic-version'], ANTHROPIC_VERSION);
    assert.ok(!Object.keys(s.headers).some((h) => /beta/i.test(h)));
    assert.ok(!s.url.includes(FAKE_ANTHROPIC_PROBE_KEY) && !(s.body ?? '').includes(FAKE_ANTHROPIC_PROBE_KEY), 'the Key only in a header');
  }
  for (const s of r.api.posts()) assert.equal(JSON.parse(s.body).stream, undefined);
  const [cold, warm, decision] = r.calls;
  assert.equal(cold.stop, 'end_turn');
  assert.equal(cold.modelMatches, true);
  assert.equal(cold.cacheWriteTokens, 1500);
  assert.equal(cold.thinkingTokens, 80);
  assert.equal(cold.thinkingBlocks, 1);
  assert.equal(cold.geo, 'global');
  assert.equal(cold.speed, 'standard');
  assert.ok(cold.usageKeys.includes('inference_geo') && cold.usageKeys.includes('speed'));
  assert.equal(cold.contentChars, CANARY.length, 'positive control: the answer was there');
  assert.equal(warm.cacheReadTokens, 1500);
  assert.equal(warm.cacheHit, true);
  assert.equal(decision.decisionValid, true);
  // Computed from tokens at the book price: cold = 40 x 4 + 1500 x 5 + 120 x 20 micro-USD.
  assert.equal(cold.countedUsd, (40 * 4 + 1500 * 5 + 120 * 20) / 1e6);
  assert.equal(warm.countedUsd, (40 * 4 + 1500 * 0.2 + 120 * 20) / 1e6);
  for (const c of r.calls) {
    assert.equal(c.usageMissing, false);
    assert.ok(c.countedUsd <= c.worstUsd);
    assert.equal(c.requests, 1);
  }
  assert.ok(r.records.some((x) => x.kind === 'measure' && x.name === 'warm_cache_read' && x.cacheHit === true));
  const summary = r.records.find((x) => x.kind === 'summary');
  assert.equal(summary.completed, true);
  assert.equal(summary.requested.length, 5, 'the requested list survives the result filter');
  noLeak(r);
});

test('a warm turn that reads nothing from the cache is recorded as a miss', async () => {
  const r = await run({}, {
    onPost: (body, n) => (n === 2 ? json(200, message(body, { usage: turnUsage(false) })) : defaultAnswer(body, n)),
  });
  assert.equal(r.calls[1].cacheHit, false);
  assert.match(r.out, /read nothing from the cache/);
});

test('a US-only answer is counted at 1.1x, flagged, and still within the bound', async () => {
  const r = await run({}, { onPost: (body, n) => json(200, message(body, { usage: { ...turnUsage(n > 1), inference_geo: 'us' }, text: body.model === DECISION_ID ? DECISION_TEXT : CANARY })) });
  assert.equal(r.stopReason, null, r.out);
  assert.equal(r.calls[0].geo, 'us');
  assert.deepEqual(r.calls[0].flags, ['geo_us']);
  assert.equal(r.calls[0].countedUsd, ceilMicros((40 * 4 + 1500 * 5 + 120 * 20) * 1.1) / 1e6);
});

// --- pre-send refusals: nothing leaves, nothing is counted ---

const withTurn = (f) => Object.freeze({ ...anthropicAdapter, turnBody: (s) => f(anthropicAdapter.turnBody(s)) });
const withDecision = (f) => Object.freeze({ ...anthropicAdapter, decisionBody: (s) => f(anthropicAdapter.decisionBody(s)) });
const withRequest = (f) => Object.freeze({ ...anthropicAdapter, request: (k, b) => f(anthropicAdapter.request(k, b)) });

const TAMPERS = [
  ['stream', withTurn((b) => ({ ...b, stream: false })), 'presend_stream'],
  ['server-side fallbacks', withTurn((b) => ({ ...b, fallbacks: 'default' })), 'presend_fallbacks'],
  ['tools', withTurn((b) => ({ ...b, tools: [] })), 'presend_tools'],
  ['a thinking field on Opus', withTurn((b) => ({ ...b, thinking: { type: 'adaptive' } })), 'presend_thinking'],
  ['inference_geo', withTurn((b) => ({ ...b, inference_geo: 'global' })), 'presend_fields'],
  ['speed', withTurn((b) => ({ ...b, speed: 'fast' })), 'presend_fields'],
  ['a cache ttl', withTurn((b) => ({ ...b, system: [{ ...b.system[0], cache_control: { type: 'ephemeral', ttl: '1h' } }] })), 'presend_cache_control'],
  ['a second cache_control', withTurn((b) => ({ ...b, system: [...b.system, { type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }] })), 'presend_cache_control'],
  ['another effort', withTurn((b) => ({ ...b, output_config: { effort: 'high' } })), 'presend_output_config'],
  ['another model', withTurn((b) => ({ ...b, model: 'claude-opus-5' })), 'presend_model'],
  ['more max_tokens', withTurn((b) => ({ ...b, max_tokens: 3000 })), 'presend_max_tokens'],
  ['a changed system text', withTurn((b) => ({ ...b, system: [{ ...b.system[0], text: `${b.system[0].text}x` }] })), 'presend_system_changed'],
  ['a changed user text', withTurn((b) => ({ ...b, messages: [{ role: 'user', content: `${b.messages[0].content}x` }] })), 'presend_messages'],
  ['a beta header', withRequest((r) => ({ ...r, headers: { ...r.headers, 'anthropic-beta': 'server-side-fallback-2026-07-01' } })), 'presend_beta_header'],
  ['an extra header', withRequest((r) => ({ ...r, headers: { ...r.headers, 'x-extra': '1' } })), 'presend_headers'],
  ['another API version', withRequest((r) => ({ ...r, headers: { ...r.headers, 'anthropic-version': '2023-06-01' } })), 'presend_headers'],
  ['another path', withRequest((r) => ({ ...r, url: r.url.replace('/v1/messages', '/v1/complete') })), 'presend_path'],
  ['another host', withRequest((r) => ({ ...r, url: 'http://127.0.0.2:9/v1/messages' })), 'presend_host'],
];

for (const [name, adapter, reason] of TAMPERS) {
  test(`pre-send: ${name} is refused before it leaves`, async () => {
    const r = await run({ opts: { factories: { adapter } } });
    assert.equal(r.stopReason, reason, r.out);
    assert.equal(r.api.posts().length, 0, 'the fake API saw no post');
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].requests, 0);
    assert.equal(r.calls[0].countedUsd, 0, 'nothing left, nothing counted');
    assert.ok(r.records.find((x) => x.kind === 'summary').refusedReasons.includes(reason));
    noLeak(r);
  });
}

test('pre-send: a decision with thinking on, or another effort, is refused after both turns went', async () => {
  for (const [adapter, reason] of [
    [withDecision((b) => ({ ...b, thinking: { type: 'adaptive' } })), 'presend_thinking'],
    [withDecision((b) => ({ ...b, output_config: { ...b.output_config, effort: 'high' } })), 'presend_output_config'],
    [withDecision((b) => ({ ...b, system: [{ type: 'text', text: b.system, cache_control: { type: 'ephemeral' } }] })), 'presend_cache_control'],
  ]) {
    const r = await run({ opts: { factories: { adapter } } });
    assert.equal(r.stopReason, reason, r.out);
    assert.equal(r.api.posts().length, 2, 'control: the turns went');
    assert.equal(r.calls[2].requests, 0);
  }
});

test('presendRefusal accepts the planned body and refuses every field it does not list', () => {
  for (const c of plan.calls) {
    assert.equal(presendRefusal(c.body, { call: c, plan, expected: c.body }), null, `control: ${c.id}`);
    assert.equal(presendRefusal({ ...c.body, metadata: { user_id: 'x' } }, { call: c, plan, expected: c.body }), 'presend_fields');
    assert.equal(presendRefusal({ ...c.body, temperature: 1 }, { call: c, plan, expected: c.body }), 'presend_fields');
    assert.equal(presendRefusal(null, { call: c, plan, expected: c.body }), 'presend_unreadable');
  }
});

// --- the guard: only the planned paths, only in their phase ---

test('the guard refuses /key, other paths and anything out of a phase, before the request leaves', async () => {
  const api = fakeApi();
  const g = createProbeFetch({ http: api.fetch, baseUrl: BASE, key: FAKE_ANTHROPIC_PROBE_KEY, plan });
  const headers = { 'x-api-key': FAKE_ANTHROPIC_PROBE_KEY, 'anthropic-version': ANTHROPIC_VERSION };
  await assert.rejects(g.fetch(`${BASE}/v1/messages`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(plan.calls[0].body) }), /refused/);
  g.models();
  for (const path of ['/api/v1/key', '/v1/key', '/v1/models', '/v1/models/claude-opus-5', '/v1/organizations/usage_report/messages']) {
    await assert.rejects(g.fetch(`${BASE}${path}`, { method: 'GET', headers }), /refused/, path);
  }
  await assert.rejects(g.fetch(`https://openrouter.ai/api/v1/key`, { method: 'GET', headers }), /refused/);
  assert.equal(api.seen.length, 0, 'nothing reached the fake API');
  const ok = await g.fetch(`${BASE}/v1/models/${PRIMARY_ID}`, { method: 'GET', headers });
  assert.equal(ok.status, 200, 'control: a planned model read goes');
  assert.equal(api.seen.length, 1);
  assert.deepEqual(g.refusedHosts(), ['openrouter.ai']);
  g.disarm();
});

test('one request per call: a second post in the same call is refused', async () => {
  const api = fakeApi();
  const g = createProbeFetch({ http: api.fetch, baseUrl: BASE, key: FAKE_ANTHROPIC_PROBE_KEY, plan });
  const call = plan.calls[0];
  const slot = { call, expected: call.body, requests: 0, refused: 0, refusedReason: null };
  g.arm(slot);
  const init = { method: 'POST', headers: { 'x-api-key': FAKE_ANTHROPIC_PROBE_KEY, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' }, body: JSON.stringify(call.body) };
  assert.equal((await g.fetch(`${BASE}/v1/messages`, init)).status, 200, 'control: the first post goes');
  await assert.rejects(g.fetch(`${BASE}/v1/messages`, init), /refused/);
  assert.equal(api.posts().length, 1);
  assert.equal(slot.refusedReason, 'call_limit');
});

// --- answers that stop the run ---

test('a connect failure is not retried and counts nothing', async () => {
  let attempts = 0;
  const api = fakeApi();
  const fetch = async (url, init) => {
    if (init?.method === 'POST') {
      attempts += 1;
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', syscall: 'connect' } });
    }
    return api.fetch(url, init);
  };
  const r = await run({ api: { fetch, seen: api.seen, posts: () => [] } });
  assert.equal(r.stopReason, 'not_sent_connect');
  assert.equal(attempts, 1, 'one attempt, no retry');
  assert.equal(r.calls[0].countedUsd, 0);
  assert.equal(r.totals.totalMicros, 0);
});

test('an HTTP error stops the run, sends nothing more, and counts at the bound', async () => {
  const r = await run({}, { onPost: () => json(500, { type: 'error', error: { type: 'api_error', message: LEAK }, request_id: REQUEST_ID }) });
  assert.equal(r.stopReason, 'http_500');
  assert.equal(r.api.posts().length, 1, 'no second request after an HTTP error');
  assert.equal(r.calls[0].errorType, 'api_error');
  assert.equal(r.calls[0].usageMissing, true);
  assert.equal(r.calls[0].countedUsd, plan.calls[0].boundMicros / 1e6, 'no usage: counted at the bound');
  noLeak(r);
});

test('a 403 permission_error pauses the probe as anthropic_permission and is never a refusal', async () => {
  const r = await run({}, { onPost: () => json(403, { type: 'error', error: { type: 'permission_error', message: LEAK }, request_id: REQUEST_ID }) });
  assert.equal(r.stopReason, 'anthropic_permission');
  assert.equal(r.calls[0].class, 'error');
  assert.equal(r.calls[0].limitSource, 'anthropic_permission');
  assert.equal(r.calls[0].errorType, 'permission_error');
  assert.equal(r.calls[0].httpStatus, 403);
  assert.equal(r.api.posts().length, 1);
  noLeak(r);
});

test('a refusal (HTTP 200, stop_reason refusal) stops the run and is counted from its usage', async () => {
  const r = await run({}, { onPost: (body) => json(200, { ...message(body, { stop: 'refusal', usage: { input_tokens: 1540, output_tokens: 0 } }), content: [] }) });
  assert.equal(r.stopReason, 'refusal');
  assert.equal(r.calls[0].class, 'refusal');
  assert.equal(r.calls[0].stop, 'refusal');
  assert.equal(r.calls[0].usageMissing, false);
  // The answer names no geo, so it is priced as US-only, as the bound is.
  assert.deepEqual(r.calls[0].flags, ['geo_unknown']);
  assert.equal(r.calls[0].countedUsd, ceilMicros(1540 * 4 * 1.1) / 1e6);
  assert.equal(r.api.posts().length, 1);
  noLeak(r);
});

test('an answer with no usage is counted at its bound, never as free, and stops the run', async () => {
  const r = await run({}, { onPost: (body) => json(200, message(body, { usage: null })) });
  assert.equal(r.stopReason, 'usage_missing');
  assert.equal(r.calls[0].usageMissing, true);
  assert.equal(r.calls[0].countedUsd, plan.calls[0].boundMicros / 1e6);
  assert.equal(r.totals.missingCount, 1);
  assert.equal(r.api.posts().length, 1);
});

test('a breach of what the bound rests on stops the run before the next call', async () => {
  const cases = [
    [{ ...turnUsage(false), output_tokens: PROBE_MAX_TOKENS + 1 }, 'completion_above_bound'],
    [{ ...turnUsage(false), input_tokens: plan.calls[0].inputTokens }, 'prompt_above_bound'],
    [{ ...turnUsage(false), speed: 'fast' }, 'speed_unexpected'],
    [{ ...turnUsage(false), cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1500 } }, 'cache_1h_unexpected'],
  ];
  for (const [usage, reason] of cases) {
    const r = await run({}, { onPost: (body) => json(200, message(body, { usage })) });
    assert.equal(r.stopReason, reason, reason);
    assert.equal(r.api.posts().length, 1, reason);
  }
});

test('a model that answers under another id stops the run', async () => {
  const r = await run({}, { onPost: (body) => json(200, message(body, { usage: turnUsage(false), model: 'claude-opus-5' })) });
  assert.equal(r.stopReason, 'model_mismatch');
  assert.equal(r.calls[0].modelMatches, false);
});

test('the model check: a 401 stops before any post; an unknown capability path is recorded, not a stop', async () => {
  const denied = await run({}, { onGet: () => json(401, { type: 'error', error: { type: 'authentication_error', message: LEAK } }) });
  assert.equal(denied.stopReason, 'model_check_http_401');
  assert.equal(denied.api.posts().length, 0);
  noLeak(denied);
  const unknown = await run({}, { onGet: (id) => json(200, { ...modelBody(id), capabilities: { ...modelBody(id).capabilities, thinking: {} } }) });
  assert.equal(unknown.stopReason, null, 'control: the probe exists to confirm that path');
  assert.ok(unknown.records.some((x) => x.kind === 'model_check' && (x.problems ?? []).includes('decision:capability_unknown:thinking_disabled')));
  assert.equal(unknown.api.posts().length, 3);
});

test('the result filter keeps listed numbers and classes only', () => {
  const kept = sanitizeResult({ kind: 'call', countedUsd: 0.1, reason: 'has space', note: 'x', errorType: FAKE_ANTHROPIC_PROBE_KEY, flags: ['geo_us', CANARY], caps: { effort: true, text: 'x' } });
  assert.deepEqual(kept, { kind: 'call', countedUsd: 0.1, flags: ['geo_us'], caps: { effort: true } });
});

// --- the command line and the Key ---

function cliRoot(label, envText = null) {
  const root = tempDir(label);
  if (envText !== null) writeFileSync(join(root, '.env'), envText);
  return root;
}
async function cli(argv, { root, env = {}, fetchImpl = fakeApi().fetch } = {}) {
  const out = [];
  const err = [];
  const code = await main(argv, {
    env: { CLO_TEST_ROOT: root, [TEST_BASE_ENV]: BASE, ...env },
    stdout: { write: (t) => out.push(t) },
    stderr: { write: (t) => err.push(t) },
    fetchImpl,
  });
  return { code, out: out.join(''), err: err.join('') };
}
const BOTH_KEYS = `${PROBE_KEY_NAME}=${FAKE_ANTHROPIC_PROBE_KEY}\nCLO_ANTHROPIC_API_KEY=${FAKE_ANTHROPIC_KEY}\nCLO_CHAT_API_KEY=${FAKE_OPENROUTER_KEY}\n`;
const APPROVED = ['--approve', '--max-usd', '0.10', '--hard-cap-attested'];

test('parseCli takes no free text', () => {
  assert.deepEqual(parseCli(APPROVED), { approve: true, maxUsd: 0.1, hardCapAttested: true });
  assert.ok(parseCli(['hello']).error);
  assert.ok(parseCli(['--max-usd', '-1']).error);
});

test('without --approve the plan is printed and nothing is requested', async () => {
  const api = fakeApi();
  const r = await cli([], { root: cliRoot('plain', BOTH_KEYS), fetchImpl: api.fetch });
  assert.equal(r.code, 0);
  assert.match(r.out, /no request was made and \.env was not read/);
  assert.equal(api.seen.length, 0);
});

test('refusals before any request: no --max-usd, a cap below the bound, no hard-cap attestation, a proxy, no Key, a Key of another kind', async () => {
  const cases = [
    [['--approve'], BOTH_KEYS, {}, /--max-usd/],
    [['--approve', '--max-usd', '0.05', '--hard-cap-attested'], BOTH_KEYS, {}, /above --max-usd/],
    [['--approve', '--max-usd', '0.10'], BOTH_KEYS, {}, /no per-key daily limit[\s\S]*--hard-cap-attested/],
    [APPROVED, BOTH_KEYS, { HTTPS_PROXY: 'http://127.0.0.1:1' }, /proxy/],
    [APPROVED, `CLO_ANTHROPIC_API_KEY=${FAKE_ANTHROPIC_KEY}\n`, {}, new RegExp(`${PROBE_KEY_NAME} is empty`)],
    [APPROVED, `${PROBE_KEY_NAME}=${FAKE_OPENROUTER_KEY}\n`, {}, /does not look like an Anthropic Key/],
  ];
  for (const [argv, envText, env, pattern] of cases) {
    const api = fakeApi();
    const r = await cli(argv, { root: cliRoot('refuse', envText), env, fetchImpl: api.fetch });
    assert.equal(r.code, 2, `${argv.join(' ')}: ${r.err}`);
    assert.match(r.err, pattern);
    assert.equal(api.seen.length, 0, 'nothing was requested');
    for (const k of [FAKE_ANTHROPIC_PROBE_KEY, FAKE_ANTHROPIC_KEY, FAKE_OPENROUTER_KEY]) assert.ok(!`${r.out}${r.err}`.includes(k));
  }
});

test('the endpoint is fixed outside test mode, and a loopback mock inside it', () => {
  assert.deepEqual(resolveEndpoint({}), { baseUrl: 'https://api.anthropic.com', testMode: false });
  assert.throws(() => resolveEndpoint({ [TEST_BASE_ENV]: BASE }), /only allowed in test mode/);
  assert.throws(() => resolveEndpoint({ CLO_TEST_ROOT: 'x', [TEST_BASE_ENV]: 'https://api.anthropic.com' }), /loopback/);
  assert.deepEqual(resolveEndpoint({ CLO_TEST_ROOT: 'x', [TEST_BASE_ENV]: BASE }), { baseUrl: BASE, testMode: true });
});

test('key isolation: only the probe Key is read, sent only in its header, and never printed or recorded', async () => {
  const root = cliRoot('keys', BOTH_KEYS);
  const api = fakeApi();
  const r = await cli(APPROVED, { root, fetchImpl: api.fetch });
  assert.equal(r.code, 0, r.err);
  assert.equal(api.seen.length, 5);
  const resultText = readFileSync(join(root, RESULT_FILE), 'utf8');
  for (const s of api.seen) {
    assert.equal(s.headers['x-api-key'], FAKE_ANTHROPIC_PROBE_KEY, 'positive control: the probe Key reached the header');
    const wire = `${s.url}${s.body ?? ''}${JSON.stringify(Object.entries(s.headers).filter(([h]) => h !== 'x-api-key'))}`;
    for (const k of [FAKE_ANTHROPIC_PROBE_KEY, FAKE_ANTHROPIC_KEY, FAKE_OPENROUTER_KEY]) assert.ok(!wire.includes(k), 'no Key outside the one header');
  }
  for (const k of [FAKE_ANTHROPIC_PROBE_KEY, FAKE_ANTHROPIC_KEY, FAKE_OPENROUTER_KEY, CANARY]) {
    assert.ok(!r.out.includes(k) && !r.err.includes(k), 'console');
    assert.ok(!resultText.includes(k), 'results');
  }
  assert.ok(resultText.includes('"kind":"summary"'), 'positive control: results were written');
});

// --- the wrapper ---

const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
function ps(args, root) {
  return spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-File', join(ROOT, 'scripts', 'q5-anthropic.ps1'), ...args], {
    cwd: tmpdir(),
    env: cleanChildEnv({ CLO_TEST_ROOT: root, [TEST_BASE_ENV]: BASE, PSModulePath: process.env.PSModulePath }),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
  });
}

test('the wrapper is ASCII with LF, uses the private Node, and carries output and exit codes', () => {
  const bytes = readFileSync(join(ROOT, 'scripts', 'q5-anthropic.ps1'));
  assert.ok(bytes.every((b) => b < 128), 'ASCII');
  assert.ok(!bytes.includes(13), 'LF only');
  const src = bytes.toString();
  assert.ok(src.includes('_env.ps1') && src.includes('$NodeExe'));
  const root = cliRoot('ps');
  mkdirSync(join(root, '.runtime'), { recursive: true });
  const plain = ps([], root);
  assert.equal(plain.status, 0, plain.stderr);
  assert.ok(plain.stdout.includes(FIXED.turns[0]), 'UTF-8 survives the pipe');
  assert.match(plain.stdout, /no request was made/);
  const noCap = ps(['-Approve'], root);
  assert.equal(noCap.status, 2);
  assert.match(`${noCap.stdout}${noCap.stderr}`, /--max-usd/);
  const noAttest = ps(['-Approve', '-MaxUsd', '0.10'], root);
  assert.equal(noAttest.status, 2);
  assert.match(noAttest.stderr, /hard-cap-attested/);
  const noKey = ps(['-Approve', '-MaxUsd', '0.10', '-HardCapAttested'], root);
  assert.equal(noKey.status, 2, 'control: with every flag it reaches the Key, which this root has not');
  assert.match(noKey.stderr, /is empty in \.env/);
});
