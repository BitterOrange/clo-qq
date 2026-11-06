// The direct decision call. Fail closed: anything but a clean, well-formed answer is a skip.
// Provider text is never returned or logged, only the whitelisted status fields.
import { readFileSync } from 'node:fs';
import { mappedCopy, normalizeCopy } from './contentPolicy.js';
import { createOpenRouterClient } from './openrouterChat.js';

const SKIP_CLASSES = ['political', 'violence_crime', 'sexual', 'harm_person', 'none'];
const FIELDS = ['action', 'crisis', 'need_search', 'skip_class'];

const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'clo_decision',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'skip_class', 'crisis', 'need_search'],
      properties: {
        action: { type: 'string', enum: ['reply', 'skip'] },
        skip_class: { type: 'string', enum: SKIP_CLASSES },
        crisis: { type: 'boolean' },
        need_search: { type: 'boolean' },
      },
    },
  },
};

const clamp = (text, chars) => [...String(text ?? '')].slice(0, chars).join('');

export function parseAnswer(content) {
  let v;
  try {
    v = JSON.parse(content);
  } catch {
    return null;
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  if (Object.keys(v).sort().join() !== FIELDS.join()) return null;
  if (v.action !== 'reply' && v.action !== 'skip') return null;
  if (!SKIP_CLASSES.includes(v.skip_class)) return null;
  if (typeof v.crisis !== 'boolean' || typeof v.need_search !== 'boolean') return null;
  // Kept as answered: past the crisis caps routeDecision still needs the class and the action.
  if (v.crisis) return { action: v.action, skipClass: v.skip_class, crisis: true };
  // Forced locally, whatever the model said. need_search is ignored: this build has no search.
  if (v.skip_class !== 'none') return { action: 'skip', skipClass: v.skip_class, crisis: false };
  return { action: v.action, skipClass: 'none', crisis: v.crisis };
}

// An effective file written before this limit existed must not leave the current message unbounded.
const currentChars = ({ retention }) => retention.decisionCurrentChars ?? retention.decisionLineChars;

// What counts as saying her name. One definition, for classifying and for finding the focus.
export function namePattern(raw) {
  const name = String(raw).normalize('NFKC');
  if (!name) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!/^[\x00-\x7f]+$/.test(name)) return new RegExp(escaped, 'g');
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'gi');
}

function lastNameSpan(text, names) {
  const { copy, from, to } = mappedCopy(text, (run) => run.normalize('NFKC'));
  let last = null;
  for (const raw of names ?? []) {
    const re = namePattern(raw);
    for (const m of re ? copy.matchAll(re) : []) {
      if (!last || m.index > last.index) last = { index: m.index, length: m[0].length };
    }
  }
  return last && { start: from[last.index], end: to[last.index + last.length - 1] };
}

// isCrisisRoute reads past spacing, so a term can be spread wider than any window. Then its filler goes, since
// the term has to be seen. Narrower ones stay as typed.
function closeUpSpan(points, span, limit) {
  if (span.end - span.start <= limit / 8) return { points, span };
  const kept = points.slice(span.start, span.end).filter((point) => normalizeCopy(point) !== '');
  return {
    points: [...points.slice(0, span.start), ...kept, ...points.slice(span.end)],
    span: { start: span.start, end: span.start + kept.length },
  };
}

// Head + … + a window around each focus the ends would lose + … + tail, at most the limit in code points.
// crisisSpan is policy.lastCrisisSpan(text), code point offsets into this same text, or null.
export function shapeCurrentText(eff, text, crisisSpan = null) {
  const limit = currentChars(eff);
  const whole = [...String(text ?? '')];
  if (whole.length <= limit) return whole.join('');
  if (limit < 1) return '';
  const { points, span } = crisisSpan ? closeUpSpan(whole, crisisSpan, limit) : { points: whole, span: null };
  const n = points.length;
  if (n <= limit) return points.join('');
  const ends = Math.floor(limit / 4);
  const inEnds = (s) => s.end <= ends || s.start >= n - ends;
  const lost = [lastNameSpan(points.join(''), eff.names), span].filter((s) => s && !inEnds(s));
  // A limit too short for a window beside the ends just keeps the ends.
  const width = lost.length === 0 ? 0 : Math.floor((limit - 2 * ends - lost.length - 1) / lost.length);
  let parts;
  if (width < 1) {
    const head = Math.ceil((limit - 1) / 2);
    parts = [[0, head], [n - (limit - 1 - head), n]];
  } else {
    const windowOf = ({ start, end }) => {
      const centered = Math.min(start, Math.floor((start + end - width) / 2));
      const from = Math.min(Math.max(ends, centered), n - ends - width);
      return [from, from + width];
    };
    parts = [[0, ends], ...lost.map(windowOf), [n - ends, n]].sort((a, b) => a[0] - b[0]);
  }
  // Touching parts join up: … only ever marks text that really was left out.
  const merged = [];
  for (const [from, to] of parts) {
    const prev = merged.at(-1);
    if (prev && from <= prev[1]) prev[1] = Math.max(prev[1], to);
    else merged.push([from, to]);
  }
  return merged.map(([from, to]) => points.slice(from, to).join('')).join('…');
}

export function buildRequest(eff, prompt, { trigger, lines, current }) {
  const { decision } = eff.models;
  const { decisionLines, decisionLineChars } = eff.retention;
  const payload = {
    trigger,
    lines: (lines ?? []).slice(-decisionLines).map((l) => ({ sender: l.sender, text: clamp(l.text, decisionLineChars) })),
    current: { sender: current.sender, text: clamp(current.text, currentChars(eff)) },
  };
  return {
    model: decision.id,
    stream: false,
    reasoning: { effort: decision.effort },
    max_tokens: decision.maxTokens,
    response_format: RESPONSE_FORMAT,
    provider: { require_parameters: true },
    usage: { include: true },
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: JSON.stringify(payload) },
    ],
  };
}

const costMicros = (usage) => {
  const cost = usage?.costUsd;
  return typeof cost === 'number' && Number.isFinite(cost) && cost > 0 ? Math.ceil(cost * 1e6) : null;
};

const skip = (invalid, over = {}) => ({
  action: 'skip', skipClass: 'none', crisis: false, invalid, paid: true,
  actualMicros: null, model: null, httpStatus: null, limitSource: null, ...over,
});

// client: the shared OpenRouter client. Without one, a client of its own is made over fetch.
export function createDecider({ client = null, fetch = globalThis.fetch, getKey, getEffective, promptFile, log = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  // No deadline is passed to it, so it never retries: a decision is cheap to skip.
  const chat = client ?? createOpenRouterClient({ fetch, getKey, getBaseUrl: () => getEffective()?.openrouter?.baseUrl, log, now });
  let prompt = null;
  const loadPrompt = (eff) => {
    prompt ??= readFileSync(promptFile ?? eff.paths.decisionPromptFile, 'utf8');
    return prompt;
  };

  return async function decide({ trigger, lines, current, signal }) {
    const started = now();
    const eff = getEffective();
    const key = eff ? getKey() : null;
    let text;
    try {
      if (!eff || !key) throw new Error('unavailable');
      text = loadPrompt(eff);
    } catch {
      // No request left this machine, so nothing was spent.
      log('decision', { reason: 'unavailable' });
      return skip('unavailable', { paid: false });
    }

    const ctl = new AbortController();
    const onOuterAbort = () => ctl.abort();
    if (signal?.aborted) ctl.abort();
    signal?.addEventListener('abort', onOuterAbort, { once: true });
    const timer = setTimer(() => ctl.abort(), eff.timeouts.decisionMs);
    const model = eff.models.decision.id;
    const finish = ({ providerInfo, ...out }) => {
      log('decision', {
        reason: out.invalid, model, httpStatus: out.httpStatus, actualMicros: out.actualMicros, durationMs: now() - started,
        status: providerInfo?.status, error_type: providerInfo?.error_type,
        provider_name: providerInfo?.provider_name, provider_code: providerInfo?.provider_code,
      });
      return out;
    };

    let r;
    try {
      r = await chat.post(buildRequest(eff, text, { trigger, lines, current }), { signal: ctl.signal });
    } finally {
      clearTimer(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }

    if (r.kind === 'aborted') return finish(skip('timeout', { model, httpStatus: r.status }));
    if (r.kind === 'not_sent' || r.reason === 'network') return finish(skip('http', { model, httpStatus: r.status }));
    const base = { model, actualMicros: costMicros(r.usage), httpStatus: r.status };
    if (r.reason === 'http' || r.reason === 'moderation' || r.reason === 'provider_error') {
      return finish(skip('http', {
        ...base,
        limitSource: r.info.limitSource,
        providerInfo: { status: r.info.status, error_type: r.info.error_type, provider_name: r.info.provider_name, provider_code: r.info.provider_code },
      }));
    }
    if (r.reason === 'bad_body') return finish(skip('json', base));
    // Read from the message itself, as before the shared client: a decision has its own rules for what is usable.
    if (r.finishReason === 'length') return finish(skip('length', base));
    const content = r.message?.content;
    if (typeof content !== 'string' || !content.trim() || r.message?.refusal) return finish(skip('empty', base));
    const answer = parseAnswer(content.trim());
    if (!answer) return finish(skip('json', base));
    return finish({ ...answer, invalid: null, paid: true, limitSource: null, ...base });
  };
}

// What a decision means locally. takeCrisisCap consumes the local crisis caps, so model output
// (or a member asking for crisis=true) can never raise them.
export function routeDecision(trigger, d, { takeCrisisCap }) {
  if (d.invalid) return { next: 'skip', reason: 'decision_invalid' };
  if (trigger === 'crisis_route') return d.crisis === true ? { next: 'crisis' } : { next: 'skip', reason: 'decision_skip' };
  // Within the caps a person in danger is answered whatever the topic class. Past them, crisis means nothing.
  if (d.crisis === true && takeCrisisCap()) return { next: 'crisis' };
  if (d.skipClass !== 'none') return { next: 'skip', reason: 'decision_skip' };
  if (d.action !== 'reply') return { next: 'skip', reason: 'decision_skip' };
  return { next: trigger === 'name' ? 'name_addressed' : 'interject' };
}
