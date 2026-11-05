import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startMockQq } from '../harness/mock-qq.mjs';
import { LISTENER_INTENTS, runListener } from '../../src/tools/qq-listener.mjs';
import { hashId, idCase, parseQqEnv, scrub, shapeOf } from '../../src/tools/qq-shape.mjs';

const SECRET_TEXT = 'SENTINEL_BODY_不该出现';
const SECRET_NAME = 'SENTINEL_NAME';
const SECRET_ID = 'SENTINELOPENIDabc123';

const until = async (cond, what) => {
  const end = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

function groupEvent(extra = {}) {
  return {
    id: 'MSGID1',
    content: `<@!bot> ${SECRET_TEXT} https://example.com`,
    timestamp: new Date().toISOString(),
    author: { member_openid: SECRET_ID, username: SECRET_NAME, bot: false },
    group_openid: 'GROUPOPENID1',
    mentions: [{ scope: 'single', member_openid: SECRET_ID, nickname: SECRET_NAME, bot: true, is_you: true }],
    attachments: [{ content_type: 'image/png', url: 'https://example.com/secret.png', filename: SECRET_NAME }],
    message_scene: { source: 'default', ext: ['msg_idx=REFIDX1', `secret=${SECRET_TEXT}`] },
    message_type: 0,
    ...extra,
  };
}

async function withListener(fn) {
  const mock = await startMockQq();
  const dir = mkdtempSync(join(tmpdir(), 'clo-q0-'));
  const capturePath = join(dir, 'cap.jsonl');
  const ac = new AbortController();
  const said = [];
  const run = runListener({
    appId: 'APP1', secret: 'SECRET_VALUE', apiBase: mock.base, tokenBase: mock.base,
    capturePath, salt: 'test-salt', signal: ac.signal, say: (s) => said.push(s),
  });
  try {
    await until(() => mock.connected() > 0 && mock.identifies.length > 0, 'identify');
    await fn({ mock, capturePath, said, run });
  } finally {
    ac.abort();
    await run.catch(() => {});
    await mock.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('identifies with only the group-and-C2C intent bit', async () => {
  await withListener(async ({ mock }) => {
    assert.equal(mock.identifies[0].intents, 1 << 25);
    assert.equal(LISTENER_INTENTS, 1 << 25);
  });
});

test('capture and console contain no text, names, raw IDs, secret or token', async () => {
  await withListener(async ({ mock, capturePath, said }) => {
    await until(() => said.some((s) => s.startsWith('Connected')), 'ready');
    mock.push('GROUP_AT_MESSAGE_CREATE', groupEvent());
    mock.push('GROUP_MESSAGE_CREATE', groupEvent({ id: 'MSGID2', mentions: [] }));
    mock.push('C2C_MESSAGE_CREATE', { id: 'MSGID3', content: SECRET_TEXT, timestamp: new Date().toISOString(), author: { user_openid: SECRET_ID } });
    mock.push('GROUP_ADD_ROBOT', { group_openid: 'GROUPOPENID1', op_member_openid: SECRET_ID, timestamp: 1 });
    await until(() => readFileSync(capturePath, 'utf8').split('\n').filter(Boolean).length >= 5, 'capture lines');
    const all = readFileSync(capturePath, 'utf8') + said.join('\n');
    for (const s of [SECRET_TEXT, SECRET_NAME, SECRET_ID, 'GROUPOPENID1', 'MSGID1', 'REFIDX1', 'SECRET_VALUE', 'mock-access-token', 'secret.png', 'example.com']) {
      assert.ok(!all.includes(s), `capture leaked ${s}`);
    }
  });
});

test('records what Q0a must decide: event type, is_you, bot flag, self echo, ID stability', async () => {
  await withListener(async ({ mock, capturePath, said }) => {
    await until(() => said.some((s) => s.startsWith('Connected')), 'ready');
    mock.push('GROUP_AT_MESSAGE_CREATE', groupEvent());
    mock.push('GROUP_MESSAGE_CREATE', groupEvent({ id: 'MSGID2', mentions: [], author: { member_openid: SECRET_ID, bot: true } }));
    await until(() => readFileSync(capturePath, 'utf8').split('\n').filter(Boolean).length >= 3, 'capture lines');
    const recs = readFileSync(capturePath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const at = recs.find((r) => r.event === 'GROUP_AT_MESSAGE_CREATE');
    const all = recs.find((r) => r.event === 'GROUP_MESSAGE_CREATE');
    assert.equal(at.mentions[0].is_you, true);
    assert.equal(at.mentions[0].bot, true);
    assert.equal(at.content.hasAtTag, true);
    assert.equal(at.content.hasUrl, true);
    assert.deepEqual(at.attachments, ['image/png']);
    assert.deepEqual(at.sceneExtKeys, ['msg_idx', 'secret']);
    assert.equal(all.authorBot, true);
    assert.equal(at.sender, all.sender, 'the same member must hash to the same value');
    assert.equal(at.group, all.group);
    assert.equal(at.senderCase, 'mixed');
    assert.ok(typeof at.skewMs === 'number');
  });
});

test('makes no request other than the token and GET /gateway', async () => {
  await withListener(async ({ mock, said, capturePath }) => {
    await until(() => said.some((s) => s.startsWith('Connected')), 'ready');
    mock.push('GROUP_AT_MESSAGE_CREATE', groupEvent());
    await until(() => readFileSync(capturePath, 'utf8').includes('GROUP_AT_MESSAGE_CREATE'), 'event');
    const seen = new Set(mock.requests.map((r) => `${r.method} ${r.path}`));
    assert.deepEqual([...seen].sort(), ['GET /gateway', 'POST /app/getAppAccessToken']);
  });
});

test('source has no send capability', () => {
  const src = readFileSync(new URL('../../src/tools/qq-listener.mjs', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  for (const banned of [/\bQQBot\s*\(/, /\bMessageApi\b/, /\bApiClient\b/, /\.send[A-Z]?\w*\(/, /sendWakeup/, /OPENROUTER/i, /CLO_CHAT_API_KEY/, /CLO_SEARCH_API_KEY/, /method:\s*'(POST|PUT|PATCH|DELETE)'/, /FULL_INTENTS/]) {
    assert.ok(!banned.test(code), `listener source matches ${banned}`);
  }
});

test('stops without retrying on close code 4914 or 4915 and reports the code', async () => {
  for (const code of [4914, 4915]) {
    const mock = await startMockQq();
    const dir = mkdtempSync(join(tmpdir(), 'clo-q0-'));
    const ac = new AbortController();
    const run = runListener({
      appId: 'APP1', secret: 'SECRET_VALUE', apiBase: mock.base, tokenBase: mock.base,
      capturePath: join(dir, 'cap.jsonl'), salt: 's', signal: ac.signal, say: () => {},
    });
    await until(() => mock.connected() > 0 && mock.identifies.length > 0, 'identify');
    mock.closeAll(code);
    await assert.rejects(run, new RegExp(String(code)));
    assert.equal(mock.identifies.length, 1, 'must not reconnect');
    ac.abort();
    await mock.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('env parsing loads only the QQ credentials', () => {
  const env = parseQqEnv('CLO_QQ_APP_ID=1\r\nCLO_QQ_APP_SECRET="s e"\nCLO_CHAT_API_KEY=sk-x\nCLO_SEARCH_API_KEY=sk-y\nOPENROUTER_API_KEY=sk-z\n# comment\n');
  assert.deepEqual(env, { CLO_QQ_APP_ID: '1', CLO_QQ_APP_SECRET: 's e' });
});

test('shape, hash, case and scrub helpers', () => {
  assert.deepEqual(shapeOf({ a: 'xyz', b: [1], c: null }), { a: 'string(3)', b: { array: 1, first: 'number' }, c: 'null' });
  assert.equal(hashId('s', 'abc'), hashId('s', 'abc'));
  assert.notEqual(hashId('s', 'abc'), hashId('t', 'abc'));
  assert.equal(hashId('s', ''), null);
  assert.equal(idCase('aB1'), 'mixed');
  assert.equal(idCase('AB1'), 'upper');
  assert.equal(idCase('ab1'), 'lower');
  assert.equal(scrub('x SECRET QQBot tok123 y', ['SECRET']), 'x <redacted> QQBot <redacted> y');
});
