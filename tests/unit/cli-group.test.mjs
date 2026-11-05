// Group and owner management. Group IDs and sender IDs stay separate; validation runs before any write.
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { clo, configOf, effectiveOf, enabledConfig, fakeProvider, GROUP_ID, makeRoot, openclawOf, OWNER_ID, readyForLive } from './_cli-helper.mjs';

const roots = [];
const root = (label, cfg) => {
  const r = makeRoot(label, cfg);
  roots.push(r);
  return r.root;
};
after(() => roots.forEach((r) => r.cleanup()));

test('add, owner, set, notice-done and remove keep both lists in step', async () => {
  const r = root('flow');
  const added = await clo(r, ['group', 'add', '测试群', '--id', GROUP_ID]);
  assert.equal(added.code, 0, added.err);
  assert.ok(!added.out.includes(GROUP_ID), 'the id is masked');
  let cfg = configOf(r);
  assert.deepEqual(cfg.qq.allowedGroupIds, [GROUP_ID]);
  assert.deepEqual(cfg.qq.groups[GROUP_ID], { label: '测试群', interject: false, nameMention: false, noticeGiven: false, displayNames: false }, 'everything off by default');
  assert.equal(effectiveOf(r).qq.groups[GROUP_ID].displayNames, false, 'a new group never gets names silently');
  assert.deepEqual(effectiveOf(r).qq.groups[GROUP_ID].ownerMemberIds, []);

  assert.equal((await clo(r, ['owner', 'add', '测试群', '--id', OWNER_ID])).code, 0);
  await clo(r, ['owner', 'add', '测试群', '--id', OWNER_ID]);
  cfg = configOf(r);
  assert.deepEqual(cfg.qq.owner.groupMember[GROUP_ID], [OWNER_ID], 'an owner is listed once');
  assert.ok(!cfg.qq.allowedGroupIds.includes(OWNER_ID), 'a member id never enters the group list');
  assert.deepEqual(effectiveOf(r).qq.groups[GROUP_ID].ownerMemberIds, [OWNER_ID]);

  assert.equal((await clo(r, ['group', 'set', '测试群', '--interject', 'on'])).code, 0);
  assert.equal(effectiveOf(r).qq.groups[GROUP_ID].interject, true);
  assert.equal(effectiveOf(r).qq.groups[GROUP_ID].nameMention, false);
  assert.equal((await clo(r, ['group', 'set', '测试群', '--interject', 'off', '--name-mention', 'on'])).code, 0);
  assert.equal(effectiveOf(r).qq.groups[GROUP_ID].interject, false);
  assert.equal(effectiveOf(r).qq.groups[GROUP_ID].nameMention, true);
  assert.equal((await clo(r, ['group', 'set', '测试群', '--interject', 'maybe'])).code, 1);
  assert.equal((await clo(r, ['group', 'set', '测试群'])).code, 1);

  assert.equal((await clo(r, ['group', 'notice-done', '测试群'])).code, 0);
  assert.equal(configOf(r).qq.groups[GROUP_ID].noticeGiven, true);

  const list = await clo(r, ['group', 'list']);
  assert.match(list.out, /测试群/);
  assert.ok(!list.out.includes(GROUP_ID));
  assert.ok(!list.out.includes(OWNER_ID));

  assert.equal((await clo(r, ['group', 'remove', '测试群'])).code, 0);
  cfg = configOf(r);
  assert.deepEqual(cfg.qq.allowedGroupIds, []);
  assert.deepEqual(cfg.qq.groups, {});
  assert.equal(cfg.qq.owner.groupMember[GROUP_ID], undefined);
  assert.deepEqual(effectiveOf(r).qq.groups, {});
  assert.match((await clo(r, ['group', 'list'])).out, /全部关闭/);
});

test('bad input changes nothing on disk', async () => {
  const r = root('bad');
  await clo(r, ['group', 'add', '甲', '--id', 'GROUPA000000']);
  const before = readFileSync(join(r, 'config.json'), 'utf8');
  for (const args of [
    ['group', 'add', '乙', '--id', 'HAS SPACE'],
    ['group', 'add', '乙'],
    ['group', 'add', '--id', 'GROUPB000000'],
    ['group', 'add', '甲', '--id', 'GROUPB000000'],
    ['group', 'add', '乙', '--id', 'GROUPA000000'],
    ['group', 'remove', '丙'],
    ['group', 'set', '丙', '--interject', 'on'],
    ['group', 'notice-done', '丙'],
    ['owner', 'add', '丙', '--id', 'M0000000000'],
    ['owner', 'add', '甲', '--id', 'HAS SPACE'],
    ['owner', 'add', '甲'],
    ['owner', 'nope'],
  ]) {
    const res = await clo(r, args);
    assert.notEqual(res.code, 0, args.join(' '));
    assert.equal(readFileSync(join(r, 'config.json'), 'utf8'), before, args.join(' '));
  }
});

test('IDs differing only by case are two groups', async () => {
  const r = root('case');
  assert.equal((await clo(r, ['group', 'add', '大写', '--id', 'ABCDEF123456'])).code, 0);
  assert.equal((await clo(r, ['group', 'add', '小写', '--id', 'abcdef123456'])).code, 0);
  assert.deepEqual(configOf(r).qq.allowedGroupIds, ['ABCDEF123456', 'abcdef123456']);
});

test('a new group cannot be added while live, since it would be admitted before anyone is told', async () => {
  const r = root('live');
  const provider = fakeProvider();
  await readyForLive(r, provider);
  assert.equal((await clo(r, ['mode', 'live'], { fetch: provider.fetch })).code, 0);
  const res = await clo(r, ['group', 'add', '新群', '--id', 'NEWGROUP000000']);
  assert.equal(res.code, 1);
  assert.match(res.err, /mode dry-run/);
  assert.equal(configOf(r).qq.groups.NEWGROUP000000, undefined);
});

test('group changes reach effective.json but do not rewrite openclaw.json', async () => {
  const r = root('noreload', enabledConfig());
  await clo(r, ['apply']);
  const file = join(r, '.runtime', 'state', 'openclaw.json');
  const before = statSync(file).mtimeMs;
  const bytes = readFileSync(file, 'utf8');
  await clo(r, ['group', 'set', '测试群', '--interject', 'on']);
  await clo(r, ['group', 'add', '第二群', '--id', 'SECONDGROUP0000']);
  await clo(r, ['group', 'set', '测试群', '--display-names', 'on']);
  assert.equal(readFileSync(file, 'utf8'), bytes);
  assert.equal(statSync(file).mtimeMs, before, 'no write, so no Gateway reload');
  assert.equal(effectiveOf(r).qq.groups[GROUP_ID].interject, true);
  assert.equal(effectiveOf(r).qq.groups[GROUP_ID].displayNames, true);
  assert.equal(openclawOf(r).channels['clo-qq'].appId, 'FAKEAPPID000111');
});

test('--display-names: per group, on and off, shown by list and status, and a config without the field still means off', async () => {
  const r = root('names');
  await clo(r, ['group', 'add', '甲', '--id', 'GROUPA000000']);
  await clo(r, ['group', 'add', '乙', '--id', 'GROUPB000000']);
  const raw = JSON.parse(readFileSync(join(r, 'config.json'), 'utf8'));
  delete raw.qq.groups.GROUPA000000.displayNames;
  writeFileSync(join(r, 'config.json'), JSON.stringify(raw));
  assert.equal((await clo(r, ['apply'])).code, 0, 'an older config is valid');
  assert.equal(effectiveOf(r).qq.groups.GROUPA000000.displayNames, false);
  assert.match((await clo(r, ['status'])).out, /群 甲（[^）]*）：[^\n]*显示名 否/);

  const on = await clo(r, ['group', 'set', '甲', '--display-names', 'on']);
  assert.equal(on.code, 0, on.err);
  assert.match(on.out, /显示名 开/);
  assert.match(on.out, /D5/, 'the command says whose decision this is');
  assert.equal(configOf(r).qq.groups.GROUPA000000.displayNames, true);
  assert.equal(effectiveOf(r).qq.groups.GROUPA000000.displayNames, true);
  assert.equal(effectiveOf(r).qq.groups.GROUPB000000.displayNames, false, 'the other group is untouched');
  assert.match((await clo(r, ['status'])).out, /群 甲（[^）]*）：[^\n]*显示名 是/);
  assert.match((await clo(r, ['status'])).out, /群 乙（[^）]*）：[^\n]*显示名 否/);
  assert.match((await clo(r, ['group', 'list'])).out, /甲\t[^\n]*显示名 开/);

  const before = readFileSync(join(r, 'config.json'), 'utf8');
  assert.equal((await clo(r, ['group', 'set', '甲', '--display-names', 'maybe'])).code, 1);
  assert.equal(readFileSync(join(r, 'config.json'), 'utf8'), before, 'bad input changes nothing');

  const off = await clo(r, ['group', 'set', '甲', '--display-names', 'off']);
  assert.equal(off.code, 0);
  assert.ok(!off.out.includes('D5'));
  assert.equal(effectiveOf(r).qq.groups.GROUPA000000.displayNames, false);

  const bad = JSON.parse(readFileSync(join(r, 'config.json'), 'utf8'));
  bad.qq.groups.GROUPA000000.displayNames = 'on';
  writeFileSync(join(r, 'config.json'), JSON.stringify(bad));
  assert.notEqual((await clo(r, ['apply'])).code, 0, 'validation refuses anything but a boolean');
});

test('while live, the last group cannot be removed; another can, and dry-run opens the way', async () => {
  const r = root('lastgroup');
  const provider = fakeProvider();
  await readyForLive(r, provider);
  const cfg = configOf(r);
  cfg.qq.groups.SECONDGROUP0000 = { label: '第二群', interject: false, nameMention: false, noticeGiven: true };
  cfg.qq.allowedGroupIds.push('SECONDGROUP0000');
  cfg.qq.owner.groupMember.SECONDGROUP0000 = ['SECONDOWNER0000'];
  writeFileSync(join(r, 'config.json'), JSON.stringify(cfg));
  assert.equal((await clo(r, ['mode', 'live'], { fetch: provider.fetch })).code, 0);

  assert.equal((await clo(r, ['group', 'remove', '第二群'])).code, 0, 'a group that is not the last goes');
  assert.equal(effectiveOf(r).qq.groups.SECONDGROUP0000, undefined);

  const before = readFileSync(join(r, 'config.json'), 'utf8');
  const refused = await clo(r, ['group', 'remove', '测试群']);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /最后一个群/);
  assert.match(refused.err, /clo mode dry-run/);
  assert.equal(readFileSync(join(r, 'config.json'), 'utf8'), before, 'nothing written');
  assert.equal(effectiveOf(r).mode, 'live');
  assert.ok(effectiveOf(r).qq.groups[GROUP_ID]);

  assert.equal((await clo(r, ['mode', 'dry-run'])).code, 0);
  assert.equal((await clo(r, ['group', 'remove', '测试群'])).code, 0);
  assert.deepEqual(effectiveOf(r).qq.groups, {});
});

test('a command refused by the config it would apply writes nothing, while live and over a model mismatch', async () => {
  const r = root('nowrite');
  const provider = fakeProvider();
  await readyForLive(r, provider);
  assert.equal((await clo(r, ['mode', 'live'], { fetch: provider.fetch })).code, 0);
  assert.equal((await clo(r, ['group', 'set', '测试群', '--interject', 'on'])).code, 0, 'positive control: a clean config goes through');

  const good = configOf(r);
  for (const [mutate, pattern] of [
    [(c) => { c.acks.d3 = '   '; }, /d3/],
    [(c) => { c.claudeModel.id = 'anthropic/claude-sonnet-5.5'; }, /clo model refresh/],
  ]) {
    const edited = structuredClone(good);
    mutate(edited);
    writeFileSync(join(r, 'config.json'), JSON.stringify(edited));
    const before = readFileSync(join(r, 'config.json'), 'utf8');
    const effective = effectiveOf(r);
    for (const args of [['group', 'set', '测试群', '--interject', 'off'], ['group', 'notice-done', '测试群'], ['owner', 'add', '测试群', '--id', 'ANOTHEROWNER000']]) {
      const res = await clo(r, args);
      assert.equal(res.code, 1, args.join(' '));
      assert.match(res.err, pattern);
      assert.equal(readFileSync(join(r, 'config.json'), 'utf8'), before, args.join(' '));
    }
    assert.deepEqual(effectiveOf(r), effective);
  }
});
