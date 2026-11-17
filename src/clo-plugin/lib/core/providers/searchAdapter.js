// OpenRouter's Sonar search, as an adapter for modelChat.js: the request body and the classification of every response
// shape. Pure: no fetch, no cost, no pause. docs/search-contract.md section 4 is the contract.
// What leaves it: the answer text cut to a limit, up to MAX_SOURCES source names, usage, the HTTP status and the same
// short error scalars the chat adapter gives. Provider error text never leaves, and URLs never leave: a source with no
// usable title is named by its host's main label, which carries no dot, so it cannot read as a URL either.
// The field names of the citations are unverified (section 9): all three shapes seen in documentation are read.
import { findUrls } from '../urls.js';
import { mapUsage, openrouterAdapter } from './openrouterAdapter.js';
import { SEARCH_CEILINGS, SEARCH_DEFAULTS } from './searchRegistry.js';

export const MAX_SOURCES = 5;
export const SOURCE_NAME_MAX = 30;

// The one instruction sent with every query. Fixed text: nothing from the group, the turn or the config is in it.
export const SEARCH_INSTRUCTION = '用简体中文简要回答这个检索问题，只写来源支持的事实，说明信息的时间。纯文本，不要 Markdown，不要网址。';

const CONTROL = /[\p{Cc}\p{Cf}]/gu;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Labels under which a country's registrable names sit (news.bbc.co.uk -> bbc).
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go']);

// The main label of a URL's host: lower case, no dot, no punycode, no IP. Null when there is none.
export function hostLabel(url) {
  let host;
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    host = u.hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host || /^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[')) return null;
  const labels = host.split('.').filter(Boolean);
  if (labels[0] === 'www') labels.shift();
  if (labels.length < 2) return null;
  let i = labels.length - 2;
  if (labels.length >= 3 && SECOND_LEVEL.has(labels[i])) i -= 1;
  const label = labels[i];
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label) && !label.startsWith('xn--') ? label : null;
}

// A title as a source name: one line, no control or format characters, no URL in it, no mark-up brackets, at most
// SOURCE_NAME_MAX code points. Null when nothing usable is left.
export function cleanTitle(title) {
  if (typeof title !== 'string') return null;
  const text = title.normalize('NFKC').replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim();
  if (!text || findUrls(text).length > 0 || /[<>[\]{}]/u.test(text)) return null;
  const cut = [...text].slice(0, SOURCE_NAME_MAX).join('').trim();
  return cut || null;
}

// Every citation the body carries, in its order, as { title, url }. Unknown shapes are skipped.
function citationsOf(body, message) {
  const out = [];
  const annotations = Array.isArray(message?.annotations) ? message.annotations : [];
  for (const a of annotations) {
    const c = isObj(a?.url_citation) ? a.url_citation : null;
    if (a?.type === 'url_citation' && c) out.push({ title: c.title, url: c.url });
  }
  for (const r of Array.isArray(body?.search_results) ? body.search_results : []) {
    if (isObj(r)) out.push({ title: r.title, url: r.url });
  }
  for (const u of Array.isArray(body?.citations) ? body.citations : []) {
    if (typeof u === 'string') out.push({ title: null, url: u });
  }
  return out;
}

// Source names, each once, at most MAX_SOURCES. A citation with no usable name is dropped.
export function sourceNames(body, message) {
  const names = [];
  const seen = new Set();
  for (const c of citationsOf(body, message)) {
    const name = cleanTitle(c.title) ?? hostLabel(c.url);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push({ name });
    if (names.length >= MAX_SOURCES) break;
  }
  return names;
}

// The answer text: control characters but line breaks out, at most limit code points. Null when empty.
function textOf(content, limit) {
  if (typeof content !== 'string') return null;
  const text = content.replace(/\r\n?/g, '\n').replace(/[\p{Cf}]|(?![\n\t])\p{Cc}/gu, '').trim();
  if (!text) return null;
  const chars = [...text];
  return chars.length > limit ? chars.slice(0, limit).join('') : text;
}

const base = (status) => ({ status, message: null, finishReason: null, usage: null, info: null, text: null, sources: [] });

// kind and reason:
//   ok: null; text and 1 to MAX_SOURCES sources
//   no_source: no_source; a handled, billed answer with no usable source name. Its text is withheld here.
//   error: bad_body, no_choice, tool_calls, finish_error, finish_reason, model_mismatch, empty, http, provider_error
//   refusal: moderation (a 403 with no limit source), refusal (message.refusal), content_filter
// The transport adds not_sent, aborted, network and timeout, with no text and no sources.
function classifyWith(limit) {
  return function classify(status, body, requestedModel) {
    const out = base(status);
    if (body === null || !isObj(body)) return { ...out, kind: 'error', reason: 'bad_body' };
    const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
    const message = isObj(choice?.message) ? choice.message : null;
    out.finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null;
    out.usage = mapUsage(body.usage, body.model);
    if (!choice) return { ...out, kind: 'error', reason: 'no_choice' };
    if (message?.refusal) return { ...out, kind: 'refusal', reason: 'refusal' };
    if (out.finishReason === 'content_filter') return { ...out, kind: 'refusal', reason: 'content_filter' };
    if ((Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) || out.finishReason === 'tool_calls') return { ...out, kind: 'error', reason: 'tool_calls' };
    if (out.finishReason === 'error') return { ...out, kind: 'error', reason: 'finish_error' };
    if (out.finishReason !== 'stop' && out.finishReason !== 'length') return { ...out, kind: 'error', reason: 'finish_reason' };
    if (requestedModel && body.model !== requestedModel) return { ...out, kind: 'error', reason: 'model_mismatch' };
    const text = textOf(message?.content, limit);
    if (text === null) return { ...out, kind: 'error', reason: 'empty' };
    const sources = sourceNames(body, message);
    if (sources.length === 0) return { ...out, kind: 'no_source', reason: 'no_source' };
    return { ...out, kind: 'ok', reason: null, text, sources };
  };
}

// The chat adapter's reading of a non-2xx or an error body: only status, error type, provider name and code, and the
// limit source. The Key's own limits are not moderation.
function parseError(status, parsed) {
  return { ...base(status), ...openrouterAdapter.parseError(status, parsed), message: null, text: null, sources: [] };
}

// resultMaxChars: the cut of the answer text, at most the ceiling.
export function createSearchAdapter({ resultMaxChars = SEARCH_DEFAULTS.resultMaxChars } = {}) {
  const limit = Number.isInteger(resultMaxChars) && resultMaxChars > 0 ? Math.min(resultMaxChars, SEARCH_CEILINGS.resultMaxChars) : SEARCH_DEFAULTS.resultMaxChars;
  return Object.freeze({
    kind: 'search',
    retryEvent: 'search_retry',
    resultMaxChars: limit,

    // The Key goes in a header only. No attribution headers, as with chat requests.
    request: (key, baseUrl) => ({ url: `${baseUrl}/chat/completions`, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } }),

    // One query, with the fixed instruction and nothing else: no history, no speaker codes, no ids, no user field.
    searchBody: ({ model, maxTokens, query }) => {
      if (typeof model !== 'string' || !model) throw new TypeError('searchBody: model');
      if (!(Number.isInteger(maxTokens) && maxTokens > 0 && maxTokens <= SEARCH_CEILINGS.maxTokens)) throw new TypeError('searchBody: maxTokens');
      if (typeof query !== 'string' || !query.trim()) throw new TypeError('searchBody: query');
      return {
        model,
        stream: false,
        max_tokens: maxTokens,
        usage: { include: true },
        messages: [
          { role: 'system', content: SEARCH_INSTRUCTION },
          { role: 'user', content: query },
        ],
      };
    },
    requestedModel: (body) => (typeof body?.model === 'string' ? body.model : null),

    parseError,
    classify: classifyWith(limit),
  });
}

export const searchAdapter = createSearchAdapter();
