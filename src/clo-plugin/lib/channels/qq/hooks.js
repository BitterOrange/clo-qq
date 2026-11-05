// Host hooks and usage settlement. Hooks carry no text out of the host: only whitelisted log fields.
import { checkSentinels } from '../../core/contentPolicy.js';
import { usageMicros } from '../../core/gate.js';
import { TOOL_NAME } from './tools.js';

const MAX_TOOL_ROUNDS = 2;
const DRAIN_WAIT_MS = 2000;
const DRAIN_STEP_MS = 50;
const USAGE_OWNER = Symbol.for('clo.usage.owner');
// How long usage arriving after a turn closed is still booked to that turn.
const LATE_USAGE_MS = 15 * 60000;

const sessionId = (key) => String(key ?? '').toLowerCase();
const wait = (ms) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  t.unref?.();
});

function addUsage(target, evt) {
  const u = evt.usage ?? {};
  target.input += u.input ?? 0;
  target.output += u.output ?? 0;
  target.cacheRead += u.cacheRead ?? 0;
  target.cacheWrite += u.cacheWrite ?? 0;
  if (typeof evt.costUsd === 'number') target.costUsd = (target.costUsd ?? 0) + evt.costUsd;
  if (evt.model) target.model = evt.model;
}

const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null, model: null });

// Diagnostic listeners are process-wide and a replaced plugin generation may not have unsubscribed yet.
// Only the newest tracker in this process acts, so one model.usage is never counted twice.
export function createUsageTracker({ onInternalDiagnosticEvent, waitDrained = async () => {}, ledger, log = () => {}, price = () => null, drainWaitMs = DRAIN_WAIT_MS, now = Date.now, lateUsageMs = LATE_USAGE_MS }) {
  const openTurns = new Map();
  const byTurn = new Map();
  const closedTurns = new Map();
  const owner = {};
  globalThis[USAGE_OWNER] = owner;

  function lateUsage(evt) {
    const seen = emptyUsage();
    addUsage(seen, evt);
    const known = usageMicros(seen, price());
    if (!known) {
      log('usage_ignored', { model: seen.model });
      return;
    }
    const closed = closedTurns.get(sessionId(evt.sessionKey));
    const eventKey = closed && now() - closed.at <= lateUsageMs ? closed.eventKey : null;
    ledger.applyLateUsage(eventKey, { actualMicros: known.micros, source: known.source, model: seen.model });
    log(eventKey ? 'usage_late' : 'usage_unattributed', { eventKey, actualMicros: known.micros, source: known.source, model: seen.model });
  }

  const off = onInternalDiagnosticEvent((evt) => {
    if (globalThis[USAGE_OWNER] !== owner || evt?.type !== 'model.usage') return;
    try {
      const entry = openTurns.get(sessionId(evt.sessionKey));
      if (entry) {
        entry.usage ??= emptyUsage();
        addUsage(entry.usage, evt);
      } else {
        lateUsage(evt);
      }
    } catch {
      log('usage_error', {});
    }
  }, { include: ['model.usage'] });

  return {
    open(sessionKey, turn) {
      const entry = { turn, key: sessionId(sessionKey), usage: null, rounds: 0, toolHolds: [] };
      openTurns.set(entry.key, entry);
      byTurn.set(turn.turnId, entry);
      return entry;
    },
    turnFor(sessionKey) {
      return openTurns.get(sessionId(sessionKey)) ?? null;
    },
    // Waits for the host's event to arrive. Tool holds end with the turn: the reply settlement pays for them.
    async close(turnId) {
      const entry = byTurn.get(turnId);
      if (!entry) return null;
      const deadline = Date.now() + drainWaitMs;
      for (;;) {
        await waitDrained();
        if (entry.usage || Date.now() >= deadline) break;
        await wait(DRAIN_STEP_MS);
      }
      byTurn.delete(turnId);
      if (openTurns.get(entry.key) === entry) openTurns.delete(entry.key);
      closedTurns.set(entry.key, { eventKey: entry.turn.eventKey, at: now() });
      // Numbers only. Q5 reads these: on the Gateway path the host gives no other token breakdown.
      if (entry.usage) {
        const { input, output, cacheRead, cacheWrite, model } = entry.usage;
        log('turn_usage', { eventKey: entry.turn.eventKey, inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, model });
      }
      for (const id of entry.toolHolds) {
        if (entry.usage) ledger.release(id);
        else ledger.markUnsettled(id);
      }
      return entry.usage;
    },
    stop() {
      off?.();
      if (globalThis[USAGE_OWNER] === owner) delete globalThis[USAGE_OWNER];
    },
  };
}

export function registerHooks(api, { getServices }) {
  api.on('before_prompt_build', () => {
    const s = getServices();
    if (s.getEffective()?.privacy?.replaceSystemPrompt !== true) return undefined;
    const systemPrompt = s.systemPrompt();
    if (!systemPrompt) {
      s.log('prompt_replace', { state: 'unreadable' });
      return undefined;
    }
    return { systemPrompt };
  });

  // A failure in this handler blocks the run: the host fails closed (read in the hook reference).
  api.on('before_agent_run', (event) => {
    const s = getServices();
    const version = s.getEffective()?.contentPolicy?.version;
    const result = version ? checkSentinels(event?.systemPrompt, version) : { ok: false, reason: 'no-effective' };
    if (result.ok) return { outcome: 'pass' };
    s.store.addAlert('policy_sentinel', { reason: result.reason });
    s.log('policy_sentinel', { reason: result.reason });
    return { outcome: 'block', reason: 'content-policy-check' };
  });

  api.on('before_tool_call', (event, ctx) => {
    const s = getServices();
    if (event?.toolName !== TOOL_NAME) {
      s.log('tool_blocked', { reason: 'not_allowed' });
      return { block: true, blockReason: 'tool not available' };
    }
    const entry = s.usage?.turnFor(ctx?.sessionKey);
    if (!entry) return { block: true, blockReason: 'no active turn' };
    if (entry.rounds >= MAX_TOOL_ROUNDS) return { block: true, blockReason: 'tool round limit' };
    const r = s.ledger.reserve({
      tier: entry.turn.tier,
      category: 'tool_round',
      heldMicros: s.ledger.holdMicros('tool_round'),
      eventKey: entry.turn.eventKey,
      model: s.getEffective()?.models?.primary?.id ?? null,
    });
    if (!r.ok) return { block: true, blockReason: 'budget' };
    entry.rounds += 1;
    entry.toolHolds.push(r.id);
    return undefined;
  });

  api.on('model_call_ended', (event) => {
    const s = getServices();
    s.log('model_call_ended', {
      model: typeof event?.model === 'string' ? event.model : null,
      state: event?.outcome ?? null,
      reason: typeof event?.errorCategory === 'string' ? event.errorCategory : null,
      kind: event?.failureKind ?? null,
      durationMs: event?.durationMs ?? null,
    });
    // No status here: errorCategory is only a JS class name and failureKind only transport (host 2026.10.9).
    // An exhausted Key shows up as this streak until the next Key read names it.
    if (event?.outcome === 'completed') s.ledger.noteProviderOk();
    else if (event?.outcome === 'error' && event?.failureKind !== 'aborted') s.ledger.noteProviderError({});
  });
}
