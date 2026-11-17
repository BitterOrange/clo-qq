// The search step of the own runtime (docs/search-contract.md sections 5 and 6): query cleaning, the calls, their
// settlement, and what the primary turn is told. It never posts anything: Sonar's text is material in the primary
// turn's user message, and the reply goes through the exit like any other. Nothing here logs a query, a result or a
// source name; the log keeps statuses, counts, times, HTTP statuses and figures.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { findUrls } from './urls.js';
import { searchMicros } from './providers/cost.js';
import { searchAdapter as defaultAdapter } from './providers/searchAdapter.js';
import { SEARCH_CEILINGS, searchOfEffective } from './providers/searchRegistry.js';

// What the primary turn still needs after the search: its own shortest run and the exit's posting time
// (docs/search-contract.md section 6, step 2). A search that cannot end inside that is not started.
export const MIN_TURN_MS = 45000;
export const DELIVERY_RESERVE_MS = 15000;
// At most this many source names in the line the program appends (decision D2: 1 to 3).
export const SOURCE_LINE_MAX = 3;
export const SOURCE_LINE_PREFIX = '来源：';

// The notes a turn with search material sends as a second system block (turn.js), beside the decision prompt in the
// persona folder. Not part of the shared persona files, so a turn without search, and the OpenClaw runtime, send the
// system prompt they always did.
export const SEARCH_NOTE_FILE = 'search-notes.zh.md';
export function readSearchNote(eff) {
  const text = readFileSync(join(dirname(eff.paths.decisionPromptFile), SEARCH_NOTE_FILE), 'utf8').trim();
  if (!text) throw new Error('search notes are empty');
  return text;
}

const CONTROL = /[\p{Cc}\p{Cf}]/gu;
// A speaker code the gate gives members (U1, U2, ...), on either case, not inside a longer word or number.
const SPEAKER_CODE = /(?<![A-Za-z0-9])[Uu]\d+(?!\d)/u;
// A QQ number, a member or group id, a phone number: six digits or more in a row.
const LONG_DIGITS = /\d{6,}/u;
// A QQ mention mark, or what is left of one.
const MENTION = /<@|@!?[A-Za-z0-9]{6,}/u;
// Display names shorter than this are too common to refuse a query over (a one-character name is in many words).
const MIN_NAME_CHARS = 2;

/**
 * One query term from the decision model, as it may leave this machine, or the reason it may not. NFKC, control and
 * format characters out, whitespace collapsed. Refused whole, never cut or rewritten: longer than maxChars code points,
 * a URL, a mention mark, a speaker code, a known display name, six or more digits in a row, a leak (the turn's raw ids,
 * the process's secrets, the leak shapes) or a local rule. The program can hold these shapes; it cannot hold a term to
 * what the answer needs (docs/search-contract.md section 5).
 * -> { ok: true, query } | { ok: false, reason }
 */
export function cleanQuery(raw, { maxChars = SEARCH_CEILINGS.queryMaxChars, policy, rawIds = [], secrets = [], displayNames = [] } = {}) {
  if (typeof raw !== 'string') return { ok: false, reason: 'empty' };
  const query = raw.normalize('NFKC').replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim();
  if (!query) return { ok: false, reason: 'empty' };
  const limit = Math.min(Number.isInteger(maxChars) && maxChars > 0 ? maxChars : SEARCH_CEILINGS.queryMaxChars, SEARCH_CEILINGS.queryMaxChars);
  if ([...query].length > limit) return { ok: false, reason: 'long' };
  if (findUrls(query).length > 0) return { ok: false, reason: 'url' };
  if (MENTION.test(query)) return { ok: false, reason: 'mention' };
  if (SPEAKER_CODE.test(query)) return { ok: false, reason: 'speaker' };
  if (LONG_DIGITS.test(query)) return { ok: false, reason: 'digits' };
  const folded = query.toLowerCase();
  for (const name of displayNames) {
    if (typeof name !== 'string') continue;
    const n = name.normalize('NFKC').replace(CONTROL, '').trim().toLowerCase();
    if ([...n].length >= MIN_NAME_CHARS && folded.includes(n)) return { ok: false, reason: 'name' };
  }
  try {
    if (policy.checkLeak(query, { secrets, rawIds }).hit) return { ok: false, reason: 'leak' };
    if (policy.check(query).hit) return { ok: false, reason: 'rule' };
  } catch {
    return { ok: false, reason: 'rule' };
  }
  return { ok: true, query };
}

/**
 * What a decision asks of search: null for nothing, { refused: true } for a search on a topic the decision classed
 * (decision D6: the primary model says "这个我不查"), or { queries } with the raw terms. A person in danger is never
 * searched for; parseAnswer has already dropped the need then.
 */
export function searchRequestOf(d) {
  const s = d?.search;
  if (!s || d.invalid || s.need !== true) return null;
  if (d.crisis === true) return null;
  if (s.skipClass !== 'none') return { refused: true, queries: [] };
  const queries = Array.isArray(s.queries) ? s.queries.filter((q) => typeof q === 'string' && q.trim() !== '') : [];
  return queries.length > 0 ? { refused: false, queries } : null;
}

// The status the turn sees as a whole: material if any call gave some, else the plainest reason for none.
export function overallStatus(items) {
  const has = (status) => items.some((i) => i.status === status);
  if (has('ok')) return 'ok';
  if (has('refused')) return 'refused';
  if (has('no_source')) return 'no_source';
  return 'failed';
}

/** The line the program appends to a reply that had material (decision D2), or null. Names only, never a URL. */
export function sourceLine(turn) {
  if (turn?.search?.status !== 'ok') return null;
  const names = Array.isArray(turn.searchSources) ? turn.searchSources.filter((n) => typeof n === 'string' && n) : [];
  if (names.length === 0) return null;
  return `${SOURCE_LINE_PREFIX}${names.slice(0, SOURCE_LINE_MAX).join('、')}`;
}

/** The reply as it goes to the exit: the model's text, then the source line on its own line when there is one. */
export function withSourceLine(text, turn) {
  const line = sourceLine(turn);
  return line ? `${String(text).trimEnd()}\n${line}` : text;
}

const refusedAll = () => ({ status: 'refused', items: [{ status: 'refused' }], sources: [] });

/**
 * The search step. client: the search client (providers/modelChat.js over the search adapter). ledger: claimSearch,
 * settleSearch, releaseSearch, markUnsettled, noteSearchError, noteSearchOk. secrets: () => the process's secrets.
 * beforeRetry: (groupKey) => whether a connect retry may go, asked by the client before its one retry.
 */
export function createSearchStep({ client, ledger, policy, getEffective, log = () => {}, now = Date.now, secrets = () => [], beforeRetry = null }) {
  const adapter = client?.adapter ?? defaultAdapter;

  // Material Sonar returned, as the turn may see it: refused when the text hits a local rule (decision D6), failed when
  // it carries a leak, and only the source names that pass the same checks.
  function materialOf(r, { rawIds, held }) {
    try {
      if (policy.check(r.text).hit) return { status: 'refused' };
      if (policy.checkLeak(r.text, { secrets: held, rawIds }).hit) return { status: 'failed' };
    } catch {
      return { status: 'failed' };
    }
    const names = [];
    for (const { name } of r.sources ?? []) {
      try {
        if (typeof name !== 'string' || !name) continue;
        if (findUrls(name).length > 0) continue;
        if (policy.check(name).hit || policy.checkLeak(name, { secrets: held, rawIds }).hit) continue;
        names.push(name);
      } catch {
        // A name that cannot be checked is left out.
      }
    }
    if (names.length === 0) return { status: 'no_source' };
    return { status: 'ok', text: r.text, names };
  }

  // Settles one call by its reservation, never by event: the reply's row is on the same event. Not sent: released. A
  // figure: settled at it (above the hold pauses search). No figure: unsettled, counted at the hold until it settles.
  function settleCall(id, r, price) {
    if (r.kind === 'not_sent') {
      ledger.releaseSearch(id);
      return null;
    }
    const known = searchMicros(r.usage, price);
    if (known) {
      ledger.settleSearch(id, { actualMicros: known.micros, source: known.source, model: r.usage?.model ?? null });
      return known.micros;
    }
    ledger.markUnsettled(id);
    return null;
  }

  // What the call says about the search provider. Our own abort says nothing. A handled answer, whatever its content,
  // is a provider that answered.
  function noteHealth(r) {
    if (r.kind === 'aborted') return;
    if (r.kind === 'not_sent') {
      if (r.reason !== 'unavailable') ledger.noteSearchError({ httpStatus: null, limitSource: null });
      return;
    }
    if (r.kind === 'ok' || r.kind === 'no_source' || (r.kind === 'refusal' && r.reason !== 'moderation')) {
      ledger.noteSearchOk();
      return;
    }
    ledger.noteSearchError({ httpStatus: r.status ?? null, limitSource: r.info?.limitSource ?? null });
  }

  async function oneCall({ eventKey, groupKey, query, search, signal, rawIds, held }) {
    const started = now();
    const claim = ledger.claimSearch({ eventKey });
    if (!claim.ok) {
      log('search_call', { eventKey, status: 'failed', reason: claim.reason });
      return { status: 'failed' };
    }
    let r;
    try {
      const body = adapter.searchBody({ model: search.model, maxTokens: search.maxTokens, query });
      r = await client.post(body, {
        signal,
        deadlineAt: started + search.searchMs,
        ...(beforeRetry ? { beforeRetry: () => beforeRetry(groupKey) } : {}),
      });
    } catch {
      // The client does not throw. If it ever does, whether a request left is unknown: it counts as sent.
      r = { kind: 'error', reason: 'network', status: null, usage: null, info: null };
    }
    let actualMicros = null;
    try {
      actualMicros = settleCall(claim.id, r, search.price);
      noteHealth(r);
    } catch {
      log('ledger_error', { reason: 'search_settle' });
    }
    const item = r.kind === 'ok' ? materialOf(r, { rawIds, held })
      : r.kind === 'no_source' ? { status: 'no_source' }
        : { status: 'failed' };
    log('search_call', {
      eventKey, status: item.status, reason: r.kind === 'ok' ? null : r.reason ?? r.kind, httpStatus: r.status ?? null,
      count: item.names?.length ?? 0, actualMicros, durationMs: now() - started,
    });
    return item;
  }

  /**
   * request: searchRequestOf's answer. prerule: the inbound text hit a local rule. rawIds: the turn's raw ids.
   * displayNames: names known in the group. signal: the turn's own (a /stop, a shutdown or the deadline aborts it).
   * deadlineAt: the passive window's end. -> null (no search) or { status, items, sources }.
   */
  async function run({ eventKey, groupKey = null, request, prerule = false, rawIds = [], displayNames = [], signal, deadlineAt }) {
    if (!request) return null;
    const eff = getEffective();
    const search = searchOfEffective(eff);
    if (!search) return null;
    // Local checks first: nothing leaves, nothing is held, nothing is counted.
    if (request.refused === true || prerule === true) {
      log('search_call', { eventKey, status: 'refused', reason: request.refused === true ? 'class' : 'rule' });
      return refusedAll();
    }
    const held = (() => {
      try {
        return secrets().filter((v) => typeof v === 'string' && v);
      } catch {
        return [];
      }
    })();
    const perAnswer = Math.min(search.perAnswer, SEARCH_CEILINGS.perAnswer);
    const items = [];
    const sources = [];
    for (const raw of request.queries.slice(0, perAnswer)) {
      if (signal?.aborted) break;
      const c = cleanQuery(raw, { maxChars: search.queryMaxChars, policy, rawIds, secrets: held, displayNames });
      if (!c.ok) {
        log('search_call', { eventKey, status: 'refused', reason: c.reason });
        items.push({ status: 'refused' });
        continue;
      }
      if (now() + search.searchMs + MIN_TURN_MS + DELIVERY_RESERVE_MS > deadlineAt) {
        log('search_call', { eventKey, status: 'failed', reason: 'time' });
        items.push({ status: 'failed', query: c.query });
        continue;
      }
      const item = await oneCall({ eventKey, groupKey, query: c.query, search, signal, rawIds, held });
      if (item.status === 'ok') {
        for (const name of item.names) if (!sources.includes(name)) sources.push(name);
        items.push({ status: 'ok', query: c.query, text: item.text });
      } else {
        items.push(item.status === 'refused' ? { status: 'refused' } : { status: item.status, query: c.query });
      }
    }
    if (items.length === 0) items.push({ status: 'failed' });
    return { status: overallStatus(items), items, sources };
  }

  return { run };
}
