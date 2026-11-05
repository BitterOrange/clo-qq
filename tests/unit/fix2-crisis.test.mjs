// Crisis routing in the window flush and past the decision breaker: who is judged, who merges, what it costs in caps.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '@tencent-connect/qqbot-nodejs';
import '../harness/net-guard.mjs';
import { decisionOf, deferred, GROUP_A, groupEntry, makeEffective, makeHarness, MEMBER, MEMBER2, seamStack, USAGE } from '../fixtures/inbound.mjs';

const MEMBER3 = 'THIRDMEMBER111122223333';
const MEMBER4 = 'FOURTHMEMBER11122223333';
const MEMBER5 = 'FIFTHMEMBER111122223333';
const MIN = 60000;
const HOUR = 60 * MIN;
const RETRY = 10 * MIN;
const CRISIS = '我真的不想活了';
const NAME_A = '可洛你看看退货怎么办';
const NAME_B = '可洛今天开会是几点';
const NAME_C = '可洛帮我想个标题吧';
const CHAT = '今天中午吃什么好呢';
const quiet = { quietHours: { start: '00:00', end: '23:59', timezone: 'Asia/Shanghai' } };
const closed = (over = {}) => makeEffective({ qq: { groups: { [GROUP_A]: groupEntry({ interject: false }) } }, ...over });
const tick = () => new Promise((r) => setImmediate(r));
const until = async (cond) => {
  for (let i = 0; i < 2000 && !cond(); i += 1) await tick();
  assert.ok(cond(), 'the expected state was never reached');
};
const answersCrisis = async (req) => decisionOf({ crisis: req.current.text.includes(CRISIS) });
const failed = () => decisionOf({ action: 'skip', invalid: 'http', actualMicros: null, httpStatus: 500 });
const texts = (h) => h.decideCalls.map((c) => c.current.text);
const triggers = (h) => h.decideCalls.map((c) => [c.trigger, c.current.text]);
const counted = (h, prefix) => h.counters().filter((c) => c.key.startsWith(prefix)).reduce((n, c) => n + Number(c.value), 0);
const crisisGroup = (h) => counted(h, 'crisis_group:');
const bypassGroup = (h) => counted(h, 'decision_bypass:');
const ends = (h, e) => h.logs.filter((l) => (l.event === 'gate_end' || l.event === 'turn_end') && l.eventKey === h.store.key(e.messageId)).length;

async function flushWindow(h, ...events) {
  const sent = [];
  for (const e of events) sent.push(await h.send(e));
  h.advance(4000);
  await h.gate.idle();
  return sent;
}

// The first decision waits for the test to let it go; the rest answer at once.
function holdingFirst(answer = answersCrisis) {
  const hold = deferred();
  let n = 0;
  return {
    hold,
    decide: async (req) => {
      n += 1;
      if (n === 1) await hold.promise;
      return answer(req);
    },
  };
}

async function openedBreaker(over = {}) {
  const ctl = { d: failed() };
  const h = makeHarness({ decide: async () => ctl.d, ...over });
  for (const text of ['第一条普通消息', '第二条普通消息', '第三条普通消息']) await h.sendAndFlush(h.event({ text }));
  assert.equal(h.store.getControl('decision_paused'), 'open', 'positive control: three failures open it');
  return { h, ctl };
}

// ---- the crisis caps hold on every way past the open breaker ----

test('breaker open: danger words on the ordinary path buy decisions only up to a count of their own', async () => {
  const { h } = await openedBreaker();
  const calls = h.decideCalls.length;
  const sent = [];
  for (let i = 0; i < 6; i += 1) sent.push(await h.sendAndFlush(h.event({ text: `${CRISIS}${i}`, senderId: MEMBER })));
  assert.equal(h.decideCalls.length - calls, 2, 'the per-sender cap, whoever keeps posting');
  assert.deepEqual(h.decideCalls.slice(calls).map((c) => c.trigger), ['ordinary', 'ordinary']);
  assert.equal(bypassGroup(h), 2);
  assert.equal(crisisGroup(h), 0, 'a failed decision leaves the crisis caps whole');
  for (const e of sent.slice(2)) {
    assert.equal(h.state(e), 'skipped:decision_paused');
    assert.deepEqual(h.reservations(e), [], 'refused before any hold');
  }

  const second = await h.sendAndFlush(h.event({ text: CRISIS, senderId: MEMBER2 }));
  assert.equal(h.decideCalls.length - calls, 3, 'someone else still has room');
  assert.equal(h.state(second), 'skipped:decision_invalid');
  assert.equal(bypassGroup(h), 3);
  assert.equal(crisisGroup(h), 0);
  const third = await h.sendAndFlush(h.event({ text: CRISIS, senderId: MEMBER3 }));
  assert.equal(h.decideCalls.length - calls, 3, 'the per-group cap');
  assert.equal(h.state(third), 'skipped:decision_paused');
  await h.close();
});

test('breaker open: the same holds for a name message in danger', async () => {
  const { h } = await openedBreaker();
  const calls = h.decideCalls.length;
  const sent = [];
  for (let i = 0; i < 3; i += 1) sent.push(await h.sendAndFlush(h.event({ text: `可洛，${CRISIS}${i}` })));
  assert.deepEqual(h.decideCalls.slice(calls).map((c) => c.trigger), ['name', 'name']);
  assert.equal(h.state(sent[2]), 'skipped:decision_paused');
  await h.close();
});

test('breaker open: one message takes one crisis slot, answered as crisis', async () => {
  const { h, ctl } = await openedBreaker();
  ctl.d = decisionOf({ crisis: true });
  await h.sendAndFlush(h.event({ text: CRISIS }));
  assert.equal(h.dispatched.at(-1).cls, 'crisis');
  assert.equal(crisisGroup(h), 1, 'taken once, at the routing');
  assert.equal(bypassGroup(h), 1);
  await h.close();
});

test('breaker open: an answer that says it is not crisis keeps no crisis slot', async () => {
  const { h, ctl } = await openedBreaker();
  ctl.d = decisionOf({ action: 'skip' });
  const e = await h.sendAndFlush(h.event({ text: CRISIS }));
  assert.equal(h.state(e), 'skipped:decision_skip');
  assert.equal(bypassGroup(h), 1, 'positive control: it did go past the breaker');
  assert.equal(crisisGroup(h), 0);
  await h.close();
});

// Failures while it is open, then a healthy trial shuts it.
async function outageOver(h, ctl) {
  h.advance(RETRY);
  ctl.d = decisionOf({ action: 'skip' });
  await h.sendAndFlush(h.event({ text: '恢复之后的一句普通消息', senderId: MEMBER5 }));
  assert.equal(h.store.getControl('decision_paused'), null, 'positive control: the trial shut it');
}
const crisisOnFlaggedTopic = () => decisionOf({ action: 'skip', skipClass: 'harm_person', crisis: true });

test('after the outage: the person whose decisions failed still gets a crisis reply', async () => {
  const { h, ctl } = await openedBreaker();
  for (const text of [CRISIS, `${CRISIS}吧`]) assert.equal(h.state(await h.sendAndFlush(h.event({ text }))), 'skipped:decision_invalid');
  await outageOver(h, ctl);
  h.advance(MIN);
  ctl.d = crisisOnFlaggedTopic();
  const e = await h.sendAndFlush(h.event({ text: `还是${CRISIS}` }));
  assert.equal(h.state(e), 'completed:sent');
  assert.equal(h.dispatched.at(-1).cls, 'crisis');
  await h.close();
});

test('after the outage: a group that used the whole bypass still has its crisis replies', async () => {
  const { h, ctl } = await openedBreaker();
  for (const senderId of [MEMBER, MEMBER2, MEMBER3]) await h.sendAndFlush(h.event({ text: CRISIS, senderId }));
  assert.equal(bypassGroup(h), 3);
  await outageOver(h, ctl);
  h.advance(3 * HOUR);
  ctl.d = crisisOnFlaggedTopic();
  const e = await h.sendAndFlush(h.event({ text: CRISIS, senderId: MEMBER4 }));
  assert.equal(h.state(e), 'completed:sent');
  assert.equal(h.dispatched.at(-1).cls, 'crisis');
  await h.close();
});

test('breaker open: with the real caps spent no bypass is bought, whatever room the bypass has', async () => {
  const cases = [
    ['the sender', makeEffective(), [CRISIS, `${CRISIS}吧`], MEMBER],
    ['the group', makeEffective({ limits: { crisisRoutePerGroupPerDay: 1 } }), [CRISIS], MEMBER2],
  ];
  for (const [who, effective, spend, next] of cases) {
    const ctl = { d: decisionOf({ crisis: true }) };
    const h = makeHarness({ effective, decide: async () => ctl.d });
    for (const text of spend) await h.sendAndFlush(h.event({ text }));
    assert.equal(h.dispatched.length, spend.length, 'positive control: the caps went on real replies');
    ctl.d = failed();
    for (const text of ['第一条普通消息', '第二条普通消息', '第三条普通消息']) await h.sendAndFlush(h.event({ text }));
    assert.equal(h.store.getControl('decision_paused'), 'open');
    const calls = h.decideCalls.length;
    const e = await h.sendAndFlush(h.event({ text: `又一次${CRISIS}`, senderId: next }));
    assert.equal(h.state(e), 'skipped:decision_paused', who);
    assert.equal(h.decideCalls.length, calls, who);
    assert.equal(bypassGroup(h), 0, who);
    await h.close();
  }
});

test('breaker open: past the caps nothing is bought, so a crisis answer cannot reach a reply either', async () => {
  const eff = makeEffective({ limits: { crisisRoutePerSenderPerHour: 0 } });
  const { h, ctl } = await openedBreaker({ effective: eff });
  const calls = h.decideCalls.length;
  ctl.d = decisionOf({ crisis: true });
  const e = await h.sendAndFlush(h.event({ text: CRISIS }));
  assert.equal(h.state(e), 'skipped:decision_paused');
  assert.equal(h.decideCalls.length, calls);
  assert.equal(h.dispatched.length, 0);
  await h.close();
});

test('breaker open: a claim refused later gives the crisis slot back', async () => {
  const { h, ctl } = await openedBreaker();
  const calls = h.decideCalls.length;
  h.store.setControl('paid_paused', 'residual', 'test');
  for (let i = 0; i < 3; i += 1) assert.equal(h.state(await h.sendAndFlush(h.event({ text: `${CRISIS}${i}` }))), 'skipped:paid_paused');
  assert.equal(bypassGroup(h), 0);
  assert.equal(h.decideCalls.length, calls);
  h.store.delControl('paid_paused');
  ctl.d = failed();
  await h.sendAndFlush(h.event({ text: CRISIS }));
  await h.sendAndFlush(h.event({ text: `${CRISIS}吧` }));
  assert.equal(h.decideCalls.length, calls + 2, 'the per-sender room is whole');
  await h.close();
});

test('breaker past its wait: danger words take the trial like anything else, and no crisis slot', async () => {
  const { h } = await openedBreaker();
  const calls = h.decideCalls.length;
  h.advance(RETRY);
  await h.sendAndFlush(h.event({ text: CRISIS }));
  assert.equal(h.decideCalls.length, calls + 1);
  assert.equal(crisisGroup(h), 0);
  assert.equal(bypassGroup(h), 0);
  await h.close();
});

// ---- one person, one turn ----

test('one person saying her name in danger, then danger again in one window: one turn on the last, one slot', async () => {
  const h = makeHarness({ decide: answersCrisis });
  const first = `可洛 ${CRISIS}`;
  const last = `${CRISIS}吧`;
  const [a, b] = await flushWindow(h, h.event({ text: first }), h.event({ text: last }));
  assert.deepEqual(triggers(h), [['ordinary', last]]);
  assert.deepEqual(h.dispatched.map((t) => t.cls), ['crisis']);
  assert.equal(h.state(a), 'merged:merged');
  assert.equal(h.row(a).merged_into, h.row(b).event_key);
  assert.equal(h.state(b), 'completed:sent');
  for (const e of [a, b]) assert.equal(ends(h, e), 1);
  assert.equal(crisisGroup(h), 1);

  h.advance(MIN);
  await h.sendAndFlush(h.event({ text: `还是${CRISIS}` }));
  assert.equal(h.dispatched.at(-1).cls, 'crisis', 'the sender cap of 2 still has room a minute later');
  await h.close();
});

test('the same two lines in quiet hours: one crisis_route decision, one slot', async () => {
  const h = makeHarness({ effective: makeEffective(quiet), decide: answersCrisis });
  const last = `${CRISIS}吧`;
  const [a] = await flushWindow(h, h.event({ text: `可洛 ${CRISIS}` }), h.event({ text: last }));
  assert.deepEqual(triggers(h), [['crisis_route', last]]);
  assert.equal(h.state(a), 'merged:merged');
  assert.equal(crisisGroup(h), 1);
  await h.close();
});

test('the later line cannot be rescued: the name message is the turn and the later line follows it', async () => {
  const h = makeHarness({ effective: closed(), decide: answersCrisis });
  const first = `可洛 ${CRISIS}`;
  const [a, b] = await flushWindow(h, h.event({ text: first }), h.event({ text: `${CRISIS}吧` }));
  assert.deepEqual(triggers(h), [['name', first]]);
  assert.equal(h.state(a), 'completed:sent');
  assert.equal(h.row(b).merged_into, h.row(a).event_key);
  await h.close();
});

test('only that person folds: another name in the window is judged, and chat follows it', async () => {
  const h = makeHarness({ decide: answersCrisis });
  const last = `${CRISIS}吧`;
  const [a, b, y, chat] = await flushWindow(h, h.event({ text: `可洛 ${CRISIS}` }), h.event({ text: last }), h.event({ text: NAME_B, senderId: MEMBER2 }), h.event({ text: CHAT, senderId: MEMBER2 }));
  assert.deepEqual(triggers(h), [['ordinary', last], ['name', NAME_B]]);
  assert.equal(h.row(a).merged_into, h.row(b).event_key);
  assert.equal(h.row(chat).merged_into, h.row(y).event_key);
  for (const e of [a, b, y, chat]) assert.equal(ends(h, e), 1);
  await h.close();
});

test('two people in danger, one saying her name: each is judged, nobody folds into the other', async () => {
  const h = makeHarness({ decide: answersCrisis });
  const named = `可洛 ${CRISIS}`;
  const other = `我也${CRISIS}`;
  const [x, y] = await flushWindow(h, h.event({ text: named, senderId: MEMBER }), h.event({ text: other, senderId: MEMBER2 }));
  assert.deepEqual(triggers(h), [['ordinary', other], ['name', named]]);
  assert.equal(h.row(x).merged_into, null);
  assert.equal(h.state(x), 'completed:sent');
  assert.equal(h.state(y), 'completed:sent');
  await h.close();
});

test('the later line gets no decision: the name message is judged after all, not merged into a skipped row', async () => {
  const noCrisisSlots = { crisisRoutePerGroupPerDay: 0 };
  const cases = [
    ['quiet hours, group cap spent', makeEffective({ ...quiet, limits: noCrisisSlots }), 'skipped:quiet'],
    ['interjection tier spent, group cap spent', makeEffective({ budget: { interjectUsd: 0 }, limits: noCrisisSlots }), 'skipped:budget'],
  ];
  for (const [title, effective, later] of cases) {
    const h = makeHarness({ effective, decide: answersCrisis });
    const first = `可洛 ${CRISIS}`;
    const [a, b] = await flushWindow(h, h.event({ text: first }), h.event({ text: `${CRISIS}吧` }));
    assert.deepEqual(triggers(h), [['name', first]], title);
    assert.deepEqual(h.dispatched.map((t) => t.cls), ['name_addressed'], title);
    assert.equal(h.state(a), 'completed:sent', title);
    assert.equal(h.row(a).merged_into, null, title);
    assert.equal(h.state(b), later, title);
    for (const e of [a, b]) assert.equal(ends(h, e), 1, title);
    await h.close();
  }
});

test('the later line, queued, is refused once the lane reaches it: the name message is judged after all', async () => {
  const { hold, decide } = holdingFirst();
  const h = makeHarness({ decide });
  const first = `可洛 ${CRISIS}`;
  const other = `我也${CRISIS}`;
  const a = await h.send(h.event({ text: first }));
  const b = await h.send(h.event({ text: `${CRISIS}吧` }));
  await h.send(h.event({ text: other, senderId: MEMBER2 }));
  h.advance(4000);
  await until(() => h.decideCalls.length === 1);
  h.eff.current.qq.groups[GROUP_A].interject = false;
  hold.resolve();
  await h.gate.idle();
  assert.deepEqual(triggers(h), [['ordinary', other], ['name', first]]);
  assert.equal(h.state(b), 'skipped:interject_off');
  assert.equal(h.state(a), 'completed:sent');
  await h.close();
});

test('the later line got its decision and the answer is no: nothing spoke, so the name message is judged itself', async () => {
  const h = makeHarness({ decide: async () => decisionOf({ action: 'skip' }) });
  const last = `${CRISIS}吧`;
  const name = `可洛 ${CRISIS}`;
  const [a, b] = await flushWindow(h, h.event({ text: name }), h.event({ text: last }));
  assert.deepEqual(triggers(h), [['ordinary', last], ['name', name]]);
  assert.equal(h.state(b), 'skipped:decision_skip');
  assert.equal(h.state(a), 'skipped:decision_skip');
  assert.equal(h.row(a).merged_into, null);
  await h.close();
});

test('the name message judged itself can still get the reply the later line did not', async () => {
  const name = `可洛 ${CRISIS}`;
  const h = makeHarness({ decide: async (req) => (req.current.text === name ? decisionOf({ crisis: true }) : decisionOf({ action: 'skip' })) });
  const last = `${CRISIS}吧`;
  const [a] = await flushWindow(h, h.event({ text: name }), h.event({ text: last }));
  assert.equal(h.state(a), 'completed:sent');
  assert.deepEqual(h.dispatched.map((t) => [t.cls, t.text]), [['crisis', name]]);
  await h.close();
});

test('positive control: the later line got a turn, so the name message merges into it with no decision of its own', async () => {
  const h = makeHarness({ decide: answersCrisis });
  const last = `${CRISIS}吧`;
  const [a, b] = await flushWindow(h, h.event({ text: `可洛 ${CRISIS}` }), h.event({ text: last }));
  assert.deepEqual(triggers(h), [['ordinary', last]]);
  assert.equal(h.state(a), 'merged:merged');
  assert.equal(h.row(a).merged_into, h.row(b).event_key);
  assert.equal(h.dispatched.length, 1);
  await h.close();
});

// ---- what the later line's turn actually did ----

const FOLD_NAME = `可洛 ${CRISIS}`;
const FOLD_LAST = `${CRISIS}吧`;
const replyNotCrisis = async () => decisionOf({ action: 'reply', crisis: false });
const ranOk = { started: true, hostError: false, aborted: false, usage: USAGE };
const foldAlerts = (h, kind) => h.store.listAlerts().filter((a) => a.kind === kind);

// The later line takes a turn that is not required, ending as the case says. Every other turn runs and sends.
function foldedHarness(first, exitResult = null, decide = replyNotCrisis) {
  const h = makeHarness({
    decide,
    dispatch: async (turn) => {
      h.exit.result = turn.cls === 'interject' ? exitResult : null;
      return turn.cls === 'interject' ? first : ranOk;
    },
  });
  return h;
}

test('the later line\'s turn said nothing: the name message is judged itself and gets the required turn', async () => {
  const cases = [
    ['the model returned nothing', ranOk, { state: 'silent', reason: 'no_reply' }, 'silent:no_reply', []],
    ['the host failed', { ...ranOk, hostError: true, usage: null }, { state: 'silent', reason: 'host_error' }, 'silent:host_error', []],
    ['the host ran nothing', { started: false, reason: 'ingress', hostError: false, aborted: false, usage: null }, null, 'skipped:ingress', ['host_refused']],
  ];
  for (const [title, first, exitResult, later, alertKinds] of cases) {
    const h = foldedHarness(first, exitResult);
    const [a, b] = await flushWindow(h, h.event({ text: FOLD_NAME }), h.event({ text: FOLD_LAST }));
    assert.deepEqual(triggers(h), [['ordinary', FOLD_LAST], ['name', FOLD_NAME]], title);
    assert.deepEqual(h.dispatched.map((t) => [t.cls, t.required]), [['interject', false], ['name_addressed', true]], title);
    assert.equal(h.state(b), later, title);
    assert.equal(h.state(a), 'completed:sent', title);
    assert.equal(h.row(a).merged_into, null, title);
    assert.deepEqual(h.store.listAlerts().map((x) => x.kind), alertKinds, title);
    for (const e of [a, b]) assert.equal(ends(h, e), 1, title);
    await h.close();
  }
});

test('judged itself after a silent turn, the name message can still be the one the model calls danger', async () => {
  const h = foldedHarness(ranOk, { state: 'silent', reason: 'no_reply' }, async (req) => decisionOf({ action: 'reply', crisis: req.current.text === FOLD_NAME }));
  const [a] = await flushWindow(h, h.event({ text: FOLD_NAME }), h.event({ text: FOLD_LAST }));
  assert.deepEqual(h.dispatched.map((t) => t.cls), ['interject', 'crisis']);
  assert.equal(h.state(a), 'completed:sent');
  await h.close();
});

test('the name message waits for the later line\'s turn to end, not just to start', async () => {
  const hold = deferred();
  const h = makeHarness({
    decide: replyNotCrisis,
    dispatch: async (turn) => {
      if (turn.cls === 'interject') await hold.promise;
      h.exit.result = turn.cls === 'interject' ? { state: 'silent', reason: 'no_reply' } : null;
      return ranOk;
    },
  });
  const a = await h.send(h.event({ text: FOLD_NAME }));
  await h.send(h.event({ text: FOLD_LAST }));
  h.advance(4000);
  await until(() => h.dispatched.length === 1);
  for (let i = 0; i < 50; i += 1) await tick();
  assert.equal(h.decideCalls.length, 1, 'no decision for the name message while the turn is out');
  assert.equal(h.row(a).state, 'queued');
  hold.resolve();
  await h.gate.idle();
  assert.equal(h.state(a), 'completed:sent');
  await h.close();
});

test('a required turn the host refused: the failure line speaks for the name message, unless it could not go out', async () => {
  const refused = async () => ({ started: false, reason: 'ingress', hostError: false, aborted: false, usage: null });
  const heard = makeHarness({ decide: answersCrisis, dispatch: refused });
  const [a, b] = await flushWindow(heard, heard.event({ text: FOLD_NAME }), heard.event({ text: FOLD_LAST }));
  assert.equal(heard.state(b), 'skipped:ingress');
  assert.equal(heard.exit.fixed.length, 1);
  assert.equal(heard.state(a), 'merged:merged');
  assert.equal(heard.decideCalls.length, 1);
  await heard.close();

  const held = makeHarness({ decide: answersCrisis, dispatch: refused });
  held.exit.sendFixed = async () => ({ sent: false, reason: 'failline_rate' });
  const [c, d] = await flushWindow(held, held.event({ text: FOLD_NAME }), held.event({ text: FOLD_LAST }));
  assert.equal(held.state(d), 'skipped:ingress');
  assert.deepEqual(triggers(held), [['ordinary', FOLD_LAST], ['name', FOLD_NAME]]);
  assert.equal(held.row(c).merged_into, null);
  await held.close();
});

test('a failure line for the later line, through the real exit, speaks for the name message', async () => {
  const h = await seamStack({ decide: answersCrisis });
  h.replyText = null;
  const [a, b] = await flushWindow(h, h.event({ text: FOLD_NAME }), h.event({ text: FOLD_LAST }));
  assert.deepEqual(triggers(h), [['ordinary', FOLD_LAST]]);
  assert.equal(h.state(b), 'failed:required_no_text');
  assert.equal(h.posts().length, 1, 'the failure line');
  assert.equal(h.state(a), 'merged:merged');
  assert.equal(h.row(a).merged_into, h.row(b).event_key);
  await h.close();
});

test('an empty turn that was not required, through the real exit: the name message gets its own reply', async () => {
  const h = await seamStack({ decide: replyNotCrisis });
  const script = h.script;
  h.script = async (turn) => {
    h.replyText = turn.cls === 'interject' ? null : '这是一条普通的回复。';
    return script(turn);
  };
  const [a, b] = await flushWindow(h, h.event({ text: FOLD_NAME }), h.event({ text: FOLD_LAST }));
  assert.equal(h.state(b), 'silent:no_reply');
  assert.equal(h.state(a), 'completed:sent');
  assert.equal(h.posts().length, 1);
  assert.equal(h.posts()[0].body.msg_id, a.messageId);
  await h.close();
});

test('a post nobody can confirm may have reached the group: the name message merges, and no second reply is made', async () => {
  const h = await seamStack({ decide: replyNotCrisis });
  h.nextPostError = new Error('network timeout');
  const [a, b] = await flushWindow(h, h.event({ text: FOLD_NAME }), h.event({ text: FOLD_LAST }));
  assert.equal(h.state(b), 'failed:send_uncertain');
  assert.equal(h.state(a), 'merged:merged');
  assert.equal(h.seen.length, 1);
  assert.equal(h.decideCalls.length, 1);
  assert.equal(foldAlerts(h, 'crisis_refused').length, 0, 'something may have been said');
  await h.close();
});

test('a reply cut off after its first part was still heard: the name message merges, and no second reply is made', async () => {
  const h = await seamStack({ decide: answersCrisis });
  h.replyText = '这是一句足够长的回复内容。'.repeat(200);
  let failed = false;
  Object.defineProperty(h, 'nextPostError', {
    get: () => (h.posts().length === 1 && !failed ? new ApiError('expired', 400, '/v2/groups/x/messages', 40034128, 'detail') : null),
    set: (v) => { if (v === null && h.posts().length === 1) failed = true; },
  });
  const [a, b] = await flushWindow(h, h.event({ text: FOLD_NAME }), h.event({ text: FOLD_LAST }));
  assert.equal(h.state(b), 'failed:passive_expired');
  assert.equal(h.posts().length, 1, 'positive control: one part got out');
  assert.equal(h.state(a), 'merged:merged');
  assert.equal(h.seen.length, 1);
  await h.close();
});

test('a reply a content check refused is not tried again on the name message, and the operator hears of it', async () => {
  const violation = () => new ApiError('content violation', 400, '/v2/groups/x/messages', 40034006, 'detail');
  const cases = [
    ['local rule', (h) => { h.replyText = '可以，加我 约炮'; }, /^policy_dropped:/u],
    ['platform', (h) => { h.nextPostError = violation(); }, /^failed:platform_violation$/u],
  ];
  for (const [title, arrange, later] of cases) {
    const h = await seamStack({ decide: replyNotCrisis });
    arrange(h);
    const [a, b] = await flushWindow(h, h.event({ text: FOLD_NAME }), h.event({ text: FOLD_LAST }));
    assert.match(h.state(b), later, title);
    assert.equal(h.state(a), 'merged:merged', title);
    assert.equal(h.seen.length, 1, `${title}: one turn`);
    assert.equal(h.decideCalls.length, 1, `${title}: one decision`);
    assert.equal(h.posts().length, 0, title);
    const refused = foldAlerts(h, 'crisis_refused');
    assert.equal(refused.length, 1, title);
    assert.match(JSON.stringify(refused[0]), /reply_dropped/u, title);
    await h.close();
  }
});

test('positive control: a refused reply on a required turn sends the fixed line, so there is nothing to alert', async () => {
  const h = await seamStack({ decide: answersCrisis });
  h.replyText = '可以，加我 约炮';
  const [a, b] = await flushWindow(h, h.event({ text: FOLD_NAME }), h.event({ text: FOLD_LAST }));
  assert.match(h.state(b), /^policy_dropped:/u);
  assert.equal(h.posts().length, 1);
  assert.equal(h.state(a), 'merged:merged');
  assert.equal(foldAlerts(h, 'crisis_refused').length, 0);
  await h.close();
});

test('the cap of names does not lose a person to a line that folds', async () => {
  const h = makeHarness({ effective: makeEffective({ limits: { nameWindowMax: 1 } }), decide: answersCrisis });
  const last = `${CRISIS}吧`;
  await flushWindow(h, h.event({ text: NAME_B, senderId: MEMBER2 }), h.event({ text: `可洛 ${CRISIS}` }), h.event({ text: last }));
  assert.deepEqual(triggers(h), [['ordinary', last], ['name', NAME_B]]);
  await h.close();
});

// ---- the interjection tier spent ----

const noInterjectTier = (over = {}) => makeEffective({ budget: { interjectUsd: 0 }, ...over });

test('interjection tier spent: danger words go by the crisis route, on the addressed tier', async () => {
  const h = makeHarness({ effective: noInterjectTier(), decide: answersCrisis });
  const e = await h.sendAndFlush(h.event({ text: CRISIS }));
  assert.deepEqual(triggers(h), [['crisis_route', CRISIS]]);
  assert.deepEqual(h.dispatched.map((t) => [t.cls, t.tier]), [['crisis', 'addressed']]);
  assert.deepEqual(h.reservations(e).map((r) => [r.category, r.tier]).sort(), [['decision', 'addressed'], ['reply', 'addressed']]);
  assert.equal(h.state(e), 'completed:sent');
  assert.equal(crisisGroup(h), 1);
  await h.close();
});

test('interjection tier spent: the route answers crisis and nothing else', async () => {
  const h = makeHarness({ effective: noInterjectTier(), decide: async () => decisionOf({ action: 'reply' }) });
  const e = await h.sendAndFlush(h.event({ text: CRISIS }));
  assert.equal(h.decideCalls.length, 1);
  assert.equal(h.state(e), 'skipped:decision_skip');
  assert.equal(h.dispatched.length, 0);
  await h.close();
});

test('interjection tier spent: nothing else is lifted, and the caps hold', async () => {
  const cases = [
    ['no danger words', noInterjectTier(), CHAT],
    ['no sender room', noInterjectTier({ limits: { crisisRoutePerSenderPerHour: 0 } }), CRISIS],
    ['no group room', noInterjectTier({ limits: { crisisRoutePerGroupPerDay: 0 } }), CRISIS],
  ];
  for (const [title, effective, text] of cases) {
    const h = makeHarness({ effective, decide: answersCrisis });
    const e = await h.sendAndFlush(h.event({ text }));
    assert.equal(h.state(e), 'skipped:budget', title);
    assert.equal(h.decideCalls.length, 0, title);
    assert.deepEqual(h.reservations(e), [], title);
    assert.equal(crisisGroup(h), 0, title);
    await h.close();
  }
});

test('the whole budget spent: the route is refused too, as budget', async () => {
  const h = makeHarness({ effective: makeEffective({ budget: { interjectUsd: 0, addressedUsd: 0 } }), decide: answersCrisis });
  const e = await h.sendAndFlush(h.event({ text: CRISIS }));
  assert.equal(h.state(e), 'skipped:budget');
  assert.equal(h.decideCalls.length, 0);
  assert.equal(crisisGroup(h), 0, 'rolled back with the claim');
  await h.close();
});

test('interjection tier spent, two danger lines from one person: the later line takes the turn, one slot', async () => {
  const h = makeHarness({ effective: noInterjectTier(), decide: answersCrisis });
  const last = `${CRISIS}吧`;
  const [a, b] = await flushWindow(h, h.event({ text: `可洛 ${CRISIS}` }), h.event({ text: last }));
  assert.deepEqual(triggers(h), [['crisis_route', last]]);
  assert.equal(h.state(a), 'merged:merged');
  assert.equal(h.state(b), 'completed:sent');
  assert.equal(crisisGroup(h), 1);
  await h.close();
});

// ---- the name switch turned off while a person in danger waits ----

async function nameOffWhileQueued(effective, extra = []) {
  const { hold, decide } = holdingFirst();
  const h = makeHarness({ effective, decide });
  const x = await h.send(h.event({ text: `可洛 ${CRISIS}`, senderId: MEMBER }));
  const y = await h.send(h.event({ text: `可洛 我也${CRISIS}`, senderId: MEMBER2 }));
  for (const e of extra) await h.send(h.event(e));
  h.advance(4000);
  await until(() => h.decideCalls.length === 1);
  h.eff.current.qq.groups[GROUP_A].nameMention = false;
  return { h, hold, queued: h.decideCalls[0].current.text === y.text ? x : y };
}

test('switched off while queued: a name message in danger is treated as ordinary, and still looked at', async () => {
  const { h, hold, queued } = await nameOffWhileQueued(makeEffective());
  hold.resolve();
  await h.gate.idle();
  assert.equal(h.decideCalls.length, 2);
  assert.equal(h.decideCalls.at(-1).trigger, 'ordinary');
  assert.equal(h.decideCalls.at(-1).current.text, queued.text);
  assert.equal(h.state(queued), 'completed:sent');
  assert.deepEqual(h.dispatched.map((t) => t.cls), ['crisis', 'crisis']);
  await h.close();
});

test('switched off while queued, with interjection off too: the rules that keep it quiet still do', async () => {
  const { h, hold, queued } = await nameOffWhileQueued(closed());
  hold.resolve();
  await h.gate.idle();
  assert.equal(h.decideCalls.length, 1);
  assert.equal(h.state(queued), 'skipped:interject_off');
  await h.close();
});

test('switched off while queued, in a flood: the window count is the real one', async () => {
  const chatter = Array.from({ length: 12 }, (_, i) => ({ text: `闲聊第${i}句话题`, senderId: MEMBER3 }));
  const { h, hold, queued } = await nameOffWhileQueued(makeEffective(), chatter);
  hold.resolve();
  await h.gate.idle();
  assert.equal(h.decideCalls.length, 1);
  assert.equal(h.state(queued), 'skipped:rule');
  await h.close();
});

// ---- judgeCrisis reads everything fresh ----

test('what changed while a person in danger waited is read fresh', async () => {
  const moves = [
    ['ignored:admission', (h) => { delete h.eff.current.qq.groups[GROUP_A]; }],
    ['ignored:admission', (h) => { h.eff.current = null; }],
    ['ignored:admission', (h) => { h.eff.current.qq.enabled = false; }],
    ['paused:paused', (h) => { h.store.setControl('global_paused', '1', 'test'); }],
    ['paused:paused', (h) => { h.store.setControl(`group_paused:${h.store.key(GROUP_A)}`, '1', 'test'); }],
    ['paused:paused', (h) => { h.store.setControl('terminal_close', 'test', 'test'); }],
    ['skipped:expired_before_dispatch', (h) => { h.clock.t += h.eff.current.window.dispatchDeadlineMs + 1; }],
    ['dry_run:would_window', (h) => { h.eff.current.mode = 'dry-run'; }],
    ['skipped:interject_off', (h) => { h.eff.current.qq.groups[GROUP_A].interject = false; }],
    ['skipped:interject_latch', (h) => { h.store.setControl('interject_paused', '1', 'test'); }],
    ['skipped:quiet', (h) => { h.eff.current.quietHours = quiet.quietHours; h.eff.current.limits.crisisRoutePerSenderPerHour = 0; }],
  ];
  for (const [expected, move] of moves) {
    const { hold, decide } = holdingFirst();
    const h = makeHarness({ decide });
    const x = await h.send(h.event({ text: CRISIS, senderId: MEMBER }));
    await h.send(h.event({ text: `我也${CRISIS}`, senderId: MEMBER2 }));
    h.advance(4000);
    await until(() => h.decideCalls.length === 1);
    move(h);
    hold.resolve();
    await h.gate.idle();
    assert.equal(h.state(x), expected);
    assert.equal(h.decideCalls.length, 1, expected);
    assert.deepEqual(h.reservations(x), [], expected);
    await h.close();
  }
});

test('positive control: with nothing changed, the one who waited is looked at and answered', async () => {
  const { hold, decide } = holdingFirst();
  const h = makeHarness({ decide });
  const x = await h.send(h.event({ text: CRISIS, senderId: MEMBER }));
  await h.send(h.event({ text: `我也${CRISIS}`, senderId: MEMBER2 }));
  h.advance(4000);
  await until(() => h.decideCalls.length === 1);
  hold.resolve();
  await h.gate.idle();
  assert.equal(h.decideCalls.length, 2);
  assert.equal(h.state(x), 'completed:sent');
  await h.close();
});

// ---- danger does not yield ----

async function queuedCrisis() {
  const { hold, decide } = holdingFirst();
  const h = makeHarness({ decide });
  const x = await h.send(h.event({ text: CRISIS, senderId: MEMBER }));
  const y = await h.send(h.event({ text: `我也${CRISIS}`, senderId: MEMBER2 }));
  h.advance(4000);
  await until(() => h.decideCalls.length === 1);
  return { h, hold, x, y };
}

test('a real @ arriving later does not pass a queued person in danger', async () => {
  const { h, hold, x, y } = await queuedCrisis();
  const at = await h.send(h.at({ senderId: MEMBER3 }));
  hold.resolve();
  await h.gate.idle();
  assert.deepEqual(h.dispatched.map((t) => t.messageId), [y.messageId, x.messageId, at.messageId]);
  await h.close();
});

test('a later urgent window does not pass a queued person in danger', async () => {
  const { h, hold, x, y } = await queuedCrisis();
  const z = await h.send(h.event({ text: `他也${CRISIS}`, senderId: MEMBER3 }));
  h.advance(4000);
  hold.resolve();
  await h.gate.idle();
  assert.deepEqual(h.dispatched.map((t) => t.messageId), [y.messageId, x.messageId, z.messageId]);
  await h.close();
});

async function crisisPairBehindNames(turnMs) {
  const first = deferred();
  let n = 0;
  const h = makeHarness({
    decide: answersCrisis,
    dispatch: async () => {
      n += 1;
      if (n === 1) await first.promise;
      h.clock.t += turnMs;
      return { started: true, hostError: false, aborted: false, usage: USAGE };
    },
  });
  const a = await h.send(h.event({ text: NAME_A, senderId: MEMBER }));
  const b = await h.send(h.event({ text: NAME_B, senderId: MEMBER2 }));
  const c = await h.send(h.event({ text: NAME_C, senderId: MEMBER3 }));
  h.advance(4000);
  await until(() => h.dispatched.length === 1);
  h.advance(1000);
  const x = await h.send(h.event({ text: CRISIS, senderId: MEMBER4 }));
  const y = await h.send(h.event({ text: `我也${CRISIS}`, senderId: MEMBER5 }));
  h.advance(4000);
  first.resolve();
  await h.gate.idle();
  return { h, a, b, c, x, y };
}

test('a queued person in danger goes ahead of names left from the last window', async () => {
  const { h, a, b, c, x, y } = await crisisPairBehindNames(1000);
  assert.deepEqual(h.dispatched.map((t) => t.messageId), [a, y, x, b, c].map((e) => e.messageId));
  await h.close();
});

test('with slow turns that order is what gets them answered before the deadline', async () => {
  const { h, x } = await crisisPairBehindNames(85000);
  assert.equal(h.state(x), 'completed:sent');
  await h.close();
});

test('nothing rescued: a name message in danger leads even when it was not said first', async () => {
  const h = makeHarness({ effective: closed(), decide: answersCrisis });
  const danger = `可洛 ${CRISIS}`;
  await flushWindow(h, h.event({ text: NAME_A, senderId: MEMBER }), h.event({ text: danger, senderId: MEMBER2 }));
  assert.deepEqual(texts(h), [danger, NAME_A]);
  assert.deepEqual(h.dispatched.map((t) => t.cls), ['crisis', 'name_addressed']);
  await h.close();
});

// ---- where an earlier danger line points ----

test('an earlier danger line points at that person\'s last danger line, not at their name message', async () => {
  const h = makeHarness({ decide: answersCrisis });
  const [a, name, c] = await flushWindow(h, h.event({ text: CRISIS }), h.event({ text: NAME_A }), h.event({ text: `${CRISIS}吧` }));
  assert.equal(h.row(a).merged_into, h.row(c).event_key);
  assert.equal(h.state(name), 'completed:sent');
  assert.equal(h.state(c), 'completed:sent');
  await h.close();
});

test('and not at someone else\'s question', async () => {
  for (const order of [0, 1]) {
    const h = makeHarness({ decide: answersCrisis });
    const x1 = h.event({ text: CRISIS, senderId: MEMBER });
    const x2 = h.event({ text: `${CRISIS}吧`, senderId: MEMBER });
    const y = h.event({ text: NAME_B, senderId: MEMBER2 });
    await flushWindow(h, ...(order === 0 ? [x1, x2, y] : [y, x1, x2]));
    assert.equal(h.row(x1).merged_into, h.row(x2).event_key);
    assert.equal(h.row(y).merged_into, null);
    await h.close();
  }
});

// ---- the name switch turned off inside the window, before it flushes ----

test('switched off before the flush, past the crisis caps: the window is one ordinary evaluation', async () => {
  const eff = makeEffective({ limits: { crisisRoutePerSenderPerHour: 0 } });
  const h = makeHarness({ effective: eff, decide: answersCrisis });
  const x = await h.send(h.event({ text: `可洛 ${CRISIS}`, senderId: MEMBER }));
  const y = await h.send(h.event({ text: NAME_B, senderId: MEMBER2 }));
  h.eff.current.qq.groups[GROUP_A].nameMention = false;
  h.advance(4000);
  await h.gate.idle();
  assert.deepEqual(triggers(h), [['ordinary', NAME_B]]);
  assert.equal(h.state(x), 'merged:merged');
  assert.equal(h.row(x).merged_into, h.row(y).event_key);
  assert.equal(h.state(y), 'completed:sent');
  await h.close();
});

// ---- danger on the name path, and past the decision caps ----

const alerts = (h, kind) => h.store.listAlerts().filter((a) => a.kind === kind);
const detail = (a) => (typeof a.detail === 'string' ? JSON.parse(a.detail) : a.detail);

for (const [title, effective] of [
  ['the named tier spent', () => makeEffective({ budget: { namedUsd: 0 } })],
  ['the name cap spent', () => makeEffective({ limits: { nameDecisionsPerGroupPerHour: 0 } })],
  ['the group decision cap spent', () => makeEffective({ limits: { decisionsPerGroupPerHour: 0 } })],
  ['the day decision cap spent', () => makeEffective({ limits: { decisionsPerDay: 0 } })],
]) {
  test(`${title}: a name message in danger goes by the crisis route`, async () => {
    const h = makeHarness({ effective: effective(), decide: answersCrisis });
    const text = `可洛 ${CRISIS}`;
    const e = await h.sendAndFlush(h.event({ text }));
    assert.deepEqual(triggers(h), [['crisis_route', text]]);
    assert.deepEqual(h.dispatched.map((t) => [t.cls, t.tier]), [['crisis', 'addressed']]);
    assert.equal(h.state(e), 'completed:sent');
    assert.equal(crisisGroup(h), 1);
    assert.equal(alerts(h, 'crisis_refused').length, 0);
    await h.close();
  });

  test(`${title}: a name message with no danger words is refused, buys nothing and raises nothing`, async () => {
    const h = makeHarness({ effective: effective(), decide: answersCrisis });
    const e = await h.sendAndFlush(h.event({ text: NAME_A }));
    assert.match(h.state(e), /^skipped:(budget|decision_cap)$/);
    assert.equal(h.decideCalls.length, 0);
    assert.equal(h.store.listAlerts().length, 0);
    await h.close();
  });
}

test('the decision cap spent: an ordinary message in danger goes by the crisis route', async () => {
  const h = makeHarness({ effective: makeEffective({ limits: { decisionsPerGroupPerHour: 0 } }), decide: answersCrisis });
  const e = await h.sendAndFlush(h.event({ text: CRISIS }));
  assert.deepEqual(triggers(h), [['crisis_route', CRISIS]]);
  assert.equal(h.state(e), 'completed:sent');
  assert.equal(h.claims().filter((c) => c.status === 'consumed').length, 0, 'the refused claim went back with the refusal');
  await h.close();
});

test('the fallback answers crisis and nothing else', async () => {
  const h = makeHarness({ effective: makeEffective({ limits: { decisionsPerGroupPerHour: 0 } }), decide: async () => decisionOf({ action: 'reply' }) });
  const e = await h.sendAndFlush(h.event({ text: `可洛 ${CRISIS}` }));
  assert.equal(h.state(e), 'skipped:decision_skip');
  assert.equal(h.dispatched.length, 0);
  assert.equal(alerts(h, 'crisis_refused').length, 0, 'the model looked and said no');
  await h.close();
});

test('danger refused all the way: skipped with the first refusal, no decision bought, and the owner hears', async () => {
  const cases = [
    ['no group room', { limits: { decisionsPerGroupPerHour: 0, crisisRoutePerGroupPerDay: 0 } }, 'decision_cap'],
    ['no sender room', { limits: { decisionsPerGroupPerHour: 0, crisisRoutePerSenderPerHour: 0 } }, 'decision_cap'],
    ['no money on any tier', { budget: { namedUsd: 0, addressedUsd: 0 } }, 'budget'],
  ];
  for (const [title, over, reason] of cases) {
    const h = makeHarness({ effective: makeEffective(over), decide: answersCrisis });
    const e = await h.sendAndFlush(h.event({ text: `可洛 ${CRISIS}` }));
    assert.equal(h.state(e), `skipped:${reason}`, title);
    assert.equal(h.decideCalls.length, 0, title);
    const [alert] = alerts(h, 'crisis_refused');
    assert.ok(alert, title);
    assert.equal(detail(alert).reason, reason, title);
    assert.equal(detail(alert).eventKey, h.row(e).event_key, title);
    await h.close();
  }
});

test('the decision failing on a line on the list raises the alert; on chat it does not', async () => {
  const h = makeHarness({ decide: async () => failed() });
  await h.sendAndFlush(h.event({ text: NAME_A }));
  assert.equal(alerts(h, 'crisis_refused').length, 0, 'positive control');
  const e = await h.sendAndFlush(h.event({ text: `可洛 ${CRISIS}`, senderId: MEMBER2 }));
  assert.equal(h.state(e), 'skipped:decision_invalid');
  assert.equal(detail(alerts(h, 'crisis_refused')[0]).reason, 'decision_invalid');
  await h.close();
});

test('the model says danger with the crisis caps spent and the topic flagged: not answered, as decided, but the owner hears', async () => {
  const h = makeHarness({
    effective: makeEffective({ limits: { crisisRoutePerGroupPerDay: 0 } }),
    decide: async () => decisionOf({ crisis: true, action: 'skip', skipClass: 'harm_person' }),
  });
  const e = await h.sendAndFlush(h.event({ text: NAME_A }));
  assert.equal(h.state(e), 'skipped:decision_skip');
  assert.equal(detail(alerts(h, 'crisis_refused')[0]).reason, 'decision_skip');
  await h.close();
});

// ---- danger @ past the per-sender hourly count ----

const oneAddressed = (over = {}) => makeEffective({ limits: { perSenderAddressedPerHour: 1, ...over } });

async function overRate(h, text = CRISIS) {
  await h.sendAndFlush(h.at({ text: '先问一个普通问题' }));
  assert.equal(h.dispatched.length, 1, 'the premise: the first @ takes the only place');
  return h.sendAndFlush(h.at({ text }));
}

test('danger @ past the hourly count: one decision on the crisis route, and a reply if the model agrees', async () => {
  const h = makeHarness({ effective: oneAddressed(), decide: answersCrisis });
  const e = await overRate(h);
  assert.deepEqual(triggers(h), [['crisis_route', CRISIS]]);
  assert.deepEqual(h.dispatched.at(-1).cls, 'crisis');
  assert.equal(h.dispatched.at(-1).tier, 'addressed');
  assert.equal(h.dispatched.at(-1).required, true);
  assert.equal(h.state(e), 'completed:sent');
  assert.equal(crisisGroup(h), 1);
  assert.equal(h.row(e).cls, 'at', 'the row does not keep the route');
  await h.close();
});

test('danger @ past the hourly count: the model says no, so no reply and no failure line', async () => {
  const h = makeHarness({ effective: oneAddressed(), decide: async () => decisionOf({ action: 'reply', crisis: false }) });
  const e = await overRate(h);
  assert.equal(h.decideCalls.length, 1);
  assert.equal(h.state(e), 'skipped:decision_skip');
  assert.equal(h.dispatched.length, 1, 'never a reply without the model saying danger');
  assert.deepEqual(h.exit.fixed, []);
  await h.close();
});

test('chat @ past the hourly count buys nothing', async () => {
  const h = makeHarness({ effective: oneAddressed(), decide: answersCrisis });
  const e = await overRate(h, '再问一个普通问题');
  assert.equal(h.state(e), 'skipped:sender_rate');
  assert.equal(h.decideCalls.length, 0);
  assert.equal(h.store.listAlerts().length, 0);
  await h.close();
});

test('danger @ past the hourly count with no crisis room left: no decision, sender_rate, and the owner hears', async () => {
  for (const over of [{ crisisRoutePerSenderPerHour: 0 }, { crisisRoutePerGroupPerDay: 0 }]) {
    const h = makeHarness({ effective: oneAddressed(over), decide: answersCrisis });
    const e = await overRate(h);
    assert.equal(h.state(e), 'skipped:sender_rate', JSON.stringify(over));
    assert.equal(h.decideCalls.length, 0, JSON.stringify(over));
    assert.equal(detail(alerts(h, 'crisis_refused')[0]).reason, 'sender_rate', JSON.stringify(over));
    await h.close();
  }
});

// Queued behind a slow turn, so the world can change before it runs.
async function queuedOverRate(change) {
  const block = deferred();
  let n = 0;
  const h = makeHarness({
    effective: oneAddressed(),
    decide: answersCrisis,
    dispatch: async () => {
      n += 1;
      if (n === 1) await block.promise;
      return { started: true, hostError: false, aborted: false, usage: USAGE };
    },
  });
  await h.send(h.at({ text: '先问一个普通问题' }));
  await until(() => n === 1);
  const e = await h.send(h.at({ text: CRISIS }));
  assert.equal(h.state(e), 'queued');
  change(h);
  block.resolve();
  await h.gate.idle();
  return { h, e };
}

test('danger @ past the count, then the group is paused while it waits: no decision bought', async () => {
  const { h, e } = await queuedOverRate((x) => x.store.setControl(`group_paused:${x.store.key(GROUP_A)}`, '1', 'test'));
  assert.equal(h.state(e), 'paused:paused');
  assert.equal(h.decideCalls.length, 0);
  await h.close();
});

test('danger @ past the count, then it waits past the dispatch deadline: no decision bought, and the alert', async () => {
  const { h, e } = await queuedOverRate((x) => x.advance(181000));
  assert.equal(h.state(e), 'skipped:expired_before_dispatch');
  assert.equal(h.decideCalls.length, 0);
  assert.equal(alerts(h, 'expired_before_dispatch').length, 1);
  await h.close();
});

test('danger @ past the count, then the mode goes to dry-run while it waits: no decision bought', async () => {
  const { h, e } = await queuedOverRate((x) => { x.eff.current.mode = 'dry-run'; });
  assert.equal(h.state(e), 'dry_run:would_at');
  assert.equal(h.decideCalls.length, 0);
  await h.close();
});

// ---- room for danger when the lane is full ----

function fullLane() {
  const block = deferred();
  let n = 0;
  const h = makeHarness({
    effective: makeEffective({ window: { maxPending: 2 } }),
    decide: answersCrisis,
    dispatch: async () => {
      n += 1;
      if (n === 1) await block.promise;
      return { started: true, hostError: false, aborted: false, usage: USAGE };
    },
  });
  return {
    h,
    block,
    fill: async () => {
      await h.send(h.at({ text: '讲个长故事', senderId: MEMBER3 }));
      await until(() => n === 1);
      await h.send(h.at({ text: '排队的第一个问题', senderId: MEMBER3 }));
      await h.send(h.at({ text: '排队的第二个问题', senderId: MEMBER3 }));
    },
  };
}

test('a danger @ behind a full lane has room; another @ does not', async () => {
  const { h, block, fill } = fullLane();
  await fill();
  const chat = await h.send(h.at({ text: '排队的第三个问题', senderId: MEMBER4 }));
  assert.equal(h.state(chat), 'skipped:queue_full', 'positive control: the lane is full');
  assert.equal(alerts(h, 'crisis_queue_full').length, 0);
  const danger = await h.send(h.at({ text: CRISIS, senderId: MEMBER }));
  assert.equal(h.state(danger), 'queued');
  block.resolve();
  await h.gate.idle();
  assert.equal(h.state(danger), 'completed:sent');
  assert.equal(alerts(h, 'crisis_queue_full').length, 0);
  await h.close();
});

test('one sender cannot take all the danger room: their third is refused with the alert, and another person still fits', async () => {
  const { h, block, fill } = fullLane();
  await fill();
  const mine = [];
  for (let i = 0; i < 3; i += 1) mine.push(await h.send(h.at({ text: `${CRISIS}${i}`, senderId: MEMBER })));
  assert.deepEqual(mine.map((e) => h.state(e)), ['queued', 'queued', 'skipped:queue_full']);
  assert.equal(alerts(h, 'crisis_queue_full').length, 1, 'that line may be the one that matters');
  const other = await h.send(h.at({ text: CRISIS, senderId: MEMBER2 }));
  assert.equal(h.state(other), 'queued');
  block.resolve();
  await h.gate.idle();
  assert.equal(h.state(other), 'completed:sent');
  await h.close();
});

test('a folded line finding no room is refused with no alert: the same person\'s later line is still judged', async () => {
  const block = deferred();
  let n = 0;
  const senders = ['A', 'B', 'C'].map((s) => `FOLD${s}MEMBER1111222233334`);
  const others = Array.from({ length: 12 }, (_, i) => `LATE${String(i).padStart(2, '0')}MEMBER111122223333`);
  const h = makeHarness({
    effective: makeEffective({ window: { maxPending: 12 }, limits: { floodPerWindow: 100 } }),
    decide: async () => decisionOf({ action: 'skip' }),
    dispatch: async () => {
      n += 1;
      if (n === 1) await block.promise;
      return { started: true, hostError: false, aborted: false, usage: USAGE };
    },
  });
  await h.send(h.at({ text: '讲个长故事', senderId: MEMBER }));
  await until(() => n === 1);
  // These fill each sender's share while their window waits, so the next lines take chat room instead of danger room.
  const first = [];
  for (const senderId of senders) {
    first.push(await h.send(h.event({ text: CRISIS, senderId })));
    first.push(await h.send(h.event({ text: `${CRISIS}呀`, senderId })));
  }
  h.advance(4000);
  const folded = new Map();
  for (const senderId of senders) {
    folded.set(senderId, await h.send(h.event({ text: `可洛 ${CRISIS}`, senderId })));
    await h.send(h.event({ text: `${CRISIS}吧`, senderId }));
  }
  block.resolve();
  await until(() => first.every((e) => h.state(e) !== 'queued'));
  for (const senderId of others) assert.equal(h.state(await h.send(h.event({ text: CRISIS, senderId }))), 'queued', senderId);
  h.advance(4000);
  await h.gate.idle();
  const ended = senders.map((s) => h.state(folded.get(s)));
  assert.deepEqual(ended.map((s) => s === 'skipped:queue_full'), [false, true, true], 'the premise: the danger room ran out on the last two');
  assert.equal(alerts(h, 'crisis_queue_full').length, 0);
  assert.equal(h.allEvents().filter((e) => e.reason === 'queue_full').length, 2, 'only the folded lines were refused');
  await h.close();
});

// ---- danger at shutdown ----

test('danger in an open window at shutdown raises crisis_dropped_on_stop; chat raises nothing', async () => {
  const h = makeHarness({ decide: answersCrisis });
  const chat = await h.send(h.event({ text: CHAT, senderId: MEMBER2 }));
  const danger = await h.send(h.event({ text: CRISIS }));
  await h.gate.stop();
  assert.equal(h.state(chat), 'restart_dropped:restart');
  assert.equal(h.state(danger), 'restart_dropped:restart');
  const raised = alerts(h, 'crisis_dropped_on_stop');
  assert.equal(raised.length, 1);
  assert.equal(detail(raised[0]).eventKey, h.row(danger).event_key);
  assert.equal(alerts(h, 'crisis_queue_full').length, 0, 'a kind of its own');
  await h.close();
});

test('a queued danger @ at shutdown raises it too; a queued chat @ does not', async () => {
  const block = deferred();
  let n = 0;
  const h = makeHarness({
    dispatch: async () => {
      n += 1;
      await block.promise;
      return { started: true, hostError: false, aborted: false, usage: USAGE };
    },
  });
  await h.send(h.at({ text: '讲个长故事' }));
  await until(() => n === 1);
  const chat = await h.send(h.at({ text: '排队的问题' }));
  assert.equal(alerts(h, 'crisis_dropped_on_stop').length, 0);
  const danger = await h.send(h.at({ text: CRISIS, senderId: MEMBER2 }));
  const stopping = h.gate.stop();
  assert.equal(h.state(chat), 'restart_dropped:restart');
  assert.equal(h.state(danger), 'restart_dropped:restart');
  assert.equal(alerts(h, 'crisis_dropped_on_stop').length, 1);
  block.resolve();
  await stopping;
  await h.close();
});

test('a decision out at shutdown on a line on the list raises it, and not crisis_refused', async () => {
  const hold = deferred();
  const h = makeHarness({ decide: async () => { await hold.promise; return failed(); } });
  const danger = await h.send(h.event({ text: `可洛 ${CRISIS}` }));
  h.advance(4000);
  await until(() => h.decideCalls.length === 1);
  const stopping = h.gate.stop();
  hold.resolve();
  await stopping;
  assert.equal(h.state(danger), 'skipped:decision_invalid');
  assert.equal(alerts(h, 'crisis_dropped_on_stop').length, 1);
  assert.equal(alerts(h, 'crisis_refused').length, 0);
  await h.close();
});

test('the model says danger as the shutdown lands: the turn does not start, and the owner hears', async () => {
  const hold = deferred();
  const h = makeHarness({ decide: async () => { await hold.promise; return decisionOf({ crisis: true }); } });
  const danger = await h.send(h.event({ text: CRISIS }));
  h.advance(4000);
  await until(() => h.decideCalls.length === 1);
  const stopping = h.gate.stop();
  hold.resolve();
  await stopping;
  assert.equal(h.state(danger), 'restart_dropped:restart');
  assert.equal(h.dispatched.length, 0);
  assert.equal(alerts(h, 'crisis_dropped_on_stop').length, 1);
  await h.close();
});

test('the same two moments on chat raise nothing', async () => {
  const hold = deferred();
  const h = makeHarness({ decide: async () => { await hold.promise; return decisionOf(); } });
  const chat = await h.send(h.event({ text: CHAT }));
  h.advance(4000);
  await until(() => h.decideCalls.length === 1);
  const stopping = h.gate.stop();
  hold.resolve();
  await stopping;
  assert.equal(h.state(chat), 'restart_dropped:restart');
  assert.equal(alerts(h, 'crisis_dropped_on_stop').length, 0);
  await h.close();
});
