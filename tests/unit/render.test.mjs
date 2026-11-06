// Goldens for the pure render. The host validator itself runs in render-validate.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildEffective } from '../../src/clo-plugin/lib/core/config.js';
import { DENY, renderOpenclaw, renderWorkspace, writeAtomic } from '../../src/clo-plugin/lib/core/render.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const FIX = join(HERE, '..', 'fixtures', 'render');
const dir = mkdtempSync(join(tmpdir(), 'clo-render-'));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const sample = () => JSON.parse(readFileSync(join(FIX, 'config.sample.json'), 'utf8'));
const LOCK = {
  primary: { id: 'anthropic/claude-opus-5.5', selector: 'opus-latest', price: { inputPerM: 5, outputPerM: 20, cacheReadPerM: 0.5, cacheWritePerM: 6.25 } },
  decision: { id: 'anthropic/claude-haiku-5.5', price: { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, cacheWritePerM: 1.25 } },
};
const PATHS = { repoRoot: 'C:\\fake repo', workspace: 'C:\\fake repo\\.runtime\\workspace', effectiveJson: 'C:\\fake repo\\.runtime\\clo\\effective.json', db: 'db', eventLog: 'log', systemPromptFile: 'sp' };
function render(cfg, { lock = LOCK, testMode = false, env = {} } = {}) {
  const effective = buildEffective(cfg, { paths: PATHS, modelsLock: lock, env, now: () => 0 });
  return renderOpenclaw(cfg, effective, PATHS, { testMode });
}
const golden = (name) => readFileSync(join(FIX, name), 'utf8');
const pretty = (o) => `${JSON.stringify(o, null, 2)}\n`;

test('golden: the real-provider render', () => {
  assert.equal(pretty(render(sample())), golden('openclaw.real.json'));
});

test('golden: the test-mode render', () => {
  const cfg = sample();
  cfg.openrouter = { baseUrl: 'http://127.0.0.1:9/v1' };
  cfg.qq.apiBaseUrl = 'http://127.0.0.1:8';
  cfg.qq.tokenBaseUrl = 'http://127.0.0.1:8';
  const out = render(cfg, { testMode: true, env: { CLO_TEST_ROOT: 'C:\\t' } });
  assert.equal(pretty(out), golden('openclaw.test.json'));
});

test('deterministic: the same input gives the same bytes', () => {
  assert.equal(pretty(render(sample())), pretty(render(sample())));
});

test('the corrections from the wiring trial are all present', () => {
  const r = render(sample());
  assert.ok(!r.tools.deny.includes('group:*'), 'group:* in deny fails every turn');
  assert.ok(r.tools.deny.every((d) => !d.startsWith('group:')), 'denies are enumerated');
  assert.deepEqual(r.tools.allow, ['clo_feature_status']);
  assert.equal(r.tools.toolSearch, false);
  assert.equal(r.agents.defaults.silentReply.group, 'allow');
  assert.equal(r.session.dmScope, 'per-channel-peer');
  assert.equal(r.agents.defaults.skipBootstrap, true);
  assert.equal(r.plugins.entries.clo.hooks.allowConversationAccess, true);
  assert.deepEqual(r.agents.defaults.model.fallbacks, []);
  assert.equal(r.agents.defaults.model.primary, 'openrouter/anthropic/claude-opus-5.5');
  assert.equal(r.agents.defaults.heartbeat.every, '0m');
  assert.equal(r.agents.defaults.compaction.memoryFlush.enabled, false);
  assert.equal(r.gateway.bind, 'loopback');
  assert.equal(r.gateway.controlUi.enabled, false);
  assert.equal(r.update.auto.enabled, false);
  assert.equal(r.cron.enabled, false);
  assert.equal(r.models.catalogRefresh.enabled, false);
  assert.equal(r.tools.elevated.enabled, false);
  assert.equal(r.plugins.slots.memory, 'none');
});

test('the deny list covers everything the observed deny-only run offered, except the one allowed tool', () => {
  const observed = ['apply_patch', 'edit', 'exec', 'ls', 'process', 'read', 'write', 'tool_call', 'tool_describe', 'tool_search', 'message', 'web_fetch', 'sessions_yield', 'subagents', 'secrets', 'tts'];
  const covered = (name) => DENY.some((d) => (d.endsWith('*') ? name.startsWith(d.slice(0, -1)) : d === name));
  for (const name of observed) assert.ok(covered(name), name);
  assert.ok(!covered('clo_feature_status'));
});

test('thinking effort goes to the documented params.thinking key, with token and cache limits', () => {
  const r = render(sample());
  assert.deepEqual(r.agents.defaults.models['openrouter/anthropic/claude-opus-5.5'].params, { thinking: 'low', maxTokens: 3000, cacheRetention: 'short' });
  const row = r.models.providers.openrouter.models[0];
  assert.equal(row.contextTokens, 24000);
  assert.equal(row.maxTokens, 3000);
  assert.deepEqual(row.cost, { input: 5, output: 20, cacheRead: 0.5, cacheWrite: 6.25 });
});

test('the real render has no base URL or key; only test mode does', () => {
  const real = render(sample()).models.providers.openrouter;
  for (const k of ['baseUrl', 'apiKey', 'request']) assert.equal(real[k], undefined, k);
  const cfg = sample();
  cfg.openrouter = { baseUrl: 'http://127.0.0.1:9/v1' };
  const test_ = render(cfg, { testMode: true, env: { CLO_TEST_ROOT: 'C:\\t' } }).models.providers.openrouter;
  assert.equal(test_.baseUrl, 'http://127.0.0.1:9/v1');
  assert.match(test_.apiKey, /FAKE/);
  assert.equal(test_.request.allowPrivateNetwork, true);
});

test('no channel account when QQ is off, so startAccount is never called', () => {
  const cfg = sample();
  cfg.qq.enabled = false;
  assert.deepEqual(render(cfg).channels, {});
  const on = render(sample()).channels['clo-qq'];
  assert.deepEqual(on, { enabled: true, appId: 'FAKE-APP-ID' });
});

test('the channel config holds no secret, list or owner', () => {
  const text = JSON.stringify(render(sample()));
  for (const bad of ['clientSecret', 'allowedGroupIds', 'ownerMemberIds', 'FAKE_OWNER_A', 'FAKE_GROUP_A', 'OPENROUTER_API_KEY', 'CLO_CHAT_API_KEY', 'CLO_SEARCH_API_KEY', 'PERPLEXITY', 'trial']) {
    assert.ok(!text.includes(bad), bad);
  }
});

test('no model is rendered before the lock has one: dry-run needs no catalog', () => {
  const r = render(sample(), { lock: null });
  assert.equal(r.agents.defaults.model, undefined);
  assert.equal(r.agents.defaults.models, undefined);
  assert.equal(r.models.providers, undefined);
});

test('the workspace render is pure and carries no host path or ID', () => {
  const effective = buildEffective(sample(), { paths: { ...PATHS, repoRoot: ROOT }, modelsLock: LOCK, env: {} });
  const a = renderWorkspace(ROOT, effective);
  const b = renderWorkspace(ROOT, effective);
  assert.deepEqual(a, b);
  assert.deepEqual(Object.keys(a.files).sort(), ['AGENTS.md', 'IDENTITY.md', 'SOUL.md']);
  assert.ok(a.files['AGENTS.md'].includes('## 通道说明'));
  for (const text of [a.systemPrompt, ...Object.values(a.files)]) {
    assert.ok(!text.includes(ROOT));
    assert.ok(!text.includes('FAKE_GROUP_A'));
    assert.ok(!/C:\\/.test(text));
  }
});

test('the rendered AGENTS.md fits the host bootstrap limits we render, so it is never truncated', () => {
  const effective = buildEffective(sample(), { paths: { ...PATHS, repoRoot: ROOT }, modelsLock: LOCK, env: {} });
  const { files } = renderWorkspace(ROOT, effective);
  const { bootstrapMaxChars, bootstrapTotalMaxChars } = render(sample()).agents.defaults;
  assert.ok(files['AGENTS.md'].length < bootstrapMaxChars);
  const total = Object.values(files).reduce((n, t) => n + t.length, 0);
  assert.ok(total < bootstrapTotalMaxChars);
});

test('writeAtomic replaces the file whole, makes directories, leaves no temp file, handles spaces', () => {
  const file = join(dir, 'a b', 'c.json');
  writeAtomic(file, 'one');
  assert.equal(readFileSync(file, 'utf8'), 'one');
  writeAtomic(file, 'two');
  assert.equal(readFileSync(file, 'utf8'), 'two');
  assert.deepEqual(readdirSync(dirname(file)), ['c.json']);
  assert.ok(existsSync(file));
});

test('the host render ignores the runtime field: an explicit openclaw gives the golden bytes, and nothing of it leaks in', () => {
  const cfg = sample();
  assert.equal(cfg.runtime, undefined, 'positive control: the golden comes from a config written before the switch');
  assert.equal(pretty(render({ ...cfg, runtime: 'openclaw' })), golden('openclaw.real.json'));
  const effective = buildEffective({ ...cfg, runtime: 'own' }, { paths: PATHS, modelsLock: LOCK, env: {}, now: () => 0 });
  assert.equal(effective.runtime, 'own');
  assert.equal(pretty(renderOpenclaw(cfg, effective, PATHS)), golden('openclaw.real.json'), 'the field does not reach the host config');
});
