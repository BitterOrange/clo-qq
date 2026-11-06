// The own runtime's consumer lease and stop request: rows in clo.db, readable with no SDK or host loaded, so the
// console can read them as well as both runtimes.

export const HEARTBEAT_MS = 30000;

// The own runtime's consumer lease: one row naming the process that holds the account. It listens on no port, so
// nothing else stops a second process on the same database (a bot clo start lost track of, say) from connecting.
export const CONSUMER_LEASE_KEY = 'bot_consumer';
export const LEASE_REFRESH_MS = HEARTBEAT_MS;
// A lease, or a heartbeat, older than this belongs to a process that is gone or no longer running its timers.
export const LEASE_STALE_MS = 3 * HEARTBEAT_MS;

/** Whether a process with this PID exists. A PID that cannot be probed counts as alive. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== 'ESRCH';
  }
}

export const leasePid = (value) => Number(String(value ?? '').split(':')[0]);

// A stop clo can ask for without killing the process: the row names the bot's PID, so a row left behind can never stop
// a later process. The bot polls it, since a hidden detached process gets no console signal.
export const STOP_REQUEST_KEY = 'bot_stop_request';

/**
 * The bot that holds the account now, as { pid }, or null: a lease renewed within LEASE_STALE_MS whose process is
 * alive. A Gateway checks this before it connects, and clo start and clo stop read it, since a bot clo lost track of
 * has no PID record. A lease that cannot be read counts as held.
 */
export function liveBotLease({ store, now = Date.now, isAlive = pidAlive }) {
  try {
    const held = store.getControl(CONSUMER_LEASE_KEY);
    if (held === null) return null;
    const pid = leasePid(held);
    const leaseAt = Number(store.controlUpdatedAt(CONSUMER_LEASE_KEY));
    if (!Number.isFinite(leaseAt) || now() - leaseAt >= LEASE_STALE_MS) return null;
    return isAlive(pid) ? { pid } : null;
  } catch {
    return { pid: null };
  }
}

/**
 * Drops the lease if the process named in it is the one given: for clo stop, once it has seen that process gone. A
 * hard stop gives the bot no chance to drop it itself, and a lease left behind would block the next start for a while
 * if Windows hands the PID to another process. A lease naming any other PID is left alone. Returns whether it went.
 */
export function releaseLeaseOfPid({ store, pid }) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  return store.tx(() => {
    const held = store.getControl(CONSUMER_LEASE_KEY);
    if (held === null || leasePid(held) !== pid) return false;
    store.delControl(CONSUMER_LEASE_KEY);
    return true;
  });
}
