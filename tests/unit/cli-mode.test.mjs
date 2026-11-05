// Modes, live preconditions, pause, status, targets, budget, policy. In-process, temp root, fake provider.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { validateBusinessConfig } from '../../src/clo-plugin/lib/core/config.js';
import { APP_ID, baseConfig, clo, configOf, effectiveOf, enabledConfig, fakeProvider, FAKE_KEY, FAKE_SECRET, GROUP_ID, makeRoot, markRunning, OWNER_ID, readJson, readyForLive, ROOT, withDb } from './_cli-helper.mjs';

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
  assert.deepEqual(names, ['CLO_QQ_APP_ID', 'CLO_QQ_APP_SECRET', 'CLO_CHAT_API_KEY', 'CLO_SEARCH_API_KEY']);
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
