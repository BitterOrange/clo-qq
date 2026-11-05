// The dispatcher's handling of a run that overstays, or that the host defers, with a fake host.
// e2e/dispatch-stalled shows the abort on the real Gateway.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDispatcher } from '../../src/clo-plugin/lib/channels/qq/dispatch.js';
import { createUsageTracker } from '../../src/clo-plugin/lib/channels/qq/hooks.js';
import { seamStack } from '../fixtures/inbound.mjs';
import { GROUP_A, MEMBER } from '../harness/gateway.mjs';

const T0 = Date.UTC(2026, 10, 3, 4);

function fakeHost({ run = async () => ({}), usage = null, now = Date.now, abortGraceMs = 30 } = {}) {
  const logs = [];
  const seen = { ran: 0, replyOptions: null };
  const rt = {
    routing: { resolveAgentRoute: () => ({ agentId: 'main', accountId: 'default', sessionKey: 'key' }) },
    inbound: {
      ingress: { resolve: async () => ({ ingress: { admission: 'dispatch' } }) },
      buildContext: () => ({}),
      run: (params) => {
        seen.ran += 1;
        seen.replyOptions = params.adapter.resolveTurn().replyOptions;
        return run(seen.replyOptions.abortSignal);
      },
    },
  };
  const dispatch = createDispatcher({
    rt, getCfg: () => ({}), account: { accountId: 'default' }, getExit: () => ({}), identity: {}, usage, now, abortGraceMs,
    log: (event, data) => logs.push({ event, ...data }),
  });
  return { dispatch, logs, seen, rt };
}

const baseTurn = (over = {}) => ({
  turnId: 't', eventKey: 'e', groupKey: 'g', groupId: GROUP_A, messageId: 'm', senderId: MEMBER, senderLabel: 'U1', speakerLabel: null,
  cls: 'at', tier: 'addressed', required: true, authorizedCommand: null, text: '正文', history: [], inboundUrls: [],
  replyReservationId: null, interjectLogId: null, receivedAt: T0, msgTs: T0, deadlineAt: Date.now() + 60000, ...over,
});

function fakeUsage() {
  const calls = [];
  return {
    calls,
    open: (key, turn) => calls.push(['open', turn.turnId]),
    close: async (id, opts) => {
      calls.push(['close', id, opts]);
      return null;
    },
    runEnded: async (id) => calls.push(['ended', id]),
  };
}

const untilAborted = (signal) => new Promise((resolve, reject) => {
  signal.addEventListener('abort', () => reject(new Error('aborted')));
});

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a finished run is reported as finished, and its signal is never aborted', async () => {
  const { dispatch, seen, logs } = fakeHost({ run: async () => ({ dispatchResult: {} }) });
  const r = await dispatch(baseTurn());
  assert.deepEqual(r, { started: true, hostError: false, aborted: false, usage: null });
  assert.equal(seen.replyOptions.abortSignal.aborted, false);
  assert.equal(seen.replyOptions.disableBlockStreaming, true);
  assert.equal(logs.some((l) => l.event === 'turn_watchdog'), false);
});

test('at the deadline the run is aborted through the host signal, and one that then ends leaves nothing owed', async () => {
  const usage = fakeUsage();
  const { dispatch, seen, logs } = fakeHost({ usage, run: untilAborted, abortGraceMs: 2000 });
  const r = await dispatch(baseTurn({ deadlineAt: Date.now() + 40 }));
  assert.equal(seen.replyOptions.abortSignal.aborted, true);
  assert.equal(r.started, true);
  assert.equal(r.aborted, true);
  assert.equal(r.hostError, false, 'the rejection is our own abort, not a host failure');
  assert.deepEqual(logs.find((l) => l.event === 'turn_watchdog'), { event: 'turn_watchdog', eventKey: 'e', state: 'ended' });
  assert.deepEqual(usage.calls.find((c) => c[0] === 'close'), ['close', 't', { runActive: false }]);
});

test('a run that ignores the abort does not hold the queue past the grace, and still owes usage until it ends', async () => {
  const usage = fakeUsage();
  let finish;
  const { dispatch, logs } = fakeHost({ usage, run: () => new Promise((resolve) => { finish = resolve; }) });
  const started = Date.now();
  const r = await dispatch(baseTurn({ deadlineAt: Date.now() + 20 }));
  assert.ok(Date.now() - started < 1500, 'returned after the grace');
  assert.equal(r.aborted, true);
  assert.deepEqual(logs.find((l) => l.event === 'turn_watchdog'), { event: 'turn_watchdog', eventKey: 'e', state: 'still_running' });
  assert.deepEqual(usage.calls.find((c) => c[0] === 'close'), ['close', 't', { runActive: true }]);
  assert.equal(usage.calls.some((c) => c[0] === 'ended'), false);
  finish({});
  await pause(20);
  assert.deepEqual(usage.calls.at(-1), ['ended', 't']);
});

test('a run still going that later rejects raises no unhandled rejection and still ends the debt', async () => {
  const usage = fakeUsage();
  let fail;
  const { dispatch } = fakeHost({ usage, run: () => new Promise((_, reject) => { fail = reject; }) });
  await dispatch(baseTurn({ deadlineAt: Date.now() + 20 }));
  fail(new Error('late'));
  await pause(20);
  assert.deepEqual(usage.calls.at(-1), ['ended', 't']);
});

test('a host rejection before the deadline is a host error, not an abort', async () => {
  const { dispatch, logs } = fakeHost({ run: async () => { throw new Error('boom'); } });
  const r = await dispatch(baseTurn());
  assert.equal(r.hostError, true);
  assert.equal(r.aborted, false);
  assert.ok(logs.some((l) => l.event === 'dispatch_error'));
});

test('a turn the host deferred behind an active run counts as a host error, so settlement does not pause paid work', async () => {
  for (const mode of ['steer', 'followup']) {
    const { dispatch, logs } = fakeHost({ run: async () => ({ dispatchResult: { deferredToActiveRun: mode } }) });
    const r = await dispatch(baseTurn());
    assert.equal(r.started, true, mode);
    assert.equal(r.hostError, true, mode);
    assert.equal(r.aborted, false, mode);
    assert.deepEqual(logs.find((l) => l.event === 'turn_deferred'), { event: 'turn_deferred', eventKey: 'e' }, mode);
  }
});

test('through the real gate and exit, a deferred turn ends as a host error and pauses nothing', async () => {
  const cases = [
    ['interject', (h) => h.sendAndFlush(h.event({ text: '有人知道怎么退货吗' })), 'silent:host_error'],
    ['at', async (h) => { const e = await h.send(h.at()); await h.gate.idle(); return e; }, 'failed:host_error'],
  ];
  for (const mode of ['steer', 'followup']) {
    for (const [name, send, state] of cases) {
      const h = await seamStack();
      const logs = [];
      const fake = fakeHost({ run: async () => ({ dispatchResult: { deferredToActiveRun: mode } }), now: h.now });
      h.script = createDispatcher({
        rt: fake.rt, getCfg: () => ({}), account: { accountId: 'default' }, getExit: () => h.exit, identity: {}, usage: null, now: h.now,
        log: (event, data) => logs.push({ event, ...data }),
      });
      const e = await send(h);
      assert.equal(h.state(e), state, `${name} ${mode}`);
      assert.equal(h.store.getControl('paid_paused'), null, `${name} ${mode}`);
      assert.equal(logs.filter((l) => l.event === 'turn_deferred').length, 1, `${name} ${mode}`);
      await h.close();
    }
  }
});

test('a run with no result object is an ordinary finish', async () => {
  const { dispatch, logs } = fakeHost({ run: async () => undefined });
  const r = await dispatch(baseTurn());
  assert.equal(r.hostError, false);
  assert.equal(logs.some((l) => l.event === 'turn_deferred'), false);
});

test('past the deadline nothing reaches the host, and no usage entry is opened', async () => {
  const usage = fakeUsage();
  for (const over of [{ cls: 'at', tier: 'addressed', required: true }, { cls: 'crisis', tier: 'addressed', required: true }, { cls: 'interject', tier: 'interject', required: false }, { cls: 'command', tier: 'addressed', required: true }]) {
    const { dispatch, seen, logs } = fakeHost({ usage });
    const r = await dispatch(baseTurn({ ...over, deadlineAt: Date.now() - 1 }));
    assert.deepEqual(r, { started: false, reason: 'expired_before_dispatch' }, over.cls);
    assert.equal(seen.ran, 0);
    assert.deepEqual(logs, [{ event: 'turn_expired', eventKey: 'e', tier: over.tier }]);
    assert.equal(JSON.stringify(logs).includes('crisis'), false, 'crisis is a routing state and stays out of the log');
  }
  assert.deepEqual(usage.calls, []);
});

test('with little time left an optional reply is not bought; a required one still tries', async () => {
  const at = Date.now();
  const late = { deadlineAt: at + 14000 };
  const optional = fakeHost({ now: () => at });
  assert.equal((await optional.dispatch(baseTurn({ ...late, cls: 'interject', tier: 'interject', required: false }))).started, false);
  assert.equal(optional.seen.ran, 0);
  const roomy = fakeHost({ now: () => at });
  assert.equal((await roomy.dispatch(baseTurn({ deadlineAt: at + 16000, cls: 'interject', tier: 'interject', required: false }))).started, true, 'positive control');
  for (const cls of ['at', 'crisis', 'name_addressed']) {
    const required = fakeHost({ now: () => at });
    assert.equal((await required.dispatch(baseTurn({ ...late, cls, required: true }))).started, true, cls);
    assert.equal(required.seen.ran, 1);
  }
});

// The locked host defers a new turn while a run is registered as active (the deferred tests above). Its stuck-session
// recovery can drop that registration while the old run's promise is still pending, and then the next turn really starts.
async function overstayedThenNext({ nextEmits }) {
  const h = await seamStack();
  const listeners = [];
  const emit = (evt) => listeners.forEach((fn) => fn({ type: 'model.usage', sessionKey: 'key', model: 'anthropic/fake-opus', usage: { input: 1000, output: 100 }, ...evt }));
  const usage = createUsageTracker({
    onInternalDiagnosticEvent: (fn) => { listeners.push(fn); return () => {}; },
    ledger: h.ledger,
    price: () => h.eff.current.models.primary.price,
    drainWaitMs: 5,
    now: h.now,
  });
  let finishFirst;
  let runs = 0;
  let current;
  const fake = fakeHost({
    run: async () => {
      runs += 1;
      if (runs === 1) return new Promise((resolve) => { finishFirst = resolve; });
      h.advance(1000);
      nextEmits(emit, h.now());
      h.exit.collect(current.turnId, { text: '第二条回答。' }, { kind: 'final' });
      return { dispatchResult: {} };
    },
  });
  const dispatch = createDispatcher({ rt: fake.rt, getCfg: () => ({}), account: { accountId: 'default' }, getExit: () => h.exit, identity: {}, usage, now: h.now, abortGraceMs: 10 });
  h.script = (turn) => {
    current = turn;
    // Only the first turn's deadline is near. The watchdog runs on real time, so it cannot follow the harness clock.
    return dispatch(runs === 0 ? { ...turn, deadlineAt: h.now() + 10 } : turn);
  };
  const first = await h.send(h.at());
  const next = await h.send(h.at());
  await h.gate.idle();
  return {
    h, first, next, emit,
    stop: async () => {
      finishFirst({});
      await pause(5);
      usage.stop();
      await h.close();
    },
  };
}

test('after an overstayed run, the next turn keeps its own usage and its normal reply pauses nothing', async () => {
  const s = await overstayedThenNext({ nextEmits: (emit, at) => emit({ ts: at, durationMs: 5 }) });
  assert.equal(s.h.state(s.next), 'completed:sent');
  assert.equal(s.h.store.getControl('paid_paused'), null);
  assert.deepEqual(s.h.reservations(s.next).map((r) => r.status), ['settled'], 'paid for by its own figure');
  assert.equal(s.h.state(s.first), 'failed:aborted');
  assert.deepEqual(s.h.reservations(s.first).map((r) => r.status), ['unsettled'], 'the old run has reported nothing yet');
  s.emit({ ts: s.h.now(), durationMs: 200000 });
  assert.deepEqual(s.h.reservations(s.first).map((r) => r.status), ['settled'], 'the old run still pays when its figure comes');
  await s.stop();
});

test('after an overstayed run, a next turn with no usage of its own still pauses paid work, whatever the old run reports', async () => {
  for (const [name, nextEmits, firstState] of [
    ['nothing arrives', () => {}, 'unsettled'],
    ['only the old run reports', (emit, at) => emit({ ts: at, durationMs: 200000 }), 'settled'],
  ]) {
    const s = await overstayedThenNext({ nextEmits });
    assert.equal(s.h.state(s.next), 'completed:sent', name);
    assert.equal(s.h.store.getControl('paid_paused'), 'usage_missing', name);
    assert.deepEqual(s.h.reservations(s.next).map((r) => r.status), ['unsettled'], name);
    assert.deepEqual(s.h.reservations(s.first).map((r) => r.status), [firstState], name);
    await s.stop();
  }
});
