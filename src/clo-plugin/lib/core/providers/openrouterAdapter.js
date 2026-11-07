// OpenRouter's chat completions, as an adapter for modelChat.js: the request bodies, byte for byte as before the
// provider layer, and the classification of every response shape. Pure: no fetch, no cost, no pause. Provider text
// never leaves: only status, error type, provider name, provider code and limit source come out as diagnostics.
import { MODEL_ID_RULES } from './registry.js';

const MAX_STRING = 128;

const scalar = (v) => (typeof v === 'string' || typeof v === 'number' ? v : undefined);
const shortString = (v) => (typeof v === 'string' && v.length <= MAX_STRING && /^[\w./:@-]+$/.test(v) ? v : null);
const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

// In the shape the gate's usageMicros and the ledger read. Null when the body carried no usage at all, which is never free.
export function mapUsage(usage, model) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const details = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object' ? usage.prompt_tokens_details : {};
  const cacheRead = count(details.cached_tokens);
  const cacheWrite = count(details.cache_write_tokens);
  return {
    input: Math.max(count(usage.prompt_tokens) - cacheRead - cacheWrite, 0),
    output: count(usage.completion_tokens),
    cacheRead,
    cacheWrite,
    costUsd: typeof usage.cost === 'number' && Number.isFinite(usage.cost) ? usage.cost : null,
    model: shortString(model),
  };
}

function errorInfo(status, error) {
  const meta = error && typeof error.metadata === 'object' ? error.metadata : null;
  return {
    status,
    error_type: scalar(error?.type),
    provider_name: scalar(meta?.provider_name),
    provider_code: scalar(error?.code),
    limitSource: typeof meta?.limit_source === 'string' ? meta.limit_source : null,
  };
}

// Only what callers read. A refusal is a flag, never its text; reasoning text and tool call bodies stay behind.
function slimMessage(m) {
  if (!m || typeof m !== 'object') return null;
  return { content: m.content, refusal: Boolean(m.refusal), toolCalls: Array.isArray(m.tool_calls) ? m.tool_calls.length : 0 };
}

const result = (kind, reason, over = {}) => ({ kind, reason, status: null, message: null, finishReason: null, usage: null, info: null, ...over });

// reason says which shape it was:
//   error: http (non-2xx), provider_error (a 2xx carrying an error object), bad_body (not JSON), no_choice (JSON with
//          no choice in it), tool_calls, finish_error (finish_reason 'error'), finish_reason (anything else but stop,
//          length or content_filter), model_mismatch
//   refusal: moderation (a 403 with no limit source), refusal (message.refusal), content_filter
//   ok: null; the caller still decides whether the content is usable
// The transport adds not_sent, aborted, network and timeout.
function classify(status, body, requestedModel) {
  const out = { status, message: null, finishReason: null, usage: null, info: null };
  if (body === null) return { ...out, kind: 'error', reason: 'bad_body', info: errorInfo(status, null) };
  const choice = Array.isArray(body?.choices) ? body.choices[0] : undefined;
  out.message = slimMessage(choice?.message);
  out.finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null;
  out.usage = mapUsage(body?.usage, body?.model);
  // A 2xx with no answer in it is the provider failing, as much as a body that is not JSON.
  if (!choice) return { ...out, kind: 'error', reason: 'no_choice' };
  const { message, finishReason } = out;
  if (message?.refusal === true) return { ...out, kind: 'refusal', reason: 'refusal' };
  if (finishReason === 'content_filter') return { ...out, kind: 'refusal', reason: 'content_filter' };
  if ((message?.toolCalls ?? 0) > 0 || finishReason === 'tool_calls') return { ...out, kind: 'error', reason: 'tool_calls' };
  // OpenRouter's own mark for a generation that broke off upstream.
  if (finishReason === 'error') return { ...out, kind: 'error', reason: 'finish_error' };
  if (finishReason !== 'stop' && finishReason !== 'length') return { ...out, kind: 'error', reason: 'finish_reason' };
  if (requestedModel && body.model !== requestedModel) return { ...out, kind: 'error', reason: 'model_mismatch' };
  return { ...out, kind: 'ok', reason: null };
}

// A non-2xx, or a 2xx whose body carries an error object.
function parseError(status, parsed) {
  const error = parsed && typeof parsed === 'object' ? parsed.error : undefined;
  const ok = status >= 200 && status <= 299;
  const info = errorInfo(status, error);
  // The Key's own limits are not moderation, whatever the status.
  const moderation = status === 403 && !info.limitSource;
  return result(moderation ? 'refusal' : 'error', !ok ? (moderation ? 'moderation' : 'http') : 'provider_error', {
    status, info, usage: mapUsage(parsed?.usage, parsed?.model),
  });
}

function messagesOf(body) {
  return Array.isArray(body?.messages) ? body.messages : [];
}

export const openrouterAdapter = Object.freeze({
  kind: 'openrouter',
  retryEvent: 'openrouter_retry',
  idRule: MODEL_ID_RULES.openrouter,

  // The Key goes in a header only.
  request: (key, baseUrl) => ({ url: `${baseUrl}/chat/completions`, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } }),

  // The main turn, keys in this order: the goldens pin the bytes.
  turnBody: ({ model, effort, maxTokens, system, user }) => ({
    model,
    stream: false,
    reasoning: { effort },
    max_tokens: maxTokens,
    provider: { require_parameters: true },
    usage: { include: true },
    messages: [
      // One cache breakpoint, at the end of the stable system block, with the default five-minute lifetime.
      { role: 'system', content: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: user },
    ],
  }),

  // The decision call, with its answer held to the schema.
  decisionBody: ({ model, effort, maxTokens, system, user, schema }) => ({
    model,
    stream: false,
    reasoning: { effort },
    max_tokens: maxTokens,
    response_format: { type: 'json_schema', json_schema: { name: schema.name, strict: true, schema: schema.schema } },
    provider: { require_parameters: true },
    usage: { include: true },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  }),

  // The system string as sent: the one text block of a turn, or the plain string of a decision. '' for anything else,
  // so a check that reads it fails closed.
  systemTextOf(body) {
    const m = messagesOf(body)[0];
    if (m?.role !== 'system') return '';
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content) && m.content.length === 1 && m.content[0]?.type === 'text' && typeof m.content[0].text === 'string') return m.content[0].text;
    return '';
  },
  userTextOf(body) {
    const m = messagesOf(body)[1];
    return m?.role === 'user' && typeof m.content === 'string' ? m.content : '';
  },
  requestedModel: (body) => (typeof body?.model === 'string' ? body.model : null),

  parseError,
  classify,
});
