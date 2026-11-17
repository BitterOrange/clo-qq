// The console's search commands so far: `clo search lock` (the search model's price from the catalog), and search in
// `clo budget` and `clo status`. In-process against a temp root with a fake catalog: no network, no real .env.
// Every refusal has its accepted control in the same test.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { baseConfig, CATALOG, clo, dbOf, effectiveOf, enabledConfig, fakeProvider, makeRoot, readJson, testEnv, withDb } from './_cli-helper.mjs';
import { gatherLiveFacts } from '../../src/cli/clo.mjs';
import { makeContext } from '../../src/cli/common.mjs';
import { CONSUMER_LEASE_KEY } from '../../src/clo-plugin/lib/channels/qq/lease.js';
import { sonarRow } from '../harness/mock-openrouter.mjs';

const roots = [];
const root = (label, cfg) => {
  const r = makeRoot(label, cfg);
  roots.push(r);
  // A config written with search on stands for an install where `clo search enable` ran: its record in clo.db.
  if (cfg?.searchProvider && cfg.searchProvider !== 'none') recordSearch(r.root, cfg.searchProvider);
  return r.root;
};
function recordSearch(r, provider) {
  mkdirSync(dirname(dbOf(r)), { recursive: true });
  withDb(r, (store) => store.setControl('search_enabled', provider, 'test'));
}
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
  const bad = await clo(r, ['search', 'bogus'], { fetch: withSonar().fetch });
  assert.equal(bad.code, 1, 'an unknown subcommand');
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
  assert.equal((await clo(r, ['search', 'disable'])).code, 0);
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

// --- clo search enable | disable | show, the per-group switch, and the record that guards hand edits (decision D7) ---

const GROUP_ID = 'FAKEGROUPOPENID000AAA';
const OTHER_ID = 'FAKEGROUPOPENID000CCC';
// An own install in dry-run with QQ enabled, two groups told, D3 recorded, and the search Key's daily limit written:
// everything enable needs except the search lock, which a test adds with lockFirst.
function readyToEnable() {
  const cfg = enabledConfig();
  cfg.runtime = 'own';
  cfg.qq.allowedGroupIds.push(OTHER_ID);
  cfg.qq.groups[GROUP_ID].noticeGiven = true;
  cfg.qq.groups[OTHER_ID] = { label: '另一群', interject: false, nameMention: false, noticeGiven: true };
  cfg.qq.owner.groupMember[OTHER_ID] = ['FAKEOWNEROPENID000DDD'];
  cfg.acks = { ...cfg.acks, d3: 'my decision', q0Recorded: true };
  cfg.budget.searchKeyDailyLimitUsd = 0.5;
  return cfg;
}
const lockFirst = async (r) => assert.equal((await clo(r, ['search', 'lock', '--confirm-price'], { fetch: withSonar().fetch })).code, 0);
const cfgOf = (r) => readJson(join(r, 'config.json'));
const writeCfg = (r, cfg) => writeFileSync(join(r, 'config.json'), `${JSON.stringify(cfg, null, 2)}\n`);
const recordOf = (r) => withDb(r, (store) => store.getControl('search_enabled'));

test('search enable: each refusal writes nothing; then it turns search on as a model change and clears every notice and D3', async () => {
  const r = root('search-enable', readyToEnable());
  const before = readFileSync(join(r, 'config.json'), 'utf8');
  const lockBefore = lockText(r);
  const tries = [
    [['search', 'enable'], /--confirm/],
    [['search', 'enable', '--confirm', '--qq-platform-notified'], /clo search lock/],
  ];
  for (const [argv, why] of tries) {
    const res = await clo(r, argv);
    assert.equal(res.code, 1, argv.join(' '));
    assert.match(res.err, why);
  }
  await lockFirst(r);
  const noFlag = await clo(r, ['search', 'enable', '--confirm']);
  assert.equal(noFlag.code, 1);
  assert.match(noFlag.err, /--qq-platform-notified/);
  // No daily limit written: the amount is the user's, and nothing invents one.
  const noLimit = readyToEnable();
  delete noLimit.budget.searchKeyDailyLimitUsd;
  writeCfg(r, noLimit);
  const limit = await clo(r, ['search', 'enable', '--confirm', '--qq-platform-notified']);
  assert.equal(limit.code, 1);
  assert.match(limit.err, /budget\.searchKeyDailyLimitUsd/);
  // The OpenClaw runtime has no search in this build.
  writeCfg(r, { ...readyToEnable(), runtime: 'openclaw' });
  const claw = await clo(r, ['search', 'enable', '--confirm', '--qq-platform-notified']);
  assert.equal(claw.code, 1);
  assert.match(claw.err, /只在 own 运行时/);
  writeCfg(r, { ...readyToEnable(), mode: 'live' });
  const live = await clo(r, ['search', 'enable', '--confirm', '--qq-platform-notified']);
  assert.equal(live.code, 1);
  assert.match(live.err, /live 下不能打开搜索/);
  // A bot that holds the account with no PID record.
  writeCfg(r, readyToEnable());
  withDb(r, (store) => store.setControl(CONSUMER_LEASE_KEY, `${process.pid}:test`, 'bot'));
  const running = await clo(r, ['search', 'enable', '--confirm', '--qq-platform-notified']);
  assert.equal(running.code, 1);
  assert.match(running.err, /先 clo stop/);
  withDb(r, (store) => store.delControl(CONSUMER_LEASE_KEY));
  assert.equal(readFileSync(join(r, 'config.json'), 'utf8'), `${JSON.stringify(readyToEnable(), null, 2)}\n`, 'the refusals wrote nothing');
  assert.equal(recordOf(r), null);
  assert.equal(JSON.parse(lockText(r)).models.changes, undefined, 'no model change recorded');
  assert.notEqual(before, null);
  assert.notEqual(lockBefore, null);

  const ok = await clo(r, ['search', 'enable', '--confirm', '--qq-platform-notified']);
  assert.equal(ok.code, 0, `${ok.out}${ok.err}`);
  const cfg = cfgOf(r);
  assert.equal(cfg.searchProvider, 'openrouter-sonar');
  assert.equal(cfg.acks.search.provider, 'openrouter-sonar');
  assert.equal(cfg.acks.d3, '', 'D3 is cleared');
  assert.equal(cfg.acks.q0Recorded, true, 'the rest of the acks stay');
  assert.ok(Object.values(cfg.qq.groups).every((g) => g.noticeGiven === false), 'every group has to be told again');
  assert.equal(cfg.budget.searchKeyDailyLimitUsd, 0.5, 'the amount stays the user\'s');
  assert.equal(recordOf(r), 'openrouter-sonar');
  assert.deepEqual(JSON.parse(lockText(r)).models.changes.at(-1), { at: JSON.parse(lockText(r)).models.changes.at(-1).at, kind: 'search', model: 'perplexity/sonar-pro', state: 'on', qqPlatformNotified: true });
  assert.equal(effectiveOf(r).search.provider, 'openrouter-sonar');
  assert.match(ok.out, /OpenRouter 和 Perplexity/);
  assert.match(ok.out, /还没有群打开搜索开关/);
  assert.match(ok.out, /clo mode live 会拒绝/);
  const again = await clo(r, ['search', 'enable', '--confirm', '--qq-platform-notified']);
  assert.equal(again.code, 0);
  assert.match(again.out, /已经打开/);
  assert.equal(JSON.parse(lockText(r)).models.changes.length, 1, 'once');
});

test('with QQ off, enable needs no platform attestation; it still clears D3 (control for the flag)', async () => {
  const cfg = readyToEnable();
  cfg.qq.enabled = false;
  const r = root('search-enable-qq-off', cfg);
  await lockFirst(r);
  const ok = await clo(r, ['search', 'enable', '--confirm']);
  assert.equal(ok.code, 0, `${ok.out}${ok.err}`);
  assert.equal(cfgOf(r).acks.d3, '');
  assert.equal(JSON.parse(lockText(r)).models.changes.at(-1).qqPlatformNotified, false);
});

test('a hand edit of searchProvider is refused by apply in both directions; enable and disable are the only ways', async () => {
  // On by hand, with the ack written by hand too: validation alone would pass it.
  const r = root('search-hand', readyToEnable());
  await lockFirst(r);
  assert.equal((await clo(r, ['apply'])).code, 0, 'control: off applies');
  const hand = readyToEnable();
  hand.searchProvider = 'openrouter-sonar';
  hand.acks.search = { provider: 'openrouter-sonar', at: '2000-01-01T00:00:00.000Z' };
  writeCfg(r, hand);
  const refused = await clo(r, ['apply']);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /clo search enable/);
  assert.equal('search' in effectiveOf(r), false, 'the running file is as it was');
  writeCfg(r, readyToEnable());
  assert.equal((await clo(r, ['search', 'enable', '--confirm', '--qq-platform-notified'])).code, 0);
  assert.equal((await clo(r, ['apply'])).code, 0, 'control: after enable, the same config applies');
  // Off by hand while the record says on: refused too, or a later hand edit back on would pass as already recorded.
  const off = cfgOf(r);
  off.searchProvider = 'none';
  writeCfg(r, off);
  const offRefused = await clo(r, ['apply']);
  assert.equal(offRefused.code, 1);
  assert.match(offRefused.err, /clo search disable/);
  // The console's disable takes it from there, with the hand edit still in place.
  const dis = await clo(r, ['search', 'disable']);
  assert.equal(dis.code, 0, `${dis.out}${dis.err}`);
  assert.equal(recordOf(r), 'none');
  assert.equal(cfgOf(r).searchProvider, 'none');
  assert.equal(cfgOf(r).acks.search, undefined, 'the ack goes with it');
  assert.equal('search' in effectiveOf(r), false);
  assert.deepEqual(JSON.parse(lockText(r)).models.changes.map((c) => c.state), ['on', 'off']);
  // Now a hand edit back on is refused again.
  const back = cfgOf(r);
  back.searchProvider = 'openrouter-sonar';
  back.acks.search = { provider: 'openrouter-sonar', at: '2000-01-01T00:00:00.000Z' };
  writeCfg(r, back);
  assert.equal((await clo(r, ['apply'])).code, 1);
});

test('search disable takes nothing else away: notices, D3 and the group switches stay; it runs beside a running bot', async () => {
  const r = root('search-disable', readyToEnable());
  await lockFirst(r);
  assert.equal((await clo(r, ['search', 'enable', '--confirm', '--qq-platform-notified'])).code, 0);
  assert.equal((await clo(r, ['group', 'set', '测试群', '--search', 'on'])).code, 0);
  const told = cfgOf(r);
  told.acks.d3 = 'again';
  for (const g of Object.values(told.qq.groups)) g.noticeGiven = true;
  writeCfg(r, told);
  withDb(r, (store) => store.setControl(CONSUMER_LEASE_KEY, `${process.pid}:test`, 'bot'));
  const res = await clo(r, ['search', 'disable']);
  assert.equal(res.code, 0, `${res.out}${res.err}`);
  const cfg = cfgOf(r);
  assert.equal(cfg.acks.d3, 'again');
  assert.ok(Object.values(cfg.qq.groups).every((g) => g.noticeGiven === true));
  assert.equal(cfg.qq.groups[GROUP_ID].search, true, 'the group switch stays, with no effect');
  assert.match(res.out, /报给平台的模型信息/);
  const quiet = await clo(r, ['search', 'disable']);
  assert.match(quiet.out, /已经关着/);
});

test('group set --search: on clears that group\'s notice only, off clears nothing, on is refused in live; list shows it', async () => {
  const r = root('search-group', readyToEnable());
  const on = await clo(r, ['group', 'set', '测试群', '--search', 'on']);
  assert.equal(on.code, 0, `${on.out}${on.err}`);
  let cfg = cfgOf(r);
  assert.equal(cfg.qq.groups[GROUP_ID].search, true);
  assert.equal(cfg.qq.groups[GROUP_ID].noticeGiven, false, 'this group has to be told again');
  assert.equal(cfg.qq.groups[OTHER_ID].noticeGiven, true, 'the other group is untouched');
  assert.match(on.out, /全局还关着/);
  assert.match((await clo(r, ['group', 'list'])).out, /测试群\t[^\n]*搜索 开/);
  // Already on: setting it on again clears nothing.
  cfg.qq.groups[GROUP_ID].noticeGiven = true;
  writeCfg(r, cfg);
  assert.equal((await clo(r, ['group', 'set', '测试群', '--search', 'on'])).code, 0);
  assert.equal(cfgOf(r).qq.groups[GROUP_ID].noticeGiven, true);
  const off = await clo(r, ['group', 'set', '测试群', '--search', 'off']);
  assert.equal(off.code, 0);
  assert.equal(cfgOf(r).qq.groups[GROUP_ID].search, false);
  assert.equal(cfgOf(r).qq.groups[GROUP_ID].noticeGiven, true, 'off clears nothing');
  const bad = await clo(r, ['group', 'set', '测试群', '--search', 'yes']);
  assert.equal(bad.code, 1);
  // In live, turning a group's search on is refused before anything is written.
  cfg = cfgOf(r);
  writeCfg(r, { ...cfg, mode: 'live' });
  const live = await clo(r, ['group', 'set', '另一群', '--search', 'on']);
  assert.equal(live.code, 1);
  assert.match(live.err, /live 下不能打开群的搜索/);
  assert.equal(cfgOf(r).qq.groups[OTHER_ID].search, undefined);
});

test('search show: the state, the lock, the Key named but never printed, a shared Key flagged, the amount left to the user', async () => {
  const r = root('search-show', readyToEnable());
  const SEARCH_KEY = 'sk-or-v1-FAKE-SEARCH-KEY-SHOW-ONLY';
  writeFileSync(join(r, '.env'), `CLO_CHAT_API_KEY=sk-or-v1-FAKE-CHAT\nCLO_SEARCH_API_KEY=${SEARCH_KEY}\n`, { mode: 0o600 });
  let show = await clo(r, ['search', 'show']);
  assert.equal(show.code, 0, show.err);
  assert.match(show.out, /搜索：关/);
  assert.match(show.out, /价格：还没锁定/);
  assert.match(show.out, /CLO_SEARCH_API_KEY，已填。/);
  assert.match(show.out, /\$0\.5/);
  assert.match(show.out, /OpenRouter 和 Perplexity/);
  assert.ok(!show.out.includes(SEARCH_KEY));
  await lockFirst(r);
  assert.equal((await clo(r, ['search', 'enable', '--confirm', '--qq-platform-notified'])).code, 0);
  show = await clo(r, ['search', 'show']);
  assert.match(show.out, /搜索：开（openrouter-sonar，模型 perplexity\/sonar-pro）/);
  assert.match(show.out, /单次最坏预留 \$0\.0260/);
  writeFileSync(join(r, '.env'), `CLO_CHAT_API_KEY=${SEARCH_KEY}\nCLO_SEARCH_API_KEY=${SEARCH_KEY}\n`, { mode: 0o600 });
  show = await clo(r, ['search', 'show']);
  assert.match(show.out, /同一个，不能用/);
  const cfg = readyToEnable();
  delete cfg.budget.searchKeyDailyLimitUsd;
  const r2 = root('search-show-nolimit', cfg);
  assert.match((await clo(r2, ['search', 'show'])).out, /还没写（budget\.searchKeyDailyLimitUsd）/);
});

test('mode live with search on lists the search checks and never sends the search Key while the rules are unrecorded', async () => {
  const r = root('search-live', readyToEnable());
  const SEARCH_KEY = 'sk-or-v1-FAKE-SEARCH-KEY-LIVE-ONLY';
  writeFileSync(join(r, '.env'), `CLO_QQ_APP_ID=FAKEAPPID000111\nCLO_QQ_APP_SECRET=FAKE-QQ-SECRET-FOR-LOCAL-MOCK-ONLY\nCLO_CHAT_API_KEY=sk-or-v1-FAKE-KEY-FOR-LOCAL-MOCK-ONLY\nCLO_SEARCH_API_KEY=${SEARCH_KEY}\n`, { mode: 0o600 });
  await lockFirst(r);
  assert.equal((await clo(r, ['search', 'enable', '--confirm', '--qq-platform-notified'])).code, 0);
  const p = withSonar();
  const res = await clo(r, ['mode', 'live'], { fetch: p.fetch });
  assert.equal(res.code, 1);
  for (const code of ['search_rules', 'search_key_limit', 'search_process_key']) assert.match(res.out, new RegExp(`${code}：`), code);
  assert.doesNotMatch(res.out, /search_ack：|search_lock：|search_key：/, 'the record, the lock and a Key of its own are fine');
  assert.match(res.out, /search_key_limit：没有检查/);
  assert.ok(p.calls.every((c) => c.auth !== `Bearer ${SEARCH_KEY}`), 'the search Key did not leave');
  assert.ok(!res.out.includes(SEARCH_KEY));
  assert.equal(cfgOf(r).mode, 'dry-run');
});

test('gatherLiveFacts with the search rules recorded reads the search Key at the search base, and sees a shared or missing Key', async () => {
  const r = root('search-facts', readyToEnable());
  const SEARCH_KEY = 'sk-or-v1-FAKE-SEARCH-KEY-FACTS-ONLY';
  writeFileSync(join(r, '.env'), `CLO_CHAT_API_KEY=sk-or-v1-FAKE-CHAT\nCLO_SEARCH_API_KEY=${SEARCH_KEY}\n`, { mode: 0o600 });
  await lockFirst(r);
  assert.equal((await clo(r, ['search', 'enable', '--confirm', '--qq-platform-notified'])).code, 0);
  const told = cfgOf(r);
  told.acks.d3 = 'again';
  writeCfg(r, told);
  withDb(r, (store) => store.setControl('search_key', store.key(SEARCH_KEY), 'start'));
  const p = fakeProvider({ catalog: [...CATALOG(), sonarRow()], key: { usage: 0, usage_daily: 0.01, limit: 0.5, limit_remaining: 0.49, limit_reset: 'daily' } });
  const ctx = makeContext({ env: testEnv(r), fetch: p.fetch, stdout: { write: () => {} }, stderr: { write: () => {} } });
  const facts = await gatherLiveFacts(ctx, cfgOf(r), { searchRules: () => true });
  assert.equal(facts.searchKeyRead, 'ok');
  assert.deepEqual(facts.searchKey, { limitMicros: 500000, remainingMicros: 490000, limitReset: 'daily', usageDailyMicros: 10000 });
  assert.equal(facts.searchAckMatches, true);
  assert.equal(facts.searchLocked, true);
  assert.equal(facts.searchHoldMicros, 26000);
  assert.equal(facts.searchKeyOk, true);
  assert.equal(facts.searchProcessKeyMatches, true);
  const read = p.calls.filter((c) => c.auth === `Bearer ${SEARCH_KEY}`);
  assert.equal(read.length, 1);
  assert.ok(read[0].url.endsWith('/key'));
  // The default: rules unrecorded, so no read at all.
  const p2 = fakeProvider();
  const quiet = await gatherLiveFacts(makeContext({ env: testEnv(r), fetch: p2.fetch, stdout: { write: () => {} }, stderr: { write: () => {} } }), cfgOf(r));
  assert.equal(quiet.searchKeyRead, 'skipped');
  assert.ok(p2.calls.every((c) => c.auth !== `Bearer ${SEARCH_KEY}`));
  // The same Key as the probe's is refused without being sent.
  writeFileSync(join(r, '.env'), `CLO_CHAT_API_KEY=sk-or-v1-FAKE-CHAT\nCLO_TEST_API_KEY=${SEARCH_KEY}\nCLO_SEARCH_API_KEY=${SEARCH_KEY}\n`, { mode: 0o600 });
  const p3 = fakeProvider();
  const shared = await gatherLiveFacts(makeContext({ env: testEnv(r), fetch: p3.fetch, stdout: { write: () => {} }, stderr: { write: () => {} } }), cfgOf(r), { searchRules: () => true });
  assert.equal(shared.searchKeyOk, false);
  assert.equal(shared.searchKeyRead, 'skipped');
  assert.ok(p3.calls.every((c) => c.auth !== `Bearer ${SEARCH_KEY}`));
  // Another Key held by the process.
  writeFileSync(join(r, '.env'), `CLO_CHAT_API_KEY=sk-or-v1-FAKE-CHAT\nCLO_SEARCH_API_KEY=${SEARCH_KEY}x\n`, { mode: 0o600 });
  const other = await gatherLiveFacts(makeContext({ env: testEnv(r), fetch: fakeProvider().fetch, stdout: { write: () => {} }, stderr: { write: () => {} } }), cfgOf(r));
  assert.equal(other.searchProcessKeyMatches, false);
  assert.equal(other.searchKeyOk, true);
});
