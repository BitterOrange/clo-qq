// TQ26. The content pre-gate applies on interject paths only; a real @ always reaches the model.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import '../harness/net-guard.mjs';
import { assertEveryPostLegal, decisionOf, makeEffective, ROOT, seamStack } from '../fixtures/inbound.mjs';

const HIT = '加我 约炮';
const LINES = JSON.parse(readFileSync(join(ROOT, 'persona', 'policy-lines.zh.json'), 'utf8'));

test('positive control: clean ordinary text decides, runs and posts once', async () => {
  const h = await seamStack();
  assert.equal(h.policy.check(HIT).hit, true, 'the rule is live');
  const e = await h.sendAndFlush(h.event({ text: '有人知道怎么退货吗' }));
  assert.equal(h.decideCalls.length, 1);
  assert.equal(h.seen.length, 1);
  assert.equal(h.posts().length, 1);
  assert.equal(h.state(e), 'completed:sent');
  assertEveryPostLegal(h);
  await h.close();
});

test('a policy hit on an ordinary message stops before any model, with no hit record', async () => {
  const h = await seamStack();
  const e = await h.sendAndFlush(h.event({ text: HIT }));
  assert.equal(h.state(e), 'skipped:rule');
  assert.equal(h.decideCalls.length, 0);
  assert.equal(h.seen.length, 0);
  assert.equal(h.posts().length, 0);
  assert.equal(h.store.q('SELECT COUNT(*) AS n FROM alerts').get().n, 0);
  assert.equal(h.counters().filter((c) => c.key.startsWith('policy_drop')).length, 0);
  const dump = JSON.stringify(h.allEvents());
  assert.equal(dump.includes('sexual'), false, 'no rule or category on the row');
  assert.equal(dump.includes(HIT), false);

  // Same stack, positive control: this path does post.
  await h.sendAndFlush(h.at({ text: '现在问一个问题' }));
  assert.equal(h.posts().length, 1);
  assert.deepEqual(h.seen[0].history, [], 'the hit never entered context');

  // Indistinguishable from a skip that has nothing to do with content, in the row and in the log.
  h.nextTurn();
  const noise = await h.sendAndFlush(h.event({ text: '😀😀😀' }));
  assert.equal(h.state(noise), h.state(e));
  assert.equal(JSON.stringify(h.logs).includes('prerule'), false);
  await h.close();
});

test('the same text as a real @ or a reply to the bot reaches the model unchanged', async () => {
  const h = await seamStack();
  const at = await h.sendAndFlush(h.at({ text: HIT }));
  assert.equal(h.seen.length, 1);
  assert.equal(h.seen[0].text, HIT);
  assert.equal(h.seen[0].cls, 'at');
  assert.equal(h.state(at), 'completed:sent', 'the model answer was clean, so it posts');
  h.nextTurn();
  h.store.addBotRef(h.store.key('REFA'), h.store.key(at.conversationId), 'E');
  await h.sendAndFlush(h.event({ text: HIT, refMsgIdx: 'REFA' }));
  assert.equal(h.seen[1].cls, 'reply_bot');
  assert.equal(h.seen[1].text, HIT);
  assert.equal(h.posts().length, 2);
  await h.close();
});

test('a name mention with the same text still reaches the decision', async () => {
  const h = await seamStack({ decide: async () => decisionOf({ action: 'skip' }) });
  await h.sendAndFlush(h.event({ text: `可洛 ${HIT}` }));
  assert.equal(h.decideCalls.length, 1);
  assert.equal(h.decideCalls[0].trigger, 'name');
  await h.close();
});

test('a rule that throws fails closed on the interject path and still lets a real @ through', async () => {
  const h = await seamStack();
  const real = h.policy.check;
  h.policy.check = (text) => {
    if (text.includes('触发异常')) throw new Error('rule engine failed');
    return real(text);
  };
  const ordinary = await h.sendAndFlush(h.event({ text: '触发异常的普通消息' }));
  assert.equal(h.state(ordinary), 'skipped:rule');
  const at = await h.sendAndFlush(h.at({ text: '触发异常的提问' }));
  assert.equal(h.seen.length, 1);
  assert.equal(h.state(at), 'completed:sent');
  h.policy.check = real;
  await h.close();
});

test('a dropped answer on a required turn sends the fixed line once; on an interjection, nothing', async () => {
  const h = await seamStack();
  h.replyText = `可以 ${HIT}`;
  const at = await h.sendAndFlush(h.at({ text: '问一个问题' }));
  assert.equal(h.state(at).split(':')[0], 'policy_dropped');
  const posts = h.posts();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.content, LINES.policyDropped);
  assert.equal(posts[0].body.content.includes('约炮'), false);

  h.nextTurn();
  const ordinary = await h.sendAndFlush(h.event({ text: '有人知道怎么退货吗' }));
  assert.equal(h.state(ordinary).split(':')[0], 'policy_dropped');
  assert.equal(h.posts().length, 1, 'silent');
  assert.equal(h.claims().at(-1).status, 'consumed', 'the cooldown still runs');
  assert.ok(h.reservations(ordinary).find((r) => r.category === 'reply').actual_micros > 0, 'the money is not zeroed');
  await h.close();
});

test('the model is not asked again after a drop', async () => {
  const h = await seamStack();
  h.replyText = `可以 ${HIT}`;
  await h.sendAndFlush(h.at({ text: '问一个问题' }));
  assert.equal(h.seen.length, 1);
  assert.equal(h.decideCalls.length, 0);
  await h.close();
});

test('dry-run: a hit is still only a rule result, and nothing posts', async () => {
  const h = await seamStack({ effective: makeEffective({ mode: 'dry-run' }) });
  const e = await h.sendAndFlush(h.event({ text: HIT }));
  assert.equal(h.state(e), 'dry_run:rule');
  const at = await h.sendAndFlush(h.at({ text: HIT }));
  assert.equal(h.state(at), 'dry_run:would_at');
  assert.equal(h.seen.length + h.posts().length, 0);
  await h.close();
});

test('last: every POST across a mixed run is legal', async () => {
  const h = await seamStack();
  await h.sendAndFlush(h.at({ text: '第一个提问' }));
  h.nextTurn();
  await h.sendAndFlush(h.event({ text: HIT }));
  h.nextTurn();
  h.replyText = `可以 ${HIT}`;
  await h.sendAndFlush(h.at({ text: '第二个提问' }));
  assertEveryPostLegal(h, { minPosts: 2 });
  await h.close();
});
