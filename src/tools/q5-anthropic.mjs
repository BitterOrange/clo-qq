// Q5 paid probe for the Anthropic Messages API, apart from q5-probe.mjs. It measures what the offline suite cannot:
// stop_reason and the model echo, usage.speed and usage.inference_geo, the cache write of a cold turn and the cache
// read of a warm one, thinking tokens on Opus at effort low, a Haiku decision with thinking disabled, and the cost
// counted from tokens against a static bound.
//
// Safeguards:
// - Without --approve it prints the plan and exits. No request, and .env is not read.
// - Three model calls at most: two Opus turns with the same system text (cold, then warm) and one Haiku decision.
//   Before them, a model check reads GET /v1/models/{id} for both ids. Nothing else is requested.
// - The whole run is bounded before it starts: every input-side token at the dearest standard input rate, every
//   max_tokens token at the output rate, both from the price book in versions.lock.json, times 1.1 for inference
//   served from the US only, which a workspace default could apply. The plan refuses to exist above $0.10.
// - Anthropic enforces no per-key daily limit. The only provider-side stop is the probe workspace's monthly spend
//   limit or its prepaid balance with auto-reload off, so the run needs --hard-cap-attested as well.
// - Every request is checked before it leaves: the host, the path, the three headers, and the exact body (no stream,
//   no fallbacks, no beta header, no tools, one cache_control with no ttl on the system text of a turn). A request
//   unlike the planned one is refused before it leaves, and the run stops.
// - No call is retried, not even a connect failure that surely sent nothing. A request that left with no usage
//   counts at its bound: no figure is not a free call.
// - The Key is CLO_TEST_ANTHROPIC_API_KEY, read from .env at run time and used only in the x-api-key header. It never
//   reaches a log, an Error, the command line or the results.
// - Results hold numbers and classifications only, in captures/q5-anthropic.jsonl. No prompt, answer, error message,
//   request id or stop detail is kept. config.json is neither read nor changed.
//
// Facts this tool rests on that only the paid run can confirm are marked unverified where they are used.
// Run through scripts\q5-anthropic.ps1, which uses the private Node.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { isLoopback } from '../cli/common.mjs';
import { parseEnvFile } from '../cli/lifecycle.mjs';
import { resolvePaths } from '../clo-plugin/lib/core/config.js';
import { buildRequest as buildDecisionRequest, parseAnswer } from '../clo-plugin/lib/core/decision.js';
import { checkAnthropicModels, priceBookProblems } from '../clo-plugin/lib/core/models.js';
import { anthropicAdapter } from '../clo-plugin/lib/core/providers/anthropicAdapter.js';
import { computeMicros, worstCaseMicros } from '../clo-plugin/lib/core/providers/cost.js';
import { createChatClient } from '../clo-plugin/lib/core/providers/modelChat.js';
import { ANTHROPIC_VERSION, DEFAULT_BASE, PROBE_KEY_ENV } from '../clo-plugin/lib/core/providers/registry.js';
import { renderUserMessage } from '../clo-plugin/lib/core/turn.js';

const SELF = fileURLToPath(import.meta.url);

// The ids a person agrees to when reading the plan. Concrete ids only: no alias, no dated snapshot.
export const PRIMARY_ID = 'claude-opus-5-5';
export const DECISION_ID = 'claude-haiku-5-5';
// The amount the user agreed to for this probe. The plan refuses to exist above it.
export const PROBE_CAP_MICROS = 100000;
// Probe only; production keeps claudeModel.maxTokens. Opus 5.5 thinking cannot be turned off and counts toward it, so
// the run records whether a turn at effort low ends at max_tokens.
export const PROBE_MAX_TOKENS = 1000;
export const PRIMARY_EFFORT = 'low';
// Decision D9: config effort 'none' is sent as thinking disabled at effort low, by the adapter.
export const DECISION_EFFORT = 'none';
export const DECISION_MAX_TOKENS = 200;
// A token covers at least one byte of UTF-8, so the bytes of the whole request body bound its text. This covers what
// the API adds around it. Unverified: how much the structured-output format adds to the decision's input; Haiku is
// cheap, so its allowance is large.
export const TURN_OVERHEAD_TOKENS = 500;
export const DECISION_OVERHEAD_TOKENS = 4000;
export const PROBE_KEY_NAME = PROBE_KEY_ENV.anthropic;
// In test mode the base is a loopback mock named here. Outside test mode the base is fixed.
export const TEST_BASE_ENV = 'CLO_Q5_ANTHROPIC_TEST_BASE';
export const RESULT_FILE = join('captures', 'q5-anthropic.jsonl');

// Every text this tool can send, apart from the two persona files named in the plan.
export const FIXED = Object.freeze({
  turns: Object.freeze(['一年有几个季节？', '春天大概是几月到几月？']),
  decisionInput: Object.freeze({
    trigger: 'ordinary',
    lines: Object.freeze([Object.freeze({ sender: '群友1', text: '今天天气不错，下午打算去公园走走。' })]),
    current: Object.freeze({ sender: '群友2', text: '有人知道公园几点关门吗？' }),
  }),
});
// The system text of both turns. The whole persona prompt is about 11 KB, and two turns of it cannot be bounded under
// $0.10 by bytes; the content policy is the block every turn sends first, and long enough to be cached.
const SYSTEM_FILE = 'CONTENT-POLICY.md';
const DECISION_PROMPT_FILE = 'decision-prompt.zh.md';
// The same retention the decision call uses by default.
const DECISION_RETENTION = Object.freeze({ decisionLines: 15, decisionLineChars: 200, decisionCurrentChars: 800 });
// A stand-in label, as the gate would give one. No ID reaches the model.
const MEMBER_LABEL = 'U1';
// A fixed moment for the printed preview. The run uses the time it sends at; the stamp has a fixed length.
const PREVIEW_AT = Date.UTC(2026, 0, 1, 4, 0);
const CALL_TIMEOUT_MS = 120000;
const MODEL_CHECK_TIMEOUT_MS = 15000;

const utf8Bytes = (text) => Buffer.byteLength(text, 'utf8');
const usdText = (micros) => `$${(micros / 1e6).toFixed(6)}`;
const round6 = (micros) => Number((micros / 1e6).toFixed(6));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const parseJson = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

// --- the plan ---

const turnOf = (text, at) => ({ cls: 'at', senderLabel: MEMBER_LABEL, speakerLabel: null, text, history: [], receivedAt: at, msgTs: at });

// The decision's user text and schema, as the decision call builds them. Only the two are taken from the OpenRouter
// request; the Anthropic body comes from the adapter.
function decisionParts(prompt) {
  const eff = { models: { decision: { id: DECISION_ID, effort: DECISION_EFFORT, maxTokens: DECISION_MAX_TOKENS } }, retention: DECISION_RETENTION };
  const req = buildDecisionRequest(eff, prompt, FIXED.decisionInput);
  const format = req.response_format.json_schema;
  return { user: req.messages[1].content, schema: { name: format.name, schema: format.schema } };
}

// The exact body of a call. adapter is the real one for the plan and the pre-send check; tests pass another to show
// that a body unlike it never leaves.
export function callBody(plan, call, at, adapter = anthropicAdapter) {
  if (call.role === 'decision') {
    return adapter.decisionBody({ model: plan.decisionId, effort: DECISION_EFFORT, maxTokens: call.maxTokens, system: plan.texts.decisionPrompt, user: plan.decision.user, schema: plan.decision.schema });
  }
  return adapter.turnBody({ model: plan.primaryId, effort: PRIMARY_EFFORT, maxTokens: call.maxTokens, system: plan.texts.system, user: renderUserMessage(turnOf(call.text, at)) });
}

// The input bound of a body, in tokens: its bytes plus the allowance.
export const inputBoundTokens = (body, overhead) => utf8Bytes(JSON.stringify(body)) + overhead;

function readBook(repoRoot) {
  const lock = JSON.parse(readFileSync(join(repoRoot, 'versions.lock.json'), 'utf8').replace(/^﻿/, ''));
  const book = lock?.models?.priceBooks?.anthropic;
  const problems = priceBookProblems(book);
  if (problems.length) throw new Error(`q5-anthropic: the price book is not usable (${problems.map((p) => p.path).join(', ')})`);
  const prices = {};
  for (const [role, id] of [['primary', PRIMARY_ID], ['decision', DECISION_ID]]) {
    if (!Object.hasOwn(book.models, id)) throw new Error(`q5-anthropic: the price book has no ${role} model`);
    if (book.unverified.some((p) => p === id || p.startsWith(`${id}.`))) throw new Error(`q5-anthropic: the ${role} price is marked unverified`);
    prices[role] = structuredClone(book.models[id]);
  }
  return { checkedOn: book.checkedOn, source: book.source, prices };
}

// The bound of one call, with and without the US-only multiplier, from the price card that many tokens fall on.
function boundOf(inputTokens, maxTokens, price) {
  return {
    boundMicros: worstCaseMicros({ input: inputTokens, output: maxTokens }, price),
    preGeoMicros: worstCaseMicros({ input: inputTokens, output: maxTokens }, price, { geoUs: false }),
  };
}

// options.maxTokens exists for the bound test only.
export function buildPlan(repoRoot, { maxTokens = PROBE_MAX_TOKENS, capMicros = PROBE_CAP_MICROS } = {}) {
  const read = (name) => readFileSync(join(repoRoot, 'persona', name), 'utf8');
  const files = [SYSTEM_FILE, DECISION_PROMPT_FILE].map((name) => {
    const text = read(name);
    return { name, text, bytes: utf8Bytes(text), sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
  });
  const book = readBook(repoRoot);
  const plan = {
    primaryId: PRIMARY_ID,
    decisionId: DECISION_ID,
    probeMaxTokens: maxTokens,
    capMicros,
    files,
    book: { checkedOn: book.checkedOn, source: book.source },
    prices: book.prices,
    texts: { system: files[0].text, decisionPrompt: files[1].text },
  };
  plan.decision = decisionParts(plan.texts.decisionPrompt);
  const planned = [
    { id: 'turn_cold', role: 'primary', text: FIXED.turns[0], maxTokens, overhead: TURN_OVERHEAD_TOKENS },
    { id: 'turn_warm', role: 'primary', text: FIXED.turns[1], maxTokens, overhead: TURN_OVERHEAD_TOKENS },
    { id: 'decision', role: 'decision', text: null, maxTokens: DECISION_MAX_TOKENS, overhead: DECISION_OVERHEAD_TOKENS },
  ];
  plan.calls = planned.map((c) => {
    const body = callBody(plan, c, PREVIEW_AT);
    const inputTokens = inputBoundTokens(body, c.overhead);
    return { ...c, body, bodyBytes: utf8Bytes(JSON.stringify(body)), inputTokens, ...boundOf(inputTokens, c.maxTokens, plan.prices[c.role]) };
  });
  plan.totalWorstMicros = plan.calls.reduce((a, c) => a + c.boundMicros, 0);
  plan.totalPreGeoMicros = plan.calls.reduce((a, c) => a + c.preGeoMicros, 0);
  if (plan.totalWorstMicros > capMicros) {
    throw new Error(`q5-anthropic: the static bound ${usdText(plan.totalWorstMicros)} is above the agreed ${usdText(capMicros)}`);
  }
  return plan;
}

const inputRate = (price) => Math.max(price.inputPerM, price.cacheWritePerM);

export function printPlan(plan, say) {
  say('Q5 paid probe for the Anthropic API: plan');
  say(`Models: primary ${plan.primaryId} at effort ${PRIMARY_EFFORT} (no thinking field: Opus 5.5 thinking cannot be turned off), decision ${plan.decisionId} with thinking disabled and effort low (config effort ${DECISION_EFFORT}).`);
  say(`Requests: GET /v1/models/${plan.primaryId} and GET /v1/models/${plan.decisionId} first (they generate no tokens; whether they are charged is not documented), then ${plan.calls.length} POST /v1/messages, one per call, in this order: ${plan.calls.map((c) => c.id).join(', ')}. Nothing is retried, not even a connect failure.`);
  say(`Host: ${DEFAULT_BASE.anthropic} only. Headers: x-api-key, anthropic-version ${ANTHROPIC_VERSION}, content-type. No beta header, no stream, no fallbacks, no tools, no speed, no inference_geo.`);
  say('');
  say(`Static bound, from the price book in versions.lock.json (checked on ${plan.book.checkedOn}; source: ${plan.book.source}). The book is entered by hand; the bound is only as right as it is.`);
  say(`Input tokens are bounded by the bytes of the exact request body plus an allowance (${TURN_OVERHEAD_TOKENS} for a turn, ${DECISION_OVERHEAD_TOKENS} for the decision), all priced at the dearer of the input and five-minute cache-write rates. Output is max_tokens at the output rate. Then x1.1, for inference served from the US only, which a workspace default could apply.`);
  for (const c of plan.calls) {
    const p = plan.prices[c.role];
    say(`  ${c.id}: (${c.bodyBytes} body bytes + ${c.overhead}) = ${c.inputTokens} tokens x $${inputRate(p)}/M + ${c.maxTokens} x $${p.outputPerM}/M = ${usdText(c.preGeoMicros)}; x 1.1 = ${usdText(c.boundMicros)}.`);
  }
  say(`  Total: ${usdText(plan.totalPreGeoMicros)} before the US-only multiplier, ${usdText(plan.totalWorstMicros)} with it (${plan.totalWorstMicros} micro-USD). The agreed cap is ${usdText(plan.capMicros)}; --max-usd must be at least the bound.`);
  say('What the bound rests on: the price book being right, output tokens within max_tokens, input tokens within the bound above, no one-hour cache write and no fast mode (neither is requested). Each is checked after a call, and a breach stops the run before the next one, so the call that breached was already charged.');
  say('A call that left and came back with no usage, an HTTP error or a lost connection counts at its bound.');
  say('');
  say('Anthropic enforces no per-key daily limit. The only stop on the provider side is the spend limit of the workspace this Key belongs to, which is monthly, or its prepaid balance with auto-reload off. The run needs --hard-cap-attested: that CLO_TEST_ANTHROPIC_API_KEY is a Key of a dedicated probe workspace whose spend limit or prepaid balance is no more than you accept to lose. No program reads that limit.');
  say('Afterwards, compare the counted figures with the usage page of the Console by hand.');
  say('');
  say('Exact texts sent:');
  say(`  ${plan.calls[0].id} and ${plan.calls[1].id}: system persona/${SYSTEM_FILE} (one cache_control at its end, default five-minute lifetime). User messages, as the bot frames them; only the time differs in the run:`);
  for (const c of plan.calls.filter((x) => x.role === 'primary')) say(`    ${c.id}:\n${c.body.messages[0].content}`);
  say(`  ${plan.calls[2].id}: system persona/${DECISION_PROMPT_FILE}, user ${plan.decision.user}`);
  say(`    format: json_schema ${JSON.stringify(plan.decision.schema.schema)}`);
  say('');
  for (const f of plan.files) {
    say(`--- persona/${f.name} (${f.bytes} bytes, sha256 ${f.sha256}) ---`);
    say(f.text.trimEnd());
  }
  say('--- end of files ---');
  say(`Results go to ${RESULT_FILE.replace(/\\/g, '/')}: numbers and classifications only.`);
}

// --- what may leave ---

const countKey = (v, key) => (v && typeof v === 'object'
  ? Object.entries(v).reduce((n, [k, x]) => n + (k === key ? 1 : 0) + countKey(x, key), 0)
  : 0);
const sameKeys = (obj, keys) => {
  const have = Object.keys(obj).sort();
  const want = [...keys].sort();
  return have.length === want.length && have.every((k, i) => k === want[i]);
};
const TURN_KEYS = ['max_tokens', 'messages', 'model', 'output_config', 'system'];
const DECISION_KEYS = ['max_tokens', 'messages', 'model', 'output_config', 'system', 'thinking'];
const POST_HEADERS = ['anthropic-version', 'content-type', 'x-api-key'];
const GET_HEADERS = ['anthropic-version', 'x-api-key'];

function headerProblem(headers, names, key) {
  if (!isObj(headers)) return 'presend_headers';
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (Object.keys(lower).some((k) => k.startsWith('anthropic-beta'))) return 'presend_beta_header';
  if (!sameKeys(lower, names) || Object.keys(headers).length !== names.length) return 'presend_headers';
  if (lower['anthropic-version'] !== ANTHROPIC_VERSION) return 'presend_headers';
  if (names.includes('content-type') && lower['content-type'] !== 'application/json') return 'presend_headers';
  if (lower['x-api-key'] !== key) return 'presend_key';
  return null;
}

// The checks on a model call before it may leave. Each has its own reason, which becomes the run's stop reason.
// expected is the body the real adapter builds for this call at the same moment.
export function presendRefusal(body, { call, plan, expected }) {
  if (!isObj(body)) return 'presend_unreadable';
  if ('stream' in body) return 'presend_stream';
  if ('fallbacks' in body) return 'presend_fallbacks';
  if ('tools' in body || 'tool_choice' in body) return 'presend_tools';
  const decision = call.role === 'decision';
  if (!sameKeys(body, decision ? DECISION_KEYS : TURN_KEYS)) return decision || !('thinking' in body) ? 'presend_fields' : 'presend_thinking';
  if (body.model !== (decision ? plan.decisionId : plan.primaryId)) return 'presend_model';
  if (body.max_tokens !== call.maxTokens) return 'presend_max_tokens';
  if (!Array.isArray(body.messages) || body.messages.length !== 1 || body.messages[0]?.role !== 'user' || !sameKeys(body.messages[0], ['content', 'role'])
    || body.messages[0].content !== expected.messages[0].content) return 'presend_messages';
  if (decision) {
    if (!isDeepStrictEqual(body.thinking, { type: 'disabled' })) return 'presend_thinking';
    if (!isDeepStrictEqual(body.output_config, expected.output_config)) return 'presend_output_config';
    if (countKey(body, 'cache_control') !== 0) return 'presend_cache_control';
    if (body.system !== plan.texts.decisionPrompt) return 'presend_system_changed';
  } else {
    if (!isDeepStrictEqual(body.output_config, { effort: PRIMARY_EFFORT })) return 'presend_output_config';
    const block = Array.isArray(body.system) && body.system.length === 1 && isObj(body.system[0]) ? body.system[0] : null;
    // With a ttl the one-hour write price applies, which the bound leaves out only while this refuses it.
    if (countKey(body, 'cache_control') !== 1 || !block || block.type !== 'text' || !sameKeys(block, ['cache_control', 'text', 'type'])
      || !isDeepStrictEqual(block.cache_control, { type: 'ephemeral' })) return 'presend_cache_control';
    if (block.text !== plan.texts.system) return 'presend_system_changed';
  }
  if (utf8Bytes(JSON.stringify(body)) > call.bodyBytes) return 'presend_bytes';
  if (!isDeepStrictEqual(body, expected)) return 'presend_body';
  return null;
}

const MODEL_PATHS = (plan) => new Set([plan.primaryId, plan.decisionId].map((id) => `/v1/models/${encodeURIComponent(id)}`));

// The only fetch the probe's requests go through. Out of a phase nothing may leave; in the model check only the two
// GETs; in a call one POST /v1/messages whose headers and body pass the checks. Every refusal throws before the request
// leaves, and says why in the slot. The response is read here as well, for the figures the adapter does not return.
export function createProbeFetch({ http, baseUrl, key, plan }) {
  const origin = new URL(baseUrl).origin;
  const modelPaths = MODEL_PATHS(plan);
  const refusedHosts = new Set();
  const requested = [];
  let phase = null;
  let slot = null;
  const refusals = [];
  const refuse = (reason) => {
    refusals.push(reason);
    if (slot) {
      slot.refused += 1;
      slot.refusedReason ??= reason;
    }
    throw new Error('q5-anthropic: a request unlike the planned one was refused before it left');
  };
  const probeFetch = async (url, init = {}) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      return refuse('presend_url');
    }
    if (target.origin !== origin) {
      refusedHosts.add(target.hostname);
      return refuse('presend_host');
    }
    const method = String(init.method ?? 'GET').toUpperCase();
    if (target.search || target.hash) return refuse('presend_path');
    if (phase === 'models') {
      if (method !== 'GET' || !modelPaths.has(target.pathname) || init.body !== undefined) return refuse('presend_path');
      const h = headerProblem(init.headers, GET_HEADERS, key);
      if (h) return refuse(h);
    } else if (phase === 'call' && slot) {
      if (method !== 'POST' || target.pathname !== '/v1/messages') return refuse('presend_path');
      if (slot.requests >= 1) return refuse('call_limit');
      const h = headerProblem(init.headers, POST_HEADERS, key);
      if (h) return refuse(h);
      const r = presendRefusal(parseJson(String(init.body ?? '')), { call: slot.call, plan, expected: slot.expected });
      if (r) return refuse(r);
      slot.requests += 1;
    } else {
      return refuse('presend_phase');
    }
    requested.push(`${method}:${target.pathname}`);
    const s = phase === 'call' ? slot : null;
    const res = await http(url, { ...init, redirect: 'error' });
    if (s) {
      s.status = res.status;
      try {
        s.observed = parseJson(await res.clone().text());
      } catch {
        // Cut off. The client sees the same, and the call counts at its bound.
      }
    }
    return res;
  };
  return {
    fetch: probeFetch,
    models() {
      phase = 'models';
      slot = null;
    },
    arm(next) {
      phase = 'call';
      slot = next;
    },
    disarm() {
      phase = null;
      slot = null;
    },
    refusedHosts: () => [...refusedHosts],
    requested: () => [...requested],
    refusals: () => [...refusals],
  };
}

// --- what is kept: numbers and classifications ---

const RESULT_KEYS = new Set([
  'at', 'kind', 'id', 'role', 'state', 'stopReason', 'class', 'reason', 'httpStatus', 'errorType', 'limitSource', 'stop', 'finish', 'modelMatches',
  'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cacheWrite1hTokens', 'thinkingTokens', 'thinkingBlocks', 'textBlocks',
  'contentChars', 'geo', 'speed', 'usageKeys', 'flags', 'usageMissing', 'computedUsd', 'countedUsd', 'worstUsd', 'preGeoWorstUsd', 'inputBoundTokens',
  'maxTokens', 'requests', 'refusedRequests', 'durationMs', 'cacheHit', 'decisionValid', 'problems', 'caps', 'maxUsd', 'capUsd', 'totalUsd',
  'missingCount', 'completed', 'primaryModel', 'decisionModel', 'testMode', 'planCalls', 'refusedHosts', 'refusedReasons', 'requested', 'name', 'tokens',
]);
const SAFE_STRING = /^[A-Za-z0-9_.:/-]{1,64}$/;
const KEY_SHAPED = /sk-ant-|sk-or-|^sk-/i;
const safeText = (v) => typeof v === 'string' && SAFE_STRING.test(v) && !KEY_SHAPED.test(v);
const safeScalar = (v) => v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || safeText(v);

// The last gate: a key outside the list, a string outside the safe set, or anything shaped like a Key never reaches
// the file. An object is kept only one level deep, with the same rules for its values.
export function sanitizeResult(line) {
  const out = {};
  for (const [k, v] of Object.entries(line)) {
    if (!RESULT_KEYS.has(k)) continue;
    if (Array.isArray(v)) out[k] = v.filter(safeText).slice(0, 32);
    else if (isObj(v)) out[k] = Object.fromEntries(Object.entries(v).filter(([n, x]) => /^[a-z_]{1,32}$/.test(n) && x !== undefined && safeScalar(x) && typeof x !== 'string'));
    else if (safeScalar(v)) out[k] = v;
  }
  return out;
}

function resultWriter(path, secrets) {
  mkdirSync(dirname(path), { recursive: true });
  return (line) => {
    const text = JSON.stringify(sanitizeResult({ at: new Date().toISOString(), ...line }));
    appendFileSync(path, `${secrets.reduce((acc, s) => acc.split(s).join('[hidden]'), text)}\n`);
  };
}

// Closed lists, so provider text cannot reach the file by being plain ASCII.
const STOP_REASONS = new Set(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'refusal', 'pause_turn', 'model_context_window_exceeded']);
const ERROR_TYPES = new Set(['invalid_request_error', 'authentication_error', 'billing_error', 'permission_error', 'not_found_error', 'request_too_large', 'rate_limit_error', 'api_error', 'overloaded_error', 'timeout_error']);
const GEOS = new Set(['us', 'global']);
const SPEEDS = new Set(['standard', 'fast']);
// Unverified beyond the token counts: which of these the API returns is what the run shows.
const USAGE_KEYS = new Set(['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'cache_creation', 'inference_geo', 'speed', 'service_tier', 'server_tool_use', 'output_tokens_details', 'iterations']);
const oneOf = (set, v) => (typeof v === 'string' && v ? (set.has(v) ? v : 'other') : null);

// What the raw response says beyond the adapter's usage, as numbers and closed classes. Text is counted, never kept.
function observe(obs, requestedModel) {
  const usage = isObj(obs?.usage) ? obs.usage : null;
  const content = Array.isArray(obs?.content) ? obs.content : [];
  return {
    stop: oneOf(STOP_REASONS, obs?.stop_reason),
    modelMatches: typeof obs?.model === 'string' ? obs.model === requestedModel : null,
    // Unverified field: usage.output_tokens_details.thinking_tokens, where the response carries it.
    thinkingTokens: num(usage?.output_tokens_details?.thinking_tokens),
    thinkingBlocks: content.filter((b) => b?.type === 'thinking' || b?.type === 'redacted_thinking').length,
    textBlocks: content.filter((b) => b?.type === 'text').length,
    usageKeys: usage ? [...new Set(Object.keys(usage).map((k) => (USAGE_KEYS.has(k) ? k : 'other_key')))] : [],
    geo: oneOf(GEOS, usage?.inference_geo),
    speed: oneOf(SPEEDS, usage?.speed),
  };
}

// Tokens at the book price. Fast mode is billed only when a request asks for it with the speed field, which this probe
// never sends, so a usage with no speed is read as standard; a speed it does report is priced as reported. A missing
// or unknown geo is priced as US-only, as the bound is.
function costOf(usage, price) {
  if (!usage) return null;
  return computeMicros({ ...usage, speed: usage.speed ?? undefined }, price);
}

// --- the run ---

const MODEL_CHECKS = (plan) => [
  { role: 'primary', id: plan.primaryId, effort: PRIMARY_EFFORT, maxTokens: plan.probeMaxTokens },
  { role: 'decision', id: plan.decisionId, effort: DECISION_EFFORT, maxTokens: DECISION_MAX_TOKENS },
];
// Capability leaves the probe exists to confirm. Their absence is recorded, not a stop.
const NOTE_ONLY = /^(primary|decision):capability_unknown:/;

async function modelCheck({ guard, baseUrl, key, plan, record, say, signal, checkModels }) {
  guard.models();
  let out;
  try {
    out = await checkModels({ fetch: guard.fetch, baseUrl, key, models: MODEL_CHECKS(plan), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(MODEL_CHECK_TIMEOUT_MS)]) : undefined });
  } catch {
    out = { ok: false, rows: [], problems: ['check_failed'] };
  } finally {
    guard.disarm();
  }
  const problems = (out.problems ?? []).map(String);
  const blocking = problems.filter((p) => !NOTE_ONLY.test(p));
  for (const row of out.rows ?? []) {
    record({ kind: 'model_check', role: row.role, maxTokens: row.maxTokens, caps: row.caps ?? {} });
  }
  record({ kind: 'model_check', state: blocking.length ? 'refused' : 'ok', problems });
  if (problems.length) say(`Model check: ${problems.join(', ')}.`);
  else say('Model check: both models answered with the capabilities this probe sends.');
  // A request the guard refused says more than the network error the check saw instead.
  const refused = guard.refusals()[0];
  if (refused) return refused;
  if (!blocking.length) return null;
  const first = blocking[0].replace(/^(primary|decision):/, '');
  return `model_check_${first.replace(/[^a-z0-9_]/gi, '_')}`;
}

function spendTracker(capMicros) {
  let total = 0;
  let missing = 0;
  return {
    canAfford: (micros) => total + micros <= capMicros,
    add(micros, { missingUsage = false } = {}) {
      total += micros;
      if (missingUsage) missing += 1;
    },
    totals: () => ({ totalMicros: total, missingCount: missing, capMicros }),
  };
}

// Why the run stops after this call, or null. Checked in order: what the client says, then the bound's assumptions.
function stopAfter(r, slot, call, { usage, counted, computed }) {
  if (slot.refusedReason) return slot.refusedReason;
  if (r.kind === 'not_sent') return `not_sent_${r.reason}`;
  if (r.kind === 'aborted') return 'interrupted';
  if (r.kind === 'refusal') return 'refusal';
  if (r.kind === 'error') {
    if (r.reason === 'http' || r.reason === 'provider_error') return r.info?.limitSource ?? `http_${num(r.status) ?? 'error'}`;
    return r.reason;
  }
  if (!usage || computed === null) return 'usage_missing';
  if ((usage.output ?? 0) > call.maxTokens) return 'completion_above_bound';
  const prompt = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) + (usage.cacheWrite1h ?? 0);
  if (prompt > call.inputTokens) return 'prompt_above_bound';
  if (computed.flags.some((f) => f.startsWith('speed_'))) return 'speed_unexpected';
  if (computed.flags.includes('cache_1h')) return 'cache_1h_unexpected';
  if (counted > call.boundMicros) return 'cost_above_bound';
  return null;
}

// factories: { adapter, checkModels }, for tests only.
export async function runProbe({ plan, baseUrl, key, maxUsd, resultPath, say, fetchImpl = globalThis.fetch, testMode = false, signal, now = Date.now, factories = {} }) {
  const capMicros = Math.floor(maxUsd * 1e6);
  if (plan.totalWorstMicros > capMicros) throw new Error(`refused: the bound ${usdText(plan.totalWorstMicros)} is above --max-usd`);
  if (plan.totalWorstMicros > PROBE_CAP_MICROS) throw new Error(`refused: the bound ${usdText(plan.totalWorstMicros)} is above the agreed cap`);
  const adapter = factories.adapter ?? anthropicAdapter;
  const checkModels = factories.checkModels ?? checkAnthropicModels;
  const record = resultWriter(resultPath, [key]);
  const tracker = spendTracker(capMicros);
  const guard = createProbeFetch({ http: fetchImpl, baseUrl, key, plan });
  const client = createChatClient({ adapter, fetch: guard.fetch, getKey: () => key, getBaseUrl: () => baseUrl, now });
  const lines = [];
  let stopReason = null;
  record({ kind: 'run_start', planCalls: plan.calls.length, worstUsd: round6(plan.totalWorstMicros), preGeoWorstUsd: round6(plan.totalPreGeoMicros), maxUsd, capUsd: round6(capMicros), primaryModel: plan.primaryId, decisionModel: plan.decisionId, testMode });

  stopReason = await modelCheck({ guard, baseUrl, key, plan, record, say, signal, checkModels });

  for (const call of stopReason ? [] : plan.calls) {
    if (signal?.aborted) {
      stopReason = 'interrupted';
      break;
    }
    if (!tracker.canAfford(call.boundMicros)) {
      stopReason = 'cap';
      say(`Stopped before ${call.id}: its bound could pass --max-usd.`);
      break;
    }
    const at = now();
    const expected = callBody(plan, call, at);
    let body;
    try {
      body = callBody(plan, call, at, adapter);
    } catch {
      stopReason = 'presend_body';
      break;
    }
    const slot = { call, expected, requests: 0, refused: 0, refusedReason: null, status: null, observed: null };
    guard.arm(slot);
    let r;
    try {
      r = await client.post(body, { signal, deadlineAt: at + CALL_TIMEOUT_MS, beforeRetry: () => false });
    } finally {
      guard.disarm();
    }
    const usage = r.usage ?? null;
    const computed = costOf(usage, plan.prices[call.role]);
    const sent = slot.requests > 0 && r.kind !== 'not_sent';
    // Nothing left: nothing is counted. Something left with no figure: it counts at its bound.
    let counted = 0;
    if (sent) counted = computed === null ? call.boundMicros : computed.micros;
    tracker.add(counted, { missingUsage: sent && computed === null });
    const seen = observe(slot.observed, body.model);
    const content = r.message?.content;
    const line = {
      kind: 'call',
      id: call.id,
      role: call.role,
      class: r.kind,
      reason: r.reason,
      httpStatus: num(r.status),
      errorType: oneOf(ERROR_TYPES, r.info?.error_type),
      limitSource: r.info?.limitSource ?? null,
      finish: r.finishReason ?? null,
      ...seen,
      inputTokens: num(usage?.input),
      outputTokens: num(usage?.output),
      cacheReadTokens: num(usage?.cacheRead),
      cacheWriteTokens: num(usage?.cacheWrite),
      cacheWrite1hTokens: num(usage?.cacheWrite1h),
      contentChars: typeof content === 'string' ? content.length : 0,
      flags: computed?.flags ?? [],
      usageMissing: sent && computed === null,
      computedUsd: computed === null ? null : round6(computed.micros),
      countedUsd: round6(counted),
      worstUsd: round6(call.boundMicros),
      preGeoWorstUsd: round6(call.preGeoMicros),
      inputBoundTokens: call.inputTokens,
      maxTokens: call.maxTokens,
      requests: slot.requests,
      refusedRequests: slot.refused,
      durationMs: now() - at,
    };
    if (call.id === 'turn_warm') line.cacheHit = sent ? (num(usage?.cacheRead) ?? 0) > 0 : null;
    if (call.role === 'decision') line.decisionValid = r.kind === 'ok' && typeof content === 'string' ? parseAnswer(content.trim()) !== null : false;
    const stop = stopAfter(r, slot, call, { usage, counted, computed });
    line.state = stop ? 'stopped' : 'ok';
    line.stopReason = stop;
    lines.push(line);
    record(line);
    say(`${call.id}: ${r.kind}${line.httpStatus ? ` (HTTP ${line.httpStatus})` : ''}, stop_reason ${line.stop ?? 'none'}, counted ${usdText(counted)} of its bound ${usdText(call.boundMicros)}${line.usageMissing ? ' (no usage, counted at its bound)' : ''}.`);
    if (stop) {
      stopReason = stop;
      if (slot.refusedReason) say(`The request was refused before it left: ${stop}. Nothing was sent, so nothing is counted.`);
      else say(`Stopped after ${call.id}: ${stop}. Not retried.`);
      break;
    }
  }

  const warm = lines.find((l) => l.id === 'turn_warm');
  if (warm && warm.requests > 0) {
    record({ kind: 'measure', name: 'warm_cache_read', tokens: warm.cacheReadTokens, cacheHit: warm.cacheHit });
    say(warm.cacheHit ? `The warm turn read ${warm.cacheReadTokens} tokens from the cache.` : 'Note: the warm turn read nothing from the cache.');
  }
  const totals = tracker.totals();
  const refusedHosts = guard.refusedHosts();
  record({ kind: 'summary', completed: stopReason === null, stopReason, totalUsd: round6(totals.totalMicros), worstUsd: round6(plan.totalWorstMicros), capUsd: round6(capMicros), missingCount: totals.missingCount, refusedHosts, refusedReasons: guard.refusals(), requested: guard.requested() });
  say('');
  say(stopReason ? `Run stopped: ${stopReason}.` : 'Run finished.');
  say(`Counted: ${usdText(totals.totalMicros)} (${totals.missingCount} call(s) at their bound for want of usage), bound ${usdText(plan.totalWorstMicros)}, --max-usd ${usdText(capMicros)}. This is a local count from tokens; compare it with the Console by hand.`);
  return { stopReason, totals, lines, requested: guard.requested() };
}

// --- command line ---

const USAGE = `Usage: q5-anthropic [--approve --max-usd <dollars> --hard-cap-attested]
Without --approve it prints the plan and exits. No request is made and .env is not read.
It reads CLO_TEST_ANTHROPIC_API_KEY from .env, a Key of a dedicated probe workspace, and no other Key.`;

export function parseCli(argv) {
  const out = { approve: false, maxUsd: null, hardCapAttested: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--approve') out.approve = true;
    else if (a === '--hard-cap-attested') out.hardCapAttested = true;
    else if (a === '--max-usd') {
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
    if (env[TEST_BASE_ENV]) throw new Error(`${TEST_BASE_ENV} is only allowed in test mode.`);
    return { baseUrl: DEFAULT_BASE.anthropic, testMode };
  }
  if (!env[TEST_BASE_ENV] || !isLoopback(env[TEST_BASE_ENV])) throw new Error(`Test mode needs a loopback ${TEST_BASE_ENV}.`);
  return { baseUrl: env[TEST_BASE_ENV], testMode };
}

function watchStopSignals(ac) {
  const onStop = () => ac.abort();
  const names = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'];
  for (const name of names) process.on(name, onStop);
  return () => {
    for (const name of names) process.off(name, onStop);
  };
}

export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, fetchImpl = globalThis.fetch, factories = {} } = {}) {
  let secrets = [];
  const clean = (text) => secrets.reduce((acc, s) => acc.split(s).join('[hidden]'), String(text));
  const say = (text = '') => stdout.write(`${clean(text)}\n`);
  const fail = (text) => stderr.write(`${clean(text)}\n`);
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
    say('Not approved, so no request was made and .env was not read. Run with --approve --max-usd <dollars> --hard-cap-attested after the user has agreed to spend.');
    return 0;
  }
  if (cli.maxUsd === null) {
    fail('--approve needs an explicit --max-usd.');
    return 2;
  }
  if (plan.totalWorstMicros > Math.floor(cli.maxUsd * 1e6)) {
    fail(`Refused: the bound ${usdText(plan.totalWorstMicros)} is above --max-usd $${cli.maxUsd}. Nothing was sent.`);
    return 2;
  }
  if (!cli.hardCapAttested) {
    fail('Refused: Anthropic enforces no per-key daily limit, so the probe workspace\'s spend limit or prepaid balance (auto-reload off) is the only stop on the provider side. Set it up, then attest it with --hard-cap-attested. Nothing was sent and .env was not read.');
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
    fail(`${PROBE_KEY_NAME} is empty in .env. This probe uses no other Key. Create a Key in a dedicated probe workspace with a small spend limit or a prepaid balance with auto-reload off, and put it in .env as ${PROBE_KEY_NAME}.`);
    return 2;
  }
  secrets = [key];
  if (!/^sk-ant-/.test(key)) {
    fail(`Refused: ${PROBE_KEY_NAME} does not look like an Anthropic Key. Nothing was sent.`);
    return 2;
  }
  const ac = new AbortController();
  const stopWatching = watchStopSignals(ac);
  try {
    const out = await runProbe({
      plan,
      baseUrl: endpoint.baseUrl,
      key,
      maxUsd: cli.maxUsd,
      resultPath: join(paths.root, RESULT_FILE),
      say,
      fetchImpl,
      testMode: endpoint.testMode,
      signal: ac.signal,
      factories,
    });
    return out.stopReason ? 1 : 0;
  } catch (e) {
    fail(`Stopped: ${e.message}`);
    return 1;
  } finally {
    stopWatching();
  }
}

if (resolve(process.argv[1] ?? '').toLowerCase() === SELF.toLowerCase()) {
  process.exitCode = await main(process.argv.slice(2));
}
