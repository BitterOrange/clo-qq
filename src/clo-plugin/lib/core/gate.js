// Inbound gate: everything between normalize and the host turn, in the order of design section 5.1.
// Non-admitted traffic leaves before any write or buffer. Writes commit before the effect they allow.
import { randomUUID } from 'node:crypto';
import { commandRoute, forwardAck, listedCommand, parseCommand, runLocalCommand } from './commands.js';
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
// Own runtime: how long an aborted run gets to end before its group's queue moves on without it.
const ABORT_GRACE_MS = 5000;
const ABANDONED = Symbol('abandoned');
const abortReason = (why) => new DOMException(why, 'AbortError');
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
const NO_OUTPUT = new Set(['host_error', 'required_no_text', 'aborted', 'no_reply']);
// Endings where a running turn's reply is lost to a stop: an abort, a pause, the deadline, or the exit refusing it.
// Send errors raise alerts of their own, and content refusals keep their own rules.
const REPLY_LOST = new Set(['aborted', 'paused', 'deadline', 'exit_refused']);
// Send rows that reached the group, or may have.
const MAY_BE_OUT = new Set(['sending', 'sent', 'uncertain']);
// Classes whose line gets its own decision or turn. Plain chat normally gets neither, so it stays in others' history.
const OWN_TURN_CLASSES = ['at', 'reply_bot', 'name', 'name_addressed'];
// One shared reason, so a row or log line cannot be counted as a content hit (plan: no hit record).
const STORED_REASON = { prerule: 'rule', noise: 'rule', flood: 'rule' };
const storedReason = (reason) => STORED_REASON[reason] ?? reason;
// A slash text is a command only if its first word looks like a command name, with or without an @bot or :value end.
// The host hands any other slash text to the model as plain text, and a person's words can start that way.
const COMMAND_WORD = /^\/[a-z][a-z0-9_-]*(?:[@:]\S*)?(?:\s|$)/iu;
const commandShaped = (text) => COMMAND_WORD.test(String(text ?? '').normalize('NFKC').replace(/\p{Cf}/gu, '').trim());
// Reasons a message in danger can leave its own path for the crisis route, which pays and counts apart.
const CRISIS_FALLBACK = new Set(['budget', 'decision_cap']);
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

// Ordinary messages get five sixths of each decision cap, which leaves room for names. The crisis route is counted
// against the same totals and has no cap of its own here: its own caps are the crisis ones.
function decisionCap(trigger, cap) {
  if (trigger === 'crisis_route') return undefined;
  return trigger === 'ordinary' ? Math.ceil((cap * 5) / 6) : cap;
}

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

export function createGate({ store, ledger, policy, getEffective, decide, dispatchTurn, log = () => {}, now = Date.now, timers = {}, runtime = 'openclaw' }) {
  if (runtime !== 'openclaw' && runtime !== 'own') throw new TypeError('createGate: runtime must be openclaw or own');
  const setTimer = timers.setTimer ?? setTimeout;
  const clearTimer = timers.clearTimer ?? clearTimeout;
  let exit = null;
  let stopped = false;
  let stopping = null;
  let queues = null;
  let context = null;
  let sweepTimer = null;
  let ownSweepTimer = null;
  let invalidStreak = 0;
  let arrivals = 0;
  const flights = new Map();
  // Every model turn from its start to its very end, for the shutdown grace. Held in memory only.
  const running = new Set();
  const ownerStops = new Map();
  const adhoc = new Set();
  const crisisSenders = new Map();
  const bypassSenders = new Map();
  const abort = new AbortController();
  // Which runtime this process is, fixed when it is built: the plugin is 'openclaw', the bot is 'own'. The effective
  // file can change under a running process (clo apply), and must never switch its behaviour halfway. A file that names
  // the other runtime is logged once per change; the process goes on as what it is.
  const runtimeOf = () => runtime;
  let fileRuntimeSeen = runtime;
  function noteFileRuntime(eff) {
    const named = eff?.runtime ?? 'openclaw';
    if (named === fileRuntimeSeen) return;
    fileRuntimeSeen = named;
    if (named !== runtime) log('runtime_mismatch', { process: runtime, file: named });
  }

  const contextCaps = (eff) => ({
    maxItems: eff.retention.contextMaxItems,
    maxAgeMs: eff.retention.contextMaxAgeHours * HOUR,
    maxTokens: eff.retention.contextMaxTokens,
  });

  function ensureRuntime(eff) {
    if (context) context.configure(contextCaps(eff));
    else context = createContextBuffer(contextCaps(eff));
    if (!queues) {
      queues = createGroupQueues({
        windowMs: eff.window.windowMs,
        maxPending: eff.window.maxPending,
        maxConcurrentTurns: eff.window.maxConcurrentTurns,
        // The queues' only timer is a window's, so a changed length applies from the next window that opens.
        setTimer: (fn, ms) => setTimer(fn, getEffective()?.window?.windowMs ?? ms),
        clearTimer,
        onError: () => log('gate_error', { reason: 'queue_task' }),
        onDrop: (rec) => tryQuietly(() => {
          end(rec, 'queued', 'restart_dropped', 'restart');
          if (isCrisis(rec)) alertDropped(rec);
        }),
        isUrgent: (records) => records.some(isCrisis),
        urgentKey: (rec) => rec.senderKey,
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
      const eff = getEffective();
      if (eff) context.configure(contextCaps(eff));
      const groups = Object.entries(eff?.qq?.groups ?? {});
      context.retainNames(new Set(groups.filter(([, g]) => showsNames(g)).map(([id]) => store.key(id))));
      if (context.sweep(now()) > 0) armSweep();
    }, HOUR);
    sweepTimer?.unref?.();
  }

  // Own runtime: her own lines leave the moment a group has been idle for OWN_IDLE_MS, not at the next hourly sweep.
  // One timer, set for the earliest such deadline. A turn that moved a deadline later finds it early, and it sets
  // itself again.
  function armOwnSweep() {
    if (stopped) return;
    if (ownSweepTimer) clearTimer(ownSweepTimer);
    ownSweepTimer = null;
    const due = context?.ownDeadline() ?? null;
    if (due === null) return;
    ownSweepTimer = setTimer(() => {
      ownSweepTimer = null;
      if (stopped) return;
      tryQuietly(() => {
        const held = context.ownHeld();
        context.sweep(now());
        const gone = held - context.ownHeld();
        if (gone > 0) log('own_lines_expired', { count: gone });
      });
      armOwnSweep();
    }, Math.max(due - now(), 1));
    ownSweepTimer?.unref?.();
  }

  function end(rec, from, state, reason, extra = {}) {
    const moved = store.transition(rec.eventKey, from, state, { reason, ...extra });
    log('gate_end', { eventKey: rec.eventKey, groupKey: rec.groupKey, state, reason });
    return moved;
  }

  // Danger the shutdown took with it. The next start does not pick it up.
  const alertDropped = (rec) => store.addAlert('crisis_dropped_on_stop', { eventKey: rec.eventKey, groupKey: rec.groupKey });
  // Danger with no reply and no decision that could lead to one.
  const alertRefused = (rec, reason) => store.addAlert('crisis_refused', { eventKey: rec.eventKey, groupKey: rec.groupKey, reason });
  const alertMissed = (rec, reason) => (stopped ? alertDropped(rec) : alertRefused(rec, reason));

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

  const stopControl = (groupKey) => `owner_stop:${groupKey}`;

  // The host keeps its cutoff across a restart, so the gate has to as well, or a late message older than /stop reaches it.
  function stopOf(groupKey) {
    if (ownerStops.has(groupKey)) return ownerStops.get(groupKey);
    const msgTs = Number(store.getControl(stopControl(groupKey)));
    const stop = Number.isFinite(msgTs) && msgTs > 0 ? { arrival: null, msgTs } : null;
    ownerStops.set(groupKey, stop);
    return stop;
  }

  // A text in danger is never taken for a command: no exact owner command matches the list, and a slash word
  // in front of those words must not cost the person their answer. The worst the host does with it is leave the failure line.
  // With the own runtime there is no host parser to guess at: only a listed owner command is a command.
  function commandIn(rec) {
    if (runtimeOf() === 'own') {
      const listed = listedCommand(rec.evt.text);
      return listed && !isCrisis(rec) ? listed : null;
    }
    const cmd = parseCommand(rec.evt.text);
    return cmd && commandShaped(rec.evt.text) && !isCrisis(rec) ? cmd : null;
  }

  // /stop marks every running turn of the group. With the own runtime it also aborts the run, except where a reply
  // for a person in danger has already been handed over: that one still goes out.
  function stopFlights(groupKey, own) {
    for (const flight of flights.get(groupKey) ?? []) {
      flight.aborted = true;
      // A reply the host already handed over was written before this /stop. For a person in danger it still goes out.
      flight.replyBeforeStop = exit?.hasReply?.(flight.turnId) === true;
      if (own && !(flight.replyBeforeStop && inDanger(flight.rec, flight.cls))) flight.controller.abort(abortReason('owner_stop'));
    }
  }

  function recordStop(rec) {
    store.setControl(stopControl(rec.groupKey), rec.evt.timestampMs, 'owner');
    ownerStops.set(rec.groupKey, { arrival: rec.arrival, msgTs: rec.evt.timestampMs });
  }

  // Own runtime: /new, /reset and /stop never leave the gate. The ack is the same fixed line the host path sends.
  async function runOwnCommand(rec, cmd) {
    if (cmd.name === 'new' || cmd.name === 'reset') context.clear(rec.groupKey);
    if (cmd.name === 'stop') {
      stopFlights(rec.groupKey, true);
      recordStop(rec);
    }
    const ack = await exit.commandAck(refOf(rec), forwardAck(`/${cmd.name}`));
    log('command_ack', { eventKey: rec.eventKey, reason: ack?.reason ?? null });
    return end(rec, 'received', 'completed', 'cmd_owner');
  }

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
    if (runtimeOf() === 'own') return runOwnCommand(rec, cmd);
    const authorizedCommand = `/${cmd.name}`;
    // The buffer is uploaded with the next turn, so a reset has to reach it as well as the host session.
    if (cmd.name === 'new' || cmd.name === 'reset') context.clear(rec.groupKey);
    if (cmd.name === 'stop') {
      stopFlights(rec.groupKey, false);
      recordStop(rec);
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
  // An abort after a part went out is not that case: a reply reached the group and its cost is unknown.
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
    const aborted = result.aborted === true || fin?.reason === 'aborted';
    const partSent = aborted && store.sendsForEvent(turn.eventKey).some((s) => s.state === 'sent');
    if (partSent || (!result.aborted && !result.hostError && !NO_OUTPUT.has(fin?.reason))) ledger.pausePaid('usage_missing', 'gate');
  }

  async function runTurn(rec, turn, holdId, eff) {
    const started = now();
    const own = runtime === 'own';
    // The signal belongs to the gate: /stop, gate.stop() and, with the own runtime, the turn's deadline abort it.
    const flight = { aborted: false, replyBeforeStop: false, turnId: turn.turnId, rec, cls: turn.cls, droppedOnStop: false, own, controller: new AbortController() };
    if (turn.cls !== 'command') {
      if (!flights.has(rec.groupKey)) flights.set(rec.groupKey, new Set());
      flights.get(rec.groupKey).add(flight);
      if (own) context.touch(rec.groupKey, started);
    }
    if (stopped) flight.controller.abort(abortReason('shutdown'));
    running.add(flight);
    try {
      await runFlight(rec, turn, holdId, eff, flight, started);
    } finally {
      running.delete(flight);
    }
  }

  async function runFlight(rec, turn, holdId, eff, flight, started) {
    let result;
    let fin;
    let hostRefused = false;
    // For a reply already being delivered: read while it waits for send-rate room, before each part, on a connect retry
    // and before it says it failed. One written for a person in danger still goes out.
    const ownerStopped = () => flight.aborted && !inDanger(rec, turn.cls);
    // The host may have ended its run with the whole reply while dispatchTurn still drains usage. A /stop in that gap
    // aborts nothing for a person in danger: their reply goes out as it would once delivery had begun.
    const stopAborts = () => flight.aborted && !(flight.replyBeforeStop && inDanger(rec, turn.cls));
    try {
      exit.beginTurn(turn);
      try {
        // The host path calls straight through, at the same moment it always has.
        result = flight.own ? await callDispatch(turn, flight) : await dispatchTurn(turn, { signal: flight.controller.signal });
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
          aborted: hostRefused || result?.aborted === true || stopAborts(),
          ownerStopped,
        });
      } catch {
        fin = { state: 'failed', reason: 'exit_refused' };
      }
    } finally {
      // A /stop arriving after this point finds the reply already out.
      flights.get(rec.groupKey)?.delete(flight);
    }
    if (hostRefused) fin = { state: 'skipped', reason: result.reason ?? 'ingress' };
    rec.spoke = fin?.state === 'completed' || wentOut(rec.eventKey);
    rec.contentDropped = fin?.state === 'policy_dropped' || fin?.reason === 'platform_violation';
    crashpoint('before_settle');
    settleReply(turn, holdId, result ?? { started: true, usage: null }, eff, fin);
    const state = TERMINAL.has(fin?.state) ? fin.state : 'failed';
    const reason = fin?.reason ?? (TERMINAL.has(fin?.state) ? fin.state : 'exit_refused');
    store.transition(rec.eventKey, ['dispatching', 'delivering'], state, { reason });
    log('turn_end', { eventKey: rec.eventKey, groupKey: rec.groupKey, state, reason, tier: turn.tier, durationMs: now() - started });
    if (flight.own) noteOwnTurn(rec, result, fin);
    if (hostRefused) {
      if (await noteHostRefused(rec, turn, reason, ownerStopped())) rec.spoke = true;
    } else if (inDanger(rec, turn.cls) && !flight.droppedOnStop && await noteDangerLost(rec, turn, reason, stopAborts())) {
      rec.spoke = true;
    }
  }

  // Own runtime only; the host has its own watchdog and ignores the signal. Here the gate's deadline aborts the run, and
  // a run that has not ended within the grace after any abort is left behind: its hold stays unsettled, any late text
  // finds the turn closed at the exit, and late usage still settles the hold.
  async function callDispatch(turn, flight) {
    const { signal } = flight.controller;
    let run;
    try {
      run = Promise.resolve(dispatchTurn(turn, { signal }));
    } catch (err) {
      run = Promise.reject(err);
    }
    let graceTimer = null;
    let onAbort = null;
    const abandoned = new Promise((resolve) => {
      onAbort = () => {
        graceTimer = setTimer(() => resolve(ABANDONED), ABORT_GRACE_MS);
        graceTimer?.unref?.();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    const deadline = setTimer(() => flight.controller.abort(abortReason('deadline')), Math.max(turn.deadlineAt - now(), 0));
    deadline?.unref?.();
    try {
      const outcome = await Promise.race([run, abandoned]);
      if (outcome !== ABANDONED) return outcome;
      log('turn_abandoned', { eventKey: turn.eventKey, groupKey: turn.groupKey, tier: turn.tier });
      run.then((late) => tryQuietly(() => {
        const known = usageMicros(late?.usage, getEffective()?.models?.primary?.price);
        if (known) ledger.applyLateUsage(turn.eventKey, { actualMicros: known.micros, source: known.source, model: late.usage.model });
      }), () => {});
      return { started: true, hostError: false, aborted: true, usage: null };
    } finally {
      clearTimer(deadline);
      if (graceTimer) clearTimer(graceTimer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  // Own runtime, after the turn's row is closed. The provider streak is counted here, as the host's model_call_ended
  // hook counts it on the host path: an abort says nothing about the model, and a refused start ran nothing. Only a
  // failure the runner blamed on the provider (it carries info) counts against it. A refusal, a tool call, an odd ending
  // or empty text is a failed turn the provider still answered (it reports usage), which counts as a good call, as a
  // completed call does on the host path. A failed turn with neither, such as a call cut early to keep the passive
  // window, says nothing about the provider and leaves the streak alone. Then her
  // posted words join the group's memory ring. Only parts the exit reports as sent or possibly out are kept: a reply
  // dropped for its content, one QQ refused, a fixed line and provider text never get there.
  function noteOwnTurn(rec, result, fin) {
    if (result && result.started !== false && result.aborted !== true) {
      tryQuietly(() => {
        const info = result.info && typeof result.info === 'object' ? result.info : null;
        if (result.hostError !== true) ledger.noteProviderOk();
        else if (info) ledger.noteProviderError({ httpStatus: info.status ?? null, limitSource: info.limitSource ?? null });
        else if (result.usage) ledger.noteProviderOk();
      });
    }
    const posted = Array.isArray(fin?.posted) ? fin.posted.filter((p) => typeof p === 'string' && p) : [];
    if (posted.length > 0) {
      context.pushOwn(rec.groupKey, { text: posted.join('\n'), ts: now() });
      armSweep();
      armOwnSweep();
    }
  }

  // A running turn for a person in danger that ended without its reply: an abort, a pause, the deadline or a refusal at
  // the exit. The operator always hears, and a shutdown has its own alert. A /stop is the one abort that leaves time to
  // say anything, so the person gets the failure line unless some of the reply reached them. That line alone passes the
  // hourly cap, and does not use it up. Its alert is raised once the line is settled and says whether it went out.
  // Returns whether it went out.
  async function noteDangerLost(rec, turn, reason, ownerAborted) {
    if (reason === 'exit_refused' && (stopped || exit?.isStopped?.() === true)) {
      alertDropped(rec);
      return false;
    }
    if (!REPLY_LOST.has(reason)) return false;
    if (reason !== 'aborted') {
      alertRefused(rec, reason);
      return false;
    }
    const why = ownerAborted ? 'owner_stop' : 'aborted';
    // With the own runtime gate.stop() aborts the run itself, so an abort that was not a /stop may be the shutdown.
    if (!ownerAborted && runtime === 'own') {
      alertMissed(rec, why);
      return false;
    }
    if (!ownerAborted || !turn.required || wentOut(rec.eventKey)) {
      alertRefused(rec, why);
      return false;
    }
    let fixed = null;
    try {
      fixed = await exit.sendFixed(refOf(rec), 'modelFailed', { exemptFromCap: true });
    } finally {
      const state = fixed?.sent === true ? 'line_sent' : 'line_refused';
      store.addAlert('crisis_refused', { eventKey: rec.eventKey, groupKey: rec.groupKey, reason: why, state });
    }
    log('fixed_line', { eventKey: rec.eventKey, kind: 'modelFailed', reason: fixed?.reason ?? null });
    return fixed?.sent === true;
  }

  // Read from the sends, not the turn's reason: a reply cut off after its first part, a post nobody can confirm and a
  // failure line that really went out all count, and one that was held back does not. A failed read costs at worst a
  // double answer.
  function wentOut(eventKey) {
    try {
      return store.sendsForEvent(eventKey).some((s) => MAY_BE_OUT.has(s.state));
    } catch {
      return false;
    }
  }

  // Nothing ran and nothing was said. The hold is released, and anything already spent stays spent: giving it back
  // would buy a decision for every message while the host keeps refusing. Returns whether a line went out after all.
  async function noteHostRefused(rec, turn, reason, ownerStopped) {
    const kind = reason === 'expired_before_dispatch' ? reason : 'host_refused';
    store.addAlert(kind, { eventKey: rec.eventKey, groupKey: rec.groupKey, reason });
    if (!turn.required || turn.cls === 'command' || ownerStopped) return false;
    const fixed = await exit.sendFixed(refOf(rec), 'modelFailed');
    log('fixed_line', { eventKey: rec.eventKey, kind: 'modelFailed', reason: fixed?.reason ?? null });
    return fixed?.sent === true;
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
      if (reason !== 'budget' && reason !== 'paid_paused') return;
      // The failure line has an hourly cap and tells the operator nothing, so danger raises an alert as well.
      if (inDanger(rec, cls)) alertRefused(rec, reason);
      if (plan.required && exit) {
        const fixed = await exit.sendFixed(refOf(rec), 'modelFailed');
        log('fixed_line', { eventKey: rec.eventKey, kind: 'modelFailed', reason: fixed?.reason ?? null });
      }
    };

    if (stopped) {
      if (inDanger(rec, cls)) alertDropped(rec);
      return finishRefused('restart_dropped', 'restart');
    }
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
      if (eff && !takeSenderSlot(rec, eff)) return isCrisis(rec) ? judgeOverRate(rec) : end(rec, 'queued', 'skipped', 'sender_rate');
      return approveAndRun(rec, rec.cls, 'queued');
    });
  }

  // Danger past the hourly count buys one decision on the crisis route, and is answered only if the model agrees.
  function judgeOverRate(rec) {
    const ready = readyToJudge(rec, WOULD[rec.cls]);
    if (!ready || endIfExpired(rec, ready.eff)) return undefined;
    if (!crisisRoom(rec.senderKey, now(), ready.eff)) {
      end(rec, 'queued', 'skipped', 'sender_rate');
      return alertRefused(rec, 'sender_rate');
    }
    return decideAndRun(rec, 'crisis_route', ready.eff, ready.group, 'sender_rate');
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
      if (!store.bumpCounter(`dec_group:${rec.groupKey}:${hour}`, hourExpiry(at), decisionCap(trigger, limits.decisionsPerGroupPerHour)).ok) throw new Refused('decision_cap');
      if (!store.bumpCounter(`dec_day:${day}`, dayExpiry(at), decisionCap(trigger, limits.decisionsPerDay)).ok) throw new Refused('decision_cap');
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
      // A spent tier or decision cap is no reason to miss a person in danger. The crisis route pays from its own tier,
      // on its own caps, and answers nothing but crisis.
      if (trigger !== 'crisis_route' && CRISIS_FALLBACK.has(claim.reason) && isCrisis(rec) && crisisRoom(rec.senderKey, now(), eff)) {
        return decideAndRun(rec, 'crisis_route', eff, group, claim.reason);
      }
      if (claim.reason !== 'gone') {
        end(rec, 'queued', 'skipped', claim.reason);
        if (isCrisis(rec)) alertRefused(rec, claim.reason);
      }
      return undefined;
    }
    rec.claimId = claim.value.claimId;
    crashpoint('deciding');

    const d = await askDecision(rec, trigger, eff);
    settleDecision(claim.value.holdId, d);
    noteDecisionHealth(d);
    rec.modelCrisis = d.crisis === true;
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
      end(rec, 'deciding', 'skipped', route.reason);
      // The model said danger with the caps spent, or could not answer about a line on the list. Nobody else will look.
      if (d.crisis === true || (d.invalid && isCrisis(rec))) alertMissed(rec, route.reason);
      return undefined;
    }
    if (route.next === 'crisis') {
      dropClaim(rec);
    } else if (route.next === 'interject' ? interjectionRefused(rec) : stoppedByOwner(rec)) {
      dropClaim(rec);
      end(rec, 'deciding', 'skipped', 'owner_stop');
      if (d.crisis === true) alertMissed(rec, 'owner_stop');
      return undefined;
    }
    if (route.next === 'name_addressed' && !takeSenderSlot(rec, eff)) {
      end(rec, 'deciding', 'skipped', 'sender_rate');
      // Past the crisis caps a reply and a skip are the same verdict, and nobody else will look at either.
      if (d.crisis === true) alertMissed(rec, 'sender_rate');
      return undefined;
    }
    return approveAndRun(rec, route.next, 'deciding');
  }

  function isCrisis(rec) {
    try {
      return policy.isCrisisRoute(rec.evt.text);
    } catch {
      return false;
    }
  }

  // A turn on the crisis route, a line the model called danger past the caps, or a line on the list.
  const inDanger = (rec, cls) => cls === 'crisis' || rec.modelCrisis === true || isCrisis(rec);

  // The host refuses any turn older than /stop, and the exit would then post the failure line. A person in danger
  // still gets that line, which says where to find help; anyone else has been told the replying stopped, or the
  // operator has been told that they were not.
  const olderThanStop = (rec) => {
    const stop = stopOf(rec.groupKey);
    if (!stop) return false;
    // Arrival order ends with the process. After a restart only the message time is left, and a message from the same
    // whole second may be newer, so it is not counted as older.
    return stop.arrival === null ? rec.evt.timestampMs < stop.msgTs : rec.arrival < stop.arrival;
  };

  // An interjection has no such line, and a refused one would only pause paid work, so it stops either way. The host
  // compares timestamps, and QQ's are whole seconds: arriving after /stop does not save one from the same second, or one
  // sent before it and delivered late. Nobody is owed an interjection, so this drops no question.
  const interjectionRefused = (rec) => olderThanStop(rec) || rec.evt.timestampMs <= stopOf(rec.groupKey)?.msgTs;

  // With the host, a message from the same second as /stop reaches it and meets its cutoff. The own runtime has no host,
  // so the gate applies the same rule itself: the same second is not newer, and is skipped. Words of danger still go on.
  function stoppedByOwner(rec) {
    const notNewer = runtimeOf() === 'own' ? interjectionRefused(rec) : olderThanStop(rec);
    return notNewer && !isCrisis(rec);
  }

  // Everything is read here and now: queued work may have waited behind several turns. Null means the event has ended.
  function readyToJudge(rec, wouldReason) {
    const eff = getEffective();
    const group = stillAdmitted(eff, rec.evt.conversationId);
    const stop = (state, reason) => {
      end(rec, 'queued', state, reason);
      return null;
    };
    if (!eff || !group) return stop('ignored', 'admission');
    const pause = store.pauseState(rec.groupKey);
    if (pause.global || pause.group || pause.terminal) return stop('paused', 'paused');
    if (eff.mode !== 'live') return stop('dry_run', wouldReason);
    if (exitRefuses()) return stop('failed', 'exit_refused');
    return { eff, group, pause };
  }

  function endIfExpired(rec, eff) {
    if (now() - rec.receivedAt <= eff.window.dispatchDeadlineMs) return false;
    store.addAlert('expired_before_dispatch', { eventKey: rec.eventKey, groupKey: rec.groupKey });
    end(rec, 'queued', 'skipped', 'expired_before_dispatch');
    return true;
  }

  function judgeName(rec, windowCount) {
    return guarded(rec, async () => {
      const ready = readyToJudge(rec, WOULD.name);
      if (!ready) return undefined;
      const { eff, group } = ready;
      // With the switch off a name is ordinary, and an ordinary message in danger is still looked at.
      if (!group.nameMention) return isCrisis(rec) ? judgeCrisis(rec, windowCount) : end(rec, 'queued', 'skipped', 'name_off');
      if (stoppedByOwner(rec)) return end(rec, 'queued', 'skipped', 'owner_stop');
      if (endIfExpired(rec, eff)) return undefined;
      const at = now();
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

  // Yielding, so a real @ arriving later is still not held behind them. Danger does not yield, and has a little room of
  // its own. A sender over their share of that room is still refused with the alert: this line may be the one that matters.
  function queueJudged(rec, task, refuse = refuseFull) {
    const danger = isCrisis(rec);
    const lane = queues.addressed(rec.groupKey, task, rec, { urgent: danger, yielding: !danger });
    if (lane.ok) return;
    if (lane.reason === 'stopped') {
      end(rec, 'queued', 'restart_dropped', 'restart');
      if (danger) alertDropped(rec);
    } else {
      refuse(rec);
    }
  }

  // No alert: the same person's later line is judged either way, and raises its own if it finds no room.
  const refuseFolded = (rec) => end(rec, 'queued', 'skipped', 'queue_full');

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
      if (endIfExpired(rep, ctx.eff)) return undefined;
      const rule = ruleFor(rep, ctx);
      if (rule.ok) return interjectionRefused(rep) && !isCrisis(rep) ? end(rep, 'queued', 'skipped', 'owner_stop') : decideAndRun(rep, 'ordinary', ctx.eff, ctx.group);
      if (rescue) return decideAndRun(rep, 'crisis_route', ctx.eff, ctx.group, storedReason(rule.reason));
      return end(rep, 'queued', 'skipped', storedReason(rule.reason));
    });
  }

  // A second person in danger from the same window, read fresh once the lane reaches them.
  function judgeCrisis(rec, windowCount) {
    return guarded(rec, async () => {
      const ready = readyToJudge(rec, 'would_window');
      if (!ready) return undefined;
      const ctx = { ...ready, at: now(), windowCount };
      return runWindowRep(rec, ctx, isRescued(rec, ctx));
    });
  }

  // Queued behind the line that speaks for it, so that line's fate is known by now. If its turn said nothing, the name
  // message is judged itself. The exception is a reply a content check refused: a second turn on the same words would be
  // another try at it, so that stays closed, and the operator hears if the person heard nothing.
  function judgeFolded(rec, later, windowCount) {
    if (!later.spoke && !later.contentDropped) return judgeName(rec, windowCount);
    return guarded(rec, async () => {
      end(rec, 'queued', 'merged', 'merged', { mergedInto: later.eventKey });
      if (!later.spoke) alertRefused(rec, 'reply_dropped');
    });
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
      // Only if that line's turn says something, so each such name message stays open until then, outside the cap of names.
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
      for (const r of folded) queueJudged(r, () => judgeFolded(r, laterLine(r), records.length), refuseFolded);
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
    const rec = { evt, eventKey, groupKey, senderKey: store.key(evt.senderId), receivedAt, arrival: arrivals, cls: null, prerule: false, claimId: null, displayName: null, spoke: false, contentDropped: false, modelCrisis: false, heldBack: [] };

    await guarded(rec, async () => {
      ensureRuntime(eff);
      logReplyRef(evt, eventKey, groupKey);
      const stale = staleReason(evt, receivedAt, eff.window);
      if (stale) return end(rec, 'received', 'stale', stale);

      const cmd = commandIn(rec);
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
        ? queues.addressed(groupKey, () => runAddressed(rec), rec, { urgent: isCrisis(rec) })
        : queues.ordinary(groupKey, rec, flushWindow);
      if (lane.ok) return undefined;
      if (lane.reason !== 'stopped') return refuseFull(rec);
      end(rec, 'queued', 'skipped', 'restart');
      if (isCrisis(rec)) alertDropped(rec);
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
      if (eff) noteFileRuntime(eff);
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
      for (const flight of running) flight.controller.abort(abortReason('shutdown'));
      if (sweepTimer) clearTimer(sweepTimer);
      sweepTimer = null;
      if (ownSweepTimer) clearTimer(ownSweepTimer);
      ownSweepTimer = null;
      const done = (async () => {
        if (queues) await queues.stop();
        await Promise.allSettled([...adhoc]);
      })();
      // Whatever is still running past the grace ends after the store has closed, where its own alert cannot be written.
      // A person in danger among them is reported now, once, and their turn raises nothing more when it ends.
      const reportOutlasting = () => {
        for (const flight of running) {
          if (flight.droppedOnStop || !inDanger(flight.rec, flight.cls)) continue;
          flight.droppedOnStop = true;
          tryQuietly(() => alertDropped(flight.rec));
        }
      };
      stopping = new Promise((resolve) => {
        const grace = setTimer(() => {
          reportOutlasting();
          resolve();
        }, STOP_GRACE_MS);
        grace?.unref?.();
        done.finally(() => {
          clearTimer(grace);
          reportOutlasting();
          resolve();
        });
      });
      return stopping;
    },
  };
}
