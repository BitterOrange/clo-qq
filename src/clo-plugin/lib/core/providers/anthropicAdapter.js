// The Anthropic Messages API, as an adapter for modelChat.js. Raw HTTP, no SDK. Pure: no fetch, no cost, no pause.
// The request carries only whitelisted fields: never stream, fallbacks, beta headers, speed, inference_geo, metadata,
// tools, tool_choice or sampling parameters. Provider text never leaves: error messages, request ids, stop details,
// thinking text and tool bodies stay here; only short scalars come out. docs/provider-contract.md section 3.2.
// Facts marked unverified there are assumptions until the paid probe has seen the real API.
import { ANTHROPIC_EFFORTS, ANTHROPIC_VERSION, MODEL_ID_RULES } from './registry.js';

const MAX_STRING = 128;
// The decision call runs with thinking off, which Haiku 5.5 accepts at effort high or below; low keeps it short.
const DECISION_EFFORT = 'low';
// Matched on error.message, which itself never leaves this module. Unverified wording.
const CREDITS_PREFIX = 'Your credit balance is too low';
const SPEND_LIMIT_PREFIX = 'You have reached your specified';
// The tier cap's 429. Where the code sits in the body is unverified, so each plausible place is read.
const SPEND_LIMIT_CODE = 'enforced_spend_limit_reached';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const shortString = (v) => (typeof v === 'string' && v.length <= MAX_STRING && /^[\w./:@-]+$/.test(v) ? v : null);
const isCount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const absent = (v) => v === undefined || v === null;
// A count as it is, absent or null as 0, anything else unreadable. Never read as 0: that would settle billed tokens
// below their hold for good.
const optionalCount = (v) => (absent(v) ? 0 : isCount(v) ? v : null);

const result = (kind, reason, over = {}) => ({ kind, reason, status: null, message: null, finishReason: null, usage: null, info: null, ...over });
const infoOf = (status, errorType = null, limitSource = null) => ({ status, error_type: errorType, provider_name: null, provider_code: null, limitSource });

// The written cache tokens: the five-minute part, and the one-hour part or null when the split is unknown (cost.js
// then prices all of it at the one-hour rate and flags it). Null for cacheWrite when nothing can be read.
function cacheWrites(usage) {
  const total = usage.cache_creation_input_tokens;
  const split = usage.cache_creation;
  if (isObj(split)) {
    const m5 = split.ephemeral_5m_input_tokens;
    const h1 = split.ephemeral_1h_input_tokens;
    if (isCount(m5) && isCount(h1) && (absent(total) || total === m5 + h1)) return { cacheWrite: m5, cacheWrite1h: h1 };
  }
  if (isCount(total)) return { cacheWrite: total, cacheWrite1h: null };
  // A split that is there but cannot be read, with no total beside it, may hide real writes: nothing is read as 0.
  if (absent(total) && absent(split)) return { cacheWrite: 0, cacheWrite1h: null };
  return { cacheWrite: null, cacheWrite1h: null };
}

// Nothing is subtracted: input_tokens already excludes the cache tokens, and output_tokens includes thinking.
// cacheWrite1h, geo and speed are always set, to a value or to null: cost.js reads an absent field as "this provider
// has no such field". The usage field names inference_geo and speed are unverified.
export function mapUsage(usage, model) {
  if (!isObj(usage)) return null;
  return {
    input: isCount(usage.input_tokens) ? usage.input_tokens : null,
    output: isCount(usage.output_tokens) ? usage.output_tokens : null,
    cacheRead: optionalCount(usage.cache_read_input_tokens),
    ...cacheWrites(usage),
    costUsd: null,
    model: shortString(model),
    geo: shortString(usage.inference_geo) ?? null,
    speed: shortString(usage.speed) ?? null,
  };
}

function limitSourceOf(status, error) {
  const type = error?.type;
  const message = typeof error?.message === 'string' ? error.message : '';
  if (status === 402 || type === 'billing_error') return 'anthropic_credits';
  if (status === 400 && message.startsWith(CREDITS_PREFIX)) return 'anthropic_credits';
  if (status === 400 && message.startsWith(SPEND_LIMIT_PREFIX)) return 'anthropic_spend_limit';
  if (status === 429 && [error?.details?.error_code, error?.error_code, error?.code].includes(SPEND_LIMIT_CODE)) return 'anthropic_spend_limit';
  // Region, identity or access. Never a refusal: refusals come as a 200 with stop_reason refusal.
  if (status === 403) return 'anthropic_permission';
  return null;
}

// A non-2xx, or a 2xx carrying an error. The body is {type: 'error', error: {type, message}, request_id}; message and
// request_id are matched or ignored here and never returned.
function parseError(status, parsed) {
  const error = isObj(parsed) && isObj(parsed.error) ? parsed.error : null;
  const ok = status >= 200 && status <= 299;
  return result('error', ok ? 'provider_error' : 'http', {
    status,
    info: infoOf(status, shortString(error?.type), limitSourceOf(status, error)),
    usage: isObj(parsed) ? mapUsage(parsed.usage, parsed.model) : null,
  });
}

const FINISH = { end_turn: 'stop', max_tokens: 'length', refusal: 'refusal', tool_use: 'tool_use' };

// A 2xx. Text blocks are joined in order; thinking and redacted_thinking blocks, and any other block, are dropped.
// stop_details is never read.
function classify(status, body, requestedModel) {
  if (body === null) return result('error', 'bad_body', { status, info: infoOf(status) });
  if (isObj(body) && body.type === 'error') return parseError(status, body);
  const out = { status, message: null, finishReason: null, usage: null, info: null };
  if (!isObj(body)) return { ...out, kind: 'error', reason: 'no_choice' };
  out.usage = mapUsage(body.usage, body.model);
  const stop = body.stop_reason;
  out.finishReason = Object.hasOwn(FINISH, stop) ? FINISH[stop] : shortString(stop);
  if (!Array.isArray(body.content)) return { ...out, kind: 'error', reason: 'no_choice' };
  const texts = body.content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text);
  const toolCalls = body.content.filter((b) => b?.type === 'tool_use').length;
  out.message = { content: texts.length > 0 ? texts.join('') : null, refusal: stop === 'refusal', toolCalls };
  if (stop === 'refusal') return { ...out, kind: 'refusal', reason: 'refusal' };
  if (toolCalls > 0 || stop === 'tool_use') return { ...out, kind: 'error', reason: 'tool_calls' };
  if (stop !== 'end_turn' && stop !== 'max_tokens') return { ...out, kind: 'error', reason: 'finish_reason' };
  // Unverified: that body.model echoes the bare id that was asked for.
  if (requestedModel && body.model !== requestedModel) return { ...out, kind: 'error', reason: 'model_mismatch' };
  return { ...out, kind: 'ok', reason: null };
}

function checkCommon({ model, maxTokens, system, user }) {
  if (typeof model !== 'string' || !MODEL_ID_RULES.anthropic.test(model)) throw new TypeError('anthropic: model id');
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw new TypeError('anthropic: maxTokens');
  if (typeof system !== 'string' || typeof user !== 'string') throw new TypeError('anthropic: system and user are strings');
}

export const anthropicAdapter = Object.freeze({
  kind: 'anthropic',
  retryEvent: 'anthropic_retry',
  idRule: MODEL_ID_RULES.anthropic,

  // Exactly these three headers: the Key in a header only, the pinned API version, no beta header.
  request: (key, baseUrl) => ({
    url: `${baseUrl}/v1/messages`,
    headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
  }),

  // The main turn. Opus 5.5 thinking is adaptive and cannot be turned off, so there is no thinking key and effort is
  // the control. One cache breakpoint, at the end of the system block, with the default five-minute lifetime.
  turnBody({ model, effort, maxTokens, system, user }) {
    checkCommon({ model, maxTokens, system, user });
    if (!ANTHROPIC_EFFORTS.primary.includes(effort)) throw new TypeError('anthropic: primary effort');
    return {
      model,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
      output_config: { effort },
    };
  },

  // The decision call: effort 'none' only, sent as thinking disabled at a low effort, so thinking cannot use up the
  // small max_tokens. Unverified: that Haiku 5.5 takes this with a format.
  decisionBody({ model, effort, maxTokens, system, user, schema }) {
    checkCommon({ model, maxTokens, system, user });
    if (!ANTHROPIC_EFFORTS.decision.includes(effort)) throw new TypeError('anthropic: decision effort');
    if (!isObj(schema?.schema)) throw new TypeError('anthropic: decision schema');
    return {
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
      thinking: { type: 'disabled' },
      output_config: { effort: DECISION_EFFORT, format: { type: 'json_schema', schema: schema.schema } },
    };
  },

  // The system string as sent: the plain string of a decision, or the one text block of a turn. '' for anything else,
  // so a check that reads it fails closed.
  systemTextOf(body) {
    const s = body?.system;
    if (typeof s === 'string') return s;
    if (Array.isArray(s) && s.length === 1 && s[0]?.type === 'text' && typeof s[0].text === 'string') return s[0].text;
    return '';
  },
  userTextOf(body) {
    const m = Array.isArray(body?.messages) ? body.messages[0] : undefined;
    return m?.role === 'user' && typeof m.content === 'string' ? m.content : '';
  },
  requestedModel: (body) => (typeof body?.model === 'string' ? body.model : null),

  parseError,
  classify,
});
