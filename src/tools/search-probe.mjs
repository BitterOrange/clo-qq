// Search probe (docs/search-contract.md, "Unverified"). Measures what the offline suite cannot about the one search
// path this build has: the Sonar request body is accepted, which citation shapes come back and whether they carry
// titles, the usage and cost fields, the catalog's price field names, whether the Key's /key answer has usage_daily,
// and whether the decision model takes the search schema (two plain query strings).
//
// Safeguards, the same as q5-probe's own mode:
// - Without --approve it prints the plan and exits. No request, and .env is not read.
// - It sends only the fixed texts below and the project's two decision prompt files. Nothing from the command line.
// - It reads one Key of its own, CLO_TEST_API_KEY, never the chat or the search Key, and refuses to run when that Key
//   has no daily limit or a daily limit above --max-usd.
// - The worst case is computed at fixed price ceilings with no network. A catalog price above them, or a price field
//   this tool does not know, refuses the run before any paid call.
// - Every request body is compared with the planned one just before it leaves. Requests go to the one model host
//   only, redirects refused, and no paid call is retried.
// - Results hold field names, types, numbers and classifications only: no query text, no answer text, no URL, no
//   title. The Key never reaches the file or the console.
// - config.json is neither read nor changed. The bot and the Gateway are not started.
//
// Run through scripts\search-probe.ps1, which uses the private Node.
import { dirname, join, resolve } from 'node:path';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { isLoopback } from '../cli/common.mjs';
import { parseEnvFile } from '../cli/lifecycle.mjs';
import { IS_WINDOWS, isEntryPath } from '../cli/platform.mjs';
import { mkdirPrivate, privateAppender } from '../clo-plugin/lib/core/private-fs.js';
import { OPENROUTER_BASE_URL, resolvePaths } from '../clo-plugin/lib/core/config.js';
import { buildSearchRequest, parseAnswer, SEARCH_ADDENDUM_FILE, searchPrompt } from '../clo-plugin/lib/core/decision.js';
import { fetchCatalog, priceFor, searchPriceFor } from '../clo-plugin/lib/core/models.js';
import { searchMicros } from '../clo-plugin/lib/core/providers/cost.js';
import { mapUsage } from '../clo-plugin/lib/core/providers/openrouterAdapter.js';
import { createSearchAdapter } from '../clo-plugin/lib/core/providers/searchAdapter.js';
import { SEARCH_DEFAULTS, SEARCH_HOLD_INPUT_TOKENS, SEARCH_MODEL } from '../clo-plugin/lib/core/providers/searchRegistry.js';
import { classifyError, createSpendTracker, reportedCostMicros, restrictedFetch, watchStopSignals } from './q5-probe.mjs';

const SELF = fileURLToPath(import.meta.url);

// The models a person agrees to when reading the plan. A catalog without them stops the run before any paid call.
export const SEARCH_ID = SEARCH_MODEL['openrouter-sonar'];
export const DECISION_ID = 'anthropic/claude-haiku-5.5';
// The .env name this tool reads. A Key of its own, so its spend is not mixed with the bot's.
export const PROBE_KEY_NAME = 'CLO_TEST_API_KEY';
// The estimate has to be printable with no network, so it uses ceilings, chosen in development with room above the
// unverified prices the mocks use. A catalog price above them refuses the run.
export const PRICE_CEILING = Object.freeze({
  search: Object.freeze({ inputPerM: 5, outputPerM: 20, requestUsd: 0.02 }),
  decision: Object.freeze({ inputPerM: 2, outputPerM: 10 }),
});
// A token is at least about one byte of UTF-8, so bytes bound the decision prompt. This covers schema and framing.
const PROMPT_OVERHEAD_TOKENS = 500;
// The only top-level fields each request may carry.
const SEARCH_BODY_KEYS = Object.freeze(['max_tokens', 'messages', 'model', 'stream', 'usage']);
const CALL_TIMEOUT_MS = 60000;
const KEY_TIMEOUT_MS = 15000;
// The catalog is large and free to read; 15 s timed out once on a real home connection (2026-11-19).
const CATALOG_TIMEOUT_MS = 60000;
// The Key can round. A difference this small is not a finding.
const KEY_TOLERANCE_MICROS = 1000;
const STOP_STATUS = new Set([401, 402, 403, 429]);
export const RESULT_FILE = 'search-probe-results.jsonl';

// Every text this tool can send, apart from the two decision prompt files. Harmless, and current enough that a search
// is the right answer.
export const FIXED = Object.freeze({
  query: '最近一届夏季奥运会的举办城市',
  decisionInput: Object.freeze({
    trigger: 'addressed',
    lines: Object.freeze([Object.freeze({ sender: 'U1', text: '周末大家有什么安排？' })]),
    current: Object.freeze({ sender: 'U2', text: '可洛，最近一届夏季奥运会是在哪个城市办的？' }),
  }),
});

const utf8Bytes = (text) => Buffer.byteLength(text, 'utf8');
const round6 = (micros) => Number((micros / 1e6).toFixed(6));
const usdText = (micros) => `$${(micros / 1e6).toFixed(4)}`;
const usdUpText = (micros) => `$${(Math.ceil(micros / 100) / 1e4).toFixed(4)}`;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// --- the plan ---

function decisionEff(example) {
  const d = example.decisionModel;
  if (d.id !== DECISION_ID) throw new Error('config.example.json names another decision model');
  return {
    models: { decision: { id: d.id, effort: d.effort, maxTokens: d.maxTokens } },
    retention: { decisionLines: 15, decisionLineChars: 200, decisionCurrentChars: 800 },
  };
}

export function buildPlan(repoRoot) {
  const example = JSON.parse(readFileSync(join(repoRoot, 'config.example.json'), 'utf8').replace(/^﻿/, ''));
  const read = (name) => readFileSync(join(repoRoot, 'persona', name), 'utf8');
  const prompt = searchPrompt(read('decision-prompt.zh.md'), read(SEARCH_ADDENDUM_FILE));
  const decisionBody = buildSearchRequest(decisionEff(example), prompt, FIXED.decisionInput);
  const maxTokens = SEARCH_DEFAULTS.maxTokens;
  const searchBody = createSearchAdapter().searchBody({ model: SEARCH_ID, maxTokens, query: FIXED.query });
  const decisionTokens = utf8Bytes(JSON.stringify(decisionBody.messages)) + PROMPT_OVERHEAD_TOKENS;
  const dc = PRICE_CEILING.decision;
  const sc = PRICE_CEILING.search;
  const calls = [
    { id: 'decision_search_schema', role: 'decision', body: decisionBody, worstMicros: Math.ceil(decisionTokens * dc.inputPerM + decisionBody.max_tokens * dc.outputPerM) },
    // Retrieved content may count as prompt tokens (unverified), so the input bound is the ledger's own hold.
    { id: 'sonar', role: 'search', body: searchBody, worstMicros: Math.ceil(SEARCH_HOLD_INPUT_TOKENS * sc.inputPerM + maxTokens * sc.outputPerM + sc.requestUsd * 1e6) },
  ];
  return { calls, totalWorstMicros: calls.reduce((a, c) => a + c.worstMicros, 0), searchId: SEARCH_ID, decisionId: DECISION_ID };
}

export function printPlan(plan, say) {
  say('Search probe plan. Each call is sent once and never retried.');
  for (const c of plan.calls) say(`  ${c.id}: model ${c.body.model}, max_tokens ${c.body.max_tokens}, worst case ${usdUpText(c.worstMicros)}`);
  say(`Worst case in all: ${usdUpText(plan.totalWorstMicros)} (${plan.totalWorstMicros} micro-USD), at the ceilings: search input $${PRICE_CEILING.search.inputPerM}/M, output $${PRICE_CEILING.search.outputPerM}/M, $${PRICE_CEILING.search.requestUsd} per call; decision input $${PRICE_CEILING.decision.inputPerM}/M, output $${PRICE_CEILING.decision.outputPerM}/M.`);
  say(`Search query, the only text sent to ${SEARCH_ID} apart from the fixed instruction: ${FIXED.query}`);
  say(`Decision input (with persona/decision-prompt.zh.md and persona/${SEARCH_ADDENDUM_FILE}): ${JSON.stringify(FIXED.decisionInput)}`);
  say(`Also: two reads of /key with ${PROBE_KEY_NAME} (not charged) and one catalog read with no Key.`);
  say(`Results: captures/${RESULT_FILE}, field names, numbers and classifications only.`);
}

// --- catalog ---

const PRICE_FIELD_NAME = /^[a-z][a-z0-9_]{0,40}$/;
const fieldNames = (o) => (isObj(o) ? Object.keys(o).filter((k) => PRICE_FIELD_NAME.test(k)).slice(0, 32) : []);

// The prices of both models, checked against the ceilings. A problem refuses the run.
export function checkCatalog(catalog) {
  const problems = [];
  let searchPrice = null;
  let decisionPrice = null;
  const row = catalog?.find?.((r) => r?.id === SEARCH_ID) ?? null;
  try {
    searchPrice = searchPriceFor(SEARCH_ID, catalog);
    const c = PRICE_CEILING.search;
    if (searchPrice.inputPerM > c.inputPerM || searchPrice.outputPerM > c.outputPerM || searchPrice.requestUsd > c.requestUsd) problems.push('search_price_above_ceiling');
  } catch (e) {
    problems.push(/unknown price field/.test(e.message) ? 'search_price_field_unknown' : /not in the catalog/.test(e.message) ? 'search_model_missing' : 'search_price_missing');
  }
  try {
    decisionPrice = priceFor(DECISION_ID, catalog);
    const c = PRICE_CEILING.decision;
    if (decisionPrice.inputPerM > c.inputPerM || decisionPrice.outputPerM > c.outputPerM) problems.push('decision_price_above_ceiling');
  } catch {
    problems.push('decision_price_missing');
  }
  return { problems, searchPrice, decisionPrice, priceFields: fieldNames(row?.pricing), parameters: Array.isArray(row?.supported_parameters) ? row.supported_parameters.filter((p) => typeof p === 'string' && PRICE_FIELD_NAME.test(p)).slice(0, 32) : [] };
}

// --- results: numbers and classifications only ---

const RESULT_KEYS = new Set([
  'at', 'kind', 'id', 'role', 'class', 'reason', 'httpStatus', 'finishReason', 'promptTokens', 'completionTokens', 'costUsd', 'costPresent',
  'tokenCostUsd', 'countedUsd', 'worstUsd', 'aboveWorst', 'usageMissing', 'durationMs', 'modelMatches', 'bodyKeys', 'usageKeys', 'citationShapes',
  'annotationCount', 'searchResultCount', 'citationCount', 'titlesPresent', 'sourceCount', 'parsed', 'needSearch', 'queryCount', 'errorType',
  'errorCode', 'metadataKeys', 'limitSource', 'keyLimitUsd', 'keyRemainingUsd', 'keyLimitReset', 'usageDailyPresent', 'usageDailyType',
  'keyFields', 'keyDeltaUsd', 'keyDailyDeltaUsd', 'priceFields', 'parameters', 'searchInputPerM', 'searchOutputPerM', 'searchRequestUsd',
  'decisionInputPerM', 'decisionOutputPerM', 'problems', 'stopReason', 'completed', 'flags', 'totalUsd', 'capUsd', 'maxUsd', 'planCalls',
  'reportedUsd', 'countedAtWorstUsd', 'missingCount', 'testMode', 'searchModel', 'decisionModel',
]);
const SAFE_STRING = /^[A-Za-z0-9_.:/~+-]{1,64}$/;
const KEY_SHAPED = /^sk-|sk-or-/i;
const safeText = (v) => typeof v === 'string' && SAFE_STRING.test(v) && !KEY_SHAPED.test(v);
const safeScalar = (v) => v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || safeText(v);

// The last gate: a key outside the list, a string with a space or any non-ASCII text, or anything shaped like a
// provider key never reaches the file.
export function sanitizeResult(line) {
  const out = {};
  for (const [k, v] of Object.entries(line)) {
    if (!RESULT_KEYS.has(k)) continue;
    if (Array.isArray(v)) out[k] = v.filter(safeText).slice(0, 32);
    else if (safeScalar(v)) out[k] = v;
  }
  return out;
}

const scrub = (text, secrets) => secrets.reduce((acc, s) => acc.split(s).join('[hidden]'), text);

// Off Windows the file is 0600 and its folder 0700, as q5-probe's results are.
export function resultWriter(path, secrets = []) {
  if (IS_WINDOWS) mkdirSync(dirname(path), { recursive: true });
  else mkdirPrivate(dirname(path));
  const append = IS_WINDOWS ? (text) => appendFileSync(path, text) : privateAppender(path);
  return (line) => append(`${scrub(JSON.stringify(sanitizeResult({ at: new Date().toISOString(), ...line })), secrets)}\n`);
}

// What a Sonar answer looks like, as names and counts. The adapter reads it the way the bot would; its text, sources
// and the URLs stay in memory here and are dropped.
export function sonarFacts(status, body, plan) {
  const adapter = createSearchAdapter();
  const call = plan.calls.find((c) => c.role === 'search');
  const c = adapter.classify(status, body, adapter.requestedModel(call.body));
  const message = body?.choices?.[0]?.message;
  const annotations = Array.isArray(message?.annotations) ? message.annotations.filter((a) => a?.type === 'url_citation') : [];
  const results = Array.isArray(body?.search_results) ? body.search_results : [];
  const citations = Array.isArray(body?.citations) ? body.citations : [];
  const titled = (t) => typeof t === 'string' && t.trim() !== '';
  const shapes = [];
  if (annotations.length) shapes.push('annotations');
  if (results.length) shapes.push('search_results');
  if (citations.length) shapes.push('citations');
  return {
    class: c.kind,
    reason: c.reason,
    finishReason: c.finishReason,
    modelMatches: isObj(body) && body.model === call.body.model,
    bodyKeys: fieldNames(body),
    usageKeys: fieldNames(body?.usage),
    citationShapes: shapes,
    annotationCount: annotations.length,
    searchResultCount: results.length,
    citationCount: citations.length,
    titlesPresent: annotations.some((a) => titled(a?.url_citation?.title)) || results.some((r) => titled(r?.title)),
    sourceCount: c.sources.length,
  };
}

// What the decision answer says about the schema: whether it parses with search on, and the counts. No query text.
export function decisionFacts(body) {
  const content = body?.choices?.[0]?.message?.content;
  const answer = typeof content === 'string' ? parseAnswer(content, { search: true }) : null;
  return {
    class: answer ? 'ok' : 'unparsed',
    finishReason: typeof body?.choices?.[0]?.finish_reason === 'string' && SAFE_STRING.test(body.choices[0].finish_reason) ? body.choices[0].finish_reason : null,
    modelMatches: isObj(body) && typeof body.model === 'string' && body.model.startsWith(DECISION_ID),
    parsed: answer !== null,
    needSearch: answer?.search?.need ?? null,
    queryCount: answer?.search?.queries?.length ?? null,
    usageKeys: fieldNames(body?.usage),
  };
}

// A body differing in anything from the plan, or carrying a field outside the list, is not sent.
export function presendRefusal(body, call) {
  if (!isDeepStrictEqual(body, call.body)) return 'body_changed';
  if (call.role === 'search' && Object.keys(body).some((k) => !SEARCH_BODY_KEYS.includes(k))) return 'body_field';
  return null;
}

const parseJson = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

function decisionTokenMicros(usage, price) {
  const p = num(usage?.prompt_tokens);
  const o = num(usage?.completion_tokens);
  if (!price || (p === null && o === null)) return null;
  return Math.ceil((p ?? 0) * price.inputPerM + (o ?? 0) * price.outputPerM);
}

async function paidCall({ http, baseUrl, key, call, tracker, record, signal, prices }) {
  const line = { kind: 'call', id: call.id, role: call.role, worstUsd: round6(call.worstMicros) };
  const refusal = presendRefusal(call.body, call);
  if (refusal) {
    record({ ...line, class: 'not_sent', reason: refusal });
    return { line, stop: refusal };
  }
  const started = Date.now();
  let status = null;
  let body = null;
  try {
    const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
    const res = await http(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(call.body),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    status = res.status;
    body = parseJson(await res.text());
  } catch {
    // The request may have been billed. Counted at worst below, and not sent again.
    line.class = signal?.aborted ? 'interrupted' : 'network';
  }
  line.durationMs = Date.now() - started;
  line.httpStatus = status;
  let stop = line.class === 'interrupted' ? 'interrupted' : line.class === 'network' ? 'network' : null;
  if (!line.class) {
    if (status < 200 || status >= 300 || body?.error) {
      const c = classifyError(status, body?.error ?? null);
      Object.assign(line, { class: c.class, errorCode: c.errorCode, errorType: c.errorType, metadataKeys: c.metadataKeys, limitSource: c.limitSource });
      if (c.stop || STOP_STATUS.has(status)) stop = c.class;
    } else if (body === null) {
      line.class = 'bad_json';
    } else {
      Object.assign(line, call.role === 'search' ? sonarFacts(status, body, { calls: [call] }) : decisionFacts(body));
    }
  }
  line.promptTokens = num(body?.usage?.prompt_tokens);
  line.completionTokens = num(body?.usage?.completion_tokens);
  const reported = reportedCostMicros(body?.usage);
  line.costPresent = reported !== null;
  line.costUsd = reported === null ? null : round6(reported);
  const byTokens = call.role === 'search'
    ? (searchMicros(mapUsage(body?.usage, body?.model), prices?.search)?.micros ?? null)
    : decisionTokenMicros(body?.usage, prices?.decision);
  line.tokenCostUsd = byTokens === null ? null : round6(byTokens);
  if (reported === null && byTokens === null) {
    // No figure is not a free call.
    tracker.addMissing(call.worstMicros);
    Object.assign(line, { usageMissing: true, countedUsd: round6(call.worstMicros) });
  } else {
    const counted = Math.max(reported ?? 0, byTokens ?? 0);
    tracker.addReported(counted);
    line.usageMissing = false;
    line.countedUsd = round6(counted);
    // The plan's bound was wrong: the next call's bound cannot be trusted either.
    if (counted > call.worstMicros) {
      line.aboveWorst = true;
      stop ??= 'above_worst';
    }
  }
  record(line);
  return { line, stop };
}

// --- the Key ---

async function readKey({ http, baseUrl, key }) {
  let res;
  let body;
  try {
    res = await http(`${baseUrl}/key`, { method: 'GET', headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(KEY_TIMEOUT_MS) });
    body = parseJson(await res.text());
  } catch {
    return { ok: false, class: 'network', httpStatus: null };
  }
  if (!res.ok) {
    const c = classifyError(res.status, body?.error ?? null);
    return { ok: false, class: c.class, httpStatus: res.status, metadataKeys: c.metadataKeys };
  }
  const d = body?.data;
  if (num(d?.usage) === null) return { ok: false, class: 'bad_shape', httpStatus: res.status };
  return {
    ok: true,
    usage: d.usage,
    usageDaily: num(d.usage_daily),
    usageDailyPresent: isObj(d) && 'usage_daily' in d,
    usageDailyType: isObj(d) && 'usage_daily' in d ? (d.usage_daily === null ? 'null' : typeof d.usage_daily) : null,
    limit: num(d.limit),
    remaining: num(d.limit_remaining),
    limitReset: typeof d.limit_reset === 'string' && SAFE_STRING.test(d.limit_reset) ? d.limit_reset : null,
    fields: fieldNames(d),
  };
}

// --- the run ---

export async function runSearchProbe({ plan, baseUrl, key, maxUsd, resultPath, say, fetchImpl = globalThis.fetch, signal, testMode = false }) {
  const capMicros = Math.floor(maxUsd * 1e6);
  if (plan.totalWorstMicros > capMicros) throw new Error(`refused: worst case ${usdUpText(plan.totalWorstMicros)} is above --max-usd`);
  const http = restrictedFetch(baseUrl, fetchImpl);
  const tracker = createSpendTracker(capMicros);
  const record = resultWriter(resultPath, [key]);
  let stopReason = null;
  const stopWith = (reason) => {
    stopReason = reason;
    record({ kind: 'stop', stopReason: reason });
  };
  record({ kind: 'run_start', planCalls: plan.calls.length, worstUsd: round6(plan.totalWorstMicros), maxUsd, searchModel: plan.searchId, decisionModel: plan.decisionId, testMode });

  const key0 = await readKey({ http, baseUrl, key });
  if (!key0.ok) {
    record({ kind: 'key_read', class: key0.class, httpStatus: key0.httpStatus, metadataKeys: key0.metadataKeys ?? [] });
    stopWith(`key_read_${key0.class}`);
  } else {
    record({ kind: 'key_read', class: 'ok', keyLimitUsd: key0.limit, keyRemainingUsd: key0.remaining, keyLimitReset: key0.limitReset, usageDailyPresent: key0.usageDailyPresent, usageDailyType: key0.usageDailyType, keyFields: key0.fields });
    if (key0.limit === null || key0.limitReset !== 'daily') {
      stopWith('no_daily_limit');
      say('Refused: this Key has no daily limit. Set one on OpenRouter (limit_reset daily) and run again. No paid call was made.');
    } else if (key0.limit * 1e6 > capMicros) {
      stopWith('key_limit_above_cap');
      say(`Refused: this Key's daily limit $${key0.limit} is above --max-usd $${maxUsd}. Lower the limit on OpenRouter, or raise --max-usd to it. No paid call was made.`);
    }
  }

  let prices = null;
  if (!stopReason) {
    try {
      const checked = checkCatalog(await fetchCatalog({ fetch: http, baseUrl, timeoutMs: CATALOG_TIMEOUT_MS }));
      prices = { search: checked.searchPrice, decision: checked.decisionPrice };
      const line = { kind: 'catalog', priceFields: checked.priceFields, parameters: checked.parameters, problems: checked.problems,
        searchInputPerM: checked.searchPrice?.inputPerM ?? null, searchOutputPerM: checked.searchPrice?.outputPerM ?? null, searchRequestUsd: checked.searchPrice?.requestUsd ?? null,
        decisionInputPerM: checked.decisionPrice?.inputPerM ?? null, decisionOutputPerM: checked.decisionPrice?.outputPerM ?? null };
      if (checked.problems.length) {
        record({ ...line, class: 'refused' });
        stopWith(`catalog_${checked.problems[0]}`);
        say(`Refused before any paid call. Catalog problems: ${checked.problems.join(', ')}.`);
      } else {
        record({ ...line, class: 'ok' });
      }
    } catch (e) {
      // Only a class, never the error text: timeout, an HTTP status, a body that is not the catalog, or other.
      const status = /HTTP (\d{3})/.exec(String(e?.message))?.[1];
      const why = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout'
        : status ? `http_${status}`
          : /unexpected shape/.test(String(e?.message)) ? 'shape' : 'other';
      record({ kind: 'catalog', class: 'read_failed', reason: why });
      stopWith('catalog_read_failed');
    }
  }

  let paid = false;
  if (!stopReason) {
    for (const call of plan.calls) {
      if (signal?.aborted) {
        stopWith('interrupted');
        break;
      }
      if (!tracker.canAfford(call.worstMicros)) {
        stopWith('cap');
        say(`Stopped before ${call.id}: it could pass the cap.`);
        break;
      }
      const { line, stop } = await paidCall({ http, baseUrl, key, call, tracker, record, signal, prices });
      paid = paid || line.class !== 'not_sent';
      say(`${call.id}: ${line.class}${line.httpStatus ? ` (HTTP ${line.httpStatus})` : ''}, counted $${line.countedUsd ?? 0}${line.usageMissing ? ' (no usage, counted at worst case)' : ''}.`);
      if (stop) {
        stopWith(stop);
        say(`Stopped: ${stop}. Not retried.`);
        break;
      }
    }
  }

  const flags = [];
  if (paid && key0.ok) {
    const k = await readKey({ http, baseUrl, key });
    const totals = tracker.totals();
    if (!k.ok) {
      flags.push('key_unreadable');
      record({ kind: 'key_check', class: k.class, httpStatus: k.httpStatus, flags });
      say('Could not read the Key at the end, so the spend could not be compared with it. Check OpenRouter by hand.');
    } else {
      const delta = Math.round((k.usage - key0.usage) * 1e6);
      const dailyDelta = k.usageDaily !== null && key0.usageDaily !== null ? Math.round((k.usageDaily - key0.usageDaily) * 1e6) : null;
      if (delta > capMicros) flags.push('key_delta_above_cap');
      if (delta > totals.totalMicros + KEY_TOLERANCE_MICROS) flags.push('key_delta_above_tracker');
      record({ kind: 'key_check', class: 'ok', keyDeltaUsd: round6(delta), keyDailyDeltaUsd: dailyDelta === null ? null : round6(dailyDelta), usageDailyPresent: k.usageDailyPresent, usageDailyType: k.usageDailyType, totalUsd: round6(totals.totalMicros), capUsd: round6(capMicros), flags });
      say(`Key spend since the start: ${usdText(delta)}${dailyDelta === null ? ' (no usage_daily figure)' : `, usage_daily moved ${usdText(dailyDelta)}`}; counted here ${usdText(totals.totalMicros)}, cap ${usdText(capMicros)}. The Key can lag behind, so a lower figure proves nothing.`);
    }
  }

  const totals = tracker.totals();
  record({ kind: 'summary', completed: stopReason === null, stopReason, flags, reportedUsd: round6(totals.reportedMicros), countedAtWorstUsd: round6(totals.countedAtWorstMicros), missingCount: totals.missingCount, totalUsd: round6(totals.totalMicros), capUsd: round6(capMicros) });
  say(stopReason ? `Run stopped: ${stopReason}.` : 'Run finished.');
  say(`Counted spend: ${usdText(totals.totalMicros)} (${totals.missingCount} counted at worst case), cap ${usdText(capMicros)}.`);
  say('Nothing was changed: config.json, versions.lock.json and .env were not written. Record the findings in DECISIONS.md by hand, as one sample.');
  return { stopReason, totals, flags };
}

// --- command line ---

const USAGE = `Usage: search-probe [--approve --max-usd <dollars>]
Without --approve it prints the plan and exits. No request is made and .env is not read.
With --approve it reads ${PROBE_KEY_NAME} from .env, a separate OpenRouter Key whose daily limit is at or below --max-usd.`;

export function parseCli(argv) {
  const out = { approve: false, maxUsd: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--approve') {
      out.approve = true;
    } else if (a === '--max-usd') {
      i += 1;
      if (!/^\d+(\.\d+)?$/.test(argv[i] ?? '') || Number(argv[i]) <= 0) return { error: '--max-usd needs a positive number of dollars.' };
      out.maxUsd = Number(argv[i]);
    } else {
      return { error: 'Unknown argument. This tool takes no free text.' };
    }
  }
  return out;
}

// In test mode the base must be a loopback mock. Outside it the address is fixed, and the override is refused.
export function resolveEndpoint(env) {
  const testMode = Boolean(env.CLO_TEST_ROOT);
  if (!testMode) {
    if (env.CLO_SEARCH_PROBE_TEST_BASE) throw new Error('CLO_SEARCH_PROBE_TEST_BASE is only allowed in test mode.');
    return { baseUrl: OPENROUTER_BASE_URL, testMode };
  }
  if (!env.CLO_SEARCH_PROBE_TEST_BASE || !isLoopback(env.CLO_SEARCH_PROBE_TEST_BASE)) throw new Error('Test mode needs a loopback CLO_SEARCH_PROBE_TEST_BASE.');
  return { baseUrl: env.CLO_SEARCH_PROBE_TEST_BASE, testMode };
}

export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, fetchImpl = globalThis.fetch } = {}) {
  let secrets = [];
  const say = (text = '') => stdout.write(`${scrub(String(text), secrets)}\n`);
  const fail = (text) => stderr.write(`${scrub(String(text), secrets)}\n`);
  const cli = parseCli(argv);
  if (cli.error) {
    fail(`${cli.error}\n${USAGE}`);
    return 2;
  }
  const paths = resolvePaths(env);
  const plan = buildPlan(paths.repoRoot);
  printPlan(plan, say);
  say('');
  if (!cli.approve) {
    say('Not approved, so no request was made and .env was not read. Run with --approve --max-usd <dollars> after the user has agreed to spend.');
    return 0;
  }
  if (cli.maxUsd === null) {
    fail('--approve needs an explicit --max-usd.');
    return 2;
  }
  if (plan.totalWorstMicros > Math.floor(cli.maxUsd * 1e6)) {
    fail(`Refused: the worst case ${usdUpText(plan.totalWorstMicros)} is above --max-usd $${cli.maxUsd}. Nothing was sent.`);
    return 2;
  }
  const proxies = Object.keys(env).filter((k) => /proxy/i.test(k));
  if (proxies.length) {
    fail(`Refused: proxy variables are set (${proxies.join(', ')}). This project does not use a proxy.`);
    return 2;
  }
  let endpoint;
  try {
    endpoint = resolveEndpoint(env);
  } catch (e) {
    fail(e.message);
    return 2;
  }
  // The one read of .env, and only this name comes back.
  const key = parseEnvFile(paths.envFile, [PROBE_KEY_NAME])[PROBE_KEY_NAME];
  if (!key) {
    fail(`${PROBE_KEY_NAME} is empty in .env. This probe does not use the chat or the search Key. Create a separate OpenRouter Key for it, with a daily limit at or below --max-usd ($${cli.maxUsd}), and put it in .env as ${PROBE_KEY_NAME}.`);
    return 2;
  }
  secrets = [key];
  const ac = new AbortController();
  const stopWatching = watchStopSignals(ac);
  try {
    const out = await runSearchProbe({ plan, baseUrl: endpoint.baseUrl, key, maxUsd: cli.maxUsd, resultPath: join(paths.root, 'captures', RESULT_FILE), say, fetchImpl, signal: ac.signal, testMode: endpoint.testMode });
    return out.stopReason ? 1 : 0;
  } catch (e) {
    fail(`Stopped: ${e.message}`);
    return 1;
  } finally {
    stopWatching();
  }
}

if (IS_WINDOWS ? resolve(process.argv[1] ?? '').toLowerCase() === SELF.toLowerCase() : isEntryPath(process.argv[1], import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
