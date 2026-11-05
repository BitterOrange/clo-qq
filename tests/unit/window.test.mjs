// Queues with a fake timer. Every wait is on a promise the test controls.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGroupQueues } from '../../src/clo-plugin/lib/core/window.js';
import { deferred } from '../fixtures/inbound.mjs';

function setup(over = {}) {
  const fired = new Map();
  let id = 0;
  const dropped = [];
  const errors = [];
  const q = createGroupQueues({
    windowMs: 4000,
    maxPending: 20,
    maxConcurrentTurns: 2,
    setTimer: (fn, ms) => {
      id += 1;
      fired.set(id, { fn, ms });
      return id;
    },
    clearTimer: (t) => fired.delete(t),
    onDrop: (r) => dropped.push(r),
    onError: (e) => errors.push(e),
    ...over,
  });
  const fire = () => {
    for (const [k, v] of [...fired]) {
      fired.delete(k);
      v.fn();
    }
  };
  return { q, fire, fired, dropped, errors };
}
const tick = () => new Promise((r) => setImmediate(r));

test('a window is fixed: the first message opens it and later ones do not extend it', async () => {
  const { q, fire, fired } = setup();
  const seen = [];
  const onFlush = (records) => {
    seen.push(records);
  };
  assert.deepEqual(q.ordinary('g', 'a', onFlush), { ok: true });
  assert.equal(fired.size, 1);
  assert.equal([...fired.values()][0].ms, 4000);
  q.ordinary('g', 'b', onFlush);
  q.ordinary('g', 'c', onFlush);
  assert.equal(fired.size, 1, 'no second timer');
  fire();
  await q.idle();
  assert.deepEqual(seen, [['a', 'b', 'c']]);
  q.ordinary('g', 'd', onFlush);
  assert.equal(fired.size, 1, 'the next message opens a new window');
  fire();
  await q.idle();
  assert.deepEqual(seen, [['a', 'b', 'c'], ['d']]);
});

test('windows are per group', async () => {
  const { q, fire } = setup();
  const seen = [];
  const onFlush = (r) => {
    seen.push(r);
  };
  q.ordinary('g1', 'a', onFlush);
  q.ordinary('g2', 'b', onFlush);
  fire();
  await q.idle();
  assert.deepEqual(seen.sort(), [['a'], ['b']]);
});

test('same group runs serially, and addressed drains before a flushed window', async () => {
  const { q, fire } = setup();
  const order = [];
  const gate1 = deferred();
  q.addressed('g', async () => {
    order.push('at1-start');
    await gate1.promise;
    order.push('at1-end');
  });
  await tick();
  q.ordinary('g', 'w', () => {
    order.push('window');
  });
  fire();
  q.addressed('g', async () => {
    order.push('at2');
  });
  await tick();
  assert.deepEqual(order, ['at1-start'], 'nothing overlaps the running task');
  gate1.resolve();
  await q.idle();
  assert.deepEqual(order, ['at1-start', 'at1-end', 'at2', 'window']);
});

test('maxConcurrentTurns is global across groups', async () => {
  const { q } = setup();
  const release = [deferred(), deferred(), deferred()];
  let running = 0;
  let peak = 0;
  const task = (i) => async () => {
    running += 1;
    peak = Math.max(peak, running);
    await release[i].promise;
    running -= 1;
  };
  q.addressed('g1', task(0));
  q.addressed('g2', task(1));
  q.addressed('g3', task(2));
  await tick();
  assert.equal(running, 2);
  release[0].resolve();
  await tick();
  assert.equal(running, 2, 'the third starts when a slot frees');
  release[1].resolve();
  release[2].resolve();
  await q.idle();
  assert.equal(peak, 2);
});

test('lanes have separate caps: an ordinary flood cannot crowd out a real @', async () => {
  const { q } = setup({ maxPending: 2 });
  const noop = () => {};
  assert.equal(q.ordinary('g', 'a', noop).ok, true);
  assert.equal(q.ordinary('g', 'b', noop).ok, true);
  assert.deepEqual(q.ordinary('g', 'c', noop), { ok: false, reason: 'queue_full' });
  assert.deepEqual(q.addressed('g', async () => {}), { ok: true });
});

test('addressed lane overflow reports queue_full', async () => {
  const { q } = setup({ maxPending: 1, maxConcurrentTurns: 1 });
  const hold = deferred();
  q.addressed('g', () => hold.promise);
  await tick();
  assert.equal(q.addressed('g', async () => {}).ok, true);
  assert.deepEqual(q.addressed('g', async () => {}), { ok: false, reason: 'queue_full' });
  hold.resolve();
  await q.idle();
});

test('flushed windows still count until they start, then free room', async () => {
  const { q, fire } = setup({ maxPending: 2, maxConcurrentTurns: 1 });
  const hold = deferred();
  q.addressed('g', () => hold.promise);
  await tick();
  q.ordinary('g', 'a', () => {});
  q.ordinary('g', 'b', () => {});
  fire();
  assert.equal(q.ordinary('g', 'c', () => {}).reason, 'queue_full', 'flushed but not started');
  hold.resolve();
  await tick();
  await tick();
  assert.equal(q.ordinary('g', 'd', () => {}).ok, true);
  fire();
  await q.idle();
});

test('a failing task is reported and does not stop the queue', async () => {
  const { q, errors } = setup();
  const ran = [];
  q.addressed('g', async () => {
    throw new Error('boom');
  });
  q.addressed('g', async () => {
    ran.push('next');
  });
  await q.idle();
  assert.equal(errors.length, 1);
  assert.deepEqual(ran, ['next']);
});

test('idle waits for open windows and running tasks, and resolves at once when empty', async () => {
  const { q, fire } = setup();
  await q.idle();
  q.ordinary('g', 'a', () => {});
  let done = false;
  const p = q.idle().then(() => {
    done = true;
  });
  await tick();
  assert.equal(done, false);
  fire();
  await p;
  assert.equal(done, true);
});

test('a yielding task stays behind later ordinary addressed tasks, takes no room from them, and counts toward the drop', async () => {
  const { q, dropped } = setup({ maxPending: 3 });
  const hold = deferred();
  const ran = [];
  q.addressed('g', async () => {
    await hold.promise;
  }, 'running');
  await tick();
  const task = (name) => async () => {
    ran.push(name);
  };
  q.addressed('g', task('name1'), 'name1', { yielding: true });
  q.addressed('g', task('at1'), 'at1');
  q.addressed('g', task('name2'), 'name2', { yielding: true });
  assert.deepEqual(q.addressed('g', task('name3'), 'name3', { yielding: true }), { ok: false, reason: 'queue_full' });
  assert.deepEqual(q.addressed('g', task('at2'), 'at2'), { ok: true });
  hold.resolve();
  await q.idle();
  assert.deepEqual(ran, ['at1', 'at2', 'name1', 'name2'], 'an @ goes ahead of the names; the names keep their order');

  const stopping = setup();
  const hold2 = deferred();
  stopping.q.addressed('g', async () => {
    await hold2.promise;
  }, 'running');
  await tick();
  stopping.q.addressed('g', task('late'), 'late', { yielding: true });
  const p = stopping.q.stop();
  assert.deepEqual(stopping.dropped, ['late']);
  hold2.resolve();
  await p;
  assert.deepEqual(dropped, []);
});

test('stop drops pending work to onDrop, runs nothing further, and waits for what is running', async () => {
  const { q, dropped, fired } = setup({ maxConcurrentTurns: 1 });
  const hold = deferred();
  const ran = [];
  q.addressed('g', async () => {
    await hold.promise;
    ran.push('running');
  }, 'rec-running');
  await tick();
  q.addressed('g', async () => {
    ran.push('queued');
  }, 'rec-queued');
  q.ordinary('g', 'rec-window', () => ran.push('window'));
  let stopped = false;
  const p = q.stop().then(() => {
    stopped = true;
  });
  await tick();
  assert.deepEqual(dropped.sort(), ['rec-queued', 'rec-window']);
  assert.equal(fired.size, 0, 'the window timer is cleared');
  assert.equal(stopped, false);
  hold.resolve();
  await p;
  assert.deepEqual(ran, ['running']);
  assert.deepEqual(q.addressed('g', async () => {}), { ok: false, reason: 'stopped' });
  assert.deepEqual(q.ordinary('g', 'x', () => {}), { ok: false, reason: 'stopped' });
});

test('an urgent window goes ahead of yielding tasks, and an ordinary one does not', async () => {
  const q = setup({ isUrgent: (records) => records.includes('danger') });
  const ran = [];
  const hold = deferred();
  q.q.addressed('G', async () => {
    ran.push('running');
    await hold.promise;
  }, 'r0');
  await new Promise((r) => setImmediate(r));
  q.q.addressed('G', async () => { ran.push('name'); }, 'r1', { yielding: true });
  q.q.ordinary('G', 'chat', async () => { ran.push('chat window'); });
  q.fire();
  q.q.ordinary('G', 'danger', async () => { ran.push('danger window'); });
  q.fire();
  q.q.addressed('G', async () => { ran.push('at'); }, 'r2');
  hold.resolve();
  await q.q.idle();
  assert.deepEqual(ran, ['running', 'at', 'danger window', 'name', 'chat window'], 'a real @ first, then danger, then what yields, then the rest');
});
