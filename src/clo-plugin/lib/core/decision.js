// The direct decision call. Fail closed: anything but a clean, well-formed answer is a skip.
// Provider text is never returned or logged, only the whitelisted status fields.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mappedCopy, normalizeCopy } from './contentPolicy.js';
import { createOpenRouterClient } from './openrouterChat.js';
import { settleMicros } from './providers/cost.js';
import { openrouterAdapter } from './providers/openrouterAdapter.js';
import { CAPABILITIES } from './providers/registry.js';

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

// With search on in the group (own runtime only): the same answer plus two query strings, empty for none. Two plain
// strings, not an array with maxItems, which a strict schema may not take (docs/search-contract.md section 9). The
// request without search is byte for byte what it was.
export const SEARCH_QUERY_FIELDS = Object.freeze(['search_query_1', 'search_query_2']);
const SEARCH_FIELDS = [...FIELDS, ...SEARCH_QUERY_FIELDS].sort();
const SEARCH_SCHEMA = {
  name: 'clo_decision_search',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'skip_class', 'crisis', 'need_search', ...SEARCH_QUERY_FIELDS],
    properties: {
      ...RESPONSE_FORMAT.json_schema.schema.properties,
      search_query_1: { type: 'string' },
      search_query_2: { type: 'string' },
    },
  },
};
// The addendum the search prompt adds, beside the base prompt, which stays as it is.
export const SEARCH_ADDENDUM_FILE = 'decision-search-addendum.zh.md';

const clamp = (text, chars) => [...String(text ?? '')].slice(0, chars).join('');

function baseAnswer(v) {
  // Kept as answered: past the crisis caps routeDecision still needs the class and the action.
  if (v.crisis) return { action: v.action, skipClass: v.skip_class, crisis: true };
  // Forced locally, whatever the model said.
  if (v.skip_class !== 'none') return { action: 'skip', skipClass: v.skip_class, crisis: false };
  return { action: v.action, skipClass: 'none', crisis: v.crisis };
}

// search: the answer was asked for with the search schema. Without it need_search is ignored, as it always was, and the
// result is what it always was. With it the result also carries search: { need, queries }, the raw query strings as
// the model wrote them; what may leave this machine is decided later (search.js cleanQuery), never here.
export function parseAnswer(content, { search = false } = {}) {
  let v;
  try {
    v = JSON.parse(content);
  } catch {
    return null;
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  if (Object.keys(v).sort().join() !== (search ? SEARCH_FIELDS : FIELDS).join()) return null;
  if (v.action !== 'reply' && v.action !== 'skip') return null;
  if (!SKIP_CLASSES.includes(v.skip_class)) return null;
  if (typeof v.crisis !== 'boolean' || typeof v.need_search !== 'boolean') return null;
  if (!search) return baseAnswer(v);
  if (SEARCH_QUERY_FIELDS.some((f) => typeof v[f] !== 'string')) return null;
  // A person in danger is never searched for. The class stays as answered so the gate can tell a refusal.
  const need = v.need_search === true && v.crisis !== true;
  const queries = need ? SEARCH_QUERY_FIELDS.map((f) => v[f]).filter((q) => q.trim() !== '') : [];
  return { ...baseAnswer(v), search: { need, queries, skipClass: v.skip_class } };
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

// The answer's schema, as every adapter takes it.
const DECISION_SCHEMA = { name: RESPONSE_FORMAT.json_schema.name, schema: RESPONSE_FORMAT.json_schema.schema };

function requestOf(adapter, eff, prompt, { trigger, lines, current }, schema = DECISION_SCHEMA) {
  const { decision } = eff.models;
  const { decisionLines, decisionLineChars } = eff.retention;
  const payload = {
    trigger,
    lines: (lines ?? []).slice(-decisionLines).map((l) => ({ sender: l.sender, text: clamp(l.text, decisionLineChars) })),
    current: { sender: current.sender, text: clamp(current.text, currentChars(eff)) },
  };
  return adapter.decisionBody({
    model: decision.id, effort: decision.effort, maxTokens: decision.maxTokens, system: prompt, user: JSON.stringify(payload), schema,
  });
}

// The OpenRouter request, as the goldens and the Q5 probe build it.
export function buildRequest(eff, prompt, args) {
  return requestOf(openrouterAdapter, eff, prompt, args);
}

// The base prompt with the search addendum after it, as the search request sends it.
export const searchPrompt = (base, addendum) => `${base.endsWith('\n') ? base : `${base}\n`}${addendum}`;

// The OpenRouter request with search on, for the tests that measure its hold.
export function buildSearchRequest(eff, prompt, args) {
  return requestOf(openrouterAdapter, eff, prompt, args, SEARCH_SCHEMA);
}

const costMicros = (usage) => {
  const cost = usage?.costUsd;
  return typeof cost === 'number' && Number.isFinite(cost) && cost > 0 ? Math.ceil(cost * 1e6) : null;
};

// What the call cost. A provider that reports a cost settles from it, as before. One that does not is priced from its
// tokens at the locked price ('computed'), with flags for anything the price could not take at the standard rate;
// usage that cannot be priced gives null, so the hold stays counted. An unknown kind prices nothing.
function costOf(kind, usage, price) {
  if (CAPABILITIES[kind]?.reportsCost === true) return { actualMicros: costMicros(usage) };
  const s = settleMicros(usage, price, { kind });
  return { actualMicros: s?.micros ?? null, costSource: 'computed', costFlags: s?.flags ?? [] };
}

const skip = (invalid, over = {}) => ({
  action: 'skip', skipClass: 'none', crisis: false, invalid, paid: true,
  actualMicros: null, model: null, httpStatus: null, limitSource: null, ...over,
});

// client: the shared chat client of the provider in use. Without one, an OpenRouter client of its own is made over fetch.
// searchAddendumFile: the addendum the search request appends; by default the file beside the base prompt.
export function createDecider({ client = null, fetch = globalThis.fetch, getKey, getEffective, promptFile, searchAddendumFile, log = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  // No deadline is passed to it, so it never retries: a decision is cheap to skip.
  const chat = client ?? createOpenRouterClient({ fetch, getKey, getBaseUrl: () => getEffective()?.openrouter?.baseUrl, log, now });
  const adapter = chat.adapter ?? openrouterAdapter;
  let prompt = null;
  let addendum = null;
  const loadPrompt = (eff) => {
    prompt ??= readFileSync(promptFile ?? eff.paths.decisionPromptFile, 'utf8');
    return prompt;
  };
  const loadSearchPrompt = (eff) => {
    const base = loadPrompt(eff);
    addendum ??= readFileSync(searchAddendumFile ?? join(dirname(promptFile ?? eff.paths.decisionPromptFile), SEARCH_ADDENDUM_FILE), 'utf8');
    return searchPrompt(base, addendum);
  };

  // search: true asks with the search schema and prompt (own runtime, search on in the group). Left out or false, the
  // request is the one it always was.
  return async function decide({ trigger, lines, current, signal, search = false }) {
    const started = now();
    const eff = getEffective();
    const key = eff ? getKey() : null;
    let text;
    try {
      if (!eff || !key) throw new Error('unavailable');
      text = search === true ? loadSearchPrompt(eff) : loadPrompt(eff);
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

    // A provider that reports a cost keeps a request it never sent as it always did: unsettled, until its Key reads
    // settle it. One that reports none has no Key read to settle it, so what never left this machine is released
    // (decision D4) instead of staying counted until the owner accepts it.
    const reportsCost = CAPABILITIES[adapter.kind]?.reportsCost === true;
    let r;
    try {
      let body;
      try {
        body = requestOf(adapter, eff, text, { trigger, lines, current }, search === true ? SEARCH_SCHEMA : DECISION_SCHEMA);
      } catch (err) {
        // A body the adapter will not build, before anything is sent. With a cost report the gate keeps the hold.
        if (reportsCost) throw err;
        return finish(skip('http', { model, paid: false }));
      }
      r = await chat.post(body, { signal: ctl.signal });
    } finally {
      clearTimer(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }

    if (r.kind === 'aborted') return finish(skip('timeout', { model, httpStatus: r.status }));
    if (r.kind === 'not_sent') return finish(skip('http', { model, httpStatus: r.status, ...(reportsCost ? {} : { paid: false }) }));
    if (r.reason === 'network') return finish(skip('http', { model, httpStatus: r.status }));
    const base = { model, ...costOf(adapter.kind, r.usage, eff.models.decision.price), httpStatus: r.status };
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
    const answer = parseAnswer(content.trim(), { search: search === true });
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
