// Catalog validation, the opus-latest selector, prices and hold arithmetic.

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
