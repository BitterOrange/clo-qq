// Inbound gate: everything between normalize and the host turn, in the order of design section 5.1.
// Non-admitted traffic leaves before any write or buffer. Writes commit before the effect they allow.
import { randomUUID } from 'node:crypto';
import { commandRoute, forwardAck, parseCommand, runLocalCommand } from './commands.js';
import { createContextBuffer } from './context.js';
import { namePattern, routeDecision, shapeCurrentText } from './decision.js';
import { checkDisplayName, speakerLabel } from './displayName.js';
import { crashpoint, hourBucket, isQuietHours, shanghaiDay } from './ids.js';
import { refShape } from './log.js';
import { CRISIS_ELIGIBLE, evaluateOrdinary, extractUrls, pickRepresentative, selectNameRecords } from './rules.js';
import { createGroupQueues } from './window.js';

const HOUR = 3600000;
const PASSIVE_WINDOW_MS = 285000;
const INTERJECT_LEASE_MS = 120000;
const STOP_GRACE_MS = 5000;
const INVALID_STREAK_ALERT = 5;
const NON_TERMINAL = ['received', 'queued', 'deciding', 'approved', 'dispatching', 'delivering'];
const TERMINAL = new Set(['ignored', 'stale', 'merged', 'paused', 'dry_run', 'skipped', 'completed', 'silent',
  'policy_dropped', 'failed', 'restart_dropped', 'crash_unknown']);

const REPLY_PLANS = {
  at: { tier: 'addressed', hold: 'reply_required', required: true },
  reply_bot: { tier: 'addressed', hold: 'reply_required', required: true },
  crisis: { tier: 'addressed', hold: 'reply_required', required: true },
  name_addressed: { tier: 'named', hold: 'reply_required', required: true },
  interject: { tier: 'interject', hold: 'reply_optional', required: false },
};
const DECISION_TIERS = { ordinary: 'interject', name: 'named', crisis_route: 'addressed' };
const NO_OUTPUT = new Set(['host_error', 'required_no_text', 'aborted']);
// Classes whose line gets its own decision or turn. Plain chat normally gets neither, so it stays in others' history.
const OWN_TURN_CLASSES = ['at', 'reply_bot', 'name', 'name_addressed'];
// One shared reason, so a row or log line cannot be counted as a content hit (plan: no hit record).
const STORED_REASON = { prerule: 'rule', noise: 'rule', flood: 'rule' };
const storedReason = (reason) => STORED_REASON[reason] ?? reason;
const WOULD = { at: 'would_at', reply_bot: 'would_reply_bot', name: 'would_name', crisis: 'would_window', name_addressed: 'would_name', interject: 'would_window' };

class Refused extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function attempt(store, fn) {
  try {
    return { ok: true, value: store.tx(fn) };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, reason: err.reason };
    throw err;
  }
}

const groupOf = (eff, id) => (eff?.qq?.groups && Object.hasOwn(eff.qq.groups, id) ? eff.qq.groups[id] : null);
// For work that waited: QQ switched off since then counts the same as the group coming off the list.
const stillAdmitted = (eff, id) => (eff?.qq?.enabled ? groupOf(eff, id) : null);
const showsNames = (group) => group?.displayNames === true;

function mentionsName(text, names) {
  const hay = String(text ?? '').normalize('NFKC');
  return (names ?? []).some((raw) => namePattern(raw)?.test(hay) === true);
}

// hasBotRef takes the raw refMsgIdx. Priority: at, reply_bot, name, ordinary.
export function classify(evt, { hasBotRef, names }) {
  const ambiguous = evt.ambiguousMention === true;
  if (evt.isRealAt === true) return { cls: 'at', ambiguous };
  if (evt.refMsgIdx !== null && evt.refMsgIdx !== undefined && hasBotRef(evt.refMsgIdx)) return { cls: 'reply_bot', ambiguous };
  if (evt.hasUserText && mentionsName(evt.text, names)) return { cls: 'name', ambiguous };
  return { cls: 'ordinary', ambiguous };
}

function admissionDrop(evt, eff, store, exit) {
  if (!eff) return 'no_effective';
  if (!eff.qq?.enabled) return 'qq_disabled';
  if (store.getControl('terminal_close') !== null) return 'terminal';
  if (exit?.accountOk?.() === false) return 'account';
  if (evt.kind !== 'group') return 'dm_closed';
  if (!evt.messageId || !evt.conversationId || !evt.senderId) return 'no_identity';
  if (evt.senderIsBot) return 'bot';
  if (!groupOf(eff, evt.conversationId)) return 'not_admitted';
  return null;
}

function staleReason(evt, receivedAt, { staleMs, futureSkewMs }) {
  const ts = evt.timestampMs;
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return 'no_timestamp';
  if (receivedAt - ts > staleMs) return 'old';
  if (ts - receivedAt > futureSkewMs) return 'future';
  return null;
}

const interjectLimits = (group) => ({
  cooldownMs: group.cooldownMinutes * 60000,
  perHour: group.perHour,
  perDay: group.perDay,
  leaseMs: INTERJECT_LEASE_MS,
});

const hourExpiry = (at) => (hourBucket(at) + 2) * HOUR;
const dayExpiry = (at) => at + 2 * 24 * HOUR;

// Costs come from the host's figure. Tokens at the locked price are the fallback. Zero is never free.
export function usageMicros(usage, price) {
  if (!usage) return null;
  if (typeof usage.costUsd === 'number' && usage.costUsd > 0) return { micros: Math.ceil(usage.costUsd * 1e6), source: 'model.usage' };
  const tokens = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  if (tokens <= 0 || !price) return null;
  const micros = (usage.input ?? 0) * price.inputPerM + (usage.output ?? 0) * price.outputPerM
    + (usage.cacheRead ?? 0) * (price.cacheReadPerM ?? price.inputPerM) + (usage.cacheWrite ?? 0) * (price.cacheWritePerM ?? price.inputPerM);
  return micros > 0 ? { micros: Math.ceil(micros), source: 'computed' } : null;
}

export function createGate({ store, ledger, policy, getEffective, decide, dispatchTurn, log = () => {}, now = Date.now, timers = {} }) {
  const setTimer = timers.setTimer ?? setTimeout;
  const clearTimer = timers.clearTimer ?? clearTimeout;
  let exit = null;
  let stopped = false;
  let stopping = null;
  let queues = null;
  let context = null;
  let sweepTimer = null;
  let invalidStreak = 0;
  let arrivals = 0;
  const flights = new Map();
  const ownerStops = new Map();
  const adhoc = new Set();
  const crisisSenders = new Map();
  const bypassSenders = new Map();
  const abort = new AbortController();

  function ensureRuntime(eff) {
    if (!context) {
      context = createContextBuffer({
        maxItems: eff.retention.contextMaxItems,
        maxAgeMs: eff.retention.contextMaxAgeHours * HOUR,
        maxTokens: eff.retention.contextMaxTokens,
      });
    }
    if (!queues) {
      queues = createGroupQueues({
        windowMs: eff.window.windowMs,
        maxPending: eff.window.maxPending,
        maxConcurrentTurns: eff.window.maxConcurrentTurns,
        setTimer,
        clearTimer,
        onError: () => log('gate_error', { reason: 'queue_task' }),
        onDrop: (rec) => tryQuietly(() => end(rec, 'queued', 'restart_dropped', 'restart')),
        isUrgent: (records) => records.some(isCrisis),
      });
    }
  }

  function tryQuietly(fn) {
    try {
      return fn();
    } catch {
      log('gate_error', { reason: 'cleanup' });
      return undefined;
    }
  }

  function armSweep() {
    if (sweepTimer || stopped) return;
    sweepTimer = setTimer(() => {
      sweepTimer = null;
      if (stopped) return;
      const groups = Object.entries(getEffective()?.qq?.groups ?? {});
      context.retainNames(new Set(groups.filter(([, g]) => showsNames(g)).map(([id]) => store.key(id))));
      if (context.sweep(now()) > 0) armSweep();
    }, HOUR);
    sweepTimer?.unref?.();
  }

  function end(rec, from, state, reason, extra = {}) {
    const moved = store.transition(rec.eventKey, from, state, { reason, ...extra });
    log('gate_end', { eventKey: rec.eventKey, groupKey: rec.groupKey, state, reason });
    return moved;
  }

  const refOf = (rec) => ({
    eventKey: rec.eventKey,
    groupKey: rec.groupKey,
    groupId: rec.evt.conversationId,
    messageId: rec.evt.messageId,
    receivedAt: rec.receivedAt,
    msgTs: rec.evt.timestampMs,
  });

  function dropClaim(rec) {
    if (rec.claimId) store.releaseInterject(rec.claimId);
    rec.claimId = null;
  }

  // Anything escaping a step ends the event rather than leaving it open. Held money stays counted.
  async function guarded(rec, fn) {
    try {
      await fn();
      return true;
    } catch (err) {
      log('gate_error', { eventKey: rec.eventKey, groupKey: rec.groupKey, reason: 'exception', kind: String(err?.name ?? 'Error').slice(0, 32) });
      tryQuietly(() => {
        store.q("UPDATE reservations SET status='unsettled' WHERE event_key=? AND status='held'").run(rec.eventKey);
        dropClaim(rec);
        store.transition(rec.eventKey, NON_TERMINAL, 'failed', { reason: 'gate_error' });
        store.addAlert('gate_error', { eventKey: rec.eventKey });
      });
      return false;
    }
  }

  // ---- owner commands ----

  async function handleCommand(rec, cmd, eff, group) {
    store.setClass(rec.eventKey, 'command');
    if (!group.ownerMemberIds?.includes(rec.evt.senderId)) return end(rec, 'received', 'ignored', 'cmd_non_owner');
    if (eff.mode !== 'live') return end(rec, 'received', 'dry_run', 'would_cmd');
    const route = commandRoute(cmd);
    if (route === 'unknown') return end(rec, 'received', 'ignored', 'cmd_unknown');
    if (!exit) return end(rec, 'received', 'failed', 'exit_refused');
    if (route === 'local') {
      const { ackText } = runLocalCommand(cmd, { store, group, groupKey: rec.groupKey, effective: eff });
      const ack = await exit.commandAck(refOf(rec), ackText);
      log('command_ack', { eventKey: rec.eventKey, reason: ack?.reason ?? null });
      return end(rec, 'received', 'completed', 'cmd_owner');
    }
    const authorizedCommand = `/${cmd.name}`;
    // The buffer is uploaded with the next turn, so a reset has to reach it as well as the host session.
    if (cmd.name === 'new' || cmd.name === 'reset') context.clear(rec.groupKey);
    if (cmd.name === 'stop') {
      for (const flight of flights.get(rec.groupKey) ?? []) flight.aborted = true;
      ownerStops.set(rec.groupKey, { arrival: rec.arrival, msgTs: rec.evt.timestampMs });
    }
    if (!store.transition(rec.eventKey, 'received', 'dispatching')) return undefined;
    crashpoint('dispatching');
    const turn = buildTurn(rec, { cls: 'command', tier: 'none', required: true, authorizedCommand, history: [], holdId: null });
    turn.ackText = forwardAck(authorizedCommand);
    return runTurn(rec, turn, null, eff);
  }

  // ---- turns ----

  function readDisplayName(raw, rec, eff) {
    const { evt } = rec;
    const { name, reason } = checkDisplayName(raw, { policy, names: eff.names, rawIds: [evt.conversationId, evt.senderId, evt.messageId, eff.qq?.appId].filter(Boolean) });
    // One shared reason, so a line cannot be read as a content hit against a member. The value is never logged.
    if (!name) log('display_name', { eventKey: rec.eventKey, reason: reason === 'absent' ? 'absent' : 'rejected' });
    return name;
  }

  function buildTurn(rec, { cls, tier, required, authorizedCommand = null, history, holdId, speaker = null }) {
    const { evt } = rec;
    return {
      turnId: randomUUID(),
      eventKey: rec.eventKey,
      groupKey: rec.groupKey,
      groupId: evt.conversationId,
      messageId: evt.messageId,
      senderId: evt.senderId,
      senderLabel: authorizedCommand ? null : context.pseudonym(rec.groupKey, rec.senderKey),
      speakerLabel: speaker,
      cls,
      tier,
      required,
      authorizedCommand,
      text: authorizedCommand ?? evt.text,
      history,
      inboundUrls: authorizedCommand ? [] : extractUrls(evt.text),
      replyReservationId: holdId,
      interjectLogId: rec.claimId ?? null,
      receivedAt: rec.receivedAt,
      msgTs: evt.timestampMs,
      deadlineAt: Math.min(evt.timestampMs ?? rec.receivedAt, rec.receivedAt) + PASSIVE_WINDOW_MS,
    };
  }

  // fin is how the turn ended. A turn that produced nothing because the provider or an abort stopped it
  // leaves its hold unsettled, and only the failure streak pauses paid work (plan: repeated failures).
  function settleReply(turn, holdId, result, eff, fin) {
    if (!holdId) {
      const known = usageMicros(result.usage, eff?.models?.primary?.price);
      if (known) ledger.applyLateUsage(turn.eventKey, { actualMicros: known.micros, source: known.source, model: result.usage.model });
      return;
    }
    if (result.started === false) {
      ledger.release(holdId);
      return;
    }
    const known = usageMicros(result.usage, eff?.models?.primary?.price);
    if (known) {
      ledger.settle(holdId, { actualMicros: known.micros, source: known.source, model: result.usage.model });
      return;
    }
    log('settle_missing', { eventKey: turn.eventKey, tier: turn.tier });
    // False means a late usage event has already settled it.
    if (!ledger.markUnsettled(holdId)) return;
    if (!result.aborted && !result.hostError && !NO_OUTPUT.has(fin?.reason)) ledger.pausePaid('usage_missing', 'gate');
  }

  async function runTurn(rec, turn, holdId, eff) {
    const started = now();
    const flight = { aborted: false };
    if (turn.cls !== 'command') {
      if (!flights.has(rec.groupKey)) flights.set(rec.groupKey, new Set());
      flights.get(rec.groupKey).add(flight);
    }
    let result;
    let fin;
    let hostRefused = false;
    try {
      exit.beginTurn(turn);
      try {
        result = await dispatchTurn(turn);
      } catch {
        // Whether the model ran is unknown, so settlement treats it as having run.
        log('dispatch_error', { eventKey: rec.eventKey });
        result = { started: true, hostError: true, aborted: false, usage: null };
      }
      hostRefused = result?.started === false;
      try {
        fin = await exit.finishTurn(turn.turnId, {
          hostError: !hostRefused && result?.hostError === true,
          // A turn the host refused has nothing to send. This also clears it from the exit.
          aborted: hostRefused || result?.aborted === true || flight.aborted,
          // For a reply still waiting for send-rate room. One written for a person in danger still goes out.
          ownerStopped: () => flight.aborted && turn.cls !== 'crisis' && !isCrisis(rec),
        });
      } catch {
        fin = { state: 'failed', reason: 'exit_refused' };
      }
    } finally {
      // A /stop arriving after this point finds the reply already out.
      flights.get(rec.groupKey)?.delete(flight);
    }
    if (hostRefused) fin = { state: 'skipped', reason: result.reason ?? 'ingress' };
    crashpoint('before_settle');
    settleReply(turn, holdId, result ?? { started: true, usage: null }, eff, fin);
    const state = TERMINAL.has(fin?.state) ? fin.state : 'failed';
    const reason = fin?.reason ?? (TERMINAL.has(fin?.state) ? fin.state : 'exit_refused');
    store.transition(rec.eventKey, ['dispatching', 'delivering'], state, { reason });
    log('turn_end', { eventKey: rec.eventKey, groupKey: rec.groupKey, state, reason, tier: turn.tier, durationMs: now() - started });
  }

  // G14's refusal. Work that waited reads it too, so no decision is bought for a turn G14 would refuse.
  const exitRefuses = () => !exit || exit.accountOk?.() === false;

  // A line with its own decision or turn still to come stays out of this turn's history, or the group sees it answered
  // twice. So does a line merged into such a line, which that turn speaks for, and no other. Each comes back when that
  // event ends, merged or skipped included. A row older than the dispatch deadline can get no turn any more, so one stuck
  // open hides nothing for long. The same person's earlier lines stay in, even at the cost of a double answer: a reply to
  // someone in danger, or an @ saying "that one above", must not be written without the words just before it.
  // This runs with a hold taken, so a failed read costs at worst a double answer, never the turn.
  function hiddenLines(rec, eff) {
    try {
      const since = now() - eff.window.dispatchDeadlineMs;
      const hide = new Set(store.openEventKeys(rec.groupKey, OWN_TURN_CLASSES, since));
      for (const { eventKey, mergedInto } of store.mergedIntoOpen(rec.groupKey, OWN_TURN_CLASSES, since)) {
        if (mergedInto !== rec.eventKey) hide.add(eventKey);
      }
      for (const key of context.ownEarlier(rec.groupKey, rec.senderKey, rec.arrival)) hide.delete(key);
      for (const key of rec.heldBack) hide.add(key);
      return hide;
    } catch (err) {
      log('history_hide_error', { eventKey: rec.eventKey, groupKey: rec.groupKey, kind: String(err?.name ?? 'Error').slice(0, 32) });
      return new Set();
    }
  }

  // G14, G15, G16. rec.claimId is the interject claim, if any.
  async function approveAndRun(rec, cls, from) {
    const plan = REPLY_PLANS[cls];
    const finishRefused = async (state, reason) => {
      dropClaim(rec);
      end(rec, from, state, reason);
      if (plan.required && exit && (reason === 'budget' || reason === 'paid_paused')) {
        const fixed = await exit.sendFixed(refOf(rec), 'modelFailed');
        log('fixed_line', { eventKey: rec.eventKey, kind: 'modelFailed', reason: fixed?.reason ?? null });
      }
    };

    if (stopped) return finishRefused('restart_dropped', 'restart');
    const eff = getEffective();
    if (!eff) return finishRefused('skipped', 'no_effective');
    if (!stillAdmitted(eff, rec.evt.conversationId)) return finishRefused('ignored', 'admission');
    if (eff.mode !== 'live') return finishRefused('dry_run', WOULD[cls]);
    if (exitRefuses()) return finishRefused('failed', 'exit_refused');
    const at = now();
    if (at - rec.receivedAt > eff.window.dispatchDeadlineMs) {
      store.addAlert('expired_before_dispatch', { eventKey: rec.eventKey, groupKey: rec.groupKey });
      return finishRefused('skipped', 'expired_before_dispatch');
    }
    let heldMicros;
    try {
      heldMicros = ledger.holdMicros(plan.hold);
    } catch {
      return finishRefused('skipped', 'budget');
    }

    const approved = attempt(store, () => {
      const p = store.pauseState(rec.groupKey);
      if (p.global || p.group || p.terminal) throw new Refused('paused');
      if (cls === 'interject' && p.interject) throw new Refused('interject_latch');
      const r = ledger.reserve({ tier: plan.tier, category: 'reply', heldMicros, eventKey: rec.eventKey, model: eff.models.primary.id });
      if (!r.ok) throw new Refused(r.reason === 'paid_paused' ? 'paid_paused' : 'budget');
      if (!store.transition(rec.eventKey, from, 'approved')) throw new Refused('gone');
      // Crisis stays a routing state: its class is not kept on the row.
      if (cls !== 'crisis') store.setClass(rec.eventKey, cls);
      return r.id;
    });
    if (!approved.ok) {
      if (approved.reason === 'gone') return dropClaim(rec);
      return finishRefused(approved.reason === 'paused' ? 'paused' : 'skipped', approved.reason);
    }
    const holdId = approved.value;
    crashpoint('approved');

    const dispatching = attempt(store, () => {
      if (!store.transition(rec.eventKey, 'approved', 'dispatching')) throw new Refused('gone');
      if (rec.claimId && !store.consumeInterject(rec.claimId, now())) throw new Refused('inflight');
    });
    if (!dispatching.ok) {
      ledger.release(holdId);
      dropClaim(rec);
      if (dispatching.reason !== 'gone') end(rec, 'approved', 'skipped', dispatching.reason);
      return undefined;
    }
    crashpoint('dispatching');

    // Read from the effective just checked above, so a switch turned off while this waited counts.
    const showNames = showsNames(groupOf(eff, rec.evt.conversationId));
    const code = context.pseudonym(rec.groupKey, rec.senderKey);
    const displayName = showNames ? rec.displayName : null;
    const hide = hiddenLines(rec, eff);
    const turn = buildTurn(rec, {
      cls, tier: plan.tier, required: plan.required, holdId,
      history: showNames
        ? context.history(rec.groupKey, rec.eventKey, now(), { showNames: true, current: { sender: code, displayName }, hide })
        : context.history(rec.groupKey, rec.eventKey, now(), { hide }),
      speaker: displayName ? speakerLabel(code, displayName) : null,
    });
    return runTurn(rec, turn, holdId, eff);
  }

  // ---- addressed lane ----

  // One count per person per hour, shared by @, reply-to-bot and named replies.
  const senderCounter = (rec, at) => `sender_addr:${rec.senderKey}:${hourBucket(at)}`;

  function takeSenderSlot(rec, eff) {
    const at = now();
    return store.bumpCounter(senderCounter(rec, at), hourExpiry(at), eff.limits.perSenderAddressedPerHour).ok;
  }

  function runAddressed(rec) {
    return guarded(rec, async () => {
      if (stoppedByOwner(rec)) return end(rec, 'queued', 'skipped', 'owner_stop');
      const eff = getEffective();
      if (eff && !takeSenderSlot(rec, eff)) return end(rec, 'queued', 'skipped', 'sender_rate');
      return approveAndRun(rec, rec.cls, 'queued');
    });
  }

  // ---- window lane ----

  function crisisRoom(senderKey, at, eff, senders = crisisSenders) {
    const cutoff = at - HOUR;
    if (senders.size > 1000) {
      for (const [k, list] of senders) {
        if (list.every((t) => t <= cutoff)) senders.delete(k);
      }
    }
    const list = (senders.get(senderKey) ?? []).filter((t) => t > cutoff);
    if (list.length === 0) senders.delete(senderKey);
    else senders.set(senderKey, list);
    return list.length < eff.limits.crisisRoutePerSenderPerHour;
  }

  function noteCrisis(senderKey, at, senders = crisisSenders) {
    senders.set(senderKey, [...(senders.get(senderKey) ?? []), at]);
  }

  const crisisGroupKey = (rec, at) => `crisis_group:${rec.groupKey}:${shanghaiDay(at)}`;

  function bumpCrisisGroup(rec, at, eff) {
    return store.bumpCounter(crisisGroupKey(rec, at), dayExpiry(at), eff.limits.crisisRoutePerGroupPerDay).ok;
  }

  // Danger past a failing decision model. Most of these will fail, so they are counted apart, the same size:
  // the crisis caps are only read here, and are still whole for the person who needs a reply after the outage.
  // With those spent no answer could reach a crisis reply, so nothing is bought.
  function takeBypass(rec, at, eff) {
    const { crisisRoutePerGroupPerDay: perDay } = eff.limits;
    if (!crisisRoom(rec.senderKey, at, eff) || store.peekCounter(crisisGroupKey(rec, at)) >= perDay) return false;
    if (!crisisRoom(rec.senderKey, at, eff, bypassSenders)) return false;
    return store.bumpCounter(`decision_bypass:${rec.groupKey}:${shanghaiDay(at)}`, dayExpiry(at), perDay).ok;
  }

  // G12: claim, caps and hold commit together, or none of them do.
  function claimDecision(rec, trigger, eff, group, crisisRefusal) {
    let heldMicros;
    try {
      heldMicros = ledger.holdMicros('decision');
    } catch {
      return { ok: false, reason: 'budget' };
    }
    const at = now();
    const hour = hourBucket(at);
    const day = shanghaiDay(at);
    const { limits } = eff;
    const claimed = attempt(store, () => {
      const bypassed = trigger !== 'crisis_route' && !ledger.admitDecision();
      if (bypassed && (!isCrisis(rec) || !takeBypass(rec, at, eff))) throw new Refused('decision_paused');
      let claimId = null;
      if (trigger === 'ordinary') {
        const c = store.claimInterject({ groupKey: rec.groupKey, eventKey: rec.eventKey, limits: interjectLimits(group), now: at });
        if (!c.ok) throw new Refused(c.reason);
        claimId = c.id;
      }
      if (trigger === 'name' && !store.bumpCounter(`name_dec:${rec.groupKey}:${hour}`, hourExpiry(at), limits.nameDecisionsPerGroupPerHour).ok) throw new Refused('decision_cap');
      if (trigger === 'crisis_route' && !bumpCrisisGroup(rec, at, eff)) throw new Refused(crisisRefusal);
      if (!store.bumpCounter(`dec_group:${rec.groupKey}:${hour}`, hourExpiry(at), limits.decisionsPerGroupPerHour).ok) throw new Refused('decision_cap');
      if (!store.bumpCounter(`dec_day:${day}`, dayExpiry(at), limits.decisionsPerDay).ok) throw new Refused('decision_cap');
      const r = ledger.reserve({ tier: DECISION_TIERS[trigger], category: 'decision', heldMicros, eventKey: rec.eventKey, model: eff.models.decision.id });
      if (!r.ok) throw new Refused(r.reason === 'paid_paused' ? 'paid_paused' : 'budget');
      if (!store.transition(rec.eventKey, 'queued', 'deciding')) throw new Refused('gone');
      return { claimId, holdId: r.id, bypassed };
    });
    if (claimed.ok && trigger === 'crisis_route') noteCrisis(rec.senderKey, at);
    if (claimed.ok && claimed.value.bypassed) noteCrisis(rec.senderKey, at, bypassSenders);
    return claimed;
  }

  function settleDecision(holdId, d) {
    if (d.paid === false) {
      ledger.release(holdId);
    } else if (d.actualMicros) {
      ledger.settle(holdId, { actualMicros: d.actualMicros, source: 'usage.cost', model: d.model });
    } else {
      ledger.markUnsettled(holdId);
    }
  }

  function noteDecisionHealth(d) {
    // Our own stop cancelled it, which says nothing about the model.
    if (d.invalid === 'timeout' && abort.signal.aborted) return;
    if (d.invalid === 'http' || d.invalid === 'timeout') {
      ledger.noteDecisionError({ httpStatus: d.httpStatus, limitSource: d.limitSource });
    } else if (d.paid !== false) {
      ledger.noteDecisionOk();
    }
    if (d.invalid && d.paid !== false) {
      invalidStreak += 1;
      if (invalidStreak === INVALID_STREAK_ALERT) store.addAlert('decision_invalid_streak', { count: invalidStreak });
    } else if (!d.invalid) {
      invalidStreak = 0;
    }
  }

  function crisisSpan(rec) {
    try {
      return policy.lastCrisisSpan(rec.evt.text);
    } catch {
      return null;
    }
  }

  async function askDecision(rec, trigger, eff) {
    const at = now();
    const lines = context.lines(rec.groupKey, rec.eventKey, eff.retention.decisionLines, eff.retention.decisionLineChars, at);
    const current = { sender: context.pseudonym(rec.groupKey, rec.senderKey), text: shapeCurrentText(eff, rec.evt.text, crisisSpan(rec)) };
    try {
      return await decide({ trigger, lines, current, signal: abort.signal });
    } catch {
      return { action: 'skip', skipClass: 'none', crisis: false, invalid: 'http', paid: true, actualMicros: null, model: null, httpStatus: null, limitSource: null };
    }
  }

  async function decideAndRun(rec, trigger, eff, group, crisisRefusal) {
    const claim = claimDecision(rec, trigger, eff, group, crisisRefusal);
    if (!claim.ok) {
      // A spent interjection tier is no reason to miss a person in danger. The crisis route pays from its own tier,
      // on its own caps, and answers nothing but crisis.
      if (trigger === 'ordinary' && claim.reason === 'budget' && isCrisis(rec) && crisisRoom(rec.senderKey, now(), eff)) {
        return decideAndRun(rec, 'crisis_route', eff, group, 'budget');
      }
      if (claim.reason !== 'gone') end(rec, 'queued', 'skipped', claim.reason);
      return undefined;
    }
    rec.decided = true;
    rec.claimId = claim.value.claimId;
    crashpoint('deciding');

    const d = await askDecision(rec, trigger, eff);
    settleDecision(claim.value.holdId, d);
    noteDecisionHealth(d);
    const route = routeDecision(trigger, d, {
      takeCrisisCap: () => {
        const at = now();
        if (!crisisRoom(rec.senderKey, at, eff) || !bumpCrisisGroup(rec, at, eff)) return false;
        noteCrisis(rec.senderKey, at);
        return true;
      },
    });
    if (route.next === 'skip') {
      // Only here: a crisis reply on a flagged topic leaves no class count.
      if (!d.invalid && d.skipClass !== 'none') {
        const at = now();
        store.bumpCounter(`skip_class:${shanghaiDay(at)}`, dayExpiry(at));
      }
      dropClaim(rec);
      return end(rec, 'deciding', 'skipped', route.reason);
    }
    if (route.next === 'crisis') {
      dropClaim(rec);
    } else if (route.next === 'interject' ? interjectionRefused(rec) : stoppedByOwner(rec)) {
      dropClaim(rec);
      return end(rec, 'deciding', 'skipped', 'owner_stop');
    }
    if (route.next === 'name_addressed' && !takeSenderSlot(rec, eff)) return end(rec, 'deciding', 'skipped', 'sender_rate');
    return approveAndRun(rec, route.next, 'deciding');
  }

  function isCrisis(rec) {
    try {
      return policy.isCrisisRoute(rec.evt.text);
    } catch {
      return false;
    }
  }

  // The host refuses any turn older than /stop, and the exit would then post the failure line. A person in danger
  // still gets that line, which says where to find help; anyone else has been told the replying stopped, or the
  // operator has been told that they were not.
  const olderThanStop = (rec) => rec.arrival < (ownerStops.get(rec.groupKey)?.arrival ?? 0);

  // An interjection has no such line, and a refused one would only pause paid work, so it stops either way. The host
  // compares timestamps, and QQ's are whole seconds: arriving after /stop does not save one from the same second, or one
  // sent before it and delivered late. Nobody is owed an interjection, so this drops no question.
  const interjectionRefused = (rec) => olderThanStop(rec) || rec.evt.timestampMs <= ownerStops.get(rec.groupKey)?.msgTs;

  function stoppedByOwner(rec) {
    return olderThanStop(rec) && !isCrisis(rec);
  }

  // Everything is read here and now: a queued name may have waited behind several turns.
  function judgeName(rec, windowCount) {
    return guarded(rec, async () => {
      const eff = getEffective();
      const group = stillAdmitted(eff, rec.evt.conversationId);
      if (!eff || !group) return end(rec, 'queued', 'ignored', 'admission');
      const p = store.pauseState(rec.groupKey);
      if (p.global || p.group || p.terminal) return end(rec, 'queued', 'paused', 'paused');
      if (eff.mode !== 'live') return end(rec, 'queued', 'dry_run', WOULD.name);
      if (exitRefuses()) return end(rec, 'queued', 'failed', 'exit_refused');
      // With the switch off a name is ordinary, and an ordinary message in danger is still looked at.
      if (!group.nameMention) return isCrisis(rec) ? judgeCrisis(rec, windowCount) : end(rec, 'queued', 'skipped', 'name_off');
      if (stoppedByOwner(rec)) return end(rec, 'queued', 'skipped', 'owner_stop');
      const at = now();
      if (at - rec.receivedAt > eff.window.dispatchDeadlineMs) {
        store.addAlert('expired_before_dispatch', { eventKey: rec.eventKey, groupKey: rec.groupKey });
        return end(rec, 'queued', 'skipped', 'expired_before_dispatch');
      }
      // No decision is bought for someone already at their limit, unless the words suggest danger.
      if (!isCrisis(rec) && store.peekCounter(senderCounter(rec, at)) >= eff.limits.perSenderAddressedPerHour) {
        return end(rec, 'queued', 'skipped', 'sender_rate');
      }
      return decideAndRun(rec, 'name', eff, group);
    });
  }

  // Danger that even its own room could not take is a person missed, and the owner should hear of it.
  function refuseFull(rec) {
    const moved = end(rec, 'queued', 'skipped', 'queue_full');
    if (isCrisis(rec)) store.addAlert('crisis_queue_full', { eventKey: rec.eventKey, groupKey: rec.groupKey });
    return moved;
  }

  // Yielding, so a real @ arriving later is still not held behind them. Danger does not yield.
  function queueJudged(rec, task) {
    const lane = queues.addressed(rec.groupKey, task, rec, { yielding: !isCrisis(rec) });
    if (lane.ok) return;
    if (lane.reason === 'stopped') end(rec, 'queued', 'restart_dropped', 'restart');
    else refuseFull(rec);
  }

  const ruleFor = (r, { eff, group, pause, at, windowCount }) => evaluateOrdinary({
    group,
    evt: r.evt,
    prerule: r.prerule,
    quiet: isQuietHours(at, eff.quietHours),
    interjectPeek: store.peekInterject({ groupKey: r.groupKey, limits: interjectLimits(group), now: at }),
    pause,
    windowCount,
    limits: eff.limits,
    now: at,
  });

  // Whether the crisis list may lift a message over the rules that would keep it quiet.
  function isRescued(r, ctx) {
    if (!isCrisis(r) || !crisisRoom(r.senderKey, ctx.at, ctx.eff)) return false;
    const rule = ruleFor(r, ctx);
    return rule.ok || CRISIS_ELIGIBLE.has(rule.reason);
  }

  function runWindowRep(rep, ctx, rescue) {
    return guarded(rep, async () => {
      if (ctx.at - rep.receivedAt > ctx.eff.window.dispatchDeadlineMs) {
        store.addAlert('expired_before_dispatch', { eventKey: rep.eventKey, groupKey: rep.groupKey });
        return end(rep, 'queued', 'skipped', 'expired_before_dispatch');
      }
      const rule = ruleFor(rep, ctx);
      if (rule.ok) return interjectionRefused(rep) && !isCrisis(rep) ? end(rep, 'queued', 'skipped', 'owner_stop') : decideAndRun(rep, 'ordinary', ctx.eff, ctx.group);
      if (rescue) return decideAndRun(rep, 'crisis_route', ctx.eff, ctx.group, storedReason(rule.reason));
      return end(rep, 'queued', 'skipped', storedReason(rule.reason));
    });
  }

  // A second person in danger from the same window, read fresh once the lane reaches them.
  function judgeCrisis(rec, windowCount) {
    return guarded(rec, async () => {
      const eff = getEffective();
      const group = stillAdmitted(eff, rec.evt.conversationId);
      if (!eff || !group) return end(rec, 'queued', 'ignored', 'admission');
      const pause = store.pauseState(rec.groupKey);
      if (pause.global || pause.group || pause.terminal) return end(rec, 'queued', 'paused', 'paused');
      if (eff.mode !== 'live') return end(rec, 'queued', 'dry_run', 'would_window');
      if (exitRefuses()) return end(rec, 'queued', 'failed', 'exit_refused');
      const ctx = { eff, group, pause, at: now(), windowCount };
      return runWindowRep(rec, ctx, isRescued(rec, ctx));
    });
  }

  // Queued behind the line that speaks for it, so that line's fate is known by now. If it got no decision, nothing spoke.
  function judgeFolded(rec, later, windowCount) {
    if (!later.decided) return judgeName(rec, windowCount);
    return guarded(rec, async () => end(rec, 'queued', 'merged', 'merged', { mergedInto: later.eventKey }));
  }

  async function flushWindow(arrived) {
    const first = arrived[0];
    const clean = await guarded(first, async () => {
      const eff = getEffective();
      const group = stillAdmitted(eff, first.evt.conversationId);
      const endAll = (state, reason, list = arrived) => {
        for (const r of list) end(r, 'queued', state, reason);
      };
      if (!eff || !group) return endAll('ignored', 'admission');
      const p = store.pauseState(first.groupKey);
      if (p.global || p.group || p.terminal) return endAll('paused', 'paused');
      if (eff.mode !== 'live') return endAll('dry_run', 'would_window');
      if (exitRefuses()) return endAll('failed', 'exit_refused');
      // A name from before /stop ends here. As lead it would take with it what was said after the stop.
      const stoppedName = (r) => group.nameMention && r.cls === 'name' && stoppedByOwner(r);
      endAll('skipped', 'owner_stop', arrived.filter(stoppedName));
      const records = arrived.filter((r) => !stoppedName(r));
      const plain = pickRepresentative(records, eff.limits);
      if (!plain) return endAll('skipped', storedReason('noise'), records);
      const ctx = { eff, group, pause: p, at: now(), windowCount: records.length };
      // A person in danger must not lose to whoever else spoke in the same 4 seconds. One turn per person:
      // each one's last such message speaks for the earlier ones.
      const lastCrisis = new Map(records.filter(isCrisis).map((r) => [r.senderKey, r]));
      const crises = records.filter((r) => lastCrisis.get(r.senderKey) === r);
      const rescued = crises.filter((r) => isRescued(r, ctx));
      // A person's later danger line speaks for their earlier one even if that one said her name: one turn, one cap slot.
      const laterLine = (r) => (isCrisis(r) ? rescued.find((c) => c !== r && c.senderKey === r.senderKey) : undefined);
      const selected = group.nameMention ? selectNameRecords(records.filter((r) => !laterLine(r)), eff.limits) : [];
      // Only if that line gets its decision, so each such name message stays open until then, outside the cap of names.
      const folded = group.nameMention ? selectNameRecords(records.filter(laterLine), { nameWindowMax: records.length }) : [];
      // A name message in danger the rules cannot rescue is still a name message, so the window cap does not push it
      // out, nor does a later word from the same person. The decision caps still count it.
      const named = selected.length === 0 ? [] : records.filter((r) => selected.includes(r) || (r.cls === 'name' && crises.includes(r) && !rescued.includes(r)));
      const elsewhere = rescued.filter((r) => !named.includes(r));
      const lead = rescued.at(-1) ?? named.find(isCrisis) ?? named[0] ?? plain;
      // Crisis is not kept on the row, so a danger line of plain class still waiting cannot be told from chat there.
      // These run in this order, so each turn holds back the lines queued behind it.
      const dangerOrder = [lead, ...elsewhere.filter((r) => r !== lead)];
      dangerOrder.forEach((r, i) => {
        r.heldBack = dangerOrder.slice(i + 1).map((w) => w.eventKey);
      });
      const follow = (r) => (isCrisis(r) && rescued.find((c) => c.senderKey === r.senderKey))
        || selected.find((n) => n.senderKey === r.senderKey)
        || selected.at(-1)
        || lead;
      for (const r of records) {
        if (r !== lead && !named.includes(r) && !elsewhere.includes(r) && !folded.includes(r)) end(r, 'queued', 'merged', 'merged', { mergedInto: follow(r).eventKey });
      }

      // This flush holds the group for one turn, the most urgent. Whatever else has a question waits in the lane.
      // A folded line goes after every line that can speak for it: those are rescued, so here or among the named in danger.
      const queueNames = (list) => {
        for (const r of list) if (r !== lead) queueJudged(r, () => judgeName(r, records.length));
      };
      for (const r of elsewhere) if (r !== lead) queueJudged(r, () => judgeCrisis(r, records.length));
      queueNames(named.filter(isCrisis));
      for (const r of folded) queueJudged(r, () => judgeFolded(r, laterLine(r), records.length));
      queueNames(named.filter((n) => !isCrisis(n)));
      return named.includes(lead) ? judgeName(lead, records.length) : runWindowRep(lead, ctx, rescued.includes(lead));
    });
    if (!clean) {
      for (const r of arrived) tryQuietly(() => store.transition(r.eventKey, 'queued', 'failed', { reason: 'gate_error' }));
    }
  }

  // ---- dry-run ----

  function dryRunReason(rec, eff, group) {
    if (rec.cls === 'at' || rec.cls === 'reply_bot') return WOULD[rec.cls];
    if (rec.cls === 'name') {
      const key = `name_dec:${rec.groupKey}:${hourBucket(now())}`;
      return store.peekCounter(key) < eff.limits.nameDecisionsPerGroupPerHour ? 'would_name' : 'decision_cap';
    }
    const at = now();
    const rule = evaluateOrdinary({
      group,
      evt: rec.evt,
      prerule: rec.prerule,
      quiet: isQuietHours(at, eff.quietHours),
      interjectPeek: store.peekInterject({ groupKey: rec.groupKey, limits: interjectLimits(group), now: at }),
      pause: store.pauseState(rec.groupKey),
      windowCount: 1,
      limits: eff.limits,
      now: at,
    });
    return rule.ok ? 'would_window' : storedReason(rule.reason);
  }

  // ---- entry ----

  // A log line only. A quote of a human's message is unmatched too, and classify never looks the ref up for a real @.
  function logReplyRef(evt, eventKey, groupKey) {
    const idx = evt.refMsgIdx;
    if (typeof idx !== 'string' || !idx) return;
    const refKey = store.key(idx);
    log('reply_ref', { eventKey, groupKey, state: store.hasBotRef(refKey, groupKey) ? 'matched' : 'unmatched', refKey, ...refShape(idx) });
  }

  async function admit(evt, eff) {
    const group = groupOf(eff, evt.conversationId);
    // The unchecked name goes no further than the event: only what the sanitizer returns is kept, on rec.
    const rawName = evt.displayNameRaw;
    delete evt.displayNameRaw;
    const receivedAt = evt.receivedAt ?? now();
    const eventKey = store.key(evt.messageId);
    const groupKey = store.key(evt.conversationId);
    // Whatever this event turns out to be: a command, a stale or paused message must not leave old names for a later "on".
    if (!showsNames(group)) context?.forgetNames(groupKey);
    const claim = store.claimEvent({ eventKey, groupKey, msgTs: evt.timestampMs ?? null, receivedAt });
    if (!claim.fresh) {
      log('gate_dup', { eventKey, state: claim.state });
      return;
    }
    crashpoint('after_claim');
    store.setControl('last_event_at', receivedAt, 'gate');
    arrivals += 1;
    const rec = { evt, eventKey, groupKey, senderKey: store.key(evt.senderId), receivedAt, arrival: arrivals, cls: null, prerule: false, claimId: null, displayName: null, decided: false, heldBack: [] };

    await guarded(rec, async () => {
      ensureRuntime(eff);
      logReplyRef(evt, eventKey, groupKey);
      const stale = staleReason(evt, receivedAt, eff.window);
      if (stale) return end(rec, 'received', 'stale', stale);

      const cmd = parseCommand(evt.text);
      if (cmd) return handleCommand(rec, cmd, eff, group);

      const { cls, ambiguous } = classify(evt, {
        hasBotRef: (idx) => store.hasBotRef(store.key(idx), groupKey),
        names: eff.names,
      });
      if (ambiguous) log('ambiguous_mention', { eventKey, groupKey });
      rec.cls = cls === 'name' && !group.nameMention ? 'ordinary' : cls;
      store.setClass(eventKey, rec.cls);

      try {
        rec.prerule = policy.check(evt.text).hit === true;
      } catch {
        rec.prerule = true;
      }
      // Before the buffer: what was said while paused, or before live and its notice, is never uploaded later.
      const p = store.pauseState(groupKey);
      if (p.global || p.group) return end(rec, 'received', 'paused', 'paused');
      if (eff.mode !== 'live') return end(rec, 'received', 'dry_run', dryRunReason(rec, eff, group));

      if (showsNames(group)) rec.displayName = readDisplayName(rawName, rec, eff);

      if (!rec.prerule && evt.hasUserText) {
        context.push(groupKey, { senderKey: rec.senderKey, text: evt.text, ts: evt.timestampMs, eventKey, displayName: rec.displayName, arrival: rec.arrival });
        armSweep();
      }

      store.transition(eventKey, 'received', 'queued');
      const lane = rec.cls === 'at' || rec.cls === 'reply_bot'
        ? queues.addressed(groupKey, () => runAddressed(rec), rec)
        : queues.ordinary(groupKey, rec, flushWindow);
      if (!lane.ok) return lane.reason === 'stopped' ? end(rec, 'queued', 'skipped', 'restart') : refuseFull(rec);
      return undefined;
    });
  }

  return {
    attachExit(next) {
      exit = next;
    },

    async onInbound(evt) {
      if (stopped || !evt) return;
      const eff = getEffective();
      if (eff?.mode === 'dry-run' && evt.kind === 'group' && evt.conversationId && !evt.senderIsBot) {
        tryQuietly(() => store.recordDiscovery({ groupId: evt.conversationId, memberId: evt.senderId, now: now() }));
      }
      const drop = admissionDrop(evt, eff, store, exit);
      if (drop) {
        // A group taken off the list is off, and adding it back must not bring its old names with it.
        if (drop === 'not_admitted') context?.forgetNames(store.key(evt.conversationId));
        log('gate_drop', { reason: drop });
        return;
      }
      const work = admit(evt, eff);
      adhoc.add(work);
      try {
        await work;
      } finally {
        adhoc.delete(work);
      }
    },

    async idle() {
      for (;;) {
        await Promise.allSettled([...adhoc]);
        if (queues) await queues.idle();
        if (adhoc.size === 0) return;
      }
    },

    stop() {
      if (stopping) return stopping;
      stopped = true;
      abort.abort();
      if (sweepTimer) clearTimer(sweepTimer);
      sweepTimer = null;
      const done = (async () => {
        if (queues) await queues.stop();
        await Promise.allSettled([...adhoc]);
      })();
      stopping = new Promise((resolve) => {
        const grace = setTimer(resolve, STOP_GRACE_MS);
        grace?.unref?.();
        done.finally(() => {
          clearTimer(grace);
          resolve();
        });
      });
      return stopping;
    },
  };
}
