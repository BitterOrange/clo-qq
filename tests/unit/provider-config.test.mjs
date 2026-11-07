// The providers block in config.json, the effective apiProvider and the per-kind model lock. Without the block,
// everything is as before; each refusal here has an accepted control in the same test.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertApplicable, CliError, lockMatches, makeContext, readModelsLock, readPriceBook, usableLock, writeModelsLock } from '../../src/cli/common.mjs';
import { activeKindOf, buildEffective, ConfigError, createEffectiveReader, lockFitProblems, providerOfConfig, providerOfEffective, validateBusinessConfig } from '../../src/clo-plugin/lib/core/config.js';
import { replyHoldMicros } from '../../src/clo-plugin/lib/core/ledger.js';
import { worstCaseMicros } from '../../src/clo-plugin/lib/core/providers/cost.js';
import { lockFromPriceBook } from '../../src/clo-plugin/lib/core/models.js';
import { CAPABILITIES, DEFAULT_BASE } from '../../src/clo-plugin/lib/core/providers/registry.js';
import { FAKE_ANTHROPIC_KEY, FAKE_OPENROUTER_KEY } from '../harness/fake-keys.mjs';
import { baseConfig, CATALOG, clo, configOf, effectiveOf, fakeProvider, makeRoot, openclawOf, readJson, recordProvider, TEST_ANTHROPIC_BOOK, testEnv, withProviders, writePriceBook } from './_cli-helper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'clo-provider-config-'));
const roots = [];
after(() => {
  roots.forEach((r) => r.cleanup());
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
const root = (label, cfg) => {
  const r = makeRoot(label, cfg);
  roots.push(r);
  return r.root;
};

const sample = () => JSON.parse(readFileSync(join(HERE, '..', 'fixtures', 'render', 'config.sample.json'), 'utf8'));
const paths = { repoRoot: 'C:\\repo', db: 'db', eventLog: 'log', systemPromptFile: 'sp' };
const TEST = { CLO_TEST_ROOT: dir };
const errorsOf = (cfg, env = {}) => validateBusinessConfig(cfg, { env }).errors.map((e) => e.path);
const valid = (cfg, env = {}) => assert.deepEqual(validateBusinessConfig(cfg, { env }).errors, []);

// The block `clo provider add anthropic` writes, on a config that is valid without it.
const PROVIDERS = () => ({
  openrouter: { kind: 'openrouter', keyEnv: 'CLO_CHAT_API_KEY' },
  anthropic: { kind: 'anthropic', keyEnv: 'CLO_ANTHROPIC_API_KEY', models: { primary: 'claude-opus-5-5', decision: 'claude-haiku-5-5' } },
});
const withBlock = (active = 'openrouter', over = {}) => {
  const c = sample();
  c.providers = PROVIDERS();
  c.activeProvider = active;
  c.acks.provider = { name: active, at: '2000-01-01T00:00:00.000Z' };
  if (active === 'anthropic') c.runtime = 'own';
  return Object.assign(c, over);
};
const ACK = () => ({ kind: 'workspace_monthly', usd: 20, prepaidNoReload: true, at: '2000-01-01T00:00:00.000Z' });
const book = TEST_ANTHROPIC_BOOK;
const anthropicLock = () => lockFromPriceBook({ primary: 'claude-opus-5-5', decision: 'claude-haiku-5-5' }, book(), { confirmPrice: true }).lock;
const ORLOCK = { primary: { id: 'anthropic/claude-opus-5.5', selector: 'opus-latest', price: { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2, cacheWritePerM: 5 } }, decision: { id: 'anthropic/claude-haiku-5.5', price: { inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01, cacheWritePerM: 0.125 } } };
const eff = (cfg, lock = null, env = {}) => buildEffective(cfg, { paths, modelsLock: lock, env, now: () => 0 });

test('without a providers block nothing is new: the implicit OpenRouter entry, and no apiProvider in the effective file', () => {
  for (const runtime of [undefined, 'openclaw', 'own']) {
    const c = sample();
    if (runtime) c.runtime = runtime;
    valid(c);
    const p = providerOfConfig(c);
    assert.equal(p.kind, 'openrouter');
    assert.equal(p.implicit, true);
    assert.equal(activeKindOf(c), 'openrouter');
    const e = eff(c, ORLOCK);
    assert.equal('apiProvider' in e, false, String(runtime));
    assert.equal(e.models.primary.id, 'anthropic/claude-opus-5.5');
    assert.equal(providerOfEffective(e).implicit, true);
  }
});

test('a providers block on the OpenClaw runtime changes no byte of the effective file', () => {
  for (const runtime of [undefined, 'openclaw']) {
    const plain = sample();
    const block = withBlock('openrouter');
    if (runtime) {
      plain.runtime = runtime;
      block.runtime = runtime;
    }
    const { providers: _p, activeProvider: _a, ...rest } = block;
    rest.acks = { ...block.acks };
    delete rest.acks.provider;
    assert.deepEqual(rest, plain, 'the two configs differ only in the block');
    valid(block);
    for (const lock of [null, ORLOCK]) assert.equal(JSON.stringify(eff(block, lock)), JSON.stringify(eff(plain, lock)), String(runtime));
  }
  // Positive control: on the own runtime the same block adds apiProvider.
  assert.deepEqual(eff(withBlock('openrouter', { runtime: 'own' })).apiProvider, { name: 'openrouter', kind: 'openrouter', baseUrl: DEFAULT_BASE.openrouter, hardCap: null });
});

test('a top-level apiProvider is refused by name, with or without providers', () => {
  const plain = sample();
  plain.apiProvider = { name: 'anthropic', kind: 'anthropic' };
  assert.ok(errorsOf(plain).includes('apiProvider'));
  const block = withBlock('openrouter', { runtime: 'own', apiProvider: { name: 'anthropic', kind: 'anthropic' } });
  assert.ok(errorsOf(block).includes('apiProvider'));
  assert.equal(providerOfConfig(block), null, 'and the reader names no provider for it');
  valid(withBlock('openrouter', { runtime: 'own' }));
});

test('activeProvider is required with providers, must name an entry, and needs the block', () => {
  const cases = [
    ['activeProvider', (c) => { delete c.activeProvider; }],
    ['activeProvider', (c) => { c.activeProvider = 'nobody'; }],
    ['activeProvider', (c) => { c.activeProvider = 'toString'; }],
    ['providers', (c) => { c.providers = {}; }],
    ['providers', (c) => { c.providers = []; }],
  ];
  for (const [path, mutate] of cases) {
    const c = withBlock();
    mutate(c);
    assert.ok(errorsOf(c).includes(path), `${path}: ${errorsOf(c)}`);
  }
  const orphan = sample();
  orphan.activeProvider = 'openrouter';
  assert.ok(errorsOf(orphan).includes('activeProvider'));
  valid(withBlock());
});

test('activeProvider must equal acks.provider.name, so a hand switch is refused', () => {
  for (const ack of [undefined, { name: 'anthropic' }, { name: 'OpenRouter' }, 'openrouter']) {
    const c = withBlock();
    if (ack === undefined) delete c.acks.provider;
    else c.acks.provider = ack;
    assert.ok(errorsOf(c).includes('acks.provider'), JSON.stringify(ack));
  }
  const handSwitch = withBlock('openrouter', { runtime: 'own' });
  handSwitch.activeProvider = 'anthropic';
  assert.ok(errorsOf(handSwitch).includes('acks.provider'));
  valid(withBlock('anthropic'));
});

test('entry names and fields: a whitelist, and failover fields refused by name, in an entry or at the top', () => {
  for (const bad of ['Anthropic', '1st', 'my_or', 'a'.repeat(33), '']) {
    const c = withBlock();
    c.providers[bad] = c.providers.openrouter;
    delete c.providers.openrouter;
    c.activeProvider = bad;
    c.acks.provider.name = bad;
    assert.ok(errorsOf(c).includes(`providers.${bad}`), bad);
  }
  const named = withBlock();
  named.providers['my-or2'] = named.providers.openrouter;
  delete named.providers.openrouter;
  named.activeProvider = 'my-or2';
  named.acks.provider.name = 'my-or2';
  valid(named);
  for (const f of ['fallbacks', 'priority', 'failover', 'order', 'backup', 'region']) {
    const c = withBlock();
    c.providers.anthropic[f] = f === 'fallbacks' ? ['claude-opus-5'] : 1;
    assert.ok(errorsOf(c).includes(`providers.anthropic.${f}`), f);
  }
  for (const f of ['fallbacks', 'priority', 'failover']) {
    const c = withBlock();
    c[f] = ['anthropic'];
    assert.ok(errorsOf(c).includes(f), f);
  }
});

test('keyEnv is the fixed name for the kind, so a Key value or a second entry of one kind is refused', () => {
  for (const keyEnv of [undefined, 'CLO_CHAT_API_KEY', FAKE_ANTHROPIC_KEY, 'ANTHROPIC_API_KEY', 'CLO_TEST_ANTHROPIC_API_KEY']) {
    const c = withBlock();
    if (keyEnv === undefined) delete c.providers.anthropic.keyEnv;
    else c.providers.anthropic.keyEnv = keyEnv;
    assert.ok(errorsOf(c).includes('providers.anthropic.keyEnv'), String(keyEnv && keyEnv.length));
  }
  const twice = withBlock();
  twice.providers.second = { kind: 'openrouter', keyEnv: 'CLO_CHAT_API_KEY' };
  assert.ok(errorsOf(twice).includes('providers.second'));
  const unknown = withBlock();
  unknown.providers.other = { kind: 'openai', keyEnv: 'X' };
  assert.ok(errorsOf(unknown).includes('providers.other.kind'));
  valid(withBlock());
  // keyEnv is a field name the secret scan accepts, and the effective file never carries it.
  assert.equal(JSON.stringify(eff(withBlock('anthropic'))).includes('keyEnv'), false);
});

test('an entry baseUrl: loopback in test mode only, on the own runtime only, and not beside openrouter.baseUrl', () => {
  const at = (name, url, over) => {
    const c = withBlock('openrouter', { runtime: 'own', ...over });
    c.providers[name].baseUrl = url;
    return c;
  };
  assert.ok(errorsOf(at('anthropic', 'http://127.0.0.1:9')).includes('providers.anthropic.baseUrl'), 'not in test mode');
  assert.ok(errorsOf(at('anthropic', 'https://api.anthropic.com', {}), TEST).includes('providers.anthropic.baseUrl'), 'not loopback');
  assert.ok(errorsOf(at('anthropic', 'http://127.0.0.1:9', { runtime: 'openclaw' }), TEST).includes('providers.anthropic.baseUrl'), 'not own');
  assert.ok(errorsOf(at('openrouter', 'http://127.0.0.1:9/api/v1', { openrouter: { baseUrl: 'http://127.0.0.1:8/api/v1' } }), TEST).includes('providers.openrouter.baseUrl'), 'both');
  valid(at('anthropic', 'http://127.0.0.1:9'), TEST);
  valid(at('openrouter', 'http://127.0.0.1:9/api/v1'), TEST);
});

test('the OpenClaw runtime runs on OpenRouter only; an inactive Anthropic entry is fine there', () => {
  for (const runtime of [undefined, 'openclaw']) {
    const c = withBlock('anthropic');
    if (runtime) c.runtime = runtime;
    else delete c.runtime;
    assert.ok(errorsOf(c).includes('activeProvider'), String(runtime));
    // The reader never gives Anthropic there, whatever the file says.
    assert.equal(providerOfConfig(c).kind, 'openrouter');
  }
  valid(withBlock('openrouter'));
  valid(withBlock('anthropic'));
});

test('OpenRouter entries take no models; Anthropic entries need concrete Opus, Sonnet or Haiku ids', () => {
  const or = withBlock();
  or.providers.openrouter.models = { primary: 'anthropic/claude-opus-5.5' };
  assert.ok(errorsOf(or).includes('providers.openrouter.models'));
  for (const id of ['claude-opus-latest', 'claude-opus-5-5-20261101', 'claude-fable-5-1', 'anthropic/claude-opus-5.5', 'claude-opus-5.5', '', 5, undefined]) {
    const c = withBlock();
    c.providers.anthropic.models.primary = id;
    assert.ok(errorsOf(c).includes('providers.anthropic.models.primary'), String(id));
  }
  const extra = withBlock();
  extra.providers.anthropic.models.fallback = 'claude-opus-5';
  assert.ok(errorsOf(extra).includes('providers.anthropic.models.fallback'));
  const none = withBlock();
  delete none.providers.anthropic.models;
  assert.ok(errorsOf(none).includes('providers.anthropic.models'));
  for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5']) {
    const c = withBlock();
    c.providers.anthropic.models.primary = id;
    valid(c);
  }
});

test('efforts on an active Anthropic entry: the primary has no none, the decision only none', () => {
  for (const effort of ['none', 'minimal', undefined]) {
    const c = withBlock('anthropic');
    c.claudeModel.effort = effort;
    assert.ok(errorsOf(c).includes('claudeModel.effort'), String(effort));
  }
  for (const effort of ['low', 'high']) {
    const c = withBlock('anthropic');
    c.decisionModel.effort = effort;
    assert.ok(errorsOf(c).includes('decisionModel.effort'), effort);
  }
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const c = withBlock('anthropic');
    c.claudeModel.effort = effort;
    valid(c);
  }
  // Only the active kind's rules apply: OpenRouter keeps its own checks for the same values.
  const inactive = withBlock('openrouter', { runtime: 'own' });
  inactive.decisionModel.effort = 'low';
  valid(inactive);
});

test('the effective apiProvider: name, kind, base and a copy of the attested cap; never a Key, never the config block', () => {
  const c = withBlock('anthropic');
  const e = eff(c, null, { CLO_ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY, CLO_CHAT_API_KEY: FAKE_OPENROUTER_KEY });
  assert.deepEqual(e.apiProvider, { name: 'anthropic', kind: 'anthropic', baseUrl: DEFAULT_BASE.anthropic, hardCap: null });
  assert.equal('providers' in e, false);
  assert.equal('activeProvider' in e, false);
  assert.deepEqual(e.openrouter, { baseUrl: DEFAULT_BASE.openrouter }, 'always emitted');
  const text = JSON.stringify(e);
  assert.equal(text.includes(FAKE_ANTHROPIC_KEY), false);
  assert.equal(text.includes(FAKE_OPENROUTER_KEY), false);
  assert.equal(text.includes('keyReadable'), false, 'capabilities come from code, not from the file');
  const p = providerOfEffective(e);
  assert.equal(p.kind, 'anthropic');
  assert.equal(p.caps, CAPABILITIES.anthropic);

  const acked = withBlock('anthropic');
  acked.acks.hardCap = { anthropic: ACK() };
  const ea = eff(acked);
  assert.deepEqual(ea.apiProvider.hardCap, ACK());
  assert.notEqual(ea.apiProvider.hardCap, acked.acks.hardCap.anthropic, 'a copy');
  const other = withBlock('anthropic');
  other.acks.hardCap = { openrouter: ACK() };
  assert.equal(eff(other).apiProvider.hardCap, null, 'only the active entry’s ack is copied');
});

test('an OpenRouter entry base on the own runtime is the base of the effective file too', () => {
  const c = withBlock('openrouter', { runtime: 'own' });
  c.providers.openrouter.baseUrl = 'http://127.0.0.1:9/api/v1';
  const e = eff(c, null, TEST);
  assert.equal(e.openrouter.baseUrl, 'http://127.0.0.1:9/api/v1');
  assert.equal(e.apiProvider.baseUrl, 'http://127.0.0.1:9/api/v1');
  const top = withBlock('openrouter', { runtime: 'own', openrouter: { baseUrl: 'http://127.0.0.1:8/api/v1' } });
  assert.equal(eff(top, null, TEST).openrouter.baseUrl, 'http://127.0.0.1:8/api/v1');
  assert.equal(eff(top, null, TEST).apiProvider.baseUrl, 'http://127.0.0.1:8/api/v1');
});

test('Anthropic models: ids from the entry with selector = id, prices only from a lock for exactly those ids', () => {
  const c = withBlock('anthropic');
  const locked = eff(c, anthropicLock());
  assert.equal(locked.models.primary.id, 'claude-opus-5-5');
  assert.equal(locked.models.primary.selector, 'claude-opus-5-5');
  assert.equal(locked.models.primary.price.cacheWrite1hPerM, 8);
  assert.equal(locked.models.decision.id, 'claude-haiku-5-5');
  assert.equal(locked.models.decision.price.long.aboveTokens, 100000);
  assert.equal(locked.models.primary.effort, 'low');
  assert.equal(locked.models.decision.effort, 'none');
  const unlocked = eff(c, null);
  assert.equal(unlocked.models.primary.id, 'claude-opus-5-5');
  assert.equal(unlocked.models.primary.price, null);
  assert.equal(unlocked.models.decision.price, null);
  // An OpenRouter lock, or one for other ids, prices nothing.
  for (const wrong of [ORLOCK, { ...anthropicLock(), decision: { id: 'claude-haiku-4-5', price: { inputPerM: 1, outputPerM: 5 } } }]) {
    const e = eff(c, wrong);
    assert.equal(e.models.primary.id, 'claude-opus-5-5');
    assert.equal(e.models.primary.price, null);
    assert.equal(e.models.decision.price, null);
  }
});

test('the effective reader refuses an apiProvider kind it does not know', () => {
  const sub = join(dir, 'eff');
  mkdirSync(sub, { recursive: true });
  const file = join(sub, 'effective.json');
  const e = eff(withBlock('anthropic'));
  writeFileSync(file, JSON.stringify(e));
  const read = createEffectiveReader(file);
  assert.equal(read().apiProvider.kind, 'anthropic', 'positive control');
  for (const [i, apiProvider] of [{ ...e.apiProvider, kind: 'openai' }, 'anthropic', null].entries()) {
    const f = join(sub, `bad-${i}.json`);
    writeFileSync(f, JSON.stringify({ ...e, apiProvider }));
    assert.equal(createEffectiveReader(f)(), null, JSON.stringify(apiProvider));
  }
});

test('lock files per kind: OpenRouter in models.lock, Anthropic in models.locks.anthropic, books apart', () => {
  const r = root('provider-lock-files');
  const ctx = { paths: { versionsLock: join(r, 'versions.lock.json') }, now: () => 0 };
  assert.equal(readModelsLock(ctx.paths), null);
  assert.equal(readModelsLock(ctx.paths, 'anthropic'), null);
  assert.equal(readPriceBook(ctx.paths, 'anthropic'), null, 'a test root has no book');
  writePriceBook(r);
  assert.deepEqual(readPriceBook(ctx.paths, 'anthropic'), book());
  assert.equal(readPriceBook(ctx.paths, 'openrouter'), null);
  writeModelsLock(ctx, anthropicLock(), { kind: 'anthropic', changed: true, qqPlatformNotified: true });
  writeModelsLock(ctx, ORLOCK, { changed: true });
  assert.deepEqual(readModelsLock(ctx.paths, 'anthropic'), anthropicLock());
  assert.deepEqual(readModelsLock(ctx.paths), ORLOCK);
  assert.equal(readModelsLock(ctx.paths, 'openai'), null);
  const file = readJson(ctx.paths.versionsLock).models;
  assert.deepEqual(file.priceBooks?.anthropic, book(), 'neither write touched the book');
  assert.equal(file.primaryResolved, ORLOCK.primary.id, 'the Anthropic write left the OpenRouter fields alone');
  assert.deepEqual(file.changes.map((x) => x.kind ?? 'openrouter'), ['anthropic', 'openrouter']);
  assert.equal(file.changes[0].qqPlatformNotified, true);
});

test('lockMatches per kind: a lock counts only for the kind and the ids the config names now', () => {
  const c = withBlock('anthropic');
  assert.equal(lockMatches(c, anthropicLock(), 'anthropic'), true);
  assert.deepEqual(usableLock(c, anthropicLock(), 'anthropic'), anthropicLock());
  assert.equal(lockMatches(c, ORLOCK, 'anthropic'), false);
  assert.equal(lockMatches(c, anthropicLock(), 'openrouter'), false);
  assert.equal(lockMatches(c, ORLOCK), true, 'the OpenRouter lock still matches the OpenRouter models');
  const moved = withBlock('anthropic');
  moved.providers.anthropic.models.primary = 'claude-sonnet-5-5';
  assert.equal(lockMatches(moved, anthropicLock(), 'anthropic'), false);
  assert.equal(usableLock(moved, anthropicLock(), 'anthropic'), null);
  // A lock is made before `clo provider use` switches to it, so it matches the Anthropic entry while OpenRouter is active.
  const inactive = withBlock('openrouter', { runtime: 'own' });
  assert.equal(lockMatches(inactive, anthropicLock(), 'anthropic'), true, 'an inactive entry has a usable lock');
  assert.deepEqual(usableLock(inactive, anthropicLock(), 'anthropic'), anthropicLock());
  assert.equal(lockMatches(inactive, anthropicLock(), 'anthropic', { entryName: 'anthropic' }), true);
  assert.equal(lockMatches(inactive, anthropicLock(), 'anthropic', { entryName: 'openrouter' }), false, 'an entry of another kind');
  const wrongId = anthropicLock();
  wrongId.primary = { ...wrongId.primary, id: 'claude-sonnet-5-5', selector: 'claude-sonnet-5-5' };
  assert.equal(lockMatches(inactive, wrongId, 'anthropic'), false, 'a lock for other ids');
  assert.equal(lockMatches(sample(), anthropicLock(), 'anthropic'), false, 'no providers block, no Anthropic entry');
});

test('assertApplicable takes a lock for the inactive Anthropic entry, and refuses one for other ids', () => {
  const r = root('provider-applicable-inactive', withProviders(baseConfig(), { active: 'openrouter' }));
  const ctx = makeContext({ env: testEnv(r), fetch: () => { throw new Error('no network'); }, now: () => 0 });
  const cfg = configOf(r);
  cfg.runtime = 'own';
  const res = assertApplicable(ctx, cfg, { lock: anthropicLock(), lockKind: 'anthropic' });
  assert.equal(res.effective.models.primary.selector, 'opus-latest', 'the render still runs on the active OpenRouter models');
  const wrongId = anthropicLock();
  wrongId.primary = { ...wrongId.primary, id: 'claude-sonnet-5-5', selector: 'claude-sonnet-5-5' };
  assert.throws(() => assertApplicable(ctx, cfg, { lock: wrongId, lockKind: 'anthropic' }), (e) => e instanceof CliError && /不一致/.test(e.message));
});

test('a lock whose long-prompt rates begin below the input bound is refused, so the hold covers what a call can settle', async () => {
  const haikuIds = { primary: 'claude-haiku-5-5', decision: 'claude-haiku-5-5' };
  const haikuLock = lockFromPriceBook(haikuIds, book(), { confirmPrice: true }).lock;
  const c = withBlock('anthropic');
  c.providers.anthropic.models = { ...haikuIds };
  c.claudeModel.contextTokens = 150000;
  valid(c);
  assert.deepEqual(lockFitProblems(c, haikuLock).map((p) => [p.path, p.aboveTokens]), [['claudeModel.contextTokens', 100000]]);
  assert.throws(() => eff(c, haikuLock), (e) => e instanceof ConfigError && /claudeModel.contextTokens/.test(e.message));
  // Positive control: at the threshold the long card is never reached, and the own hold covers the worst call.
  c.claudeModel.contextTokens = 100000;
  assert.deepEqual(lockFitProblems(c, haikuLock), []);
  const ok = eff(c, haikuLock);
  const hold = replyHoldMicros('reply_required', ok.models.primary, 'own');
  assert.ok(hold >= worstCaseMicros({ input: 100000, output: c.claudeModel.maxTokens }, ok.models.primary.price, { geoUs: false }), String(hold));
  // Nothing priced, nothing refused; and Opus has no long card, so its lock fits any bound.
  c.claudeModel.contextTokens = 150000;
  assert.equal(eff(c, null).models.primary.price, null);
  const opus = withBlock('anthropic');
  opus.claudeModel.contextTokens = 150000;
  assert.deepEqual(lockFitProblems(opus, anthropicLock()), []);

  // The console refuses it before anything is written, and says so in Chinese.
  const cfg = withProviders(baseConfig(), { active: 'anthropic' });
  cfg.providers.anthropic.models = { ...haikuIds };
  const r = root('provider-apply-long-card', cfg);
  recordProvider(r);
  writeModelsLock({ paths: { versionsLock: join(r, 'versions.lock.json') }, now: () => 0 }, haikuLock, { kind: 'anthropic' });
  assert.equal((await clo(r, ['apply'])).code, 0, 'positive control');
  const wide = configOf(r);
  wide.claudeModel.contextTokens = 150000;
  writeFileSync(join(r, 'config.json'), `${JSON.stringify(wide, null, 2)}
`);
  const res = await clo(r, ['apply']);
  assert.notEqual(res.code, 0);
  assert.match(`${res.out}${res.err}`, /长提示价/);
});

const NOW = () => Date.parse('2026-01-02T03:04:05.000Z');

test('clo apply: with a providers block on the OpenClaw runtime, openclaw.json and effective.json are byte-identical', async () => {
  const plain = root('provider-apply-plain');
  const block = root('provider-apply-block', withProviders(baseConfig()));
  for (const r of [plain, block]) {
    const res = await clo(r, ['apply'], { now: NOW });
    assert.equal(res.code, 0, `${res.out}${res.err}`);
  }
  assert.ok(configOf(block).providers, 'positive control: the block is there');
  const bytes = (r, f) => readFileSync(join(r, '.runtime', f), 'utf8');
  const rel = (r, text) => text.split(r.replaceAll('\\', '\\\\')).join('<root>');
  for (const f of [join('state', 'openclaw.json'), join('clo', 'effective.json')]) {
    assert.equal(rel(block, bytes(block, f)), rel(plain, bytes(plain, f)), f);
  }
  assert.equal('apiProvider' in effectiveOf(block), false);
  assert.ok(openclawOf(block).models, 'the host config was rendered');
});

test('clo apply on the own runtime with Anthropic active writes apiProvider and the Anthropic ids', async () => {
  const r = root('provider-apply-anthropic', withProviders(baseConfig(), { active: 'anthropic', anthropicBaseUrl: 'http://127.0.0.1:9' }));
  recordProvider(r);
  const res = await clo(r, ['apply'], { now: NOW });
  assert.equal(res.code, 0, `${res.out}${res.err}`);
  const e = effectiveOf(r);
  assert.deepEqual(e.apiProvider, { name: 'anthropic', kind: 'anthropic', baseUrl: 'http://127.0.0.1:9', hardCap: null });
  assert.equal(e.models.primary.id, 'claude-opus-5-5');
  assert.equal(e.models.primary.price, null, 'no Anthropic lock yet');
  const text = readFileSync(join(r, '.runtime', 'clo', 'effective.json'), 'utf8');
  assert.equal(text.includes(FAKE_OPENROUTER_KEY), false);
});

test('clo model refresh leaves models.locks.anthropic and the price book untouched, with Anthropic active or not', async () => {
  for (const active of ['openrouter', 'anthropic']) {
    const r = root(`provider-refresh-${active}`, withProviders(baseConfig(), { active }));
    recordProvider(r);
    writePriceBook(r);
    const ctx = { paths: { versionsLock: join(r, 'versions.lock.json') }, now: () => 0 };
    writeModelsLock(ctx, anthropicLock(), { kind: 'anthropic' });
    const before = readJson(join(r, 'versions.lock.json')).models;
    const p = fakeProvider({ catalog: CATALOG() });
    const res = await clo(r, ['model', 'refresh'], { fetch: p.fetch });
    assert.equal(res.code, 0, `${active}: ${res.out}${res.err}`);
    const after = readJson(join(r, 'versions.lock.json')).models;
    assert.ok(after.lock?.primary?.id, 'positive control: the OpenRouter lock was written');
    assert.deepEqual(after.locks, before.locks, active);
    assert.deepEqual(after.priceBooks, before.priceBooks, active);
    if (active === 'anthropic') assert.equal(effectiveOf(r).models.primary.price.cacheWrite1hPerM, 8, 'the render runs on the Anthropic lock');
  }
});

test('apply refuses an Anthropic lock for other ids than the config names', async () => {
  const cfg = withProviders(baseConfig(), { active: 'anthropic' });
  const r = root('provider-apply-lock', cfg);
  recordProvider(r);
  const ctx = { paths: { versionsLock: join(r, 'versions.lock.json') }, now: () => 0 };
  writeModelsLock(ctx, anthropicLock(), { kind: 'anthropic' });
  assert.equal((await clo(r, ['apply'])).code, 0, 'positive control');
  const moved = configOf(r);
  moved.providers.anthropic.models.primary = 'claude-sonnet-5-5';
  writeFileSync(join(r, 'config.json'), `${JSON.stringify(moved, null, 2)}\n`);
  const res = await clo(r, ['apply']);
  assert.notEqual(res.code, 0);
  assert.match(`${res.out}${res.err}`, /不一致/);
});
