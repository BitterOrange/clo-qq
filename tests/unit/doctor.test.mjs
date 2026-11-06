// Doctor: each check must fail on its own bad state, with the clean state as the control in the same run.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { makeContext } from '../../src/cli/common.mjs';
import { CONFIG_LEVEL, formatDoctor, FULL_LEVEL, inspectHooks, runDoctor } from '../../src/cli/doctor.mjs';
import { ensureGatewayEnvClean, gatewayEnv, gatewayEnvForCheck } from '../../src/cli/lifecycle.mjs';
import { APP_ID, baseConfig, clo, enabledConfig, fakeProvider, FAKE_KEY, FAKE_SECRET, GROUP_ID, makeRoot, NET_GUARD, openclawOf, OWNER_ID, ROOT, testEnv } from './_cli-helper.mjs';

const roots = [];
async function prepared(label, cfg = enabledConfig()) {
  const r = makeRoot(label, cfg);
  roots.push(r);
  const res = await clo(r.root, ['model', 'refresh'], { fetch: fakeProvider().fetch });
  assert.equal(res.code, 0, res.err);
  return r.root;
}
after(() => roots.forEach((r) => r.cleanup()));

const ctxOf = (root, env = {}) => makeContext({ env: testEnv(root, { CLO_TEST_NODE_IMPORT: NET_GUARD, ...env }), fetch: () => { throw new Error('no network'); }, stdout: { write() {} }, stderr: { write() {} } });
const doctor = (root, opts = {}, env = {}) => runDoctor(ctxOf(root, env), { level: CONFIG_LEVEL, ...opts });
const failedIds = (report) => report.failed;
const statePath = (root) => join(root, '.runtime', 'state', 'openclaw.json');
function editOpenclaw(root, fn) {
  const o = openclawOf(root);
  fn(o);
  writeFileSync(statePath(root), JSON.stringify(o, null, 2));
}

test('a freshly applied install passes every config check (the control for this file)', async () => {
  const root = await prepared('clean');
  const report = doctor(root);
  assert.deepEqual(report.failed, [], formatDoctor(report));
  assert.equal(report.ok, true);
});

// One render edit per doctor rule. Each also fails render_fresh, which is intended: nothing hand-edited may pass.
const RENDER_CASES = [
  ['conversation_access', 'allowConversationAccess removed', (o) => { delete o.plugins.entries.clo.hooks; }],
  ['conversation_access', 'allowConversationAccess false', (o) => { o.plugins.entries.clo.hooks.allowConversationAccess = false; }],
  ['skip_bootstrap', 'skipBootstrap false', (o) => { o.agents.defaults.skipBootstrap = false; }],
  ['context_injection', 'defaults never', (o) => { o.agents.defaults.contextInjection = 'never'; }],
  ['context_injection', 'defaults continuation-skip', (o) => { o.agents.defaults.contextInjection = 'continuation-skip'; }],
  ['context_injection', 'agents.entries override', (o) => { o.agents.entries = { main: { contextInjection: 'never' } }; }],
  ['context_injection', 'agents.list override', (o) => { o.agents.list = [{ id: 'main', contextInjection: 'continuation-skip' }]; }],
  ['bootstrap_limits', 'bootstrapMaxChars too small', (o) => { o.agents.defaults.bootstrapMaxChars = 100; }],
  ['bootstrap_limits', 'per-agent override too small', (o) => { o.agents.entries = { main: { bootstrapMaxChars: 100 } }; }],
  ['bootstrap_limits', 'total too small', (o) => { o.agents.defaults.bootstrapTotalMaxChars = 200; }],
  ['node_turn', 'node worker runs on', (o) => { o.nodeHost = { workerRuns: { enabled: true } }; }],
  ['tools_policy', 'allow empty', (o) => { o.tools.allow = []; }],
  ['tools_policy', 'toolSearch on', (o) => { o.tools.toolSearch = true; }],
  ['tools_policy', 'group:* denied', (o) => { o.tools.deny.push('group:*'); }],
  ['tools_policy', 'message not denied', (o) => { o.tools.deny = o.tools.deny.filter((d) => d !== 'message'); }],
  ['silent_reply', 'silentReply missing', (o) => { delete o.agents.defaults.silentReply; }],
  ['dm_scope', 'dmScope default', (o) => { delete o.session.dmScope; }],
  ['no_fallback_model', 'fallback set', (o) => { o.agents.defaults.model.fallbacks = ['openrouter/openai/gpt-x']; }],
  ['forbidden_plugins', 'official plugin allowed', (o) => { o.plugins.allow.push('openclaw-qqbot'); }],
  ['forbidden_plugins', 'wechat plugin entry', (o) => { o.plugins.entries['agent-wechat'] = { enabled: true }; }],
  ['proxy_config', 'proxy key', (o) => { o.gateway.proxy = 'http://x'; }],
];

for (const [id, what, edit] of RENDER_CASES) {
  test(`doctor ${id}: ${what}`, async () => {
    const root = await prepared(`r-${id}`);
    editOpenclaw(root, edit);
    const report = doctor(root);
    assert.ok(failedIds(report).includes(id), formatDoctor(report));
    assert.ok(failedIds(report).includes('render_fresh'));
  });
}

test('doctor catches an edited workspace: policy section, persona and system prompt', async () => {
  const root = await prepared('workspace');
  const agents = join(root, '.runtime', 'workspace', 'AGENTS.md');
  const soul = join(root, '.runtime', 'workspace', 'SOUL.md');
  const prompt = join(root, '.runtime', 'clo', 'system-prompt.md');
  const original = readFileSync(agents, 'utf8');

  writeFileSync(agents, original.replace('## 内容范围', '## 内容范围（已改）'));
  assert.ok(failedIds(doctor(root)).includes('policy_section'), 'one edited policy line');

  writeFileSync(agents, original.replace('<!-- clo-policy-end:1 -->', ''));
  assert.ok(failedIds(doctor(root)).includes('policy_section'), 'truncated, no end marker');
  writeFileSync(agents, original);
  assert.deepEqual(failedIds(doctor(root)), [], 'restored');

  writeFileSync(soul, 'changed');
  assert.ok(failedIds(doctor(root)).includes('persona_hashes'));
  await clo(root, ['apply']);

  writeFileSync(prompt, 'no markers here');
  assert.ok(failedIds(doctor(root)).includes('persona_hashes'));
  await clo(root, ['apply']);

  writeFileSync(join(root, '.runtime', 'workspace', 'BOOTSTRAP.md'), 'x');
  assert.ok(failedIds(doctor(root)).includes('persona_hashes'));
});

test('doctor catches a mismatch in effective mode, versions, the DB and the lists', async () => {
  const root = await prepared('misc');

  const effective = join(root, '.runtime', 'clo', 'effective.json');
  const e = JSON.parse(readFileSync(effective, 'utf8'));
  writeFileSync(effective, JSON.stringify({ ...e, mode: 'live' }));
  assert.ok(failedIds(doctor(root)).includes('effective_mode'));
  await clo(root, ['apply']);

  const lockFile = join(root, 'versions.lock.json');
  const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
  const good = JSON.stringify(lock);
  lock.npm.openclaw.version = '2026.1.1';
  writeFileSync(lockFile, JSON.stringify(lock));
  assert.ok(failedIds(doctor(root)).includes('lock_versions'), 'package version');
  const lock2 = JSON.parse(good);
  lock2.node.version = '20.0.0';
  writeFileSync(lockFile, JSON.stringify(lock2));
  assert.ok(failedIds(doctor(root)).includes('lock_versions'), 'node version');
  const lock3 = JSON.parse(good);
  lock3.npm['@tencent-connect/qqbot-nodejs'].integrity = 'sha512-wrong';
  writeFileSync(lockFile, JSON.stringify(lock3));
  assert.ok(failedIds(doctor(root)).includes('lock_versions'), 'integrity');
  writeFileSync(lockFile, good);

  const { DatabaseSync } = await import('node:sqlite');
  mkdirSync(join(root, '.runtime', 'clo'), { recursive: true });
  const db = new DatabaseSync(join(root, '.runtime', 'clo', 'clo.db'));
  db.exec('PRAGMA user_version=99');
  db.close();
  assert.ok(failedIds(doctor(root)).includes('db_version'));
});

test('a config with DM or search on fails config_valid', async () => {
  const root = await prepared('dmsearch');
  const file = join(root, 'config.json');
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  const bad = structuredClone(cfg);
  bad.qq.allowedDmUserIds = ['SOMEONE'];
  writeFileSync(file, JSON.stringify(bad));
  const r1 = doctor(root);
  assert.ok(failedIds(r1).includes('config_valid'), formatDoctor(r1));
  assert.ok(failedIds(r1).includes('dm_closed'), formatDoctor(r1));
  const bad2 = structuredClone(cfg);
  bad2.searchProvider = 'perplexity';
  writeFileSync(file, JSON.stringify(bad2));
  const r2 = doctor(root);
  assert.ok(failedIds(r2).includes('search_off'), formatDoctor(r2));
});

test('a live config with no D3 fails doctor', async () => {
  const root = await prepared('liveD3');
  const file = join(root, 'config.json');
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  cfg.mode = 'live';
  writeFileSync(file, JSON.stringify(cfg));
  assert.ok(failedIds(doctor(root)).includes('live_gate'));
});

test('forbidden packages and extension folders are found', async () => {
  const root = await prepared('forbidden');
  const fakeRoots = makeRoot('forbidden-tree', null);
  roots.push(fakeRoots);
  const tree = join(fakeRoots.root, 'tree');
  const plant = join(tree, 'node_modules', '@tencent-connect', 'openclaw-qqbot');
  mkdirSync(plant, { recursive: true });
  assert.ok(failedIds(doctor(root, { packageRoots: [tree] })).includes('forbidden_plugins'), 'official plugin in node_modules');
  assert.ok(!failedIds(doctor(root)).includes('forbidden_plugins'), 'the real trees are clean (control)');
  mkdirSync(join(root, '.runtime', 'state', 'extensions', 'agent-wechat'), { recursive: true });
  assert.ok(failedIds(doctor(root)).includes('forbidden_plugins'), 'extension folder');
});

test('proxy variables in the shell only warn, because the Gateway env is an allowlist', async () => {
  const root = await prepared('proxyenv');
  const report = doctor(root, {}, { HTTP_PROXY: 'http://127.0.0.1:1', PERPLEXITY_API_KEY: 'x', OPENROUTER_API_KEY: 'PARENT', CLO_CHAT_API_KEY: 'PARENT', CLO_SEARCH_API_KEY: 'PARENT' });
  assert.deepEqual(report.failed, [], formatDoctor(report));
  const warning = report.checks.find((c) => c.id === 'parent_proxy');
  assert.equal(warning.ok, false);
  assert.equal(warning.severity, 'warn');
  assert.ok(!formatDoctor(report).includes('http://127.0.0.1:1'), 'the value is not printed');

  const ctx = ctxOf(root, { HTTP_PROXY: 'http://127.0.0.1:1', https_proxy: 'x', PERPLEXITY_API_KEY: 'x', OPENROUTER_API_KEY: 'PARENT', CLO_CHAT_API_KEY: 'PARENT', CLO_SEARCH_API_KEY: 'PARENT' });
  const child = gatewayEnv(ctx.paths, ctx.env);
  assert.deepEqual(ensureGatewayEnvClean(child), []);
  for (const k of ['OPENROUTER_API_KEY', 'CLO_CHAT_API_KEY', 'CLO_SEARCH_API_KEY']) assert.equal(child[k], undefined, k);
  assert.deepEqual(ensureGatewayEnvClean({ HTTP_PROXY: 'x', https_proxy: 'x', PERPLEXITY_API_KEY: 'x', PATH: 'x' }).sort(), ['HTTP_PROXY', 'PERPLEXITY_API_KEY', 'https_proxy'], 'the detector works (control)');
  assert.deepEqual(ensureGatewayEnvClean({ CLO_CHAT_API_KEY: 'x', CLO_SEARCH_API_KEY: 'x', CLO_SEARCH_OPENROUTER_KEY: 'x', CLO_TEST_API_KEY: 'x', OPENROUTER_API_KEY: 'x' }).sort(), ['CLO_CHAT_API_KEY', 'CLO_SEARCH_API_KEY', 'CLO_SEARCH_OPENROUTER_KEY', 'CLO_TEST_API_KEY'], 'the file names are forbidden, the host name is not');
  const checked = gatewayEnvForCheck(ctx.paths, ctx.env);
  assert.equal(checked.OPENROUTER_API_KEY, 'check-only', 'the check sees the key under the name start would give it, with no real value');
  assert.deepEqual(ensureGatewayEnvClean(checked), [], 'and that name is clean');
  assert.ok(!Object.values(checked).includes('PARENT'), 'nothing from the parent');
});

test('the full level asks the host about hooks, and each bad answer fails', async () => {
  const root = await prepared('hooks');
  const good = { plugin: { status: 'loaded' }, typedHooks: [{ name: 'before_agent_run' }, { name: 'before_prompt_build' }, { name: 'before_tool_call' }], policy: { allowConversationAccess: true } };
  const answer = (obj, status = 0) => () => ({ status, stdout: JSON.stringify(obj) });
  const ctx = ctxOf(root);
  assert.equal(inspectHooks(ctx, { run: answer(good) }).ok, true);
  for (const [what, bad, status] of [
    ['no before_agent_run', { ...good, typedHooks: good.typedHooks.slice(1) }, 0],
    ['policy off', { ...good, policy: { allowConversationAccess: false } }, 0],
    ['not loaded', { ...good, plugin: { status: 'error' } }, 0],
    ['exit code', good, 1],
  ]) {
    assert.equal(inspectHooks(ctx, { run: answer(bad, status) }).ok, false, what);
  }
  assert.equal(inspectHooks(ctx, { run: () => ({ status: 0, stdout: 'not json' }) }).ok, false);

  const full = runDoctor(ctx, { level: FULL_LEVEL, run: answer(good) });
  assert.deepEqual(full.failed, [], formatDoctor(full));
  assert.ok(full.checks.some((c) => c.id === 'hook_registered' && c.ok));
  assert.ok(failedIds(runDoctor(ctx, { level: FULL_LEVEL, run: answer({ ...good, typedHooks: [] }) })).includes('hook_registered'));
});

test('the full level checks .env by key name and prints no value', async () => {
  const root = await prepared('envfile');
  const answer = () => ({ status: 0, stdout: JSON.stringify({ plugin: { status: 'loaded' }, typedHooks: [{ name: 'before_agent_run' }, { name: 'before_prompt_build' }, { name: 'before_tool_call' }], policy: { allowConversationAccess: true } }) });
  const ctx = ctxOf(root);
  const report = runDoctor(ctx, { level: FULL_LEVEL, run: answer });
  assert.ok(report.checks.some((c) => c.id === 'env_file' && c.ok));
  const text = formatDoctor(report);
  for (const raw of [FAKE_KEY, FAKE_SECRET, APP_ID, GROUP_ID, OWNER_ID]) assert.ok(!text.includes(raw), 'leak');
  writeFileSync(join(root, '.env'), `CLO_QQ_APP_ID=${APP_ID}\n`);
  const missing = runDoctor(ctx, { level: FULL_LEVEL, run: answer });
  assert.ok(failedIds(missing).includes('env_file'));
  assert.match(formatDoctor(missing), /CLO_QQ_APP_SECRET/);
});

test('live: a .env with only the old key name fails doctor, names the new one and prints no value', async () => {
  const root = await prepared('oldkey');
  const answer = () => ({ status: 0, stdout: JSON.stringify({ plugin: { status: 'loaded' }, typedHooks: [{ name: 'before_agent_run' }, { name: 'before_prompt_build' }, { name: 'before_tool_call' }], policy: { allowConversationAccess: true } }) });
  const old = 'sk-or-v1-OLD-NAME-VALUE-MUST-NOT-BE-USED';
  const cfgFile = join(root, 'config.json');
  const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
  writeFileSync(cfgFile, JSON.stringify({ ...cfg, mode: 'live' }));
  writeFileSync(join(root, '.env'), `CLO_QQ_APP_ID=${APP_ID}\nCLO_QQ_APP_SECRET=${FAKE_SECRET}\nOPENROUTER_API_KEY=${old}\n`);
  const ctx = ctxOf(root, { OPENROUTER_API_KEY: old, CLO_CHAT_API_KEY: old });
  const live = runDoctor(ctx, { level: FULL_LEVEL, run: answer });
  assert.ok(failedIds(live).includes('env_file'), 'a key in the shell does not count');
  const text = formatDoctor(live);
  assert.match(text, /env_file：.*缺少：CLO_CHAT_API_KEY/);
  assert.match(text, /OPENROUTER_API_KEY 已不再读取，请把这一行改名为 CLO_CHAT_API_KEY/);
  assert.ok(!text.includes(old), 'printed the value');

  // Dry-run needs no key, so the old line is only a warning there.
  writeFileSync(cfgFile, JSON.stringify(cfg));
  const dry = runDoctor(ctx, { level: FULL_LEVEL, run: answer });
  assert.ok(!failedIds(dry).includes('env_file'), formatDoctor(dry));
  const warned = dry.checks.find((c) => c.id === 'env_old_names');
  assert.equal(warned.ok, false);
  assert.equal(warned.severity, 'warn');
  assert.match(warned.detail, /CLO_CHAT_API_KEY/);
  assert.ok(!formatDoctor(dry).includes(old));

  writeFileSync(join(root, '.env'), `CLO_QQ_APP_ID=${APP_ID}\nCLO_QQ_APP_SECRET=${FAKE_SECRET}\nCLO_CHAT_API_KEY=${FAKE_KEY}\n`);
  assert.equal(runDoctor(ctx, { level: FULL_LEVEL, run: answer }).checks.find((c) => c.id === 'env_old_names').ok, true, 'positive control');
});

test('both names in .env: doctor says delete the old line, and reports a duplicate if it was renamed anyway', async () => {
  const root = await prepared('bothkeys');
  const answer = () => ({ status: 0, stdout: JSON.stringify({ plugin: { status: 'loaded' }, typedHooks: [{ name: 'before_agent_run' }, { name: 'before_prompt_build' }, { name: 'before_tool_call' }], policy: { allowConversationAccess: true } }) });
  const old = 'sk-or-v1-OLD-NAME-VALUE-MUST-NOT-BE-USED';
  const ctx = ctxOf(root);
  const check = (id) => runDoctor(ctx, { level: FULL_LEVEL, run: answer }).checks.find((c) => c.id === id);
  const base = `CLO_QQ_APP_ID=${APP_ID}\nCLO_QQ_APP_SECRET=${FAKE_SECRET}\n`;

  writeFileSync(join(root, '.env'), `${base}CLO_CHAT_API_KEY=${FAKE_KEY}\nOPENROUTER_API_KEY=${old}\n`);
  const warned = check('env_old_names');
  assert.equal(warned.ok, false);
  assert.equal(warned.severity, 'warn');
  assert.match(warned.detail, /可以删掉这一行/);
  assert.doesNotMatch(warned.detail, /请把这一行改名/);
  assert.equal(check('env_duplicates').ok, true, 'no name is on two lines yet');

  writeFileSync(join(root, '.env'), `${base}CLO_CHAT_API_KEY=${FAKE_KEY}\nCLO_CHAT_API_KEY=${old}\n`);
  assert.equal(check('env_old_names').ok, true);
  const dup = check('env_duplicates');
  assert.equal(dup.ok, false);
  assert.equal(dup.severity, 'warn');
  assert.match(dup.detail, /CLO_CHAT_API_KEY 写了不止一行/);
  const text = formatDoctor(runDoctor(ctx, { level: FULL_LEVEL, run: answer }));
  assert.ok(!text.includes(old) && !text.includes(FAKE_KEY), 'printed a value');

  writeFileSync(join(root, '.env'), `${base}CLO_CHAT_API_KEY=${FAKE_KEY}\n`);
  assert.equal(check('env_duplicates').ok, true, 'positive control');
});

test('doctor is read only: it creates no database, and writes nothing', async () => {
  const r = makeRoot('readonly', baseConfig());
  roots.push(r);
  await clo(r.root, ['apply']);
  const db = join(r.root, '.runtime', 'clo', 'clo.db');
  assert.equal(existsSync(db), false);
  const report = doctor(r.root);
  assert.equal(existsSync(db), false);
  assert.ok(report.checks.some((c) => c.id === 'db_version' && c.ok));
});

test('the console doctor command exits non-zero on failure', async () => {
  const root = await prepared('exit');
  const pass = await clo(root, ['doctor', '--config-only']);
  assert.equal(pass.code, 0, pass.out);
  editOpenclaw(root, (o) => { delete o.plugins.entries.clo.hooks; });
  const fail = await clo(root, ['doctor', '--config-only']);
  assert.equal(fail.code, 1);
  assert.match(fail.out, /conversation_access/);
});

// TQ27 on the real host. Needs the plugin's real hooks, so it only proves anything once the CHANNEL files are in.
test('real host: with allowConversationAccess the hooks are registered; without it they are blocked', { timeout: 300000 }, async () => {
  const root = await prepared('realhost');
  const ctx = ctxOf(root);
  const withAccess = inspectHooks(ctx, { run: spawnSync });
  assert.equal(withAccess.ok, true, withAccess.detail);

  editOpenclaw(root, (o) => { delete o.plugins.entries.clo.hooks; });
  const without = inspectHooks(ctx, { run: spawnSync });
  assert.equal(without.ok, false, 'hooks must not count as registered without access');
  assert.match(without.detail, /before_agent_run|allowConversationAccess/);
  assert.ok(failedIds(runDoctor(ctx, { level: CONFIG_LEVEL })).includes('conversation_access'));
});

test('the project files doctor reads are there', () => {
  for (const p of ['CLAUDE.md', 'tests/fixtures/claude-md-7x.sha256', 'persona/CONTENT-POLICY.md', '.gitignore']) assert.ok(existsSync(join(ROOT, p)), p);
});

// --- The own runtime: no host config, and its own checks. ---

const HOST_ONLY = ['openclaw_json', 'conversation_access', 'skip_bootstrap', 'context_injection', 'bootstrap_limits', 'node_turn', 'tools_policy', 'silent_reply', 'dm_scope', 'no_fallback_model', 'policy_section', 'persona_hashes', 'render_fresh', 'gateway_env', 'proxy_config', 'hook_registered'];
const OWN_ONLY = ['system_prompt', 'bot_env', 'bot_entry', 'bot_no_listen'];

async function preparedOwn(label) {
  const root = await prepared(label, { ...enabledConfig(), runtime: 'own' });
  const entry = join(root, 'bot', 'main.mjs');
  mkdirSync(join(root, 'bot'), { recursive: true });
  writeFileSync(entry, '// stand-in entry\n');
  return { root, env: { CLO_TEST_BOT_ENTRY: entry }, entry };
}
const ids = (report) => report.checks.map((c) => c.id);

test('own: a fresh install passes with no openclaw.json, runs none of the host checks and all of its own', async () => {
  const { root, env } = await preparedOwn('own-clean');
  assert.equal(existsSync(statePath(root)), false, 'apply wrote no host config');
  const report = doctor(root, {}, env);
  assert.deepEqual(report.failed, [], formatDoctor(report));
  assert.equal(report.runtime, 'own');
  for (const id of HOST_ONLY) assert.ok(!ids(report).includes(id), id);
  for (const id of [...OWN_ONLY, 'effective_runtime', 'lock_versions', 'private_node', 'claude_md_baseline', 'forbidden_plugins', 'dm_closed', 'search_off', 'db_version', 'live_gate']) assert.ok(ids(report).includes(id), id);

  // Positive control: the same install switched to openclaw needs the host config it does not have.
  const cfgFile = join(root, 'config.json');
  writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(readFileSync(cfgFile, 'utf8')), runtime: 'openclaw' }));
  const host = doctor(root, {}, env);
  assert.ok(failedIds(host).includes('openclaw_json'), formatDoctor(host));
  assert.ok(failedIds(host).includes('effective_runtime'), 'effective.json still says own');
  for (const id of OWN_ONLY) assert.ok(!ids(host).includes(id), id);
});

test('own: the system prompt is checked whole, by its policy section and by its markers', async () => {
  const { root, env } = await preparedOwn('own-prompt');
  const prompt = join(root, '.runtime', 'clo', 'system-prompt.md');
  const original = readFileSync(prompt, 'utf8');
  assert.deepEqual(failedIds(doctor(root, {}, env)), [], 'control');
  writeFileSync(prompt, original.replace('## 内容范围', '## 内容范围（已改）'));
  assert.ok(failedIds(doctor(root, {}, env)).includes('system_prompt'), 'one edited policy line');
  writeFileSync(prompt, original.replace('<!-- clo-policy-end:1 -->', ''));
  assert.ok(failedIds(doctor(root, {}, env)).includes('system_prompt'), 'no end marker');
  writeFileSync(prompt, 'no markers here');
  assert.ok(failedIds(doctor(root, {}, env)).includes('system_prompt'), 'nothing left');
  assert.equal((await clo(root, ['apply'])).code, 0);
  assert.deepEqual(failedIds(doctor(root, {}, env)), [], 'apply restores it');
});

test('own: a missing entry, a listening bot file and a stale effective runtime each fail', async () => {
  const { root, env, entry } = await preparedOwn('own-entry');
  assert.deepEqual(failedIds(doctor(root, {}, env)), [], 'control');
  const missing = doctor(root, {}, { CLO_TEST_BOT_ENTRY: join(root, 'nowhere', 'main.mjs') });
  assert.ok(failedIds(missing).includes('bot_entry'), formatDoctor(missing));

  writeFileSync(join(dirname(entry), 'side.mjs'), "import { createServer } from 'node:http';\ncreateServer(() => {}).listen(0);\n");
  const listens = doctor(root, {}, env);
  assert.ok(failedIds(listens).includes('bot_no_listen'), formatDoctor(listens));
  assert.match(formatDoctor(listens), /side\.mjs/);
  writeFileSync(join(dirname(entry), 'side.mjs'), "// connects out only: sock.connect(443, 'example.invalid')\n");
  assert.deepEqual(failedIds(doctor(root, {}, env)), [], 'a file that only connects out passes');

  const effective = join(root, '.runtime', 'clo', 'effective.json');
  writeFileSync(effective, JSON.stringify({ ...JSON.parse(readFileSync(effective, 'utf8')), runtime: 'openclaw' }));
  assert.ok(failedIds(doctor(root, {}, env)).includes('effective_runtime'));
});

test('own: lock_versions still checks the Node and the SDK, and no longer the host packages', async () => {
  const { root, env } = await preparedOwn('own-lock');
  const lockFile = join(root, 'versions.lock.json');
  const good = readFileSync(lockFile, 'utf8');
  const hostOff = JSON.parse(good);
  hostOff.npm.openclaw.version = '2026.1.1';
  writeFileSync(lockFile, JSON.stringify(hostOff));
  assert.ok(!failedIds(doctor(root, {}, env)).includes('lock_versions'), 'the host package is not needed');
  const cfgFile = join(root, 'config.json');
  const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
  writeFileSync(cfgFile, JSON.stringify({ ...cfg, runtime: 'openclaw' }));
  assert.ok(failedIds(doctor(root, {}, env)).includes('lock_versions'), 'positive control: under openclaw it is');
  writeFileSync(cfgFile, JSON.stringify(cfg));
  const nodeOff = JSON.parse(good);
  nodeOff.node.version = '20.0.0';
  writeFileSync(lockFile, JSON.stringify(nodeOff));
  assert.ok(failedIds(doctor(root, {}, env)).includes('lock_versions'), 'node');
  const sdkOff = JSON.parse(good);
  sdkOff.npm['@tencent-connect/qqbot-nodejs'].integrity = 'sha512-wrong';
  writeFileSync(lockFile, JSON.stringify(sdkOff));
  assert.ok(failedIds(doctor(root, {}, env)).includes('lock_versions'), 'sdk');
});

test('own: the full level never asks a host, and still checks .env', async () => {
  const { root, env } = await preparedOwn('own-full');
  let asked = 0;
  const run = () => { asked += 1; return { status: 1, stdout: '' }; };
  const report = runDoctor(ctxOf(root, env), { level: FULL_LEVEL, run });
  assert.deepEqual(report.failed, [], formatDoctor(report));
  assert.equal(asked, 0);
  assert.ok(report.checks.some((c) => c.id === 'env_file' && c.ok));
  const cfgFile = join(root, 'config.json');
  writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(readFileSync(cfgFile, 'utf8')), runtime: 'openclaw' }));
  assert.equal((await clo(root, ['apply'])).code, 0);
  runDoctor(ctxOf(root, env), { level: FULL_LEVEL, run });
  assert.equal(asked, 1, 'positive control: under openclaw the host is asked');
});
