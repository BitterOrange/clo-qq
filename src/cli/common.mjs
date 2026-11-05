// Shared console helpers: context, config and lock files, and `apply`.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildEffective, ConfigError, createEffectiveReader, liveConfigProblems, loadBusinessConfig, resolvePaths, validateBusinessConfig } from '../clo-plugin/lib/core/config.js';
import { createLog } from '../clo-plugin/lib/core/log.js';
import { renderOpenclaw, renderWorkspace, writeAtomic } from '../clo-plugin/lib/core/render.js';
import { openStore } from '../clo-plugin/lib/core/store.js';

export class CliError extends Error {
  constructor(message, { code = 1 } = {}) {
    super(message);
    this.exitCode = code;
  }
}

export const isTestMode = (env) => Boolean(env.CLO_TEST_ROOT);

const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);
export function isLoopback(url) {
  try {
    return LOOPBACK.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

// Test mode can never reach a real endpoint, whatever a config says.
export function guardedFetch(env, realFetch) {
  if (!isTestMode(env)) return realFetch;
  return (url, init) => {
    if (!isLoopback(String(url))) throw new CliError('test mode refuses a non-loopback request');
    return realFetch(url, init);
  };
}

export function makeContext({ env = process.env, fetch = globalThis.fetch, stdout = process.stdout, stderr = process.stderr, now = Date.now } = {}) {
  const paths = resolvePaths(env);
  const out = (line = '') => stdout.write(`${line}\n`);
  const err = (line = '') => stderr.write(`${line}\n`);
  return { env, paths, out, err, now, fetch: guardedFetch(env, fetch), log: createLog(paths.eventLog) };
}

export function readConfig(ctx) {
  if (!existsSync(ctx.paths.configJson)) {
    throw new CliError('没有 config.json。先复制模板：Copy-Item config.example.json config.json，再填写 qq.appId。');
  }
  return loadBusinessConfig(ctx.paths.configJson);
}

export function assertValid(ctx, cfg, env = ctx.env) {
  const v = validateBusinessConfig(cfg, { env });
  if (!v.ok) {
    throw new CliError(`配置无效：\n${v.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`);
  }
  return v;
}

export function writeConfig(ctx, cfg) {
  assertValid(ctx, cfg);
  writeAtomic(ctx.paths.configJson, `${JSON.stringify(cfg, null, 2)}\n`);
}

export function readVersionsLock(paths) {
  if (!existsSync(paths.versionsLock)) return null;
  return JSON.parse(readFileSync(paths.versionsLock, 'utf8').replace(/^\uFEFF/, ''));
}

export function readModelsLock(paths) {
  return readVersionsLock(paths)?.models?.lock ?? null;
}

// Records what `clo model` resolved. Other fields of the file stay as they are.
export function writeModelsLock(ctx, lock, { qqPlatformNotified = false, changed = false } = {}) {
  const file = readVersionsLock(ctx.paths) ?? {};
  const history = file.models?.changes ?? [];
  if (changed) history.push({ at: new Date(ctx.now()).toISOString(), primary: lock.primary.id, decision: lock.decision.id, qqPlatformNotified });
  file.models = {
    ...file.models,
    primarySelector: lock.primary.selector,
    primaryResolved: lock.primary.id,
    decision: lock.decision.id,
    lock,
    changes: history,
  };
  writeAtomic(ctx.paths.versionsLock, `${JSON.stringify(file, null, 2)}\n`);
}

// A lock only counts for the models the config names now.
export function lockMatches(cfg, lock) {
  return Boolean(lock?.primary?.id && lock?.decision?.id)
    && lock.primary.selector === cfg.claudeModel.id
    && lock.decision.id === cfg.decisionModel.id;
}

export function usableLock(cfg, lock) {
  return lockMatches(cfg, lock) ? lock : null;
}

// The whole output of a render, with nothing written.
export function renderAll(ctx, cfg, env = ctx.env) {
  const lock = usableLock(cfg, readModelsLock(ctx.paths));
  const effective = buildEffective(cfg, { paths: ctx.paths, modelsLock: lock, env, now: ctx.now });
  const openclaw = renderOpenclaw(cfg, effective, ctx.paths, { testMode: isTestMode(env) });
  const workspace = renderWorkspace(ctx.paths.repoRoot, effective);
  return { effective, openclaw, workspace };
}

function writeIfChanged(path, text) {
  try {
    if (readFileSync(path, 'utf8') === text) return false;
  } catch {
    // Missing: write it.
  }
  writeAtomic(path, text);
  return true;
}

export function readEffective(ctx) {
  return createEffectiveReader(ctx.paths.effectiveJson)();
}

// Only `clo mode live` may turn a dry-run install live. Hand-editing config.json cannot do it.
export function apply(ctx, cfg, { allowLive = false } = {}) {
  assertValid(ctx, cfg);
  if (cfg.mode === 'live' && !allowLive && readEffective(ctx)?.mode !== 'live') {
    throw new CliError('config.json 写着 live，但当前不是 live。live 只能由 clo mode live 开启，它会先检查所有前置条件。');
  }
  if (cfg.mode === 'live' && !allowLive) {
    // A group added by hand while live would be read before anyone there has been told.
    const problems = liveConfigProblems(cfg);
    if (problems.length) {
      throw new CliError(`live 下这份 config.json 不满足前置条件（${problems.join('、')}）。先 clo mode dry-run，改好后再 clo mode live，它会重新检查。`);
    }
  }
  const lock = readModelsLock(ctx.paths);
  if (lock && !lockMatches(cfg, lock)) {
    throw new CliError('config.json 里的模型与锁定的模型不一致。先运行 clo model refresh（启用 QQ 时要加 --qq-platform-notified），不会悄悄换模型。');
  }
  const { effective, openclaw, workspace } = renderAll(ctx, cfg);
  const { paths } = ctx;
  // doctor runs before start and needs TEMP to exist: the host's plugin inspect makes a temp folder there.
  for (const d of [paths.stateDir, paths.home, paths.workspace, paths.cloDir, paths.logsDir, paths.gatewayCwd, dirname(paths.pidFile), join(paths.runtime, 'temp')]) {
    mkdirSync(d, { recursive: true });
  }
  for (const [name, text] of Object.entries(workspace.files)) writeIfChanged(join(paths.workspace, name), text);
  writeIfChanged(paths.systemPromptFile, workspace.systemPrompt);
  writeAtomic(paths.effectiveJson, `${JSON.stringify(effective, null, 2)}\n`);
  // Last, and only on a real change: the Gateway watches this file and reloads on a write.
  const changed = writeIfChanged(paths.openclawJson, `${JSON.stringify(openclaw, null, 2)}\n`);
  ctx.log('cli_apply', { state: effective.mode, count: changed ? 1 : 0 });
  return { effective, openclaw, workspace, openclawChanged: changed };
}

export function withStore(ctx, fn) {
  const store = openStore(ctx.paths.db, { now: ctx.now });
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

export async function withStoreAsync(ctx, fn) {
  const store = openStore(ctx.paths.db, { now: ctx.now });
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

// Enough to recognise an ID, not enough to use it.
export function maskId(id) {
  if (typeof id !== 'string' || !id) return '(空)';
  if (id.length < 10) return '***';
  return `${id.slice(0, 4)}…${id.slice(-2)}`;
}

export function groupByLabel(cfg, label) {
  const groups = cfg.qq?.groups ?? {};
  for (const [id, g] of Object.entries(groups)) {
    if (g?.label === label) return { id, group: g };
  }
  throw new CliError(`没有叫“${label}”的群。用 clo group list 查看。`);
}

export function usd(micros) {
  return `$${(micros / 1e6).toFixed(4)}`;
}

export { ConfigError };
