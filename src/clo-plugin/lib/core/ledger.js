// Budget ledger. Money is integer micro-USD. Every reservation commits before the money is spent.
import { randomUUID } from 'node:crypto';
import { shanghaiDay, shanghaiDayStart, utcDay } from './ids.js';
import { callWorstMicros } from './models.js';
import { pauseRank } from './store.js';

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
const LIMIT_SOURCES = new Set(['openrouter_key_limit', 'openrouter_credits']);
// No Key read can lift these: usage_unavailable waits for a person to look, and credits for a person to top up.
const OWNER_CLEARS = new Set(['usage_unavailable', 'openrouter_credits']);
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

export const usdToMicros = (usd) => Math.round(usd * 1e6);

function microsOf(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? usdToMicros(n) : null;
}

export function createLedger({ store, getEffective, fetch = globalThis.fetch, getKey, log = () => {}, now = Date.now, setTimer = setInterval, clearTimer = clearInterval }) {
  const { q } = store;
  let keyFailures = 0;
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
      byTier: { interject: tiers.interject, named: tiers.named, addressed: tiers.addressed },
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

  function reserve({ tier, category, heldMicros, eventKey = null, model = null }) {
    if (!Number.isInteger(heldMicros) || heldMicros <= 0) throw new TypeError('ledger.reserve: heldMicros must be a positive integer');
    return store.tx(() => {
      const eff = getEffective();
      if (!eff) return { ok: false, reason: 'total' };
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
      } else {
        return { ok: false, reason: 'tier' };
      }
      const id = randomUUID();
      q(`INSERT INTO reservations(id, local_day, utc_day, tier, category, held_micros, status, event_key, model, run_gen, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'held', ?, ?, ?, ?)`)
        .run(id, shanghaiDay(at), utcDay(at), tier, category, heldMicros, eventKey, model, store.runGen, at);
      return { ok: true, id };
    });
  }

  function holdMicros(kind) {
    const eff = getEffective();
    if (!eff) throw new Error('ledger: no effective config');
    const { primary, decision } = eff.models;
    const callWorst = () => callWorstMicros(primary.price, primary);
    if (kind === 'decision') {
      if (!decision.price) throw new Error('ledger: decision price is not locked');
      return Math.ceil(DECISION_INPUT_TOKENS * decision.price.inputPerM + decision.maxTokens * decision.price.outputPerM);
    }
    if (kind === 'reply_required') return 2 * callWorst();
    if (kind === 'reply_optional' || kind === 'tool_round') return callWorst();
    throw new TypeError(`ledger.holdMicros: unknown kind ${kind}`);
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

  function insertSettledRow({ tier, category, actualMicros, source, model, eventKey }) {
    const at = now();
    const id = randomUUID();
    q(`INSERT INTO reservations(id, local_day, utc_day, tier, category, held_micros, actual_micros, status, source, event_key, model, run_gen, created_at, settled_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, 'settled', ?, ?, ?, ?, ?, ?)`)
      .run(id, shanghaiDay(at), utcDay(at), tier, category, actualMicros, source ?? null, eventKey ?? null, model ?? null, store.runGen, at, at);
    return id;
  }

  const streakLimit = () => getEffective()?.budget.providerFailStreakPause ?? 3;

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
        const prior = q('SELECT tier FROM reservations WHERE event_key=? ORDER BY created_at DESC LIMIT 1').get(eventKey);
        if (prior) {
          return { status: 'adjusted', id: insertSettledRow({ tier: prior.tier, category: 'adjustment', actualMicros, source, model, eventKey }) };
        }
      }
      return { status: 'unattributed', id: insertSettledRow({ tier: 'none', category: 'unattributed', actualMicros, source, model, eventKey }) };
    });
  }

  async function readKey() {
    const eff = getEffective();
    if (!eff) throw new Error('key read failed: no effective config');
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
    for (const row of q("SELECT id, created_at FROM reservations WHERE status='unsettled' AND created_at>=? AND created_at<=? ORDER BY created_at").all(base.at, at - delay)) {
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

  // What the key has charged since the baseline, beyond what local rows already explain.
  function attribute(k, keyId, at) {
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
    const explained = q("SELECT COALESCE(SUM(actual_micros), 0) AS m FROM reservations WHERE status='settled' AND settled_at>=?").get(base.at).m;
    // Calls in flight may already be in the provider figure, so they are not unexplained yet.
    const inFlight = q("SELECT COALESCE(SUM(held_micros), 0) AS m FROM reservations WHERE status='held'").get().m;
    let unexplained = k.usageMicros - base.usage - explained - inFlight;
    const clean = unexplained <= 0 && inFlight === 0;
    if (unexplained > 0) {
      for (const row of q("SELECT id, held_micros FROM reservations WHERE status='unsettled' ORDER BY created_at").all()) {
        if (unexplained <= 0) break;
        const amount = Math.min(unexplained, row.held_micros);
        setSettled(row.id, amount, 'key_delta', null);
        unexplained -= amount;
      }
      if (unexplained > 0) insertSettledRow({ tier: 'none', category: 'unattributed', actualMicros: unexplained, source: 'key_delta' });
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

  async function reconcile(at = now(), { atStart = false } = {}) {
    const readStartedAt = now();
    let k;
    let keyId;
    try {
      k = await readKey();
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
    return store.tx(() => {
      q(`INSERT OR REPLACE INTO key_snapshots(taken_at, usage_micros, usage_daily_micros, limit_micros, remaining_micros, limit_reset)
         VALUES (?, ?, ?, ?, ?, ?)`).run(at, k.usageMicros, k.usageDailyMicros, k.limitMicros, k.remainingMicros, k.limitReset);
      noteKeyLimit(k, eff);
      attribute(k, keyId, at);

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
    if (!eff || eff.mode !== 'live' || !getKey()) return;
    const at = now();
    const unsettled = q("SELECT COUNT(*) AS n FROM reservations WHERE status='unsettled'").get().n;
    if (!liveStarted) {
      liveStarted = true;
      await reconcile(at, { atStart: true });
    } else if (unsettled > 0 || (store.getControl('connected') === 'true' && at - lastReadAt >= CONNECTED_READ_MS)) {
      await reconcile(at);
    }
  }

  function runTick() {
    tick().catch(() => log('reconcile_error', {}));
  }

  // The Key is shared, so a limit error from either path stops all paid work. A bare 402 still means no money.
  function pauseOnLimit(httpStatus, limitSource) {
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
    readKey,
    reconcile,
    pausePaid,

    // Primary model errors. Provider text never reaches this function.
    noteProviderError({ httpStatus = null, limitSource = null } = {}) {
      if (pauseOnLimit(httpStatus, limitSource)) return;
      if (httpStatus === 403) store.addAlert('provider_403', { httpStatus });
      const { value } = store.bumpCounter(STREAK_KEY, now() + STREAK_TTL_MS);
      if (value < streakLimit()) return;
      pausePaid(probeLive() ? 'openrouter_credits' : 'provider_fail');
    },
    noteProviderOk() {
      q('DELETE FROM counters WHERE key=?').run(STREAK_KEY);
      store.delControl(CREDITS_PROBE);
    },

    // Decision errors stop decisions only: a failing cheap model must not silence real @ replies.
    noteDecisionError({ httpStatus = null, limitSource = null } = {}) {
      if (pauseOnLimit(httpStatus, limitSource)) return;
      if (httpStatus === 403) store.addAlert('provider_403', { httpStatus });
      store.tx(() => {
        const { value } = store.bumpCounter(DECISION_STREAK_KEY, now() + STREAK_TTL_MS);
        if (store.getControl(DECISION_BREAKER) !== null) {
          store.setControl(DECISION_BREAKER, 'open', 'ledger');
        } else if (value >= (getEffective()?.budget.providerFailStreakPause ?? 3)) {
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
    clearOwnerPause() {
      return store.tx(() => {
        const reason = store.getControl('paid_paused');
        if (!OWNER_CLEARS.has(reason)) return { cleared: false, reason };
        liftPause(reason);
        // The failures behind the pause end with it. New ones still need a full streak to pause again.
        q('DELETE FROM counters WHERE key=?').run(STREAK_KEY);
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
  };
}
