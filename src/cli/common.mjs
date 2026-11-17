// Shared console helpers: context, config and lock files, and `apply`.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { activeKindOf, buildEffective, ConfigError, createEffectiveReader, liveConfigProblems, loadBusinessConfig, lockFitProblems, providerOfConfig, providerOfEffective, resolvePaths, runtimeOf, validateBusinessConfig } from '../clo-plugin/lib/core/config.js';
import { ACTIVE_PROVIDER_CONTROL, providerRecord } from '../clo-plugin/lib/core/providers/registry.js';
import { createLedger } from '../clo-plugin/lib/core/ledger.js';
import { createLog } from '../clo-plugin/lib/core/log.js';
import { ensurePrivateDirs, tryNarrowMode } from '../clo-plugin/lib/core/private-fs.js';
import { renderOpenclaw, renderWorkspace, writeAtomic } from '../clo-plugin/lib/core/render.js';
import { backupFileOf, openStore } from '../clo-plugin/lib/core/store.js';
import { IS_WINDOWS } from './platform.mjs';

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

// Node turns its env proxy on at startup, from NODE_USE_ENV_PROXY or --use-env-proxy, and keeps the proxy URL it read
// then: deleting either variable from process.env later does not undo it (checked on the private Node 24.22.2 with a
// loopback listener). So a console started that way cannot be cleaned up from inside and refuses to make requests.
// Node 24.22.2 acts only on the value '1'; any other non-empty value except '0' counts too, in case a later Node widens it.
// The flag is matched loosely, because Node 24.22.2 turns the proxy on for '"--use-env-proxy"' (quoted in NODE_OPTIONS),
// '--use-env-proxy=true', '--use-env-proxy=false' and '--use_env_proxy' alike (checked with a loopback fake proxy).
// Any entry that mentions use-env-proxy counts, except a lone '--no-use-env-proxy'; that refuses a few spellings Node
// would leave off (a later '--no-use-env-proxy' that cancels an earlier one), which is the safe side.
const ENV_PROXY_FLAG = /use[-_]env[-_]proxy/i;
const ENV_PROXY_OFF = /^--no[-_]use[-_]env[-_]proxy$/i;
const mentionsEnvProxy = (tokens) => tokens.map((t) => t.replace(/^["']+|["']+$/g, '')).some((t) => ENV_PROXY_FLAG.test(t) && !ENV_PROXY_OFF.test(t));
export function envProxyAtLaunch(env, execArgv = []) {
  const flag = env.NODE_USE_ENV_PROXY;
  if (typeof flag === 'string' && flag !== '' && flag !== '0') return 'NODE_USE_ENV_PROXY';
  if (mentionsEnvProxy(execArgv.map(String))) return '--use-env-proxy';
  if (mentionsEnvProxy(String(env.NODE_OPTIONS ?? '').split(/\s+/))) return 'NODE_OPTIONS 里的 --use-env-proxy';
  return null;
}

// Read once, when the console loads: what Node saw at startup, not what the environment says later.
const LAUNCH_ENV_PROXY = envProxyAtLaunch(process.env, process.execArgv);

export function envProxyMessage(reason) {
  return `这个控制台进程启动时带了 ${reason}，Node 会让它的网络请求走代理，启动后改不掉。拒绝联网。用 scripts/clo.sh 运行，或者先去掉 NODE_USE_ENV_PROXY 和 NODE_OPTIONS 里的 --use-env-proxy 再运行。`;
}

export function assertNoEnvProxy(ctx) {
  if (ctx.envProxy) throw new CliError(envProxyMessage(ctx.envProxy));
}

// envProxy: off Windows, why Node's env proxy is on in this process, or null. Windows keeps its earlier behaviour.
// The launch state only applies to a context that reads this process's own environment, as the real console does: a
// caller that injects env (the tests) is not this process's launch, and gets null unless it passes envProxy itself.
export function makeContext({ env = process.env, fetch = globalThis.fetch, stdout = process.stdout, stderr = process.stderr, now = Date.now, envProxy = IS_WINDOWS || env !== process.env ? null : LAUNCH_ENV_PROXY } = {}) {
  const paths = resolvePaths(env);
  const out = (line = '') => stdout.write(`${line}\n`);
  const err = (line = '') => stderr.write(`${line}\n`);
  const guarded = guardedFetch(env, fetch);
  const send = envProxy ? () => Promise.reject(new CliError(envProxyMessage(envProxy))) : guarded;
  return { env, paths, out, err, now, envProxy, fetch: send, log: createLog(paths.eventLog) };
}

export function readConfig(ctx) {
  if (!existsSync(ctx.paths.configJson)) {
    const copy = IS_WINDOWS ? 'Copy-Item config.example.json config.json' : 'cp -n config.example.json config.json';
    throw new CliError(`没有 config.json。先复制模板：${copy}，再填写 qq.appId。`);
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

// OpenRouter's lock is models.lock, as before. Every other kind has its own under models.locks, so a lock of one kind
// never stands for another.
export function readModelsLock(paths, kind = 'openrouter') {
  const models = readVersionsLock(paths)?.models;
  if (kind === 'openrouter') return models?.lock ?? null;
  if (kind !== 'anthropic') return null;
  return models?.locks?.[kind] ?? null;
}

// The hand-entered price book of a kind whose API returns no price: models.priceBooks.<kind>, or null.
export function readPriceBook(paths, kind) {
  if (kind !== 'anthropic') return null;
  return readVersionsLock(paths)?.models?.priceBooks?.[kind] ?? null;
}

// Records what `clo model` resolved. Other fields of the file stay as they are. An OpenRouter write leaves
// models.locks and models.priceBooks alone; an Anthropic write touches only models.locks.anthropic and the history.
export function writeModelsLock(ctx, lock, { qqPlatformNotified = false, changed = false, kind = 'openrouter' } = {}) {
  const file = readVersionsLock(ctx.paths) ?? {};
  const history = file.models?.changes ?? [];
  if (kind !== 'openrouter') {
    if (kind !== 'anthropic') throw new CliError(`没有这种接口：${kind}`);
    if (changed) history.push({ at: new Date(ctx.now()).toISOString(), kind, primary: lock.primary.id, decision: lock.decision.id, qqPlatformNotified });
    file.models = { ...file.models, locks: { ...file.models?.locks, [kind]: lock }, changes: history };
    writeAtomic(ctx.paths.versionsLock, `${JSON.stringify(file, null, 2)}
`);
    return;
  }
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

// The providers entry of a kind, active or not: validation allows at most one per kind. entryName picks one by name.
function entryOf(cfg, kind, entryName) {
  const providers = cfg?.providers;
  if (providers === null || typeof providers !== 'object') return null;
  if (entryName !== undefined) return Object.hasOwn(providers, entryName) && providers[entryName]?.kind === kind ? providers[entryName] : null;
  return Object.values(providers).find((e) => e?.kind === kind) ?? null;
}

// A lock only counts for the models the config names now. OpenRouter's names come from claudeModel and decisionModel;
// Anthropic's from the models of the Anthropic entry, with the id as the selector, whether or not that entry is the
// active one: a lock is made before `clo provider use` switches to it. kind is the kind the lock was read for.
export function lockMatches(cfg, lock, kind = 'openrouter', { entryName } = {}) {
  if (!(lock?.primary?.id && lock?.decision?.id)) return false;
  if (kind === 'openrouter') return lock.primary.selector === cfg.claudeModel.id && lock.decision.id === cfg.decisionModel.id;
  if (kind !== 'anthropic') return false;
  const entry = entryOf(cfg, kind, entryName);
  if (!entry) return false;
  return lock.primary.id === entry.models?.primary && lock.primary.selector === lock.primary.id && lock.decision.id === entry.models?.decision;
}

export function usableLock(cfg, lock, kind = 'openrouter', opts) {
  return lockMatches(cfg, lock, kind, opts) ? lock : null;
}

// A lock whose long-prompt rates begin below what one call may send cannot be held right (lockFitProblems).
function assertLockFits(cfg, lock) {
  const fit = lockFitProblems(cfg, lock);
  if (fit.length) {
    throw new CliError(`锁定的价格在提示超过 ${fit.map((p) => p.aboveTokens).join('、')} token 时按长提示价计费，预留算不准。把 claudeModel 的 contextTokens 调到不超过这个值，或换一个模型。`);
  }
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
// The model lock the config runs on is the active kind's.
export function renderAll(ctx, cfg, env = ctx.env) {
  const kind = activeKindOf(cfg);
  return renderWith(ctx, cfg, usableLock(cfg, readModelsLock(ctx.paths, kind), kind), env);
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

// The provider the install runs on, as providerRecord gives it: the control `clo provider use` writes; without one (no
// switch was ever made through it) the provider the effective file names; without that file, the implicit OpenRouter.
// Reading never creates clo.db.
export function runningProviderRecord(ctx) {
  if (existsSync(ctx.paths.db)) {
    const recorded = withStore(ctx, (store) => store.getControl(ACTIVE_PROVIDER_CONTROL));
    if (recorded !== null) return recorded;
  }
  const eff = readEffective(ctx);
  return providerRecord((eff && providerOfEffective(eff)) || providerOfConfig({}));
}

// Decision D8: a change of provider is a model change under protocol §4.2 and a change of who receives the text, so it
// goes through `clo provider use` alone, which asks for the attestation, clears each group's noticeGiven and acks.d3,
// and resets what the old kind left. activeProvider and acks.provider both sit in config.json, so a hand edit of the
// two would otherwise pass validation, in dry-run and in live alike. providerSwitch is set only by that command, before
// it records the new provider.
function assertProviderUnchanged(ctx, cfg) {
  const next = providerRecord(providerOfConfig(cfg));
  const running = runningProviderRecord(ctx);
  if (next === running) return;
  const [kind, name] = running.split(':');
  throw new CliError(`config.json 里在用的模型接口（${next}）不是现在运行的这个（${running}）。换接口只能用 clo provider use：它会要求 --qq-platform-notified（启用 QQ 时），并清除每个群的“已告知”和 D3 记录。先把 config.json 的 activeProvider 和 acks.provider 改回 ${name}（${kind}），再 clo provider use <名称> --confirm。`);
}

// Everything that can refuse this config, with nothing written and the render as the result. A command runs it before
// it writes config.json, so a refusal cannot leave a config that the running effective file does not match.
// Only `clo mode live` may turn a dry-run install live. Hand-editing config.json cannot do it.
// lock is a model lock a change is about to record, of kind lockKind; the active kind's lock is what the config runs
// on. A lock passed for a kind that is not active must still match its own models, and the render uses the active one.
export function assertApplicable(ctx, cfg, { allowLive = false, lock, lockKind = 'openrouter', providerSwitch = false } = {}) {
  assertValid(ctx, cfg);
  if (!providerSwitch) assertProviderUnchanged(ctx, cfg);
  const kind = activeKindOf(cfg);
  if (lock !== undefined && lockKind !== kind && lock && !lockMatches(cfg, lock, lockKind)) {
    throw new CliError('config.json 里的模型与要锁定的模型不一致。');
  }
  if (lock) assertLockFits(cfg, lock);
  const active = lock !== undefined && lockKind === kind ? lock : readModelsLock(ctx.paths, kind);
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
  if (cfg.mode === 'live' && !active) {
    throw new CliError(kind === 'openrouter'
      ? 'live 下没有锁定的模型，不能生成运行配置。先 clo mode dry-run，再 clo model refresh。'
      : 'live 下没有锁定当前接口的模型价格，不能生成运行配置。先 clo mode dry-run，再锁定这个接口的模型价格。');
  }
  if (active && !lockMatches(cfg, active, kind)) {
    throw new CliError(kind === 'openrouter'
      ? 'config.json 里的模型与锁定的模型不一致。先运行 clo model refresh（启用 QQ 时要加 --qq-platform-notified），不会悄悄换模型。'
      : 'config.json 里当前接口的模型与锁定的不一致。先重新锁定这个接口的模型价格（启用 QQ 时要加 --qq-platform-notified），不会悄悄换模型。');
  }
  if (active) assertLockFits(cfg, active);
  return renderWith(ctx, cfg, usableLock(cfg, active, kind), ctx.env);
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

// Off Windows only. Files that hold a secret or the ledger's raw IDs: doctor fails while group or others can reach
// them. .env is the user's; the rest are the project's, and apply narrows them.
export function secretFiles(paths) {
  return [paths.envFile, join(paths.cloDir, 'gateway.token'), paths.db, `${paths.db}-wal`, `${paths.db}-shm`, `${paths.db}-journal`, backupFileOf(paths.db)];
}

// Off Windows only. Files and folders that may hold an ID, a hash salt or log lines: doctor warns. config.json is
// the user's; everything under the runtime folder is the project's, and apply narrows it.
export function privateFiles(paths) {
  return [paths.configJson, paths.runtime, paths.cloDir, paths.logsDir, paths.stateDir, paths.effectiveJson, paths.eventLog, paths.gatewayLog, `${paths.gatewayLog}.1`, join(paths.runtime, 'q0-salt'), join(paths.runtime, 'q0b-dm-target')];
}

export function apply(ctx, cfg, { allowLive = false } = {}) {
  const { effective, openclaw, workspace } = assertApplicable(ctx, cfg, { allowLive });
  const { paths } = ctx;
  // doctor runs before start and needs TEMP to exist: the host's plugin inspect makes a temp folder there.
  const dirs = [paths.stateDir, paths.home, paths.workspace, paths.cloDir, paths.logsDir, paths.gatewayCwd, dirname(paths.pidFile), join(paths.runtime, 'temp')];
  if (IS_WINDOWS) {
    for (const d of dirs) {
      mkdirSync(d, { recursive: true });
    }
  } else {
    ensurePrivateDirs(paths.runtime, dirs);
    // What an earlier build left 0644 under the runtime folder. .env and config.json are the user's and left alone.
    for (const f of [...secretFiles(paths), ...privateFiles(paths)]) {
      if (f !== paths.envFile && f !== paths.configJson) tryNarrowMode(f);
    }
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
