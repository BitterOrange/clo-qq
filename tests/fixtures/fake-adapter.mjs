// A scripted stand-in for a provider adapter and a chat client, in the shapes of docs/provider-contract.md items 2-4.
// Callers, the ledger and the console can be tested against it before the real adapters exist. No network.
import { MODEL_ID_RULES, RESULT_KINDS, RESULT_REASONS } from '../../src/clo-plugin/lib/core/providers/registry.js';

export const RESULT_KEYS = Object.freeze(['kind', 'reason', 'status', 'message', 'finishReason', 'usage', 'info']);
export const INFO_KEYS = Object.freeze(['status', 'error_type', 'provider_name', 'provider_code', 'limitSource']);
const DEFAULT_REASON = { ok: null, refusal: 'refusal', error: 'http', not_sent: 'unavailable', aborted: 'aborted' };

// A Result with every key present.
export function fakeResult(kind, reason = DEFAULT_REASON[kind], over = {}) {
  return { kind, reason, status: null, message: null, finishReason: null, usage: null, info: null, ...over };
}

// Usage in the normalised shape of each kind. Anthropic reports no cost, and always says whether it split the writes.
export function fakeUsage(kind = 'openrouter', over = {}) {
  if (kind === 'anthropic') {
    return { input: 900, output: 40, cacheRead: 0, cacheWrite: 4000, cacheWrite1h: 0, costUsd: null, model: 'claude-opus-5-5', geo: 'global', speed: 'standard', ...over };
  }
  return { input: 50, output: 40, cacheRead: 1000, cacheWrite: 150, costUsd: 0.0123, model: 'anthropic/claude-opus-5.5', ...over };
}

export function okResult(content = '好的。', { kind = 'openrouter', usage = fakeUsage(kind), finishReason = 'stop', status = 200 } = {}) {
  return fakeResult('ok', null, { status, message: { content, refusal: false, toolCalls: 0 }, finishReason, usage });
}

export function errorInfo(status, limitSource = null, over = {}) {
  return { status, error_type: null, provider_name: null, provider_code: null, limitSource, ...over };
}

// What is wrong with a Result, by the contract: exact keys, a known kind and reason, short info.
export function checkResult(r) {
  const problems = [];
  if (!r || typeof r !== 'object') return ['not an object'];
  const keys = Object.keys(r).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...RESULT_KEYS].sort())) problems.push(`keys ${keys.join(',')}`);
  if (!RESULT_KINDS.includes(r.kind)) problems.push(`kind ${r.kind}`);
  else if (!RESULT_REASONS[r.kind].includes(r.reason)) problems.push(`reason ${r.reason} for ${r.kind}`);
  if (r.info !== null) {
    const ik = Object.keys(r.info ?? {}).sort();
    if (JSON.stringify(ik) !== JSON.stringify([...INFO_KEYS].sort())) problems.push(`info keys ${ik.join(',')}`);
  }
  if (r.message !== null && JSON.stringify(Object.keys(r.message ?? {}).sort()) !== '["content","refusal","toolCalls"]') problems.push('message keys');
  return problems;
}

// The fake wire format: the response body is {fake: <Result fields>}, so a real chat client can run this adapter over a
// scripted fetch. fakeResponse makes one.
export function fakeResponse(fields, status = 200) {
  return new Response(JSON.stringify({ fake: fields }), { status, headers: { 'Content-Type': 'application/json' } });
}

export function createFakeAdapter({ kind = 'openrouter', idRule = MODEL_ID_RULES[kind] ?? /^fake-[a-z0-9-]+$/, retryEvent = `${kind}_retry` } = {}) {
  const calls = { request: [], turnBody: [], decisionBody: [], parseError: [], classify: [] };
  const fromWire = (status, parsed) => {
    const f = parsed && typeof parsed === 'object' ? parsed.fake : undefined;
    if (!f || typeof f !== 'object') return null;
    const picked = Object.fromEntries(RESULT_KEYS.filter((k) => k !== 'status' && Object.hasOwn(f, k)).map((k) => [k, f[k]]));
    return fakeResult(f.kind, Object.hasOwn(f, 'reason') ? f.reason : DEFAULT_REASON[f.kind], { ...picked, status });
  };
  return {
    kind,
    retryEvent,
    idRule,
    calls,
    // The Key is in a header only, never in the URL.
    request(key, baseUrl) {
      calls.request.push({ baseUrl });
      return { url: `${baseUrl}/fake/chat`, headers: { 'x-fake-key': key, 'content-type': 'application/json' } };
    },
    turnBody({ model, effort, maxTokens, system, user }) {
      calls.turnBody.push({ model, effort, maxTokens });
      return { model, effort, max_tokens: maxTokens, system, user };
    },
    decisionBody({ model, effort, maxTokens, system, user, schema }) {
      calls.decisionBody.push({ model, effort, maxTokens, schema: schema?.name ?? null });
      return { model, effort, max_tokens: maxTokens, system, user, schema: schema?.name ?? null };
    },
    systemTextOf: (body) => (typeof body?.system === 'string' ? body.system : ''),
    userTextOf: (body) => (typeof body?.user === 'string' ? body.user : ''),
    requestedModel: (body) => (typeof body?.model === 'string' ? body.model : null),
    parseError(status, parsed) {
      calls.parseError.push({ status });
      return fromWire(status, parsed) ?? fakeResult('error', 'http', { status, info: errorInfo(status) });
    },
    classify(status, parsed, requestedModel) {
      calls.classify.push({ status, requestedModel });
      if (parsed === null) return fakeResult('error', 'bad_body', { status, info: errorInfo(status) });
      return fromWire(status, parsed) ?? fakeResult('error', 'no_choice', { status });
    },
  };
}

// A chat client of the contract's shape over a script. Each entry is a Result or (body, opts) => Result. It never
// throws: an unscripted post returns error/network and counts in `unscripted`, which a test should assert is 0.
export function createFakeClient({ adapter = createFakeAdapter(), script = [], getKey = () => 'FAKE-CLIENT-KEY', getBaseUrl = () => 'http://127.0.0.1:9' } = {}) {
  const queue = [...script];
  const posts = [];
  const client = {
    adapter,
    posts,
    unscripted: 0,
    push: (...more) => queue.push(...more),
    async post(body, opts = {}) {
      let key;
      let baseUrl;
      try {
        key = getKey();
        baseUrl = getBaseUrl();
      } catch {
        key = null;
      }
      if (!key || typeof baseUrl !== 'string' || !baseUrl) return fakeResult('not_sent', 'unavailable');
      if (opts.signal?.aborted) return fakeResult('aborted', 'aborted');
      posts.push({ body, deadlineAt: opts.deadlineAt ?? null, hasBeforeRetry: typeof opts.beforeRetry === 'function' });
      const next = queue.shift();
      if (next === undefined) {
        client.unscripted += 1;
        return fakeResult('error', 'network');
      }
      return typeof next === 'function' ? next(body, opts) : next;
    },
  };
  return client;
}
