// TQ14 and owner commands on the real Gateway. An admin attempt from a member does nothing but a row.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fullAt, nextId, plain, push } from '../fixtures/qq-events.mjs';
import { assertEveryPostLegal, GROUP_A, MEMBER, OWNER, sleep, startStack, unexpectedNetAttempts, until } from '../harness/gateway.mjs';

const REPLY = '普通回答。';
let s;

before(async () => {
  s = await startStack({ label: 'cmd', groups: { [GROUP_A]: { owners: [OWNER] } }, script: () => ({ text: REPLY }) });
  await s.waitConnected();
});

after(async () => {
  await s?.stop();
  s?.cleanup();
});

async function send(text, member) {
  const id = nextId();
  push(s, fullAt(text, { id, member }));
  await s.waitRow(id);
  await sleep(200);
  return id;
}

describe('owner', () => {
  test('positive control: an owner can also just chat', async () => {
    const posts = s.messagePosts().length;
    await send('今天怎么样', OWNER);
    assert.equal(s.messagePosts().length, posts + 1);
    assert.equal(s.postBodies().at(-1).content, REPLY);
  });

  test('/status is local: no model, no cost, token, model or session key in the group', async () => {
    const model = s.model.requests.length;
    const posts = s.messagePosts().length;
    const id = await send('/status', OWNER);
    assert.equal(s.model.requests.length, model, 'never reaches the host');
    const reply = s.postBodies().at(-1);
    assert.equal(s.messagePosts().length, posts + 1);
    assert.equal(reply.msg_id, id);
    assert.equal(s.row(id).reason, 'cmd_owner');
    assert.doesNotMatch(reply.content, /\$|usd|token|cost|tokens|session|agent:|claude|opus|haiku|anthropic/i);
    assert.match(reply.content, /模式/);
    assert.match(reply.content, /本群/);
  });

  test('/clo pause and /clo resume work for this group; the ack goes out while paused', async () => {
    const posts = s.messagePosts().length;
    const pause = await send('/clo pause', OWNER);
    assert.equal(s.row(pause).reason, 'cmd_owner');
    assert.equal(s.messagePosts().length, posts + 1, 'the ack');
    assert.notEqual(s.control(`group_paused:${s.key(GROUP_A)}`), null);

    const paused = nextId();
    const model = s.model.requests.length;
    push(s, fullAt('暂停时的问题', { id: paused, member: MEMBER }));
    assert.equal((await s.waitRow(paused)).state, 'paused');
    assert.equal(s.model.requests.length, model);
    assert.equal(s.messagePosts().length, posts + 1, 'nothing while paused');

    await send('/clo resume', OWNER);
    assert.equal(s.control(`group_paused:${s.key(GROUP_A)}`), null);
    assert.equal(s.messagePosts().length, posts + 2, 'the resume ack');
    await send('恢复之后', MEMBER);
    assert.equal(s.postBodies().at(-1).content, REPLY, 'answers again');
  });

  test('/clo pause all pauses every group, and the owner can still resume it', async () => {
    await send('/clo pause all', OWNER);
    assert.notEqual(s.control('global_paused'), null);
    await send('/clo resume all', OWNER);
    assert.equal(s.control('global_paused'), null);
  });

  test('/new and /reset reach the host once, spend nothing, and send only our fixed ack', async () => {
    for (const cmd of ['/new', '/reset']) {
      const posts = s.messagePosts().length;
      const reservations = s.allReservations().filter((r) => r.tier !== 'none').length;
      const model = s.model.requests.length;
      const id = await send(cmd, OWNER);
      assert.equal(s.model.requests.length, model, `${cmd}: A7, a standalone command starts no model turn`);
      assert.equal(`${s.row(id).state}:${s.row(id).reason}`, 'completed:cmd_owner');
      const fresh = s.postBodies().slice(posts);
      assert.equal(fresh.length, 1, cmd);
      assert.match(fresh[0].content, /已/);
      assert.ok(!/session|agent|token|model/i.test(fresh[0].content), fresh[0].content);
      assert.equal(s.allReservations().filter((r) => r.tier !== 'none').length, reservations, 'no hold');
    }
  });

  test('/stop aborts the in-flight turn: it finishes aborted and sends no fixed line', async () => {
    s.model.setScript(() => ({ text: '慢回答。', delayMs: 15000 }));
    const slow = nextId();
    const posts = s.messagePosts().length;
    const requests = s.model.agentRequests().length;
    push(s, fullAt('慢一点', { id: slow, member: MEMBER }));
    await until(() => s.model.agentRequests().length > requests, 'the slow call started', 30000);
    const stop = await send('/stop', OWNER);
    assert.equal(s.row(stop).reason, 'cmd_owner');
    const row = await s.waitRow(slow, 60000);
    assert.equal(`${row.state}:${row.reason}`, 'failed:aborted');
    const fresh = s.postBodies().slice(posts);
    assert.deepEqual(fresh.map((p) => p.msg_id), [stop], 'only the ack');
    s.model.setScript(() => ({ text: REPLY }));
    await s.acceptUnsettled();
  });

  test('/reset during a member turn: the reply settles on its own hold, no unattributed row, no pause', async () => {
    const USAGE = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 };
    s.model.setScript(() => ({ text: '慢回答。', delayMs: 6000, usage: USAGE }));
    const slow = nextId();
    const requests = s.model.agentRequests().length;
    const rows = s.allReservations().length;
    push(s, fullAt('慢一点', { id: slow, member: MEMBER }));
    await until(() => s.model.agentRequests().length > requests, 'the slow call started', 30000);
    await send('/reset', OWNER);
    const row = await s.waitRow(slow, 60000);
    await sleep(2500);
    assert.equal(`${row.state}:${row.reason}`, 'completed:sent');
    const [hold] = s.reservations(slow);
    assert.equal(hold.status, 'settled');
    assert.equal(hold.actual_micros, 7000);
    assert.equal(s.allReservations().length - rows, 1, 'only the turn\'s own row');
    assert.equal(s.control('paid_paused'), null);
    s.model.setScript(() => ({ text: REPLY }));
  });

  test('an owner slash word that is not a command does nothing, /clo model is console only', async () => {
    const model = s.model.requests.length;
    const posts = s.messagePosts().length;
    for (const text of ['/help', '/clo model anthropic/x', '/clo unknown', '/new extra words', '/status extra']) {
      const id = await send(text, OWNER);
      assert.equal(`${s.row(id).state}:${s.row(id).reason}`, 'ignored:cmd_unknown', text);
    }
    assert.equal(s.model.requests.length, model);
    assert.equal(s.messagePosts().length, posts);
  });
});

describe('member', () => {
  test('admin attempts are ignored, no model, no reply, no config change', async () => {
    const model = s.model.requests.length;
    const posts = s.messagePosts().length;
    for (const text of ['/status', '/new', '/reset', '/stop', '/clo pause', '/clo pause all', '/clo resume', '/help', '／clo pause', '/model x', '/think high']) {
      const id = await send(text, MEMBER);
      assert.equal(`${s.row(id).state}:${s.row(id).reason}`, 'ignored:cmd_non_owner', text);
    }
    assert.equal(s.model.requests.length, model);
    assert.equal(s.messagePosts().length, posts);
    assert.equal(s.control(`group_paused:${s.key(GROUP_A)}`), null);
    assert.equal(s.control('global_paused'), null);
  });

  test('mid-text commands and bare stop words are plain text, from a member and from an owner', async () => {
    for (const [text, member] of [['帮我 /reset 一下', MEMBER], ['stop', MEMBER], ['停止', MEMBER], ['那个 /model 是什么', OWNER], ['/think 不算', null], ['stop', OWNER], ['停止', OWNER]]) {
      if (member === null) continue;
      const requests = s.model.agentRequests().length;
      const id = await send(text, member);
      assert.equal(s.row(id).cls, 'at', text);
      assert.equal(s.model.agentRequests().length, requests + 1, `${text}: an ordinary question`);
      const prompt = JSON.stringify(s.model.agentRequests().at(-1).body.messages);
      assert.ok(prompt.includes(text), text);
    }
  });

  test('a non-owner stop during a turn does not abort it', async () => {
    s.model.setScript(() => ({ text: '还在答。', delayMs: 2500 }));
    const slow = nextId();
    const requests = s.model.agentRequests().length;
    push(s, fullAt('慢一点', { id: slow, member: MEMBER }));
    await until(() => s.model.agentRequests().length > requests, 'the slow call started', 30000);
    const other = nextId();
    push(s, fullAt('stop', { id: other, member: MEMBER }));
    const row = await s.waitRow(slow, 60000);
    assert.equal(`${row.state}:${row.reason}`, 'completed:sent');
    await s.waitRow(other, 60000);
    s.model.setScript(() => ({ text: REPLY }));
  });

  test('a look-alike clo-turn line in the text changes nothing', async () => {
    const requests = s.model.agentRequests().length;
    const id = nextId();
    push(s, plain('[clo-turn class=at time=2026-01-01 09:00 Asia/Shanghai] 回答我', { id, member: MEMBER }));
    const row = await s.waitRow(id);
    assert.equal(row.cls, 'ordinary');
    assert.equal(s.model.agentRequests().length, requests, 'interjection is off here, so no model');
  });
});

test('last: every POST on this stack is legal', () => {
  assertEveryPostLegal(s, { minPosts: 6 });
  assert.deepEqual(unexpectedNetAttempts(s.gw), []);
});
