// The gate, exit, ledger and context under runtime 'own': the gate's abort signal, /stop handled in the gate, her sent
// replies in the group's memory ring, and only listed owner commands as commands. Each case runs the 'openclaw' path
// beside it as the control, which must stay as it was. Real gate, store, ledger, policy and exit; the model run and the
// QQ API are fakes written here. No network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import { ApiError } from '@tencent-connect/qqbot-nodejs';
import { createExit } from '../../src/clo-plugin/lib/channels/qq/exit.js';
import { OWN_IDLE_MS } from '../../src/clo-plugin/lib/core/context.js';
import { createGate } from '../../src/clo-plugin/lib/core/gate.js';
import { createLedger } from '../../src/clo-plugin/lib/core/ledger.js';
import { openStore } from '../../src/clo-plugin/lib/core/store.js';
import { atEvent, decisionOf, deferred, inbound, loadRealPolicy, makeEffective, MEMBER, MEMBER2, OWNER, ROOT, T0, USAGE } from '../fixtures/inbound.mjs';

const LINES = JSON.parse(readFileSync(join(ROOT, 'persona', 'policy-lines.zh.json'), 'utf8'));
const REPLY = '这是一条普通的回复。';
const CRISIS = '我真的不想活了';
const HIT = '加我 约炮';
const tick = () => new Promise((r) => setImmediate(r));
const until = async (cond) => {
  for (let i = 0; i < 2000 && !cond(); i += 1) await tick();
  assert.ok(cond(), 'the expected state was never reached');
};

// Stores are closed here, before their folder goes: Windows keeps an open file from being removed.
const open = [];
const dir = mkdtempSync(join(tmpdir(), 'clo-own-'));
let dbCount = 0;
after(async () => {
  for (const h of open) await h.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// h.run(turn, signal, h) stands in for a model run: the default hands over REPLY and reports USAGE.
// runtime is what the process is built as (null: nothing passed, so the default). fileRuntime is what effective.json
// says, the same unless a test sets it (null: the file names none).
function stack({ runtime = 'own', fileRuntime = runtime, effective = {}, run } = {}) {
  const clock = { t: T0 };
  const now = () => clock.t;
  const pinned = runtime === null ? {} : { runtime };
  const eff = { current: makeEffective({ ...(fileRuntime === null ? {} : { runtime: fileRuntime }), ...effective }) };
  if (fileRuntime === null) delete eff.current.runtime;
  const getEffective = () => eff.current;
  let timerId = 0;
  const timerList = new Map();
  const timers = {
    setTimer(fn, ms) {
      timerId += 1;
      timerList.set(timerId, { at: clock.t + ms, fn });
      return timerId;
    },
    clearTimer(id) {
      timerList.delete(id);
    },
  };
  const store = openStore(join(dir, `own${++dbCount}.db`),{ runGen: 'gen-1', now });
  const logs = [];
  const log = (event, data) => logs.push({ event, ...data });
  const ledger = createLedger({ store, getEffective, fetch: async () => { throw new Error('no network in this test'); }, getKey: () => 'FAKE-KEY', now, log, ...pinned });
  const policy = loadRealPolicy();
  const posts = [];
  const results = [];
  const bot = {
    appId: 'FAKE-APP',
    api: {
      post: async (path, body) => {
        posts.push({ path, body });
        const r = results.shift();
        if (r instanceof Error) throw r;
        return r ?? { id: `S${posts.length}` };
      },
    },
  };
  const exit = createExit({ bot, store, policy, getEffective, secrets: [], log, now, sleep: async (ms) => { clock.t += ms; }, ...pinned });
  const h = {
    clock, now, eff, store, ledger, policy, exit, logs, posts, results,
    runs: [],
    replyText: REPLY,
    usage: USAGE,
  };
  h.run = run ?? (async (turn) => {
    if (h.replyText !== null) h.exit.collect(turn.turnId, { text: h.replyText }, { kind: 'final' });
    return { started: true, hostError: false, aborted: false, usage: h.usage };
  });
  h.gate = createGate({
    store, ledger, policy, getEffective, log, now, timers, ...pinned,
    decide: async () => decisionOf(),
    dispatchTurn: async (turn, opts) => {
      h.runs.push({ turn, signal: opts?.signal ?? null });
      return h.run(turn, opts?.signal ?? null, h);
    },
  });
  h.gate.attachExit(exit);
  Object.assign(h, {
    advance(ms) {
      const target = clock.t + ms;
      for (;;) {
        const due = [...timerList.entries()].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timerList.delete(due[0]);
        clock.t = Math.max(clock.t, due[1].at);
        due[1].fn();
      }
      clock.t = target;
    },
    later(ms = 1000) {
      clock.t += ms;
    },
    async send(evt) {
      await h.gate.onInbound(evt);
      return evt;
    },
    // Far enough apart that the per-group send rate is not what a test is about.
    async ask(over = {}) {
      h.later(20000);
      const e = await h.send(atEvent(over, clock.t));
      await h.gate.idle();
      return e;
    },
    event: (over) => inbound(over, clock.t),
    at: (over) => atEvent(over, clock.t),
    state: (evt) => {
      const r = store.getEvent(store.key(evt.messageId));
      return r ? `${r.state}${r.reason ? `:${r.reason}` : ''}` : null;
    },
    postedTo: (evt) => posts.filter((p) => p.body.msg_id === evt.messageId).map((p) => p.body.content),
    reservations: (evt) => store.q('SELECT * FROM reservations WHERE event_key=? ORDER BY created_at, category').all(store.key(evt.messageId)),
    alertKinds: () => store.listAlerts().map((a) => a.kind),
    pausedBy: () => store.getControl('paid_paused'),
    historyOf: (i) => h.runs[i].turn.history,
    ownLines: (i) => h.runs[i].turn.history.filter((l) => l.own === true),
    async close() {
      await h.gate.stop();
      exit.stop();
      store.close();
    },
  });
  open.push(h);
  return h;
}

// A run that waits for its signal, the way a well-behaved runner does, and reports the abort.
const waitsForAbort = (h) => async (turn, signal) => {
  h.waiting = (h.waiting ?? 0) + 1;
  await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  return { started: true, hostError: false, aborted: true, usage: null };
};

// ---- the signal ----

test('own: every turn gets an AbortSignal, and /stop aborts the running one with owner_stop', async () => {
  const h = stack();
  h.run = waitsForAbort(h);
  h.later();
  const a = await h.send(h.at({ text: '讲个长故事', senderId: MEMBER }));
  await until(() => h.waiting === 1);
  const { signal } = h.runs[0];
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false, 'positive control: not aborted before /stop');
  h.later();
  const stop = await h.send(h.at({ text: '/stop', senderId: OWNER }));
  await h.gate.idle();
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason.name, 'AbortError');
  assert.equal(signal.reason.message, 'owner_stop');
  assert.equal(h.state(a), 'failed:aborted');
  assert.equal(h.state(stop), 'completed:cmd_owner');
  assert.deepEqual(h.postedTo(stop), ['已停止当前回复。']);
  assert.deepEqual(h.postedTo(a), [], 'an ordinary turn stays quiet after /stop');
  assert.equal(h.runs.length, 1, '/stop itself is never sent to a model');
  assert.deepEqual(h.reservations(a).map((r) => r.status), ['unsettled']);
  assert.equal(h.pausedBy(), null, 'one /stop pauses nothing');
});

test('openclaw: the signal is passed but /stop leaves it to the host, which still gets the command turn', async () => {
  const h = stack({ runtime: null });
  const release = deferred();
  h.run = async (turn) => {
    if (turn.authorizedCommand === '/stop') return { started: true, hostError: false, aborted: false, usage: null };
    await release.promise;
    return { started: true, hostError: false, aborted: false, usage: USAGE };
  };
  h.later();
  const a = await h.send(h.at({ text: '讲个长故事', senderId: MEMBER }));
  await until(() => h.runs.length === 1);
  h.later();
  await h.send(h.at({ text: '/stop', senderId: OWNER }));
  await until(() => h.runs.length === 2);
  assert.equal(h.runs[1].turn.authorizedCommand, '/stop', 'the host path forwards /stop as before');
  assert.equal(h.runs[0].signal.aborted, false);
  release.resolve();
  await h.gate.idle();
  assert.equal(h.state(a), 'failed:aborted', 'the gate still marks the turn stopped');
});

test('own: /stop aborts a running turn for a person in danger with nothing out, and the failure line goes out once', async () => {
  const h = stack();
  h.run = waitsForAbort(h);
  h.later();
  const a = await h.send(h.at({ text: CRISIS, senderId: MEMBER }));
  await until(() => h.waiting === 1);
  h.later();
  await h.send(h.at({ text: '/stop', senderId: OWNER }));
  await h.gate.idle();
  assert.equal(h.runs[0].signal.aborted, true);
  assert.deepEqual(h.postedTo(a), [LINES.modelFailed]);
  const alert = h.store.listAlerts().find((x) => x.kind === 'crisis_refused');
  assert.ok(alert, 'the operator hears');
  assert.match(JSON.stringify(alert), /owner_stop/);
  assert.match(JSON.stringify(alert), /line_sent/);
});

test('own: a reply for a person in danger already handed over is not aborted by /stop, and goes out', async () => {
  const h = stack();
  const hold = deferred();
  h.run = async (turn) => {
    h.exit.collect(turn.turnId, { text: REPLY }, { kind: 'final' });
    h.handedOver = true;
    await hold.promise;
    return { started: true, hostError: false, aborted: false, usage: USAGE };
  };
  h.later();
  const a = await h.send(h.at({ text: CRISIS, senderId: MEMBER }));
  await until(() => h.handedOver === true);
  h.later();
  await h.send(h.at({ text: '/stop', senderId: OWNER }));
  assert.equal(h.runs[0].signal.aborted, false, 'kept for the person in danger');
  hold.resolve();
  await h.gate.idle();
  assert.deepEqual(h.postedTo(a), [REPLY]);
  assert.equal(h.state(a), 'completed:sent');

  // Control in the same run: the same timing for an ordinary @ is aborted and stays quiet.
  const hold2 = deferred();
  h.handedOver = false;
  h.run = async (turn, signal) => {
    h.exit.collect(turn.turnId, { text: REPLY }, { kind: 'final' });
    h.handedOver = true;
    await hold2.promise;
    return { started: true, hostError: false, aborted: signal.aborted, usage: USAGE };
  };
  h.later(5000);
  const b = await h.send(h.at({ text: '普通的问题', senderId: MEMBER2 }));
  await until(() => h.handedOver === true);
  h.later();
  await h.send(h.at({ text: '/stop', senderId: OWNER }));
  assert.equal(h.runs[1].signal.aborted, true);
  hold2.resolve();
  await h.gate.idle();
  assert.deepEqual(h.postedTo(b), []);
  assert.equal(h.state(b), 'failed:aborted');
});

test('own: gate.stop aborts the running turn with shutdown', async () => {
  const h = stack();
  h.run = waitsForAbort(h);
  h.later();
  await h.send(h.at({ text: '讲个长故事' }));
  await until(() => h.waiting === 1);
  assert.equal(h.runs[0].signal.aborted, false);
  await h.gate.stop();
  assert.equal(h.runs[0].signal.aborted, true);
  assert.equal(h.runs[0].signal.reason.message, 'shutdown');
});

test('own: the deadline aborts the run; one that ignores it is left after the grace, unsettled, and its late text never posts', async () => {
  const h = stack();
  const late = deferred();
  h.run = async () => {
    h.waiting = 1;
    await late.promise;
    return { started: true, hostError: false, aborted: false, usage: USAGE };
  };
  h.later();
  const a = await h.send(h.at({ text: '一个慢问题' }));
  await until(() => h.waiting === 1);
  const turn = h.runs[0].turn;
  h.advance(turn.deadlineAt - h.now() - 1);
  assert.equal(h.runs[0].signal.aborted, false, 'positive control: not before the deadline');
  h.advance(1);
  assert.equal(h.runs[0].signal.aborted, true);
  assert.equal(h.runs[0].signal.reason.message, 'deadline');
  h.advance(5000);
  await h.gate.idle();
  assert.equal(h.state(a), 'failed:aborted');
  assert.deepEqual(h.reservations(a).map((r) => r.status), ['unsettled']);
  assert.ok(h.logs.some((l) => l.event === 'turn_abandoned'));
  // The run ends late: its text finds the turn closed, and its usage still settles the hold.
  assert.deepEqual(h.exit.collect(turn.turnId, { text: REPLY }, { kind: 'final' }).visibleReplySent, false);
  late.resolve();
  await tick();
  await tick();
  assert.deepEqual(h.postedTo(a), []);
  assert.deepEqual(h.reservations(a).map((r) => r.status), ['settled']);
  assert.equal(h.reservations(a)[0].actual_micros, 10000);
});

test('openclaw: the gate arms no deadline of its own; the host keeps its watchdog', async () => {
  const h = stack({ runtime: 'openclaw' });
  const late = deferred();
  h.run = async () => {
    h.waiting = 1;
    await late.promise;
    return { started: true, hostError: false, aborted: true, usage: null };
  };
  h.later();
  await h.send(h.at({ text: '一个慢问题' }));
  await until(() => h.waiting === 1);
  h.advance(h.runs[0].turn.deadlineAt - h.now() + 10000);
  assert.equal(h.runs[0].signal.aborted, false);
  late.resolve();
  await h.gate.idle();
});

// ---- /stop and the same second ----

test('own: an @ in the same second as /stop is skipped by the gate, with no model call, no line and no hold', async () => {
  const h = stack();
  h.later();
  await h.send(h.at({ text: '/stop', senderId: OWNER }));
  await h.gate.idle();
  const same = await h.send(h.at({ text: '同一秒的问题', senderId: MEMBER }));
  await h.gate.idle();
  assert.equal(h.state(same), 'skipped:owner_stop');
  assert.equal(h.runs.length, 0);
  assert.deepEqual(h.postedTo(same), []);
  assert.equal(h.reservations(same).length, 0);

  const danger = await h.send(h.at({ text: CRISIS, senderId: MEMBER2 }));
  await h.gate.idle();
  assert.equal(h.state(danger), 'completed:sent', 'words of danger in the same second still go on');
  assert.deepEqual(h.postedTo(danger), [REPLY]);

  const next = await h.ask({ text: '下一秒的问题', senderId: MEMBER });
  assert.equal(h.state(next), 'completed:sent', 'the next second is past /stop');
});

test('openclaw: an @ in the same second as /stop still reaches the host, which keeps the cutoff', async () => {
  const h = stack({ runtime: 'openclaw' });
  h.run = async (turn) => {
    if (turn.authorizedCommand) return { started: true, hostError: false, aborted: false, usage: null };
    h.exit.collect(turn.turnId, { text: REPLY }, { kind: 'final' });
    return { started: true, hostError: false, aborted: false, usage: USAGE };
  };
  h.later();
  await h.send(h.at({ text: '/stop', senderId: OWNER }));
  await h.gate.idle();
  await h.send(h.at({ text: '同一秒的问题', senderId: MEMBER }));
  await h.gate.idle();
  assert.equal(h.runs.filter((r) => !r.turn.authorizedCommand).length, 1);
});

// ---- her replies in the memory ring ----

test('own: a sent reply joins the next turn\'s history as her line; openclaw adds none', async () => {
  for (const runtime of ['own', 'openclaw']) {
    const h = stack({ runtime });
    await h.ask({ text: '第一个问题' });
    await h.ask({ text: '第二个问题' });
    const own = h.ownLines(1);
    if (runtime === 'own') {
      assert.deepEqual(own.map(({ sender, body, own: o }) => ({ sender, body, own: o })), [{ sender: '可洛', body: REPLY, own: true }]);
      assert.deepEqual(h.historyOf(1).map((l) => l.sender), ['U1', '可洛'], 'in order, after the question it answered');
      assert.equal(h.historyOf(1).some((l) => /MSGID|GROUP|MEMBER/.test(JSON.stringify(l))), false, 'no raw IDs');
    } else {
      assert.deepEqual(own, []);
      assert.deepEqual(h.historyOf(1).map((l) => l.sender), ['U1']);
    }
  }
});

test('own: a reply dropped for its content, one QQ refused as a violation, and the failure line never join the ring', async () => {
  const h = stack();
  h.replyText = HIT;
  const a = await h.ask({ text: '第一个问题' });
  assert.equal(h.state(a).startsWith('policy_dropped'), true, 'the premise');
  assert.deepEqual(h.postedTo(a), [LINES.policyDropped]);

  h.replyText = '这一句会被平台拒绝。';
  h.results.push(new ApiError('content violation', 400, '/v2/groups/x/messages', 40034006, 'detail'));
  const b = await h.ask({ text: '第二个问题' });
  assert.equal(h.state(b), 'failed:platform_violation', 'the premise');

  h.replyText = null;
  const c = await h.ask({ text: '第三个问题' });
  assert.deepEqual(h.postedTo(c), [LINES.modelFailed], 'the premise');

  h.replyText = REPLY;
  await h.ask({ text: '第四个问题' });
  assert.deepEqual(h.ownLines(3), []);
  // Positive control in the same run: that reply did go out, so the next turn sees it.
  await h.ask({ text: '第五个问题' });
  assert.deepEqual(h.ownLines(4).map((l) => l.body), [REPLY]);
});

test('own: a part whose send is uncertain counts as out; a part never sent does not', async () => {
  const h = stack({ effective: { qq: { maxPartChars: 20 } } });
  const long = `${'一'.repeat(15)}。${'二'.repeat(15)}。`;
  h.replyText = long;
  h.results.push({ id: 'S1' }, new ApiError('server', 500, '/v2/groups/x/messages', 99999, 'detail'));
  const a = await h.ask({ text: '长一点的问题' });
  assert.equal(h.state(a), 'failed:send_uncertain', 'the premise');
  assert.equal(h.postedTo(a).length, 2);
  h.replyText = '短回复。';
  await h.ask({ text: '下一个问题' });
  assert.deepEqual(h.ownLines(1).map((l) => l.body), [h.postedTo(a).join('\n')]);
});

test('own: /new and /reset clear members\' lines and hers; the ack is local and no model runs', async () => {
  for (const name of ['/new', '/reset']) {
    const h = stack();
    await h.ask({ text: '第一个问题' });
    const cmd = await h.ask({ text: name, senderId: OWNER });
    assert.equal(h.state(cmd), 'completed:cmd_owner');
    assert.equal(h.runs.length, 1, `${name} never reaches a model`);
    assert.equal(h.postedTo(cmd).length, 1);
    await h.ask({ text: '清空之后的问题' });
    assert.deepEqual(h.historyOf(1), [], `${name} cleared both`);
    // Positive control: without a reset the same sequence carries both lines.
    await h.ask({ text: '再问一个' });
    assert.deepEqual(h.historyOf(2).map((l) => l.sender), ['U1', '可洛']);
  }
});

test('own: her lines leave after 120 idle minutes with no turn, members\' lines stay', async () => {
  const h = stack();
  await h.ask({ text: '第一个问题' });
  // ask() moves the clock 20 s more.
  h.later(OWN_IDLE_MS - 30000);
  await h.ask({ text: '快到时限的问题' });
  assert.deepEqual(h.ownLines(1).map((l) => l.body), [REPLY], 'positive control: just inside the idle time');
  h.later(OWN_IDLE_MS + 1000);
  await h.ask({ text: '很久之后的问题' });
  assert.deepEqual(h.ownLines(2), []);
  assert.deepEqual(h.historyOf(2).map((l) => l.sender), ['U1', 'U1'], 'members\' lines are under the 24-hour cap only');
});

test('own: any turn in the group restarts the idle time, even one that posted nothing of hers', async () => {
  const h = stack();
  await h.ask({ text: '第一个问题' });
  h.later(100 * 60000);
  h.replyText = null;
  const quiet = await h.ask({ text: '没有回复的问题' });
  assert.deepEqual(h.postedTo(quiet), [LINES.modelFailed], 'the premise: only the failure line went out');
  h.replyText = REPLY;
  h.later(100 * 60000);
  await h.ask({ text: '又过了一阵的问题' });
  assert.deepEqual(h.ownLines(2).map((l) => l.body), [REPLY], 'well past 120 minutes since her reply, under 120 since the last turn');
});

test('own: her lines stay inside the ring\'s item cap', async () => {
  const h = stack({ effective: { retention: { contextMaxItems: 3 } } });
  for (let i = 0; i < 4; i += 1) await h.ask({ text: `问题${i}` });
  // Three items held: the last question, her reply to it, and the current one, which a turn never sees in its history.
  assert.deepEqual(h.historyOf(3).map((l) => [l.sender, l.body]), [['U1', '问题2'], ['可洛', REPLY]]);
});

// ---- required turns with nothing to say ----

test('own: a required turn that says nothing or NO_REPLY gets the failure line and one model call', async () => {
  for (const text of [null, 'NO_REPLY']) {
    const h = stack();
    h.run = async (turn) => {
      if (text) h.exit.collect(turn.turnId, { text }, { kind: 'final' });
      return { started: true, hostError: false, aborted: false, usage: USAGE };
    };
    const a = await h.ask({ text: '一个问题' });
    assert.equal(h.runs.length, 1, 'no second call');
    assert.equal(h.state(a), 'failed:required_no_text');
    assert.deepEqual(h.postedTo(a), [LINES.modelFailed]);
    assert.deepEqual(h.reservations(a).map((r) => r.status), ['settled']);
  }
});

// ---- the host-notice branch ----

test('own: text shaped like a host notice is the model\'s own and is posted; openclaw still drops it', async () => {
  const notice = '⚠️ Gateway is restarting. Please wait a few seconds and try again.';
  for (const runtime of ['own', 'openclaw']) {
    const h = stack({ runtime });
    h.replyText = notice;
    const a = await h.ask({ text: '一个问题' });
    if (runtime === 'own') assert.deepEqual(h.postedTo(a), [notice]);
    else assert.deepEqual(h.postedTo(a), [LINES.modelFailed]);
  }
});

// ---- commands ----

test('own: only listed owner commands are commands; other slash text is ordinary text', async () => {
  const h = stack();
  const think = await h.ask({ text: `/think ${CRISIS}`, senderId: MEMBER });
  assert.equal(h.state(think), 'completed:sent');
  assert.equal(h.runs.at(-1).turn.text, `/think ${CRISIS}`);
  const help = await h.ask({ text: '/help', senderId: MEMBER });
  assert.equal(h.state(help), 'completed:sent', 'a member\'s /help is a question');
  const stopArgs = await h.ask({ text: '/stop 一下', senderId: OWNER });
  assert.equal(h.state(stopArgs), 'completed:sent', 'not the listed /stop');
  assert.equal(h.store.getControl(`owner_stop:${h.store.key(h.runs[0].turn.groupId)}`), null);
  // Listed commands keep their rules: a member's is ignored, the owner's acts.
  for (const t of ['/stop', '/clo pause', '/status', '/new']) {
    const e = await h.ask({ text: t, senderId: MEMBER });
    assert.equal(h.state(e), 'ignored:cmd_non_owner', t);
  }
  const status = await h.ask({ text: '/status', senderId: OWNER });
  assert.equal(h.state(status), 'completed:cmd_owner');
  assert.equal(h.runs.length, 3);
});

test('openclaw: slash text is still taken as a command, as before', async () => {
  const h = stack({ runtime: 'openclaw' });
  const help = await h.ask({ text: '/help', senderId: MEMBER });
  assert.equal(h.state(help), 'ignored:cmd_non_owner');
  assert.equal(h.runs.length, 0);
});

// ---- the provider streak ----

test('own: three failed model calls pause paid work, an abort counts for nothing, a success resets the streak', async () => {
  const h = stack();
  let mode = 'error';
  h.run = async (turn, signal) => {
    if (mode === 'abort') return { started: true, hostError: false, aborted: true, usage: null };
    if (mode === 'ok') {
      h.exit.collect(turn.turnId, { text: REPLY }, { kind: 'final' });
      return { started: true, hostError: false, aborted: false, usage: USAGE };
    }
    void signal;
    return { started: true, hostError: true, aborted: false, usage: null, info: { status: 503, limitSource: null } };
  };
  await h.ask({ text: '问题一' });
  await h.ask({ text: '问题二' });
  mode = 'ok';
  await h.ask({ text: '问题三' });
  mode = 'error';
  await h.ask({ text: '问题四' });
  mode = 'abort';
  await h.ask({ text: '问题五' });
  mode = 'error';
  await h.ask({ text: '问题六' });
  assert.equal(h.pausedBy(), null, 'two failures since the success, the abort between them uncounted');
  await h.ask({ text: '问题七' });
  assert.equal(h.pausedBy(), 'provider_fail');
});

test('own: a refusal, a tool call or empty text the provider answered counts as a good call, not toward the pause', async () => {
  const h = stack();
  let mode = 'refused';
  h.run = async () => {
    if (mode === 'refused') return { started: true, hostError: true, aborted: false, usage: USAGE };
    return { started: true, hostError: true, aborted: false, usage: null, info: { status: 503, limitSource: null } };
  };
  for (let i = 0; i < 4; i += 1) await h.ask({ text: `被拒的问题${i}` });
  assert.equal(h.pausedBy(), null, 'four refusals in a row pause nothing');
  assert.equal(h.runs.length, 4, 'every one of them still reached the model');
  mode = 'error';
  await h.ask({ text: '问题一' });
  await h.ask({ text: '问题二' });
  mode = 'refused';
  await h.ask({ text: '问题三' });
  mode = 'error';
  await h.ask({ text: '问题四' });
  await h.ask({ text: '问题五' });
  assert.equal(h.pausedBy(), null, 'the answered refusal reset the streak, as a completed call does on the host path');
  await h.ask({ text: '问题六' });
  assert.equal(h.pausedBy(), 'provider_fail', 'positive control: three provider failures in a row still pause');
});

test('own: a failed turn with no usage and no provider blame, such as a call cut early, leaves the streak alone', async () => {
  const h = stack();
  let mode = 'error';
  h.run = async () => {
    if (mode === 'cut') return { started: true, hostError: true, aborted: false, usage: null };
    return { started: true, hostError: true, aborted: false, usage: null, info: { status: 503, limitSource: null } };
  };
  await h.ask({ text: '问题一' });
  await h.ask({ text: '问题二' });
  mode = 'cut';
  for (let i = 0; i < 3; i += 1) await h.ask({ text: `截断的问题${i}` });
  assert.equal(h.pausedBy(), null, 'cut calls count for nothing');
  mode = 'error';
  await h.ask({ text: '问题三' });
  assert.equal(h.pausedBy(), 'provider_fail', 'nor did they reset the two failures before them');
});

test('own: a 402 from the provider pauses at once as credits', async () => {
  const h = stack();
  h.run = async () => ({ started: true, hostError: true, aborted: false, usage: null, info: { status: 402, limitSource: null } });
  await h.ask({ text: '问题一' });
  assert.equal(h.pausedBy(), 'openrouter_credits');
});

test('openclaw: the gate counts no provider failures; the host hook does', async () => {
  const h = stack({ runtime: 'openclaw' });
  h.run = async () => ({ started: true, hostError: true, aborted: false, usage: null, info: { status: 402, limitSource: null } });
  for (let i = 0; i < 4; i += 1) await h.ask({ text: `问题${i}` });
  assert.equal(h.pausedBy(), null);
});

// ---- the hold ----

test('own: a required turn holds one worst call at the cache-write rate; openclaw holds two', async () => {
  for (const [runtime, micros] of [['own', 24000 * 6.25 + 3000 * 20], ['openclaw', 2 * (24000 * 5 + 3000 * 20)]]) {
    const h = stack({ runtime });
    const release = deferred();
    h.run = async (turn) => {
      await release.promise;
      h.exit.collect(turn.turnId, { text: REPLY }, { kind: 'final' });
      return { started: true, hostError: false, aborted: false, usage: USAGE };
    };
    h.later();
    const a = await h.send(h.at({ text: '一个问题' }));
    await until(() => h.runs.length === 1);
    assert.deepEqual(h.reservations(a).map((r) => [r.status, r.held_micros]), [['held', micros]], runtime);
    release.resolve();
    await h.gate.idle();
  }
});

// ---- the runtime is the process's, not the file's ----

test('the host process keeps the host rules when a clo apply writes runtime own under it', async () => {
  const notice = '⚠️ Gateway is restarting. Please wait a few seconds and try again.';
  const ctl = stack({ runtime: 'own' });
  ctl.replyText = notice;
  const shown = await ctl.ask({ text: '一个问题' });
  assert.deepEqual(ctl.postedTo(shown), [notice], 'positive control: the bot process posts the same text');

  const h = stack({ runtime: null, fileRuntime: 'own' });
  // The notice filter stays on.
  h.replyText = notice;
  const a = await h.ask({ text: '一个问题' });
  assert.deepEqual(h.postedTo(a), [LINES.modelFailed], 'a host notice never reaches the group');
  assert.deepEqual(h.logs.filter((l) => l.event === 'runtime_mismatch'), [{ event: 'runtime_mismatch', process: 'openclaw', file: 'own' }]);
  // The hold stays at two calls.
  const release = deferred();
  h.run = async (turn) => {
    if (turn.authorizedCommand) return { started: true, hostError: false, aborted: false, usage: null };
    await release.promise;
    return { started: true, hostError: true, aborted: false, usage: null, info: { status: 503, limitSource: null } };
  };
  h.later(20000);
  const b = await h.send(h.at({ text: '另一个问题' }));
  await until(() => h.runs.length === 2);
  assert.deepEqual(h.reservations(b).map((r) => [r.status, r.held_micros]), [['held', 2 * (24000 * 5 + 3000 * 20)]]);
  // /stop still goes to the host.
  h.later();
  await h.send(h.at({ text: '/stop', senderId: OWNER }));
  await until(() => h.runs.length === 3);
  assert.equal(h.runs[2].turn.authorizedCommand, '/stop');
  release.resolve();
  await h.gate.idle();
  // The gate counts no provider failures; the host hook does.
  for (let i = 0; i < 3; i += 1) await h.ask({ text: `问题${i}` });
  assert.equal(h.pausedBy(), null);
  assert.equal(h.logs.filter((l) => l.event === 'runtime_mismatch').length, 1, 'logged once, not on every event');
});

test('the bot process keeps the own rules when a clo apply writes runtime openclaw, or none, under it', async () => {
  for (const fileRuntime of ['openclaw', null]) {
    const h = stack({ runtime: 'own', fileRuntime });
    // /stop is handled in the gate and never sent to the model as a command turn.
    h.run = waitsForAbort(h);
    h.later();
    const a = await h.send(h.at({ text: '讲个长故事', senderId: MEMBER }));
    await until(() => h.waiting === 1);
    assert.deepEqual(h.reservations(a).map((r) => [r.status, r.held_micros]), [['held', 24000 * 6.25 + 3000 * 20]], 'one call held');
    h.later();
    // Not awaited first: were /stop sent on as a command turn, it would wait on the model.
    const stopping = h.send(h.at({ text: '/stop', senderId: OWNER }));
    await until(() => h.runs[0].signal.aborted);
    const stop = await stopping;
    await h.gate.idle();
    assert.equal(h.runs.length, 1, String(fileRuntime));
    assert.equal(h.runs[0].signal.aborted, true);
    assert.equal(h.state(stop), 'completed:cmd_owner');
    // Provider failures are still counted here, with no host hook to count them.
    h.run = async () => ({ started: true, hostError: true, aborted: false, usage: null, info: { status: 503, limitSource: null } });
    for (let i = 0; i < 3; i += 1) await h.ask({ text: `问题${i}` });
    assert.equal(h.pausedBy(), 'provider_fail', String(fileRuntime));
    assert.deepEqual(h.logs.filter((l) => l.event === 'runtime_mismatch').map((l) => [l.process, l.file]), [['own', 'openclaw']]);
  }
});

test('a runtime other than openclaw or own is refused when the gate or exit is built', () => {
  assert.throws(() => createGate({ store: null, ledger: null, policy: null, getEffective: () => null, decide: null, dispatchTurn: null, runtime: 'wechat' }), /runtime must be/);
  assert.throws(() => createExit({ bot: null, store: null, policy: null, getEffective: () => null, runtime: 'wechat' }), /runtime must be/);
});

// ---- a turn for a person in danger cut off by a shutdown ----

const crisisAlerts = (h) => h.store.listAlerts().filter((a) => a.kind.startsWith('crisis_'));

test('own: a shutdown that cuts off a turn for a person in danger raises the shutdown alert, not crisis_refused', async () => {
  const h = stack();
  h.run = waitsForAbort(h);
  h.later();
  const a = await h.send(h.at({ text: CRISIS, senderId: MEMBER }));
  await until(() => h.waiting === 1);
  await h.gate.stop();
  await until(() => h.state(a) !== 'dispatching');
  assert.equal(h.runs[0].signal.reason.message, 'shutdown');
  assert.equal(h.state(a), 'failed:aborted');
  assert.deepEqual(crisisAlerts(h).map((x) => x.kind), ['crisis_dropped_on_stop']);
  assert.deepEqual(h.postedTo(a), [], 'nothing is said at a shutdown');
  assert.deepEqual(h.reservations(a).map((r) => r.status), ['unsettled']);
  assert.equal(h.pausedBy(), null);
});

test('own: /stop and the deadline keep their path for a person in danger (controls for the shutdown case)', async () => {
  // /stop: the failure line once, and crisis_refused saying so.
  const s = stack();
  s.run = waitsForAbort(s);
  s.later();
  const a = await s.send(s.at({ text: CRISIS, senderId: MEMBER }));
  await until(() => s.waiting === 1);
  s.later();
  await s.send(s.at({ text: '/stop', senderId: OWNER }));
  await s.gate.idle();
  assert.deepEqual(s.postedTo(a), [LINES.modelFailed]);
  const stopAlerts = crisisAlerts(s);
  assert.deepEqual(stopAlerts.map((x) => x.kind), ['crisis_refused']);
  assert.match(JSON.stringify(stopAlerts[0]), /owner_stop/);
  assert.match(JSON.stringify(stopAlerts[0]), /line_sent/);

  // The deadline, with the gate running: crisis_refused for the abort, and no line.
  const d = stack();
  d.run = waitsForAbort(d);
  d.later();
  const b = await d.send(d.at({ text: CRISIS, senderId: MEMBER }));
  await until(() => d.waiting === 1);
  d.advance(d.runs[0].turn.deadlineAt - d.now());
  await d.gate.idle();
  assert.equal(d.runs[0].signal.reason.message, 'deadline');
  assert.equal(d.state(b), 'failed:aborted');
  const deadlineAlerts = crisisAlerts(d);
  assert.deepEqual(deadlineAlerts.map((x) => x.kind), ['crisis_refused']);
  assert.match(JSON.stringify(deadlineAlerts[0]), /"aborted"/);
  assert.deepEqual(d.postedTo(b), []);
});

test('openclaw: a shutdown during a turn for a person in danger that the host reports aborted still raises crisis_refused, as before', async () => {
  const h = stack({ runtime: null });
  h.run = waitsForAbort(h);
  h.later();
  const a = await h.send(h.at({ text: CRISIS, senderId: MEMBER }));
  await until(() => h.waiting === 1);
  await h.gate.stop();
  await until(() => h.state(a) !== 'dispatching');
  const alerts = crisisAlerts(h);
  assert.deepEqual(alerts.map((x) => x.kind), ['crisis_refused']);
  assert.match(JSON.stringify(alerts[0]), /"aborted"/);
});

// ---- her lines leave on time ----

const expired = (h) => h.logs.filter((l) => l.event === 'own_lines_expired');

test('own: her lines leave memory at exactly 120 idle minutes with no read; openclaw holds none to drop', async () => {
  const h = stack();
  await h.ask({ text: '第一个问题' });
  h.advance(OWN_IDLE_MS - 1);
  assert.deepEqual(expired(h), [], 'positive control: still held a moment before');
  h.advance(1);
  assert.deepEqual(expired(h).map((l) => l.count), [1], 'gone at the deadline, before any turn reads the ring');
  await h.ask({ text: '之后的问题' });
  assert.deepEqual(h.ownLines(1), []);
  assert.deepEqual(h.historyOf(1).map((l) => l.sender), ['U1'], 'members\' lines stay');

  const o = stack({ runtime: null });
  await o.ask({ text: '第一个问题' });
  o.advance(2 * OWN_IDLE_MS);
  assert.deepEqual(expired(o), []);
});

test('own: a turn in between moves the deadline; the early timer sets itself again', async () => {
  const h = stack();
  await h.ask({ text: '第一个问题' });
  const first = h.now();
  h.later(100 * 60000);
  h.replyText = null;
  await h.ask({ text: '没有回复的问题' });
  const touched = h.now();
  h.advance(first + OWN_IDLE_MS - h.now());
  assert.deepEqual(expired(h), [], 'the turn at 100 minutes kept her line');
  h.advance(touched + OWN_IDLE_MS - h.now() - 1);
  assert.deepEqual(expired(h), []);
  h.advance(1);
  assert.deepEqual(expired(h).map((l) => l.count), [1]);
});
