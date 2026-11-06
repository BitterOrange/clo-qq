// TQ15 on the own runtime: two groups whose IDs differ only by case stay separate. The host kept one session per
// group; here each group has its own memory ring, and that is what is checked, on the request the model receives.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fullAt, nextId, push } from '../fixtures/qq-events.mjs';
import { assertEveryPostLegal, netAttempts, startOwnStack, until } from '../harness/own.mjs';

const UPPER = 'CASEGROUPOPENIDABCDEF000000000000';
const LOWER = 'casegroupopenidabcdef000000000000';
const CANARY_UPPER = '大写群金丝雀UPPERCANARY4421';
const CANARY_LOWER = '小写群金丝雀LOWERCANARY4421';
const REPLY_UPPER = '大写群的回复UPPERREPLY4421';
const REPLY_LOWER = '小写群的回复LOWERREPLY4421';
const promptOf = (rec) => JSON.stringify(rec.body.messages);
const payloadOf = (rec) => {
  const c = rec.body.messages.find((m) => m.role === 'user').content;
  return JSON.parse(c.slice(c.indexOf('\n') + 1));
};

let s;
let replyText = REPLY_UPPER;

before(async () => {
  s = await startOwnStack({ label: 'ident', groups: { [UPPER]: {}, [LOWER]: {} }, script: () => ({ text: replyText }) });
});

after(async () => {
  await s?.stop();
  s?.cleanup();
});

test('one group talks first, and its own second turn does see the canary and her reply (positive control)', async () => {
  replyText = REPLY_UPPER;
  const first = nextId();
  push(s, fullAt(CANARY_UPPER, { id: first, group: UPPER }));
  await s.waitRow(first);
  const second = nextId();
  push(s, fullAt('刚才我说了什么', { id: second, group: UPPER }));
  await s.waitRow(second);
  const { recent } = payloadOf(s.model.agentRequests().at(-1));
  assert.ok(recent.some((r) => r.text === CANARY_UPPER), 'same group, second turn: the ring holds the line');
  assert.ok(recent.some((r) => r.who === '可洛' && r.text === REPLY_UPPER), 'and her own reply');
});

test('the group differing only by case has its own ring: no canary and no reply crosses', async () => {
  replyText = REPLY_LOWER;
  const id = nextId();
  push(s, fullAt(CANARY_LOWER, { id, group: LOWER }));
  await s.waitRow(id);
  const req = s.model.agentRequests().at(-1);
  assert.equal(payloadOf(req).text, CANARY_LOWER, 'positive control: this is the right request');
  assert.deepEqual(payloadOf(req).recent, [], 'a new group starts with nothing');
  assert.ok(!promptOf(req).includes('UPPERCANARY4421') && !promptOf(req).includes('UPPERREPLY4421'), "the other group's text is not in this prompt");

  replyText = REPLY_UPPER;
  const back = nextId();
  push(s, fullAt('回到大写群', { id: back, group: UPPER }));
  await s.waitRow(back);
  const again = promptOf(s.model.agentRequests().at(-1));
  assert.ok(again.includes('UPPERCANARY4421'));
  assert.ok(!again.includes('LOWERCANARY4421') && !again.includes('LOWERREPLY4421'));
});

test('POST paths keep the exact case, each going back to its own group', () => {
  const paths = new Set(s.postBodies().map((p) => p.path));
  assert.ok(paths.has(`/v2/groups/${UPPER}/messages`));
  assert.ok(paths.has(`/v2/groups/${LOWER}/messages`));
});

test('the raw group id never reaches a prompt', () => {
  assert.ok(s.model.requests.length >= 4, 'positive control: there are requests to read');
  for (const rec of s.model.requests) {
    const prompt = promptOf(rec);
    assert.ok(!prompt.includes(UPPER) && !prompt.includes(LOWER));
  }
});

test('events are keyed separately: the two groups are two group keys', () => {
  assert.notEqual(s.key(UPPER), s.key(LOWER));
  const groups = s.withDb((db) => db.prepare('SELECT DISTINCT group_key FROM events').all()).map((r) => r.group_key).sort();
  assert.deepEqual(groups, [s.key(UPPER), s.key(LOWER)].sort());
});

test('last: every POST on this stack is legal', async () => {
  await until(() => s.messagePosts().length >= 4, 'posts', 5000);
  assertEveryPostLegal(s, { minPosts: 4 });
  assert.deepEqual(netAttempts(s), []);
});
