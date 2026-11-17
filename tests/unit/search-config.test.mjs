// Search, step 1: config, the effective file, the live checks and the env. Nothing here calls a network or reads a
// real .env. Each refusal has its accepted control in the same test.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildEffective, createEffectiveReader, liveConfigProblems, livePreconditions, OPENROUTER_BASE_URL, resolvePaths, validateBusinessConfig } from '../../src/clo-plugin/lib/core/config.js';
import {
  groupSearchOn, SEARCH_CEILINGS, SEARCH_CHILD_KEY, SEARCH_DEFAULTS, SEARCH_KEY_ENV, SEARCH_MODEL, SEARCH_RULES_RECORDED, searchOfEffective,
} from '../../src/clo-plugin/lib/core/providers/searchRegistry.js';
import { CliError } from '../../src/cli/common.mjs';
import { ensureGatewayEnvClean, ensureOwnEnvClean, gatewayEnv, gatewayEnvForCheck, modelKeyNames, ownEnv, ownEnvForCheck, requireSecrets } from '../../src/cli/lifecycle.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'clo-search-config-'));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
const sample = () => JSON.parse(readFileSync(join(HERE, '..', 'fixtures', 'render', 'config.sample.json'), 'utf8'));
const paths = { repoRoot: 'C:\\repo', db: 'db', eventLog: 'log', systemPromptFile: 'sp' };
const errorsOf = (cfg, env = {}) => validateBusinessConfig(cfg, { env }).errors.map((e) => e.path);
const GROUP = 'FAKE_GROUP_A';
const ACK = { provider: 'openrouter-sonar', at: '2026-11-17T00:00:00.000Z' };

// Search off, on the own runtime: the control every case starts from.
const ownCfg = () => ({ ...sample(), runtime: 'own' });
// What `clo search enable` will write.
function searchOn(cfg = ownCfg()) {
  cfg.searchProvider = 'openrouter-sonar';
  cfg.acks = { ...cfg.acks, search: { ...ACK } };
  cfg.budget.searchKeyDailyLimitUsd = 0.5;
  return cfg;
}

test('search on is valid on the own runtime with its record and Key limit, and refused on the OpenClaw runtime', () => {
  assert.deepEqual(errorsOf(ownCfg()), [], 'control: off');
  assert.deepEqual(errorsOf(searchOn()), [], 'control: on, complete');
  const host = searchOn({ ...sample(), runtime: 'openclaw' });
  const v = validateBusinessConfig(host, { env: {} });
  assert.deepEqual(v.errors.map((e) => e.path), ['searchProvider']);
  assert.match(v.errors[0].message, /own runtime only; the OpenClaw runtime has no search in this build/);
  const implicit = searchOn(sample());
  assert.deepEqual(errorsOf(implicit), ['searchProvider'], 'a config with no runtime field is the OpenClaw runtime');
});

test('search on needs the console record and the Key limit; neither is guessed', () => {
  const cases = [
    ['acks.search', (c) => { delete c.acks.search; }],
    ['acks.search', (c) => { c.acks.search = { provider: 'none', at: ACK.at }; }],
    ['acks.search', (c) => { c.acks.search = { provider: 'openrouter-sonar' }; }],
    ['acks.search', (c) => { c.acks.search = 'yes'; }],
    ['budget.searchKeyDailyLimitUsd', (c) => { delete c.budget.searchKeyDailyLimitUsd; }],
    ['budget.searchKeyDailyLimitUsd', (c) => { c.budget.searchKeyDailyLimitUsd = 0; }],
    ['budget.searchKeyDailyLimitUsd', (c) => { c.budget.searchKeyDailyLimitUsd = '0.5'; }],
  ];
  for (const [path, mutate] of cases) {
    const cfg = searchOn();
    mutate(cfg);
    assert.deepEqual(errorsOf(cfg), [path], `${path}: ${JSON.stringify(cfg.acks.search ?? null)} / ${cfg.budget.searchKeyDailyLimitUsd}`);
  }
  // Off, the record and the limit are not needed, and a leftover record is harmless.
  const off = ownCfg();
  off.acks.search = { ...ACK };
  assert.deepEqual(errorsOf(off), []);
  // A limit that is set must be positive even with search off.
  off.budget.searchKeyDailyLimitUsd = -1;
  assert.deepEqual(errorsOf(off), ['budget.searchKeyDailyLimitUsd']);
});

test('searchProvider names only what this build knows', () => {
  for (const bad of ['perplexity', 'openrouter', '', null, true]) {
    const cfg = searchOn();
    cfg.searchProvider = bad;
    assert.ok(errorsOf(cfg).includes('searchProvider'), String(bad));
  }
  const missing = ownCfg();
  delete missing.searchProvider;
  assert.ok(errorsOf(missing).includes('searchProvider'), 'left out');
});

test('the limits can be lowered, never raised: at most 2 calls per answer and 10 a day', () => {
  const low = searchOn();
  low.search = { perAnswer: 1, perDay: 3, maxTokens: 300, resultMaxChars: 800, queryMaxChars: 40 };
  low.timeouts.searchMs = 10000;
  assert.deepEqual(errorsOf(low), [], 'control: lower values pass');
  const atCeiling = searchOn();
  atCeiling.search = Object.fromEntries(['perAnswer', 'perDay', 'maxTokens', 'resultMaxChars', 'queryMaxChars'].map((f) => [f, SEARCH_CEILINGS[f]]));
  atCeiling.timeouts.searchMs = SEARCH_CEILINGS.searchMs;
  assert.deepEqual(errorsOf(atCeiling), [], 'control: the ceilings themselves pass');
  assert.equal(SEARCH_CEILINGS.perAnswer, 2);
  assert.equal(SEARCH_CEILINGS.perDay, 10);
  for (const f of ['perAnswer', 'perDay', 'maxTokens', 'resultMaxChars', 'queryMaxChars']) {
    for (const bad of [SEARCH_CEILINGS[f] + 1, 0, -1, 1.5, '2', null]) {
      const cfg = searchOn();
      cfg.search = { [f]: bad };
      assert.deepEqual(errorsOf(cfg), [`search.${f}`], `${f}=${bad}`);
    }
  }
  for (const bad of [SEARCH_CEILINGS.searchMs + 1, 0, 1.5, '20000']) {
    const cfg = searchOn();
    cfg.timeouts.searchMs = bad;
    assert.deepEqual(errorsOf(cfg), ['timeouts.searchMs'], String(bad));
  }
  const unknown = searchOn();
  unknown.search = { perAnswer: 2, model: 'perplexity/sonar' };
  assert.deepEqual(errorsOf(unknown), ['search.model'], 'the model is not configurable');
  const notObj = searchOn();
  notObj.search = [];
  assert.deepEqual(errorsOf(notObj), ['search']);
});

test('search.baseUrl only in test mode, on loopback, and live refuses it outside test mode', () => {
  const cfg = searchOn();
  cfg.search = { baseUrl: 'http://127.0.0.1:9' };
  assert.deepEqual(errorsOf(cfg, { CLO_TEST_ROOT: dir }), [], 'control: test mode, loopback');
  assert.deepEqual(errorsOf(cfg), ['search.baseUrl'], 'not in test mode');
  cfg.search.baseUrl = 'https://openrouter.ai/api/v1';
  assert.deepEqual(errorsOf(cfg, { CLO_TEST_ROOT: dir }), ['search.baseUrl'], 'not loopback');
});

test('the per-group switch is a boolean; on with search off globally it only warns', () => {
  const cfg = searchOn();
  cfg.qq.groups[GROUP].search = true;
  const on = validateBusinessConfig(cfg, { env: {} });
  assert.deepEqual(on.errors, []);
  assert.ok(!on.warnings.some((w) => w.path.endsWith('.search')), 'control: no warning with search on');
  const off = ownCfg();
  off.qq.groups[GROUP].search = true;
  const v = validateBusinessConfig(off, { env: {} });
  assert.deepEqual(v.errors, []);
  assert.ok(v.warnings.some((w) => w.path === 'qq.groups.测试群.search' && /不起作用/.test(w.message)));
  off.qq.groups[GROUP].search = 'yes';
  assert.deepEqual(errorsOf(off), ['qq.groups.测试群.search']);
});

test('effective: no search field at all while off, so every file written with it off stays as it was', () => {
  const before = buildEffective(sample(), { paths, env: {}, now: () => 0 });
  const offOwn = buildEffective(ownCfg(), { paths, env: {}, now: () => 0 });
  const withTunables = ownCfg();
  withTunables.search = { perAnswer: 1 };
  withTunables.timeouts.searchMs = 10000;
  withTunables.budget.searchKeyDailyLimitUsd = 0.5;
  withTunables.qq.groups[GROUP].search = true;
  const tuned = buildEffective(withTunables, { paths, env: {}, now: () => 0 });
  assert.deepEqual(tuned, offOwn, 'tunables and switches left behind change nothing while off');
  for (const e of [before, offOwn]) {
    assert.equal('search' in e, false);
    assert.equal('searchKeyDailyLimitUsd' in e.budget, false);
    assert.equal('search' in e.qq.groups[GROUP], false);
    assert.deepEqual(e.timeouts, { decisionMs: 8000, turnSeconds: 90 });
    assert.equal(searchOfEffective(e), null);
    assert.equal(groupSearchOn(e, GROUP), false);
  }
  // Positive control: on, the block is there.
  assert.notEqual(searchOfEffective(buildEffective(searchOn(), { paths, env: {}, now: () => 0 })), null);
});

test('effective: on, the block has the one model, the defaults, the Key limit and each group\'s switch', () => {
  const cfg = searchOn();
  cfg.qq.groups.FAKE_GROUP_B = { label: '另一个群', interject: false, nameMention: false, noticeGiven: false };
  cfg.qq.allowedGroupIds.push('FAKE_GROUP_B');
  cfg.qq.owner.groupMember.FAKE_GROUP_B = ['FAKE_OWNER_B'];
  cfg.qq.groups[GROUP].search = true;
  const e = buildEffective(cfg, { paths, env: {}, now: () => 0 });
  assert.deepEqual(e.search, {
    provider: 'openrouter-sonar', model: SEARCH_MODEL['openrouter-sonar'], baseUrl: OPENROUTER_BASE_URL,
    perAnswer: 2, perDay: 10, maxTokens: SEARCH_DEFAULTS.maxTokens, resultMaxChars: SEARCH_DEFAULTS.resultMaxChars, queryMaxChars: 80, searchMs: SEARCH_DEFAULTS.searchMs,
    price: null,
  });
  assert.equal(e.search.model, 'perplexity/sonar-pro');
  assert.equal(e.budget.searchKeyDailyLimitUsd, 0.5);
  assert.equal(e.qq.groups[GROUP].search, true);
  assert.equal(e.qq.groups.FAKE_GROUP_B.search, false, 'a group without the switch is off');
  assert.equal(groupSearchOn(e, GROUP), true);
  assert.equal(groupSearchOn(e, 'FAKE_GROUP_B'), false, 'control: the other group');
  assert.deepEqual(e.timeouts, { decisionMs: 8000, turnSeconds: 90 }, 'the search timeout lives in the search block');
  assert.equal(JSON.stringify(e).includes('CLO_SEARCH'), false, 'no Key name or value in the file');

  // Lowered limits and the test-mode address reach it; with an OpenRouter test address and no search one, search follows it.
  const tuned = searchOn();
  tuned.search = { perAnswer: 1, perDay: 4, baseUrl: 'http://127.0.0.1:7' };
  tuned.timeouts.searchMs = 9000;
  const t = buildEffective(tuned, { paths, env: { CLO_TEST_ROOT: dir }, now: () => 0 });
  assert.equal(t.search.perAnswer, 1);
  assert.equal(t.search.perDay, 4);
  assert.equal(t.search.searchMs, 9000);
  assert.equal(t.search.baseUrl, 'http://127.0.0.1:7');
  const viaOr = searchOn();
  viaOr.openrouter = { baseUrl: 'http://127.0.0.1:8' };
  assert.equal(buildEffective(viaOr, { paths, env: { CLO_TEST_ROOT: dir }, now: () => 0 }).search.baseUrl, 'http://127.0.0.1:8');
});

test('effective: the search price comes from a lock of the search model only, and only while search is on', () => {
  const LOCK = { id: 'perplexity/sonar-pro', price: { inputPerM: 3, outputPerM: 15, requestUsd: 0.005 } };
  const locked = buildEffective(searchOn(), { paths, env: {}, now: () => 0, searchLock: LOCK });
  assert.deepEqual(locked.search.price, LOCK.price, 'control: a lock of the search model is the price');
  assert.notEqual(locked.search.price, LOCK.price, 'a copy, not the lock object');
  for (const bad of [
    { ...LOCK, id: 'perplexity/sonar' },
    { ...LOCK, price: { ...LOCK.price, inputPerM: 0 } },
    { ...LOCK, price: { ...LOCK.price, requestUsd: -1 } },
    { ...LOCK, price: { inputPerM: 3, outputPerM: 15 } },
    null,
  ]) {
    assert.equal(buildEffective(searchOn(), { paths, env: {}, now: () => 0, searchLock: bad }).search.price, null, JSON.stringify(bad));
  }
  const off = buildEffective(ownCfg(), { paths, env: {}, now: () => 0, searchLock: LOCK });
  assert.equal('search' in off, false, 'off: no block, lock or not');
});

test('the effective reader refuses a search block it does not know, or one on the OpenClaw runtime', () => {
  const sub = join(dir, 'eff');
  mkdirSync(sub, { recursive: true });
  const file = join(sub, 'effective.json');
  const read = createEffectiveReader(file);
  const good = buildEffective(searchOn(), { paths, env: {}, now: () => 0 });
  let tick = 0;
  const write = (obj) => {
    writeFileSync(file, JSON.stringify(obj));
    tick += 10;
    utimesSync(file, new Date(), new Date(Date.now() + tick * 1000));
  };
  write(good);
  assert.equal(read()?.search?.provider, 'openrouter-sonar', 'control: a good file reads');
  write({ ...good, search: { ...good.search, provider: 'perplexity' } });
  assert.equal(read(), null, 'unknown provider');
  write({ ...good, search: { ...good.search, provider: 'none' } });
  assert.equal(read(), null, 'a block that says off is not a shape this build writes');
  write({ ...good, runtime: 'openclaw' });
  assert.equal(read(), null, 'search on the OpenClaw runtime');
  write({ ...good, search: 'on' });
  assert.equal(read(), null, 'not an object');
  write({ ...good, search: { ...good.search, price: { inputPerM: 3, outputPerM: 15, requestUsd: 0.005 } } });
  assert.deepEqual(read()?.search?.price, { inputPerM: 3, outputPerM: 15, requestUsd: 0.005 }, 'control: a locked price reads');
  write({ ...good, search: { ...good.search, price: { inputPerM: 3, outputPerM: 15 } } });
  assert.equal(read(), null, 'a price without its per-call fee');
  write({ ...good, search: { ...good.search, price: { inputPerM: 0, outputPerM: 15, requestUsd: 0 } } });
  assert.equal(read(), null, 'a free token price');
  const { search, ...off } = good;
  assert.ok(search);
  write(off);
  assert.equal(read()?.mode, 'dry-run', 'control: without the block it reads again');
});

// The live facts that pass everything else (as config.test.mjs), on the own runtime.
const NOW = 1000000;
const goodFacts = () => ({ now: NOW, key: { limitMicros: 3250000, limitReset: 'daily' }, reconciled: true, heartbeatAt: NOW - 30000, lastReadyAt: NOW - 60000, gatewayKeyMatches: true, policyOk: true, doctorOk: true, paidPaused: null, env: {} });
const liveReady = (cfg) => {
  cfg.qq.groups[GROUP].noticeGiven = true;
  cfg.acks = { ...cfg.acks, q0Recorded: true, d3: 'a', identityConfirmedAppId: 'FAKE-APP-ID' };
  return cfg;
};

test('live is refused while search is on, until the search rules are recorded', () => {
  assert.equal(SEARCH_RULES_RECORDED, false, 'this build has not recorded them');
  assert.deepEqual(livePreconditions(liveReady(ownCfg()), goodFacts()).failed, [], 'control: off, live passes');
  const on = liveReady(searchOn());
  assert.deepEqual(livePreconditions(on, goodFacts()).failed, ['search_rules']);
  assert.deepEqual(livePreconditions(on, goodFacts(), { searchRules: () => true }).failed, [], 'control: recorded, it passes');
  // A hand edit while live counts it as a config problem too.
  assert.deepEqual(liveConfigProblems(liveReady(ownCfg())), []);
  assert.deepEqual(liveConfigProblems(on), ['search_rules']);
});

test('live: base_urls covers the search address', () => {
  const cfg = liveReady(searchOn());
  cfg.search = { baseUrl: 'http://127.0.0.1:9' };
  const rules = { searchRules: () => true };
  assert.deepEqual(livePreconditions(cfg, goodFacts(), rules).failed, ['base_urls']);
  assert.deepEqual(livePreconditions(cfg, { ...goodFacts(), env: { CLO_TEST_ROOT: dir } }, rules).failed, [], 'control: test mode');
});

// --- The env: the search Key reaches the bot alone, under its child name, and only with search on. ---

const envPaths = resolvePaths({ CLO_TEST_ROOT: join(dir, 'env root') });
const parent = { CLO_TEST_ROOT: join(dir, 'env root'), SystemRoot: 'C:\\Windows', CLO_SEARCH_API_KEY: 'PARENT', CLO_SEARCH_KEY: 'PARENT', PERPLEXITY_API_KEY: 'PARENT' };
const SECRETS = { CLO_QQ_APP_ID: 'FAKE-APP-ID', CLO_QQ_APP_SECRET: 'FAKE-SECRET', CLO_CHAT_API_KEY: 'FAKE-CHAT-KEY', CLO_ANTHROPIC_API_KEY: 'FAKE-ANTHROPIC-KEY', CLO_SEARCH_API_KEY: 'FAKE-SEARCH-KEY' };

test('ownEnv passes the search Key as CLO_SEARCH_KEY only with search on, on either chat kind', () => {
  assert.equal(SEARCH_KEY_ENV, 'CLO_SEARCH_API_KEY');
  assert.equal(SEARCH_CHILD_KEY, 'CLO_SEARCH_KEY');
  for (const kind of ['openrouter', 'anthropic']) {
    const off = ownEnv(envPaths, parent, { secrets: SECRETS, kind });
    assert.equal(off[SEARCH_CHILD_KEY], undefined, `${kind}: off, no search Key, not even the parent's`);
    assert.ok(!Object.values(off).includes('FAKE-SEARCH-KEY'), `${kind}: the value is nowhere`);
    const on = ownEnv(envPaths, parent, { secrets: SECRETS, kind, search: true });
    assert.equal(on[SEARCH_CHILD_KEY], 'FAKE-SEARCH-KEY', `${kind}: on, it is there`);
    assert.equal(on.CLO_SEARCH_API_KEY, undefined, `${kind}: never under the .env name`);
    assert.equal(on.PERPLEXITY_API_KEY, undefined);
    assert.deepEqual(ensureOwnEnvClean(on), [], `${kind}: the bot env is clean with it`);
    assert.equal(modelKeyNames(on).length, 1, `${kind}: still exactly one model Key; the search Key is not one`);
    // The rest of the env is the same as with search off.
    const { [SEARCH_CHILD_KEY]: added, ...rest } = on;
    assert.ok(added);
    assert.deepEqual(rest, off, `${kind}: nothing else changes`);
  }
  // On, but no search Key in .env: nothing stands in for it.
  const { CLO_SEARCH_API_KEY: _, ...noSearch } = SECRETS;
  assert.equal(ownEnv(envPaths, parent, { secrets: noSearch, search: true })[SEARCH_CHILD_KEY], undefined);
  assert.equal(ownEnvForCheck(envPaths, parent, { search: true })[SEARCH_CHILD_KEY], 'check-only', 'control: the check env has the name when on');
  assert.equal(ownEnvForCheck(envPaths, parent)[SEARCH_CHILD_KEY], undefined, 'and not when off');
});

test('the Gateway never gets the search Key under any name, and its check refuses the child name', () => {
  const host = gatewayEnv(envPaths, parent, { secrets: SECRETS, token: 'T' });
  assert.equal(host.OPENROUTER_API_KEY, 'FAKE-CHAT-KEY', 'control: the chat Key passes');
  for (const k of ['CLO_SEARCH_API_KEY', SEARCH_CHILD_KEY, 'PERPLEXITY_API_KEY']) assert.equal(host[k], undefined, k);
  assert.ok(!Object.values(host).includes('FAKE-SEARCH-KEY'));
  assert.deepEqual(ensureGatewayEnvClean(gatewayEnvForCheck(envPaths, parent)), [], 'control: the real Gateway env is clean');
  assert.deepEqual(ensureGatewayEnvClean({ ...host, [SEARCH_CHILD_KEY]: 'x' }), [SEARCH_CHILD_KEY]);
  assert.deepEqual(ensureGatewayEnvClean({ ...host, CLO_SEARCH_API_KEY: 'x' }), ['CLO_SEARCH_API_KEY']);
  assert.deepEqual(ensureOwnEnvClean({ CLO_SEARCH_API_KEY: 'x' }), ['CLO_SEARCH_API_KEY'], 'the .env name never reaches the bot either');
});

test('requireSecrets in live with search on asks for a search Key of its own', () => {
  const live = { ...searchOn(), mode: 'live' };
  const base = { CLO_QQ_APP_ID: 'FAKE-APP-ID', CLO_QQ_APP_SECRET: 'FAKE-SECRET', CLO_CHAT_API_KEY: 'FAKE-CHAT-KEY' };
  assert.throws(() => requireSecrets(live, base), /缺少：CLO_SEARCH_API_KEY/);
  assert.doesNotThrow(() => requireSecrets(live, { ...base, CLO_SEARCH_API_KEY: 'FAKE-SEARCH-KEY' }), 'control: its own Key');
  let caught;
  try {
    requireSecrets(live, { ...base, CLO_SEARCH_API_KEY: 'FAKE-CHAT-KEY' });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof CliError);
  assert.match(caught.message, /CLO_SEARCH_API_KEY 和 CLO_CHAT_API_KEY 是同一个 Key/);
  assert.ok(!caught.message.includes('FAKE-CHAT-KEY'), 'no value in the message');
  assert.doesNotThrow(() => requireSecrets({ ...live, mode: 'dry-run' }, base), 'dry-run spends nothing');
  assert.doesNotThrow(() => requireSecrets({ ...ownCfg(), mode: 'live' }, base), 'control: search off needs no search Key');
});
