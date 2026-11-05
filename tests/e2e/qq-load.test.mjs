// TQ10: the pure-ESM SDK loads inside the plugin under the real loader, resolved through plugins.load.paths.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { PLUGIN_DIR, ROOT, startStack, unexpectedNetAttempts, until } from '../harness/gateway.mjs';

let s;

before(async () => {
  s = await startStack({ label: 'load' });
  await until(() => s.event('connection_ready').length > 0 || s.event('connection_error').length > 0, 'SDK connection result');
});

after(async () => {
  await s?.stop();
  s?.cleanup();
});

test('the SDK package is pure ESM, so the check below is meaningful', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'node_modules', '@tencent-connect', 'qqbot-nodejs', 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.exports['.'].require, undefined, 'no require condition: a CommonJS resolver cannot load it');
});

test('the only copy the plugin can resolve is the project root one, found by walking up from the load path', () => {
  assert.equal(existsSync(join(PLUGIN_DIR, 'node_modules')), false);
  assert.equal(existsSync(join(ROOT, '.runtime', 'pkg', 'node_modules', '@tencent-connect')), false);
  assert.equal(existsSync(join(ROOT, 'node_modules', '@tencent-connect', 'qqbot-nodejs', 'dist', 'index.js')), true);
});

test('the Gateway loads the plugin from plugins.load.paths and reports it', () => {
  assert.deepEqual(s.config.plugins.load.paths, [PLUGIN_DIR]);
  assert.ok(s.event('start_account').length > 0, 'our code ran under the host');
  assert.doesNotMatch(s.logs(), /plugin.*(failed|error).*clo/i);
});

test('code from the SDK actually ran in the Gateway process: it fetched a token and identified', () => {
  assert.ok(s.qq.requests.some((r) => r.method === 'POST' && r.path === '/app/getAppAccessToken'));
  assert.equal(s.qq.identifies.length, 1);
  assert.equal(s.qq.identifies[0].intents, 1 << 25);
  assert.ok(s.event('connection_ready').length > 0);
  assert.notEqual(s.event('connection_ready')[0].pid, process.pid, 'it ran in the Gateway, not in the test runner');
});

test('status comes from READY: connected and last_ready_at are set, and the bot name is kept for the console', () => {
  assert.equal(s.control('connected'), 'true');
  assert.ok(Number(s.control('last_ready_at')) > 0);
  assert.equal(s.control('ready_username'), 'mock-bot');
  assert.ok(Number(s.control('heartbeat_at')) > 0);
});

test('no network beyond loopback', () => {
  assert.deepEqual(unexpectedNetAttempts(s.gw), []);
});
