// A4 on the own runtime: recent group lines reach the model as the recent list under pseudonyms, her own sent replies
// join them under her name, other groups stay out, and no turn text is written anywhere on disk.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { atOther, fullAt, nextId, plain, push } from '../fixtures/qq-events.mjs';
import { assertEveryPostLegal, GROUP_A, GROUP_B, MEMBER, MEMBER2, netAttempts, sleep, startOwnStack, until } from '../harness/own.mjs';

const LINE_A = '上下文金丝雀甲CONTEXTA9931';
const LINE_B = '上下文金丝雀乙CONTEXTB9931';
const OTHER_GROUP = '别的群金丝雀CONTEXTC9931';
const REPLY = '看过了REPLYMARK9931。';
const promptOf = (rec) => JSON.stringify(rec.body.messages);
const payloadOf = (rec) => {
  const c = rec.body.messages.find((m) => m.role === 'user').content;
  return JSON.parse(c.slice(c.indexOf('\n') + 1));
};

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
// Everything the bot or the console wrote under the test root: database and WAL, event log, bot logs, controls.
const diskBytes = (s) => walk(s.tmp).map((f) => {
  try {
    return readFileSync(f);
  } catch {
    return Buffer.alloc(0);
  }
});
const inBytes = (buffers, text) => buffers.some((b) => b.includes(Buffer.from(text, 'utf8')));

let s;

before(async () => {
  s = await startOwnStack({ label: 'ctx', groups: { [GROUP_A]: {}, [GROUP_B]: {} }, script: () => ({ text: REPLY }) });
});

after(async () => {
  await s?.stop();
  s?.cleanup();
});

test('ordinary lines that did not trigger anything are in the next prompt, under pseudonyms', async () => {
  const a = nextId();
  const b = nextId();
  push(s, plain(LINE_A, { id: a, member: MEMBER }));
  push(s, atOther(LINE_B, { id: b, member: MEMBER2 }));
  await Promise.all([s.waitRow(a), s.waitRow(b)]);
  assert.equal(s.model.requests.length, 0, 'no model for those lines');

  const id = nextId();
  push(s, fullAt('上面他们说的什么', { id, member: MEMBER }));
  await s.waitRow(id);
  const req = s.model.agentRequests()[0];
  const { recent, speaker, text } = payloadOf(req);
  assert.equal(text, '上面他们说的什么');
  assert.deepEqual(recent.map((r) => [r.who, r.text]), [['U1', LINE_A], ['U2', `@群友 ${LINE_B}`]], 'both lines, oldest first, under codes, the other mention as a placeholder');
  assert.equal(speaker, 'U1', 'the current speaker is the same code as their earlier line');
  const prompt = promptOf(req);
  assert.ok(!prompt.includes(MEMBER) && !prompt.includes(MEMBER2), 'no openid');
  assert.ok(!prompt.includes('SENDER-DISPLAY-NAME') && !prompt.includes('OTHER-DISPLAY-NAME'), 'no display name');
});

test('the current message is not repeated as its own history', () => {
  const prompt = promptOf(s.model.agentRequests()[0]);
  assert.equal(prompt.split('上面他们说的什么').length - 1, 1, 'once');
});

test('her own sent reply is in the next prompt under her name, and the addressed line before it too', async () => {
  const id = nextId();
  push(s, fullAt('你刚才怎么说的', { id, member: MEMBER2 }));
  await s.waitRow(id);
  const { recent } = payloadOf(s.model.agentRequests().at(-1));
  const own = recent.filter((r) => r.who === '可洛');
  assert.deepEqual(own.map((r) => r.text), [REPLY], 'her reply as it was posted, once');
  assert.ok(recent.some((r) => r.who === 'U1' && r.text === '上面他们说的什么'), 'the question it answered');
  const order = recent.map((r) => r.text);
  assert.ok(order.indexOf('上面他们说的什么') < order.indexOf(REPLY), 'question before answer');
});

test('a line from another group is not in this group\'s prompt', async () => {
  const other = nextId();
  push(s, plain(OTHER_GROUP, { id: other, group: GROUP_B }));
  await s.waitRow(other);
  const id = nextId();
  push(s, fullAt('本群再问', { id }));
  await s.waitRow(id);
  const req = s.model.agentRequests().at(-1);
  assert.equal(payloadOf(req).text, '本群再问', 'positive control: the right request');
  assert.ok(!promptOf(req).includes('CONTEXTC9931'));
});

test('no turn text is on disk: not the lines, not the question, not her reply (the host transcript is gone)', async () => {
  await sleep(500);
  const buffers = diskBytes(s);
  const known = s.allSends()[0].event_key;
  assert.ok(inBytes(buffers, known), 'positive control: the scan finds a string known to be on disk');
  for (const t of ['CONTEXTA9931', 'CONTEXTB9931', 'CONTEXTC9931', '上面他们说的什么', '你刚才怎么说的', 'REPLYMARK9931']) {
    assert.ok(!inBytes(buffers, t), `${t} on disk`);
  }
});

test('a message caught by a local rule never enters the context', async () => {
  const hit = nextId();
  push(s, plain('加我 约炮', { id: hit }));
  await s.waitRow(hit);
  const id = nextId();
  push(s, fullAt('还是我', { id }));
  await s.waitRow(id);
  const req = s.model.agentRequests().at(-1);
  assert.equal(payloadOf(req).text, '还是我', 'positive control');
  assert.ok(payloadOf(req).recent.length > 0, 'positive control: there is a recent list');
  assert.ok(!promptOf(req).includes('约炮'));
});

test('last: every POST on this stack is legal', async () => {
  await until(() => s.messagePosts().length >= 2, 'posts', 3000);
  assertEveryPostLegal(s, { minPosts: 2 });
  assert.deepEqual(netAttempts(s), []);
});
