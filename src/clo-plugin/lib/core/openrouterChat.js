// The one client for OpenRouter's chat completions, shared by the decision call and the main turn. It classifies every
// response shape and never throws. Provider text never enters an Error or a log line: only status, error type, provider
// name, provider code and limit source leave this module as diagnostics. The assistant message's content and refusal
// are returned to the caller, which decides what, if anything, reaches the exit.

// Retry only with this much time left before the deadline: a retry that the deadline would cut off is paid for in vain.
const RETRY_MIN_MS = 15000;
const RETRY_DELAY_MS = 1000;
const MAX_STRING = 128;

// Failures that happen before any byte of the request can leave: the socket never connected or the host name never
// resolved. Anything else, including a socket lost after connecting, may have reached OpenRouter and is never retried.
// The shapes are undici's on Node 24: TypeError('fetch failed') whose cause carries the code, or an AggregateError of
// per-address connect errors.
const CONNECT_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH']);
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN']);

export function isConnectFailure(err, depth = 0) {
  if (!err || typeof err !== 'object' || depth > 4) return false;
  if (Array.isArray(err.errors)) return err.errors.length > 0 && err.errors.every((e) => isConnectFailure(e, depth + 1));
  if (err.code === 'UND_ERR_CONNECT_TIMEOUT') return true;
  if (CONNECT_CODES.has(err.code) && err.syscall === 'connect') return true;
  if (DNS_CODES.has(err.code) && err.syscall === 'getaddrinfo') return true;
  return isConnectFailure(err.cause, depth + 1);
}

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

// reason says which shape it was:
//   not_sent: unavailable (no Key or URL), connect
//   aborted: aborted (the caller's signal)
//   error: http (non-2xx), provider_error (a 2xx carrying an error object), bad_body (not JSON), no_choice (JSON with
//          no choice in it), network (lost after connecting), timeout (the deadlineAt passed to post), tool_calls,
//          finish_error (finish_reason 'error'), finish_reason (anything else but stop, length or content_filter),
//          model_mismatch
//   refusal: moderation (a 403 with no limit source), refusal (message.refusal), content_filter
//   ok: null; the caller still decides whether the content is usable
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

const result = (kind, reason, over = {}) => ({ kind, reason, status: null, message: null, finishReason: null, usage: null, info: null, ...over });

function abortableDelay(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const t = setTimeout(done, ms);
    t.unref?.();
    signal.addEventListener('abort', done, { once: true });
  });
}

export function createOpenRouterClient({ fetch = globalThis.fetch, getKey, getBaseUrl, log = () => {}, now = Date.now, retryMinMs = RETRY_MIN_MS, retryDelayMs = RETRY_DELAY_MS }) {
  // deadlineAt: the request is aborted then, and a connect retry needs retryMinMs before it. Without a deadline nothing
  // is retried. beforeRetry, if given, is asked first and may refuse (for a hold of its own, say).
  async function post(body, { signal, deadlineAt, beforeRetry } = {}) {
    let key;
    let baseUrl;
    try {
      key = getKey();
      baseUrl = getBaseUrl();
    } catch {
      key = null;
    }
    if (!key || typeof baseUrl !== 'string' || !baseUrl) return result('not_sent', 'unavailable');

    // One controller, two causes, and the first one wins: the caller's signal (a stop, a shutdown, the caller's own end)
    // is 'aborted'; this call's own deadline is a 'timeout', which the caller counts as the provider not answering.
    const ctl = new AbortController();
    let cause = null;
    const stopBy = (why) => {
      cause ??= why;
      ctl.abort();
    };
    const onOuterAbort = () => stopBy('aborted');
    if (signal?.aborted) stopBy('aborted');
    signal?.addEventListener('abort', onOuterAbort, { once: true });
    let timer = null;
    if (typeof deadlineAt === 'number') {
      timer = setTimeout(() => stopBy('timeout'), Math.max(deadlineAt - now(), 0));
      timer.unref?.();
    }
    const stopped = (over) => (cause === 'timeout' ? result('error', 'timeout', over) : result('aborted', 'aborted', over));
    const requestedModel = typeof body?.model === 'string' ? body.model : null;
    const init = {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // A redirect to a host that cannot be reached would look like a connect failure after the POST was handled.
      redirect: 'error',
    };

    try {
      for (let attempt = 1; ; attempt += 1) {
        if (ctl.signal.aborted) return stopped();
        let res = null;
        let raw;
        try {
          res = await fetch(`${baseUrl}/chat/completions`, { ...init, signal: ctl.signal });
          raw = await res.text();
        } catch (err) {
          if (ctl.signal.aborted) return stopped({ status: res?.status ?? null });
          if (res || !isConnectFailure(err)) return result('error', 'network', { status: res?.status ?? null });
          const roomy = typeof deadlineAt === 'number' && deadlineAt - now() >= retryMinMs;
          if (attempt > 1 || !roomy) return result('not_sent', 'connect');
          let allowed = true;
          try {
            if (beforeRetry) allowed = (await beforeRetry()) === true;
          } catch {
            allowed = false;
          }
          if (!allowed) return result('not_sent', 'connect');
          log('openrouter_retry', { attempt: attempt + 1, reason: 'connect' });
          await abortableDelay(retryDelayMs, ctl.signal);
          continue;
        }
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = null;
        }
        const error = parsed && typeof parsed === 'object' ? parsed.error : undefined;
        if (!res.ok || error) {
          const info = errorInfo(res.status, error);
          // The Key's own limits are not moderation, whatever the status.
          const moderation = res.status === 403 && !info.limitSource;
          return result(moderation ? 'refusal' : 'error', !res.ok ? (moderation ? 'moderation' : 'http') : 'provider_error', {
            status: res.status, info, usage: mapUsage(parsed?.usage, parsed?.model),
          });
        }
        return classify(res.status, parsed, requestedModel);
      }
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }
  }

  return { post };
}
