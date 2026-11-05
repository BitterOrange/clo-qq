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
