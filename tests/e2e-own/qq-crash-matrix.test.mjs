// Crash recovery on the own runtime with real process exits. CLO_TEST_CRASH_AT makes the bot exit at the named point,
// then a fresh bot process recovers from the same files. The same message redelivered afterwards: never a second run
// or reply. Each row has its own stack, so no row can lean on state another row left.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fullAt, nextId, plain, push } from '../fixtures/qq-events.mjs';
import { decisionText } from '../harness/mock-openrouter.mjs';
import { assertEveryPostLegal, GROUP_A, netAttempts, startOwnStack, until } from '../harness/own.mjs';

const REPLY = '恢复测试的回答。';

async function crashAndRecover(point, event, { expectPosts, expectModel, expectState, paidAfter = null, then = () => {} }) {
  const s = await startOwnStack({
    label: 'crash',
    groups: { [GROUP_A]: { interject: true, cooldownMinutes: 0, perHour: 100, perDay: 100 } },
    script: () => ({ text: REPLY }),
    decision: () => ({ text: decisionText({ action: 'reply' }) }),
    effective: { quietHours: { start: '00:00', end: '00:00', timezone: 'Asia/Shanghai' } },
    start: false,
  });
  try {
    await s.start({ env: { CLO_TEST_CRASH_AT: point } });
    const id = push(s, event);
    const died = await s.bot.waitExit(120000);
    assert.equal(died.code, 77, `the crash point ${point} was reached`);
    assert.equal(s.messagePosts().length, expectPosts, `posts before the crash at ${point}`);
    assert.equal(s.agentRequests().length, expectModel, `model calls before the crash at ${point}`);

    await s.restart();
    await until(() => s.row(id)?.state === expectState, `${point} recovers to ${expectState}, row is ${s.row(id)?.state}`, 30000);
    assert.equal(s.control('paid_paused'), paidAfter, `paid pause after ${point}`);

    const posts = s.messagePosts().length;
    const model = s.agentRequests().length;
    s.qq.push(event[0], event[1]);
    await until(() => s.event('gate_dup').some((e) => e.eventKey === s.key(id)), 'the replay was dropped', 15000);
    assert.equal(s.messagePosts().length, posts, 'replay: no second reply');
    assert.equal(s.agentRequests().length, model, 'replay: no second run');

    then(s, id);

    // Positive control on the same files: once settled, a new message gets one reply.
    await s.acceptUnsettled();
    const before_ = s.messagePosts().length;
    const fresh = nextId('CRASHZ');
    push(s, fullAt('全部之后的新问题', { id: fresh }));
    const row = await s.waitRow(fresh);
    assert.equal(`${row.state}:${row.reason}`, 'completed:sent');
    assert.equal(s.messagePosts().length, before_ + 1);
    assertEveryPostLegal(s, { minPosts: 1 });
    assert.deepEqual(netAttempts(s), []);
  } finally {
    await s.stop();
    s.cleanup();
  }
}

describe('crash matrix on the own runtime', () => {
  test('after_claim: dropped, nothing ran', async () => {
    await crashAndRecover('after_claim', fullAt('崩在认领之后', { id: nextId('CRASHA') }), { expectPosts: 0, expectModel: 0, expectState: 'restart_dropped' });
  });

  test('deciding: decision hold unsettled, claim released, no reply, no pause', async () => {
    await crashAndRecover('deciding', plain('崩在判定开始的时候', { id: nextId('CRASHC') }), {
      expectPosts: 0,
      expectModel: 0,
      expectState: 'restart_dropped',
      then: (s, id) => {
        assert.equal(s.reservations(id).find((r) => r.category === 'decision').status, 'unsettled');
        assert.equal(s.claims().filter((c) => c.status === 'claimed').length, 0);
      },
    });
  });

  test('approved: reply hold released, no model ran, no pause', async () => {
    await crashAndRecover('approved', fullAt('崩在批准之后', { id: nextId('CRASHB') }), {
      expectPosts: 0,
      expectModel: 0,
      expectState: 'restart_dropped',
      then: (s, id) => assert.equal(s.reservations(id).find((r) => r.category === 'reply').status, 'released'),
    });
  });

  test('dispatching: unknown whether the model ran; crash_unknown, paid pause, never re-run', async () => {
    await crashAndRecover('dispatching', fullAt('崩在派发之前', { id: nextId('CRASHD') }), {
      expectPosts: 0,
      expectModel: 0,
      expectState: 'crash_unknown',
      paidAfter: 'crash_unsettled',
      then: (s, id) => assert.equal(s.reservations(id)[0].status, 'unsettled'),
    });
  });

  test('before_post: no POST, crash_unknown, paid pause', async () => {
    await crashAndRecover('before_post', fullAt('崩在发送之前', { id: nextId('CRASHE') }), {
      expectPosts: 0,
      expectModel: 1,
      expectState: 'crash_unknown',
      paidAfter: 'crash_unsettled',
      then: (s, id) => assert.equal(s.sends(id).at(-1).state, 'aborted', 'markSend(sending) comes after the crash point'),
    });
  });

  test('after_post: the POST happened and is only known as uncertain; never re-sent', async () => {
    await crashAndRecover('after_post', fullAt('崩在发送之后', { id: nextId('CRASHF') }), {
      expectPosts: 1,
      expectModel: 1,
      expectState: 'crash_unknown',
      paidAfter: 'crash_unsettled',
      then: (s, id) => assert.equal(s.sends(id).at(-1).state, 'uncertain'),
    });
  });

  test('before_settle: all parts sent; event completed, hold unsettled, paid pause', async () => {
    await crashAndRecover('before_settle', fullAt('崩在结算之前', { id: nextId('CRASHG') }), {
      expectPosts: 1,
      expectModel: 1,
      expectState: 'completed',
      paidAfter: 'crash_unsettled',
      then: (s, id) => assert.equal(s.sends(id).at(-1).state, 'sent'),
    });
  });
});
