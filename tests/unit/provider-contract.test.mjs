// The provider contract, run as one table over both adapters through the one transport (providers/modelChat.js):
// classification, a billed error keeping its usage, thrown fetch errors carrying no text, exactly one connect retry and
// never one after an HTTP status, redirects refused, aborts, and nothing sent without a Key or a base URL.
// Stubbed fetch, plus one loopback server for the redirect. No real provider, no QQ.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createOpenRouterClient } from '../../src/clo-plugin/lib/core/openrouterChat.js';
import { anthropicAdapter } from '../../src/clo-plugin/lib/core/providers/anthropicAdapter.js';
import { adapterFor } from '../../src/clo-plugin/lib/core/providers/index.js';
import { createChatClient } from '../../src/clo-plugin/lib/core/providers/modelChat.js';
import { openrouterAdapter } from '../../src/clo-plugin/lib/core/providers/openrouterAdapter.js';
import { MODEL_ID_RULES } from '../../src/clo-plugin/lib/core/providers/registry.js';
import { checkResult } from '../fixtures/fake-adapter.mjs';
import { DECISION_CASES, DECISION_PROMPT, SYSTEM, TURN_CASES } from '../fixtures/provider-golden/cases.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const SECRET = 'PROVIDER-SECRET-TEXT';
const KEY = 'CONTRACT-FAKE-KEY';
const json = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const connectError = (code = 'ECONNREFUSED') => new TypeError('fetch failed', { cause: Object.assign(new Error(`connect ${code} ${SECRET}`), { code, syscall: 'connect' }) });
const roomy = () => Date.now() + 60000;

// Each kind's wire format for the same situations, and what its adapter must make of them.
const KINDS = {
  openrouter: {
    adapter: openrouterAdapter,
    base: 'http://127.0.0.1:9/api/v1',
    path: '/chat/completions',
    keyHeader: ['Authorization', `Bearer ${KEY}`],
    model: 'anthropic/fake-opus',
    body: (model) => ({ model, messages: [{ role: 'user', content: 'x' }] }),
    answer: ({ text = '好的。', finish = 'stop', model, refusal = null, tools = 0, usage = true } = {}) => ({
      id: 'gen-1', model,
      choices: [{ finish_reason: finish, message: { role: 'assistant', content: text, refusal, ...(tools ? { tool_calls: [{ id: 't', function: { name: 'x', arguments: SECRET } }] } : {}) } }],
      ...(usage ? { usage: { prompt_tokens: 1200, completion_tokens: 40, cost: 0.0123, prompt_tokens_details: { cached_tokens: 1000, cache_write_tokens: 150 } } } : {}),
    }),
    refusal: (model) => KINDS.openrouter.answer({ model, text: null, refusal: SECRET }),
    otherFinish: 'weird_stop',
    noAnswer: () => ({ choices: [], usage: { cost: 0.001 } }),
    error: (status, extra = {}) => ({ error: { code: status, type: 'moderation', message: SECRET, metadata: { provider_name: 'FakeProv', raw: SECRET } }, ...extra }),
    billedUsage: { cost: 0.002, prompt_tokens: 10 },
    // A 403 without a Key limit is OpenRouter's moderation; on Anthropic it is never a refusal.
    forbidden: { kind: 'refusal', reason: 'moderation', limitSource: null },
  },
  anthropic: {
    adapter: anthropicAdapter,
    base: 'http://127.0.0.1:9',
    path: '/v1/messages',
    keyHeader: ['x-api-key', KEY],
    model: 'claude-opus-5-5',
    body: (model) => anthropicAdapter.turnBody({ model, effort: 'low', maxTokens: 3000, system: SYSTEM, user: 'x' }),
    answer: ({ text = '好的。', finish = 'end_turn', model, tools = 0, usage = true } = {}) => ({
      id: 'msg_1', type: 'message', role: 'assistant', model,
      content: [
        { type: 'thinking', thinking: SECRET, signature: 'sig' },
        ...(text === null ? [] : [{ type: 'text', text }]),
        ...(tools ? [{ type: 'tool_use', id: 'tu', name: 'x', input: { q: SECRET } }] : []),
      ],
      stop_reason: tools ? 'tool_use' : finish,
      stop_details: null,
      ...(usage ? { usage: { input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 4000, cache_creation: { ephemeral_5m_input_tokens: 4000, ephemeral_1h_input_tokens: 0 }, inference_geo: 'global', speed: 'standard' } } : {}),
    }),
    refusal: (model) => ({ ...KINDS.anthropic.answer({ model, text: null, finish: 'refusal' }), stop_details: { type: 'refusal', category: 'cyber', explanation: SECRET } }),
    otherFinish: 'pause_turn',
    noAnswer: () => ({ id: 'msg_1', type: 'message', usage: { input_tokens: 5, output_tokens: 0 } }),
    error: (status, extra = {}) => ({ type: 'error', error: { type: 'api_error', message: SECRET }, request_id: 'req_SECRET_ID', ...extra }),
    billedUsage: { input_tokens: 10, output_tokens: 3 },
    forbidden: { kind: 'error', reason: 'http', limitSource: 'anthropic_permission' },
  },
};
const FINISH = { openrouter: { length: 'length' }, anthropic: { length: 'max_tokens' } };

function client(kind, { respond, key = KEY, baseUrl = KINDS[kind].base, ...over } = {}) {
  const calls = [];
  const logs = [];
  const c = createChatClient({
    adapter: KINDS[kind].adapter,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return respond(url, init, calls.length);
    },
    getKey: () => key,
    getBaseUrl: () => baseUrl,
    log: (event, data) => logs.push({ event, ...data }),
    retryDelayMs: 0,
    ...over,
  });
  return { c, calls, logs };
}

const bothKinds = Object.keys(KINDS);

test('adapterFor gives the one adapter of each kind and refuses any other', () => {
  assert.equal(adapterFor('openrouter'), openrouterAdapter);
  assert.equal(adapterFor('anthropic'), anthropicAdapter);
  for (const bad of ['fake', 'constructor', '__proto__', 'toString', '', null, undefined, 1]) assert.throws(() => adapterFor(bad), TypeError, String(bad));
  for (const kind of bothKinds) {
    const a = adapterFor(kind);
    assert.equal(a.kind, kind);
    assert.equal(a.idRule, MODEL_ID_RULES[kind]);
    assert.equal(a.retryEvent, `${kind}_retry`);
    assert.ok(Object.isFrozen(a));
  }
});

test('the adapters are pure: they import the registry only and never name fetch', () => {
  // Comments may say "no fetch"; the code may not.
  const codeOf = (file) => readFileSync(join(ROOT, 'src', 'clo-plugin', 'lib', 'core', 'providers', file), 'utf8').replace(/\/\/.*$/gm, '');
  for (const file of ['openrouterAdapter.js', 'anthropicAdapter.js']) {
    const code = codeOf(file);
    const imports = [...code.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    assert.deepEqual(imports, ['./registry.js'], file);
    assert.equal(/\bfetch\b/.test(code), false, file);
    assert.equal(/\bawait\b|\bsetTimeout\b|process\./.test(code), false, file);
  }
  // Positive control: the transport imports nothing and does use fetch.
  const chat = codeOf('modelChat.js');
  assert.equal(/\bfetch\(/.test(chat), true);
  assert.deepEqual([...chat.matchAll(/^import .* from '([^']+)';$/gm)], []);
});

test('the OpenRouter shim is the transport with the OpenRouter adapter, which options cannot replace', async () => {
  const c = createOpenRouterClient({ adapter: anthropicAdapter, fetch: async () => json({}), getKey: () => KEY, getBaseUrl: () => KINDS.openrouter.base });
  assert.equal(c.adapter, openrouterAdapter);
  assert.equal(client('anthropic', { respond: () => json({}) }).c.adapter, anthropicAdapter, 'control: the transport takes the adapter it is given');
  assert.throws(() => createChatClient({ getKey: () => KEY, getBaseUrl: () => 'x' }), TypeError);
});

for (const kind of bothKinds) {
  const K = KINDS[kind];
  const body = K.body(K.model);

  test(`${kind}: the request goes to its path with its Key header only, the body unchanged, redirects refused`, async () => {
    const k = client(kind, { respond: () => json(K.answer({ model: K.model })) });
    const r = await k.c.post(body);
    assert.equal(r.kind, 'ok');
    assert.equal(k.calls.length, 1);
    const { url, init } = k.calls[0];
    assert.equal(url, `${K.base}${K.path}`);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.body, JSON.stringify(body));
    // Compared, never printed, even on failure.
    assert.ok(init.headers[K.keyHeader[0]] === K.keyHeader[1]);
    // The Key is in its header and nowhere else.
    const rest = { ...init.headers };
    delete rest[K.keyHeader[0]];
    assert.equal(JSON.stringify(rest).includes(KEY), false);
    assert.equal(url.includes(KEY), false);
    assert.equal(init.body.includes(KEY), false);
    assert.equal(JSON.stringify(r).includes(KEY), false);
  });

  test(`${kind}: every response shape is classified to the contract`, async () => {
    const m = K.model;
    const table = [
      ['ok', json(K.answer({ model: m })), 'ok', null],
      ['length', json(K.answer({ model: m, finish: FINISH[kind].length })), 'ok', null],
      ['refusal at 200', json(K.refusal(m)), 'refusal', 'refusal'],
      ['tool calls', json(K.answer({ model: m, tools: 1 })), 'error', 'tool_calls'],
      ['other finish', json(K.answer({ model: m, finish: K.otherFinish })), 'error', 'finish_reason'],
      ['model mismatch', json(K.answer({ model: kind === 'openrouter' ? 'openai/other' : 'claude-haiku-5-5' })), 'error', 'model_mismatch'],
      ['no answer', json(K.noAnswer()), 'error', 'no_choice'],
      ['not JSON at 200', json(`not json ${SECRET}`), 'error', 'bad_body'],
      ['2xx carrying an error', json(K.error(502)), 'error', 'provider_error'],
      ['400', json(K.error(400), 400), 'error', 'http'],
      ['403', json(K.error(403), 403), K.forbidden.kind, K.forbidden.reason],
      ['429', json(K.error(429), 429), 'error', 'http'],
      ['500 not JSON', json(`<html>${SECRET}</html>`, 500), 'error', 'http'],
      ['529', json(K.error(529), 529), 'error', 'http'],
    ];
    for (const [label, response, kindOut, reason] of table) {
      const k = client(kind, { respond: () => response.clone() });
      const r = await k.c.post(body, { deadlineAt: roomy() });
      assert.equal(r.kind, kindOut, label);
      assert.equal(r.reason, reason, label);
      assert.deepEqual(checkResult(r), [], label);
      assert.equal(k.calls.length, 1, `${label}: never retried`);
      assert.equal(JSON.stringify(r).includes(SECRET), false, `${label}: no provider text`);
      assert.equal(JSON.stringify(r).includes('req_SECRET_ID'), false, `${label}: no request id`);
      if (r.info) assert.equal(r.info.status, r.status, label);
    }
    // Positive control: the responses did carry the text the Results leave out.
    assert.equal((await json(K.refusal(m)).text()).includes(SECRET), true);
    assert.equal((await json(K.error(400), 400).text()).includes(SECRET), true);
    const ok = await client(kind, { respond: () => json(K.answer({ model: m, text: '可洛。' })) }).c.post(body);
    assert.equal(ok.message.content, '可洛。');
    assert.equal(ok.finishReason, 'stop');
    assert.equal(ok.message.refusal, false);
    assert.equal(ok.message.toolCalls, 0);
  });

  test(`${kind}: the 403 rule of this kind`, async () => {
    const r = await client(kind, { respond: () => json(K.error(403), 403) }).c.post(body);
    assert.equal(r.kind, K.forbidden.kind);
    assert.equal(r.reason, K.forbidden.reason);
    assert.equal(r.info.limitSource, K.forbidden.limitSource);
  });

  test(`${kind}: a billed error keeps its usage, so it is not booked as free`, async () => {
    const billed = await client(kind, { respond: () => json(K.error(500, { usage: K.billedUsage }), 500) }).c.post(body);
    assert.equal(billed.kind, 'error');
    assert.notEqual(billed.usage, null);
    const bare = await client(kind, { respond: () => json(K.error(500), 500) }).c.post(body);
    assert.equal(bare.usage, null, 'control: an error without usage carries none');
  });

  test(`${kind}: a thrown fetch error never carries its text out`, async () => {
    const k = client(kind, { respond: () => { throw new Error(`ECONNRESET ${SECRET}`); } });
    const r = await k.c.post(body, { deadlineAt: roomy() });
    assert.equal(r.kind, 'error');
    assert.equal(r.reason, 'network');
    assert.equal(k.calls.length, 1, 'lost after connecting: never retried');
    assert.equal(JSON.stringify(r).includes(SECRET), false);
    assert.equal(JSON.stringify(k.logs).includes(SECRET), false);
    // A body that fails to arrive after the status line is lost after connecting too, even with a connect-shaped error.
    const lost = client(kind, { respond: () => ({ ok: true, status: 200, text: async () => { throw connectError(); } }) });
    const r2 = await lost.c.post(body, { deadlineAt: roomy() });
    assert.equal(r2.reason, 'network');
    assert.equal(r2.status, 200);
    assert.equal(lost.calls.length, 1);
  });

  test(`${kind}: one connect retry within the deadline, logged as its own event, and never a second`, async () => {
    const once = client(kind, { respond: (_u, _i, n) => { if (n === 1) throw connectError(); return json(K.answer({ model: K.model })); } });
    const r = await once.c.post(body, { deadlineAt: roomy() });
    assert.equal(r.kind, 'ok');
    assert.equal(once.calls.length, 2);
    assert.deepEqual(once.logs, [{ event: `${kind}_retry`, attempt: 2, reason: 'connect' }]);
    assert.equal(once.calls[1].init.body, once.calls[0].init.body, 'the retry sends the same bytes');

    const twice = client(kind, { respond: () => { throw connectError('ETIMEDOUT'); } });
    assert.deepEqual([(await twice.c.post(body, { deadlineAt: roomy() })).reason, twice.calls.length], ['connect', 2]);

    for (const [label, opts] of [['no deadline', {}], ['too tight', { deadlineAt: Date.now() + 5000 }], ['refused', { deadlineAt: roomy(), beforeRetry: async () => false }], ['beforeRetry throws', { deadlineAt: roomy(), beforeRetry: async () => { throw new Error(SECRET); } }]]) {
      const k = client(kind, { respond: () => { throw connectError(); } });
      const out = await k.c.post(body, opts);
      assert.equal(out.kind, 'not_sent', label);
      assert.equal(out.reason, 'connect', label);
      assert.equal(k.calls.length, 1, label);
      assert.deepEqual(k.logs, [], label);
    }
  });

  test(`${kind}: no HTTP status is ever retried, however roomy the deadline`, async () => {
    for (const status of [400, 401, 402, 403, 404, 408, 409, 429, 500, 502, 503, 529]) {
      let allowedAsked = 0;
      const k = client(kind, { respond: () => json(K.error(status), status) });
      const r = await k.c.post(body, { deadlineAt: roomy(), beforeRetry: async () => { allowedAsked += 1; return true; } });
      assert.equal(k.calls.length, 1, String(status));
      assert.equal(allowedAsked, 0, String(status));
      assert.notEqual(r.kind, 'ok', String(status));
      assert.notEqual(r.kind, 'not_sent', String(status));
    }
  });

  test(`${kind}: aborts are 'aborted', the call's own deadline is a timeout`, async () => {
    const pre = new AbortController();
    pre.abort();
    const k = client(kind, { respond: () => json(K.answer({ model: K.model })) });
    assert.deepEqual([(await k.c.post(body, { signal: pre.signal })).kind, k.calls.length], ['aborted', 0]);

    const outer = new AbortController();
    const waiting = client(kind, { respond: (_u, init) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })) });
    const p = waiting.c.post(body, { signal: outer.signal, deadlineAt: roomy() });
    setTimeout(() => outer.abort(), 10);
    assert.equal((await p).kind, 'aborted');

    const slow = client(kind, { respond: (_u, init) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })) });
    const keep = setInterval(() => {}, 1000);
    try {
      const r = await slow.c.post(body, { deadlineAt: Date.now() + 30 });
      assert.deepEqual([r.kind, r.reason], ['error', 'timeout']);
    } finally {
      clearInterval(keep);
    }
    // Positive control: the same shape completes when nothing aborts it.
    assert.equal((await client(kind, { respond: () => json(K.answer({ model: K.model })) }).c.post(body, { signal: new AbortController().signal, deadlineAt: roomy() })).kind, 'ok');
  });

  test(`${kind}: no Key or no base URL means nothing is sent`, async () => {
    for (const over of [{ key: null }, { key: '' }, { key: 42 }, { baseUrl: '' }, { baseUrl: null }, { getBaseUrl: () => undefined }, { getKey: () => { throw new Error(SECRET); } }, { getBaseUrl: () => { throw new Error(SECRET); } }]) {
      const k = client(kind, { respond: () => json(K.answer({ model: K.model })), ...over });
      const r = await k.c.post(body);
      assert.deepEqual([r.kind, r.reason], ['not_sent', 'unavailable'], JSON.stringify(Object.keys(over)));
      assert.equal(k.calls.length, 0);
      assert.equal(JSON.stringify(r).includes(SECRET), false);
    }
    // A body that cannot be serialised never leaves either, and the call still does not throw.
    const cyclic = { model: K.model };
    cyclic.self = cyclic;
    const k = client(kind, { respond: () => json(K.answer({ model: K.model })) });
    assert.deepEqual([(await k.c.post(cyclic)).kind, k.calls.length], ['not_sent', 0]);
    assert.equal(client(kind, { respond: () => json({}) }).calls.length, 0, 'control: a client sends nothing before post');
    const sent = client(kind, { respond: () => json(K.answer({ model: K.model })) });
    await sent.c.post(body);
    assert.equal(sent.calls.length, 1, 'control: with both, it sends');
  });

  test(`${kind}: the system and user text read back are the strings sent`, () => {
    const user = 'line 1\n{"recent":[]}';
    const turn = K.adapter.turnBody({ model: K.model, effort: 'low', maxTokens: 3000, system: SYSTEM, user });
    assert.equal(K.adapter.systemTextOf(turn), SYSTEM);
    assert.equal(K.adapter.userTextOf(turn), user);
    assert.equal(K.adapter.requestedModel(turn), K.model);
    assert.ok(JSON.stringify(turn).includes(JSON.stringify(SYSTEM)), 'the system string appears unchanged in the body');
    const decisionModel = kind === 'openrouter' ? 'anthropic/claude-haiku-5.5' : 'claude-haiku-5-5';
    const dec = K.adapter.decisionBody({ model: decisionModel, effort: 'none', maxTokens: 200, system: DECISION_PROMPT, user, schema: { name: 'clo_decision', schema: { type: 'object' } } });
    assert.equal(K.adapter.systemTextOf(dec), DECISION_PROMPT);
    assert.equal(K.adapter.userTextOf(dec), user);
    // Fails closed on anything else.
    for (const bad of [null, {}, { messages: [] }, { system: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }, { messages: [{ role: 'user', content: 'x' }] }]) {
      assert.equal(K.adapter.systemTextOf(bad), '');
    }
  });
}

test('OpenRouter decisionBody gives the golden decision bytes', () => {
  const g = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'provider-golden', 'decision-bodies.json'), 'utf8'));
  for (const [name, c] of Object.entries(DECISION_CASES)) {
    const golden = JSON.parse(g[name]);
    const { id: model, effort, maxTokens } = c.eff.models.decision;
    const body = openrouterAdapter.decisionBody({
      model, effort, maxTokens, system: DECISION_PROMPT, user: golden.messages[1].content,
      schema: { name: golden.response_format.json_schema.name, schema: golden.response_format.json_schema.schema },
    });
    assert.equal(JSON.stringify(body), g[name], name);
  }
  // Positive control: one changed field is not the same bytes.
  const { id: model, effort, maxTokens } = DECISION_CASES.ordinary.eff.models.decision;
  const golden = JSON.parse(g.ordinary);
  const off = openrouterAdapter.decisionBody({ model, effort, maxTokens: maxTokens + 1, system: DECISION_PROMPT, user: golden.messages[1].content, schema: { name: 'clo_decision', schema: golden.response_format.json_schema.schema } });
  assert.notEqual(JSON.stringify(off), g.ordinary);
});

test('OpenRouter turnBody gives the golden turn bytes from the same inputs as before', async () => {
  const { renderUserMessage } = await import('../../src/clo-plugin/lib/core/turn.js');
  const g = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'provider-golden', 'turn-bodies.json'), 'utf8'));
  for (const [name, c] of Object.entries(TURN_CASES)) {
    const { id: model, effort, maxTokens } = c.eff.models.primary;
    assert.equal(JSON.stringify(openrouterAdapter.turnBody({ model, effort, maxTokens, system: SYSTEM, user: renderUserMessage(c.turn) })), g[name], name);
  }
});

test('a redirect is refused by the real fetch and never followed or retried', async () => {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    if (req.url.endsWith('/v1/messages') || req.url.endsWith('/chat/completions')) {
      res.writeHead(307, { Location: '/elsewhere' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(KINDS.anthropic.answer({ model: KINDS.anthropic.model })));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    for (const kind of bothKinds) {
      hits.length = 0;
      const base = kind === 'openrouter' ? `http://127.0.0.1:${port}/api/v1` : `http://127.0.0.1:${port}`;
      const c = createChatClient({ adapter: KINDS[kind].adapter, getKey: () => KEY, getBaseUrl: () => base, retryDelayMs: 0 });
      const r = await c.post(KINDS[kind].body(KINDS[kind].model), { deadlineAt: roomy() });
      assert.deepEqual([r.kind, r.reason], ['error', 'network'], kind);
      assert.equal(hits.length, 1, `${kind}: one request, the redirect not followed`);
      assert.equal(hits.includes('/elsewhere'), false);
    }
    // Positive control: the same server answers a path that does not redirect, through the same real fetch.
    hits.length = 0;
    const res = await fetch(`http://127.0.0.1:${port}/elsewhere`, { redirect: 'error' });
    assert.equal(res.status, 200);
    assert.equal(hits.length, 1);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
