// A4: recent group lines reach the model as history, stay bounded, and are not written to the host transcript.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { atOther, fullAt, nextId, plain, push } from '../fixtures/qq-events.mjs';
import { assertEveryPostLegal, GROUP_A, GROUP_B, MEMBER, MEMBER2, sleep, startStack, unexpectedNetAttempts, until } from '../harness/gateway.mjs';

const LINE_A = '上下文金丝雀甲CONTEXTA9931';
const LINE_B = '上下文金丝雀乙CONTEXTB9931';
const OTHER_GROUP = '别的群金丝雀CONTEXTC9931';
const promptOf = (rec) => JSON.stringify(rec.body.messages);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
// The host keeps sessions in its own state files, a database among them, so every byte is scanned.
const hostBytes = (s) => [...walk(s.paths.stateDir), ...walk(s.paths.home)].map((f) => {
  try {
    return readFileSync(f);
  } catch {
    return Buffer.alloc(0);
  }
});
const inBytes = (buffers, text) => buffers.some((b) => b.includes(Buffer.from(text, 'utf8')));

let s;

before(async () => {
  s = await startStack({ label: 'ctx', groups: { [GROUP_A]: {}, [GROUP_B]: {} }, script: () => ({ text: '看过了。' }) });
  await s.waitConnected();
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
  const prompt = promptOf(s.model.agentRequests()[0]);
  assert.ok(prompt.includes(LINE_A), 'first line');
  assert.ok(prompt.includes(LINE_B), 'second line');
  assert.ok(prompt.includes('U1') && prompt.includes('U2'), 'pseudonyms');
  assert.ok(!prompt.includes(MEMBER) && !prompt.includes(MEMBER2), 'no openid');
  assert.ok(!prompt.includes('SENDER-DISPLAY-NAME') && !prompt.includes('OTHER-DISPLAY-NAME'), 'no display name');
});

test('the current message is not repeated as its own history', () => {
  const prompt = promptOf(s.model.agentRequests()[0]);
  assert.equal(prompt.split('上面他们说的什么').length - 1, 1, 'once');
});

test('a line from another group is not in this group\'s prompt', async () => {
  const other = nextId();
  push(s, plain(OTHER_GROUP, { id: other, group: GROUP_B }));
  await s.waitRow(other);
  const id = nextId();
  push(s, fullAt('本群再问', { id }));
  await s.waitRow(id);
  assert.ok(!promptOf(s.model.agentRequests().at(-1)).includes(OTHER_GROUP));
});

test('non-addressed lines do not persist into the host transcript; addressed text does (control)', async () => {
  await sleep(500);
  const buffers = hostBytes(s);
  assert.ok(inBytes(buffers, '上面他们说的什么'), 'positive control: the scan can see addressed text');
  assert.ok(!inBytes(buffers, 'CONTEXTA9931'), 'first line in host state');
  assert.ok(!inBytes(buffers, 'CONTEXTB9931'), 'second line in host state');
});

test('a message caught by a local rule never enters the context', async () => {
  const hit = nextId();
  push(s, plain('加我 约炮', { id: hit }));
  await s.waitRow(hit);
  const id = nextId();
  push(s, fullAt('还是我', { id }));
  await s.waitRow(id);
  assert.ok(!promptOf(s.model.agentRequests().at(-1)).includes('约炮'));
});

test('last: every POST on this stack is legal', async () => {
  await until(() => s.messagePosts().length >= 2, 'posts', 3000);
  assertEveryPostLegal(s, { minPosts: 2 });
  assert.deepEqual(unexpectedNetAttempts(s.gw), []);
});
