// Budget ledger. Money is integer micro-USD. Every reservation commits before the money is spent.
import { randomUUID } from 'node:crypto';
import { shanghaiDay, shanghaiDayStart, utcDay } from './ids.js';
import { callWorstMicros } from './models.js';
import {
  ANTHROPIC_LIMIT_SOURCES, HARD_CAP_PAUSE, LIVE_CODES, OPENROUTER_LIMIT_SOURCES, OWNER_CLEARED_PROVIDER_PAUSES,
  PROVIDER_KINDS, hardCapControlKey, hardCapPauseKey, providerOfEffective,
} from './providers/registry.js';
import { pauseRank } from './store.js';
import { searchWorstMicros } from './providers/cost.js';
import {
  SEARCH_HOLD_INPUT_TOKENS, SEARCH_OWNER_CLEARS, SEARCH_PAUSE_KEY, SEARCH_PAUSE_REASONS, SEARCH_ROW_PROVIDER, SEARCH_TIER,
  searchDayCounter, searchEventCounter, searchOfEffective, searchPauseRank,
} from './providers/searchRegistry.js';

const KEY_TIMEOUT_MS = 8000;
const TICK_MS = 60000;
const CONNECTED_READ_MS = 10 * 60000;
const REBASE_AFTER_MS = 30 * 24 * 3600000;
const DAY_MS = 24 * 3600000;
const BASELINE_META = 'key_baseline';
const KEY_LIMIT_SEEN = 'key_limit_seen';
const RESIDUAL_COUNT = 'residual_over';
const STREAK_KEY = 'provider_fail_streak';
const STREAK_TTL_MS = 7 * 24 * 3600000;
const DECISION_STREAK_KEY = 'decision_fail_streak';
const DECISION_BREAKER = 'decision_paused';
const DECISION_RETRY_MS = 10 * 60000;
const LIMIT_SOURCES = new Set(OPENROUTER_LIMIT_SOURCES);
// They pause under their own names, and only while an Anthropic Key is the one spending.
const ANTHROPIC_LIMITS = new Set(ANTHROPIC_LIMIT_SOURCES);
// No Key read can lift these: usage_unavailable waits for a person to look, and credits for a person to top up.
const OWNER_CLEARS = new Set(['usage_unavailable', 'openrouter_credits']);
// A provider whose Key cannot be read has nothing that could lift its pauses but the owner (decisions D3 to D5).
const OWNER_CLEARS_PROVIDER = new Set(OWNER_CLEARED_PROVIDER_PAUSES);
const HARD_CAP_CODES = new Set([LIVE_CODES.hardCap, LIVE_CODES.providerRules]);
const CREDITS_PROBE = 'credits_probe';
const CLEAR_ON_CLEAN_READ = new Set(['key_read_failed', 'residual', 'provider_fail', 'openrouter_key_limit']);
const CLEAR_WHEN_SETTLED = new Set(['crash_unsettled', 'usage_missing']);
// A Key read says nothing about credits, so this pause clears only after a wait. If credits are still out, a
// decision's 402 pauses again at once, and primary calls, whose failures carry no status, after one failure streak
// with no paid success since. Either way with a fresh time: bounded to one round per wait. Whether a failed call
// costs money has not been observed, so its hold stays counted until something settles it.
const CREDITS_RETRY_MS = 3600000;
// After this long with paid work able to run and no paid success, a failure streak says nothing about those credits:
// it is provider_fail again. A pause cannot age the probe. Its control value is the absolute expiry while paid work can
// run, and f<ms left> during a pause, so a lift gives back exactly what was left. Lifting a credits pause gives a full life.
const CREDITS_PROBE_TTL_MS = 24 * 3600000;
// A row with no usage is cleared after this long with this many clean Key reads. The delay is provisional:
// the real reporting lag has not been measured (Q5). Budget fields can override both.
const UNSETTLED_CLEAR_MS = 15 * 60000;
const UNSETTLED_CLEAR_READS = 3;
// estimateTokens of the largest decision input: prompt + 15 lines of 200 + current of 800, all characters JSON writes
// as \uXXXX, which the body escapes twice: about 10240. Nothing strips them on the way in. fix2-decision.test.mjs holds this
// to it. What a model really spends on them has not been measured; settling counts the real cost.
export const DECISION_INPUT_TOKENS = 10500;
// The same measure for the search request (own runtime, search on in the group): the base prompt with the search
// addendum, and the larger schema. search-decision.test.mjs holds this to it.
export const SEARCH_DECISION_INPUT_TOKENS = 11500;

export const usdToMicros = (usd) => Math.round(usd * 1e6);

// Search (docs/search-contract.md section 7). The search Key's daily limit is search's only hard cap; these are local.
const SEARCH_STREAK_KEY = 'search_fail_streak';
const SEARCH_RETRY_MS = 10 * 60000;
const SEARCH_RESIDUAL_COUNT = 'search_residual_over';
const SEARCH_KEY_LIMIT_SEEN = 'search_key_limit_seen';
const SEARCH_LIFTED_BY_READ = new Set(['key_limit', 'residual', 'key_read_failed']);
// What a search row settles at when no figure came for it: its hold, never less (decision D3).
const SEARCH_HOLD_SOURCE = 'search_hold';
const searchDayExpiry = (at) => shanghaiDayStart(at) + 2 * DAY_MS;

class SearchRefused extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

// One primary call at its worst. The own runtime marks the system block for caching, and which part of the input that
// is goes unmeasured here, so all of it is priced at the dearer of the input and cache-write rates. It makes no hidden
// second call, so a required turn holds one call. With the host a required turn holds two: it calls again on NO_REPLY.
export function replyHoldMicros(kind, primary, runtime = 'openclaw') {
  if (kind !== 'reply_required' && kind !== 'reply_optional' && kind !== 'tool_round') throw new TypeError(`ledger.holdMicros: unknown kind ${kind}`);
  if (runtime !== 'own') return (kind === 'reply_required' ? 2 : 1) * callWorstMicros(primary.price, primary);
  const { price } = primary;
  if (!price) throw new Error('callWorstMicros: price is not locked');
  const inputPerM = Math.max(price.inputPerM, price.cacheWritePerM ?? price.inputPerM);
  return Math.ceil(primary.contextTokens * inputPerM + primary.maxTokens * price.outputPerM);
}

function microsOf(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? usdToMicros(n) : null;
}

// getProvider(eff) gives the provider entry that spends under that effective file (registry shape), or null when none
// can be named. Its caps decide whether the Key can be read at all: an Anthropic Key is never sent to OpenRouter's /key.
// Each call resolves the provider once, from the very eff it uses, so one call never mixes two reads of the file. On the
// own runtime an unreadable file names no provider: the implicit OpenRouter entry would read and pause on the wrong Key.
// getSearchKey: the search Key, on the own runtime with search on only. It is never the chat Key, and it is read only
// against the search block's own base.
export function createLedger({ store, getEffective, fetch = globalThis.fetch, getKey, getSearchKey = () => null, log = () => {}, now = Date.now, setTimer = setInterval, clearTimer = clearInterval, runtime = 'openclaw', getProvider = (eff) => (eff == null && runtime === 'own' ? null : providerOfEffective(eff)) }) {
  if (runtime !== 'openclaw' && runtime !== 'own') throw new TypeError('createLedger: runtime must be openclaw or own');
  const { q } = store;
  const provider = (eff) => {
    try {
      return getProvider(eff) ?? null;
    } catch {
      return null;
    }
  };
  // No provider means nothing can be sent, and nothing is read either.
  const keyReadable = (p) => p?.caps?.keyReadable === true;
  // What reservations.provider holds: the kind, or NULL for the implicit OpenRouter entry.
  const providerColumn = (p) => (p.implicit ? null : p.kind);
  // The rows the OpenRouter Key figure can speak for.
  const OPENROUTER_ROWS = "(provider IS NULL OR provider='openrouter')";
  let keyFailures = 0;
  let searchKeyFailures = 0;
  let searchStarted = false;
  let lastSearchReadAt = 0;
  let timer = null;
  let liveStarted = false;
  let lastReadAt = 0;

  function localMicros(day) {
    return q(`SELECT COALESCE(SUM(CASE status WHEN 'settled' THEN actual_micros WHEN 'released' THEN 0 ELSE held_micros END), 0) AS m
              FROM reservations WHERE local_day=?`).get(day).m;
  }

  // Lifetime usage now, minus lifetime usage at the start of the Shanghai day.
  function providerMicros(at) {
    const latest = q('SELECT usage_micros AS u FROM key_snapshots ORDER BY taken_at DESC LIMIT 1').get();
    if (!latest) return 0;
    const dayStart = shanghaiDayStart(at);
    const base = q('SELECT usage_micros AS u FROM key_snapshots WHERE taken_at<=? ORDER BY taken_at DESC LIMIT 1').get(dayStart)
      ?? q('SELECT usage_micros AS u FROM key_snapshots WHERE taken_at>? ORDER BY taken_at ASC LIMIT 1').get(dayStart);
    return Math.max(0, latest.u - base.u);
  }

  function spent(at = now()) {
    const day = shanghaiDay(at);
    const local = localMicros(day);
    const provider = providerMicros(at);
    const tiers = store.spendByTier(day);
    const unsettled = q("SELECT COUNT(*) AS n, COALESCE(SUM(held_micros), 0) AS m FROM reservations WHERE status='unsettled'").get();
    return {
      effectiveMicros: Math.max(local, provider),
      localMicros: local,
      providerMicros: provider,
      byTier: { interject: tiers.interject, named: tiers.named, addressed: tiers.addressed, search: tiers.search ?? 0 },
      unsettled: unsettled.n,
      unsettledMicros: unsettled.m,
    };
  }

  // What the probe has left at a moment. Not a positive number means there is no live probe.
  function probeLeftAt(at) {
    const raw = store.getControl(CREDITS_PROBE);
    if (raw === null) return 0;
    if (raw.startsWith('f')) return Number(raw.slice(1));
    // '1' is a value written before the expiry was stored: it lives from when it was written.
    const expiresAt = raw === '1' ? store.controlUpdatedAt(CREDITS_PROBE) + CREDITS_PROBE_TTL_MS : Number(raw);
    return expiresAt - at;
  }

  const probeLive = () => probeLeftAt(now()) > 0;

  function pausePaid(reason, by = 'ledger') {
    store.tx(() => {
      const old = store.getControl('paid_paused');
      if (old !== null && pauseRank(old) > pauseRank(reason)) return;
      if (old === reason) return;
      // What replaces it says nothing about credits, and lifts with no wait, so the probe bounds what follows.
      if (old === 'openrouter_credits') {
        store.setControl(CREDITS_PROBE, `f${CREDITS_PROBE_TTL_MS}`, 'ledger');
      } else {
        // A pause the store wrote at recovery froze nothing, so its own start is what counts.
        const left = probeLeftAt(old === null ? now() : store.controlUpdatedAt('paid_paused'));
        if (left > 0) store.setControl(CREDITS_PROBE, `f${left}`, 'ledger');
        // Died with paid work open, so the next lift must not bring it back.
        else store.delControl(CREDITS_PROBE);
      }
      store.setControl('paid_paused', reason, by);
      store.addAlert('paid_paused', { reason });
      log('paid_paused', { reason });
    });
  }

  // provider: only 'search', and only with the search tier, which always takes it. Every other row carries the kind
  // spending now. A search row needs search on, no search pause, and the whole day's spend within searchUsd.
  function reserve(args) {
    return reserveRow(args, { searchAdmitted: false });
  }

  // searchAdmitted: the caller has already let this search row past the search pause (claimSearch, in its transaction).
  function reserveRow({ tier, category, heldMicros, eventKey = null, model = null, provider: providerOverride }, { searchAdmitted }) {
    if (!Number.isInteger(heldMicros) || heldMicros <= 0) throw new TypeError('ledger.reserve: heldMicros must be a positive integer');
    if (providerOverride !== undefined && providerOverride !== SEARCH_ROW_PROVIDER) throw new TypeError('ledger.reserve: provider can only be search');
    if (providerOverride === SEARCH_ROW_PROVIDER && tier !== SEARCH_TIER) throw new TypeError('ledger.reserve: the search provider goes with the search tier');
    return store.tx(() => {
      const eff = getEffective();
      if (!eff) return { ok: false, reason: 'total' };
      const p = provider(eff);
      if (!p) return { ok: false, reason: 'provider' };
      // Its own control, so it neither hides nor replaces what paid_paused holds, and it binds only its own kind.
      if (store.getControl(hardCapPauseKey(p.kind)) !== null) return { ok: false, reason: HARD_CAP_PAUSE };
      if (store.getControl('paid_paused') !== null) return { ok: false, reason: 'paid_paused' };
      const at = now();
      const s = spent(at);
      const b = eff.budget;
      const after = s.effectiveMicros + heldMicros;
      if (tier === 'interject') {
        if (s.byTier.interject + heldMicros > usdToMicros(b.interjectUsd)) return { ok: false, reason: 'tier' };
        if (after > usdToMicros(b.searchUsd)) return { ok: false, reason: 'total' };
      } else if (tier === 'named') {
        if (after > usdToMicros(b.namedUsd)) return { ok: false, reason: 'total' };
      } else if (tier === 'addressed') {
        if (after > usdToMicros(b.addressedUsd)) return { ok: false, reason: 'total' };
      } else if (tier === SEARCH_TIER) {
        // Search is never on under the OpenClaw runtime, whatever the file says.
        if (runtime !== 'own' || !searchOfEffective(eff)) return { ok: false, reason: 'search_off' };
        if (!searchAdmitted && store.getControl(SEARCH_PAUSE_KEY) !== null) return { ok: false, reason: 'search_paused' };
        if (after > usdToMicros(b.searchUsd)) return { ok: false, reason: 'total' };
      } else {
        return { ok: false, reason: 'tier' };
      }
      const id = randomUUID();
      const column = tier === SEARCH_TIER ? SEARCH_ROW_PROVIDER : providerColumn(p);
      q(`INSERT INTO reservations(id, local_day, utc_day, tier, category, held_micros, status, event_key, model, run_gen, created_at, provider)
         VALUES (?, ?, ?, ?, ?, ?, 'held', ?, ?, ?, ?, ?)`)
        .run(id, shanghaiDay(at), utcDay(at), tier, category, heldMicros, eventKey, model, store.runGen, at, column);
      return { ok: true, id };
    });
  }

  function holdMicros(kind) {
    const eff = getEffective();
    if (!eff) throw new Error('ledger: no effective config');
    // One search call at its worst: held prompt, the output cap and the per-call fee (docs/search-contract.md 7).
    if (kind === 'search') {
      const search = searchOfEffective(eff);
      if (!search) throw new Error('ledger: search is off');
      return searchWorstMicros({ inputTokens: SEARCH_HOLD_INPUT_TOKENS, maxTokens: search.maxTokens }, search.price);
    }
    const { primary, decision } = eff.models;
    if (kind === 'decision' || kind === 'search_decision') {
      if (!decision.price) throw new Error('ledger: decision price is not locked');
      const input = kind === 'decision' ? DECISION_INPUT_TOKENS : SEARCH_DECISION_INPUT_TOKENS;
      return Math.ceil(input * decision.price.inputPerM + decision.maxTokens * decision.price.outputPerM);
    }
    // The process's own runtime, fixed when it was built: the host process can still make its hidden second call
    // whatever a later clo apply wrote to the file.
    return replyHoldMicros(kind, primary, runtime);
  }

  const setSettled = (id, actualMicros, source, model) => q(`UPDATE reservations SET status='settled', actual_micros=?, source=?, model=COALESCE(?, model), settled_at=?
     WHERE id=? AND status IN ('held','unsettled')`).run(actualMicros, source ?? null, model ?? null, now(), id);

  function markUnsettled(id) {
    return Number(q("UPDATE reservations SET status='unsettled' WHERE id=? AND status='held'").run(id).changes) === 1;
  }

  // Zero or missing usage is never treated as free: the hold stays counted until something settles it.
  function settle(id, { actualMicros, source, model } = {}) {
    const usable = Number.isInteger(actualMicros) && (actualMicros > 0 || source === 'manual');
    if (!usable) {
      markUnsettled(id);
      log('settle_unknown', { source: source ?? null });
      return { status: 'unsettled' };
    }
    const changed = Number(setSettled(id, actualMicros, source, model).changes) === 1;
    return { status: changed ? 'settled' : 'unchanged' };
  }

  function release(id) {
    return Number(q("UPDATE reservations SET status='released', settled_at=? WHERE id=? AND status='held'").run(now(), id).changes) === 1;
  }

  // providerValue: the reservations.provider of the row; by default the provider spending now.
  function insertSettledRow({ tier, category, actualMicros, source, model, eventKey, providerValue }) {
    const at = now();
    const id = randomUUID();
    let value = providerValue;
    if (value === undefined) {
      const p = provider(getEffective());
      value = p ? providerColumn(p) : null;
    }
    q(`INSERT INTO reservations(id, local_day, utc_day, tier, category, held_micros, actual_micros, status, source, event_key, model, run_gen, created_at, settled_at, provider)
       VALUES (?, ?, ?, ?, ?, 0, ?, 'settled', ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, shanghaiDay(at), utcDay(at), tier, category, actualMicros, source ?? null, eventKey ?? null, model ?? null, store.runGen, at, at, value ?? null);
    return id;
  }

  const streakLimit = (eff = getEffective()) => eff?.budget.providerFailStreakPause ?? 3;

  // Other reasons can relabel provider_fail. A streak that reached the limit ends with the pause under any label;
  // a shorter one has paused nothing, so it keeps counting.
  function endSpentStreak() {
    if (store.peekCounter(STREAK_KEY) >= streakLimit()) q('DELETE FROM counters WHERE key=?').run(STREAK_KEY);
  }

  function liftPause(reason) {
    const pausedAt = store.controlUpdatedAt('paid_paused');
    store.delControl('paid_paused');
    const left = reason === 'openrouter_credits' ? CREDITS_PROBE_TTL_MS : probeLeftAt(pausedAt);
    if (left > 0) store.setControl(CREDITS_PROBE, now() + left, 'ledger');
    else store.delControl(CREDITS_PROBE);
  }

  // Only a read can end a residual, so a pause lifted without one does not run past it.
  function holdForResidual() {
    if (Number(store.getControl(RESIDUAL_COUNT) ?? 0) >= 2) pausePaid('residual');
  }

  function resumeIfSettled() {
    const reason = store.getControl('paid_paused');
    if (!CLEAR_WHEN_SETTLED.has(reason)) return;
    if (q("SELECT COUNT(*) AS n FROM reservations WHERE status='unsettled'").get().n > 0) return;
    liftPause(reason);
    endSpentStreak();
    log('paid_resumed', { reason });
    holdForResidual();
  }

  // eventKey null, or an event with no row, means usage nobody was waiting for: it still counts.
  function applyLateUsage(eventKey, { actualMicros, source, model } = {}) {
    if (!Number.isInteger(actualMicros) || actualMicros <= 0) return { status: 'ignored' };
    return store.tx(() => {
      if (eventKey) {
        // 'held' too: the turn has closed, and the gate may not have reached its settlement yet.
        const row = q("SELECT id FROM reservations WHERE event_key=? AND status IN ('unsettled','held') ORDER BY category='reply' DESC, created_at LIMIT 1").get(eventKey);
        if (row) {
          setSettled(row.id, actualMicros, source, model);
          resumeIfSettled();
          return { status: 'settled', id: row.id };
        }
        const prior = q('SELECT tier, provider FROM reservations WHERE event_key=? ORDER BY created_at DESC LIMIT 1').get(eventKey);
        if (prior) {
          // It belongs to the provider that ran the event.
          return { status: 'adjusted', id: insertSettledRow({ tier: prior.tier, category: 'adjustment', actualMicros, source, model, eventKey, providerValue: prior.provider }) };
        }
      }
      return { status: 'unattributed', id: insertSettledRow({ tier: 'none', category: 'unattributed', actualMicros, source, model, eventKey }) };
    });
  }

  async function readKey(eff = getEffective()) {
    if (!eff) throw new Error('key read failed: no effective config');
    // Before the Key is even fetched: a Key this provider cannot read with must never reach the /key endpoint.
    if (!keyReadable(provider(eff))) throw new Error('key read unsupported');
    const key = getKey();
    if (!key) throw new Error('key read failed: no key');
    const res = await fetch(`${eff.openrouter.baseUrl}/key`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(KEY_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`key read failed: HTTP ${res.status}`);
    const data = (await res.json())?.data;
    const usageMicros = microsOf(data?.usage);
    if (usageMicros === null) throw new Error('key read failed: no usage figure');
    return {
      limitMicros: microsOf(data.limit),
      remainingMicros: microsOf(data.limit_remaining),
      limitReset: data.limit_reset ?? null,
      usageMicros,
      usageDailyMicros: microsOf(data.usage_daily),
    };
  }

  function loadBaseline() {
    const raw = store.getMeta(BASELINE_META);
    return raw ? JSON.parse(raw) : null;
  }

  // The Key says nothing was charged. After the delay the row settles at zero, under a source of its own.
  // If the charge shows up later it becomes an unattributed residual, so it still counts.
  function clearUnbilled(base, at) {
    const b = getEffective()?.budget;
    const delay = b?.unsettledClearMs ?? UNSETTLED_CLEAR_MS;
    const reads = b?.unsettledClearReads ?? UNSETTLED_CLEAR_READS;
    for (const row of q(`SELECT id, created_at FROM reservations WHERE status='unsettled' AND ${OPENROUTER_ROWS} AND created_at>=? AND created_at<=? ORDER BY created_at`).all(base.at, at - delay)) {
      const seen = q('SELECT COUNT(*) AS n FROM key_snapshots WHERE taken_at>?').get(row.created_at).n;
      if (seen < reads) continue;
      q("UPDATE reservations SET status='settled', actual_micros=0, source='key_delta_none', settled_at=? WHERE id=? AND status='unsettled'").run(at, row.id);
      log('settle_unbilled', { source: 'key_delta_none' });
    }
  }

  const saveBaseline = (usage, at, keyId) => store.setMeta(BASELINE_META, JSON.stringify({ usage, at, keyId }));

  // For rows the Key figure can no longer speak for. They stay counted at their hold, and are dated before the new
  // baseline so they explain nothing charged after it. A charge that does land later is a residual: counted twice, not lost.
  function settleAtHold(source, at) {
    return Number(q("UPDATE reservations SET status='settled', actual_micros=held_micros, source=?, settled_at=? WHERE status='unsettled'").run(source, at - 1).changes);
  }

  // Moving the baseline past a row absorbs its charge. A row settling later would then explain money it did not cause,
  // and one that never settles would wait on a figure that already holds it. A charge lags the local settlement too, so
  // a row settled just now counts as well: its charge would arrive after the new baseline as a false residual.
  function quietToRebase(at) {
    const lag = getEffective()?.budget?.unsettledClearMs ?? UNSETTLED_CLEAR_MS;
    return q("SELECT COUNT(*) AS n FROM reservations WHERE status IN ('held','unsettled') OR (status='settled' AND actual_micros>0 AND settled_at>?)").get(at - lag).n === 0;
  }

  // The sweep drops rows by this age, so past it the sum of what is explained would read swept spend as new charges.
  function baselineOutlivesRows(base, at) {
    const days = getEffective()?.retention?.reservationDays;
    return days > 0 && at - base.at > days * DAY_MS;
  }

  // What the key has charged since the baseline, beyond what local rows already explain. p: the provider of the read.
  function attribute(k, keyId, at, p) {
    let base = loadBaseline();
    // A baseline from before it carried an id takes the current one: a rotation in that one gap shows only if the figure falls.
    if (base && ((base.keyId && base.keyId !== keyId) || k.usageMicros < base.usage)) {
      store.addAlert('key_changed', {});
      // What the old Key charged can never show on this one, so waiting cannot settle these.
      settleAtHold('key_changed', at);
      // Lifetime figures of two Keys cannot be subtracted, so the provider's day starts again at this read.
      // Local rows still hold what the old Key was seen to charge today.
      q('DELETE FROM key_snapshots WHERE taken_at<>?').run(at);
      base = null;
    }
    if (!base) {
      saveBaseline(k.usageMicros, at, keyId);
      return;
    }
    if (!base.keyId) saveBaseline(base.usage, base.at, keyId);
    if (baselineOutlivesRows(base, at)) {
      // Only a call in flight can delay this, and a restart turns those into unsettled rows. Until then nothing is
      // attributed. The provider figure for the day does not use the baseline, so the budget still sees the charges.
      if (q("SELECT COUNT(*) AS n FROM reservations WHERE status='held'").get().n > 0) return;
      log('key_baseline_reset', { count: settleAtHold('baseline_expired', at) });
      saveBaseline(k.usageMicros, at, keyId);
      return;
    }
    // Only rows the OpenRouter Key could have charged explain its figure: another provider's spend never shows there.
    const explained = q(`SELECT COALESCE(SUM(actual_micros), 0) AS m FROM reservations WHERE status='settled' AND ${OPENROUTER_ROWS} AND settled_at>=?`).get(base.at).m;
    // Calls in flight may already be in the provider figure, so they are not unexplained yet.
    const inFlight = q(`SELECT COALESCE(SUM(held_micros), 0) AS m FROM reservations WHERE status='held' AND ${OPENROUTER_ROWS}`).get().m;
    let unexplained = k.usageMicros - base.usage - explained - inFlight;
    const clean = unexplained <= 0 && inFlight === 0;
    if (unexplained > 0) {
      for (const row of q(`SELECT id, held_micros FROM reservations WHERE status='unsettled' AND ${OPENROUTER_ROWS} ORDER BY created_at`).all()) {
        if (unexplained <= 0) break;
        const amount = Math.min(unexplained, row.held_micros);
        setSettled(row.id, amount, 'key_delta', null);
        unexplained -= amount;
      }
      if (unexplained > 0) insertSettledRow({ tier: 'none', category: 'unattributed', actualMicros: unexplained, source: 'key_delta', providerValue: providerColumnOfKey(p) });
    }
    if (clean) clearUnbilled(base, at);
    if (at - base.at > REBASE_AFTER_MS && quietToRebase(at)) saveBaseline(k.usageMicros, at, keyId);
  }

  // Only says so: the local budget and the Key's own room are what stop spending, and a limit below the budget is fine.
  // Alerts once for each difference, so a read every few minutes does not repeat it, across restarts too.
  function noteKeyLimit(k, eff) {
    const configured = eff.budget?.keyDailyLimitUsd;
    const wanted = configured === null || configured === undefined ? null : usdToMicros(configured);
    const reason = wanted === null ? null : k.limitMicros !== wanted ? 'amount' : k.limitReset !== 'daily' ? 'reset' : null;
    if (reason === null) {
      store.delControl(KEY_LIMIT_SEEN);
      return;
    }
    const seen = `${reason}:${wanted}:${k.limitMicros}`;
    if (store.getControl(KEY_LIMIT_SEEN) === seen) return;
    store.setControl(KEY_LIMIT_SEEN, seen, 'ledger');
    store.addAlert('key_limit_mismatch', { reason, actualMicros: k.limitMicros });
    log('key_limit_mismatch', { reason });
  }

  function residualFor(day) {
    return q("SELECT COALESCE(SUM(actual_micros), 0) AS m FROM reservations WHERE local_day=? AND category='unattributed' AND source='key_delta'").get(day).m;
  }

  function clearsOnRead(reason, unsettled, at) {
    if (CLEAR_ON_CLEAN_READ.has(reason)) return true;
    if (CLEAR_WHEN_SETTLED.has(reason)) return unsettled === 0;
    if (reason !== 'openrouter_credits') return false;
    return at - store.controlUpdatedAt('paid_paused') >= (getEffective()?.budget?.creditsRetryMs ?? CREDITS_RETRY_MS);
  }

  // What the OpenRouter Key's own rows carry: the implicit entry stays NULL, an explicit one 'openrouter'.
  function providerColumnOfKey(p) {
    return p && p.kind === 'openrouter' ? providerColumn(p) : 'openrouter';
  }

  async function reconcile(at = now(), { atStart = false } = {}) {
    const startEff = getEffective();
    const startP = provider(startEff);
    // Nothing to read, so nothing to pause on: the local estimate is all there is (decision D3).
    if (!keyReadable(startP)) return { ok: false, unsupported: true };
    const readStartedAt = now();
    let k;
    let keyId;
    try {
      k = await readKey(startEff);
      keyId = store.key(getKey());
    } catch {
      keyFailures += 1;
      log('key_read_failed', { count: keyFailures });
      if (atStart || keyFailures >= 2) pausePaid('key_read_failed');
      return { ok: false, residualMicros: null, paused: store.getControl('paid_paused') !== null };
    }
    keyFailures = 0;
    lastReadAt = at;
    const eff = getEffective();
    if (!eff) return { ok: false, residualMicros: null, paused: store.getControl('paid_paused') !== null };
    // The file may have changed during the read. A figure read for another kind, or under a provider whose Key can no
    // longer be read, explains nothing here.
    const p = provider(eff);
    if (!keyReadable(p) || p.kind !== startP.kind) return { ok: false, residualMicros: null, paused: store.getControl('paid_paused') !== null };
    return store.tx(() => {
      q(`INSERT OR REPLACE INTO key_snapshots(taken_at, usage_micros, usage_daily_micros, limit_micros, remaining_micros, limit_reset)
         VALUES (?, ?, ?, ?, ?, ?)`).run(at, k.usageMicros, k.usageDailyMicros, k.limitMicros, k.remainingMicros, k.limitReset);
      noteKeyLimit(k, eff);
      attribute(k, keyId, at, p);

      const day = shanghaiDay(at);
      const residualMicros = residualFor(day);
      const threshold = Math.max(usdToMicros(eff.budget.residualMinUsd), Math.ceil(eff.budget.residualPct * providerMicros(at)));
      const over = residualMicros > threshold;
      const overCount = over ? Number(store.getControl(RESIDUAL_COUNT) ?? 0) + 1 : 0;
      store.setControl(RESIDUAL_COUNT, overCount, 'ledger');
      if (overCount >= 2) pausePaid('residual');

      // The host never says why a primary call failed, so this read is what names an exhausted Key.
      const exhausted = k.remainingMicros !== null && k.remainingMicros <= 0;
      if (exhausted) pausePaid('openrouter_key_limit');

      const reason = store.getControl('paid_paused');
      const unsettled = q("SELECT COUNT(*) AS n FROM reservations WHERE status='unsettled'").get().n;
      // A figure older than the pause says nothing about it.
      const pausedDuringRead = store.controlUpdatedAt('paid_paused') > readStartedAt;
      if (reason !== null && !over && !exhausted && !pausedDuringRead && clearsOnRead(reason, unsettled, at)) {
        liftPause(reason);
        // A limit pause can relabel provider_fail, so the streak behind it ends here too.
        if (reason === 'provider_fail' || LIMIT_SOURCES.has(reason)) q('DELETE FROM counters WHERE key=?').run(STREAK_KEY);
        else endSpentStreak();
        log('paid_resumed', { reason });
        // It can also have replaced a settlement pause. Paid work does not run on past rows still unknown.
        if (LIMIT_SOURCES.has(reason) && unsettled > 0) pausePaid('usage_missing');
      }
      return { ok: true, residualMicros, paused: store.getControl('paid_paused') !== null };
    });
  }

  async function tick() {
    const eff = getEffective();
    if (!eff || eff.mode !== 'live' || !keyReadable(provider(eff)) || !getKey()) return;
    const at = now();
    const unsettled = q("SELECT COUNT(*) AS n FROM reservations WHERE status='unsettled'").get().n;
    if (!liveStarted) {
      liveStarted = true;
      await reconcile(at, { atStart: true });
    } else if (unsettled > 0 || (store.getControl('connected') === 'true' && at - lastReadAt >= CONNECTED_READ_MS)) {
      await reconcile(at);
    }
  }

  // The baseline and the snapshots belong to one Key, and the baseline is the only record of which Key that was.
  // Dropping both makes the next read start a new baseline and a new day figure, so a switch back to OpenRouter, with
  // this Key or another, never reads another Key's figure, or the time away, as charges. Local rows still hold what was
  // spent today. Safe only with no row held or unsettled.
  function rebaseKey() {
    q('DELETE FROM meta WHERE key=?').run(BASELINE_META);
    q('DELETE FROM key_snapshots').run();
  }

  // Before `clo provider use` writes the config. It refuses while a pause, the decision breaker or any open row would
  // carry over to the other provider; otherwise it clears what only the old provider's Key reads or calls could end.
  // Hard-cap pauses and attestations stay: they belong to their kind, and switching away needs no attestation.
  function resetForProviderSwitch() {
    const out = store.tx(() => {
      if (store.getControl('paid_paused') !== null) return { ok: false, reason: 'paid_paused' };
      if (store.getControl(DECISION_BREAKER) !== null) return { ok: false, reason: 'decision_breaker' };
      if (q("SELECT COUNT(*) AS n FROM reservations WHERE status IN ('held','unsettled')").get().n > 0) return { ok: false, reason: 'reservations' };
      store.delControl(RESIDUAL_COUNT);
      store.delControl(CREDITS_PROBE);
      store.delControl(KEY_LIMIT_SEEN);
      q('DELETE FROM counters WHERE key=?').run(STREAK_KEY);
      rebaseKey();
      return { ok: true };
    });
    if (out.ok) {
      keyFailures = 0;
      lastReadAt = 0;
    }
    return out;
  }

  // ---- Search ----

  // A lower rank never replaces a higher one; an equal rank replaces. Search only: paid_paused is not touched.
  function pauseSearch(reason, by = 'ledger') {
    if (!SEARCH_PAUSE_REASONS.includes(reason)) throw new TypeError('ledger.pauseSearch: unknown reason');
    return store.tx(() => {
      const old = store.getControl(SEARCH_PAUSE_KEY);
      if (old !== null && searchPauseRank(old) > searchPauseRank(reason)) return false;
      if (old === reason) return false;
      store.setControl(SEARCH_PAUSE_KEY, reason, String(by).slice(0, 32));
      store.addAlert('search_paused', { reason });
      log('search_paused', { reason });
      return true;
    });
  }

  function liftSearch(reason) {
    store.delControl(SEARCH_PAUSE_KEY);
    log('search_resumed', { reason });
  }

  // Inside a claim's transaction, so a claim refused later gives the trial back. After a failure pause, one trial per
  // wait; it restarts the timer, so a crash during it still waits. No other search pause admits anything.
  function admitSearch() {
    const reason = store.getControl(SEARCH_PAUSE_KEY);
    if (reason === null) return true;
    if (reason !== 'fail') return false;
    const wait = getEffective()?.budget?.searchRetryMs ?? SEARCH_RETRY_MS;
    if (now() - store.controlUpdatedAt(SEARCH_PAUSE_KEY) < wait) return false;
    store.setControl(SEARCH_PAUSE_KEY, 'fail', 'ledger');
    return true;
  }

  // One search call: the per-answer count, the day's count and the hold commit together, or none of them do.
  // -> { ok: true, id, heldMicros } | { ok: false, reason } with reason one of search_off, search_paused, paid_paused,
  //    hard_cap_paused, price, answer_cap, day_cap, total, provider.
  function claimSearch({ eventKey, model = null } = {}) {
    if (typeof eventKey !== 'string' || !eventKey) throw new TypeError('ledger.claimSearch: eventKey');
    const eff = getEffective();
    const search = runtime === 'own' ? searchOfEffective(eff) : null;
    if (!search) return { ok: false, reason: 'search_off' };
    let heldMicros;
    try {
      heldMicros = holdMicros('search');
    } catch {
      return { ok: false, reason: 'price' };
    }
    const at = now();
    try {
      return store.tx(() => {
        if (store.getControl('paid_paused') !== null) throw new SearchRefused('paid_paused');
        if (!admitSearch()) throw new SearchRefused('search_paused');
        if (!store.bumpCounter(searchEventCounter(eventKey), at + DAY_MS, search.perAnswer).ok) throw new SearchRefused('answer_cap');
        if (!store.bumpCounter(searchDayCounter(shanghaiDay(at)), searchDayExpiry(at), search.perDay).ok) throw new SearchRefused('day_cap');
        // admitSearch has decided about the search pause, a failure pause's trial included.
        const r = reserveRow({ tier: SEARCH_TIER, category: 'search', heldMicros, eventKey, model: model ?? search.model, provider: SEARCH_ROW_PROVIDER }, { searchAdmitted: true });
        if (!r.ok) throw new SearchRefused(r.reason);
        return { ok: true, id: r.id, heldMicros };
      });
    } catch (err) {
      if (err instanceof SearchRefused) return { ok: false, reason: err.reason };
      throw err;
    }
  }

  // Whether a search could be claimed now, read without writing: what buys the decision for a real @ (decision D1)
  // asks this first, so no decision is bought for a search that would be refused. The claim itself decides.
  function searchRoom(at = now()) {
    try {
      const eff = getEffective();
      const search = runtime === 'own' ? searchOfEffective(eff) : null;
      if (!search || !search.price) return false;
      if (store.getControl('paid_paused') !== null) return false;
      const reason = store.getControl(SEARCH_PAUSE_KEY);
      if (reason !== null) {
        if (reason !== 'fail') return false;
        const wait = eff?.budget?.searchRetryMs ?? SEARCH_RETRY_MS;
        if (at - store.controlUpdatedAt(SEARCH_PAUSE_KEY) < wait) return false;
      }
      if (store.peekCounter(searchDayCounter(shanghaiDay(at))) >= search.perDay) return false;
      return spent(at).effectiveMicros + holdMicros('search') <= usdToMicros(eff.budget.searchUsd);
    } catch {
      return false;
    }
  }

  // Settles one search row. Usage unknown leaves it unsettled, counted at its hold. A figure above the hold settles at
  // the figure and pauses search: the hold was wrong, and only the owner lifts that.
  function settleSearch(id, { actualMicros, source, model } = {}) {
    const row = q("SELECT held_micros AS held, provider FROM reservations WHERE id=? AND status IN ('held','unsettled')").get(id);
    if (!row || row.provider !== SEARCH_ROW_PROVIDER) return { status: 'unchanged' };
    const out = settle(id, { actualMicros, source, model });
    if (out.status === 'settled' && actualMicros > row.held) {
      store.addAlert('search_cost_above_hold', { actualMicros, heldMicros: row.held });
      pauseSearch('cost_above_hold');
    }
    return out;
  }

  // Search failures stop search only: chat goes on. A 402, or one of OpenRouter's limit sources, is the search Key's
  // limit or the account's credits: search pauses until a read of its Key shows room.
  function noteSearchError({ httpStatus = null, limitSource = null } = {}) {
    if (httpStatus === 402 || (httpStatus === 403 && LIMIT_SOURCES.has(limitSource))) {
      pauseSearch('key_limit');
      return;
    }
    store.tx(() => {
      const { value } = store.bumpCounter(SEARCH_STREAK_KEY, now() + STREAK_TTL_MS);
      if (store.getControl(SEARCH_PAUSE_KEY) === 'fail') {
        // A failed trial: the wait starts again.
        store.setControl(SEARCH_PAUSE_KEY, 'fail', 'ledger');
      } else if (value >= streakLimit()) {
        pauseSearch('fail');
      }
    });
  }

  function noteSearchOk() {
    store.tx(() => {
      q('DELETE FROM counters WHERE key=?').run(SEARCH_STREAK_KEY);
      if (store.getControl(SEARCH_PAUSE_KEY) === 'fail') liftSearch('fail');
    });
  }

  // The owner says the cause is dealt with: cost_above_hold (after a look at the price lock) and fail only. The others
  // end with a read of the search Key.
  function clearSearchPause(by = 'cli') {
    return store.tx(() => {
      const reason = store.getControl(SEARCH_PAUSE_KEY);
      if (!SEARCH_OWNER_CLEARS.includes(reason)) return { cleared: false, reason };
      liftSearch(reason);
      q('DELETE FROM counters WHERE key=?').run(SEARCH_STREAK_KEY);
      log('search_pause_cleared', { reason, by: String(by).slice(0, 32) });
      return { cleared: true, reason };
    });
  }

  // Unsettled search rows that no figure has settled after the wait settle at their hold (decision D3): the light
  // reconciliation never attributes the search Key's figure to rows, so waiting longer cannot settle them. Over-counts,
  // never under-counts. Then a settlement pause with nothing left unsettled lifts as it would on any settlement.
  function settleExpiredSearch(at = now()) {
    const delay = getEffective()?.budget?.unsettledClearMs ?? UNSETTLED_CLEAR_MS;
    return store.tx(() => {
      const n = Number(q(`UPDATE reservations SET status='settled', actual_micros=held_micros, source=?, settled_at=?
                          WHERE status='unsettled' AND provider=? AND created_at<=?`).run(SEARCH_HOLD_SOURCE, at, SEARCH_ROW_PROVIDER, at - delay).changes);
      if (n > 0) {
        log('settle_search_hold', { count: n });
        resumeIfSettled();
      }
      return n;
    });
  }

  async function readSearchKey(eff) {
    const search = searchOfEffective(eff);
    if (runtime !== 'own' || !search) throw new Error('search key read unsupported');
    const key = getSearchKey();
    if (!key) throw new Error('search key read failed: no key');
    const res = await fetch(`${search.baseUrl}/key`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      redirect: 'error',
      signal: AbortSignal.timeout(KEY_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`search key read failed: HTTP ${res.status}`);
    const data = (await res.json())?.data;
    const usageDailyMicros = microsOf(data?.usage_daily);
    // The light reconciliation stands on this figure. Without it nothing can be compared, which is a failed read.
    if (usageDailyMicros === null) throw new Error('search key read failed: no daily usage figure');
    return {
      limitMicros: microsOf(data.limit),
      remainingMicros: microsOf(data.limit_remaining),
      limitReset: data.limit_reset ?? null,
      usageDailyMicros,
    };
  }

  // What the local search rows of a UTC day come to: settled at their figure, released at 0, the rest at their hold.
  function searchLocalUtc(day) {
    return q(`SELECT COALESCE(SUM(CASE status WHEN 'settled' THEN actual_micros WHEN 'released' THEN 0 ELSE held_micros END), 0) AS m
              FROM reservations WHERE utc_day=? AND provider=?`).get(day, SEARCH_ROW_PROVIDER).m;
  }

  // Says so once per difference: the search Key's limit should be budget.searchKeyDailyLimitUsd, reset daily.
  function noteSearchKeyLimit(k, eff) {
    const configured = eff.budget?.searchKeyDailyLimitUsd;
    const wanted = configured === null || configured === undefined ? null : usdToMicros(configured);
    const reason = wanted === null ? null : k.limitMicros !== wanted ? 'amount' : k.limitReset !== 'daily' ? 'reset' : null;
    if (reason === null) {
      store.delControl(SEARCH_KEY_LIMIT_SEEN);
      return;
    }
    const seen = `${reason}:${wanted}:${k.limitMicros}`;
    if (store.getControl(SEARCH_KEY_LIMIT_SEEN) === seen) return;
    store.setControl(SEARCH_KEY_LIMIT_SEEN, seen, 'ledger');
    store.addAlert('search_key_limit_mismatch', { reason, actualMicros: k.limitMicros });
    log('search_key_limit_mismatch', { reason });
  }

  // The light reconciliation (decision D3): the search Key's figure for the UTC day against what the local search rows
  // of that day come to. Nothing is attributed and nothing is written to key_snapshots. A gap above the threshold twice
  // in a row pauses search; a Key with no room left pauses search; a clean read lifts what a read can lift.
  async function reconcileSearch(at = now(), { atStart = false } = {}) {
    const startEff = getEffective();
    if (runtime !== 'own' || !searchOfEffective(startEff) || !getSearchKey()) return { ok: false, unsupported: true };
    const readStartedAt = now();
    let k;
    try {
      k = await readSearchKey(startEff);
    } catch {
      searchKeyFailures += 1;
      log('search_key_read_failed', { count: searchKeyFailures });
      if (atStart || searchKeyFailures >= 2) pauseSearch('key_read_failed');
      return { ok: false, gapMicros: null, paused: store.getControl(SEARCH_PAUSE_KEY) };
    }
    searchKeyFailures = 0;
    lastSearchReadAt = at;
    const eff = getEffective();
    if (!searchOfEffective(eff)) return { ok: false, gapMicros: null, paused: store.getControl(SEARCH_PAUSE_KEY) };
    return store.tx(() => {
      noteSearchKeyLimit(k, eff);
      const local = searchLocalUtc(utcDay(at));
      const gapMicros = k.usageDailyMicros - local;
      const threshold = Math.max(usdToMicros(eff.budget.residualMinUsd), Math.ceil(eff.budget.residualPct * k.usageDailyMicros));
      const over = gapMicros > threshold;
      const overCount = over ? Number(store.getControl(SEARCH_RESIDUAL_COUNT) ?? 0) + 1 : 0;
      store.setControl(SEARCH_RESIDUAL_COUNT, overCount, 'ledger');
      if (overCount >= 2) pauseSearch('residual');
      const exhausted = k.remainingMicros !== null && k.remainingMicros <= 0;
      if (exhausted) pauseSearch('key_limit');
      const reason = store.getControl(SEARCH_PAUSE_KEY);
      const pausedDuringRead = store.controlUpdatedAt(SEARCH_PAUSE_KEY) > readStartedAt;
      if (SEARCH_LIFTED_BY_READ.has(reason) && !over && !exhausted && !pausedDuringRead) liftSearch(reason);
      return { ok: true, gapMicros, localMicros: local, providerMicros: k.usageDailyMicros, paused: store.getControl(SEARCH_PAUSE_KEY) };
    });
  }

  // Each tick: expired search rows settle at their hold, then the search Key is read at the first live tick, after any
  // search row since the last read, and every ten minutes. Off, or with no search Key, nothing is read.
  async function searchTick() {
    const at = now();
    settleExpiredSearch(at);
    const eff = getEffective();
    if (!eff || eff.mode !== 'live' || runtime !== 'own' || !searchOfEffective(eff) || !getSearchKey()) return;
    if (!searchStarted) {
      searchStarted = true;
      await reconcileSearch(at, { atStart: true });
      return;
    }
    const fresh = q('SELECT COUNT(*) AS n FROM reservations WHERE provider=? AND (created_at>=? OR settled_at>=?)').get(SEARCH_ROW_PROVIDER, lastSearchReadAt, lastSearchReadAt).n;
    const due = at - lastSearchReadAt >= CONNECTED_READ_MS;
    const open = q("SELECT COUNT(*) AS n FROM reservations WHERE provider=? AND status IN ('held','unsettled')").get(SEARCH_ROW_PROVIDER).n;
    if (fresh > 0 || due || open > 0 || SEARCH_LIFTED_BY_READ.has(store.getControl(SEARCH_PAUSE_KEY))) await reconcileSearch(at);
  }

  // What status shows for search: the pause, today's count and spend, and the limits it runs under.
  function searchSnapshot(at = now()) {
    const eff = getEffective();
    const search = searchOfEffective(eff);
    return {
      on: runtime === 'own' ? search !== null : false,
      paused: store.getControl(SEARCH_PAUSE_KEY),
      countToday: store.peekCounter(searchDayCounter(shanghaiDay(at))),
      perDay: search?.perDay ?? null,
      spentMicros: store.spendByTier(shanghaiDay(at)).search ?? 0,
      searchUsd: eff?.budget?.searchUsd ?? null,
      keyDailyLimitUsd: eff?.budget?.searchKeyDailyLimitUsd ?? null,
      priceLocked: Boolean(search?.price),
    };
  }

  function checkKind(kind) {
    if (!PROVIDER_KINDS.includes(kind)) throw new TypeError('ledger: unknown provider kind');
  }

  function runTick() {
    tick().catch(() => log('reconcile_error', {})).then(() => searchTick()).catch(() => log('search_reconcile_error', {}));
  }

  // The Key is shared, so a limit error from either path stops all paid work. A bare 402 still means no money.
  // Each kind's limit names count only while that kind spends: a stray one from the other kind pauses nothing under
  // its name, so no pause can appear that only the other kind's Key read could lift.
  // p: the provider spending now, resolved once by the caller. With none named (an unreadable file on the own runtime)
  // no limit pause is taken under either kind's names: the error still counts in the streak.
  function pauseOnLimit(httpStatus, limitSource, p) {
    if (!p) return false;
    if (p.kind === 'anthropic') {
      if (ANTHROPIC_LIMITS.has(limitSource)) {
        pausePaid(limitSource);
        return true;
      }
      if (httpStatus !== 402) return false;
      pausePaid('anthropic_credits');
      return true;
    }
    if (httpStatus !== 402 && httpStatus !== 403) return false;
    if (LIMIT_SOURCES.has(limitSource)) {
      pausePaid(limitSource);
      return true;
    }
    if (httpStatus !== 402) return false;
    pausePaid('openrouter_credits');
    return true;
  }

  return {
    reserve,
    holdMicros,
    settle,
    release,
    markUnsettled,
    applyLateUsage,
    spent,
    readKey: () => readKey(),
    reconcile,
    pausePaid,

    // Primary model errors. Provider text never reaches this function.
    noteProviderError({ httpStatus = null, limitSource = null } = {}) {
      const eff = getEffective();
      const p = provider(eff);
      if (pauseOnLimit(httpStatus, limitSource, p)) return;
      if (httpStatus === 403) store.addAlert('provider_403', { httpStatus });
      const { value } = store.bumpCounter(STREAK_KEY, now() + STREAK_TTL_MS);
      if (value < streakLimit(eff)) return;
      // The credits probe speaks of OpenRouter credits only.
      pausePaid(p?.kind === 'openrouter' && probeLive() ? 'openrouter_credits' : 'provider_fail');
    },
    noteProviderOk() {
      q('DELETE FROM counters WHERE key=?').run(STREAK_KEY);
      store.delControl(CREDITS_PROBE);
    },

    // Decision errors stop decisions only: a failing cheap model must not silence real @ replies.
    noteDecisionError({ httpStatus = null, limitSource = null } = {}) {
      const eff = getEffective();
      if (pauseOnLimit(httpStatus, limitSource, provider(eff))) return;
      if (httpStatus === 403) store.addAlert('provider_403', { httpStatus });
      store.tx(() => {
        const { value } = store.bumpCounter(DECISION_STREAK_KEY, now() + STREAK_TTL_MS);
        if (store.getControl(DECISION_BREAKER) !== null) {
          store.setControl(DECISION_BREAKER, 'open', 'ledger');
        } else if (value >= streakLimit(eff)) {
          store.setControl(DECISION_BREAKER, 'open', 'ledger');
          store.addAlert('decision_paused', { count: value });
          log('decision_paused', { count: value });
        }
      });
    },
    noteDecisionOk() {
      store.tx(() => {
        q('DELETE FROM counters WHERE key=?').run(DECISION_STREAK_KEY);
        store.delControl(CREDITS_PROBE);
        if (store.getControl(DECISION_BREAKER) === null) return;
        store.delControl(DECISION_BREAKER);
        log('decision_resumed', {});
      });
    },
    // Called inside the claim's transaction, so a claim refused later gives the trial back.
    // A trial restarts the timer: one per wait, and a crash during it still waits.
    admitDecision() {
      if (store.getControl(DECISION_BREAKER) === null) return true;
      const wait = getEffective()?.budget?.decisionRetryMs ?? DECISION_RETRY_MS;
      if (now() - store.controlUpdatedAt(DECISION_BREAKER) < wait) return false;
      store.setControl(DECISION_BREAKER, 'open', 'ledger');
      return true;
    },

    startTimers() {
      if (timer) return;
      runTick();
      timer = setTimer(runTick, TICK_MS);
      timer?.unref?.();
    },
    stopTimers() {
      if (timer) clearTimer(timer);
      timer = null;
    },

    // The owner says the cause is dealt with. Only for pauses nothing else can lift early; a wrong call pauses again.
    // provider_fail too where no Key read can lift it. Then the streak is left one short of the limit, so one more
    // failure pauses again at once; an anthropic_* limit pauses again at its next occurrence.
    clearOwnerPause() {
      return store.tx(() => {
        const reason = store.getControl('paid_paused');
        const eff = getEffective();
        const providerFail = reason === 'provider_fail' && provider(eff)?.caps?.ownerClearsProviderFail === true;
        if (!OWNER_CLEARS.has(reason) && !OWNER_CLEARS_PROVIDER.has(reason) && !providerFail) return { cleared: false, reason };
        liftPause(reason);
        const limit = streakLimit(eff);
        if (providerFail && limit > 1) {
          q(`INSERT INTO counters(key, value, expires_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at`).run(STREAK_KEY, limit - 1, now() + STREAK_TTL_MS);
        } else {
          // The failures behind the pause end with it. New ones still need a full streak to pause again.
          q('DELETE FROM counters WHERE key=?').run(STREAK_KEY);
        }
        log('paid_resumed', { reason });
        // Not past what is already known: a residual this pause was masking, or rows still unknown.
        holdForResidual();
        if (q("SELECT COUNT(*) AS n FROM reservations WHERE status='unsettled'").get().n > 0) pausePaid('usage_missing');
        return { cleared: true, reason };
      });
    },

    acceptUnsettled(by = 'cli') {
      return store.tx(() => {
        const rows = q("SELECT id, held_micros FROM reservations WHERE status='unsettled'").all();
        for (const r of rows) setSettled(r.id, r.held_micros, 'manual', null);
        const reason = store.getControl('paid_paused');
        if (CLEAR_WHEN_SETTLED.has(reason)) {
          liftPause(reason);
          endSpentStreak();
          holdForResidual();
        }
        log('accept_unsettled', { count: rows.length, source: 'manual', reason: String(by).slice(0, 32) });
        return rows.length;
      });
    },

    rebaseKey,
    resetForProviderSwitch,

    // Search (own runtime only).
    claimSearch,
    searchRoom,
    settleSearch,
    releaseSearch: release,
    noteSearchError,
    noteSearchOk,
    pauseSearch,
    searchPaused: () => store.getControl(SEARCH_PAUSE_KEY),
    clearSearchPause,
    settleExpiredSearch,
    reconcileSearch,
    searchTick,
    searchSnapshot,

    // The hard-cap pause (contract 8.1). Not a paid_paused reason: it lives in a control per kind, so it never
    // replaces a lower pause, lifting it never clears one, and it binds only while its kind spends.
    pauseHardCap(kind, by = 'ledger', code = LIVE_CODES.hardCap) {
      checkKind(kind);
      if (!HARD_CAP_CODES.has(code)) throw new TypeError('ledger.pauseHardCap: unknown code');
      store.tx(() => {
        const key = hardCapPauseKey(kind);
        if (store.getControl(key) === code) return;
        store.setControl(key, code, String(by).slice(0, 32));
        store.addAlert('paid_paused', { reason: HARD_CAP_PAUSE, code });
        log('paid_paused', { reason: HARD_CAP_PAUSE });
      });
    },
    // Only an ack calls this. Whatever paid_paused holds stays as it is.
    liftHardCapPause(kind) {
      checkKind(kind);
      store.delControl(hardCapPauseKey(kind));
    },
    hardCapPaused(kind) {
      checkKind(kind);
      return store.getControl(hardCapPauseKey(kind));
    },
    // `clo ack hard-cap`: binds the attestation to this Key's fingerprint and lifts that kind's hard-cap pause, together.
    attestHardCap(kind, key, by = 'cli') {
      checkKind(kind);
      if (typeof key !== 'string' || key === '') throw new TypeError('ledger.attestHardCap: no key');
      store.tx(() => {
        store.setControl(hardCapControlKey(kind), store.key(key), String(by).slice(0, 32));
        store.delControl(hardCapPauseKey(kind));
      });
    },
    // Whether the attested fingerprint is this Key's. No Key, or no attestation, is not a match.
    hardCapKeyMatches(kind, key) {
      checkKind(kind);
      const control = store.getControl(hardCapControlKey(kind));
      return typeof key === 'string' && key !== '' && control !== null && control === store.key(key);
    },

    // What status shows beside paid_paused: the kind spending now, whether its Key can be read (reconciliation is
    // unavailable where it cannot), and that kind's hard-cap pause.
    snapshot() {
      const p = provider(getEffective());
      return {
        provider: p ? p.kind : null,
        keyReadable: keyReadable(p),
        paidPaused: store.getControl('paid_paused'),
        hardCapPaused: p ? store.getControl(hardCapPauseKey(p.kind)) : null,
      };
    },
  };
}
