// Runs the console in-process against a temp root. Never touches the project's .env or state.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../../src/cli/clo.mjs';
import { openStore } from '../../src/clo-plugin/lib/core/store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..');
export const NODE = join(ROOT, '.runtime', 'node', 'node.exe');
export const NET_GUARD = join(ROOT, 'tests', 'harness', 'net-guard.mjs');

export const FAKE_KEY = 'sk-or-v1-FAKE-KEY-FOR-LOCAL-MOCK-ONLY';
export const FAKE_SECRET = 'FAKE-QQ-SECRET-FOR-LOCAL-MOCK-ONLY';
export const APP_ID = 'FAKEAPPID000111';
export const GROUP_ID = 'FAKEGROUPOPENID000AAA';
export const OWNER_ID = 'FAKEOWNEROPENID000BBB';

export const baseConfig = (over = {}) => {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config.example.json'), 'utf8'));
  cfg.openrouter = { baseUrl: 'http://127.0.0.1:9/api/v1' };
  return Object.assign(cfg, over);
};

export function enabledConfig() {
  const cfg = baseConfig();
  cfg.qq.enabled = true;
  cfg.qq.appId = APP_ID;
  cfg.qq.apiBaseUrl = 'http://127.0.0.1:9';
  cfg.qq.tokenBaseUrl = 'http://127.0.0.1:9';
  cfg.qq.allowedGroupIds = [GROUP_ID];
  cfg.qq.groups = { [GROUP_ID]: { label: '测试群', interject: false, nameMention: false, noticeGiven: false } };
  cfg.qq.owner.groupMember = { [GROUP_ID]: [OWNER_ID] };
  return cfg;
}

// A real `clo model refresh` writes the project's lock file. Tests start from the state before that, so what the
// project has locked cannot change their result.
export function pristineVersionsLock() {
  const lock = JSON.parse(readFileSync(join(ROOT, 'versions.lock.json'), 'utf8').replace(/^\uFEFF/, ''));
  if (lock.models) {
    const { lock: _lock, changes: _changes, ...rest } = lock.models;
    lock.models = rest;
  }
  return lock;
}

// The path has a space on purpose. Scripts and the console must cope.
export function makeRoot(label, config = baseConfig()) {
  const base = mkdtempSync(join(tmpdir(), `clo-cli-${label}-`));
  const root = join(base, 'a b');
  mkdirSync(root, { recursive: true });
  if (config) writeFileSync(join(root, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(join(root, 'versions.lock.json'), `${JSON.stringify(pristineVersionsLock(), null, 2)}\n`);
  writeFileSync(join(root, '.env'), `CLO_QQ_APP_ID=${APP_ID}\nCLO_QQ_APP_SECRET=${FAKE_SECRET}\nCLO_CHAT_API_KEY=${FAKE_KEY}\n`);
  return { root, base, cleanup: () => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) };
}

export function testEnv(root, extra = {}) {
  return {
    CLO_TEST_ROOT: root,
    SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    ...extra,
  };
}

export async function clo(root, argv, { env = {}, fetch, now } = {}) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    env: testEnv(root, env),
    fetch: fetch ?? (() => { throw new Error('this test did not expect a network call'); }),
    now,
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
  });
  return { code, out, err };
}

export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
export const configOf = (root) => readJson(join(root, 'config.json'));
export const dbOf = (root) => join(root, '.runtime', 'clo', 'clo.db');
export const effectiveOf = (root) => readJson(join(root, '.runtime', 'clo', 'effective.json'));
export const openclawOf = (root) => readJson(join(root, '.runtime', 'state', 'openclaw.json'));

export function withDb(root, fn, opts = {}) {
  const store = openStore(dbOf(root), opts);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

const reasoning = { mandatory: true, supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low'], default_effort: 'high' };
const opusPrice = { prompt: '0.000005', completion: '0.00002', input_cache_read: '0.0000005', input_cache_write: '0.00000625' };
const row = (id, created, over = {}) => ({
  id, created, pricing: opusPrice, supported_parameters: ['tools', 'reasoning', 'response_format', 'max_tokens'], reasoning,
  top_provider: { max_completion_tokens: 32000, context_length: 200000 }, ...over,
});
export const catalogRow = row;

export const CATALOG = () => [
  row('anthropic/claude-opus-5', 50),
  row('anthropic/claude-opus-5.5', 100),
  row('~anthropic/claude-opus-latest', 100),
  row('anthropic/claude-opus-5.5:thinking', 100),
  row('anthropic/claude-sonnet-5.5', 110, { pricing: { prompt: '0.000003', completion: '0.000015' } }),
  row('openai/gpt-x', 120),
  row('anthropic/claude-haiku-5.5', 90, {
    pricing: { prompt: '0.000001', completion: '0.000005' },
    supported_parameters: ['response_format', 'reasoning', 'max_tokens'],
    reasoning: { mandatory: false, supported_efforts: ['low', 'medium', 'high'] },
  }),
];

const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// A loopback-shaped provider. Records calls, so a test can prove one did or did not happen.
export function fakeProvider({ catalog = CATALOG(), key = { usage: 0, limit: 3.25, limit_remaining: 3.25, limit_reset: 'daily', usage_daily: 0 } } = {}) {
  const calls = [];
  const state = { catalog, key };
  const fetch = async (url, init) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization ?? null });
    if (String(url).endsWith('/models')) return jsonRes({ data: state.catalog });
    if (String(url).endsWith('/key')) return state.key ? jsonRes({ data: state.key }) : jsonRes({ error: { message: 'no' } }, 401);
    return jsonRes({ error: { message: 'mock: no route' } }, 404);
  };
  return { fetch, calls, state };
}

// Everything `mode live` needs, except the things a test wants to withhold.
export async function readyForLive(root, provider, { d3 = 'test-only decision' } = {}) {
  const cfg = enabledConfig();
  cfg.qq.groups[GROUP_ID].noticeGiven = true;
  cfg.acks = { q0Recorded: true, d3, identityConfirmedAppId: APP_ID };
  writeFileSync(join(root, 'config.json'), `${JSON.stringify(cfg, null, 2)}\n`);
  const r = await clo(root, ['model', 'refresh'], { fetch: provider.fetch });
  if (r.code !== 0) throw new Error(`model refresh failed: ${r.err}${r.out}`);
  markRunning(root);
}

export function markRunning(root, at = Date.now()) {
  withDb(root, (store) => {
    store.setControl('heartbeat_at', at, 'test');
    store.setControl('last_ready_at', at, 'test');
    store.setControl('gateway_key', store.key(FAKE_KEY), 'test');
  });
}
