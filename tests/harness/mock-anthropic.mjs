// Loopback stand-in for the Anthropic Messages API. Records every request. Replies are scripted per test, with the
// same control surface and step vocabulary as mock-openrouter.mjs, so a test can run on either kind.
//
// Shapes come from the Claude API reference (messages, errors, models). What the reference does not state is a
// mock-only assumption and is marked UNVERIFIED below: the paid probe must confirm it before anyone relies on it.
//
// This mock is stricter than the real API on purpose. It answers 400 to anything the project must never send: an
// Authorization header, an anthropic-beta header, stream:true, fallbacks, sampling parameters, and any body field
// outside the adapter's whitelist. The real API accepts some of these (an OAuth bearer, a valid beta); refusing them
// here makes a regression fail loudly.
import { createServer } from 'node:http';

const MESSAGES = /^\/v1\/messages$/;
const MODEL_ROUTE = /^\/v1\/models\/([^/?#]+)$/;

// The body fields the adapter may send (docs/provider-contract.md section 3.2).
export const BODY_WHITELIST = Object.freeze(['model', 'max_tokens', 'system', 'messages', 'output_config', 'thinking']);
// Never sent by this project. Each gets a 400 naming the field.
const REFUSED_FIELDS = Object.freeze(['stream', 'fallbacks', 'speed', 'inference_geo', 'metadata', 'tools', 'tool_choice', 'temperature', 'top_p', 'top_k', 'service_tier']);

// Markers a test can look for: they must never reach QQ, a log, the database or an Error.
export const REQUEST_ID_MARKER = 'REQIDLEAKMARKER';
export const STOP_DETAILS_MARKER = 'STOPDETAILSLEAKMARKER';
export const THINKING_MARKER = 'THINKINGLEAKMARKER';

export const isDecisionRequest = (rec) => Boolean(rec.body?.output_config?.format);

export const decisionText = ({ action = 'skip', skipClass = 'none', crisis = false } = {}) => JSON.stringify({ action, skip_class: skipClass, crisis, need_search: false });

// usage.inference_geo and usage.speed are UNVERIFIED field names (the contract's section 14). The adapter reads them
// and cost.js flags and pauses when they are absent, so the default answer carries the standard values.
const DEFAULT_USAGE = () => ({
  input_tokens: 10,
  output_tokens: 2,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  service_tier: 'standard',
  inference_geo: 'global',
  speed: 'standard',
});

// The OpenRouter prompt-detail keys this mock translates. Any other key under prompt_tokens_details is an error, so a
// script cannot assume a translation that does not happen.
const PROMPT_DETAIL_KEYS = Object.freeze(['cached_tokens', 'cache_write_tokens']);
const isCount = (v) => Number.isInteger(v) && v >= 0;

// The mock-openrouter usage vocabulary, read here too so one script runs on both mocks. OpenRouter's prompt_tokens
// counts the cached and written tokens too, while Anthropic's input_tokens excludes them, so the cache counts move to
// their own fields (writes as five-minute writes, the only TTL OpenRouter's usage names) and input_tokens keeps the rest.
// Anthropic-native keys in the step are applied last and win. Cost is dropped: Anthropic reports none.
function usageFrom(step) {
  if (step.usage === null) return undefined;
  const u = { ...DEFAULT_USAGE() };
  const given = step.usage ?? {};
  const details = given.prompt_tokens_details ?? {};
  if (typeof details !== 'object' || details === null || Array.isArray(details)) throw new Error('mock-anthropic: prompt_tokens_details must be an object');
  for (const k of Object.keys(details)) {
    if (!PROMPT_DETAIL_KEYS.includes(k)) throw new Error(`mock-anthropic: prompt_tokens_details.${k} has no Anthropic translation here`);
    if (!isCount(details[k])) throw new Error(`mock-anthropic: prompt_tokens_details.${k} must be a count`);
  }
  const cached = details.cached_tokens ?? 0;
  const written = details.cache_write_tokens ?? 0;
  if (Object.hasOwn(given, 'prompt_tokens')) {
    if (!isCount(given.prompt_tokens) || given.prompt_tokens < cached + written) throw new Error('mock-anthropic: prompt_tokens must count at least the cached and written tokens');
    u.input_tokens = given.prompt_tokens - cached - written;
  } else if (cached + written > 0) {
    throw new Error('mock-anthropic: cache details need prompt_tokens to split from');
  }
  u.cache_read_input_tokens = cached;
  u.cache_creation_input_tokens = written;
  u.cache_creation = { ephemeral_5m_input_tokens: written, ephemeral_1h_input_tokens: 0 };
  for (const [k, v] of Object.entries(given)) {
    if (k === 'prompt_tokens' || k === 'prompt_tokens_details') continue;
    if (k === 'completion_tokens') u.output_tokens = v;
    else if (['total_tokens', 'cost', 'completion_tokens_details', 'cost_details', 'is_byok'].includes(k)) continue;
    else u[k] = v;
  }
  if (step.geoUs) u.inference_geo = 'us';
  if (step.speedFast) u.speed = 'fast';
  if (step.geoMissing) {
    delete u.inference_geo;
    delete u.speed;
  }
  return u;
}

// mock-openrouter finish reasons, mapped to stop_reason. A value with no Anthropic counterpart is passed through as
// it is, which exercises the adapter's branch for a stop_reason it does not know.
const STOP_OF = { stop: 'end_turn', length: 'max_tokens', content_filter: 'refusal', tool_calls: 'tool_use' };

const errorBody = (type, message, n) => ({ type: 'error', error: { type, message }, request_id: `req_${REQUEST_ID_MARKER}_${n}` });

// Named error steps. The 402, 403, 429, 500 and 529 types are the reference's. The messages are not; the prefixes the
// adapter matches ("Your credit balance is too low", "You have reached your specified") and where the 429 spend-limit
// code sits are UNVERIFIED (contract section 14). `leak` is appended to each message so tests can check it stays put.
export const ERROR_STEPS = Object.freeze({
  credits402: (leak, n) => ({ status: 402, body: errorBody('billing_error', `Billing problem. ${leak}`, n) }),
  // UNVERIFIED: the prepaid-credits-exhausted shape. Secondary sources say a 400 with this prefix.
  credits400: (leak, n) => ({ status: 400, body: errorBody('invalid_request_error', `Your credit balance is too low to access the Anthropic API. ${leak}`, n) }),
  // UNVERIFIED: the workspace spend-limit message.
  spendLimit400: (leak, n) => ({ status: 400, body: errorBody('invalid_request_error', `You have reached your specified workspace API usage limits. ${leak}`, n) }),
  // UNVERIFIED: that the tier cap's 429 carries error.details.error_code.
  enforced429: (leak, n) => {
    const body = errorBody('rate_limit_error', `Spend limit reached. ${leak}`, n);
    body.error.details = { error_code: 'enforced_spend_limit_reached' };
    return { status: 429, body };
  },
  permission403: (leak, n) => ({ status: 403, body: errorBody('permission_error', `Request not allowed. ${leak}`, n) }),
  rateLimit429: (leak, n) => ({ status: 429, body: errorBody('rate_limit_error', `Too many requests. ${leak}`, n) }),
  overloaded529: (leak, n) => ({ status: 529, body: errorBody('overloaded_error', `Overloaded. ${leak}`, n) }),
  apiError500: (leak, n) => ({ status: 500, body: errorBody('api_error', `Internal error. ${leak}`, n) }),
  auth401: (leak, n) => ({ status: 401, body: errorBody('authentication_error', `invalid x-api-key ${leak}`, n) }),
  notFound404: (leak, n) => ({ status: 404, body: errorBody('not_found_error', `model: unknown ${leak}`, n) }),
});
export const ERROR_STEP_NAMES = Object.freeze(Object.keys(ERROR_STEPS));

// The capability tree GET /v1/models/{id} returns, in the reference's shape (capabilities.effort.<level>.supported,
// capabilities.structured_outputs.supported, capabilities.thinking.types.<type>.supported). The thinking.types.disabled
// leaf is UNVERIFIED: the reference's example shows enabled and adaptive only.
const efforts = (levels) => ({ supported: true, ...Object.fromEntries(['low', 'medium', 'high', 'xhigh', 'max'].map((l) => [l, { supported: levels.includes(l) }])) });
export const defaultModels = () => ({
  'claude-opus-5-5': {
    type: 'model', id: 'claude-opus-5-5', display_name: 'mock opus', max_input_tokens: 1000000, max_tokens: 128000,
    capabilities: {
      structured_outputs: { supported: true },
      thinking: { supported: true, types: { enabled: { supported: false }, adaptive: { supported: true }, disabled: { supported: false } } },
      effort: efforts(['low', 'medium', 'high', 'xhigh', 'max']),
    },
  },
  'claude-haiku-5-5': {
    type: 'model', id: 'claude-haiku-5-5', display_name: 'mock haiku', max_input_tokens: 1000000, max_tokens: 128000,
    capabilities: {
      structured_outputs: { supported: true },
      thinking: { supported: true, types: { enabled: { supported: false }, adaptive: { supported: true }, disabled: { supported: true } } },
      effort: efforts(['low', 'medium', 'high', 'xhigh', 'max']),
    },
  },
});

// Request checks the reference documents, then the mock's own refusals. null when the request may be answered.
function refusalOf(req, body, n) {
  const h = req.headers;
  if (!h['x-api-key']) return { status: 401, body: errorBody('authentication_error', 'x-api-key header is required', n), why: 'no_key' };
  if (h.authorization !== undefined) return { status: 400, body: errorBody('invalid_request_error', 'mock: this project never sends an Authorization header', n), why: 'authorization' };
  if (h['anthropic-beta'] !== undefined) return { status: 400, body: errorBody('invalid_request_error', `Unexpected value(s) \`${h['anthropic-beta']}\` for the \`anthropic-beta\` header.`, n), why: 'beta' };
  if (!h['anthropic-version']) return { status: 400, body: errorBody('invalid_request_error', 'anthropic-version: header is required', n), why: 'no_version' };
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { status: 400, body: errorBody('invalid_request_error', 'mock: body is not a JSON object', n), why: 'bad_json' };
  for (const f of REFUSED_FIELDS) {
    if (Object.hasOwn(body, f)) return { status: 400, body: errorBody('invalid_request_error', `mock: ${f} is never sent by this project`, n), why: f };
  }
  for (const f of Object.keys(body)) {
    if (!BODY_WHITELIST.includes(f)) return { status: 400, body: errorBody('invalid_request_error', `mock: ${f}: Extra inputs are not permitted`, n), why: f };
  }
  if (typeof body.model !== 'string' || !Number.isInteger(body.max_tokens) || body.max_tokens <= 0 || !Array.isArray(body.messages) || body.messages.length === 0) {
    return { status: 400, body: errorBody('invalid_request_error', 'mock: model, max_tokens and messages are required', n), why: 'required' };
  }
  // Documented: Opus 5.5 refuses thinking disabled at every effort; Haiku 5.5 refuses it at xhigh and max.
  const thinking = body.thinking?.type;
  const effort = body.output_config?.effort;
  if (/^claude-opus-5-5$/.test(body.model) && (thinking === 'disabled' || thinking === 'enabled')) {
    return { status: 400, body: errorBody('invalid_request_error', `"thinking.type.${thinking}" is not supported for this model.`, n), why: 'thinking_opus' };
  }
  if (/^claude-haiku-5-5$/.test(body.model) && thinking === 'disabled' && (effort === 'xhigh' || effort === 'max')) {
    return { status: 400, body: errorBody('invalid_request_error', `output_config.effort '${effort}' is not supported when thinking is disabled on this model.`, n), why: 'thinking_haiku' };
  }
  return null;
}

export async function startMockAnthropic() {
  const requests = [];
  const other = [];
  const modelReads = [];
  let script = () => ({ text: '好的。' });
  let decide = () => ({ text: decisionText() });
  let counter = 0;
  let models = defaultModels();

  const send = (res, status, obj) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(obj));
  };

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', async () => {
      const path = req.url.split('?')[0];
      const modelMatch = MODEL_ROUTE.exec(path);
      if (req.method === 'GET' && modelMatch) {
        const id = decodeURIComponent(modelMatch[1]);
        const hasKey = Boolean(req.headers['x-api-key']);
        modelReads.push({ id, headers: { ...req.headers } });
        if (!hasKey) return send(res, 401, errorBody('authentication_error', 'x-api-key header is required', ++counter));
        if (!Object.hasOwn(models, id)) return send(res, 404, errorBody('not_found_error', `model: ${id}`, ++counter));
        return send(res, 200, models[id]);
      }
      if (req.method !== 'POST' || !MESSAGES.test(path)) {
        // The OpenRouter /key route among them: an Anthropic Key must never be read there.
        other.push({ method: req.method, url: req.url });
        return send(res, 404, errorBody('not_found_error', 'mock: no such route', ++counter));
      }
      let body = null;
      try { body = JSON.parse(raw); } catch { /* recorded as null */ }
      const n = ++counter;
      const rec = { kind: 'anthropic', url: req.url, headers: { ...req.headers }, body, at: Date.now(), rejected: null, reply: null };
      requests.push(rec);
      const refused = refusalOf(req, body, n);
      if (refused) {
        rec.rejected = refused.why;
        rec.answeredAt = Date.now();
        rec.reply = { status: refused.status, usage: null };
        return send(res, refused.status, refused.body);
      }
      const decision = isDecisionRequest(rec);
      const step = (await (decision ? decide : script)(rec, requests.length)) ?? {};
      if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
      rec.answeredAt = Date.now();
      const named = ERROR_STEP_NAMES.find((k) => step[k]);
      if (step.error || named) {
        const e = step.error ?? ERROR_STEPS[named](typeof step[named] === 'string' ? step[named] : '', n);
        rec.reply = { status: e.status ?? 500, usage: null };
        return send(res, e.status ?? 500, e.body ?? errorBody('api_error', 'mock: scripted error', n));
      }
      let usage;
      try {
        usage = usageFrom(step);
      } catch (err) {
        // A script this mock cannot translate: answered with a 500 the test will see, and recorded with the reason.
        rec.rejected = 'bad_script';
        rec.scriptError = err.message;
        rec.reply = { status: 500, usage: null };
        return send(res, 500, errorBody('api_error', 'mock: the scripted usage cannot be translated', n));
      }
      const content = [];
      // A thinking block as Opus 5.5 returns one; its text must be dropped by the adapter.
      if (step.thinking) content.push({ type: 'thinking', thinking: `${step.thinking} ${THINKING_MARKER}`, signature: 'mock-signature' });
      const refusal = Boolean(step.refusal) || step.finishReason === 'content_filter' || step.stopReason === 'refusal';
      if (typeof step.text === 'string' && step.text !== '') content.push({ type: 'text', text: step.text });
      else if (typeof step.text === 'string' && !refusal) content.push({ type: 'text', text: '' });
      if (step.toolCall) content.push({ type: 'tool_use', id: `toolu_mock_${n}`, name: step.toolCall.name, input: step.toolCall.arguments ?? {} });
      let stop = step.stopReason ?? (step.finishReason ? (STOP_OF[step.finishReason] ?? step.finishReason) : (step.toolCall ? 'tool_use' : 'end_turn'));
      if (step.refusal) stop = 'refusal';
      const message = {
        id: `msg_mock_${n}`,
        type: 'message',
        role: 'assistant',
        model: step.model ?? body.model,
        content,
        stop_reason: stop,
        stop_sequence: null,
        ...(stop === 'refusal' ? { stop_details: { category: 'cyber', explanation: `${typeof step.refusal === 'string' ? step.refusal : ''} ${STOP_DETAILS_MARKER}` } } : {}),
        ...(usage ? { usage } : {}),
      };
      rec.reply = { status: 200, usage: usage ?? null };
      return send(res, 200, message);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const noKeyRoute = () => { throw new Error('the Anthropic mock has no Key route: a test that sets the Key is OpenRouter-only'); };
  return {
    kind: 'anthropic',
    // The adapter appends /v1/messages, so the base has no path.
    base: `http://127.0.0.1:${server.address().port}`,
    requests,
    other,
    modelReads,
    /**
     * `fn(record, nthRequest)` for agent requests. A step may carry what a mock-openrouter step carries (`text`,
     * `toolCall`, `delayMs`, `usage` merged into the default or null for none, `error: { status, body }`, `refusal`,
     * `finishReason`) plus `stopReason`, `thinking`, `model` (the model the answer names), `geoUs`, `speedFast`,
     * `geoMissing`, or one named error step from ERROR_STEPS set to true or to a leak string.
     */
    setScript(fn) { script = fn; },
    /** Same step shape, for decision requests only. */
    setDecision(fn) { decide = fn; },
    setKey: noKeyRoute,
    setKeyStatus: noKeyRoute,
    /** The GET /v1/models/{id} answers, by id. */
    setModels(map) { models = map; },
    agentRequests: () => requests.filter((r) => !isDecisionRequest(r)),
    decisionRequests: () => requests.filter(isDecisionRequest),
    rejected: () => requests.filter((r) => r.rejected !== null),
    async stop() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
