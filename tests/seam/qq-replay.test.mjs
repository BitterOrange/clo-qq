// TQ19. Replays, restarts and uncertain sends never produce a second reply.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '@tencent-connect/qqbot-nodejs';
import '../harness/net-guard.mjs';
import { assertEveryPostLegal, deferred, makeEffective, seamMock, seamStack, T0, USAGE } from '../fixtures/inbound.mjs';

const tick = () => new Promise((r) => setImmediate(r));

test('the same message delivered twice posts once, and the first post really happened', async () => {
  const h = await seamStack();
  const e = h.at();
  await h.send(e);
  await h.gate.idle();
  assert.equal(h.posts().length, 1, 'positive control');
  await h.send(e);
  await h.gate.idle();
  assert.equal(h.posts().length, 1);
  assert.equal(h.seen.length, 1);
  assertEveryPostLegal(h);
  await h.close();
});

test('after a restart a replayed message posts nothing and a new one posts once', async () => {
  const mock = await seamMock();
  const a = await seamStack({ mock, runGen: 'gen-a' });
  const e = await a.sendAndFlush(a.at());
  assert.equal(a.posts().length, 1);
  const { file } = a;
  await a.close();

  const b = await seamStack({ mock, dbFile: file, runGen: 'gen-b', start: T0 + 1000 });
  b.store.recoverOnStart(T0 + 1000);
  await b.sendAndFlush({ ...e, receivedAt: T0 + 1000 });
  assert.equal(b.seen.length, 0);
  assert.equal(b.posts().length, 1, 'still only the first post');

  const fresh = await b.sendAndFlush(b.at());
  assert.equal(b.posts().length, 2);
  assert.equal(b.posts()[1].body.msg_id, fresh.messageId);
  await b.close();
  await mock.stop();
});

test('catch-up: an old message delivered after reconnect is stale and gets no reply', async () => {
  const h = await seamStack();
  const old = h.at({ timestampMs: T0 - 600000 });
  await h.send(old);
  await h.gate.idle();
  assert.equal(h.state(old), 'stale:old');
  assert.equal(h.posts().length, 0);
  await h.sendAndFlush(h.at());
  assert.equal(h.posts().length, 1, 'positive control');
  await h.close();
});

test('crash during the model run: no re-run, no re-send, paid work paused until settled', async () => {
  const mock = await seamMock();
  const never = deferred();
  const a = await seamStack({ mock, runGen: 'gen-a' });
  a.script = () => never.promise;
  const e = a.at();
  await a.send(e);
  await tick();
  assert.equal(a.state(e), 'dispatching');
  const { file } = a;
  // The process is gone: the handle closes with the row left as it was.
  a.store.close();

  const b = await seamStack({ mock, dbFile: file, runGen: 'gen-b', start: T0 + 5000 });
  const counts = b.store.recoverOnStart(T0 + 5000);
  assert.equal(counts.crash_unknown, 1);
  assert.equal(b.state(e), 'crash_unknown:restart');
  assert.equal(b.store.getControl('paid_paused'), 'crash_unsettled');

  await b.sendAndFlush({ ...e, receivedAt: T0 + 5000 });
  assert.equal(b.seen.length, 0, 'never re-run');
  assert.equal(b.posts().length, 0, 'never re-sent');

  const blocked = await b.sendAndFlush(b.at());
  assert.equal(b.state(blocked), 'skipped:paid_paused');
  assert.equal(b.seen.length, 0);

  b.ledger.acceptUnsettled('test');
  b.nextTurn();
  await b.sendAndFlush(b.at());
  assert.equal(b.seen.length, 1, 'accepted: paid work resumes');
  assert.equal(b.posts().filter((p) => p.body.content === b.replyText).length, 1);
  await b.close();
  await mock.stop();
});

test('a timeout on POST is uncertain: not re-sent now, not re-sent after a restart', async () => {
  const mock = await seamMock();
  const a = await seamStack({ mock, runGen: 'gen-a' });
  a.nextPostError = new Error('network timeout');
  const e = await a.sendAndFlush(a.at());
  assert.equal(a.state(e), 'failed:send_uncertain');
  assert.equal(a.posts().length, 0, 'the fake failure stopped it before the mock');
  const key = a.store.key(e.messageId);
  assert.equal(a.store.sendsForEvent(key).at(-1).state, 'uncertain');
  assert.ok(a.reservations(e)[0].actual_micros > 0, 'the model ran, so its cost stays');
  await a.sendAndFlush(e);
  assert.equal(a.seen.length, 1, 'a replay does not run it again');
  const { file } = a;
  await a.close();

  const b = await seamStack({ mock, dbFile: file, runGen: 'gen-b', start: T0 + 30000 });
  b.store.recoverOnStart(T0 + 30000);
  assert.equal(b.state(e), 'failed:send_uncertain', 'terminal rows are left alone');
  await b.sendAndFlush({ ...e, receivedAt: T0 + 30000 });
  assert.equal(b.seen.length + b.posts().length, 0);
  await b.close();
  await mock.stop();
});

test('platform violation: dropped, no retry, no reword and no fixed line', async () => {
  const h = await seamStack();
  await h.sendAndFlush(h.at());
  assert.equal(h.posts().length, 1, 'positive control');
  h.nextTurn();
  h.nextPostError = new ApiError('content violation', 400, '/v2/groups/x/messages', 40034006, 'detail');
  const e = await h.sendAndFlush(h.at());
  assert.equal(h.state(e), 'failed:platform_violation');
  assert.equal(h.seen.length, 2);
  assert.equal(h.posts().length, 1, 'nothing further reached the mock');
  await h.close();
});

test('a late result after stop never posts', async () => {
  const hold = deferred();
  const h = await seamStack();
  h.script = async (turn) => {
    await hold.promise;
    h.exit.collect(turn.turnId, { text: h.replyText }, { kind: 'final' });
    return { started: true, hostError: false, aborted: false, usage: USAGE };
  };
  const e = h.at();
  await h.send(e);
  await tick();
  assert.equal(h.seen.length, 1);
  h.exit.stop();
  const stopping = h.gate.stop();
  hold.resolve();
  await stopping;
  assert.equal(h.posts().length, 0);
  assert.equal(h.state(e), 'failed:exit_refused');
  await h.close();
});

test('dry-run replays stay dry and write one row', async () => {
  const h = await seamStack({ effective: makeEffective({ mode: 'dry-run' }) });
  const e = h.at();
  await h.send(e);
  await h.send(e);
  await h.gate.idle();
  assert.equal(h.allEvents().length, 1);
  assert.equal(h.state(e), 'dry_run:would_at');
  assert.equal(h.posts().length, 0);
  await h.close();
});

test('last: every POST across a mixed run is legal', async () => {
  const h = await seamStack();
  const e = await h.sendAndFlush(h.at());
  await h.sendAndFlush(e);
  h.nextTurn();
  await h.sendAndFlush(h.at());
  assertEveryPostLegal(h, { minPosts: 2 });
  await h.close();
});
