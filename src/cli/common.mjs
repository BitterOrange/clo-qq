// Shared console helpers: context, config and lock files, and `apply`.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildEffective, ConfigError, createEffectiveReader, liveConfigProblems, loadBusinessConfig, resolvePaths, runtimeOf, validateBusinessConfig } from '../clo-plugin/lib/core/config.js';
import { createLedger } from '../clo-plugin/lib/core/ledger.js';
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

// Under the own runtime there is no host config: openclaw is null, and of the workspace only the system prompt is used.
function renderWith(ctx, cfg, lock, env) {
  const effective = buildEffective(cfg, { paths: ctx.paths, modelsLock: lock, env, now: ctx.now });
  const openclaw = runtimeOf(effective) === 'openclaw' ? renderOpenclaw(cfg, effective, ctx.paths, { testMode: isTestMode(env) }) : null;
  const workspace = renderWorkspace(ctx.paths.repoRoot, effective);
  return { effective, openclaw, workspace };
}

// The hold of one required reply, in micros, exactly as the ledger of the runtime this effective config names computes
// it. Null when it cannot be priced yet. holdMicros reads only the effective config, so no database is opened for it.
export function requiredHoldMicros(effective) {
  try {
    const ledger = createLedger({ store: { q: null }, getEffective: () => effective, fetch: null, getKey: () => null, setTimer: () => null, clearTimer: () => {}, runtime: runtimeOf(effective) });
    return ledger.holdMicros('reply_required');
  } catch {
    return null;
  }
}

// The whole output of a render, with nothing written.
export function renderAll(ctx, cfg, env = ctx.env) {
  return renderWith(ctx, cfg, usableLock(cfg, readModelsLock(ctx.paths)), env);
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

// Everything that can refuse this config, with nothing written and the render as the result. A command runs it before
// it writes config.json, so a refusal cannot leave a config that the running effective file does not match.
// Only `clo mode live` may turn a dry-run install live. Hand-editing config.json cannot do it.
// lock is the model lock the config will run on: a model change passes the one it is about to record.
export function assertApplicable(ctx, cfg, { allowLive = false, lock = readModelsLock(ctx.paths) } = {}) {
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
  if (cfg.mode === 'live' && !lock) {
    throw new CliError('live 下没有锁定的模型，不能生成运行配置。先 clo mode dry-run，再 clo model refresh。');
  }
  if (lock && !lockMatches(cfg, lock)) {
    throw new CliError('config.json 里的模型与锁定的模型不一致。先运行 clo model refresh（启用 QQ 时要加 --qq-platform-notified），不会悄悄换模型。');
  }
  return renderWith(ctx, cfg, usableLock(cfg, lock), ctx.env);
}

// Stops replies and spending on its own, before config.json is even read: the Gateway reads this file for each event.
// Returns true when it changed the mode. A file that is missing or unreadable is not live to any reader, so it stays.
export function forceEffectiveDryRun(ctx) {
  let effective;
  try {
    effective = JSON.parse(readFileSync(ctx.paths.effectiveJson, 'utf8'));
  } catch {
    return false;
  }
  if (effective?.mode !== 'live') return false;
  try {
    writeAtomic(ctx.paths.effectiveJson, `${JSON.stringify({ ...effective, mode: 'dry-run' }, null, 2)}\n`);
  } catch (e) {
    throw new CliError(`没能切到 dry-run，生效配置还是 live，可洛还会回复：写不了 effective.json（${e.code ?? '未知错误'}）。可以用 clo pause --all 先暂停，或 clo stop 停止。`);
  }
  return true;
}

export function apply(ctx, cfg, { allowLive = false } = {}) {
  const { effective, openclaw, workspace } = assertApplicable(ctx, cfg, { allowLive });
  const { paths } = ctx;
  // doctor runs before start and needs TEMP to exist: the host's plugin inspect makes a temp folder there.
  for (const d of [paths.stateDir, paths.home, paths.workspace, paths.cloDir, paths.logsDir, paths.gatewayCwd, dirname(paths.pidFile), join(paths.runtime, 'temp')]) {
    mkdirSync(d, { recursive: true });
  }
  // The own runtime reads only the system prompt and effective.json. The host's workspace files and openclaw.json are
  // left as they are: a switch back to openclaw renders them again, and nothing that runs reads them meanwhile.
  if (openclaw) {
    for (const [name, text] of Object.entries(workspace.files)) writeIfChanged(join(paths.workspace, name), text);
  }
  writeIfChanged(paths.systemPromptFile, workspace.systemPrompt);
  writeAtomic(paths.effectiveJson, `${JSON.stringify(effective, null, 2)}\n`);
  // Last, and only on a real change: the Gateway watches this file and reloads on a write.
  const changed = openclaw ? writeIfChanged(paths.openclawJson, `${JSON.stringify(openclaw, null, 2)}\n`) : false;
  ctx.log('cli_apply', { state: effective.mode, count: changed ? 1 : 0, kind: runtimeOf(effective) });
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
