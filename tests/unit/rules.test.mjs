// Pure local rules and the in-memory context ring.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContextBuffer, estimateTokens } from '../../src/clo-plugin/lib/core/context.js';
import { CRISIS_ELIGIBLE, evaluateOrdinary, extractUrls, isNoise, pickRepresentative, selectNameRecords } from '../../src/clo-plugin/lib/core/rules.js';
import { groupEntry, inbound, makeEffective, T0 } from '../fixtures/inbound.mjs';

const { limits } = makeEffective();

const base = (over = {}) => ({
  group: groupEntry(),
  evt: inbound({ text: '有人知道这个怎么做吗' }),
  prerule: false,
  quiet: false,
  interjectPeek: { ok: true },
  pause: { interject: false },
  windowCount: 1,
  limits,
  now: T0,
  ...over,
});

test('evaluateOrdinary passes a clean message', () => {
  assert.deepEqual(evaluateOrdinary(base()), { ok: true });
});

test('evaluateOrdinary: first failure wins, in the documented order', () => {
  const bad = {
    group: groupEntry({ interject: false }),
    pause: { interject: true },
    quiet: true,
    interjectPeek: { ok: false, reason: 'cooldown' },
    evt: inbound({ text: '嗯' }),
    windowCount: 99,
    prerule: true,
  };
  const order = [['group', 'interject_off'], ['pause', 'interject_latch'], ['quiet', 'quiet'], ['interjectPeek', 'cooldown'], ['evt', 'noise'], ['windowCount', 'flood'], ['prerule', 'prerule']];
  let current = base(bad);
  for (const [field, reason] of order) {
    assert.deepEqual(evaluateOrdinary(current), { ok: false, reason });
    current = { ...current, [field]: base()[field] };
  }
  assert.deepEqual(evaluateOrdinary(current), { ok: true });
});

test('peek reasons pass through unchanged', () => {
  for (const reason of ['cooldown', 'hour', 'day', 'inflight']) {
    assert.equal(evaluateOrdinary(base({ interjectPeek: { ok: false, reason } })).reason, reason);
  }
});

test('flood is over the limit, not at it', () => {
  assert.equal(evaluateOrdinary(base({ windowCount: limits.floodPerWindow })).ok, true);
  assert.equal(evaluateOrdinary(base({ windowCount: limits.floodPerWindow + 1 })).reason, 'flood');
});

test('crisis may rescue only the documented failures', () => {
  assert.deepEqual([...CRISIS_ELIGIBLE].sort(), ['cooldown', 'day', 'hour', 'inflight', 'prerule', 'quiet']);
});

test('noise: too short, emoji only, punctuation only, placeholder only', () => {
  for (const text of ['嗯', '😀', '😀😀😀', '👍🏻', '🇨🇳', '！！！', '...', '  ', '<faceType=1,faceId="5">']) {
    assert.equal(isNoise(inbound({ text }), limits), true, text);
  }
  assert.equal(isNoise(inbound({ text: '[图片]', placeholders: ['[图片]'], hasUserText: false }), limits), true);
  for (const text of ['你好', 'ok', '12', '好的😀', '求助！']) assert.equal(isNoise(inbound({ text }), limits), false, text);
  assert.equal(isNoise(inbound({ text: '你看 [图片]', placeholders: ['[图片]'], hasUserText: true }), limits), false);
  assert.equal(isNoise(inbound({ text: '嗯 [图片]', placeholders: ['[图片]'], hasUserText: true }), limits), true);
});

test('representative: last name, else last with substance, else last with text, else none', () => {
  const r = (over) => ({ cls: over.cls ?? 'ordinary', evt: inbound(over) });
  const a = r({ text: '第一条消息' });
  const b = r({ text: '可洛你看', cls: 'name' });
  const c = r({ text: '第三条消息' });
  const d = r({ text: '嗯' });
  const img = r({ text: '[图片]', placeholders: ['[图片]'], hasUserText: false });
  assert.equal(pickRepresentative([a, b, c], limits), b);
  assert.equal(pickRepresentative([a, c], limits), c);
  assert.equal(pickRepresentative([a, d], limits), a, 'a trailing "嗯" must not bury the message before it');
  assert.equal(pickRepresentative([d, img], limits), d);
  assert.equal(pickRepresentative([img], limits), null);
  assert.equal(pickRepresentative([], limits), null);
});

test('name selection: each sender\'s last, in arrival order, name class with user text only', () => {
  const r = (senderKey, over = {}) => ({ senderKey, cls: over.cls ?? 'name', evt: { hasUserText: over.hasUserText ?? true } });
  const a1 = r('a');
  const b1 = r('b');
  const a2 = r('a');
  assert.deepEqual(selectNameRecords([a1, b1, a2], limits), [b1, a2], 'a sender moves to where their last message arrived');
  assert.deepEqual(selectNameRecords([a1, r('b', { cls: 'ordinary' }), r('c', { hasUserText: false })], limits), [a1]);
  assert.deepEqual(selectNameRecords([r('a', { cls: 'ordinary' })], limits), []);
  assert.deepEqual(selectNameRecords([], limits), []);
});

test('name selection: past the cap the newest senders stay; a bad or missing cap judges one, never all', () => {
  const r = (senderKey) => ({ senderKey, cls: 'name', evt: { hasUserText: true } });
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(r);
  assert.equal(limits.nameWindowMax, 3);
  assert.deepEqual(selectNameRecords([a, b, c, d], limits), [b, c, d]);
  assert.deepEqual(selectNameRecords([a, b], limits), [a, b]);
  assert.deepEqual(selectNameRecords([a, b, c, d], { nameWindowMax: 2 }), [c, d]);
  for (const nameWindowMax of [undefined, 0, -1, 'x']) assert.deepEqual(selectNameRecords([a, b, c, d], { nameWindowMax }), [d], String(nameWindowMax));
});

test('extractUrls finds URLs in the form the guard compares, stops at CJK punctuation, removes duplicates', () => {
  assert.deepEqual(extractUrls('看 https://a.example/x，还有 http://b.example/y?q=1。'), ['https://a.example/x', 'http://b.example/y?q=1']);
  assert.deepEqual(extractUrls('HTTPS://A.example https://a.example https://a.example'), ['https://a.example']);
  assert.deepEqual(extractUrls('看 www.example.com 和 evil.example.com/path'), ['www.example.com', 'evil.example.com/path']);
  assert.deepEqual(extractUrls('没有链接 v1.2'), []);
  assert.deepEqual(extractUrls(undefined), []);
});

const ctx = (over = {}) => createContextBuffer({ maxItems: 40, maxAgeMs: 24 * 3600000, maxTokens: 3000, ...over });
const line = (i, ts = T0, senderKey = 's1') => ({ senderKey, text: `消息${i}`, ts, eventKey: `e${i}` });

test('context: item cap keeps the newest, in order', () => {
  const c = ctx({ maxItems: 3 });
  for (let i = 0; i < 5; i += 1) c.push('g', line(i));
  assert.deepEqual(c.history('g', null, T0).map((h) => h.body), ['消息2', '消息3', '消息4']);
});

test('context: age cap, exclusion and the host history shape', () => {
  const c = ctx({ maxAgeMs: 1000 });
  c.push('g', line(1, T0));
  c.push('g', line(2, T0 + 900));
  assert.deepEqual(c.history('g', null, T0 + 1000), [
    { sender: 'U1', body: '消息1', timestamp: T0 },
    { sender: 'U1', body: '消息2', timestamp: T0 + 900 },
  ]);
  assert.deepEqual(c.history('g', 'e2', T0 + 1000).map((h) => h.body), ['消息1']);
  assert.deepEqual(c.history('g', null, T0 + 1001).map((h) => h.body), ['消息2']);
});

test('context: the token cap drops the oldest whole lines', () => {
  const c = ctx({ maxTokens: estimateTokens('消息1') * 2 });
  for (let i = 1; i <= 4; i += 1) c.push('g', line(i));
  assert.deepEqual(c.history('g', null, T0).map((h) => h.body), ['消息3', '消息4']);
});

test('context: token estimate is high for CJK and low for ASCII', () => {
  assert.equal(estimateTokens('你好'), 4);
  assert.equal(estimateTokens('abcdef'), 2);
  assert.equal(estimateTokens(''), 0);
});

test('context: pseudonyms by first appearance, per group, and they survive eviction', () => {
  const c = ctx({ maxItems: 1 });
  assert.equal(c.push('g', line(1, T0, 'a')), 'U1');
  assert.equal(c.push('g', line(2, T0, 'b')), 'U2');
  assert.equal(c.push('g', line(3, T0, 'a')), 'U1');
  assert.equal(c.push('other', line(4, T0, 'b')), 'U1');
  assert.equal(c.pseudonym('g', 'b'), 'U2');
  assert.equal(c.pseudonym('g', 'c'), 'U3');
});

test('context: groups never see each other', () => {
  const c = ctx();
  c.push('g1', line(1));
  c.push('g2', line(2));
  assert.deepEqual(c.history('g1', null, T0).map((h) => h.body), ['消息1']);
  assert.deepEqual(c.lines('g2', null, 10, 50, T0).map((l) => l.text), ['消息2']);
  assert.deepEqual(c.history('nope', null, T0), []);
});

test('context: lines are counted and clamped by character, not by UTF-16 unit', () => {
  const c = ctx();
  for (let i = 0; i < 5; i += 1) c.push('g', { senderKey: 's', text: `😀😀😀${i}`, ts: T0, eventKey: `e${i}` });
  const out = c.lines('g', null, 2, 2, T0);
  assert.deepEqual(out, [{ sender: 'U1', text: '😀😀' }, { sender: 'U1', text: '😀😀' }]);
  assert.deepEqual(Object.keys(out[0]).sort(), ['sender', 'text'], 'no sender key or event key leaves this module');
});

test('context: sweep removes expired text from memory, clear empties a group', () => {
  const c = ctx({ maxAgeMs: 1000 });
  c.push('g', line(1, T0));
  c.push('g2', line(2, T0 + 5000));
  assert.equal(c.sweep(T0 + 5000), 1);
  c.clear('g2');
  assert.equal(c.sweep(T0 + 5000), 0);
});
