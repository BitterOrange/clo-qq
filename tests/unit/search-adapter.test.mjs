// The Sonar adapter (docs/search-contract.md section 4), the search client on the one send loop, the bot's search Key
// and base, and the mock that answers search. Fake fetches and a loopback mock only: no real request. Every refusal
// has its accepted control in the same test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatClient } from '../../src/clo-plugin/lib/core/providers/modelChat.js';
import {
  createSearchAdapter, hostLabel, MAX_SOURCES, SEARCH_INSTRUCTION, searchAdapter, sourceNames,
} from '../../src/clo-plugin/lib/core/providers/searchAdapter.js';
import { SEARCH_CEILINGS, SEARCH_DEFAULTS, SEARCH_MODEL } from '../../src/clo-plugin/lib/core/providers/searchRegistry.js';
import { liveSecrets, searchBaseOf, searchKeyOf } from '../../src/bot/services.mjs';
import { FAKE_OPENROUTER_KEY, FAKE_SEARCH_KEY } from '../harness/fake-keys.mjs';
import { startMockOpenRouter, sonarRow } from '../harness/mock-openrouter.mjs';

const MODEL = SEARCH_MODEL['openrouter-sonar'];
const PROVIDER_TEXT = 'provider says: secret upstream detail';
const answer = (over = {}, message = {}) => ({
  id: 'gen-1', model: MODEL,
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '一条检索结果。', ...message } }],
  usage: { prompt_tokens: 20, completion_tokens: 40, cost: 0.0056 },
  search_results: [{ title: 'Mock News', url: 'https://news.example.com/a' }],
  ...over,
});
const classify = (body, model = MODEL) => searchAdapter.classify(200, body, model);
const noUrl = (r) => {
  const s = JSON.stringify(r);
  return !/https?:|example\.com|news\.|\.com/i.test(s);
};

test('the body is the model, the output cap, usage, the fixed instruction and the query: nothing else', () => {
  const body = searchAdapter.searchBody({ model: MODEL, maxTokens: 600, query: '今天的天气' });
  assert.deepEqual(body, {
    model: MODEL, stream: false, max_tokens: 600, usage: { include: true },
    messages: [{ role: 'system', content: SEARCH_INSTRUCTION }, { role: 'user', content: '今天的天气' }],
  });
  assert.deepEqual(Object.keys(body), ['model', 'stream', 'max_tokens', 'usage', 'messages']);
  assert.equal('user' in body, false, 'no user field');
  assert.equal('tools' in body, false);
  assert.equal(searchAdapter.requestedModel(body), MODEL);
  for (const bad of [{ model: '', maxTokens: 600, query: 'q' }, { model: MODEL, maxTokens: 0, query: 'q' }, { model: MODEL, maxTokens: SEARCH_CEILINGS.maxTokens + 1, query: 'q' }, { model: MODEL, maxTokens: 600, query: '  ' }, { model: MODEL, maxTokens: 600, query: 5 }]) {
    assert.throws(() => searchAdapter.searchBody(bad), TypeError, JSON.stringify(bad));
  }
  const { url, headers } = searchAdapter.request(FAKE_SEARCH_KEY, 'http://127.0.0.1:9/api/v1');
  assert.equal(url, 'http://127.0.0.1:9/api/v1/chat/completions');
  assert.deepEqual(Object.keys(headers).sort(), ['Authorization', 'Content-Type'], 'no attribution headers');
  assert.equal(headers.Authorization, `Bearer ${FAKE_SEARCH_KEY}`);
  assert.equal(searchAdapter.kind, 'search');
  assert.equal(searchAdapter.retryEvent, 'search_retry');
});

test('success: text and source names from any of the three citation shapes, and no URL leaves the adapter', () => {
  const viaResults = classify(answer());
  assert.equal(viaResults.kind, 'ok');
  assert.equal(viaResults.text, '一条检索结果。');
  assert.deepEqual(viaResults.sources, [{ name: 'example' }], 'the host label of news.example.com');
  assert.equal(viaResults.message, null, 'the raw message never leaves');
  assert.deepEqual(viaResults.usage, { input: 20, output: 40, cacheRead: 0, cacheWrite: 0, costUsd: 0.0056, model: MODEL });
  assert.ok(noUrl(viaResults));

  const viaAnnotations = classify(answer({ search_results: undefined }, { annotations: [{ type: 'url_citation', url_citation: { title: '新华网报道', url: 'https://www.xinhuanet.com/x' } }] }));
  assert.deepEqual(viaAnnotations.sources, [{ name: 'xinhuanet' }]);
  const viaCitations = classify(answer({ search_results: undefined, citations: ['https://www.reuters.com/world/x', 'https://news.bbc.co.uk/y'] }));
  assert.deepEqual(viaCitations.sources, [{ name: 'reuters' }, { name: 'bbc' }], 'with no title, the host\'s main label');
  for (const r of [viaAnnotations, viaCitations]) {
    assert.equal(r.kind, 'ok');
    assert.ok(noUrl(r), JSON.stringify(r));
  }
});

test('source names: host labels only, one each, at most five; a title is never posted, whatever it says', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ title: `来源 ${i}`, url: `https://s${i}.site${i}.org/` }));
  assert.equal(classify(answer({ search_results: many })).sources.length, MAX_SOURCES);
  const dup = classify(answer({ search_results: [{ title: 'Same', url: 'https://a.example.com/1' }, { title: 'Other', url: 'https://b.example.com/2' }] }));
  assert.deepEqual(dup.sources, [{ name: 'example' }], 'one host, one name');
  // Free web text in a title (an advert, a slogan, a topic the content scope leaves to the model) never reaches the line.
  const TITLE = '限时优惠加微信 TITLE-MARKER 立即领取';
  const titled = classify(answer({ search_results: [{ title: TITLE, url: 'https://www.wikipedia.org/wiki/x' }] }));
  assert.deepEqual(titled.sources, [{ name: 'wikipedia' }]);
  assert.equal(JSON.stringify(titled).includes('TITLE-MARKER'), false);
  // A title with no usable URL gives no source at all.
  const titleOnly = classify(answer({ search_results: [{ title: 'Mock News', url: null }] }));
  assert.equal(titleOnly.kind, 'no_source');
  assert.equal(classify(answer()).kind, 'ok', 'control: the same answer with a URL has a source');
});

test('host labels: the registrable label, never a dot, an IP, punycode or another scheme', () => {
  assert.equal(hostLabel('https://www.reuters.com/x'), 'reuters');
  assert.equal(hostLabel('https://news.bbc.co.uk/x'), 'bbc');
  assert.equal(hostLabel('http://example.com'), 'example');
  assert.equal(hostLabel('https://cn.nytimes.com/'), 'nytimes');
  assert.equal(hostLabel('https://127.0.0.1/x'), null);
  assert.equal(hostLabel('https://[::1]/x'), null);
  assert.equal(hostLabel('https://xn--fiqs8s.xn--fiqs8s/'), null);
  assert.equal(hostLabel('ftp://files.example.com/'), null);
  assert.equal(hostLabel('javascript:alert(1)'), null);
  assert.equal(hostLabel('not a url'), null);
  assert.equal(hostLabel('https://localhost/'), null);
});

test('no usable source: no_source, and the text is withheld; with one the same text comes through', () => {
  const none = classify(answer({ search_results: undefined }));
  assert.equal(none.kind, 'no_source');
  assert.equal(none.text, null);
  assert.deepEqual(none.sources, []);
  assert.ok(none.usage, 'the call was handled and billed: its usage is kept');
  const unusable = classify(answer({ search_results: [{ title: '', url: 'https://127.0.0.1/' }], citations: ['ftp://x.example.com'] }));
  assert.equal(unusable.kind, 'no_source');
  assert.equal(classify(answer()).text, '一条检索结果。', 'control');
});

test('the text is cut to resultMaxChars, at most the ceiling', () => {
  const long = '字'.repeat(5000);
  assert.equal([...classify(answer({}, { content: long })).text].length, SEARCH_DEFAULTS.resultMaxChars);
  const small = createSearchAdapter({ resultMaxChars: 10 });
  assert.equal(small.classify(200, answer({}, { content: long }), MODEL).text, '字'.repeat(10));
  assert.equal(createSearchAdapter({ resultMaxChars: 99999 }).resultMaxChars, SEARCH_CEILINGS.resultMaxChars);
  assert.equal(createSearchAdapter({ resultMaxChars: 0 }).resultMaxChars, SEARCH_DEFAULTS.resultMaxChars);
  const ctrl = classify(answer({}, { content: 'a\u0007b\r\nc​d' }));
  assert.equal(ctrl.text, 'ab\ncd');
});

test('every failure shape is classified, with no text and no source', () => {
  const cases = [
    ['bad_body', null],
    ['bad_body', 'text'],
    ['no_choice', { model: MODEL, choices: [] }],
    ['tool_calls', answer({}, { tool_calls: [{ id: 'x' }] })],
    ['finish_error', answer({ choices: [{ finish_reason: 'error', message: { content: 'x' } }] })],
    ['finish_reason', answer({ choices: [{ finish_reason: 'weird', message: { content: 'x' } }] })],
    ['model_mismatch', answer({ model: 'perplexity/sonar' })],
    ['empty', answer({}, { content: '   ' })],
    ['empty', answer({}, { content: null })],
  ];
  for (const [reason, body] of cases) {
    const r = classify(body);
    assert.equal(r.kind, 'error', reason);
    assert.equal(r.reason, reason, JSON.stringify(body));
    assert.equal(r.text, null);
    assert.deepEqual(r.sources, []);
  }
  const refused = classify(answer({}, { refusal: PROVIDER_TEXT }));
  assert.deepEqual([refused.kind, refused.reason], ['refusal', 'refusal']);
  assert.equal(JSON.stringify(refused).includes('provider says'), false, 'a refusal is a flag, never its text');
  const filtered = classify(answer({ choices: [{ finish_reason: 'content_filter', message: { content: 'x' } }] }));
  assert.deepEqual([filtered.kind, filtered.reason], ['refusal', 'content_filter']);
  assert.equal(classify(answer({ choices: [{ finish_reason: 'length', message: { content: '截断的结果' } }] })).kind, 'ok', 'control: length is an answer');
});

test('HTTP errors: status and short codes only, never the provider\'s words; a Key limit is not moderation', () => {
  const body = { error: { message: PROVIDER_TEXT, type: 'invalid_request', code: 400, metadata: { provider_name: 'Perplexity', raw: PROVIDER_TEXT } } };
  const r400 = searchAdapter.parseError(400, body);
  assert.equal(r400.kind, 'error');
  assert.equal(r400.reason, 'http');
  assert.equal(r400.status, 400, 'control: the status is there');
  assert.equal(r400.info.provider_name, 'Perplexity');
  assert.equal(JSON.stringify(r400).includes('provider says'), false);
  assert.equal(r400.text, null);
  const r500 = searchAdapter.parseError(500, null);
  assert.deepEqual([r500.kind, r500.reason, r500.status], ['error', 'http', 500]);
  const moderation = searchAdapter.parseError(403, { error: { message: PROVIDER_TEXT } });
  assert.deepEqual([moderation.kind, moderation.reason], ['refusal', 'moderation']);
  const limited = searchAdapter.parseError(403, { error: { message: PROVIDER_TEXT, metadata: { limit_source: 'openrouter_key_limit' } } });
  assert.deepEqual([limited.kind, limited.reason, limited.info.limitSource], ['error', 'http', 'openrouter_key_limit']);
  const paid = searchAdapter.parseError(402, { error: { message: PROVIDER_TEXT } });
  assert.deepEqual([paid.kind, paid.status], ['error', 402]);
  const inBody = searchAdapter.parseError(200, { error: { message: PROVIDER_TEXT } });
  assert.equal(inBody.reason, 'provider_error');
  for (const r of [r400, r500, moderation, limited, paid, inBody]) assert.deepEqual(r.sources, []);
});

test('through the one send loop: the search Key in its header, the answer classified, a timeout with no text', async () => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify(answer()) };
  };
  const client = createChatClient({ adapter: searchAdapter, fetch, getKey: () => FAKE_SEARCH_KEY, getBaseUrl: () => 'http://127.0.0.1:9/api/v1' });
  const body = searchAdapter.searchBody({ model: MODEL, maxTokens: 600, query: '查一下' });
  const r = await client.post(body, { deadlineAt: Date.now() + 5000 });
  assert.equal(r.kind, 'ok');
  assert.deepEqual(r.sources, [{ name: 'example' }]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'http://127.0.0.1:9/api/v1/chat/completions');
  assert.equal(seen[0].init.headers.Authorization, `Bearer ${FAKE_SEARCH_KEY}`);
  assert.equal(seen[0].init.redirect, 'error');
  assert.deepEqual(JSON.parse(seen[0].init.body), body);

  const slow = createChatClient({
    adapter: searchAdapter,
    fetch: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))),
    getKey: () => FAKE_SEARCH_KEY,
    getBaseUrl: () => 'http://127.0.0.1:9/api/v1',
  });
  const t = await slow.post(body, { deadlineAt: Date.now() + 50 });
  assert.deepEqual([t.kind, t.reason], ['error', 'timeout']);
  assert.equal(t.text ?? null, null);
  assert.equal(t.sources ?? null, null, 'the transport adds no sources');

  const off = createChatClient({ adapter: searchAdapter, fetch, getKey: () => null, getBaseUrl: () => 'http://127.0.0.1:9/api/v1' });
  assert.deepEqual([(await off.post(body)).kind, seen.length], ['not_sent', 1], 'no search Key: nothing leaves');
});

test('the bot\'s search Key: only with search on, never the chat Key; its base is the search block\'s; it is a secret', () => {
  const on = () => ({ search: { provider: 'openrouter-sonar', baseUrl: 'http://127.0.0.1:9/api/v1' } });
  const env = { CLO_SEARCH_KEY: FAKE_SEARCH_KEY, OPENROUTER_API_KEY: FAKE_OPENROUTER_KEY, CLO_QQ_APP_SECRET: 'qq-secret' };
  assert.equal(searchKeyOf(env, on), FAKE_SEARCH_KEY, 'control');
  assert.equal(searchKeyOf(env, () => ({})), null, 'search off');
  assert.equal(searchKeyOf(env, () => null), null, 'no file');
  assert.equal(searchKeyOf(env, () => { throw new Error('read'); }), null);
  assert.equal(searchKeyOf({ ...env, CLO_SEARCH_KEY: FAKE_OPENROUTER_KEY }, on), null, 'the chat Key is never the search Key');
  assert.equal(searchKeyOf({ CLO_SEARCH_KEY: 'k', CLO_PROVIDER_API_KEY: 'k' }, on), null, 'nor the Anthropic chat Key');
  assert.equal(searchKeyOf({ OPENROUTER_API_KEY: FAKE_OPENROUTER_KEY }, on), null, 'none given');
  assert.equal(searchBaseOf(on), 'http://127.0.0.1:9/api/v1');
  assert.equal(searchBaseOf(() => ({})), null);
  assert.ok(liveSecrets(env).includes(FAKE_SEARCH_KEY), 'the exit refuses text that holds it');
  assert.equal(liveSecrets({ CLO_QQ_APP_SECRET: 'qq-secret' }).length, 1, 'control: absent, not listed');
});

test('the mock: search requests are told apart by model, and each Key reads its own /key figure', async () => {
  const mock = await startMockOpenRouter();
  try {
    mock.setSearch(() => ({ text: '结果', citations: ['https://www.example.org/x'] }));
    mock.setKey({ usage_daily: 0.02, limit: 0.5 }, FAKE_SEARCH_KEY);
    const client = createChatClient({ adapter: searchAdapter, fetch: globalThis.fetch, getKey: () => FAKE_SEARCH_KEY, getBaseUrl: () => mock.base });
    const r = await client.post(searchAdapter.searchBody({ model: MODEL, maxTokens: 600, query: '查' }), { deadlineAt: Date.now() + 5000 });
    assert.equal(r.kind, 'ok');
    assert.deepEqual(r.sources, [{ name: 'example' }]);
    assert.equal(mock.searchRequests().length, 1);
    assert.equal(mock.agentRequests().length, 0, 'not a chat turn');
    assert.equal(mock.decisionRequests().length, 0);
    const read = async (key) => (await (await fetch(`${mock.base}/key`, { headers: { Authorization: `Bearer ${key}` } })).json()).data;
    assert.equal((await read(FAKE_SEARCH_KEY)).usage_daily, 0.02);
    assert.equal((await read(FAKE_OPENROUTER_KEY)).usage_daily, 0, 'control: the chat Key reads the default');
    assert.deepEqual(mock.keyReads().map((k) => k.key === FAKE_SEARCH_KEY), [true, false]);
    mock.setCatalog([sonarRow()]);
    const cat = await (await fetch(`${mock.base}/models`)).json();
    assert.equal(cat.data[0].id, MODEL);
  } finally {
    await mock.stop();
  }
});
