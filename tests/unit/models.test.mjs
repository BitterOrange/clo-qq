import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANTHROPIC_CAPABILITY_LEAVES, anthropicModelChecks, callWorstMicros, checkAnthropicModels, fetchCatalog, lockFromCatalog, lockFromPriceBook, priceBookProblems, priceFor, resolveSelector, validateModels } from '../../src/clo-plugin/lib/core/models.js';
import { computeMicros, worstCaseMicros } from '../../src/clo-plugin/lib/core/providers/cost.js';
import { ANTHROPIC_VERSION } from '../../src/clo-plugin/lib/core/providers/registry.js';
import { FAKE_ANTHROPIC_KEY } from '../harness/fake-keys.mjs';

const reasoning = { mandatory: true, supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low'], default_effort: 'high' };
const opusParams = ['tools', 'reasoning', 'response_format', 'max_tokens'];
const opusPrice = { prompt: '0.000005', completion: '0.00002', input_cache_read: '0.0000005', input_cache_write: '0.00000625' };
const row = (id, created, over = {}) => ({ id, created, pricing: opusPrice, supported_parameters: opusParams, reasoning, top_provider: { max_completion_tokens: 32000, context_length: 200000 }, ...over });
const HAIKU = row('anthropic/claude-haiku-5.5', 90, {
  pricing: { prompt: '0.000001', completion: '0.000005' },
  supported_parameters: ['response_format', 'reasoning', 'max_tokens'],
  reasoning: { mandatory: false, supported_efforts: ['low', 'medium', 'high'] },
});
const catalog = () => structuredClone([
  row('anthropic/claude-opus-5', 50),
  row('anthropic/claude-opus-5.5', 100),
  row('~anthropic/claude-opus-latest', 100),
  row('anthropic/claude-opus-5.5:thinking', 100),
  row('anthropic/claude-sonnet-5.5', 110),
  row('openai/gpt-x', 120),
  HAIKU,
]);
const cfg = (over = {}) => ({
  claudeModel: { id: 'opus-latest', effort: 'low', maxTokens: 3000, contextTokens: 24000 },
  decisionModel: { id: 'anthropic/claude-haiku-5.5', effort: 'none', maxTokens: 200 },
  budget: {},
  qq: { enabled: false },
  ...over,
});

test('opus-latest resolves to the highest concrete version', () => {
  assert.equal(resolveSelector('opus-latest', catalog()), 'anthropic/claude-opus-5.5');
});

test('versions compare as numbers, so 5.10 is above 5.5', () => {
  const c = [...catalog(), row('anthropic/claude-opus-5.10', 200), row('~anthropic/claude-opus-latest-dup', 1)];
  assert.equal(resolveSelector('opus-latest', c), 'anthropic/claude-opus-5.10');
});

test('opus-latest refuses when the top version is not the newest row', () => {
  const c = [...catalog(), row('anthropic/claude-opus-5.4', 300)];
  assert.throws(() => resolveSelector('opus-latest', c), /not the newest/);
});

test('opus-latest refuses when price or reasoning differs from the alias row, or the alias is absent', () => {
  const dearer = catalog();
  dearer.find((m) => m.id.startsWith('~')).pricing = { ...opusPrice, completion: '0.00003' };
  assert.throws(() => resolveSelector('opus-latest', dearer), /differs from the alias/);
  const noThink = catalog();
  noThink.find((m) => m.id.startsWith('~')).reasoning = { mandatory: false, supported_efforts: ['low'] };
  assert.throws(() => resolveSelector('opus-latest', noThink), /differs from the alias/);
  const none = catalog().filter((m) => !m.id.startsWith('~'));
  assert.throws(() => resolveSelector('opus-latest', none), /alias row is absent/);
  assert.throws(() => resolveSelector('opus-latest', [HAIKU]), /no concrete Opus/);
});

test('other ids: anthropic only, no suffix, no alias, no auto', () => {
  assert.equal(resolveSelector('anthropic/claude-opus-5', catalog()), 'anthropic/claude-opus-5');
  for (const bad of ['openrouter/auto', 'openai/gpt-x', '~anthropic/claude-opus-latest', 'anthropic/claude-opus-5.5:thinking']) {
    assert.throws(() => resolveSelector(bad, catalog()), /not allowed|refused/, bad);
  }
});

test('priceFor converts per-token strings to per-million numbers, without float noise', () => {
  assert.deepEqual(priceFor('anthropic/claude-opus-5.5', catalog()), { inputPerM: 5, outputPerM: 20, cacheReadPerM: 0.5, cacheWritePerM: 6.25 });
});

test('priceFor assumes no cache discount when a cache price is missing, and refuses bad rows', () => {
  assert.deepEqual(priceFor('anthropic/claude-haiku-5.5', catalog()), { inputPerM: 1, outputPerM: 5, cacheReadPerM: 1, cacheWritePerM: 1 });
  assert.throws(() => priceFor('nope', catalog()), /not in the catalog/);
  assert.throws(() => priceFor('x', [row('x', 1, { pricing: {} })]), /price missing/);
  assert.throws(() => priceFor('x', [row('x', 1, { pricing: { prompt: '-1', completion: '1' } })]), /bad input price/);
});

test('the plan arithmetic: 24000 x $5/M + 3000 x $20/M = $0.18', () => {
  const p = priceFor('anthropic/claude-opus-5.5', catalog());
  assert.equal(callWorstMicros(p, { contextTokens: 24000, maxTokens: 3000 }), 180000);
  assert.throws(() => callWorstMicros(null, { contextTokens: 1, maxTokens: 1 }), /not locked/);
});

test('validateModels accepts the plan defaults', () => {
  assert.deepEqual(validateModels(cfg(), catalog()).errors, []);
});

test('primary rules: tools, reasoning, supported effort, mandatory none, token limit', () => {
  const noTools = catalog();
  noTools.find((m) => m.id === 'anthropic/claude-opus-5.5').supported_parameters = ['reasoning'];
  noTools.find((m) => m.id.startsWith('~')).supported_parameters = ['reasoning'];
  assert.ok(validateModels(cfg(), noTools).errors.some((e) => /tools/.test(e.message)));

  const bad = (over) => validateModels(cfg({ claudeModel: { id: 'anthropic/claude-opus-5.5', effort: 'low', maxTokens: 3000, contextTokens: 24000, ...over } }), catalog()).errors;
  assert.ok(bad({ effort: 'none' }).some((e) => /mandatory/.test(e.message)));
  assert.ok(bad({ effort: 'minimal' }).some((e) => /supported effort/.test(e.message)));
  assert.ok(bad({ maxTokens: 64000 }).some((e) => /provider limit/.test(e.message)));
  assert.ok(bad({ id: 'anthropic/claude-gone' }).some((e) => /not in the catalog/.test(e.message)));
  assert.ok(bad({ id: 'openai/gpt-x' }).some((e) => e.path === 'claudeModel.id'));
});

test('an expensive model needs --confirm-price', () => {
  const dear = catalog();
  const pricey = { ...opusPrice, completion: '0.00005' };
  dear.find((m) => m.id === 'anthropic/claude-opus-5.5').pricing = pricey;
  dear.find((m) => m.id.startsWith('~')).pricing = pricey;
  assert.ok(validateModels(cfg(), dear).errors.some((e) => /confirm-price/.test(e.message)));
  assert.deepEqual(validateModels(cfg(), dear, { confirmPrice: true }).errors, []);
});

test('decision rules: response_format required; none refused when reasoning is mandatory', () => {
  const noFormat = catalog();
  noFormat.find((m) => m.id === HAIKU.id).supported_parameters = ['reasoning'];
  assert.ok(validateModels(cfg(), noFormat).errors.some((e) => /response_format/.test(e.message)));

  const mandatory = catalog();
  mandatory.find((m) => m.id === HAIKU.id).reasoning = { mandatory: true, supported_efforts: ['low'] };
  assert.ok(validateModels(cfg(), mandatory).errors.some((e) => e.path === 'decisionModel.effort'));

  const low = cfg({ decisionModel: { id: HAIKU.id, effort: 'low', maxTokens: 200 } });
  const r = validateModels(low, mandatory);
  assert.ok(r.errors.some((e) => e.path === 'decisionModel.maxTokens'));
  assert.equal(r.warnings.length, 1);
  const enough = cfg({ decisionModel: { id: HAIKU.id, effort: 'low', maxTokens: 2000 } });
  assert.deepEqual(validateModels(enough, mandatory).errors, []);
});

test('a model change needs the platform flag only while QQ is on', () => {
  const on = cfg({ qq: { enabled: true } });
  assert.ok(validateModels(on, catalog(), { change: true }).errors.some((e) => /qq-platform-notified/.test(e.message)));
  assert.deepEqual(validateModels(on, catalog(), { change: true, qqPlatformNotified: true }).errors, []);
  assert.deepEqual(validateModels(on, catalog()).errors, [], 'no change, no flag needed');
  assert.deepEqual(validateModels(cfg(), catalog(), { change: true }).errors, [], 'QQ off');
});

test('lockFromCatalog gives what buildEffective takes', () => {
  const lock = lockFromCatalog(cfg(), catalog());
  assert.equal(lock.primary.id, 'anthropic/claude-opus-5.5');
  assert.equal(lock.primary.selector, 'opus-latest');
  assert.equal(lock.primary.price.outputPerM, 20);
  assert.equal(lock.decision.id, HAIKU.id);
  assert.equal(lock.decision.price.inputPerM, 1);
});

test('fetchCatalog reads /models with no key, and refuses a failure or a bad shape', async () => {
  const calls = [];
  const ok = await fetchCatalog({ baseUrl: 'http://mock/api/v1', fetch: async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ data: [HAIKU] }) }; } });
  assert.deepEqual(ok, [HAIKU]);
  assert.equal(calls[0].url, 'http://mock/api/v1/models');
  assert.equal(calls[0].init.headers, undefined, 'the catalog needs no key');
  await assert.rejects(fetchCatalog({ baseUrl: 'x', fetch: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
  await assert.rejects(fetchCatalog({ baseUrl: 'x', fetch: async () => ({ ok: true, json: async () => ({}) }) }), /unexpected shape/);
});

// ---- Anthropic direct ----

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const IDS = { primary: 'claude-opus-5-5', decision: 'claude-haiku-5-5' };
const BOOK = () => ({
  checkedOn: '2000-01-01',
  source: 'test',
  unverified: [],
  models: {
    'claude-opus-5-5': { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2, cacheWritePerM: 5, cacheWrite1hPerM: 8 },
    'claude-haiku-5-5': {
      inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01, cacheWritePerM: 0.125, cacheWrite1hPerM: 0.2,
      long: { aboveTokens: 100000, inputPerM: 0.5, outputPerM: 2.5, cacheReadPerM: 0.05, cacheWritePerM: 0.625, cacheWrite1hPerM: 1 },
    },
  },
});
const pathsOf = (r) => r.errors.map((e) => e.path);

test('the project price book: the published Opus 5.5 and Haiku 5.5 rates, nothing unverified, and usable by cost.js', () => {
  const book = JSON.parse(readFileSync(join(ROOT, 'versions.lock.json'), 'utf8')).models.priceBooks.anthropic;
  assert.deepEqual(priceBookProblems(book), []);
  assert.deepEqual(book.unverified, []);
  assert.match(book.source, /platform\.claude\.com\/docs\/en\/about-claude\/pricing/);
  // Opus 5.5: $4 / $20, cache read $0.20, writes 1.25x and 2x the input rate.
  assert.deepEqual(book.models['claude-opus-5-5'], { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2, cacheWritePerM: 5, cacheWrite1hPerM: 8 });
  // Haiku 5.5: $0.10 / $0.50 up to 100K prompt tokens, $0.50 / $2.50 above; cache 0.1x, 1.25x, 2x of each card's input.
  assert.deepEqual(book.models['claude-haiku-5-5'], BOOK().models['claude-haiku-5-5']);
  const r = lockFromPriceBook(IDS, book, { confirmPrice: true });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  // The documented arithmetic: 24000 x $5/M + 3000 x $20/M = $0.18 per required Opus reply, before the 1.1x geo factor.
  assert.equal(worstCaseMicros({ input: 24000, output: 3000 }, r.lock.primary.price, { geoUs: false }), 180000);
  assert.equal(computeMicros({ input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, geo: 'global', speed: 'standard' }, r.lock.decision.price).micros, 150);
});

test('lockFromPriceBook: the first lock, a different id and any price change need --confirm-price; the same price does not', () => {
  const first = lockFromPriceBook(IDS, BOOK());
  assert.equal(first.ok, false);
  assert.ok(first.errors.some((e) => /confirm-price/.test(e.message)));
  const ok = lockFromPriceBook(IDS, BOOK(), { confirmPrice: true });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.lock.primary, { id: 'claude-opus-5-5', selector: 'claude-opus-5-5', price: BOOK().models['claude-opus-5-5'] });
  assert.deepEqual(ok.lock.decision, { id: 'claude-haiku-5-5', price: BOOK().models['claude-haiku-5-5'] });
  assert.deepEqual(lockFromPriceBook(IDS, BOOK(), { previous: ok.lock }).errors, [], 'the same ids and prices');
  const changes = [
    (b) => { b.models['claude-opus-5-5'].cacheWrite1hPerM = 9; },
    (b) => { b.models['claude-haiku-5-5'].long.outputPerM = 3; },
    (b) => { b.models['claude-haiku-5-5'].long.aboveTokens = 50000; },
    (b) => { delete b.models['claude-haiku-5-5'].long; },
    // A fall: nothing reconciles an Anthropic lock, so a book typed too low would under-count in silence.
    (b) => { b.models['claude-opus-5-5'].outputPerM = 19; },
    (b) => { b.models['claude-opus-5-5'].outputPerM = 2; b.models['claude-opus-5-5'].inputPerM = 0.4; },
    (b) => { b.models['claude-haiku-5-5'].cacheReadPerM = 0.005; },
    (b) => { b.models['claude-haiku-5-5'].long.aboveTokens = 200000; },
  ];
  for (const mutate of changes) {
    const b = BOOK();
    mutate(b);
    assert.ok(pathsOf(lockFromPriceBook(IDS, b, { previous: ok.lock })).includes('price'), String(mutate));
    assert.equal(lockFromPriceBook(IDS, b, { previous: ok.lock, confirmPrice: true }).ok, true, String(mutate));
  }
  const otherBook = BOOK();
  otherBook.models['claude-sonnet-5-5'] = { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5, cacheWrite1hPerM: 4 };
  assert.ok(pathsOf(lockFromPriceBook({ ...IDS, primary: 'claude-sonnet-5-5' }, otherBook, { previous: ok.lock })).includes('price'), 'a different id');
});

test('lockFromPriceBook refuses a missing book price, a rate marked unverified, a bad id and an output above the ceiling', () => {
  const missing = lockFromPriceBook({ ...IDS, primary: 'claude-sonnet-5-5' }, BOOK(), { confirmPrice: true });
  assert.ok(pathsOf(missing).includes('primary'));
  assert.equal(missing.lock, null);
  for (const unverified of [['claude-haiku-5-5'], ['claude-haiku-5-5.long.cacheReadPerM']]) {
    const b = BOOK();
    b.unverified = unverified;
    const r = lockFromPriceBook(IDS, b, { confirmPrice: true });
    assert.ok(pathsOf(r).includes('decision'), String(unverified));
    assert.equal(r.ok, false);
  }
  const otherOnly = BOOK();
  otherOnly.unverified = ['claude-haiku-5-5-x'];
  assert.equal(lockFromPriceBook(IDS, otherOnly, { confirmPrice: true }).ok, true, 'a path of another id does not count');
  for (const id of ['claude-opus-latest', 'anthropic/claude-opus-5.5', 'claude-opus-5-5-20261101', 'claude-fable-5-1']) {
    assert.ok(pathsOf(lockFromPriceBook({ ...IDS, primary: id }, BOOK(), { confirmPrice: true })).includes('primary'), id);
  }
  const dear = BOOK();
  dear.models['claude-opus-5-5'].outputPerM = 40;
  assert.ok(lockFromPriceBook(IDS, dear, { confirmPrice: false, previous: lockFromPriceBook(IDS, BOOK(), { confirmPrice: true }).lock }).errors.some((e) => e.path === 'primary' && /\$30/.test(e.message)));
  assert.equal(lockFromPriceBook(IDS, dear, { confirmPrice: true }).ok, true);
  assert.ok(pathsOf(lockFromPriceBook(IDS, dear, { confirmPrice: false, maxOutputPerM: 50 })).every((p) => p !== 'primary'), 'a higher ceiling');
});

test('lockFromPriceBook: a lowered book relocks only with --confirm-price, and a confirmed one settles at the new rate', () => {
  const first = lockFromPriceBook(IDS, BOOK(), { confirmPrice: true });
  assert.equal(first.ok, true);
  // Every Opus rate a tenth of the real one: the rates still fit together, so only the confirmation catches it.
  const typo = BOOK();
  typo.models['claude-opus-5-5'] = { inputPerM: 0.4, outputPerM: 2, cacheReadPerM: 0.02, cacheWritePerM: 0.5, cacheWrite1hPerM: 0.8 };
  assert.deepEqual(priceBookProblems(typo), []);
  const silent = lockFromPriceBook(IDS, typo, { previous: first.lock });
  assert.equal(silent.ok, false);
  assert.equal(silent.lock, null);
  assert.ok(silent.errors.some((e) => e.path === 'price' && /confirm-price/.test(e.message)), JSON.stringify(silent.errors));
  // Positive controls in the same run: an unchanged relock passes, and the confirmed relock carries the new rate.
  assert.equal(lockFromPriceBook(IDS, BOOK(), { previous: first.lock }).ok, true);
  const confirmed = lockFromPriceBook(IDS, typo, { previous: first.lock, confirmPrice: true });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.lock.primary.price.outputPerM, 2);
});

test('priceBookProblems: the rates of a card must fit together', () => {
  assert.deepEqual(priceBookProblems(BOOK()), [], 'the shipped rates fit');
  const cases = [
    ['models.claude-opus-5-5.cacheWritePerM', (b) => { b.models['claude-opus-5-5'].cacheWritePerM = 0.5; }],
    ['models.claude-opus-5-5.inputPerM', (b) => { b.models['claude-opus-5-5'].cacheReadPerM = 5; }],
    ['models.claude-opus-5-5.cacheWrite1hPerM', (b) => { b.models['claude-opus-5-5'].cacheWrite1hPerM = 4.9; }],
    ['models.claude-opus-5-5.outputPerM', (b) => { b.models['claude-opus-5-5'].outputPerM = 2; b.models['claude-opus-5-5'].inputPerM = 4; }],
    ['models.claude-haiku-5-5.long.cacheWritePerM', (b) => { b.models['claude-haiku-5-5'].long.cacheWritePerM = 0.4; }],
    ['models.claude-haiku-5-5.long.outputPerM', (b) => { b.models['claude-haiku-5-5'].long.outputPerM = 0.4; }],
    // In order within the long card, but cheaper than the short card.
    ['models.claude-haiku-5-5.long.inputPerM', (b) => { b.models['claude-haiku-5-5'].long.inputPerM = 0.05; }],
  ];
  for (const [path, mutate] of cases) {
    const b = BOOK();
    mutate(b);
    const problems = priceBookProblems(b);
    assert.ok(problems.some((p) => p.path === path), `${path}: ${JSON.stringify(problems)}`);
    assert.equal(lockFromPriceBook(IDS, b, { confirmPrice: true }).ok, false, path);
  }
  // Equal rates fit: the order is not strict.
  const flat = BOOK();
  Object.assign(flat.models['claude-opus-5-5'], { inputPerM: 4, outputPerM: 4, cacheReadPerM: 4, cacheWritePerM: 4, cacheWrite1hPerM: 4 });
  assert.deepEqual(priceBookProblems(flat), []);
});

test('priceBookProblems: every rate written out and positive, no unknown field, a long card with its threshold', () => {
  assert.deepEqual(priceBookProblems(BOOK()), []);
  const cases = [
    ['models.claude-opus-5-5.cacheWrite1hPerM', (b) => { delete b.models['claude-opus-5-5'].cacheWrite1hPerM; }],
    ['models.claude-opus-5-5.inputPerM', (b) => { b.models['claude-opus-5-5'].inputPerM = 0; }],
    ['models.claude-opus-5-5.outputPerM', (b) => { b.models['claude-opus-5-5'].outputPerM = '20'; }],
    ['models.claude-opus-5-5.batchPerM', (b) => { b.models['claude-opus-5-5'].batchPerM = 2; }],
    ['models.claude-haiku-5-5.long.aboveTokens', (b) => { b.models['claude-haiku-5-5'].long.aboveTokens = 0; }],
    ['models.claude-haiku-5-5.long.cacheReadPerM', (b) => { delete b.models['claude-haiku-5-5'].long.cacheReadPerM; }],
    ['models.anthropic/claude-x', (b) => { b.models['anthropic/claude-x'] = b.models['claude-opus-5-5']; }],
    ['checkedOn', (b) => { b.checkedOn = 'yesterday'; }],
    ['source', (b) => { b.source = ' '; }],
    ['unverified', (b) => { delete b.unverified; }],
    ['models', (b) => { b.models = {}; }],
  ];
  for (const [path, mutate] of cases) {
    const b = BOOK();
    mutate(b);
    assert.ok(priceBookProblems(b).some((p) => p.path === path), `${path}: ${JSON.stringify(priceBookProblems(b))}`);
  }
  assert.deepEqual(priceBookProblems(null), [{ path: '', message: 'no price book' }]);
});

// A scripted Anthropic Models API. Answers the documented shape: max_tokens and a capability tree with `supported`.
const effortTree = (levels) => Object.fromEntries([['supported', true], ...['low', 'medium', 'high', 'xhigh', 'max'].map((l) => [l, { supported: levels.includes(l) }])]);
const modelBody = (id, over = {}) => ({
  id,
  type: 'model',
  max_input_tokens: 1000000,
  max_tokens: 128000,
  capabilities: {
    structured_outputs: { supported: true },
    thinking: { supported: true, types: { enabled: { supported: false }, adaptive: { supported: true }, disabled: { supported: id.includes('haiku') } } },
    effort: effortTree(['low', 'medium', 'high', 'xhigh', 'max']),
  },
  ...over,
});
function modelsApi(bodies = {}, { status = {} } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const id = decodeURIComponent(String(url).split('/v1/models/')[1] ?? '');
    if (status[id]) return new Response(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `model: ${id} PROVIDER-TEXT` } }), { status: status[id] });
    return new Response(JSON.stringify(bodies[id] ?? modelBody(id)), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}
const anthropicCfg = (over = {}) => ({
  claudeModel: { id: 'opus-latest', effort: 'low', maxTokens: 3000, contextTokens: 24000 },
  decisionModel: { id: 'anthropic/claude-haiku-5.5', effort: 'none', maxTokens: 200 },
  providers: { anthropic: { kind: 'anthropic', keyEnv: 'CLO_ANTHROPIC_API_KEY', models: { ...IDS } } },
  activeProvider: 'anthropic',
  ...over,
});
const check = (api, models = anthropicModelChecks(anthropicCfg()), over = {}) => checkAnthropicModels({ fetch: api.fetch, baseUrl: 'http://127.0.0.1:9', key: FAKE_ANTHROPIC_KEY, models, ...over });

test('checkAnthropicModels reads each model with x-api-key and the version, no Authorization, no redirect, the Key in a header only', async () => {
  const api = modelsApi();
  const r = await check(api);
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.rows.map((x) => [x.role, x.id, x.maxTokens]), [['primary', 'claude-opus-5-5', 128000], ['decision', 'claude-haiku-5-5', 128000]]);
  assert.deepEqual(r.rows[1].caps, { effort: true, structured_outputs: true, thinking_disabled: true });
  assert.deepEqual(api.calls.map((c) => c.url), ['http://127.0.0.1:9/v1/models/claude-opus-5-5', 'http://127.0.0.1:9/v1/models/claude-haiku-5-5']);
  for (const c of api.calls) {
    assert.equal(c.init.method, 'GET');
    assert.equal(c.init.redirect, 'error');
    assert.deepEqual(Object.keys(c.init.headers).sort(), ['anthropic-version', 'x-api-key']);
    assert.equal(c.init.headers['x-api-key'], FAKE_ANTHROPIC_KEY);
    assert.equal(c.init.headers['anthropic-version'], ANTHROPIC_VERSION);
    assert.equal(c.url.includes(FAKE_ANTHROPIC_KEY), false);
    assert.equal(c.init.body, undefined);
  }
  assert.equal(JSON.stringify(r).includes(FAKE_ANTHROPIC_KEY), false, 'the result never carries the Key');
});

test('checkAnthropicModels refuses a missing capability: the effort sent, structured outputs and disabled thinking for the decision', async () => {
  const noLow = modelBody('claude-opus-5-5');
  noLow.capabilities.effort = effortTree(['medium', 'high']);
  assert.deepEqual((await check(modelsApi({ 'claude-opus-5-5': noLow }))).problems, ['primary:capability_missing:effort']);
  // The decision is sent at effort low with thinking disabled, whatever 'none' reads as.
  const haikuNoLow = modelBody('claude-haiku-5-5');
  haikuNoLow.capabilities.effort = effortTree(['medium']);
  assert.deepEqual((await check(modelsApi({ 'claude-haiku-5-5': haikuNoLow }))).problems, ['decision:capability_missing:effort']);
  const noFormat = modelBody('claude-haiku-5-5');
  noFormat.capabilities.structured_outputs.supported = false;
  assert.deepEqual((await check(modelsApi({ 'claude-haiku-5-5': noFormat }))).problems, ['decision:capability_missing:structured_outputs']);
  const noOff = modelBody('claude-haiku-5-5');
  noOff.capabilities.thinking.types.disabled.supported = false;
  assert.deepEqual((await check(modelsApi({ 'claude-haiku-5-5': noOff }))).problems, ['decision:capability_missing:thinking_disabled']);
  // The disabled-thinking leaf is not in the reference: absent, it is unknown, which refuses as well.
  assert.equal(ANTHROPIC_CAPABILITY_LEAVES.thinking_disabled.documented, false);
  const unknown = modelBody('claude-haiku-5-5');
  delete unknown.capabilities.thinking.types.disabled;
  assert.deepEqual((await check(modelsApi({ 'claude-haiku-5-5': unknown }))).problems, ['decision:capability_unknown:thinking_disabled']);
  const bare = modelBody('claude-opus-5-5');
  delete bare.capabilities;
  assert.deepEqual((await check(modelsApi({ 'claude-opus-5-5': bare }))).problems, ['primary:capability_unknown:effort']);
  // The primary is not asked for disabled thinking: Opus 5.5 cannot turn it off and is never sent so.
  assert.deepEqual(Object.keys((await check(modelsApi())).rows[0].caps), ['effort']);
  // Positive control on the configured effort: medium on the primary.
  const medium = anthropicModelChecks(anthropicCfg({ claudeModel: { id: 'opus-latest', effort: 'medium', maxTokens: 3000, contextTokens: 24000 } }));
  assert.deepEqual((await check(modelsApi({ 'claude-opus-5-5': noLow }), medium)).problems, []);
});

test('checkAnthropicModels: limits, HTTP errors, a wrong id, the network; short codes only, never provider text', async () => {
  const small = modelBody('claude-opus-5-5', { max_tokens: 2000 });
  assert.deepEqual((await check(modelsApi({ 'claude-opus-5-5': small }))).problems, ['primary:max_tokens_above_limit']);
  const noLimit = modelBody('claude-opus-5-5', { max_tokens: '128000' });
  assert.deepEqual((await check(modelsApi({ 'claude-opus-5-5': noLimit }))).problems, ['primary:max_tokens_unknown']);
  const gone = await check(modelsApi({}, { status: { 'claude-haiku-5-5': 404 } }));
  assert.deepEqual(gone.problems, ['decision:http_404']);
  assert.equal(JSON.stringify(gone).includes('PROVIDER-TEXT'), false);
  const swapped = modelBody('claude-opus-5', {});
  assert.deepEqual((await check(modelsApi({ 'claude-opus-5-5': swapped }))).problems, ['primary:model_mismatch']);
  const broken = { fetch: async () => new Response('{ nope', { status: 200 }) };
  assert.deepEqual((await check(broken)).problems, ['primary:bad_body', 'decision:bad_body']);
  const down = { fetch: async () => { throw new Error(`connect failed with ${FAKE_ANTHROPIC_KEY}`); } };
  const r = await check(down);
  assert.deepEqual(r.problems, ['primary:network', 'decision:network']);
  assert.equal(JSON.stringify(r).includes(FAKE_ANTHROPIC_KEY), false);
});

test('checkAnthropicModels makes no call without a Key, a base, models or a valid id', async () => {
  const api = modelsApi();
  assert.deepEqual((await check(api, undefined, { key: '' })).problems, ['key_missing']);
  assert.deepEqual((await check(api, undefined, { baseUrl: null })).problems, ['base_url_missing']);
  assert.deepEqual((await check(api, null)).problems, ['models_missing']);
  assert.deepEqual((await check(api, [{ role: 'primary', id: 'claude-opus-5-5/../x', effort: 'low', maxTokens: 1 }])).problems, ['primary:bad_id']);
  assert.equal(api.calls.length, 0);
  // Positive control: the same api answers a valid call.
  assert.equal((await check(api)).ok, true);
  assert.equal(api.calls.length, 2);
  // One read for one id, even when both roles use it.
  const same = modelsApi();
  const both = anthropicModelChecks(anthropicCfg({ providers: { anthropic: { kind: 'anthropic', keyEnv: 'CLO_ANTHROPIC_API_KEY', models: { primary: 'claude-haiku-5-5', decision: 'claude-haiku-5-5' } } } }));
  assert.equal((await check(same, both)).ok, true);
  assert.equal(same.calls.length, 1);
  assert.equal(anthropicModelChecks({ ...anthropicCfg(), activeProvider: 'openrouter', providers: { openrouter: { kind: 'openrouter' } } }), null);
});
