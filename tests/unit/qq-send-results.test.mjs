// TQ17 and TQ24: the section 6.3 table, row by row, on real SQLite with the real gate and a scripted SDK.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ApiError } from '@tencent-connect/qqbot-nodejs';
import { createExit, isDefinitelyNotSent } from '../../src/clo-plugin/lib/channels/qq/exit.js';
import { GROUP_A, makeEffective, makeHarness, MEMBER, MEMBER2, OWNER, ROOT, USAGE } from '../fixtures/inbound.mjs';

const LINES = JSON.parse(readFileSync(join(ROOT, 'persona', 'policy-lines.zh.json'), 'utf8'));
const CRISIS = '我真的不想活了';
const THREE_PARTS = '第一句话有十一个字。\n\n第二句话有十一个字。\n\n第三句话有十一个字。';

const bizError = (code, status = 400) => new ApiError(`API Error [/x]: PLATFORM-TEXT-${code}`, status, '/x', code, `PLATFORM-TEXT-${code}`);
// The shape of the message from the real SDK, with documentation addresses.
const connectTimeout = () => new ApiError('Network error [/x]: fetch failed | Connect Timeout Error (attempted addresses: 192.0.2.1:443, 198.51.100.1:443, timeout: 10000ms)', 0, '/x');

const open = [];
after(async () => {
  for (const h of open) await h.close();
});

function stack(effective) {
  const posts = [];
  const results = [];
  const bot = {
    appId: 'FAKE-APP',
    api: {
      post: async (path, body) => {
        posts.push({ path, body });
        await h.onPost?.();
        const r = results.shift();
        if (r instanceof Error) throw r;
        return r ?? { id: `SENT${posts.length}` };
      },
    },
  };
  const slept = [];
  let h;
  const dispatch = async (turn) => {
    await h.mid?.(turn);
    h.exit.collect(turn.turnId, { text: h.replyText }, { kind: 'final' });
    return { started: true, hostError: false, aborted: false, usage: USAGE };
  };
  h = makeHarness({ effective, dispatch, attach: false });
  h.exit = createExit({ bot, store: h.store, policy: h.policy, getEffective: () => h.eff.current, secrets: [], log: h.log, now: h.now, sleep: async (ms) => { slept.push(ms); await h.onSleep?.(ms); } });
  h.gate.attachExit(h.exit);
  h.replyText = '这是一条普通的回复。';
  h.slept = slept;
  h.posts = posts;
  h.results = results;
  h.sends = (e) => h.store.sendsForEvent(h.store.key(e.messageId));
  open.push(h);
  return h;
}

async function ask(h, ...results) {
  const over = results[0]?.inbound ? results.shift().inbound : {};
  h.results.push(...results);
  const e = await h.sendAndFlush(h.at(over));
  h.advance(20000);
  return e;
}

test('200 with id: sent, and ext_info.ref_idx becomes a bot ref keyed by HMAC', async () => {
  const h = stack();
  const e = await ask(h, { id: 'S1', ext_info: { ref_idx: 'REF-A' } });
  assert.equal(h.state(e), 'completed:sent');
  assert.equal(h.sends(e)[0].state, 'sent');
  assert.equal(h.sends(e)[0].ref_key, h.store.key('REF-A'));
  assert.equal(h.store.hasBotRef(h.store.key('REF-A'), h.store.key(GROUP_A)), true);
  assert.equal(h.store.hasBotRef(h.store.key('REF-B'), h.store.key(GROUP_A)), false);
});

test('200 with no id: uncertain, alert, never re-posted', async () => {
  const h = stack();
  const e = await ask(h, { timestamp: 'x' });
  assert.equal(h.state(e), 'failed:send_uncertain');
  assert.equal(h.sends(e)[0].state, 'uncertain');
  assert.equal(h.posts.length, 1);
  assert.ok(h.store.listAlerts().some((a) => a.kind === 'send_uncertain'));
});

test('a connect timeout never left this machine: the same part is posted again under the same seq and goes out once', async () => {
  const h = stack();
  const e = await ask(h, connectTimeout(), connectTimeout(), { id: 'S1' });
  assert.equal(h.state(e), 'completed:sent');
  assert.equal(h.posts.length, 3);
  assert.equal(new Set(h.posts.map((p) => p.body.msg_seq)).size, 1, 'one seq, so the platform can dedupe if this reading is ever wrong');
  assert.equal(new Set(h.posts.map((p) => p.body.content)).size, 1);
  assert.deepEqual(h.sends(e).map((r) => r.state), ['sent'], 'one row, not one per attempt');
  assert.equal(h.slept.length, 2);
  assert.equal(h.store.listAlerts().filter((a) => a.kind === 'send_not_connected').length, 0);
});

test('a token that could not be fetched also means nothing was posted, whatever ended the fetch', async () => {
  const h = stack();
  const e = await ask(h, new Error('Network error getting access_token: fetch failed | other side closed'), { id: 'S1' });
  assert.equal(h.state(e), 'completed:sent');
  assert.equal(h.posts.length, 2);
});

test('connect timeouts up to the limit: failed and not uncertain, with an alert and nothing further', async () => {
  const h = stack();
  const e = await ask(h, connectTimeout(), connectTimeout(), connectTimeout(), connectTimeout(), { id: 'never' });
  assert.equal(h.state(e), 'failed:send_not_connected');
  assert.equal(h.posts.length, 4);
  assert.equal(h.sends(e)[0].state, 'failed');
  assert.equal(h.store.listAlerts().filter((a) => a.kind === 'send_not_connected').length, 1);
  assert.equal(h.store.listAlerts().filter((a) => a.kind === 'send_uncertain').length, 0);
});

test('a later part that cannot connect stops the rest, and the earlier part stays sent', async () => {
  const h = stack();
  h.eff.current = { ...h.eff.current, qq: { ...h.eff.current.qq, maxPartChars: 12 } };
  h.replyText = '第一段内容在这里。\n\n第二段内容在这里。\n\n第三段内容在这里。';
  const e = await ask(h, { id: 'S1' }, connectTimeout(), connectTimeout(), connectTimeout(), connectTimeout(), { id: 'never' });
  assert.equal(h.state(e), 'failed:send_not_connected');
  const states = h.sends(e).map((r) => r.state);
  assert.equal(states[0], 'sent');
  assert.equal(states[1], 'failed');
  assert.ok(states.slice(2).every((s) => s === 'aborted'), JSON.stringify(states));
});

for (const [name, err] of [
  ['the socket lost after connecting', new ApiError('Network error [/x]: fetch failed | other side closed', 0, '/x')],
  ['the SDK request timeout', new ApiError('Request timeout [/x]: exceeded 30000ms', 0, '/x')],
  ['a TLS failure', new ApiError('Network error [/x]: fetch failed | Client network socket disconnected before secure TLS connection was established', 0, '/x')],
  ['a bare fetch failure', new ApiError('Network error [/x]: fetch failed', 0, '/x')],
  ['the words inside another message', new ApiError('Upstream said: Network error [/x]: fetch failed | Connect Timeout Error', 0, '/x')],
  ['the same words with an HTTP status', new ApiError('Network error [/x]: fetch failed | Connect Timeout Error', 502, '/x')],
  ['the same words with a platform code', new ApiError('Network error [/x]: fetch failed | Connect Timeout Error', 0, '/x', 40034006)],
  ['a token request the platform answered', new Error('Token fetch failed: HTTP 500')],
]) {
  test(`no retry after ${name}: uncertain, one POST`, async () => {
    const h = stack();
    const e = await ask(h, err, { id: 'never' });
    assert.equal(h.posts.length, 1, name);
    assert.ok(h.state(e).startsWith('failed:'), name);
    assert.notEqual(h.state(e), 'failed:send_not_connected', name);
    assert.equal(h.sends(e)[0].state, name.includes('platform code') ? 'failed' : 'uncertain', name);
    assert.equal(h.slept.length, 0, name);
  });
}

test('an interjection gets one attempt: it is not asked for, and late it has missed the conversation', async () => {
  const h = stack();
  h.results.push(connectTimeout(), { id: 'never' });
  const e = await h.sendAndFlush(h.event({ text: '有人知道怎么退货吗' }));
  assert.equal(h.posts.length, 1, 'one attempt');
  assert.equal(h.slept.length, 0);
  assert.equal(h.row(e).reason, 'send_not_connected');
  assert.equal(h.sends(e)[0].state, 'failed');
});

test('a retry reads the hard stops again: pause, dry-run, the terminal latch and the passive window each end it', async () => {
  const stops = [
    ['global pause', (h) => h.store.setControl('global_paused', 'test', 'test')],
    ['group pause', (h, e) => h.store.setControl(`group_paused:${h.store.key(e.groupId ?? GROUP_A)}`, 'test', 'test')],
    ['dry-run', (h) => { h.eff.current = { ...h.eff.current, mode: 'dry-run' }; }],
    ['terminal latch', (h) => h.store.setControl('terminal_close', '4914', 'test')],
    ['passive window', (h) => h.advance(400000)],
    ['group removed', (h) => { h.eff.current = { ...h.eff.current, qq: { ...h.eff.current.qq, groups: {} } }; }],
    ['a different bot', (h) => { h.eff.current = { ...h.eff.current, qq: { ...h.eff.current.qq, appId: 'OTHER-APP' } }; }],
    ['exit stopped', (h) => h.exit.stop()],
  ];
  for (const [name, stop] of stops) {
    const h = stack();
    h.onSleep = () => stop(h, {});
    const e = await ask(h, connectTimeout(), { id: 'never' });
    assert.equal(h.posts.length, 1, `${name}: nothing posted after the stop`);
    assert.equal(h.state(e), 'failed:send_not_connected', name);
    assert.equal(h.sends(e)[0].state, 'failed', name);
  }
});

test('a command ack is not pausable, so a pause does not stop its retry, and it is the ack of that pause', async () => {
  const h = stack();
  const e = await ask(h);
  const posted = h.posts.length;
  const ref = { eventKey: h.store.key(e.messageId), groupKey: h.store.key(GROUP_A), groupId: GROUP_A, messageId: e.messageId, receivedAt: h.now(), msgTs: h.now() };
  h.store.setControl('global_paused', 'test', 'test');
  h.results.push(connectTimeout(), { id: 'ACK' });
  const ack = await h.exit.commandAck(ref, '已暂停。');
  assert.equal(ack.sent, true);
  assert.equal(h.posts.length, posted + 2);
});

test('the probe tries a failed connection again; other errors and a stopped exit end it at once', async () => {
  const run = async (results, { stopFirst = false } = {}) => {
    let gets = 0;
    const slept = [];
    const h = stack();
    const logs = [];
    const exit = createExit({ bot: { appId: 'FAKE-APP', api: { get: async () => { gets += 1; const r = results.shift(); if (r instanceof Error) throw r; return r; } } }, store: h.store, policy: h.policy, getEffective: () => h.eff.current, log: (event, data) => { if (event === 'liveness_probe') logs.push(data.state); }, now: h.now, sleep: async (ms) => { slept.push(ms); } });
    if (stopFirst) exit.stop();
    const out = { ok: await exit.probe(), gets, slept: slept.length };
    seen.push(logs);
    return out;
  };
  const seen = [];
  assert.deepEqual(await run([connectTimeout(), connectTimeout(), { url: 'x' }]), { ok: true, gets: 3, slept: 2 });
  assert.deepEqual(await run([connectTimeout(), connectTimeout(), connectTimeout(), { url: 'x' }]), { ok: false, gets: 3, slept: 2 }, 'a real outage still fails the tick');
  assert.deepEqual(await run([new ApiError('API Error [/gateway]: nope', 500, '/gateway'), { url: 'x' }]), { ok: false, gets: 1, slept: 0 });
  assert.deepEqual(await run([new ApiError('Network error [/gateway]: fetch failed | other side closed', 0, '/gateway'), { url: 'x' }]), { ok: false, gets: 1, slept: 0 });
  assert.deepEqual(await run([{ url: 'x' }], { stopFirst: true }), { ok: false, gets: 0, slept: 0 });
  assert.deepEqual(seen, [['not_connected', 'not_connected'], ['not_connected', 'not_connected', 'not_connected'], ['error_other'], ['error_other'], []], 'the real Gateway shows which case it hit');
});

test('the classifier against the real SDK and real sockets: refused counts as not sent, a socket lost after the request does not', async () => {
  const { ApiClient } = await import('@tencent-connect/qqbot-nodejs/protocol');
  const net = await import('node:net');
  const listen = (handler) => new Promise((resolve) => { const s = net.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const fail = (client) => client.request('FAKE', 'POST', '/x', { a: 1 }).then(() => assert.fail('it should have failed'), (e) => e);

  const closed = await listen(() => {});
  const closedPort = closed.address().port;
  await new Promise((r) => closed.close(r));
  const refused = await fail(new ApiClient({ baseUrl: `http://127.0.0.1:${closedPort}` }));
  assert.equal(isDefinitelyNotSent(refused), true, refused.message);

  let received = 0;
  const dying = await listen((s) => { s.once('data', () => { received += 1; s.destroy(); }); });
  const lost = await fail(new ApiClient({ baseUrl: `http://127.0.0.1:${dying.address().port}` }));
  await new Promise((r) => dying.close(r));
  assert.equal(received, 1, 'control: the request did reach the server');
  assert.equal(isDefinitelyNotSent(lost), false, lost.message);
});

test('a reused socket that dies on the second POST does not count as not sent, even with the listener gone', async () => {
  const { ApiClient } = await import('@tencent-connect/qqbot-nodejs/protocol');
  const http = await import('node:http');
  let requests = 0;
  let connections = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    requests += 1;
    if (requests === 1) {
      res.setHeader('content-type', 'application/json');
      res.end('{"id":"S1"}');
      return;
    }
    server.close();
    req.socket.destroy();
  });
  server.on('connection', () => { connections += 1; });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const client = new ApiClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
  await client.request('FAKE', 'POST', '/x', { a: 1 });
  // The socket goes back to the pool a moment after the body is read. A request sent sooner opens a new one.
  await new Promise((r) => setTimeout(r, 100));
  const lost = await client.request('FAKE', 'POST', '/x', { a: 2 }).then(() => assert.fail('it should have failed'), (e) => e);
  assert.equal(requests, 2, 'control: the second request reached the server');
  assert.equal(connections, 1, 'control: on the same socket');
  assert.equal(isDefinitelyNotSent(lost), false, lost.message);
});

test('through the real QQBot: a token host that cannot be reached counts as not sent, and the API host saw nothing', async () => {
  const { QQBot } = await import('@tencent-connect/qqbot-nodejs');
  const net = await import('node:net');
  const http = await import('node:http');
  const closed = net.createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const tokenPort = closed.address().port;
  await new Promise((r) => closed.close(r));
  let apiRequests = 0;
  const api = http.createServer((req, res) => { apiRequests += 1; res.end('{}'); });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const bot = new QQBot({ appId: 'APP', appSecret: 'FAKE', accountId: 'default', baseUrl: `http://127.0.0.1:${api.address().port}`, tokenBaseUrl: `http://127.0.0.1:${tokenPort}`, intents: 1 << 25, userAgent: 'test' });
  const err = await bot.api.post('/v2/groups/G/messages', { content: 'x' }).then(() => assert.fail('it should have failed'), (e) => e);
  await new Promise((r) => api.close(r));
  assert.equal(apiRequests, 0);
  assert.equal(isDefinitelyNotSent(err), true, err.message);
});

test('40054010 removes every URL, resends once under a new seq, and never disguises one', async () => {
  const h = stack();
  h.replyText = '看 https://a.example/x 或者 HTTP://B.example/y 都行';
  const inbound = { text: '这两个呢 https://a.example/x HTTP://B.example/y' };
  const e = await ask(h, { inbound }, bizError(40054010), { id: 'S2' });
  assert.equal(h.state(e), 'completed:sent');
  assert.equal(h.posts.length, 2);
  assert.ok(!/https?:/i.test(h.posts[1].body.content));
  assert.equal(h.posts[1].body.content, '看 [链接已移除] 或者 [链接已移除] 都行');
  assert.equal(h.posts[1].body.msg_id, h.posts[0].body.msg_id);
  assert.ok(h.posts[1].body.msg_seq > h.posts[0].body.msg_seq);
  assert.deepEqual(h.sends(e).map((r) => [r.kind, r.state, r.qq_code]), [['reply', 'failed', 40054010], ['reply_url_stripped', 'sent', null]]);
});

test('40054010 twice is group_error: no third try of the text, and the failure line says it could not answer', async () => {
  const h = stack();
  h.replyText = '看 https://a.example/x';
  const e = await ask(h, { inbound: { text: 'https://a.example/x 呢' } }, bizError(40054010), bizError(40054010));
  assert.equal(h.state(e), 'failed:group_error');
  assert.equal(h.posts.length, 3);
  assert.equal(h.posts[2].body.content, LINES.modelFailed);
  assert.deepEqual(h.sends(e).map((r) => r.kind), ['reply', 'reply_url_stripped', 'fixed_line']);
});

test('40054010 on text with no URL: nothing to remove, so no resend, only the failure line', async () => {
  const h = stack();
  const e = await ask(h, bizError(40054010));
  assert.equal(h.state(e), 'failed:group_error');
  assert.deepEqual(h.posts.map((p) => p.body.content), [h.replyText, LINES.modelFailed]);
});

test('40054010 with part of the reply already out: no failure line, the answer did reach them', async () => {
  const h = stack();
  h.eff.current.qq.maxPartChars = 30;
  h.replyText = '第一句话没有任何链接。\n\n第二句话在这 https://a.example/x 里。';
  const e = await ask(h, { inbound: { text: 'https://a.example/x 呢' } }, { id: 'S1' }, bizError(40054010), bizError(40054010));
  assert.equal(h.state(e), 'failed:group_error');
  assert.equal(h.posts.length, 3, 'the first part, the refused part, its one resend');
  assert.ok(!h.posts.some((p) => p.body.content === LINES.modelFailed));
});

test('40054010 refused twice on an interjection stays silent', async () => {
  const h = stack();
  h.replyText = '看 https://a.example/x';
  const e = await ask(h, { inbound: { text: 'https://a.example/x 有人知道怎么退货吗', isRealAt: false } }, bizError(40054010), bizError(40054010));
  h.advance(4000);
  await h.gate.idle();
  assert.equal(h.state(e), 'failed:group_error');
  assert.equal(h.posts.length, 2);
});

// One long reply against the default four sends a minute: each part holds a URL, so all four are resent.
const FOUR_PARTS = [1, 2, 3, 4].map((n) => `第${n}段看这里 https://a.example/x 就行。`).join('\n\n');
const WITH_URL = { inbound: { text: 'https://a.example/x 呢' } };
const fourParts = (h) => {
  h.eff.current.qq.maxPartChars = 40;
  h.replyText = FOUR_PARTS;
};

test('40054010 at the send rate: a required answer waits once for room and goes out whole', async () => {
  const h = stack();
  fourParts(h);
  h.onSleep = (ms) => { h.clock.t += ms; };
  const e = await ask(h, WITH_URL, bizError(40054010));
  assert.equal(h.state(e), 'completed:sent');
  assert.equal(h.slept.length, 1, 'it did wait');
  assert.ok(h.slept[0] > 0 && h.slept[0] <= 60000, String(h.slept[0]));
  assert.equal(h.posts.length, 5);
  assert.ok(h.posts.slice(1).every((p) => !p.body.content.includes('http')));
  assert.deepEqual(h.sends(e).map((r) => [r.kind, r.state]), [
    ['reply', 'failed'], ['reply', 'aborted'], ['reply', 'aborted'], ['reply', 'aborted'],
    ['reply_url_stripped', 'sent'], ['reply_url_stripped', 'sent'], ['reply_url_stripped', 'sent'], ['reply_url_stripped', 'sent'],
  ]);
  assert.equal(h.store.listAlerts().some((a) => a.kind === 'send_rate'), false);
});

test('40054010 with no time left to wait: refused for rate, and the failure line goes out as nothing else did', async () => {
  const h = stack();
  fourParts(h);
  h.mid = () => { h.clock.t += 270000; };
  const e = await ask(h, WITH_URL, bizError(40054010));
  assert.equal(h.state(e), 'failed:send_rate');
  assert.deepEqual(h.slept, []);
  assert.equal(h.posts.length, 2);
  assert.equal(h.posts[1].body.content, LINES.modelFailed);
  assert.ok(h.store.listAlerts().some((a) => a.kind === 'send_rate'));
});

test('40054010 with no time left and part of the reply out: refused for rate, with no failure line', async () => {
  const h = stack();
  fourParts(h);
  h.mid = () => { h.clock.t += 270000; };
  const e = await ask(h, WITH_URL, { id: 'S1' }, bizError(40054010));
  assert.equal(h.state(e), 'failed:send_rate');
  assert.equal(h.posts.length, 2);
  assert.ok(!h.posts.some((p) => p.body.content === LINES.modelFailed));
});

test('40054010 at the rate on an interjection: no wait, no line', async () => {
  const h = stack(makeEffective({ limits: { sendGroupPerMin: 1, sendAccountPerMin: 100 } }));
  h.replyText = '看 https://a.example/x';
  const e = await ask(h, { inbound: { text: 'https://a.example/x 有人知道怎么退货吗', isRealAt: false } }, bizError(40054010));
  h.advance(4000);
  await h.gate.idle();
  assert.equal(h.state(e), 'failed:send_rate');
  assert.deepEqual(h.slept, []);
  assert.equal(h.posts.length, 1);
});

test('a pause during the URL-refused post stops the resend before it takes any send row', async () => {
  const h = stack();
  h.replyText = '看 https://a.example/x';
  h.onPost = () => h.store.setControl('global_paused', 'test', 'test');
  const e = await ask(h, WITH_URL, bizError(40054010));
  assert.equal(h.state(e), 'paused:paused');
  assert.equal(h.posts.length, 1);
  assert.deepEqual(h.sends(e).map((r) => r.kind), ['reply']);
});

test('a pause during the wait for resend room stops the resend', async () => {
  const h = stack();
  fourParts(h);
  h.onSleep = (ms) => {
    h.clock.t += ms;
    h.store.setControl('global_paused', 'test', 'test');
  };
  const e = await ask(h, WITH_URL, bizError(40054010));
  assert.equal(h.slept.length, 1, 'it did wait');
  assert.equal(h.state(e), 'paused:paused');
  assert.equal(h.posts.length, 1);
  assert.equal(h.sends(e).some((r) => r.kind === 'reply_url_stripped'), false);
});

// ---- the hard stops between parts ----

const threeParts = (h) => {
  h.eff.current.qq.maxPartChars = 12;
  h.replyText = THREE_PARTS;
};

test('positive control: with nothing in the way all three parts go out', async () => {
  const h = stack();
  threeParts(h);
  const e = await ask(h);
  assert.equal(h.state(e), 'completed:sent');
  assert.deepEqual(h.sends(e).map((r) => r.state), ['sent', 'sent', 'sent']);
});

for (const [name, expected, stop] of [
  ['global pause', 'paused:paused', (h) => h.store.setControl('global_paused', 'test', 'test')],
  ['group pause', 'paused:paused', (h) => h.store.setControl(`group_paused:${h.store.key(GROUP_A)}`, 'test', 'test')],
  ['dry-run', 'failed:exit_refused', (h) => { h.eff.current = { ...h.eff.current, mode: 'dry-run' }; }],
  ['terminal latch', 'failed:exit_refused', (h) => h.store.setControl('terminal_close', '4914', 'test')],
  ['group removed', 'failed:exit_refused', (h) => { h.eff.current = { ...h.eff.current, qq: { ...h.eff.current.qq, groups: {} } }; }],
  ['a different bot', 'failed:exit_refused', (h) => { h.eff.current = { ...h.eff.current, qq: { ...h.eff.current.qq, appId: 'OTHER-APP' } }; }],
  ['exit stopped', 'failed:exit_refused', (h) => h.exit.stop()],
  ['deadline', 'failed:deadline', (h) => { h.clock.t += 400000; }],
  ['deadline and a pause: the deadline is what gets reported', 'failed:deadline', (h) => {
    h.clock.t += 400000;
    h.store.setControl('global_paused', 'test', 'test');
  }],
]) {
  test(`${name} between two parts stops the rest: ${expected}`, async () => {
    const h = stack();
    threeParts(h);
    h.onPost = () => stop(h);
    const e = await ask(h);
    assert.equal(h.state(e), expected);
    assert.equal(h.posts.length, 1);
    assert.deepEqual(h.sends(e).map((r) => r.state), ['sent', 'aborted', 'aborted']);
  });
}

// The owner's /stop lands while the first part is on the wire.
function stopDuringFirstPost(h, senderId = OWNER) {
  let sent = false;
  h.onPost = async () => {
    if (sent) return;
    sent = true;
    h.clock.t += 1000;
    await h.send(h.at({ text: '/stop', senderId }));
  };
}

test('/stop between two parts: the rest stay unsent and the ack goes out', async () => {
  const h = stack();
  threeParts(h);
  stopDuringFirstPost(h);
  const e = await ask(h, { inbound: { senderId: MEMBER } });
  await h.gate.idle();
  assert.equal(h.state(e), 'failed:aborted');
  assert.deepEqual(h.sends(e).map((r) => r.state), ['sent', 'aborted', 'aborted']);
  assert.equal(h.posts.filter((p) => p.body.msg_id === e.messageId).length, 1);
  assert.equal(h.posts.length, 2, 'the part and the ack');
});

test('/stop between two parts of a reply to a person in danger: it still goes out whole', async () => {
  const h = stack();
  threeParts(h);
  stopDuringFirstPost(h);
  const e = await ask(h, { inbound: { senderId: MEMBER, text: CRISIS } });
  await h.gate.idle();
  assert.equal(h.state(e), 'completed:sent');
  assert.deepEqual(h.sends(e).map((r) => r.state), ['sent', 'sent', 'sent']);
});

test("a member's /stop between two parts changes nothing", async () => {
  const h = stack();
  threeParts(h);
  stopDuringFirstPost(h, MEMBER2);
  const e = await ask(h, { inbound: { senderId: MEMBER } });
  await h.gate.idle();
  assert.equal(h.state(e), 'completed:sent');
  assert.equal(h.posts.length, 3);
});

test('/stop during a connect retry: not tried again, no alert about the connection', async () => {
  const h = stack();
  h.onSleep = async () => {
    h.clock.t += 1000;
    await h.send(h.at({ text: '/stop', senderId: OWNER }));
  };
  const e = await ask(h, { inbound: { senderId: MEMBER } }, connectTimeout());
  await h.gate.idle();
  assert.equal(h.state(e), 'failed:aborted');
  assert.equal(h.posts.filter((p) => p.body.msg_id === e.messageId).length, 1);
  assert.equal(h.sends(e)[0].state, 'failed');
  assert.equal(h.store.listAlerts().some((a) => a.kind === 'send_not_connected'), false);
});

// ---- the wait for send-rate room can be cut short ----

const fillRate = (h) => {
  h.store.insertSendParts({ eventKey: 'filler', groupKey: h.store.key(GROUP_A), kind: 'reply', parts: [1, 2, 3, 4].map((n) => ({ textSha: String(n) })), now: h.now() });
};
const within = (promise, ms = 5000) => {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('it was still asleep')), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
};

test('/stop wakes a reply waiting for send-rate room: the queue is free long before the wait would end', async () => {
  const h = stack();
  fillRate(h);
  let parked = false;
  // The wait never ends by itself. Only the ack, which waits as well, moves the clock on.
  h.onSleep = (ms) => {
    if (parked) {
      h.clock.t += ms;
      return undefined;
    }
    parked = true;
    setImmediate(() => {
      h.clock.t += 1000;
      h.send(h.at({ text: '/stop', senderId: OWNER }));
    });
    return new Promise(() => {});
  };
  h.clock.t += 1000;
  const e = await h.send(h.at({ senderId: MEMBER }));
  await within(h.gate.idle());
  assert.equal(h.state(e), 'failed:aborted');
  assert.equal(h.posts.filter((p) => p.body.msg_id === e.messageId).length, 0);
});

test('exit.stop() wakes a reply waiting for send-rate room', async () => {
  const h = stack();
  fillRate(h);
  h.onSleep = () => {
    setImmediate(() => h.exit.stop());
    return new Promise(() => {});
  };
  h.clock.t += 1000;
  const e = await h.send(h.at({ senderId: MEMBER }));
  await within(h.gate.idle(), 200);
  assert.equal(h.state(e), 'failed:exit_refused');
  assert.equal(h.posts.length, 0);
});

// ---- the failure line's hourly slot ----

test('a failure line refused for send rate does not spend the hourly slot, and one that goes out does', async () => {
  const h = stack();
  h.eff.current.limits.failureLinePerGroupPerHour = 1;
  fillRate(h);
  const ref = { eventKey: h.store.key('EVENT'), groupKey: h.store.key(GROUP_A), groupId: GROUP_A, messageId: 'MESSAGE', receivedAt: h.now(), msgTs: h.now() };
  const key = `failline:${ref.groupKey}:${Math.floor(h.now() / 3600000)}`;

  const refused = await h.exit.sendFixed(ref, 'modelFailed');
  assert.deepEqual([refused.sent, refused.reason], [false, 'send_rate']);
  assert.equal(h.store.peekCounter(key), 0);
  assert.equal(h.posts.length, 0);

  h.clock.t += 61000;
  ref.receivedAt = h.now();
  ref.msgTs = h.now();
  const sent = await h.exit.sendFixed(ref, 'modelFailed');
  assert.equal(sent.sent, true);
  assert.equal(h.store.peekCounter(key), 1);
  assert.equal(h.posts.length, 1);

  const spent = await h.exit.sendFixed(ref, 'modelFailed');
  assert.deepEqual([spent.sent, spent.reason], [false, 'failline_rate']);
  assert.equal(h.posts.length, 1);
});

test('40054005 with no prior row of that text: uncertain, not assumed sent', async () => {
  const h = stack();
  const e = await ask(h, bizError(40054005));
  assert.equal(h.state(e), 'failed:send_uncertain');
  assert.equal(h.sends(e)[0].state, 'uncertain');
  assert.equal(h.sends(e)[0].qq_code, 40054005);
});

test('40054005 with a prior sent row of the same text under this message: sent', async () => {
  const h = stack();
  h.replyText = '第一段重复的内容。\n\n第一段重复的内容。';
  // Force two parts of the same text by a part limit smaller than one sentence pair.
  h.eff.current.qq.maxPartChars = 10;
  const e = await ask(h, { id: 'S1' }, bizError(40054005));
  assert.equal(h.posts.length, 2);
  assert.equal(h.posts[0].body.content, h.posts[1].body.content, 'positive control: the same text');
  assert.equal(h.sends(e)[1].state, 'sent');
  assert.equal(h.state(e), 'completed:sent');
});

for (const code of [40034128, 40034005, 304103]) {
  test(`${code}: passive window closed, alert on an addressed turn, no proactive retry`, async () => {
    const h = stack();
    const e = await ask(h, bizError(code), { id: 'never' });
    assert.equal(h.state(e), 'failed:passive_expired');
    assert.equal(h.sends(e)[0].state, 'failed');
    assert.equal(h.sends(e)[0].qq_code, code);
    assert.equal(h.posts.length, 1);
    assert.ok(h.posts[0].body.msg_id);
    assert.ok(h.store.listAlerts().some((a) => a.kind === 'passive_expired'));
  });
}

test('40034006: failed, no retry, no fixed line, and the platform text is nowhere', async () => {
  const h = stack();
  const e = await ask(h, bizError(40034006), { id: 'never' });
  assert.equal(h.state(e), 'failed:platform_violation');
  assert.equal(h.posts.length, 1, 'no retry or fixed line');
  assert.equal(h.store.getControl('interject_paused'), null, 'one is not a latch');
  assert.ok(!JSON.stringify(h.logs).includes('PLATFORM-TEXT'));
  assert.ok(!JSON.stringify(h.store.listAlerts()).includes('PLATFORM-TEXT'));
  assert.ok(!JSON.stringify(h.allEvents()).includes('PLATFORM-TEXT'));
});

test('two 40034006 in one day latch interjection and alert; a real @ still gets its try', async () => {
  const h = stack();
  await ask(h, bizError(40034006));
  await ask(h, bizError(40034006));
  assert.equal(h.store.getControl('interject_paused'), 'platform_violation');
  assert.ok(h.store.listAlerts().some((a) => a.kind === 'interject_latched'));
  const e = await ask(h, { id: 'S3' });
  assert.equal(h.state(e), 'completed:sent');
});

for (const code of [40054002, 40034101, 40054003]) {
  test(`${code}: this group pauses itself and alerts`, async () => {
    const h = stack();
    const e = await ask(h, bizError(code));
    assert.equal(h.state(e), 'failed:group_error');
    assert.notEqual(h.store.getControl(`group_paused:${h.store.key(GROUP_A)}`), null);
    assert.ok(h.store.listAlerts().some((a) => a.kind === 'group_error'));
    const next = await ask(h, { id: 'never' });
    assert.equal(h.state(next), 'paused:paused');
    assert.equal(h.posts.length, 1);
  });
}

for (const code of [40034105, 40034100, 40054013]) {
  test(`${code}: a DM code here is group_error with an alert and no pause`, async () => {
    const h = stack();
    const e = await ask(h, bizError(code));
    assert.equal(h.state(e), 'failed:group_error');
    assert.equal(h.store.getControl(`group_paused:${h.store.key(GROUP_A)}`), null);
    assert.ok(h.store.listAlerts().some((a) => a.kind === 'group_error'));
  });
}

for (const [label, err] of [
  ['network error, httpStatus 0', new ApiError('Network error [/x]: ECONNRESET', 0, '/x')],
  ['timeout, httpStatus 0', new ApiError('Request timeout [/x]', 0, '/x')],
  ['unknown code', bizError(12345)],
  ['HTTP 500 with no code', new ApiError('API Error', 500, '/x')],
  ['a plain Error', new Error('socket hang up')],
]) {
  test(`${label}: uncertain, alert, never re-POST`, async () => {
    const h = stack();
    const e = await ask(h, err, { id: 'never' });
    assert.equal(h.state(e), 'failed:send_uncertain');
    assert.equal(h.sends(e)[0].state, 'uncertain');
    assert.equal(h.posts.length, 1);
    assert.ok(h.store.listAlerts().some((a) => a.kind === 'send_uncertain'));
  });
}

test('a failure on part 2 of 3: part 1 stays sent, part 2 is the failure, part 3 is aborted', async () => {
  const h = stack();
  h.eff.current.qq.maxPartChars = 12;
  h.replyText = '第一句话有十一个字。\n\n第二句话有十一个字。\n\n第三句话有十一个字。';
  const e = await ask(h, { id: 'S1' }, bizError(40034006), { id: 'never' });
  assert.equal(h.state(e), 'failed:platform_violation');
  assert.deepEqual(h.sends(e).map((r) => r.state), ['sent', 'failed', 'aborted']);
  assert.equal(h.posts.length, 2);
});

test('the money is kept on every failure', async () => {
  const h = stack();
  const e = await ask(h, bizError(40034006));
  assert.equal(h.reservations(e)[0].status, 'settled');
  assert.ok(h.reservations(e)[0].actual_micros > 0);
});
