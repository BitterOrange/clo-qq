import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cleanChildEnv } from '../harness/clean-env.mjs';
import { startMockQq } from '../harness/mock-qq.mjs';
import { buildRequest, CASES, isTrigger, runProbe, TRIGGER } from '../../src/tools/qq-send-probe.mjs';
import { hashId } from '../../src/tools/qq-shape.mjs';

const SALT = 'test-salt';
const GROUP = 'GROUPALLOWED';
const ALLOW = hashId(SALT, GROUP);

const until = async (cond, what) => {
  const end = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

const groupEvent = (over = {}) => ({
  id: 'MSG1', content: TRIGGER, timestamp: new Date().toISOString(),
  author: { member_openid: 'MEMBER1', bot: false }, group_openid: GROUP, message_type: 0, ...over,
});

const sends = (mock) => mock.requests.filter((r) => r.method === 'POST' && r.path.startsWith('/v2/'));

async function withProbe(fn, caseName = 'passive-text') {
  const mock = await startMockQq();
  const dir = mkdtempSync(join(tmpdir(), 'clo-q0b-'));
  const ac = new AbortController();
  const said = [];
  const run = runProbe({
    caseName, allowHash: ALLOW, appId: 'A', secret: 'SECRET_VALUE', apiBase: mock.base, tokenBase: mock.base,
    salt: SALT, resultPath: join(dir, 'r.jsonl'), signal: ac.signal, say: (s) => said.push(s), echoWatchMs: 50,
  });
  try {
    await until(() => said.some((s) => s.startsWith('Connected')), 'ready');
    await fn({ mock, ac, run, said, resultPath: join(dir, 'r.jsonl') });
  } finally {
    ac.abort();
    await run.catch(() => {});
    await mock.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('replies once to the exact trigger from the allowed group, with msg_id and msg_seq', async () => {
  await withProbe(async ({ mock }) => {
    mock.push('GROUP_MESSAGE_CREATE', groupEvent());
    await until(() => sends(mock).length === 1, 'send');
    mock.push('GROUP_MESSAGE_CREATE', groupEvent({ id: 'MSG2' }));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sends(mock).length, 1, 'must not send twice');
    const req = sends(mock)[0];
    assert.equal(req.path, `/v2/groups/${GROUP}/messages`);
    assert.deepEqual(JSON.parse(req.body), { msg_type: 0, msg_seq: 1, content: CASES['passive-text'].content, msg_id: 'MSG1' });
  });
});

test('ignores other text, other groups and bot authors, with a positive control after', async () => {
  await withProbe(async ({ mock }) => {
    mock.push('GROUP_MESSAGE_CREATE', groupEvent({ content: '随便聊聊' }));
    mock.push('GROUP_MESSAGE_CREATE', groupEvent({ group_openid: 'GROUPOTHER' }));
    mock.push('GROUP_MESSAGE_CREATE', groupEvent({ author: { member_openid: 'BOT', bot: true } }));
    mock.push('GROUP_MESSAGE_CREATE', groupEvent({ id: 'MSGOK' }));
    await until(() => sends(mock).length === 1, 'send');
    assert.equal(JSON.parse(sends(mock)[0].body).msg_id, 'MSGOK');
  });
});

test('accepts the trigger with an @ tag and a leading space', () => {
  const c = CASES['passive-text'];
  const msg = (content) => ({ kind: 'group', senderIsBot: false, groupOpenid: GROUP, content });
  assert.ok(isTrigger(msg(`<@!ABC> ${TRIGGER}`), c, ALLOW, SALT));
  assert.ok(isTrigger(msg(` ${TRIGGER}`), c, ALLOW, SALT));
  assert.ok(!isTrigger(msg(`${TRIGGER} 再加几个字`), c, ALLOW, SALT));
});

test('the result line has no text or IDs, and the send is not repeated', async () => {
  await withProbe(async ({ mock, resultPath }) => {
    mock.push('GROUP_MESSAGE_CREATE', groupEvent());
    await until(() => sends(mock).length === 1, 'send');
    await until(() => { try { return readFileSync(resultPath, 'utf8').includes('passive-text'); } catch { return false; } }, 'result');
    const line = readFileSync(resultPath, 'utf8');
    for (const s of [TRIGGER, GROUP, 'MSG1', 'SECRET_VALUE', 'mock-access-token']) assert.ok(!line.includes(s), `result leaked ${s}`);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(sends(mock).length, 1);
  });
});

test('proactive case refuses a target that does not match the allowed hash', async () => {
  const mock = await startMockQq();
  const dir = mkdtempSync(join(tmpdir(), 'clo-q0b-'));
  await assert.rejects(runProbe({
    caseName: 'dm-proactive', allowHash: ALLOW, appId: 'A', secret: 'S', apiBase: mock.base, tokenBase: mock.base,
    salt: SALT, resultPath: join(dir, 'r.jsonl'), savedTarget: 'SOMEONEELSE', say: () => {},
  }), /does not match/);
  assert.equal(sends(mock).length, 0);
  await mock.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('request shapes: markdown, passive needs msg_id, proactive has none', () => {
  assert.deepEqual(buildRequest('passive-markdown', 'G', 'M').body.markdown, { content: CASES['passive-markdown'].markdown });
  assert.throws(() => buildRequest('passive-text', 'G', null), /needs an inbound/);
  assert.equal(buildRequest('dm-proactive', 'U', null).body.msg_id, undefined);
  assert.equal(buildRequest('dm-proactive', 'U', null).path, '/v2/users/U/messages');
  assert.throws(() => buildRequest('anything-else', 'G', 'M'), /Unknown case/);
});

test('without --approve it shows the text and sends nothing', () => {
  const probe = fileURLToPath(new URL('../../src/tools/qq-send-probe.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [probe, '--case', 'passive-text', '--allow', ALLOW], { cwd: tmpdir(), env: cleanChildEnv(), encoding: 'utf8', timeout: 20000, windowsHide: true });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Not approved, so nothing was sent/);
  assert.ok(r.stdout.includes(CASES['passive-text'].content));
});

test('source allows no free-text send', () => {
  const src = readFileSync(new URL('../../src/tools/qq-send-probe.mjs', import.meta.url), 'utf8');
  assert.ok(!/arg\('(text|content|message|target)'\)/.test(src));
  assert.ok(!/OPENROUTER|CLO_CHAT_API_KEY|CLO_SEARCH_API_KEY/i.test(src));
  assert.ok(!/FULL_INTENTS/.test(src));
});
