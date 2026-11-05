// Where a person in danger could vanish with no reply and no operator signal, and what /stop leaves behind it.
// Real gate, store, ledger, policy and exit. Only the host and the QQ API are fake.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ApiError } from '@tencent-connect/qqbot-nodejs';
import '../harness/net-guard.mjs';
import { createExit } from '../../src/clo-plugin/lib/channels/qq/exit.js';
import { openStore } from '../../src/clo-plugin/lib/core/store.js';
import { decisionOf, deferred, GROUP_A, makeEffective, makeHarness, MEMBER, MEMBER2, OWNER, ROOT, USAGE } from '../fixtures/inbound.mjs';

const LINES = JSON.parse(readFileSync(join(ROOT, 'persona', 'policy-lines.zh.json'), 'utf8'));
const FAILED = LINES.modelFailed;
const CRISIS = '我真的不想活了';
const NAMED_CRISIS = `可洛 ${CRISIS}`;
const NAME_A = '可洛你看看退货怎么办';
const CHAT = '有人知道退货要怎么办吗';
const REPLY = '这是一条普通的回复。';
// Past one part at the harness's part limit.
const LONG_REPLY = `${'第一段的内容很长。'.repeat(200)}\n\n${'第二段的内容也很长。'.repeat(200)}`;
const URL_REFUSED = () => new ApiError('API Error [/x]: url', 400, '/x', 40054010, 'detail');

const tick = () => new Promise((r) => setImmediate(r));
const until = async (cond) => {
  for (let i = 0; i < 2000 && !cond(); i += 1) await tick();
  assert.ok(cond(), 'the expected state was never reached');
};

const open = [];
after(async () => {
  for (const h of open) await h.close();
});

// hold keeps a model turn running until it is released. run() is what the host hands back once it ends.
// With timePasses, a wait at the exit moves the clock by its length. Without it no time passes during a wait.
function stack({ decide, effective, hold = false, text = REPLY, usage = USAGE, aborted = false, timePasses = false } = {}) {
  const posts = [];
  const gateHold = deferred();
  const ran = [];
  const failNext = new Map();
  let h;
  const bot = {
    appId: 'FAKE-APP',
    api: {
      post: async (path, body) => {
        posts.push({ path, body });
        await h.onPost?.(body, posts.length);
        const err = failNext.get(body.msg_id);
        if (err) {
          failNext.delete(body.msg_id);
          throw err;
        }
        return { id: `S${posts.length}` };
      },
    },
  };
  const dispatch = async (turn) => {
    if (turn.authorizedCommand) return { started: true, hostError: false, aborted: false, usage: null };
    ran.push(turn.messageId);
    if (hold) await gateHold.promise;
    h.exit.collect(turn.turnId, { text }, { kind: 'final' });
    return { started: true, hostError: false, aborted, usage };
  };
  h = makeHarness({ decide, effective, dispatch, attach: false });
  h.exit = createExit({ bot, store: h.store, policy: h.policy, getEffective: () => h.eff.current, secrets: [], log: h.log, now: h.now, sleep: async (ms) => {
    if (timePasses) h.clock.t += ms;
  } });
  h.gate.attachExit(h.exit);
  h.ran = ran;
  h.posts = posts;
  h.failNext = failNext;
  h.release = () => gateHold.resolve();
  h.stop = async (senderId = OWNER) => {
    h.clock.t += 1000;
    const e = await h.send(h.at({ text: '/stop', senderId }));
    await tick();
    return e;
  };
  h.alerts = (kind) => h.store.listAlerts().filter((a) => a.kind === kind);
  h.lineOf = (a) => a.detail.state ?? null;
  // Sends from another event that fill this many of the group's places in the current minute.
  h.fillMinute = (groupKey, n) => {
    const { ok } = h.store.insertSendParts({
      eventKey: 'filler', groupKey, kind: 'reply', parts: Array.from({ length: n }, () => ({ textSha: 'x' })),
      rate: { accountPerMin: 12, accountPerHour: 120, groupPerMin: 4 }, now: h.now(),
    });
    assert.ok(ok);
  };
  h.reasonOf = (a) => a.detail.reason;
  h.pausedBy = () => h.store.getControl('paid_paused');
  h.postedTo = (e) => h.posts.filter((p) => p.body.msg_id === e.messageId).map((p) => p.body.content);
  h.failLines = (e) => h.postedTo(e).filter((c) => c === FAILED).length;
  open.push(h);
  return h;
}

const noFailLines = () => makeEffective({ limits: { ...makeEffective().limits, failureLinePerGroupPerHour: 0 } });

// ---- /stop against a running turn ----

test('/stop aborts a running turn for a person in danger: the failure line goes out once, and the operator hears', async () => {
  const h = stack({ hold: true });
  const e = await h.send(h.at({ text: CRISIS, senderId: MEMBER }));
  await until(() => h.ran.length === 1);
  const stop = await h.stop();
  h.release();
  await h.gate.idle();
  assert.equal(h.state(e), 'failed:aborted');
  assert.deepEqual(h.postedTo(e), [FAILED]);
  assert.equal(h.postedTo(stop).length, 1, 'the ack goes out as well');
  assert.deepEqual(h.alerts('crisis_refused').map(h.reasonOf), ['owner_stop']);
  assert.deepEqual(h.alerts('crisis_refused').map(h.lineOf), ['line_sent']);
  assert.equal(h.pausedBy(), null);
});

// The group's minute is full once the ack is out: three sends before it, and the ack takes the fourth place.
async function stopInFullMinute(options) {
  const h = stack({ hold: true, ...options });
  const e = await h.send(h.at({ text: CRISIS, senderId: MEMBER }));
  await until(() => h.ran.length === 1);
  h.fillMinute(h.dispatched[0].groupKey, 3);
  const stop = await h.stop();
  h.release();
  await h.gate.idle();
  assert.equal(h.state(e), 'failed:aborted');
  assert.equal(h.postedTo(stop).length, 1, 'the ack took the last place in the minute');
  return { h, e };
}

test('that line waits for room in a full minute, inside the passive window, and then goes out', async () => {
  const { h, e } = await stopInFullMinute({ timePasses: true });
  assert.deepEqual(h.postedTo(e), [FAILED]);
  assert.deepEqual(h.alerts('crisis_refused').map(h.reasonOf), ['owner_stop']);
  assert.deepEqual(h.alerts('crisis_refused').map(h.lineOf), ['line_sent']);
});

test('that line still refused after its one wait: the alert says so', async () => {
  const { h, e } = await stopInFullMinute({ timePasses: false });
  assert.deepEqual(h.postedTo(e), []);
  assert.deepEqual(h.alerts('crisis_refused').map(h.reasonOf), ['owner_stop']);
  assert.deepEqual(h.alerts('crisis_refused').map(h.lineOf), ['line_refused']);
});

test('positive control: the same turn with no /stop is answered, with no line and no alert', async () => {
  const h = stack();
  const e = await h.sendAndFlush(h.at({ text: CRISIS, senderId: MEMBER }));
  assert.equal(h.state(e), 'completed:sent');
  assert.deepEqual(h.postedTo(e), [REPLY]);
  assert.equal(h.alerts('crisis_refused').length, 0);
});

test('an ordinary running turn stays silent after /stop', async () => {
  const h = stack({ hold: true });
  const e = await h.send(h.at({ text: '讲个长故事', senderId: MEMBER }));
  await until(() => h.ran.length === 1);
  await h.stop();
  h.release();
  await h.gate.idle();
  assert.equal(h.state(e), 'failed:aborted');
  assert.deepEqual(h.postedTo(e), []);
  assert.equal(h.alerts('crisis_refused').length, 0);
});

test('that one line passes the failure-line cap and does not use it up', async () => {
  for (const [cap, effective] of [[0, noFailLines()], [2, makeEffective()]]) {
    const h = stack({ hold: true, effective });
    const e = await h.send(h.at({ text: CRISIS, senderId: MEMBER }));
    await until(() => h.ran.length === 1);
    await h.stop();
    h.release();
    await h.gate.idle();
    assert.deepEqual(h.postedTo(e), [FAILED], String(cap));
    assert.equal(h.counters().filter((c) => c.key.startsWith('failline:')).length, 0, String(cap));
  }
});

test('no other case passes the cap: a danger reply that came back empty, or refused a hold', async () => {
  const empty = stack({ effective: noFailLines(), text: '' });
  const a = await empty.sendAndFlush(empty.at({ text: CRISIS, senderId: MEMBER }));
  assert.equal(empty.state(a), 'failed:required_no_text');
  assert.deepEqual(empty.postedTo(a), []);

  const broke = stack({ effective: makeEffective({ budget: { addressedUsd: 0 }, limits: { ...makeEffective().limits, failureLinePerGroupPerHour: 0 } }) });
  const b = await broke.sendAndFlush(broke.at({ text: CRISIS, senderId: MEMBER }));
  assert.equal(broke.state(b), 'skipped:budget');
  assert.deepEqual(broke.postedTo(b), []);
});

test('with a part already out there is no failure line, and the operator still hears', async () => {
  const h = stack({ hold: true });
  const real = h.exit;
  h.gate.attachExit({
    ...real,
    async finishTurn(turnId, flags) {
      const [turn] = h.dispatched.filter((t) => t.turnId === turnId);
      const { rows } = h.store.insertSendParts({
        eventKey: turn.eventKey, groupKey: turn.groupKey, kind: 'reply', parts: [{ textSha: 'x' }],
        rate: { accountPerMin: 12, accountPerHour: 120, groupPerMin: 4 }, now: h.now(),
      });
      h.store.markSend(rows[0].sendId, 'sending');
      h.store.markSend(rows[0].sendId, 'sent', { httpStatus: 200 });
      await real.finishTurn(turnId, flags);
      return { state: 'failed', reason: 'aborted' };
    },
  });
  const e = await h.send(h.at({ text: CRISIS, senderId: MEMBER }));
  await until(() => h.ran.length === 1);
  await h.stop();
  h.release();
  await h.gate.idle();
  assert.equal(h.state(e), 'failed:aborted');
  assert.deepEqual(h.postedTo(e), []);
  assert.deepEqual(h.alerts('crisis_refused').map(h.reasonOf), ['owner_stop']);
});

test('an interjection on words of danger has no line to give after /stop, and the operator still hears', async () => {
  const h = stack({ hold: true, decide: async () => decisionOf() });
  const e = await h.send(h.event({ text: CRISIS, senderId: MEMBER }));
  h.advance(4000);
  await until(() => h.ran.length === 1);
  await h.stop();
  h.release();
  await h.gate.idle();
  assert.equal(h.state(e), 'failed:aborted');
  assert.deepEqual(h.postedTo(e), []);
  assert.equal(h.alerts('crisis_refused').length, 1);
});

test('a name line off the list the model called danger past the caps counts as danger at /stop', async () => {
  const h = stack({
    hold: true,
    effective: makeEffective({ limits: { ...makeEffective().limits, crisisRoutePerSenderPerHour: 0 } }),
    decide: async () => decisionOf({ crisis: true, action: 'reply' }),
  });
  assert.equal(h.policy.isCrisisRoute(NAME_A), false, 'off the list');
  const e = await h.send(h.event({ text: NAME_A, senderId: MEMBER }));
  h.advance(4000);
  await until(() => h.ran.length === 1);
  await h.stop();
  h.release();
  await h.gate.idle();
  assert.equal(h.state(e), 'failed:aborted');
  assert.deepEqual(h.postedTo(e), [FAILED]);
  assert.deepEqual(h.alerts('crisis_refused').map(h.reasonOf), ['owner_stop']);
});

// ---- after the model confirmed danger ----

// Room for the decision, not for the reply's hold.
function overRateNoReplyRoom(limits = {}) {
  const probe = makeHarness();
  open.push(probe);
  const decisionUsd = probe.ledger.holdMicros('decision') / 1e6;
  assert.ok(probe.ledger.holdMicros('reply_required') > 3 * probe.ledger.holdMicros('decision'));
  return stack({
    effective: makeEffective({ budget: { addressedUsd: decisionUsd * 2 }, limits: { ...makeEffective().limits, perSenderAddressedPerHour: 0, ...limits } }),
    decide: async () => decisionOf({ crisis: true, action: 'reply' }),
  });
}

test('the model confirmed danger and the reply hold is refused: the line goes out and the operator hears', async () => {
  const h = overRateNoReplyRoom();
  const e = await h.sendAndFlush(h.at({ text: CRISIS, senderId: MEMBER }));
  assert.equal(h.decideCalls.length, 1);
  assert.equal(h.state(e), 'skipped:budget');
  assert.deepEqual(h.postedTo(e), [FAILED]);
  assert.deepEqual(h.alerts('crisis_refused').map(h.reasonOf), ['budget']);
});

test('the same with the failure lines spent: no post, so the alert is the only signal', async () => {
  const h = overRateNoReplyRoom({ failureLinePerGroupPerHour: 0 });
  const e = await h.sendAndFlush(h.at({ text: CRISIS, senderId: MEMBER }));
  assert.equal(h.state(e), 'skipped:budget');
  assert.deepEqual(h.postedTo(e), []);
  assert.deepEqual(h.alerts('crisis_refused').map(h.reasonOf), ['budget']);
});

test('a hold refused for someone not in danger raises nothing', async () => {
  const h = stack({ effective: makeEffective({ budget: { addressedUsd: 0 } }) });
  const e = await h.sendAndFlush(h.at({ text: '帮我看个问题', senderId: MEMBER }));
  assert.equal(h.state(e), 'skipped:budget');
  assert.equal(h.alerts('crisis_refused').length, 0);
});

test('a name line off the list the model called danger past the caps: a refused hold still raises it', async () => {
  const h = stack({
    effective: makeEffective({ budget: { namedUsd: 0.05 }, limits: { ...makeEffective().limits, crisisRoutePerSenderPerHour: 0 } }),
    decide: async () => decisionOf({ crisis: true, action: 'reply' }),
  });
  const e = await h.sendAndFlush(h.event({ text: NAME_A, senderId: MEMBER }));
  assert.equal(h.state(e), 'skipped:budget');
  assert.deepEqual(h.alerts('crisis_refused').map(h.reasonOf), ['budget']);
});

// ---- the watchdog ----

test('a watchdog-aborted danger turn raises the alert, with no line: its time has run out', async () => {
  const h = stack({ aborted: true, usage: null });
  const e = await h.sendAndFlush(h.at({ text: CRISIS, senderId: MEMBER }));
  assert.equal(h.state(e), 'failed:aborted');
  assert.deepEqual(h.postedTo(e), []);
  assert.deepEqual(h.alerts('crisis_refused').map(h.reasonOf), ['aborted']);
});

// ---- a running danger turn whose written reply a pause or the deadline takes ----

test('a pause landing while a danger turn runs: no line, and the operator hears', async () => {
  const h = stack({ hold: true });
  const e = await h.send(h.at({ text: CRISIS, senderId: MEMBER }));
  await until(() => h.ran.length === 1);
  h.clock.t += 1000;
  const pause = await h.send(h.at({ text: '/clo pause', senderId: OWNER }));
  await tick();
  h.release();
  await h.gate.idle();
  assert.equal(h.state(pause), 'completed:cmd_owner');
  assert.equal(h.state(e), 'paused:paused');
  assert.deepEqual(h.postedTo(e), []);
  assert.deepEqual(h.alerts('crisis_refused').map(h.reasonOf), ['paused']);
});

test('the same pause on an ordinary running turn raises nothing', async () => {
  const h = stack({ hold: true });
  const e = await h.send(h.at({ text: '讲个长故事', senderId: MEMBER }));
  await until(() => h.ran.length === 1);
  h.clock.t += 1000;
  await h.send(h.at({ text: '/clo pause', senderId: OWNER }));
  await tick();
  h.release();
  await h.gate.idle();
  assert.equal(h.state(e), 'paused:paused');
  assert.equal(h.alerts('crisis_refused').length, 0);
});

test('a danger turn that ran past the passive window: no line, and the operator hears', async () => {
  const h = stack({ hold: true });
  const e = await h.send(h.at({ text: CRISIS, senderId: MEMBER }));
  await until(() => h.ran.length === 1);
  h.clock.t = h.dispatched[0].deadlineAt;
  h.release();
  await h.gate.idle();
  assert.equal(h.state(e), 'failed:deadline');
  assert.deepEqual(h.postedTo(e), []);
  assert.deepEqual(h.alerts('crisis_refused').map(h.reasonOf), ['deadline']);
});

test('a watchdog-aborted ordinary turn raises nothing', async () => {
  const h = stack({ aborted: true, usage: null });
  const e = await h.sendAndFlush(h.at({ text: '讲个长故事', senderId: MEMBER }));
  assert.equal(h.state(e), 'failed:aborted');
  assert.equal(h.alerts('crisis_refused').length, 0);
});

// ---- the same verdict, whatever the action field says ----

function nameOverRate(answer) {
  return stack({
    effective: makeEffective({ limits: { ...makeEffective().limits, perSenderAddressedPerHour: 0, crisisRoutePerSenderPerHour: 0 } }),
    decide: async () => decisionOf(answer),
  });
}

test('danger past the sender cap and the crisis caps alerts whether the model said reply or skip', async () => {
  for (const [action, end] of [['reply', 'skipped:sender_rate'], ['skip', 'skipped:decision_skip']]) {
    const h = nameOverRate({ crisis: true, action });
    const e = await h.sendAndFlush(h.event({ text: NAMED_CRISIS, senderId: MEMBER }));
    assert.equal(h.decideCalls.length, 1, action);
    assert.equal(h.state(e), end, action);
    assert.deepEqual(h.postedTo(e), [], action);
    assert.equal(h.alerts('crisis_refused').length, 1, action);
  }
});

test('over the sender cap with the model saying no danger: nothing raised', async () => {
  const h = nameOverRate({ crisis: false, action: 'reply' });
  const e = await h.sendAndFlush(h.event({ text: NAMED_CRISIS, senderId: MEMBER }));
  assert.equal(h.state(e), 'skipped:sender_rate');
  assert.equal(h.alerts('crisis_refused').length, 0);
});

test('a name decision out at /stop that calls an off-list line danger past the caps alerts as it ends', async () => {
  for (const [crisis, count] of [[true, 1], [false, 0]]) {
    const hold = deferred();
    const h = stack({
      effective: makeEffective({ limits: { ...makeEffective().limits, crisisRoutePerSenderPerHour: 0 } }),
      decide: async () => {
        await hold.promise;
        return decisionOf({ crisis, action: 'reply' });
      },
    });
    const e = await h.send(h.event({ text: NAME_A, senderId: MEMBER }));
    h.advance(4000);
    await until(() => h.decideCalls.length === 1);
    await h.stop();
    hold.resolve();
    await h.gate.idle();
    assert.equal(h.state(e), 'skipped:owner_stop', String(crisis));
    assert.equal(h.alerts('crisis_refused').length, count, String(crisis));
  }
});

// ---- shutdown ----

test('a danger turn running when the exit stops raises the same alert as a queued one', async () => {
  const h = stack({ hold: true });
  const e = await h.send(h.at({ text: CRISIS, senderId: MEMBER }));
  await until(() => h.ran.length === 1);
  h.exit.stop();
  const stopping = h.gate.stop();
  h.release();
  await stopping;
  assert.equal(h.state(e), 'failed:exit_refused');
  assert.deepEqual(h.postedTo(e), []);
  assert.equal(h.alerts('crisis_dropped_on_stop').length, 1);
  assert.equal(h.alerts('crisis_refused').length, 0);
});

test('the exit stopped and the gate not yet: the same alert', async () => {
  const h = stack({ hold: true });
  const e = await h.send(h.at({ text: CRISIS, senderId: MEMBER }));
  await until(() => h.ran.length === 1);
  h.exit.stop();
  h.release();
  await h.gate.idle();
  assert.equal(h.state(e), 'failed:exit_refused');
  assert.equal(h.alerts('crisis_dropped_on_stop').length, 1);
});

test('an ordinary turn running at shutdown raises nothing, and a danger turn refused with the exit up is not called a shutdown', async () => {
  const plain = stack({ hold: true });
  await plain.send(plain.at({ text: '讲个长故事', senderId: MEMBER }));
  await until(() => plain.ran.length === 1);
  plain.exit.stop();
  plain.release();
  await plain.gate.idle();
  assert.equal(plain.alerts('crisis_dropped_on_stop').length, 0);

  const up = stack({ hold: true });
  const e = await up.send(up.at({ text: CRISIS, senderId: MEMBER }));
  await until(() => up.ran.length === 1);
  delete up.eff.current.qq.groups[GROUP_A];
  up.release();
  await up.gate.idle();
  assert.equal(up.state(e), 'failed:exit_refused');
  assert.equal(up.alerts('crisis_dropped_on_stop').length, 0);
  assert.deepEqual(up.alerts('crisis_refused').map(up.reasonOf), ['exit_refused']);
});

// ---- a failure line after the stop ack ----

test('a URL refusal after /stop posts no failure line behind the ack', async () => {
  const h = stack();
  let stop = null;
  h.onPost = async (body) => {
    if (stop === null && body.content === REPLY) {
      h.failNext.set(body.msg_id, URL_REFUSED());
      stop = h.stop();
      await stop;
    }
  };
  const e = await h.sendAndFlush(h.at({ text: '讲个长故事', senderId: MEMBER }));
  assert.equal(h.state(e), 'failed:group_error');
  assert.deepEqual(h.postedTo(e), [REPLY], 'the refused post, and nothing after it');
  assert.equal(h.postedTo(await stop).length, 1);
});

test('positive control: the same refusal with no /stop gets the failure line', async () => {
  const h = stack();
  h.onPost = async (body) => {
    if (body.content === REPLY && h.posts.length === 1) h.failNext.set(body.msg_id, URL_REFUSED());
  };
  const e = await h.sendAndFlush(h.at({ text: '讲个长故事', senderId: MEMBER }));
  assert.equal(h.state(e), 'failed:group_error');
  assert.deepEqual(h.postedTo(e), [REPLY, FAILED]);
});

test('the same refusal for a person in danger keeps the failure line after /stop', async () => {
  const h = stack();
  let stop = null;
  h.onPost = async (body) => {
    if (stop === null && body.content === REPLY) {
      h.failNext.set(body.msg_id, URL_REFUSED());
      stop = h.stop();
      await stop;
    }
  };
  const e = await h.sendAndFlush(h.at({ text: CRISIS, senderId: MEMBER }));
  assert.deepEqual(h.postedTo(e), [REPLY, FAILED]);
});

// ---- an abort and the usage figure ----

// A two-part reply, with /stop landing while the first part is out.
async function stoppedBetweenParts(usage) {
  const h = stack({ text: LONG_REPLY, usage });
  let stop = null;
  h.onPost = async () => {
    if (stop === null) {
      stop = h.stop();
      await stop;
    }
  };
  const e = await h.sendAndFlush(h.at({ text: '讲个长故事', senderId: MEMBER }));
  assert.equal(h.state(e), 'failed:aborted');
  assert.equal(h.postedTo(e).length, 1, 'one part went out, and the second did not');
  return { h, e };
}

test('aborted after a part went out with no usage figure: paid work pauses', async () => {
  const { h, e } = await stoppedBetweenParts(null);
  assert.equal(h.pausedBy(), 'usage_missing');
  assert.deepEqual(h.reservations(e).map((r) => r.status), ['unsettled']);
});

test('aborted after a part went out with a usage figure: nothing pauses', async () => {
  const { h, e } = await stoppedBetweenParts(USAGE);
  assert.equal(h.pausedBy(), null);
  assert.deepEqual(h.reservations(e).map((r) => r.status), ['settled']);
});

test('aborted with nothing sent and no usage figure: one /stop pauses nothing', async () => {
  const h = stack({ hold: true, usage: null });
  const e = await h.send(h.at({ text: '讲个长故事', senderId: MEMBER2 }));
  await until(() => h.ran.length === 1);
  await h.stop();
  h.release();
  await h.gate.idle();
  assert.equal(h.state(e), 'failed:aborted');
  assert.equal(h.pausedBy(), null);
  assert.deepEqual(h.reservations(e).map((r) => r.status), ['unsettled']);
});

test('a watchdog abort with nothing sent and no usage figure pauses nothing', async () => {
  const h = stack({ aborted: true, usage: null });
  await h.sendAndFlush(h.at({ text: '讲个长故事', senderId: MEMBER }));
  assert.equal(h.pausedBy(), null);
});

test('the fixed line for an aborted danger turn does not count as a sent part', async () => {
  const h = stack({ hold: true, usage: null });
  const e = await h.send(h.at({ text: CRISIS, senderId: MEMBER }));
  await until(() => h.ran.length === 1);
  await h.stop();
  h.release();
  await h.gate.idle();
  assert.deepEqual(h.postedTo(e), [FAILED]);
  assert.equal(h.pausedBy(), null);
});

// ---- what the model called danger counts on the later paths too ----

test('an off-list name line the model called danger keeps the failure line after /stop on a URL refusal', async () => {
  const h = stack({
    effective: makeEffective({ limits: { ...makeEffective().limits, crisisRoutePerSenderPerHour: 0 } }),
    decide: async () => decisionOf({ crisis: true, action: 'reply' }),
  });
  let stop = null;
  h.onPost = async (body) => {
    if (stop === null && body.content === REPLY) {
      h.failNext.set(body.msg_id, URL_REFUSED());
      stop = h.stop();
      await stop;
    }
  };
  const e = await h.sendAndFlush(h.event({ text: NAME_A, senderId: MEMBER }));
  assert.deepEqual(h.postedTo(e), [REPLY, FAILED]);
});

test('an off-list name line the model called danger, with the decision out at shutdown: the shutdown alert', async () => {
  const hold = deferred();
  const h = stack({
    effective: makeEffective({ limits: { ...makeEffective().limits, crisisRoutePerSenderPerHour: 0 } }),
    decide: async () => {
      await hold.promise;
      return decisionOf({ crisis: true, action: 'reply' });
    },
  });
  const e = await h.send(h.event({ text: NAME_A, senderId: MEMBER }));
  h.advance(4000);
  await until(() => h.decideCalls.length === 1);
  const stopping = h.gate.stop();
  hold.resolve();
  await stopping;
  assert.equal(h.state(e), 'restart_dropped:restart');
  assert.equal(h.alerts('crisis_dropped_on_stop').length, 1);
});

// The gate gives running work a few seconds at shutdown, and then the store is closed under whatever is still going.
async function outlastGrace(text) {
  const h = stack({ hold: true });
  const e = await h.send(h.at({ text, senderId: MEMBER }));
  await until(() => h.ran.length === 1);
  h.exit.stop();
  const stopping = h.gate.stop();
  h.advance(5000);
  await stopping;
  return { h, e };
}

test('a danger turn still running when the shutdown grace ends raises the shutdown alert before the store closes', async () => {
  const { h, e } = await outlastGrace(CRISIS);
  assert.equal(h.alerts('crisis_dropped_on_stop').length, 1, 'raised while the store is still open');
  assert.equal(h.alerts('crisis_refused').length, 0);
  assert.equal(h.state(e), 'dispatching', 'the turn itself has not ended yet');
  h.store.close();
  h.release();
  for (let i = 0; i < 50; i += 1) await tick();
  const again = openStore(h.file, { runGen: 'gen-2', now: h.now });
  try {
    again.recoverOnStart(h.now());
    assert.deepEqual(again.listAlerts().filter((a) => a.kind === 'crisis_dropped_on_stop').map((a) => a.detail.eventKey), [again.key(e.messageId)]);
    assert.equal(JSON.stringify(again.getEvent(again.key(e.messageId))).includes('crisis'), false, 'no danger marker on the row');
  } finally {
    again.close();
  }
});

test('that turn ending later, with the store still open, does not raise the alert a second time', async () => {
  const { h, e } = await outlastGrace(CRISIS);
  h.release();
  await h.gate.idle();
  assert.equal(h.state(e), 'failed:exit_refused');
  assert.deepEqual(h.postedTo(e), []);
  assert.equal(h.alerts('crisis_dropped_on_stop').length, 1);
  assert.equal(h.alerts('crisis_refused').length, 0);
});

test('positive control: an ordinary turn outlasting the grace raises nothing', async () => {
  const { h, e } = await outlastGrace('讲个长故事');
  h.release();
  await h.gate.idle();
  assert.equal(h.state(e), 'failed:exit_refused');
  assert.equal(h.store.listAlerts().length, 0);
});
