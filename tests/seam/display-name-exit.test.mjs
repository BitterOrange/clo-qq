// A name, repeated in a reply to somebody else, through the real gate and the real exit with the real SDK against mock QQ.
// The replies are scripted: what a model might write. Whether Opus would write them has not been observed.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { atEvent, GROUP_A, groupEntry, inbound, makeEffective, MEMBER, MEMBER2, seamStack } from '../fixtures/inbound.mjs';
import { startMockQq } from '../harness/mock-qq.mjs';

const onEffective = () => makeEffective({ qq: { groups: { [GROUP_A]: groupEntry({ displayNames: true, interject: false }) } } });
const LABEL = /显示名：(.+)）$/u;
let mock;

before(async () => {
  mock = await startMockQq();
});

after(async () => {
  await mock.stop();
});

// Member B holds the name and has spoken; member A asks. reply gets whatever label she actually saw for B.
async function run(name, reply) {
  const h = await seamStack({ effective: onEffective(), mock });
  try {
    await h.send(inbound({ senderId: MEMBER2, text: '我刚才说了一句', displayNameRaw: name }, h.clock.t));
    const evt = atEvent({ senderId: MEMBER, text: '能帮我看看这个问题吗', displayNameRaw: '小红' }, h.clock.t);
    let seenName = null;
    const script = h.script;
    h.script = async (turn) => {
      seenName = turn.history[0].sender.match(LABEL)?.[1] ?? null;
      h.replyText = reply(seenName);
      return script(turn);
    };
    const before_ = h.posts().length;
    await h.sendAndFlush(evt);
    const row = h.row(evt);
    return { seenName, state: `${row.state}:${row.reason}`, posted: h.posts().slice(before_).map((p) => p.body.content), expected: reply(seenName) };
  } finally {
    await h.close();
  }
}

const SHAPES = [
  (n) => `${n}刚才说得对，你可以先试试。`,
  (n) => `看来${n}说得对，你可以先试试。`,
  (n) => `原来${n}刚才已经说过了。`,
  (n) => `${n}加油。`,
  (n) => `${n} ok，你也看一下。`,
  (n) => `${n}，我看到了，这是回答。\n第二段。`,
];

async function assertGoesOut(name, expectSeen) {
  for (const shape of SHAPES) {
    const out = await run(name, (seen) => (seen ? shape(seen) : '刚才有人说得对，你可以先试试。'));
    assert.equal(out.seenName, expectSeen, `${name}: what she saw`);
    assert.equal(out.state, 'completed:sent', `${name}: ${out.expected}`);
    assert.deepEqual(out.posted, [out.expected], `${name}: posted whole, once`);
  }
}

test('control: a plain name repeated in a reply goes out whole, once', async () => {
  await assertGoesOut('老李', '老李');
});

test('a name with markup can no longer get a reply dropped or erased', async () => {
  // Refused to the code: nothing for her to repeat.
  for (const name of ['一起*约炮*', '一起~~约炮~~', '~~138~~12345678', '*sk*-or-abcdefgh', '~~~']) await assertGoesOut(name, null);
  // Harmless once the markup is gone.
  await assertGoesOut('*小*明', '小明');
  await assertGoesOut('# 老张', '老张');
});

test('half a rule, or a key prefix, can no longer get someone else\'s reply replaced', async () => {
  for (const name of ['约炮', '裸聊', '代开发票', 'sk-or-abcdefg', '援交', '办假证', '洗钱通道', '炸弹制作', '卡号', '138123456']) await assertGoesOut(name, null);
});

test('a host-looking name and a cut that exposes one stay out of a reply', async () => {
  for (const name of ['bit.ly', 'abcdefghijkl.comabc']) await assertGoesOut(name, null);
});

test('without the sanitizer in the way, the exit still does what these tests rely on: the same words from a model are dropped', async () => {
  const dropped = await run('老李', () => '一起约炮刚才说得对，你可以先试试。');
  assert.equal(dropped.state, 'policy_dropped:sexual.solicit');
  assert.equal(dropped.posted.length, 1, 'the fixed line');
  assert.ok(!dropped.posted[0].includes('约炮'));
});
