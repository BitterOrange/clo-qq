// Section 6.3 through the real SDK and the real Gateway: platform codes come back as HTTP errors from the
// mock, the SDK raises ApiError, and the exit decides. The full table is in unit/qq-send-results.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fullAt, nextId, plain, push } from '../fixtures/qq-events.mjs';
import { assertEveryPostLegal, GROUP_A, sleep, startStack, unexpectedNetAttempts } from '../harness/gateway.mjs';

const CLEAN = '普通回答。';
const reject = (code, status = 400) => ({ status, body: { code, message: `platform says ${code}` } });

let s;

before(async () => {
  s = await startStack({ label: 'senderr', script: () => ({ text: CLEAN }), groups: { [GROUP_A]: { interject: false } } });
  await s.waitConnected();
});

after(async () => {
  await s?.stop();
  s?.cleanup();
});

function scriptSequence(steps) {
  let n = 0;
  s.qq.setSendScript(() => steps[Math.min(n++, steps.length - 1)]);
}

async function ask(text = '问一句') {
  const id = nextId();
  const posts = s.messagePosts().length;
  push(s, fullAt(text, { id }));
  const row = await s.waitRow(id);
  await sleep(100);
  return { id, row, fresh: s.postBodies().slice(posts) };
}

test('positive control: a plain 200 completes', async () => {
  s.qq.setSendScript(null);
  const { row, fresh } = await ask();
  assert.equal(`${row.state}:${row.reason}`, 'completed:sent');
  assert.equal(fresh.length, 1);
});

test('40034006 content violation: one POST, no retry, no reword, no fixed line', async () => {
  scriptSequence([reject(40034006)]);
  const { id, row, fresh } = await ask();
  assert.equal(`${row.state}:${row.reason}`, 'failed:platform_violation');
  assert.equal(fresh.length, 1, 'the attempt itself, nothing after it');
  assert.equal(s.sends(id).at(-1).state, 'failed');
  assert.equal(s.sends(id).at(-1).qq_code, 40034006);
  assert.equal(s.control('interject_paused'), null, 'one violation does not latch');
});

test('a second 40034006 the same day latches interjection and alerts', async () => {
  scriptSequence([reject(40034006)]);
  const { row } = await ask();
  assert.equal(row.reason, 'platform_violation');
  assert.equal(s.control('interject_paused'), 'platform_violation');
  assert.ok(s.alerts().some((a) => a.kind === 'interject_latched'));
  await s.writeStore((store) => store.delControl('interject_paused'));
});

test('40054010 URL refused: one resend with URLs removed under a new seq, then done', async () => {
  s.model.setScript(() => ({ text: '看这里 https://member.example/a 就行' }));
  scriptSequence([reject(40054010), { status: 200 }]);
  const { id, row, fresh } = await ask('https://member.example/a 这个怎么样');
  assert.equal(`${row.state}:${row.reason}`, 'completed:sent');
  assert.equal(fresh.length, 2);
  assert.ok(fresh[0].content.includes('https://member.example/a'), 'the inbound URL was allowed the first time');
  assert.ok(!fresh[1].content.includes('http'), 'removed outright, never disguised');
  assert.ok(fresh[1].content.includes('[链接已移除]'));
  assert.ok(fresh[1].msg_seq > fresh[0].msg_seq);
  assert.deepEqual(s.sends(id).map((r) => [r.kind, r.state]), [['reply', 'failed'], ['reply_url_stripped', 'sent']]);
});

test('40054010 twice: group_error, no third attempt', async () => {
  scriptSequence([reject(40054010), reject(40054010)]);
  const { row, fresh } = await ask('https://member.example/a 再问一次');
  assert.equal(`${row.state}:${row.reason}`, 'failed:group_error');
  assert.equal(fresh.length, 2);
  s.model.setScript(() => ({ text: CLEAN }));
});

test('40054005 dedupe with no prior text is uncertain and is not assumed sent', async () => {
  scriptSequence([reject(40054005)]);
  const { id, row, fresh } = await ask();
  assert.equal(`${row.state}:${row.reason}`, 'failed:send_uncertain');
  assert.equal(fresh.length, 1);
  assert.equal(s.sends(id).at(-1).state, 'uncertain');
});

test('40034128 passive window expired: failed, alert for a required turn, never proactive', async () => {
  scriptSequence([reject(40034128)]);
  const { id, row, fresh } = await ask();
  assert.equal(`${row.state}:${row.reason}`, 'failed:passive_expired');
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].msg_id, id, 'it carried msg_id, and nothing tried without one');
  assert.ok(s.alerts().some((a) => a.kind === 'passive_expired'));
});

test('a 200 with no id is uncertain, an unknown code is uncertain, and neither is re-posted', async () => {
  scriptSequence([{ status: 200, body: { timestamp: 'now' } }]);
  const first = await ask();
  assert.equal(`${first.row.state}:${first.row.reason}`, 'failed:send_uncertain');
  assert.equal(first.fresh.length, 1);
  scriptSequence([reject(99999)]);
  const second = await ask();
  assert.equal(`${second.row.state}:${second.row.reason}`, 'failed:send_uncertain');
  assert.equal(second.fresh.length, 1);
});

test('a plain ordinary message on the same stack still ends where it should', async () => {
  s.qq.setSendScript(null);
  const id = nextId();
  push(s, plain('随便说一句话', { id }));
  assert.equal((await s.waitRow(id)).reason, 'interject_off');
});

test('40054002 group gone: this group pauses itself and alerts; the next message is paused', async () => {
  scriptSequence([reject(40054002)]);
  const { row } = await ask();
  assert.equal(`${row.state}:${row.reason}`, 'failed:group_error');
  assert.notEqual(s.control(`group_paused:${s.key(GROUP_A)}`), null);
  assert.ok(s.alerts().some((a) => a.kind === 'group_error'));
  s.qq.setSendScript(null);
  const posts = s.messagePosts().length;
  const next = await ask();
  assert.equal(next.row.state, 'paused');
  assert.equal(s.messagePosts().length, posts);
  await s.writeStore((store) => store.delControl(`group_paused:${s.key(GROUP_A)}`));
});

test('last: every POST on this stack is legal', () => {
  assertEveryPostLegal(s, { minPosts: 8 });
  assert.deepEqual(unexpectedNetAttempts(s.gw), []);
});
