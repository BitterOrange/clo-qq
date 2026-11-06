// The context buffer's caps: a very long line must not empty a turn's history, and caps can change while it runs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContextBuffer, estimateTokens, OWN_IDLE_MS, OWN_LABEL } from '../../src/clo-plugin/lib/core/context.js';
import { atEvent, decisionOf, inbound, makeHarness, MEMBER, MEMBER2, T0 } from '../fixtures/inbound.mjs';

const buffer = (over = {}) => createContextBuffer({ maxItems: 40, maxAgeMs: 3600000, maxTokens: 3000, ...over });
const say = (c, eventKey, text, over = {}) => c.push('g', { senderKey: 's1', text, ts: T0, eventKey, ...over });
const LONG = '长'.repeat(5000);
const SHORT = '先看这一句';

test('a line over the whole cap is shortened, and the lines before it stay', () => {
  const c = buffer();
  say(c, 'before', SHORT);
  say(c, 'long', LONG);
  const out = c.history('g', 'current', T0);
  assert.equal(out.length, 2);
  assert.equal(out[0].body, SHORT);
  assert.ok(out[1].body.startsWith('长长长'));
  assert.match(out[1].body, /后面省略/, 'the reader is told the line was cut');
  assert.ok(estimateTokens(out[1].body) <= 1500, 'held to half the cap');
  assert.ok(out.reduce((n, l) => n + estimateTokens(l.body), 0) <= 3000);
});

test('ASCII is cut by its own cost, and a character outside the BMP is not split', () => {
  const c = buffer();
  say(c, 'ascii', 'a'.repeat(30000));
  const ascii = c.history('g', 'current', T0)[0].body;
  assert.ok(estimateTokens(ascii) <= 1500);
  assert.ok(ascii.length > 4000, 'three ASCII characters cost one token');

  const d = buffer();
  say(d, 'emoji', '😀'.repeat(5000));
  const emoji = d.history('g', 'current', T0)[0].body;
  assert.ok(estimateTokens(emoji) <= 1500);
  assert.doesNotMatch(emoji, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});

test('shortening is only in what history returns: lines and later reads see the stored line', () => {
  const c = buffer();
  say(c, 'long', LONG);
  c.history('g', 'current', T0);
  assert.equal(c.lines('g', 'current', 15, 6000, T0)[0].text, LONG);
});

test('a line at the per-line cap comes through untouched, one over it does not', () => {
  const at = '字'.repeat(750);
  assert.equal(estimateTokens(at), 1500);
  const c = buffer();
  say(c, 'at', at);
  assert.equal(c.history('g', 'current', T0)[0].body, at);
  const d = buffer();
  say(d, 'over', `${at}字`);
  assert.notEqual(d.history('g', 'current', T0)[0].body, `${at}字`);
});

test('two long lines fit, and the walk still stops at the cap for older lines', () => {
  const c = buffer();
  say(c, 'oldest', '一'.repeat(100));
  say(c, 'long1', LONG);
  say(c, 'long2', LONG);
  const out = c.history('g', 'current', T0);
  assert.equal(out.length, 2, 'the shortened lines leave too little room for the oldest');
  assert.ok(out.every((l) => /后面省略/.test(l.body)));
});

test('with names shown, a long line keeps its label and the total stays under the cap', () => {
  const c = buffer();
  say(c, 'long', LONG, { displayName: '小明' });
  const out = c.history('g', 'current', T0, { showNames: true });
  assert.equal(out.length, 1);
  assert.match(out[0].sender, /小明/);
  assert.ok(estimateTokens(out[0].body) + estimateTokens(out[0].sender) <= 3000);
});

test('a hidden long line still takes no room and is not returned', () => {
  const c = buffer();
  say(c, 'before', SHORT);
  say(c, 'long', LONG);
  assert.deepEqual(c.history('g', 'current', T0, { hide: new Set(['long']) }).map((l) => l.body), [SHORT]);
});

test('through the gate: an ended long line leaves the next turn with its history', async () => {
  const h = makeHarness({ decide: async () => decisionOf({ action: 'skip' }) });
  await h.send(inbound({ text: SHORT, senderId: MEMBER2 }));
  await h.send(inbound({ text: LONG, senderId: MEMBER2 }));
  h.advance(4000);
  await h.gate.idle();
  assert.equal(h.dispatched.length, 0, 'neither line got a turn of its own');

  await h.send(atEvent({ senderId: MEMBER }));
  await h.gate.idle();
  assert.equal(h.dispatched.length, 1);
  const { history } = h.dispatched[0];
  assert.equal(history.length, 2);
  assert.equal(history[0].body, SHORT);
  assert.match(history[1].body, /后面省略/);
  assert.ok(estimateTokens(history[1].body) <= 1500);
  await h.close();
});

test('configure: a lower item cap drops the oldest lines at once, and stays for later pushes', () => {
  const c = buffer();
  for (let i = 1; i <= 5; i += 1) say(c, `e${i}`, `消息${i}`);
  c.configure({ maxItems: 2 });
  assert.deepEqual(c.history('g', null, T0).map((l) => l.body), ['消息4', '消息5']);
  say(c, 'e6', '消息6');
  assert.deepEqual(c.history('g', null, T0).map((l) => l.body), ['消息5', '消息6']);
  assert.deepEqual(c.lines('g', null, 15, 200, T0).map((l) => l.text), ['消息5', '消息6']);
});

test('configure: a raised item cap keeps more from then on', () => {
  const c = buffer({ maxItems: 1 });
  say(c, 'e1', '消息1');
  say(c, 'e2', '消息2');
  c.configure({ maxItems: 3 });
  say(c, 'e3', '消息3');
  assert.deepEqual(c.history('g', null, T0).map((l) => l.body), ['消息2', '消息3']);
});

test('configure: a lower age cap applies at the next sweep and the next read', () => {
  const c = buffer();
  say(c, 'e1', '消息1');
  c.configure({ maxAgeMs: 1000 });
  assert.equal(c.sweep(T0 + 1000), 1);
  assert.equal(c.sweep(T0 + 1001), 0, 'a sweep alone clears a quiet group');
  const d = buffer();
  say(d, 'e1', '消息1');
  d.configure({ maxAgeMs: 1000 });
  assert.deepEqual(d.history('g', null, T0 + 1001), []);
});

test('configure: a new token cap sets both the total and the per-line cap', () => {
  const c = buffer();
  for (let i = 1; i <= 4; i += 1) say(c, `e${i}`, `消息${i}`);
  c.configure({ maxTokens: estimateTokens('消息1') * 2 });
  assert.deepEqual(c.history('g', null, T0).map((l) => l.body), ['消息3', '消息4']);

  const d = buffer();
  const line = '长'.repeat(1000);
  say(d, 'long', line);
  assert.notEqual(d.history('g', null, T0)[0].body, line, 'over half of the first cap');
  d.configure({ maxTokens: 6000 });
  assert.equal(d.history('g', null, T0)[0].body, line, 'within half of the raised cap');
  d.configure({ maxTokens: 1000 });
  assert.ok(estimateTokens(d.history('g', null, T0)[0].body) <= 500);
});

test('configure: a missing cap stays as it is, and pseudonyms and names survive', () => {
  const c = buffer({ maxItems: 2 });
  say(c, 'e1', '消息1', { displayName: '小明' });
  c.configure();
  c.configure({ maxTokens: 2000 });
  assert.deepEqual(c.history('g', null, T0, { showNames: true }).map((l) => l.sender), ['U1（显示名：小明）']);
  say(c, 'e2', '消息2');
  say(c, 'e3', '消息3');
  assert.equal(c.history('g', null, T0).length, 2, 'the item cap was not touched');
  assert.equal(c.pseudonym('g', 's1'), 'U1');
});

// ---- her own lines (own runtime) ----

test('her own line reads as hers in history, never in the decision lines, and never takes a member label', () => {
  const c = buffer();
  say(c, 'q1', '第一个问题', { displayName: '小明', arrival: 1 });
  c.pushOwn('g', { text: '她的回复', ts: T0 });
  const plain = c.history('g', 'current', T0);
  assert.deepEqual(plain, [
    { sender: 'U1', body: '第一个问题', timestamp: T0 },
    { sender: OWN_LABEL, body: '她的回复', timestamp: T0, own: true },
  ]);
  const named = c.history('g', 'current', T0, { showNames: true });
  assert.equal(named[1].sender, OWN_LABEL, 'no display-name suffix on her line');
  assert.match(named[0].sender, /小明/, 'positive control: the member keeps theirs');
  assert.deepEqual(c.lines('g', 'current', 15, 200, T0).map((l) => l.sender), ['U1']);
  assert.deepEqual(c.ownEarlier('g', 's1', 99), ['q1']);
});

test('her own lines go after the idle time with no turn; a touch restarts it; members stay', () => {
  const c = buffer({ maxAgeMs: 24 * 3600000 });
  say(c, 'q1', '问题');
  c.pushOwn('g', { text: '回复', ts: T0 });
  c.touch('g', T0 + OWN_IDLE_MS);
  assert.equal(c.history('g', 'x', T0 + OWN_IDLE_MS + 1000).length, 2, 'the touch kept her line');
  assert.equal(c.history('g', 'x', T0 + 2 * OWN_IDLE_MS + 1000).length, 1);
  assert.equal(c.history('g', 'x', T0 + 2 * OWN_IDLE_MS + 1000)[0].sender, 'U1');
  // The sweep applies it too, so a quiet group does not keep her text in memory.
  const d = buffer({ maxAgeMs: 24 * 3600000 });
  d.pushOwn('g', { text: '回复', ts: T0 });
  assert.equal(d.sweep(T0 + OWN_IDLE_MS), 1);
  assert.equal(d.sweep(T0 + OWN_IDLE_MS + 1), 0);
});

test('her own lines share the item cap, and clear() takes them with the rest', () => {
  const c = buffer({ maxItems: 2 });
  say(c, 'q1', '问题一');
  c.pushOwn('g', { text: '回复一', ts: T0 });
  say(c, 'q2', '问题二');
  assert.deepEqual(c.history('g', 'x', T0).map((l) => l.body), ['回复一', '问题二']);
  c.clear('g');
  assert.deepEqual(c.history('g', 'x', T0), []);
});
