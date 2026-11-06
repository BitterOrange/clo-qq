// The shared OpenRouter client: every response shape, the one connect retry, aborts, and no provider text in results
// or logs. Stubbed fetch only; one test pins the real fetch's refused-connection shape on a closed loopback port.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { createOpenRouterClient, isConnectFailure, mapUsage } from '../../src/clo-plugin/lib/core/openrouterChat.js';

const SECRET = 'PROVIDER-SECRET-TEXT';
const BASE = 'http://127.0.0.1:9/api/v1';
const json = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const completion = (over = {}, choice = {}) => ({
  id: 'gen-1', model: 'anthropic/fake-opus',
  choices: [{ finish_reason: 'stop', ...choice, message: { role: 'assistant', content: '好的。', refusal: null, ...choice.message } }],
  usage: { prompt_tokens: 1200, completion_tokens: 40, cost: 0.0123, prompt_tokens_details: { cached_tokens: 1000, cache_write_tokens: 150 } },
  ...over,
});
const providerError = (code, meta = {}) => ({
  error: { code, type: 'moderation', message: SECRET, metadata: { provider_name: 'FakeProv', flagged_input: SECRET, raw: SECRET, reasons: [SECRET], ...meta } },
});
const connectError = (code = 'ECONNREFUSED') => new TypeError('fetch failed', { cause: Object.assign(new Error(`connect ${code} ${SECRET}`), { code, syscall: 'connect' }) });

function client({ respond = async () => json(completion()), key = 'FAKE-KEY', baseUrl = BASE, ...over } = {}) {
  const calls = [];
  const logs = [];
  const c = createOpenRouterClient({
    fetch: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
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
const BODY = { model: 'anthropic/fake-opus', messages: [{ role: 'user', content: 'x' }] };
const roomy = () => Date.now() + 60000;

test('request: POST to chat/completions, the Key and the content type only, redirects refused', async () => {
  const k = client();
  await k.c.post(BODY);
  assert.equal(k.calls.length, 1);
  const { url, init, body } = k.calls[0];
  assert.equal(url, `${BASE}/chat/completions`);
  assert.equal(init.method, 'POST');
  assert.deepEqual(Object.keys(init.headers).sort(), ['Authorization', 'Content-Type']);
  assert.equal(init.headers.Authorization, 'Bearer FAKE-KEY');
  assert.equal(init.redirect, 'error');
  assert.deepEqual(body, BODY);
});

test('every response shape is classified, and only whitelisted fields leave', async () => {
  const table = [
    ['200 ok', json(completion()), 'ok', null],
    ['200 carrying an error', json(providerError(502)), 'error', 'provider_error'],
    ['400', json(providerError(400), 400), 'error', 'http'],
    ['402 credits', json(providerError(402, { limit_source: 'openrouter_credits' }), 402), 'error', 'http'],
    ['403 Key limit', json(providerError(403, { limit_source: 'openrouter_key_limit' }), 403), 'error', 'http'],
    ['403 flagged', json(providerError(403), 403), 'refusal', 'moderation'],
    ['500 not JSON', json(`<html>${SECRET}</html>`, 500), 'error', 'http'],
    ['message.refusal', json(completion({}, { message: { content: null, refusal: SECRET } })), 'refusal', 'refusal'],
    ['content_filter', json(completion({}, { finish_reason: 'content_filter' })), 'refusal', 'content_filter'],
    ['length', json(completion({}, { finish_reason: 'length' })), 'ok', null],
    ['empty content', json(completion({}, { message: { content: '' } })), 'ok', null],
    ['no choices', json({ choices: [], usage: { cost: 0.001 } }), 'error', 'no_choice'],
    ['a bare body', json({ id: 'gen' }), 'error', 'no_choice'],
    ['200 not JSON', json(`not json ${SECRET}`), 'error', 'bad_body'],
    ['tool_calls in the message', json(completion({}, { message: { content: null, tool_calls: [{ id: 't', function: { name: 'x', arguments: SECRET } }] } })), 'error', 'tool_calls'],
    ['finish_reason tool_calls', json(completion({}, { finish_reason: 'tool_calls' })), 'error', 'tool_calls'],
    ['finish_reason error', json(completion({}, { finish_reason: 'error' })), 'error', 'finish_error'],
    ['no finish_reason', json(completion({}, { finish_reason: null })), 'error', 'finish_reason'],
    ['model mismatch', json(completion({ model: 'openai/other' })), 'error', 'model_mismatch'],
  ];
  for (const [label, response, kind, reason] of table) {
    const k = client({ respond: async () => response });
    const r = await k.c.post(BODY);
    assert.equal(r.kind, kind, label);
    assert.equal(r.reason, reason, label);
    assert.equal(k.calls.length, 1, `${label}: never retried`);
    assert.equal(JSON.stringify(r).includes(SECRET), false, `${label}: no provider text in the result`);
    assert.equal(JSON.stringify(k.logs).includes(SECRET), false, label);
    if (r.info) assert.deepEqual(Object.keys(r.info).sort(), ['error_type', 'limitSource', 'provider_code', 'provider_name', 'status'], label);
  }
  // Positive controls for what is carried.
  const ok = await client().c.post(BODY);
  assert.equal(ok.status, 200);
  assert.equal(ok.message.content, '好的。');
  assert.equal(ok.finishReason, 'stop');
  assert.deepEqual(ok.usage, { input: 50, output: 40, cacheRead: 1000, cacheWrite: 150, costUsd: 0.0123, model: 'anthropic/fake-opus' });
  const limited = await client({ respond: async () => json(providerError(403, { limit_source: 'openrouter_key_limit' }), 403) }).c.post(BODY);
  assert.deepEqual(limited.info, { status: 403, error_type: 'moderation', provider_name: 'FakeProv', provider_code: 403, limitSource: 'openrouter_key_limit' });
  const refused = await client({ respond: async () => json(completion({}, { message: { content: null, refusal: SECRET } })) }).c.post(BODY);
  assert.equal(refused.message.refusal, true, 'the refusal is a flag, never its text');
  const empty = await client({ respond: async () => json({ choices: [], usage: { cost: 0.001 } }) }).c.post(BODY);
  assert.equal(empty.usage.costUsd, 0.001, 'a 200 with no choice keeps its cost');
  const tools = await client({ respond: async () => json(completion({}, { message: { content: null, tool_calls: [{ id: 't' }] } })) }).c.post(BODY);
  assert.deepEqual(Object.keys(tools.message).sort(), ['content', 'refusal', 'toolCalls'], 'no tool call bodies or reasoning');
});

test('a billed error keeps its usage, so it is not booked as free', async () => {
  const r = await client({ respond: async () => json({ ...providerError(500), usage: { cost: 0.002, prompt_tokens: 10 } }, 500) }).c.post(BODY);
  assert.equal(r.kind, 'error');
  assert.equal(r.usage.costUsd, 0.002);
});

test('usage mapping: cache reads and writes come out of the prompt count; missing usage is null', () => {
  assert.equal(mapUsage(undefined, 'm'), null);
  assert.equal(mapUsage('x', 'm'), null);
  assert.deepEqual(mapUsage({}, 'anthropic/a'), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null, model: 'anthropic/a' });
  assert.equal(mapUsage({ cost: 'x' }, 'm').costUsd, null);
  assert.equal(mapUsage({ cost: 0 }, 'm').costUsd, 0);
  assert.equal(mapUsage({ prompt_tokens: 5 }, `bad model ${SECRET} with spaces`).model, null, 'a model string that is not an id is dropped');
});

test('a thrown fetch error never carries its text out', async () => {
  const k = client({ respond: async () => { throw new Error(`ECONNRESET ${SECRET}`); } });
  const r = await k.c.post(BODY, { deadlineAt: roomy() });
  assert.equal(r.kind, 'error');
  assert.equal(r.reason, 'network');
  assert.equal(k.calls.length, 1, 'not a connect failure: never retried');
  assert.equal(JSON.stringify(r).includes(SECRET), false);
});

test('connect failures: one retry within the deadline, and never a second', async () => {
  // Positive control: the retry succeeds.
  const once = client({ respond: async (_u, _i, n) => { if (n === 1) throw connectError(); return json(completion()); } });
  const r1 = await once.c.post(BODY, { deadlineAt: roomy() });
  assert.equal(r1.kind, 'ok');
  assert.equal(once.calls.length, 2);
  assert.deepEqual(once.logs, [{ event: 'openrouter_retry', attempt: 2, reason: 'connect' }]);

  const always = client({ respond: async () => { throw connectError('ETIMEDOUT'); } });
  const r2 = await always.c.post(BODY, { deadlineAt: roomy() });
  assert.equal(r2.kind, 'not_sent');
  assert.equal(r2.reason, 'connect');
  assert.equal(always.calls.length, 2);

  const noDeadline = client({ respond: async () => { throw connectError(); } });
  assert.equal((await noDeadline.c.post(BODY)).kind, 'not_sent');
  assert.equal(noDeadline.calls.length, 1, 'no deadline, no retry');

  const tight = client({ respond: async () => { throw connectError(); } });
  assert.equal((await tight.c.post(BODY, { deadlineAt: Date.now() + 5000 })).kind, 'not_sent');
  assert.equal(tight.calls.length, 1, 'too little time left for a retry');

  const refused = client({ respond: async () => { throw connectError(); } });
  let asked = 0;
  await refused.c.post(BODY, { deadlineAt: roomy(), beforeRetry: async () => { asked += 1; return false; } });
  assert.equal(asked, 1);
  assert.equal(refused.calls.length, 1, 'beforeRetry can refuse it');

  const dns = client({ respond: async (_u, _i, n) => {
    if (n === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND', syscall: 'getaddrinfo' }) });
    return json(completion());
  } });
  assert.equal((await dns.c.post(BODY, { deadlineAt: roomy() })).kind, 'ok');
  assert.equal(dns.calls.length, 2);
});

test('nothing after a response, and no HTTP status, is ever retried', async () => {
  for (const status of [429, 500, 502, 503]) {
    const k = client({ respond: async () => json(providerError(status), status) });
    await k.c.post(BODY, { deadlineAt: roomy() });
    assert.equal(k.calls.length, 1, String(status));
  }
  const lostBody = client({ respond: async () => ({ ok: true, status: 200, text: async () => { throw connectError(); } }) });
  const r = await lostBody.c.post(BODY, { deadlineAt: roomy() });
  assert.equal(r.reason, 'network');
  assert.equal(r.status, 200);
  assert.equal(lostBody.calls.length, 1, 'a body lost after the response started is never retried');
});

test('connect failure shapes', () => {
  assert.equal(isConnectFailure(connectError()), true);
  assert.equal(isConnectFailure(new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) })), true);
  const agg = Object.assign(new AggregateError([connectError().cause, Object.assign(new Error('x'), { code: 'ECONNREFUSED', syscall: 'connect' })]), { code: 'ECONNREFUSED' });
  assert.equal(isConnectFailure(new TypeError('fetch failed', { cause: agg })), true);
  assert.equal(isConnectFailure(new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNRESET', syscall: 'read' }) })), false);
  assert.equal(isConnectFailure(new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ETIMEDOUT', syscall: 'read' }) })), false, 'a timeout after connecting may have been sent');
  assert.equal(isConnectFailure(new Error('ECONNREFUSED in the text only')), false);
  const mixed = new AggregateError([connectError().cause, Object.assign(new Error('x'), { code: 'ECONNRESET' })]);
  assert.equal(isConnectFailure(mixed), false);
});

test('the real fetch on a closed loopback port fails in the shape read as not sent', async () => {
  const srv = createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  let err = null;
  try {
    await fetch(`http://127.0.0.1:${port}/chat/completions`, { method: 'POST', body: '{}', redirect: 'error' });
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'the port is closed');
  assert.equal(isConnectFailure(err), true);
});

test('aborts: an outer signal is aborted, the deadline passed to post is a timeout error, and the first cause wins', async () => {
  const hanging = (_u, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  const ctl = new AbortController();
  const outer = client({ respond: hanging });
  const pending = outer.c.post(BODY, { signal: ctl.signal, deadlineAt: roomy() });
  ctl.abort();
  const byCaller = await pending;
  assert.deepEqual({ kind: byCaller.kind, reason: byCaller.reason }, { kind: 'aborted', reason: 'aborted' });

  const timed = client({ respond: hanging });
  const r = await timed.c.post(BODY, { deadlineAt: Date.now() + 20 });
  assert.deepEqual({ kind: r.kind, reason: r.reason }, { kind: 'error', reason: 'timeout' });
  assert.equal(timed.calls.length, 1, 'a timeout is never retried');

  // The caller aborting after the deadline fired does not turn the timeout into an abort, and the other way round.
  const late = new AbortController();
  const both = client({ respond: (u, init) => { init.signal.addEventListener('abort', () => late.abort()); return hanging(u, init); } });
  assert.equal((await both.c.post(BODY, { signal: late.signal, deadlineAt: Date.now() + 20 })).reason, 'timeout');
  const first = new AbortController();
  const callerFirst = client({ respond: (u, init) => { setImmediate(() => first.abort()); return hanging(u, init); } });
  assert.equal((await callerFirst.c.post(BODY, { signal: first.signal, deadlineAt: Date.now() + 60000 })).kind, 'aborted');

  const already = new AbortController();
  already.abort();
  const early = client();
  assert.equal((await early.c.post(BODY, { signal: already.signal })).kind, 'aborted');
  assert.equal(early.calls.length, 0, 'an aborted signal sends nothing');

  // Positive control: the same client shape completes when nothing aborts it.
  assert.equal((await client().c.post(BODY, { signal: new AbortController().signal, deadlineAt: roomy() })).kind, 'ok');
});

test('no Key or no base URL: nothing is sent', async () => {
  for (const over of [{ key: null }, { key: '' }, { baseUrl: '' }, { getBaseUrl: () => undefined }, { getKey: () => { throw new Error(SECRET); } }]) {
    const k = client(over);
    const r = await k.c.post(BODY);
    assert.equal(r.kind, 'not_sent');
    assert.equal(r.reason, 'unavailable');
    assert.equal(k.calls.length, 0);
  }
  assert.equal(client().calls.length, 0, 'control: a client sends nothing before post');
});
