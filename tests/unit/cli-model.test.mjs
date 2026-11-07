// Model commands with an injected catalog. A refused change must leave config and lock untouched.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { baseConfig, CATALOG, catalogRow, clo, configOf, effectiveOf, enabledConfig, fakeProvider, makeRoot, openclawOf, readJson, readyForLive, recordProvider, TEST_ANTHROPIC_BOOK, withProviders, writePriceBook } from './_cli-helper.mjs';

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

const newOpus = (p) => {
  p.state.catalog.push(catalogRow('anthropic/claude-opus-5.6', 200));
  p.state.catalog.find((m) => m.id.startsWith('~')).created = 200;
};

test('set-primary to the same selector counts as a change when it resolves to a new model', async () => {
  const r = root('sameselector', enabledConfig());
  const p = fakeProvider();
  await clo(r, ['model', 'refresh'], { fetch: p.fetch });
  const same = await clo(r, ['model', 'set-primary', 'opus-latest'], { fetch: p.fetch });
  assert.equal(same.code, 0, `positive control, nothing new: ${same.out}${same.err}`);
  assert.equal(lockOf(r).changes.length, 0);

  newOpus(p);
  const before = snapshot(r);
  const refused = await clo(r, ['model', 'set-primary', 'opus-latest'], { fetch: p.fetch });
  assert.equal(refused.code, 1);
  assert.match(refused.err, /--qq-platform-notified/);
  assert.deepEqual(snapshot(r), before);
  assert.equal(effectiveOf(r).models.primary.id, 'anthropic/claude-opus-5.5');

  assert.equal((await clo(r, ['model', 'set-primary', 'opus-latest', '--qq-platform-notified'], { fetch: p.fetch })).code, 0);
  assert.equal(lockOf(r).lock.primary.id, 'anthropic/claude-opus-5.6');
  assert.equal(lockOf(r).changes.length, 1);
});

test('a set command does not carry along the other model: it refuses and points at refresh', async () => {
  const r = root('otherslot', enabledConfig());
  const p = fakeProvider();
  await clo(r, ['model', 'refresh'], { fetch: p.fetch });
  newOpus(p);
  let before = snapshot(r);
  // With the flag given, so that this refusal cannot be the platform-notice one.
  const decision = await clo(r, ['model', 'set-decision', 'anthropic/claude-sonnet-5.5', '--qq-platform-notified'], { fetch: p.fetch });
  assert.equal(decision.code, 1);
  assert.match(decision.err, /主模型现在解析到 anthropic\/claude-opus-5\.6/);
  assert.match(decision.err, /clo model refresh/);
  assert.deepEqual(snapshot(r), before);

  await clo(r, ['model', 'refresh', '--qq-platform-notified'], { fetch: p.fetch });
  const cfg = configOf(r);
  cfg.decisionModel.id = 'anthropic/claude-sonnet-5.5';
  writeFileSync(join(r, 'config.json'), JSON.stringify(cfg));
  before = snapshot(r);
  const primary = await clo(r, ['model', 'set-primary', 'anthropic/claude-opus-5', '--qq-platform-notified'], { fetch: p.fetch });
  assert.equal(primary.code, 1);
  assert.match(primary.err, /判定模型现在解析到/);
  assert.deepEqual(snapshot(r), before);
});

test('a bad id on a set command still reports through the model check, with a lock in place', async () => {
  const r = root('badset');
  const p = fakeProvider();
  await clo(r, ['model', 'refresh'], { fetch: p.fetch });
  for (const sub of ['set-primary', 'set-decision']) {
    const res = await clo(r, ['model', sub, 'openrouter/auto'], { fetch: p.fetch });
    assert.equal(res.code, 1, sub);
    assert.match(res.err, /模型检查没有通过/, sub);
  }
});

test('a model change that the resulting config would refuse writes neither config nor lock', async () => {
  const r = root('commitrefused');
  const p = fakeProvider();
  await readyForLive(r, p);
  assert.equal((await clo(r, ['mode', 'live'], { fetch: p.fetch })).code, 0);
  const notified = ['--qq-platform-notified'];
  const cfg = configOf(r);
  cfg.acks.d3 = '   ';
  writeFileSync(join(r, 'config.json'), JSON.stringify(cfg));
  const before = snapshot(r);
  const res = await clo(r, ['model', 'set-primary', 'anthropic/claude-sonnet-5.5', ...notified], { fetch: p.fetch });
  assert.equal(res.code, 1);
  assert.match(res.err, /d3/);
  assert.deepEqual(snapshot(r), before);

  cfg.acks.d3 = 'test-only decision';
  writeFileSync(join(r, 'config.json'), JSON.stringify(cfg));
  const ok = await clo(r, ['model', 'set-primary', 'anthropic/claude-sonnet-5.5', ...notified], { fetch: p.fetch });
  assert.equal(ok.code, 0, `positive control, the new model renders under its new lock while live: ${ok.out}${ok.err}`);
  assert.equal(effectiveOf(r).mode, 'live');
  assert.equal(effectiveOf(r).models.primary.id, 'anthropic/claude-sonnet-5.5');
});

test('check compares prices when the model is the same', async () => {
  const r = root('checkprice');
  const p = fakeProvider();
  await clo(r, ['model', 'refresh'], { fetch: p.fetch });
  assert.match((await clo(r, ['model', 'check'], { fetch: p.fetch })).out, /与锁定一致/, 'positive control');
  for (const m of p.state.catalog) {
    if (m.id.includes('opus')) m.pricing = { ...m.pricing, completion: '0.000025' };
  }
  const before = snapshot(r);
  const res = await clo(r, ['model', 'check'], { fetch: p.fetch });
  assert.equal(res.code, 0);
  assert.doesNotMatch(res.out, /与锁定一致/);
  assert.match(res.out, /目录价格和锁定时不同/);
  assert.deepEqual(snapshot(r), before);
});

// --- clo model lock --provider: a kind whose API returns no price locks from the hand-entered book. No network. ---

const bookRoot = (label, { active = 'openrouter', qq = false } = {}) => {
  const cfg = qq ? enabledConfig() : baseConfig();
  const r = root(label, withProviders(cfg, { active, anthropicBaseUrl: active === 'anthropic' ? 'http://127.0.0.1:9' : undefined }));
  recordProvider(r);
  return r;
};

test('model lock --provider anthropic: from the book, only with --confirm-price the first time, and nothing else in the lock file moves', async () => {
  const r = bookRoot('book-lock');
  assert.equal((await clo(r, ['model', 'refresh'], { fetch: fakeProvider().fetch })).code, 0);
  const noBook = await clo(r, ['model', 'lock', '--provider', 'anthropic', '--confirm-price']);
  assert.equal(noBook.code, 1);
  assert.match(noBook.err, /priceBook/);
  writePriceBook(r);
  const before = snapshot(r);
  const orBefore = lockOf(r);

  const first = await clo(r, ['model', 'lock', '--provider', 'anthropic']);
  assert.equal(first.code, 1);
  assert.match(first.err, /--confirm-price/);
  assert.deepEqual(snapshot(r), before, 'a refused lock writes nothing');
  const wrongKind = await clo(r, ['model', 'lock', '--provider', 'openrouter', '--confirm-price']);
  assert.equal(wrongKind.code, 1);
  assert.match(wrongKind.err, /clo model refresh/);
  const missing = await clo(r, ['model', 'lock']);
  assert.equal(missing.code, 1);

  const ok = await clo(r, ['model', 'lock', '--provider', 'anthropic', '--confirm-price']);
  assert.equal(ok.code, 0, `${ok.out}${ok.err}`);
  assert.match(ok.out, /价格表/);
  assert.match(ok.out, /clo provider use anthropic --confirm/, 'not in use yet, and the switch is named');
  const models = lockOf(r);
  assert.deepEqual(models.locks.anthropic.primary, { id: 'claude-opus-5-5', selector: 'claude-opus-5-5', price: TEST_ANTHROPIC_BOOK().models['claude-opus-5-5'] });
  assert.deepEqual(models.locks.anthropic.decision, { id: 'claude-haiku-5-5', price: TEST_ANTHROPIC_BOOK().models['claude-haiku-5-5'] });
  for (const k of ['lock', 'primarySelector', 'primaryResolved', 'decision', 'changes', 'priceBooks']) assert.deepEqual(models[k], orBefore[k], `${k} unchanged`);
  assert.equal(readFileSync(join(r, 'config.json'), 'utf8'), before[0], 'config.json unchanged');

  // A relock at the same prices needs no confirmation; a changed book price does, and a catalog refresh leaves it alone.
  assert.equal((await clo(r, ['model', 'lock', '--provider', 'anthropic'])).code, 0, 'control: same ids, same prices');
  const book = TEST_ANTHROPIC_BOOK();
  book.models['claude-opus-5-5'].outputPerM = 25;
  writePriceBook(r, book);
  const dearer = await clo(r, ['model', 'lock', '--provider', 'anthropic']);
  assert.equal(dearer.code, 1);
  assert.match(dearer.err, /--confirm-price/);
  assert.equal(lockOf(r).locks.anthropic.primary.price.outputPerM, 20);
  assert.equal((await clo(r, ['model', 'refresh'], { fetch: fakeProvider().fetch })).code, 0);
  assert.deepEqual(lockOf(r).locks.anthropic, models.locks.anthropic, 'refresh never touches the Anthropic lock');
  assert.deepEqual(lockOf(r).priceBooks.anthropic, book, 'or the book');
});

test('model lock: changing the models in use while QQ is enabled needs --qq-platform-notified, and is recorded as a change', async () => {
  const r = bookRoot('book-change', { active: 'anthropic', qq: true });
  const book = TEST_ANTHROPIC_BOOK();
  book.models['claude-sonnet-5-5'] = { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75, cacheWrite1hPerM: 6 };
  writePriceBook(r, book);
  assert.equal((await clo(r, ['model', 'lock', '--provider', 'anthropic', '--confirm-price'])).code, 0);
  assert.equal(effectiveOf(r).models.primary.id, 'claude-opus-5-5');
  const cfg = configOf(r);
  cfg.providers.anthropic.models.primary = 'claude-sonnet-5-5';
  writeFileSync(join(r, 'config.json'), JSON.stringify(cfg, null, 2));
  const before = snapshot(r);
  const silent = await clo(r, ['model', 'lock', '--provider', 'anthropic', '--confirm-price']);
  assert.equal(silent.code, 1);
  assert.match(silent.err, /§4\.2/);
  assert.deepEqual(snapshot(r), before);
  const told = await clo(r, ['model', 'lock', '--provider', 'anthropic', '--confirm-price', '--qq-platform-notified']);
  assert.equal(told.code, 0, `${told.out}${told.err}`);
  assert.match(told.out, /已记录：你确认向平台报告了这次模型变更/);
  assert.equal(effectiveOf(r).models.primary.id, 'claude-sonnet-5-5');
  assert.deepEqual(lockOf(r).changes.at(-1), { ...lockOf(r).changes.at(-1), kind: 'anthropic', primary: 'claude-sonnet-5-5', qqPlatformNotified: true });
  const shown = await clo(r, ['model', 'show']);
  assert.match(shown.out, /接口 anthropic（anthropic）（在用）：锁定 主模型 claude-sonnet-5-5/);
});
