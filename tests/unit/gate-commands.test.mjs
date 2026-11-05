// G4 and design section 5.4. Admin rights are checked by stable ID, separately from chat rights.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandRoute, forwardAck, parseCommand } from '../../src/clo-plugin/lib/core/commands.js';
import { deferred, makeEffective, makeHarness, MEMBER, OWNER, USAGE } from '../fixtures/inbound.mjs';

const cmd = (h, text, senderId = OWNER) => h.event({ text, senderId, isRealAt: true });

test('parseCommand: prefix after normalize, names, args, standalone', () => {
  assert.equal(parseCommand('你好'), null);
  assert.equal(parseCommand('帮我 /reset 一下'), null);
  assert.equal(parseCommand(''), null);
  assert.equal(parseCommand(null), null);
  assert.equal(parseCommand('stop'), null);
  assert.equal(parseCommand('停止'), null);
  assert.deepEqual(parseCommand('/status'), { name: 'status', args: [], standalone: true });
  assert.deepEqual(parseCommand('／STATUS'), { name: 'status', args: [], standalone: true });
  assert.deepEqual(parseCommand('​/new'), { name: 'new', args: [], standalone: true });
  assert.deepEqual(parseCommand(' /clo　pause  all'), { name: 'clo', args: ['pause', 'all'], standalone: false });
  assert.deepEqual(parseCommand('/reset now'), { name: 'reset', args: ['now'], standalone: false });
  assert.deepEqual(parseCommand('/model x'), { name: 'other', args: ['x'], standalone: false });
  assert.equal(parseCommand('/').name, 'other');
  assert.equal(parseCommand('/ status').name, 'other');
  assert.equal(parseCommand('/new@bot').name, 'other');
});

test('commandRoute: only the listed shapes do anything', () => {
  const route = (t) => commandRoute(parseCommand(t));
  for (const t of ['/status', '/clo status', '/clo pause', '/clo pause all', '/clo resume', '/clo resume all', '/clo resume interject', '/CLO PAUSE']) assert.equal(route(t), 'local', t);
  for (const t of ['/new', '/reset', '/stop']) assert.equal(route(t), 'forward', t);
  for (const t of ['/new x', '/reset x', '/stop x', '/status x', '/clo', '/clo model set x', '/clo status x', '/clo pause foo', '/clo pause all x', '/clo resume foo', '/model', '/think', '/help']) assert.equal(route(t), 'unknown', t);
});

test('a non-owner running any command is ignored: no effect, no reply, not buffered', async () => {
  const h = makeHarness();
  const texts = ['/status', '/clo status', '/clo pause', '/clo pause all', '/clo resume interject', '/new', '/reset', '/stop', '/help', '/model x', '／clo pause', '​/clo pause'];
  const before = h.control();
  for (const t of texts) {
    const e = await h.send(cmd(h, t, MEMBER));
    assert.equal(h.state(e), 'ignored:cmd_non_owner', t);
  }
  await h.gate.idle();
  assert.deepEqual(h.control().filter((c) => c.key !== 'last_event_at'), before.filter((c) => c.key !== 'last_event_at'));
  assert.equal(h.dispatched.length, 0);
  assert.equal(h.exit.acks.length, 0);

  const ok = await h.sendAndFlush(h.at({ text: '现在问问题' }));
  assert.equal(h.state(ok), 'completed:sent', 'positive control: not paused');
  assert.deepEqual(h.dispatched[0].history, [], 'none of the commands entered context');
  await h.close();
});

test('a non-owner can still chat', async () => {
  const h = makeHarness();
  await h.sendAndFlush(h.at({ senderId: MEMBER }));
  assert.equal(h.dispatched.length, 1);
  assert.equal(h.dispatched[0].authorizedCommand, null);
  await h.close();
});

test('owner /status and /clo status: fixed one line, local only, no figures', async () => {
  const h = makeHarness();
  for (const t of ['/status', '/clo status']) {
    const e = await h.send(cmd(h, t));
    assert.equal(h.state(e), 'completed:cmd_owner');
  }
  assert.equal(h.dispatched.length, 0, 'never reaches the host');
  assert.equal(h.exit.acks.length, 2);
  for (const { ackText } of h.exit.acks) {
    assert.equal(ackText, '模式：正常运行。本群：未暂停。');
    assert.doesNotMatch(ackText, /\d|\$|token|agent:|session|opus|haiku|usd/i);
    assert.equal(h.policy.check(ackText).hit, false);
  }
  await h.close();
});

test('every fixed ack passes the content rules', () => {
  const h = makeHarness();
  for (const c of ['/new', '/reset', '/stop']) {
    assert.ok(forwardAck(c));
    assert.equal(h.policy.check(forwardAck(c)).hit, false);
  }
  return h.close();
});

test('pause and resume: this group, then everything, and an owner can always resume', async () => {
  const h = makeHarness();
  await h.send(cmd(h, '/clo pause'));
  assert.equal(h.exit.acks.at(-1).ackText, '本群已暂停。');
  const blocked = await h.sendAndFlush(h.at());
  assert.equal(h.state(blocked), 'paused:paused');
  assert.equal(h.dispatched.length, 0);
  assert.equal(h.exit.fixed.length, 0, 'a pause sends no fixed line');

  await h.send(cmd(h, '/status'));
  assert.equal(h.exit.acks.at(-1).ackText, '模式：正常运行。本群：已暂停。');

  await h.send(cmd(h, '/clo resume'));
  assert.equal(h.exit.acks.at(-1).ackText, '本群已恢复。');
  await h.sendAndFlush(h.at());
  assert.equal(h.dispatched.length, 1);

  await h.send(cmd(h, '/clo pause all'));
  assert.equal(h.store.pauseState('anything').global, true);
  const blocked2 = await h.sendAndFlush(h.at());
  assert.equal(h.state(blocked2), 'paused:paused');
  await h.send(cmd(h, '/clo resume all'));
  assert.equal(h.store.pauseState('anything').global, false);
  await h.sendAndFlush(h.at());
  assert.equal(h.dispatched.length, 2);
  await h.close();
});

test('/clo resume interject clears the latch and nothing else', async () => {
  const h = makeHarness();
  h.store.setControl('interject_paused', '1', 'test');
  await h.send(cmd(h, '/clo pause'));
  await h.send(cmd(h, '/clo resume interject'));
  assert.equal(h.store.getControl('interject_paused'), null);
  assert.equal(h.exit.acks.at(-1).ackText, '已恢复插话。');
  const e = await h.sendAndFlush(h.at());
  assert.equal(h.state(e), 'paused:paused', 'the group pause is still on');
  await h.close();
});

test('unknown owner commands: ignored, no reply, never reach the host', async () => {
  const h = makeHarness();
  for (const t of ['/clo model set x', '/clo', '/clo pause foo', '/new now', '/reset me', '/stop it', '/status x', '/model x', '/think hard', '/help']) {
    const e = await h.send(cmd(h, t));
    assert.equal(h.state(e), 'ignored:cmd_unknown', t);
  }
  assert.equal(h.dispatched.length, 0);
  assert.equal(h.exit.acks.length, 0);
  await h.close();
});

test('/new and /reset are forwarded as authorized commands: tier none, no hold, fixed ack text', async () => {
  const h = makeHarness();
  for (const [t, ack] of [['/new', '已开始新的对话。'], ['/reset', '已重置本群对话。']]) {
    const e = await h.send(cmd(h, t));
    const turn = h.dispatched.at(-1);
    assert.equal(turn.cls, 'command');
    assert.equal(turn.tier, 'none');
    assert.equal(turn.authorizedCommand, t);
    assert.equal(turn.text, t);
    assert.equal(turn.ackText, ack);
    assert.deepEqual(turn.history, []);
    assert.equal(turn.replyReservationId, null);
    assert.equal(h.exit.begun.at(-1), turn);
    assert.equal(h.reservations(e).filter((r) => r.status === 'held').length, 0);
    assert.equal(h.row(e).cls, 'command');
  }
  await h.close();
});

test('usage from a command turn is counted as unattributed, never lost', async () => {
  const h = makeHarness();
  const e = await h.send(cmd(h, '/new'));
  const rows = h.reservations(e);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tier, 'none');
  assert.equal(rows[0].category, 'unattributed');
  assert.equal(rows[0].actual_micros, Math.ceil(USAGE.costUsd * 1e6));
  await h.close();
});

test('/stop bypasses the queue and aborts the in-flight turn, which sends no fixed line', async () => {
  const hold = deferred();
  let first = true;
  const h = makeHarness({
    dispatch: async () => {
      if (!first) return { started: true, hostError: false, aborted: false, usage: null };
      first = false;
      await hold.promise;
      return { started: true, hostError: false, aborted: false, usage: USAGE };
    },
  });
  const talk = await h.send(h.at({ text: '讲个长故事' }));
  const queued = await h.send(h.at({ text: '排队的问题' }));
  await new Promise((r) => setImmediate(r));
  assert.equal(h.dispatched.length, 1);
  assert.equal(h.state(queued), 'queued');

  const stop = await h.send(cmd(h, '/stop'));
  assert.equal(h.dispatched.length, 2, 'it ran while the lane was busy');
  assert.equal(h.dispatched[1].authorizedCommand, '/stop');
  assert.equal(h.state(stop), 'completed:sent');

  hold.resolve();
  await h.gate.idle();
  assert.equal(h.state(talk), 'failed:aborted');
  assert.equal(h.exit.fixed.length, 0);
  assert.equal(h.exit.finished[1].aborted, true, 'the exit was told');
  assert.equal(h.reservations(talk)[0].status, 'settled', 'the money was still spent');
  assert.equal(h.state(queued), 'skipped:owner_stop', 'older than the stop, so the real host would refuse it: see fix2-stop.test.mjs');
  await h.close();
});

test('a /stop arriving while the reply is being sent does not relabel it', async () => {
  const posting = deferred();
  const h = makeHarness();
  const realFinish = h.exit.finishTurn;
  let calls = 0;
  h.exit.finishTurn = async (id, flags) => {
    calls += 1;
    if (calls === 1) await posting.promise;
    return realFinish(id, flags);
  };
  const e = await h.send(h.at());
  await new Promise((r) => setImmediate(r));
  await h.send(cmd(h, '/stop'));
  posting.resolve();
  await h.gate.idle();
  assert.equal(h.state(e), 'completed:sent');
  await h.close();
});

test('dry-run: every owner command is would_cmd, with no effect and nothing sent', async () => {
  const h = makeHarness({ effective: makeEffective({ mode: 'dry-run' }) });
  for (const t of ['/status', '/clo pause', '/new', '/stop', '/help']) {
    const e = await h.send(cmd(h, t));
    assert.equal(h.state(e), 'dry_run:would_cmd', t);
  }
  const member = await h.send(cmd(h, '/clo pause', MEMBER));
  assert.equal(h.state(member), 'ignored:cmd_non_owner');
  assert.equal(h.store.getControl(`group_paused:${h.row(member).group_key}`), null);
  assert.equal(h.dispatched.length, 0);
  assert.equal(h.exit.acks.length, 0);
  await h.close();
});

test('mid-text commands and bare stop words are plain text, from anyone', async () => {
  const h = makeHarness();
  for (const senderId of [MEMBER, OWNER]) {
    for (const text of ['帮我 /reset 一下', '用 /model 换一下', '/think 不是这样 这句不是命令'.slice(7), 'stop', '停止']) {
      await h.sendAndFlush(h.at({ text, senderId }));
      const t = h.dispatched.at(-1);
      assert.equal(t.cls, 'at', text);
      assert.equal(t.authorizedCommand, null, text);
    }
  }
  assert.equal(h.exit.finished.every((f) => f.aborted === false), true);
  await h.close();
});

test('the owner check is exact case', async () => {
  const h = makeHarness();
  const e = await h.send(cmd(h, '/clo pause', OWNER.toLowerCase()));
  assert.equal(h.state(e), 'ignored:cmd_non_owner');
  await h.close();
});

test('a command with no exit attached fails closed before any effect', async () => {
  const h = makeHarness({ attach: false });
  const e = await h.send(cmd(h, '/clo pause'));
  assert.equal(h.state(e), 'failed:exit_refused');
  assert.equal(h.store.getControl(`group_paused:${h.row(e).group_key}`), null);
  await h.close();
});
