// TQ12, TQ21 and the required-turn rows of the test map: QQ events through the real agent run and back.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { atAll, atBotAndAll, atImage, atOther, dm, fullAt, groupAtOff, imageOnly, nextId, plain, push, quoted } from '../fixtures/qq-events.mjs';
import { assertAgentRequest, assertEveryPostLegal, BOT_MEMBER, FAKE_MODEL_KEY, FAKE_QQ_SECRET, GROUP_A, GROUP_B, MEMBER, sleep, startStack, unexpectedNetAttempts, until } from '../harness/gateway.mjs';

const LINES = JSON.parse(readFileSync(new URL('../../persona/policy-lines.zh.json', import.meta.url), 'utf8'));
const QUIET_MS = 1500;
const toolNames = (rec) => (rec.body.tools ?? []).map((t) => t.function?.name ?? t.name);

let s;

// A positive control for every negative below: this stack replies when it should.
async function askAndReply(text) {
  s.model.setScript(() => ({ text: '对照回复。' }));
  const posts = s.messagePosts().length;
  const id = push(s, fullAt(text));
  await s.waitRow(id);
  assert.equal(s.messagePosts().length, posts + 1, 'positive control: this stack replies');
}

before(async () => {
  s = await startStack({ label: 'group', groups: { [GROUP_A]: {} } });
  await s.waitConnected();
});

after(async () => {
  await s?.stop();
  s?.cleanup();
});

describe('real @', () => {
  test('full-message mode: a real @ reaches the provider and is delivered once with msg_id and msg_seq', async () => {
    s.model.setScript(() => ({ text: '可洛的测试回复。' }));
    const id = nextId();
    push(s, fullAt('今天怎么样', { id }));
    const row = await s.waitRow(id);
    assert.equal(`${row.state}:${row.reason}`, 'completed:sent');
    assert.equal(row.cls, 'at');

    assert.equal(s.model.agentRequests().length, 1, 'one model request');
    const req = s.model.agentRequests()[0];
    assertAgentRequest(req);
    assert.equal(req.body.stream, true);
    assert.equal(req.headers.authorization, `Bearer ${FAKE_MODEL_KEY}`);
    const prompt = JSON.stringify(req.body.messages);
    assert.ok(prompt.includes('今天怎么样'));
    assert.ok(!prompt.includes(BOT_MEMBER), 'the mention tag never reaches the model');
    assert.ok(!prompt.includes('<@'), 'no tag at all');

    const posts = s.postBodies();
    assert.equal(posts.length, 1, 'exactly one message POST');
    assert.equal(posts[0].path, `/v2/groups/${GROUP_A}/messages`);
    assert.equal(posts[0].msg_id, id);
    assert.equal(posts[0].msg_seq, 1);
    assert.equal(posts[0].msg_type, 0);
    assert.equal(posts[0].content, '可洛的测试回复。');
    assert.equal(s.sends(id)[0].state, 'sent');
    assert.equal(s.reservations(id)[0].status, 'settled');
  });

  test('the tool list is exact and nothing is forced', () => {
    const req = s.model.agentRequests()[0];
    assert.deepEqual(toolNames(req), ['clo_feature_status']);
    const choice = req.body.tool_choice;
    assert.ok(choice === undefined || choice === 'auto' || choice === 'none', `tool_choice was ${JSON.stringify(choice)}`);
  });

  test('GROUP_AT mode (full-message off): leading space, no mentions, still a real @', async () => {
    s.model.setScript(() => ({ text: '收到。' }));
    const before_ = s.messagePosts().length;
    const id = nextId();
    push(s, groupAtOff('全量关着的问题', { id }));
    const row = await s.waitRow(id);
    assert.equal(row.cls, 'at');
    assert.equal(`${row.state}:${row.reason}`, 'completed:sent');
    assert.equal(s.messagePosts().length, before_ + 1);
    assert.ok(JSON.stringify(s.model.agentRequests().at(-1).body.messages).includes('全量关着的问题'));
  });

  test('@ plus image: real @, placeholder in the text, quoted material never read', async () => {
    s.model.setScript(() => ({ text: '看不到图。' }));
    const id = nextId();
    push(s, atImage('看这个', { id }));
    const row = await s.waitRow(id);
    assert.equal(row.cls, 'at');
    const prompt = JSON.stringify(s.model.agentRequests().at(-1).body.messages);
    assert.ok(prompt.includes('[图片]'), 'placeholder');
    assert.ok(!prompt.includes('QUOTED-ELEMENT-TEXT'));
    assert.ok(!prompt.includes('PARALLEL-NODE-TEXT'));
    assert.ok(!prompt.includes('multimedia.example'), 'no attachment URL');
  });

  test('@ with @all alongside is a real @', async () => {
    s.model.setScript(() => ({ text: '好。' }));
    const id = nextId();
    push(s, atBotAndAll('大家和你都看看', { id }));
    assert.equal((await s.waitRow(id)).cls, 'at');
  });

  test('two messages in the same group get their own msg_id, each with msg_seq 1', async () => {
    s.model.setScript(() => ({ text: '第二条。' }));
    const posts = s.messagePosts().length;
    const a = push(s, fullAt('再问一句'));
    await s.waitRow(a);
    const b = push(s, fullAt('还有一句'));
    await s.waitRow(b);
    const fresh = s.postBodies().slice(posts);
    assert.deepEqual(fresh.map((p) => [p.msg_id, p.msg_seq]), [[a, 1], [b, 1]]);
  });
});

describe('no model, no reply', () => {
  test('@all alone is an ordinary message: interjection is off here, so no model and no reply', async () => {
    await askAndReply('对照一');
    const model = s.model.requests.length;
    const posts = s.messagePosts().length;
    const id = push(s, atAll('都来看看'));
    const row = await s.waitRow(id);
    assert.equal(row.cls, 'ordinary');
    await sleep(QUIET_MS);
    assert.equal(s.model.requests.length, model);
    assert.equal(s.messagePosts().length, posts);
  });

  test("another member's @ is not a real @", async () => {
    const model = s.model.requests.length;
    const id = push(s, atOther('你看这个'));
    const row = await s.waitRow(id);
    assert.equal(row.cls, 'ordinary');
    assert.equal(s.model.requests.length, model);
  });

  test('a group that is not admitted leaves no row and reaches nothing', async () => {
    const model = s.model.requests.length;
    const posts = s.messagePosts().length;
    const drops = s.event('gate_drop').length;
    const id = push(s, fullAt('外面的群', { group: GROUP_B }));
    await until(() => s.event('gate_drop').length > drops, 'gate drop');
    await sleep(QUIET_MS);
    assert.equal(s.row(id), null);
    assert.equal(s.event('gate_drop').at(-1).reason, 'not_admitted');
    assert.equal(s.model.requests.length, model);
    assert.equal(s.messagePosts().length, posts);
  });

  test('author.bot in the admitted group leaves no row', async () => {
    const drops = s.event('gate_drop').length;
    const id = push(s, fullAt('机器人说话', { bot: true }));
    await until(() => s.event('gate_drop').length > drops, 'gate drop');
    assert.equal(s.row(id), null);
    assert.equal(s.event('gate_drop').at(-1).reason, 'bot');
  });

  test('a DM produces no model call and no reply, and leaves no row', async () => {
    const model = s.model.requests.length;
    const posts = s.messagePosts().length;
    const drops = s.event('gate_drop').length;
    const id = push(s, dm('私聊一句', { member: MEMBER }));
    await until(() => s.event('gate_drop').length > drops, 'gate drop');
    await sleep(QUIET_MS);
    assert.equal(s.event('gate_drop').at(-1).reason, 'dm_closed');
    assert.equal(s.row(id), null);
    assert.equal(s.model.requests.length, model);
    assert.equal(s.messagePosts().length, posts);
    assert.ok(s.qq.identifies.every((i) => i.intents === 1 << 25));
  });

  test('a replayed message id gets no second model call', async () => {
    s.model.setScript(() => ({ text: '只一次。' }));
    const event = fullAt('重放测试');
    const id = push(s, event);
    await s.waitRow(id);
    const model = s.model.requests.length;
    const posts = s.messagePosts().length;
    push(s, event);
    const dups = s.event('gate_dup').length;
    await until(() => s.event('gate_dup').length >= dups, 'dup logged');
    await sleep(QUIET_MS);
    assert.equal(s.model.requests.length, model);
    assert.equal(s.messagePosts().length, posts);
  });

  test('image with no text and no mention is noise', async () => {
    const id = push(s, imageOnly());
    const row = await s.waitRow(id);
    assert.equal(`${row.state}:${row.reason}`, 'skipped:rule');
  });

  test('a quote that does not match a bot ref is ordinary', async () => {
    const id = push(s, quoted('引用别人', 'NOT-A-BOT-REF'));
    assert.equal((await s.waitRow(id)).cls, 'ordinary');
  });
});

describe('reply to the bot', () => {
  test('a quote of a recorded bot message is answered; ref is matched verbatim', async () => {
    s.model.setScript(() => ({ text: '第一句。' }));
    const refIdx = s.qq.nextRefIdx();
    s.qq.setSendScript(() => ({ status: 200, body: { id: 'SENT-REF', timestamp: new Date().toISOString(), ext_info: { ref_idx: refIdx } } }));
    const first = push(s, fullAt('先问一句'));
    await s.waitRow(first);
    s.qq.setSendScript(null);
    assert.ok(s.sends(first)[0].ref_key, 'the ref was recorded');

    s.model.setScript(() => ({ text: '接着说。' }));
    const posts = s.messagePosts().length;
    const id = push(s, quoted('你刚才说的是什么意思', refIdx));
    const row = await s.waitRow(id);
    assert.equal(row.cls, 'reply_bot');
    assert.equal(s.messagePosts().length, posts + 1);
  });
});

describe('required turn that returns nothing', () => {
  test('NO_REPLY on a real @: two model calls, isError dropped, fixed line once, alert', async () => {
    s.model.setScript(() => ({ text: '  NO_REPLY\n' }));
    const model = s.model.agentRequests().length;
    const posts = s.messagePosts().length;
    const id = push(s, fullAt('不用回'));
    const row = await s.waitRow(id);
    assert.equal(row.state, 'failed');
    assert.ok(['host_error', 'required_no_text'].includes(row.reason), row.reason);
    assert.equal(s.model.agentRequests().length - model, 2, 'observed: one paid retry');
    const fresh = s.postBodies().slice(posts);
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].content, LINES.modelFailed);
    assert.equal(fresh[0].msg_id, id);
    assert.ok(s.alerts().some((a) => a.kind === 'model_failed'));
    assert.ok(s.event('exit_drop').some((e) => e.reason === 'host-error-text'), 'the host error text was dropped');
  });
});

describe('at rest', () => {
  test('TQ21: no canary body or raw ID in the event log, database or gateway log', async () => {
    const canary = '金丝雀正文CANARYBODY7731';
    s.model.setScript(() => ({ text: '金丝雀回复CANARYREPLY7731' }));
    const id = push(s, fullAt(canary, { id: 'CANARYMESSAGEID7731' }));
    await s.waitRow(id);
    const posted = s.postBodies().at(-1);
    assert.equal(posted.content, '金丝雀回复CANARYREPLY7731', 'positive control: the text passed through');
    const logText = readFileSync(s.paths.eventLog, 'utf8');
    const gatewayLog = s.logs();
    const dbText = readFileSync(s.paths.db).toString('latin1') + (await readWal(s.paths.db));
    for (const c of [canary, 'CANARYBODY7731', 'CANARYREPLY7731', 'CANARYMESSAGEID7731', GROUP_A, MEMBER, BOT_MEMBER, 'SENDER-DISPLAY-NAME', FAKE_QQ_SECRET, FAKE_MODEL_KEY]) {
      assert.ok(!logText.includes(c), `${c} in the event log`);
      assert.ok(!gatewayLog.includes(c), `${c} in the gateway log`);
      assert.ok(!dbText.includes(c), `${c} in the database`);
    }
  });

  test('no network beyond loopback', () => {
    assert.deepEqual(unexpectedNetAttempts(s.gw), []);
  });

  test('last: every POST on this stack is legal', () => {
    assertEveryPostLegal(s, { minPosts: 5 });
  });
});

async function readWal(file) {
  try {
    return readFileSync(`${file}-wal`).toString('latin1');
  } catch {
    return '';
  }
}
