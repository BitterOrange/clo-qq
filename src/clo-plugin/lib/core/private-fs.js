// Owner-only modes for what the project writes off Windows: secrets, raw IDs, the ledger and logs. On Windows every
// helper here does exactly what the plain call did before, and changes no mode: the folder's ACL decides there.
//
// New folders are made 0700 and new files 0600, whatever the umask. An existing file or folder is narrowed by
// clearing its group and other bits; the owner's bits are never touched, so a stricter mode the owner set stays.
import { appendFileSync, chmodSync, closeSync, fchmodSync, fstatSync, mkdirSync, openSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

export const PRIVATE_MODES = process.platform !== 'win32';
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
const GROUP_OTHER = 0o077;

// Clears group and other bits of one path. A missing path is left missing. Returns true when it changed a mode.
export function narrowMode(path) {
  if (!PRIVATE_MODES) return false;
  let st;
  try {
    st = statSync(path);
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  if ((st.mode & GROUP_OTHER) === 0) return false;
  chmodSync(path, st.mode & 0o700);
  return true;
}

// For paths a running bot or Gateway narrows on the way: a file it cannot chmod (another owner) must not stop the
// ledger or the log. doctor still reports the mode.
export function tryNarrowMode(path) {
  try {
    return narrowMode(path);
  } catch {
    return false;
  }
}

// The same on an open descriptor, so a file opened for append is narrowed without a second lookup by name.
export function narrowFd(fd) {
  if (!PRIVATE_MODES) return;
  const { mode } = fstatSync(fd);
  if (mode & GROUP_OTHER) fchmodSync(fd, mode & 0o700);
}

// mkdir -p, with any folder it creates made 0700. Folders that already exist keep their mode.
export function mkdirPrivate(dir) {
  if (!PRIVATE_MODES) {
    mkdirSync(dir, { recursive: true });
    return;
  }
  const first = mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  // The umask can only take bits away, and mkdir with a mode is already 0700 at most. chmod makes it exact.
  if (first) chmodSync(dir, PRIVATE_DIR_MODE);
}

const inside = (root, p) => {
  const rel = relative(root, p);
  return rel === '' || (!!rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};

// For folders the project owns under the runtime folder: made if missing, and narrowed if they exist. The runtime
// folder itself is narrowed too. Anything outside it is refused: a repo root or a user's folder is never chmodded.
export function ensurePrivateDirs(runtime, dirs) {
  if (!PRIVATE_MODES) {
    for (const d of dirs) mkdirSync(d, { recursive: true });
    return;
  }
  for (const d of dirs) {
    if (!inside(runtime, d)) throw new Error('ensurePrivateDirs: a folder outside the runtime folder');
  }
  mkdirPrivate(runtime);
  narrowMode(runtime);
  for (const d of dirs) {
    mkdirPrivate(d);
    narrowMode(d);
  }
}

// Opens for append. A new file is 0600; an existing one is narrowed.
export function openAppendPrivate(path) {
  if (!PRIVATE_MODES) return openSync(path, 'a');
  const fd = openSync(path, 'a', PRIVATE_FILE_MODE);
  try {
    narrowFd(fd);
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  return fd;
}

// appendFileSync, with a new file made 0600. An existing file keeps its mode: callers narrow it once, not per line.
export function appendPrivate(path, text) {
  if (!PRIVATE_MODES) return appendFileSync(path, text);
  return appendFileSync(path, text, { mode: PRIVATE_FILE_MODE });
}

// For a file appended to across runs: an existing file is narrowed once, here, then each line goes through appendPrivate.
export function privateAppender(path) {
  narrowMode(path);
  return (text) => appendPrivate(path, text);
}

// writeFileSync for a new or replaced small file, made 0600 and narrowed if it already existed.
export function writeFilePrivate(path, text, { flag = 'w' } = {}) {
  if (!PRIVATE_MODES) return writeFileSync(path, text, { flag });
  writeFileSync(path, text, { flag, mode: PRIVATE_FILE_MODE });
  narrowMode(path);
}
