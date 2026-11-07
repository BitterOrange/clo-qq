// Paths, business config validation, the effective reader and live preconditions.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POLICY_CATEGORIES, POLICY_V1_SHA256 } from './contentPolicy.js';
import { DECISION_INPUT_TOKENS, usdToMicros } from './ledger.js';
import {
  ANTHROPIC_EFFORTS, hardCapAckProblems, KEY_ENV, MODEL_ID_RULES, PROVIDER_ENTRY_FIELDS, PROVIDER_KINDS, PROVIDER_NAME_RE,
  providerOfConfig, providerOfEffective, providerRulesRecorded,
} from './providers/registry.js';

export { providerOfConfig, providerOfEffective };

export class ConfigError extends Error {}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const HEARTBEAT_FRESH_MS = 90000;
const SECRET_KEY = /^(client_?secret|app_?secret|api_?key|secret|token|password)$/i;
const DEFAULT_MAX_PART_CHARS = 1500;
// Optional. Left out, the ledger's own defaults apply.
const BUDGET_WAITS = ['decisionRetryMs', 'creditsRetryMs', 'unsettledClearMs', 'unsettledClearReads'];

// Which process answers QQ: the OpenClaw Gateway, or the project's own runtime (src/bot/main.mjs).
export const RUNTIMES = Object.freeze(['openclaw', 'own']);
export const DEFAULT_RUNTIME = 'openclaw';
// Every reader goes through this, so a config or effective file written before the switch means openclaw.
export const runtimeOf = (cfgOrEffective) => cfgOrEffective?.runtime ?? DEFAULT_RUNTIME;

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
  if (cfg.runtime !== undefined && !RUNTIMES.includes(cfg.runtime)) err('runtime', 'must be openclaw or own');
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

  validateProviders(cfg, err, testMode);

  return { ok: errors.length === 0, errors, warnings };
}

// Fields that would make one provider stand in for another. Nothing here fails over, so they are refused by name.
const FAILOVER_FIELDS = ['fallbacks', 'priority', 'failover', 'order', 'backup'];

// The optional providers block. Without it nothing new is checked and every generated file is as before. The provider
// is never guessed: activeProvider names the entry, and acks.provider records that the console made that choice.
function validateProviders(cfg, err, testMode) {
  // The effective file's field. In config.json it would let the live checks look at one kind while the bot runs another.
  if (cfg.apiProvider !== undefined) err('apiProvider', 'belongs to the generated effective file only; use providers and activeProvider');
  for (const f of FAILOVER_FIELDS) {
    if (cfg[f] !== undefined) err(f, 'there is no failover between providers or models');
  }
  if (cfg.providers === undefined) {
    if (cfg.activeProvider !== undefined) err('activeProvider', 'needs a providers block');
    return;
  }
  const providers = cfg.providers;
  if (!isObj(providers) || Object.keys(providers).length === 0) {
    err('providers', 'must be a non-empty object');
    return;
  }
  const own = runtimeOf(cfg) === 'own';
  const kinds = new Set();
  for (const [name, e] of Object.entries(providers)) {
    const at = `providers.${name}`;
    if (!PROVIDER_NAME_RE.test(name)) err(at, 'names are lower case letters, digits and -, starting with a letter, at most 32');
    if (!isObj(e)) {
      err(at, 'must be an object');
      continue;
    }
    for (const f of Object.keys(e)) {
      if (FAILOVER_FIELDS.includes(f)) err(`${at}.${f}`, 'there is no failover between providers or models');
      else if (!PROVIDER_ENTRY_FIELDS.includes(f)) err(`${at}.${f}`, `unknown field; allowed: ${PROVIDER_ENTRY_FIELDS.join(', ')}`);
    }
    if (!PROVIDER_KINDS.includes(e.kind)) {
      err(`${at}.kind`, `must be one of ${PROVIDER_KINDS.join(', ')}`);
      continue;
    }
    // One fixed Key name per kind in this build, so at most one entry of each kind. The field holds a name only.
    if (kinds.has(e.kind)) err(at, `only one entry of kind ${e.kind}`);
    kinds.add(e.kind);
    if (e.keyEnv !== KEY_ENV[e.kind]) err(`${at}.keyEnv`, `must be ${KEY_ENV[e.kind]} for kind ${e.kind}`);
    if (e.baseUrl !== undefined) {
      if (!(testMode && isLoopbackUrl(e.baseUrl))) err(`${at}.baseUrl`, 'allowed only in test mode, on loopback');
      // The OpenClaw runtime reads only openrouter.baseUrl, so an entry's own address would be ignored there.
      else if (!own) err(`${at}.baseUrl`, 'only with runtime own; the OpenClaw runtime reads openrouter.baseUrl');
      if (e.kind === 'openrouter' && cfg.openrouter?.baseUrl !== undefined) err(`${at}.baseUrl`, 'set either this or openrouter.baseUrl, not both');
    }
    if (e.kind === 'openrouter') {
      // Its ids stay in claudeModel.id and decisionModel.id, checked as before.
      if (e.models !== undefined) err(`${at}.models`, 'an OpenRouter entry takes its models from claudeModel and decisionModel');
    } else if (e.kind === 'anthropic') {
      const m = e.models;
      if (!isObj(m)) {
        err(`${at}.models`, 'needs primary and decision');
      } else {
        for (const f of Object.keys(m)) {
          if (f !== 'primary' && f !== 'decision') err(`${at}.models.${f}`, 'allowed: primary, decision');
        }
        for (const role of ['primary', 'decision']) {
          if (!(typeof m[role] === 'string' && MODEL_ID_RULES.anthropic.test(m[role]))) {
            err(`${at}.models.${role}`, 'must be a concrete Opus, Sonnet or Haiku id such as claude-opus-5-5: no -latest, no date, no other line');
          }
        }
      }
    }
  }
  const active = cfg.activeProvider;
  if (!(typeof active === 'string' && Object.hasOwn(providers, active))) {
    err('activeProvider', 'must name an entry in providers');
    return;
  }
  // Only `clo provider use` writes both, so a switch made by editing one of them is refused here.
  if (cfg.acks?.provider?.name !== active) err('acks.provider', 'must name activeProvider; switch with clo provider use');
  const kind = providers[active]?.kind;
  if (!PROVIDER_KINDS.includes(kind)) return;
  if (!own && kind !== 'openrouter') err('activeProvider', 'the OpenClaw runtime runs on OpenRouter only');
  if (kind === 'anthropic') {
    // Opus 5.5 cannot turn thinking off. The decision runs with thinking disabled, so its small max_tokens holds JSON.
    if (!ANTHROPIC_EFFORTS.primary.includes(cfg.claudeModel?.effort)) err('claudeModel.effort', `on Anthropic: one of ${ANTHROPIC_EFFORTS.primary.join(', ')}`);
    if (!ANTHROPIC_EFFORTS.decision.includes(cfg.decisionModel?.effort)) err('decisionModel.effort', `on Anthropic: ${ANTHROPIC_EFFORTS.decision.join(', ')}`);
  }
}

// The kind config.json runs on, or null when it names none this build can use.
export const activeKindOf = (cfg) => providerOfConfig(cfg)?.kind ?? null;

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
  const models = modelsOf(cfg, modelsLock);
  const fit = lockFitProblems(cfg, models);
  if (fit.length) throw new ConfigError(`invalid config: ${fit.map((p) => p.path).join(', ')}`);
  const effective = {
    version: 1,
    generatedAt: new Date(now()).toISOString(),
    mode: cfg.mode,
    runtime: runtimeOf(cfg),
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
    models,
    openrouter: { baseUrl: openrouterBaseOf(cfg) },
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
  // Only the own runtime with a providers block gets the field, so every other effective file stays as it was.
  const apiProvider = apiProviderOf(cfg);
  if (apiProvider) effective.apiProvider = apiProvider;
  return effective;
}

const ownWithProviders = (cfg) => runtimeOf(cfg) === 'own' && cfg.providers !== undefined;

// The base the OpenRouter Key reads and catalog use. An OpenRouter entry's own base counts only on the own runtime;
// validation refuses it elsewhere, and refuses it together with openrouter.baseUrl.
function openrouterBaseOf(cfg) {
  if (cfg.openrouter?.baseUrl !== undefined) return cfg.openrouter.baseUrl;
  if (ownWithProviders(cfg)) {
    const entry = Object.values(cfg.providers).find((e) => e?.kind === 'openrouter' && typeof e.baseUrl === 'string');
    if (entry) return entry.baseUrl;
  }
  return OPENROUTER_BASE_URL;
}

// {name, kind, baseUrl, hardCap}: what the bot runs on and the attested cap it re-checks at start. Capabilities are
// never written: code looks them up by kind.
function apiProviderOf(cfg) {
  if (!ownWithProviders(cfg)) return null;
  const p = providerOfConfig(cfg);
  if (!p) throw new ConfigError('invalid config: activeProvider');
  const ack = cfg.acks?.hardCap?.[p.name];
  return { name: p.name, kind: p.kind, baseUrl: p.baseUrl, hardCap: isObj(ack) ? structuredClone(ack) : null };
}

// modelsLock is the lock of the active kind. On Anthropic the ids come from the entry, with selector = id, and a price
// only from a lock for exactly those ids: a lock for other ids prices nothing, and holds then refuse.
function modelsOf(cfg, modelsLock) {
  const primary = {
    id: modelsLock?.primary?.id ?? null,
    selector: cfg.claudeModel.id,
    effort: cfg.claudeModel.effort,
    maxTokens: cfg.claudeModel.maxTokens,
    contextTokens: cfg.claudeModel.contextTokens,
    cacheRetention: cfg.claudeModel.cacheRetention ?? 'short',
    price: modelsLock?.primary?.price ?? null,
  };
  const decision = {
    id: modelsLock?.decision?.id ?? (cfg.decisionModel.id),
    effort: cfg.decisionModel.effort,
    maxTokens: cfg.decisionModel.maxTokens,
    price: modelsLock?.decision?.price ?? null,
  };
  if (activeKindOf(cfg) === 'anthropic') {
    const ids = cfg.providers[cfg.activeProvider].models;
    const matches = modelsLock?.primary?.id === ids.primary && modelsLock?.decision?.id === ids.decision;
    Object.assign(primary, { id: ids.primary, selector: ids.primary, price: matches ? modelsLock.primary.price ?? null : null });
    Object.assign(decision, { id: ids.decision, price: matches ? modelsLock.decision.price ?? null : null });
  }
  return { primary, decision };
}

// Holds price a whole prompt on a card's short-prompt rates. A price with a long-prompt card that begins below what one
// call may send would hold less than that call can settle, so such a lock is refused rather than held on the wrong
// card. lock: { primary: { price }, decision: { price } }, as locked or as modelsOf priced them. A price without a long
// card, as every OpenRouter price is, always fits.
export function lockFitProblems(cfg, lock) {
  const out = [];
  const check = (price, tokens, path, what) => {
    const above = price?.long?.aboveTokens;
    if (Number.isInteger(above) && !(Number.isInteger(tokens) && tokens <= above)) {
      out.push({ path, aboveTokens: above, message: `${what} (${tokens}) is above ${above} tokens, where the model's long-prompt rates begin` });
    }
  };
  check(lock?.primary?.price, cfg?.claudeModel?.contextTokens, 'claudeModel.contextTokens', 'the primary input bound');
  check(lock?.decision?.price, DECISION_INPUT_TOKENS, 'decisionModel', 'the decision input bound');
  return out;
}

function isEffectiveShape(e) {
  // A runtime or a provider kind this build does not know reads as no config at all, so nothing runs on a guess.
  return isObj(e) && e.version === 1 && (e.mode === 'dry-run' || e.mode === 'live') && (e.runtime === undefined || RUNTIMES.includes(e.runtime))
    && (e.apiProvider === undefined || (isObj(e.apiProvider) && PROVIDER_KINDS.includes(e.apiProvider.kind)))
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
// On a kind whose Key cannot be read, key_readable, key_limit and reconciled are not checked. These take their place:
//   hard_cap: the attested cap meets decision D2, covers one required hold, and facts.hardCapKeyMatches is true (the
//     attested Key is the one in .env and, while a process is recorded, the one that process holds);
//   key_valid: facts.keyValid is true (checkAnthropicModels passed for both locked ids);
//   provider_rules: facts.providerRulesRecorded is true and the registry says the rules are recorded for the kind.
// The provider comes from config.json itself, never from a fact. A config that names no usable one fails 'provider'.
// rulesRecorded is the registry's, and only a test passes another.
export function livePreconditions(cfg, facts = {}, { rulesRecorded = providerRulesRecorded } = {}) {
  const provider = providerOfConfig(cfg);
  const failed = [];
  const check = (code, ok) => { if (!ok) failed.push(code); };
  check('provider', Boolean(provider));
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
  if (provider?.caps.keyReadable === true) {
    check('key_readable', keyDaily);
    // Only a readable daily limit can be compared. A limit below the local budget is fine, as long as it is the one declared.
    check('key_limit', !keyDaily || budget?.keyDailyLimitUsd === undefined || usdToMicros(budget.keyDailyLimitUsd) === key.limitMicros);
    check('reconciled', facts.reconciled === true);
  } else if (provider) {
    // The provider's own stop rests on the owner's word, bound to one Key. One day can spend up to it.
    const ack = cfg.acks?.hardCap?.[provider.name];
    const covers = hold === undefined || hold === null || (isNum(hold) && isPos(ack?.usd) && usdToMicros(ack.usd) >= hold);
    check('hard_cap', hardCapAckProblems(ack).length === 0 && covers && facts.hardCapKeyMatches === true);
    check('key_valid', facts.keyValid === true);
    check('provider_rules', facts.providerRulesRecorded === true && rulesRecorded(provider.kind) === true);
  }
  check('heartbeat', isNum(facts.heartbeatAt) && now - facts.heartbeatAt <= HEARTBEAT_FRESH_MS && isNum(facts.lastReadyAt));
  check('gateway_key', facts.gatewayKeyMatches === true);
  check('identity', !inConfig.includes('identity'));
  check('notice', !inConfig.includes('notice'));
  check('q0', !inConfig.includes('q0'));
  check('d3', !inConfig.includes('d3'));
  check('policy', !inConfig.includes('policy') && facts.policyOk === true);
  check('numbers', noLocalNumbers(cfg?.contentPolicy?.crisis?.localNumbers));
  check('doctor', facts.doctorOk === true);
  const entryUrls = isObj(cfg?.providers) ? Object.values(cfg.providers).map((e) => (isObj(e) ? e.baseUrl : undefined)) : [];
  const urls = [qq.apiBaseUrl, qq.tokenBaseUrl, cfg?.openrouter?.baseUrl, ...entryUrls].filter((u) => u !== undefined && u !== '');
  check('base_urls', urls.length === 0 || testMode);
  check('no_paid_pause', !facts.paidPaused);
  // Holds refuse an unlocked price anyway, so this only gives a clearer refusal at the console.
  check('models', facts.modelsLocked !== false);
  return { ok: failed.length === 0, failed };
}
