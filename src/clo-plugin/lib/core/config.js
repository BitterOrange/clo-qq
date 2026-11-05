// Paths, business config validation, the effective reader and live preconditions.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POLICY_CATEGORIES, POLICY_V1_SHA256 } from './contentPolicy.js';
import { usdToMicros } from './ledger.js';

export class ConfigError extends Error {}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const HEARTBEAT_FRESH_MS = 90000;
const SECRET_KEY = /^(client_?secret|app_?secret|api_?key|secret|token|password)$/i;
const DEFAULT_MAX_PART_CHARS = 1500;
// Optional. Left out, the ledger's own defaults apply.
const BUDGET_WAITS = ['decisionRetryMs', 'creditsRetryMs', 'unsettledClearMs', 'unsettledClearReads'];

const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

function realOrSelf(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function resolvePaths(env = process.env) {
  const repoRoot = REPO_ROOT;
  const testRoot = env.CLO_TEST_ROOT ? resolve(env.CLO_TEST_ROOT) : null;
  const root = testRoot ?? repoRoot;
  const envFile = join(root, '.env');
  if (testRoot) {
    const real = join(repoRoot, '.env');
    if (samePath(envFile, real) || samePath(realOrSelf(envFile), realOrSelf(real))) {
      throw new ConfigError('CLO_TEST_ROOT resolves envFile to the real project .env');
    }
  }
  const runtime = join(root, '.runtime');
  const stateDir = join(runtime, 'state');
  const cloDir = join(runtime, 'clo');
  const logsDir = join(runtime, 'logs');
  return {
    repoRoot,
    root,
    runtime,
    configJson: join(root, 'config.json'),
    envFile,
    versionsLock: join(root, 'versions.lock.json'),
    stateDir,
    openclawJson: join(stateDir, 'openclaw.json'),
    home: join(runtime, 'home'),
    workspace: join(runtime, 'workspace'),
    gatewayCwd: join(runtime, 'gateway-cwd'),
    cloDir,
    effectiveJson: join(cloDir, 'effective.json'),
    db: join(cloDir, 'clo.db'),
    logsDir,
    eventLog: join(logsDir, 'events.jsonl'),
    gatewayLog: join(logsDir, 'gateway.log'),
    pidFile: join(runtime, 'pids', 'gateway.json'),
    systemPromptFile: join(cloDir, 'system-prompt.md'),
  };
}

export function loadBusinessConfig(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`cannot read config: ${err.code ?? 'read error'}`);
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new ConfigError('config is not valid JSON');
  }
}

function isLoopbackUrl(url) {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname);
  } catch {
    return false;
  }
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPos = (v) => isNum(v) && v > 0;
const isNonNeg = (v) => isNum(v) && v >= 0;
const isPosInt = (v) => Number.isInteger(v) && v > 0;
const isStr = (v) => typeof v === 'string' && v.length > 0;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasSpace = (v) => /\s/u.test(v);
// Nothing reads a local number: wiring one in would change what someone in danger is told.
const noLocalNumbers = (v) => v === undefined || v === '';

function findSecretKeys(node, path, out) {
  if (!isObj(node)) return;
  for (const [k, v] of Object.entries(node)) {
    const here = path ? `${path}.${k}` : k;
    if (SECRET_KEY.test(k)) out.push(here);
    findSecretKeys(v, here, out);
  }
}

// Checks the budget tier order on its own, since live preconditions reuse it.
export function tiersValid(budget) {
  if (!isObj(budget)) return false;
  const { interjectUsd, searchUsd, namedUsd, addressedUsd, dailyUsd } = budget;
  if (![interjectUsd, searchUsd, namedUsd, addressedUsd, dailyUsd].every(isNonNeg)) return false;
  return interjectUsd <= searchUsd && searchUsd <= namedUsd && namedUsd <= addressedUsd && addressedUsd === dailyUsd;
}

function validateModelBlock(block, path, err) {
  if (!isObj(block)) return err(path, 'required');
  if (!isStr(block.id)) return err(`${path}.id`, 'required');
  if (block.id === 'openrouter/auto') err(`${path}.id`, 'openrouter/auto is not allowed');
  else if (block.id !== 'opus-latest' && !/^anthropic\/[^:\s]+$/.test(block.id)) err(`${path}.id`, 'must be opus-latest or an anthropic/ model id with no :suffix');
  if (!isStr(block.effort)) err(`${path}.effort`, 'required');
  if (!isPosInt(block.maxTokens)) err(`${path}.maxTokens`, 'must be a positive integer');
  return undefined;
}

export function validateBusinessConfig(cfg, { env = process.env } = {}) {
  const errors = [];
  const warnings = [];
  const err = (path, message) => { errors.push({ path, message }); };
  if (!isObj(cfg)) return { ok: false, errors: [{ path: '', message: 'config must be an object' }], warnings };
  const testMode = Boolean(env.CLO_TEST_ROOT);

  const secretKeys = [];
  findSecretKeys(cfg, '', secretKeys);
  for (const p of secretKeys) err(p, 'secrets belong in .env, not in config');

  if (cfg.mode !== 'dry-run' && cfg.mode !== 'live') err('mode', 'must be dry-run or live');
  if (cfg.gatewayPort !== undefined && !(Number.isInteger(cfg.gatewayPort) && cfg.gatewayPort > 0 && cfg.gatewayPort < 65536)) err('gatewayPort', 'must be a port number');

  if (!tiersValid(cfg.budget)) err('budget', 'needs interjectUsd <= searchUsd <= namedUsd <= addressedUsd = dailyUsd, all non-negative');
  if (cfg.budget?.keyDailyLimitUsd !== undefined && !isNonNeg(cfg.budget.keyDailyLimitUsd)) err('budget.keyDailyLimitUsd', 'must be non-negative');
  // Left out, models.js uses its own default ceiling.
  if (cfg.budget?.maxOutputUsdPerMtok !== undefined && !isPos(cfg.budget.maxOutputUsdPerMtok)) err('budget.maxOutputUsdPerMtok', 'must be a positive number');
  for (const f of BUDGET_WAITS) {
    if (cfg.budget?.[f] !== undefined && !(Number.isInteger(cfg.budget[f]) && cfg.budget[f] > 0)) err(`budget.${f}`, 'must be a positive integer');
  }

  validateModelBlock(cfg.claudeModel, 'claudeModel', err);
  if (isObj(cfg.claudeModel) && !isPosInt(cfg.claudeModel.contextTokens)) err('claudeModel.contextTokens', 'must be a positive integer');
  // Holds are priced from the locked cache-write rate, which is the short one.
  if (cfg.claudeModel?.cacheRetention !== undefined && cfg.claudeModel.cacheRetention !== 'short') err('claudeModel.cacheRetention', 'must be short');
  validateModelBlock(cfg.decisionModel, 'decisionModel', err);
  if (cfg.decisionModel?.id === 'opus-latest') err('decisionModel.id', 'the selector is for the primary model only');

  if (cfg.searchProvider !== 'none') err('searchProvider', 'must be none in this build');
  if (!isObj(cfg.timeouts) || !isPos(cfg.timeouts.decisionMs) || !isPos(cfg.timeouts.turnSeconds)) err('timeouts', 'decisionMs and turnSeconds must be positive');

  if (!Array.isArray(cfg.names) || cfg.names.length === 0 || !cfg.names.every(isStr)) err('names', 'must be a non-empty list of strings');

  const ij = cfg.interject;
  if (!isObj(ij) || !isNonNeg(ij.cooldownMinutes) || !isPosInt(ij.perHour) || !isPosInt(ij.perDay) || !isPos(ij.windowMs)) {
    err('interject', 'needs cooldownMinutes, perHour, perDay, windowMs');
  }

  const qh = cfg.quietHours;
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!isObj(qh) || !hhmm.test(qh.start ?? '') || !hhmm.test(qh.end ?? '')) err('quietHours', 'start and end must be HH:MM');
  if (qh?.timezone !== 'Asia/Shanghai') err('quietHours.timezone', 'only Asia/Shanghai is supported');

  const rt = cfg.retention;
  if (!isObj(rt) || !isPos(rt.eventDays) || !isPos(rt.sendDays) || !isPos(rt.reservationDays)) err('retention', 'eventDays, sendDays and reservationDays must be positive');
  // The ledger's Key baseline can be 30 days old, and attribution needs every reservation made since it.
  if (isPos(rt?.reservationDays) && rt.reservationDays <= 30) err('retention.reservationDays', 'must be above 30');
  if (!isPosInt(rt?.contextMaxItems) || rt.contextMaxItems > 40) err('retention.contextMaxItems', 'must be 1 to 40');
  if (!isPos(rt?.contextMaxAgeHours) || rt.contextMaxAgeHours > 24) err('retention.contextMaxAgeHours', 'must be above 0 and at most 24');
  if (!isPosInt(rt?.contextMaxTokens)) err('retention.contextMaxTokens', 'must be a positive integer');

  const qq = cfg.qq;
  if (!isObj(qq)) {
    err('qq', 'required');
  } else {
    if (typeof qq.enabled !== 'boolean') err('qq.enabled', 'must be a boolean');
    if (qq.enabled && !isStr(qq.appId)) err('qq.appId', 'required when qq.enabled');
    if (qq.enabled && isStr(env.CLO_QQ_APP_ID) && qq.appId !== env.CLO_QQ_APP_ID) err('qq.appId', 'does not match CLO_QQ_APP_ID');
    if (qq.urlMode !== 'names') err('qq.urlMode', 'must be names');
    if (qq.maxPartChars !== undefined && !isPosInt(qq.maxPartChars)) err('qq.maxPartChars', 'must be a positive integer');
    if (!Array.isArray(qq.allowedDmUserIds) || qq.allowedDmUserIds.length > 0) err('qq.allowedDmUserIds', 'must be empty in this build');

    for (const k of ['apiBaseUrl', 'tokenBaseUrl']) {
      const url = qq[k];
      if (url !== undefined && url !== '' && !(testMode && isLoopbackUrl(url))) err(`qq.${k}`, 'allowed only in test mode, on loopback');
    }

    const allowed = Array.isArray(qq.allowedGroupIds) ? qq.allowedGroupIds : null;
    const groups = isObj(qq.groups) ? qq.groups : null;
    if (!allowed) err('qq.allowedGroupIds', 'must be a list');
    if (!groups) err('qq.groups', 'must be an object');
    if (allowed && groups) {
      for (const id of allowed) {
        if (!isStr(id) || hasSpace(id)) err('qq.allowedGroupIds', 'ids must be non-empty with no whitespace');
        else if (!Object.hasOwn(groups, id)) err(`qq.allowedGroupIds`, 'each id needs a qq.groups entry');
      }
      const labels = new Set();
      for (const [id, g] of Object.entries(groups)) {
        if (hasSpace(id)) err('qq.groups', 'ids must have no whitespace');
        if (!allowed.includes(id)) err('qq.groups', 'each entry needs an id in qq.allowedGroupIds');
        if (!isObj(g) || !isStr(g.label)) {
          err('qq.groups', 'each entry needs a label');
          continue;
        }
        if (labels.has(g.label)) err('qq.groups', 'labels must be unique');
        labels.add(g.label);
        for (const f of ['interject', 'nameMention', 'noticeGiven']) {
          if (typeof g[f] !== 'boolean') err(`qq.groups.${g.label}.${f}`, 'must be a boolean');
        }
        // Optional: a config written before this switch means off.
        if (g.displayNames !== undefined && typeof g.displayNames !== 'boolean') err(`qq.groups.${g.label}.displayNames`, 'must be a boolean');
        if (g.cooldownMinutes !== undefined && !isNonNeg(g.cooldownMinutes)) err(`qq.groups.${g.label}.cooldownMinutes`, 'must be non-negative');
        for (const f of ['perHour', 'perDay']) {
          if (g[f] !== undefined && !isPosInt(g[f])) err(`qq.groups.${g.label}.${f}`, 'must be a positive integer');
        }
        if (qq.enabled && !ownersOf(qq, id).length) {
          // A group is added before its owner is known, so this only stops live.
          if (cfg.mode === 'live') err(`qq.groups.${g.label}`, 'needs at least one owner');
          else warnings.push({ path: `qq.groups.${g.label}`, message: 'has no owner yet; live will refuse' });
        }
      }
    }
    const members = qq.owner?.groupMember;
    if (members !== undefined && !isObj(members)) err('qq.owner.groupMember', 'must be an object');
    if (isObj(members)) {
      for (const list of Object.values(members)) {
        if (!Array.isArray(list) || !list.every((m) => isStr(m) && !hasSpace(m))) err('qq.owner.groupMember', 'owner ids must be non-empty with no whitespace');
      }
    }
  }

  const cp = cfg.contentPolicy;
  if (!isObj(cp)) {
    err('contentPolicy', 'required');
  } else {
    if (typeof cp.enabled !== 'boolean') err('contentPolicy.enabled', 'must be a boolean');
    if (cp.version !== '1') err('contentPolicy.version', 'must be 1');
    if (!isStr(cp.file)) err('contentPolicy.file', 'required');
    if (cp.sha256 !== undefined && cp.sha256 !== '' && !/^[0-9a-f]{64}$/.test(cp.sha256)) err('contentPolicy.sha256', 'must be empty or a sha256 hex digest');
    if (!isStr(cp.outputFilter?.rulesFile)) err('contentPolicy.outputFilter.rulesFile', 'required');
    const cats = cp.outputFilter?.categories;
    if (!Array.isArray(cats) || !cats.every((c) => POLICY_CATEGORIES.includes(c))) err('contentPolicy.outputFilter.categories', 'allowed: sexual, crime, privacy');
    if (!isStr(cp.crisis?.routeTermsFile)) err('contentPolicy.crisis.routeTermsFile', 'required');
    if (!noLocalNumbers(cp.crisis?.localNumbers)) err('contentPolicy.crisis.localNumbers', 'must be empty');
  }

  if (typeof cfg.privacy?.replaceSystemPrompt !== 'boolean') err('privacy.replaceSystemPrompt', 'must be a boolean');
  if (cfg.openrouter?.baseUrl !== undefined && !(testMode && isLoopbackUrl(cfg.openrouter.baseUrl))) err('openrouter.baseUrl', 'allowed only in test mode, on loopback');

  return { ok: errors.length === 0, errors, warnings };
}

function ownersOf(qq, groupId) {
  const list = qq.owner?.groupMember?.[groupId];
  return Array.isArray(list) ? list : [];
}

const atRepo = (repoRoot, p) => (isAbsolute(p) ? p : join(repoRoot, p));

// modelsLock: { primary: { id, selector, price }, decision: { id, price } }. Absent or null until resolved.
export function buildEffective(cfg, { paths, modelsLock = null, env = process.env, now = Date.now } = {}) {
  const v = validateBusinessConfig(cfg, { env });
  if (!v.ok) throw new ConfigError(`invalid config: ${v.errors.map((e) => e.path).join(', ')}`);
  const groups = {};
  for (const [id, g] of Object.entries(cfg.qq.groups)) {
    groups[id] = {
      label: g.label,
      interject: g.interject,
      nameMention: g.nameMention,
      noticeGiven: g.noticeGiven,
      displayNames: g.displayNames === true,
      cooldownMinutes: g.cooldownMinutes ?? cfg.interject.cooldownMinutes,
      perHour: g.perHour ?? cfg.interject.perHour,
      perDay: g.perDay ?? cfg.interject.perDay,
      ownerMemberIds: [...ownersOf(cfg.qq, id)],
    };
  }
  const b = cfg.budget;
  const cp = cfg.contentPolicy;
  const rt = cfg.retention;
  return {
    version: 1,
    generatedAt: new Date(now()).toISOString(),
    mode: cfg.mode,
    qq: {
      enabled: cfg.qq.enabled,
      appId: cfg.qq.appId ?? '',
      apiBaseUrl: cfg.qq.apiBaseUrl ?? '',
      tokenBaseUrl: cfg.qq.tokenBaseUrl ?? '',
      urlMode: 'names',
      maxPartChars: cfg.qq.maxPartChars ?? DEFAULT_MAX_PART_CHARS,
      maxPartsGroup: 5,
      interjectMaxChars: 400,
      groups,
    },
    names: [...cfg.names],
    quietHours: { start: cfg.quietHours.start, end: cfg.quietHours.end, timezone: cfg.quietHours.timezone },
    window: {
      windowMs: cfg.interject.windowMs,
      maxPending: 20,
      maxConcurrentTurns: 2,
      staleMs: 120000,
      futureSkewMs: 300000,
      dispatchDeadlineMs: 180000,
    },
    limits: {
      nameWindowMax: 3,
      nameDecisionsPerGroupPerHour: 12,
      decisionsPerGroupPerHour: 60,
      decisionsPerDay: 300,
      perSenderAddressedPerHour: 10,
      crisisRoutePerGroupPerDay: 3,
      crisisRoutePerSenderPerHour: 2,
      failureLinePerGroupPerHour: 2,
      floodPerWindow: 10,
      minTextChars: 2,
      sendAccountPerMin: 12,
      sendAccountPerHour: 120,
      sendGroupPerMin: 4,
    },
    budget: {
      dailyUsd: b.dailyUsd,
      interjectUsd: b.interjectUsd,
      searchUsd: b.searchUsd,
      namedUsd: b.namedUsd,
      addressedUsd: b.addressedUsd,
      keyDailyLimitUsd: b.keyDailyLimitUsd ?? null,
      residualMinUsd: 0.25,
      residualPct: 0.15,
      providerFailStreakPause: 3,
      ...Object.fromEntries(BUDGET_WAITS.filter((f) => b[f] !== undefined).map((f) => [f, b[f]])),
    },
    models: {
      primary: {
        id: modelsLock?.primary?.id ?? null,
        selector: cfg.claudeModel.id,
        effort: cfg.claudeModel.effort,
        maxTokens: cfg.claudeModel.maxTokens,
        contextTokens: cfg.claudeModel.contextTokens,
        cacheRetention: cfg.claudeModel.cacheRetention ?? 'short',
        price: modelsLock?.primary?.price ?? null,
      },
      decision: {
        id: modelsLock?.decision?.id ?? (cfg.decisionModel.id),
        effort: cfg.decisionModel.effort,
        maxTokens: cfg.decisionModel.maxTokens,
        price: modelsLock?.decision?.price ?? null,
      },
    },
    openrouter: { baseUrl: cfg.openrouter?.baseUrl ?? OPENROUTER_BASE_URL },
    timeouts: { decisionMs: cfg.timeouts.decisionMs, turnSeconds: cfg.timeouts.turnSeconds },
    retention: {
      eventDays: rt.eventDays,
      sendDays: rt.sendDays,
      reservationDays: rt.reservationDays,
      contextMaxItems: rt.contextMaxItems,
      contextMaxAgeHours: rt.contextMaxAgeHours,
      contextMaxTokens: rt.contextMaxTokens,
      decisionLines: 15,
      decisionLineChars: 200,
      decisionCurrentChars: 800,
    },
    contentPolicy: {
      enabled: cp.enabled,
      version: cp.version,
      sha256: cp.sha256 || POLICY_V1_SHA256,
      policyFile: atRepo(paths.repoRoot, cp.file),
      rulesFile: atRepo(paths.repoRoot, cp.outputFilter.rulesFile),
      crisisFile: atRepo(paths.repoRoot, cp.crisis.routeTermsFile),
      linesFile: join(paths.repoRoot, 'persona', 'policy-lines.zh.json'),
    },
    privacy: { replaceSystemPrompt: cfg.privacy.replaceSystemPrompt },
    paths: {
      db: paths.db,
      eventLog: paths.eventLog,
      systemPromptFile: paths.systemPromptFile,
      decisionPromptFile: join(paths.repoRoot, 'persona', 'decision-prompt.zh.md'),
    },
  };
}

function isEffectiveShape(e) {
  return isObj(e) && e.version === 1 && (e.mode === 'dry-run' || e.mode === 'live')
    && isObj(e.qq) && isObj(e.qq.groups) && isObj(e.budget) && isObj(e.limits) && isObj(e.window) && isObj(e.paths);
}

export function createEffectiveReader(path) {
  let cachedSig = null;
  let cached = null;
  return () => {
    try {
      const st = statSync(path);
      const sig = `${st.mtimeMs}:${st.size}`;
      if (sig === cachedSig) return cached;
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      cachedSig = sig;
      cached = isEffectiveShape(parsed) ? parsed : null;
      return cached;
    } catch {
      cachedSig = null;
      cached = null;
      return null;
    }
  };
}

const hasText = (v) => typeof v === 'string' && v.trim().length > 0;

// The part of the live preconditions that lives in config.json, so a hand edit can break it while live.
export function liveConfigProblems(cfg) {
  const failed = [];
  const qq = cfg?.qq ?? {};
  const allowed = Array.isArray(qq.allowedGroupIds) ? qq.allowedGroupIds : [];
  const groups = isObj(qq.groups) ? qq.groups : {};
  if (!(isPos(cfg?.budget?.dailyUsd) && tiersValid(cfg.budget))) failed.push('budget');
  if (cfg?.contentPolicy?.enabled !== true) failed.push('policy');
  if (!(allowed.length > 0 && allowed.every((id) => ownersOf(qq, id).length > 0))) failed.push('targets');
  if (!(hasText(qq.appId) && cfg?.acks?.identityConfirmedAppId === qq.appId)) failed.push('identity');
  if (!(allowed.length > 0 && allowed.every((id) => groups[id]?.noticeGiven === true))) failed.push('notice');
  if (cfg?.acks?.q0Recorded !== true) failed.push('q0');
  if (!hasText(cfg?.acks?.d3)) failed.push('d3');
  return failed;
}

// facts: { now, key: readKey() result | null, reconciled, heartbeatAt, lastReadyAt, gatewayKeyMatches, policyOk, doctorOk, paidPaused, modelsLocked, requiredHoldMicros, env }
// requiredHoldMicros: the hold of one required reply, in micro-USD. Absent or null when it cannot be priced yet.
export function livePreconditions(cfg, facts = {}) {
  const failed = [];
  const check = (code, ok) => { if (!ok) failed.push(code); };
  const qq = cfg?.qq ?? {};
  const allowed = Array.isArray(qq.allowedGroupIds) ? qq.allowedGroupIds : [];
  const inConfig = liveConfigProblems(cfg);
  const now = facts.now ?? Date.now();
  const testMode = Boolean(facts.env?.CLO_TEST_ROOT);
  const key = facts.key;
  const budget = cfg?.budget;
  const hold = facts.requiredHoldMicros;
  const keyDaily = isObj(key) && isNum(key.limitMicros) && key.limitReset === 'daily';

  check('budget', !inConfig.includes('budget'));
  // Below one hold, the ledger refuses every reply, and that only shows once someone asks.
  check('daily_hold', hold === undefined || hold === null || (isNum(hold) && isNum(budget?.dailyUsd) && usdToMicros(budget.dailyUsd) >= hold));
  check('targets', !inConfig.includes('targets'));
  check('dm_closed', Array.isArray(qq.allowedDmUserIds) && qq.allowedDmUserIds.length === 0);
  check('key_readable', keyDaily);
  // Only a readable daily limit can be compared. A limit below the local budget is fine, as long as it is the one declared.
  check('key_limit', !keyDaily || budget?.keyDailyLimitUsd === undefined || usdToMicros(budget.keyDailyLimitUsd) === key.limitMicros);
  check('reconciled', facts.reconciled === true);
  check('heartbeat', isNum(facts.heartbeatAt) && now - facts.heartbeatAt <= HEARTBEAT_FRESH_MS && isNum(facts.lastReadyAt));
  check('gateway_key', facts.gatewayKeyMatches === true);
  check('identity', !inConfig.includes('identity'));
  check('notice', !inConfig.includes('notice'));
  check('q0', !inConfig.includes('q0'));
  check('d3', !inConfig.includes('d3'));
  check('policy', !inConfig.includes('policy') && facts.policyOk === true);
  check('numbers', noLocalNumbers(cfg?.contentPolicy?.crisis?.localNumbers));
  check('doctor', facts.doctorOk === true);
  const urls = [qq.apiBaseUrl, qq.tokenBaseUrl, cfg?.openrouter?.baseUrl].filter((u) => u !== undefined && u !== '');
  check('base_urls', urls.length === 0 || testMode);
  check('no_paid_pause', !facts.paidPaused);
  // Holds refuse an unlocked price anyway, so this only gives a clearer refusal at the console.
  check('models', facts.modelsLocked !== false);
  return { ok: failed.length === 0, failed };
}
