// Design section 5.2, one row per observed shape.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify } from '../../src/clo-plugin/lib/core/gate.js';
import { inbound } from '../fixtures/inbound.mjs';

const NAMES = ['可洛', '可洛小姐', 'Clo'];
const noRef = () => false;
const cls = (over, hasBotRef = noRef) => classify(inbound(over), { hasBotRef, names: NAMES }).cls;

test('GROUP_AT_MESSAGE_CREATE with no mentions is a real @', () => {
  assert.equal(cls({ eventType: 'GROUP_AT_MESSAGE_CREATE', isRealAt: true, text: '你好' }), 'at');
});

test('a single mention with is_you, with or without @all alongside, is a real @', () => {
  assert.equal(cls({ isRealAt: true, text: '你好' }), 'at');
  assert.equal(cls({ isRealAt: true, mentionsAll: true, text: '@所有人 你好' }), 'at');
});

test('@all alone is ordinary, even though the platform marks it is_you', () => {
  assert.equal(cls({ mentionsAll: true, text: '@所有人 开会了' }), 'ordinary');
});

test('@ of another member is ordinary, or name when her name also appears', () => {
  assert.equal(cls({ mentionsOther: true, text: '@群友 吃饭吗' }), 'ordinary');
  assert.equal(cls({ mentionsOther: true, text: '@群友 你问问可洛' }), 'name');
});

test('mentions[].bot without is_you is never a fallback: ordinary, flagged ambiguous', () => {
  const c = classify(inbound({ ambiguousMention: true, text: '这是一条消息' }), { hasBotRef: noRef, names: NAMES });
  assert.deepEqual(c, { cls: 'ordinary', ambiguous: true });
  assert.equal(classify(inbound({ text: '这是一条消息' }), { hasBotRef: noRef, names: NAMES }).ambiguous, false);
});

test('her name typed by hand is a name, not a real @', () => {
  assert.equal(cls({ text: '可洛你在吗' }), 'name');
  assert.equal(cls({ text: '可洛小姐早上好' }), 'name');
  assert.equal(cls({ text: '@可洛 在吗' }), 'name');
});

test('Clo is case-insensitive and matched at a word boundary', () => {
  for (const text of ['Clo 你好', 'clo你好', 'hey CLO!', 'Clo小姐', '问问clo吧', 'Ｃｌｏ 在吗']) assert.equal(cls({ text }), 'name', text);
  for (const text of ['Clock 坏了', 'include clone', 'cloud 服务', 'mclo 是谁', 'clo_x']) assert.equal(cls({ text }), 'ordinary', text);
});

test('a URL or plain text is ordinary', () => {
  assert.equal(cls({ text: 'https://example.com/a' }), 'ordinary');
  assert.equal(cls({ text: '随便聊聊' }), 'ordinary');
});

test('type 103 with a real mention is a real @ and is not reply-to-bot on its own', () => {
  let asked = false;
  const c = cls({ isRealAt: true, msgType: 103, text: '[图片]', placeholders: ['[图片]'], hasUserText: false, refMsgIdx: 'REF' }, () => {
    asked = true;
    return true;
  });
  assert.equal(c, 'at');
  assert.equal(asked, false, 'at wins before any reference lookup');
});

test('reply-to-bot needs a recorded reference, for both message types', () => {
  const known = (idx) => idx === 'KNOWN';
  assert.equal(cls({ msgType: 103, refMsgIdx: 'KNOWN', text: '[图片]', placeholders: ['[图片]'], hasUserText: false }, known), 'reply_bot');
  assert.equal(cls({ msgType: 0, refMsgIdx: 'KNOWN', text: '对' }, known), 'reply_bot');
  assert.equal(cls({ msgType: 103, refMsgIdx: 'OTHER', text: '[图片]', placeholders: ['[图片]'], hasUserText: false }, known), 'ordinary');
  assert.equal(cls({ msgType: 0, refMsgIdx: 'OTHER', text: '对' }, known), 'ordinary');
  assert.equal(cls({ msgType: 0, refMsgIdx: null, text: '对' }, known), 'ordinary');
});

test('priority: at, then reply_bot, then name', () => {
  const known = () => true;
  assert.equal(cls({ isRealAt: true, refMsgIdx: 'K', text: '可洛' }, known), 'at');
  assert.equal(cls({ refMsgIdx: 'K', text: '可洛' }, known), 'reply_bot');
  assert.equal(cls({ refMsgIdx: 'K', text: '可洛' }, noRef), 'name');
});

test('a placeholder-only message is never a name', () => {
  assert.equal(cls({ text: '[图片]', placeholders: ['[图片]'], hasUserText: false }), 'ordinary');
});

test('names come from config, and an empty list matches nothing', () => {
  assert.equal(classify(inbound({ text: '可洛' }), { hasBotRef: noRef, names: [] }).cls, 'ordinary');
  assert.equal(classify(inbound({ text: '小洛来了' }), { hasBotRef: noRef, names: ['小洛'] }).cls, 'name');
  assert.equal(classify(inbound({ text: 'a.b 来了' }), { hasBotRef: noRef, names: ['a.b'] }).cls, 'name');
  assert.equal(classify(inbound({ text: 'axb 来了' }), { hasBotRef: noRef, names: ['a.b'] }).cls, 'ordinary');
});
