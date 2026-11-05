// TQ34. The failure line goes out once, within its rate limit, and never while paused.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import '../harness/net-guard.mjs';
import { assertEveryPostLegal, GROUP_A, makeEffective, ROOT, seamStack, T0, USAGE } from '../fixtures/inbound.mjs';

const LINES = JSON.parse(readFileSync(join(ROOT, 'persona', 'policy-lines.zh.json'), 'utf8'));
const groupPause = (h) => h.store.setControl(`group_paused:${h.store.key(GROUP_A)}`, '1', 'test');

test('positive control: a normal answer posts its own text, not the failure line', async () => {
  const h = await seamStack();
  const e = await h.sendAndFlush(h.at());
  assert.equal(h.state(e), 'completed:sent');
  assert.equal(h.posts()[0].body.content, h.replyText);
  await h.close();
});

test('a required turn with no text sends the line once, tied to the message, and alerts', async () => {
  const h = await seamStack();
  h.replyText = null;
  const e = await h.sendAndFlush(h.at());
  assert.equal(h.state(e), 'failed:required_no_text');
  const posts = h.posts();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.content, LINES.modelFailed);
  assert.equal(posts[0].body.msg_id, e.messageId);
  assert.equal(posts[0].path, `/v2/groups/${GROUP_A}/messages`);
  assert.ok(h.store.listAlerts().length > 0);
  assert.equal(h.reservations(e)[0].status, 'settled');
  await h.close();
});

test('host error text never reaches QQ: the fixed line replaces it', async () => {
  const hostText = 'Agent could not generate a response. PROVIDER-DETAIL';
  const h = await seamStack();
  h.script = async (turn) => {
    h.exit.collect(turn.turnId, { text: hostText, isError: true }, { kind: 'final' });
    return { started: true, hostError: true, aborted: false, usage: USAGE };
  };
  const e = await h.sendAndFlush(h.at());
  assert.equal(h.state(e), 'failed:host_error');
  const posts = h.posts();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.content, LINES.modelFailed);
  assert.equal(JSON.stringify(posts).includes('PROVIDER-DETAIL'), false);
  assert.equal(JSON.stringify(h.logs).includes('PROVIDER-DETAIL'), false);
  await h.close();
});

test('the line is rate limited per group per hour; failed turns still get terminal rows', async () => {
  const h = await seamStack();
  h.replyText = null;
  const events = [];
  for (let i = 0; i < 3; i += 1) {
    events.push(await h.sendAndFlush(h.at({ text: `问题${i}` })));
    h.nextTurn();
  }
  assert.equal(h.posts().length, 2, 'the third is over the limit of 2');
  for (const e of events) assert.equal(h.state(e), 'failed:required_no_text');
  h.advance(3600000);
  await h.sendAndFlush(h.at({ text: '下一个小时的问题' }));
  assert.equal(h.posts().length, 3, 'the next hour has room');
  await h.close();
});

test('an interjection with no text is silent', async () => {
  const h = await seamStack();
  h.replyText = null;
  const e = await h.sendAndFlush(h.event({ text: '有人知道怎么退货吗' }));
  assert.equal(h.state(e), 'silent:no_reply');
  assert.equal(h.posts().length, 0);
  await h.sendAndFlush(h.at());
  assert.equal(h.posts().length, 1, 'positive control: a required turn on the same stack does post');
  await h.close();
});

test('paused before the message: no turn and no line', async () => {
  const h = await seamStack();
  await h.sendAndFlush(h.at());
  assert.equal(h.posts().length, 1, 'positive control');
  h.nextTurn();
  groupPause(h);
  const e = await h.sendAndFlush(h.at());
  assert.equal(h.state(e), 'paused:paused');
  assert.equal(h.posts().length, 1);
  await h.close();
});

test('paused while the model runs: nothing posts, including the line', async () => {
  const h = await seamStack();
  await h.sendAndFlush(h.at());
  const baseline = h.posts().length;
  h.nextTurn();
  h.replyText = null;
  const script = h.script;
  h.script = async (turn) => {
    groupPause(h);
    return script(turn);
  };
  await h.sendAndFlush(h.at());
  assert.equal(h.posts().length, baseline, 'no line while paused');
  h.store.delControl(`group_paused:${h.store.key(GROUP_A)}`);

  h.nextTurn();
  h.replyText = '这是模型的回答。';
  h.script = async (turn) => {
    groupPause(h);
    return script(turn);
  };
  await h.sendAndFlush(h.at());
  assert.equal(h.posts().length, baseline, 'no reply while paused');
  await h.close();
});

test('budget exhausted before dispatch: the line goes out once, with no model call', async () => {
  const eff = makeEffective({ budget: { addressedUsd: 0.1, dailyUsd: 0.1, namedUsd: 0.1, searchUsd: 0.1, interjectUsd: 0.1 } });
  const h = await seamStack({ effective: eff });
  const e = await h.sendAndFlush(h.at());
  assert.equal(h.state(e), 'skipped:budget');
  assert.equal(h.seen.length, 0);
  assert.equal(h.posts().length, 1);
  assert.equal(h.posts()[0].body.content, LINES.modelFailed);
  await h.close();
});

test('budget exhausted while paused is decided by the pause: no line', async () => {
  const eff = makeEffective({ budget: { addressedUsd: 0.1, dailyUsd: 0.1, namedUsd: 0.1, searchUsd: 0.1, interjectUsd: 0.1 } });
  const h = await seamStack({ effective: eff });
  groupPause(h);
  const e = await h.sendAndFlush(h.at());
  assert.equal(h.state(e), 'paused:paused');
  assert.equal(h.posts().length, 0);
  await h.close();
});

test('the failure line is refused in dry-run even if something asked for it', async () => {
  const h = await seamStack({ effective: makeEffective({ mode: 'dry-run' }) });
  const ref = { eventKey: 'k', groupKey: h.store.key(GROUP_A), groupId: GROUP_A, messageId: 'M', receivedAt: T0, msgTs: T0 };
  const r = await h.exit.sendFixed(ref, 'modelFailed');
  assert.equal(r.sent, false);
  assert.equal(h.posts().length, 0);
  await h.close();
});

test('last: every POST across a mixed run is legal', async () => {
  const h = await seamStack();
  await h.sendAndFlush(h.at());
  h.nextTurn();
  h.replyText = null;
  await h.sendAndFlush(h.at());
  assertEveryPostLegal(h, { minPosts: 2 });
  await h.close();
});
