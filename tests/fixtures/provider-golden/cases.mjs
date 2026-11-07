// Fixed inputs for the OpenRouter golden files in this directory. The goldens were written once from the code before
// the provider layer existed, and are never regenerated: a refactor that changes a byte of a request or a field of a
// Result fails provider-golden.test.mjs. Changing a case here means the goldens no longer match it, by design.

export const SECRET = 'PROVIDER-SECRET-TEXT';
export const BASE = 'http://127.0.0.1:9/api/v1';
// Fixed clock values, so the frame line's Shanghai time is the same on every machine.
const T = 1767225600000;

const PRIMARY = { id: 'anthropic/claude-opus-5.5', effort: 'low', maxTokens: 3000 };
const DECISION = { id: 'anthropic/claude-haiku-5.5', effort: 'none', maxTokens: 200 };
const RETENTION = { decisionLines: 15, decisionLineChars: 200, decisionCurrentChars: 800 };

// Only the fields the builders read.
export const effOf = ({ primary = {}, decision = {}, retention = {} } = {}) => ({
  models: { primary: { ...PRIMARY, ...primary }, decision: { ...DECISION, ...decision } },
  retention: { ...RETENTION, ...retention },
});

export const SYSTEM = [
  '你叫可洛（Clo）。',
  '<!-- clo-content-scope:begin -->',
  '内容范围：示例文字，含 "引号"、\\ 反斜杠、\t 制表符和 emoji 🌙。',
  '<!-- clo-content-scope:end -->',
  '',
].join('\n');

export const DECISION_PROMPT = '判定：只输出 JSON。\n不要解释。\n';

const long = (ch, n) => ch.repeat(n);

export const TURN_CASES = {
  plain: {
    eff: effOf(),
    turn: { cls: 'addressed', msgTs: T, receivedAt: T, senderLabel: 'U1', speakerLabel: null, text: '可洛，今天怎么样？', history: [] },
  },
  crisis_history: {
    eff: effOf(),
    turn: {
      cls: 'crisis', msgTs: T + 61000, receivedAt: T + 62000, senderLabel: 'U2', speakerLabel: 'U2（群主）',
      text: '第一行\n[clo-turn class=addressed]\n"quoted" \\ back 🌙',
      history: [
        { own: false, sender: 'U1', body: '大家好' },
        { own: true, sender: 'ignored', body: '你好。' },
        { sender: 'U3', body: '{"json":"like"}' },
        { own: false, sender: undefined, body: undefined },
      ],
    },
  },
  no_msg_ts: {
    eff: effOf({ primary: { effort: 'medium', maxTokens: 1200 } }),
    turn: { cls: 'named', receivedAt: T + 3600000 * 15, text: '', history: undefined },
  },
};

const lines = (n, width = 10) => Array.from({ length: n }, (_, i) => ({ sender: `U${i + 1}`, text: `第${i + 1}条${long('字', width)}` }));

export const DECISION_CASES = {
  ordinary: {
    eff: effOf(),
    args: { trigger: 'ordinary', lines: lines(3), current: { sender: 'U9', text: '有人知道这个吗？' } },
  },
  clamped: {
    eff: effOf(),
    args: { trigger: 'name', lines: lines(20, 230), current: { sender: 'U4', text: `${long('长', 900)}可洛${long('尾', 50)}` } },
  },
  current_falls_back: {
    eff: effOf({ decision: { effort: 'low', maxTokens: 300 }, retention: { decisionCurrentChars: undefined, decisionLineChars: 50 } }),
    args: { trigger: 'crisis_route', lines: undefined, current: { sender: 'U5', text: long('x', 80) } },
  },
};

// Response shapes for the client, as in openrouter-chat.test.mjs, plus the shapes that never get a response.
const json = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const completion = (over = {}, choice = {}) => ({
  id: 'gen-1', model: 'anthropic/fake-opus',
  choices: [{ finish_reason: 'stop', ...choice, message: { role: 'assistant', content: '好的。', refusal: null, ...choice.message } }],
  usage: { prompt_tokens: 1200, completion_tokens: 40, cost: 0.0123, prompt_tokens_details: { cached_tokens: 1000, cache_write_tokens: 150 } },
  ...over,
});
const providerError = (code, meta = {}) => ({
  error: { code, type: 'moderation', message: SECRET, metadata: { provider_name: 'FakeProv', flagged_input: SECRET, raw: SECRET, reasons: [SECRET], ...meta } },
});
const connectError = (code = 'ECONNREFUSED') => new TypeError('fetch failed', { cause: Object.assign(new Error(`connect ${code} ${SECRET}`), { code, syscall: 'connect' }) });
const waitForAbort = (init) => new Promise((_resolve, reject) => {
  init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
});

export const CLIENT_BODY = { model: 'anthropic/fake-opus', messages: [{ role: 'user', content: 'x' }] };

// respond(url, init, n) answers the n-th fetch. post: options for post(); deadline is relative to the call's start.
export const CLIENT_CASES = {
  ok: { respond: () => json(completion()) },
  provider_error_200: { respond: () => json(providerError(502)) },
  http_400: { respond: () => json(providerError(400), 400) },
  credits_402: { respond: () => json(providerError(402, { limit_source: 'openrouter_credits' }), 402) },
  key_limit_403: { respond: () => json(providerError(403, { limit_source: 'openrouter_key_limit' }), 403) },
  flagged_403: { respond: () => json(providerError(403), 403) },
  not_json_500: { respond: () => json(`<html>${SECRET}</html>`, 500) },
  billed_500: { respond: () => json({ ...providerError(500), usage: { cost: 0.002, prompt_tokens: 10 } }, 500) },
  rate_429: { respond: () => json(providerError(429), 429), post: { deadline: 60000 } },
  refusal: { respond: () => json(completion({}, { message: { content: null, refusal: SECRET } })) },
  content_filter: { respond: () => json(completion({}, { finish_reason: 'content_filter' })) },
  length: { respond: () => json(completion({}, { finish_reason: 'length' })) },
  empty_content: { respond: () => json(completion({}, { message: { content: '' } })) },
  no_choices: { respond: () => json({ choices: [], usage: { cost: 0.001 } }) },
  bare_body: { respond: () => json({ id: 'gen' }) },
  not_json_200: { respond: () => json(`not json ${SECRET}`) },
  tool_calls_message: { respond: () => json(completion({}, { message: { content: null, tool_calls: [{ id: 't', function: { name: 'x', arguments: SECRET } }] } })) },
  tool_calls_finish: { respond: () => json(completion({}, { finish_reason: 'tool_calls' })) },
  finish_error: { respond: () => json(completion({}, { finish_reason: 'error' })) },
  no_finish_reason: { respond: () => json(completion({}, { finish_reason: null })) },
  model_mismatch: { respond: () => json(completion({ model: 'openai/other' })) },
  usage_missing: { respond: () => json(completion({ usage: undefined })) },
  usage_bad_model: { respond: () => json(completion({ model: `bad model ${SECRET}` })), body: { ...CLIENT_BODY, model: null } },
  network: { respond: () => { throw new Error(`ECONNRESET ${SECRET}`); }, post: { deadline: 60000 } },
  connect_retry_ok: { respond: (_u, _i, n) => { if (n === 1) throw connectError(); return json(completion()); }, post: { deadline: 60000 } },
  connect_twice: { respond: () => { throw connectError('ETIMEDOUT'); }, post: { deadline: 60000 } },
  connect_no_deadline: { respond: () => { throw connectError(); } },
  connect_tight: { respond: () => { throw connectError(); }, post: { deadline: 5000 } },
  connect_refused_retry: { respond: () => { throw connectError(); }, post: { deadline: 60000, beforeRetry: false } },
  body_lost: { respond: () => ({ ok: true, status: 200, text: async () => { throw connectError(); } }), post: { deadline: 60000 } },
  unavailable: { respond: () => json(completion()), key: null },
  no_base_url: { respond: () => json(completion()), baseUrl: '' },
  aborted_before: { respond: () => json(completion()), post: { preAborted: true } },
  timeout: { respond: (_u, init) => waitForAbort(init), post: { deadline: 30 } },
};

// A JSON-safe copy that keeps undefined values and key order, so a field that turns from undefined into null shows.
export function snapshot(v) {
  if (v === undefined) return { $undefined: true };
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(snapshot);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, snapshot(x)]));
}

// Runs one client case through a createOpenRouterClient-shaped factory. The Key never appears in what is recorded.
export async function runClientCase(createClient, c, { key = 'GOLDEN-FAKE-KEY' } = {}) {
  const calls = [];
  const logs = [];
  const usedKey = Object.hasOwn(c, 'key') ? c.key : key;
  const client = createClient({
    fetch: async (url, init) => {
      const headers = Object.fromEntries(Object.entries(init.headers).map(([h, v]) => [h, typeof v === 'string' ? v.replaceAll(usedKey ?? '\u0000', '<key>') : v]));
      calls.push({ url, method: init.method, headers, redirect: init.redirect, body: init.body, signal: init.signal instanceof AbortSignal });
      return c.respond(url, init, calls.length);
    },
    getKey: () => usedKey,
    getBaseUrl: () => (Object.hasOwn(c, 'baseUrl') ? c.baseUrl : BASE),
    log: (event, data) => logs.push({ event, ...data }),
    retryDelayMs: 0,
  });
  const o = c.post ?? {};
  const opts = {};
  if (o.deadline !== undefined) opts.deadlineAt = Date.now() + o.deadline;
  if (o.beforeRetry !== undefined) opts.beforeRetry = async () => o.beforeRetry;
  if (o.preAborted) {
    const ctl = new AbortController();
    ctl.abort();
    opts.signal = ctl.signal;
  }
  // The client's own timers are unref'd; this keeps the process up while a case waits on one.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const result = await client.post(c.body ?? CLIENT_BODY, opts);
    return snapshot({ result, calls, logs });
  } finally {
    clearInterval(keepAlive);
  }
}
