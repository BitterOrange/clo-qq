// Several people calling her by name in one window: who is judged, what merges into what, how the queued
// ones wait, and what they still have to pass before a decision is bought.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decisionOf, deferred, GROUP_A, GROUP_B, groupEntry, makeEffective, makeHarness, MEMBER, MEMBER2, OWNER, USAGE } from '../fixtures/inbound.mjs';

const MEMBER3 = 'THIRDMEMBER111122223333';
const MEMBER4 = 'FOURTHMEMBER11122223333';
const NAME_A = '可洛你看看退货怎么办';
const NAME_B = '可洛今天开会是几点';
const NAME_C = '可洛帮我想个标题吧';
const NAME_D = '可洛这本书好看吗';
const CHAT = '今天中午吃什么好呢';
const CRISIS = '我真的不想活了';
const TERMINAL = new Set(['ignored', 'stale', 'merged', 'paused', 'dry_run', 'skipped', 'completed', 'silent',
  'policy_dropped', 'failed', 'restart_dropped', 'crash_unknown']);
const tick = () => new Promise((r) => setImmediate(r));
const until = async (cond) => {
  for (let i = 0; i < 2000 && !cond(); i += 1) await tick();
  assert.ok(cond(), 'the expected state was never reached');
};
const quiet = { quietHours: { start: '00:00', end: '23:59', timezone: 'Asia/Shanghai' } };

async function flushWindow(h, ...events) {
  const sent = [];
  for (const e of events) sent.push(await h.send(e));
  h.advance(4000);
  await h.gate.idle();
  return sent;
}

// The decision about one text waits for the test to let it go; the rest answer at once.
function holding(text, answer = () => decisionOf()) {
  const hold = deferred();
  return {
    hold,
    decide: async (req) => {
      if (req.current.text === text) await hold.promise;
      return answer(req);
    },
  };
}

// A window whose first message is being decided on, so the others are already in the lane.
async function openHeld(h, ...events) {
  const sent = [];
  for (const e of events) sent.push(await h.send(e));
  h.advance(4000);
  await until(() => h.decideCalls.length === 1);
  return sent;
}

const texts = (h) => h.decideCalls.map((c) => c.current.text);

test('two people call her in one window: each is decided on and each can get a reply', async () => {
  const h = makeHarness();
  const [a, b] = await flushWindow(h, h.event({ text: NAME_A, senderId: MEMBER }), h.event({ text: NAME_B, senderId: MEMBER2 }));
  assert.deepEqual(texts(h), [NAME_A, NAME_B]);
  assert.deepEqual(h.decideCalls.map((c) => c.trigger), ['name', 'name']);
  assert.deepEqual(h.dispatched.map((t) => t.messageId), [a.messageId, b.messageId]);
  assert.deepEqual(h.dispatched.map((t) => t.cls), ['name_addressed', 'name_addressed']);
  assert.equal(h.state(a), 'completed:sent');
  assert.equal(h.state(b), 'completed:sent');
  assert.equal(h.row(a).merged_into, null);
  assert.equal(h.row(b).merged_into, null);
  await h.close();
});

test('each decision sees the other as context, and not itself; a turn holds only the one that has ended', async () => {
  const h = makeHarness();
  await flushWindow(h, h.event({ text: NAME_A, senderId: MEMBER }), h.event({ text: NAME_B, senderId: MEMBER2 }));
  assert.deepEqual(h.decideCalls[0].lines.map((l) => l.text), [NAME_B]);
  assert.deepEqual(h.decideCalls[1].lines.map((l) => l.text), [NAME_A]);
  assert.equal(h.decideCalls[0].current.sender, 'U1');
  assert.equal(h.decideCalls[1].current.sender, 'U2');
  assert.deepEqual(h.dispatched[0].history.map((l) => l.body), [], 'the second still has its own turn coming');
  assert.deepEqual(h.dispatched[1].history.map((l) => l.body), [NAME_A]);
  await h.close();
});

test('one person twice is one decision, on their last message', async () => {
  const h = makeHarness();
  const [a, b] = await flushWindow(h, h.event({ text: NAME_A }), h.event({ text: NAME_B }));
  assert.deepEqual(texts(h), [NAME_B]);
  assert.equal(h.state(a), 'merged:merged');
  assert.equal(h.row(a).merged_into, h.row(b).event_key);
  assert.equal(h.state(b), 'completed:sent');
  await h.close();
});

test('four people against a cap of three: the newest three are judged, in order', async () => {
  const h = makeHarness();
  assert.equal(h.eff.current.limits.nameWindowMax, 3);
  const [a, b, c, d] = await flushWindow(
    h,
    h.event({ text: NAME_A, senderId: MEMBER }),
    h.event({ text: NAME_B, senderId: MEMBER2 }),
    h.event({ text: NAME_C, senderId: MEMBER3 }),
    h.event({ text: NAME_D, senderId: MEMBER4 }),
  );
  assert.deepEqual(texts(h), [NAME_B, NAME_C, NAME_D]);
  assert.equal(h.state(a), 'merged:merged');
  assert.equal(h.row(a).merged_into, h.row(d).event_key, 'no selected message of theirs, so the last selected one');
  for (const e of [b, c, d]) assert.equal(h.state(e), 'completed:sent');
  await h.close();
});

test('what merges follows the same sender\'s name, else the last name', async () => {
  const h = makeHarness();
  const [mine, a, b, other] = await flushWindow(
    h,
    h.event({ text: CHAT, senderId: MEMBER }),
    h.event({ text: NAME_A, senderId: MEMBER }),
    h.event({ text: NAME_B, senderId: MEMBER2 }),
    h.event({ text: '另一个人的闲聊', senderId: MEMBER3 }),
  );
  assert.equal(h.row(mine).merged_into, h.row(a).event_key);
  assert.equal(h.row(other).merged_into, h.row(b).event_key);
  assert.equal(h.decideCalls.length, 2);
  await h.close();
});

test('one name in a window: ordinary messages still follow it, one decision, as before', async () => {
  const h = makeHarness();
  const [x, a, y] = await flushWindow(h, h.event({ text: CHAT, senderId: MEMBER2 }), h.event({ text: NAME_A }), h.event({ text: '后面的闲聊', senderId: MEMBER3 }));
  assert.deepEqual(texts(h), [NAME_A]);
  assert.equal(h.row(x).merged_into, h.row(a).event_key);
  assert.equal(h.row(y).merged_into, h.row(a).event_key);
  assert.equal(h.state(a), 'completed:sent');
  await h.close();
});

test('a crisis message that names no one runs first, and the names are still judged', async () => {
  const h = makeHarness({
    effective: makeEffective(quiet),
    decide: async (req) => (req.trigger === 'crisis_route' ? decisionOf({ crisis: true }) : decisionOf()),
  });
  const [chat, crisis, a, b] = await flushWindow(
    h,
    h.event({ text: CHAT, senderId: MEMBER4 }),
    h.event({ text: CRISIS, senderId: MEMBER3 }),
    h.event({ text: NAME_A, senderId: MEMBER }),
    h.event({ text: NAME_B, senderId: MEMBER2 }),
  );
  assert.deepEqual(h.decideCalls.map((c) => [c.trigger, c.current.text]), [['crisis_route', CRISIS], ['name', NAME_A], ['name', NAME_B]]);
  assert.deepEqual(h.dispatched.map((t) => t.messageId), [crisis.messageId, a.messageId, b.messageId]);
  assert.equal(h.dispatched[0].cls, 'crisis');
  assert.equal(h.state(crisis), 'completed:sent');
  assert.equal(h.row(crisis).merged_into, null);
  assert.equal(h.row(chat).merged_into, h.row(b).event_key, 'ordinary messages follow the name, not the crisis message');
  await h.close();
});

test('a crisis message is not merged when its own sender has a later name message', async () => {
  const h = makeHarness({ decide: async () => decisionOf({ action: 'skip' }) });
  const [crisis, later] = await flushWindow(h, h.event({ text: `可洛 ${CRISIS}` }), h.event({ text: NAME_A }));
  assert.deepEqual(texts(h), [`可洛 ${CRISIS}`, NAME_A], 'both decided, the crisis message first');
  assert.notEqual(h.decideCalls[0].trigger, 'name');
  assert.equal(h.decideCalls[1].trigger, 'name');
  assert.notEqual(h.row(crisis).state, 'merged');
  assert.notEqual(h.row(later).state, 'merged');
  await h.close();
});

test('a crisis message pushed out by the cap still runs', async () => {
  const h = makeHarness({ decide: async () => decisionOf({ action: 'skip' }) });
  const crisisText = `可洛 ${CRISIS}`;
  const [crisis] = await flushWindow(
    h,
    h.event({ text: crisisText, senderId: MEMBER }),
    h.event({ text: NAME_B, senderId: MEMBER2 }),
    h.event({ text: NAME_C, senderId: MEMBER3 }),
    h.event({ text: NAME_D, senderId: MEMBER4 }),
  );
  assert.deepEqual(texts(h), [crisisText, NAME_B, NAME_C, NAME_D]);
  assert.notEqual(h.row(crisis).state, 'merged');
  await h.close();
});

test('a crisis message that is a selected name takes the name path, ahead of the others', async () => {
  const h = makeHarness({ decide: async (req) => decisionOf({ crisis: req.current.text.includes(CRISIS) }) });
  const crisisText = `可洛 ${CRISIS}`;
  const [a, crisis] = await flushWindow(h, h.event({ text: NAME_A, senderId: MEMBER }), h.event({ text: crisisText, senderId: MEMBER2 }));
  assert.deepEqual(h.decideCalls.map((c) => [c.trigger, c.current.text]), [['name', crisisText], ['name', NAME_A]]);
  assert.equal(h.state(a), 'completed:sent');
  assert.equal(h.state(crisis), 'completed:sent');
  assert.equal(h.decideCalls.length, 2, 'one decision each, no extra crisis_route');
  await h.close();
});

test('with interjection off a crisis message opens nothing, and the names still get their decisions', async () => {
  const h = makeHarness({ effective: makeEffective({ qq: { groups: { [GROUP_A]: groupEntry({ interject: false }) } } }), decide: async () => decisionOf({ action: 'skip' }) });
  await flushWindow(h, h.event({ text: CRISIS, senderId: MEMBER3 }), h.event({ text: NAME_A, senderId: MEMBER }), h.event({ text: NAME_B, senderId: MEMBER2 }));
  assert.deepEqual(h.decideCalls.map((c) => [c.trigger, c.current.text]), [['name', NAME_A], ['name', NAME_B]]);
  await h.close();
});

test('every record reaches one terminal state, once', async () => {
  const h = makeHarness({ decide: async (req) => decisionOf(req.current.text === NAME_C ? { action: 'skip' } : {}) });
  const sent = await flushWindow(
    h,
    h.event({ text: CHAT, senderId: MEMBER4 }),
    h.event({ text: NAME_D, senderId: MEMBER4 }),
    h.event({ text: CRISIS, senderId: MEMBER }),
    h.event({ text: NAME_A, senderId: MEMBER }),
    h.event({ text: NAME_B, senderId: MEMBER2 }),
    h.event({ text: NAME_C, senderId: MEMBER3 }),
  );
  const ends = h.logs.filter((l) => l.event === 'gate_end' || l.event === 'turn_end');
  for (const e of sent) {
    const key = h.store.key(e.messageId);
    assert.ok(TERMINAL.has(h.row(e).state), h.state(e));
    assert.equal(ends.filter((l) => l.eventKey === key).length, 1, h.state(e));
  }
  assert.equal(h.state(sent[0]), 'merged:merged');
  assert.equal(h.state(sent[5]), 'skipped:decision_skip', 'positive control: a skip is one of them');
  await h.close();
});

test('stop while the first is out: the queued ones end restart_dropped and buy nothing', async () => {
  const { hold, decide } = holding(NAME_A);
  const h = makeHarness({ decide });
  const [a, b, c] = await openHeld(h, h.event({ text: NAME_A, senderId: MEMBER }), h.event({ text: NAME_B, senderId: MEMBER2 }), h.event({ text: NAME_C, senderId: MEMBER3 }));
  const stopping = h.gate.stop();
  assert.equal(h.state(b), 'restart_dropped:restart');
  assert.equal(h.state(c), 'restart_dropped:restart');
  hold.resolve();
  await stopping;
  assert.equal(h.state(a), 'restart_dropped:restart', 'the decision came back after the stop');
  assert.equal(h.decideCalls.length, 1);
  assert.equal(h.dispatched.length, 0);
  assert.equal(h.reservations(b).length, 0);
  await h.close();
});

test('stop as the flush starts: the lane refuses, and the record still ends restart_dropped', async () => {
  const h = makeHarness();
  const a = await h.send(h.event({ text: NAME_A, senderId: MEMBER }));
  const b = await h.send(h.event({ text: NAME_B, senderId: MEMBER2 }));
  h.advance(4000);
  // The flush is scheduled for the next microtask, so the stop lands before it.
  const stopping = h.gate.stop();
  await stopping;
  assert.equal(h.state(b), 'restart_dropped:restart');
  assert.ok(TERMINAL.has(h.row(a).state), h.state(a));
  assert.equal(h.dispatched.length, 0);
  await h.close();
});

test('a real @ arriving while the first name is out is served before the queued name', async () => {
  const { hold, decide } = holding(NAME_A);
  const h = makeHarness({ decide });
  const [a, b] = await openHeld(h, h.event({ text: NAME_A, senderId: MEMBER }), h.event({ text: NAME_B, senderId: MEMBER2 }));
  const at = await h.send(h.at({ senderId: MEMBER3 }));
  hold.resolve();
  await h.gate.idle();
  assert.deepEqual(h.dispatched.map((t) => t.messageId), [a.messageId, at.messageId, b.messageId]);
  await h.close();
});

test('a real @ arriving while a queued name is out still goes ahead of the name after it', async () => {
  const { hold, decide } = holding(NAME_B);
  const h = makeHarness({ decide });
  const [a, b, c] = [h.event({ text: NAME_A, senderId: MEMBER }), h.event({ text: NAME_B, senderId: MEMBER2 }), h.event({ text: NAME_C, senderId: MEMBER3 })];
  for (const e of [a, b, c]) await h.send(e);
  h.advance(4000);
  await until(() => h.decideCalls.length === 2);
  const at = await h.send(h.at({ senderId: MEMBER4 }));
  hold.resolve();
  await h.gate.idle();
  assert.deepEqual(h.dispatched.map((t) => t.messageId), [a.messageId, b.messageId, at.messageId, c.messageId]);
  await h.close();
});

test('a pause landing while a name waits: no decision is bought for it, whichever pause it is', async () => {
  for (const control of [`group_paused:${'GROUP'}`, 'global_paused', 'terminal_close']) {
    const { hold, decide } = holding(NAME_A);
    const h = makeHarness({ decide });
    const [a, b] = await openHeld(h, h.event({ text: NAME_A, senderId: MEMBER }), h.event({ text: NAME_B, senderId: MEMBER2 }));
    h.store.setControl(control.replace('GROUP', h.store.key(GROUP_A)), '1', 'test');
    hold.resolve();
    await h.gate.idle();
    assert.equal(h.state(a), 'paused:paused', control);
    assert.equal(h.state(b), 'paused:paused', control);
    assert.deepEqual(texts(h), [NAME_A], control);
    assert.equal(h.reservations(b).length, 0, control);
    await h.close();
  }
});

test('what changed while a name waited is read fresh: admission, mode and the name switch', async () => {
  const moves = [
    ['ignored:admission', (h) => { delete h.eff.current.qq.groups[GROUP_A]; }],
    ['dry_run:would_name', (h) => { h.eff.current.mode = 'dry-run'; }],
    ['skipped:name_off', (h) => { h.eff.current.qq.groups[GROUP_A].nameMention = false; }],
    ['ignored:admission', (h) => { h.eff.current = null; }],
    ['ignored:admission', (h) => { h.eff.current.qq.enabled = false; }],
  ];
  for (const [expected, move] of moves) {
    const { hold, decide } = holding(NAME_A, () => decisionOf({ action: 'skip' }));
    const h = makeHarness({ decide });
    const [, b] = await openHeld(h, h.event({ text: NAME_A, senderId: MEMBER }), h.event({ text: NAME_B, senderId: MEMBER2 }));
    move(h);
    hold.resolve();
    await h.gate.idle();
    assert.equal(h.state(b), expected);
    assert.deepEqual(texts(h), [NAME_A], expected);
    await h.close();
  }
});

test('a name that waited past the dispatch deadline buys nothing and raises the alert', async () => {
  const { hold, decide } = holding(NAME_A, () => decisionOf({ action: 'skip' }));
  const h = makeHarness({ decide });
  const [, b] = await openHeld(h, h.event({ text: NAME_A, senderId: MEMBER }), h.event({ text: NAME_B, senderId: MEMBER2 }));
  h.clock.t += 180001;
  hold.resolve();
  await h.gate.idle();
  assert.equal(h.state(b), 'skipped:expired_before_dispatch');
  assert.deepEqual(texts(h), [NAME_A]);
  assert.equal(h.reservations(b).length, 0);
  assert.ok(h.store.listAlerts().some((al) => al.kind === 'expired_before_dispatch'));
  await h.close();
});

test('the per-sender check applies to a queued name, and danger still passes it', async () => {
  const h = makeHarness({ effective: makeEffective({ limits: { perSenderAddressedPerHour: 1 } }) });
  await h.sendAndFlush(h.at({ senderId: MEMBER2 }));
  await h.sendAndFlush(h.at({ senderId: MEMBER3 }));
  const before = h.decideCalls.length;
  const crisisText = `可洛 ${NAME_C} ${CRISIS}`;
  const [a, b, c] = await flushWindow(
    h,
    h.event({ text: NAME_A, senderId: MEMBER }),
    h.event({ text: NAME_B, senderId: MEMBER2 }),
    h.event({ text: crisisText, senderId: MEMBER3 }),
  );
  assert.equal(h.state(b), 'skipped:sender_rate');
  assert.deepEqual(h.decideCalls.slice(before).map((d) => d.current.text).sort(), [NAME_A, crisisText].sort(), 'no decision for the one at their limit');
  assert.equal(h.state(a), 'completed:sent', 'positive control: another member is not affected');
  assert.ok(TERMINAL.has(h.row(c).state));
  await h.close();
});

test('someone at their limit whose queued name suggests danger still reaches the decision', async () => {
  const h = makeHarness({ effective: makeEffective({ limits: { perSenderAddressedPerHour: 0 } }), decide: async () => decisionOf({ action: 'skip' }) });
  const queued = `可洛 ${CRISIS}`;
  const lead = `可洛 ${CRISIS} 真的`;
  await flushWindow(h, h.event({ text: queued, senderId: MEMBER }), h.event({ text: lead, senderId: MEMBER2 }));
  assert.deepEqual(texts(h), [lead, queued], 'the later one is the rescue candidate, so the earlier one was queued');
  await h.close();
});

test('the per-group name cap stops the third decision in a window', async () => {
  const h = makeHarness({ effective: makeEffective({ limits: { nameDecisionsPerGroupPerHour: 2 } }) });
  const [a, b, c] = await flushWindow(h, h.event({ text: NAME_A, senderId: MEMBER }), h.event({ text: NAME_B, senderId: MEMBER2 }), h.event({ text: NAME_C, senderId: MEMBER3 }));
  assert.deepEqual(texts(h), [NAME_A, NAME_B]);
  assert.equal(h.state(a), 'completed:sent');
  assert.equal(h.state(b), 'completed:sent');
  assert.equal(h.state(c), 'skipped:decision_cap');
  assert.equal(h.reservations(c).length, 0);
  await h.close();
});

test('the daily and hourly decision caps count each judged name', async () => {
  for (const limits of [{ decisionsPerDay: 1 }, { decisionsPerGroupPerHour: 1 }]) {
    const h = makeHarness({ effective: makeEffective({ limits }) });
    const [, b] = await flushWindow(h, h.event({ text: NAME_A, senderId: MEMBER }), h.event({ text: NAME_B, senderId: MEMBER2 }));
    assert.deepEqual(texts(h), [NAME_A]);
    assert.equal(h.state(b), 'skipped:decision_cap');
    await h.close();
  }
});

test('a full lane ends that name as queue_full; the others are not touched', async () => {
  const h = makeHarness({ effective: makeEffective({ window: { maxPending: 2 } }) });
  const a = await h.send(h.event({ text: NAME_A, senderId: MEMBER }));
  const b = await h.send(h.event({ text: NAME_B, senderId: MEMBER2 }));
  h.advance(4000);
  // In the gap before the flush runs: the lane drains ahead of a flush, so this is the only way it fills.
  const ats = [h.at({ senderId: MEMBER3 }), h.at({ senderId: MEMBER4 })];
  const admitted = ats.map((e) => h.gate.onInbound(e));
  await Promise.all(admitted);
  await h.gate.idle();
  assert.equal(h.state(b), 'skipped:queue_full');
  assert.deepEqual(texts(h), [NAME_A]);
  assert.equal(h.state(a), 'completed:sent');
  for (const e of ats) assert.equal(h.state(e), 'completed:sent');
  await h.close();
});

test('one queued failure does not touch the others', async () => {
  const h = makeHarness();
  const realPeek = h.store.peekCounter;
  let calls = 0;
  h.store.peekCounter = (...args) => {
    calls += 1;
    if (calls === 2) throw new Error('disk trouble');
    return realPeek(...args);
  };
  const [a, b, c] = await flushWindow(h, h.event({ text: NAME_A, senderId: MEMBER }), h.event({ text: NAME_B, senderId: MEMBER2 }), h.event({ text: NAME_C, senderId: MEMBER3 }));
  assert.equal(h.state(a), 'completed:sent');
  assert.equal(h.state(b), 'failed:gate_error');
  assert.equal(h.state(c), 'completed:sent');
  assert.deepEqual(texts(h), [NAME_A, NAME_C]);
  await h.close();
});

test('with nameMention off, name words are ordinary: one decision, as before', async () => {
  const h = makeHarness({ effective: makeEffective({ qq: { groups: { [GROUP_A]: groupEntry({ nameMention: false }) } } }) });
  const [a, b] = await flushWindow(h, h.event({ text: NAME_A, senderId: MEMBER }), h.event({ text: NAME_B, senderId: MEMBER2 }));
  assert.equal(h.decideCalls.length, 1);
  assert.equal(h.decideCalls[0].trigger, 'ordinary');
  assert.equal(h.state(a), 'merged:merged');
  assert.equal(h.row(a).merged_into, h.row(b).event_key);
  await h.close();
});

test('QQ switched off while a decision is out: nothing is held or dispatched for it', async () => {
  const { hold, decide } = holding(NAME_A);
  const h = makeHarness({ decide });
  const [a, b] = await openHeld(h, h.event({ text: NAME_A, senderId: MEMBER }), h.event({ text: NAME_B, senderId: MEMBER2 }));
  h.eff.current.qq.enabled = false;
  hold.resolve();
  await h.gate.idle();
  assert.equal(h.state(a), 'ignored:admission');
  assert.equal(h.state(b), 'ignored:admission');
  assert.equal(h.dispatched.length, 0);
  assert.equal(h.reservations(a).filter((r) => r.category === 'reply').length, 0);
  assert.equal(h.reservations(b).length, 0);
  await h.close();
});

test('a window closed while QQ is off buys nothing', async () => {
  const h = makeHarness();
  const a = await h.send(h.event({ text: NAME_A }));
  h.eff.current.qq.enabled = false;
  h.advance(4000);
  await h.gate.idle();
  assert.equal(h.state(a), 'ignored:admission');
  assert.equal(h.decideCalls.length, 0);
  await h.close();
});

// Three names whose turns each take long, then a crisis message arriving just after their window has closed.
async function crisisBehindNames(turnMs, names) {
  const first = deferred();
  let n = 0;
  const h = makeHarness({
    decide: async (req) => decisionOf({ crisis: req.current.text === CRISIS }),
    dispatch: async () => {
      n += 1;
      if (n === 1) await first.promise;
      h.clock.t += turnMs;
      return { started: true, hostError: false, aborted: false, usage: USAGE };
    },
  });
  const senders = [MEMBER, MEMBER2, MEMBER3];
  for (let i = 0; i < names.length; i += 1) await h.send(h.event({ text: names[i], senderId: senders[i] }));
  h.advance(4000);
  await until(() => h.dispatched.length === 1);
  h.advance(1000);
  const crisis = await h.send(h.event({ text: CRISIS, senderId: MEMBER4 }));
  h.advance(4000);
  first.resolve();
  await h.gate.idle();
  return { h, crisis };
}

test('a crisis message in the next window does not expire behind names queued from the last one', async () => {
  const slow = await crisisBehindNames(85000, [NAME_A, NAME_B, NAME_C]);
  assert.equal(slow.h.state(slow.crisis), 'completed:sent');
  assert.deepEqual(slow.h.dispatched.map((t) => t.cls).slice(0, 2), ['name_addressed', 'crisis'], 'after the turn already running, ahead of the queued names');
  await slow.h.close();
  const quick = await crisisBehindNames(20000, [NAME_A, NAME_B, NAME_C]);
  assert.deepEqual(quick.h.dispatched.map((t) => t.cls), ['name_addressed', 'crisis', 'name_addressed', 'name_addressed'], 'the names still get their turns');
  await quick.h.close();
});

test('an ordinary window still waits behind queued names', async () => {
  const first = deferred();
  let n = 0;
  const h = makeHarness({ dispatch: async () => {
    n += 1;
    if (n === 1) await first.promise;
    return { started: true, hostError: false, aborted: false, usage: USAGE };
  } });
  await h.send(h.event({ text: NAME_A, senderId: MEMBER }));
  const b = await h.send(h.event({ text: NAME_B, senderId: MEMBER2 }));
  h.advance(4000);
  await until(() => h.dispatched.length === 1);
  const chat = await h.send(h.event({ text: CHAT, senderId: MEMBER4 }));
  h.advance(4000);
  first.resolve();
  await h.gate.idle();
  assert.deepEqual(h.dispatched.map((t) => t.messageId).slice(1), [b.messageId, chat.messageId]);
  await h.close();
});

const closed = (over = {}) => makeEffective({ qq: { groups: { [GROUP_A]: groupEntry({ interject: false, ...over }) } } });
const answersCrisis = async (req) => decisionOf({ crisis: req.current.text.includes(CRISIS) });
const ends = (h, e) => h.logs.filter((l) => (l.event === 'gate_end' || l.event === 'turn_end') && l.eventKey === h.store.key(e.messageId)).length;

test('interjection off: a name message in danger is judged, though the same person spoke again', async () => {
  const h = makeHarness({ effective: closed(), decide: answersCrisis });
  const text = `可洛 ${CRISIS}`;
  const [crisis, later] = await flushWindow(h, h.event({ text }), h.event({ text: '可洛算了' }));
  assert.deepEqual(h.decideCalls.map((c) => [c.trigger, c.current.text]), [['name', text], ['name', '可洛算了']], 'the danger first');
  assert.equal(h.row(crisis).merged_into, null);
  assert.equal(h.state(crisis), 'completed:sent');
  assert.equal(h.dispatched[0].messageId, crisis.messageId);
  assert.equal(h.dispatched[0].cls, 'crisis');
  assert.equal(h.state(later), 'completed:sent');
  await h.close();
});

test('interjection off: a name message in danger is not pushed out by the window cap', async () => {
  const h = makeHarness({ effective: closed(), decide: answersCrisis });
  const text = `可洛 ${CRISIS}`;
  const sent = await flushWindow(
    h,
    h.event({ text, senderId: MEMBER }),
    h.event({ text: NAME_B, senderId: MEMBER2 }),
    h.event({ text: NAME_C, senderId: MEMBER3 }),
    h.event({ text: NAME_D, senderId: MEMBER4 }),
  );
  assert.deepEqual(texts(h), [text, NAME_B, NAME_C, NAME_D]);
  assert.equal(h.row(sent[0]).merged_into, null);
  assert.deepEqual(h.dispatched.map((t) => t.cls), ['crisis', 'name_addressed', 'name_addressed', 'name_addressed'], 'the reply in crisis goes to the one in danger');
  for (const e of sent) assert.equal(ends(h, e), 1);
  await h.close();
});

test('the latch and a flood do not merge a name message in danger either', async () => {
  const text = `可洛 ${CRISIS}`;
  const latched = makeHarness({ decide: answersCrisis });
  latched.store.setControl('interject_paused', '1', 'test');
  const [a] = await flushWindow(latched, latched.event({ text }), latched.event({ text: '可洛算了' }));
  assert.equal(latched.row(a).merged_into, null);
  assert.equal(latched.state(a), 'completed:sent');
  await latched.close();

  const flood = makeHarness({ decide: answersCrisis });
  const chatter = Array.from({ length: 12 }, (_, i) => flood.event({ text: `闲聊第${i}句话题`, senderId: MEMBER2 }));
  const [b] = await flushWindow(flood, flood.event({ text }), flood.event({ text: '可洛算了' }), ...chatter);
  assert.equal(flood.row(b).merged_into, null);
  assert.equal(flood.state(b), 'completed:sent');
  assert.equal(flood.state(chatter[0]), 'merged:merged', 'positive control: the chatter still merges');
  await flood.close();
});

test('two people in danger in one window: each gets a decision, and neither merges into an unrelated question', async () => {
  const h = makeHarness({ decide: answersCrisis });
  const x = h.event({ text: CRISIS, senderId: MEMBER });
  const y = h.event({ text: `我也${CRISIS}`, senderId: MEMBER2 });
  const z = h.event({ text: '可洛今天几点', senderId: MEMBER3 });
  await flushWindow(h, x, y, z);
  assert.deepEqual(texts(h), [y.text, x.text, z.text], 'danger ahead of the name');
  for (const e of [x, y, z]) {
    assert.equal(h.row(e).merged_into, null);
    assert.equal(ends(h, e), 1);
  }
  assert.deepEqual(h.dispatched.map((t) => t.cls), ['crisis', 'crisis', 'name_addressed']);
  await h.close();
});

test('two people in danger, no name: both still run', async () => {
  const h = makeHarness({ decide: answersCrisis });
  const [x, y] = await flushWindow(h, h.event({ text: CRISIS, senderId: MEMBER }), h.event({ text: `我也${CRISIS}`, senderId: MEMBER2 }));
  assert.equal(h.decideCalls.length, 2);
  assert.equal(h.state(x), 'completed:sent');
  assert.equal(h.state(y), 'completed:sent');
  await h.close();
});

test('someone in danger who also called her, beside a second person in danger: all three are judged', async () => {
  const h = makeHarness({ decide: answersCrisis });
  const text = `可洛 ${CRISIS}`;
  const [x1, x2, y] = await flushWindow(h, h.event({ text, senderId: MEMBER }), h.event({ text: '可洛算了', senderId: MEMBER }), h.event({ text: `我也${CRISIS}`, senderId: MEMBER2 }));
  assert.equal(h.decideCalls.length, 3);
  for (const e of [x1, x2, y]) assert.equal(h.row(e).merged_into, null);
  await h.close();
});

test('one person repeating a danger message in a window is one turn, on the last', async () => {
  const h = makeHarness({ decide: answersCrisis });
  const [a, b] = await flushWindow(h, h.event({ text: CRISIS }), h.event({ text: `${CRISIS}吧` }));
  assert.deepEqual(texts(h), [`${CRISIS}吧`]);
  assert.equal(h.state(a), 'merged:merged');
  assert.equal(h.row(a).merged_into, h.row(b).event_key);
  await h.close();
});

test('a person in danger queued after the first still passes the checks read fresh', async () => {
  const hold = deferred();
  let n = 0;
  const h = makeHarness({ decide: async (req) => {
    n += 1;
    if (n === 1) await hold.promise;
    return answersCrisis(req);
  } });
  const x = await h.send(h.event({ text: CRISIS, senderId: MEMBER }));
  await h.send(h.event({ text: `我也${CRISIS}`, senderId: MEMBER2 }));
  h.advance(4000);
  await until(() => h.decideCalls.length === 1);
  h.store.setControl('global_paused', '1', 'test');
  hold.resolve();
  await h.gate.idle();
  assert.equal(h.state(x), 'paused:paused');
  assert.equal(h.decideCalls.length, 1);
  await h.close();
});

const ownerStop = (h) => h.event({ text: '/stop', senderId: OWNER, isRealAt: true });

test('/stop while a name is being answered: the names queued behind it buy nothing and post nothing', async () => {
  const hold = deferred();
  let n = 0;
  const h = makeHarness({ dispatch: async (turn) => {
    n += 1;
    if (n === 1) await hold.promise;
    return { started: true, hostError: false, aborted: false, usage: turn.authorizedCommand ? null : USAGE };
  } });
  const a = await h.send(h.event({ text: NAME_A, senderId: MEMBER }));
  const b = await h.send(h.event({ text: NAME_B, senderId: MEMBER2 }));
  const c = await h.send(h.event({ text: NAME_C, senderId: MEMBER3 }));
  h.advance(4000);
  await until(() => h.dispatched.length === 1);
  await h.send(ownerStop(h));
  hold.resolve();
  await h.gate.idle();
  assert.equal(h.state(a), 'failed:aborted');
  for (const e of [b, c]) {
    assert.equal(h.state(e), 'skipped:owner_stop');
    assert.equal(h.reservations(e).length, 0);
  }
  assert.deepEqual(texts(h), [NAME_A]);
  assert.equal(h.exit.fixed.length, 0);
  assert.deepEqual(h.dispatched.map((t) => t.authorizedCommand ?? t.messageId), [a.messageId, '/stop']);
  await h.close();
});

test('/stop while a name is still being decided on: its reply does not start', async () => {
  const { hold, decide } = holding(NAME_A);
  const h = makeHarness({ decide });
  const [a] = await openHeld(h, h.event({ text: NAME_A, senderId: MEMBER }));
  await h.send(ownerStop(h));
  hold.resolve();
  await h.gate.idle();
  assert.equal(h.state(a), 'skipped:owner_stop');
  assert.deepEqual(h.dispatched.map((t) => t.authorizedCommand), ['/stop']);
  assert.equal(h.exit.fixed.length, 0);
  await h.close();
});

test('/stop leaves alone a name said after it, another group, and a person in danger', async () => {
  const { hold, decide } = holding(NAME_A);
  const h = makeHarness({ decide });
  const danger = `可洛 ${CRISIS}`;
  await openHeld(h, h.event({ text: NAME_A, senderId: MEMBER }));
  const elsewhere = await h.send(h.event({ text: NAME_C, senderId: MEMBER3, conversationId: GROUP_B }));
  await h.send(ownerStop(h));
  hold.resolve();
  const after = await h.send(h.event({ text: NAME_B, senderId: MEMBER2 }));
  h.advance(4000);
  await h.gate.idle();
  assert.equal(h.state(after), 'completed:sent', 'said after the stop');
  assert.equal(h.state(elsewhere), 'completed:sent', 'said before it, in another group');
  await h.close();

  const hold2 = deferred();
  let n = 0;
  const g = makeHarness({ decide: async () => {
    n += 1;
    if (n === 1) await hold2.promise;
    return decisionOf({ crisis: true });
  } });
  const x = await g.send(g.event({ text: danger, senderId: MEMBER }));
  await g.send(g.event({ text: `${danger}吧`, senderId: MEMBER2 }));
  g.advance(4000);
  await until(() => g.decideCalls.length === 1);
  await g.send(ownerStop(g));
  hold2.resolve();
  await g.gate.idle();
  assert.equal(g.decideCalls.length, 2, 'the queued one in danger is still looked at');
  assert.notEqual(g.state(x), 'skipped:owner_stop');
  await g.close();
});
