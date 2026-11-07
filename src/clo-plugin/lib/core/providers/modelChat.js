// The one place a chat request to a model provider leaves this machine, for every provider kind. The adapter says
// where the request goes and how to read the answer; this loop owns the network rules, which are the same for all:
// it never throws, refuses redirects, stops at the caller's signal or the call's own deadline, and retries only a
// connect failure that provably sent nothing, once, inside the deadline and only after beforeRetry agrees. No HTTP
// status is ever retried. Provider text never enters an Error or a log line: only the adapter's short scalars leave.

// Retry only with this much time left before the deadline: a retry that the deadline would cut off is paid for in vain.
const RETRY_MIN_MS = 15000;
const RETRY_DELAY_MS = 1000;

// Failures that happen before any byte of the request can leave: the socket never connected or the host name never
// resolved. Anything else, including a socket lost after connecting, may have reached the provider and is never
// retried. The shapes are undici's on Node 24: TypeError('fetch failed') whose cause carries the code, or an
// AggregateError of per-address connect errors.
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

const result = (kind, reason, over = {}) => ({ kind, reason, status: null, message: null, finishReason: null, usage: null, info: null, ...over });
const usable = (v) => typeof v === 'string' && v !== '';

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

export function createChatClient({ adapter, fetch = globalThis.fetch, getKey, getBaseUrl, log = () => {}, now = Date.now, retryMinMs = RETRY_MIN_MS, retryDelayMs = RETRY_DELAY_MS }) {
  if (!adapter || typeof adapter.request !== 'function' || typeof adapter.classify !== 'function' || typeof adapter.parseError !== 'function') {
    throw new TypeError('createChatClient needs an adapter');
  }

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
    if (!usable(key) || !usable(baseUrl)) return result('not_sent', 'unavailable');
    // Everything that could fail before sending is done first: nothing has left, so nothing can be retried or billed.
    let url;
    let headers;
    let payload;
    let requestedModel;
    try {
      ({ url, headers } = adapter.request(key, baseUrl));
      payload = JSON.stringify(body);
      requestedModel = adapter.requestedModel(body);
    } catch {
      return result('not_sent', 'unavailable');
    }
    if (!usable(url) || typeof payload !== 'string') return result('not_sent', 'unavailable');

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
    const init = {
      method: 'POST',
      headers,
      body: payload,
      // A redirect to a host that cannot be reached would look like a connect failure after the POST was handled.
      redirect: 'error',
    };

    try {
      for (let attempt = 1; ; attempt += 1) {
        if (ctl.signal.aborted) return stopped();
        let res = null;
        let raw;
        try {
          res = await fetch(url, { ...init, signal: ctl.signal });
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
          log(adapter.retryEvent, { attempt: attempt + 1, reason: 'connect' });
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
        // The request was handled: whatever the adapter makes of the answer, it is never sent again.
        try {
          if (!res.ok || error) return adapter.parseError(res.status, parsed);
          return adapter.classify(res.status, parsed, requestedModel);
        } catch {
          return result('error', 'bad_body', { status: res.status });
        }
      }
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }
  }

  return { adapter, post };
}
