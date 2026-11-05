// TQ15 on the real Gateway: two groups whose IDs differ only by case stay separate. Before the peer id
// fix a verifier saw the second group's prompt carry the first group's text.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fullAt, nextId, push } from '../fixtures/qq-events.mjs';
import { assertEveryPostLegal, startStack, unexpectedNetAttempts, until } from '../harness/gateway.mjs';

const UPPER = 'CASEGROUPOPENIDABCDEF000000000000';
const LOWER = 'casegroupopenidabcdef000000000000';
const CANARY_UPPER = '大写群金丝雀UPPERCANARY4421';
const CANARY_LOWER = '小写群金丝雀LOWERCANARY4421';
const promptOf = (rec) => JSON.stringify(rec.body.messages);

let s;

before(async () => {
  s = await startStack({ label: 'ident', groups: { [UPPER]: {}, [LOWER]: {} }, script: () => ({ text: '记下了。' }) });
  await s.waitConnected();
});

after(async () => {
  await s?.stop();
  s?.cleanup();
});

test('one group talks first, and its own second turn does see the canary (positive control)', async () => {
  const first = nextId();
  push(s, fullAt(CANARY_UPPER, { id: first, group: UPPER }));
  await s.waitRow(first);
  const second = nextId();
  push(s, fullAt('刚才我说了什么', { id: second, group: UPPER }));
  await s.waitRow(second);
  assert.ok(promptOf(s.model.agentRequests().at(-1)).includes(CANARY_UPPER), 'same group, second turn: the session holds it');
});

test('the group differing only by case has its own session: no canary crosses', async () => {
  const id = nextId();
  push(s, fullAt(CANARY_LOWER, { id, group: LOWER }));
  await s.waitRow(id);
  const prompt = promptOf(s.model.agentRequests().at(-1));
  assert.ok(prompt.includes(CANARY_LOWER), 'positive control: this is the right request');
  assert.ok(!prompt.includes(CANARY_UPPER), "the other group's text is not in this prompt");

  const back = nextId();
  push(s, fullAt('回到大写群', { id: back, group: UPPER }));
  await s.waitRow(back);
  const again = promptOf(s.model.agentRequests().at(-1));
  assert.ok(again.includes(CANARY_UPPER));
  assert.ok(!again.includes(CANARY_LOWER));
});

test('the host holds two session keys, neither carrying a raw group id', async () => {
  const r = s.gw.cli(['sessions', '--json', '--all-agents']);
  const text = r.stdout || '';
  const keys = [...new Set((text.match(/agent:main:clo-qq:group:[0-9a-z]+/g) ?? []))];
  assert.equal(keys.length, 2, `sessions output: ${text.slice(0, 400)} / ${r.stderr.slice(0, 200)}`);
  assert.ok(!text.includes(UPPER) && !text.includes(LOWER));
});

test('POST paths keep the exact case, each going back to its own group', async () => {
  const paths = new Set(s.postBodies().map((p) => p.path));
  assert.ok(paths.has(`/v2/groups/${UPPER}/messages`));
  assert.ok(paths.has(`/v2/groups/${LOWER}/messages`));
});

test('the raw group id never reaches a prompt', () => {
  for (const rec of s.model.requests) {
    const prompt = promptOf(rec);
    assert.ok(!prompt.includes(UPPER) && !prompt.includes(LOWER));
  }
});

test('events are keyed separately: same text from both groups is two rows', () => {
  assert.notEqual(s.key(UPPER), s.key(LOWER));
  const groups = s.withDb((db) => db.prepare('SELECT DISTINCT group_key FROM events').all());
  assert.equal(groups.length, 2);
});

test('last: every POST on this stack is legal', async () => {
  await until(() => s.messagePosts().length >= 4, 'posts', 5000);
  assertEveryPostLegal(s, { minPosts: 4 });
  assert.deepEqual(unexpectedNetAttempts(s.gw), []);
});
