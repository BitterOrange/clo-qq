// One view of a model request, whichever mock recorded it, so an e2e test can assert what the model was shown without
// knowing the wire format. The provider a run uses comes from CLO_TEST_PROVIDER (default openrouter).
// Keys never leave this module: keySent() compares and never returns the value.
import { decisionText as openrouterDecisionText } from './mock-openrouter.mjs';

export const TEST_KINDS = Object.freeze(['openrouter', 'anthropic']);

// The provider the suite runs on. An unknown value is an error, so a typo never silently runs the default.
export function testProvider(env = process.env) {
  const v = env.CLO_TEST_PROVIDER;
  if (v === undefined || v === '') return 'openrouter';
  if (!TEST_KINDS.includes(v)) throw new Error(`CLO_TEST_PROVIDER must be one of ${TEST_KINDS.join(', ')}`);
  return v;
}

// The kind of one test stack. Only an explicit provider option picks one; with none the stack is OpenRouter even when
// CLO_TEST_PROVIDER says anthropic, because a file that has not opted in reads the OpenRouter wire shape and would
// crash, or pass with nothing checked, on the other mock.
export function stackKind(option) {
  if (option === undefined) return 'openrouter';
  if (!TEST_KINDS.includes(option)) throw new Error(`provider must be one of ${TEST_KINDS.join(', ')}`);
  return option;
}

// The ids each kind's mock lock uses. OpenRouter ids are the harness's existing ones.
export const MODEL_IDS = Object.freeze({
  openrouter: Object.freeze({ primary: 'anthropic/claude-opus-5.5', decision: 'anthropic/claude-haiku-5.5' }),
  anthropic: Object.freeze({ primary: 'claude-opus-5-5', decision: 'claude-haiku-5-5' }),
});

// Both mocks take the same decision text.
export const decisionText = openrouterDecisionText;

export async function startMockModel(kind = testProvider()) {
  if (kind === 'anthropic') {
    const { startMockAnthropic } = await import('./mock-anthropic.mjs');
    return startMockAnthropic();
  }
  const { startMockOpenRouter } = await import('./mock-openrouter.mjs');
  const m = await startMockOpenRouter();
  return Object.assign(m, { kind: 'openrouter' });
}

const kindOf = (rec) => (rec?.kind === 'anthropic' ? 'anthropic' : 'openrouter');

// Every cache_control marker anywhere in a body, with where it sits.
export function cacheMarkers(node, path = '', out = []) {
  if (Array.isArray(node)) node.forEach((v, i) => cacheMarkers(v, `${path}[${i}]`, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'cache_control') out.push(path);
      else cacheMarkers(v, `${path}.${k}`, out);
    }
  }
  return out;
}

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('');
  return '';
};

function authOf(headers) {
  if (typeof headers?.authorization === 'string') return headers.authorization.startsWith('Bearer ') ? 'bearer' : 'other';
  if (typeof headers?.['x-api-key'] === 'string') return 'x-api-key';
  return null;
}

/**
 * { kind, system, user, model, maxTokens, effort, stream, decision, schema, thinking, cacheMarkers, auth }
 * system: the system text as sent; user: the one user message; effort: what the request asks for; schema: the
 * decision's JSON schema, or null; auth: 'bearer', 'x-api-key' or null.
 */
export function view(rec) {
  const b = rec?.body ?? {};
  const kind = kindOf(rec);
  const messages = Array.isArray(b.messages) ? b.messages : [];
  const user = messages.find((m) => m?.role === 'user')?.content;
  if (kind === 'anthropic') {
    return {
      kind,
      system: textOf(b.system),
      user: typeof user === 'string' ? user : null,
      model: b.model ?? null,
      maxTokens: b.max_tokens ?? null,
      effort: b.output_config?.effort ?? null,
      stream: b.stream ?? null,
      decision: Boolean(b.output_config?.format),
      schema: b.output_config?.format?.schema ?? null,
      thinking: b.thinking ?? null,
      cacheMarkers: cacheMarkers(b),
      auth: authOf(rec.headers),
    };
  }
  return {
    kind,
    system: messages.filter((m) => m?.role === 'system').map((m) => textOf(m.content)).join(''),
    user: typeof user === 'string' ? user : null,
    model: b.model ?? null,
    maxTokens: b.max_tokens ?? null,
    effort: b.reasoning?.effort ?? null,
    stream: b.stream ?? null,
    decision: Boolean(b.response_format),
    schema: b.response_format?.json_schema?.schema ?? null,
    thinking: null,
    cacheMarkers: cacheMarkers(b),
    auth: authOf(rec.headers),
  };
}

// Whether the request carried exactly this Key, in the header its kind uses. Never returns the Key.
export function keySent(rec, key) {
  if (kindOf(rec) === 'anthropic') return rec?.headers?.['x-api-key'] === key && rec?.headers?.authorization === undefined;
  return rec?.headers?.authorization === `Bearer ${key}`;
}

// The usage the mock answered with, normalised: { input, output, cacheRead, cacheWrite } or null. The OpenRouter mock
// does not record its answers, so this is null there.
export function replyUsage(rec) {
  const u = rec?.reply?.usage;
  if (!u) return null;
  return { input: u.input_tokens ?? null, output: u.output_tokens ?? null, cacheRead: u.cache_read_input_tokens ?? null, cacheWrite: u.cache_creation_input_tokens ?? null };
}

// The fields a request body of this kind must never carry, beyond what each test checks itself.
export const NEVER_SENT = Object.freeze({
  openrouter: Object.freeze(['fallbacks', 'models', 'tools', 'tool_choice']),
  anthropic: Object.freeze(['stream', 'fallbacks', 'speed', 'inference_geo', 'metadata', 'tools', 'tool_choice', 'temperature', 'top_p', 'top_k', 'service_tier']),
});
