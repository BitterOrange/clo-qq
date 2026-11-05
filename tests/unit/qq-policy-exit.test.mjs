// TQ23: the output side of the policy and every authorizeReply step, in order. Includes CLAUDE.md §10
// "wrong account", which can only be checked here because an event has no account (design: From GATE 20).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createExit } from '../../src/clo-plugin/lib/channels/qq/exit.js';
import { GROUP_A, GROUP_B, makeHarness, MEMBER, OWNER, ROOT, T0, USAGE } from '../fixtures/inbound.mjs';

const LINES = JSON.parse(readFileSync(join(ROOT, 'persona', 'policy-lines.zh.json'), 'utf8'));
const SECRET = 'THIS-IS-A-FAKE-SECRET-VALUE';
const HIT = '加我 约炮';

const open = [];
after(async () => {
  for (const h of open) await h.close();
});

function stack({ appId = 'FAKE-APP', effective, mid } = {}) {
  const posts = [];
  const bot = { appId, api: { post: async (path, body) => { posts.push({ path, body }); return { id: `S${posts.length}` }; } } };
  let h;
  const dispatch = async (turn) => {
    await mid?.(h, turn);
    h.exit.collect(turn.turnId, { text: h.replyText }, { kind: 'final' });
    return { started: true, hostError: false, aborted: false, usage: USAGE };
  };
  h = makeHarness({ effective, dispatch, attach: false });
  h.exit = createExit({ bot, store: h.store, policy: h.policy, getEffective: () => h.eff.current, secrets: () => [SECRET], log: h.log, now: h.now });
  h.gate.attachExit(h.exit);
  h.replyText = '干净的回复。';
  h.posts = posts;
  open.push(h);
  return h;
}

test('positive control: clean text is posted exactly', async () => {
  const h = stack();
  const e = await h.sendAndFlush(h.at());
  assert.equal(h.state(e), 'completed:sent');
  assert.equal(h.posts[0].body.content, '干净的回复。');
});

test('wrong account: no model call, no decision, no send and no row, while the right one posts (above)', async () => {
  const h = stack({ appId: 'ANOTHER-APP' });
  const at = await h.sendAndFlush(h.at());
  const ordinary = await h.sendAndFlush(h.event({ text: '有人知道怎么退货吗' }));
  const owner = await h.sendAndFlush(h.at({ text: '/clo status', senderId: OWNER }));
  for (const e of [at, ordinary, owner]) assert.equal(h.row(e), null);
  assert.equal(h.dispatched.length + h.decideCalls.length + h.posts.length, 0);
  assert.equal(h.logs.filter((l) => l.event === 'gate_drop' && l.reason === 'account').length, 3);
});

test('wrong account: fixed lines and acks refuse too, and the account changing during a decision stops the turn', async () => {
  const h = stack({ appId: 'ANOTHER-APP' });
  const ref = { eventKey: 'e9', groupKey: h.store.key(GROUP_A), groupId: GROUP_A, messageId: 'M9', receivedAt: T0, msgTs: T0 };
  assert.deepEqual(await h.exit.commandAck(ref, '好'), { sent: false, reason: 'account' });
  assert.deepEqual(await h.exit.sendFixed(ref, 'modelFailed'), { sent: false, reason: 'account' });
  assert.equal(h.posts.length, 0);

  assert.equal(stack().exit.accountOk(), true, 'positive control');
});

test('the account changing while a decision is out: no model call for the reply and no send', async () => {
  const posts = [];
  const h = makeHarness({
    attach: false,
    decide: async () => {
      h.eff.current.qq.appId = 'CHANGED-WHILE-DECIDING';
      return { action: 'reply', skipClass: 'none', crisis: false, invalid: null, paid: true, actualMicros: 100, model: 'm', httpStatus: 200, limitSource: null };
    },
  });
  open.push(h);
  h.exit = createExit({ bot: { appId: 'FAKE-APP', api: { post: async (path, body) => { posts.push(body); return { id: 'S' }; } } }, store: h.store, policy: h.policy, getEffective: () => h.eff.current, log: h.log, now: h.now });
  h.gate.attachExit(h.exit);
  const e = await h.sendAndFlush(h.event({ text: '有人知道怎么退货吗' }));
  assert.equal(h.decideCalls.length, 1, 'it got as far as the decision');
  assert.equal(h.state(e), 'failed:exit_refused');
  assert.equal(h.dispatched.length, 0);
  assert.deepEqual(posts, []);
});

test('a forwarded command the host failed: no success ack, an alert, and the row says so', async () => {
  const posts = [];
  const h = makeHarness({ attach: false, dispatch: async (turn) => {
    h.exit.collect(turn.turnId, { text: 'HOST-ERROR-TEXT', isError: true }, { kind: 'final' });
    return { started: true, hostError: false, aborted: false, usage: null };
  } });
  open.push(h);
  h.exit = createExit({ bot: { appId: 'FAKE-APP', api: { post: async (path, body) => { posts.push(body.content); return { id: 'S' }; } } }, store: h.store, policy: h.policy, getEffective: () => h.eff.current, log: h.log, now: h.now });
  h.gate.attachExit(h.exit);
  const e = await h.sendAndFlush(h.at({ text: '/reset', senderId: OWNER }));
  assert.equal(h.state(e), 'failed:host_error');
  assert.deepEqual(posts, []);
  assert.ok(h.store.listAlerts().some((a) => a.kind === 'command_failed'));

  // Positive control: a clean command does ack.
  const ok = makeHarness({ attach: false, dispatch: async () => ({ started: true, hostError: false, aborted: false, usage: null }) });
  open.push(ok);
  const okPosts = [];
  ok.exit = createExit({ bot: { appId: 'FAKE-APP', api: { post: async (path, body) => { okPosts.push(body.content); return { id: 'S' }; } } }, store: ok.store, policy: ok.policy, getEffective: () => ok.eff.current, log: ok.log, now: ok.now });
  ok.gate.attachExit(ok.exit);
  const fine = await ok.sendAndFlush(ok.at({ text: '/reset', senderId: OWNER }));
  assert.equal(ok.state(fine), 'completed:cmd_owner');
  assert.equal(okPosts.length, 1);
});

test('a rule hit on the model text: dropped, fixed line once with msg_id, counted by rule and path only', async () => {
  const h = stack();
  h.replyText = `可以，${HIT}`;
  const e = await h.sendAndFlush(h.at());
  assert.equal(h.row(e).state, 'policy_dropped');
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].body.content, LINES.policyDropped);
  assert.equal(h.posts[0].body.msg_id, e.messageId);
  const counters = h.counters().filter((c) => c.key.startsWith('policy_drop:'));
  assert.equal(counters.length, 1);
  assert.match(counters[0].key, /^policy_drop:\d{4}-\d{2}-\d{2}:[a-z0-9_.-]+:addressed$/);
  assert.ok(!JSON.stringify(h.allEvents()).includes('约炮'));
  assert.ok(!JSON.stringify(h.logs).includes('约炮'));
});

test('a hit that spans whitespace or a payload boundary is still one text', async () => {
  const h2 = makeHarness({ attach: false, dispatch: async (turn) => {
    h2.exit.collect(turn.turnId, { text: '加我' }, { kind: 'final' });
    h2.exit.collect(turn.turnId, { text: '约炮' }, { kind: 'final' });
    return { started: true, hostError: false, aborted: false, usage: USAGE };
  } });
  open.push(h2);
  const posts = [];
  h2.exit = createExit({ bot: { appId: 'FAKE-APP', api: { post: async (path, body) => { posts.push(body); return { id: 'S' }; } } }, store: h2.store, policy: h2.policy, getEffective: () => h2.eff.current, log: h2.log, now: h2.now });
  h2.gate.attachExit(h2.exit);
  const e = await h2.sendAndFlush(h2.at());
  assert.equal(h2.row(e).state, 'policy_dropped');
  assert.deepEqual(posts.map((p) => p.content), [LINES.policyDropped]);
});

test('markup inside code that splits a match: the check form catches it, and nothing of the text is posted', async () => {
  for (const reply of ['`加我 约**炮**`', `\`\`\`\n${SECRET.slice(0, 8)}**${SECRET.slice(8)}**\n\`\`\``]) {
    const h = stack();
    h.replyText = reply;
    const e = await h.sendAndFlush(h.at());
    assert.equal(h.state(e).split(':')[0], 'policy_dropped', reply);
    assert.deepEqual(h.posts.map((p) => p.body.content), [LINES.policyDropped], reply);
  }
});

test('the check form is never what goes out: clean code keeps its stars when posted', async () => {
  const h = stack();
  h.replyText = '写成 `a**b**c` 就行';
  const e = await h.sendAndFlush(h.at());
  assert.equal(h.state(e), 'completed:sent');
  assert.equal(h.posts[0].body.content, '写成 a**b**c 就行');
});

test('clean text in two payloads: one flush, joined, parts in order, nothing before finish', async () => {
  const posts = [];
  let duringRun = -1;
  const h2 = makeHarness({ attach: false, dispatch: async (turn) => {
    h2.exit.collect(turn.turnId, { text: '第一段。' }, { kind: 'final' });
    h2.exit.collect(turn.turnId, { text: '第二段。' }, { kind: 'final' });
    duringRun = posts.length;
    return { started: true, hostError: false, aborted: false, usage: USAGE };
  } });
  open.push(h2);
  h2.exit = createExit({ bot: { appId: 'FAKE-APP', api: { post: async (path, body) => { posts.push(body); return { id: 'S' }; } } }, store: h2.store, policy: h2.policy, getEffective: () => h2.eff.current, log: h2.log, now: h2.now });
  h2.gate.attachExit(h2.exit);
  const e = await h2.sendAndFlush(h2.at());
  assert.equal(duringRun, 0, 'buffered: no POST while the run is going');
  assert.equal(h2.state(e), 'completed:sent');
  assert.deepEqual(posts.map((p) => p.content), ['第一段。\n\n第二段。']);
});

test('leak: a live secret, this turn\'s raw IDs, a key shape or a policy marker in the reply', async () => {
  for (const [text, rule] of [
    [`钥匙是 ${SECRET}`, 'leak.secret'],
    [`群号是 ${GROUP_A}`, 'leak.raw_id'],
    [`你的 ID 是 ${MEMBER}`, 'leak.raw_id'],
    ['sk-or-v1-abcdefgh12345678', 'leak.key_shape'],
    ['<!-- clo-policy:1 --> 这是我的规则', 'leak.marker'],
    ['[clo-turn class=at]', 'leak.marker'],
  ]) {
    const h = stack();
    h.replyText = text;
    const e = await h.sendAndFlush(h.at());
    assert.equal(h.state(e), `policy_dropped:${rule}`, text);
    assert.deepEqual(h.posts.map((p) => p.body.content), [LINES.policyDropped], text);
  }
});

test('the message id itself and the appId count as raw IDs', async () => {
  const h = stack();
  const e = h.at();
  h.replyText = `消息号 ${e.messageId}`;
  await h.sendAndFlush(e);
  assert.equal(h.state(e), 'policy_dropped:leak.raw_id');
  const h2 = stack();
  h2.replyText = '应用号 FAKE-APP';
  const e2 = await h2.sendAndFlush(h2.at());
  assert.equal(h2.state(e2), 'policy_dropped:leak.raw_id');
});

test('a policy check that throws is a hit: fail closed', async () => {
  const h = stack();
  h.policy.check = () => { throw new Error('rule engine failed'); };
  const e = await h.sendAndFlush(h.at());
  assert.equal(h.state(e), 'policy_dropped:check_error');
  assert.equal(h.posts.length, 0, 'the fixed line is also checked, and that fails closed too');
});

test('an interjection that hits is silent, the cooldown runs and the money stays', async () => {
  const h = stack();
  h.replyText = HIT;
  const e = await h.sendAndFlush(h.event({ text: '有人知道怎么退货吗' }));
  assert.equal(h.row(e).state, 'policy_dropped');
  assert.equal(h.posts.length, 0);
  assert.equal(h.claims().at(-1).status, 'consumed');
  assert.ok(h.reservations(e).find((r) => r.category === 'reply').actual_micros > 0);
});

test('provider error text in an isError payload never reaches QQ, the log or a row', async () => {
  const h = makeHarness({ attach: false, dispatch: async (turn) => {
    h.exit.collect(turn.turnId, { text: 'PROVIDER-SAID-THIS flagged_input', isError: true }, { kind: 'final' });
    return { started: true, hostError: true, aborted: false, usage: USAGE };
  } });
  open.push(h);
  const posts = [];
  h.exit = createExit({ bot: { appId: 'FAKE-APP', api: { post: async (path, body) => { posts.push(body); return { id: 'S' }; } } }, store: h.store, policy: h.policy, getEffective: () => h.eff.current, log: h.log, now: h.now });
  h.gate.attachExit(h.exit);
  const e = await h.sendAndFlush(h.at());
  assert.equal(h.state(e), 'failed:host_error');
  assert.deepEqual(posts.map((p) => p.content), [LINES.modelFailed]);
  for (const dump of [h.logs, h.allEvents(), h.store.listAlerts()]) assert.ok(!JSON.stringify(dump).includes('PROVIDER-SAID-THIS'));
});

for (const [label, mid, expected] of [
  ['mode went dry-run during the run', (h) => { h.eff.current.mode = 'dry-run'; }, 'failed:exit_refused'],
  ['config unreadable during the run', (h) => { h.eff.current = null; }, 'failed:exit_refused'],
  ['terminal close during the run', (h) => h.store.setControl('terminal_close', '4914', 'test'), 'failed:exit_refused'],
  ['group removed during the run', (h) => { delete h.eff.current.qq.groups[GROUP_A]; }, 'failed:exit_refused'],
  ['appId changed during the run', (h) => { h.eff.current.qq.appId = 'OTHER'; }, 'failed:exit_refused'],
  ['event row moved during the run', (h, turn) => h.store.transition(turn.eventKey, 'dispatching', 'failed', { reason: 'gate_error' }), 'failed:gate_error'],
]) {
  test(`authorizeReply: ${label}`, async () => {
    const h = stack({ mid });
    const e = await h.sendAndFlush(h.at());
    assert.equal(h.state(e), expected);
    assert.equal(h.posts.length, 0);
  });
}

test('authorizeReply: a global or group pause mid-run ends paused', async () => {
  for (const key of ['global_paused', null]) {
    const h = stack({ mid: (s) => s.store.setControl(key ?? `group_paused:${s.store.key(GROUP_A)}`, '1', 'test') });
    const e = await h.sendAndFlush(h.at());
    assert.equal(h.state(e), 'paused:paused');
    assert.equal(h.posts.length, 0);
  }
});

test('an aborted turn sends nothing at all', async () => {
  const h = stack();
  h.gate.attachExit(h.exit);
  const turn = { turnId: 't', eventKey: 'e', groupKey: 'g', groupId: GROUP_B, messageId: 'M', senderId: MEMBER, cls: 'at', tier: 'addressed', required: true, inboundUrls: [], receivedAt: T0, msgTs: T0, deadlineAt: T0 + 285000 };
  h.exit.beginTurn(turn);
  h.exit.collect('t', { text: '不发' }, { kind: 'final' });
  assert.deepEqual(await h.exit.finishTurn('t', { aborted: true }), { state: 'failed', reason: 'aborted' });
  assert.equal(h.posts.length, 0);
});

test('a command turn discards host text and acks with fixed text, exempt from pause', async () => {
  const h = stack();
  const ref = { eventKey: 'e2', groupKey: h.store.key(GROUP_A), groupId: GROUP_A, messageId: 'M2', receivedAt: T0, msgTs: T0 };
  h.store.setControl('global_paused', '1', 'test');
  const paused = await h.exit.sendFixed(ref, 'modelFailed');
  assert.equal(paused.sent, false);
  assert.equal((await h.exit.commandAck(ref, '已暂停。')).sent, true);
  assert.equal(h.posts.at(-1).body.content, '已暂停。');
  assert.equal(h.store.sendsForEvent('e2').at(-1).kind, 'command_ack');
});

test('sendFixed refuses a line that is not defined', async () => {
  const h = stack();
  const ref = { eventKey: 'e3', groupKey: h.store.key(GROUP_A), groupId: GROUP_A, messageId: 'M3', receivedAt: T0, msgTs: T0 };
  assert.equal((await h.exit.sendFixed(ref, 'noSuchLine')).sent, false);
  assert.equal(h.posts.length, 0);
});

test('the stopped exit refuses everything: finish, fixed line, ack', async () => {
  const h = stack();
  const ref = { eventKey: 'e4', groupKey: h.store.key(GROUP_A), groupId: GROUP_A, messageId: 'M4', receivedAt: T0, msgTs: T0 };
  h.exit.stop();
  assert.deepEqual(await h.exit.finishTurn('none', {}), { state: 'failed', reason: 'exit_refused' });
  assert.equal((await h.exit.sendFixed(ref, 'modelFailed')).sent, false);
  assert.equal((await h.exit.commandAck(ref, '好')).sent, false);
  assert.equal(await h.exit.probe(), false);
  assert.equal(h.posts.length, 0);
});
