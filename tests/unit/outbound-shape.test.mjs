// What is posted is what gets checked. Markup, tags and URL forms are all outbound shaping, driven through
// the real exit with a stub SDK, since a helper alone would not show what reaches the group.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createExit } from '../../src/clo-plugin/lib/channels/qq/exit.js';
import { checkFormForQq, guardUrls, removeUrls, shapeForQq, stripForQq, URL_REMOVED } from '../../src/clo-plugin/lib/channels/qq/text.js';
import { extractUrls } from '../../src/clo-plugin/lib/core/rules.js';
import { findUrls } from '../../src/clo-plugin/lib/core/urls.js';
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

test('a long run of letters is matched in linear time, and only the first letter decides a word label', () => {
  const started = Date.now();
  for (const run of ['a'.repeat(40000), '1-'.repeat(20000), `x.${'a'.repeat(40000)}`]) assert.deepEqual(findUrls(run), []);
  assert.ok(Date.now() - started < 2000, 'quadratic backtracking would take seconds here');
  const cutUrls = Date.now();
  assert.equal(findUrls('https://a.com/这'.repeat(2700)).length, 2700);
  assert.equal(findUrls('https://a.com这'.repeat(2700)).length, 2700);
  assert.ok(Date.now() - cutUrls < 1000, 'reading to the next stop for every cut URL would take over a second here');
  const letters = ['a', '1', '-'];
  let labels = [''];
  for (let n = 0; n < 4; n += 1) {
    labels = labels.flatMap((label) => [label, ...letters.map((c) => label + c)]);
    labels = [...new Set(labels)];
  }
  for (const label of labels.filter(Boolean)) {
    const url = `${label}.xyzzy/p`;
    const matched = findUrls(url).some((span) => span.end === url.length);
    // With a path and an unknown ending, a host needs a letter in its label.
    assert.equal(matched, /a/.test(label), url);
  }
});

for (const text of ['用 df.info() 看', 'this.work()', 'self.net(x)', 'model.top(3, "a")', 'a.b.live(1)', '内网是 10.0.0.0/8', '192.168.1.0/24。', '1.2.3.4/32']) {
  test(`the guard leaves a method call and a CIDR block: ${text}`, async () => {
    const { state, posts } = await reply(text);
    assert.equal(state, 'completed:sent');
    assert.deepEqual(posts, [text]);
  });
}

for (const [text, expected] of [
  ['evil.xyz(官网)', `${URL_REMOVED}(官网)`],
  ['evil.xyz（官网）', `${URL_REMOVED}（官网）`],
  ['evil.com(official)', `${URL_REMOVED}(official)`],
  ['evil.info(', `${URL_REMOVED}(`],
  ['evil.info', URL_REMOVED],
  ['www.evil.info()', `${URL_REMOVED}()`],
  ['evil.info/a()', `${URL_REMOVED}()`],
  ['xn--fiqs8s.top()', `${URL_REMOVED}()`],
  ['127.0.0.1/x', URL_REMOVED],
  ['1.2.3.4/33', URL_REMOVED],
  ['1.2.3.4/123', URL_REMOVED],
  ['1.2.3.4:80/8', URL_REMOVED],
]) {
  test(`what only resembles a call or a block is still removed: ${text}`, () => {
    assert.equal(guardUrls(text, []), expected);
  });
}

test('the exceptions live in the guard alone: the matcher and the 40054010 resend stay strict', () => {
  for (const text of ['df.info()', '10.0.0.0/8']) {
    assert.equal(findUrls(text).length, 1, text);
    assert.ok(removeUrls(text).startsWith(URL_REMOVED), text);
  }
});

for (const [text, expected] of [
  ['https://a.com这个很好', `${URL_REMOVED}这个很好`],
  ['https://a.com——这个', `${URL_REMOVED}——这个`],
  ['https://a.com…更多', `${URL_REMOVED}…更多`],
  ['https://a.com（官网）', `${URL_REMOVED}（官网）`],
  ['https://a.com/x这个', `${URL_REMOVED}这个`],
  ['https://a.com/x,这个', `${URL_REMOVED},这个`],
  ['ｈｔｔｐｓ://a.com这个', `${URL_REMOVED}这个`],
  // A path that mixes in Chinese is cut where the Chinese starts: nothing marks where it would end.
  ['https://a.com/路径/x', `${URL_REMOVED}路径/x`],
  // The cut-off text is read again.
  ['https://a.com/路径/evil.xyz/x', `${URL_REMOVED}路径/${URL_REMOVED}`],
  ['https://a.com/路径https://b.com', `${URL_REMOVED}路径${URL_REMOVED}`],
  ['https://a.com这https://b.com', `${URL_REMOVED}这${URL_REMOVED}`],
  // A host that goes on past the Chinese is one address, not a cut.
  ['https://www.例子.com/x', URL_REMOVED],
  ['https://例子.com/x', URL_REMOVED],
  ['https://a.b例子.com/x', URL_REMOVED],
  ['https://user@例子.com/x', URL_REMOVED],
  ['https://a这个@evil.com/x', URL_REMOVED],
]) {
  test(`a URL with a scheme ends after a complete ASCII host: ${text}`, () => {
    assert.equal(guardUrls(text, []), expected);
  });
}

test('the inbound list reads the same end, so an echo of the address is kept and the sentence survives', () => {
  assert.deepEqual(extractUrls('看 https://a.com这个'), ['https://a.com']);
  assert.equal(guardUrls('就是 https://a.com这个', extractUrls('看 https://a.com这个')), '就是 https://a.com这个');
});

for (const [text, allowed, expected] of [
  ['a.com.evil.foo', ['a.com'], URL_REMOVED],
  ['a.com.evil.foo/x', ['a.com'], URL_REMOVED],
  ['a.com.Then', ['a.com'], URL_REMOVED],
  ['socket.io.js', [], URL_REMOVED],
  ['evil.com.attacker.foo', [], URL_REMOVED],
  ['a.com. 然后', ['a.com'], 'a.com. 然后'],
  ['a.com。然后', ['a.com'], 'a.com。然后'],
]) {
  test(`labels after a TLD belong to the same host: ${text}`, () => {
    assert.equal(guardUrls(text, allowed), expected);
  });
}

for (const [text, expected] of [
  ['`handlers[key](event)`', 'handlers[key](event)'],
  ['调用 `a**b**c` 就行', '调用 a**b**c 就行'],
  ['`2**3*4`', '2**3*4'],
  ['`__init__` 和 `_x_`', '__init__ 和 _x_'],
  ['**重点** `**不动**`', '重点 **不动**'],
  ['**`x*y*z`**', 'x*y*z'],
  ['```py\n# 注释\nd[k](v)\n**kw**\n~~~\n```', '# 注释\nd[k](v)\n**kw**\n~~~'],
  ['前面 **粗**\n```\n_a_\n```\n后面 *斜*', '前面 粗\n\n_a_\n\n后面 斜'],
]) {
  test(`code keeps its characters and text around it is still cleaned: ${text}`, async () => {
    const { state, posts } = await reply(text);
    assert.equal(state, 'completed:sent');
    assert.deepEqual(posts, [expected]);
  });
}

test('a URL hidden by markup inside code does not leave, and a member\'s own stays as written', async () => {
  assert.deepEqual((await reply('看 `evil.**com**/path`')).posts, [`看 ${URL_REMOVED}`]);
  assert.deepEqual((await reply('```\nevil.~~com~~/path\n```')).posts, [URL_REMOVED]);
  assert.deepEqual((await reply('`evil.**com**/path`', '看 evil.com/path')).posts, ['evil.**com**/path']);
  assert.deepEqual((await reply('`https://evil.example/x`')).posts, [URL_REMOVED]);
  assert.deepEqual((await reply('`[a](evil.com)`')).posts, [`[a](${URL_REMOVED})`]);
});

for (const [text, allowed, expected] of [
  ['evil.com/path 和 `evil.**com**/path`', [], `${URL_REMOVED} 和 ${URL_REMOVED}`],
  ['`evil.~~com~~/path` evil.com/path', [], `${URL_REMOVED} ${URL_REMOVED}`],
  ['evil.com/path `evil.**com**/path` `evil.~~com~~/path`', [], `${URL_REMOVED} ${URL_REMOVED} ${URL_REMOVED}`],
  // Both copies written plainly reveal nothing, so code elsewhere keeps its characters.
  ['evil.com/path `a**b**c` `evil.com/path`', [], `${URL_REMOVED} a**b**c ${URL_REMOVED}`],
  ['evil.com/path `evil.**com**/path`', ['evil.com/path'], 'evil.com/path evil.**com**/path'],
]) {
  test(`a visible copy of an address does not let a hidden copy out: ${text}`, () => {
    assert.equal(shapeForQq(text, allowed), expected);
  });
}

test('the same reply with a visible and a hidden copy posts neither', async () => {
  const { posts } = await reply('evil.com/path 和 `evil.**com**/path`');
  assert.deepEqual(posts, [`${URL_REMOVED} 和 ${URL_REMOVED}`]);
});

for (const [text, expected] of [
  ['evil.com.hk(official)', `${URL_REMOVED}(official)`],
  ['evil.org.uk(x)', `${URL_REMOVED}(x)`],
  ['evil.cn.top()', `${URL_REMOVED}()`],
  ['EVIL.COM.HK(official)', `${URL_REMOVED}(official)`],
  ['evil.xyz()/pay', `${URL_REMOVED}()/pay`],
  ['evil.xyz(official)/pay', `${URL_REMOVED}(official)/pay`],
  ['evil.xyz(a)?x=1', `${URL_REMOVED}(a)?x=1`],
  ['evil.xyz(a)#top', `${URL_REMOVED}(a)#top`],
  // A later closing parenthesis on the line does not hide the path after the first call.
  ['evil.xyz(a)/pay 和 (b)', `${URL_REMOVED}(a)/pay 和 (b)`],
  ['evil.xyz(a)/pay and (b)', `${URL_REMOVED}(a)/pay and (b)`],
  ['evil.xyz(g(a))/pay', `${URL_REMOVED}(g(a))/pay`],
  ['evil.xyz((a)', `${URL_REMOVED}((a)`],
]) {
  test(`the call exception does not cover this link form: ${text}`, () => {
    assert.equal(shapeForQq(text, []), expected);
  });
}

// Each still reads as a call: a chain, text after a space, and a slash inside the arguments.
for (const text of ['df.info().head()', 'df.info() / 2', 'df.info(a(b)/2)', 'model.top(3, "a") 和 self.net(x)']) {
  test(`a call stays a call when other text follows: ${text}`, () => {
    assert.equal(shapeForQq(text, []), text);
  });
}

// Known limit: these have the shape of self.net(x). Only the resend after QQ refuses a URL removes them.
for (const text of ['evil.net(official)', 'evil.xyz(official)']) {
  test(`disclosed limit, the guard cannot tell this from a call: ${text}`, () => {
    assert.equal(shapeForQq(text, []), text);
    assert.equal(removeUrls(text), `${URL_REMOVED}(official)`);
  });
}

test('a mention tag leaves no code either', () => {
  assert.equal(shapeForQq('`<@all>` 大家看这里'), '大家看这里');
  assert.equal(shapeForQq('```\n<qqbot-at-everyone />\n```\n大家看这里'), '大家看这里');
});

test('a NUL in the text cannot stand in for held code', () => {
  assert.equal(stripForQq('\u00000\u0000 `a`'), '0 a');
});

test('checkFormForQq: every layer gone, code included, with mention tags and URLs guarded', () => {
  const inCode = '`138**0013**8000`';
  assert.equal(shapeForQq(inCode), '138**0013**8000', 'what is posted keeps the code');
  assert.equal(checkFormForQq(inCode), '13800138000', 'what is checked does not');
  assert.equal(checkFormForQq('```\n约~~炮~~\n```'), '约炮');
  assert.equal(checkFormForQq('`<@all> 约炮`'), '约炮');
  assert.equal(checkFormForQq('看 `evil.**com**/path`'), `看 ${URL_REMOVED}`);
  assert.equal(checkFormForQq('`evil.**com**/path`', ['evil.com/path']), 'evil.com/path');
  assert.equal(checkFormForQq('[a](evil.example)'), `a ${URL_REMOVED}`);
  assert.equal(checkFormForQq(null), '');
  for (const text of ['重点。', '**重点**是这里。']) assert.equal(checkFormForQq(text), shapeForQq(text));
});

for (const [text, expected] of [
  ['```npm i```', 'npm i'],
  ['``` npm i ```', 'npm i'],
  ['~~~这是结论~~~', '这是结论'],
  ['``` npm i', 'npm i'],
  ['``` npm i\n**粗**', 'npm i\n粗'],
  ['``` npm i\n**不动**\n```\n**粗**', 'npm i\n**不动**\n\n粗'],
  ['~~~这是结论', '这是结论'],
  ['```js', ''],
  ['``` js \ncode()', 'code()'],
  ['~~~\n```\n~~~', '```'],
  ['```js\r\ncode()\r\n```', 'code()'],
]) {
  test(`a fence line keeps the text it carries: ${JSON.stringify(text)}`, () => {
    assert.equal(stripForQq(text), expected);
  });
}
