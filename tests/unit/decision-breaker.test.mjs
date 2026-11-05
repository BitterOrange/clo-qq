// The decision breaker: a failing decision model stops decisions and nothing else. Real gate, ledger and SQLite.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDecider } from '../../src/clo-plugin/lib/core/decision.js';
import { decisionOf, deferred, GROUP_A, GROUP_B, makeEffective, makeHarness, MEMBER2, ROOT, tempDir } from '../fixtures/inbound.mjs';

const MIN = 60000;
const RETRY = 10 * MIN;
const CRISIS = '我真的不想活了';
const failed = (over = {}) => decisionOf({ action: 'skip', invalid: 'http', actualMicros: null, httpStatus: 500, ...over });
const alertsOf = (h, kind) => h.store.listAlerts().filter((a) => a.kind === kind);
const breaker = (h) => h.store.getControl('decision_paused');
const restartedAt = (h) => h.store.controlUpdatedAt('decision_paused');

// A harness whose breaker has just opened, with the clock at the third failure.
async function opened(over = {}) {
  const ctl = { d: failed() };
  const h = makeHarness({ decide: async () => {
    ctl.during?.(h);
    return ctl.d;
  }, ...over });
  for (const text of ['第一条普通消息', '第二条普通消息', '第三条普通消息']) await h.sendAndFlush(h.event({ text }));
  assert.equal(breaker(h), 'open', 'positive control: three failures open it');
  return { h, ctl };
}

test('open: three failures in a row open it once and leave paid work and the primary streak alone', async () => {
  const ctl = { d: failed() };
  const h = makeHarness({ decide: async () => ctl.d });
  await h.sendAndFlush(h.event({ text: '第一条普通消息' }));
  await h.sendAndFlush(h.event({ text: '第二条普通消息' }));
  assert.equal(breaker(h), null, 'two is not enough');
  ctl.d = failed({ invalid: 'timeout', httpStatus: null });
  await h.sendAndFlush(h.event({ text: '第三条普通消息' }));
  assert.equal(breaker(h), 'open', 'a timeout counts like an HTTP failure');
  assert.equal(h.store.getControl('paid_paused'), null, 'decision failures do not stop paid work');
  assert.equal(h.store.peekCounter('provider_fail_streak'), 0, 'nor touch the primary streak');
  assert.equal(alertsOf(h, 'paid_paused').length, 0);
  assert.equal(alertsOf(h, 'decision_paused').length, 1);
  assert.equal(h.logs.filter((l) => l.event === 'decision_paused').length, 1);
  await h.close();
});

test('open: ordinary and name messages end skipped before any claim, cap or hold, and no money moves', async () => {
  const { h } = await opened();
  const calls = h.decideCalls.length;
  const counters = h.counters();
  const ordinary = await h.sendAndFlush(h.event({ text: '第四条普通消息' }));
  const name = await h.sendAndFlush(h.event({ text: '可洛你怎么看这个问题' }));
  for (const e of [ordinary, name]) {
    assert.equal(h.state(e), 'skipped:decision_paused');
    assert.deepEqual(h.reservations(e), []);
    assert.equal(h.claims().some((c) => c.event_key === h.store.key(e.messageId)), false);
  }
  assert.equal(h.decideCalls.length, calls);
  assert.equal(h.dispatched.length, 0, 'a name message needs a decision, so it stays silent');
  assert.deepEqual(h.counters(), counters, 'no decision cap was consumed');
  await h.close();
});

test('half-open: refused until the wait is over, then one decision goes through and success closes it', async () => {
  const { h, ctl } = await opened();
  const calls = h.decideCalls.length;
  h.advance(RETRY - 10000);
  const early = await h.sendAndFlush(h.event({ text: '等待时间还没到' }));
  assert.equal(h.state(early), 'skipped:decision_paused', 'six seconds short of the wait');
  assert.equal(h.decideCalls.length, calls);

  h.advance(6000);
  ctl.d = decisionOf({ action: 'reply' });
  const trial = await h.sendAndFlush(h.event({ text: '等待时间已经到了' }));
  assert.equal(h.decideCalls.length, calls + 1);
  assert.equal(h.state(trial), 'completed:sent', 'the trial is a real decision');
  assert.equal(breaker(h), null);
  assert.equal(h.store.peekCounter('decision_fail_streak'), 0, 'success clears the streak');

  ctl.d = failed();
  await h.sendAndFlush(h.event({ text: '又失败了一次', senderId: MEMBER2 }));
  assert.equal(breaker(h), null, 'with the streak cleared, one failure does not reopen it');
  assert.equal(alertsOf(h, 'decision_paused').length, 1);
  await h.close();
});

test('half-open: failure restarts the timer with no second alert, and the next wait allows another trial', async () => {
  const { h, ctl } = await opened();
  const calls = h.decideCalls.length;
  h.advance(RETRY);
  // The call takes time, so this tells the time of the failure from the time the trial was admitted.
  ctl.during = () => { h.clock.t += 5000; };
  const trial = await h.sendAndFlush(h.event({ text: '试探这一次也失败' }));
  ctl.during = null;
  assert.equal(h.decideCalls.length, calls + 1);
  assert.equal(h.state(trial), 'skipped:decision_invalid');
  assert.equal(breaker(h), 'open');
  assert.equal(restartedAt(h), h.clock.t, 'the failure restarted the timer');
  assert.equal(alertsOf(h, 'decision_paused').length, 1, 'no second alert');

  const soon = await h.sendAndFlush(h.event({ text: '紧接着的下一条' }));
  assert.equal(h.state(soon), 'skipped:decision_paused');
  h.advance(RETRY);
  await h.sendAndFlush(h.event({ text: '又到了可以试探' }));
  assert.equal(h.decideCalls.length, calls + 2);
  assert.equal(alertsOf(h, 'decision_paused').length, 1);
  await h.close();
});

test('half-open: only one trial runs, and a second message in the same wait is refused', async () => {
  const { h, ctl } = await opened();
  const calls = h.decideCalls.length;
  h.advance(RETRY);
  const pending = deferred();
  ctl.d = pending.promise;
  const a = await h.send(h.event({ text: '第一个群的试探', conversationId: GROUP_A }));
  const b = await h.send(h.event({ text: '第二个群也想试探', conversationId: GROUP_B, senderId: MEMBER2 }));
  h.advance(4000);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(h.decideCalls.length, calls + 1);
  pending.resolve(failed());
  await h.gate.idle();
  assert.deepEqual([h.state(a), h.state(b)].sort(), ['skipped:decision_invalid', 'skipped:decision_paused']);
  await h.close();
});

test('half-open: a claim refused for another reason gives the trial back', async () => {
  const { h, ctl } = await opened();
  const calls = h.decideCalls.length;
  h.advance(RETRY);
  const before = restartedAt(h);
  h.store.setControl('paid_paused', 'residual', 'test');
  const refused = await h.sendAndFlush(h.event({ text: '付费暂停时的消息' }));
  assert.equal(h.state(refused), 'skipped:paid_paused');
  assert.equal(restartedAt(h), before, 'the rollback kept the old time');
  assert.equal(h.decideCalls.length, calls);

  h.store.delControl('paid_paused');
  ctl.d = decisionOf({ action: 'skip' });
  await h.sendAndFlush(h.event({ text: '暂停解除后的消息' }));
  assert.equal(h.decideCalls.length, calls + 1, 'the next message gets the trial, with no new wait');
  assert.equal(breaker(h), null);
  await h.close();
});

test('restart: the breaker, its timer and the streak are all durable', async () => {
  const { h, ctl } = await opened();
  const { file } = h;
  const at = h.clock.t;
  await h.close();

  const next = makeHarness({ dbFile: file, start: at + MIN, runGen: 'gen-2', decide: async () => ctl.d });
  next.store.recoverOnStart(at + MIN);
  assert.equal(breaker(next), 'open');
  const refused = await next.sendAndFlush(next.event({ text: '重启之后的消息' }));
  assert.equal(next.state(refused), 'skipped:decision_paused');
  assert.equal(next.decideCalls.length, 0);
  assert.equal(alertsOf(next, 'decision_paused').length, 1);
  next.advance(RETRY);
  await next.sendAndFlush(next.event({ text: '重启等够之后的消息' }));
  assert.equal(next.decideCalls.length, 1, 'the wait counted from before the restart');
  await next.close();

  const two = makeHarness({ decide: async () => failed() });
  await two.sendAndFlush(two.event({ text: '第一条普通消息' }));
  await two.sendAndFlush(two.event({ text: '第二条普通消息' }));
  const twoFile = two.file;
  const twoAt = two.clock.t;
  await two.close();
  const three = makeHarness({ dbFile: twoFile, start: twoAt, runGen: 'gen-2', decide: async () => failed() });
  await three.sendAndFlush(three.event({ text: '第三条普通消息' }));
  assert.equal(breaker(three), 'open', 'two before the restart and one after make three');
  await three.close();
});

test('crisis: a message that reads as danger still reaches the decision on every trigger', async () => {
  const quiet = { quietHours: { start: '00:00', end: '23:59', timezone: 'Asia/Shanghai' } };
  for (const [text, trigger, over] of [
    [CRISIS, 'ordinary', {}],
    [`可洛，${CRISIS}`, 'name', {}],
    [CRISIS, 'crisis_route', quiet],
  ]) {
    const { h, ctl } = await opened();
    h.eff.current = makeEffective(over);
    const calls = h.decideCalls.length;
    ctl.d = decisionOf({ crisis: true });
    const e = await h.sendAndFlush(h.event({ text }));
    assert.equal(h.decideCalls.length, calls + 1, trigger);
    assert.equal(h.decideCalls.at(-1).trigger, trigger);
    assert.equal(h.state(e), 'completed:sent', trigger);
    assert.equal(h.reservations(e).some((r) => r.category === 'reply' && r.tier === 'addressed'), true, trigger);
    await h.close();
  }
});

test('crisis: a failed crisis decision restarts the timer, stays silent, and does not use up the trial', async () => {
  const { h } = await opened();
  const calls = h.decideCalls.length;
  h.advance(MIN);
  const e = await h.sendAndFlush(h.event({ text: CRISIS }));
  assert.equal(h.decideCalls.length, calls + 1);
  assert.equal(h.state(e), 'skipped:decision_invalid');
  assert.equal(h.dispatched.length, 0);
  assert.equal(restartedAt(h), h.clock.t);
  assert.equal(alertsOf(h, 'decision_paused').length, 1);
  await h.close();
});

test('@ and reply-to-bot are untouched while it is open, and do not close it', async () => {
  const { h } = await opened();
  const calls = h.decideCalls.length;
  const at = await h.sendAndFlush(h.at());
  assert.equal(h.state(at), 'completed:sent');
  h.store.addBotRef(h.store.key('REFIDX'), h.store.key(GROUP_A), 'EARLIER');
  const reply = await h.sendAndFlush(h.event({ text: '接着你刚才说的', refMsgIdx: 'REFIDX', senderId: MEMBER2 }));
  assert.equal(h.state(reply), 'completed:sent');
  assert.equal(h.dispatched.length, 2);
  assert.equal(h.decideCalls.length, calls, 'neither needed a decision');
  assert.equal(breaker(h), 'open', 'a primary success says nothing about the decision model');
  await h.close();
});

test('a reply already approved goes out even if the breaker opens while its decision is in flight', async () => {
  const pending = deferred();
  const h = makeHarness({ decide: async () => pending.promise });
  const e = await h.send(h.event({ text: '正在判定的这一条' }));
  h.advance(4000);
  await new Promise((resolve) => { setImmediate(resolve); });
  for (let i = 0; i < 3; i += 1) h.ledger.noteDecisionError({ httpStatus: 500 });
  assert.equal(breaker(h), 'open');
  pending.resolve(decisionOf({ action: 'reply' }));
  await h.gate.idle();
  assert.equal(h.state(e), 'completed:sent');
  await h.close();
});

test('limit errors from a decision pause paid work for everyone and are not breaker failures', async () => {
  for (const [httpStatus, limitSource, reason] of [
    [402, 'openrouter_credits', 'openrouter_credits'],
    [403, 'openrouter_key_limit', 'openrouter_key_limit'],
    [402, null, 'openrouter_credits'],
  ]) {
    const h = makeHarness({ decide: async () => failed({ httpStatus, limitSource }) });
    await h.sendAndFlush(h.event({ text: '第一条普通消息' }));
    assert.equal(h.store.getControl('paid_paused'), reason);
    assert.equal(h.store.peekCounter('decision_fail_streak'), 0);
    assert.equal(breaker(h), null);
    const at = await h.sendAndFlush(h.at());
    assert.equal(h.state(at), 'skipped:paid_paused', 'the Key is shared, so @ stops too');
    await h.close();
  }
});

test('a 403 with no limit source alerts and counts toward the breaker only', async () => {
  const h = makeHarness({ decide: async () => failed({ httpStatus: 403 }) });
  for (const text of ['第一条普通消息', '第二条普通消息', '第三条普通消息']) await h.sendAndFlush(h.event({ text }));
  assert.equal(breaker(h), 'open');
  assert.equal(h.store.getControl('paid_paused'), null);
  assert.equal(alertsOf(h, 'provider_403').length, 3);
  await h.close();
});

test('the two streaks are separate: neither path clears or feeds the other', async () => {
  const ctl = { d: decisionOf({ action: 'skip' }) };
  const h = makeHarness({ decide: async () => ctl.d });
  h.ledger.noteProviderError({});
  h.ledger.noteProviderError({});
  await h.sendAndFlush(h.event({ text: '判定模型工作正常' }));
  assert.equal(h.store.peekCounter('provider_fail_streak'), 2, 'a Haiku success does not clear the primary streak');
  h.ledger.noteProviderError({});
  assert.equal(h.store.getControl('paid_paused'), 'provider_fail', 'so a failing primary with a working Haiku pauses');
  assert.equal(breaker(h), null);
  h.store.delControl('paid_paused');

  ctl.d = failed();
  await h.sendAndFlush(h.event({ text: '第一条普通消息' }));
  await h.sendAndFlush(h.event({ text: '第二条普通消息' }));
  h.ledger.noteProviderOk();
  assert.equal(h.store.peekCounter('decision_fail_streak'), 2, 'a primary success does not clear the decision streak');
  await h.close();
});

test('budget fields can change the threshold and the wait', async () => {
  const eff = makeEffective({ budget: { providerFailStreakPause: 1, decisionRetryMs: MIN } });
  const h = makeHarness({ effective: eff, decide: async () => failed() });
  await h.sendAndFlush(h.event({ text: '第一条普通消息' }));
  assert.equal(breaker(h), 'open');
  h.advance(MIN);
  await h.sendAndFlush(h.event({ text: '第二条普通消息' }));
  assert.equal(h.decideCalls.length, 2);
  await h.close();
});

test('status snapshot reports when it last failed or tried, and null when closed', async () => {
  const { h, ctl } = await opened();
  assert.equal(h.store.statusSnapshot(h.clock.t).decisionPausedAt, restartedAt(h));
  h.advance(RETRY);
  ctl.d = decisionOf({ action: 'skip' });
  await h.sendAndFlush(h.event({ text: '恢复之后的消息' }));
  assert.equal(h.store.statusSnapshot(h.clock.t).decisionPausedAt, null);
  await h.close();
});

// The real decider over a fetch that only ever ends by being aborted.
function hangingDecider(eff) {
  let asked = () => {};
  const decide = createDecider({
    fetch: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      asked();
    }),
    getKey: () => 'FAKE-KEY',
    getEffective: () => eff,
    promptFile: join(ROOT, 'persona', 'decision-prompt.zh.md'),
  });
  return { decide, reached: () => new Promise((resolve) => { asked = resolve; }) };
}

test('our own stop during a decision is no failure: restarts with a decision in flight never open it', async () => {
  const dbFile = join(tempDir(), 'clo.db');
  for (const runGen of ['gen-1', 'gen-2', 'gen-3', 'gen-4']) {
    const eff = makeEffective();
    const real = hangingDecider(eff);
    const h = makeHarness({ effective: eff, decide: real.decide, dbFile, runGen });
    const reached = real.reached();
    const e = await h.send(h.event({ text: '一条普通的群消息' }));
    h.advance(4000);
    await reached;
    await h.gate.stop();
    assert.equal(h.state(e), 'skipped:decision_invalid');
    assert.equal(h.store.peekCounter('decision_fail_streak'), 0, runGen);
    assert.equal(breaker(h), null, runGen);
    assert.equal(h.reservations(e)[0].status, 'unsettled', 'it may have been charged, so it stays counted');
    await h.close();
  }
});

test('a stop during the third decision does not finish off a streak of two', async () => {
  const eff = makeEffective();
  const real = hangingDecider(eff);
  const ctl = { hang: false };
  const h = makeHarness({ effective: eff, decide: (req) => (ctl.hang ? real.decide(req) : failed()) });
  await h.sendAndFlush(h.event({ text: '第一条普通消息' }));
  await h.sendAndFlush(h.event({ text: '第二条普通消息' }));
  assert.equal(h.store.peekCounter('decision_fail_streak'), 2);
  ctl.hang = true;
  const reached = real.reached();
  await h.send(h.event({ text: '第三条普通消息' }));
  h.advance(4000);
  await reached;
  await h.gate.stop();
  assert.equal(h.store.peekCounter('decision_fail_streak'), 2);
  assert.equal(breaker(h), null);
  assert.equal(alertsOf(h, 'decision_paused').length, 0);
  await h.close();
});

test('positive control: the same decider timing out with no stop does count', async () => {
  const eff = makeEffective({ timeouts: { decisionMs: 1 } });
  const real = hangingDecider(eff);
  const h = makeHarness({ effective: eff, decide: real.decide });
  const e = await h.sendAndFlush(h.event({ text: '一条普通的群消息' }));
  assert.equal(h.state(e), 'skipped:decision_invalid');
  assert.equal(h.store.peekCounter('decision_fail_streak'), 1);
  await h.close();
});

test('a call that never left the machine says nothing: it neither closes it nor clears the streak', async () => {
  const unavailable = decisionOf({ action: 'skip', invalid: 'unavailable', paid: false, actualMicros: null, httpStatus: null });
  const { h, ctl } = await opened();
  h.advance(RETRY);
  ctl.d = unavailable;
  await h.sendAndFlush(h.event({ text: '试探时没有发出请求' }));
  assert.equal(breaker(h), 'open');
  assert.equal(h.store.peekCounter('decision_fail_streak'), 3);
  await h.close();

  const before = { d: failed() };
  const g = makeHarness({ decide: async () => before.d });
  await g.sendAndFlush(g.event({ text: '第一条普通消息' }));
  await g.sendAndFlush(g.event({ text: '第二条普通消息' }));
  before.d = unavailable;
  await g.sendAndFlush(g.event({ text: '没有发出请求的一次' }));
  assert.equal(g.store.peekCounter('decision_fail_streak'), 2);
  await g.close();
});

test('a malformed answer came back from a provider that is up: it closes it and clears the streak', async () => {
  for (const invalid of ['json', 'empty', 'length']) {
    const { h, ctl } = await opened();
    h.advance(RETRY);
    ctl.d = decisionOf({ action: 'skip', invalid, actualMicros: null });
    const trial = await h.sendAndFlush(h.event({ text: '试探得到一个坏答案' }));
    assert.equal(h.state(trial), 'skipped:decision_invalid', invalid);
    assert.equal(breaker(h), null, invalid);
    assert.equal(h.store.peekCounter('decision_fail_streak'), 0, invalid);
    await h.close();
  }
});
