// Two faults in the reply_ref diagnostics: a prefix that is most of a short value, and a status label that names the wrong cause.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { formatStatus } from '../../src/cli/status.mjs';
import { createExit } from '../../src/clo-plugin/lib/channels/qq/exit.js';
import { createLog, refShape } from '../../src/clo-plugin/lib/core/log.js';
import { makeHarness, USAGE } from '../fixtures/inbound.mjs';

const dir = mkdtempSync(join(tmpdir(), 'clo-fix2-diag-'));
const open = [];
let files = 0;
after(async () => {
  for (const h of open) await h.close();
  rmSync(dir, { recursive: true, force: true });
});

// The real exit and the real log, with only the platform faked, so what is asserted is what would really be written.
function stack(responses) {
  files += 1;
  const logFile = join(dir, `log-${files}.jsonl`);
  const bot = { appId: 'FAKE-APP', api: { post: async () => responses.shift() } };
  let h;
  const dispatch = async (turn) => {
    h.exit.collect(turn.turnId, { text: '这是一条普通的回复。' }, { kind: 'final' });
    return { started: true, hostError: false, aborted: false, usage: USAGE };
  };
  h = makeHarness({ dispatch, attach: false, log: createLog(logFile) });
  h.exit = createExit({ bot, store: h.store, policy: h.policy, getEffective: () => h.eff.current, secrets: [], log: h.log, now: h.now, sleep: async () => {} });
  h.gate.attachExit(h.exit);
  h.logText = () => readFileSync(logFile, 'utf8');
  h.lines = (event) => h.logText().trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.event === event);
  open.push(h);
  return h;
}

async function sendOne(h, over = {}) {
  const e = await h.sendAndFlush(h.at(over));
  h.advance(20000);
  assert.equal(h.state(e), 'completed:sent', 'positive control: the send went through');
  return e;
}

const statusLine = (h) => formatStatus({ groups: [], db: { ...h.store.statusSnapshot() } }).split('\n').find((l) => l.includes('bot_refs'));

test('refShape: a prefix is logged only when at least 8 characters of the value stay out of the line', () => {
  assert.equal(refShape('ABCDEFGHIJKL_x').refPrefix, null, 'this would be 13 of the 14 raw characters');
  assert.equal(refShape('AB_c').refPrefix, null);
  assert.deepEqual(refShape('REF_1234567'), { refLen: 11, refPrefix: null }, '7 left over');
  assert.deepEqual(refShape('REF_12345678'), { refLen: 12, refPrefix: 'REF_' }, '8 left over');
  assert.deepEqual(refShape('ABCDEFGHIJKL_12345678'), { refLen: 21, refPrefix: 'ABCDEFGHIJKL_' });
});

test('a short value with a capital prefix: neither written line holds the prefix, and the length still shows', async () => {
  const short = 'ABCDEFGHIJKL_x';
  const h = stack([{ id: 'S1', ext_info: { ref_idx: short } }]);
  await sendOne(h);
  await h.sendAndFlush(h.event({ text: '对，就是这个', refMsgIdx: short }));
  const send = h.lines('exit_post').find((l) => l.state === 'sent');
  const quote = h.lines('reply_ref')[0];
  assert.equal(quote.state, 'matched', 'matching is untouched: it uses the salted key');
  assert.deepEqual([send.refState, send.refLen, send.refPrefix], ['present', short.length, null]);
  assert.deepEqual([quote.refLen, quote.refPrefix], [short.length, null]);
  assert.ok(!h.logText().includes('ABCDEFGHIJKL'));
});

test('a long value still shows its prefix on both lines, so a format mismatch can be read', async () => {
  const long = 'REFIDX_CANARY7Q2';
  const h = stack([{ id: 'S1', ext_info: { ref_idx: long } }]);
  await sendOne(h);
  await h.sendAndFlush(h.event({ text: '对，就是这个', refMsgIdx: long }));
  assert.equal(h.lines('exit_post').find((l) => l.state === 'sent').refPrefix, 'REFIDX_');
  assert.equal(h.lines('reply_ref')[0].refPrefix, 'REFIDX_');
  assert.ok(!h.logText().includes('CANARY7Q2'));
});

test('status does not say the send carried no ref_idx: a non-string one and a missing one share the count', async () => {
  for (const [response, refState] of [
    [{ id: 'S1', ext_info: { ref_idx: 987654321987 } }, 'not_string'],
    [{ id: 'S1', ext_info: { ref_idx: { inner: 'x' } } }, 'not_string'],
    [{ id: 'S1' }, 'absent'],
  ]) {
    const h = stack([response]);
    await sendOne(h);
    assert.equal(h.lines('exit_post').find((l) => l.state === 'sent').refState, refState, 'the log line tells the two apart');
    const line = statusLine(h);
    assert.match(line, /bot_refs：0（已发送但没有可用 ref_idx：1 条）/);
    assert.doesNotMatch(line, /没带/);
  }
});
