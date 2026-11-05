import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildEffective, ConfigError, createEffectiveReader, livePreconditions, loadBusinessConfig, OPENROUTER_BASE_URL, resolvePaths, validateBusinessConfig } from '../../src/clo-plugin/lib/core/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const dir = mkdtempSync(join(tmpdir(), 'clo-config-'));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
const sample = () => JSON.parse(readFileSync(join(HERE, '..', 'fixtures', 'render', 'config.sample.json'), 'utf8'));
const paths = { repoRoot: 'C:\\repo', db: 'db', eventLog: 'log', systemPromptFile: 'sp' };
const errorsOf = (cfg, env = {}) => validateBusinessConfig(cfg, { env }).errors.map((e) => e.path);

test('budget waits reach the effective file when set, and stay out of it otherwise', () => {
  const plain = buildEffective(sample(), { paths, modelsLock: null });
  for (const f of ['decisionRetryMs', 'creditsRetryMs', 'unsettledClearMs', 'unsettledClearReads']) assert.equal(f in plain.budget, false, f);
  const cfg = sample();
  Object.assign(cfg.budget, { decisionRetryMs: 120000, creditsRetryMs: 600000, unsettledClearMs: 60000, unsettledClearReads: 1 });
  assert.deepEqual(errorsOf(cfg), []);
  const e = buildEffective(cfg, { paths, modelsLock: null });
  assert.equal(e.budget.decisionRetryMs, 120000);
  assert.equal(e.budget.creditsRetryMs, 600000);
  assert.equal(e.budget.unsettledClearMs, 60000);
  assert.equal(e.budget.unsettledClearReads, 1);
  for (const bad of [0, -1, 1.5, '600000', null]) {
    const c = sample();
    c.budget.creditsRetryMs = bad;
    assert.ok(errorsOf(c).includes('budget.creditsRetryMs'), String(bad));
  }
});

test('resolvePaths: real mode sits under the repo and .runtime', () => {
  const p = resolvePaths({});
  assert.equal(p.repoRoot, ROOT);
  assert.equal(p.root, ROOT);
  assert.equal(p.envFile, join(ROOT, '.env'));
  assert.equal(p.configJson, join(ROOT, 'config.json'));
  assert.equal(p.db, join(ROOT, '.runtime', 'clo', 'clo.db'));
  assert.equal(p.openclawJson, join(ROOT, '.runtime', 'state', 'openclaw.json'));
  assert.equal(p.effectiveJson, join(ROOT, '.runtime', 'clo', 'effective.json'));
  assert.notEqual(p.gatewayCwd, ROOT, 'the Gateway never runs in the project root');
  for (const k of ['repoRoot', 'root', 'runtime', 'configJson', 'envFile', 'versionsLock', 'stateDir', 'openclawJson', 'home', 'workspace', 'gatewayCwd', 'cloDir', 'effectiveJson', 'db', 'logsDir', 'eventLog', 'gatewayLog', 'pidFile', 'systemPromptFile']) {
    assert.equal(typeof p[k], 'string', k);
  }
});

test('resolvePaths: CLO_TEST_ROOT moves all but repoRoot, and a path with spaces works', () => {
  const tmp = join(dir, 'a b');
  const p = resolvePaths({ CLO_TEST_ROOT: tmp });
  assert.equal(p.repoRoot, ROOT);
  for (const [k, v] of Object.entries(p)) {
    if (k !== 'repoRoot') assert.ok(v.startsWith(tmp), `${k} = ${v}`);
  }
});

test('resolvePaths: test mode never resolves to the real .env, however it is spelled', () => {
  assert.throws(() => resolvePaths({ CLO_TEST_ROOT: ROOT }), /real project \.env/);
  assert.throws(() => resolvePaths({ CLO_TEST_ROOT: ROOT.toUpperCase() }), /real project \.env/);
  assert.throws(() => resolvePaths({ CLO_TEST_ROOT: `${ROOT}\\tests\\..` }), /real project \.env/);
  assert.throws(() => resolvePaths({ CLO_TEST_ROOT: `${ROOT}\\` }), ConfigError);
});

test('loadBusinessConfig throws ConfigError on a missing file or bad JSON, and accepts a BOM', () => {
  assert.throws(() => loadBusinessConfig(join(dir, 'none.json')), ConfigError);
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{ nope');
  assert.throws(() => loadBusinessConfig(bad), ConfigError);
  writeFileSync(bad, '\uFEFF{"mode":"dry-run"}');
  assert.deepEqual(loadBusinessConfig(bad), { mode: 'dry-run' });
});

test('the sample is valid', () => {
  assert.deepEqual(validateBusinessConfig(sample(), { env: {} }).errors, []);
});

test('rejected always', () => {
  const cases = [
    ['mode', (c) => { c.mode = 'run'; }],
    ['qq.urlMode', (c) => { c.qq.urlMode = 'links'; }],
    ['claudeModel.id', (c) => { c.claudeModel.id = 'openrouter/auto'; }],
    ['claudeModel.id', (c) => { c.claudeModel.id = 'openai/gpt-x'; }],
    ['claudeModel.id', (c) => { c.claudeModel.id = 'anthropic/claude-opus-5.5:thinking'; }],
    ['decisionModel.id', (c) => { c.decisionModel.id = 'openrouter/auto'; }],
    ['qq.allowedDmUserIds', (c) => { c.qq.allowedDmUserIds = ['SOMEONE']; }],
    ['searchProvider', (c) => { c.searchProvider = 'perplexity'; }],
    ['qq.apiBaseUrl', (c) => { c.qq.apiBaseUrl = 'http://127.0.0.1:9'; }],
    ['qq.tokenBaseUrl', (c) => { c.qq.tokenBaseUrl = 'https://bots.qq.com'; }],
    ['openrouter.baseUrl', (c) => { c.openrouter = { baseUrl: 'http://127.0.0.1:9' }; }],
    ['contentPolicy.crisis.numbersVerifiedOn', (c) => { c.contentPolicy.crisis.localNumbers = '110'; }],
    ['quietHours.timezone', (c) => { c.quietHours.timezone = 'UTC'; }],
    ['quietHours', (c) => { c.quietHours.start = '25:00'; }],
    ['budget', (c) => { c.budget.addressedUsd = 3; }],
    ['budget', (c) => { c.budget.interjectUsd = 2.2; }],
    ['budget', (c) => { c.budget.dailyUsd = -1; }],
    ['retention.contextMaxItems', (c) => { c.retention.contextMaxItems = 41; }],
    ['retention.contextMaxAgeHours', (c) => { c.retention.contextMaxAgeHours = 25; }],
    ['qq.appId', (c) => { c.qq.appId = ''; }],
    ['qq.allowedGroupIds', (c) => { c.qq.allowedGroupIds = ['HAS SPACE']; }],
    ['qq.allowedGroupIds', (c) => { c.qq.allowedGroupIds.push('NO_ENTRY'); }],
    ['qq.groups', (c) => { c.qq.groups.EXTRA = { label: 'x', interject: false, nameMention: false, noticeGiven: false }; }],
    ['qq.owner.groupMember', (c) => { c.qq.owner.groupMember.FAKE_GROUP_A = ['HAS SPACE']; }],
    ['contentPolicy.version', (c) => { c.contentPolicy.version = '2'; }],
    ['contentPolicy.sha256', (c) => { c.contentPolicy.sha256 = 'abc'; }],
    ['contentPolicy.outputFilter.categories', (c) => { c.contentPolicy.outputFilter.categories = ['political']; }],
    ['timeouts', (c) => { c.timeouts.turnSeconds = 0; }],
    ['names', (c) => { c.names = []; }],
    ['qq.clientSecret', (c) => { c.qq.clientSecret = 'x'; }],
    ['budget.apiKey', (c) => { c.budget.apiKey = 'x'; }],
  ];
  for (const [path, mutate] of cases) {
    const cfg = sample();
    mutate(cfg);
    assert.ok(errorsOf(cfg).includes(path), `expected an error at ${path}, got ${errorsOf(cfg)}`);
  }
});

test('appId must match the environment when QQ is on', () => {
  assert.ok(errorsOf(sample(), { CLO_QQ_APP_ID: 'ANOTHER' }).includes('qq.appId'));
  assert.deepEqual(errorsOf(sample(), { CLO_QQ_APP_ID: 'FAKE-APP-ID' }), []);
  const off = sample();
  off.qq.enabled = false;
  assert.deepEqual(errorsOf(off, { CLO_QQ_APP_ID: 'ANOTHER' }), []);
});

test('base URL overrides need test mode and loopback', () => {
  const cfg = sample();
  cfg.qq.apiBaseUrl = 'http://127.0.0.1:9';
  cfg.openrouter = { baseUrl: 'http://localhost:9/v1' };
  assert.deepEqual(errorsOf(cfg, { CLO_TEST_ROOT: dir }), []);
  cfg.qq.apiBaseUrl = 'https://api.sgroup.qq.com';
  assert.ok(errorsOf(cfg, { CLO_TEST_ROOT: dir }).includes('qq.apiBaseUrl'));
});

test('a group with no owner blocks live, but not dry-run, where the owner is still being found', () => {
  const cfg = sample();
  cfg.qq.owner.groupMember = {};
  const dry = validateBusinessConfig(cfg, { env: {} });
  assert.equal(dry.ok, true);
  assert.equal(dry.warnings.length, 1);
  cfg.mode = 'live';
  assert.equal(validateBusinessConfig(cfg, { env: {} }).ok, false);
});

test('buildEffective holds what the design lists, no secret, and exact-case IDs', () => {
  const lock = { primary: { id: 'anthropic/claude-opus-5.5', selector: 'opus-latest', price: { inputPerM: 5, outputPerM: 20, cacheReadPerM: 1, cacheWritePerM: 1 } }, decision: { id: 'anthropic/claude-haiku-5.5', price: { inputPerM: 1, outputPerM: 5, cacheReadPerM: 1, cacheWritePerM: 1 } } };
  const e = buildEffective(sample(), { paths, modelsLock: lock, env: {}, now: () => 0 });
  assert.equal(e.version, 1);
  assert.equal(e.generatedAt, '1970-01-01T00:00:00.000Z');
  assert.equal(e.mode, 'dry-run');
  assert.deepEqual(e.qq.groups.FAKE_GROUP_A, { label: '测试群', interject: false, nameMention: false, noticeGiven: false, displayNames: false, cooldownMinutes: 8, perHour: 6, perDay: 8, ownerMemberIds: ['FAKE_OWNER_A'] });
  assert.equal(e.qq.maxPartsGroup, 5);
  assert.equal(e.qq.interjectMaxChars, 400);
  assert.equal(e.qq.urlMode, 'names');
  assert.deepEqual(e.window, { windowMs: 4000, maxPending: 20, maxConcurrentTurns: 2, staleMs: 120000, futureSkewMs: 300000, dispatchDeadlineMs: 180000 });
  assert.equal(e.limits.sendAccountPerMin, 12);
  assert.equal(e.limits.nameWindowMax, 3);
  assert.equal(e.limits.crisisRoutePerGroupPerDay, 3);
  assert.equal(e.budget.residualMinUsd, 0.25);
  assert.equal(e.budget.providerFailStreakPause, 3);
  assert.equal(e.models.primary.id, 'anthropic/claude-opus-5.5');
  assert.equal(e.models.primary.selector, 'opus-latest');
  assert.equal(e.models.primary.price.inputPerM, 5);
  assert.equal(e.models.decision.id, 'anthropic/claude-haiku-5.5');
  assert.equal(e.openrouter.baseUrl, OPENROUTER_BASE_URL);
  assert.equal(e.retention.decisionLines, 15);
  assert.equal(e.retention.decisionLineChars, 200);
  assert.equal(e.retention.decisionCurrentChars, 800);
  assert.equal(e.contentPolicy.sha256, 'f0ed566dc5f7b4e0b0c84111faf24d32f59c40cd8871ef0ba7bd23b938b70048');
  assert.equal(e.contentPolicy.policyFile, 'C:\\repo\\persona\\CONTENT-POLICY.md');
  assert.equal(e.paths.decisionPromptFile, 'C:\\repo\\persona\\decision-prompt.zh.md');
  assert.ok(!/secret|sk-or/i.test(JSON.stringify({ ...e, qq: { ...e.qq } })), 'no secret field or value');
});

test('buildEffective: per-group overrides win; no lock leaves models unresolved, which holds refuse', () => {
  const cfg = sample();
  Object.assign(cfg.qq.groups.FAKE_GROUP_A, { cooldownMinutes: 1, perHour: 2, perDay: 3 });
  const e = buildEffective(cfg, { paths, env: {} });
  assert.equal(e.qq.groups.FAKE_GROUP_A.cooldownMinutes, 1);
  assert.equal(e.qq.groups.FAKE_GROUP_A.perHour, 2);
  assert.equal(e.qq.groups.FAKE_GROUP_A.perDay, 3);
  assert.equal(e.models.primary.id, null);
  assert.equal(e.models.primary.price, null);
});

test('buildEffective refuses an invalid config', () => {
  const cfg = sample();
  cfg.mode = 'nope';
  assert.throws(() => buildEffective(cfg, { paths, env: {} }), ConfigError);
});

test('the effective reader caches by mtime, picks up a change, and fails to null', () => {
  const sub = join(dir, 'eff');
  mkdirSync(sub, { recursive: true });
  const file = join(sub, 'effective.json');
  const read = createEffectiveReader(file);
  assert.equal(read(), null, 'missing');
  const eff = buildEffective(sample(), { paths, env: {} });
  writeFileSync(file, JSON.stringify(eff));
  assert.equal(read().mode, 'dry-run');
  assert.equal(read(), read(), 'the same object while unchanged');
  writeFileSync(file, JSON.stringify({ ...eff, mode: 'live' }));
  utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.equal(read().mode, 'live');
  writeFileSync(file, '{ broken');
  assert.equal(read(), null, 'corrupt');
  writeFileSync(file, JSON.stringify({ version: 2, mode: 'live' }));
  assert.equal(read(), null, 'wrong shape');
  rmSync(file);
  assert.equal(read(), null, 'removed after a good read');
});

const goodCfg = () => {
  const c = sample();
  c.mode = 'dry-run';
  c.qq.groups.FAKE_GROUP_A.noticeGiven = true;
  c.acks = { q0Recorded: true, d3: 'a', identityConfirmedAppId: 'FAKE-APP-ID' };
  return c;
};
const NOW = 1000000;
const goodFacts = () => ({ now: NOW, key: { limitMicros: 3250000, limitReset: 'daily' }, reconciled: true, heartbeatAt: NOW - 30000, lastReadyAt: NOW - 60000, gatewayKeyMatches: true, policyOk: true, doctorOk: true, paidPaused: null, env: {} });

test('live preconditions: all hold', () => {
  assert.deepEqual(livePreconditions(goodCfg(), goodFacts()), { ok: true, failed: [] });
});

test('live preconditions: each code fails on its own', () => {
  const cases = {
    budget: [(c) => { c.budget = { dailyUsd: 0, interjectUsd: 0, searchUsd: 0, namedUsd: 0, addressedUsd: 0 }; }],
    targets: [(c) => { c.qq.owner.groupMember = {}; }],
    dm_closed: [(c) => { c.qq.allowedDmUserIds = ['X']; }],
    key_readable: [null, (f) => { f.key = null; }],
    reconciled: [null, (f) => { f.reconciled = false; }],
    heartbeat: [null, (f) => { f.heartbeatAt = NOW - 90001; }],
    gateway_key: [null, (f) => { f.gatewayKeyMatches = false; }],
    identity: [(c) => { c.acks.identityConfirmedAppId = 'OTHER'; }],
    notice: [(c) => { c.qq.groups.FAKE_GROUP_A.noticeGiven = false; }],
    q0: [(c) => { c.acks.q0Recorded = false; }],
    d3: [(c) => { c.acks.d3 = '   '; }],
    policy: [null, (f) => { f.policyOk = false; }],
    numbers: [(c) => { c.contentPolicy.crisis.localNumbers = '110'; c.contentPolicy.crisis.numbersVerifiedOn = ''; }],
    doctor: [null, (f) => { f.doctorOk = false; }],
    base_urls: [(c) => { c.qq.apiBaseUrl = 'http://127.0.0.1:9'; }],
    no_paid_pause: [null, (f) => { f.paidPaused = 'residual'; }],
    models: [null, (f) => { f.modelsLocked = false; }],
  };
  for (const [code, [mutateCfg, mutateFacts]] of Object.entries(cases)) {
    const cfg = goodCfg();
    const facts = goodFacts();
    if (mutateCfg) mutateCfg(cfg);
    if (mutateFacts) mutateFacts(facts);
    assert.deepEqual(livePreconditions(cfg, facts).failed, [code], code);
  }
});

test('live preconditions: the finer cases', () => {
  const unlimited = goodFacts();
  unlimited.key = { limitMicros: null, limitReset: 'daily' };
  assert.deepEqual(livePreconditions(goodCfg(), unlimited).failed, ['key_readable'], 'a key with no limit');
  const monthly = goodFacts();
  monthly.key = { limitMicros: 1, limitReset: 'monthly' };
  assert.deepEqual(livePreconditions(goodCfg(), monthly).failed, ['key_readable'], 'not a daily limit');
  const noReady = goodFacts();
  noReady.lastReadyAt = null;
  assert.deepEqual(livePreconditions(goodCfg(), noReady).failed, ['heartbeat']);
  const off = goodCfg();
  off.contentPolicy.enabled = false;
  assert.deepEqual(livePreconditions(off, goodFacts()).failed, ['policy']);
  const urls = goodCfg();
  urls.qq.apiBaseUrl = 'http://127.0.0.1:9';
  assert.deepEqual(livePreconditions(urls, { ...goodFacts(), env: { CLO_TEST_ROOT: dir } }).failed, [], 'allowed in test mode');
  const empty = goodCfg();
  empty.qq.allowedGroupIds = [];
  empty.qq.groups = {};
  assert.deepEqual(livePreconditions(empty, goodFacts()).failed.sort(), ['notice', 'targets']);
});

test('nothing passes on empty facts, and the shipped defaults are not ready for live: D3 is pending', () => {
  const r = livePreconditions(sample(), {});
  assert.equal(r.ok, false);
  for (const code of ['d3', 'q0', 'identity', 'key_readable', 'reconciled', 'heartbeat', 'policy', 'doctor']) {
    assert.ok(r.failed.includes(code), code);
  }
});
