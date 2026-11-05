// TQ18: passive window, part cap, interjection cap, and that there is no path without msg_id.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createExit } from '../../src/clo-plugin/lib/channels/qq/exit.js';
import { clipToSentence, guardUrls, removeUrls, splitParts, stripForQq, URL_REMOVED } from '../../src/clo-plugin/lib/channels/qq/text.js';
import { makeEffective, makeHarness, MEMBER2, T0, USAGE } from '../fixtures/inbound.mjs';

const open = [];
after(async () => {
  for (const h of open) await h.close();
});

function stack(effective) {
  const posts = [];
  const bot = { appId: 'FAKE-APP', api: { post: async (path, body) => { posts.push({ path, body }); return { id: `S${posts.length}` }; } } };
  let h;
  const dispatch = async (turn) => {
    if (h.delayMs) h.clock.t += h.delayMs;
    await h.mid?.(turn);
    h.exit.collect(turn.turnId, { text: h.replyText }, { kind: 'final' });
    return { started: true, hostError: false, aborted: false, usage: USAGE };
  };
  h = makeHarness({ effective, dispatch, attach: false });
  h.waits = [];
  h.exit = createExit({
    bot, store: h.store, policy: h.policy, getEffective: () => h.eff.current, secrets: [], log: h.log, now: h.now,
    sleep: async (ms) => {
      h.waits.push(ms);
      h.clock.t += ms;
      await h.onWait?.();
    },
  });
  h.gate.attachExit(h.exit);
  h.replyText = '普通回复。';
  h.posts = posts;
  open.push(h);
  return h;
}

test('positive control: within the window it posts, with msg_id and msg_seq 1', async () => {
  const h = stack();
  const e = await h.sendAndFlush(h.at());
  assert.equal(h.state(e), 'completed:sent');
  assert.equal(h.posts[0].body.msg_id, e.messageId);
  assert.equal(h.posts[0].body.msg_seq, 1);
  assert.equal(h.posts[0].body.msg_type, 0);
});

test('at 285 s the reply is dropped, never converted to proactive', async () => {
  const h = stack();
  h.delayMs = 285000;
  const e = await h.sendAndFlush(h.at());
  assert.equal(h.state(e), 'failed:deadline');
  assert.equal(h.posts.length, 0);
});

test('just inside 285 s it still posts', async () => {
  const h = stack();
  h.delayMs = 284000;
  const e = await h.sendAndFlush(h.at());
  assert.equal(h.state(e), 'completed:sent');
  assert.equal(h.posts.length, 1);
});

test('the window counts from the earlier of the message time and arrival', async () => {
  const h = stack();
  h.delayMs = 284000;
  const e = h.at({ timestampMs: T0 - 60000 });
  await h.sendAndFlush(e);
  assert.equal(h.state(e), 'failed:deadline');
});

test('the fixed line respects the same window', async () => {
  const h = stack();
  const ref = { eventKey: 'k', groupKey: h.store.key('GROUPAAAA11112222333344445555'), groupId: 'GROUPAAAA11112222333344445555', messageId: 'M', receivedAt: T0, msgTs: T0 };
  h.clock.t = T0 + 285000;
  assert.deepEqual(await h.exit.sendFixed(ref, 'modelFailed'), { sent: false, reason: 'deadline' });
  assert.equal(h.posts.length, 0);
  h.clock.t = T0 + 1000;
  assert.equal((await h.exit.sendFixed(ref, 'modelFailed')).sent, true, 'positive control');
});

test('a required answer is at most 5 parts of at most maxPartChars, in order, with seq per part', async () => {
  const h = stack(makeEffective({ limits: { sendGroupPerMin: 100, sendAccountPerMin: 100 } }));
  h.eff.current.qq.maxPartChars = 100;
  h.replyText = '这是一句测试用的句子。'.repeat(200);
  const e = await h.sendAndFlush(h.at());
  assert.equal(h.state(e), 'completed:sent');
  assert.equal(h.posts.length, 5);
  assert.deepEqual(h.posts.map((p) => p.body.msg_seq), [1, 2, 3, 4, 5]);
  for (const p of h.posts) assert.ok([...p.body.content].length <= 100);
  assert.ok(h.posts.every((p) => p.body.msg_id === e.messageId));
});

const LONG = (n) => '这是一句测试用的句子。'.repeat(n);

test('at default limits a long answer fits one reply: parts are clamped to the per-minute limit', async () => {
  const h = stack();
  assert.equal(h.eff.current.limits.sendGroupPerMin, 4, 'this test is about the real limit');
  h.replyText = LONG(700);
  const e = await h.sendAndFlush(h.at());
  assert.equal(h.state(e), 'completed:sent');
  assert.equal(h.posts.length, 4);
  assert.deepEqual(h.waits, []);
});

test('at default limits a second answer waits for room inside the window and goes out whole', async () => {
  const h = stack();
  h.replyText = LONG(200);
  const a = await h.sendAndFlush(h.at());
  assert.equal(h.posts.length, 2);
  h.clock.t += 5000;
  h.replyText = LONG(350);
  const b = await h.sendAndFlush(h.at({ senderId: MEMBER2 }));
  assert.equal(h.state(a), 'completed:sent');
  assert.equal(h.state(b), 'completed:sent');
  assert.equal(h.posts.length, 5, 'two, then three');
  assert.equal(h.waits.length, 1);
  assert.ok(h.waits[0] > 0 && h.waits[0] <= 60000, String(h.waits[0]));
  assert.ok(!h.store.listAlerts().some((a2) => a2.kind === 'send_rate'));
});

test('a fifth single-part answer in one minute waits instead of being dropped after the spend', async () => {
  const h = stack();
  const states = [];
  for (let i = 0; i < 5; i += 1) states.push(h.state(await h.sendAndFlush(h.at({ senderId: `MEMBER${i}` }), 0)));
  assert.deepEqual(states, new Array(5).fill('completed:sent'));
  assert.equal(h.posts.length, 5);
  assert.equal(h.waits.length, 1);
});

test('a pause arriving during the wait ends it: the waiting reply is not sent', async () => {
  const h = stack();
  h.replyText = LONG(350);
  await h.sendAndFlush(h.at());
  const posts = h.posts.length;
  h.onWait = () => h.store.setControl('global_paused', '1', 'test');
  const e = await h.sendAndFlush(h.at({ senderId: MEMBER2 }));
  assert.equal(h.waits.length, 1, 'it did wait');
  assert.equal(h.state(e), 'paused:paused');
  assert.equal(h.posts.length, posts);
});

test('no room before the deadline: nothing of the reply is sent, one fixed line while a slot is free, alert raised', async () => {
  const h = stack();
  h.replyText = LONG(350);
  // The model took most of the window, and other sends have just filled three of the four slots.
  h.mid = (turn) => {
    h.clock.t += 270000;
    h.store.insertSendParts({ eventKey: 'OTHER', groupKey: turn.groupKey, kind: 'reply', parts: [{ textSha: 'a' }, { textSha: 'b' }, { textSha: 'c' }], rate: null, now: h.clock.t });
  };
  const e = await h.sendAndFlush(h.at(), 0);
  assert.equal(h.state(e), 'failed:send_rate');
  assert.equal(h.posts.length, 1, 'only the fixed line, not part of the reply');
  assert.ok(h.posts[0].body.content.includes('答不了'));
  assert.ok(h.store.listAlerts().some((a) => a.kind === 'send_rate'));
  assert.deepEqual(h.waits, []);
  assert.deepEqual(h.store.sendsForEvent(h.store.key(e.messageId)).map((r) => r.kind), ['fixed_line'], 'atomic: no reply row');
});

test('an interjection never waits: over the rate it is dropped, with no line', async () => {
  const h = stack(makeEffective({ limits: { sendGroupPerMin: 1, sendAccountPerMin: 100 } }));
  h.replyText = '回答。';
  await h.sendAndFlush(h.at());
  const posts = h.posts.length;
  const e = await h.sendAndFlush(h.event({ text: '有人知道怎么退货吗' }), 4000);
  assert.equal(h.state(e), 'failed:send_rate');
  assert.equal(h.posts.length, posts);
  assert.deepEqual(h.waits, []);
});

test('a deadline passing between two parts stops the rest', async () => {
  const h = stack();
  h.replyText = LONG(200);
  const e = h.at();
  const bot = { appId: 'FAKE-APP', api: { post: async (path, body) => { h.posts.push({ path, body }); h.clock.t = e.timestampMs + 285000; return { id: 'S1' }; } } };
  h.exit = createExit({ bot, store: h.store, policy: h.policy, getEffective: () => h.eff.current, secrets: [], log: h.log, now: h.now });
  h.gate.attachExit(h.exit);
  await h.sendAndFlush(e, 0);
  assert.equal(h.state(e), 'failed:deadline');
  assert.equal(h.posts.length, 1);
  assert.deepEqual(h.store.sendsForEvent(h.store.key(e.messageId)).map((r) => r.state), ['sent', 'aborted']);
});

test('an interjection is one part of at most 400 characters, cut at a sentence end', async () => {
  const h = stack();
  h.replyText = '这是一句测试用的句子。'.repeat(100);
  const e = await h.sendAndFlush(h.event({ text: '有人知道怎么退货吗' }));
  assert.equal(h.state(e), 'completed:sent');
  assert.equal(h.posts.length, 1);
  const { content } = h.posts[0].body;
  assert.ok([...content].length <= 400);
  assert.ok(content.endsWith('。'));
});

test('the only post route is the group route, with msg_id, whatever the event', async () => {
  const h = stack();
  await h.sendAndFlush(h.at());
  await h.sendAndFlush(h.event({ text: '有人知道怎么退货吗' }));
  assert.ok(h.posts.length >= 2);
  for (const p of h.posts) {
    assert.match(p.path, /^\/v2\/groups\/[^/]+\/messages$/);
    assert.ok(p.body.msg_id);
  }
});

test('host deliveries: non-final, error, empty, silent tokens and unknown turns are suppressed with nothing buffered', async () => {
  const seen = [];
  const dispatch = async (turn) => {
    const c = (payload, kind) => h2.exit.collect(turn.turnId, payload, { kind });
    seen.push(
      c({ text: 'partial' }, 'block'),
      c({ text: 'tool text' }, 'tool'),
      c({ text: '' }, 'final'),
      c({ text: '  NO_REPLY\n' }, 'final'),
      c({ text: 'no_reply' }, 'final'),
      c({ text: 'HEARTBEAT_OK' }, 'final'),
      c({ text: 'ANNOUNCE_SKIP' }, 'final'),
      c({ text: 'REPLY_SKIP' }, 'final'),
      h2.exit.collect('unknown-turn', { text: 'late' }, { kind: 'final' }),
    );
    return { started: true, hostError: false, aborted: false, usage: USAGE };
  };
  const h2 = makeHarness({ dispatch, attach: false });
  open.push(h2);
  const posts = [];
  const exit = createExit({ bot: { appId: 'FAKE-APP', api: { post: async (path, body) => { posts.push(body); return { id: 'S' }; } } }, store: h2.store, policy: h2.policy, getEffective: () => h2.eff.current, log: h2.log, now: h2.now });
  h2.exit = exit;
  h2.gate.attachExit(exit);
  const e = await h2.sendAndFlush(h2.at());
  assert.equal(seen.length, 9);
  for (const r of seen) {
    assert.equal(r.visibleReplySent, false);
    assert.equal(r.suppression.reason, 'channel_transform');
  }
  assert.equal(h2.state(e), 'failed:required_no_text');
  assert.equal(posts.length, 1, 'the fixed line, and no host text');
  assert.ok(!posts[0].content.includes('partial'));
});

test('a kept payload reports delivery to the host so it does not retry', async () => {
  let result;
  const h2 = makeHarness({ attach: false, dispatch: async (turn) => {
    result = h2.exit.collect(turn.turnId, { text: '留下' }, { kind: 'final' });
    return { started: true, hostError: false, aborted: false, usage: USAGE };
  } });
  open.push(h2);
  h2.exit = createExit({ bot: { appId: 'FAKE-APP', api: { post: async () => ({ id: 'S' }) } }, store: h2.store, policy: h2.policy, getEffective: () => h2.eff.current, log: h2.log, now: h2.now });
  h2.gate.attachExit(h2.exit);
  await h2.sendAndFlush(h2.at());
  assert.deepEqual(result, { messageIds: [], visibleReplySent: true });
});

test('splitParts prefers paragraphs, then sentences, and never splits a surrogate pair', () => {
  assert.deepEqual(splitParts('一二三\n\n四五六', 5, 5), ['一二三', '四五六']);
  assert.deepEqual(splitParts('一二三。四五六。', 5, 5), ['一二三。', '四五六。']);
  assert.deepEqual(splitParts('', 5, 5), []);
  assert.deepEqual(splitParts('短', 5, 5), ['短']);
  const emoji = '😀'.repeat(7);
  for (const part of splitParts(emoji, 3, 5)) assert.ok(/^(😀)+$/u.test(part), part);
  assert.equal(splitParts('一二三四五六七八九十', 3, 2).length, 2, 'cut off at the part cap');
});

test('clipToSentence: within the limit whole; otherwise the last sentence end; otherwise a hard cut', () => {
  assert.deepEqual(clipToSentence('一句。', 10), ['一句。']);
  assert.deepEqual(clipToSentence('一句。二句。三句。', 7), ['一句。二句。']);
  assert.deepEqual(clipToSentence('没有句号的很长的一段话', 4), ['没有句号']);
  assert.deepEqual(clipToSentence('  ', 4), []);
});

test('stripForQq: emphasis, headings, fences and links become plain text; ordinary symbols survive', () => {
  assert.equal(stripForQq('# 标题\n**粗** *斜* __粗__ _斜_ ~~删~~ `码`'), '标题\n粗 斜 粗 斜 删 码');
  assert.equal(stripForQq('[名称](https://a.example/x)'), '名称 https://a.example/x');
  assert.equal(stripForQq('![图](https://a.example/y)'), '图 https://a.example/y');
  assert.equal(stripForQq('```js\ncode()\n```'), 'code()');
  assert.equal(stripForQq('2*3*4 和 snake_case_word 不动'), '2*3*4 和 snake_case_word 不动');
});

test('the URL guard removes anything the member did not send, in any case', () => {
  assert.equal(guardUrls('去 https://a.example/x 看', []), `去 ${URL_REMOVED} 看`);
  assert.equal(guardUrls('去 HTTPS://A.Example/x 看', ['https://a.example/x']), '去 HTTPS://A.Example/x 看', 'same scheme and host in another case');
  assert.equal(guardUrls('去 https://a.example/x 看', ['https://a.example/x']), '去 https://a.example/x 看');
  assert.equal(guardUrls('去 HTTP://A.example 看', ['https://a.example/x']), `去 ${URL_REMOVED} 看`);
  assert.equal(removeUrls('a https://x.example b http://y.example c'), `a ${URL_REMOVED} b ${URL_REMOVED} c`);
  assert.equal(guardUrls('没有网址', []), '没有网址');
});

test('splitParts never cuts inside a URL, judging by the whole remaining text', () => {
  const url = 'https://a.example/x?y=1';
  // The limit falls right after the question mark. From the head alone the URL looks finished there.
  assert.deepEqual(splitParts(`一二三四五 ${url}`, 26, 5), ['一二三四五', url]);
  // No boundary at all: the hard cut moves back to where the URL starts.
  const chars = '一'.repeat(25);
  assert.deepEqual(splitParts(`${chars}${url}`, 30, 5), [chars, url]);
  assert.deepEqual(splitParts(`${url}。后面还有一些话`, 26, 5), [`${url}。`, '后面还有一些话']);
  // A sentence end before the URL is used, one inside it is not.
  assert.deepEqual(splitParts(`一句话说完了。${url}`, 24, 5), ['一句话说完了。', url]);
});

test('a URL longer than a part is cut, since nothing else can be done, and the split still ends', () => {
  const url = `https://a.example/${'x'.repeat(40)}`;
  const parts = splitParts(url, 20, 5);
  assert.equal(parts.join(''), url);
  assert.ok(parts.every((part) => [...part].length <= 20));
});

test('clipToSentence does not end an interjection inside a URL', () => {
  assert.deepEqual(clipToSentence('看 https://a.example/x?y=1', 22), ['看']);
  assert.deepEqual(clipToSentence('看过了。https://a.example/x?y=1', 24), ['看过了。']);
});

test('the dot of a list number is not a sentence end; any other line-end dot still is', () => {
  const parts = splitParts('引子一句话。\n1. 甲乙\n2. 丙丁戊己', 17, 5);
  assert.deepEqual(parts, ['引子一句话。', '1. 甲乙\n2. 丙丁戊己']);
  assert.deepEqual(clipToSentence('一句话。\n2. 后面很长', 8), ['一句话。']);
  assert.deepEqual(clipToSentence('一句。\n  3. 后面很长', 9), ['一句。']);
  assert.deepEqual(clipToSentence('版本是 2. 后面很长的内容', 8), ['版本是 2.']);
});
