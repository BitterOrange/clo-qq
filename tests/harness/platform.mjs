// What the tests need to know about the platform they run on. The paths here are written out per platform and not
// taken from src, so a wrong path in src is caught by the tests that compare against these.
import { readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const IS_WINDOWS = process.platform === 'win32';
export const NODE = IS_WINDOWS ? join(ROOT, '.runtime', 'node', 'node.exe') : join(ROOT, '.runtime', 'node', 'bin', 'node');

// For `{ skip }`: false where the test runs, and the reason everywhere else. Every use is listed in the skip inventory.
export const WINDOWS_ONLY = IS_WINDOWS ? false : 'Windows only: runs a .ps1 through powershell.exe';
export const LINUX_ONLY = process.platform === 'linux' ? false : 'Linux only: reads /proc';

// An env under which the process lookup itself fails, so it can say neither 'found' nor 'gone'. Windows: the folder
// PowerShell is looked for in does not exist. Elsewhere: test mode points the lookup at a /proc that does not exist.
export function brokenLookupEnv(root) {
  if (IS_WINDOWS) return { SystemRoot: join(root, 'no-such-windows') };
  return { CLO_TEST_ROOT: root, CLO_TEST_PROC_ROOT: join(root, 'no-such-proc') };
}

// A live PID whose start time every caller can read and whose identity the OS withholds, or null when there is none.
// Windows: the System process. Linux: the first process above PID 1 that is not exited and whose exe link cannot be
// read, which is a kernel thread (they have no exe link) or another user's process. PID 1 is passed over: in a
// container it is often one whose link even root cannot read, and a test should not write a PID record for init.
// Read only; nothing is ever sent to it.
export function withheldCmdlinePid() {
  if (IS_WINDOWS) return 4;
  let names;
  try {
    names = readdirSync('/proc');
  } catch {
    return null;
  }
  for (const pid of names.filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => a - b)) {
    if (pid <= 1 || pid === process.pid) continue;
    let state;
    try {
      const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
      state = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/)[0];
    } catch {
      continue;
    }
    if (!/^[A-Za-z]$/.test(state) || state === 'Z' || state === 'X') continue;
    try {
      readlinkSync(`/proc/${pid}/exe`);
    } catch {
      return pid;
    }
  }
  return null;
}

// Off Windows only. The start time of a live PID in clock ticks, or null: taken when a test learns a bare PID, so a
// later kill can tell that process from another one that got the number.
export function startTicksOf(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/);
    return /^[A-Za-z]$/.test(rest[0]) && rest[0] !== 'Z' && rest[0] !== 'X' && /^\d+$/.test(rest[19]) ? rest[19] : null;
  } catch {
    return null;
  }
}

// Off Windows only, for a cleanup that holds neither a PID record nor a child handle. Ends one process, and only if
// it still has the start time seen when the PID was learned and runs the private Node. True when the signal went.
export function killIfSame(pid, startTicks) {
  if (IS_WINDOWS || !Number.isInteger(pid) || pid <= 1 || pid === process.pid || !startTicks) return false;
  if (startTicksOf(pid) !== startTicks) return false;
  try {
    if (readlinkSync(`/proc/${pid}/exe`) !== realpathSync(NODE)) return false;
    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

// A start time in the platform's own format that no live process can have.
export function otherStartTime() {
  return IS_WINDOWS ? '2001-01-01T00:00:00.0000000Z' : 'linux:00000000-0000-0000-0000-000000000000:0';
}

// Everything below is for off Windows only and reads /proc. Nothing here signals a process.

// One process from /proc/<pid>/stat as { state, name, ppid, startTicks }, or null when the entry cannot be read.
// The name is the kernel's short one. It may hold spaces and brackets, so the fields are taken after the last ')'.
function procStat(pid) {
  let text;
  try {
    text = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const rest = text.slice(close + 1).trim().split(/\s+/);
  if (!/^[A-Za-z]$/.test(rest[0]) || !/^\d+$/.test(rest[1]) || !/^\d+$/.test(rest[19])) return null;
  return { state: rest[0], name: text.slice(open + 1, close), ppid: Number(rest[1]), startTicks: rest[19] };
}

// Whether the PID is a running process. One that has exited and only waits to be collected counts as not running.
// Throws when /proc gives no clear answer, so a caller never reads "cannot tell" as either.
export function pidAliveLinux(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`not a PID: ${pid}`);
  const stat = procStat(pid);
  if (stat) return stat.state !== 'Z' && stat.state !== 'X';
  try {
    // Signal 0 delivers nothing; it only asks whether the PID exists.
    process.kill(pid, 0);
  } catch (err) {
    if (err.code === 'ESRCH') return false;
  }
  throw new Error(`cannot tell whether PID ${pid} is alive`);
}

// Every running process as { pid, ppid, name, cmd, start }. `start` is the start time in clock ticks, zero-padded so
// that string order is time order. `cmd` is the argument list joined with spaces as the process shows it now: a
// process can rewrite it (the host does, through process.title), so it need not be what it was started with. Null
// when it cannot be read or is empty.
export function linuxProcessList() {
  const list = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const stat = procStat(pid);
    if (!stat || stat.state === 'Z' || stat.state === 'X') continue;
    let cmd = null;
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0+$/, '').replaceAll('\0', ' ') || null;
    } catch {
      // Left null.
    }
    list.push({ pid, ppid: stat.ppid, name: stat.name, cmd, start: stat.startTicks.padStart(20, '0') });
  }
  return list;
}

function socketAddress(hex) {
  const at = hex.lastIndexOf(':');
  const port = parseInt(hex.slice(at + 1), 16);
  const raw = hex.slice(0, at);
  // IPv4 is one 32-bit word in the machine's byte order (little-endian on x64). IPv6 is left as the kernel prints it.
  const host = raw.length === 8 ? raw.match(/../g).reverse().map((b) => parseInt(b, 16)).join('.') : `[${raw}]`;
  return { text: `${host}:${port}`, port };
}

// Listening TCP sockets and bound UDP sockets in this network namespace, each as { proto, address, port, pids }: the
// kernel's socket tables give the inode, and the fd folders say which processes hold it. `unreadable` lists the
// running PIDs whose fd folder could not be read, so a caller can say "I cannot tell" for those and not "holds none".
export function linuxSockets() {
  const byInode = new Map();
  for (const [file, proto] of [['tcp', 'tcp'], ['tcp6', 'tcp'], ['udp', 'udp'], ['udp6', 'udp']]) {
    let text;
    try {
      text = readFileSync(`/proc/net/${file}`, 'utf8');
    } catch (err) {
      // No IPv6 in this kernel is fine; an IPv4 table that cannot be read is not.
      if (err.code === 'ENOENT' && file.endsWith('6')) continue;
      throw new Error(`socket table ${file} could not be read: ${err.code}`);
    }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10) continue;
      // State 0A is LISTEN. Every row of the UDP tables is a bound socket.
      if (proto === 'tcp' && cols[3] !== '0A') continue;
      const { text: address, port } = socketAddress(cols[1]);
      byInode.set(cols[9], { proto, address, port, pids: [] });
    }
  }
  const unreadable = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let fds;
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch (err) {
      // A process that ended during the scan holds nothing. Any other failure is "cannot tell".
      if (err.code !== 'ENOENT' && err.code !== 'ESRCH') unreadable.push(pid);
      continue;
    }
    for (const fd of fds) {
      let target;
      try {
        target = readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      const m = /^socket:\[(\d+)\]$/.exec(target);
      const socket = m && byInode.get(m[1]);
      if (socket && !socket.pids.includes(pid)) socket.pids.push(pid);
    }
  }
  return { sockets: [...byInode.values()], unreadable };
}
