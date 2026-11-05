// What /stop does to work that has not started, what a changed account does before money is spent, and qq.enabled=false
// at the exit. The fake host here refuses what the real one refuses: any turn no newer than /stop until a later turn
// clears the cutoff (shouldSkipMessageByAbortCutoff, seen on the real Gateway), and it still reports a clean run.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ApiError } from '@tencent-connect/qqbot-nodejs';
import { createExit } from '../../src/clo-plugin/lib/channels/qq/exit.js';
import { decisionOf, deferred, GROUP_A, GROUP_B, groupEntry, makeEffective, makeHarness, MEMBER, MEMBER2, OWNER, ROOT, USAGE } from '../fixtures/inbound.mjs';

const MEMBER3 = 'THIRDMEMBER111122223333';
const LINES = JSON.parse(readFileSync(join(ROOT, 'persona', 'policy-lines.zh.json'), 'utf8'));
const NAME_A = '可洛你看看退货怎么办';
const NAME_B = '可洛今天开会是几点';
const NAME_C = '可洛帮我想个标题吧';
const CHAT = '今天中午吃什么好呢';
const CRISIS = '我真的不想活了';
const REPLY = '这是一条普通的回复。';
const tick = () => new Promise((r) => setImmediate(r));
const until = async (cond) => {
  for (let i = 0; i < 2000 && !cond(); i += 1) await tick();
  assert.ok(cond(), 'the expected state was never reached');
};

const open = [];
after(async () => {
  for (const h of open) await h.close();
});

// Real gate, store, ledger, policy and exit. Only the host and the QQ API are fake. holdFirst keeps the first model turn
// running until it is released, the way a slow reply does.
function stack({ decide, effective, holdFirst = false } = {}) {
  const posts = [];
  const results = [];
  const hold = deferred();
  const host = { cutoff: null, ran: [] };
  let h;
  const bot = {
    appId: 'FAKE-APP',
    api: {
      post: async (path, body) => {
        posts.push({ path, body });
        h.onPost?.();
        const r = results.shift();
        if (r instanceof Error) throw r;
        return r ?? { id: `S${posts.length}` };
      },
    },
  };
  const dispatch = async (turn) => {
    if (turn.authorizedCommand === '/stop') {
      host.cutoff = turn.msgTs;
      return { started: true, hostError: false, aborted: false, usage: null };
    }
    if (host.cutoff !== null && turn.msgTs <= host.cutoff) return { started: true, hostError: false, aborted: false, usage: null };
    host.cutoff = null;
    host.ran.push(turn.messageId);
    if (holdFirst && host.ran.length === 1) await hold.promise;
    h.onModelRun?.();
    h.exit.collect(turn.turnId, { text: REPLY }, { kind: 'final' });
    return { started: true, hostError: false, aborted: false, usage: USAGE };
  };
  h = makeHarness({ decide, effective, dispatch, attach: false });
  h.exit = createExit({ bot, store: h.store, policy: h.policy, getEffective: () => h.eff.current, secrets: [], log: h.log, now: h.now, sleep: async (ms) => { await h.onSleep?.(ms); } });
  h.gate.attachExit(h.exit);
  h.posts = posts;
  h.results = results;
  h.hold = hold;
  h.host = host;
  // The platform's clock moves too, so what follows has a later timestamp than what came before.
  h.later = (ms = 1000) => { h.clock.t += ms; };
  h.stop = async (senderId = OWNER) => {
    h.later();
    const e = await h.send(h.at({ text: '/stop', senderId }));
    await tick();
    return e;
  };
  h.alertKinds = () => h.store.listAlerts().map((a) => a.kind);
  h.pausedBy = () => h.store.getControl('paid_paused');
  h.postedTo = (e) => h.posts.filter((p) => p.body.msg_id === e.messageId).map((p) => p.body.content);
  open.push(h);
  return h;
}

// ---- /stop against a queued @ ----

test('@ queued behind /stop: not sent the failure line, nothing held, no false alert', async () => {
  const h = stack({ holdFirst: true });
  const a = await h.send(h.at({ text: '讲个长故事', senderId: MEMBER }));
  await until(() => h.host.ran.length === 1);
  h.later();
  const b = await h.send(h.at({ text: '排队的问题', senderId: MEMBER2 }));
  assert.equal(h.state(b), 'queued');
  const stop = await h.stop();
  h.hold.resolve();
  await h.gate.idle();

  assert.equal(h.state(a), 'failed:aborted');
  assert.equal(h.state(b), 'skipped:owner_stop');
  assert.deepEqual(h.postedTo(b), []);
  assert.equal(h.reservations(b).length, 0, 'no hold');
  assert.equal(h.alertKinds().includes('model_failed'), false);
  assert.equal(h.counters().filter((c) => c.key.startsWith(`sender_addr:${h.store.key(MEMBER2)}`)).length, 0, 'no sender slot');
  assert.equal(h.posts.length, 1, 'only the ack');
  assert.equal(h.postedTo(stop).length, 1);
  assert.deepEqual(h.host.ran, [a.messageId]);
});

test('reply-to-bot queued behind /stop ends the same way', async () => {
  const h = stack({ holdFirst: true });
  h.store.addBotRef(h.store.key('REFIDX9'), h.store.key(GROUP_A), 'E');
  await h.send(h.at({ text: '讲个长故事', senderId: MEMBER }));
  await until(() => h.host.ran.length === 1);
  h.later();
  const b = await h.send(h.event({ text: '接着上一条说', senderId: MEMBER2, refMsgIdx: 'REFIDX9' }));
  assert.equal(h.row(b).cls, 'reply_bot');
  await h.stop();
  h.hold.resolve();
  await h.gate.idle();
  assert.equal(h.state(b), 'skipped:owner_stop');
  assert.deepEqual(h.postedTo(b), []);
  assert.equal(h.reservations(b).length, 0);
});

test('a person in danger queued behind /stop still goes on, and gets the line that says where to find help', async () => {
  const h = stack({ holdFirst: true });
  await h.send(h.at({ text: '讲个长故事', senderId: MEMBER }));
  await until(() => h.host.ran.length === 1);
  h.later();
  const b = await h.send(h.at({ text: CRISIS, senderId: MEMBER2 }));
  await h.stop();
  h.hold.resolve();
  await h.gate.idle();
  assert.equal(h.state(b), 'failed:required_no_text');
  assert.deepEqual(h.postedTo(b), [LINES.modelFailed]);
});

test('/stop leaves alone an @ said after it, and an @ queued in another group', async () => {
  const h = stack({ holdFirst: true });
  const a = await h.send(h.at({ text: '讲个长故事', senderId: MEMBER }));
  await until(() => h.host.ran.length === 1);
  h.later();
  const elsewhere = await h.send(h.at({ text: '另一个群的问题', senderId: MEMBER3, conversationId: GROUP_B }));
  await h.stop();
  h.later();
  const newer = await h.send(h.at({ text: '停下之后的问题', senderId: MEMBER2 }));
  h.hold.resolve();
  await h.gate.idle();
  assert.equal(h.state(a), 'failed:aborted');
  assert.equal(h.state(newer), 'completed:sent');
  assert.deepEqual(h.postedTo(newer), [REPLY]);
  assert.notEqual(h.state(elsewhere), 'skipped:owner_stop');
});

// ---- /stop against an ordinary window ----

test('an ordinary message in a window open at /stop buys nothing and spends no interjection', async () => {
  const h = stack();
  const e = await h.send(h.event({ text: CHAT, senderId: MEMBER }));
  await h.stop();
  h.advance(4000);
  await h.gate.idle();
  assert.equal(h.state(e), 'skipped:owner_stop');
  assert.equal(h.decideCalls.length, 0);
  assert.equal(h.reservations(e).length, 0);
  assert.equal(h.claims().length, 0);
  assert.equal(h.pausedBy(), null, 'one /stop must not pause paid work for everyone');
  assert.equal(h.posts.length, 1, 'only the ack');

  const next = await h.sendAndFlush(h.event({ text: '有人知道怎么退货吗', senderId: MEMBER2 }));
  assert.equal(h.state(next), 'completed:sent', 'the cooldown was not used up');
  assert.deepEqual(h.claims().map((c) => c.status), ['consumed']);
});

test('an ordinary decision out at /stop: paid for, but its interjection does not start and its claim goes back', async () => {
  const hold = deferred();
  const h = stack({ decide: async () => {
    await hold.promise;
    return decisionOf();
  } });
  const e = await h.send(h.event({ text: CHAT, senderId: MEMBER }));
  h.advance(4000);
  await until(() => h.decideCalls.length === 1);
  await h.stop();
  hold.resolve();
  await h.gate.idle();
  assert.equal(h.state(e), 'skipped:owner_stop');
  assert.equal(h.decideCalls.length, 1);
  assert.deepEqual(h.reservations(e).map((r) => `${r.category}:${r.status}`), ['decision:settled'], 'the decision was paid and there is no reply hold');
  assert.deepEqual(h.claims().map((c) => c.status), ['released']);
  assert.deepEqual(h.host.ran, []);
  assert.equal(h.pausedBy(), null);
  assert.equal(h.alertKinds().includes('model_failed'), false);
});

test('words of danger the model read as nothing: an interjection has no help line to give, so it stops too', async () => {
  const hold = deferred();
  const h = stack({ decide: async () => {
    await hold.promise;
    return decisionOf();
  } });
  const e = await h.send(h.event({ text: CRISIS, senderId: MEMBER }));
  h.advance(4000);
  await until(() => h.decideCalls.length === 1);
  await h.stop();
  hold.resolve();
  await h.gate.idle();
  assert.equal(h.state(e), 'skipped:owner_stop');
  assert.deepEqual(h.claims().map((c) => c.status), ['released']);
  assert.equal(h.pausedBy(), null, 'a refused interjection would have left usage_missing');
  assert.deepEqual(h.postedTo(e), []);
});

test('an ordinary decision out at /stop that the model flags as danger still goes on', async () => {
  const hold = deferred();
  const h = stack({ decide: async () => {
    await hold.promise;
    return decisionOf({ crisis: true });
  } });
  const e = await h.send(h.event({ text: '没什么意思了真的', senderId: MEMBER }));
  h.advance(4000);
  await until(() => h.decideCalls.length === 1);
  await h.stop();
  hold.resolve();
  await h.gate.idle();
  assert.equal(h.state(e), 'failed:required_no_text', 'past the gate, and the host refuses it');
  assert.deepEqual(h.postedTo(e), [LINES.modelFailed]);
});

test('a window that would stay quiet anyway keeps its own reason', async () => {
  const plain = async (withStop) => {
    const h = stack({ effective: makeEffective({ qq: { groups: { [GROUP_A]: groupEntry({ interject: false }) } } }) });
    const e = await h.send(h.event({ text: CHAT, senderId: MEMBER }));
    if (withStop) await h.stop();
    h.advance(4000);
    await h.gate.idle();
    return h.state(e);
  };
  const without = await plain(false);
  assert.match(without, /^skipped:/);
  assert.notEqual(without, 'skipped:owner_stop');
  assert.equal(await plain(true), without);
});

test('a window holding both sides of /stop speaks for what was said after it', async () => {
  const h = stack();
  const older = await h.send(h.event({ text: CHAT, senderId: MEMBER }));
  await h.stop();
  h.later();
  const newer = await h.send(h.event({ text: '有人知道怎么退货吗', senderId: MEMBER2 }));
  h.advance(4000);
  await h.gate.idle();
  assert.equal(h.state(older), 'merged:merged');
  assert.equal(h.state(newer), 'completed:sent');
  assert.equal(h.decideCalls.length, 1);
});

test('words of danger in a window open at /stop are still looked at, and get the line that says where to find help', async () => {
  const h = stack({ decide: async () => decisionOf({ crisis: true }) });
  const e = await h.send(h.event({ text: CRISIS, senderId: MEMBER }));
  await h.stop();
  h.advance(4000);
  await h.gate.idle();
  assert.equal(h.decideCalls.length, 1);
  assert.equal(h.state(e), 'failed:required_no_text', 'past the gate, and the host refuses it');
  assert.deepEqual(h.postedTo(e), [LINES.modelFailed]);
});

test('a name from before /stop does not take with it what was said after the stop', async () => {
  const h = stack();
  const name = await h.send(h.event({ text: NAME_A, senderId: MEMBER }));
  await h.stop();
  h.later();
  const newer = await h.send(h.event({ text: '有人知道怎么退货吗', senderId: MEMBER2 }));
  h.advance(4000);
  await h.gate.idle();
  assert.equal(h.state(name), 'skipped:owner_stop');
  assert.equal(h.row(newer).merged_into, null);
  assert.equal(h.state(newer), 'completed:sent');
  assert.equal(h.decideCalls.length, 1, 'for the one said after it');
  assert.deepEqual(h.host.ran, [newer.messageId]);
});

test('a name from before /stop alone in its window just ends, once', async () => {
  const h = stack();
  const name = await h.send(h.event({ text: NAME_A, senderId: MEMBER }));
  await h.stop();
  h.advance(4000);
  await h.gate.idle();
  assert.equal(h.state(name), 'skipped:owner_stop');
  assert.equal(h.decideCalls.length, 0);
  assert.equal(h.logs.filter((l) => l.event === 'gate_end' && l.eventKey === h.row(name).event_key).length, 1);
});

// ---- the same second as /stop: the host compares timestamps, and QQ's are whole seconds ----

const ownerStopNow = (h) => h.send(h.at({ text: '/stop', senderId: OWNER }));

test('an ordinary message in the same second as /stop is not sent to the host, and pauses nothing', async () => {
  const h = stack();
  await ownerStopNow(h);
  await tick();
  const e = await h.sendAndFlush(h.event({ text: '有人知道怎么退货吗', senderId: MEMBER2 }));
  assert.equal(h.state(e), 'skipped:owner_stop');
  assert.equal(h.decideCalls.length, 0);
  assert.equal(h.reservations(e).length, 0);
  assert.equal(h.claims().length, 0);
  assert.equal(h.pausedBy(), null);

  h.later(5000);
  const next = await h.sendAndFlush(h.at({ text: '后面的人问问题', senderId: MEMBER }));
  assert.equal(h.state(next), 'completed:sent', 'an unrelated member is still answered');
  assert.deepEqual(h.postedTo(next), [REPLY]);
});

test('an ordinary message sent before /stop but delivered after it ends the same way', async () => {
  const h = stack();
  const sentAt = h.now();
  h.later();
  await ownerStopNow(h);
  await tick();
  const e = await h.sendAndFlush({ ...h.event({ text: '有人知道怎么退货吗', senderId: MEMBER2 }), timestampMs: sentAt });
  assert.equal(h.state(e), 'skipped:owner_stop');
  assert.equal(h.decideCalls.length, 0);
  assert.equal(h.pausedBy(), null);
});

test('words of danger in the same second as /stop are looked at, but an interjection on them still stops', async () => {
  const h = stack();
  await ownerStopNow(h);
  await tick();
  const e = await h.sendAndFlush(h.event({ text: CRISIS, senderId: MEMBER2 }));
  assert.equal(h.decideCalls.length, 1);
  assert.equal(h.state(e), 'skipped:owner_stop');
  assert.deepEqual(h.claims().map((c) => c.status), ['released']);
  assert.deepEqual(h.host.ran, []);
  assert.equal(h.pausedBy(), null);
});

test('the next second is past /stop: an ordinary message there is judged as usual', async () => {
  const h = stack();
  await ownerStopNow(h);
  await tick();
  h.later();
  const e = await h.sendAndFlush(h.event({ text: '有人知道怎么退货吗', senderId: MEMBER2 }));
  assert.equal(h.state(e), 'completed:sent');
});

// ---- /stop with the send rate full ----

// Four sends this minute, the default for one group.
const fillRate = (h) => {
  h.store.insertSendParts({ eventKey: 'filler', groupKey: h.store.key(GROUP_A), kind: 'reply', parts: [1, 2, 3, 4].map((n) => ({ textSha: String(n) })), now: h.now() });
};
const passTime = (h) => { h.onSleep = (ms) => { h.later(ms); }; };

test('rate full at /stop: the ack waits for room and goes out, so the queued @ was told', async () => {
  const h = stack({ holdFirst: true });
  passTime(h);
  fillRate(h);
  const a = await h.send(h.at({ text: '讲个长故事', senderId: MEMBER }));
  await until(() => h.host.ran.length === 1);
  h.later();
  const b = await h.send(h.at({ text: '排队的问题', senderId: MEMBER2 }));
  const stop = await h.stop();
  h.hold.resolve();
  await h.gate.idle();
  assert.equal(h.state(a), 'failed:aborted');
  assert.equal(h.state(b), 'skipped:owner_stop');
  assert.equal(h.state(stop), 'completed:cmd_owner');
  assert.equal(h.postedTo(stop).length, 1);
  assert.equal(h.logs.filter((l) => l.event === 'exit_wait' && l.reason === 'command_ack').length, 1);
  assert.equal(h.alertKinds().includes('command_ack_refused'), false);
});

test('rate still full after the wait: the operator hears the ack was lost, and it is tried no more', async () => {
  const h = stack({ holdFirst: true });
  let waits = 0;
  h.onSleep = () => { waits += 1; };
  fillRate(h);
  await h.send(h.at({ text: '讲个长故事', senderId: MEMBER }));
  await until(() => h.host.ran.length === 1);
  h.later();
  const b = await h.send(h.at({ text: '排队的问题', senderId: MEMBER2 }));
  const stop = await h.stop();
  h.hold.resolve();
  await h.gate.idle();
  assert.equal(h.state(b), 'skipped:owner_stop');
  assert.equal(h.state(stop), 'completed:cmd_owner', 'the host did stop');
  assert.deepEqual(h.postedTo(stop), []);
  assert.equal(waits, 1);
  assert.equal(h.alertKinds().filter((k) => k === 'command_ack_refused').length, 1);
  assert.equal(JSON.stringify(h.store.listAlerts()).includes(GROUP_A), false, 'no raw ID');
});

test('a local command\'s ack waits for room too', async () => {
  const h = stack();
  passTime(h);
  fillRate(h);
  h.later();
  const e = await h.send(h.at({ text: '/clo pause', senderId: OWNER }));
  await h.gate.idle();
  assert.equal(h.state(e), 'completed:cmd_owner');
  assert.equal(h.postedTo(e).length, 1);
  assert.equal(h.alertKinds().includes('command_ack_refused'), false);
});

// A reply with its text written, and no room to post it yet. The owner's /stop lands during the wait.
async function parkedAtStop(text) {
  const h = stack();
  let stop = null;
  // The ack waits here too, so this goes first.
  h.onSleep = async (ms) => {
    if (stop === null) {
      stop = h.stop();
      await stop;
    }
    h.later(ms);
  };
  fillRate(h);
  h.later();
  const e = await h.send(h.at({ text, senderId: MEMBER }));
  await h.gate.idle();
  assert.ok(h.logs.some((l) => l.event === 'exit_wait' && l.eventKey === h.row(e).event_key), 'it did wait');
  return { h, e, stop: await stop };
}

test('a reply waiting for send-rate room is stopped by /stop and never posts', async () => {
  const { h, e, stop } = await parkedAtStop('讲个长故事');
  assert.equal(h.state(e), 'failed:aborted');
  assert.deepEqual(h.postedTo(e), []);
  assert.deepEqual(h.reservations(e).map((r) => r.status), ['settled'], 'the model did run');
  assert.equal(h.pausedBy(), null);
  assert.equal(h.alertKinds().includes('model_failed'), false);
  assert.equal(h.postedTo(stop).length, 1, 'the ack goes out in its place');
});

test('a reply written for a person in danger still goes out after the wait', async () => {
  const { h, e } = await parkedAtStop(CRISIS);
  assert.equal(h.state(e), 'completed:sent');
  assert.deepEqual(h.postedTo(e), [REPLY]);
});

test('positive control: with no /stop the waiting reply posts', async () => {
  const h = stack();
  passTime(h);
  fillRate(h);
  h.later();
  const e = await h.send(h.at({ text: '讲个长故事', senderId: MEMBER }));
  await h.gate.idle();
  assert.equal(h.state(e), 'completed:sent');
  assert.deepEqual(h.postedTo(e), [REPLY]);
});

// ---- a member's /stop ----

test("a member's /stop leaves a running turn, a queued @ and queued names alone", async () => {
  const h = stack({ holdFirst: true });
  const a = await h.send(h.at({ text: '讲个长故事', senderId: MEMBER3 }));
  await until(() => h.host.ran.length === 1);
  h.later();
  const at = await h.send(h.at({ text: '排队的问题', senderId: MEMBER2 }));
  const n1 = await h.send(h.event({ text: NAME_A, senderId: MEMBER }));
  const n2 = await h.send(h.event({ text: NAME_B, senderId: MEMBER2 }));
  const stop = await h.stop(MEMBER);
  assert.equal(h.state(stop), 'ignored:cmd_non_owner');
  h.advance(4000);
  h.hold.resolve();
  await h.gate.idle();
  assert.equal(h.state(a), 'completed:sent', 'the running turn is not aborted');
  for (const e of [at, n1, n2]) assert.equal(h.state(e), 'completed:sent');
  assert.equal(h.decideCalls.length, 2);
});

test("a member's /stop leaves an open ordinary window alone", async () => {
  const h = stack();
  const e = await h.send(h.event({ text: CHAT, senderId: MEMBER }));
  await h.stop(MEMBER);
  h.advance(4000);
  await h.gate.idle();
  assert.equal(h.state(e), 'completed:sent');
  assert.equal(h.decideCalls.length, 1);
});

// ---- account checks before a decision ----

const flipAccount = (h) => { h.eff.current.qq.appId = 'OTHER-APP'; };
const firstHeld = (hold, answer) => {
  let first = true;
  return async () => {
    if (first) {
      first = false;
      await hold.promise;
    }
    return answer();
  };
};

test('the account changing with names queued: no decision is bought for them and no cap is spent', async () => {
  const hold = deferred();
  const h = stack({ decide: firstHeld(hold, () => decisionOf()) });
  const a = await h.send(h.event({ text: NAME_A, senderId: MEMBER }));
  const b = await h.send(h.event({ text: NAME_B, senderId: MEMBER2 }));
  const c = await h.send(h.event({ text: NAME_C, senderId: MEMBER3 }));
  h.advance(4000);
  await until(() => h.decideCalls.length === 1);
  flipAccount(h);
  hold.resolve();
  await h.gate.idle();
  assert.equal(h.decideCalls.length, 1, 'only the one already out');
  for (const e of [a, b, c]) assert.equal(h.state(e), 'failed:exit_refused');
  for (const e of [b, c]) assert.equal(h.reservations(e).length, 0);
  const count = (prefix) => h.counters().filter((r) => r.key.startsWith(prefix)).reduce((n, r) => n + r.value, 0);
  assert.equal(count('name_dec:'), 1);
  assert.equal(count('dec_group:'), 1);
  assert.equal(count('dec_day:'), 1);
  assert.equal(h.dispatched.length, 0);
  assert.equal(h.posts.length, 0);
});

test('positive control for the above: the same names with the account unchanged are all judged', async () => {
  const h = stack();
  const a = await h.send(h.event({ text: NAME_A, senderId: MEMBER }));
  const b = await h.send(h.event({ text: NAME_B, senderId: MEMBER2 }));
  h.advance(4000);
  await h.gate.idle();
  assert.equal(h.decideCalls.length, 2);
  assert.equal(h.state(a), 'completed:sent');
  assert.equal(h.state(b), 'completed:sent');
});

test('the account changing with a second person in danger queued: no second decision', async () => {
  const hold = deferred();
  const h = stack({ decide: firstHeld(hold, () => decisionOf({ crisis: true })) });
  const a = await h.send(h.event({ text: CRISIS, senderId: MEMBER }));
  const b = await h.send(h.event({ text: `我也${CRISIS}`, senderId: MEMBER2 }));
  h.advance(4000);
  await until(() => h.decideCalls.length === 1);
  flipAccount(h);
  hold.resolve();
  await h.gate.idle();
  assert.equal(h.decideCalls.length, 1);
  assert.equal(h.state(a), 'failed:exit_refused');
  assert.equal(h.state(b), 'failed:exit_refused');
  assert.equal(h.reservations(a).length, 0, 'the last one in danger leads the window, so the first is the one queued');
  assert.equal(h.posts.length, 0);
});

test('the account changing while a window is open: every record ends once and nothing is claimed or bought', async () => {
  for (const [label, events] of [
    ['a name', [{ text: NAME_A, senderId: MEMBER }]],
    ['ordinary', [{ text: CHAT, senderId: MEMBER }, { text: '有人知道怎么退货吗', senderId: MEMBER2 }]],
    ['danger', [{ text: CRISIS, senderId: MEMBER }]],
  ]) {
    const h = stack();
    const sent = [];
    for (const e of events) sent.push(await h.send(h.event(e)));
    flipAccount(h);
    h.advance(4000);
    await h.gate.idle();
    assert.equal(h.decideCalls.length, 0, label);
    assert.equal(h.claims().length, 0, label);
    for (const e of sent) {
      assert.equal(h.state(e), 'failed:exit_refused', label);
      assert.equal(h.reservations(e).length, 0, label);
    }
    assert.equal(h.posts.length, 0, label);
  }
});

// ---- qq.enabled=false at the exit ----

const switchOff = (h) => { h.eff.current = { ...h.eff.current, qq: { ...h.eff.current.qq, enabled: false } }; };
const refOf = (h) => ({ eventKey: 'e9', groupKey: h.store.key(GROUP_A), groupId: GROUP_A, messageId: 'M9', receivedAt: h.now(), msgTs: h.now() });

test('QQ switched off during a turn: its reply is refused, the same as the group coming off the list', async () => {
  const outcome = async (flip) => {
    const h = stack();
    if (flip) h.onModelRun = () => flip(h);
    const e = await h.sendAndFlush(h.at());
    return { state: h.state(e), posts: h.posts.length, dropped: h.logs.filter((l) => l.event === 'exit_drop').map((l) => l.reason) };
  };
  assert.deepEqual(await outcome(null), { state: 'completed:sent', posts: 1, dropped: [] }, 'positive control');
  const removed = await outcome((h) => { h.eff.current = { ...h.eff.current, qq: { ...h.eff.current.qq, groups: {} } }; });
  assert.deepEqual(removed, { state: 'failed:exit_refused', posts: 0, dropped: ['not_admitted'] });
  assert.deepEqual(await outcome(switchOff), removed);
});

test('QQ switched off: fixed lines and acks do not go out', async () => {
  const h = stack();
  assert.equal((await h.exit.sendFixed(refOf(h), 'modelFailed')).sent, true, 'positive control');
  assert.equal((await h.exit.commandAck(refOf(h), '好')).sent, true, 'positive control');
  const before = h.posts.length;
  switchOff(h);
  assert.deepEqual(await h.exit.sendFixed(refOf(h), 'modelFailed'), { sent: false, reason: 'not_admitted' });
  assert.deepEqual(await h.exit.commandAck(refOf(h), '好'), { sent: false, reason: 'not_admitted' });
  assert.equal(h.posts.length, before);
});

test('QQ switched off during a connect retry: the retry does not go out', async () => {
  const connectTimeout = () => new ApiError('Network error [/x]: fetch failed | Connect Timeout Error (attempted addresses: 192.0.2.1:443, timeout: 10000ms)', 0, '/x');
  const control = stack();
  control.results.push(connectTimeout(), { id: 'ACK' });
  assert.equal((await control.exit.commandAck(refOf(control), '好')).sent, true, 'positive control');
  assert.equal(control.posts.length, 2);

  const h = stack();
  h.results.push(connectTimeout(), { id: 'never' });
  h.onPost = () => switchOff(h);
  assert.deepEqual(await h.exit.commandAck(refOf(h), '好'), { sent: false, reason: 'send_not_connected' });
  assert.equal(h.posts.length, 1);
});
