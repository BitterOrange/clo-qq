import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callWorstMicros, fetchCatalog, lockFromCatalog, priceFor, resolveSelector, validateModels } from '../../src/clo-plugin/lib/core/models.js';

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
