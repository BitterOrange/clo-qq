// The only module that POSTs messages, and the only one that uses the SDK object after connection.js
// built it. A reply is buffered for the whole turn, checked once as a whole, then sent as passive parts.
import { createHash } from 'node:crypto';
import { loadFixedLines } from '../../core/contentPolicy.js';
import { crashpoint, hourBucket, shanghaiDay } from '../../core/ids.js';
import { refShape } from '../../core/log.js';
import { isHostNotice, noticeLogReason, withoutHostNotices } from './hostNotices.js';
import { checkFormForQq, clipToSentence, removeUrls, shapeForQq, splitParts } from './text.js';

// The token alone, whatever punctuation or symbols wrap it. The host swallows some wrapped forms and not others,
// and shaping can reveal one from inside backticks, tildes or a code block.
const SILENT = /^[\s\p{P}\p{S}]*(?:NO_REPLY|HEARTBEAT_OK|ANNOUNCE_SKIP|REPLY_SKIP)[\s\p{P}\p{S}]*$/iu;
const PASSIVE_WINDOW_MS = 285000;
const HOUR = 3600000;
const VIOLATIONS_TO_LATCH = 2;
// Read-only, for the liveness probe.
const PROBE_PATH = '/gateway';

const CODE_URL_REFUSED = 40054010;
const CODE_DEDUPE = 40054005;
const CODE_VIOLATION = 40034006;
const CODES_PASSIVE = new Set([40034128, 40034005, 304103]);
const CODES_GROUP = new Set([40054002, 40034101, 40054003]);
const CODES_DM = new Set([40034105, 40034100, 40054013]);

// New TCP connects to the QQ hosts can time out often on a lossy path, while long-lived sockets stay up. Assuming up to
// about 25% per try, four tries keep the combined failure rate under 0.5%, and take at most about 45 s.
const SEND_CONNECT_ATTEMPTS = 4;
const PROBE_CONNECT_ATTEMPTS = 3;
const CONNECT_RETRY_DELAY_MS = 1000;
// How soon a wait for send-rate room notices that the owner stopped the turn.
const WAKE_POLL_MS = 250;

// The SDK keeps no error object, only the cause's text, so this reads that text. It lists failures that happen before
// any byte of the request can leave: the socket never connected, or the token needed for the request was never fetched.
// Anything else, including a timeout or a socket lost after connecting, may have reached the platform and stays uncertain.
// SDK 1.0.5 on Node 24.22.2. Seen on the real host: the connect timeout. Pinned against the real SDK by tests: a refused
// connection and a token that could not be fetched. Taken on trust, as a literal in tests: getaddrinfo. A change in this
// text ends the retries and nothing fails loudly, but it fails safe: the send becomes uncertain and is not repeated.
// One gap in "before any byte": fetch follows redirects, so a server that processed a POST, then redirected to a host that
// cannot be reached, would match. The same msg_seq is reused so the platform can refuse that as a duplicate.
const NOT_SENT_MESSAGES = [
  /^Network error \[[^\]]*\]: fetch failed \| Connect Timeout Error\b/,
  /^Network error \[[^\]]*\]: fetch failed \| connect E(?:CONNREFUSED|TIMEDOUT|NETUNREACH|HOSTUNREACH)\b/,
  /^Network error \[[^\]]*\]: fetch failed \| getaddrinfo /,
  /^Network error getting access_token: /,
];

export function isDefinitelyNotSent(err) {
  if (err?.bizCode !== undefined && err?.bizCode !== null) return false;
  if (err?.httpStatus !== undefined && err?.httpStatus !== 0) return false;
  return typeof err?.message === 'string' && NOT_SENT_MESSAGES.some((re) => re.test(err.message));
}

const shaOf = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const refuse = (reason) => ({ state: 'failed', reason });

const realSleep = (ms) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  t.unref?.();
});

const suppressed = (cancelReason) => ({ visibleReplySent: false, suppression: { reason: 'channel_transform', cancelReason } });

export function classifySendError(err) {
  const qqCode = Number.isInteger(err?.bizCode) ? err.bizCode : null;
  const httpStatus = Number.isInteger(err?.httpStatus) ? err.httpStatus : null;
  return { qqCode, httpStatus };
}

export function createExit({ bot, store, policy, getEffective, secrets = [], log = () => {}, now = Date.now, appId = null, sleep = realSleep, runtime = 'openclaw' }) {
  if (runtime !== 'openclaw' && runtime !== 'own') throw new TypeError('createExit: runtime must be openclaw or own');
  // Fixed when the process builds it, never read from the effective file: a clo apply under a running process must not
  // switch it halfway, so the host process keeps its notice filter whatever the file says.
  const own = runtime === 'own';
  const turns = new Map();
  const wakers = new Set();
  let stopped = false;
  let lines = null;
  let linesFile = null;

  const fixedLine = (eff, key) => {
    const file = eff.contentPolicy.linesFile;
    if (lines === null || linesFile !== file) {
      lines = loadFixedLines(file);
      linesFile = file;
    }
    return lines[key];
  };
  const currentSecrets = () => (typeof secrets === 'function' ? secrets() : secrets) ?? [];
  // QQ switched off counts the same as the group coming off the list, as in the gate. The channel closes only after a running turn ends.
  const groupOf = (eff, id) => (eff?.qq?.enabled && eff.qq.groups && Object.hasOwn(eff.qq.groups, id) ? eff.qq.groups[id] : null);
  const rateOf = (eff) => ({
    accountPerMin: eff.limits.sendAccountPerMin,
    accountPerHour: eff.limits.sendAccountPerHour,
    groupPerMin: eff.limits.sendGroupPerMin,
  });
  const boundAppId = () => appId ?? bot?.appId ?? null;
  const accountOk = (eff) => Boolean(boundAppId()) && eff?.qq?.appId === boundAppId();

  function endOfWindow(ref) {
    return Math.min(ref.msgTs ?? ref.receivedAt, ref.receivedAt) + PASSIVE_WINDOW_MS;
  }

  function alertOnce(kind, ref, extra = {}) {
    store.addAlert(kind, { eventKey: ref.eventKey, groupKey: ref.groupKey, ...extra });
    log('exit_alert', { eventKey: ref.eventKey, groupKey: ref.groupKey, kind, ...extra });
  }

  function noteViolation(ref) {
    const at = now();
    const { value } = store.bumpCounter(`violation:${shanghaiDay(at)}`, at + 2 * 24 * HOUR);
    if (value >= VIOLATIONS_TO_LATCH && store.getControl('interject_paused') === null) {
      store.setControl('interject_paused', 'platform_violation', 'exit');
      alertOnce('interject_latched', ref, { count: value });
    }
  }

  // A wait the exit can cut short: stop() ends it at once, and wake() is polled, because nothing tells the exit about a /stop.
  function sleepUnless(ms, wake = () => false) {
    return new Promise((resolve) => {
      const done = () => {
        clearInterval(poll);
        wakers.delete(done);
        resolve();
      };
      const poll = setInterval(() => {
        if (wake()) done();
      }, WAKE_POLL_MS);
      poll.unref?.();
      wakers.add(done);
      Promise.resolve(sleep(ms)).then(done, done);
    });
  }

  // What stops a send right now, or null. A retry or a later part can come many seconds after the checks that let
  // the reply out, so these are read again.
  function hardStop(ref, pausable) {
    if (stopped) return 'exit_refused';
    if (now() >= endOfWindow(ref)) return 'deadline';
    const eff = getEffective();
    if (eff?.mode !== 'live' || store.getControl('terminal_close') !== null || !accountOk(eff) || !groupOf(eff, ref.groupId)) return 'exit_refused';
    if (!pausable) return null;
    const p = store.pauseState(ref.groupKey);
    return p.global || p.group ? 'paused' : null;
  }

  const mayRetrySend = (ref, pausable) => hardStop(ref, pausable) === null;

  // One logical POST: durable before and after. Returns what the send table says should happen next. It is posted again,
  // with the same msg_seq, only after an error that shows the earlier attempt never left this machine.
  async function postPart(ref, row, content, { pausable = true, connectAttempts = SEND_CONNECT_ATTEMPTS, ownerStopped = () => false } = {}) {
    crashpoint('before_post');
    store.markSend(row.sendId, 'sending');
    const path = `/v2/groups/${encodeURIComponent(ref.groupId)}/messages`;
    let res;
    for (let attempt = 1; ; attempt += 1) {
      try {
        res = await bot.api.post(path, { content, msg_type: 0, msg_id: ref.messageId, msg_seq: row.msgSeq });
        break;
      } catch (err) {
        crashpoint('after_post');
        const { qqCode, httpStatus } = classifySendError(err);
        if (!isDefinitelyNotSent(err)) {
          log('exit_post', { eventKey: ref.eventKey, seq: row.msgSeq, part: row.part, qqCode, httpStatus, state: 'error' });
          return { ok: false, ...resolveFailure(ref, row, content, qqCode, httpStatus) };
        }
        log('exit_post', { eventKey: ref.eventKey, seq: row.msgSeq, part: row.part, attempt, state: 'not_connected' });
        const again = attempt < connectAttempts && mayRetrySend(ref, pausable) && !ownerStopped();
        if (again) await sleep(CONNECT_RETRY_DELAY_MS);
        if (ownerStopped()) {
          store.markSend(row.sendId, 'failed', { qqCode, httpStatus });
          return { ok: false, action: 'stop', reason: 'aborted' };
        }
        if (!again || !mayRetrySend(ref, pausable)) {
          store.markSend(row.sendId, 'failed', { qqCode, httpStatus });
          alertOnce('send_not_connected', ref);
          return { ok: false, action: 'stop', reason: 'send_not_connected' };
        }
      }
    }
    crashpoint('after_post');
    if (typeof res?.id !== 'string' || !res.id) {
      store.markSend(row.sendId, 'uncertain', { httpStatus: 200 });
      alertOnce('send_uncertain', ref);
      log('exit_post', { eventKey: ref.eventKey, seq: row.msgSeq, part: row.part, httpStatus: 200, state: 'uncertain' });
      return { ok: false, action: 'stop', reason: 'send_uncertain' };
    }
    const refIdx = res?.ext_info?.ref_idx;
    const refKey = typeof refIdx === 'string' && refIdx ? store.key(refIdx) : null;
    store.markSend(row.sendId, 'sent', { httpStatus: 200, refKey });
    if (refKey) store.addBotRef(refKey, ref.groupKey, ref.eventKey);
    const refFacts = refKey ? { refState: 'present', refKey, ...refShape(refIdx) }
      : { refState: refIdx === undefined || refIdx === null || refIdx === '' ? 'absent' : 'not_string' };
    log('exit_post', { eventKey: ref.eventKey, seq: row.msgSeq, part: row.part, httpStatus: 200, state: 'sent', ...refFacts });
    return { ok: true };
  }

  // Section 6.3. Text from the platform is never read here: codes and status only.
  function resolveFailure(ref, row, content, qqCode, httpStatus) {
    const fail = { qqCode, httpStatus };
    if (qqCode === CODE_URL_REFUSED) {
      store.markSend(row.sendId, 'failed', fail);
      return { action: 'url_refused', reason: 'group_error' };
    }
    if (qqCode === CODE_DEDUPE) {
      const sha = shaOf(content);
      const seen = store.sendsForEvent(ref.eventKey).some((s) => s.state === 'sent' && s.text_sha === sha);
      if (seen) {
        store.markSend(row.sendId, 'sent', fail);
        return { action: 'continue' };
      }
      store.markSend(row.sendId, 'uncertain', fail);
      alertOnce('send_uncertain', ref, { qqCode });
      return { action: 'stop', reason: 'send_uncertain' };
    }
    if (CODES_PASSIVE.has(qqCode)) {
      store.markSend(row.sendId, 'failed', fail);
      return { action: 'stop', reason: 'passive_expired', passive: true };
    }
    if (qqCode === CODE_VIOLATION) {
      store.markSend(row.sendId, 'failed', fail);
      noteViolation(ref);
      return { action: 'stop', reason: 'platform_violation' };
    }
    if (CODES_GROUP.has(qqCode)) {
      store.markSend(row.sendId, 'failed', fail);
      store.setControl(`group_paused:${ref.groupKey}`, String(qqCode), 'exit');
      alertOnce('group_error', ref, { qqCode });
      return { action: 'stop', reason: 'group_error' };
    }
    if (CODES_DM.has(qqCode)) {
      store.markSend(row.sendId, 'failed', fail);
      alertOnce('group_error', ref, { qqCode });
      return { action: 'stop', reason: 'group_error' };
    }
    store.markSend(row.sendId, 'uncertain', fail);
    alertOnce('send_uncertain', ref, fail);
    return { action: 'stop', reason: 'send_uncertain' };
  }

  function abortRest(rows, from) {
    for (const r of rows.slice(from)) store.markSend(r.sendId, 'aborted');
  }

  function insertParts(ref, kind, parts, eff) {
    return store.insertSendParts({
      eventKey: ref.eventKey,
      groupKey: ref.groupKey,
      kind,
      parts: parts.map((p) => ({ textSha: shaOf(p) })),
      rate: rateOf(eff),
      now: now(),
    });
  }

  const failureLineKey = (ref) => `failline:${ref.groupKey}:${hourBucket(now())}`;

  // The hourly limit is spent last, once the line has its send row.
  function spendFailureLineSlot(ref, eff) {
    store.bumpCounter(failureLineKey(ref), (hourBucket(now()) + 2) * HOUR, eff.limits.failureLinePerGroupPerHour);
  }

  // Sends a fixed line or an ack. One part. It applies its own checks and never touches the event row.
  async function sendOneLine(ref, { kind, text, pausable, limited = false }) {
    if (stopped) return { sent: false, reason: 'stopped' };
    const eff = getEffective();
    if (!eff) return { sent: false, reason: 'no_effective' };
    if (eff.mode !== 'live') return { sent: false, reason: 'not_live' };
    if (store.getControl('terminal_close') !== null) return { sent: false, reason: 'terminal' };
    if (!accountOk(eff)) return { sent: false, reason: 'account' };
    if (!groupOf(eff, ref.groupId)) return { sent: false, reason: 'not_admitted' };
    if (pausable) {
      const p = store.pauseState(ref.groupKey);
      if (p.global || p.group) return { sent: false, reason: 'paused' };
    }
    if (now() >= endOfWindow(ref)) return { sent: false, reason: 'deadline' };
    let hit;
    try {
      hit = policy.check(text).hit;
    } catch {
      hit = true;
    }
    if (hit) return { sent: false, reason: 'policy' };
    if (limited && store.peekCounter(failureLineKey(ref)) >= eff.limits.failureLinePerGroupPerHour) return { sent: false, reason: 'failline_rate' };
    const inserted = insertParts(ref, kind, [text], eff);
    if (!inserted.ok) {
      log('exit_drop', { eventKey: ref.eventKey, reason: inserted.reason, kind });
      return { sent: false, reason: 'send_rate' };
    }
    if (limited) spendFailureLineSlot(ref, eff);
    const result = await postPart(ref, inserted.rows[0], text, { pausable });
    return { sent: result.ok === true || result.action === 'continue', reason: result.reason ?? null };
  }

  // A line that must not be lost to a full minute waits for room once, inside the passive window. Every check runs
  // again when it is sent.
  async function sendWaitingOnce(ref, line, why) {
    const first = await sendOneLine(ref, line);
    if (first.reason !== 'send_rate') return first;
    const eff = getEffective();
    if (!eff) return first;
    const waitMs = store.sendWaitMs({ groupKey: ref.groupKey, need: 1, rate: rateOf(eff), now: now() });
    if (!Number.isFinite(waitMs) || now() + waitMs >= endOfWindow(ref)) return first;
    log('exit_wait', { eventKey: ref.eventKey, groupKey: ref.groupKey, reason: why, durationMs: waitMs });
    await sleepUnless(waitMs);
    return sendOneLine(ref, line);
  }

  // The ack is the group's only word that a command took, and /stop tends to come in a burst, when the rate is full.
  // It waits for room once. If it still cannot go out, the operator hears of it.
  async function sendAck(ref, text) {
    const ack = await sendWaitingOnce(ref, { kind: 'command_ack', text, pausable: false }, 'command_ack');
    if (ack.reason === 'send_rate') alertOnce('command_ack_refused', ref);
    return ack;
  }

  // exemptFromCap is for one case, decided by the gate: the failure line after /stop aborts a running turn for a person in danger.
  // That line comes right behind the stop ack, often in a full minute, so it also waits for room once. Whether it went
  // out is the gate's to report.
  async function sendFixed(ref, lineKey, { exemptFromCap = false } = {}) {
    let text;
    try {
      const eff = getEffective();
      if (!eff) return { sent: false, reason: 'no_effective' };
      text = fixedLine(eff, lineKey);
    } catch {
      log('exit_drop', { eventKey: ref.eventKey, reason: 'fixed_line_unreadable' });
      return { sent: false, reason: 'fixed_line_unreadable' };
    }
    if (typeof text !== 'string' || !text) return { sent: false, reason: 'unknown_line' };
    const line = { kind: 'fixed_line', text, pausable: true, limited: lineKey === 'modelFailed' && !exemptFromCap };
    return exemptFromCap ? sendWaitingOnce(ref, line, 'fixed_line') : sendOneLine(ref, line);
  }

  function refOf(turn) {
    return { eventKey: turn.eventKey, groupKey: turn.groupKey, groupId: turn.groupId, messageId: turn.messageId, receivedAt: turn.receivedAt, msgTs: turn.msgTs };
  }

  // Section 6.2 step 3, in order. Each failure is a drop with a logged reason.
  function authorizeReply(turn) {
    const eff = getEffective();
    const drop = (state, reason, why) => {
      log('exit_drop', { eventKey: turn.eventKey, groupKey: turn.groupKey, reason: why });
      return { eff: null, stop: { state, reason } };
    };
    if (!eff) return drop('failed', 'exit_refused', 'no_effective');
    if (eff.mode !== 'live') return drop('failed', 'exit_refused', 'not_live');
    if (store.getControl('terminal_close') !== null) return drop('failed', 'exit_refused', 'terminal');
    if (!accountOk(eff)) return drop('failed', 'exit_refused', 'account');
    if (store.getEvent(turn.eventKey)?.state !== 'dispatching') return drop('failed', 'exit_refused', 'event_state');
    if (!groupOf(eff, turn.groupId)) return drop('failed', 'exit_refused', 'not_admitted');
    const p = store.pauseState(turn.groupKey);
    if (p.global || p.group) return drop('paused', 'paused', 'paused');
    if (now() >= turn.deadlineAt) return drop('failed', 'deadline', 'deadline');
    return { eff, stop: null };
  }

  function policyHit(text, turn, eff) {
    const rawIds = [turn.groupId, turn.senderId, turn.messageId, eff.qq.appId].filter(Boolean);
    try {
      const leak = policy.checkLeak(text, { secrets: currentSecrets(), rawIds });
      if (leak.hit) return leak;
      return policy.check(text);
    } catch {
      return { hit: true, ruleId: 'check_error', category: 'error' };
    }
  }

  async function dropForPolicy(t, hit) {
    const { turn } = t;
    const at = now();
    store.bumpCounter(`policy_drop:${shanghaiDay(at)}:${hit.ruleId}:${turn.tier}`, at + 2 * 24 * HOUR);
    log('exit_policy_drop', { eventKey: turn.eventKey, groupKey: turn.groupKey, ruleId: hit.ruleId, path: turn.tier, tier: turn.tier });
    if (turn.required) {
      const fixed = await sendFixed(refOf(turn), 'policyDropped');
      log('fixed_line', { eventKey: turn.eventKey, kind: 'policyDropped', reason: fixed.reason ?? null });
    }
    return { state: 'policy_dropped', reason: hit.ruleId };
  }

  function reserveParts(turn, ref, parts, kind, eff) {
    return store.tx(() => {
      const r = insertParts(ref, kind, parts, eff);
      if (r.ok && !store.transition(turn.eventKey, 'dispatching', 'delivering')) throw new Error('event moved');
      return r;
    });
  }

  // Waits until this many parts could fit. False when that cannot happen inside the passive window.
  async function waitOutRate(turn, ref, need, eff, reason, ownerStopped) {
    const waitMs = store.sendWaitMs({ groupKey: ref.groupKey, need, rate: rateOf(eff), now: now() });
    if (!Number.isFinite(waitMs) || now() + waitMs >= turn.deadlineAt) return false;
    log('exit_wait', { eventKey: turn.eventKey, groupKey: turn.groupKey, reason, durationMs: waitMs });
    await sleepUnless(waitMs, ownerStopped);
    return true;
  }

  // The money for a required answer is already spent, so it waits for room inside the passive window.
  async function waitForRoom(turn, ref, parts, kind, firstEff, refused, ownerStopped) {
    let eff = firstEff;
    let inserted = refused;
    while (!inserted.ok) {
      if (!(await waitOutRate(turn, ref, parts.length, eff, inserted.reason, ownerStopped))) return inserted;
      if (stopped) return { ok: false, stop: refuse('exit_refused') };
      if (ownerStopped()) return { ok: false, stop: refuse('aborted') };
      const again = authorizeReply(turn);
      if (again.stop) return { ok: false, stop: again.stop };
      eff = again.eff;
      inserted = reserveParts(turn, ref, parts, kind, eff);
    }
    return inserted;
  }

  // Someone who asked hears that the answer failed, unless some of it has reached them or the owner stopped the turn.
  async function tellFailedIfNothingOut(turn, ref, ownerStopped) {
    if (!turn.required || ownerStopped()) return;
    if (store.sendsForEvent(ref.eventKey).some((s) => s.state === 'sent' || s.state === 'uncertain')) return;
    const fixed = await sendFixed(ref, 'modelFailed');
    log('fixed_line', { eventKey: turn.eventKey, kind: 'modelFailed', reason: fixed.reason ?? null });
  }

  async function refuseForRate(turn, ref, reason, ownerStopped) {
    log('exit_drop', { eventKey: turn.eventKey, groupKey: turn.groupKey, reason });
    store.addAlert('send_rate', { eventKey: turn.eventKey, groupKey: turn.groupKey, reason });
    await tellFailedIfNothingOut(turn, ref, ownerStopped);
    return refuse('send_rate');
  }

  // Why the rest of this reply must not go out, or null. The deadline comes first, so a reply that ran out of time says so.
  function partStop(turn, ref, ownerStopped) {
    if (stopped) return refuse('exit_refused');
    if (now() >= turn.deadlineAt) return refuse('deadline');
    if (ownerStopped()) return refuse('aborted');
    const why = hardStop(ref, true);
    if (!why) return null;
    log('exit_drop', { eventKey: turn.eventKey, groupKey: turn.groupKey, reason: why });
    return why === 'paused' ? { state: 'paused', reason: 'paused' } : refuse(why);
  }

  // The refused row and the rows sent before it stay on the rate, so a long reply can need room it does not have yet.
  // A required answer waits once. Whether QQ counts a refused request is not known, so the row keeps counting.
  async function reserveResend(turn, ref, parts, ownerStopped) {
    const before = partStop(turn, ref, ownerStopped);
    if (before) return { ok: false, stop: before };
    const inserted = insertParts(ref, 'reply_url_stripped', parts, getEffective());
    if (inserted.ok || !turn.required) return inserted;
    if (!(await waitOutRate(turn, ref, parts.length, getEffective(), inserted.reason, ownerStopped))) return inserted;
    const after = partStop(turn, ref, ownerStopped);
    if (after) return { ok: false, stop: after };
    return insertParts(ref, 'reply_url_stripped', parts, getEffective());
  }

  // Steps 8 and 9, with one URL-free resend for 40054010. posted collects each part that reached the group or may have:
  // sent, or uncertain. A part refused for its content, or one never sent, is not in it.
  async function deliver(turn, firstParts, kind, eff, ownerStopped, posted = []) {
    const ref = refOf(turn);
    let parts = firstParts;
    let urlsRemoved = false;
    let inserted;
    try {
      inserted = reserveParts(turn, ref, parts, kind, eff);
      if (!inserted.ok && turn.required) inserted = await waitForRoom(turn, ref, parts, kind, eff, inserted, ownerStopped);
    } catch {
      return refuse('exit_refused');
    }
    if (inserted.stop) return inserted.stop;
    if (!inserted.ok) return refuseForRate(turn, ref, inserted.reason, ownerStopped);
    let { rows } = inserted;

    for (let i = 0; i < parts.length; i += 1) {
      const halt = partStop(turn, ref, ownerStopped);
      if (halt) {
        abortRest(rows, i);
        return halt;
      }
      // Nobody asked for an interjection, and one that arrives 45 s late has missed the conversation.
      const result = await postPart(ref, rows[i], parts[i], { connectAttempts: turn.required ? SEND_CONNECT_ATTEMPTS : 1, ownerStopped });
      if (result.ok || result.action === 'continue' || result.reason === 'send_uncertain') posted.push(parts[i]);
      if (result.ok || result.action === 'continue') continue;
      abortRest(rows, i + 1);
      if (result.action === 'url_refused') {
        const stripped = parts.slice(i).map(removeUrls);
        const changed = stripped.some((p, n) => p !== parts[i + n]);
        if (urlsRemoved || !changed) {
          alertOnce('group_error', ref, { qqCode: CODE_URL_REFUSED });
          await tellFailedIfNothingOut(turn, ref, ownerStopped);
          return refuse('group_error');
        }
        urlsRemoved = true;
        const again = await reserveResend(turn, ref, stripped, ownerStopped);
        if (again.stop) return again.stop;
        if (!again.ok) return refuseForRate(turn, ref, again.reason, ownerStopped);
        parts = stripped;
        rows = again.rows;
        i = -1;
        continue;
      }
      if (result.passive && turn.required) alertOnce('passive_expired', ref);
      return refuse(result.reason);
    }
    return { state: 'completed', reason: 'sent' };
  }

  async function finishCommand(t, failed) {
    const { turn } = t;
    if (failed) {
      // The host did not confirm it, so the group is not told it happened.
      alertOnce('command_failed', refOf(turn));
      return { state: 'failed', reason: 'host_error' };
    }
    const ack = await sendAck(refOf(turn), turn.ackText);
    log('command_ack', { eventKey: turn.eventKey, reason: ack.reason ?? null });
    return { state: 'completed', reason: 'cmd_owner' };
  }

  async function finishEmpty(t, hostError) {
    const { turn } = t;
    if (!turn.required) return { state: 'silent', reason: hostError ? 'host_error' : 'no_reply' };
    const reason = hostError ? 'host_error' : 'required_no_text';
    const p = store.pauseState(turn.groupKey);
    if (p.global || p.group) return { state: 'failed', reason };
    alertOnce('model_failed', refOf(turn), { reason });
    const fixed = await sendFixed(refOf(turn), 'modelFailed');
    log('fixed_line', { eventKey: turn.eventKey, kind: 'modelFailed', reason: fixed.reason ?? null });
    return { state: 'failed', reason };
  }

  return {
    beginTurn(turn) {
      turns.set(turn.turnId, { turn, buffer: [], hostError: false });
    },

    // The host's deliver callback. It only buffers: nothing is posted until the turn has ended.
    collect(turnId, { text, isError } = {}, { kind } = {}) {
      const t = turns.get(turnId);
      if (stopped || !t) return suppressed('not_active');
      if (kind !== 'final') return suppressed('non_final');
      if (isError === true) {
        t.hostError = true;
        log('exit_drop', { eventKey: t.turn.eventKey, reason: 'host-error-text' });
        return suppressed('host_error');
      }
      const body = typeof text === 'string' ? text.trim() : '';
      if (!body || SILENT.test(body)) return suppressed('silent');
      if (t.turn.cls === 'command') return suppressed('command');
      // With no host there are no host notices: what arrives here is the model's text, and the checks below still apply.
      if (own) {
        t.buffer.push(body);
        log('exit_collect', { eventKey: t.turn.eventKey, count: t.buffer.length });
        return { messageIds: [], visibleReplySent: true };
      }
      const kept = isHostNotice(body) ? '' : withoutHostNotices(body);
      if (kept !== body) {
        t.hostError = true;
        log('exit_drop', { eventKey: t.turn.eventKey, reason: noticeLogReason(body) });
      }
      if (!kept) return suppressed('host_notice');
      t.buffer.push(kept);
      log('exit_collect', { eventKey: t.turn.eventKey, count: t.buffer.length });
      return { messageIds: [], visibleReplySent: true };
    },

    // Whether the host has handed this turn a reply that would be posted. Read-only: nothing is sent through it.
    hasReply(turnId) {
      return (turns.get(turnId)?.buffer.length ?? 0) > 0;
    },

    async finishTurn(turnId, { hostError = false, aborted = false, ownerStopped = () => false } = {}) {
      const t = turns.get(turnId);
      turns.delete(turnId);
      if (!t || stopped) return refuse('exit_refused');
      const { turn } = t;
      if (aborted) return refuse('aborted');
      const failed = hostError || t.hostError;
      if (turn.cls === 'command') return finishCommand(t, failed);
      const whole = t.buffer.join('\n\n');
      if (!whole) return finishEmpty(t, failed);

      const { eff, stop } = authorizeReply(turn);
      if (stop) return stop;

      const hit = policyHit(whole, turn, eff);
      if (hit.hit) return dropForPolicy(t, hit);

      const plain = shapeForQq(whole, turn.inboundUrls);
      if (SILENT.test(plain)) return finishEmpty(t, failed);
      // What is posted is what counts: markup inside a phrase or number hid it from the check above.
      const shapedHit = policyHit(plain, turn, eff);
      if (shapedHit.hit) return dropForPolicy(t, shapedHit);
      // Code keeps its characters when shaped, so markup there can still split a match. This form is never posted.
      const checkForm = checkFormForQq(whole, turn.inboundUrls);
      if (checkForm !== plain) {
        const checkHit = policyHit(checkForm, turn, eff);
        if (checkHit.hit) return dropForPolicy(t, checkHit);
      }

      // One reply must fit the send rate, or it could never go out at all.
      const maxParts = Math.min(eff.qq.maxPartsGroup, eff.limits.sendGroupPerMin, eff.limits.sendAccountPerMin);
      const parts = turn.required
        ? splitParts(plain, eff.qq.maxPartChars, maxParts)
        : clipToSentence(plain, Math.min(eff.qq.interjectMaxChars, eff.qq.maxPartChars));
      if (parts.length === 0) return finishEmpty(t, failed);
      if (!own) return deliver(turn, parts, 'reply', eff, ownerStopped);
      // The own runtime keeps her posted words in the group's memory ring, so the gate is told which ones went out.
      const posted = [];
      const out = await deliver(turn, parts, 'reply', eff, ownerStopped, posted);
      return posted.length > 0 ? { ...out, posted } : out;
    },

    sendFixed,

    accountOk: () => accountOk(getEffective()),

    isStopped: () => stopped,

    commandAck(ref, ackText) {
      return sendAck(ref, ackText);
    },

    // Read-only liveness probe. Nothing else is reachable through it. A failed new connection says little on a lossy
    // path, so it is tried again here: three such ticks in a row had been rebuilding working sockets every hour or two.
    async probe() {
      for (let attempt = 1; !stopped; attempt += 1) {
        try {
          await bot.api.get(PROBE_PATH);
          return true;
        } catch (err) {
          // Logged so the classifier can be seen working in the real Gateway, where the host may change the fetch stack.
          const notSent = isDefinitelyNotSent(err);
          log('liveness_probe', { state: notSent ? 'not_connected' : 'error_other', attempt, httpStatus: Number.isInteger(err?.httpStatus) ? err.httpStatus : null });
          if (!notSent || attempt >= PROBE_CONNECT_ATTEMPTS) return false;
          await sleep(CONNECT_RETRY_DELAY_MS);
        }
      }
      return false;
    },

    stop() {
      stopped = true;
      for (const wake of [...wakers]) wake();
    },
  };
}
