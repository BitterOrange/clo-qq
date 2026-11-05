// Loopback OpenAI-compatible model endpoint. Records every request. Replies are scripted per test.
import { createServer } from 'node:http';

const CHAT = /\/chat\/completions$/;

function sseChunk(res, id, model, delta, finishReason = null) {
  const chunk = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finishReason }] };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

export const isDecisionRequest = (rec) => rec.body?.stream === false && Boolean(rec.body?.response_format);

export const decisionText = ({ action = 'skip', skipClass = 'none', crisis = false } = {}) => JSON.stringify({ action, skip_class: skipClass, crisis, need_search: false });

const DEFAULT_KEY = { usage: 0, limit: 3.25, limit_remaining: 3.25, limit_reset: 'daily', usage_daily: 0 };
const OPUS_ROW = (id, name) => ({
  id,
  name,
  created: 100,
  pricing: { prompt: '0.000005', completion: '0.00002', input_cache_read: '0.0000005', input_cache_write: '0.00000625' },
  context_length: 200000,
  top_provider: { max_completion_tokens: 8000 },
  supported_parameters: ['tools', 'tool_choice', 'reasoning', 'include_reasoning', 'max_tokens'],
  reasoning: { mandatory: true, supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low'], default_effort: 'high' },
});
// The opus-latest selector checks the top concrete row against the alias row, so a catalog without it cannot lock.
export const defaultCatalog = () => [
  OPUS_ROW('anthropic/claude-opus-5.5', 'mock opus'),
  OPUS_ROW('~anthropic/claude-opus-latest', 'mock opus alias'),
  { id: 'anthropic/claude-haiku-5.5', name: 'mock haiku', created: 90, pricing: { prompt: '0.000001', completion: '0.000005', input_cache_read: '0.0000001', input_cache_write: '0.00000125' }, context_length: 200000, top_provider: { max_completion_tokens: 8000 }, supported_parameters: ['response_format', 'structured_outputs', 'reasoning', 'include_reasoning', 'max_tokens'], reasoning: { mandatory: false, supported_efforts: ['low', 'medium', 'high'] } },
];

export async function startMockOpenRouter() {
  const requests = [];
  const other = [];
  let script = () => ({ text: '好的。' });
  let decide = () => ({ text: decisionText() });
  let counter = 0;
  let keyBody = { ...DEFAULT_KEY };
  let keyStatus = 200;
  let catalog = defaultCatalog();

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', async () => {
      if (req.method !== 'POST' || !CHAT.test(req.url)) {
        other.push({ method: req.method, url: req.url });
        res.setHeader('Content-Type', 'application/json');
        if (req.url.endsWith('/models')) {
          res.end(JSON.stringify({ data: catalog }));
        } else if (req.url.endsWith('/key')) {
          res.statusCode = keyStatus;
          res.end(JSON.stringify(keyStatus === 200 ? { data: keyBody } : { error: { message: 'mock: key read refused' } }));
        } else {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: { message: 'mock: no such route' } }));
        }
        return;
      }
      let body = null;
      try { body = JSON.parse(raw); } catch { /* recorded as null */ }
      const rec = { url: req.url, headers: { ...req.headers }, body, at: Date.now() };
      requests.push(rec);
      const decision = isDecisionRequest(rec);
      const step = (await (decision ? decide : script)(rec, requests.length)) ?? {};
      if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
      // A test can tell that something happened before the model's answer was on its way.
      rec.answeredAt = Date.now();
      const id = `gen-mock-${++counter}`;
      const model = body?.model ?? 'unknown';
      const usage = step.usage === null ? undefined : { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: decision ? 0.0001 : 0, ...(step.usage ?? {}) };
      if (step.error) {
        res.statusCode = step.error.status ?? 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(step.error.body ?? { error: { message: 'mock: scripted error' } }));
        return;
      }
      const toolCall = step.toolCall
        ? { id: `call_${counter}`, type: 'function', function: { name: step.toolCall.name, arguments: JSON.stringify(step.toolCall.arguments ?? {}) } }
        : null;
      const finish = step.finishReason ?? (toolCall ? 'tool_calls' : 'stop');
      if (body?.stream === false) {
        res.setHeader('Content-Type', 'application/json');
        const message = { role: 'assistant', content: step.text ?? null, ...(toolCall ? { tool_calls: [toolCall] } : {}), ...(step.refusal ? { refusal: step.refusal } : {}) };
        res.end(JSON.stringify({ id, object: 'chat.completion', model, choices: [{ index: 0, finish_reason: finish, message }], ...(usage ? { usage } : {}) }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      sseChunk(res, id, model, { role: 'assistant', content: '' });
      if (step.refusal) {
        sseChunk(res, id, model, { refusal: step.refusal });
        sseChunk(res, id, model, {}, step.finishReason ?? 'content_filter');
      } else if (toolCall) {
        if (step.text) sseChunk(res, id, model, { content: step.text });
        sseChunk(res, id, model, { tool_calls: [{ index: 0, ...toolCall }] });
        sseChunk(res, id, model, {}, 'tool_calls');
      } else {
        const text = step.text ?? '';
        const mid = Math.ceil(text.length / 2);
        for (const part of [text.slice(0, mid), text.slice(mid)]) if (part) sseChunk(res, id, model, { content: part });
        if (step.midStreamError) {
          res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, error: step.midStreamError, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] })}\n\n`);
          res.end();
          return;
        }
        sseChunk(res, id, model, {}, finish);
      }
      if (usage) res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [], usage })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${server.address().port}/api/v1`,
    requests,
    other,
    /**
     * `fn(record, nthRequest)` for agent requests. A step may carry `text`, `toolCall`, `delayMs`, `usage`
     * (merged into the default, or null for none), `error: { status, body }`, `refusal`, `midStreamError`, `finishReason`.
     */
    setScript(fn) { script = fn; },
    /** Same step shape, for decision requests only. */
    setDecision(fn) { decide = fn; },
    setKey(obj) { keyBody = { ...DEFAULT_KEY, ...obj }; },
    setKeyStatus(status) { keyStatus = status; },
    setCatalog(list) { catalog = list; },
    agentRequests: () => requests.filter((r) => !isDecisionRequest(r)),
    decisionRequests: () => requests.filter(isDecisionRequest),
    async stop() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
