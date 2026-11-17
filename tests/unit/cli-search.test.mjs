// The console's search commands so far: `clo search lock` (the search model's price from the catalog), and search in
// `clo budget` and `clo status`. In-process against a temp root with a fake catalog: no network, no real .env.
// Every refusal has its accepted control in the same test.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { baseConfig, CATALOG, clo, effectiveOf, fakeProvider, makeRoot, readJson, withDb } from './_cli-helper.mjs';
import { sonarRow } from '../harness/mock-openrouter.mjs';

const roots = [];
const root = (label, cfg) => {
  const r = makeRoot(label, cfg);
  roots.push(r);
  return r.root;
};
after(() => roots.forEach((r) => r.cleanup()));

const lockFile = (r) => join(r, 'versions.lock.json');
const lockText = (r) => readFileSync(lockFile(r), 'utf8');
const searchLockOf = (r) => readJson(lockFile(r)).models?.locks?.search ?? null;
const withSonar = (pricing) => fakeProvider({ catalog: [...CATALOG(), sonarRow(pricing)] });
// What `clo search enable` will write: search on, on the own runtime, with its record and the Key's daily limit.
const searchOnConfig = () => {
  const cfg = baseConfig({ runtime: 'own', searchProvider: 'openrouter-sonar' });
  cfg.acks = { ...cfg.acks, search: { provider: 'openrouter-sonar', at: '2000-01-01T00:00:00.000Z' } };
  cfg.budget.searchKeyDailyLimitUsd = 0.5;
  return cfg;
};

test('search lock: the first lock needs --confirm-price; it records only models.locks.search, read with no Key', async () => {
  const r = root('search-lock');
  const p = withSonar();
  const before = lockText(r);
  const refused = await clo(r, ['search', 'lock'], { fetch: p.fetch });
  assert.equal(refused.code, 1);
  assert.match(refused.err, /--confirm-price/);
  assert.equal(lockText(r), before, 'a refusal writes nothing');
  const ok = await clo(r, ['search', 'lock', '--confirm-price'], { fetch: p.fetch });
  assert.equal(ok.code, 0, `${ok.out}${ok.err}`);
  assert.deepEqual(searchLockOf(r), { id: 'perplexity/sonar-pro', price: { inputPerM: 3, outputPerM: 15, requestUsd: 0.005 } });
  const after = readJson(lockFile(r));
  const was = JSON.parse(before);
  assert.deepEqual(after.models.lock, was.models?.lock, 'the chat lock is as it was');
  assert.deepEqual(after.models.changes, was.models?.changes, 'a price lock is not a model change');
  const { models: _a, ...restAfter } = after;
  const { models: _b, ...restBefore } = was;
  assert.deepEqual(restAfter, restBefore, 'nothing else in the file moves');
  assert.ok(p.calls.every((c) => c.auth === null), 'the catalog read sends no Key');
  assert.ok(p.calls.every((c) => c.url.startsWith('http://127.0.0.1:9')));
  assert.match(ok.out, /单次搜索最坏预留：\$0\.0260/, '4000 x $3/M + 600 x $15/M + $0.005');
  assert.match(ok.out, /还没有用真实请求核实/);
  assert.match(ok.out, /搜索现在没有打开/);
});

test('search lock: the same price relocks without the flag; any change, up or down, needs it', async () => {
  const r = root('search-relock');
  assert.equal((await clo(r, ['search', 'lock', '--confirm-price'], { fetch: withSonar().fetch })).code, 0);
  assert.equal((await clo(r, ['search', 'lock'], { fetch: withSonar().fetch })).code, 0, 'control: the same price');
  for (const pricing of [{ completion: '0.000016' }, { completion: '0.000014' }, { request: '0.006' }]) {
    const res = await clo(r, ['search', 'lock'], { fetch: withSonar(pricing).fetch });
    assert.equal(res.code, 1, JSON.stringify(pricing));
    assert.match(res.err, /differs from the locked one/);
  }
  assert.equal(searchLockOf(r).price.outputPerM, 15, 'refusals left the lock');
  assert.equal((await clo(r, ['search', 'lock', '--confirm-price'], { fetch: withSonar({ request: '0.006' }).fetch })).code, 0);
  assert.equal(searchLockOf(r).price.requestUsd, 0.006);
});

test('search lock: a price field this code does not know refuses even with the flag; a zero one does not; web_search adds to the fee', async () => {
  const r = root('search-fields');
  for (const pricing of [{ internal_reasoning: '0.00001' }, { image: '0.01' }, { overrides: [{ prompt: '0.00001' }] }]) {
    const res = await clo(r, ['search', 'lock', '--confirm-price'], { fetch: withSonar(pricing).fetch });
    assert.equal(res.code, 1, JSON.stringify(pricing));
    assert.match(res.err, /unknown price field/);
  }
  assert.equal(searchLockOf(r), null);
  const zero = await clo(r, ['search', 'lock', '--confirm-price'], { fetch: withSonar({ image: '0', internal_reasoning: 0, web_search: '0.004' }).fetch });
  assert.equal(zero.code, 0, `${zero.out}${zero.err}`);
  assert.equal(searchLockOf(r).price.requestUsd, 0.009, 'request + web_search per call');
});

test('search lock: no row, no price, a free token price or one above the output ceiling is refused', async () => {
  const r = root('search-missing');
  const none = await clo(r, ['search', 'lock', '--confirm-price'], { fetch: fakeProvider().fetch });
  assert.equal(none.code, 1);
  assert.match(none.err, /not in the catalog/);
  const free = await clo(r, ['search', 'lock', '--confirm-price'], { fetch: withSonar({ prompt: '0' }).fetch });
  assert.equal(free.code, 1);
  assert.match(free.err, /price of 0/);
  const dear = await clo(r, ['search', 'lock'], { fetch: withSonar({ completion: '0.00004' }).fetch });
  assert.equal(dear.code, 1);
  assert.match(dear.err, /above \$30\/M/);
  assert.equal(searchLockOf(r), null);
  const bad = await clo(r, ['search'], { fetch: withSonar().fetch });
  assert.equal(bad.code, 1, 'no subcommand');
});

test('with search on, the lock reaches the effective file at once; with it off the file carries no search at all', async () => {
  const r = root('search-effective', searchOnConfig());
  assert.equal((await clo(r, ['apply'])).code, 0);
  assert.equal(effectiveOf(r).search.price, null, 'before the lock: no price, so the ledger holds nothing for search');
  const res = await clo(r, ['search', 'lock', '--confirm-price'], { fetch: withSonar().fetch });
  assert.equal(res.code, 0, `${res.out}${res.err}`);
  assert.deepEqual(effectiveOf(r).search.price, { inputPerM: 3, outputPerM: 15, requestUsd: 0.005 });
  assert.doesNotMatch(res.out, /搜索现在没有打开/);
  // Control: search off, the same lock in the file, and the effective file has no search block.
  const cfg = searchOnConfig();
  cfg.searchProvider = 'none';
  writeFileSync(join(r, 'config.json'), `${JSON.stringify(cfg, null, 2)}\n`);
  assert.equal((await clo(r, ['apply'])).code, 0);
  assert.equal('search' in effectiveOf(r), false);
});

test('budget and status show search while it is on; the owner lifts cost_above_hold, never a pause a read lifts', async () => {
  const r = root('search-budget', searchOnConfig());
  assert.equal((await clo(r, ['search', 'lock', '--confirm-price'], { fetch: withSonar().fetch })).code, 0);
  assert.equal((await clo(r, ['apply'])).code, 0);
  let show = await clo(r, ['budget', 'show']);
  assert.equal(show.code, 0);
  assert.match(show.out, /搜索：今日 0\/10 次，花费 \$0\.0000 \/ 全部到 \$2\.1 停。搜索暂停：否/);
  assert.match(show.out, /搜索 Key 日限额：\$0\.5/);
  const status = await clo(r, ['status']);
  assert.match(status.out, /搜索：打开（0 个群）；今日 0\/10 次/);

  assert.match((await clo(r, ['budget', 'clear-search-pause'])).out, /现在没有搜索暂停/);
  withDb(r, (store) => store.setControl('search_paused', 'cost_above_hold', 'ledger'));
  show = await clo(r, ['budget', 'show']);
  assert.match(show.out, /搜索暂停：cost_above_hold/);
  const lifted = await clo(r, ['budget', 'clear-search-pause']);
  assert.equal(lifted.code, 0);
  assert.match(lifted.out, /已解除搜索暂停 cost_above_hold/);
  assert.equal(withDb(r, (store) => store.getControl('search_paused')), null);
  withDb(r, (store) => store.setControl('search_paused', 'key_limit', 'ledger'));
  const kept = await clo(r, ['budget', 'clear-search-pause']);
  assert.equal(kept.code, 1);
  assert.match(kept.out, /由读取搜索 Key 解除/);
  assert.equal(withDb(r, (store) => store.getControl('search_paused')), 'key_limit');
  assert.equal(withDb(r, (store) => store.getControl('paid_paused')), null, 'none of it touches the paid pause');
});

test('budget and status say nothing of search while it is off and nothing of it is left', async () => {
  const r = root('search-quiet');
  assert.equal((await clo(r, ['apply'])).code, 0);
  withDb(r, () => {});
  assert.doesNotMatch((await clo(r, ['budget', 'show'])).out, /搜索/);
  assert.doesNotMatch((await clo(r, ['status'])).out, /搜索：/);
  // Control: a search pause left from before shows even with search off.
  withDb(r, (store) => store.setControl('search_paused', 'fail', 'ledger'));
  assert.match((await clo(r, ['budget', 'show'])).out, /搜索暂停：fail/);
  assert.match((await clo(r, ['status'])).out, /搜索：关闭.*搜索暂停：fail/);
});
