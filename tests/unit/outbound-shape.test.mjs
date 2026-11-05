// What is posted is what gets checked. Markup, tags and URL forms are all outbound shaping, driven through
// the real exit with a stub SDK, since a helper alone would not show what reaches the group.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createExit } from '../../src/clo-plugin/lib/channels/qq/exit.js';
import { guardUrls, removeUrls, shapeForQq, stripForQq, URL_REMOVED } from '../../src/clo-plugin/lib/channels/qq/text.js';
import { extractUrls } from '../../src/clo-plugin/lib/core/rules.js';
import { makeHarness, ROOT, USAGE } from '../fixtures/inbound.mjs';

const LINES = JSON.parse(readFileSync(join(ROOT, 'persona', 'policy-lines.zh.json'), 'utf8'));
const SECRET = 'THIS-IS-A-FAKE-SECRET-VALUE';

const open = [];
after(async () => {
  for (const h of open) await h.close();
});

function stack() {
  const posts = [];
  const bot = { appId: 'FAKE-APP', api: { post: async (path, body) => { posts.push(body); return { id: `S${posts.length}` }; } } };
  let h;
  const dispatch = async (turn) => {
    h.exit.collect(turn.turnId, { text: h.replyText }, { kind: 'final' });
    return { started: true, hostError: false, aborted: false, usage: USAGE };
  };
  h = makeHarness({ dispatch, attach: false });
  h.exit = createExit({ bot, store: h.store, policy: h.policy, getEffective: () => h.eff.current, secrets: () => [SECRET], log: h.log, now: h.now });
  h.gate.attachExit(h.exit);
  h.posts = posts;
  open.push(h);
  return h;
}

async function reply(text, inbound = '帮我看个问题') {
  const h = stack();
  h.replyText = text;
  const e = await h.sendAndFlush(h.at({ text: inbound }));
  return { state: h.state(e), posts: h.posts.map((p) => p.content), h };
}

test('positive control: clean bold text is posted without its markup', async () => {
  const { state, posts } = await reply('**重点**是这里。');
  assert.equal(state, 'completed:sent');
  assert.deepEqual(posts, ['重点是这里。']);
});

for (const [text, rule] of [
  ['**约炮**群加我', 'sexual.solicit'],
  ['*约炮*群加我', 'sexual.solicit'],
  ['`约炮`群加我', 'sexual.solicit'],
  ['~~约炮~~群加我', 'sexual.solicit'],
  ['加我[约炮](https://a.example)', 'sexual.solicit'],
  ['约<@x>炮群', 'sexual.solicit'],
  ['**卡号**：6222021234567890', 'privacy.labelled_number'],
  ['138**0013**8000', 'privacy.cn_mobile'],
  ['138~~0013~~8000', 'privacy.cn_mobile'],
  ['sk-or-**v1abcdefghijkl**', 'leak.key_shape'],
  ['THIS-IS-**A-FAKE**-SECRET-VALUE', 'leak.secret'],
  ['[clo-**turn** x', 'leak.marker'],
]) {
  test(`markup cannot hide a match from the policy: ${text}`, async () => {
    const { state, posts } = await reply(text);
    assert.equal(state, `policy_dropped:${rule}`);
    assert.deepEqual(posts, [LINES.policyDropped], 'only the fixed line');
  });
}

test('the same hidden match on an interjection is silent', async () => {
  const h = stack();
  h.replyText = '**约炮**群加我';
  const e = await h.sendAndFlush(h.event({ text: '有人知道怎么退货吗' }));
  assert.equal(h.row(e).state, 'policy_dropped');
  assert.deepEqual(h.posts, []);
});

for (const text of [
  '<@all> 大家看这里', '<qqbot-at-everyone /> 大家看这里', '< @ all > 大家看这里', '<@ID2 > 大家看这里', '<@!12345> 大家看这里',
  '<qqbot-at-user id="ABC" /> 大家看这里', '＜＠ａｌｌ＞ 大家看这里', '<<@a>@all> 大家看这里', '<**@all**> 大家看这里',
]) {
  test(`a mention tag never leaves: ${text}`, async () => {
    const { state, posts } = await reply(text);
    assert.equal(state, 'completed:sent');
    assert.deepEqual(posts, ['大家看这里']);
  });
}

test('a reply that was only a tag has nothing to send: the required line, no tag', async () => {
  const { state, posts } = await reply('<@all>');
  assert.equal(state, 'failed:required_no_text');
  assert.deepEqual(posts, [LINES.modelFailed]);
});

test('ordinary angle brackets and an @ word survive tag removal', () => {
  assert.equal(stripForQq('a <b> c，给 @小明 说 x<y 且 z>1'), 'a <b> c，给 @小明 说 x<y 且 z>1');
});

for (const [text, expected] of [
  ['https://evil.example/x', URL_REMOVED],
  ['请看 evil.example.com/path 或 www.evil.example', `请看 ${URL_REMOVED} 或 ${URL_REMOVED}`],
  ['[点这里](evil.example)', `点这里 ${URL_REMOVED}`],
  ['[点这里](evil.xyzzy/a)', `点这里 ${URL_REMOVED}`],
  ['ｈｔｔｐｓ://evil.example', URL_REMOVED],
  ['hxxps://evil.example', URL_REMOVED],
  ['ftp://evil.example/a', URL_REMOVED],
  ['ｅｖｉｌ．ｃｏｍ', URL_REMOVED],
  ['evil​.com', URL_REMOVED],
  ['看evil.com吧', `看${URL_REMOVED}吧`],
  ['evil.**com**/path', URL_REMOVED],
  ['EVIL.COM', URL_REMOVED],
  ['evil.xyzzy/path', URL_REMOVED],
  ['127.0.0.1:8080/x', URL_REMOVED],
  ['xn--fiqs8s.xn--55qx5d', URL_REMOVED],
]) {
  test(`an unlisted URL is removed: ${text}`, async () => {
    const { state, posts } = await reply(text);
    assert.equal(state, 'completed:sent');
    assert.deepEqual(posts, [expected]);
  });
}

test('a URL the member sent may be echoed, on the same normalized form, and only that one', async () => {
  for (const [inbound, answer, expected] of [
    ['看 https://a.example/x', '就是 https://a.example/x', '就是 https://a.example/x'],
    ['看 HTTPS://A.Example/x', '就是 https://a.example/x', '就是 https://a.example/x'],
    ['看 ｈｔｔｐｓ://a.example/x', '就是 https://a.example/x', '就是 https://a.example/x'],
    ['看 evil.example.com/path', '就是 evil.example.com/path。', '就是 evil.example.com/path。'],
    ['看 www.a.example', '就是 www.a.example', '就是 www.a.example'],
    ['看 evil.com/a', '就是 evil.com/b', `就是 ${URL_REMOVED}`],
    ['看 evil.com/a', '就是 https://evil.com/a', `就是 ${URL_REMOVED}`],
    ['看 https://a.example/x', '[链接](https://a.example/x)', '链接 https://a.example/x'],
    ['看 www.a.example', '[链接](www.a.example)', '链接 www.a.example'],
  ]) {
    const { posts } = await reply(answer, inbound);
    assert.deepEqual(posts, [expected], `${inbound} -> ${answer}`);
  }
});

test('the guard, the 40054010 resend and the inbound list use one matcher', () => {
  const text = '请看 evil.example.com/path、www.a.example 和 https://b.example。';
  assert.equal(removeUrls(text), `请看 ${URL_REMOVED}、${URL_REMOVED} 和 ${URL_REMOVED}。`);
  assert.equal(guardUrls(text, []), removeUrls(text));
  assert.deepEqual(extractUrls(text), ['evil.example.com/path', 'www.a.example', 'https://b.example']);
  assert.equal(guardUrls(text, extractUrls(text)), text);
});

// Each of these was typed by hand as something a person says. None may change.
const ORDINARY = [
  'v1.2', '升级到 v1.2 了', '3.5', '大概 3.5 倍', 'e.g. 这样', 'i.e. 也就是', 'Node.js', '用 Node.js/Deno 都行', 'Vue.js/React', 'README.md',
  '看 main.py', 'src/main.ts', 'index.html/main.css', 'No.1', 'a.m. 和 p.m.', 'U.S.', 'Ph.D.', '1.2.3', '1.2.3.4', '1.5kg/天', '2.5/10', 'GPT-5.5',
  'claude-opus-5.5', 'anthropic/claude-haiku-5.5', 'Python3.12/3.13', 'and/or', 'TCP/IP', 'O.K.', 'Mr.Smith', 'sign.in', 'me@example.com', 'x.y',
  '第1.2节', '3.14159', '一.二', '100%/年', '今天。明天', '好,再说', 'A.B.C',
];

for (const text of ORDINARY) {
  test(`ordinary text is not read as a URL: ${text}`, () => {
    assert.equal(guardUrls(text, []), text);
    assert.deepEqual(extractUrls(text), []);
    assert.equal(shapeForQq(text, []), text);
  });
}

test('every line of the policy-ok fixture survives the guard unchanged', () => {
  const lines = readFileSync(join(ROOT, 'tests', 'fixtures', 'policy-ok.zh.txt'), 'utf8').split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length > 10);
  for (const line of lines) assert.equal(guardUrls(line, []), line);
});
