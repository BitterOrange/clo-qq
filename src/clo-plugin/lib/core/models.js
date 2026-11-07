// Catalog validation, the opus-latest selector, prices and hold arithmetic. For Anthropic direct: the price book, its
// lock, and the model capability read.
import { ANTHROPIC_VERSION, MODEL_ID_RULES } from './providers/registry.js';

const OPUS_ROW = /^anthropic\/claude-opus-(\d+)(?:\.(\d+))?$/;
const ALIAS_ROW = '~anthropic/claude-opus-latest';
const ANTHROPIC_ID = /^anthropic\/[^:\s~]+$/;
const DEFAULT_MAX_OUTPUT_PER_M = 30;
const MANDATORY_REASONING_MIN_TOKENS = 2000;

export async function fetchCatalog({ fetch, baseUrl }) {
  const res = await fetch(`${baseUrl}/models`, { method: 'GET', signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`model catalog read failed: HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body?.data)) throw new Error('model catalog read failed: unexpected shape');
  return body.data;
}

const rowOf = (id, catalog) => catalog.find((m) => m.id === id) ?? null;

function reasoningEqual(a, b) {
  const shape = (m) => JSON.stringify({
    supported: (m.supported_parameters ?? []).includes('reasoning'),
    mandatory: m.reasoning?.mandatory ?? null,
    efforts: [...(m.reasoning?.supported_efforts ?? [])].sort(),
  });
  return shape(a) === shape(b);
}

function pricingEqual(a, b) {
  const shape = (m) => JSON.stringify(['prompt', 'completion', 'input_cache_read', 'input_cache_write'].map((k) => Number(m.pricing?.[k] ?? -1)));
  return shape(a) === shape(b);
}

export function resolveSelector(id, catalog) {
  if (id === 'openrouter/auto') throw new Error('openrouter/auto is not allowed');
  if (id !== 'opus-latest') {
    if (!ANTHROPIC_ID.test(id)) throw new Error(`refused model id ${id}: anthropic/ only, no :suffix, no ~ alias`);
    return id;
  }
  const versions = catalog
    .map((m) => ({ m, match: OPUS_ROW.exec(m.id ?? '') }))
    .filter((r) => r.match)
    .map((r) => ({ m: r.m, major: Number(r.match[1]), minor: Number(r.match[2] ?? 0) }))
    .sort((a, b) => b.major - a.major || b.minor - a.minor);
  if (versions.length === 0) throw new Error('opus-latest: no concrete Opus row in the catalog');
  const top = versions[0].m;
  if (versions.some((v) => v.m !== top && (v.m.created ?? 0) > (top.created ?? 0))) {
    throw new Error(`opus-latest: ${top.id} is the highest version but not the newest row. Choose an id explicitly.`);
  }
  const alias = rowOf(ALIAS_ROW, catalog);
  if (!alias) throw new Error('opus-latest: the alias row is absent, so the choice cannot be checked. Choose an id explicitly.');
  if (!pricingEqual(top, alias) || !reasoningEqual(top, alias)) {
    throw new Error(`opus-latest: ${top.id} differs from the alias row in price or reasoning. Choose an id explicitly.`);
  }
  return top.id;
}

function perMillion(value, what, id) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`model ${id}: bad ${what} price`);
  return Number((n * 1e6).toFixed(6));
}

export function priceFor(id, catalog) {
  const row = rowOf(id, catalog);
  if (!row) throw new Error(`model ${id} is not in the catalog`);
  const p = row.pricing ?? {};
  if (p.prompt === undefined || p.completion === undefined) throw new Error(`model ${id}: price missing`);
  const inputPerM = perMillion(p.prompt, 'input', id);
  return {
    inputPerM,
    outputPerM: perMillion(p.completion, 'output', id),
    // Without a cache price, assume no discount. Holds and computed cost must not understate.
    cacheReadPerM: p.input_cache_read === undefined ? inputPerM : perMillion(p.input_cache_read, 'cache read', id),
    cacheWritePerM: p.input_cache_write === undefined ? inputPerM : perMillion(p.input_cache_write, 'cache write', id),
  };
}

export function callWorstMicros(price, { contextTokens, maxTokens }) {
  if (!price) throw new Error('callWorstMicros: price is not locked');
  return Math.ceil(contextTokens * price.inputPerM + maxTokens * price.outputPerM);
}

function checkRow(path, id, block, catalog, err) {
  const row = rowOf(id, catalog);
  if (!row) {
    err(path, `${id} is not in the catalog`);
    return null;
  }
  if (!ANTHROPIC_ID.test(id)) err(path, `${id} is refused: anthropic/ only, no :suffix, no ~ alias`);
  const limit = row.top_provider?.max_completion_tokens;
  if (Number.isFinite(limit) && block.maxTokens > limit) err(`${path}.maxTokens`, `above the provider limit ${limit}`);
  return row;
}

export function validateModels(cfg, catalog, { confirmPrice = false, qqPlatformNotified = false, change = false } = {}) {
  const errors = [];
  const warnings = [];
  const err = (path, message) => { errors.push({ path, message }); };

  let primaryId = null;
  try {
    primaryId = resolveSelector(cfg.claudeModel.id, catalog);
  } catch (e) {
    err('claudeModel.id', e.message);
  }
  if (primaryId) {
    const row = checkRow('claudeModel', primaryId, cfg.claudeModel, catalog, err);
    if (row) {
      const params = row.supported_parameters ?? [];
      if (!params.includes('tools')) err('claudeModel', 'the model does not support tools');
      if (!params.includes('reasoning')) err('claudeModel', 'the model does not support reasoning');
      const r = row.reasoning ?? {};
      const effort = cfg.claudeModel.effort;
      if (effort === 'none' && r.mandatory === true) err('claudeModel.effort', 'none is refused: reasoning is mandatory on this model');
      if (effort !== 'none' && !(r.supported_efforts ?? []).includes(effort)) err('claudeModel.effort', `${effort} is not a supported effort`);
      try {
        const ceiling = cfg.budget?.maxOutputUsdPerMtok ?? DEFAULT_MAX_OUTPUT_PER_M;
        if (priceFor(primaryId, catalog).outputPerM > ceiling && !confirmPrice) err('claudeModel', `output price is above $${ceiling}/M; pass --confirm-price`);
      } catch (e) {
        err('claudeModel', e.message);
      }
    }
  }

  const decisionId = cfg.decisionModel.id;
  const row = checkRow('decisionModel', decisionId, cfg.decisionModel, catalog, err);
  if (row) {
    if (!(row.supported_parameters ?? []).includes('response_format')) err('decisionModel', 'the model does not support response_format');
    const r = row.reasoning ?? {};
    const effort = cfg.decisionModel.effort;
    if (r.mandatory === true) {
      if (effort === 'none') err('decisionModel.effort', 'none is refused: reasoning is mandatory on this model');
      else {
        warnings.push({ path: 'decisionModel', message: 'reasoning is mandatory on this model, so decisions cost more' });
        if (cfg.decisionModel.maxTokens < MANDATORY_REASONING_MIN_TOKENS) err('decisionModel.maxTokens', `must be at least ${MANDATORY_REASONING_MIN_TOKENS} when reasoning is mandatory`);
      }
    }
    if (effort !== 'none' && r.supported_efforts && !r.supported_efforts.includes(effort)) err('decisionModel.effort', `${effort} is not a supported effort`);
    try {
      priceFor(decisionId, catalog);
    } catch (e) {
      err('decisionModel', e.message);
    }
  }

  if (change && cfg.qq?.enabled && !qqPlatformNotified) err('qq', 'a model change needs --qq-platform-notified while QQ is enabled');
  return { ok: errors.length === 0, errors, warnings };
}

// What buildEffective takes as modelsLock, and what the CLI records in versions.lock.json.
export function lockFromCatalog(cfg, catalog) {
  const primaryId = resolveSelector(cfg.claudeModel.id, catalog);
  const decisionId = resolveSelector(cfg.decisionModel.id, catalog);
  return {
    primary: { id: primaryId, selector: cfg.claudeModel.id, price: priceFor(primaryId, catalog) },
    decision: { id: decisionId, price: priceFor(decisionId, catalog) },
  };
}

// ---- Anthropic, direct (the own runtime only) ----
// The Messages API returns no price, so prices come from a price book entered by hand into versions.lock.json and
// reviewed against the published rates. A lock takes them from the book for exactly the configured ids.

export const ANTHROPIC_PRICE_FIELDS = Object.freeze(['inputPerM', 'outputPerM', 'cacheReadPerM', 'cacheWritePerM', 'cacheWrite1hPerM']);
const BOOK_MODEL_FIELDS = [...ANTHROPIC_PRICE_FIELDS, 'long'];
const LONG_FIELDS = ['aboveTokens', ...ANTHROPIC_PRICE_FIELDS];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isRate = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

// Every rate is written out: a reviewed book never leans on a default multiple.
function cardProblems(card, at, fields, out) {
  if (!isObj(card)) {
    out.push({ path: at, message: 'must be an object' });
    return;
  }
  for (const f of Object.keys(card)) if (!fields.includes(f)) out.push({ path: `${at}.${f}`, message: 'unknown field' });
  for (const f of ANTHROPIC_PRICE_FIELDS) if (!isRate(card[f])) out.push({ path: `${at}.${f}`, message: 'must be a positive number of USD per million tokens' });
  rateOrderProblems(card, at, out);
}

// The rates of one card must fit together, so a slipped digit shows: a cache read is no dearer than input, a
// five-minute write no cheaper than input, a one-hour write no cheaper than a five-minute one, and output no cheaper
// than input. Checked only once each rate is itself valid.
const RATE_ORDER = [
  ['cacheReadPerM', 'inputPerM', 'a cache read must not cost more than input'],
  ['inputPerM', 'cacheWritePerM', 'a five-minute cache write must not cost less than input'],
  ['cacheWritePerM', 'cacheWrite1hPerM', 'a one-hour cache write must not cost less than a five-minute one'],
  ['inputPerM', 'outputPerM', 'output must not cost less than input'],
];
function rateOrderProblems(card, at, out) {
  for (const [low, high, message] of RATE_ORDER) {
    if (isRate(card[low]) && isRate(card[high]) && card[low] > card[high]) out.push({ path: `${at}.${high}`, message });
  }
}

// { checkedOn, source, unverified: [], models: { <id>: price } }. unverified lists ids, or id.field paths, whose rates
// were not found in the source; nothing listed there can be locked.
export function priceBookProblems(book) {
  const out = [];
  if (!isObj(book)) return [{ path: '', message: 'no price book' }];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(book.checkedOn ?? '')) out.push({ path: 'checkedOn', message: 'must be YYYY-MM-DD' });
  if (!(typeof book.source === 'string' && book.source.trim())) out.push({ path: 'source', message: 'required' });
  if (!(Array.isArray(book.unverified) && book.unverified.every((p) => typeof p === 'string' && p))) out.push({ path: 'unverified', message: 'must be a list of ids or id.field paths' });
  if (!isObj(book.models) || Object.keys(book.models).length === 0) {
    out.push({ path: 'models', message: 'must list at least one model' });
    return out;
  }
  for (const [id, price] of Object.entries(book.models)) {
    const at = `models.${id}`;
    if (!MODEL_ID_RULES.anthropic.test(id)) out.push({ path: at, message: 'not a concrete Anthropic model id' });
    cardProblems(price, at, BOOK_MODEL_FIELDS, out);
    if (isObj(price) && price.long !== undefined) {
      cardProblems(price.long, `${at}.long`, LONG_FIELDS, out);
      if (!(Number.isInteger(price.long?.aboveTokens) && price.long.aboveTokens > 0)) out.push({ path: `${at}.long.aboveTokens`, message: 'must be a positive integer' });
      // Long prompts cost at least the short rates: a cheaper long card would under-count the dearest calls.
      if (isObj(price.long)) for (const f of ANTHROPIC_PRICE_FIELDS) {
        if (isRate(price[f]) && isRate(price.long[f]) && price.long[f] < price[f]) out.push({ path: `${at}.long.${f}`, message: 'must not cost less than the short-prompt rate' });
      }
    }
  }
  return out;
}

const unverifiedFor = (book, id) => (Array.isArray(book?.unverified) ? book.unverified : []).filter((p) => p === id || p.startsWith(`${id}.`));

function ratesOf(price) {
  const flat = ANTHROPIC_PRICE_FIELDS.map((f) => [f, price?.[f]]);
  if (isObj(price?.long)) for (const f of LONG_FIELDS) flat.push([`long.${f}`, price.long[f]]);
  return Object.fromEntries(flat);
}

// Any difference in any rate, or a long-prompt card that appears or goes away. A fall needs a confirmation as much as a
// rise: nothing reconciles an Anthropic lock, so a book typed too low would under-count every reply in silence.
function priceChanged(oldPrice, price) {
  const a = ratesOf(oldPrice);
  const b = ratesOf(price);
  if (isObj(price?.long) !== isObj(oldPrice?.long)) return true;
  return Object.keys(b).some((k) => b[k] !== a[k]);
}

// The Anthropic lock for ids { primary, decision }: { ok, errors, lock }. Nothing in versions.lock.json changes here.
// --confirm-price is needed on the first lock, on a different id, on any change of price and above the output
// ceiling; only a relock of the same ids at exactly the locked prices passes without it.
export function lockFromPriceBook(ids, book, { previous = null, confirmPrice = false, maxOutputPerM = DEFAULT_MAX_OUTPUT_PER_M } = {}) {
  const errors = [];
  const err = (path, message) => { errors.push({ path, message }); };
  for (const p of priceBookProblems(book)) err(`priceBook.${p.path}`, p.message);
  const lock = {};
  for (const role of ['primary', 'decision']) {
    const id = ids?.[role];
    if (!(typeof id === 'string' && MODEL_ID_RULES.anthropic.test(id))) {
      err(role, 'not a concrete Anthropic model id');
      continue;
    }
    const price = isObj(book?.models) && Object.hasOwn(book.models, id) ? book.models[id] : null;
    if (!price) {
      err(role, `${id} has no reviewed price in the book`);
      continue;
    }
    const unverified = unverifiedFor(book, id);
    if (unverified.length) err(role, `${id}: rates not found in the source cannot be locked (${unverified.join(', ')})`);
    if (isRate(price.outputPerM) && price.outputPerM > maxOutputPerM && !confirmPrice) err(role, `output price is above $${maxOutputPerM}/M; pass --confirm-price`);
    lock[role] = role === 'primary' ? { id, selector: id, price: structuredClone(price) } : { id, price: structuredClone(price) };
  }
  if (errors.length === 0 && !confirmPrice) {
    const same = previous?.primary?.id === lock.primary.id && previous?.decision?.id === lock.decision.id;
    if (!same) err('price', 'a first lock or a different model needs --confirm-price');
    else if (priceChanged(previous.primary.price, lock.primary.price) || priceChanged(previous.decision.price, lock.decision.price)) err('price', 'the book price differs from the locked one; pass --confirm-price');
  }
  return errors.length ? { ok: false, errors, lock: null } : { ok: true, errors, lock };
}

// The decision is sent with thinking disabled and this effort (decision D9): config effort 'none' maps here.
export const ANTHROPIC_DECISION_SENT_EFFORT = 'low';

// Where GET /v1/models/{id} says a model can do what this project sends. The API documents a full capability tree
// with `supported` at each leaf; a path marked documented: false is not in the reference, so a model whose answer
// lacks it fails as unknown until the free call has shown the real path. Confirm every path before relying on it.
// '<effort>' stands for the effort level sent. No tools leaf is checked: the Anthropic adapter never sends tools.
export const ANTHROPIC_CAPABILITY_LEAVES = Object.freeze({
  effort: Object.freeze({ path: Object.freeze(['capabilities', 'effort', '<effort>', 'supported']), documented: true }),
  structured_outputs: Object.freeze({ path: Object.freeze(['capabilities', 'structured_outputs', 'supported']), documented: true }),
  thinking_disabled: Object.freeze({ path: Object.freeze(['capabilities', 'thinking', 'types', 'disabled', 'supported']), documented: false }),
});

function leaf(body, name, effort) {
  let node = body;
  for (const step of ANTHROPIC_CAPABILITY_LEAVES[name].path) {
    if (!isObj(node)) return null;
    node = node[step === '<effort>' ? effort : step];
  }
  return typeof node === 'boolean' ? node : null;
}

// The checks for the active Anthropic entry: [{ role, id, effort, maxTokens }], or null on another kind.
export function anthropicModelChecks(cfg) {
  const entry = cfg?.providers?.[cfg?.activeProvider];
  if (entry?.kind !== 'anthropic' || !isObj(entry.models)) return null;
  return [
    { role: 'primary', id: entry.models.primary, effort: cfg.claudeModel?.effort, maxTokens: cfg.claudeModel?.maxTokens },
    { role: 'decision', id: entry.models.decision, effort: cfg.decisionModel?.effort, maxTokens: cfg.decisionModel?.maxTokens },
  ];
}

const sentEffort = (role, effort) => (role === 'decision' && effort === 'none' ? ANTHROPIC_DECISION_SENT_EFFORT : effort);
const needsOf = (role) => (role === 'decision' ? ['effort', 'structured_outputs', 'thinking_disabled'] : ['effort']);

// Reads each model with the Key in one header, never in the URL, and never follows a redirect. Whether this call is free
// is not documented. It never throws, and its problems are short codes: no provider text and no Key leaves it.
// models: anthropicModelChecks(cfg). -> { ok, rows: [{ role, id, maxTokens, caps }], problems }
export async function checkAnthropicModels({ fetch, baseUrl, key, models, signal }) {
  const problems = [];
  const rows = [];
  if (!(typeof key === 'string' && key)) problems.push('key_missing');
  if (!(typeof baseUrl === 'string' && baseUrl)) problems.push('base_url_missing');
  if (!Array.isArray(models) || models.length === 0) problems.push('models_missing');
  if (problems.length) return { ok: false, rows, problems };
  const bodies = new Map();
  for (const m of models) {
    const role = m?.role === 'decision' ? 'decision' : 'primary';
    const id = m?.id;
    if (!(typeof id === 'string' && MODEL_ID_RULES.anthropic.test(id))) {
      problems.push(`${role}:bad_id`);
      continue;
    }
    if (!bodies.has(id)) bodies.set(id, await readModel({ fetch, baseUrl, key, id, signal }));
    const got = bodies.get(id);
    if (got.problem) {
      problems.push(`${role}:${got.problem}`);
      continue;
    }
    const body = got.body;
    const maxTokens = Number.isInteger(body.max_tokens) && body.max_tokens > 0 ? body.max_tokens : null;
    if (maxTokens === null) problems.push(`${role}:max_tokens_unknown`);
    else if (!(Number.isInteger(m.maxTokens) && m.maxTokens <= maxTokens)) problems.push(`${role}:max_tokens_above_limit`);
    const effort = sentEffort(role, m.effort);
    const caps = {};
    for (const name of needsOf(role)) {
      caps[name] = leaf(body, name, effort);
      if (caps[name] === null) problems.push(`${role}:capability_unknown:${name}`);
      else if (caps[name] === false) problems.push(`${role}:capability_missing:${name}`);
    }
    rows.push({ role, id, maxTokens, caps });
  }
  return { ok: problems.length === 0, rows, problems };
}

async function readModel({ fetch, baseUrl, key, id, signal }) {
  let res;
  try {
    res = await fetch(`${baseUrl}/v1/models/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
      redirect: 'error',
      signal: signal ?? AbortSignal.timeout(15000),
    });
  } catch {
    return { problem: 'network' };
  }
  if (!res.ok) return { problem: `http_${Number.isInteger(res.status) ? res.status : 'error'}` };
  let body;
  try {
    body = await res.json();
  } catch {
    return { problem: 'bad_body' };
  }
  if (!isObj(body)) return { problem: 'bad_body' };
  if (body.id !== id) return { problem: 'model_mismatch' };
  return { body };
}
