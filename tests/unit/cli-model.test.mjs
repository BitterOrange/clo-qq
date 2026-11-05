// Model commands with an injected catalog. A refused change must leave config and lock untouched.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { baseConfig, CATALOG, catalogRow, clo, configOf, effectiveOf, enabledConfig, fakeProvider, makeRoot, openclawOf, readJson } from './_cli-helper.mjs';

const roots = [];
const root = (label, cfg) => {
  const r = makeRoot(label, cfg);
  roots.push(r);
  return r.root;
};
after(() => roots.forEach((r) => r.cleanup()));

const snapshot = (r) => [readFileSync(join(r, 'config.json'), 'utf8'), readFileSync(join(r, 'versions.lock.json'), 'utf8')];
const lockOf = (r) => readJson(join(r, 'versions.lock.json')).models;

test('show works without a network call or a lock', async () => {
  const r = root('show');
  const res = await clo(r, ['model', 'show']);
  assert.equal(res.code, 0);
  assert.match(res.out, /opus-latest/);
  assert.match(res.out, /还没有/);
});

test('refresh resolves opus-latest to a concrete id, locks prices, and renders them', async () => {
  const r = root('refresh', enabledConfig());
  const p = fakeProvider();
  const res = await clo(r, ['model', 'refresh'], { fetch: p.fetch });
  assert.equal(res.code, 0, `${res.out}${res.err}`);
  const lock = lockOf(r).lock;
  assert.equal(lock.primary.id, 'anthropic/claude-opus-5.5');
  assert.equal(lock.primary.selector, 'opus-latest');
  assert.equal(lock.primary.price.outputPerM, 20);
  assert.equal(lock.decision.id, 'anthropic/claude-haiku-5.5');
  assert.equal(lockOf(r).primaryResolved, 'anthropic/claude-opus-5.5');
  assert.equal(effectiveOf(r).models.primary.id, 'anthropic/claude-opus-5.5');
  assert.equal(effectiveOf(r).models.primary.price.inputPerM, 5);
  assert.equal(openclawOf(r).agents.defaults.model.primary, 'openrouter/anthropic/claude-opus-5.5');
  assert.deepEqual(openclawOf(r).agents.defaults.model.fallbacks, []);
  assert.equal(p.calls.every((c) => c.url.startsWith('http://127.0.0.1:9')), true);
  assert.equal(p.calls.every((c) => c.auth === null), true, 'the catalog read sends no key');
  const show = await clo(r, ['model', 'show']);
  assert.match(show.out, /\$0\.1800/, 'plan arithmetic: 24000 x $5/M + 3000 x $20/M');
});

test('other fields of versions.lock.json survive a refresh', async () => {
  const r = root('keeps');
  const before = readJson(join(r, 'versions.lock.json'));
  await clo(r, ['model', 'refresh'], { fetch: fakeProvider().fetch });
  const after_ = readJson(join(r, 'versions.lock.json'));
  assert.deepEqual(after_.npm, before.npm);
  assert.deepEqual(after_.node, before.node);
  assert.deepEqual(after_.parked, before.parked);
});

test('with QQ on, any model change needs --qq-platform-notified, and refusal writes nothing', async () => {
  const r = root('notify', enabledConfig());
  const p = fakeProvider();
  await clo(r, ['model', 'refresh'], { fetch: p.fetch });
  const before = snapshot(r);
  const refused = await clo(r, ['model', 'set-primary', 'anthropic/claude-sonnet-5.5'], { fetch: p.fetch });
  assert.equal(refused.code, 1);
  assert.match(refused.err, /--qq-platform-notified/);
  assert.deepEqual(snapshot(r), before);
  assert.equal((await clo(r, ['model', 'set-decision', 'anthropic/claude-sonnet-5.5'], { fetch: p.fetch })).code, 1);
  assert.deepEqual(snapshot(r), before);

  const ok = await clo(r, ['model', 'set-primary', 'anthropic/claude-sonnet-5.5', '--qq-platform-notified'], { fetch: p.fetch });
  assert.equal(ok.code, 0, `${ok.out}${ok.err}`);
  assert.equal(configOf(r).claudeModel.id, 'anthropic/claude-sonnet-5.5');
  assert.equal(effectiveOf(r).models.primary.id, 'anthropic/claude-sonnet-5.5');
  const changes = lockOf(r).changes;
  assert.equal(changes.length, 1);
  assert.equal(changes[0].qqPlatformNotified, true);
  assert.equal(changes[0].primary, 'anthropic/claude-sonnet-5.5');
});

test('with QQ off, no notification flag is needed', async () => {
  const r = root('qqoff');
  const res = await clo(r, ['model', 'set-primary', 'anthropic/claude-sonnet-5.5'], { fetch: fakeProvider().fetch });
  assert.equal(res.code, 0, `${res.out}${res.err}`);
});

test('refused ids: auto, other vendors, suffixes, aliases, unknown', async () => {
  const r = root('ids');
  const p = fakeProvider();
  await clo(r, ['model', 'refresh'], { fetch: p.fetch });
  const before = snapshot(r);
  for (const id of ['openrouter/auto', 'openai/gpt-x', 'anthropic/claude-opus-5.5:thinking', '~anthropic/claude-opus-latest', 'anthropic/not-listed']) {
    const res = await clo(r, ['model', 'set-primary', id], { fetch: p.fetch });
    assert.notEqual(res.code, 0, id);
    assert.deepEqual(snapshot(r), before, id);
  }
});

test('a price above the ceiling needs --confirm-price', async () => {
  const r = root('price');
  const dear = catalogRow('anthropic/claude-opus-dear', 60, { pricing: { prompt: '0.00001', completion: '0.00004' } });
  const p = fakeProvider({ catalog: [...CATALOG(), dear] });
  const refused = await clo(r, ['model', 'set-primary', 'anthropic/claude-opus-dear'], { fetch: p.fetch });
  assert.equal(refused.code, 1);
  assert.match(refused.err, /--confirm-price/);
  assert.equal(configOf(r).claudeModel.id, 'opus-latest');
  const ok = await clo(r, ['model', 'set-primary', 'anthropic/claude-opus-dear', '--confirm-price'], { fetch: p.fetch });
  assert.equal(ok.code, 0, `${ok.out}${ok.err}`);
});

test('a price rise on the same model also needs --confirm-price', async () => {
  const r = root('rise');
  const p = fakeProvider();
  await clo(r, ['model', 'refresh'], { fetch: p.fetch });
  const before = snapshot(r);
  for (const m of p.state.catalog) {
    if (m.id.includes('opus')) m.pricing = { ...m.pricing, prompt: '0.000006' };
  }
  const res = await clo(r, ['model', 'refresh'], { fetch: p.fetch });
  assert.equal(res.code, 1);
  assert.match(res.err, /--confirm-price/);
  assert.deepEqual(snapshot(r), before);
  assert.equal((await clo(r, ['model', 'refresh', '--confirm-price'], { fetch: p.fetch })).code, 0);
  assert.equal(lockOf(r).lock.primary.price.inputPerM, 6);
});

test('a new Opus does not take over until refresh, and refresh then needs the notice', async () => {
  const r = root('newopus', enabledConfig());
  const p = fakeProvider();
  await clo(r, ['model', 'refresh'], { fetch: p.fetch });
  p.state.catalog.push(catalogRow('anthropic/claude-opus-5.6', 200));
  p.state.catalog.find((m) => m.id.startsWith('~')).created = 200;

  const check = await clo(r, ['model', 'check'], { fetch: p.fetch });
  assert.equal(check.code, 0);
  assert.match(check.out, /与锁定不同/);
  assert.equal(effectiveOf(r).models.primary.id, 'anthropic/claude-opus-5.5', 'check writes nothing');

  const before = snapshot(r);
  const refused = await clo(r, ['model', 'refresh'], { fetch: p.fetch });
  assert.equal(refused.code, 1);
  assert.deepEqual(snapshot(r), before);
  assert.equal((await clo(r, ['model', 'refresh', '--qq-platform-notified'], { fetch: p.fetch })).code, 0);
  assert.equal(effectiveOf(r).models.primary.id, 'anthropic/claude-opus-5.6');
});

test('check reports failures, and writes nothing', async () => {
  const r = root('check');
  const p = fakeProvider({ catalog: CATALOG().filter((m) => !m.id.includes('haiku')) });
  const before = snapshot(r);
  const res = await clo(r, ['model', 'check'], { fetch: p.fetch });
  assert.equal(res.code, 1);
  assert.match(res.out, /decisionModel/);
  assert.deepEqual(snapshot(r), before);
});

test('an unreadable catalog is reported and changes nothing', async () => {
  const r = root('down');
  const before = snapshot(r);
  const res = await clo(r, ['model', 'refresh'], { fetch: async () => new Response('', { status: 503 }) });
  assert.equal(res.code, 1);
  assert.match(res.err, /读不到模型目录/);
  assert.deepEqual(snapshot(r), before);
});

test('a model edited by hand in config.json stops apply, rather than running on the wrong lock', async () => {
  const r = root('handmodel');
  await clo(r, ['model', 'refresh'], { fetch: fakeProvider().fetch });
  const cfg = configOf(r);
  cfg.claudeModel.id = 'anthropic/claude-sonnet-5.5';
  writeFileSync(join(r, 'config.json'), JSON.stringify(cfg));
  const res = await clo(r, ['apply']);
  assert.equal(res.code, 1);
  assert.match(res.err, /clo model refresh/);
  assert.equal(effectiveOf(r).models.primary.id, 'anthropic/claude-opus-5.5');
  assert.equal((await clo(r, ['model', 'refresh'], { fetch: fakeProvider().fetch })).code, 0);
  assert.equal(effectiveOf(r).models.primary.id, 'anthropic/claude-sonnet-5.5');
});

test('test mode refuses a real endpoint before fetch is ever called', async () => {
  const cfg = baseConfig();
  delete cfg.openrouter;
  const r = root('guard', cfg);
  let called = 0;
  const res = await clo(r, ['model', 'refresh'], { fetch: async () => { called += 1; return new Response('{}'); } });
  assert.equal(res.code, 1);
  assert.match(res.err, /non-loopback/);
  assert.equal(called, 0);
});

test('a budget too small for one required turn is called out', async () => {
  const cfg = baseConfig();
  Object.assign(cfg.budget, { dailyUsd: 0.2, interjectUsd: 0.1, searchUsd: 0.1, namedUsd: 0.2, addressedUsd: 0.2 });
  const r = root('tinybudget', cfg);
  const res = await clo(r, ['model', 'refresh'], { fetch: fakeProvider().fetch });
  assert.equal(res.code, 0);
  assert.match(res.out, /永远得不到额度/);
});
