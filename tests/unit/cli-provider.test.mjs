// clo provider, clo ack hard-cap, and the budget and status text for a provider whose Key cannot be read. Offline: no
// test here may reach a network, and no Key may appear in any output. Each refusal has the same command passing in the
// same run as its control.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { digestOf, processInfo } from '../../src/cli/lifecycle.mjs';
import { CONSUMER_LEASE_KEY } from '../../src/clo-plugin/lib/channels/qq/lease.js';
import { shanghaiDay, utcDay } from '../../src/clo-plugin/lib/core/ids.js';
import { ACTIVE_PROVIDER_CONTROL, hardCapControlKey, hardCapPauseKey } from '../../src/clo-plugin/lib/core/providers/registry.js';
import { cleanChildEnv } from '../harness/clean-env.mjs';
import { FAKE_ANTHROPIC_KEY, FAKE_ANTHROPIC_PROBE_KEY } from '../harness/fake-keys.mjs';
import { clo, configOf, dbOf, effectiveOf, enabledConfig, fakeProvider, FAKE_KEY, FAKE_SECRET, GROUP_ID, makeRoot, NET_GUARD, NODE, readJson, withDb, withProviders, writePriceBook } from './_cli-helper.mjs';

const roots = [];
const cleanups = [];
after(() => {
  for (const fn of cleanups) {
    try { fn(); } catch { /* best effort */ }
  }
  roots.forEach((r) => r.cleanup());
});

const RAW = [FAKE_KEY, FAKE_SECRET, FAKE_ANTHROPIC_KEY, FAKE_ANTHROPIC_PROBE_KEY];
const printed = (r) => `${r.out}${r.err}`;
function noKeys(r, what = 'output') {
  for (const raw of RAW) assert.ok(!printed(r).includes(raw), `a Key in the ${what}`);
  assert.doesNotMatch(printed(r), /sk-(ant|or-v1)-/, `a Key-shaped string in the ${what}`);
}
const writeCfg = (root, cfg) => writeFileSync(join(root, 'config.json'), `${JSON.stringify(cfg, null, 2)}\n`);
const lockFile = (root) => join(root, 'versions.lock.json');

// An own-runtime install with both entries, OpenRouter in use, an Anthropic Key in .env, the test price book, and the
// OpenRouter models locked. The Anthropic entry points at loopback, as test mode requires.
async function install(label, { qq = true, anthropicLock = true, runtime = 'own' } = {}) {
  const base = enabledConfig();
  if (!qq) base.qq.enabled = false;
  base.runtime = runtime;
  base.qq.groups[GROUP_ID].noticeGiven = true;
  base.acks = { q0Recorded: true, d3: 'test-only decision', identityConfirmedAppId: base.qq.appId };
  const cfg = withProviders(base, { anthropicBaseUrl: 'http://127.0.0.1:9' });
  const r = makeRoot(label, cfg);
  roots.push(r);
  appendFileSync(join(r.root, '.env'), `CLO_ANTHROPIC_API_KEY=${FAKE_ANTHROPIC_KEY}\n`);
  writePriceBook(r.root);
  const run = (argv, opts = {}) => clo(r.root, argv, opts);
  const refresh = await run(['model', 'refresh'], { fetch: fakeProvider().fetch });
  assert.equal(refresh.code, 0, printed(refresh));
  if (anthropicLock) {
    const locked = await run(['model', 'lock', '--provider', 'anthropic', '--confirm-price']);
    assert.equal(locked.code, 0, printed(locked));
  }
  return { root: r.root, run };
}

function bystander() {
  const child = spawn(NODE, ['-e', 'setInterval(() => {}, 1000)'], { cwd: tmpdir(), env: cleanChildEnv(), stdio: 'ignore', windowsHide: true });
  cleanups.push(() => child.kill());
  return child;
}
const sleep = (ms) => new Promise((res) => { setTimeout(res, ms); });
async function infoOf(pid) {
  for (let i = 0; i < 50; i += 1) {
    const info = processInfo(pid);
    if (info?.commandLine) return info;
    await sleep(100);
  }
  throw new Error('no process info');
}

function insertRow(store, status) {
  const at = Date.now();
  store.q(`INSERT INTO reservations(id, local_day, utc_day, tier, category, held_micros, status, event_key, model, run_gen, created_at, provider)
    VALUES (?, ?, ?, 'addressed', 'reply_required', 180000, ?, NULL, NULL, ?, ?, NULL)`).run(`row-${status}`, shanghaiDay(at), utcDay(at), status, store.runGen, at);
}

test('provider add anthropic: the implicit entry becomes explicit and stays in use; the OpenClaw files do not change', async () => {
  const cfg = enabledConfig();
  const r = makeRoot('add', cfg);
  roots.push(r);
  const run = (argv, opts = {}) => clo(r.root, argv, opts);
  assert.equal((await run(['model', 'refresh'], { fetch: fakeProvider().fetch })).code, 0);
  const openclawBefore = readFileSync(join(r.root, '.runtime', 'state', 'openclaw.json'), 'utf8');
  const listed = await run(['provider', 'list']);
  assert.match(listed.out, /openrouter\topenrouter\t在用（默认/);

  const added = await run(['provider', 'add', 'anthropic']);
  assert.equal(added.code, 0, printed(added));
  const after1 = configOf(r.root);
  assert.deepEqual(Object.keys(after1.providers), ['openrouter', 'anthropic']);
  assert.deepEqual(after1.providers.openrouter, { kind: 'openrouter', keyEnv: 'CLO_CHAT_API_KEY' });
  assert.equal(after1.providers.anthropic.kind, 'anthropic');
  assert.equal(after1.activeProvider, 'openrouter');
  assert.equal(after1.acks.provider.name, 'openrouter');
  // OpenClaw runtime: the effective file and the host config are as before.
  assert.equal(effectiveOf(r.root).apiProvider, undefined);
  assert.equal(readFileSync(join(r.root, '.runtime', 'state', 'openclaw.json'), 'utf8'), openclawBefore, 'openclaw.json unchanged');
  const list2 = await run(['provider', 'list']);
  assert.match(list2.out, /^openrouter\topenrouter\t在用/m);
  assert.match(list2.out, /^anthropic\tanthropic\t未用\t价格未锁定\tKey 读不到（对账不可用）\t硬上限未声明/m);
  noKeys(list2);

  const again = await run(['provider', 'add', 'anthropic']);
  assert.equal(again.code, 1);
  assert.match(again.err, /已经加过/);
  const other = await run(['provider', 'add', 'openai']);
  assert.equal(other.code, 1, 'only anthropic can be added');
  assert.deepEqual(configOf(r.root), after1, 'refusals wrote nothing');
});

test('provider use: refused without --confirm, in live, without a lock, without --qq-platform-notified, on openclaw; then it switches (control)', async () => {
  const s = await install('use', { anthropicLock: false });
  const before = readFileSync(join(s.root, 'config.json'), 'utf8');
  const unchanged = () => assert.equal(readFileSync(join(s.root, 'config.json'), 'utf8'), before, 'config.json unchanged');

  const noConfirm = await s.run(['provider', 'use', 'anthropic', '--qq-platform-notified']);
  assert.equal(noConfirm.code, 1);
  assert.match(noConfirm.err, /算一次模型变更/);
  assert.match(noConfirm.err, /--confirm/);
  unchanged();

  const noLock = await s.run(['provider', 'use', 'anthropic', '--confirm', '--qq-platform-notified']);
  assert.equal(noLock.code, 1);
  assert.match(noLock.err, /clo model lock --provider anthropic/);
  unchanged();
  assert.equal((await s.run(['model', 'lock', '--provider', 'anthropic', '--confirm-price'])).code, 0);
  const beforeLocked = readFileSync(join(s.root, 'config.json'), 'utf8');

  const noNotice = await s.run(['provider', 'use', 'anthropic', '--confirm']);
  assert.equal(noNotice.code, 1);
  assert.match(noNotice.err, /§4\.2/);
  assert.match(noNotice.err, /--qq-platform-notified/);

  const live = configOf(s.root);
  writeCfg(s.root, { ...live, mode: 'live' });
  const inLive = await s.run(['provider', 'use', 'anthropic', '--confirm', '--qq-platform-notified']);
  assert.equal(inLive.code, 1);
  assert.match(inLive.err, /live 下不能换接口/);
  const host = structuredClone(live);
  host.runtime = 'openclaw';
  // An entry's own base is for the own runtime only, so validation would refuse the file before the switch check.
  delete host.providers.anthropic.baseUrl;
  writeCfg(s.root, host);
  const onHost = await s.run(['provider', 'use', 'anthropic', '--confirm', '--qq-platform-notified']);
  assert.equal(onHost.code, 1);
  assert.match(onHost.err, /OpenClaw 运行时只能用 OpenRouter/);
  writeFileSync(join(s.root, 'config.json'), beforeLocked);

  // Control: with every condition met, the switch goes through.
  const ok = await s.run(['provider', 'use', 'anthropic', '--confirm', '--qq-platform-notified']);
  assert.equal(ok.code, 0, printed(ok));
  noKeys(ok);
  const cfg = configOf(s.root);
  assert.equal(cfg.activeProvider, 'anthropic');
  assert.equal(cfg.acks.provider.name, 'anthropic');
  assert.equal(cfg.acks.d3, '', 'the D3 record is cleared (decision D8)');
  assert.equal(cfg.qq.groups[GROUP_ID].noticeGiven, false, 'every group must be told again');
  assert.equal(cfg.acks.q0Recorded, true, 'other acks stay');
  assert.match(ok.out, /重新告知各群/);
  assert.match(ok.out, /clo ack d3/);
  assert.match(ok.out, /已记录：你确认向平台报告了这次模型变更/);
  assert.match(ok.out, /clo ack hard-cap anthropic/);
  assert.doesNotMatch(ok.out, /记录之前 clo mode live 会拒绝/, 'the rules for anthropic are recorded');
  assert.deepEqual(effectiveOf(s.root).apiProvider, { name: 'anthropic', kind: 'anthropic', baseUrl: 'http://127.0.0.1:9', hardCap: null });
  const history = readJson(lockFile(s.root)).models.changes;
  assert.deepEqual(history.at(-1), { ...history.at(-1), kind: 'anthropic', primary: 'claude-opus-5-5', decision: 'claude-haiku-5-5', qqPlatformNotified: true });
  const shown = await s.run(['provider', 'show']);
  assert.match(shown.out, /在用的模型接口：anthropic（anthropic）/);
  assert.match(shown.out, /CLO_ANTHROPIC_API_KEY，已填/);
  assert.match(shown.out, /对账：不可用（本地估算）/);
  noKeys(shown);

  // A second use of the same entry changes nothing.
  const same = await s.run(['provider', 'use', 'anthropic', '--confirm']);
  assert.equal(same.code, 0);
  assert.match(same.out, /已经在用/);
});

test('provider use: refused with a recorded process or an untracked bot; the same switch passes once neither is there (control)', { timeout: 60000 }, async () => {
  const s = await install('use-process');
  const other = bystander();
  const info = await infoOf(other.pid);
  const pidFile = join(s.root, '.runtime', 'pids', 'gateway.json');
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, JSON.stringify({ pid: other.pid, startTime: info.startTime, commandDigest: digestOf(info.commandLine), port: null, runtime: 'own' }));
  const recorded = await s.run(['provider', 'use', 'anthropic', '--confirm', '--qq-platform-notified']);
  assert.equal(recorded.code, 1);
  assert.match(recorded.err, new RegExp(`可洛进程（进程 ${other.pid}）还在运行`));
  assert.equal(configOf(s.root).activeProvider, 'openrouter');

  writeFileSync(pidFile, '{}');
  withDb(s.root, (store) => store.setControl(CONSUMER_LEASE_KEY, `${other.pid}:run`, 'bot'));
  const untracked = await s.run(['provider', 'use', 'anthropic', '--confirm', '--qq-platform-notified']);
  assert.equal(untracked.code, 1);
  assert.match(untracked.err, /PID 文件里没有它/);
  assert.equal(configOf(s.root).activeProvider, 'openrouter');

  withDb(s.root, (store) => store.delControl(CONSUMER_LEASE_KEY));
  const ok = await s.run(['provider', 'use', 'anthropic', '--confirm', '--qq-platform-notified']);
  assert.equal(ok.code, 0, printed(ok));
  assert.equal(configOf(s.root).activeProvider, 'anthropic');
});

test('provider use: refused while paid_paused, the decision breaker or an open row is there; a switch clears the old Key\'s counters (control)', async () => {
  const s = await install('use-ledger');
  // A db with the old provider's read state in it.
  mkdirSync(dirname(dbOf(s.root)), { recursive: true });
  const cases = [
    ['paid_paused', (store) => store.setControl('paid_paused', 'usage_unavailable', 'test'), (store) => store.delControl('paid_paused'), /付费暂停还在/],
    ['decision breaker', (store) => store.setControl('decision_paused', 'open', 'test'), (store) => store.delControl('decision_paused'), /判定熔断还在/],
    ['held row', (store) => insertRow(store, 'held'), (store) => store.q("DELETE FROM reservations WHERE id='row-held'").run(), /预留中或未结算/],
    ['unsettled row', (store) => insertRow(store, 'unsettled'), (store) => store.q("DELETE FROM reservations WHERE id='row-unsettled'").run(), /预留中或未结算/],
  ];
  for (const [what, set, clear, message] of cases) {
    withDb(s.root, set);
    const refused = await s.run(['provider', 'use', 'anthropic', '--confirm', '--qq-platform-notified']);
    assert.equal(refused.code, 1, what);
    assert.match(refused.err, message, what);
    assert.equal(configOf(s.root).activeProvider, 'openrouter', `${what}: nothing switched`);
    withDb(s.root, clear);
  }
  withDb(s.root, (store) => {
    store.setControl('residual_over', '1', 'test');
    store.setControl('credits_probe', String(Date.now()), 'test');
    store.setControl('key_limit_seen', '1', 'test');
    store.bumpCounter('provider_fail_streak', Date.now() + 3600000);
    store.q("INSERT OR REPLACE INTO meta(key, value) VALUES ('key_baseline', '{}')").run();
    // A hard-cap pause never blocks a switch, and survives one.
    store.setControl(hardCapPauseKey('anthropic'), 'hard_cap', 'test');
  });
  const ok = await s.run(['provider', 'use', 'anthropic', '--confirm', '--qq-platform-notified']);
  assert.equal(ok.code, 0, printed(ok));
  withDb(s.root, (store) => {
    for (const k of ['residual_over', 'credits_probe', 'key_limit_seen']) assert.equal(store.getControl(k), null, k);
    assert.equal(store.q("SELECT COUNT(*) AS n FROM counters WHERE key='provider_fail_streak'").get().n, 0);
    assert.equal(store.q("SELECT COUNT(*) AS n FROM meta WHERE key='key_baseline'").get().n, 0);
    assert.equal(store.getControl(hardCapPauseKey('anthropic')), 'hard_cap', 'the hard-cap pause stays with its kind');
  });
  // The way back needs no attestation, with the hard-cap pause still recorded for anthropic.
  const back = await s.run(['provider', 'use', 'openrouter', '--confirm', '--qq-platform-notified']);
  assert.equal(back.code, 0, printed(back));
  assert.equal(configOf(s.root).activeProvider, 'openrouter');
  withDb(s.root, (store) => assert.equal(store.getControl(hardCapPauseKey('anthropic')), 'hard_cap'));
});

test('provider use lifts a pause only a read of the old Key could lift; every other pause still refuses, and a refused reset keeps the pause', async () => {
  const s = await install('use-lifts');
  mkdirSync(dirname(dbOf(s.root)), { recursive: true });
  const use = (name) => s.run(['provider', 'use', name, '--confirm', '--qq-platform-notified']);
  // Nothing but a clean read of the OpenRouter Key lifts these, and clo budget clear-pause leaves them alone.
  for (const reason of ['key_read_failed', 'residual', 'openrouter_key_limit', 'provider_fail']) {
    withDb(s.root, (store) => store.setControl('paid_paused', reason, 'ledger'));
    const clear = await s.run(['budget', 'clear-pause']);
    assert.equal(clear.code, 1, `${reason}: clear-pause leaves it`);
    // A reset that refuses for another reason rolls the lift back with it.
    withDb(s.root, (store) => insertRow(store, 'held'));
    const held = await use('anthropic');
    assert.equal(held.code, 1, reason);
    assert.match(held.err, /预留中或未结算/, reason);
    assert.equal(configOf(s.root).activeProvider, 'openrouter', `${reason}: nothing switched`);
    withDb(s.root, (store) => {
      assert.equal(store.getControl('paid_paused'), reason, `${reason}: the pause stays when the switch is refused`);
      store.q("DELETE FROM reservations WHERE id='row-held'").run();
    });
    const ok = await use('anthropic');
    assert.equal(ok.code, 0, `${reason}: ${printed(ok)}`);
    assert.match(ok.out, new RegExp(`付费暂停 ${reason} .*已一并解除`), reason);
    assert.equal(configOf(s.root).activeProvider, 'anthropic', reason);
    withDb(s.root, (store) => assert.equal(store.getControl('paid_paused'), null, reason));
    noKeys(ok);
    const back = await use('openrouter');
    assert.equal(back.code, 0, printed(back));
    assert.doesNotMatch(back.out, /已一并解除/, 'nothing to lift on the way back');
  }
  // Pauses something else lifts still refuse: an owner command, settlement, or a person topping up.
  for (const reason of ['usage_unavailable', 'openrouter_credits', 'usage_missing']) {
    withDb(s.root, (store) => store.setControl('paid_paused', reason, 'ledger'));
    const refused = await use('anthropic');
    assert.equal(refused.code, 1, reason);
    assert.match(refused.err, /付费暂停还在/, reason);
    withDb(s.root, (store) => {
      assert.equal(store.getControl('paid_paused'), reason, reason);
      store.delControl('paid_paused');
    });
  }
  // Leaving a kind whose Key cannot be read lifts nothing: its pauses are the owner's to clear.
  assert.equal((await use('anthropic')).code, 0);
  withDb(s.root, (store) => store.setControl('paid_paused', 'provider_fail', 'ledger'));
  const fromAnthropic = await use('openrouter');
  assert.equal(fromAnthropic.code, 1);
  assert.match(fromAnthropic.err, /付费暂停还在/);
  assert.equal(configOf(s.root).activeProvider, 'anthropic');
  withDb(s.root, (store) => assert.equal(store.getControl('paid_paused'), 'provider_fail'));
  const cleared = await s.run(['budget', 'clear-pause']);
  assert.equal(cleared.code, 0, printed(cleared));
  assert.equal((await use('openrouter')).code, 0, 'control: once cleared the way back is open');
});

test('a hand-edited activeProvider is refused by apply; the console switch is the only way (control)', async () => {
  const s = await install('hand-edit');
  const cfg = configOf(s.root);
  writeCfg(s.root, { ...cfg, activeProvider: 'anthropic' });
  const applied = await s.run(['apply']);
  assert.equal(applied.code, 1);
  assert.match(applied.err, /acks\.provider/);
  assert.equal(effectiveOf(s.root).apiProvider.kind, 'openrouter', 'the effective file still runs on OpenRouter');
  writeCfg(s.root, cfg);
  assert.equal((await s.run(['apply'])).code, 0, 'control: the unedited config applies');
});

// Decision D8 by hand: editing activeProvider and acks.provider together passes validation, so apply compares the
// config's provider with the one recorded by `clo provider use`. In dry-run, in live, at apply and at start.
test('a hand edit of activeProvider and acks.provider together is refused by apply and start; clo provider use passes (control)', { timeout: 60000 }, async () => {
  const s = await install('hand-edit-both');
  const cfg = configOf(s.root);
  const edited = (name) => ({ ...configOf(s.root), activeProvider: name, acks: { ...configOf(s.root).acks, provider: { name, at: '2000-01-01T00:00:00.000Z' } } });
  const refusal = /不是现在运行的这个（openrouter:openrouter）[\s\S]*clo provider use/;

  writeCfg(s.root, edited('anthropic'));
  const applied = await s.run(['apply']);
  assert.equal(applied.code, 1, printed(applied));
  assert.match(applied.err, refusal);
  noKeys(applied);
  assert.equal(effectiveOf(s.root).apiProvider.kind, 'openrouter', 'the effective file still runs on OpenRouter');
  assert.equal(effectiveOf(s.root).qq.groups[GROUP_ID].noticeGiven, true);
  const started = await s.run(['start'], { env: { CLO_TEST_NODE_IMPORT: NET_GUARD } });
  assert.equal(started.code, 1, printed(started));
  assert.match(started.err, refusal, 'clo start applies first and refuses the same edit');
  // In live: a running live install, the config hand-edited and still live.
  const effFile = join(s.root, '.runtime', 'clo', 'effective.json');
  const effBefore = readFileSync(effFile, 'utf8');
  writeFileSync(effFile, JSON.stringify({ ...JSON.parse(effBefore), mode: 'live' }, null, 2));
  writeCfg(s.root, { ...edited('anthropic'), mode: 'live' });
  const inLive = await s.run(['apply']);
  assert.equal(inLive.code, 1, printed(inLive));
  assert.match(inLive.err, refusal, 'live is refused the same way');
  writeFileSync(effFile, effBefore);

  // Control: the unedited config applies, and the console switch goes through and records the new provider.
  writeCfg(s.root, cfg);
  assert.equal((await s.run(['apply'])).code, 0, 'control: the unedited config applies');
  const used = await s.run(['provider', 'use', 'anthropic', '--confirm', '--qq-platform-notified']);
  assert.equal(used.code, 0, printed(used));
  withDb(s.root, (store) => assert.equal(store.getControl(ACTIVE_PROVIDER_CONTROL), 'anthropic:anthropic'));
  assert.equal(configOf(s.root).qq.groups[GROUP_ID].noticeGiven, false);
  assert.equal((await s.run(['apply'])).code, 0, 'control: apply accepts the provider the switch recorded');

  // The way back by hand is refused too, against the recorded provider; the console way back passes.
  writeCfg(s.root, edited('openrouter'));
  const back = await s.run(['apply']);
  assert.equal(back.code, 1, printed(back));
  assert.match(back.err, /不是现在运行的这个（anthropic:anthropic）/);
  assert.equal(effectiveOf(s.root).apiProvider.kind, 'anthropic');
  writeCfg(s.root, edited('anthropic'));
  const home = await s.run(['provider', 'use', 'openrouter', '--confirm', '--qq-platform-notified']);
  assert.equal(home.code, 0, printed(home));
  withDb(s.root, (store) => assert.equal(store.getControl(ACTIVE_PROVIDER_CONTROL), 'openrouter:openrouter'));
  assert.equal(effectiveOf(s.root).apiProvider.kind, 'openrouter');
});

test('ack hard-cap: each refusal, then the D2 pair in dry-run with no process binds the Key fingerprint and lifts the hard-cap pause', { timeout: 60000 }, async () => {
  const s = await install('hardcap');
  const args = (...extra) => ['ack', 'hard-cap', 'anthropic', '--kind', 'workspace_monthly', '--usd', '20', '--prepaid-no-reload', ...extra];
  const refusals = [
    [['ack', 'hard-cap', 'anthropic', '--kind', 'prepaid_no_reload', '--usd', '20', '--prepaid-no-reload'], /只接受这一种/],
    [['ack', 'hard-cap', 'anthropic', '--kind', 'workspace_monthly', '--usd', '20'], /prepaid_no_reload/],
    [['ack', 'hard-cap', 'anthropic', '--kind', 'workspace_monthly', '--usd', '0', '--prepaid-no-reload'], /usd/],
    [['ack', 'hard-cap', 'anthropic', '--kind', 'workspace_monthly', '--prepaid-no-reload'], /usd/],
    [['ack', 'hard-cap', 'openrouter', '--kind', 'workspace_monthly', '--usd', '20', '--prepaid-no-reload'], /每日限额/],
    [['ack', 'hard-cap', 'anthropic', '--kind', 'workspace_monthly', '--usd', '200', '--prepaid-no-reload'], /31 倍/],
    [['ack', 'hard-cap', 'nobody', '--kind', 'workspace_monthly', '--usd', '20', '--prepaid-no-reload'], /没有叫 nobody/],
  ];
  for (const [argv, message] of refusals) {
    const r = await s.run(argv);
    assert.equal(r.code, 1, argv.join(' '));
    assert.match(r.err, message, argv.join(' '));
    noKeys(r);
  }
  const cfg = configOf(s.root);
  assert.equal(cfg.acks.hardCap, undefined, 'no refusal wrote an ack');

  writeCfg(s.root, { ...cfg, mode: 'live' });
  const live = await s.run(args());
  assert.equal(live.code, 1);
  assert.match(live.err, /live 下不能声明/);
  writeCfg(s.root, cfg);

  const other = bystander();
  await infoOf(other.pid);
  withDb(s.root, (store) => store.setControl(CONSUMER_LEASE_KEY, `${other.pid}:run`, 'bot'));
  const running = await s.run(args());
  assert.equal(running.code, 1);
  assert.match(running.err, /启动时的 Key/);
  withDb(s.root, (store) => store.delControl(CONSUMER_LEASE_KEY));

  const envFile = join(s.root, '.env');
  const env = readFileSync(envFile, 'utf8');
  writeFileSync(envFile, env.replace(/^CLO_ANTHROPIC_API_KEY=.*$/m, ''));
  const noKey = await s.run(args());
  assert.equal(noKey.code, 1);
  assert.match(noKey.err, /\.env 里没有 CLO_ANTHROPIC_API_KEY/);
  writeFileSync(envFile, env);
  assert.equal(configOf(s.root).acks.hardCap, undefined);

  withDb(s.root, (store) => store.setControl(hardCapPauseKey('anthropic'), 'hard_cap', 'test'));
  const ok = await s.run(args());
  assert.equal(ok.code, 0, printed(ok));
  noKeys(ok);
  assert.match(ok.out, /只靠你本人的声明/);
  assert.match(ok.out, /最多可能花到 \$20/);
  const ack = configOf(s.root).acks.hardCap.anthropic;
  assert.deepEqual({ ...ack, at: 'x' }, { kind: 'workspace_monthly', usd: 20, prepaidNoReload: true, at: 'x' });
  withDb(s.root, (store) => {
    assert.equal(store.getControl(hardCapControlKey('anthropic')), store.key(FAKE_ANTHROPIC_KEY), 'bound to the .env Key');
    assert.notEqual(store.getControl(hardCapControlKey('anthropic')), store.key(FAKE_ANTHROPIC_PROBE_KEY));
    assert.equal(store.getControl(hardCapPauseKey('anthropic')), null, 'the ack lifts the hard-cap pause');
  });
  const high = await s.run(['ack', 'hard-cap', 'anthropic', '--kind', 'workspace_monthly', '--usd', '200', '--prepaid-no-reload', '--confirm']);
  assert.equal(high.code, 0, 'control: --confirm takes a cap above 31 days of budget');
  // The log holds no Key and no fingerprint.
  const log = readFileSync(join(s.root, '.runtime', 'logs', 'events.jsonl'), 'utf8');
  withDb(s.root, (store) => assert.ok(!log.includes(store.key(FAKE_ANTHROPIC_KEY)), 'a fingerprint in the log'));
  for (const raw of RAW) assert.ok(!log.includes(raw), 'a Key in the log');
});

test('budget clear-pause clears provider_fail only where no Key read can; accept-unsettled settles what nothing else will', async () => {
  const s = await install('budget');
  mkdirSync(dirname(dbOf(s.root)), { recursive: true });
  // OpenRouter in use: a Key read lifts provider_fail, so the owner cannot.
  withDb(s.root, (store) => store.setControl('paid_paused', 'provider_fail', 'ledger'));
  const onOpenRouter = await s.run(['budget', 'clear-pause']);
  assert.equal(onOpenRouter.code, 1);
  assert.match(onOpenRouter.out, /会由 Key 读取或结算解除/);
  withDb(s.root, (store) => assert.equal(store.getControl('paid_paused'), 'provider_fail'));
  const shownOr = await s.run(['budget', 'show']);
  assert.doesNotMatch(shownOr.out, /对账：不可用/);
  assert.match(shownOr.out, /OpenRouter 账单/);

  withDb(s.root, (store) => store.delControl('paid_paused'));
  assert.equal((await s.run(['provider', 'use', 'anthropic', '--confirm', '--qq-platform-notified'])).code, 0);
  withDb(s.root, (store) => store.setControl('paid_paused', 'provider_fail', 'ledger'));
  const onAnthropic = await s.run(['budget', 'clear-pause']);
  assert.equal(onAnthropic.code, 0, printed(onAnthropic));
  assert.match(onAnthropic.out, /下一次主模型调用失败会立刻再暂停/);
  withDb(s.root, (store) => assert.equal(store.getControl('paid_paused'), null));
  for (const reason of ['anthropic_credits', 'anthropic_spend_limit', 'anthropic_permission', 'anthropic_price_unexpected']) {
    withDb(s.root, (store) => store.setControl('paid_paused', reason, 'ledger'));
    const r = await s.run(['budget', 'clear-pause']);
    assert.equal(r.code, 0, reason);
    withDb(s.root, (store) => assert.equal(store.getControl('paid_paused'), null, reason));
  }

  withDb(s.root, (store) => insertRow(store, 'unsettled'));
  const shown = await s.run(['budget', 'show']);
  assert.match(shown.out, /对账：不可用（本地估算）/);
  assert.match(shown.out, /供应商 读不到/);
  assert.match(shown.out, /未结算：1 笔/);
  const accepted = await s.run(['budget', 'accept-unsettled']);
  assert.equal(accepted.code, 0);
  assert.match(accepted.out, /已按预留额结清 1 笔/);
  withDb(s.root, (store) => assert.equal(store.q("SELECT status FROM reservations WHERE id='row-unsettled'").get().status, 'settled'));

  // The hard-cap pause is named, and neither budget command lifts it.
  withDb(s.root, (store) => store.setControl(hardCapPauseKey('anthropic'), 'hard_cap', 'ledger'));
  const none = await s.run(['budget', 'clear-pause']);
  assert.match(none.out, /硬上限未核实/);
  withDb(s.root, (store) => assert.equal(store.getControl(hardCapPauseKey('anthropic')), 'hard_cap'));
});

test('status names the provider, says reconciliation is unavailable where it is, and shows the hard-cap pause', async () => {
  // Implicit OpenRouter: no provider line at all, as before.
  const plain = makeRoot('status-plain', enabledConfig());
  roots.push(plain);
  const plainOut = (await clo(plain.root, ['status'])).out;
  assert.doesNotMatch(plainOut, /模型接口|对账/);

  const s = await install('status');
  const onOr = (await s.run(['status'])).out;
  assert.match(onOr, /模型接口：openrouter（openrouter）/);
  assert.doesNotMatch(onOr, /对账：不可用/, 'OpenRouter reads its Key');
  assert.equal((await s.run(['provider', 'use', 'anthropic', '--confirm', '--qq-platform-notified'])).code, 0);
  const onAn = await s.run(['status']);
  assert.match(onAn.out, /模型接口：anthropic（anthropic）/);
  assert.match(onAn.out, /对账：不可用（本地估算）/);
  assert.doesNotMatch(onAn.out, /硬上限未核实/);
  withDb(s.root, (store) => store.setControl(hardCapPauseKey('anthropic'), 'hard_cap', 'ledger'));
  const paused = await s.run(['status']);
  assert.match(paused.out, /硬上限未核实：anthropic 的付费工作已暂停（hard_cap）/);
  const json = JSON.parse((await s.run(['status', '--json'])).out);
  assert.deepEqual(json.provider, { name: 'anthropic', kind: 'anthropic', implicit: false, keyReadable: false, hardCapPaused: 'hard_cap' });
  noKeys(paused);
  noKeys(onAn);
  assert.equal(existsSync(join(s.root, '.runtime', 'pids', 'gateway.json')), false);
});
