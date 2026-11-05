// Runs the real `openclaw config validate --json` on our render, offline, in a temp directory.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildEffective } from '../../src/clo-plugin/lib/core/config.js';
import { renderOpenclaw } from '../../src/clo-plugin/lib/core/render.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const NODE = join(ROOT, '.runtime', 'node', 'node.exe');
const OPENCLAW = join(ROOT, '.runtime', 'pkg', 'node_modules', 'openclaw', 'openclaw.mjs');
const NET_GUARD = join(ROOT, 'tests', 'harness', 'net-guard.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'clo-render-validate-'));
after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const sample = JSON.parse(readFileSync(join(HERE, '..', 'fixtures', 'render', 'config.sample.json'), 'utf8'));
const PRICE = { inputPerM: 5, outputPerM: 20, cacheReadPerM: 0.5, cacheWritePerM: 6.25 };
const LOCK = { primary: { id: 'anthropic/claude-opus-5.5', selector: 'opus-latest', price: PRICE }, decision: { id: 'anthropic/claude-haiku-5.5', price: { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, cacheWritePerM: 1.25 } } };

function childEnv(dir) {
  const keep = {};
  for (const k of ['SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS']) {
    if (process.env[k]) keep[k] = process.env[k];
  }
  return {
    ...keep,
    PATH: `${dirname(NODE)};${process.env.SystemRoot ?? 'C:\\Windows'}\\System32`,
    HOME: join(dir, 'home'),
    USERPROFILE: join(dir, 'home'),
    APPDATA: join(dir, 'appdata', 'Roaming'),
    LOCALAPPDATA: join(dir, 'appdata', 'Local'),
    TEMP: join(dir, 'temp'),
    TMP: join(dir, 'temp'),
    OPENCLAW_HOME: join(dir, 'home'),
    OPENCLAW_STATE_DIR: join(dir, 'state'),
    OPENCLAW_CONFIG_PATH: join(dir, 'state', 'openclaw.json'),
    OPENCLAW_WORKSPACE_DIR: join(dir, 'workspace'),
    OPENCLAW_GATEWAY_TOKEN: 'FAKE-GATEWAY-TOKEN-FOR-LOCAL-MOCK-ONLY',
    OPENCLAW_NO_AUTO_UPDATE: '1',
    OPENCLAW_DISABLE_BONJOUR: '1',
    OPENCLAW_OFFLINE: '1',
    OPENROUTER_API_KEY: 'sk-or-v1-FAKE-KEY-FOR-LOCAL-MOCK-ONLY',
    CLO_QQ_APP_SECRET: 'FAKE-QQ-SECRET-FOR-LOCAL-MOCK-ONLY',
    CLO_NET_GUARD_LOG: join(dir, 'net-guard.jsonl'),
    NODE_NO_WARNINGS: '1',
  };
}

function validate(label, config) {
  const dir = join(tmp, label);
  for (const d of ['home', 'state', 'workspace', 'temp', 'appdata/Roaming', 'appdata/Local']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'state', 'openclaw.json'), JSON.stringify(config, null, 2));
  const r = spawnSync(NODE, [`--import=${pathToFileURL(NET_GUARD).href}`, OPENCLAW, 'config', 'validate', '--json'], {
    cwd: dir, env: childEnv(dir), encoding: 'utf8', timeout: 180000, windowsHide: true,
  });
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    // Reported by the caller through status and stderr.
  }
  return { status: r.status, parsed, stdout: r.stdout, stderr: r.stderr, dir };
}

function renderAll(cfg, label, { testMode = false } = {}) {
  const dir = join(tmp, label);
  const paths = { repoRoot: ROOT, workspace: join(dir, 'workspace'), effectiveJson: join(dir, 'effective.json'), db: join(dir, 'clo.db'), eventLog: join(dir, 'events.jsonl'), systemPromptFile: join(dir, 'system.md') };
  const env = testMode ? { CLO_TEST_ROOT: dir } : {};
  const effective = buildEffective(cfg, { paths, modelsLock: LOCK, env });
  return renderOpenclaw(cfg, effective, paths, { testMode });
}

const describeFailure = (r) => `status ${r.status}\n${(r.stdout ?? '').slice(0, 3000)}\n${(r.stderr ?? '').slice(0, 3000)}`;

test('host validator rejects a broken config (positive control for the checks below)', { timeout: 200000 }, () => {
  const bad = renderAll(sample, 'control');
  bad.agents.defaults.notARealKey = true;
  const r = validate('control', bad);
  assert.notEqual(r.status, 0, describeFailure(r));
  assert.equal(r.parsed?.valid, false, describeFailure(r));
});

test('host validator accepts the real-provider render', { timeout: 200000 }, () => {
  const r = validate('real', renderAll(sample, 'real'));
  assert.equal(r.status, 0, describeFailure(r));
  assert.equal(r.parsed?.valid, true, describeFailure(r));
});

test('host validator accepts the test-mode render', { timeout: 200000 }, () => {
  const cfg = structuredClone(sample);
  cfg.openrouter = { baseUrl: 'http://127.0.0.1:9/v1' };
  cfg.qq.apiBaseUrl = 'http://127.0.0.1:9';
  cfg.qq.tokenBaseUrl = 'http://127.0.0.1:9';
  const r = validate('testmode', renderAll(cfg, 'testmode', { testMode: true }));
  assert.equal(r.status, 0, describeFailure(r));
  assert.equal(r.parsed?.valid, true, describeFailure(r));
});

test('host validator accepts the render with QQ off and no account', { timeout: 200000 }, () => {
  const cfg = structuredClone(sample);
  cfg.qq.enabled = false;
  const rendered = renderAll(cfg, 'qqoff');
  assert.deepEqual(rendered.channels, {});
  const r = validate('qqoff', rendered);
  assert.equal(r.status, 0, describeFailure(r));
});

test('the validator run made no outbound connection', () => {
  for (const label of ['control', 'real', 'testmode', 'qqoff']) {
    const log = join(tmp, label, 'net-guard.jsonl');
    if (!existsSync(log)) continue;
    const hosts = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(hosts.filter((h) => !/clawhub\.ai/.test(JSON.stringify(h))), [], `unexpected network use in ${label}`);
  }
});
