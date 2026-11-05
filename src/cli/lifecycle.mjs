// Starts and stops the project's one Gateway. It only ever signals a PID it recorded itself.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeAtomic } from '../clo-plugin/lib/core/render.js';
import { CliError, isLoopback, isTestMode } from './common.mjs';

// .env name -> the name the Gateway child gets. The host's openrouter provider and the plugin read OPENROUTER_API_KEY,
// so that is the child's name for the key. CLO_CHAT_API_KEY itself never reaches the child.
const CHILD_ENV_NAMES = { CLO_QQ_APP_ID: 'CLO_QQ_APP_ID', CLO_QQ_APP_SECRET: 'CLO_QQ_APP_SECRET', CLO_CHAT_API_KEY: 'OPENROUTER_API_KEY' };
export const ENV_FILE_KEYS = Object.keys(CHILD_ENV_NAMES);
// Old .env names. Never read as a key: finding one only changes what the refusal says.
export const RENAMED_ENV_KEYS = { OPENROUTER_API_KEY: 'CLO_CHAT_API_KEY', CLO_SEARCH_OPENROUTER_KEY: 'CLO_SEARCH_API_KEY' };
const OS_ENV_KEYS = ['SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS'];
const TEST_ENV_KEYS = ['CLO_TEST_ROOT', 'CLO_TEST_CRASH_AT', 'CLO_NET_GUARD_LOG'];
const DEFAULT_PORT = 18790;
const LOG_ROTATE_BYTES = 20 * 1024 * 1024;
const EARLY_EXIT_WATCH_MS = 1500;
const STOP_WAIT_MS = 15000;

const OUTPUT_FILTER = fileURLToPath(new URL('./host-output-filter.mjs', import.meta.url));
const START_LOOKUP_TRIES = 3;
const START_LOCK_TRIES = 5;
const START_LOCK_RETRY_MS = 100;

export const privateNode = (paths) => join(paths.repoRoot, '.runtime', 'node', 'node.exe');
export const openclawEntry = (paths) => join(paths.repoRoot, '.runtime', 'pkg', 'node_modules', 'openclaw', 'openclaw.mjs');
const systemExe = (env, ...rest) => join(env.SystemRoot ?? process.env.SystemRoot ?? 'C:\\Windows', 'System32', ...rest);

// For the OS tools (powershell, taskkill): enough to run, and no key or secret the parent may hold.
export function osToolEnv(parentEnv) {
  const out = {};
  for (const k of [...OS_ENV_KEYS, 'PSModulePath', 'TEMP', 'TMP', 'USERPROFILE']) {
    if (parentEnv[k]) out[k] = parentEnv[k];
  }
  return out;
}

// [name, value] for each line that assigns a value, in file order. A missing file has none.
function filledEnvLines(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const lines = [];
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    const value = m[2].replace(/^(["'])(.*)\1$/, '$2');
    if (value) lines.push([m[1], value]);
  }
  return lines;
}

// Reads the named keys and nothing else, so no other line of .env can reach a child by accident.
// A name on several lines takes its last value. duplicateEnvNames lets doctor say so.
export function parseEnvFile(file, names = ENV_FILE_KEYS) {
  const out = {};
  for (const [name, value] of filledEnvLines(file)) {
    if (names.includes(name)) out[name] = value;
  }
  return out;
}

// Names only. The names this project knows that hold a value on more than one line.
export function duplicateEnvNames(file) {
  const known = [...ENV_FILE_KEYS, ...Object.keys(RENAMED_ENV_KEYS), ...Object.values(RENAMED_ENV_KEYS)];
  const seen = filledEnvLines(file).map(([name]) => name).filter((name) => known.includes(name));
  return [...new Set(seen.filter((name, i) => seen.indexOf(name) !== i))];
}

// Names only, so the caller never holds an old value. An empty line does not count.
export function renamedEnvNames(file) {
  return Object.keys(parseEnvFile(file, Object.keys(RENAMED_ENV_KEYS)));
}

export function ensureGatewayToken(paths) {
  const file = join(paths.cloDir, 'gateway.token');
  if (!existsSync(file)) {
    mkdirSync(paths.cloDir, { recursive: true });
    writeAtomic(file, randomBytes(32).toString('hex'));
  }
  return readFileSync(file, 'utf8').trim();
}

// Built from an allowlist. A proxy variable or a key in the parent's environment cannot reach the child.
export function gatewayEnv(paths, parentEnv, { secrets = {}, token = null } = {}) {
  const keep = {};
  for (const k of OS_ENV_KEYS) {
    if (parentEnv[k]) keep[k] = parentEnv[k];
  }
  const system32 = systemExe(parentEnv);
  const base = {
    ...keep,
    PATH: `${dirname(privateNode(paths))};${system32}`,
    HOME: paths.home,
    USERPROFILE: paths.home,
    APPDATA: join(paths.runtime, 'appdata', 'Roaming'),
    LOCALAPPDATA: join(paths.runtime, 'appdata', 'Local'),
    TEMP: join(paths.runtime, 'temp'),
    TMP: join(paths.runtime, 'temp'),
    OPENCLAW_HOME: paths.home,
    OPENCLAW_STATE_DIR: paths.stateDir,
    OPENCLAW_CONFIG_PATH: paths.openclawJson,
    OPENCLAW_WORKSPACE_DIR: paths.workspace,
    OPENCLAW_NO_AUTO_UPDATE: '1',
    OPENCLAW_DISABLE_BONJOUR: '1',
    // Keeps restarts in this process, so the PID we recorded stays the Gateway (read in docs/gateway/embedding.md).
    OPENCLAW_NO_RESPAWN: '1',
    OPENCLAW_EXEC_SHELL_SNAPSHOT: '0',
    NODE_COMPILE_CACHE: join(paths.runtime, 'compile-cache'),
    NODE_NO_WARNINGS: '1',
  };
  if (token) base.OPENCLAW_GATEWAY_TOKEN = token;
  for (const [fileName, childName] of Object.entries(CHILD_ENV_NAMES)) {
    if (secrets[fileName]) base[childName] = secrets[fileName];
  }
  if (isTestMode(parentEnv)) {
    base.OPENCLAW_OFFLINE = '1';
    for (const k of TEST_ENV_KEYS) {
      if (parentEnv[k]) base[k] = parentEnv[k];
    }
  }
  return base;
}

// Node args that come before the entry script. Only test mode adds anything.
export function nodeImports(env) {
  return isTestMode(env) && env.CLO_TEST_NODE_IMPORT ? [`--import=${pathToFileURL(resolve(env.CLO_TEST_NODE_IMPORT)).href}`] : [];
}

function gatewayEntry(paths, env) {
  return isTestMode(env) && env.CLO_TEST_GATEWAY_ENTRY ? resolve(env.CLO_TEST_GATEWAY_ENTRY) : openclawEntry(paths);
}

export function gatewayArgs(paths, env, port) {
  return [`--import=${pathToFileURL(OUTPUT_FILTER).href}`, ...nodeImports(env), gatewayEntry(paths, env), 'gateway', 'run', '--port', String(port), '--bind', 'loopback'];
}

// For commands that only read, such as plugins inspect: same isolation, no secrets.
export function hostCliEnv(paths, parentEnv) {
  return gatewayEnv(paths, parentEnv);
}

export function inspectArgs(paths, env) {
  return [...nodeImports(env), gatewayEntry(paths, env), 'plugins', 'inspect', 'clo', '--runtime', '--json'];
}

const FORBIDDEN_CHILD_ENV = /proxy|^PERPLEXITY_API_KEY$|^CLO_CHAT_API_KEY$|^CLO_SEARCH_API_KEY$|^CLO_SEARCH_OPENROUTER_KEY$|^NODE_OPTIONS$|^NODE_EXTRA_CA_CERTS$/i;

// Names only. Used by doctor against gatewayEnvForCheck.
export function ensureGatewayEnvClean(childEnv) {
  return Object.keys(childEnv).filter((k) => FORBIDDEN_CHILD_ENV.test(k));
}

// The environment start would build, with placeholders for the secrets, so the check sees the real child names.
export function gatewayEnvForCheck(paths, parentEnv) {
  const secrets = Object.fromEntries(ENV_FILE_KEYS.map((k) => [k, 'check-only']));
  return gatewayEnv(paths, parentEnv, { secrets, token: 'check-only' });
}

export const digestOf = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex');

// Start time and command line, from the OS. They are what ties a PID to a process we started.
// 'gone' only when the lookup itself worked and found nothing. A lookup that failed says nothing.
export function lookupProcess(pid, env = process.env) {
  if (!Number.isInteger(pid) || pid <= 0) return { outcome: 'gone' };
  const script = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::UTF8;$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}";`
    + 'if($p){@{commandLine=$p.CommandLine;startTime=$p.CreationDate.ToUniversalTime().ToString("o")}|ConvertTo-Json -Compress}';
  const r = spawnSync(systemExe(env, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: osToolEnv(env), encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  if (r.error || r.status !== 0) return { outcome: 'unknown' };
  if (!r.stdout?.trim()) return { outcome: 'gone' };
  try {
    return { outcome: 'found', info: JSON.parse(r.stdout) };
  } catch {
    return { outcome: 'unknown' };
  }
}

export function processInfo(pid, env = process.env) {
  return lookupProcess(pid, env).info ?? null;
}

export function readPidRecord(paths) {
  try {
    const rec = JSON.parse(readFileSync(paths.pidFile, 'utf8'));
    return Number.isInteger(rec?.pid) ? rec : null;
  } catch {
    return null;
  }
}

// 'none' | 'gone' | 'mismatch' (the PID now belongs to something else) | 'running' | 'unknown' (could not tell).
// An 'unknown' result also has cause: 'lookup_failed', or 'cmdline_unreadable' when the start time matches but the OS
// withholds the command line, as it does for a more privileged process. That is no evidence the PID changed hands.
export function inspectGateway(paths, env = process.env) {
  const record = readPidRecord(paths);
  if (!record) return { state: 'none', record: null };
  const { outcome, info } = lookupProcess(record.pid, env);
  if (outcome === 'unknown') return { state: 'unknown', cause: 'lookup_failed', record };
  if (outcome === 'gone') return { state: 'gone', record };
  if (info.startTime !== record.startTime) return { state: 'mismatch', record };
  if (!info.commandLine) return { state: 'unknown', cause: 'cmdline_unreadable', record };
  return { state: digestOf(info.commandLine) === record.commandDigest ? 'running' : 'mismatch', record };
}

function portFree(port) {
  return new Promise((res) => {
    const s = createServer();
    s.once('error', () => res(false));
    s.listen(port, '127.0.0.1', () => s.close(() => res(true)));
  });
}

function rotateLog(file) {
  try {
    if (statSync(file).size > LOG_ROTATE_BYTES) renameSync(file, `${file}.1`);
  } catch {
    // No log yet, or a reader holds it.
  }
}

// Test mode must be wired to mocks, or the SDK and provider would default to the real services.
export function assertTestModeWired(cfg, env) {
  if (!isTestMode(env)) return;
  if (!env.CLO_TEST_NODE_IMPORT) throw new CliError('测试模式必须设置 CLO_TEST_NODE_IMPORT（net-guard）。');
  if (cfg.qq?.enabled && !(isLoopback(cfg.qq.apiBaseUrl) && isLoopback(cfg.qq.tokenBaseUrl))) throw new CliError('测试模式下 QQ 地址必须是 loopback。');
  if (!isLoopback(cfg.openrouter?.baseUrl)) throw new CliError('测试模式下 openrouter.baseUrl 必须是 loopback。');
}

const renameOldLine = (old) => `.env 里的 ${old} 已不再读取，请把这一行改名为 ${RENAMED_ENV_KEYS[old]}。`;

export function renamedKeyHint(renamed, missing) {
  return renamed.filter((old) => missing.includes(RENAMED_ENV_KEYS[old])).map(renameOldLine).join('');
}

// Every old line, whether or not the new name is needed now. If the new name already has a value, renaming would
// leave two lines of that name and the last one would win, so the advice is to delete.
export function oldLinesHint(file) {
  const filled = parseEnvFile(file, Object.values(RENAMED_ENV_KEYS));
  return renamedEnvNames(file).map((old) => {
    const name = RENAMED_ENV_KEYS[old];
    return filled[name] ? `.env 里的 ${old} 已不再读取，可以删掉这一行。${name} 已经有值，不要改名，否则旧值可能顶替它。` : renameOldLine(old);
  }).join('');
}

export function duplicateLinesHint(file) {
  return duplicateEnvNames(file).map((name) => `.env 里的 ${name} 写了不止一行，生效的是最后一行，请只留一行。`).join('');
}

export function requireSecrets(cfg, secrets, { renamed = [] } = {}) {
  const missing = [];
  if (cfg.qq?.enabled) {
    if (!secrets.CLO_QQ_APP_ID) missing.push('CLO_QQ_APP_ID');
    if (!secrets.CLO_QQ_APP_SECRET) missing.push('CLO_QQ_APP_SECRET');
    if (secrets.CLO_QQ_APP_ID && secrets.CLO_QQ_APP_ID !== cfg.qq.appId) throw new CliError('.env 的 CLO_QQ_APP_ID 与 config.json 的 qq.appId 不一致。');
  }
  if (cfg.mode === 'live' && !secrets.CLO_CHAT_API_KEY) missing.push('CLO_CHAT_API_KEY');
  if (missing.length) throw new CliError(`.env 缺少：${missing.join('、')}。${renamedKeyHint(renamed, missing)}`);
}

export async function startGateway(ctx, cfg, { secrets, lookup = processInfo }) {
  const { paths, env } = ctx;
  const port = cfg.gatewayPort ?? DEFAULT_PORT;
  if (!(await portFree(port))) throw new CliError(`端口 ${port} 已被占用。没有动占用它的进程；请改 gatewayPort 或先结束它。`);

  const token = ensureGatewayToken(paths);
  for (const d of [paths.logsDir, dirname(paths.pidFile), paths.gatewayCwd, join(paths.runtime, 'temp'), join(paths.runtime, 'appdata', 'Roaming'), join(paths.runtime, 'appdata', 'Local')]) {
    mkdirSync(d, { recursive: true });
  }
  rotateLog(paths.gatewayLog);
  const logFd = openSync(paths.gatewayLog, 'a');
  let child;
  try {
    child = spawn(privateNode(paths), gatewayArgs(paths, env, port), {
      cwd: paths.gatewayCwd,
      env: gatewayEnv(paths, env, { secrets, token }),
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }
  let exited = null;
  let spawnError = null;
  child.on('exit', (code) => { exited = { code }; });
  child.on('error', (e) => { spawnError = e; });
  await new Promise((r) => { setTimeout(r, EARLY_EXIT_WATCH_MS); });
  if (spawnError) throw new CliError(`Gateway 启动失败：${spawnError.code ?? '未知错误'}`);
  if (exited) throw new CliError(`Gateway 启动后立刻退出，退出码 ${exited.code}。详情见日志：${paths.gatewayLog}`);

  // With no PID record, nothing could stop it later. This is the child we just spawned, by its handle.
  // Unref too, or a child that survived the kill would hold this command open until it exits.
  const endChild = () => {
    const ended = child.kill();
    child.unref();
    return ended ? '已结束刚启动的进程。' : `进程 ${child.pid} 可能还在运行，请手动结束。`;
  };
  // A record with no command line could never be matched again, so it counts as no information.
  const readable = (i) => Boolean(i?.startTime && i?.commandLine);
  let info = null;
  for (let i = 0; i < START_LOOKUP_TRIES && !readable(info); i += 1) info = lookup(child.pid, env);
  if (!readable(info)) throw new CliError(`读不到 Gateway 进程信息，无法记录 PID，${endChild()}`);
  try {
    writeAtomic(paths.pidFile, `${JSON.stringify({
      pid: child.pid, startTime: info.startTime, commandDigest: digestOf(info.commandLine), port, startedAt: new Date(ctx.now()).toISOString(),
    }, null, 2)}\n`);
  } catch (e) {
    throw new CliError(`写不进 PID 文件（${e.code ?? '未知错误'}），${endChild()}`);
  }
  child.unref();
  ctx.log('gateway_started', { count: child.pid });
  return { pid: child.pid, port };
}

const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

export const startLockFile = (paths) => join(dirname(paths.pidFile), 'start.lock');

// null when there is no file. A file that cannot be read yet reads as empty, which counts as held.
function readLockText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    return e.code === 'ENOENT' ? null : '';
  }
}

// { state: 'free' } | { state: 'stale', text, record } | { state: 'held', cause, text, record }.
// Stale only on proof the holder ended: the OS says the PID is gone, or the PID now has another start time.
// Anything less counts as held. cause is 'running', 'lookup_failed' or 'unreadable' (record is null for that one).
export function inspectStartLock(ctx, { lookup = lookupProcess } = {}) {
  const text = readLockText(startLockFile(ctx.paths));
  if (text === null) return { state: 'free' };
  let record = null;
  try {
    const parsed = JSON.parse(text);
    if (Number.isInteger(parsed?.pid)) record = parsed;
  } catch {
    // Same as a lock with no PID in it: a holder may be between creating the file and writing it.
  }
  if (!record) return { state: 'held', cause: 'unreadable', text, record };
  const { outcome, info } = lookup(record.pid, ctx.env);
  if (outcome === 'gone') return { state: 'stale', text, record };
  if (outcome !== 'found') return { state: 'held', cause: 'lookup_failed', text, record };
  const reused = Boolean(record.startTime && info?.startTime) && record.startTime !== info.startTime;
  return { state: reused ? 'stale' : 'held', cause: reused ? undefined : 'running', text, record };
}

function startLockBusyError(file, seen) {
  if (seen.cause === 'running') return new CliError(`另一个 clo start 正在运行（进程 ${seen.record.pid}），等它结束再试。`);
  if (seen.cause === 'lookup_failed') return new CliError(`查不到持有启动锁的进程 ${seen.record.pid} 的状态，它可能还在运行。启动锁保留，请稍后再试。`);
  return new CliError(`启动锁读不出内容，可能有另一个 clo start 正在运行。如果确认没有，删除 ${file} 后再试。`);
}

// Two starts can both judge one lock stale. Removal happens under a guard and only if the file still holds the text
// that was judged, so the slower one cannot delete the lock the faster one has just created.
function removeStaleLock(file, text) {
  const guard = `${file}.reclaim`;
  try {
    closeSync(openSync(guard, 'wx'));
  } catch {
    return;
  }
  try {
    if (readLockText(file) === text) rmSync(file, { force: true });
  } catch {
    // A reader holds it. The caller tries again.
  } finally {
    rmSync(guard, { force: true });
  }
}

function acquireStartLock(ctx, lookup) {
  const file = startLockFile(ctx.paths);
  mkdirSync(dirname(file), { recursive: true });
  // Looked up before the file exists, so the file stays empty for as short a time as possible.
  const self = lookup(process.pid, ctx.env).info;
  const text = JSON.stringify({ pid: process.pid, startTime: self?.startTime ?? null, token: randomBytes(8).toString('hex'), startedAt: new Date(ctx.now()).toISOString() });
  for (let attempt = 0; attempt < START_LOCK_TRIES; attempt += 1) {
    if (attempt > 0) sleepSync(START_LOCK_RETRY_MS);
    let fd;
    try {
      fd = openSync(file, 'wx');
    } catch (e) {
      if (e.code === 'EEXIST') {
        const seen = inspectStartLock(ctx, { lookup });
        if (seen.state === 'held') throw startLockBusyError(file, seen);
        if (seen.state === 'stale') removeStaleLock(file, seen.text);
        continue;
      }
      // On Windows a file being deleted refuses new opens until its last reader closes it.
      if (['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) continue;
      throw new CliError(`建不了启动锁（${e.code ?? '未知错误'}）。`);
    }
    try {
      writeSync(fd, text);
    } catch (e) {
      closeSync(fd);
      rmSync(file, { force: true });
      throw new CliError(`写不进启动锁（${e.code ?? '未知错误'}）。`);
    }
    closeSync(fd);
    return text;
  }
  throw new CliError(`拿不到启动锁。如果确认没有 clo start 在运行，删除 ${file} 和 ${file}.reclaim 后再试。`);
}

// Runs fn while this process alone holds the project's start lock, and returns what fn returns.
// A second caller gets a CliError and its fn does not run. The lock is released when fn settles. A process that dies
// holding it leaves a lock the next caller can reclaim.
export async function withStartLock(ctx, fn, { lookup = lookupProcess } = {}) {
  const file = startLockFile(ctx.paths);
  const text = acquireStartLock(ctx, lookup);
  try {
    return await fn();
  } finally {
    // Never someone else's lock. A release that fails leaves a lock the next caller can prove stale.
    try {
      if (readLockText(file) === text) rmSync(file, { force: true });
    } catch {
      // See above.
    }
  }
}

function waitForGone(pid, env) {
  const end = Date.now() + STOP_WAIT_MS;
  while (Date.now() < end) {
    if (lookupProcess(pid, env).outcome === 'gone') return true;
    sleepSync(250);
  }
  return false;
}

export function stopGateway(ctx) {
  const { paths, env } = ctx;
  const { state, cause, record } = inspectGateway(paths, env);
  if (state === 'none') return { stopped: false, reason: 'no_pid_file' };
  // Nothing is known about the process, so the record stays and nothing is signalled.
  if (state === 'unknown') return { stopped: false, reason: 'lookup_failed', cause };
  if (state === 'gone') {
    rmSync(paths.pidFile, { force: true });
    return { stopped: false, reason: 'not_running' };
  }
  if (state === 'mismatch') {
    // The PID was reused by another process. It is not ours, so it is left alone.
    rmSync(paths.pidFile, { force: true });
    return { stopped: false, reason: 'pid_mismatch' };
  }
  spawnSync(systemExe(env, 'taskkill.exe'), ['/PID', String(record.pid), '/T', '/F'], { env: osToolEnv(env), windowsHide: true });
  if (!waitForGone(record.pid, env)) throw new CliError(`进程 ${record.pid} 没有退出。PID 文件保留，可以再试一次。`);
  rmSync(paths.pidFile, { force: true });
  ctx.log('gateway_stopped', { count: record.pid });
  return { stopped: true, pid: record.pid };
}
