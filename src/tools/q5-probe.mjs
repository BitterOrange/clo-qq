// Q5 paid probe. Measures what the offline suite cannot: thinking tokens, finish_reason, cost and usage, Key
// reconciliation lag, the token size of the content-policy block and the decision prompt, and the shape of a 403's
// error.metadata if one happens. Search is not part of this build.
//
// Safeguards:
// - Without --approve it prints the plan and exits. No request, and .env is not read.
// - This tool writes only the fixed texts below and the project's persona files. Nothing from the command line is
//   sent. In a Gateway turn the host adds its own text as well; the plan lists it.
// - It is not built to provoke a refusal. A 403 is recorded only if it happens by itself.
// - No paid call is retried by this tool. The host retries and compacts by itself, so a Gateway turn has a live limit
//   of TURN_CALL_LIMIT requests: the guard ends the Gateway when the next one is created, before it leaves.
// - The Gateway gets a temp root, a fake QQ identity and a loopback mock QQ. A preloaded guard refuses other hosts.
// - The key is read at run time, and goes only to fetch headers and the Gateway's environment.
// - Results hold numbers and classifications only. The temp root holds the host's session store, with the prompts and
//   the model's answers, until it is removed at the end, or by the next start after a hard kill.
// - config.json is neither read nor changed.
//
// Run through scripts\q5-probe.ps1, which uses the private Node.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isLoopback } from '../cli/common.mjs';
import { GATEWAY_NODE_FLAGS, gatewayEnv, openclawEntry, parseEnvFile, privateNode } from '../cli/lifecycle.mjs';
import { registerTools } from '../clo-plugin/lib/channels/qq/tools.js';
import { buildEffective, OPENROUTER_BASE_URL, resolvePaths } from '../clo-plugin/lib/core/config.js';
import { POLICY_V1_SHA256 } from '../clo-plugin/lib/core/contentPolicy.js';
import { estimateTokens } from '../clo-plugin/lib/core/context.js';
import { buildRequest as buildDecisionRequest } from '../clo-plugin/lib/core/decision.js';
import { hmacKey } from '../clo-plugin/lib/core/ids.js';
import { DECISION_INPUT_TOKENS } from '../clo-plugin/lib/core/ledger.js';
import { fetchCatalog, lockFromCatalog, priceFor, resolveSelector, validateModels } from '../clo-plugin/lib/core/models.js';
import { renderOpenclaw, renderWorkspace, writeAtomic } from '../clo-plugin/lib/core/render.js';

const SELF = fileURLToPath(import.meta.url);
const GUARD = fileURLToPath(new URL('./q5-net-guard.mjs', import.meta.url));
const OUTPUT_FILTER = fileURLToPath(new URL('../cli/host-output-filter.mjs', import.meta.url));

// The IDs a person agrees to when reading the plan. A different catalog answer stops the run before any paid call.
export const PRIMARY_ID = 'anthropic/claude-opus-5.5';
export const DECISION_ID = 'anthropic/claude-haiku-5.5';
// The estimate has to be printable with no network, so it uses ceilings. A catalog price above them refuses the run.
export const PRICE_CEILING = Object.freeze({
  primary: Object.freeze({ inputPerM: 8, outputPerM: 30 }),
  decision: Object.freeze({ inputPerM: 2, outputPerM: 10 }),
});
// A token is at least about one byte of UTF-8, so bytes bound the prompt. This covers schema and message framing.
const PROMPT_OVERHEAD_TOKENS = 500;
// Requests one Gateway turn may make. The host made up to 10 on mocks when calls failed, so this is enforced, not assumed.
export const TURN_CALL_LIMIT = 2;
// The Key can round. A difference this small is not a finding.
const KEY_TOLERANCE_MICROS = 1000;
// A hard kill leaves a temp root behind. With no recorded process, this old means no run is still starting in it.
const ORPHAN_ROOT_MS = 10 * 60000;
const CALL_TIMEOUT_MS = 120000;
const CONNECT_TIMEOUT_MS = 240000;
const SETTLE_WAIT_MS = 20000;
const DEFAULT_LAG_MINUTES = 20;
const POLL_MS = 30000;
const MATCH_RATIO = 0.95;
const CURRENT_LAG_MS = 15 * 60000;
const CURRENT_STREAK = 3;
const TURN_TERMINAL = new Set(['ignored', 'stale', 'merged', 'paused', 'dry_run', 'skipped', 'completed', 'silent', 'policy_dropped', 'failed', 'restart_dropped', 'crash_unknown']);
const STOP_STATUS = new Set([401, 402, 403, 429]);

// Never real. These are the only QQ identity the Gateway sees.
export const FAKE_APP_ID = 'Q5FAKEAPPID000111';
export const FAKE_QQ_SECRET = 'Q5-FAKE-QQ-SECRET-LOOPBACK-ONLY';
const FAKE_GROUP = 'Q5FAKEGROUP00011112222333344445555';
const FAKE_OWNER = 'Q5FAKEOWNER00011112222333344445555';
const FAKE_MEMBER = 'Q5FAKEMEMBER0001111222233334444555';
const FAKE_BOT = 'Q5FAKEBOT0000111122223333444455555';
const TEST_RENDER_KEY = 'sk-or-v1-FAKE-KEY-FOR-LOCAL-MOCK-ONLY';

// Every text this tool can send, apart from the persona files named in the plan.
export const FIXED = Object.freeze({
  baselineSystem: '你是一个聊天助手。',
  question: '一年有几个季节？请用一句话回答。',
  decisionInput: Object.freeze({
    trigger: 'ordinary',
    lines: Object.freeze([Object.freeze({ sender: '群友1', text: '今天天气不错，下午打算去公园走走。' })]),
    current: Object.freeze({ sender: '群友2', text: '有人知道公园几点关门吗？' }),
  }),
  turns: Object.freeze(['一年有几个季节？', '那春天大概是几月到几月？']),
});

// What the host adds to a Gateway turn, in its own words. A test compares this with the requests the mock receives.
export const HOST_ADDED = Object.freeze({
  runtimeContextPrefix: 'OpenClaw runtime context:',
  compactionPrefix: 'You are a context summarization assistant',
});

const PERSONA_FILES = ['CONTENT-POLICY.md', 'AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'decision-prompt.zh.md'];

function toolDefinition() {
  let def = null;
  registerTools({ registerTool: (t) => { def = t; } });
  return { name: def.name, description: def.description, parameters: def.parameters };
}

const utf8Bytes = (text) => Buffer.byteLength(text, 'utf8');
const usdText = (micros) => `$${(micros / 1e6).toFixed(4)}`;
const round6 = (micros) => Number((micros / 1e6).toFixed(6));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// --- the plan ---

function primaryBody(system, plan) {
  return {
    model: plan.primaryId,
    stream: false,
    reasoning: { effort: plan.primaryEffort },
    max_tokens: plan.primaryMaxTokens,
    provider: { require_parameters: true },
    usage: { include: true },
    messages: [{ role: 'system', content: system }, { role: 'user', content: FIXED.question }],
  };
}

const decisionEff = (plan) => ({ models: { decision: { id: plan.decisionId, effort: plan.decisionEffort, maxTokens: plan.decisionMaxTokens } }, retention: { decisionLines: 15, decisionLineChars: 200, decisionCurrentChars: 800 } });

function decisionBody(plan, { withPrompt }) {
  const body = buildDecisionRequest(decisionEff(plan), plan.texts.decisionPrompt, FIXED.decisionInput);
  return withPrompt ? body : { ...body, messages: body.messages.filter((m) => m.role !== 'system') };
}

// The hold has to cover the largest input, and the probe only sends a short one. So the figure for the short one
// is scaled by what the ledger's estimator says of the two. Filled with what the estimator rates highest.
function largestDecisionInput(plan, observedPromptTokens) {
  const FILL = '\u0001';
  const estimate = (input) => estimateTokens(JSON.stringify(buildDecisionRequest(decisionEff(plan), plan.texts.decisionPrompt, input).messages));
  const lines = Array.from({ length: 15 }, (_, i) => ({ sender: `U${1000 + i}`, text: FILL.repeat(200) }));
  const largest = estimate({ trigger: 'crisis_route', lines, current: { sender: 'U9999', text: FILL.repeat(800) } });
  return Math.ceil(observedPromptTokens * largest / estimate(FIXED.decisionInput));
}

function worstCall(body, ceiling) {
  const tokens = utf8Bytes(JSON.stringify(body.messages)) + PROMPT_OVERHEAD_TOKENS;
  return Math.ceil(tokens * ceiling.inputPerM + body.max_tokens * ceiling.outputPerM);
}

export function buildPlan(repoRoot) {
  const example = JSON.parse(readFileSync(join(repoRoot, 'config.example.json'), 'utf8').replace(/^\uFEFF/, ''));
  if (example.claudeModel.id !== 'opus-latest') throw new Error('config.example.json no longer selects opus-latest');
  if (example.decisionModel.id !== DECISION_ID) throw new Error('config.example.json names another decision model');
  const read = (name) => readFileSync(join(repoRoot, 'persona', name), 'utf8');
  const files = PERSONA_FILES.map((name) => {
    const text = read(name);
    return { name, text, bytes: utf8Bytes(text), sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
  });
  // Same assembly the Gateway uses, including the policy hash and sentinel checks.
  const { systemPrompt } = renderWorkspace(repoRoot, { contentPolicy: { policyFile: join(repoRoot, 'persona', 'CONTENT-POLICY.md'), sha256: POLICY_V1_SHA256, version: example.contentPolicy.version } });
  const plan = {
    primaryId: PRIMARY_ID,
    decisionId: DECISION_ID,
    primaryEffort: example.claudeModel.effort,
    primaryMaxTokens: example.claudeModel.maxTokens,
    contextTokens: example.claudeModel.contextTokens,
    decisionEffort: example.decisionModel.effort,
    decisionMaxTokens: example.decisionModel.maxTokens,
    files,
    texts: { policy: read('CONTENT-POLICY.md'), decisionPrompt: read('decision-prompt.zh.md'), systemPrompt },
  };
  const direct = [
    { id: 'decision_with_prompt', role: 'decision', body: decisionBody(plan, { withPrompt: true }), sends: 'decision-prompt.zh.md + decision input' },
    { id: 'decision_baseline', role: 'decision', body: decisionBody(plan, { withPrompt: false }), sends: 'decision input only' },
    { id: 'primary_baseline', role: 'primary', body: primaryBody(FIXED.baselineSystem, plan), sends: 'baseline system + question' },
    { id: 'primary_policy', role: 'primary', body: primaryBody(plan.texts.policy, plan), sends: 'CONTENT-POLICY.md + question' },
    { id: 'primary_full_prompt', role: 'primary', body: primaryBody(systemPrompt, plan), sends: 'full system prompt (policy, AGENTS, SOUL, IDENTITY) + question' },
  ];
  plan.calls = direct.map((c) => ({ ...c, worstMicros: worstCall(c.body, PRICE_CEILING[c.role]) }));
  // The guard enforces the limit, so this figure is a bound and not a guess at what the host will do.
  plan.turnCallLimit = TURN_CALL_LIMIT;
  plan.turnCallWorstMicros = Math.ceil(plan.contextTokens * PRICE_CEILING.primary.inputPerM + plan.primaryMaxTokens * PRICE_CEILING.primary.outputPerM);
  plan.turns = FIXED.turns.map((text, i) => ({ id: `gateway_turn_${i + 1}`, text, worstMicros: TURN_CALL_LIMIT * plan.turnCallWorstMicros }));
  plan.totalWorstMicros = plan.calls.reduce((a, c) => a + c.worstMicros, 0) + plan.turns.reduce((a, t) => a + t.worstMicros, 0);
  plan.maxModelCalls = plan.calls.length + plan.turns.length * TURN_CALL_LIMIT;
  plan.tool = toolDefinition();
  return plan;
}

export function printPlan(plan, say) {
  say('Q5 paid probe: plan');
  say(`Models: primary ${plan.primaryId} (selector opus-latest; if the catalog resolves it to anything else the run refuses), decision ${plan.decisionId}.`);
  say(`Planned calls: ${plan.calls.length} direct, then ${plan.turns.length} Gateway turns against mock QQ, each limited to ${plan.turnCallLimit} model requests. At most ${plan.maxModelCalls} model calls. No retries by this tool.`);
  say('The host retries failed calls and can compact by itself, up to 10 requests in one turn on mocks. So the guard counts each request as it is created, and the next one over the limit ends the Gateway before it leaves, which stops the run.');
  say(`Worst case: ${usdText(plan.totalWorstMicros)}, at price ceilings of $${PRICE_CEILING.primary.inputPerM}/$${PRICE_CEILING.primary.outputPerM} per million (primary) and $${PRICE_CEILING.decision.inputPerM}/$${PRICE_CEILING.decision.outputPerM} (decision). Real prices come from the catalog and are expected to be lower. A turn's token sizes are assumed to stay within the context and output limits above.`);
  say("The hard ceiling is the Key's daily limit on OpenRouter, because only OpenRouter can refuse a request. It must not be above --max-usd, or the run refuses to start. It covers the whole UTC day, including other use of the Key.");
  for (const c of plan.calls) say(`  ${c.id}: ${c.role}, max_tokens ${c.body.max_tokens}, worst ${usdText(c.worstMicros)}. Sends: ${c.sends}.`);
  for (const t of plan.turns) say(`  ${t.id}: real Gateway, worst ${usdText(t.worstMicros)}. Sends: full system prompt, the turn text, and what the host adds (below).`);
  say('After the calls it reads the Key endpoint (no charge) until the spend shows up, to measure the reconciliation lag.');
  say('');
  say('Exact fixed texts:');
  say(`  baseline system: ${FIXED.baselineSystem}`);
  say(`  question: ${FIXED.question}`);
  say(`  decision input: ${JSON.stringify(FIXED.decisionInput)}`);
  FIXED.turns.forEach((t, i) => say(`  turn ${i + 1}: ${t}`));
  say('');
  say('Added by the host in Gateway turns, not written by this tool:');
  say(`  a user message beginning "${HOST_ADDED.runtimeContextPrefix}" with hashed chat and sender IDs and a timestamp. The IDs here are fake.`);
  say("  turn 2 also resends turn 1's question and the model's answer to it.");
  say(`  the tool schema: ${JSON.stringify(plan.tool)}`);
  say(`  only if the host compacts: its English prompt beginning "${HOST_ADDED.compactionPrefix}", with the earlier turns. Not expected at these sizes, and it would use up the turn's limit.`);
  say('');
  say('Exact persona files sent:');
  for (const f of plan.files) {
    say(`--- persona/${f.name} (${f.bytes} bytes, sha256 ${f.sha256}) ---`);
    say(f.text.trimEnd());
  }
  say('--- end of files ---');
}

// --- spend ---

export function createSpendTracker(capMicros) {
  let reported = 0;
  let countedAtWorst = 0;
  let missingCount = 0;
  const total = () => reported + countedAtWorst;
  return {
    canAfford: (worstMicros) => total() + worstMicros <= capMicros,
    addReported(micros) { reported += micros; },
    // No figure is not a free call.
    addMissing(worstMicros) {
      countedAtWorst += worstMicros;
      missingCount += 1;
    },
    totals: () => ({ reportedMicros: reported, countedAtWorstMicros: countedAtWorst, missingCount, totalMicros: total(), capMicros }),
  };
}

// A positive, finite usage.cost. Zero, absent or malformed counts as missing.
export function reportedCostMicros(usage) {
  const cost = usage?.cost;
  return typeof cost === 'number' && Number.isFinite(cost) && cost > 0 ? Math.ceil(cost * 1e6) : null;
}

// --- results: numbers and classifications only ---

const RESULT_KEYS = new Set([
  'at', 'kind', 'id', 'role', 'httpStatus', 'class', 'stopReason', 'finishReason', 'nativeFinish', 'promptTokens', 'completionTokens', 'reasoningTokens',
  'cachedTokens', 'cacheWriteTokens', 'costUsd', 'countedUsd', 'usageMissing', 'worstUsd', 'durationMs', 'modelMatches', 'providerName', 'contentChars',
  'refusalPresent', 'errorCode', 'errorType', 'metadataKeys', 'metadataTypes', 'limitSource', 'planCalls', 'planTurns', 'maxModelCalls', 'maxUsd',
  'primaryModel', 'decisionModel', 'keyLimitUsd', 'keyRemainingUsd', 'keyLimitReset', 'state', 'reason', 'tier', 'heldUsd', 'actualUsd', 'source',
  'posts', 'modelCalls', 'modelCallErrors', 'hostNotices', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'alerts', 'paidPaused', 'refusedHosts',
  'qqRouteAttempt', 'firstDeltaMs', 'matchedMs', 'timedOut', 'polls', 'keyDeltaUsd', 'reportedUsd', 'countedAtWorstUsd', 'missingCount', 'totalUsd', 'capUsd',
  'name', 'current', 'suggested', 'basis', 'observed', 'tokens', 'catalogInputPerM', 'catalogOutputPerM', 'completed', 'testMode',
  'guardRequests', 'refusedRequests', 'hiddenCalls', 'turnCallLimit', 'tokenCostUsd', 'flags', 'unusedPriceFields',
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

function resultWriter(path, secrets = []) {
  mkdirSync(dirname(path), { recursive: true });
  return (line) => {
    const text = JSON.stringify(sanitizeResult({ at: new Date().toISOString(), ...line }));
    appendFileSync(path, `${secrets.reduce((acc, s) => acc.split(s).join('[hidden]'), text)}\n`);
  };
}

// --- provider answers ---

// A structured marker names the error. A word in free text only suggests it: 'another region restarted' is a server
// message. Fields that quote someone's text are not searched at all. The real shape has not been seen; Q5 measures it.
const REGION_MARKER = /unsupported_(country|region)/i;
const REGION_WORD = /\b(regions?|country|countries|territor(y|ies)|geograph\w*)\b/i;
const FINISH = new Set(['stop', 'length', 'tool_calls', 'content_filter', 'error', 'function_call']);
const NATIVE_FINISH = new Set(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'refusal', 'pause_turn', 'STOP', 'MAX_TOKENS', 'stop', 'length']);
// Closed lists. Provider text cannot reach the file by being plain ASCII. An unknown name is noted, not copied.
const METADATA_KEYS = new Set(['flagged_input', 'reasons', 'reason', 'raw', 'provider_name', 'limit_source', 'model_slug', 'model', 'provider', 'is_byok', 'country', 'region', 'territory', 'code', 'type', 'status', 'error', 'message', 'moderation', 'category', 'categories', 'retry_after', 'headers']);
const ERROR_TYPES = new Set(['invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error', 'rate_limit_error', 'api_error', 'overloaded_error', 'server_error', 'timeout_error', 'moderation', 'forbidden', 'error']);
const PROVIDERS = new Map([['Anthropic', 'anthropic'], ['Amazon Bedrock', 'amazon_bedrock'], ['Google', 'google'], ['Google Vertex', 'google_vertex'], ['Google AI Studio', 'google_ai_studio'], ['Azure', 'azure'], ['OpenRouter', 'openrouter']]);
const LIMIT_SOURCES = new Set(['openrouter_key_limit', 'openrouter_credits']);
const LIMIT_RESETS = new Set(['daily', 'weekly', 'monthly']);

const oneOf = (set, v) => (typeof v === 'string' && v ? (set.has(v) ? v : 'other') : null);
const providerSlug = (v) => (typeof v === 'string' && v ? (PROVIDERS.get(v) ?? 'other') : null);
const metadataName = (k) => (METADATA_KEYS.has(k) ? k : 'other_key');

// Reads provider words in memory to pick a class. Only the class and the key names ever leave this function.
export function classifyError(httpStatus, error) {
  const status = Number.isInteger(error?.code) && error.code >= 100 && error.code < 600 ? error.code : httpStatus;
  const meta = error?.metadata && typeof error.metadata === 'object' && !Array.isArray(error.metadata) ? error.metadata : null;
  const { flagged_input: _flagged, reasons: _reasons, raw: _raw, ...searchable } = meta ?? {};
  const haystack = JSON.stringify([error?.code, error?.type, error?.message, searchable]);
  const moderationShape = status === 403 && meta && ('flagged_input' in meta || 'reasons' in meta);
  let cls;
  if (REGION_MARKER.test(haystack)) cls = 'region';
  else if (moderationShape) cls = 'moderation';
  else if (meta?.limit_source === 'openrouter_key_limit') cls = 'key_limit';
  else if (meta?.limit_source === 'openrouter_credits') cls = 'credits';
  else if (REGION_WORD.test(haystack)) cls = 'region_suspected';
  else if (status === 401) cls = 'auth';
  else if (status === 402) cls = 'payment';
  else if (status === 403) cls = 'forbidden_other';
  else if (status === 429) cls = 'rate_limit';
  else if (status >= 500) cls = 'server';
  else if (status === 408) cls = 'timeout';
  else cls = 'bad_request';
  return {
    class: cls,
    status,
    stop: cls === 'region' || cls === 'region_suspected' || STOP_STATUS.has(status),
    errorCode: num(error?.code),
    errorType: oneOf(ERROR_TYPES, error?.type),
    metadataKeys: [...new Set(Object.keys(meta ?? {}).map(metadataName))],
    metadataTypes: [...new Set(Object.entries(meta ?? {}).map(([k, v]) => `${metadataName(k)}:${Array.isArray(v) ? 'array' : typeof v}`))],
    limitSource: LIMIT_SOURCES.has(meta?.limit_source) ? meta.limit_source : null,
    providerName: providerSlug(meta?.provider_name),
  };
}

// Redirects are refused too. Following one could leave the model host, and a 307 would send a paid POST again.
export function restrictedFetch(baseUrl, fetchImpl) {
  const origin = new URL(baseUrl).origin;
  return (url, init) => {
    if (new URL(url).origin !== origin) throw new Error('q5: a request outside the model host was refused');
    return fetchImpl(url, { ...init, redirect: 'error' });
  };
}

const parseJson = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

// The tokens at the catalog price. A reported cost can sit far below this, for example if it only covers a fee.
export function tokenCostMicros(usage, price) {
  const prompt = num(usage?.prompt_tokens);
  const completion = num(usage?.completion_tokens);
  if (!price || (prompt === null && completion === null)) return null;
  const cached = num(usage?.prompt_tokens_details?.cached_tokens) ?? 0;
  const written = num(usage?.prompt_tokens_details?.cache_write_tokens) ?? 0;
  const plain = Math.max(0, (prompt ?? 0) - cached - written);
  return Math.ceil(plain * price.inputPerM + cached * price.cacheReadPerM + written * price.cacheWritePerM + (completion ?? 0) * price.outputPerM);
}

async function paidCall({ http, baseUrl, key, call, tracker, record, signal, price }) {
  const started = Date.now();
  const line = { kind: 'call', id: call.id, role: call.role, worstUsd: round6(call.worstMicros) };
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
    line.httpStatus = status;
  }
  line.durationMs = Date.now() - started;
  let stop = line.class === 'interrupted' ? 'interrupted' : null;
  if (!line.class) {
    line.httpStatus = status;
    if (status < 200 || status >= 300 || body?.error) {
      const c = classifyError(status, body?.error ?? null);
      Object.assign(line, { class: c.class, errorCode: c.errorCode, errorType: c.errorType, metadataKeys: c.metadataKeys, metadataTypes: c.metadataTypes, limitSource: c.limitSource, providerName: c.providerName });
      if (c.stop) stop = c.class;
    } else if (body === null) {
      line.class = 'bad_json';
    } else {
      const choice = body.choices?.[0];
      const usage = body.usage ?? {};
      const content = choice?.message?.content;
      Object.assign(line, {
        class: 'ok',
        finishReason: FINISH.has(choice?.finish_reason) ? choice.finish_reason : (choice?.finish_reason ? 'other' : null),
        nativeFinish: NATIVE_FINISH.has(choice?.native_finish_reason) ? choice.native_finish_reason : (choice?.native_finish_reason ? 'other' : null),
        promptTokens: num(usage.prompt_tokens),
        completionTokens: num(usage.completion_tokens),
        reasoningTokens: num(usage.completion_tokens_details?.reasoning_tokens),
        cachedTokens: num(usage.prompt_tokens_details?.cached_tokens),
        cacheWriteTokens: num(usage.prompt_tokens_details?.cache_write_tokens),
        modelMatches: body.model === call.body.model,
        providerName: providerSlug(body.provider),
        contentChars: typeof content === 'string' ? content.length : 0,
        refusalPresent: Boolean(choice?.message?.refusal),
      });
    }
  }
  const cost = reportedCostMicros(body?.usage);
  if (cost === null) {
    tracker.addMissing(call.worstMicros);
    Object.assign(line, { usageMissing: true, costUsd: null, countedUsd: round6(call.worstMicros) });
  } else {
    // A tiny positive figure must not count a large call as nearly free.
    const byTokens = tokenCostMicros(body?.usage, price);
    const counted = Math.max(cost, byTokens ?? 0);
    tracker.addReported(counted);
    Object.assign(line, { usageMissing: false, costUsd: round6(cost), tokenCostUsd: byTokens === null ? null : round6(byTokens), countedUsd: round6(counted) });
  }
  record(line);
  return { line, stop };
}

// --- isolation ---

const lowerPath = (p) => resolve(p).toLowerCase();
const isInside = (child, parent) => {
  const c = lowerPath(child);
  const p = lowerPath(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : `${p}${sep}`);
};

// No Gateway state may sit in the project. The exceptions are read-only programs and text: the private Node, the host
// package, the plugin code and the persona.
export function assertIsolated(paths, repoRoot) {
  for (const p of [paths.root, paths.runtime, paths.stateDir, paths.cloDir, paths.logsDir, paths.home, paths.workspace, paths.gatewayCwd, paths.db, paths.openclawJson, paths.effectiveJson, paths.envFile, paths.configJson, paths.eventLog]) {
    if (isInside(p, repoRoot)) throw new Error('q5: a Gateway path is inside the project');
  }
}

// An empty base URL would make the QQ SDK use its real default, so empty is refused too.
export function assertNoQqRoute(openclaw, effective) {
  const ch = openclaw?.channels?.['clo-qq'];
  for (const url of [ch?.apiBaseUrl, ch?.tokenBaseUrl, effective?.qq?.apiBaseUrl, effective?.qq?.tokenBaseUrl]) {
    if (!url || !isLoopback(url)) throw new Error('q5: the QQ endpoint is not loopback');
  }
  if (ch?.appId !== FAKE_APP_ID || effective?.qq?.appId !== FAKE_APP_ID) throw new Error('q5: the QQ identity is not the fake one');
}

export function probeConfig({ repoRoot, qqBase, port, modelBase = null }) {
  const cfg = JSON.parse(readFileSync(join(repoRoot, 'config.example.json'), 'utf8').replace(/^\uFEFF/, ''));
  cfg.mode = 'live';
  cfg.gatewayPort = port;
  cfg.qq.enabled = true;
  cfg.qq.appId = FAKE_APP_ID;
  cfg.qq.apiBaseUrl = qqBase;
  cfg.qq.tokenBaseUrl = qqBase;
  cfg.qq.allowedGroupIds = [FAKE_GROUP];
  cfg.qq.groups = { [FAKE_GROUP]: { label: 'q5', interject: false, nameMention: false, noticeGiven: true } };
  cfg.qq.owner.groupMember = { [FAKE_GROUP]: [FAKE_OWNER] };
  if (modelBase) cfg.openrouter = { baseUrl: modelBase };
  return cfg;
}

// Allowlist. Whatever QQ secret or proxy the parent holds cannot reach this child.
export function q5GatewayEnv(paths, parentEnv, { key, token, allowedHost, guardLog, testMode, modelOrigin, callLog, turnFile, turnCallLimit }) {
  const parent = {};
  for (const k of ['SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS']) {
    if (parentEnv[k]) parent[k] = parentEnv[k];
  }
  if (testMode) parent.CLO_TEST_ROOT = paths.root;
  const env = gatewayEnv(paths, parent, { secrets: { CLO_QQ_APP_ID: FAKE_APP_ID, CLO_QQ_APP_SECRET: FAKE_QQ_SECRET, CLO_CHAT_API_KEY: key }, token });
  env.CLO_Q5_ALLOWED_HOST = allowedHost;
  env.CLO_NET_GUARD_LOG = guardLog;
  env.CLO_Q5_MODEL_ORIGIN = modelOrigin;
  env.CLO_Q5_CALL_LOG = callLog;
  env.CLO_Q5_TURN_FILE = turnFile;
  env.CLO_Q5_TURN_CALL_LIMIT = String(turnCallLimit);
  // A Node child that keeps this environment loads the guard too. The only NODE_OPTIONS it can have is this one.
  env.NODE_OPTIONS = `--import=${pathToFileURL(GUARD).href}`;
  return env;
}

function allocPort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function until(cond, timeoutMs, { signal, stepMs = 250 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (signal?.aborted || Date.now() > end) return null;
    await sleep(stepMs);
  }
}

const readJsonlSafe = (path) => {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(parseJson).filter(Boolean);
};

function mentionEvent(id, text) {
  return {
    id,
    content: `<@${FAKE_BOT}> ${text}`,
    timestamp: new Date().toISOString(),
    group_openid: FAKE_GROUP,
    group_id: FAKE_GROUP,
    message_type: 0,
    message_scene: { source: 'default', ext: [] },
    attachments: [],
    author: { member_openid: FAKE_MEMBER, id: FAKE_MEMBER, bot: false, username: 'q5', member_role: 'member', union_openid: '' },
    mentions: [{ scope: 'single', bot: true, is_you: true, id: FAKE_BOT, member_openid: FAKE_BOT, member_role: 'member', username: 'q5-bot' }],
  };
}

// Read-only. A busy moment, or a Gateway still dying, fails the open with an I/O error: that just means another poll,
// so after a kill the caller waits for the exit before its last read.
function turnFacts(paths, rawId) {
  if (!existsSync(paths.db)) return null;
  let db;
  try {
    db = new DatabaseSync(paths.db, { readOnly: true });
    return readTurnFacts(db, rawId);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function readTurnFacts(db, rawId) {
  const salt = db.prepare("SELECT value FROM meta WHERE key='hmac_salt'").get()?.value;
  if (!salt) return null;
  const eventKey = hmacKey(salt, rawId);
  return {
    eventKey,
    row: db.prepare('SELECT state, reason FROM events WHERE event_key=?').get(eventKey) ?? null,
    holds: db.prepare('SELECT category, status, tier, held_micros, actual_micros, source FROM reservations WHERE event_key=?').all(eventKey),
    paidPaused: db.prepare("SELECT value FROM control WHERE key='paid_paused'").get()?.value ?? null,
    alerts: db.prepare('SELECT kind FROM alerts').all().map((a) => a.kind),
  };
}

// What the Gateway will read. Real run: no baseUrl and no key in the file, so the host takes its native route with
// the env key. Checked here, because nothing offline can run that route.
export function renderForProbe({ repoRoot, paths, qqBase, port, catalog, baseUrl, key, testMode }) {
  const cfg = probeConfig({ repoRoot, qqBase, port, modelBase: testMode ? baseUrl : null });
  const effective = buildEffective(cfg, { paths, modelsLock: lockFromCatalog(cfg, catalog), env: { CLO_TEST_ROOT: paths.root } });
  const workspace = renderWorkspace(repoRoot, effective);
  const openclaw = renderOpenclaw(cfg, effective, paths, { testMode: testMode ? { apiKey: TEST_RENDER_KEY } : false });
  assertNoQqRoute(openclaw, effective);
  const rendered = JSON.stringify(openclaw, null, 2);
  if (rendered.includes(key)) throw new Error('q5: the key reached openclaw.json');
  return { effective, workspace, openclaw, rendered };
}

// A previous run that was killed hard could not delete its temp root, which holds the host's session store. Removed
// here unless a recorded Gateway is still alive, or it is so new that a run may be starting in it.
export function sweepOldRunRoots(parent, { say = () => {}, now = Date.now, isAlive = pidIsAlive } = {}) {
  let names;
  try {
    names = readdirSync(parent).filter((n) => n.startsWith('clo-q5-'));
  } catch {
    return [];
  }
  const removed = [];
  for (const name of names) {
    const dir = join(parent, name);
    try {
      let pid = null;
      try {
        pid = Number(readFileSync(join(dir, '.runtime', 'gateway.pid'), 'utf8'));
      } catch {
        // Died before it recorded one.
      }
      if (pid ? isAlive(pid) : now() - statSync(dir).mtimeMs < ORPHAN_ROOT_MS) continue;
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      removed.push(name);
    } catch {
      say(`Could not remove the old temp root ${dir}. It holds a host session store: delete it by hand.`);
    }
  }
  if (removed.length) say(`Removed ${removed.length} temp root(s) left by an earlier run that was killed.`);
  return removed;
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// One real Gateway against a loopback mock QQ. Everything it stores lives under runRoot.
// guardAllowedHost only ever narrows what the guard allows, for a test of the native route. testImports needs that or
// test mode. main() passes neither.
export async function runGatewayStage({ plan, catalog, baseUrl, key, tracker, record, say, testMode, parentEnv, tempParent, repoRoot, signal, keepRunRoot = false, spawnImpl = spawn, guardAllowedHost = null, testImports = [] }) {
  const runRoot = mkdtempSync(join(tempParent ?? tmpdir(), 'clo-q5-'));
  const paths = resolvePaths({ CLO_TEST_ROOT: runRoot });
  let qq = null;
  let child = null;
  let exited = null;
  let logFd = null;
  let stopReason = null;
  const guardLog = join(paths.logsDir, 'q5-net-guard.jsonl');
  const callLog = join(paths.logsDir, 'q5-model-calls.jsonl');
  const turnFile = join(paths.runtime, 'q5-turn');
  const refused = () => [...new Set(readJsonlSafe(guardLog).map((v) => String(v.host)))];
  const killGateway = () => {
    if (!child || exited) return;
    const systemRoot = parentEnv.SystemRoot ?? process.env.SystemRoot ?? 'C:\\Windows';
    spawnSync(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, env: { SystemRoot: systemRoot } });
  };
  // The turn limit counts requests. Anything over it, or any attempt at QQ, says more than how the turn ended.
  const finish = () => {
    const hosts = refused();
    const qqAttempt = hosts.some((h) => /(^|\.)(qq\.com|tencent\.com)$/i.test(h));
    record({ kind: 'gateway', state: stopReason ?? 'finished', refusedHosts: hosts, qqRouteAttempt: qqAttempt });
    if (qqAttempt) stopReason = 'qq_route_attempt';
    return { stop: stopReason };
  };
  try {
    assertIsolated(paths, repoRoot);
    for (const d of [paths.home, paths.stateDir, paths.workspace, paths.cloDir, paths.logsDir, paths.gatewayCwd, join(paths.runtime, 'temp'), join(paths.runtime, 'appdata', 'Roaming'), join(paths.runtime, 'appdata', 'Local')]) mkdirSync(d, { recursive: true });
    const { startMockQq } = await import('../../tests/harness/mock-qq.mjs');
    qq = await startMockQq();
    const port = await allocPort();
    const { effective, workspace, rendered } = renderForProbe({ repoRoot, paths, qqBase: qq.base, port, catalog, baseUrl, key, testMode });
    writeAtomic(paths.effectiveJson, JSON.stringify(effective, null, 2));
    for (const [name, text] of Object.entries(workspace.files)) writeAtomic(join(paths.workspace, name), text);
    writeAtomic(paths.systemPromptFile, workspace.systemPrompt);
    writeAtomic(paths.openclawJson, rendered);

    const token = randomBytes(32).toString('hex');
    const limit = plan.turnCallLimit;
    writeFileSync(turnFile, 'none');
    const childEnv = q5GatewayEnv(paths, parentEnv, {
      key,
      token,
      allowedHost: guardAllowedHost ?? (testMode ? '' : new URL(baseUrl).hostname),
      guardLog,
      testMode,
      modelOrigin: new URL(baseUrl).origin,
      callLog,
      turnFile,
      // A test can raise it to reach the second layer below. The plan's figure comes from plan.turnCallLimit.
      turnCallLimit: plan.guardCallLimit ?? limit,
    });
    logFd = openSync(paths.gatewayLog, 'a');
    // The same Node flags as clo start, so the probe measures the Gateway as it is really started.
    child = spawnImpl(privateNode(paths), [
      ...GATEWAY_NODE_FLAGS,
      `--import=${pathToFileURL(OUTPUT_FILTER).href}`,
      `--import=${pathToFileURL(GUARD).href}`,
      ...(testMode || guardAllowedHost ? testImports.map((f) => `--import=${pathToFileURL(f).href}`) : []),
      openclawEntry(paths), 'gateway', 'run', '--port', String(port), '--bind', 'loopback',
    ], { cwd: paths.gatewayCwd, env: childEnv, stdio: ['ignore', logFd, logFd], windowsHide: true });
    child.on('exit', (code) => { exited = { code }; });
    child.on('error', () => { exited = { code: null }; });
    writeFileSync(join(paths.runtime, 'gateway.pid'), String(child.pid));
    say(`Gateway started in a temp root, process ${child.pid}. Waiting for it to connect to the mock QQ.`);

    const connected = await until(() => {
      if (exited) return 'exit';
      return qq.connected() === 1 && readJsonlSafe(paths.eventLog).some((e) => e.event === 'connection_ready') ? 'up' : null;
    }, CONNECT_TIMEOUT_MS, { signal });
    if (connected !== 'up') {
      stopReason = signal?.aborted ? 'interrupted' : 'gateway_not_connected';
      return finish();
    }

    const turnTimeout = (effective.timeouts.turnSeconds * 2 + 60) * 1000;
    for (const turn of plan.turns) {
      if (signal?.aborted) {
        stopReason = 'interrupted';
        break;
      }
      if (!tracker.canAfford(turn.worstMicros)) {
        stopReason = 'cap';
        break;
      }
      const postsBefore = qq.messagePosts().length;
      const started = Date.now();
      const rawId = `Q5MSG${randomBytes(6).toString('hex').toUpperCase()}`;
      writeFileSync(turnFile, turn.id);
      qq.push('GROUP_MESSAGE_CREATE', mentionEvent(rawId, turn.text));
      let overLimit = false;
      const ended = () => readJsonlSafe(paths.eventLog).filter((e) => e.event === 'model_call_ended' && e.t >= started).length;
      let facts = await until(() => {
        const f = turnFacts(paths, rawId);
        if (f?.row && TURN_TERMINAL.has(f.row.state)) return f;
        if (exited) return { gone: true };
        // The second layer, in case a route gets past the guard's count. Calls that end this close together are not
        // all caught, so it is not the bound the plan prints; a turn that trips it still stops the run.
        if (ended() > limit) {
          overLimit = true;
          killGateway();
          return { gone: true };
        }
        return null;
      }, turnTimeout, { signal, stepMs: 100 });
      const gone = Boolean(facts?.gone);
      // Dead, or the turn is closed and a late usage event can still settle its hold.
      if (gone) {
        await until(() => exited, 15000);
        facts = turnFacts(paths, rawId);
      } else if (facts) {
        facts = await until(() => {
          const f = turnFacts(paths, rawId);
          return f && f.holds.every((h) => h.status === 'settled' || h.status === 'released') ? f : null;
        }, SETTLE_WAIT_MS, { signal }) ?? turnFacts(paths, rawId);
      }
      const holds = facts?.holds ?? [];
      const settled = holds.filter((h) => h.status === 'settled' && h.actual_micros > 0 && h.source !== 'key_delta_none');
      const unknown = !facts?.row || holds.length === 0 || holds.some((h) => h.status !== 'settled' && h.status !== 'released');
      const actualMicros = settled.reduce((a, h) => a + h.actual_micros, 0);
      const events = readJsonlSafe(paths.eventLog).filter((e) => e.t >= started && (!facts || !('eventKey' in e) || e.eventKey === facts.eventKey));
      const calls = events.filter((e) => e.event === 'model_call_ended');
      const usage = events.filter((e) => e.event === 'turn_usage');
      const requests = readJsonlSafe(callLog).filter((l) => l.turn === turn.id);
      const allowed = requests.filter((l) => !l.refused).length;
      const refusedRequests = requests.length - allowed;
      // The settled figure covers the calls that reported usage, and compaction or a failed attempt can report none.
      // Which call that was is not known here, so every call past the first counts at its worst.
      const sent = Math.max(allowed, calls.length);
      const noFigure = unknown || actualMicros === 0;
      const hiddenCalls = noFigure ? 0 : Math.max(0, sent - 1);
      const hiddenMicros = hiddenCalls * plan.turnCallWorstMicros;
      const atWorstMicros = Math.max(turn.worstMicros, sent * plan.turnCallWorstMicros);
      if (noFigure) {
        tracker.addMissing(atWorstMicros);
      } else {
        tracker.addReported(actualMicros);
        if (hiddenCalls) tracker.addMissing(hiddenMicros);
      }
      const line = {
        kind: 'gateway_turn',
        id: turn.id,
        state: facts?.row?.state ?? 'timeout',
        reason: facts?.row?.reason ?? null,
        tier: holds[0]?.tier ?? null,
        heldUsd: round6(holds.reduce((a, h) => a + h.held_micros, 0)),
        actualUsd: settled.length ? round6(actualMicros) : null,
        source: settled[0]?.source ?? null,
        usageMissing: noFigure || hiddenCalls > 0,
        countedUsd: round6(noFigure ? atWorstMicros : actualMicros + hiddenMicros),
        worstUsd: round6(turn.worstMicros),
        durationMs: Date.now() - started,
        posts: qq.messagePosts().length - postsBefore,
        modelCalls: calls.length,
        modelCallErrors: calls.filter((e) => e.state === 'error').length,
        guardRequests: allowed,
        refusedRequests,
        hiddenCalls,
        turnCallLimit: limit,
        hostNotices: events.filter((e) => e.reason === 'host-notice').length,
        inputTokens: usage.reduce((a, e) => a + (e.inputTokens ?? 0), 0),
        outputTokens: usage.reduce((a, e) => a + (e.outputTokens ?? 0), 0),
        cacheReadTokens: usage.reduce((a, e) => a + (e.cacheReadTokens ?? 0), 0),
        cacheWriteTokens: usage.reduce((a, e) => a + (e.cacheWriteTokens ?? 0), 0),
        alerts: facts?.alerts ?? [],
        paidPaused: facts?.paidPaused ?? null,
      };
      record(line);
      say(`${turn.id}: state ${line.state}, ${sent} model request(s), counted ${usdText(Math.round(line.countedUsd * 1e6))}${noFigure ? ' (no usage, counted at worst case)' : ''}${hiddenCalls ? ` (${hiddenCalls} call(s) with no usage of their own, counted at worst case)` : ''}.`);
      if (signal?.aborted) {
        stopReason = 'interrupted';
      } else if (refusedRequests > 0 || overLimit) {
        stopReason = 'gateway_call_limit';
        say(`The host went past ${limit} model requests in one turn, so the Gateway was ended.`);
      } else if (gone) {
        stopReason = 'gateway_exited';
      } else if (calls.length > allowed) {
        // The guard should have counted these. If it cannot see this route, the limit does not hold.
        stopReason = 'guard_missed_requests';
        say('The host reported more model calls than the guard counted, so the request limit cannot be trusted on this route.');
      } else if (facts?.row?.state !== 'completed' || line.paidPaused || line.modelCallErrors > 0) {
        stopReason = 'gateway_turn_failed';
      }
      if (stopReason) break;
    }
    return finish();
  } finally {
    killGateway();
    if (child) await until(() => exited, 15000);
    if (logFd !== null) closeSync(logFd);
    await qq?.stop();
    if (!keepRunRoot) {
      try {
        // Holds the host's session store, with the fixed prompts and the model's answers.
        rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        say(`Could not remove the temp root ${runRoot}. It holds the host's session store: delete it by hand.`);
      }
    }
  }
}

// --- Key lag ---

async function readKey({ http, baseUrl, key }) {
  let res;
  let body;
  try {
    res = await http(`${baseUrl}/key`, { method: 'GET', headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
    body = parseJson(await res.text());
  } catch {
    return { ok: false, class: 'network', httpStatus: null };
  }
  if (!res.ok) {
    const c = classifyError(res.status, body?.error ?? null);
    return { ok: false, class: c.class, httpStatus: res.status, ...c };
  }
  const d = body?.data;
  if (num(d?.usage) === null) return { ok: false, class: 'bad_shape', httpStatus: res.status };
  return { ok: true, usage: d.usage, limit: num(d.limit), remaining: num(d.limit_remaining), limitReset: typeof d.limit_reset === 'string' ? d.limit_reset : null };
}

// Once at every exit after anything paid was tried, stop or no stop: that is when spend is least certain. The Key can
// lag, so a low figure proves nothing, and a high one means more was spent than this run counted.
async function closingKeyCheck({ http, baseUrl, key, baselineUsage, totals, record, say }) {
  const k = await readKey({ http, baseUrl, key });
  const flags = [];
  if (totals.totalMicros > totals.capMicros) flags.push('tracker_above_cap');
  if (!k.ok) {
    flags.push('key_unreadable');
    record({ kind: 'key_check', class: k.class, httpStatus: k.httpStatus, flags });
    say('Could not read the Key at the end, so the spend could not be compared with it. Check OpenRouter by hand.');
    return { flags };
  }
  const deltaMicros = Math.round((k.usage - baselineUsage) * 1e6);
  if (deltaMicros > totals.capMicros) flags.push('key_delta_above_cap');
  if (deltaMicros > totals.totalMicros + KEY_TOLERANCE_MICROS) flags.push('key_delta_above_tracker');
  record({ kind: 'key_check', class: 'ok', keyDeltaUsd: round6(deltaMicros), totalUsd: round6(totals.totalMicros), capUsd: round6(totals.capMicros), flags });
  say(`Key spend since the start: ${usdText(deltaMicros)}, counted here ${usdText(totals.totalMicros)}, cap ${usdText(totals.capMicros)}. The Key can lag behind, so a lower figure proves nothing.`);
  if (flags.includes('key_delta_above_cap')) say('WARNING: the Key shows more than the cap. Check OpenRouter by hand.');
  if (flags.includes('key_delta_above_tracker')) say('WARNING: the Key shows more than this run counted. Either calls went uncounted, or something else used this Key.');
  if (flags.includes('tracker_above_cap')) say('WARNING: the running total went past the cap.');
  return { flags };
}

async function measureLag({ http, baseUrl, key, baselineUsage, reportedMicros, lastPaidAt, lagMs, pollMs, signal, record, say }) {
  let firstDeltaMs = null;
  let matchedMs = null;
  let polls = 0;
  let deltaMicros = 0;
  const target = reportedMicros * MATCH_RATIO;
  const end = lastPaidAt + lagMs;
  for (;;) {
    const k = await readKey({ http, baseUrl, key });
    polls += 1;
    if (!k.ok && STOP_STATUS.has(k.httpStatus)) {
      record({ kind: 'lag', state: 'key_read_stopped', class: k.class, httpStatus: k.httpStatus, polls });
      return { firstDeltaMs, matchedMs, timedOut: false, polls, deltaMicros, stopped: k.class };
    }
    if (k.ok) {
      deltaMicros = Math.round((k.usage - baselineUsage) * 1e6);
      if (deltaMicros > 0 && firstDeltaMs === null) firstDeltaMs = Date.now() - lastPaidAt;
      if (reportedMicros > 0 && deltaMicros >= target) matchedMs = Date.now() - lastPaidAt;
    }
    if (matchedMs !== null || Date.now() >= end || signal?.aborted) break;
    await sleep(pollMs);
  }
  const lag = { firstDeltaMs, matchedMs, timedOut: matchedMs === null, polls, deltaMicros };
  record({ kind: 'lag', firstDeltaMs, matchedMs, timedOut: lag.timedOut, polls, keyDeltaUsd: round6(deltaMicros), reportedUsd: round6(reportedMicros) });
  say(matchedMs === null ? `Key spend did not reach the reported figure within the wait. First change at ${firstDeltaMs ?? 'none'} ms.` : `Key spend matched after ${Math.round(matchedMs / 1000)} s.`);
  return lag;
}

// --- suggestions ---

const maxOf = (values) => {
  const list = values.filter((v) => typeof v === 'number');
  return list.length ? Math.max(...list) : null;
};
const tokenDelta = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : null);

export function suggestConfig({ plan, calls, turns, lag, prices }) {
  const byId = Object.fromEntries(calls.map((c) => [c.id, c]));
  const ok = (role) => calls.filter((c) => c.role === role && c.class === 'ok');
  const out = [];
  const add = (name, current, suggested, basis, observed = null) => out.push({ name, current, suggested, basis, observed });

  const primaryObserved = maxOf([...ok('primary').map((c) => c.completionTokens), ...turns.map((t) => t.outputTokens)]);
  const primaryCut = ok('primary').some((c) => c.finishReason === 'length') || turns.some((t) => t.hostNotices > 0);
  if (primaryObserved === null) add('claudeModel.maxTokens', plan.primaryMaxTokens, plan.primaryMaxTokens, 'no_data');
  else if (primaryCut) add('claudeModel.maxTokens', plan.primaryMaxTokens, plan.primaryMaxTokens * 2, 'truncated_in_probe', primaryObserved);
  else if (primaryObserved * 2 > plan.primaryMaxTokens) add('claudeModel.maxTokens', plan.primaryMaxTokens, primaryObserved * 2, 'observed_above_half', primaryObserved);
  else add('claudeModel.maxTokens', plan.primaryMaxTokens, plan.primaryMaxTokens, 'keep_small_sample', primaryObserved);

  const decisionObserved = maxOf(ok('decision').map((c) => c.completionTokens));
  const decisionCut = ok('decision').some((c) => c.finishReason === 'length');
  if (decisionObserved === null) add('decisionModel.maxTokens', plan.decisionMaxTokens, plan.decisionMaxTokens, 'no_data');
  else if (decisionCut) add('decisionModel.maxTokens', plan.decisionMaxTokens, plan.decisionMaxTokens * 2, 'truncated_in_probe', decisionObserved);
  else if (decisionObserved * 2 > plan.decisionMaxTokens) add('decisionModel.maxTokens', plan.decisionMaxTokens, decisionObserved * 2, 'observed_above_half', decisionObserved);
  else add('decisionModel.maxTokens', plan.decisionMaxTokens, plan.decisionMaxTokens, 'keep_small_sample', decisionObserved);

  const decisionPrompt = byId.decision_with_prompt?.promptTokens ?? null;
  const largestInput = decisionPrompt === null ? null : largestDecisionInput(plan, decisionPrompt);
  if (largestInput === null) add('ledger.decisionHoldInputTokens', DECISION_INPUT_TOKENS, DECISION_INPUT_TOKENS, 'no_data');
  else if (largestInput > DECISION_INPUT_TOKENS) add('ledger.decisionHoldInputTokens', DECISION_INPUT_TOKENS, largestInput, 'largest_input_above_hold', decisionPrompt);
  else add('ledger.decisionHoldInputTokens', DECISION_INPUT_TOKENS, DECISION_INPUT_TOKENS, 'keep', decisionPrompt);

  if (prices) {
    const hold = 2 * (plan.contextTokens * Math.max(prices.inputPerM, prices.cacheWritePerM ?? 0) + plan.primaryMaxTokens * prices.outputPerM);
    add('ledger.replyRequiredHoldUsd', null, round6(hold), 'catalog_price_times_cap', maxOf(turns.map((t) => t.actualUsd)));
  } else {
    add('ledger.replyRequiredHoldUsd', null, null, 'no_data');
  }

  const failures = calls.filter((c) => c.class !== 'ok').length + turns.filter((t) => t.modelCallErrors > 0).length;
  add('budget.providerFailStreakPause', CURRENT_STREAK, CURRENT_STREAK, failures ? 'failures_seen_review_by_hand' : 'no_failure_seen', failures);

  if (!lag) add('ledger.UNSETTLED_CLEAR_MS', CURRENT_LAG_MS, CURRENT_LAG_MS, 'no_data');
  else if (lag.matchedMs !== null) add('ledger.UNSETTLED_CLEAR_MS', CURRENT_LAG_MS, Math.max(CURRENT_LAG_MS, lag.matchedMs * 2), lag.matchedMs * 2 > CURRENT_LAG_MS ? 'observed_lag_doubled' : 'keep', lag.matchedMs);
  else add('ledger.UNSETTLED_CLEAR_MS', CURRENT_LAG_MS, CURRENT_LAG_MS, 'lag_not_reached_rerun_longer', lag.firstDeltaMs);
  return out;
}

// --- the run ---

// The estimate covers input, output and cache only. A price that applies to every request or to reasoning breaks it,
// and so does a field nobody has read. Search, image and audio prices bill for things this tool never sends, and real
// catalog rows can carry them, so those are noted and not refused.
// Seen on the real catalog: input_cache_write_1h on both models, and on the decision model a pricing.overrides
// array holding higher prices from min_prompt_tokens up. Both are bounded by priceAboveCeiling, not waved through.
const PRICE_INPUT_FIELDS = ['prompt', 'input_cache_read', 'input_cache_write', 'input_cache_write_1h'];
const PRICE_IN_ESTIMATE = new Set([...PRICE_INPUT_FIELDS, 'completion']);
const PRICE_NOT_USED = new Set(['web_search', 'image', 'image_output', 'image_token', 'audio', 'audio_output', 'input_audio', 'input_audio_cache', 'video']);

function overridesReadable(overrides) {
  if (overrides === undefined) return true;
  if (!Array.isArray(overrides)) return false;
  return overrides.every((tier) => tier !== null && typeof tier === 'object' && !Array.isArray(tier) && Object.entries(tier).every(([k, v]) => (
    (k === 'min_prompt_tokens' || PRICE_IN_ESTIMATE.has(k) || PRICE_NOT_USED.has(k)) && Number.isFinite(Number(v)) && typeof v !== 'object'
  )));
}

export function extraPriceFields(row) {
  const { overrides, ...flat } = row?.pricing ?? {};
  const fields = Object.entries(flat).filter(([k, v]) => !PRICE_IN_ESTIMATE.has(k) && Number(v) !== 0).map(([k]) => k);
  const refused = fields.filter((k) => !PRICE_NOT_USED.has(k));
  if (!overridesReadable(overrides)) refused.push('overrides');
  return { refused, unused: fields.filter((k) => PRICE_NOT_USED.has(k)) };
}

// Every tier and every input-side rate has to fit the ceilings, or the printed worst case is not a worst case.
// Rounds to whole micro-dollars per million, because 0.000008 * 1e6 is not reliably 8 in floating point.
export function priceAboveCeiling(row, ceiling) {
  const perM = (v) => Math.round(Number(v) * 1e12) / 1e6;
  const pricing = row?.pricing ?? {};
  const tiers = [pricing, ...(Array.isArray(pricing.overrides) ? pricing.overrides : [])];
  return tiers.some((tier) => PRICE_INPUT_FIELDS.some((k) => tier[k] !== undefined && perM(tier[k]) > ceiling.inputPerM)
    || (tier.completion !== undefined && perM(tier.completion) > ceiling.outputPerM));
}

function checkCatalog(plan, catalog, cfg) {
  const problems = [];
  const unused = new Set();
  let primary = null;
  try {
    primary = resolveSelector('opus-latest', catalog);
  } catch {
    problems.push('selector_refused');
  }
  if (primary !== null && primary !== plan.primaryId) problems.push('primary_id_differs');
  let prices = null;
  let decisionPrices = null;
  try {
    const p = priceFor(plan.primaryId, catalog);
    const d = priceFor(plan.decisionId, catalog);
    prices = p;
    decisionPrices = d;
    for (const [role, id] of [['primary', plan.primaryId], ['decision', plan.decisionId]]) {
      const row = catalog.find((m) => m.id === id);
      const extra = extraPriceFields(row);
      if (extra.refused.length) problems.push(`${role}_price_outside_estimate`);
      for (const k of extra.unused) unused.add(k);
      if (priceAboveCeiling(row, PRICE_CEILING[role])) problems.push(`${role}_price_above_ceiling`);
    }
  } catch {
    problems.push('price_missing');
  }
  if (!validateModels(cfg, catalog).ok) problems.push('models_invalid');
  return { problems, prices, decisionPrices, unusedPriceFields: [...unused] };
}

export async function runProbe({ plan, baseUrl, key, maxUsd, resultPath, say, fetchImpl = globalThis.fetch, gatewayStage = runGatewayStage, testMode = false, parentEnv = {}, tempParent = null, repoRoot, lagMs = DEFAULT_LAG_MINUTES * 60000, pollMs = POLL_MS, signal, keepRunRoot = false }) {
  const capMicros = Math.floor(maxUsd * 1e6);
  if (plan.totalWorstMicros > capMicros) throw new Error(`refused: worst case ${usdText(plan.totalWorstMicros)} is above --max-usd`);
  const http = restrictedFetch(baseUrl, fetchImpl);
  const tracker = createSpendTracker(capMicros);
  const record = resultWriter(resultPath, [key]);
  const calls = [];
  const turns = [];
  const trackedRecord = (line) => {
    record(line);
    if (line.kind === 'call') calls.push(line);
    if (line.kind === 'gateway_turn') turns.push(line);
  };
  record({ kind: 'run_start', planCalls: plan.calls.length, planTurns: plan.turns.length, maxModelCalls: plan.maxModelCalls, worstUsd: round6(plan.totalWorstMicros), maxUsd, primaryModel: plan.primaryId, decisionModel: plan.decisionId, testMode });

  let stopReason = null;
  let lag = null;
  let prices = null;
  let decisionPrices = null;
  const stopWith = (reason) => {
    stopReason = reason;
    record({ kind: 'stop', stopReason: reason });
  };

  const key0 = await readKey({ http, baseUrl, key });
  if (!key0.ok) {
    record({ kind: 'key_read', class: key0.class, httpStatus: key0.httpStatus, metadataKeys: key0.metadataKeys ?? [], metadataTypes: key0.metadataTypes ?? [], limitSource: key0.limitSource ?? null });
    stopWith(key0.class === 'region' || key0.class === 'region_suspected' ? key0.class : `key_read_${key0.class}`);
  } else {
    record({ kind: 'key_read', class: 'ok', keyLimitUsd: key0.limit, keyRemainingUsd: key0.remaining, keyLimitReset: oneOf(LIMIT_RESETS, key0.limitReset) });
    if (key0.limit === null || key0.limitReset !== 'daily') {
      stopWith('no_daily_limit');
      say('Refused: this key has no daily limit. Set one on OpenRouter (limit_reset daily) and run again. No paid call was made.');
    } else if (key0.limit * 1e6 > capMicros) {
      // This limit is the one thing that can stop the host mid-turn, so it has to be the ceiling the user agreed to.
      stopWith('key_limit_above_cap');
      say(`Refused: this key's daily limit $${key0.limit} is above --max-usd $${maxUsd}. Lower the limit on OpenRouter, or raise --max-usd to it. No paid call was made.`);
    } else if (key0.remaining !== null && key0.remaining * 1e6 < plan.totalWorstMicros) {
      say(`Note: the key has $${key0.remaining} left today, below the worst case. If it runs out the provider refuses and the run stops.`);
    }
  }

  let catalog = null;
  let cfg = null;
  if (!stopReason) {
    try {
      catalog = await fetchCatalog({ fetch: http, baseUrl });
      cfg = probeConfig({ repoRoot, qqBase: 'http://127.0.0.1:9', port: 1, modelBase: testMode ? baseUrl : null });
      const checked = checkCatalog(plan, catalog, cfg);
      prices = checked.prices;
      decisionPrices = checked.decisionPrices;
      if (checked.problems.length) {
        record({ kind: 'catalog', class: 'refused', metadataKeys: checked.problems });
        stopWith(`catalog_${checked.problems[0]}`);
        say(`Refused before any paid call. Catalog problems: ${checked.problems.join(', ')}.`);
      } else {
        record({ kind: 'catalog', class: 'ok', catalogInputPerM: prices.inputPerM, catalogOutputPerM: prices.outputPerM, unusedPriceFields: checked.unusedPriceFields });
        if (checked.unusedPriceFields.length) say(`Note: the catalog also prices ${checked.unusedPriceFields.join(', ')}. This tool sends none of those, so they are not in the estimate.`);
      }
    } catch {
      record({ kind: 'catalog', class: 'read_failed' });
      stopWith('catalog_read_failed');
    }
  }

  let lastPaidAt = null;
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
      const { line, stop } = await paidCall({ http, baseUrl, key, call, tracker, record: trackedRecord, signal, price: call.role === 'primary' ? prices : decisionPrices });
      lastPaidAt = Date.now();
      say(`${call.id}: ${line.class}${line.httpStatus ? ` (HTTP ${line.httpStatus})` : ''}, counted $${line.countedUsd}${line.usageMissing ? ' (no usage, counted at worst case)' : ''}.`);
      if (stop) {
        stopWith(stop);
        if (stop === 'region') say('Stopped at once: the provider reported a region error.');
        else if (stop === 'region_suspected') say('Stopped at once: a region word appeared in the provider error, so this may be a region error. It is not confirmed, and the text is not kept.');
        else say(`Stopped: ${stop}. Not retried.`);
        break;
      }
    }
  }

  // Before a Gateway costs a start-up, when the direct calls already used more than planned.
  if (!stopReason && plan.turns.length && !tracker.canAfford(plan.turns[0].worstMicros)) {
    stopWith('cap');
    say('Stopped before the Gateway stage: a turn could pass the cap.');
  }

  if (!stopReason) {
    const staged = await gatewayStage({ plan, catalog, baseUrl, key, tracker, record: trackedRecord, say, testMode, parentEnv, tempParent, repoRoot, signal, keepRunRoot });
    lastPaidAt = Date.now();
    if (staged?.stop) {
      stopWith(staged.stop);
      say(`Stopped in the Gateway stage: ${staged.stop}.`);
    }
  }

  if (!stopReason && lagMs > 0) {
    say(`Reading the Key until it shows the spend, up to ${Math.round(lagMs / 60000)} minutes. These reads are not charged.`);
    lag = await measureLag({ http, baseUrl, key, baselineUsage: key0.usage, reportedMicros: tracker.totals().reportedMicros, lastPaidAt, lagMs, pollMs, signal, record, say });
    if (lag.stopped) stopWith(`lag_${lag.stopped}`);
  }

  let keyCheck = null;
  if (lastPaidAt !== null && key0.ok) {
    keyCheck = await closingKeyCheck({ http, baseUrl, key, baselineUsage: key0.usage, totals: tracker.totals(), record, say });
    // A stop already recorded says why the run ended. The flags stay in the results and the summary.
    if (!stopReason && keyCheck.flags.length) stopWith(keyCheck.flags[0]);
  }

  const totals = tracker.totals();
  const suggestions = suggestConfig({ plan, calls, turns, lag, prices });
  for (const s of suggestions) record({ kind: 'suggestion', ...s });
  record({ kind: 'summary', completed: stopReason === null, stopReason, flags: keyCheck?.flags ?? [], reportedUsd: round6(totals.reportedMicros), countedAtWorstUsd: round6(totals.countedAtWorstMicros), missingCount: totals.missingCount, totalUsd: round6(totals.totalMicros), capUsd: round6(capMicros) });

  say('');
  say(stopReason ? `Run stopped: ${stopReason}.` : 'Run finished.');
  say(`Total reported spend: ${usdText(totals.reportedMicros)}.`);
  say(`Counted at worst case because usage was missing: ${usdText(totals.countedAtWorstMicros)} (${totals.missingCount} calls or turns). Running total ${usdText(totals.totalMicros)}, cap ${usdText(capMicros)}.`);
  say('Suggested values. These are suggestions only: nothing was changed, and config.json was not read or written.');
  for (const s of suggestions) say(`  SUGGESTION ${s.name}: current ${s.current ?? 'n/a'}, suggested ${s.suggested ?? 'n/a'} (${s.basis}${s.observed === null ? '' : `, observed ${s.observed}`}).`);
  const policyTokens = tokenDelta(calls.find((c) => c.id === 'primary_policy')?.promptTokens, calls.find((c) => c.id === 'primary_baseline')?.promptTokens);
  const promptTokens = tokenDelta(calls.find((c) => c.id === 'decision_with_prompt')?.promptTokens, calls.find((c) => c.id === 'decision_baseline')?.promptTokens);
  say(`Content-policy block: ${policyTokens ?? 'no data'} tokens above baseline. Decision prompt: ${promptTokens ?? 'no data'} tokens above baseline.`);
  record({ kind: 'measure', name: 'content_policy_block', tokens: policyTokens });
  record({ kind: 'measure', name: 'decision_prompt', tokens: promptTokens });
  return { stopReason, totals, suggestions, calls, turns, lag, keyCheck };
}

// --- command line ---

const USAGE = `Usage: q5-probe [--approve --max-usd <dollars>] [--lag-minutes <1-30>]
Without --approve it prints the plan and exits. No request is made and .env is not read.`;

export function parseCli(argv) {
  const out = { approve: false, maxUsd: null, lagMinutes: DEFAULT_LAG_MINUTES };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--approve') {
      out.approve = true;
    } else if (a === '--max-usd') {
      i += 1;
      if (!/^\d+(\.\d+)?$/.test(argv[i] ?? '') || Number(argv[i]) <= 0) return { error: '--max-usd needs a positive number of dollars.' };
      out.maxUsd = Number(argv[i]);
    } else if (a === '--lag-minutes') {
      i += 1;
      if (!/^\d+$/.test(argv[i] ?? '') || Number(argv[i]) < 1 || Number(argv[i]) > 30) return { error: '--lag-minutes must be a whole number from 1 to 30.' };
      out.lagMinutes = Number(argv[i]);
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
    if (env.CLO_Q5_TEST_BASE) throw new Error('CLO_Q5_TEST_BASE is only allowed in test mode.');
    return { baseUrl: OPENROUTER_BASE_URL, testMode };
  }
  if (!env.CLO_Q5_TEST_BASE || !isLoopback(env.CLO_Q5_TEST_BASE)) throw new Error('Test mode needs a loopback CLO_Q5_TEST_BASE.');
  return { baseUrl: env.CLO_Q5_TEST_BASE, testMode };
}

// Ctrl-C, Ctrl-Break, a closed console (SIGHUP on Windows) and SIGTERM all end the same way, so the temp root goes.
export function watchStopSignals(ac) {
  const onStop = () => ac.abort();
  const names = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'];
  for (const name of names) process.on(name, onStop);
  return () => {
    for (const name of names) process.off(name, onStop);
  };
}

export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, fetchImpl = globalThis.fetch } = {}) {
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
  if (!env.CLO_TEST_ROOT) sweepOldRunRoots(tmpdir(), { say });
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
    fail(`Refused: the worst case ${usdText(plan.totalWorstMicros)} is above --max-usd $${cli.maxUsd}. Nothing was sent.`);
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
  const key = parseEnvFile(paths.envFile, ['CLO_CHAT_API_KEY']).CLO_CHAT_API_KEY;
  if (!key) {
    fail('CLO_CHAT_API_KEY is empty in .env. The old name OPENROUTER_API_KEY is no longer read.');
    return 2;
  }
  secrets = [key];
  const ac = new AbortController();
  const stopWatching = watchStopSignals(ac);
  const pollMs = endpoint.testMode && env.CLO_Q5_TEST_POLL_MS ? Number(env.CLO_Q5_TEST_POLL_MS) : POLL_MS;
  try {
    const out = await runProbe({
      plan,
      baseUrl: endpoint.baseUrl,
      key,
      maxUsd: cli.maxUsd,
      resultPath: join(paths.root, 'captures', 'q5-results.jsonl'),
      say,
      fetchImpl,
      testMode: endpoint.testMode,
      parentEnv: env,
      tempParent: endpoint.testMode ? paths.root : null,
      repoRoot: paths.repoRoot,
      lagMs: cli.lagMinutes * 60000,
      pollMs,
      signal: ac.signal,
      keepRunRoot: endpoint.testMode,
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
