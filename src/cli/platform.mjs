// What differs between Windows and everything else: the private Node's path, and how a PID is tied to a process and
// ended. The Windows code itself stays where it is in lifecycle.mjs; this file holds the non-Windows side, and it
// starts no process. A platform with no /proc gets 'unknown' from every lookup, and then nothing is signalled.
import { readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const IS_WINDOWS = process.platform === 'win32';

const REAL_PROC = '/proc';
const EXE_RETRY_MS = 50;

export const privateNodePath = (repoRoot) => (IS_WINDOWS ? join(repoRoot, '.runtime', 'node', 'node.exe') : join(repoRoot, '.runtime', 'node', 'bin', 'node'));

// True only when both paths resolve to the same file. A path that cannot be resolved is not the same binary.
export function sameBinary(want, execPath) {
  try {
    return realpathSync(want) === realpathSync(execPath);
  } catch {
    return false;
  }
}

// What a child gets on top of the allowlisted env: the private Node's folder as the whole PATH, and a temp folder
// under the runtime. Nothing is taken from the parent.
export function linuxChildEnv(paths, nodePath) {
  return { PATH: dirname(nodePath), TMPDIR: join(paths.runtime, 'temp') };
}

// The real /proc, unless test mode names another folder. Signals are only ever sent under the real one.
export function procRootOf(env = process.env) {
  return env?.CLO_TEST_ROOT && env.CLO_TEST_PROC_ROOT ? resolve(env.CLO_TEST_PROC_ROOT) : REAL_PROC;
}

// The fields of /proc/<pid>/stat this project reads, or null. The command name may hold spaces and parentheses, so
// the numbered fields are counted from the last ')'.
export function parseProcStat(text) {
  if (typeof text !== 'string') return null;
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 1 || close < open) return null;
  const head = text.slice(0, open).trim();
  // rest[0] is field 3 (state); the start time is field 22.
  const rest = text.slice(close + 1).trim().split(/\s+/);
  if (!/^\d+$/.test(head) || rest.length < 20 || !/^[A-Za-z]$/.test(rest[0])) return null;
  for (const i of [1, 2, 3]) {
    if (!/^-?\d+$/.test(rest[i])) return null;
  }
  if (!/^\d+$/.test(rest[19])) return null;
  // The start time stays a string: it is only compared, and it may not fit a double.
  return { pid: Number(head), state: rest[0], ppid: Number(rest[1]), pgrp: Number(rest[2]), session: Number(rest[3]), startTicks: rest[19] };
}

const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
// Signal 0 delivers nothing. It only asks whether the PID exists.
const kernelProbe = (pid) => { process.kill(pid, 0); };
const isDead = (state) => state === 'Z' || state === 'X';
const validPid = (pid) => Number.isInteger(pid) && pid > 0;

// { stat } or { code }: the parsed stat of one PID, or why it could not be had.
function readStat(root, pid) {
  let text;
  try {
    text = readFileSync(join(root, String(pid), 'stat'), 'utf8');
  } catch (e) {
    return { code: e.code ?? 'UNKNOWN' };
  }
  const stat = parseProcStat(text);
  return stat && stat.pid === pid ? { stat } : { code: 'UNPARSED' };
}

// The boot id, or null when this /proc cannot be trusted: not mounted, not readable, or another PID namespace.
function bootIdOf(root) {
  try {
    const self = parseProcStat(readFileSync(join(root, 'self', 'stat'), 'utf8'));
    if (!self || self.pid !== process.pid) return null;
    const boot = readFileSync(join(root, 'sys', 'kernel', 'random', 'boot_id'), 'utf8').trim();
    return /^[0-9A-Za-z-]{1,64}$/.test(boot) ? boot : null;
  } catch {
    return null;
  }
}

// One PID, with the tri-state the Windows lookup has, plus the parsed stat for the callers in this file.
function readProcess(pid, env, { probe = kernelProbe, pause = sleepSync } = {}) {
  if (!validPid(pid)) return { outcome: 'gone' };
  const root = procRootOf(env);
  const boot = bootIdOf(root);
  if (boot === null) return { outcome: 'unknown' };
  for (let attempt = 0; ; attempt += 1) {
    const { stat, code } = readStat(root, pid);
    if (!stat) {
      if (code !== 'ENOENT' && code !== 'ESRCH') return { outcome: 'unknown' };
      // No entry. Only the kernel saying so too makes it gone: /proc can hide other users' processes.
      try {
        probe(pid);
      } catch (e) {
        return { outcome: e?.code === 'ESRCH' ? 'gone' : 'unknown' };
      }
      return { outcome: 'unknown' };
    }
    // An exited process nobody has reaped yet. Its PID cannot be handed out again while it stays in this state.
    if (isDead(stat.state)) return { outcome: 'gone' };
    let exeReadable = true;
    let exeCode = null;
    try {
      readlinkSync(join(root, String(pid), 'exe'));
    } catch (e) {
      exeReadable = false;
      exeCode = e.code ?? 'UNKNOWN';
    }
    // A process on its way out loses the link before it reads as exited. Kernel threads never have one. One more
    // look after a short wait tells the two apart.
    const kernelThread = pid === 2 || stat.ppid === 2;
    if (!exeReadable && exeCode === 'ENOENT' && !kernelThread && attempt === 0) {
      pause(EXE_RETRY_MS);
      continue;
    }
    let argv = null;
    try {
      argv = readFileSync(join(root, String(pid), 'cmdline'), 'utf8').replace(/\0+$/, '').replace(/\0/g, ' ');
    } catch {
      // For display and tests only. It is never compared.
    }
    // The identity is the boot, the PID and the start time in ticks. The command line a process shows can be rewritten
    // by the process itself, so it is not part of it.
    return {
      outcome: 'found',
      stat,
      info: {
        startTime: `linux:${boot}:${stat.startTicks}`,
        commandLine: exeReadable ? `linux-proc:${boot}:${pid}:${stat.startTicks}` : null,
        argv,
      },
    };
  }
}

// Same answers as lookupProcess gives on Windows. 'gone' only when the lookup worked and found nothing alive.
// info.commandLine is null when the OS will not show what the process is.
export function lookupProcessLinux(pid, env = process.env, opts = {}) {
  const { outcome, info } = readProcess(pid, env, opts);
  return outcome === 'found' ? { outcome, info } : { outcome };
}

// [{ pid, startTicks }] for every process below pid by parent links, or null when /proc could not be listed.
export function descendantsOf(pid, procRoot = REAL_PROC) {
  let names;
  try {
    names = readdirSync(procRoot);
  } catch {
    return null;
  }
  const children = new Map();
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const { stat } = readStat(procRoot, Number(name));
    if (!stat) continue;
    if (!children.has(stat.ppid)) children.set(stat.ppid, []);
    children.get(stat.ppid).push({ pid: stat.pid, startTicks: stat.startTicks });
  }
  const out = [];
  const seen = new Set([pid]);
  const queue = [pid];
  while (queue.length) {
    for (const child of children.get(queue.shift()) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

// The one place a signal leaves this file. target is a PID, or minus a PID for its process group. 0, -1 and 1 would
// reach this process's own group, every process, or init, so they are refused here whatever the caller checked.
// True when the signal was sent. A target that is already gone, or not ours to signal, is false.
function sendKill(kill, target) {
  if (!Number.isInteger(target) || Math.abs(target) <= 1 || Math.abs(target) === process.pid) return false;
  try {
    kill(target, 'SIGKILL');
    return true;
  } catch (e) {
    if (e?.code === 'ESRCH' || e?.code === 'EPERM') return false;
    throw e;
  }
}

// Each snapshotted descendant that is still the same process: same PID, same start time, not yet exited.
function killSnapshot(kill, root, snapshot) {
  for (const d of snapshot ?? []) {
    const { stat } = readStat(root, d.pid);
    if (stat && stat.startTicks === d.startTicks && !isDead(stat.state)) sendKill(kill, d.pid);
  }
}

// Ends the recorded process and what it started. The caller has already matched the record; it is matched again here,
// and nothing is sent unless the PID still has the recorded start time. Nothing is sent either when the lookup ran
// against a test folder instead of the real /proc: what such a folder says about a PID proves nothing about the
// process that holds it.
export function endRecordedTree(record, env = process.env, { log = () => {}, kill = process.kill, descendants = descendantsOf } = {}) {
  const root = procRootOf(env);
  if (root !== REAL_PROC) return;
  const pid = record?.pid;
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
  const seen = readProcess(pid, env);
  if (seen.outcome !== 'found' || !record.startTime || seen.info.startTime !== record.startTime) return;
  // Listed while the leader is still known to be ours.
  const snapshot = descendants(pid, root);
  // The group kill below still reaches what stayed in the group. The event carries no PID.
  if (snapshot === null) log('stop_descendants_unlisted', {});
  // start spawns it detached, so it leads its own session and group, and only what it started can be in that group.
  const leadsGroup = seen.stat.pgrp === pid && seen.stat.session === pid;
  sendKill(kill, leadsGroup ? -pid : pid);
  killSnapshot(kill, root, snapshot);
}

// Ends a child by its handle, with whatever it started. A handle that has not seen the child exit keeps the PID from
// being reused, so no start time is needed. SIGKILL, because the bot traps SIGTERM and would outlive child.kill().
// True when a kill was sent to a child this handle still owns. When /proc cannot be trusted (another PID namespace,
// not mounted), what it says about the group or the descendants may describe other processes, so only the child's
// own PID is signalled.
export function endSpawnedChild(child, env = process.env, { kill = process.kill, trusted = (root) => bootIdOf(root) !== null } = {}) {
  const root = procRootOf(env);
  if (root !== REAL_PROC) return false;
  const pid = child?.pid;
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  if (child.exitCode !== null || child.signalCode !== null) return false;
  if (!trusted(root)) return sendKill(kill, pid);
  const { stat } = readStat(root, pid);
  if (stat && stat.pgrp === pid) return sendKill(kill, -pid);
  const snapshot = descendantsOf(pid, root);
  const sent = sendKill(kill, pid);
  killSnapshot(kill, root, snapshot);
  return sent;
}
