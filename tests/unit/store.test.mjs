import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { openStore, NON_TERMINAL_STATES, TERMINAL_STATES } from '../../src/clo-plugin/lib/core/store.js';

const dir = mkdtempSync(join(tmpdir(), 'clo-store-'));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
let n = 0;
const T0 = Date.UTC(2026, 10, 3, 4, 0, 0); // 12:00 Asia/Shanghai

function fresh(runGen = 'gen-a', start = T0) {
  const clock = { t: start };
  const file = join(dir, `s${++n}.db`);
  const store = openStore(file, { runGen, now: () => clock.t });
  return { store, clock, file };
}

const LIMITS = { cooldownMs: 8 * 60000, perHour: 6, perDay: 8, leaseMs: 120000 };
const RATE = { accountPerMin: 12, accountPerHour: 120, groupPerMin: 4 };
const shape = { eventKey: 'E1', groupKey: 'G1', msgTs: T0, receivedAt: T0 };

test('A8: WAL, full sync and user_version on a real file under the private Node', () => {
  const { store } = fresh();
  assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(store.db.prepare('PRAGMA synchronous').get().synchronous, 2);
  assert.equal(store.db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 1);
  store.close();
});

test('the HMAC salt survives a reopen, and keys are case-sensitive', () => {
  const { store, file } = fresh();
  const k = store.key('AbC');
  assert.notEqual(k, store.key('abc'));
  assert.match(k, /^[0-9a-f]{32}$/);
  store.close();
  const again = openStore(file, { runGen: 'gen-b' });
  assert.equal(again.key('AbC'), k);
  again.close();
});

test('a newer schema is refused', () => {
  const { store, file } = fresh();
  store.db.exec('PRAGMA user_version=2');
  store.close();
  assert.throws(() => openStore(file), /newer than this build/);
});

test('tx commits, rolls back on throw, nests with savepoints, and refuses async work', async () => {
  const { store } = fresh();
  store.tx(() => store.setControl('a', '1'));
  assert.equal(store.getControl('a'), '1');
  assert.throws(() => store.tx(() => { store.setControl('b', '1'); throw new Error('boom'); }), /boom/);
  assert.equal(store.getControl('b'), null);
  store.tx(() => {
    store.setControl('c', '1');
    assert.throws(() => store.tx(() => { store.setControl('d', '1'); throw new Error('inner'); }), /inner/);
  });
  assert.equal(store.getControl('c'), '1');
  assert.equal(store.getControl('d'), null);
  assert.throws(() => store.tx(async () => {}), /synchronous/);
  assert.equal(store.tx(() => 5), 5, 'a failed async tx must leave the connection usable');
  store.close();
});

test('claimEvent is durable across a reopen and reports the state of a duplicate', () => {
  const { store, file } = fresh();
  assert.deepEqual(store.claimEvent(shape), { fresh: true });
  assert.deepEqual(store.claimEvent(shape), { fresh: false, state: 'received' });
  store.close();
  const again = openStore(file, { runGen: 'gen-b' });
  assert.deepEqual(again.claimEvent(shape), { fresh: false, state: 'received' });
  again.close();
});

test('transition checks from-states, refuses terminal origins and unknown states, and keeps text out', () => {
  const { store } = fresh();
  store.claimEvent(shape);
  assert.equal(store.transition('E1', ['queued'], 'deciding'), false);
  assert.equal(store.getEvent('E1').state, 'received');
  assert.equal(store.transition('E1', ['received'], 'queued'), true);
  assert.throws(() => store.transition('E1', ['queued'], 'nonsense'), /unknown state/);
  assert.throws(() => store.transition('E1', ['completed'], 'queued'), /terminal/);
  assert.throws(() => store.transition('E1', ['queued'], 'failed', { reason: '这是一句消息正文' }), /bad reason/);
  assert.throws(() => store.setClass('E1', 'a message body with spaces'), /bad class/);
  assert.equal(store.transition('E1', ['queued'], 'merged', { reason: 'would_at', mergedInto: 'E9' }), true);
  const ev = store.getEvent('E1');
  assert.equal(ev.state, 'merged');
  assert.equal(ev.reason, 'would_at');
  assert.equal(ev.merged_into, 'E9');
  store.close();
});

test('every state in the design is known', () => {
  assert.deepEqual(NON_TERMINAL_STATES, ['received', 'queued', 'deciding', 'approved', 'dispatching', 'delivering']);
  assert.equal(TERMINAL_STATES.length, 12);
});

test('bumpCounter honours max without changing the value, and expires', () => {
  const { store, clock } = fresh();
  assert.deepEqual(store.bumpCounter('k', T0 + 1000, 2), { ok: true, value: 1 });
  assert.deepEqual(store.bumpCounter('k', T0 + 1000, 2), { ok: true, value: 2 });
  assert.deepEqual(store.bumpCounter('k', T0 + 1000, 2), { ok: false, value: 2 });
  assert.equal(store.peekCounter('k'), 2);
  clock.t = T0 + 1000;
  assert.equal(store.peekCounter('k'), 0);
  assert.deepEqual(store.bumpCounter('k', T0 + 5000, 2), { ok: true, value: 1 });
  assert.deepEqual(store.bumpCounter('nomax', T0 + 1000), { ok: true, value: 1 });
  store.close();
});

test('interject: claim excludes a second claim, release frees it, consume starts the cooldown', () => {
  const { store, clock } = fresh();
  const args = { groupKey: 'G1', limits: LIMITS };
  assert.deepEqual(store.peekInterject(args), { ok: true });
  const a = store.claimInterject({ ...args, eventKey: 'E1' });
  assert.equal(a.ok, true);
  assert.deepEqual(store.claimInterject({ ...args, eventKey: 'E2' }), { ok: false, reason: 'inflight' });
  assert.equal(store.claimInterject({ ...args, groupKey: 'G2', eventKey: 'E3' }).ok, true, 'other groups are independent');
  assert.equal(store.releaseInterject(a.id), true);
  const b = store.claimInterject({ ...args, eventKey: 'E2' });
  assert.equal(b.ok, true);
  assert.equal(store.consumeInterject(b.id), true);
  assert.equal(store.consumeInterject(b.id), false);
  assert.deepEqual(store.peekInterject(args), { ok: false, reason: 'cooldown' });
  clock.t += LIMITS.cooldownMs - 1;
  assert.equal(store.peekInterject(args).reason, 'cooldown');
  clock.t += 1;
  assert.deepEqual(store.peekInterject(args), { ok: true });
  store.close();
});

test('interject: an expired lease does not block forever', () => {
  const { store, clock } = fresh();
  const args = { groupKey: 'G1', limits: LIMITS };
  const a = store.claimInterject({ ...args, eventKey: 'E1' });
  clock.t += LIMITS.leaseMs;
  const b = store.claimInterject({ ...args, eventKey: 'E2' });
  assert.equal(b.ok, true);
  assert.equal(store.consumeInterject(a.id), false, 'a lapsed claim cannot be consumed');
  store.close();
});

test('interject: hour and day caps count consumed rows only', () => {
  const { store, clock } = fresh();
  const limits = { ...LIMITS, cooldownMs: 0, perHour: 2, perDay: 3 };
  const args = { groupKey: 'G1', limits };
  const take = (e) => {
    const c = store.claimInterject({ ...args, eventKey: e });
    assert.equal(c.ok, true);
    store.consumeInterject(c.id);
  };
  take('E1');
  take('E2');
  assert.deepEqual(store.peekInterject(args), { ok: false, reason: 'hour' });
  clock.t += 3600000;
  take('E3');
  assert.deepEqual(store.peekInterject(args), { ok: false, reason: 'day' });
  clock.t = Date.UTC(2026, 10, 3, 16, 0, 0); // midnight in Shanghai
  assert.deepEqual(store.peekInterject(args), { ok: true });
  store.close();
});

test('insertSendParts: atomic over all parts, monotonic seq, rate refusal leaves no rows', () => {
  const { store, clock } = fresh();
  const base = { eventKey: 'E1', groupKey: 'G1', kind: 'reply', rate: RATE };
  const three = [{ textSha: 'a' }, { textSha: 'b' }, { textSha: 'c' }];
  const r = store.insertSendParts({ ...base, parts: three });
  assert.deepEqual(r, { ok: true, rows: [{ sendId: 'E1:1', msgSeq: 1, part: 0 }, { sendId: 'E1:2', msgSeq: 2, part: 1 }, { sendId: 'E1:3', msgSeq: 3, part: 2 }] });
  assert.deepEqual(store.insertSendParts({ ...base, parts: three }), { ok: false, reason: 'group_minute' });
  assert.equal(store.sendsForEvent('E1').length, 3);
  const fixed = store.insertSendParts({ ...base, kind: 'fixed_line', parts: [{ textSha: 'f' }] });
  assert.equal(fixed.rows[0].msgSeq, 4, 'a fixed line gets a new seq, not a hash');
  assert.deepEqual(store.insertSendParts({ ...base, parts: [] }), { ok: false, reason: 'no_parts' });

  clock.t += 61000;
  const acct = { accountPerMin: 2, accountPerHour: 120, groupPerMin: 100 };
  assert.deepEqual(store.insertSendParts({ eventKey: 'E2', groupKey: 'G2', kind: 'reply', rate: acct, parts: three }), { ok: false, reason: 'account_minute' });
  assert.equal(store.sendsForEvent('E2').length, 0);
  const hourly = { accountPerMin: 100, accountPerHour: 5, groupPerMin: 100 };
  assert.deepEqual(store.insertSendParts({ eventKey: 'E2', groupKey: 'G2', kind: 'reply', rate: hourly, parts: three }), { ok: false, reason: 'account_hour' });
  store.close();
});

test('aborted parts do not count against the rate', () => {
  const { store } = fresh();
  const rate = { accountPerMin: 100, accountPerHour: 100, groupPerMin: 2 };
  const base = { eventKey: 'E1', groupKey: 'G1', kind: 'reply', rate };
  const r = store.insertSendParts({ ...base, parts: [{ textSha: 'a' }, { textSha: 'b' }] });
  assert.equal(store.insertSendParts({ ...base, parts: [{ textSha: 'c' }] }).ok, false);
  for (const row of r.rows) store.markSend(row.sendId, 'aborted');
  assert.equal(store.insertSendParts({ ...base, parts: [{ textSha: 'c' }] }).ok, true);
  store.close();
});

test('markSend only moves forward and records codes', () => {
  const { store } = fresh();
  const { rows } = store.insertSendParts({ eventKey: 'E1', groupKey: 'G1', kind: 'reply', parts: [{ textSha: 'a' }] });
  const id = rows[0].sendId;
  assert.equal(store.markSend(id, 'sent'), false, 'pending cannot jump to sent');
  assert.equal(store.markSend(id, 'sending'), true);
  assert.equal(store.markSend(id, 'failed', { qqCode: 40034006, httpStatus: 400 }), true);
  assert.equal(store.markSend(id, 'sent'), false, 'failed is final');
  const row = store.getSend(id);
  assert.equal(row.state, 'failed');
  assert.equal(row.qq_code, 40034006);
  assert.equal(row.http_status, 400);
  assert.equal(store.markSend('nope', 'sending'), false);
  store.close();
});

test('bot refs are per group', () => {
  const { store } = fresh();
  store.addBotRef('R1', 'G1', 'E1');
  assert.equal(store.hasBotRef('R1', 'G1'), true);
  assert.equal(store.hasBotRef('R1', 'G2'), false);
  store.close();
});

test('alerts: six an hour per kind, the rest are counted, detail is whitelisted', () => {
  const { store, clock } = fresh();
  for (let i = 0; i < 9; i += 1) store.addAlert('k', { reason: 'r', text: '消息正文', member: 'RAWID' });
  store.addAlert('other', {});
  const rows = store.listAlerts();
  const k = rows.filter((a) => a.kind === 'k');
  assert.equal(k.length, 6);
  assert.equal(k[5].suppressed, 3);
  assert.deepEqual(k[0].detail, { reason: 'r' });
  assert.equal(rows.filter((a) => a.kind === 'other').length, 1);
  clock.t += 3600001;
  assert.notEqual(store.addAlert('k', {}), null);
  store.ackAlerts([k[0].id]);
  assert.equal(store.listAlerts({ unackedOnly: true }).some((a) => a.id === k[0].id), false);
  store.close();
});

test('pauseState reads every switch', () => {
  const { store } = fresh();
  assert.deepEqual(store.pauseState('G1'), { global: false, group: false, interject: false, paid: null, terminal: null });
  store.setControl('global_paused', '1', 'cli');
  store.setControl('group_paused:G1', '1', 'cli');
  store.setControl('interject_paused', '1', 'gate');
  store.setControl('paid_paused', 'crash_unsettled', 'recovery');
  store.setControl('terminal_close', '4914', 'connection');
  assert.deepEqual(store.pauseState('G1'), { global: true, group: true, interject: true, paid: 'crash_unsettled', terminal: '4914' });
  assert.equal(store.pauseState('G2').group, false);
  store.delControl('group_paused:G1');
  assert.equal(store.pauseState('G1').group, false);
  store.close();
});

test('discovery writes only while armed, caps the window, and clears', () => {
  const { store, clock } = fresh();
  assert.equal(store.recordDiscovery({ groupId: 'GROUP', memberId: 'MEMBER' }), false);
  assert.deepEqual(store.listDiscovery(), []);
  store.armDiscovery(T0 + 24 * 3600000);
  assert.equal(Number(store.getControl('discovery_until')), T0 + 15 * 60000, 'fifteen minutes at most');
  assert.equal(store.recordDiscovery({ groupId: 'GROUP', memberId: 'MEMBER' }), true);
  assert.equal(store.recordDiscovery({ groupId: 'GROUP', memberId: 'MEMBER' }), true);
  store.recordDiscovery({ groupId: 'GROUP', memberId: null });
  const rows = store.listDiscovery();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].count, 2);
  assert.equal(rows[0].groupId, 'GROUP');
  assert.equal(rows[1].memberId, null);
  clock.t = T0 + 15 * 60000;
  assert.equal(store.recordDiscovery({ groupId: 'LATE', memberId: 'M' }), false);
  store.clearDiscovery();
  assert.deepEqual(store.listDiscovery(), []);
  assert.equal(store.getControl('discovery_until'), null);
  store.close();
});

// Section 4.4: each row is written by one generation and recovered by the next.
function reserveRow(store, { id, eventKey, category = 'reply', status = 'held', tier = 'addressed' }) {
  store.q(`INSERT INTO reservations(id, local_day, utc_day, tier, category, held_micros, status, event_key, run_gen, created_at)
           VALUES (?, '2026-11-03', '2026-11-03', ?, ?, 1000, ?, ?, ?, ?)`).run(id, tier, category, status, eventKey, store.runGen, T0);
}
const holdStatus = (s, id) => s.q('SELECT status FROM reservations WHERE id=?').get(id).status;
const claimStatus = (s, id) => s.q('SELECT status FROM interject_log WHERE id=?').get(id).status;

function crashed(setup) {
  const { store, file } = fresh('old-gen');
  store.claimEvent(shape);
  setup(store);
  store.close();
  const next = openStore(file, { runGen: 'new-gen', now: () => T0 + 1000 });
  const counts = next.recoverOnStart(T0 + 1000);
  return { next, counts };
}
const toState = (store, ...states) => {
  let from = 'received';
  for (const s of states) {
    assert.equal(store.transition('E1', [from], s), true);
    from = s;
  }
};

test('recovery: received and queued become restart_dropped', () => {
  const { next, counts } = crashed(() => {});
  assert.equal(next.getEvent('E1').state, 'restart_dropped');
  assert.equal(counts.restart_dropped, 1);
  next.close();
  const q = crashed((s) => toState(s, 'queued'));
  assert.equal(q.next.getEvent('E1').state, 'restart_dropped');
  q.next.close();
});

test('recovery: deciding leaves the hold unsettled, releases the claim, no paid pause', () => {
  let claim;
  const { next, counts } = crashed((s) => {
    toState(s, 'queued', 'deciding');
    claim = s.claimInterject({ groupKey: 'G1', eventKey: 'E1', limits: LIMITS }).id;
    reserveRow(s, { id: 'H1', eventKey: 'E1', category: 'decision', tier: 'interject' });
  });
  assert.equal(next.getEvent('E1').state, 'restart_dropped');
  assert.equal(holdStatus(next, 'H1'), 'unsettled');
  assert.equal(claimStatus(next, claim), 'released');
  assert.equal(next.getControl('paid_paused'), null);
  assert.equal(counts.holds_unsettled, 1);
  assert.equal(counts.claims_released, 1);
  next.close();
});

test('recovery: approved releases the reply hold and the claim, because no model ran', () => {
  let claim;
  const { next, counts } = crashed((s) => {
    toState(s, 'queued', 'deciding', 'approved');
    claim = s.claimInterject({ groupKey: 'G1', eventKey: 'E1', limits: LIMITS }).id;
    reserveRow(s, { id: 'H1', eventKey: 'E1' });
  });
  assert.equal(next.getEvent('E1').state, 'restart_dropped');
  assert.equal(holdStatus(next, 'H1'), 'released');
  assert.equal(claimStatus(next, claim), 'released');
  assert.equal(counts.holds_released, 1);
  assert.equal(next.getControl('paid_paused'), null);
  next.close();
});

test('recovery: dispatching is crash_unknown, hold unsettled, paid pause, alert, claim stays consumed', () => {
  let claim;
  const { next, counts } = crashed((s) => {
    toState(s, 'queued', 'deciding', 'approved', 'dispatching');
    claim = s.claimInterject({ groupKey: 'G1', eventKey: 'E1', limits: LIMITS }).id;
    s.consumeInterject(claim);
    reserveRow(s, { id: 'H1', eventKey: 'E1' });
  });
  assert.equal(next.getEvent('E1').state, 'crash_unknown');
  assert.equal(holdStatus(next, 'H1'), 'unsettled');
  assert.equal(claimStatus(next, claim), 'consumed');
  assert.equal(next.getControl('paid_paused'), 'crash_unsettled');
  assert.deepEqual(next.listAlerts().map((a) => a.kind).sort(), ['crash_unknown', 'paid_paused']);
  assert.equal(counts.paid_paused, 1);
  next.close();
});

test('recovery: delivering with a pending part aborts it, never re-sends', () => {
  const { next, counts } = crashed((s) => {
    toState(s, 'queued', 'deciding', 'approved', 'dispatching', 'delivering');
    reserveRow(s, { id: 'H1', eventKey: 'E1' });
    s.insertSendParts({ eventKey: 'E1', groupKey: 'G1', kind: 'reply', parts: [{ textSha: 'a' }] });
  });
  assert.equal(next.getEvent('E1').state, 'crash_unknown');
  assert.equal(next.getSend('E1:1').state, 'aborted');
  assert.equal(holdStatus(next, 'H1'), 'unsettled');
  assert.equal(next.getControl('paid_paused'), 'crash_unsettled');
  assert.equal(counts.sends_aborted, 1);
  next.close();
});

test('recovery: delivering with a sending part becomes uncertain and raises an alert', () => {
  const { next, counts } = crashed((s) => {
    toState(s, 'queued', 'deciding', 'approved', 'dispatching', 'delivering');
    reserveRow(s, { id: 'H1', eventKey: 'E1' });
    s.insertSendParts({ eventKey: 'E1', groupKey: 'G1', kind: 'reply', parts: [{ textSha: 'a' }, { textSha: 'b' }] });
    s.markSend('E1:1', 'sending');
  });
  assert.equal(next.getEvent('E1').state, 'crash_unknown');
  assert.equal(next.getSend('E1:1').state, 'uncertain');
  assert.equal(next.getSend('E1:2').state, 'aborted');
  assert.equal(counts.sends_uncertain, 1);
  assert.deepEqual(next.listAlerts().map((a) => a.kind).sort(), ['crash_send_uncertain', 'paid_paused']);
  next.close();
});

test('recovery: all parts sent before finish means completed, hold still unsettled', () => {
  const { next, counts } = crashed((s) => {
    toState(s, 'queued', 'deciding', 'approved', 'dispatching', 'delivering');
    reserveRow(s, { id: 'H1', eventKey: 'E1' });
    s.insertSendParts({ eventKey: 'E1', groupKey: 'G1', kind: 'reply', parts: [{ textSha: 'a' }] });
    s.markSend('E1:1', 'sending');
    s.markSend('E1:1', 'sent');
  });
  assert.equal(next.getEvent('E1').state, 'completed');
  assert.equal(next.getSend('E1:1').state, 'sent');
  assert.equal(holdStatus(next, 'H1'), 'unsettled');
  assert.equal(next.getControl('paid_paused'), 'crash_unsettled', 'the model ran, so settlement is unknown (Contract changes)');
  assert.equal(counts.completed, 1);
  next.close();
});

test('recovery: a terminal row is untouched, a redelivered message stays a duplicate, a crashed fixed line is uncertain', () => {
  const { next, counts } = crashed((s) => {
    toState(s, 'queued');
    s.transition('E1', ['queued'], 'failed', { reason: 'host_error' });
    s.insertSendParts({ eventKey: 'E1', groupKey: 'G1', kind: 'fixed_line', parts: [{ textSha: 'f' }] });
    s.markSend('E1:1', 'sending');
  });
  const ev = next.getEvent('E1');
  assert.equal(ev.state, 'failed');
  assert.equal(ev.reason, 'host_error');
  assert.equal(next.getSend('E1:1').state, 'uncertain');
  assert.equal(counts.crash_unknown, 0);
  assert.deepEqual(next.claimEvent(shape), { fresh: false, state: 'failed' });
  next.close();
});

test('recovery ignores rows from its own generation', () => {
  const { store } = fresh('same-gen');
  store.claimEvent(shape);
  store.transition('E1', ['received'], 'dispatching');
  reserveRow(store, { id: 'H1', eventKey: 'E1' });
  const counts = store.recoverOnStart(T0);
  assert.equal(store.getEvent('E1').state, 'dispatching');
  assert.equal(holdStatus(store, 'H1'), 'held');
  assert.equal(counts.crash_unknown, 0);
  store.close();
});

test('recovery does not pause when a crashed turn had no hold, and an orphan hold stays counted', () => {
  const none = crashed((s) => toState(s, 'queued', 'deciding', 'approved', 'dispatching'));
  assert.equal(none.next.getControl('paid_paused'), null, 'owner command turns have no hold');
  none.next.close();

  const orphan = crashed((s) => {
    s.transition('E1', ['received'], 'completed');
    reserveRow(s, { id: 'H9', eventKey: 'E1' });
  });
  assert.equal(holdStatus(orphan.next, 'H9'), 'unsettled');
  orphan.next.close();
});

test('recovery resets connected, since no socket survives a restart', () => {
  const { next } = crashed((s) => s.setControl('connected', 'true', 'test'));
  assert.equal(next.getControl('connected'), 'false');
  next.close();
});

test('janitor removes only what retention allows', () => {
  const { store, clock } = fresh();
  const retention = { eventDays: 14, sendDays: 14, reservationDays: 90 };
  const day = 24 * 3600000;
  store.claimEvent({ eventKey: 'OLD', groupKey: 'G1', receivedAt: T0 });
  store.transition('OLD', ['received'], 'completed');
  store.claimEvent({ eventKey: 'OPEN', groupKey: 'G1', receivedAt: T0 });
  store.insertSendParts({ eventKey: 'OLD', groupKey: 'G1', kind: 'reply', parts: [{ textSha: 'a' }], now: T0 });
  store.markSend('OLD:1', 'sending');
  store.markSend('OLD:1', 'sent');
  store.addBotRef('R', 'G1', 'OLD');
  reserveRow(store, { id: 'S', eventKey: 'OLD', status: 'settled' });
  reserveRow(store, { id: 'U', eventKey: 'OLD', status: 'unsettled' });
  store.bumpCounter('c', T0 + 1);
  clock.t = T0 + 15 * day;
  const removed = store.janitor(clock.t, retention);
  assert.equal(removed.events, 1);
  assert.equal(store.getEvent('OLD'), null);
  assert.notEqual(store.getEvent('OPEN'), null, 'an open event is kept');
  assert.equal(store.getSend('OLD:1'), null);
  assert.equal(store.hasBotRef('R', 'G1'), false);
  assert.equal(removed.counters, 1);
  assert.equal(holdStatus(store, 'S'), 'settled', 'reservations last longer');
  clock.t = T0 + 91 * day;
  store.janitor(clock.t, retention);
  assert.equal(store.q('SELECT id FROM reservations WHERE id=?').get('S'), undefined);
  assert.equal(holdStatus(store, 'U'), 'unsettled', 'unknown money is never aged out');
  store.close();
});

test('statusSnapshot reports the facts in section 7.5 and no raw value', () => {
  const { store } = fresh();
  store.claimEvent(shape);
  store.transition('E1', ['received'], 'completed');
  store.addBotRef('R', 'G1', 'E1');
  store.setControl('connected', 'true', 'test');
  store.setControl('heartbeat_at', T0, 'test');
  store.setControl('last_ready_at', T0 - 5, 'test');
  store.setControl('group_paused:G1', '1', 'cli');
  store.bumpCounter('skip_class:2026-11-03', T0 + 3600000);
  reserveRow(store, { id: 'H', eventKey: 'E1', tier: 'named' });
  reserveRow(store, { id: 'U', eventKey: 'E1', status: 'unsettled' });
  const { rows } = store.insertSendParts({ eventKey: 'E1', groupKey: 'G1', kind: 'reply', parts: [{ textSha: 'a' }] });
  store.markSend(rows[0].sendId, 'sending');
  store.markSend(rows[0].sendId, 'uncertain');
  const s = store.statusSnapshot(T0);
  assert.equal(s.connected, true);
  assert.equal(s.heartbeatAt, T0);
  assert.equal(s.lastReadyAt, T0 - 5);
  assert.deepEqual(s.paused.groups, ['G1']);
  assert.equal(s.spendToday.named, 1000);
  assert.equal(s.spendToday.addressed, 1000);
  assert.equal(s.unsettled, 1);
  assert.equal(s.eventsToday.completed, 1);
  assert.equal(s.sendsUncertain, 1);
  assert.equal(s.botRefsSeen, 1);
  assert.equal(s.skipClassToday, 1);
  store.close();
});

test('sendWaitMs: 0 when it fits, until the oldest needed row ages out, Infinity if it never could', () => {
  const at = 1000000;
  const store = openStore(join(dir, 'wait.db'), { runGen: 'g', now: () => at });
  const rate = { accountPerMin: 12, accountPerHour: 120, groupPerMin: 4 };
  const put = (n, when) => store.insertSendParts({ eventKey: `E${when}`, groupKey: 'G', kind: 'reply', parts: new Array(n).fill({ textSha: 'x' }), rate: null, now: when });
  assert.equal(store.sendWaitMs({ groupKey: 'G', need: 4, rate, now: at }), 0);
  assert.equal(store.sendWaitMs({ groupKey: 'G', need: 5, rate, now: at }), Infinity);
  put(2, at - 50000);
  put(1, at - 10000);
  assert.equal(store.sendWaitMs({ groupKey: 'G', need: 1, rate, now: at }), 0);
  assert.equal(store.sendWaitMs({ groupKey: 'G', need: 2, rate, now: at }), 10000, 'the first old row');
  assert.equal(store.sendWaitMs({ groupKey: 'G', need: 3, rate, now: at }), 10000);
  assert.equal(store.sendWaitMs({ groupKey: 'G', need: 4, rate, now: at }), 50000, 'the newest row too');
  store.close();
});

test('recovery does not overwrite a higher pause reason, and says so in its count', () => {
  for (const reason of ['openrouter_key_limit', 'openrouter_credits', 'usage_unavailable']) {
    const { next, counts } = crashed((s) => {
      toState(s, 'queued', 'deciding', 'approved', 'dispatching');
      reserveRow(s, { id: 'H1', eventKey: 'E1' });
      s.setControl('paid_paused', reason, 'test');
    });
    assert.equal(holdStatus(next, 'H1'), 'unsettled', 'the money still counts');
    assert.equal(next.getControl('paid_paused'), reason);
    assert.equal(counts.paid_paused, 0);
    assert.deepEqual(next.listAlerts().map((a) => a.kind), ['crash_unknown']);
    next.close();
  }
});

test('recovery still replaces a lower reason, and an equal one as before', () => {
  for (const reason of ['provider_fail', 'key_read_failed', 'residual', 'usage_missing']) {
    const { next, counts } = crashed((s) => {
      toState(s, 'queued', 'deciding', 'approved', 'dispatching');
      reserveRow(s, { id: 'H1', eventKey: 'E1' });
      s.setControl('paid_paused', reason, 'test');
    });
    assert.equal(next.getControl('paid_paused'), 'crash_unsettled', reason);
    assert.equal(counts.paid_paused, 1);
    next.close();
  }
});

test('controlUpdatedAt is the time of the last write, and null when there is no row', () => {
  const { store, clock } = fresh();
  assert.equal(store.controlUpdatedAt('paid_paused'), null);
  store.setControl('paid_paused', 'residual', 'test');
  assert.equal(store.controlUpdatedAt('paid_paused'), clock.t);
  clock.t += 5;
  store.setControl('paid_paused', 'residual', 'test');
  assert.equal(store.controlUpdatedAt('paid_paused'), clock.t);
  store.close();
});
