// Normalize on the captured shapes, plus classify on its output: the facts in DECISIONS.md, end to end.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalize } from '../../src/clo-plugin/lib/channels/qq/normalize.js';
import { classify } from '../../src/clo-plugin/lib/core/gate.js';
import { ambiguousBot, atAll, atBotAndAll, atImage, atOther, dm, fullAt, groupAtOff, image103, imageOnly, plain, quoted } from '../fixtures/qq-events.mjs';
import { BOT_MEMBER, GROUP_A, MEMBER, MEMBER2 } from '../harness/gateway.mjs';

const run = ([type, raw]) => normalize(type, structuredClone(raw), { receivedAt: 1000 });
const NAMES = ['可洛', '可洛小姐', 'Clo'];
const classOf = (evt, refs = new Set()) => classify(evt, { hasBotRef: (idx) => refs.has(idx), names: NAMES }).cls;

test('GROUP_AT_MESSAGE_CREATE, leading space and no mentions: a real @', () => {
  const e = run(groupAtOff('今天怎么样'));
  assert.equal(e.isRealAt, true);
  assert.equal(e.text, '今天怎么样');
  assert.equal(classOf(e), 'at');
  assert.equal(e.kind, 'group');
  assert.equal(e.conversationId, GROUP_A);
  assert.equal(e.senderId, MEMBER);
});

test('full mode, scope single and is_you: a real @, with the tag gone and the ID nowhere in the text', () => {
  const e = run(fullAt('今天怎么样'));
  assert.equal(e.isRealAt, true);
  assert.equal(e.text, '今天怎么样');
  assert.ok(!JSON.stringify(e).includes(`<@`));
  assert.ok(!e.text.includes(BOT_MEMBER));
  assert.equal(classOf(e), 'at');
});

test('@all: is_you true and no bot field, and it is not a real @', () => {
  const e = run(atAll('都看看'));
  assert.equal(e.isRealAt, false);
  assert.equal(e.mentionsAll, true);
  assert.equal(e.text, '@所有人 都看看');
  assert.equal(classOf(e), 'ordinary');
});

test('@ of the bot plus <@all> is a real @', () => {
  const e = run(atBotAndAll('都看看'));
  assert.equal(e.isRealAt, true);
  assert.equal(e.mentionsAll, true);
  assert.equal(e.text, '@所有人 都看看');
  assert.equal(classOf(e), 'at');
});

test('another member: not a real @, and the tag becomes a neutral word', () => {
  const e = run(atOther('你看这个'));
  assert.equal(e.isRealAt, false);
  assert.equal(e.mentionsOther, true);
  assert.equal(e.text, '@群友 你看这个');
  assert.ok(!e.text.includes(MEMBER2));
  assert.equal(classOf(e), 'ordinary');
});

test('mentions[].bot alone is never a fallback: it is logged as ambiguous and stays ordinary', () => {
  const e = run(ambiguousBot('这是谁'));
  assert.equal(e.isRealAt, false);
  assert.equal(e.ambiguousMention, true);
  assert.equal(classOf(e), 'ordinary');
  assert.ok(!e.text.includes(BOT_MEMBER));
});

test('a hand-typed @ or a name word is not a real @', () => {
  const e = run(plain('@可洛 在吗'));
  assert.equal(e.isRealAt, false);
  assert.equal(classOf(e), 'name');
  assert.equal(classOf(run(plain('Clo 在吗'))), 'name');
  assert.equal(classOf(run(plain('include this'))), 'ordinary', 'word boundary');
});

test('type 103, @ plus image: real @, placeholder, quoted element and parallel node never read', () => {
  const e = run(atImage('看这个'));
  assert.equal(e.isRealAt, true);
  assert.equal(e.msgType, 103);
  assert.deepEqual(e.placeholders, ['[图片]']);
  assert.equal(e.text, '看这个 [图片]');
  assert.equal(e.hasUserText, true);
  assert.ok(!e.text.includes('QUOTED-ELEMENT-TEXT'));
  assert.ok(!e.text.includes('PARALLEL-NODE-TEXT'));
  assert.ok(!e.text.includes('multimedia'));
  assert.equal(classOf(e), 'at');
});

test('type 103 is not reply-to-bot unless ref_msg_idx matches, and msg_elements[].msg_idx is not the quote', () => {
  const e = run(image103('这个呢', null));
  assert.equal(e.refMsgIdx, null, 'the SDK would have reported the element index here');
  assert.equal(classOf(e, new Set(['ELEMENT-INDEX'])), 'ordinary');
  const quoting = run(image103('这个呢', 'REAL-REF'));
  assert.equal(quoting.refMsgIdx, 'REAL-REF');
  assert.equal(classOf(quoting), 'ordinary', 'no match');
  assert.equal(classOf(quoting, new Set(['REAL-REF'])), 'reply_bot');
});

test('type 0 with a ref: matched verbatim, and msg_idx is parsed too', () => {
  const e = run(quoted('你刚才说的', 'REF=WITH=EQUALS'));
  assert.equal(e.refMsgIdx, 'REF=WITH=EQUALS');
  assert.equal(e.msgIdx, 'INDEX1');
  assert.equal(classOf(e, new Set(['REF=WITH=EQUALS'])), 'reply_bot');
});

test('an image with no text is placeholder-only', () => {
  const e = run(imageOnly());
  assert.equal(e.text, '[图片]');
  assert.equal(e.hasUserText, false);
  assert.deepEqual(e.placeholders, ['[图片]']);
});

test('a lone mention word is not user text', () => {
  const e = run(atOther(''));
  assert.equal(e.text, '@群友');
  assert.equal(e.hasUserText, false);
});

test('attachment types map to placeholders; unknown types do not leak names', () => {
  const [type, raw] = plain('x');
  raw.attachments = [
    { content_type: 'audio/silk', filename: 'SECRET-NAME-A' },
    { content_type: 'video/mp4', filename: 'SECRET-NAME-B' },
    { content_type: 'application/pdf', filename: 'SECRET-NAME-C' },
    { content_type: 'image/png' },
    { content_type: 'image/png' },
    {},
  ];
  const e = normalize(type, raw, {});
  assert.deepEqual(e.placeholders, ['[语音]', '[视频]', '[文件]', '[图片]', '[非文字消息]']);
  assert.ok(!e.text.includes('SECRET-NAME'));
});

// The boundary moved on purpose: a group whose switch is on gets author.username, unchecked, for the gate to sanitize.
test('with the switch off, or no answer, no display name passes the boundary', () => {
  for (const event of [fullAt('x'), atAll('x'), atOther('x'), groupAtOff('x')]) {
    for (const opts of [{}, { keepDisplayName: () => false }, { keepDisplayName: () => undefined }, { keepDisplayName: () => 'yes' }]) {
      const dump = JSON.stringify(normalize(event[0], structuredClone(event[1]), { receivedAt: 1000, ...opts }));
      assert.ok(!dump.includes('DISPLAY-NAME'), dump);
      assert.ok(!dump.includes('displayNameRaw'), dump);
    }
  }
  // Positive control: the raw payload did hold one.
  assert.ok(JSON.stringify(fullAt('x')[1]).includes('DISPLAY-NAME'));
});

test('with the switch on, only author.username of a group event passes, and never a mention\'s username', () => {
  const asked = [];
  const keepDisplayName = (id) => {
    asked.push(id);
    return true;
  };
  for (const event of [fullAt('x'), atAll('x'), atOther('x'), groupAtOff('x'), ambiguousBot('x')]) {
    const e = normalize(event[0], structuredClone(event[1]), { receivedAt: 1000, keepDisplayName });
    assert.equal(e.displayNameRaw, 'SENDER-DISPLAY-NAME');
    const dump = JSON.stringify(e);
    for (const other of ['BOT-DISPLAY-NAME', 'OTHER-DISPLAY-NAME', 'ALL-DISPLAY-NAME']) assert.ok(!dump.includes(other), dump);
  }
  assert.ok(asked.every((id) => id === GROUP_A), 'the switch is asked about this event\'s own group');
  const mentionOnly = fullAt('x', { username: null });
  assert.equal(normalize(mentionOnly[0], mentionOnly[1], { keepDisplayName }).displayNameRaw, undefined, 'a mention is no fallback when the author has none');
  const notText = fullAt('x', { username: 12345 });
  assert.equal(normalize(notText[0], notText[1], { keepDisplayName }).displayNameRaw, undefined);
  const direct = dm('你好');
  direct[1].author.username = 'DM-DISPLAY-NAME';
  assert.ok(!JSON.stringify(normalize(direct[0], direct[1], { keepDisplayName })).includes('DM-DISPLAY-NAME'), 'a direct message never carries one');
});

test('C2C is direct, drops at the gate, and has its own IDs', () => {
  const e = run(dm('你好'));
  assert.equal(e.kind, 'direct');
  assert.equal(e.conversationId, MEMBER);
  assert.equal(e.senderId, MEMBER);
  assert.equal(e.isRealAt, false);
});

test('unknown event types return null; the input is not mutated; bad timestamps are null', () => {
  assert.equal(normalize('GROUP_ADD_ROBOT', {}, {}), null);
  assert.equal(normalize('GROUP_MESSAGE_CREATE', null, {}), null);
  const [type, raw] = fullAt('x');
  const before_ = JSON.stringify(raw);
  normalize(type, raw, {});
  assert.equal(JSON.stringify(raw), before_);
  assert.equal(normalize(type, { ...raw, timestamp: 'nonsense' }, {}).timestampMs, null);
  assert.equal(normalize(type, { ...raw, timestamp: undefined }, {}).timestampMs, null);
  assert.equal(normalize(type, { ...raw, timestamp: '2026-11-02T20:00:00+08:00' }, {}).timestampMs, Date.parse('2026-11-02T12:00:00Z'));
});

test('author.bot is carried for the gate; missing IDs stay null, exact case is kept', () => {
  assert.equal(run(fullAt('x', { bot: true })).senderIsBot, true);
  const [type, raw] = fullAt('x', { group: 'MixedCaseGroupId' });
  assert.equal(normalize(type, raw, {}).conversationId, 'MixedCaseGroupId');
  delete raw.author.member_openid;
  assert.equal(normalize(type, raw, {}).senderId, null);
});
