// Host status text delivered as an ordinary final. The scan below runs against the installed build, so a
// host upgrade that adds or rewords a notice fails here rather than in a QQ group.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createExit } from '../../src/clo-plugin/lib/channels/qq/exit.js';
import { EXACT_NOTICES, isHostNotice, withoutHostNotices } from '../../src/clo-plugin/lib/channels/qq/hostNotices.js';
import { makeHarness, ROOT, USAGE } from '../fixtures/inbound.mjs';

const LINES = JSON.parse(readFileSync(join(ROOT, 'persona', 'policy-lines.zh.json'), 'utf8'));
const TRUNCATED = EXACT_NOTICES[0];
const DIST = join(ROOT, '.runtime', 'pkg', 'node_modules', 'openclaw', 'dist');

const open = [];
after(async () => {
  for (const h of open) await h.close();
});

function stack(payloads) {
  const posts = [];
  let h;
  h = makeHarness({ attach: false, dispatch: async (turn) => {
    for (const text of payloads) h.exit.collect(turn.turnId, { text }, { kind: 'final' });
    return { started: true, hostError: false, aborted: false, usage: USAGE };
  } });
  h.exit = createExit({ bot: { appId: 'FAKE-APP', api: { post: async (path, body) => { posts.push(body.content); return { id: 'S' }; } } }, store: h.store, policy: h.policy, getEffective: () => h.eff.current, log: h.log, now: h.now });
  h.gate.attachExit(h.exit);
  h.posted = posts;
  open.push(h);
  return h;
}

test('truncated: the partial text goes out, the notice does not, and it is logged', async () => {
  const h = stack(['半句', TRUNCATED]);
  const e = await h.sendAndFlush(h.at());
  assert.equal(h.state(e), 'completed:sent');
  assert.deepEqual(h.posted, ['半句']);
  assert.ok(h.logs.some((l) => l.event === 'exit_drop' && l.reason === 'host-notice'));
});

test('a notice joined onto the text it follows is cut off too', async () => {
  const h = stack([`半句\n\n${TRUNCATED}`]);
  await h.sendAndFlush(h.at());
  assert.deepEqual(h.posted, ['半句']);
});

for (const notice of EXACT_NOTICES) {
  test(`alone on a required turn it becomes the failure line: ${notice.slice(0, 40)}`, async () => {
    const h = stack([notice]);
    const e = await h.sendAndFlush(h.at());
    assert.equal(h.state(e), 'failed:host_error');
    assert.deepEqual(h.posted, [LINES.modelFailed]);
  });

  test(`alone on an interjection it is silent: ${notice.slice(0, 40)}`, async () => {
    const h = stack([notice]);
    const e = await h.sendAndFlush(h.event({ text: '有人知道怎么退货吗' }));
    assert.equal(h.state(e), 'silent:host_error');
    assert.deepEqual(h.posted, []);
  });
}

test('host templates with a value in them are caught by shape', () => {
  for (const text of [
    "⚠️ I couldn't reach the configured model backend openrouter/x. Fallback used y, but it produced no visible reply.",
    '🧹 Compacting context...',
    '🧹 Auto-compaction complete (count 2).',
    '↪️ Model Fallback: y (selected x; rate limit)',
  ]) assert.equal(isHostNotice(text), true, text);
});

test('Clo\'s own text is left alone, including a warning sign in a Chinese sentence', async () => {
  for (const text of ['⚠️ 这里要小心。', '这个问题我答一下。', 'OK.', 'Reply truncated is an English phrase.']) {
    assert.equal(isHostNotice(text), false, text);
    assert.equal(withoutHostNotices(text), text);
  }
  const h = stack(['⚠️ 这里要小心。']);
  await h.sendAndFlush(h.at());
  assert.deepEqual(h.posted, ['⚠️ 这里要小心。']);
});

test('against the installed build: every exact notice exists, and every status literal is recognised', () => {
  const sources = readdirSync(DIST).filter((n) => n.endsWith('.mjs')).map((n) => readFileSync(join(DIST, n), 'utf8'));
  assert.ok(sources.length > 100, 'positive control: the build is here');
  const everything = sources.filter((t) => /⚠️|🧹|↪️|could not deliver/u.test(t));
  for (const notice of EXACT_NOTICES) {
    const quoted = notice.replaceAll("'", "\\'");
    assert.ok(everything.some((t) => t.includes(notice) || t.includes(quoted)), `no longer in the build: ${notice}`);
  }
  const literal = /"((?:⚠️|🧹|↪️) [^"\n]*)"|`((?:⚠️|🧹|↪️) [^`\n]*)`/gu;
  const found = new Set();
  for (const t of everything) for (const m of t.matchAll(literal)) found.add(m[1] ?? m[2]);
  assert.ok(found.size >= 10, `positive control: found ${found.size} status literals`);
  // A bare "⚠️ " is only a prefix the host builds on, not text of its own.
  const missed = [...found].filter((text) => text.trim().length > 3 && !isHostNotice(text));
  assert.deepEqual(missed, []);
});
