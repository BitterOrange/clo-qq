// TQ16, runtime half. global fetch is stubbed and the real SDK object is wrapped in a recording Proxy.
// Scenarios run through the real gate and exit. Only exit may touch the object, and every message-route
// POST must have a sends row; everything else must be the token or gateway route.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { createExit } from '../../src/clo-plugin/lib/channels/qq/exit.js';
import { FAKE_SECRET, makeHarness, USAGE } from '../fixtures/inbound.mjs';

const realFetch = globalThis.fetch;
const calls = [];
let nextMessage = null;

before(() => {
  globalThis.fetch = async (url, init = {}) => {
    const { pathname } = new URL(String(url));
    calls.push({ pathname, method: init.method, body: init.body ?? null });
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (pathname === '/app/getAppAccessToken') return json(200, { access_token: 'T', expires_in: '7200' });
    if (pathname === '/gateway') return json(200, { url: 'ws://127.0.0.1:9/ws' });
    if (nextMessage) {
      const r = nextMessage;
      nextMessage = null;
      return json(r.status, r.body);
    }
    return json(200, { id: `S${calls.length}`, timestamp: 'now' });
  };
});
after(() => {
  globalThis.fetch = realFetch;
});

const THIS_FILE = /qq-exit-runtime\.test/;
function record(sdk, touched) {
  return new Proxy(sdk, {
    get(target, prop) {
      const stack = new Error().stack;
      touched.push({ prop: String(prop), byExit: /[\\/]lib[\\/]channels[\\/]qq[\\/]exit\.js/.test(stack), fromTest: THIS_FILE.test(stack) && !/exit\.js/.test(stack) });
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

function stack() {
  const touched = [];
  const sdk = new QQBot({ appId: 'FAKE-APP', appSecret: FAKE_SECRET, accountId: 'default', baseUrl: 'http://qq.invalid', tokenBaseUrl: 'http://qq.invalid', intents: 1 << 25, userAgent: 'test' });
  const bot = record(sdk, touched);
  let h;
  h = makeHarness({ attach: false, dispatch: async (turn) => {
    if (h.replyText !== null) h.exit.collect(turn.turnId, { text: h.replyText }, { kind: 'final' });
    return { started: true, hostError: false, aborted: false, usage: USAGE };
  } });
  h.exit = createExit({ bot, store: h.store, policy: h.policy, getEffective: () => h.eff.current, secrets: [], log: h.log, now: h.now });
  h.gate.attachExit(h.exit);
  h.replyText = '干净的回复。';
  return { h, touched, bot };
}

const messageCalls = () => calls.filter((c) => /\/messages$/.test(c.pathname));

test('every scenario: message POSTs have rows, the rest are token only, and only exit touched the object', async () => {
  const { h, touched } = stack();
  // Plain reply, fixed line, URL-stripped resend, content policy drop, platform refusal, probe.
  await h.sendAndFlush(h.at());
  h.advance(20000);
  h.replyText = null;
  await h.sendAndFlush(h.at());
  h.advance(20000);
  h.replyText = '看 https://x.example 这里';
  nextMessage = { status: 400, body: { code: 40054010, message: 'url' } };
  await h.sendAndFlush(h.at({ text: 'https://x.example 这个呢' }));
  h.advance(20000);
  h.replyText = '可以 加我 约炮';
  await h.sendAndFlush(h.at());
  h.advance(20000);
  h.replyText = '干净的回复。';
  nextMessage = { status: 400, body: { code: 40034006, message: 'bad' } };
  await h.sendAndFlush(h.at());
  h.advance(20000);
  assert.equal(await h.exit.probe(), true);

  const posts = messageCalls();
  assert.ok(posts.length >= 5, `positive control: ${posts.length} message POSTs`);
  const shas = new Map();
  for (const r of h.store.q('SELECT text_sha, state FROM sends').all()) shas.set(r.text_sha, (shas.get(r.text_sha) ?? 0) + 1);
  const rowsTotal = [...shas.values()].reduce((a, b) => a + b, 0);
  assert.equal(rowsTotal, posts.length, 'one row per POST');
  for (const p of posts) {
    assert.equal(p.method, 'POST');
    const body = JSON.parse(p.body);
    assert.ok(body.msg_id, 'msg_id');
    assert.ok(body.msg_seq >= 1, 'msg_seq');
    const sha = createHash('sha256').update(body.content, 'utf8').digest('hex');
    assert.ok(shas.get(sha) > 0, 'a sends row for this POST');
  }
  const rest = calls.filter((c) => !/\/messages$/.test(c.pathname));
  assert.ok(rest.every((c) => ['/app/getAppAccessToken', '/gateway'].includes(c.pathname)), JSON.stringify(rest.map((c) => c.pathname)));
  assert.ok(rest.some((c) => c.pathname === '/gateway' && c.method === 'GET'), 'the probe is a GET');

  assert.ok(touched.length > 0, 'positive control: the proxy saw the exit use it');
  const notExit = touched.filter((t) => !t.byExit);
  assert.deepEqual(notExit, []);
  const members = new Set(touched.map((t) => t.prop));
  assert.deepEqual([...members].sort(), ['api', 'appId'], 'the exit used only these');
  await h.close();
});

test('control: the recorder would catch access from anywhere else', () => {
  const { h, touched, bot } = stack();
  touched.length = 0;
  void bot.sendText;
  assert.equal(touched.length, 1);
  assert.equal(touched[0].byExit, false);
  return h.close();
});

test('a stopped exit reaches neither fetch nor the object', async () => {
  const { h, touched } = stack();
  h.exit.stop();
  const before_ = calls.length;
  touched.length = 0;
  await h.exit.commandAck({ eventKey: 'e', groupKey: 'g', groupId: 'x', messageId: 'M', receivedAt: h.now(), msgTs: h.now() }, '好');
  await h.exit.probe();
  assert.equal(calls.length, before_);
  assert.equal(touched.length, 0);
  await h.close();
});
