// A silent token is the model saying nothing. The host swallows some wrapped forms of it and not others, and shaping can
// reveal one from inside markup, so the exit tests the text it receives and the text it would post.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createExit } from '../../src/clo-plugin/lib/channels/qq/exit.js';
import { makeHarness, ROOT, USAGE } from '../fixtures/inbound.mjs';

const LINES = JSON.parse(readFileSync(join(ROOT, 'persona', 'policy-lines.zh.json'), 'utf8'));
const CHAT = '有人知道怎么退货吗';

const open = [];
after(async () => {
  for (const h of open) await h.close();
});

function stack(reply) {
  const posts = [];
  let h;
  h = makeHarness({ attach: false, dispatch: async (turn) => {
    h.exit.collect(turn.turnId, { text: reply }, { kind: 'final' });
    return { started: true, hostError: false, aborted: false, usage: USAGE };
  } });
  h.exit = createExit({ bot: { appId: 'FAKE-APP', api: { post: async (path, body) => { posts.push(body.content); return { id: 'S' }; } } }, store: h.store, policy: h.policy, getEffective: () => h.eff.current, log: h.log, now: h.now });
  h.gate.attachExit(h.exit);
  h.posted = posts;
  open.push(h);
  return h;
}

// The token wrapped in markup or punctuation.
const WRAPPED = [
  '`NO_REPLY`',
  '~~NO_REPLY~~',
  '~NO_REPLY~',
  '```\nNO_REPLY\n```',
  '``` \nHEARTBEAT_OK\n```',
  '`announce_skip`',
  'REPLY_SKIP。',
];
// Shaping is what reveals these two: the language tag and the mention tag hide the token from the first check.
const REVEALED_BY_SHAPING = [
  '```text\nNO_REPLY\n```',
  '<@ABCDEF> NO_REPLY',
];

for (const reply of [...WRAPPED, ...REVEALED_BY_SHAPING]) {
  const label = JSON.stringify(reply);

  test(`${label} on an interjection: silent, nothing posted`, async () => {
    const h = stack(reply);
    const e = await h.sendAndFlush(h.event({ text: CHAT }));
    assert.equal(h.state(e), 'silent:no_reply');
    assert.deepEqual(h.posted, []);
  });

  test(`${label} on a required turn: the failure line, never the token`, async () => {
    const h = stack(reply);
    const e = await h.sendAndFlush(h.at());
    assert.equal(h.state(e), 'failed:required_no_text');
    assert.deepEqual(h.posted, [LINES.modelFailed]);
  });
}

test('positive control: a sentence that mentions a token is an answer and goes out', async () => {
  for (const reply of ['NO_REPLY 是宿主用的一个标记。', '那个标记叫 `NO_REPLY`，不用管。', 'NO_REPLY_YET']) {
    const h = stack(reply);
    const e = await h.sendAndFlush(h.at());
    assert.equal(h.state(e), 'completed:sent', reply);
    assert.equal(h.posted.length, 1, reply);
    assert.ok(h.posted[0].includes('NO_REPLY'), reply);
  }
});

test('punctuation alone is not a token, and a long run of it does not stall the check', async () => {
  const h = stack('。'.repeat(200));
  const e = await h.sendAndFlush(h.at());
  assert.equal(h.state(e), 'completed:sent');
  assert.equal(h.posted.length, 1);
});
