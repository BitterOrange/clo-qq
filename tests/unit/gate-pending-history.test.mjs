// What a turn's history holds while other messages wait for their own turn. A line with a turn or a decision still
// coming is left out, so it is not answered twice; once it ends, it is ordinary context again.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContextBuffer, estimateTokens } from '../../src/clo-plugin/lib/core/context.js';
import { shanghaiDay } from '../../src/clo-plugin/lib/core/ids.js';
import { decisionOf, deferred, GROUP_A, groupEntry, makeEffective, makeHarness, MEMBER, MEMBER2, T0, USAGE } from '../fixtures/inbound.mjs';

const MEMBER3 = 'THIRDMEMBER111122223333';
const MEMBER4 = 'FOURTHMEMBER11112222333';
const tick = () => new Promise((r) => setImmediate(r));
const until = async (cond) => {
  for (let i = 0; i < 2000 && !cond(); i += 1) await tick();
  assert.ok(cond(), 'the expected state was never reached');
};
const bodies = (turn) => turn.history.map((l) => l.body);
const OK = { started: true, hostError: false, aborted: false, usage: USAGE };

const CRISIS = '我真的不想活了';
const NAME_A = '可洛你看看退货怎么办';
const NAME_B = '可洛今天开会是几点';
const NAME_C = '可洛帮我想个标题吧';
const CHAT = '今天中午吃什么好呢';

async function flushWindow(h, ...events) {
  const sent = [];
  for (const e of events) sent.push(await h.send(e));
  h.advance(4000);
  await h.gate.idle();
  return sent;
}

// The first decision waits for the test to let it go; the rest answer at once.
function holdingFirst(answer = () => decisionOf()) {
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

// Sent together: the first is queued, and its turn is built, with the second already in the buffer.
const sendTogether = (h, ...events) => Promise.all(events.map((e) => h.gate.onInbound(e)));
const answersCrisis = async (req) => decisionOf({ crisis: req.current.text.includes(CRISIS) });
const turnOf = (h, e) => h.dispatched.find((t) => t.messageId === e.messageId);

test('a question arriving during the first decision: the first reply does not answer the second question, and the second reply knows the first', async () => {
  const MSG1 = '可洛，帮我看一个例子';
  const MSG2 = '可洛，换个问题，3 加 4 等于几';
  const start = T0 + 2449;
  const decision1 = deferred();
  const turn1 = deferred();
  let decisions = 0;
  let turns = 0;
  const h = makeHarness({
    start,
    decide: async () => {
      decisions += 1;
      if (decisions === 1) await decision1.promise;
      return decisionOf();
    },
    dispatch: async () => {
      turns += 1;
      if (turns === 1) await turn1.promise;
      return OK;
    },
  });
  const moveTo = (t) => h.advance(t - h.clock.t);

  // msg1 opens the window, fixed from its arrival.
  const msg1 = await h.send(h.event({ text: MSG1 }));
  assert.equal(h.row(msg1).cls, 'name');

  // the window closes and the decision on msg1 goes out.
  moveTo(start + 4000);
  await until(() => h.decideCalls.length === 1);
  assert.equal(h.decideCalls[0].current.text, MSG1);

  // msg2 arrives during that decision and opens a window of its own.
  moveTo(T0 + 7511);
  const msg2 = await h.send(h.event({ text: MSG2 }));
  assert.equal(h.row(msg2).cls, 'name');
  assert.equal(h.row(msg2).state, 'queued');

  // the decision says reply, and msg1's turn is built.
  moveTo(T0 + 8370);
  decision1.resolve();
  await until(() => h.dispatched.length === 1);
  assert.equal(h.dispatched[0].messageId, msg1.messageId);
  assert.deepEqual(bodies(h.dispatched[0]), [], 'msg2 has its own decision coming, so msg1\'s turn must not hold it');

  // msg1's reply goes out. msg2's window closed meanwhile, and its decision now runs.
  moveTo(T0 + 17040);
  turn1.resolve();
  await h.gate.idle();
  assert.equal(h.decideCalls.length, 2);
  assert.equal(h.decideCalls[1].current.text, MSG2);
  assert.equal(h.dispatched.length, 2);
  assert.equal(h.dispatched[1].messageId, msg2.messageId);
  assert.deepEqual(bodies(h.dispatched[1]), [MSG1], 'by then msg1 has ended, so it is context');
  assert.equal(h.state(msg1), 'completed:sent');
  assert.equal(h.state(msg2), 'completed:sent');
  await h.close();
});

test('two real @ in quick succession: the first turn lacks the second, and the second has the first', async () => {
  const h = makeHarness();
  const a = h.at({ text: '第一个问题是什么', senderId: MEMBER });
  const b = h.at({ text: '第二个问题是什么', senderId: MEMBER2 });
  await sendTogether(h, a, b);
  await h.gate.idle();
  assert.deepEqual(h.dispatched.map((t) => t.messageId), [a.messageId, b.messageId]);
  assert.deepEqual(bodies(h.dispatched[0]), []);
  assert.deepEqual(bodies(h.dispatched[1]), [a.text]);
  await h.close();
});

test('a reply to the bot waiting behind a real @ is held back the same way', async () => {
  const h = makeHarness();
  h.store.addBotRef(h.store.key('REF-ONE'), h.store.key(GROUP_A), 'someevent');
  const a = h.at({ text: '第一个问题是什么', senderId: MEMBER });
  const b = h.event({ text: '你刚才那句是什么意思', senderId: MEMBER2, refMsgIdx: 'REF-ONE' });
  await sendTogether(h, a, b);
  await h.gate.idle();
  assert.equal(h.row(b).cls, 'reply_bot');
  assert.deepEqual(bodies(turnOf(h, a)), []);
  assert.deepEqual(bodies(turnOf(h, b)), [a.text]);
  await h.close();
});

test('a name in a window still open while an @ runs: the @ lacks it, and the name\'s turn has the @', async () => {
  const h = makeHarness();
  const name = await h.send(h.event({ text: NAME_A, senderId: MEMBER }));
  const at = await h.send(h.at({ text: '这个问题你怎么看', senderId: MEMBER2 }));
  await until(() => h.dispatched.length === 1);
  assert.equal(h.dispatched[0].messageId, at.messageId, 'the @ goes first');
  assert.deepEqual(bodies(h.dispatched[0]), []);
  h.advance(4000);
  await h.gate.idle();
  assert.deepEqual(bodies(turnOf(h, name)), [at.text]);
  await h.close();
});

test('an @ waiting while a name is decided on: the name\'s turn lacks it, and the @ has the name', async () => {
  const { hold, decide } = holdingFirst();
  const h = makeHarness({ decide });
  const name = await h.send(h.event({ text: NAME_A, senderId: MEMBER }));
  h.advance(4000);
  await until(() => h.decideCalls.length === 1);
  const at = await h.send(h.at({ text: '这个问题你怎么看', senderId: MEMBER2 }));
  hold.resolve();
  await h.gate.idle();
  assert.deepEqual(h.dispatched.map((t) => t.messageId), [name.messageId, at.messageId]);
  assert.deepEqual(bodies(h.dispatched[0]), []);
  assert.deepEqual(bodies(h.dispatched[1]), [NAME_A]);
  await h.close();
});

test('an @ waiting while an interjection is decided on: the interjection lacks it, and the @ has what it answered', async () => {
  const { hold, decide } = holdingFirst();
  const h = makeHarness({ decide });
  const chat = await h.send(h.event({ text: '有人知道怎么退货吗', senderId: MEMBER }));
  h.advance(4000);
  await until(() => h.decideCalls.length === 1);
  const at = await h.send(h.at({ text: '这个问题你怎么看', senderId: MEMBER2 }));
  hold.resolve();
  await h.gate.idle();
  assert.deepEqual(h.dispatched.map((t) => [t.messageId, t.cls]), [[chat.messageId, 'interject'], [at.messageId, 'at']]);
  assert.deepEqual(bodies(h.dispatched[0]), []);
  assert.deepEqual(bodies(h.dispatched[1]), [chat.text]);
  await h.close();
});

test('two senders named in one window: the lead lacks the other, the other has the lead, and the third has both', async () => {
  const h = makeHarness();
  const [a, b, c] = await flushWindow(h, h.event({ text: NAME_A, senderId: MEMBER }), h.event({ text: NAME_B, senderId: MEMBER2 }), h.event({ text: NAME_C, senderId: MEMBER3 }));
  assert.deepEqual(bodies(turnOf(h, a)), []);
  assert.deepEqual(bodies(turnOf(h, b)), [NAME_A]);
  assert.deepEqual(bodies(turnOf(h, c)), [NAME_A, NAME_B]);
  assert.deepEqual(h.decideCalls[0].lines.map((l) => l.text), [NAME_B, NAME_C], 'what the decision model sees has not changed');
  await h.close();
});

test('the same open line, by class: what gets its own handling is hidden, and what does not stays', async () => {
  const table = [['at', true], ['reply_bot', true], ['name', true], ['name_addressed', true], ['ordinary', false], ['interject', false], ['command', false], [null, false]];
  for (const [cls, hidden] of table) {
    const h = makeHarness();
    const line = await h.send(h.event({ text: CHAT, senderId: MEMBER }));
    if (cls === null) h.store.q('UPDATE events SET cls=NULL WHERE event_key=?').run(h.row(line).event_key);
    else h.store.setClass(h.row(line).event_key, cls);
    await h.send(h.at({ senderId: MEMBER2 }));
    await until(() => h.dispatched.length === 1);
    assert.equal(h.row(line).state, 'queued', 'still open when the turn is built');
    assert.deepEqual(bodies(h.dispatched[0]), hidden ? [] : [CHAT], String(cls));
    h.advance(4000);
    await h.gate.idle();
    await h.close();
  }
});

test('ordinary chat arriving during the decision is visible to the turn, later though it is', async () => {
  const { hold, decide } = holdingFirst();
  const h = makeHarness({ decide });
  const name = await h.send(h.event({ text: NAME_A, senderId: MEMBER }));
  h.advance(4000);
  await until(() => h.decideCalls.length === 1);
  const correction = await h.send(h.event({ text: '不对，我说的是换货', senderId: MEMBER }));
  assert.equal(h.row(correction).cls, 'ordinary');
  hold.resolve();
  await until(() => h.dispatched.length === 1);
  assert.equal(h.row(correction).state, 'queued', 'still open when the turn is built');
  assert.equal(h.dispatched[0].messageId, name.messageId);
  assert.deepEqual(bodies(h.dispatched[0]), [correction.text]);
  h.advance(4000);
  await h.gate.idle();
  await h.close();
});

test('a person\'s name line folded under their later danger line, lead path: the danger turn reads it, and not another person\'s', async () => {
  const h = makeHarness({ decide: answersCrisis });
  const earlier = `可洛 ${CRISIS}`;
  const later = `${CRISIS}吧`;
  const [first, other, danger] = await flushWindow(
    h,
    h.event({ text: earlier, senderId: MEMBER }),
    h.event({ text: NAME_B, senderId: MEMBER2 }),
    h.event({ text: later, senderId: MEMBER }),
  );
  assert.equal(h.dispatched[0].messageId, danger.messageId, 'the danger line leads');
  assert.equal(h.dispatched[0].cls, 'crisis');
  assert.deepEqual(bodies(h.dispatched[0]), [earlier]);
  assert.equal(h.state(first), 'merged:merged');
  assert.equal(h.row(first).merged_into, h.row(danger).event_key);
  assert.equal(h.dispatched.length, 2, 'the folded line has no turn of its own');
  assert.deepEqual(bodies(turnOf(h, other)), [earlier, later], 'the other person\'s turn has everything that has ended');
  await h.close();
});

test('the same when the danger line also says her name, so the lead takes the name path', async () => {
  const h = makeHarness({ decide: answersCrisis });
  const earlier = `可洛 ${CRISIS}`;
  const later = `可洛 ${CRISIS}吧`;
  const [first, other, danger] = await flushWindow(
    h,
    h.event({ text: earlier, senderId: MEMBER }),
    h.event({ text: NAME_B, senderId: MEMBER2 }),
    h.event({ text: later, senderId: MEMBER }),
  );
  assert.equal(h.decideCalls[0].trigger, 'name');
  assert.equal(h.dispatched[0].messageId, danger.messageId);
  assert.deepEqual(bodies(h.dispatched[0]), [earlier]);
  assert.equal(h.state(first), 'merged:merged');
  assert.deepEqual(bodies(turnOf(h, other)), [earlier, later]);
  await h.close();
});

test('a folded name line, non-lead rescued path: its own danger turn reads it, the other turns do not until it ends', async () => {
  const h = makeHarness({ decide: answersCrisis });
  const earlier = `可洛 ${CRISIS}`;
  const later = `${CRISIS}吧`;
  const second = `我也${CRISIS}`;
  const [first, danger, lead, name] = await flushWindow(
    h,
    h.event({ text: earlier, senderId: MEMBER }),
    h.event({ text: later, senderId: MEMBER }),
    h.event({ text: second, senderId: MEMBER2 }),
    h.event({ text: NAME_B, senderId: MEMBER3 }),
  );
  assert.deepEqual(h.dispatched.map((t) => t.messageId), [lead.messageId, danger.messageId, name.messageId]);
  assert.deepEqual(bodies(turnOf(h, lead)), [], 'not the other person\'s folded line or danger line, and not the pending name');
  assert.deepEqual(bodies(turnOf(h, danger)), [earlier, second], 'their own earlier words, and not the pending name');
  assert.equal(h.state(first), 'merged:merged');
  assert.equal(h.row(first).merged_into, h.row(danger).event_key);
  assert.deepEqual(bodies(turnOf(h, name)), [earlier, later, second]);
  await h.close();
});

test('a person\'s own earlier name line, not on the crisis list, is in the danger turn built first', async () => {
  const h = makeHarness({ decide: answersCrisis });
  const weary = '可洛，我最近真的撑不住了';
  const [first, danger] = await flushWindow(h, h.event({ text: weary, senderId: MEMBER }), h.event({ text: CRISIS, senderId: MEMBER }));
  assert.equal(h.dispatched[0].messageId, danger.messageId);
  assert.equal(h.dispatched[0].cls, 'crisis');
  assert.deepEqual(bodies(h.dispatched[0]), [weary]);
  // The price, chosen on purpose: the earlier line keeps its own turn, and may be answered there too.
  assert.equal(h.dispatched.length, 2);
  assert.equal(turnOf(h, first).cls, 'name_addressed');
  assert.deepEqual(bodies(turnOf(h, first)), [CRISIS]);
  await h.close();
});

test('a person\'s earlier name line in a window still open is in their later @ turn: danger, on the list or not, and a follow-up', async () => {
  const cases = [
    ['可洛，我最近真的撑不住了', CRISIS],
    [`可洛 ${CRISIS}`, CRISIS],
    ['可洛，退货单号填错了，单号是 123', '上面那个怎么修'],
  ];
  for (const [earlier, atText] of cases) {
    const h = makeHarness({ decide: answersCrisis });
    const line = await h.send(h.event({ text: earlier, senderId: MEMBER }));
    await h.send(h.at({ text: atText, senderId: MEMBER }));
    await until(() => h.dispatched.length === 1);
    assert.equal(h.row(line).state, 'queued', 'still open when the turn is built');
    assert.deepEqual(bodies(h.dispatched[0]), [earlier], atText);
    h.advance(4000);
    await h.gate.idle();
    await h.close();
  }
});

test('a person\'s earlier line waiting behind someone else\'s turn is in the @ they send long after', async () => {
  const release = deferred();
  const lineStates = [];
  let line;
  const h = makeHarness({
    dispatch: async () => {
      lineStates.push(h.row(line).state);
      if (lineStates.length === 1) await release.promise;
      return OK;
    },
  });
  line = await h.send(h.event({ text: NAME_A, senderId: MEMBER }));
  const other = await h.send(h.at({ text: '另一个人的问题', senderId: MEMBER2 }));
  await until(() => h.dispatched.length === 1);
  assert.deepEqual(bodies(h.dispatched[0]), [], 'someone else\'s open line stays out');
  h.advance(20000);
  const own = await h.send(h.at({ text: '上面那个怎么修', senderId: MEMBER }));
  release.resolve();
  await h.gate.idle();
  assert.equal(h.dispatched[1].messageId, own.messageId);
  assert.equal(lineStates[1], 'queued', 'still open when the turn is built');
  assert.deepEqual(bodies(h.dispatched[1]), [NAME_A, other.text]);
  await h.close();
});

test('only earlier lines of the same person come back: a later line of theirs stays out, and so does someone else\'s', async () => {
  const h = makeHarness();
  await h.send(h.event({ text: NAME_A, senderId: MEMBER }));
  await h.send(h.event({ text: NAME_B, senderId: MEMBER2 }));
  const at = h.at({ text: '这个问题你怎么看', senderId: MEMBER });
  const laterOwn = h.event({ text: NAME_C, senderId: MEMBER });
  await sendTogether(h, at, laterOwn);
  await until(() => h.dispatched.length === 1);
  assert.equal(h.dispatched[0].messageId, at.messageId);
  assert.equal(h.row(laterOwn).state, 'queued');
  assert.deepEqual(bodies(h.dispatched[0]), [NAME_A]);
  h.advance(4000);
  await h.gate.idle();
  await h.close();
});

test('a line merged into a turn still to come is out of another person\'s turn, and in its target\'s: the double answer in a three-line window', async () => {
  const MSG1 = '可洛，今天星期几';
  const MSG2 = '可洛，算了，直接告诉我 12 乘 12 等于几';
  const h = makeHarness();
  const [first, other, last] = await flushWindow(h, h.event({ text: MSG1, senderId: MEMBER }), h.event({ text: NAME_B, senderId: MEMBER2 }), h.event({ text: MSG2, senderId: MEMBER }));
  assert.equal(h.dispatched[0].messageId, other.messageId, 'the other person leads');
  assert.deepEqual(bodies(h.dispatched[0]), []);
  assert.equal(h.state(first), 'merged:merged');
  assert.equal(h.row(first).merged_into, h.row(last).event_key);
  assert.deepEqual(bodies(turnOf(h, last)), [MSG1, NAME_B], 'the target stands on it');
  assert.equal(h.dispatched.length, 2);
  await h.close();
});

test('over the name cap, a line merged into another person\'s last turn is out of the two before and in that one', async () => {
  const [A, B, C, D] = ['可洛甲', '可洛乙', '可洛丙', '可洛丁'];
  const h = makeHarness();
  const [a, b, c, d] = await flushWindow(h, h.event({ text: A, senderId: MEMBER }), h.event({ text: B, senderId: MEMBER2 }), h.event({ text: C, senderId: MEMBER3 }), h.event({ text: D, senderId: MEMBER4 }));
  assert.equal(h.row(a).merged_into, h.row(d).event_key);
  assert.deepEqual(h.dispatched.map((t) => t.messageId), [b.messageId, c.messageId, d.messageId]);
  assert.deepEqual(bodies(turnOf(h, b)), []);
  assert.deepEqual(bodies(turnOf(h, c)), [B]);
  assert.deepEqual(bodies(turnOf(h, d)), [A, B, C]);
  await h.close();
});

test('a line merged into a target that has ended is context again, however that target ended', async () => {
  const h = makeHarness({ decide: async (req) => decisionOf(req.current.text === NAME_C ? { action: 'skip' } : {}) });
  const [first, , last] = await flushWindow(h, h.event({ text: NAME_A, senderId: MEMBER }), h.event({ text: NAME_B, senderId: MEMBER2 }), h.event({ text: NAME_C, senderId: MEMBER }));
  assert.equal(h.row(first).merged_into, h.row(last).event_key);
  assert.equal(h.state(last), 'skipped:decision_skip');
  await h.sendAndFlush(h.at({ text: '现在这一问', senderId: MEMBER3 }));
  assert.deepEqual(bodies(h.dispatched.at(-1)), [NAME_A, NAME_B, NAME_C]);
  await h.close();
});

test('merged plain chat is still visible while its target is open: only the classes with their own handling are held back', async () => {
  const h = makeHarness();
  const [chat, a, b] = await flushWindow(h, h.event({ text: CHAT, senderId: MEMBER3 }), h.event({ text: NAME_A, senderId: MEMBER }), h.event({ text: NAME_B, senderId: MEMBER2 }));
  assert.equal(h.state(chat), 'merged:merged');
  assert.equal(h.row(chat).merged_into, h.row(b).event_key);
  assert.deepEqual(bodies(turnOf(h, a)), [CHAT]);
  await h.close();
});

test('danger lines of plain class in one window: each turn lacks those queued behind it, and has those that ended', async () => {
  const [X, Y, Z] = [`${CRISIS}吧`, `我也${CRISIS}`, `他也${CRISIS}`];
  const h = makeHarness({ decide: answersCrisis });
  const [x, y, z] = await flushWindow(h, h.event({ text: X, senderId: MEMBER }), h.event({ text: Y, senderId: MEMBER2 }), h.event({ text: Z, senderId: MEMBER3 }));
  for (const e of [x, y, z]) assert.equal(h.row(e).cls, 'ordinary', 'crisis is not kept on the row');
  assert.deepEqual(h.dispatched.map((t) => [t.messageId, t.cls]), [[z.messageId, 'crisis'], [x.messageId, 'crisis'], [y.messageId, 'crisis']]);
  assert.deepEqual(bodies(turnOf(h, z)), []);
  assert.deepEqual(bodies(turnOf(h, x)), [Z]);
  assert.deepEqual(bodies(turnOf(h, y)), [X, Z]);
  await h.close();
});

test('a folded line is judged after its later line when that line is named but not the lead: one turn for the person, one cap slot', async () => {
  const earlier = `可洛 ${CRISIS}`;
  const later = `可洛 ${CRISIS}吧`;
  const second = `我也${CRISIS}`;
  const h = makeHarness({ decide: answersCrisis });
  const [first, danger, lead] = await flushWindow(h, h.event({ text: earlier, senderId: MEMBER }), h.event({ text: later, senderId: MEMBER }), h.event({ text: second, senderId: MEMBER2 }));
  assert.deepEqual(h.dispatched.map((t) => t.messageId), [lead.messageId, danger.messageId]);
  assert.deepEqual(h.dispatched.map((t) => t.cls), ['crisis', 'crisis']);
  assert.equal(h.decideCalls.length, 2);
  assert.equal(h.state(first), 'merged:merged');
  assert.equal(h.row(first).merged_into, h.row(danger).event_key);
  assert.deepEqual(bodies(turnOf(h, lead)), []);
  assert.deepEqual(bodies(turnOf(h, danger)), [earlier, second]);
  assert.equal(h.store.peekCounter(`crisis_group:${h.store.key(GROUP_A)}:${shanghaiDay(h.clock.t)}`), 2);
  await h.close();
});

test('a folded line whose later line got no decision is still judged itself', async () => {
  const earlier = `可洛 ${CRISIS}`;
  const later = `可洛 ${CRISIS}吧`;
  const second = `我也${CRISIS}`;
  const eff = makeEffective({ limits: { ...makeEffective().limits, nameDecisionsPerGroupPerHour: 0 } });
  const h = makeHarness({ effective: eff, decide: answersCrisis });
  const [first, danger] = await flushWindow(h, h.event({ text: earlier, senderId: MEMBER }), h.event({ text: later, senderId: MEMBER }), h.event({ text: second, senderId: MEMBER2 }));
  assert.equal(h.state(danger), 'skipped:decision_cap');
  assert.equal(h.state(first), 'skipped:decision_cap', 'judged itself and refused the same way, not merged into a line that never spoke');
  await h.close();
});

test('a row stuck open hides its line only until the dispatch deadline, since it can get no turn after that', async () => {
  const h = makeHarness();
  const stuck = await h.send(h.event({ text: NAME_B, senderId: MEMBER }));
  const key = h.row(stuck).event_key;
  const real = h.store.transition;
  h.store.transition = (k, ...rest) => {
    if (k === key) throw new Error('injected');
    return real(k, ...rest);
  };
  h.advance(4000);
  await h.gate.idle();
  h.store.transition = real;
  assert.equal(h.row(stuck).state, 'queued', 'both the step and its cleanup failed, and nothing retries it');
  await h.sendAndFlush(h.at({ text: '第一个问题', senderId: MEMBER2 }));
  assert.deepEqual(bodies(h.dispatched.at(-1)), [], 'inside the deadline it could still be waiting for a turn');
  // Exactly on the deadline a queued row still gets a turn; one past, it cannot.
  h.advance(makeEffective().window.dispatchDeadlineMs - 4000);
  await h.sendAndFlush(h.at({ text: '第二个问题', senderId: MEMBER2 }));
  assert.ok(bodies(h.dispatched.at(-1)).includes(NAME_B));
  assert.equal(h.row(stuck).state, 'queued');
  await h.close();
});

test('a line that ends skipped is visible to the next turn, having been hidden from the one before', async () => {
  const h = makeHarness({ decide: async (req) => decisionOf(req.current.text === NAME_B ? { action: 'skip' } : {}) });
  const [a, b, c] = await flushWindow(h, h.event({ text: NAME_A, senderId: MEMBER }), h.event({ text: NAME_B, senderId: MEMBER2 }), h.event({ text: NAME_C, senderId: MEMBER3 }));
  assert.equal(h.state(b), 'skipped:decision_skip');
  assert.deepEqual(bodies(turnOf(h, a)), []);
  assert.deepEqual(bodies(turnOf(h, c)), [NAME_A, NAME_B]);
  await h.close();
});

test('a line that ends merged is visible to the next turn, having been hidden from the one before', async () => {
  const { hold, decide } = holdingFirst();
  const h = makeHarness({ decide });
  const first = await h.send(h.event({ text: NAME_A, senderId: MEMBER }));
  h.advance(4000);
  await until(() => h.decideCalls.length === 1);
  const earlier = await h.send(h.event({ text: NAME_B, senderId: MEMBER2 }));
  const later = await h.send(h.event({ text: NAME_C, senderId: MEMBER2 }));
  hold.resolve();
  await until(() => h.dispatched.length === 1);
  assert.equal(h.dispatched[0].messageId, first.messageId);
  assert.deepEqual(bodies(h.dispatched[0]), [], 'both still open');
  h.advance(4000);
  await h.gate.idle();
  assert.equal(h.state(earlier), 'merged:merged');
  assert.deepEqual(bodies(turnOf(h, later)), [NAME_A, NAME_B], 'one person\'s earlier line, merged, is what their last line stands on');
  await h.close();
});

test('lines that ended before the turn was built are all there', async () => {
  const h = makeHarness();
  await h.sendAndFlush(h.at({ text: '更早的一问', senderId: MEMBER }));
  await h.sendAndFlush(h.event({ text: NAME_A, senderId: MEMBER2 }));
  await h.sendAndFlush(h.at({ text: '现在这一问', senderId: MEMBER3 }));
  assert.deepEqual(bodies(h.dispatched.at(-1)), ['更早的一问', NAME_A]);
  await h.close();
});

test('with display names on, the pending line is held back the same way', async () => {
  const eff = makeEffective({ qq: { groups: { [GROUP_A]: groupEntry({ displayNames: true }) } } });
  const h = makeHarness({ effective: eff });
  const [a, b] = await flushWindow(h, h.event({ text: NAME_A, senderId: MEMBER, displayNameRaw: '小明' }), h.event({ text: NAME_B, senderId: MEMBER2, displayNameRaw: '小红' }));
  assert.deepEqual(bodies(turnOf(h, a)), []);
  assert.deepEqual(turnOf(h, b).history.map((l) => [l.sender, l.body]), [['U1（显示名：小明）', NAME_A]]);
  await h.close();
});

test('the store query throwing: the turn runs with everything visible, the hold settles, and a line is logged', async () => {
  const h = makeHarness();
  h.store.openEventKeys = () => {
    throw new RangeError('disk trouble');
  };
  const [a, b] = await flushWindow(h, h.event({ text: NAME_A, senderId: MEMBER }), h.event({ text: NAME_B, senderId: MEMBER2 }));
  assert.deepEqual(bodies(turnOf(h, a)), [NAME_B], 'today\'s behaviour: a double answer at worst');
  assert.deepEqual(bodies(turnOf(h, b)), [NAME_A]);
  for (const e of [a, b]) {
    assert.equal(h.state(e), 'completed:sent');
    assert.deepEqual(h.reservations(e).map((r) => [r.category, r.status]).sort(), [['decision', 'settled'], ['reply', 'settled']]);
    const lines = h.logs.filter((l) => l.event === 'history_hide_error' && l.eventKey === h.row(e).event_key);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].kind, 'RangeError');
    assert.equal(lines[0].groupKey, h.store.key(GROUP_A));
    assert.ok(!JSON.stringify(lines[0]).includes('disk trouble'), 'the line says what kind of error, not what it said');
  }
  assert.equal(h.logs.filter((l) => l.event === 'gate_error').length, 0, 'the turn did not fail');
  assert.deepEqual(h.store.listAlerts().filter((al) => al.kind === 'gate_error'), []);
  await h.close();
});

test('the query: only this group, only these classes, only open states; and it writes nothing', async () => {
  const h = makeHarness();
  const { store } = h;
  const G = 'group-one';
  const add = (key, state, cls, group = G) => {
    store.claimEvent({ eventKey: key, groupKey: group, receivedAt: T0 });
    store.setClass(key, cls);
    if (state !== 'received') store.transition(key, 'received', state);
  };
  for (const state of ['received', 'queued', 'deciding', 'approved', 'dispatching', 'delivering']) add(`open-${state}`, state, 'name');
  for (const state of ['merged', 'skipped', 'completed', 'failed', 'restart_dropped', 'crash_unknown']) add(`shut-${state}`, state, 'name');
  add('chat', 'queued', 'ordinary');
  add('other-group', 'queued', 'name', 'group-two');
  const before = JSON.stringify(h.allEvents());
  assert.deepEqual(store.openEventKeys(G, ['name'], T0).sort(), ['open-approved', 'open-deciding', 'open-delivering', 'open-dispatching', 'open-queued', 'open-received']);
  assert.deepEqual(store.openEventKeys(G, ['ordinary'], T0), ['chat']);
  assert.deepEqual(store.openEventKeys('group-three', ['name'], T0), []);
  assert.deepEqual(store.openEventKeys(G, ['name'], T0 + 1), [], 'nothing older than the cutoff');
  assert.equal(JSON.stringify(h.allEvents()), before);
  await h.close();
});

test('the merged query: only merged rows of this group and these classes, whose target has not ended and is recent; and it writes nothing', async () => {
  const h = makeHarness();
  const { store } = h;
  const G = 'group-one';
  const add = (key, state, cls, { group = G, into = null, at = T0 } = {}) => {
    store.claimEvent({ eventKey: key, groupKey: group, receivedAt: at });
    store.setClass(key, cls);
    if (state !== 'received') store.transition(key, 'received', state, { mergedInto: into });
  };
  add('open-target', 'queued', 'name');
  add('shut-target', 'completed', 'name');
  add('old-target', 'queued', 'name', { at: T0 - 1000 });
  add('wanted', 'merged', 'name', { into: 'open-target' });
  add('into-shut', 'merged', 'name', { into: 'shut-target' });
  add('into-old', 'merged', 'name', { into: 'old-target' });
  add('old-line', 'merged', 'name', { into: 'open-target', at: T0 - 1000 });
  add('chat', 'merged', 'ordinary', { into: 'open-target' });
  add('other-group', 'merged', 'name', { group: 'group-two', into: 'open-target' });
  add('skipped-with-target', 'skipped', 'name', { into: 'open-target' });
  const before = JSON.stringify(h.allEvents());
  assert.deepEqual(store.mergedIntoOpen(G, ['name'], T0), [{ eventKey: 'wanted', mergedInto: 'open-target' }]);
  assert.deepEqual(store.mergedIntoOpen(G, ['ordinary'], T0), [{ eventKey: 'chat', mergedInto: 'open-target' }]);
  assert.equal(store.mergedIntoOpen(G, ['name'], T0 - 1000).length, 3, 'with the older cutoff, those two come back');
  assert.equal(JSON.stringify(h.allEvents()), before);
  await h.close();
});

test('both queries the gate runs read through an index, so the kept rows of finished events are not walked', async () => {
  const h = makeHarness();
  const { db } = h.store;
  const prepared = [];
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    prepared.push(sql);
    return prepare(sql);
  };
  const classes = ['at', 'reply_bot', 'name', 'name_addressed'];
  h.store.openEventKeys('g', classes, T0);
  h.store.mergedIntoOpen('g', classes, T0);
  db.prepare = prepare;
  assert.equal(prepared.length, 2, 'the statements the store really prepares');
  const details = (sql) => prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...new Array(sql.split('?').length - 1).fill('x')).map((row) => row.detail);
  const [open, merged] = prepared.map(details);
  assert.equal(open.length, 1, JSON.stringify(open));
  assert.match(open[0], /USING INDEX events_(state|received)/);
  assert.equal(merged.length, 2, JSON.stringify(merged));
  assert.match(merged[0], /^SEARCH m USING INDEX events_(state|received)/);
  assert.match(merged[1], /^SEARCH t USING INDEX sqlite_autoindex_events_1 \(event_key=\?\)/);
  await h.close();
});

test('the buffer: hidden lines take no room under the token cap', () => {
  const ITEM = '一二三四五';
  assert.equal(estimateTokens(ITEM), 10);
  const big = '长'.repeat(100);
  assert.equal(estimateTokens(big), 200, 'over this cap on its own');
  const buffer = createContextBuffer({ maxItems: 40, maxAgeMs: 3600000, maxTokens: 25 });
  const line = (eventKey, text) => buffer.push('g', { senderKey: 's1', text, ts: T0, eventKey });
  line('older', `${ITEM}甲`);
  line('old', `${ITEM}乙`);
  line('pending', big);
  line('now', `${ITEM}丙`);
  assert.deepEqual(buffer.history('g', 'current', T0).map((l) => l.body), [`${ITEM}丙`], 'positive control: unhidden, it stops the walk at itself');
  const hide = new Set(['pending']);
  assert.deepEqual(buffer.history('g', 'current', T0, { hide }).map((l) => l.body), [`${ITEM}乙`, `${ITEM}丙`], 'the cap counts visible lines, and still holds at 24 of 25');
});

test('the buffer: the same with labels counted, while lines() and an empty set change nothing', () => {
  const buffer = createContextBuffer({ maxItems: 40, maxAgeMs: 3600000, maxTokens: 30 });
  buffer.push('g', { senderKey: 's1', text: '一二三四五', ts: T0, eventKey: 'kept', displayName: '小明' });
  buffer.push('g', { senderKey: 's2', text: '长'.repeat(100), ts: T0, eventKey: 'pending', displayName: '小红' });
  buffer.push('g', { senderKey: 's3', text: '当前这句', ts: T0, eventKey: 'current' });
  const hide = new Set(['pending']);
  assert.deepEqual(buffer.history('g', 'current', T0, { showNames: true, hide }).map((l) => [l.sender, l.body]), [['U1（显示名：小明）', '一二三四五']]);
  assert.deepEqual(buffer.history('g', 'current', T0, { showNames: true }), [], 'positive control');
  assert.deepEqual(buffer.lines('g', 'current', 15, 200, T0).map((l) => l.sender), ['U1', 'U2'], 'what a decision reads keeps the pending line');
  assert.deepEqual(buffer.history('g', 'current', T0, { hide: new Set() }), [], 'an empty set hides nothing: the long line still stops the walk');
});

test('the buffer: an empty set shows a line that fits, so it is not hiding everything', () => {
  const buffer = createContextBuffer({ maxItems: 40, maxAgeMs: 3600000, maxTokens: 30 });
  buffer.push('g', { senderKey: 's1', text: '一二三四五', ts: T0, eventKey: 'kept' });
  assert.deepEqual(buffer.history('g', 'current', T0, { hide: new Set() }).map((l) => l.body), ['一二三四五']);
});

test('the buffer: a hidden newest line still decides the member\'s label on an older visible line', () => {
  const buffer = createContextBuffer({ maxItems: 40, maxAgeMs: 3600000, maxTokens: 1000 });
  buffer.push('g', { senderKey: 's1', text: '更早的一句', ts: T0, eventKey: 'old', displayName: '旧名' });
  buffer.push('g', { senderKey: 's1', text: '等自己的回合', ts: T0, eventKey: 'pending', displayName: null });
  const hide = new Set(['pending']);
  assert.deepEqual(buffer.history('g', 'current', T0, { showNames: true, hide }).map((l) => [l.sender, l.body]), [['U1', '更早的一句']]);
});

test('the buffer: ownEarlier gives only this member\'s lines from before that arrival', () => {
  const buffer = createContextBuffer({ maxItems: 40, maxAgeMs: 3600000, maxTokens: 1000 });
  const line = (eventKey, senderKey, arrival) => buffer.push('g', { senderKey, text: '一句', ts: T0, eventKey, arrival });
  line('a1', 's1', 1);
  line('b2', 's2', 2);
  line('a3', 's1', 3);
  line('a4', 's1', 4);
  assert.deepEqual(buffer.ownEarlier('g', 's1', 4), ['a1', 'a3']);
  assert.deepEqual(buffer.ownEarlier('g', 's1', 1), []);
  assert.deepEqual(buffer.ownEarlier('g', 's2', 4), ['b2']);
  assert.deepEqual(buffer.ownEarlier('g', 'nobody', 4), []);
  assert.deepEqual(buffer.ownEarlier('other', 's1', 4), []);
});
