// Reply-to-bot compares the inbound ref_msg_idx with the ref_idx of a send response. These lines let a mismatch be seen
// without keeping either value. They change nothing about what matches.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ApiError } from '@tencent-connect/qqbot-nodejs';
import { formatStatus } from '../../src/cli/status.mjs';
import { createExit } from '../../src/clo-plugin/lib/channels/qq/exit.js';
import { createLog, refShape } from '../../src/clo-plugin/lib/core/log.js';
import { GROUP_A, GROUP_B, makeHarness, USAGE } from '../fixtures/inbound.mjs';

const RAW = 'REFIDX_CANARY7Q2';
const RAW_TAIL = 'CANARY7Q2';

const dir = mkdtempSync(join(tmpdir(), 'clo-reply-ref-'));
const open = [];
let files = 0;
after(async () => {
  for (const h of open) await h.close();
  rmSync(dir, { recursive: true, force: true });
});

// The real log, so a key missing from the whitelist or a raw value in a line shows up in what is really written.
function stack() {
  const posts = [];
  const results = [];
  const bot = {
    appId: 'FAKE-APP',
    api: {
      post: async (path, body) => {
        posts.push({ path, body });
        const r = results.shift();
        if (r instanceof Error) throw r;
        return r ?? { id: `SENT${posts.length}` };
      },
    },
  };
  files += 1;
  const logFile = join(dir, `log-${files}.jsonl`);
  let h;
  const dispatch = async (turn) => {
    h.exit.collect(turn.turnId, { text: h.replyText }, { kind: 'final' });
    return { started: true, hostError: false, aborted: false, usage: USAGE };
  };
  h = makeHarness({ dispatch, attach: false, log: createLog(logFile) });
  h.exit = createExit({ bot, store: h.store, policy: h.policy, getEffective: () => h.eff.current, secrets: [], log: h.log, now: h.now, sleep: async () => {} });
  h.gate.attachExit(h.exit);
  h.replyText = '这是一条普通的回复。';
  h.results = results;
  h.posts = posts;
  h.logText = () => readFileSync(logFile, 'utf8');
  h.lines = (event) => h.logText().trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.event === event);
  open.push(h);
  return h;
}

async function ask(h, result, over = {}) {
  h.results.push(result);
  const e = await h.sendAndFlush(h.at(over));
  h.advance(20000);
  return e;
}

const sentLine = (h) => {
  const sent = h.lines('exit_post').filter((l) => l.state === 'sent');
  assert.equal(sent.length, 1, 'positive control: one send was logged');
  return sent[0];
};

test('refShape: the prefix is the leading run of 2 to 12 capitals and an underscore, and never the whole value', () => {
  assert.deepEqual(refShape('REFIDX_abcdefgh'), { refLen: 15, refPrefix: 'REFIDX_' });
  assert.equal(refShape('ABCDEFGHIJKL_abcdefgh').refPrefix, 'ABCDEFGHIJKL_');
  // Each remainder is long enough that only the pattern can be what refuses it.
  for (const noPrefix of ['abcdefgh', 'lower_abcdefgh', 'A_abcdefgh', 'ABCDEFGHIJKLM_abcdefgh', 'x REF_abcdefgh', 'REF1_abcdefgh', 'REFabcdefgh']) assert.equal(refShape(noPrefix).refPrefix, null, noPrefix);
  assert.deepEqual(refShape('REF_'), { refLen: 4, refPrefix: null }, 'all prefix: this would be the raw value');
});

test('exit_post present: salted key, length and prefix, and the raw value is not in the written log', async () => {
  const h = stack();
  const e = await ask(h, { id: 'S1', ext_info: { ref_idx: RAW } });
  assert.equal(h.state(e), 'completed:sent');
  const line = sentLine(h);
  assert.equal(line.refState, 'present');
  assert.equal(line.refKey, h.store.key(RAW));
  assert.equal(line.refLen, RAW.length);
  assert.equal(line.refPrefix, 'REFIDX_');
  assert.ok(!h.logText().includes(RAW));
  assert.ok(!h.logText().includes(RAW_TAIL));
});

test('exit_post absent: nothing about a ref but the state, and the row keeps a null ref_key', async () => {
  for (const response of [{ id: 'S1' }, { id: 'S1', ext_info: {} }, { id: 'S1', ext_info: { ref_idx: null } }, { id: 'S1', ext_info: { ref_idx: '' } }]) {
    const h = stack();
    const e = await ask(h, response);
    assert.equal(h.state(e), 'completed:sent');
    const line = sentLine(h);
    assert.equal(line.refState, 'absent', JSON.stringify(response));
    for (const k of ['refKey', 'refLen', 'refPrefix']) assert.equal(k in line, false, k);
    assert.equal(h.store.sendsForEvent(h.store.key(e.messageId))[0].ref_key, null);
  }
});

test('exit_post not_string: the state only, and the value is neither logged nor recorded as a ref', async () => {
  for (const [value, needle] of [[987654321987, '987654321987'], [{ inner: RAW }, RAW], [['REFIDX_LIST'], 'REFIDX_LIST']]) {
    const h = stack();
    const e = await ask(h, { id: 'S1', ext_info: { ref_idx: value } });
    assert.equal(h.state(e), 'completed:sent');
    const line = sentLine(h);
    assert.equal(line.refState, 'not_string');
    for (const k of ['refKey', 'refLen', 'refPrefix']) assert.equal(k in line, false, k);
    assert.ok(!h.logText().includes(needle));
    assert.equal(h.store.sendsForEvent(h.store.key(e.messageId))[0].ref_key, null);
  }
});

test('a quote of her message: reply_ref matched, with the same refKey as the send, and reply_bot as before', async () => {
  const h = stack();
  await ask(h, { id: 'S1', ext_info: { ref_idx: RAW } });
  const e = await h.sendAndFlush(h.event({ text: '对，就是这个', refMsgIdx: RAW }));
  assert.equal(h.row(e).cls, 'reply_bot');
  const lines = h.lines('reply_ref');
  assert.equal(lines.length, 1);
  const { pid, t, gen, ...line } = lines[0];
  assert.deepEqual(line, {
    event: 'reply_ref', eventKey: h.store.key(e.messageId), groupKey: h.store.key(GROUP_A), state: 'matched',
    refKey: h.lines('exit_post').find((l) => l.state === 'sent').refKey, refLen: RAW.length, refPrefix: 'REFIDX_',
  });
  assert.ok(!h.logText().includes(RAW));
  assert.ok(!h.logText().includes(RAW_TAIL));
});

test('a format mismatch can be read from the two lines, though neither holds the value', async () => {
  const h = stack();
  await ask(h, { id: 'S1', ext_info: { ref_idx: RAW } });
  const quote = 'MSGIDX_LONGER_CANARY7Q2';
  const e = await h.sendAndFlush(h.event({ text: '这件事我也想知道', refMsgIdx: quote }));
  assert.equal(h.row(e).cls, 'interject', 'an unmatched quote stays ordinary');
  const [line] = h.lines('reply_ref');
  const send = h.lines('exit_post').find((l) => l.state === 'sent');
  assert.equal(line.state, 'unmatched');
  assert.notEqual(line.refKey, send.refKey);
  assert.deepEqual([line.refPrefix, line.refLen], ['MSGIDX_', quote.length]);
  assert.deepEqual([send.refPrefix, send.refLen], ['REFIDX_', RAW.length]);
  assert.ok(!h.logText().includes(quote));
  assert.ok(!h.logText().includes(RAW_TAIL));
});

test('unmatched is a log line, never an alert, and the event is handled as if it quoted nothing', async () => {
  const outcome = async (over) => {
    const h = stack();
    const e = await h.sendAndFlush(h.event({ text: '这件事我也想知道', ...over }));
    return { h, cls: h.row(e).cls, state: h.state(e), dispatched: h.dispatched.map((t) => t.cls), decides: h.decideCalls.length, alerts: h.store.listAlerts() };
  };
  const quoting = await outcome({ refMsgIdx: RAW });
  const plain = await outcome({});
  assert.equal(quoting.h.lines('reply_ref')[0].state, 'unmatched');
  assert.equal(plain.h.lines('reply_ref').length, 0);
  assert.equal(quoting.cls, plain.cls);
  assert.equal(quoting.state, plain.state);
  assert.deepEqual(quoting.dispatched, plain.dispatched);
  assert.equal(quoting.decides, plain.decides);
  assert.deepEqual(quoting.alerts, []);
  assert.deepEqual(plain.alerts, []);
});

test('reference matching stays per group: the same value from another group logs unmatched', async () => {
  const h = stack();
  h.store.addBotRef(h.store.key(RAW), h.store.key(GROUP_A), 'E');
  const e = await h.sendAndFlush(h.event({ text: '另一个群引用的', refMsgIdx: RAW, conversationId: GROUP_B }));
  assert.equal(h.row(e).cls, 'interject');
  const [line] = h.lines('reply_ref');
  assert.equal(line.state, 'unmatched');
  assert.equal(line.groupKey, h.store.key(GROUP_B));
});

test('a real @ that also quotes her still looks the ref up, and stays at', async () => {
  const h = stack();
  h.store.addBotRef(h.store.key(RAW), h.store.key(GROUP_A), 'E');
  const e = await ask(h, { id: 'S1' }, { refMsgIdx: RAW });
  assert.equal(h.row(e).cls, 'at');
  assert.equal(h.lines('reply_ref')[0].state, 'matched');
});

test('no ref_msg_idx: no reply_ref line, for a real @ or for an ordinary message', async () => {
  const h = stack();
  await ask(h, { id: 'S1', ext_info: { ref_idx: RAW } });
  await h.sendAndFlush(h.event({ text: '这件事我也想知道' }));
  assert.ok(h.lines('exit_post').length > 0, 'positive control: the log has lines');
  assert.deepEqual(h.lines('reply_ref'), []);
});

test('a redelivered event logs once, and a stale one is still logged', async () => {
  const h = stack();
  const e = h.event({ text: '这件事我也想知道', refMsgIdx: RAW });
  await h.sendAndFlush(e);
  await h.sendAndFlush({ ...e });
  assert.equal(h.lines('gate_dup').length, 1, 'positive control: the second delivery was seen as a duplicate');
  assert.equal(h.lines('reply_ref').length, 1);
  const old = await h.sendAndFlush(h.event({ text: '很久以前的引用', refMsgIdx: RAW, timestampMs: h.now() - h.eff.current.window.staleMs - 1000 }));
  assert.equal(h.row(old).state, 'stale');
  assert.equal(h.lines('reply_ref').length, 2);
});

test('status counts sent rows with no ref, only those, and shows the count beside bot_refs', async () => {
  const h = stack();
  await ask(h, { id: 'S1', ext_info: { ref_idx: RAW } });
  assert.equal(h.store.statusSnapshot().sendsNoRef, 0, 'a send that returned ref_idx is not counted');
  await ask(h, { id: 'S2' });
  await ask(h, { id: 'S3', ext_info: { ref_idx: 12345 } });
  const failed = await ask(h, new ApiError('API Error [/x]: PLATFORM-TEXT', 400, '/x', 40034006, 'PLATFORM-TEXT'));
  const unsure = await ask(h, { timestamp: 'x' });
  assert.equal(h.store.sendsForEvent(h.store.key(failed.messageId))[0].state, 'failed');
  assert.equal(h.store.sendsForEvent(h.store.key(unsure.messageId))[0].state, 'uncertain');
  const snapshot = h.store.statusSnapshot();
  assert.equal(snapshot.sendsNoRef, 2, 'the uncertain and the failed sends are not counted');
  assert.equal(snapshot.botRefsSeen, 1);
  const line = formatStatus({ groups: [], db: { ...snapshot } }).split('\n').find((l) => l.includes('bot_refs'));
  assert.match(line, /bot_refs：1（已发送但没有可用 ref_idx：2 条）/);
});

test('status: a dedupe answer marked sent had no response to carry ref_idx, so it is not counted', async () => {
  const h = stack();
  h.eff.current = { ...h.eff.current, qq: { ...h.eff.current.qq, maxPartChars: 12 } };
  h.replyText = '同一段内容。\n\n同一段内容。';
  await ask(h, { id: 'S1', ext_info: { ref_idx: RAW } });
  assert.equal(h.store.statusSnapshot().sendsNoRef, 1, 'positive control: the second part had a response with no ref');
  h.results.push({ id: 'S2', ext_info: { ref_idx: `${RAW}B` } });
  const f = await ask(h, new ApiError('API Error [/x]: PLATFORM-TEXT', 400, '/x', 40054005, 'PLATFORM-TEXT'));
  const rows = h.store.sendsForEvent(h.store.key(f.messageId));
  assert.deepEqual(rows.map((r) => [r.state, r.qq_code]), [['sent', null], ['sent', 40054005]], 'the dedupe row is sent with a code and no ref');
  assert.equal(rows[1].ref_key, null);
  assert.equal(h.store.statusSnapshot().sendsNoRef, 1, 'unchanged by the dedupe row');
});

test('status counts what the janitor has left', async () => {
  const h = stack();
  await ask(h, { id: 'S1' });
  assert.equal(h.store.statusSnapshot().sendsNoRef, 1);
  h.advance(15 * 24 * 3600000);
  await ask(h, { id: 'S2' });
  assert.equal(h.store.statusSnapshot().sendsNoRef, 2, 'old rows count until they are cleaned');
  const removed = h.store.janitor(h.now(), { eventDays: 14, sendDays: 14, reservationDays: 90 });
  assert.equal(removed.sends, 1);
  assert.equal(h.store.statusSnapshot().sendsNoRef, 1);
});
