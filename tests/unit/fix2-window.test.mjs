// The addressed lane's cap once names queue in it, and the window count when an urgent window jumps the order.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGroupQueues } from '../../src/clo-plugin/lib/core/window.js';
import { decisionOf, deferred, makeEffective, makeHarness, USAGE } from '../fixtures/inbound.mjs';

const CRISIS = '我真的不想活了';
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => {
  for (let i = 0; i < 300; i += 1) await tick();
};
const member = (tag) => `${tag}MEMBER1111222233334444`.slice(0, 23);

function queues(over = {}) {
  const timers = new Map();
  let id = 0;
  const dropped = [];
  const q = createGroupQueues({
    windowMs: 4000,
    maxPending: 2,
    maxConcurrentTurns: 1,
    setTimer: (fn) => {
      id += 1;
      timers.set(id, fn);
      return id;
    },
    clearTimer: (t) => timers.delete(t),
    onDrop: (r) => dropped.push(r),
    isUrgent: (records) => records.includes('danger'),
    ...over,
  });
  const fire = () => {
    for (const [k, fn] of [...timers]) {
      timers.delete(k);
      fn();
    }
  };
  return { q, fire, dropped };
}

test('a lane full of yielding tasks still takes a real @, which runs first', async () => {
  const { q } = queues();
  const hold = deferred();
  const ran = [];
  const task = (name) => async () => {
    ran.push(name);
  };
  q.addressed('g', () => hold.promise, 'running');
  await tick();
  assert.equal(q.addressed('g', task('name1'), 'name1', { yielding: true }).ok, true);
  assert.equal(q.addressed('g', task('name2'), 'name2', { yielding: true }).ok, true);
  assert.deepEqual(q.addressed('g', task('name3'), 'name3', { yielding: true }), { ok: false, reason: 'queue_full' }, 'names stay bounded');
  assert.equal(q.addressed('g', task('at1'), 'at1').ok, true);
  assert.equal(q.addressed('g', task('at2'), 'at2').ok, true);
  assert.deepEqual(q.addressed('g', task('at3'), 'at3'), { ok: false, reason: 'queue_full' }, 'what does not yield keeps its own cap');
  hold.resolve();
  await q.idle();
  assert.deepEqual(ran, ['at1', 'at2', 'name1', 'name2']);
});

test('a name is refused while real @ tasks fill the lane', async () => {
  const { q } = queues();
  const hold = deferred();
  q.addressed('g', () => hold.promise, 'running');
  await tick();
  q.addressed('g', async () => {}, 'at1');
  q.addressed('g', async () => {}, 'at2');
  assert.deepEqual(q.addressed('g', async () => {}, 'name', { yielding: true }), { ok: false, reason: 'queue_full' });
  hold.resolve();
  await q.idle();
});

test('every task held in a lane past the old size is dropped once at stop', async () => {
  const { q, dropped } = queues();
  const hold = deferred();
  q.addressed('g', () => hold.promise, 'running');
  await tick();
  q.addressed('g', async () => {}, 'name1', { yielding: true });
  q.addressed('g', async () => {}, 'name2', { yielding: true });
  q.addressed('g', async () => {}, 'at1');
  q.addressed('g', async () => {}, 'at2');
  const stopping = q.stop();
  assert.deepEqual(dropped, ['at1', 'at2', 'name1', 'name2']);
  hold.resolve();
  await stopping;
});

test('an urgent window taken ahead of the others frees its own count', async () => {
  const { q, fire } = queues();
  const hold = deferred();
  const danger = deferred();
  q.addressed('g', () => hold.promise, 'running');
  await tick();
  q.addressed('g', async () => {}, 'name', { yielding: true });
  q.ordinary('g', 'chat', () => {});
  fire();
  q.ordinary('g', 'danger', () => danger.promise);
  fire();
  assert.equal(q.ordinary('g', 'over', () => {}).reason, 'queue_full', 'both windows count while they wait');
  hold.resolve();
  await settle();
  assert.equal(q.ordinary('g', 'room', () => {}).ok, true, 'the danger window started, ahead of the chat window, and left');
  assert.equal(q.ordinary('g', 'over2', () => {}).reason, 'queue_full', 'the chat window still counts');
  danger.resolve();
  fire();
  await q.idle();
});

test('urgent windows one after another do not use up the count', async () => {
  const { q, fire } = queues();
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(q.ordinary('g', 'danger', () => {}), { ok: true }, `window ${i}`);
    fire();
    await q.idle();
  }
});

test('through the gate: repeated crisis windows leave the group able to queue', async () => {
  const h = makeHarness({
    effective: makeEffective({ window: { maxPending: 2 } }),
    decide: async () => decisionOf({ crisis: true }),
  });
  for (const tag of ['A', 'B', 'C']) {
    const e = await h.send(h.event({ text: CRISIS, senderId: member(tag) }));
    h.advance(4000);
    await h.gate.idle();
    assert.equal(h.state(e), 'completed:sent', tag);
  }
  await h.close();
});

// One turn is held at a time. Each window that follows passes the names already queued.
function floodHarness(maxPending) {
  const running = [];
  const h = makeHarness({
    effective: makeEffective({ window: { maxPending } }),
    decide: async (req) => decisionOf(req.trigger === 'crisis_route' ? { crisis: true } : {}),
    dispatch: async () => {
      const d = deferred();
      running.push(d);
      await d.promise;
      return { started: true, hostError: false, aborted: false, usage: USAGE };
    },
  });
  const finish = async () => {
    running.shift()?.resolve();
    await settle();
  };
  const drain = async () => {
    for (let i = 0; i < 100 && running.length > 0; i += 1) {
      await finish();
      h.advance(4000);
      await settle();
    }
    await h.gate.idle();
  };
  return { h, finish, drain };
}

async function floodWindow(h, w, crisisText) {
  await h.send(h.event({ text: crisisText, senderId: member(`C${w}`) }));
  const names = [];
  for (const i of [1, 2, 3]) names.push(await h.send(h.event({ text: `可洛帮我看看第${w}个问题${i}`, senderId: member(`N${w}X${i}`) })));
  h.advance(4000);
  await settle();
  return names;
}

test('crisis windows flooding the lane with names: a real @ is still answered, ahead of them', async () => {
  const { h, finish, drain } = floodHarness(4);
  await h.send(h.at({ senderId: member('FIRST') }));
  await settle();
  await floodWindow(h, 1, CRISIS);
  await finish();
  const names = await floodWindow(h, 2, CRISIS);
  await finish();
  assert.ok(h.allEvents().some((e) => e.reason === 'queue_full'), 'the premise: the names have filled the lane');
  const started = h.dispatched.length;
  const at = await h.send(h.at({ senderId: member('REALAT'), text: '你好，这是真的 @' }));
  assert.equal(h.state(at), 'queued');
  await drain();
  assert.equal(h.state(at), 'completed:sent');
  assert.equal(h.dispatched[started].messageId, at.messageId, 'nothing queued before it goes first');
  for (const n of names) assert.notEqual(h.state(n), 'queued');
  await h.close();
});

test('a second person in danger is not refused by a lane full of names', async () => {
  const { h, finish, drain } = floodHarness(3);
  await h.send(h.at({ senderId: member('FIRST') }));
  await settle();
  await floodWindow(h, 1, `可洛 ${CRISIS}`);
  await finish();
  await floodWindow(h, 2, `可洛 ${CRISIS}`);
  await finish();
  assert.ok(h.allEvents().some((e) => e.reason === 'queue_full'), 'the premise: the names have filled the lane');
  const one = await h.send(h.event({ text: `可洛 ${CRISIS}`, senderId: member('DANGER1') }));
  const two = await h.send(h.event({ text: `可洛 ${CRISIS}`, senderId: member('DANGER2') }));
  h.advance(4000);
  await settle();
  await finish();
  assert.notEqual(h.state(one), 'skipped:queue_full');
  assert.notEqual(h.state(two), 'skipped:queue_full');
  await drain();
  assert.equal(h.state(one), 'completed:sent');
  assert.equal(h.state(two), 'completed:sent');
  await h.close();
});

test('chat at the cap does not refuse an urgent record, and urgent records keep a cap of their own', async () => {
  const { q, fire } = queues();
  const seen = [];
  const onFlush = (records) => {
    seen.push(records);
  };
  const hold = deferred();
  q.addressed('g', () => hold.promise, 'running');
  await tick();
  q.ordinary('g', 'chat1', onFlush);
  q.ordinary('g', 'chat2', onFlush);
  assert.equal(q.ordinary('g', 'chat3', onFlush).reason, 'queue_full', 'the premise: chat is at its cap');
  assert.deepEqual(q.ordinary('g', 'danger', onFlush), { ok: true });
  assert.deepEqual(q.ordinary('g', 'danger', onFlush), { ok: true });
  assert.equal(q.ordinary('g', 'danger', onFlush).reason, 'queue_full', 'still bounded');
  assert.equal(q.ordinary('g', 'chat4', onFlush).reason, 'queue_full');
  fire();
  hold.resolve();
  await q.idle();
  assert.deepEqual(seen, [['chat1', 'chat2', 'danger', 'danger']]);
});

test('an urgent record frees its own count when its window starts', async () => {
  const { q, fire, dropped } = queues();
  const onFlush = () => {};
  const hold = deferred();
  q.addressed('g', () => hold.promise, 'running');
  await tick();
  q.ordinary('g', 'danger', onFlush);
  q.ordinary('g', 'danger', onFlush);
  fire();
  assert.equal(q.ordinary('g', 'danger', onFlush).reason, 'queue_full', 'the premise: the room is taken');
  hold.resolve();
  await q.idle();
  assert.equal(q.ordinary('g', 'danger', onFlush).ok, true, 'room again once that window started');
  assert.equal(q.ordinary('g', 'danger', onFlush).ok, true);
  assert.equal(q.ordinary('g', 'danger', onFlush).reason, 'queue_full');
  fire();
  await q.idle();
  assert.equal(q.ordinary('g', 'a', onFlush).ok, true, 'and nothing of either count was left behind');
  assert.equal(q.ordinary('g', 'b', onFlush).ok, true);
  assert.equal(q.ordinary('g', 'c', onFlush).reason, 'queue_full');
  const stopping = q.stop();
  assert.deepEqual(dropped, ['a', 'b']);
  await stopping;
});

// The default maxPending, a slow turn, and a group that keeps talking.
for (const [label, text] of [['plain', CRISIS], ['naming her', `可洛 ${CRISIS}`]]) {
  test(`a slow turn and a full chat count: a crisis message, ${label}, is still taken and answered first`, async () => {
    const { h, finish, drain } = floodHarness(20);
    await h.send(h.at({ senderId: member('FIRST') }));
    await settle();
    for (let i = 0; i < 20; i += 1) {
      await h.send(h.event({ text: `今天的第${i}句闲聊内容`, senderId: member(`S${i}`) }));
      h.advance(2000);
      await settle();
    }
    const over = await h.send(h.event({ text: '第二十一句闲聊内容', senderId: member('OVER') }));
    assert.equal(h.state(over), 'skipped:queue_full', 'the premise: chat is at its cap');
    const danger = await h.send(h.event({ text, senderId: member('DANGER') }));
    assert.equal(h.state(danger), 'queued');
    h.advance(4000);
    await settle();
    const started = h.dispatched.length;
    await finish();
    assert.equal(h.dispatched[started].messageId, danger.messageId, 'no chat window goes before it');
    await drain();
    assert.equal(h.state(danger), 'completed:sent');
    assert.equal(h.store.listAlerts().filter((a) => a.kind === 'crisis_queue_full').length, 0);
    await h.close();
  });
}

test('a crisis message refused once its own room is full leaves an alert; chat refused does not', async () => {
  const { h, drain } = floodHarness(2);
  await h.send(h.at({ senderId: member('FIRST') }));
  await settle();
  await h.send(h.event({ text: '第一句闲聊内容', senderId: member('A') }));
  await h.send(h.event({ text: '第二句闲聊内容', senderId: member('B') }));
  const chat = await h.send(h.event({ text: '第三句闲聊内容', senderId: member('C') }));
  assert.equal(h.state(chat), 'skipped:queue_full');
  assert.equal(h.store.listAlerts().filter((a) => a.kind === 'crisis_queue_full').length, 0, 'chat raises nothing');
  await h.send(h.event({ text: CRISIS, senderId: member('D1') }));
  await h.send(h.event({ text: CRISIS, senderId: member('D2') }));
  const refused = await h.send(h.event({ text: CRISIS, senderId: member('D3') }));
  assert.equal(h.state(refused), 'skipped:queue_full');
  assert.equal(h.store.listAlerts().filter((a) => a.kind === 'crisis_queue_full').length, 1);
  h.advance(4000);
  await settle();
  await drain();
  await h.close();
});

// A running task holds the lane still, so what is queued can be counted before anything starts.
async function heldLane(over = {}) {
  const set = queues({ urgentExtra: 2, urgentPerSender: 1, urgentKey: (r) => r.sender ?? null, ...over });
  const hold = deferred();
  const ran = [];
  const task = (name) => async () => {
    ran.push(name);
  };
  set.q.addressed('g', () => hold.promise, { sender: 'running' });
  await tick();
  return { ...set, hold, ran, task };
}

test('a full lane still takes urgent work in its own small count, and refuses the rest', async () => {
  const { q, hold, task, ran } = await heldLane();
  const at = (n) => q.addressed('g', task(n), { sender: n });
  const danger = (n) => q.addressed('g', task(n), { sender: n }, { urgent: true });
  assert.equal(at('at1').ok, true);
  assert.equal(at('at2').ok, true);
  assert.deepEqual(at('at3'), { ok: false, reason: 'queue_full' }, 'the premise: the lane is full');
  assert.deepEqual(danger('d1'), { ok: true });
  assert.deepEqual(danger('d2'), { ok: true });
  assert.deepEqual(danger('d3'), { ok: false, reason: 'queue_full' }, 'still bounded');
  hold.resolve();
  await q.idle();
  assert.deepEqual(ran, ['at1', 'at2', 'd1', 'd2'], 'urgent work does not pass what is already queued');
});

test('urgent work with ordinary room left does not use up the extra places', async () => {
  const { q, hold, task, ran } = await heldLane({ maxPending: 3 });
  const danger = (n) => q.addressed('g', task(n), { sender: 'same' }, { urgent: true });
  for (const n of ['d1', 'd2', 'd3']) assert.equal(danger(n).ok, true, n);
  assert.equal(danger('d4').ok, true, 'the first extra place, still free');
  assert.equal(danger('d5').ok, false, 'the sender holds their one extra place');
  hold.resolve();
  await q.idle();
  assert.deepEqual(ran, ['d1', 'd2', 'd3', 'd4']);
});

test('the extra places take no room from a later real @', async () => {
  const { q, hold, task, ran } = await heldLane();
  const second = deferred();
  q.addressed('g', () => second.promise, { sender: 'at1' });
  q.addressed('g', task('at2'), { sender: 'at2' });
  assert.equal(q.addressed('g', task('d1'), { sender: 'd1' }, { urgent: true }).ok, true);
  hold.resolve();
  await settle();
  assert.equal(q.addressed('g', task('at3'), { sender: 'at3' }).ok, true, 'one ordinary place freed, and it is counted without d1');
  assert.equal(q.addressed('g', task('at4'), { sender: 'at4' }).ok, false);
  second.resolve();
  await q.idle();
  assert.deepEqual(ran, ['at2', 'd1', 'at3']);
});

test('an extra place and its sender allowance come back when the task starts', async () => {
  const { q, hold, task } = await heldLane({ urgentExtra: 1 });
  const danger = (n) => q.addressed('g', task(n), { sender: 'same' }, { urgent: true });
  q.addressed('g', task('at1'), { sender: 'at1' });
  q.addressed('g', task('at2'), { sender: 'at2' });
  assert.equal(danger('d1').ok, true);
  assert.equal(danger('d2').ok, false, 'the premise: the one place is taken');
  hold.resolve();
  await q.idle();
  const held = deferred();
  q.addressed('g', () => held.promise, { sender: 'at3' });
  await tick();
  q.addressed('g', task('at4'), { sender: 'at4' });
  q.addressed('g', task('at5'), { sender: 'at5' });
  assert.equal(q.addressed('g', task('at6'), { sender: 'at6' }).ok, false, 'ordinary room is counted in full again');
  assert.equal(danger('d3').ok, true);
  held.resolve();
  await q.idle();
});

test('urgent work does not yield, even when asked to', async () => {
  const { q, hold, task, ran } = await heldLane();
  q.addressed('g', task('name'), { sender: 'n' }, { yielding: true });
  q.addressed('g', task('danger'), { sender: 'd' }, { urgent: true, yielding: true });
  hold.resolve();
  await q.idle();
  assert.deepEqual(ran, ['danger', 'name']);
});

test('one sender cannot take all the extra places from another person in danger', async () => {
  const { q, hold, task, ran } = await heldLane();
  q.addressed('g', task('at1'), { sender: 'at1' });
  q.addressed('g', task('at2'), { sender: 'at2' });
  assert.equal(q.addressed('g', task('a1'), { sender: 'A' }, { urgent: true }).ok, true);
  assert.deepEqual(q.addressed('g', task('a2'), { sender: 'A' }, { urgent: true }), { ok: false, reason: 'queue_full' });
  assert.equal(q.addressed('g', task('b1'), { sender: 'B' }, { urgent: true }).ok, true, 'the other person is still taken');
  hold.resolve();
  await q.idle();
  assert.deepEqual(ran, ['at1', 'at2', 'a1', 'b1']);
});

test('a sender that cannot be told apart has no allowance to run out of, only the shared count', async () => {
  const { q, hold, task } = await heldLane({ urgentKey: () => null });
  q.addressed('g', task('at1'), {});
  q.addressed('g', task('at2'), {});
  assert.equal(q.addressed('g', task('d1'), {}, { urgent: true }).ok, true);
  assert.equal(q.addressed('g', task('d2'), {}, { urgent: true }).ok, true);
  assert.equal(q.addressed('g', task('d3'), {}, { urgent: true }).ok, false);
  hold.resolve();
  await q.idle();
});

const dangerFrom = (sender) => ({ danger: true, sender });
const windowLane = (over = {}) => heldLane({ isUrgent: (records) => records.some((r) => r.danger), urgentPerSender: 2, ...over });

test('window lane: one sender repeating danger words cannot fill the room another person needs', async () => {
  const { q, fire, hold } = await windowLane({ maxPending: 3 });
  const seen = [];
  const onFlush = (records) => {
    seen.push(records.map((r) => r.sender));
  };
  q.ordinary('g', { sender: 'chat1' }, onFlush);
  q.ordinary('g', { sender: 'chat2' }, onFlush);
  q.ordinary('g', dangerFrom('A'), onFlush);
  assert.equal(q.ordinary('g', { sender: 'chat3' }, onFlush).reason, 'queue_full', 'the premise: chat is at its cap');
  assert.equal(q.ordinary('g', dangerFrom('A'), onFlush).ok, true, 'the second of the allowance');
  assert.deepEqual(q.ordinary('g', dangerFrom('A'), onFlush), { ok: false, reason: 'queue_full' }, 'past it, and no chat room');
  assert.equal(q.ordinary('g', dangerFrom('B'), onFlush).ok, true, 'the other person is still taken');
  fire();
  hold.resolve();
  await q.idle();
  assert.deepEqual(seen, [['chat1', 'chat2', 'A', 'A', 'B']]);
});

test('window lane: past the allowance a record is plain chat and does not move its window up', async () => {
  const { q, fire, hold, task, ran } = await windowLane({ maxPending: 5 });
  const flush = (name) => () => {
    ran.push(name);
  };
  q.addressed('g', task('name'), { sender: 'n' }, { yielding: true });
  q.ordinary('g', dangerFrom('A'), flush('first'));
  q.ordinary('g', dangerFrom('A'), flush('first'));
  fire();
  assert.equal(q.ordinary('g', dangerFrom('A'), flush('later')).ok, true, 'there is chat room for it');
  fire();
  hold.resolve();
  await q.idle();
  assert.deepEqual(ran, ['first', 'name', 'later'], 'only the window holding the allowance goes ahead of the name');
});

test('window lane: the allowance comes back when the window starts, and stop clears it', async () => {
  const { q, fire, hold, dropped } = await windowLane({ maxPending: 2 });
  const noop = () => {};
  q.ordinary('g', dangerFrom('A'), noop);
  q.ordinary('g', dangerFrom('A'), noop);
  assert.equal(q.ordinary('g', dangerFrom('A'), noop).ok, false, 'the premise: the allowance is used');
  fire();
  hold.resolve();
  await q.idle();
  q.ordinary('g', { sender: 'chat1' }, noop);
  q.ordinary('g', { sender: 'chat2' }, noop);
  assert.equal(q.ordinary('g', dangerFrom('A'), noop).ok, true, 'free again: chat is full, so only the allowance can take it');
  const stopping = q.stop();
  assert.equal(dropped.length, 3);
  await stopping;
});

test('a line past the chat cap counts against the extra @ place', async () => {
  const { q, hold, task } = await windowLane({ maxPending: 2, urgentPerSender: 1 });
  q.ordinary('g', { sender: 'chat1' }, () => {});
  q.ordinary('g', { sender: 'chat2' }, () => {});
  assert.equal(q.ordinary('g', dangerFrom('A'), () => {}).ok, true, 'taken past the chat cap');
  q.addressed('g', task('at1'), { sender: 'at1' });
  q.addressed('g', task('at2'), { sender: 'at2' });
  assert.equal(q.addressed('g', task('a'), dangerFrom('A'), { urgent: true }).ok, false, 'A already holds room in the window lane');
  assert.equal(q.addressed('g', task('b'), dangerFrom('B'), { urgent: true }).ok, true);
  const stopping = q.stop();
  hold.resolve();
  await stopping;
});

test('lines that fitted in chat room do not cost the sender an extra @ place', async () => {
  const { q, hold, task, dropped } = await windowLane({ maxPending: 2 });
  assert.equal(q.ordinary('g', dangerFrom('A'), () => {}).ok, true);
  assert.equal(q.ordinary('g', dangerFrom('A'), () => {}).ok, true);
  q.addressed('g', task('at1'), { sender: 'at1' });
  q.addressed('g', task('at2'), { sender: 'at2' });
  assert.equal(q.addressed('g', task('at3'), { sender: 'at3' }).reason, 'queue_full', 'the premise: the lane is full');
  assert.deepEqual(q.addressed('g', task('a'), dangerFrom('A'), { urgent: true }), { ok: true });
  const stopping = q.stop();
  assert.equal(dropped.length, 5);
  hold.resolve();
  await stopping;
});

test('a line past the chat cap gives its @ place back when its window starts', async () => {
  const { q, fire, hold, task } = await windowLane({ maxPending: 2, urgentPerSender: 1 });
  q.ordinary('g', { sender: 'chat1' }, () => {});
  q.ordinary('g', { sender: 'chat2' }, () => {});
  q.ordinary('g', dangerFrom('A'), () => {});
  fire();
  hold.resolve();
  await q.idle();
  const held = deferred();
  q.addressed('g', () => held.promise, { sender: 'running' });
  await tick();
  q.addressed('g', task('at1'), { sender: 'at1' });
  q.addressed('g', task('at2'), { sender: 'at2' });
  assert.equal(q.addressed('g', task('a'), dangerFrom('A'), { urgent: true }).ok, true);
  held.resolve();
  await q.idle();
});

test('an extra @ place still counts toward moving a window up', async () => {
  const { q, fire, hold, task, ran } = await windowLane({ maxPending: 2, urgentPerSender: 1 });
  const flush = (name) => () => {
    ran.push(name);
  };
  assert.equal(q.addressed('g', task('name'), { sender: 'n' }, { yielding: true }).ok, true);
  q.addressed('g', task('at1'), { sender: 'at1' });
  q.addressed('g', task('at2'), { sender: 'at2' });
  assert.equal(q.addressed('g', task('a'), dangerFrom('A'), { urgent: true }).ok, true);
  assert.equal(q.ordinary('g', dangerFrom('A'), flush('window')).ok, true);
  fire();
  hold.resolve();
  await q.idle();
  assert.deepEqual(ran, ['at1', 'at2', 'a', 'name', 'window'], 'the window stays behind the name');
});

test('lines in chat room leave the sender only their own share of the extra places', async () => {
  const { q, hold, task } = await windowLane({ maxPending: 2, urgentExtra: 3, urgentPerSender: 1 });
  q.ordinary('g', dangerFrom('A'), () => {});
  q.addressed('g', task('at1'), { sender: 'at1' });
  q.addressed('g', task('at2'), { sender: 'at2' });
  assert.equal(q.addressed('g', task('a1'), dangerFrom('A'), { urgent: true }).ok, true);
  assert.equal(q.addressed('g', task('a2'), dangerFrom('A'), { urgent: true }).reason, 'queue_full');
  const stopping = q.stop();
  hold.resolve();
  await stopping;
});

test('every extra task is dropped once at stop', async () => {
  const { q, hold, task, dropped } = await heldLane();
  const at1 = { sender: 'at1' };
  const at2 = { sender: 'at2' };
  const d1 = { sender: 'd1' };
  q.addressed('g', task('at1'), at1);
  q.addressed('g', task('at2'), at2);
  q.addressed('g', task('d1'), d1, { urgent: true });
  const stopping = q.stop();
  assert.deepEqual(dropped, [at1, at2, d1]);
  hold.resolve();
  await stopping;
});
