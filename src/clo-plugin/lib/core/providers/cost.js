// Money arithmetic for model calls: pure, no I/O, no pause, no log. Adapters only normalise usage; this prices it.
// usageMicros below is a byte copy of gate.js's: reported cost first, tokens at the locked price as the fallback.
// computeMicros prices tokens only and says, in flags, what it could not price at the standard rate.
// settleMicros keeps usageMicros for the OpenClaw runtime; the own runtime on OpenRouter settles at the reported cost,
// prices the tokens only when none was reported, and compares the two for an alert.

// Inference served from the US only, and fast mode. Both are priced here, never requested, and flagged when seen.
export const GEO_US_MULTIPLIER = 1.1;
export const FAST_MULTIPLIER = 2;
// Cache writes when the price book gives no rate of its own: 1.25x the input rate for five minutes, 2x for an hour.
const CACHE_WRITE_5M_FACTOR = 1.25;
const CACHE_WRITE_1H_FACTOR = 2;

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

const rate = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
// A token count: a finite number at or above 0, or undefined. A count that is missing or unreadable is never read as 0,
// because tokens that were billed but not readable would then settle below their hold for good.
const tokens = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
// Float sums like 0.2 * n are rounded to a millionth of a micro before rounding up, so 1100.0000000000002 is 1100.
const ceilMicros = (x) => Math.ceil(Math.round(x * 1e6) / 1e6);

// One rate card with every rate filled in, or null when the input or output rate is missing.
function card(c) {
  if (!c || typeof c !== 'object') return null;
  const inputPerM = rate(c.inputPerM);
  const outputPerM = rate(c.outputPerM);
  if (inputPerM === null || outputPerM === null) return null;
  return {
    inputPerM,
    outputPerM,
    cacheReadPerM: rate(c.cacheReadPerM) ?? inputPerM,
    cacheWritePerM: rate(c.cacheWritePerM) ?? inputPerM * CACHE_WRITE_5M_FACTOR,
    cacheWrite1hPerM: rate(c.cacheWrite1hPerM) ?? inputPerM * CACHE_WRITE_1H_FACTOR,
  };
}

// The card a prompt of this many tokens is billed on. A long card that is present but incomplete prices nothing.
function cardFor(price, promptTokens) {
  const base = card(price);
  if (!base) return null;
  const long = price.long;
  if (long === undefined || long === null) return base;
  if (typeof long !== 'object' || rate(long.aboveTokens) === null) return null;
  if (promptTokens <= long.aboveTokens) return base;
  return card(long);
}

// usage: {input, output, cacheRead, cacheWrite, cacheWrite1h?, geo?, speed?}. output already counts reasoning tokens.
// input, output, cacheRead and cacheWrite are required: any of them missing, or not a finite number at or above 0,
// gives null, so the row stays unsettled and counted at its hold.
// Reported presence matters:
//   cacheWrite1h: a number when the split by lifetime is known; null when writes were reported without the split, which
//     prices all of cacheWrite at the 1h rate; absent when the provider has no such split, which prices it at 5 minutes.
//   geo: 'global' or absent is standard; 'us' is x1.1; null or anything else is unknown and priced as 'us'.
//   speed: 'standard' or absent is standard; 'fast' is x2; null or anything else is unknown and priced as 'fast'.
// Flags: 'geo_us', 'geo_unknown', 'speed_fast', 'speed_unknown', 'cache_1h', 'cache_unsplit'. Any flag means the
// figure is not the standard price the holds assume.
export function computeMicros(usage, price) {
  if (!usage || typeof usage !== 'object' || !price || typeof price !== 'object') return null;
  const input = tokens(usage.input);
  const output = tokens(usage.output);
  const cacheRead = tokens(usage.cacheRead);
  const cacheWrite = tokens(usage.cacheWrite);
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return null;
  const split = usage.cacheWrite1h;
  const cacheWrite1h = split === undefined || split === null ? 0 : tokens(split);
  if (cacheWrite1h === undefined) return null;
  const prompt = input + cacheRead + cacheWrite + cacheWrite1h;
  if (prompt + output <= 0) return null;
  const c = cardFor(price, prompt);
  if (!c) return null;
  const flags = [];
  let writeRate = c.cacheWritePerM;
  if (split === null && cacheWrite > 0) {
    writeRate = c.cacheWrite1hPerM;
    flags.push('cache_unsplit');
  }
  if (cacheWrite1h > 0) flags.push('cache_1h');
  let micros = input * c.inputPerM + output * c.outputPerM + cacheRead * c.cacheReadPerM
    + cacheWrite * writeRate + cacheWrite1h * c.cacheWrite1hPerM;
  if (usage.geo !== undefined && usage.geo !== 'global') {
    micros *= GEO_US_MULTIPLIER;
    flags.push(usage.geo === 'us' ? 'geo_us' : 'geo_unknown');
  }
  if (usage.speed !== undefined && usage.speed !== 'standard') {
    micros *= FAST_MULTIPLIER;
    flags.push(usage.speed === 'fast' ? 'speed_fast' : 'speed_unknown');
  }
  const total = ceilMicros(micros);
  return total > 0 ? { micros: total, source: 'computed', flags } : null;
}

// The alert an own-runtime OpenRouter settlement raises when the reported cost is above the computed one by more than
// this margin: the route was dearer than the lock. The reported figure already settles; the alert is for a look.
export const COST_ABOVE_COMPUTED_ALERT = 'cost_above_computed';
export const REPORTED_ABOVE_COMPUTED_MARGIN = 1.1;

// The reported cost in micros, rounded up as usageMicros rounds it, or null when none above 0 was reported.
const reportedMicros = (usage) => (typeof usage?.costUsd === 'number' && usage.costUsd > 0 ? Math.ceil(usage.costUsd * 1e6) : null);

// OpenRouter on the own runtime: the reported cost settles whenever there is one, above or below the tokens at the
// locked price. It is what the Key is charged, and the ledger reconciles the Key against the settled figures: a figure
// above the bill would read as spend the Key explains, hide later charges that were billed, and clear a lost row at 0.
// So a dearer route settles at its bill and a cheaper one does not over-count. The tokens at the lock settle only when
// no cost was reported; neither settles nothing. Never flags: nothing here pauses paid work.
function openrouterOwnMicros(usage, price) {
  if (!usage) return null;
  const reported = reportedMicros(usage);
  const computed = computeMicros(usage, price)?.micros ?? null;
  if (reported === null && computed === null) return null;
  if (reported === null) return { micros: computed, source: 'computed', flags: [] };
  if (computed === null) return { micros: reported, source: 'model.usage', flags: [] };
  // Integers on both sides: reported > 1.1 x computed, without a float in the comparison.
  const above = reported * 10 > computed * Math.round(REPORTED_ABOVE_COMPUTED_MARGIN * 10);
  return { micros: reported, source: 'model.usage', flags: [], ...(above ? { alerts: [COST_ABOVE_COMPUTED_ALERT] } : {}) };
}

// What one settled call costs.
//   OpenRouter on the OpenClaw runtime (or no runtime named): today's order, reported cost first, exactly usageMicros.
//   OpenRouter on the own runtime: the reported cost, else the tokens at the lock (computeMicros, not usageMicros),
//     with alerts ['cost_above_computed'] when reported is above 1.1x computed. alerts is a separate field from flags,
//     which pause paid work; an alert does not. The settlement sites in gate.js record each one as an alert row.
//   Anthropic: tokens at the locked price, on either runtime.
// An unknown kind settles nothing, which leaves the row unsettled and counted at its hold.
export function settleMicros(usage, price, { kind, runtime } = {}) {
  if (kind === 'openrouter') {
    if (runtime === 'own') return openrouterOwnMicros(usage, price);
    const r = usageMicros(usage, price);
    return r ? { ...r, flags: [] } : null;
  }
  if (kind === 'anthropic') return computeMicros(usage, price);
  return null;
}

// A static upper bound for one call, for a probe's budget: every input token at the dearest standard input-side rate
// (input or five-minute cache write) of the card that many tokens fall on, all output at the output rate, times the
// US-only multiplier unless geoUs is false. One-hour writes and fast mode are never requested, so they are not in it.
// A count that is not a finite number at or above 0 throws: a bound must never read it as 0.
export function worstCaseMicros({ input, output }, price, { geoUs = true } = {}) {
  const inTokens = tokens(input);
  const outTokens = tokens(output);
  if (inTokens === undefined || outTokens === undefined) throw new TypeError('worstCaseMicros: token counts must be numbers');
  const c = cardFor(price, inTokens);
  if (!c) throw new Error('worstCaseMicros: price is not locked');
  const micros = inTokens * Math.max(c.inputPerM, c.cacheWritePerM) + outTokens * c.outputPerM;
  return ceilMicros(geoUs ? micros * GEO_US_MULTIPLIER : micros);
}
