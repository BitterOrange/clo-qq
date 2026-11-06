// Modes, live preconditions, pause, status, targets, budget, policy. In-process, temp root, fake provider.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { processInfo } from '../../src/cli/lifecycle.mjs';
import { createEffectiveReader, validateBusinessConfig } from '../../src/clo-plugin/lib/core/config.js';
import { createLedger } from '../../src/clo-plugin/lib/core/ledger.js';
import { APP_ID, baseConfig, clo, configOf, dbOf, effectiveOf, enabledConfig, fakeProvider, FAKE_KEY, FAKE_SECRET, GROUP_ID, makeRoot, markRunning, OWNER_ID, readJson, readyForLive, ROOT, withDb } from './_cli-helper.mjs';

const roots = [];
const root = (label, cfg) => {
  const r = makeRoot(label, cfg);
  roots.push(r);
  return r.root;
};
after(() => roots.forEach((r) => r.cleanup()));

test('config.example.json is valid, dry-run and fully closed', () => {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config.example.json'), 'utf8'));
  assert.deepEqual(validateBusinessConfig(cfg, { env: {} }).errors, []);
  assert.equal(cfg.mode, 'dry-run');
  assert.equal(cfg.qq.enabled, false);
  assert.deepEqual(cfg.qq.allowedGroupIds, []);
  assert.deepEqual(cfg.qq.allowedDmUserIds, []);
  assert.deepEqual(cfg.qq.groups, {});
  assert.equal(cfg.searchProvider, 'none');
  assert.equal(cfg.acks.d3, '', 'D3 ships unrecorded');
});

test('.env.example holds placeholders only, under the current names', () => {
  const text = readFileSync(join(ROOT, '.env.example'), 'utf8');
  const names = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    assert.match(line, /^[A-Z_]+=$/, 'a value in .env.example');
    names.push(line.slice(0, -1));
  }
  assert.deepEqual(names, ['CLO_QQ_APP_ID', 'CLO_QQ_APP_SECRET', 'CLO_CHAT_API_KEY', 'CLO_SEARCH_API_KEY', 'CLO_TEST_API_KEY']);
  assert.match(text, /only with OpenRouter/);
  assert.match(text, /OpenAI-compatible endpoints are not\s+(# )?supported yet/);
  assert.match(text, /Nothing reads it/);
});

test('config.example.json has the example Key limit', () => {
  assert.equal(JSON.parse(readFileSync(join(ROOT, 'config.example.json'), 'utf8')).budget.keyDailyLimitUsd, 1.6);
});

test('apply generates every file, and a second apply leaves openclaw.json untouched', async () => {
  const r = root('apply');
  const first = await clo(r, ['apply']);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /有变化/);
  for (const p of ['.runtime/clo/effective.json', '.runtime/state/openclaw.json', '.runtime/workspace/AGENTS.md', '.runtime/workspace/SOUL.md', '.runtime/workspace/IDENTITY.md', '.runtime/clo/system-prompt.md', '.runtime/temp']) {
    assert.ok(existsSync(join(r, p)), p);
  }
  const second = await clo(r, ['apply']);
  assert.match(second.out, /没有变化/);
  assert.equal(effectiveOf(r).mode, 'dry-run');
});

test('a missing config gives directions and no stack trace', async () => {
  const r = makeRoot('noconfig', null);
  roots.push(r);
  const out = await clo(r.root, ['apply']);
  assert.equal(out.code, 1);
  assert.match(out.err, /config\.example\.json/);
});

test('unknown commands: usage and a non-zero exit; prototype names are not commands', async () => {
  const r = root('usage');
  assert.equal((await clo(r, ['nope'])).code, 2);
  assert.equal((await clo(r, ['constructor'])).code, 2);
  assert.equal((await clo(r, [])).code, 0);
});

test('live is refused while D3 is unrecorded, and OpenRouter is not contacted', async () => {
  const r = root('d3');
  const provider = fakeProvider();
  await readyForLive(r, provider, { d3: '' });
  const before = provider.calls.length;
  const res = await clo(r, ['mode', 'live'], { fetch: provider.fetch });
  assert.equal(res.code, 1);
  assert.match(res.out, /d3：/);
  assert.equal(configOf(r).mode, 'dry-run', 'config unchanged');
  assert.equal(effectiveOf(r).mode, 'dry-run', 'effective unchanged');
  assert.equal(provider.calls.length, before, 'no provider call before D3 is recorded');
});

test('with every precondition met, mode live succeeds; the same provider is contacted (control for the test above)', async () => {
  const r = root('live');
  const provider = fakeProvider();
  await readyForLive(r, provider);
  withDb(r, (store) => {
    store.armDiscovery(Date.now() + 60000);
    store.recordDiscovery({ groupId: 'RAWGROUPTOBEWIPED', memberId: 'RAWMEMBERTOBEWIPED' });
  });
  const res = await clo(r, ['mode', 'live'], { fetch: provider.fetch });
  assert.equal(res.code, 0, `${res.out}${res.err}`);
  assert.equal(configOf(r).mode, 'live');
  assert.equal(effectiveOf(r).mode, 'live');
  const keyCalls = provider.calls.filter((c) => c.url.endsWith('/key'));
  assert.ok(keyCalls.length >= 1);
  assert.equal(keyCalls[0].auth, `Bearer ${FAKE_KEY}`, 'the key comes from the temp .env');
  assert.deepEqual(withDb(r, (s) => s.listDiscovery()), [], 'any mode live wipes discovery');
  assert.ok(!res.out.includes(FAKE_KEY));

  const again = await clo(r, ['apply']);
  assert.equal(again.code, 0, 'apply keeps an already-live install live');
  assert.equal((await clo(r, ['mode', 'dry-run'])).code, 0);
  assert.equal(configOf(r).mode, 'dry-run');
  assert.equal(effectiveOf(r).mode, 'dry-run');
});

test('each live precondition refuses on its own', async () => {
  const cases = {
    identity: (cfg) => { cfg.acks.identityConfirmedAppId = 'OTHER'; },
    q0: (cfg) => { cfg.acks.q0Recorded = false; },
    notice: (cfg) => { cfg.qq.groups[GROUP_ID].noticeGiven = false; },
    policy: (cfg) => { cfg.contentPolicy.enabled = false; },
  };
  for (const [code, mutate] of Object.entries(cases)) {
    const r = root(`pre-${code}`);
    const provider = fakeProvider();
    await readyForLive(r, provider);
    const cfg = configOf(r);
    mutate(cfg);
    writeFileSync(join(r, 'config.json'), JSON.stringify(cfg));
    const res = await clo(r, ['mode', 'live'], { fetch: provider.fetch });
    assert.equal(res.code, 1, code);
    assert.deepEqual([...res.out.matchAll(/^ {2}(\w+)：/gm)].map((m) => m[1]), [code]);
    assert.equal(configOf(r).mode, 'dry-run');
  }
});

test('live is refused while doctor fails, and config-level doctor runs on a fresh render', async () => {
  const r = root('doctorfail');
  const provider = fakeProvider();
  await readyForLive(r, provider);
  const file = join(r, 'versions.lock.json');
  const lock = readJson(file);
  lock.npm.openclaw.version = '2026.1.1';
  writeFileSync(file, JSON.stringify(lock));
  const res = await clo(r, ['mode', 'live'], { fetch: provider.fetch });
  assert.equal(res.code, 1);
  assert.match(res.out, /doctor：/);
  assert.equal(configOf(r).mode, 'dry-run');
});

test('live is refused on a key with no daily limit, a failed key read, a stale heartbeat, or a paid pause', async () => {
  const noLimit = root('nolimit');
  let p = fakeProvider({ key: { usage: 0, limit: null, limit_remaining: null, limit_reset: null, usage_daily: 0 } });
  await readyForLive(noLimit, p);
  assert.match((await clo(noLimit, ['mode', 'live'], { fetch: p.fetch })).out, /key_readable：/);

  const badKey = root('badkey');
  p = fakeProvider();
  await readyForLive(badKey, p);
  p.state.key = null;
  const bad = await clo(badKey, ['mode', 'live'], { fetch: p.fetch });
  assert.equal(bad.code, 1);
  assert.match(bad.out, /key_readable：/);
  assert.doesNotMatch(bad.out, /key_readable：[^\n]*\.env/, 'the file has the key, so the hint does not blame the file');
  assert.match(bad.out, /reconciled：/);

  const stale = root('stale');
  p = fakeProvider();
  await readyForLive(stale, p);
  markRunning(stale, Date.now() - 91000);
  assert.match((await clo(stale, ['mode', 'live'], { fetch: p.fetch })).out, /heartbeat：/);

  const paused = root('paidpause');
  p = fakeProvider();
  await readyForLive(paused, p);
  // usage_unavailable never clears on a clean read, unlike the reconcile-settled reasons.
  withDb(paused, (s) => s.setControl('paid_paused', 'usage_unavailable', 'test'));
  assert.match((await clo(paused, ['mode', 'live'], { fetch: p.fetch })).out, /no_paid_pause：/);
});

test('live without a locked model is refused', async () => {
  const r = root('nolock');
  const provider = fakeProvider();
  await readyForLive(r, provider);
  const lockFile = join(r, 'versions.lock.json');
  const lock = readJson(lockFile);
  delete lock.models.lock;
  writeFileSync(lockFile, JSON.stringify(lock));
  const res = await clo(r, ['mode', 'live'], { fetch: provider.fetch });
  assert.equal(res.code, 1);
  assert.match(res.out, /models：/);
});

test('hand-editing config.json to live does not turn it live, and start refuses it too', async () => {
  const r = root('handedit');
  const provider = fakeProvider();
  await readyForLive(r, provider);
  const cfg = configOf(r);
  cfg.mode = 'live';
  writeFileSync(join(r, 'config.json'), JSON.stringify(cfg));
  const res = await clo(r, ['apply']);
  assert.equal(res.code, 1);
  assert.match(res.err, /clo mode live/);
  assert.equal(effectiveOf(r).mode, 'dry-run');
  const start = await clo(r, ['start'], { env: { CLO_TEST_NODE_IMPORT: join(ROOT, 'tests', 'harness', 'net-guard.mjs') } });
  assert.equal(start.code, 1);
  assert.match(start.err, /clo mode live/);
});

test('pause and resume: global, per group by key, interject', async () => {
  const r = root('pause', enabledConfig());
  assert.equal((await clo(r, ['pause', '--all'])).code, 0);
  assert.equal(withDb(r, (s) => s.pauseState(null)).global, true);
  assert.equal((await clo(r, ['resume', '--all'])).code, 0);
  assert.equal(withDb(r, (s) => s.pauseState(null)).global, false);

  assert.equal((await clo(r, ['pause'])).code, 0, 'no flag means all');
  assert.equal(withDb(r, (s) => s.pauseState(null)).global, true);
  await clo(r, ['resume']);

  assert.equal((await clo(r, ['pause', '--group', '测试群'])).code, 0);
  const paused = withDb(r, (s) => s.pauseState(s.key(GROUP_ID)));
  assert.equal(paused.group, true);
  assert.equal(paused.global, false);
  const raw = withDb(r, (s) => s.q('SELECT key FROM control').all().map((x) => x.key).join());
  assert.ok(!raw.includes(GROUP_ID), 'the control row holds a key, not the raw id');
  assert.equal((await clo(r, ['resume', '--group', '测试群'])).code, 0);
  assert.equal(withDb(r, (s) => s.pauseState(s.key(GROUP_ID))).group, false);

  withDb(r, (s) => s.setControl('interject_paused', 'violation', 'test'));
  await clo(r, ['resume', '--interject']);
  assert.equal(withDb(r, (s) => s.pauseState(null)).interject, false);

  const unknown = await clo(r, ['pause', '--group', '不存在']);
  assert.equal(unknown.code, 1);
  assert.equal((await clo(r, ['pause', '--all', '--group', '测试群'])).code, 1);
});

test('status masks every ID and prints no secret, in text and JSON', async () => {
  const r = root('status', enabledConfig());
  await clo(r, ['apply']);
  withDb(r, (s) => {
    s.addAlert('terminal', { closeCode: 4914 });
    s.setControl('terminal_close', '4914', 'test');
    s.setControl('paid_paused', 'usage_missing', 'test');
  });
  for (const args of [['status'], ['status', '--json']]) {
    const res = await clo(r, args);
    assert.equal(res.code, 0, res.err);
    for (const raw of [APP_ID, GROUP_ID, OWNER_ID, FAKE_KEY, FAKE_SECRET]) assert.ok(!res.out.includes(raw), `leak in ${args}`);
  }
  const text = (await clo(r, ['status'])).out;
  assert.match(text, /模式：dry-run/);
  assert.match(text, /测试群/);
  assert.match(text, /D3：未记录/);
  assert.match(text, /付费 usage_missing/);
  assert.match(text, /关闭码 4914/);
  assert.match(text, /告警 #1/);
  assert.match(text, /判定存活：否/);
});

test('status still reports liveness when config.json is broken', async () => {
  const r = root('badcfg');
  writeFileSync(join(r, 'config.json'), '{ not json');
  const res = await clo(r, ['status']);
  assert.equal(res.code, 0, res.err);
  assert.match(res.out, /读不了/);
  assert.match(res.out, /Gateway：没有 PID 文件/);
});

test('status --ack clears the listed alerts; ack terminal clears the latch', async () => {
  const r = root('ack', enabledConfig());
  await clo(r, ['apply']);
  withDb(r, (s) => {
    s.addAlert('x', {});
    s.setControl('terminal_close', '4915', 'test');
  });
  await clo(r, ['status', '--ack']);
  assert.equal(withDb(r, (s) => s.statusSnapshot().alerts.length), 0);
  const res = await clo(r, ['ack', 'terminal']);
  assert.match(res.out, /4915/);
  assert.equal(withDb(r, (s) => s.pauseState(null).terminal), null);
});

test('ack records exactly what it says', async () => {
  const r = root('acks', enabledConfig());
  assert.equal((await clo(r, ['ack', 'd3'])).code, 1, 'D3 needs a value');
  assert.equal(configOf(r).acks.d3, '');
  assert.equal((await clo(r, ['ack', 'd3', '   '])).code, 1, 'D3 cannot be blank');
  assert.equal(configOf(r).acks.d3, '');
  await clo(r, ['ack', 'd3', 'a：问过客服后继续']);
  assert.equal(configOf(r).acks.d3, 'a：问过客服后继续');
  const id = await clo(r, ['ack', 'identity']);
  assert.equal(configOf(r).acks.identityConfirmedAppId, APP_ID);
  assert.ok(!id.out.includes(APP_ID), 'masked');
  await clo(r, ['ack', 'q0']);
  assert.equal(configOf(r).acks.q0Recorded, true);
  assert.equal((await clo(r, ['ack', 'nope'])).code, 1);
});

test('targets: dry-run only, 15 minutes at most, masked unless asked, and clear wipes', async () => {
  const r = root('targets', enabledConfig());
  await clo(r, ['apply']);
  assert.equal((await clo(r, ['targets', 'arm', '--minutes', '16'])).code, 1);
  assert.equal((await clo(r, ['targets', 'arm', '--minutes', 'x'])).code, 1);
  assert.equal((await clo(r, ['targets', 'arm', '--minutes', '5'])).code, 0);
  assert.ok(withDb(r, (s) => s.recordDiscovery({ groupId: GROUP_ID, memberId: OWNER_ID })));
  const masked = await clo(r, ['targets', 'list']);
  assert.ok(!masked.out.includes(GROUP_ID));
  assert.ok(!masked.out.includes(OWNER_ID));
  const shown = await clo(r, ['targets', 'list', '--reveal']);
  assert.ok(shown.out.includes(GROUP_ID));
  assert.ok(shown.out.includes(OWNER_ID));
  await clo(r, ['targets', 'clear']);
  assert.deepEqual(withDb(r, (s) => s.listDiscovery()), []);
  assert.equal(withDb(r, (s) => s.getControl('discovery_until')), null);

  const cfg = configOf(r);
  cfg.mode = 'live';
  cfg.acks.d3 = 'x';
  writeFileSync(join(r, 'config.json'), JSON.stringify(cfg));
  assert.equal((await clo(r, ['targets', 'arm', '--minutes', '5'])).code, 1, 'never in live');
});

test('budget show and accept-unsettled', async () => {
  const r = root('budget', enabledConfig());
  const provider = fakeProvider();
  await clo(r, ['model', 'refresh'], { fetch: provider.fetch });
  withDb(r, (s) => {
    s.setControl('paid_paused', 'crash_unsettled', 'test');
    s.q(`INSERT INTO reservations(id, local_day, utc_day, tier, category, held_micros, status, run_gen, created_at)
         VALUES ('r1', '2026-11-03', '2026-11-03', 'addressed', 'reply', 360000, 'unsettled', 'g', 1)`).run();
  });
  const show = await clo(r, ['budget', 'show'], { now: () => Date.parse('2026-11-03T04:00:00Z') });
  assert.match(show.out, /未结算：1 笔/);
  assert.match(show.out, /\$0\.3600/);
  const accept = await clo(r, ['budget', 'accept-unsettled']);
  assert.match(accept.out, /1 笔/);
  assert.equal(withDb(r, (s) => s.getControl('paid_paused')), null);
  assert.equal(withDb(r, (s) => s.q("SELECT status, source FROM reservations WHERE id='r1'").get()).source, 'manual');
});

test('budget clear-pause lifts what only the owner can lift, says so in status, and leaves the rest', async () => {
  const r = root('clearpause', enabledConfig());
  const provider = fakeProvider();
  await clo(r, ['model', 'refresh'], { fetch: provider.fetch });
  const none = await clo(r, ['budget', 'clear-pause']);
  assert.equal(none.code, 0);
  assert.match(none.out, /没有付费暂停/);

  for (const reason of ['usage_unavailable', 'openrouter_credits']) {
    withDb(r, (s) => s.setControl('paid_paused', reason, 'test'));
    assert.match((await clo(r, ['status'])).out, new RegExp(`${reason}：.*clo budget clear-pause`), 'status names the way out');
    const res = await clo(r, ['budget', 'clear-pause']);
    assert.equal(res.code, 0, reason);
    assert.ok(res.out.includes(reason));
    assert.equal(withDb(r, (s) => s.getControl('paid_paused')), null, reason);
  }

  withDb(r, (s) => s.setControl('paid_paused', 'openrouter_key_limit', 'test'));
  const refused = await clo(r, ['budget', 'clear-pause']);
  assert.equal(refused.code, 1);
  assert.equal(withDb(r, (s) => s.getControl('paid_paused')), 'openrouter_key_limit');
});

test('policy test names rules and line numbers and never echoes the text', async () => {
  const r = root('policy');
  const hits = readFileSync(join(ROOT, 'tests', 'fixtures', 'policy-hit.zh.txt'), 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t'));
  const [ruleId, hitText] = hits[0];
  const file = join(r, 'sample.txt');
  writeFileSync(file, `今天天气不错\n${hitText}\n`);
  const res = await clo(r, ['policy', 'test', file]);
  assert.equal(res.code, 1);
  assert.match(res.out, new RegExp(`第 2 行：命中 ${ruleId}`));
  assert.ok(!res.out.includes(hitText), 'never echoes');
  writeFileSync(file, '今天天气不错\n');
  assert.equal((await clo(r, ['policy', 'test', file])).code, 0, 'clean text passes (control)');
});

test('policy rule disable records the reason and takes effect; the shipped file is not touched', async () => {
  const shipped = readFileSync(join(ROOT, 'policy', 'rules.json'), 'utf8');
  const rules = JSON.parse(shipped);
  const r = root('ruledisable');
  const copy = join(r, 'rules.json');
  writeFileSync(copy, shipped);
  const cfg = baseConfig();
  cfg.contentPolicy.outputFilter.rulesFile = copy;
  writeFileSync(join(r, 'config.json'), JSON.stringify(cfg));

  const hits = readFileSync(join(ROOT, 'tests', 'fixtures', 'policy-hit.zh.txt'), 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t'));
  const id = rules.rules.find((x) => x.status === 'active').id;
  const text = hits.find(([rid]) => rid === id)[1];
  const sample = join(r, 'one.txt');
  writeFileSync(sample, `${text}\n`);
  assert.equal((await clo(r, ['policy', 'test', sample])).code, 1, 'hits before');

  assert.equal((await clo(r, ['policy', 'rule', 'disable', id])).code, 1, 'needs a reason');
  assert.equal((await clo(r, ['policy', 'rule', 'disable', 'no.such', '--reason', 'x'])).code, 1);
  assert.equal((await clo(r, ['policy', 'rule', 'disable', id, '--reason', '误拦了正常回答'])).code, 0);
  const after_ = readJson(copy).rules.find((x) => x.id === id);
  assert.equal(after_.status, 'disabled');
  assert.equal(after_.disabledReason, '误拦了正常回答');
  assert.equal(after_.disabledBy, 'cli');
  assert.equal((await clo(r, ['policy', 'test', sample])).code, 0, 'no longer hits');
  assert.equal(readFileSync(join(ROOT, 'policy', 'rules.json'), 'utf8'), shipped);
});

test('policy hash reports the block and the workspace section', async () => {
  const r = root('hash');
  await clo(r, ['apply']);
  const res = await clo(r, ['policy', 'hash']);
  assert.equal(res.code, 0);
  assert.match(res.out, /f0ed566dc5f7b4e0b0c84111faf24d32f59c40cd8871ef0ba7bd23b938b70048/);
  assert.match(res.out, /一致/);
});

test('the console never reads the shell environment for a key', async () => {
  const r = root('shellkey');
  const provider = fakeProvider();
  await readyForLive(r, provider);
  await clo(r, ['mode', 'live'], { fetch: provider.fetch, env: { OPENROUTER_API_KEY: 'SHELL-KEY-MUST-NOT-BE-USED', CLO_CHAT_API_KEY: 'SHELL-KEY-MUST-NOT-BE-USED' } });
  assert.ok(provider.calls.some((c) => c.auth === `Bearer ${FAKE_KEY}`), 'used the file');
  assert.ok(!provider.calls.some((c) => String(c.auth).includes('SHELL-KEY')));
});

test('live is refused on a .env with only the old key name: no OpenRouter call with it, and the new name in the hint', async () => {
  const r = root('oldname');
  const provider = fakeProvider();
  await readyForLive(r, provider);
  const old = 'sk-or-v1-OLD-NAME-VALUE-MUST-NOT-BE-USED';
  writeFileSync(join(r, '.env'), `CLO_QQ_APP_ID=${APP_ID}\nCLO_QQ_APP_SECRET=${FAKE_SECRET}\nOPENROUTER_API_KEY=${old}\n`);
  const res = await clo(r, ['mode', 'live'], { fetch: provider.fetch, env: { OPENROUTER_API_KEY: old, CLO_CHAT_API_KEY: old } });
  assert.equal(res.code, 1);
  assert.match(res.out, /key_readable：\.env 里没有 CLO_CHAT_API_KEY/);
  assert.match(res.out, /gateway_key：.*CLO_CHAT_API_KEY/);
  assert.match(res.out, /OPENROUTER_API_KEY 已不再读取，请把这一行改名为 CLO_CHAT_API_KEY/);
  assert.ok(!`${res.out}${res.err}`.includes(old), 'printed the value');
  assert.ok(!provider.calls.some((c) => String(c.auth).includes(old)), 'sent the old value');
  assert.equal(configOf(r).mode, 'dry-run');
});

test('while live, apply refuses a hand-edited group with no notice, and blank acks; dry-run and live is the way in', async () => {
  const s = makeRoot('liveapply');
  const provider = fakeProvider();
  try {
    await readyForLive(s.root, provider);
    assert.equal((await clo(s.root, ['mode', 'live'], { fetch: provider.fetch })).code, 0);
    assert.equal((await clo(s.root, ['apply'], { fetch: provider.fetch })).code, 0, 'positive control: a clean config applies');

    const good = configOf(s.root);
    const edited = configOf(s.root);
    edited.qq.groups.NEWGROUPNOTICEFALSE00 = { label: '新群', interject: true, nameMention: true, noticeGiven: false };
    edited.qq.allowedGroupIds.push('NEWGROUPNOTICEFALSE00');
    edited.qq.owner.groupMember.NEWGROUPNOTICEFALSE00 = ['SOMEOWNER000000'];
    writeFileSync(join(s.root, 'config.json'), JSON.stringify(edited));
    const refused = await clo(s.root, ['apply'], { fetch: provider.fetch });
    assert.equal(refused.code, 1);
    assert.match(refused.err, /notice/);
    assert.match(refused.err, /clo mode dry-run/);
    assert.ok(!Object.hasOwn(effectiveOf(s.root).qq.groups, 'NEWGROUPNOTICEFALSE00'), 'not admitted');

    for (const [mutate, code] of [
      [(c) => { c.acks.d3 = '   '; }, 'd3'],
      [(c) => { c.acks.q0Recorded = false; }, 'q0'],
      [(c) => { c.acks.identityConfirmedAppId = ''; }, 'identity'],
    ]) {
      const c = structuredClone(good);
      mutate(c);
      writeFileSync(join(s.root, 'config.json'), JSON.stringify(c));
      const r = await clo(s.root, ['apply'], { fetch: provider.fetch });
      assert.equal(r.code, 1, code);
      assert.match(r.err, new RegExp(code));
    }
    writeFileSync(join(s.root, 'config.json'), JSON.stringify({ ...edited, mode: 'dry-run' }));
    assert.equal((await clo(s.root, ['apply'], { fetch: provider.fetch })).code, 0, 'the same edit is fine in dry-run');
    const again = await clo(s.root, ['mode', 'live'], { fetch: provider.fetch });
    assert.equal(again.code, 1);
    assert.match(again.out, /notice/);
  } finally {
    s.cleanup();
  }
});

test('live is refused when the running Gateway does not hold the Key in .env, with a hint to restart', async () => {
  const s = makeRoot('gatewaykey');
  const provider = fakeProvider();
  try {
    await readyForLive(s.root, provider);
    withDb(s.root, (store) => store.setControl('gateway_key', 'none', 'start'));
    const none = await clo(s.root, ['mode', 'live'], { fetch: provider.fetch });
    assert.equal(none.code, 1);
    assert.match(none.out, /gateway_key/);
    assert.match(none.out, /clo stop/);
    withDb(s.root, (store) => store.setControl('gateway_key', store.key('sk-or-v1-SOME-OTHER-KEY'), 'start'));
    assert.equal((await clo(s.root, ['mode', 'live'], { fetch: provider.fetch })).code, 1, 'another key');
    withDb(s.root, (store) => store.setControl('gateway_key', store.key(FAKE_KEY), 'start'));
    assert.equal((await clo(s.root, ['mode', 'live'], { fetch: provider.fetch })).code, 0, 'positive control');
    const dump = withDb(s.root, (store) => JSON.stringify(store.q('SELECT * FROM control').all()));
    assert.ok(!dump.includes(FAKE_KEY), 'the value itself is never stored');
  } finally {
    s.cleanup();
  }
});

test('status shows the decision breaker, open or closed', async () => {
  const r = root('breaker', enabledConfig());
  await clo(r, ['apply']);
  withDb(r, (s) => s.setControl('paid_paused', 'residual', 'test'));
  assert.match((await clo(r, ['status'])).out, /判定 否/);
  withDb(r, (s) => s.setControl('decision_paused', 'open', 'test'));
  const text = (await clo(r, ['status'])).out;
  assert.match(text, /判定 熔断中/);
  assert.match(text, /付费 residual/, 'the two are separate states');
  const json = JSON.parse((await clo(r, ['status', '--json'])).out);
  assert.equal(typeof json.db.decisionPausedAt, 'number');
});

const liveRoot = async (label) => {
  const r = root(label);
  const provider = fakeProvider();
  await readyForLive(r, provider);
  const res = await clo(r, ['mode', 'live'], { fetch: provider.fetch });
  assert.equal(res.code, 0, `${res.out}${res.err}`);
  return { r, provider };
};
const effectiveFile = (r) => join(r, '.runtime', 'clo', 'effective.json');
const editConfig = (r, mutate) => {
  const cfg = configOf(r);
  mutate(cfg);
  writeFileSync(join(r, 'config.json'), JSON.stringify(cfg));
};
const failedCodes = (out) => [...out.matchAll(/^ {2}(\w+)：/gm)].map((m) => m[1]);

test('mode dry-run stops first: a config it cannot apply leaves the same reader on dry-run, and no platform claim is needed', async () => {
  const { r } = await liveRoot('forcedry');
  const reader = createEffectiveReader(effectiveFile(r));
  assert.equal(reader().mode, 'live', 'positive control: it was live');
  editConfig(r, (c) => { c.claudeModel.id = 'anthropic/claude-sonnet-5.5'; });
  const res = await clo(r, ['mode', 'dry-run']);
  assert.equal(res.code, 1);
  assert.match(res.err, /已经进入 dry-run/);
  assert.match(res.err, /clo model refresh/);
  assert.equal(reader().mode, 'dry-run');
  assert.equal(configOf(r).mode, 'dry-run');
});

test('mode dry-run still stops when config.json cannot be read at all', async () => {
  const { r } = await liveRoot('forcedrybroken');
  writeFileSync(join(r, 'config.json'), '{ not json');
  const res = await clo(r, ['mode', 'dry-run']);
  assert.equal(res.code, 1);
  assert.match(res.err, /已经进入 dry-run/);
  assert.equal(effectiveOf(r).mode, 'dry-run');
});

test('mode dry-run does not claim to have stopped when the effective file cannot be written', async () => {
  const { r } = await liveRoot('forcedryro');
  chmodSync(effectiveFile(r), 0o444);
  try {
    const res = await clo(r, ['mode', 'dry-run']);
    assert.equal(res.code, 1);
    assert.match(res.err, /还是 live/);
    assert.doesNotMatch(res.err, /已经进入/);
    assert.equal(effectiveOf(r).mode, 'live');
  } finally {
    chmodSync(effectiveFile(r), 0o644);
  }
  assert.equal((await clo(r, ['mode', 'dry-run'])).code, 0, 'positive control: writable again, it goes through');
  assert.equal(effectiveOf(r).mode, 'dry-run');
});

test('apply refuses live with no model lock, and leaves the effective file as it was', async () => {
  const { r } = await liveRoot('livenolock');
  assert.equal((await clo(r, ['apply'])).code, 0, 'positive control: with the lock it applies');
  const lockFile = join(r, 'versions.lock.json');
  const saved = readFileSync(lockFile, 'utf8');
  const lock = readJson(lockFile);
  delete lock.models.lock;
  writeFileSync(lockFile, JSON.stringify(lock));
  const before = readFileSync(effectiveFile(r), 'utf8');
  const res = await clo(r, ['apply']);
  assert.equal(res.code, 1);
  assert.match(res.err, /没有锁定的模型/);
  assert.match(res.err, /clo model refresh/);
  assert.equal(readFileSync(effectiveFile(r), 'utf8'), before);
  writeFileSync(lockFile, saved);
});

test('a hand-edited live that mode live refuses goes back to dry-run, so apply works again', async () => {
  const r = root('halfstate');
  const provider = fakeProvider();
  await readyForLive(r, provider);
  editConfig(r, (c) => { c.mode = 'live'; c.acks.q0Recorded = false; });
  assert.equal((await clo(r, ['apply'])).code, 1, 'positive control: the half state refuses apply');
  const res = await clo(r, ['mode', 'live'], { fetch: provider.fetch });
  assert.equal(res.code, 1);
  assert.deepEqual(failedCodes(res.out), ['q0']);
  assert.equal(configOf(r).mode, 'dry-run');
  assert.equal(effectiveOf(r).mode, 'dry-run');
  assert.equal((await clo(r, ['apply'])).code, 0);
});

test('a daily budget below one required reply is refused, using the same hold as the ledger', async () => {
  const r = root('dailyhold');
  const provider = fakeProvider();
  await readyForLive(r, provider);
  const holdUsd = withDb(r, (store) => createLedger({ store, getEffective: () => effectiveOf(r), fetch: provider.fetch, getKey: () => null, log: () => {}, now: Date.now }).holdMicros('reply_required')) / 1e6;
  const setDaily = (x) => editConfig(r, (c) => { Object.assign(c.budget, { dailyUsd: x, addressedUsd: x, namedUsd: x, searchUsd: x, interjectUsd: x }); });

  setDaily(holdUsd - 0.000001);
  const low = await clo(r, ['mode', 'live'], { fetch: provider.fetch });
  assert.equal(low.code, 1);
  assert.deepEqual(failedCodes(low.out), ['daily_hold']);
  assert.match(low.out, /daily_hold：[^\n]*dailyUsd/, 'the hint is not empty');

  setDaily(holdUsd);
  const exact = await clo(r, ['mode', 'live'], { fetch: provider.fetch });
  assert.equal(exact.code, 0, `${exact.out}${exact.err}`);
});

test('a Key limit that differs from keyDailyLimitUsd is refused with a hint and no key in it; a lower limit that matches passes', async () => {
  const r = root('keylimit');
  const provider = fakeProvider();
  await readyForLive(r, provider);
  provider.state.key = { usage: 0, limit: 3.25, limit_remaining: 3.25, limit_reset: 'daily', usage_daily: 0 };
  const res = await clo(r, ['mode', 'live'], { fetch: provider.fetch });
  assert.equal(res.code, 1);
  assert.deepEqual(failedCodes(res.out), ['key_limit']);
  assert.match(res.out, /key_limit：[^\n]*keyDailyLimitUsd/);
  assert.ok(!res.out.includes(FAKE_KEY));

  provider.state.key = { usage: 0, limit: 1.6, limit_remaining: 1.6, limit_reset: 'daily', usage_daily: 0 };
  assert.ok(configOf(r).budget.dailyUsd > 1.6, 'this limit is below the local budget');
  assert.equal((await clo(r, ['mode', 'live'], { fetch: provider.fetch })).code, 0);
});

test('a non-empty localNumbers is refused before any write', async () => {
  const r = root('numbers');
  const provider = fakeProvider();
  await readyForLive(r, provider);
  editConfig(r, (c) => { c.contentPolicy.crisis.localNumbers = ['12345']; });
  const res = await clo(r, ['mode', 'live'], { fetch: provider.fetch });
  assert.equal(res.code, 1);
  assert.match(res.err, /contentPolicy\.crisis\.localNumbers/);
  assert.equal(effectiveOf(r).mode, 'dry-run');
});

test('with another Key in the Gateway, mode live reads the Key but does not reconcile, so the baseline is not flipped', async () => {
  const r = root('skipreconcile');
  const provider = fakeProvider();
  await readyForLive(r, provider);
  const keyReads = () => provider.calls.filter((c) => c.url.endsWith('/key')).length;
  const baseline = withDb(r, (store) => {
    const other = store.key('sk-or-v1-SOME-OTHER-KEY');
    store.setControl('gateway_key', other, 'start');
    const text = JSON.stringify({ usage: 0, at: Date.now() - 1000, keyId: other });
    store.setMeta('key_baseline', text);
    return text;
  });
  const reads = keyReads();
  const res = await clo(r, ['mode', 'live'], { fetch: provider.fetch });
  assert.equal(res.code, 1);
  assert.deepEqual(failedCodes(res.out), ['reconciled', 'gateway_key']);
  assert.match(res.out, /reconciled：这次没有对账/);
  assert.match(res.out, /gateway_key：[^\n]*刚启动的 Gateway 要先连接完成/);
  assert.equal(keyReads(), reads + 1, 'one read for the limit');
  withDb(r, (store) => {
    assert.equal(store.getMeta('key_baseline'), baseline);
    assert.equal(store.q("SELECT COUNT(*) AS n FROM alerts WHERE kind='key_changed'").get().n, 0);
  });

  withDb(r, (store) => store.setControl('gateway_key', store.key(FAKE_KEY), 'start'));
  const matched = keyReads();
  await clo(r, ['mode', 'live'], { fetch: provider.fetch });
  assert.ok(keyReads() > matched + 1, 'positive control: with the same Key it does reconcile');
});

test('resume refuses anything it cannot read, since that would otherwise resume every group; bare resume still works', async () => {
  const r = root('resumeargs', enabledConfig());
  await clo(r, ['apply']);
  assert.equal((await clo(r, ['pause', '--all'])).code, 0);
  withDb(r, (s) => s.setControl('interject_paused', '1', 'test'));
  for (const args of [['--group'], ['--group=测试群'], ['测试群'], ['--nope'], ['--all', '测试群'], ['--interject', 'x'], ['--interject', '--all'], ['--interject', '--group', '测试群']]) {
    const res = await clo(r, ['resume', ...args]);
    assert.equal(res.code, 1, args.join(' '));
    assert.match(res.err, /什么都没有恢复/);
    assert.equal(withDb(r, (s) => s.getControl('global_paused')), 'console', args.join(' '));
    assert.equal(withDb(r, (s) => s.getControl('interject_paused')), '1', args.join(' '));
  }
  assert.equal((await clo(r, ['resume'])).code, 0);
  assert.equal(withDb(r, (s) => s.getControl('global_paused')), null);
  assert.equal((await clo(r, ['resume', '--interject'])).code, 0);
  assert.equal(withDb(r, (s) => s.getControl('interject_paused')), null);
  assert.equal((await clo(r, ['resume', '--group', '测试群'])).code, 0);
  assert.equal((await clo(r, ['resume', '--all'])).code, 0);
});

test('accept-unsettled says what actually happened to the pause', async () => {
  const r = root('acceptnote', enabledConfig());
  await clo(r, ['model', 'refresh'], { fetch: fakeProvider().fetch });
  const none = await clo(r, ['budget', 'accept-unsettled']);
  assert.match(none.out, /现在没有付费暂停/);
  assert.doesNotMatch(none.out, /随之解除/);

  withDb(r, (s) => s.setControl('paid_paused', 'openrouter_credits', 'test'));
  const other = await clo(r, ['budget', 'accept-unsettled']);
  assert.match(other.out, /还没有恢复：现在的暂停原因是 openrouter_credits/);
  assert.doesNotMatch(other.out, /随之解除/);

  withDb(r, (s) => s.setControl('paid_paused', 'crash_unsettled', 'test'));
  const lifted = await clo(r, ['budget', 'accept-unsettled']);
  assert.match(lifted.out, /随之解除/);
  assert.equal(withDb(r, (s) => s.getControl('paid_paused')), null);
});

test('status --json --ack keeps standard output one JSON document', async () => {
  const r = root('jsonack', enabledConfig());
  await clo(r, ['apply']);
  withDb(r, (s) => s.addAlert('x', {}));
  const res = await clo(r, ['status', '--json', '--ack']);
  assert.equal(res.code, 0);
  assert.equal(JSON.parse(res.out).db.alerts.length, 1);
  assert.match(res.err, /已把 1 条告警/);
  withDb(r, (s) => s.addAlert('y', {}));
  assert.match((await clo(r, ['status', '--ack'])).out, /已把 1 条告警/, 'as text it stays with the report');
});

const NO_SUCH_PID = 999999;
const pidFileOf = (r) => join(r, '.runtime', 'pids', 'gateway.json');
const lockFileOf = (r) => join(r, '.runtime', 'pids', 'start.lock');
const writeInPids = (file, value) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
};
const guarded = { env: { CLO_TEST_NODE_IMPORT: join(ROOT, 'tests', 'harness', 'net-guard.mjs') } };

test('stop drops the heartbeat, so a stopped Gateway does not read as fresh', async () => {
  const r = root('stopbeat', enabledConfig());
  await clo(r, ['apply']);
  markRunning(r);
  assert.equal(JSON.parse((await clo(r, ['status', '--json'])).out).heartbeatFresh, true, 'positive control');
  writeInPids(pidFileOf(r), { pid: NO_SUCH_PID, startTime: 'x', commandDigest: 'y' });
  const res = await clo(r, ['stop']);
  assert.equal(res.code, 0, `${res.out}${res.err}`);
  assert.equal(withDb(r, (s) => s.getControl('heartbeat_at')), null);
  assert.equal(withDb(r, (s) => s.getControl('connected')), 'false');
  assert.equal(JSON.parse((await clo(r, ['status', '--json'])).out).heartbeatFresh, false);
});

test('a start under way: another start and a stop both refuse and touch nothing; a dead holder blocks neither', { timeout: 120000 }, async () => {
  const r = root('startlock');
  const provider = fakeProvider();
  await readyForLive(r, provider);
  // Hand-edited live stops a start right after the lock, so this never reaches a Gateway.
  editConfig(r, (c) => { c.mode = 'live'; });
  writeInPids(pidFileOf(r), { pid: NO_SUCH_PID, startTime: 'x', commandDigest: 'y' });

  writeInPids(lockFileOf(r), { pid: process.pid, startTime: null, token: 't', startedAt: 'x' });
  const start = await clo(r, ['start'], guarded);
  assert.equal(start.code, 1);
  assert.match(start.err, /另一个 clo start 正在运行/);
  const stop = await clo(r, ['stop']);
  assert.equal(stop.code, 1);
  assert.match(stop.out, /clo start 可能还在运行/);
  assert.ok(existsSync(pidFileOf(r)), 'nothing was touched');
  assert.ok(existsSync(lockFileOf(r)), 'nor the lock');

  writeInPids(lockFileOf(r), { pid: NO_SUCH_PID, startTime: null, token: 't', startedAt: 'x' });
  const afterDead = await clo(r, ['start'], guarded);
  assert.equal(afterDead.code, 1);
  assert.match(afterDead.err, /clo mode live/, 'it went past the lock, to the next refusal');
  assert.equal(existsSync(lockFileOf(r)), false, 'reclaimed, and released after the refusal');

  writeInPids(lockFileOf(r), { pid: NO_SUCH_PID, startTime: null, token: 't', startedAt: 'x' });
  assert.equal((await clo(r, ['stop'])).code, 0, 'a stale lock does not block a stop');
  assert.equal(existsSync(pidFileOf(r)), false);
});

test('a Gateway whose command line the OS withholds: stop and start say to use the shell that started it', { timeout: 90000 }, async () => {
  const r = root('cmdlinehint', enabledConfig());
  await clo(r, ['apply']);
  // The System process shows a start time and no command line to every caller.
  const info = processInfo(4);
  assert.ok(info?.startTime, 'positive control: the start time is readable');
  writeInPids(pidFileOf(r), { pid: 4, startTime: info.startTime, commandDigest: 'digest' });
  const stop = await clo(r, ['stop']);
  assert.equal(stop.code, 1);
  assert.match(stop.out, /从启动它的 shell 里运行/);
  assert.ok(existsSync(pidFileOf(r)));
  const start = await clo(r, ['start'], guarded);
  assert.equal(start.code, 1);
  assert.match(start.err, /从启动它的 shell 里运行/);
  assert.ok(existsSync(pidFileOf(r)));
});

test('ack terminal also clears a close that only reached the file', async () => {
  const r = root('closefile', enabledConfig());
  await clo(r, ['apply']);
  assert.match((await clo(r, ['ack', 'terminal'])).out, /没有锁存/, 'positive control: nothing latched yet');
  const file = `${dbOf(r)}.terminal_close`;
  writeFileSync(file, '4915');
  const res = await clo(r, ['ack', 'terminal']);
  assert.match(res.out, /4915/);
  assert.equal(existsSync(file), false);
  assert.match((await clo(r, ['ack', 'terminal'])).out, /没有锁存/);
});

// --- The own runtime ---

test('config.example.json names the runtime, and it is the host until the switch', () => {
  assert.equal(JSON.parse(readFileSync(join(ROOT, 'config.example.json'), 'utf8')).runtime, 'openclaw');
});

// A stand-in for src/bot/main.mjs, which doctor needs to see under own.
function ownEntryEnv(r) {
  const entry = join(r, 'bot', 'main.mjs');
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, '// stand-in entry\n');
  return { CLO_TEST_BOT_ENTRY: entry };
}

// The reply_required hold the ledger of that runtime computes from this site's effective config, in dollars.
const holdOf = (r, provider, runtime) => withDb(r, (store) => createLedger({ store, getEffective: () => effectiveOf(r), fetch: provider.fetch, getKey: () => null, log: () => {}, now: Date.now, runtime }).holdMicros('reply_required')) / 1e6;
const setBudget = (r, x) => editConfig(r, (c) => { Object.assign(c.budget, { dailyUsd: x, addressedUsd: x, namedUsd: x, searchUsd: x, interjectUsd: x }); });

test('mode live works under own with no host config at all, and refuses when its doctor checks fail', async () => {
  const r = root('ownlive');
  const provider = fakeProvider();
  await readyForLive(r, provider);
  editConfig(r, (c) => { c.runtime = 'own'; });
  const openclawJson = join(r, '.runtime', 'state', 'openclaw.json');
  rmSync(openclawJson, { force: true });
  const env = ownEntryEnv(r);

  const noEntry = await clo(r, ['mode', 'live'], { fetch: provider.fetch, env: { CLO_TEST_BOT_ENTRY: join(r, 'nowhere.mjs') } });
  assert.equal(noEntry.code, 1, 'positive control: the own doctor checks are part of the gate');
  assert.deepEqual(failedCodes(noEntry.out), ['doctor']);
  assert.equal(effectiveOf(r).mode, 'dry-run');

  const res = await clo(r, ['mode', 'live'], { fetch: provider.fetch, env });
  assert.equal(res.code, 0, `${res.out}${res.err}`);
  assert.equal(effectiveOf(r).mode, 'live');
  assert.equal(effectiveOf(r).runtime, 'own');
  assert.equal(existsSync(openclawJson), false, 'no host config was needed or written');
  const status = await clo(r, ['status', '--json']);
  assert.equal(JSON.parse(status.out).runtime, 'own');
  assert.match((await clo(r, ['status'])).out, /可洛进程：没有 PID 文件/);
});

test('under own the daily budget is checked against the hold the ledger computes for that runtime', async () => {
  const r = root('owndailyhold');
  const provider = fakeProvider();
  await readyForLive(r, provider);
  editConfig(r, (c) => { c.runtime = 'own'; });
  const env = ownEntryEnv(r);
  assert.equal((await clo(r, ['apply'], { env })).code, 0);
  assert.equal(effectiveOf(r).runtime, 'own', 'positive control: the hold below is the own one');
  const holdUsd = holdOf(r, provider, 'own');
  assert.ok(holdUsd < holdOf(r, provider, 'openclaw'), 'positive control: the own hold is the smaller one, so the exact pass below tells them apart');
  const setDaily = (x) => setBudget(r, x);

  setDaily(holdUsd - 0.000001);
  const low = await clo(r, ['mode', 'live'], { fetch: provider.fetch, env });
  assert.equal(low.code, 1);
  assert.deepEqual(failedCodes(low.out), ['daily_hold']);
  assert.match(low.out, /永远得不到额度/, 'positive control for the text checked below');
  // At the own hold, which is below the host one: the bot reserves only this much, so clo mode live lets it through.
  setDaily(holdUsd);
  const exact = await clo(r, ['mode', 'live'], { fetch: provider.fetch, env });
  assert.equal(exact.code, 0, `${exact.out}${exact.err}`);
  assert.doesNotMatch(exact.out, /永远得不到额度/, 'no budget warning at the own hold');
});

test('a daily budget between the own and the host hold is refused under openclaw and passes under own (control)', async () => {
  const r = root('betweenholds');
  const provider = fakeProvider();
  await readyForLive(r, provider);
  assert.equal(effectiveOf(r).runtime ?? 'openclaw', 'openclaw');
  const own = holdOf(r, provider, 'own');
  const host = holdOf(r, provider, 'openclaw');
  const between = Math.round(((own + host) / 2) * 1e6) / 1e6;
  assert.ok(between > own && between < host);
  setBudget(r, between);
  const hostRun = await clo(r, ['mode', 'live'], { fetch: provider.fetch });
  assert.equal(hostRun.code, 1);
  assert.deepEqual(failedCodes(hostRun.out), ['daily_hold']);
  assert.equal(effectiveOf(r).mode, 'dry-run');

  editConfig(r, (c) => { c.runtime = 'own'; });
  const env = ownEntryEnv(r);
  assert.equal((await clo(r, ['apply'], { env })).code, 0);
  const ownRun = await clo(r, ['mode', 'live'], { fetch: provider.fetch, env });
  assert.equal(ownRun.code, 0, `${ownRun.out}${ownRun.err}`);
  assert.equal(effectiveOf(r).mode, 'live');
});
