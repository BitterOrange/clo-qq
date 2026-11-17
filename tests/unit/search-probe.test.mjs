// The search probe (src/tools/search-probe.mjs), entirely against an injected fake OpenRouter: no network, no real .env.
// Every refusal has its accepted run in the same file, and every "not in the results" has the field that is.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { buildPlan, checkCatalog, FIXED, main, PRICE_CEILING, presendRefusal, PROBE_KEY_NAME, resolveEndpoint, RESULT_FILE, sanitizeResult } from '../../src/tools/search-probe.mjs';
import { CATALOG, ROOT } from './_cli-helper.mjs';
import { sonarRow } from '../harness/mock-openrouter.mjs';

const BASE = 'http://127.0.0.1:9/api/v1';
const TEST_KEY = 'sk-or-v1-FAKE-SEARCH-PROBE-KEY-LOCAL-ONLY';
const CHAT_KEY = 'sk-or-v1-FAKE-CHAT-KEY-NEVER-READ';
const ANSWER = '巴黎举办了最近一届夏季奥运会。';
const TITLE = '奥运会官方新闻稿';
const URL_A = 'https://example.org/olympics/paris';

const roots = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
function makeRoot({ env = `${PROBE_KEY_NAME}=${TEST_KEY}\nCLO_CHAT_API_KEY=${CHAT_KEY}\n` } = {}) {
  const root = join(mkdtempSync(join(tmpdir(), 'clo-search-probe-')), 'a b');
  mkdirSync(root, { recursive: true });
  roots.push(root);
  if (env !== null) writeFileSync(join(root, '.env'), env, { mode: 0o600 });
  return root;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const decisionAnswer = (over = {}) => ({
  model: 'anthropic/claude-haiku-5.5',
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ action: 'reply', skip_class: 'none', crisis: false, need_search: true, search_query_1: '夏季奥运会 举办城市', search_query_2: '', ...over }) } }],
  usage: { prompt_tokens: 2000, completion_tokens: 40, cost: 0.0023 },
});
const sonarAnswer = () => ({
  model: 'perplexity/sonar-pro',
  choices: [{ finish_reason: 'stop', message: { content: ANSWER } }],
  search_results: [{ title: TITLE, url: URL_A }],
  citations: [URL_A],
  usage: { prompt_tokens: 900, completion_tokens: 120, cost: 0.0065 },
});

// A fake OpenRouter: the Key, the catalog and chat completions. Records every call.
function fakeOpenRouter({ key = { usage: 1, usage_daily: 0.2, limit: 0.1, limit_remaining: 0.1, limit_reset: 'daily' }, catalog = [...CATALOG(), sonarRow()], decision = () => json(decisionAnswer()), sonar = () => json(sonarAnswer()) } = {}) {
  const calls = [];
  let keyReads = 0;
  const fetch = async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: u, auth: init.headers?.Authorization ?? null, body, redirect: init.redirect });
    if (u.endsWith('/key')) {
      keyReads += 1;
      // The second read shows what the two calls cost.
      return typeof key === 'function' ? key(keyReads) : json({ data: keyReads === 1 ? key : { ...key, usage: key.usage + 0.0088, usage_daily: key.usage_daily + 0.0088 } });
    }
    if (u.endsWith('/models')) return json({ data: catalog });
    if (u.endsWith('/chat/completions')) return body.model === 'perplexity/sonar-pro' ? sonar(body) : decision(body);
    return json({ error: { message: 'no route' } }, 404);
  };
  return { fetch, calls, chat: () => calls.filter((c) => c.url.endsWith('/chat/completions')) };
}

async function run(argv, { root = makeRoot(), env = {}, provider = fakeOpenRouter() } = {}) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    env: { CLO_TEST_ROOT: root, CLO_SEARCH_PROBE_TEST_BASE: BASE, ...env },
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
    fetchImpl: provider.fetch,
  });
  return { code, out, err, root, provider, results: () => resultLines(root) };
}

const resultFile = (root) => join(root, 'captures', RESULT_FILE);
function resultLines(root) {
  try {
    return readFileSync(resultFile(root), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

test('the plan: two fixed calls, a worst case under $0.10 at the ceilings, and the bodies the bot itself would send', () => {
  const plan = buildPlan(ROOT);
  assert.deepEqual(plan.calls.map((c) => c.id), ['decision_search_schema', 'sonar']);
  const [decision, sonar] = plan.calls;
  assert.equal(sonar.body.model, 'perplexity/sonar-pro');
  assert.deepEqual(Object.keys(sonar.body).sort(), ['max_tokens', 'messages', 'model', 'stream', 'usage']);
  assert.equal(sonar.body.messages.at(-1).content, FIXED.query, 'the one query is the fixed text');
  assert.equal(decision.body.model, 'anthropic/claude-haiku-5.5');
  assert.equal(decision.body.response_format.json_schema.name, 'clo_decision_search', 'the search schema, not the plain one');
  assert.match(decision.body.messages[0].content, /search_query_1/, 'the addendum follows the base prompt');
  // 4000 x $5/M + 600 x $20/M + $0.02.
  assert.equal(sonar.worstMicros, 52000);
  assert.ok(plan.totalWorstMicros < 100000, `worst ${plan.totalWorstMicros}`);
  assert.ok(plan.totalWorstMicros > sonar.worstMicros, 'positive control: the decision call adds to it');
});

test('without --approve it prints the plan, makes no request and does not read .env', async () => {
  const provider = fakeOpenRouter();
  // .env as a folder: a read would throw. Control below: the same root fails once --approve reads it.
  const root = makeRoot({ env: null });
  mkdirSync(join(root, '.env'));
  const r = await run([], { root, provider });
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes(FIXED.query), 'UTF-8 plan text is printed');
  assert.match(r.out, /no request was made and \.env was not read/);
  assert.equal(provider.calls.length, 0);
  const approved = await run(['--approve', '--max-usd', '0.10'], { root, provider }).catch(() => ({ code: 'threw' }));
  assert.notEqual(approved.code, 0, 'control: --approve does read .env');
  assert.equal(provider.chat().length, 0);
});

test('refusals before any request: no cap, a cap below the worst case, a proxy variable, no probe Key, a free-text argument', async () => {
  const provider = fakeOpenRouter();
  const noCap = await run(['--approve'], { provider });
  assert.equal(noCap.code, 2);
  assert.match(noCap.err, /--max-usd/);
  const low = await run(['--approve', '--max-usd', '0.05'], { provider });
  assert.equal(low.code, 2);
  assert.match(low.err, /worst case/);
  const proxy = await run(['--approve', '--max-usd', '0.10'], { provider, env: { HTTPS_PROXY: 'http://127.0.0.1:1' } });
  assert.equal(proxy.code, 2);
  assert.match(proxy.err, /proxy/);
  // The chat Key alone is not enough: the probe never borrows it.
  const noKey = await run(['--approve', '--max-usd', '0.10'], { provider, root: makeRoot({ env: `CLO_CHAT_API_KEY=${CHAT_KEY}\nCLO_SEARCH_API_KEY=${CHAT_KEY}x\n` }) });
  assert.equal(noKey.code, 2);
  assert.match(noKey.err, /CLO_TEST_API_KEY is empty/);
  const text = await run(['--approve', '--max-usd', '0.10', '帮我搜一下'], { provider });
  assert.equal(text.code, 2);
  assert.match(text.err, /no free text/);
  assert.equal(provider.calls.length, 0);
  // Control: the same provider, a fitting cap, and the run goes through.
  const ok = await run(['--approve', '--max-usd', '0.10'], { provider });
  assert.equal(ok.code, 0, `${ok.out}${ok.err}`);
});

test('a full run: each body as planned, the probe Key only, and results with names and numbers but no text, title, URL or Key', async () => {
  const r = await run(['--approve', '--max-usd', '0.10']);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  const plan = buildPlan(ROOT);
  const chat = r.provider.chat();
  assert.equal(chat.length, 2, 'one decision call and one Sonar call, nothing retried');
  assert.deepEqual(chat.map((c) => c.body), plan.calls.map((c) => c.body));
  assert.ok(r.provider.calls.filter((c) => !c.url.endsWith('/models')).every((c) => c.auth === `Bearer ${TEST_KEY}`), 'the probe Key, never the chat Key');
  assert.equal(r.provider.calls.find((c) => c.url.endsWith('/models')).auth, null, 'the catalog read sends no Key');
  assert.ok(r.provider.calls.every((c) => c.url.startsWith(BASE) && c.redirect === 'error'));

  const lines = r.results();
  const raw = readFileSync(resultFile(r.root), 'utf8');
  for (const secret of [TEST_KEY, CHAT_KEY, ANSWER, TITLE, URL_A, 'example', FIXED.query, '夏季奥运会']) assert.ok(!raw.includes(secret), secret);
  const key = lines.find((l) => l.kind === 'key_read');
  assert.equal(key.usageDailyPresent, true);
  assert.equal(key.usageDailyType, 'number');
  assert.equal(key.keyLimitReset, 'daily');
  const catalog = lines.find((l) => l.kind === 'catalog');
  assert.deepEqual(catalog.priceFields, ['prompt', 'completion', 'request']);
  assert.equal(catalog.searchRequestUsd, 0.005);
  const decision = lines.find((l) => l.id === 'decision_search_schema');
  assert.equal(decision.parsed, true);
  assert.equal(decision.needSearch, true);
  assert.equal(decision.queryCount, 1, 'a count, not the query');
  const sonar = lines.find((l) => l.id === 'sonar');
  assert.equal(sonar.class, 'ok');
  assert.deepEqual(sonar.citationShapes, ['search_results', 'citations']);
  assert.equal(sonar.titlesPresent, true);
  assert.equal(sonar.sourceCount, 2, 'the title, and the host label of the bare citation');
  assert.equal(sonar.modelMatches, true);
  assert.equal(sonar.costPresent, true);
  assert.equal(sonar.promptTokens, 900);
  assert.ok(sonar.usageKeys.includes('cost'));
  const check = lines.find((l) => l.kind === 'key_check');
  assert.equal(check.keyDeltaUsd, 0.0088);
  assert.equal(check.keyDailyDeltaUsd, 0.0088);
  assert.deepEqual(check.flags, []);
  assert.equal(lines.at(-1).completed, true);
  assert.match(r.out, /usage_daily moved/);
});

test('the Key decides first: no daily limit or a limit above the cap refuses before the catalog and any paid call', async () => {
  for (const key of [{ usage: 0, limit: null, limit_reset: null }, { usage: 0, limit: 0.5, limit_reset: 'daily' }, { usage: 0, limit: 0.1, limit_reset: 'monthly' }]) {
    const provider = fakeOpenRouter({ key });
    const r = await run(['--approve', '--max-usd', '0.10'], { provider });
    assert.equal(r.code, 1, JSON.stringify(key));
    assert.equal(provider.chat().length, 0, JSON.stringify(key));
    assert.ok(!provider.calls.some((c) => c.url.endsWith('/models')));
  }
  // Control: the limit equal to the cap passes.
  const provider = fakeOpenRouter({ key: { usage: 0, usage_daily: 0, limit: 0.1, limit_remaining: 0.1, limit_reset: 'daily' } });
  assert.equal((await run(['--approve', '--max-usd', '0.10'], { provider })).code, 0);
  assert.equal(provider.chat().length, 2);
});

test('a Key with no usage_daily is recorded as such and the run still measures the rest', async () => {
  const provider = fakeOpenRouter({ key: { usage: 0, limit: 0.1, limit_remaining: 0.1, limit_reset: 'daily' } });
  const r = await run(['--approve', '--max-usd', '0.10'], { provider });
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  const key = r.results().find((l) => l.kind === 'key_read');
  assert.equal(key.usageDailyPresent, false);
  assert.equal(key.usageDailyType, null);
  assert.match(r.out, /no usage_daily figure/);
});

test('the catalog refuses an unknown price field, a missing row or a price above the ceilings, before any paid call', async () => {
  const cases = [
    [[...CATALOG(), sonarRow({ image: '0.01' })], 'search_price_field_unknown'],
    [CATALOG(), 'search_model_missing'],
    [[...CATALOG(), sonarRow({ completion: '0.00003' })], 'search_price_above_ceiling'],
    [[...CATALOG(), sonarRow({ request: '0.05' })], 'search_price_above_ceiling'],
  ];
  for (const [catalog, problem] of cases) {
    const provider = fakeOpenRouter({ catalog });
    const r = await run(['--approve', '--max-usd', '0.10'], { provider });
    assert.equal(r.code, 1, problem);
    assert.equal(provider.chat().length, 0, problem);
    assert.ok(r.results().find((l) => l.kind === 'catalog').problems.includes(problem), problem);
  }
  assert.deepEqual(checkCatalog([...CATALOG(), sonarRow({ image: '0' })]).problems, [], 'control: a zero price field is fine');
  assert.ok(PRICE_CEILING.search.outputPerM >= 15, 'the mock price sits under the ceiling');
});

test('a 402 on Sonar stops the run, is not retried, and the closing Key read still happens', async () => {
  let sonarCalls = 0;
  const provider = fakeOpenRouter({ sonar: () => { sonarCalls += 1; return json({ error: { code: 402, message: 'Insufficient credits, see https://x.example' } }, 402); } });
  const r = await run(['--approve', '--max-usd', '0.10'], { provider });
  assert.equal(r.code, 1);
  assert.equal(sonarCalls, 1);
  const lines = r.results();
  const sonar = lines.find((l) => l.id === 'sonar');
  assert.equal(sonar.httpStatus, 402);
  assert.equal(sonar.usageMissing, true, 'no figure is counted at the worst case');
  assert.equal(sonar.countedUsd, 0.052);
  assert.ok(lines.some((l) => l.kind === 'key_check'), 'spend is compared with the Key after any paid try');
  assert.ok(!readFileSync(resultFile(r.root), 'utf8').includes('Insufficient'), 'no provider text');
});

test('a call that costs more than its bound stops the run before the next call', async () => {
  const provider = fakeOpenRouter({ decision: () => json({ ...decisionAnswer(), usage: { prompt_tokens: 2000, completion_tokens: 40, cost: 0.09 } }) });
  const r = await run(['--approve', '--max-usd', '0.10'], { provider });
  assert.equal(r.code, 1);
  assert.equal(provider.chat().length, 1, 'Sonar was not called');
  assert.equal(r.results().find((l) => l.kind === 'summary').stopReason, 'above_worst');
});

test('a decision answer outside the search schema is recorded as unparsed, with no text', async () => {
  const provider = fakeOpenRouter({ decision: () => json({ ...decisionAnswer(), choices: [{ finish_reason: 'stop', message: { content: '{"action":"reply","skip_class":"none","crisis":false,"need_search":true,"queries":["奥运"]}' } }] }) });
  const r = await run(['--approve', '--max-usd', '0.10'], { provider });
  assert.equal(r.code, 0);
  const d = r.results().find((l) => l.id === 'decision_search_schema');
  assert.equal(d.parsed, false);
  assert.equal(d.class, 'unparsed');
  assert.equal(d.queryCount, null);
});

test('a body that differs from the plan is not sent; the planned body passes', () => {
  const plan = buildPlan(ROOT);
  const sonar = plan.calls[1];
  assert.equal(presendRefusal(sonar.body, sonar), null, 'control');
  assert.equal(presendRefusal({ ...sonar.body, messages: [{ role: 'user', content: 'other' }] }, sonar), 'body_changed');
  const extra = { ...sonar, body: { ...sonar.body, user: 'U1' } };
  assert.equal(presendRefusal(extra.body, extra), 'body_field');
});

test('results keep listed keys and plain ASCII scalars only', () => {
  const out = sanitizeResult({ kind: 'call', class: 'ok', reason: '巴黎', errorType: 'sk-or-v1-abc', text: 'answer', usageKeys: ['cost', 'sk-or-x', '标题'], promptTokens: 3 });
  assert.deepEqual(out, { kind: 'call', class: 'ok', usageKeys: ['cost'], promptTokens: 3 });
});

test('the address: fixed outside test mode, loopback only inside it', () => {
  assert.equal(resolveEndpoint({}).baseUrl, 'https://openrouter.ai/api/v1');
  assert.throws(() => resolveEndpoint({ CLO_SEARCH_PROBE_TEST_BASE: BASE }), /only allowed in test mode/);
  assert.throws(() => resolveEndpoint({ CLO_TEST_ROOT: '/x', CLO_SEARCH_PROBE_TEST_BASE: 'https://openrouter.ai/api/v1' }), /loopback/);
  assert.equal(resolveEndpoint({ CLO_TEST_ROOT: '/x', CLO_SEARCH_PROBE_TEST_BASE: BASE }).baseUrl, BASE);
});

test('the wrappers are ASCII, clear proxies through _env and run the tool on the private Node', () => {
  for (const name of ['search-probe.ps1', 'search-probe.sh']) {
    const bytes = readFileSync(join(ROOT, 'scripts', name));
    assert.ok(bytes.length > 0 && bytes.every((b) => b < 128), name);
    const text = bytes.toString();
    assert.match(text, /_env\.(ps1|sh)/, name);
    assert.match(text, /src[\\/]tools[\\/]search-probe\.mjs/, name);
  }
  assert.match(readFileSync(join(ROOT, 'scripts', 'search-probe.ps1'), 'utf8'), /\$NodeExe/);
  assert.match(readFileSync(join(ROOT, 'scripts', 'search-probe.sh'), 'utf8'), /exec "\$CLO_NODE"/);
});
