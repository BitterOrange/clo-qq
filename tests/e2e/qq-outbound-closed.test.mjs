// TQ16: the host's own send path is closed. Replaces the old zero-POST check, which could not fail:
// it now needs a non-zero exit, our closed message or log line, and a POST from the same stack first.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fullAt, nextId, push } from '../fixtures/qq-events.mjs';
import { assertEveryPostLegal, GROUP_A, sleep, startStack, unexpectedNetAttempts } from '../harness/gateway.mjs';

let s;

before(async () => {
  s = await startStack({ label: 'closed', script: () => ({ text: '对照回复。' }) });
  await s.waitConnected();
});

after(async () => {
  await s?.stop();
  s?.cleanup();
});

const sendViaCli = (target) => s.gw.cli(['message', 'send', '--channel', 'clo-qq', '--target', target, '--message', '不该发出的文字'], { timeoutMs: 120000 });

test('positive control: a pushed event produces one POST', async () => {
  const id = nextId();
  push(s, fullAt('对照', { id }));
  await s.waitRow(id);
  assert.equal(s.messagePosts().length, 1);
});

test('openclaw message send to group:<id> reaches our closed sendText, fails, and posts nothing', async () => {
  const posts = s.messagePosts().length;
  const r = sendViaCli(`group:${GROUP_A}`);
  assert.notEqual(r.status, 0, `exit ${r.status}: ${r.stdout.slice(0, 300)}`);
  const closed = /outbound\.sendText is closed/.test(`${r.stdout}\n${r.stderr}`) || s.event('outbound_send_attempt').length > 0;
  assert.ok(closed, `no closed marker. stdout: ${r.stdout.slice(0, 300)} stderr: ${r.stderr.slice(0, 300)}`);
  await sleep(1000);
  assert.equal(s.messagePosts().length, posts, 'zero new POST');
  assert.ok(!s.postBodies().some((p) => p.content.includes('不该发出的文字')));
});

test('a bare id is refused by the host before it reaches the channel, and posts nothing', async () => {
  const posts = s.messagePosts().length;
  const r = sendViaCli(GROUP_A);
  assert.notEqual(r.status, 0);
  await sleep(1000);
  assert.equal(s.messagePosts().length, posts);
});

test('last: every POST on this stack is legal', () => {
  assertEveryPostLegal(s, { minPosts: 1 });
  assert.deepEqual(unexpectedNetAttempts(s.gw), []);
});
