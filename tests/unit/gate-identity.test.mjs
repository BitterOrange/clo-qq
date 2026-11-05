// G2 admission, G1 dedupe, G3 staleness, G0 discovery. Real SQLite, fake clock.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GROUP_A, GROUP_B, makeEffective, makeHarness, MEMBER, OWNER, T0 } from '../fixtures/inbound.mjs';

const noWork = (h) => {
  assert.equal(h.decideCalls.length, 0, 'no decision');
  assert.equal(h.dispatched.length, 0, 'no dispatch');
};

test('positive control: an admitted real @ writes a row and dispatches once', async () => {
  const h = makeHarness();
  const e = await h.sendAndFlush(h.at());
  assert.equal(h.dispatched.length, 1);
  assert.equal(h.state(e), 'completed:sent');
  await h.close();
});

test('traffic that is not admitted leaves no row and costs nothing', async () => {
  const h = makeHarness();
  const cases = [
    ['not_admitted', h.at({ conversationId: 'GROUPNOTLISTED' })],
    ['not_admitted', h.event({ conversationId: 'GROUPNOTLISTED' })],
    ['not_admitted', h.at({ conversationId: GROUP_A.toLowerCase() })],
    ['not_admitted', h.at({ conversationId: '__proto__' })],
    ['not_admitted', h.at({ conversationId: 'constructor' })],
    ['dm_closed', h.at({ kind: 'direct', eventType: 'C2C_MESSAGE_CREATE', conversationId: MEMBER })],
    ['dm_closed', h.at({ kind: 'direct', eventType: 'C2C_MESSAGE_CREATE', conversationId: OWNER, senderId: OWNER })],
    ['bot', h.at({ senderIsBot: true })],
    ['no_identity', h.at({ senderId: null })],
    ['no_identity', h.at({ messageId: '' })],
    ['no_identity', h.at({ conversationId: null })],
  ];
  for (const [reason, evt] of cases) {
    await h.send(evt);
    assert.equal(h.logs.at(-1).event, 'gate_drop');
    assert.equal(h.logs.at(-1).reason, reason);
  }
  h.advance(4000);
  await h.gate.idle();
  noWork(h);
  assert.equal(h.allEvents().length, 0);
  assert.equal(h.store.q('SELECT COUNT(*) AS n FROM reservations').get().n, 0);
  assert.equal(h.exit.fixed.length + h.exit.acks.length, 0);

  const ok = await h.sendAndFlush(h.at());
  assert.equal(h.dispatched.length, 1, 'the same gate still works');
  assert.equal(h.state(ok), 'completed:sent');
  await h.close();
});

test('a group whose ID differs only by case is a different group', async () => {
  const lower = GROUP_A.toLowerCase();
  const h = makeHarness({ effective: makeEffective({ qq: { groups: { [lower]: { label: 'x', interject: false, nameMention: false, noticeGiven: true, cooldownMinutes: 8, perHour: 6, perDay: 8, ownerMemberIds: [] } } } }) });
  const a = await h.sendAndFlush(h.at());
  const b = await h.sendAndFlush(h.at({ conversationId: lower }));
  assert.equal(h.row(a).group_key === h.row(b).group_key, false);
  assert.deepEqual(h.dispatched.map((t) => t.groupId), [GROUP_A, lower], 'raw case is kept for the send path');
  await h.close();
});

test('no effective config, QQ disabled, or a fatal close: nothing is admitted', async () => {
  const h = makeHarness({ effective: null });
  await h.sendAndFlush(h.at());
  assert.equal(h.logs.at(-1).reason, 'no_effective');
  h.eff.current = makeEffective({ qq: { enabled: false } });
  await h.sendAndFlush(h.at());
  assert.equal(h.logs.at(-1).reason, 'qq_disabled');
  h.eff.current = makeEffective();
  h.store.setControl('terminal_close', '4914', 'test');
  await h.sendAndFlush(h.at());
  assert.equal(h.logs.at(-1).reason, 'terminal');
  assert.equal(h.allEvents().length, 0);
  noWork(h);
  await h.close();
});

test('a repeated message is dropped and its state does not change', async () => {
  const h = makeHarness();
  const e = h.at();
  await h.send(e);
  await h.gate.idle();
  const before = h.row(e);
  await h.send(e);
  await h.gate.idle();
  assert.equal(h.dispatched.length, 1);
  assert.deepEqual(h.row(e), before);
  assert.equal(h.logs.filter((l) => l.event === 'gate_dup').length, 1);
  await h.close();
});

test('dedupe survives a restart, and a new message after it still works', async () => {
  const h = makeHarness({ runGen: 'first' });
  const e = await h.sendAndFlush(h.at());
  const { file } = h;
  await h.close();

  const h2 = makeHarness({ dbFile: file, runGen: 'second' });
  await h2.sendAndFlush(e);
  assert.equal(h2.dispatched.length, 0, 'the old message is not answered again');
  const fresh = await h2.sendAndFlush(h2.at());
  assert.equal(h2.dispatched.length, 1);
  assert.equal(h2.state(fresh), 'completed:sent');
  await h2.close();
});

test('two concurrent deliveries of one message give one turn', async () => {
  const h = makeHarness();
  const e = h.at();
  await Promise.all([h.gate.onInbound(e), h.gate.onInbound({ ...e })]);
  await h.gate.idle();
  assert.equal(h.dispatched.length, 1);
  await h.close();
});

test('stale, future and unusable timestamps end stale and are not buffered', async () => {
  const h = makeHarness();
  const old = h.at({ timestampMs: T0 - 120001, text: '过期的内容' });
  const future = h.at({ timestampMs: T0 + 300001, text: '未来的内容' });
  const none = h.at({ timestampMs: null, text: '没有时间的内容' });
  for (const e of [old, future, none]) await h.send(e);
  assert.equal(h.state(old), 'stale:old');
  assert.equal(h.state(future), 'stale:future');
  assert.equal(h.state(none), 'stale:no_timestamp');
  assert.equal(h.dispatched.length, 0);

  const edge = h.at({ timestampMs: T0 - 120000, text: '刚好在边界' });
  await h.send(edge);
  await h.gate.idle();
  assert.equal(h.dispatched.length, 1, 'positive control: exactly at the limit is fresh');
  const bodies = h.dispatched[0].history.map((x) => x.body);
  assert.deepEqual(bodies, [], 'the stale messages never entered the context');
  await h.close();
});

test('groups keep separate context, and the turn carries pseudonyms only', async () => {
  const h = makeHarness();
  await h.send(h.event({ text: '甲群的暗号是蓝色' }));
  await h.send(h.event({ conversationId: GROUP_B, text: '乙群的暗号是绿色', senderId: MEMBER }));
  await h.send(h.at({ text: '暗号是什么' }));
  await h.send(h.at({ conversationId: GROUP_B, text: '暗号是什么' }));
  h.advance(4000);
  await h.gate.idle();
  const a = h.dispatched.find((t) => t.groupId === GROUP_A);
  const b = h.dispatched.find((t) => t.groupId === GROUP_B);
  assert.deepEqual(a.history.map((x) => x.body), ['甲群的暗号是蓝色']);
  assert.deepEqual(b.history.map((x) => x.body), ['乙群的暗号是绿色']);
  assert.equal(a.history[0].sender, 'U1');
  assert.equal(JSON.stringify(a.history).includes(MEMBER), false);
  await h.close();
});

test('the database holds no raw ID, username or message text', async () => {
  const canary = 'CANARYTEXT42';
  const h = makeHarness();
  await h.sendAndFlush(h.at({ text: `${canary} 你好` }));
  await h.sendAndFlush(h.event({ text: `${canary} 普通消息` }));
  const dump = JSON.stringify(['events', 'sends', 'reservations', 'interject_log', 'counters', 'control', 'bot_refs', 'alerts', 'discovery']
    .map((t) => h.store.q(`SELECT * FROM ${t}`).all()));
  assert.equal(h.allEvents().length, 2, 'positive control: rows exist');
  for (const raw of [canary, GROUP_A, MEMBER, h.dispatched[0].messageId]) {
    assert.equal(dump.includes(raw), false, raw);
  }
  const logged = JSON.stringify(h.logs);
  for (const raw of [canary, GROUP_A, MEMBER, h.dispatched[0].messageId]) {
    assert.equal(logged.includes(raw), false, `log: ${raw}`);
  }
  await h.close();
});

test('discovery records raw IDs only when armed and in dry-run, with no text and no event row', async () => {
  const h = makeHarness({ effective: makeEffective({ mode: 'dry-run' }) });
  await h.send(h.event({ conversationId: 'GROUPNEW', senderId: 'MEMBERNEW', text: 'SECRETTEXT' }));
  assert.deepEqual(h.store.listDiscovery(), [], 'not armed');

  h.store.armDiscovery(T0 + 60000);
  await h.send(h.event({ conversationId: 'GROUPNEW', senderId: 'MEMBERNEW', text: 'SECRETTEXT' }));
  await h.send(h.event({ conversationId: 'GROUPBOT', senderId: 'BOTMEMBER', senderIsBot: true }));
  const found = h.store.listDiscovery();
  assert.equal(found.length, 1);
  assert.equal(found[0].groupId, 'GROUPNEW');
  assert.equal(found[0].memberId, 'MEMBERNEW');
  assert.equal(JSON.stringify(found).includes('SECRETTEXT'), false);
  assert.equal(h.allEvents().length, 0, 'still no row for a group that is not admitted');

  h.eff.current = makeEffective({ mode: 'live' });
  await h.send(h.event({ conversationId: 'GROUPLIVE', senderId: 'MEMBERLIVE' }));
  assert.equal(h.store.listDiscovery().length, 1, 'live never records');
  await h.close();
});

test('last_event_at moves on an admitted message only', async () => {
  const h = makeHarness();
  await h.send(h.at({ conversationId: 'GROUPNOTLISTED' }));
  assert.equal(h.store.getControl('last_event_at'), null);
  await h.sendAndFlush(h.at());
  assert.equal(h.store.getControl('last_event_at'), String(T0));
  await h.close();
});
