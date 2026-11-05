// Crisis in a merged window, what the buffer keeps across reset, pause and dry-run, the per-sender cap on
// named replies, and config moving while a decision is out.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decisionOf, deferred, GROUP_A, GROUP_B, groupEntry, makeEffective, makeHarness, MEMBER, MEMBER2, OWNER, T0 } from '../fixtures/inbound.mjs';

const CRISIS = '我真的不想活了';
const CHAT = '今天中午吃什么好呢';
const NAME = '可洛今天真好看';
const MIN = 60000;

async function flushWindow(h, ...events) {
  const sent = [];
  for (const e of events) sent.push(await h.send(e));
  h.advance(4000);
  await h.gate.idle();
  return sent;
}

const effectiveWith = (group = {}, over = {}) => makeEffective({ qq: { groups: { [GROUP_A]: groupEntry(group) } }, ...over });
const quiet = { quietHours: { start: '00:00', end: '23:59', timezone: 'Asia/Shanghai' } };

test('positive control: a crisis message alone is decided on, and a crisis answer is dispatched', async () => {
  const h = makeHarness({ decide: async () => decisionOf({ crisis: true }) });
  const [a] = await flushWindow(h, h.event({ text: CRISIS }));
  assert.equal(h.decideCalls[0].current.text, CRISIS);
  assert.equal(h.dispatched[0].text, CRISIS);
  assert.equal(h.state(a), 'completed:sent');
  await h.close();
});

test('a crisis message followed by someone else\'s chat is what the decision is about', async () => {
  const h = makeHarness({ decide: async () => decisionOf({ crisis: true }) });
  const [a, b] = await flushWindow(h, h.event({ text: CRISIS, senderId: MEMBER }), h.event({ text: CHAT, senderId: MEMBER2 }));
  assert.equal(h.decideCalls.length, 1);
  assert.equal(h.decideCalls[0].current.text, CRISIS);
  assert.ok(h.decideCalls[0].lines.some((l) => l.text === CHAT), 'the rest of the window is context');
  assert.equal(h.dispatched[0].text, CRISIS);
  assert.equal(h.dispatched[0].messageId, a.messageId, 'the reply answers that message');
  assert.equal(h.state(b), 'merged:merged');
  await h.close();
});

test('a crisis message followed by a name mention is decided first, and the name is not lost', async () => {
  const h = makeHarness({ decide: async () => decisionOf({ action: 'skip' }) });
  await flushWindow(h, h.event({ text: CRISIS, senderId: MEMBER }), h.event({ text: NAME, senderId: MEMBER2 }));
  assert.equal(h.decideCalls.length, 2);
  assert.equal(h.decideCalls[0].current.text, CRISIS);
  assert.notEqual(h.decideCalls[0].trigger, 'name');
  assert.equal(h.decideCalls[1].current.text, NAME);
  assert.equal(h.decideCalls[1].trigger, 'name');
  await h.close();
});

test('during quiet hours the same window goes through crisis_route on that message', async () => {
  const h = makeHarness({ effective: effectiveWith({}, quiet), decide: async () => decisionOf({ action: 'skip' }) });
  await flushWindow(h, h.event({ text: CRISIS, senderId: MEMBER }), h.event({ text: CHAT, senderId: MEMBER2 }));
  assert.equal(h.decideCalls.length, 1);
  assert.equal(h.decideCalls[0].trigger, 'crisis_route');
  assert.equal(h.decideCalls[0].current.text, CRISIS);
  await h.close();
});

test('a crisis message that also hits a local rule is still seen by the decision, as the current text', async () => {
  const h = makeHarness({ decide: async () => decisionOf({ action: 'skip' }) });
  const text = `${CRISIS} 加我 约炮`;
  assert.equal(h.policy.check(text).hit, true, 'the rule is live');
  await flushWindow(h, h.event({ text, senderId: MEMBER }), h.event({ text: CHAT, senderId: MEMBER2 }));
  assert.equal(h.decideCalls[0].trigger, 'crisis_route');
  assert.equal(h.decideCalls[0].current.text, text);
  await h.close();
});

test('with the per-sender crisis cap used up, the window falls back to its usual representative', async () => {
  const h = makeHarness({ effective: effectiveWith({}, { limits: { crisisRoutePerSenderPerHour: 0 } }), decide: async () => decisionOf({ action: 'skip' }) });
  await flushWindow(h, h.event({ text: CRISIS, senderId: MEMBER }), h.event({ text: CHAT, senderId: MEMBER2 }));
  assert.equal(h.decideCalls[0].current.text, CHAT);
  await h.close();
});

test('interjection off: the crisis list does not open a group, and a name in the window keeps its decision', async () => {
  const h = makeHarness({ effective: effectiveWith({ interject: false }), decide: async () => decisionOf({ action: 'skip' }) });
  await flushWindow(h, h.event({ text: CRISIS, senderId: MEMBER }), h.event({ text: NAME, senderId: MEMBER2 }));
  assert.equal(h.decideCalls.length, 1);
  assert.equal(h.decideCalls[0].trigger, 'name');
  assert.equal(h.decideCalls[0].current.text, NAME);
  await h.close();
});

test('owner /reset and /new clear the buffer: the next turn uploads none of it', async () => {
  for (const command of ['/reset', '/new']) {
    const h = makeHarness();
    await flushWindow(h, h.event({ text: '一段普通聊天 CANARY' }));
    h.advance(10 * MIN);
    await h.sendAndFlush(h.at({ text: '第一问 CANARY2' }));
    const before = h.dispatched.at(-1).history;
    assert.ok(before.some((l) => l.body.includes('CANARY')), 'positive control: it was in the buffer');
    await h.sendAndFlush(h.at({ text: command, senderId: OWNER }));
    assert.equal(h.exit.finished.length >= 2, true);
    await h.sendAndFlush(h.at({ text: '下一问' }));
    assert.deepEqual(h.dispatched.at(-1).history, [], command);
    await h.close();
  }
});

test('/stop and /status do not clear the buffer', async () => {
  const h = makeHarness();
  await flushWindow(h, h.event({ text: '一段普通聊天 CANARY' }));
  await h.sendAndFlush(h.at({ text: '/status', senderId: OWNER }));
  await h.sendAndFlush(h.at({ text: '/stop', senderId: OWNER }));
  h.advance(10 * MIN);
  await h.sendAndFlush(h.at({ text: '下一问' }));
  assert.ok(h.dispatched.at(-1).history.some((l) => l.body.includes('CANARY')));
  await h.close();
});

test('text sent while paused never reaches the buffer, group or global; text before the pause does', async () => {
  for (const key of ['global_paused', `group_paused`]) {
    const h = makeHarness();
    const name = key === 'group_paused' ? `group_paused:${h.store.key(GROUP_A)}` : key;
    await flushWindow(h, h.event({ text: '暂停之前的话' }));
    h.advance(10 * MIN);
    h.store.setControl(name, '1', 'test');
    const paused = await h.send(h.event({ text: '暂停期间说的私事CANARY' }));
    assert.equal(h.state(paused), 'paused:paused');
    h.store.delControl(name);
    await h.sendAndFlush(h.at({ text: '恢复后第一问' }));
    const bodies = h.dispatched.at(-1).history.map((l) => l.body);
    assert.ok(bodies.includes('暂停之前的话'), 'positive control');
    assert.ok(!bodies.some((b) => b.includes('CANARY')), key);
    await h.close();
  }
});

test('text seen in dry-run is not uploaded once the mode goes live', async () => {
  const h = makeHarness({ effective: effectiveWith({}, { mode: 'dry-run' }) });
  await h.send(h.event({ text: '告知之前的话CANARY' }));
  h.eff.current.mode = 'live';
  await h.sendAndFlush(h.at({ text: '上线后第一问' }));
  assert.deepEqual(h.dispatched.at(-1).history, []);
  await h.close();
});

test('named replies count against the per-sender hourly cap at the real limit, shared with @', async () => {
  const h = makeHarness();
  assert.equal(h.eff.current.limits.perSenderAddressedPerHour, 10, 'this test is about the real limit');
  const states = [];
  for (let i = 0; i < 12; i += 1) {
    states.push(h.state(await h.sendAndFlush(h.event({ text: `可洛你知道这个问题${i}吗` }))));
    h.advance(1000);
  }
  assert.deepEqual(states, [...new Array(10).fill('completed:sent'), 'skipped:sender_rate', 'skipped:sender_rate']);
  assert.equal(h.dispatched.length, 10);
  assert.equal(h.decideCalls.length, 10, 'no decision is bought past the limit');
  const at = await h.sendAndFlush(h.at());
  assert.equal(h.state(at), 'skipped:sender_rate', 'the same count as @');
  const other = await h.sendAndFlush(h.event({ text: '可洛你也看看这个吗', senderId: MEMBER2 }));
  assert.equal(h.state(other), 'completed:sent', 'positive control: another member is not affected');
  await h.close();
});

test('the cap applies when decisions were in flight together: the reply slot is taken after the decision', async () => {
  const eff = makeEffective({ limits: { perSenderAddressedPerHour: 1 } });
  const gates = deferred();
  const h = makeHarness({ effective: eff, decide: async () => { await gates.promise; return decisionOf(); } });
  const a = await h.send(h.event({ text: '可洛第一问是什么', senderId: MEMBER }));
  h.advance(4000);
  while (h.decideCalls.length === 0) await new Promise((r) => setImmediate(r));
  // Another group, since this group's queue is held by the decision. The count is per person.
  await h.send(h.at({ senderId: MEMBER, conversationId: GROUP_B }));
  while (h.dispatched.length === 0) await new Promise((r) => setImmediate(r));
  gates.resolve();
  await h.gate.idle();
  assert.equal(h.state(a), 'skipped:sender_rate');
  assert.equal(h.dispatched.length, 1, 'only the @');
  await h.close();
});

test('someone at the cap whose message suggests danger still reaches the decision', async () => {
  const h = makeHarness({ effective: makeEffective({ limits: { perSenderAddressedPerHour: 0 } }), decide: async () => decisionOf({ crisis: true }) });
  await flushWindow(h, h.event({ text: `可洛 ${CRISIS}` }));
  assert.equal(h.decideCalls.length, 1);
  assert.equal(h.dispatched.length, 1, 'crisis has its own caps');
  await h.close();
});

test('mode set to dry-run while a decision is out: no dispatch and no reply hold', async () => {
  const pending = deferred();
  const h = makeHarness({ decide: async () => { await pending.promise; return decisionOf(); } });
  const e = await h.send(h.event({ text: '有人知道怎么退货吗' }));
  h.advance(4000);
  while (h.decideCalls.length === 0) await new Promise((r) => setImmediate(r));
  h.eff.current.mode = 'dry-run';
  pending.resolve();
  await h.gate.idle();
  assert.equal(h.state(e), 'dry_run:would_window');
  assert.equal(h.dispatched.length, 0);
  assert.deepEqual(h.reservations(e).filter((r) => r.category === 'reply'), []);
  assert.equal(h.claims().at(-1).status, 'released');
  await h.close();
});

test('the interjection latch set while a decision is out: no dispatch and no reply hold', async () => {
  const pending = deferred();
  const h = makeHarness({ decide: async () => { await pending.promise; return decisionOf(); } });
  const e = await h.send(h.event({ text: '有人知道怎么退货吗' }));
  h.advance(4000);
  while (h.decideCalls.length === 0) await new Promise((r) => setImmediate(r));
  h.store.setControl('interject_paused', 'platform_violation', 'test');
  pending.resolve();
  await h.gate.idle();
  assert.equal(h.state(e), 'skipped:interject_latch');
  assert.equal(h.dispatched.length, 0);
  assert.deepEqual(h.reservations(e).filter((r) => r.category === 'reply'), []);
  await h.close();
});

test('positive control for the two above: with nothing moved, the same decision runs the turn', async () => {
  const pending = deferred();
  const h = makeHarness({ decide: async () => { await pending.promise; return decisionOf(); } });
  const e = await h.send(h.event({ text: '有人知道怎么退货吗' }, T0));
  h.advance(4000);
  while (h.decideCalls.length === 0) await new Promise((r) => setImmediate(r));
  pending.resolve();
  await h.gate.idle();
  assert.equal(h.state(e), 'completed:sent');
  assert.equal(h.dispatched.length, 1);
  await h.close();
});

test('a turn the provider stopped leaves its hold unsettled without pausing; a finished turn with no usage does pause', async () => {
  const failing = makeHarness({ dispatch: async () => ({ started: true, hostError: true, aborted: false, usage: null }) });
  failing.exit.result = { state: 'failed', reason: 'host_error' };
  const a = await failing.sendAndFlush(failing.at());
  assert.equal(failing.reservations(a)[0].status, 'unsettled');
  assert.equal(failing.store.getControl('paid_paused'), null);
  await failing.close();

  const aborted = makeHarness({ dispatch: async () => ({ started: true, hostError: false, aborted: true, usage: null }) });
  const b = await aborted.sendAndFlush(aborted.at());
  assert.equal(aborted.reservations(b)[0].status, 'unsettled');
  assert.equal(aborted.store.getControl('paid_paused'), null);
  await aborted.close();

  const silentBilling = makeHarness({ dispatch: async () => ({ started: true, hostError: false, aborted: false, usage: null }) });
  const c = await silentBilling.sendAndFlush(silentBilling.at());
  assert.equal(silentBilling.state(c), 'completed:sent');
  assert.equal(silentBilling.reservations(c)[0].status, 'unsettled');
  assert.equal(silentBilling.store.getControl('paid_paused'), 'usage_missing', 'the reply went out and its cost is unknown');
  await silentBilling.close();
});
