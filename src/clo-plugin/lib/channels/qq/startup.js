// What starting, running and stopping the QQ account means, whichever runtime drives it: the fatal-close latch,
// recovery, the status controls clo status reads, the reconnect cap and the stop order. Nothing here imports a host.
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { utcDay } from '../../core/ids.js';
import { createDownWatch, runConnection } from './connection.js';
import { CONSUMER_LEASE_KEY, HEARTBEAT_MS, LEASE_STALE_MS, leasePid, pidAlive } from './lease.js';

export { CONSUMER_LEASE_KEY, HEARTBEAT_MS, LEASE_REFRESH_MS, LEASE_STALE_MS, liveBotLease, pidAlive, STOP_REQUEST_KEY } from './lease.js';

export const JANITOR_MS = 3600000;
export const DOWN_CHECK_MS = 60000;
// Well below the 1000 a day session_start_limit the plan records. The SDK's own reconnects also count.
export const LIVENESS_RESTARTS_PER_DAY = 100;

/** The runtime effective.json names. Every reader uses this default. */
export const runtimeOf = (eff) => eff?.runtime ?? 'openclaw';

/**
 * True when this process must not connect: no credentials, or an AppID that differs from the configuration.
 * requireEnvAppId makes a missing CLO_QQ_APP_ID a mismatch as well.
 */
export function accountMismatch({ appId, secret, envAppId, eff, requireEnvAppId = false }) {
  if (!appId || !secret) return true;
  if (requireEnvAppId && !envAppId) return true;
  if (envAppId && envAppId !== appId) return true;
  return eff?.qq?.appId !== appId;
}

// A fatal close must outlive a database that cannot be written, or the next start would reconnect to the
// account the platform just closed. The file is written first and dropped once the store holds the code.
// The last resort, for when the file cannot be written either, lasts as long as this module instance.
let unsavedClose = null;
export const closeFilePath = (dbPath) => `${dbPath}.terminal_close`;

function saveCloseFile(dbPath, code) {
  try {
    const path = closeFilePath(dbPath);
    writeFileSync(`${path}.tmp`, String(code));
    renameSync(`${path}.tmp`, path);
    return true;
  } catch {
    return false;
  }
}

// Fails closed: a file that exists but cannot be read still counts as a latch.
function readCloseFile(dbPath) {
  try {
    return readFileSync(closeFilePath(dbPath), 'utf8').trim() || 'unknown';
  } catch (err) {
    return err?.code === 'ENOENT' ? null : 'unknown';
  }
}

function dropCloseFile(dbPath) {
  try {
    rmSync(closeFilePath(dbPath), { force: true });
  } catch {
    // The next start reads it as a latch, which is the safe direction.
  }
}

/** The latched close code, or null. A code found only on file moves into the store, which clo ack and the exit read. */
export function checkStartLatch({ store, dbPath, log }) {
  const stored = store.getControl('terminal_close');
  const filed = readCloseFile(dbPath);
  const latched = stored ?? filed ?? unsavedClose;
  if (filed !== null) {
    try {
      if (stored === null) {
        store.setControl('terminal_close', filed, 'connection');
        store.addAlert('terminal_close', { closeCode: Number(filed) });
      }
      dropCloseFile(dbPath);
    } catch {
      log('status_error', { reason: 'terminal_close' });
    }
  }
  return latched;
}

/**
 * Before any connection: which Key this process holds, recovery of an earlier generation's rows, and retention.
 * The environment is fixed now. Salted hash only: clo mode live compares it with .env.
 */
export function beginRun({ store, getEffective, log, started, key }) {
  store.setControl('gateway_key', key ? store.key(key) : 'none', 'start');
  const recovered = store.recoverOnStart(started);
  log('recovery', { count: recovered.crash_unknown + recovered.restart_dropped, reason: recovered.paid_paused ? 'crash_unsettled' : null });
  store.janitor(started, getEffective().retention);
  return recovered;
}

// The bot renews its lease in the same beat that writes heartbeat_at, so the two stamps of one beat are this close.
const SAME_BEAT_MS = 2000;

/**
 * Takes the lease for token (`<pid>:<run>`), in one transaction. Refused with 'running' while a lease from another run
 * is fresh and its process is alive (the same PID counts: two runs in one process). Refused as well while heartbeat_at
 * is fresh and was not written by a lease holder that is gone: a Gateway beats without a lease. A clean stop, by clo
 * stop or by the bot itself, removes that heartbeat. A lease left by a process that died is taken over.
 * Returns { ok:true } or { ok:false, reason:'running', holder }.
 */
export function claimConsumerLease({ store, token, now = Date.now, isAlive = pidAlive }) {
  return store.tx(() => {
    const at = now();
    const held = store.getControl(CONSUMER_LEASE_KEY);
    const leaseAt = held === null ? null : Number(store.controlUpdatedAt(CONSUMER_LEASE_KEY));
    const holderAlive = held !== null && held !== token && isAlive(leasePid(held));
    if (holderAlive && at - leaseAt < LEASE_STALE_MS) return { ok: false, reason: 'running', holder: 'bot' };
    const beat = Number(store.getControl('heartbeat_at'));
    const beatFresh = Number.isFinite(beat) && beat > 0 && at - beat < LEASE_STALE_MS;
    const holdersBeat = held !== null && !holderAlive && Math.abs(beat - leaseAt) <= SAME_BEAT_MS;
    if (beatFresh && !holdersBeat) return { ok: false, reason: 'running', holder: held === null ? 'heartbeat' : 'bot' };
    store.setControl(CONSUMER_LEASE_KEY, token, 'bot');
    return { ok: true };
  });
}

/** Renews the lease if token still holds it. False means another run took it over, so this one must stop. */
export function renewConsumerLease({ store, token }) {
  return store.tx(() => {
    if (store.getControl(CONSUMER_LEASE_KEY) !== token) return false;
    store.setControl(CONSUMER_LEASE_KEY, token, 'bot');
    return true;
  });
}

/** Whether token still holds the lease. */
export const holdsConsumerLease = ({ store, token }) => store.getControl(CONSUMER_LEASE_KEY) === token;

/**
 * Drops the lease, and the heartbeat this run wrote, if token holds it: a clean stop leaves nothing that reads as a
 * live consumer, as clo stop does for the Gateway. Another run's lease is left alone.
 */
export function releaseConsumerLease({ store, token }) {
  store.tx(() => {
    if (store.getControl(CONSUMER_LEASE_KEY) !== token) return;
    store.delControl(CONSUMER_LEASE_KEY);
    store.delControl('heartbeat_at');
  });
}

const alertQuietly = (store, log) => (kind, detail) => {
  try {
    store.addAlert(kind, detail);
  } catch {
    log('status_error', { reason: 'alert' });
  }
};

/**
 * The heartbeat, the down watch, the janitor and the ledger timers. noteConnection writes what clo status reads
 * about the connection. A status write that fails only logs. onBeat runs right after each heartbeat write.
 */
export function startControls({ store, ledger, getEffective, log, now = Date.now, onBeat = null }) {
  const downWatch = createDownWatch({ store, log });
  let connectedNow = false;
  const beat = () => {
    try {
      store.setControl('heartbeat_at', now(), 'heartbeat');
    } catch {
      log('heartbeat_error', {});
    }
    onBeat?.();
  };
  downWatch.begin(store.getControl('heartbeat_at'));
  beat();
  downWatch.check(false);
  const heartbeat = setInterval(beat, HEARTBEAT_MS);
  heartbeat.unref?.();
  const downTimer = setInterval(() => downWatch.check(connectedNow), DOWN_CHECK_MS);
  downTimer.unref?.();
  const janitor = setInterval(() => {
    try {
      const eff = getEffective();
      if (eff) store.janitor(now(), eff.retention);
    } catch {
      log('janitor_error', {});
    }
  }, JANITOR_MS);
  janitor.unref?.();
  ledger.startTimers();

  return {
    noteConnection({ connected, lastReadyAt, username }) {
      connectedNow = connected;
      try {
        store.setControl('connected', connected ? 'true' : 'false', 'connection');
        if (lastReadyAt) store.setControl('last_ready_at', lastReadyAt, 'connection');
        if (username) store.setControl('ready_username', username, 'connection');
      } catch {
        log('status_error', { reason: 'connection' });
      }
      downWatch.check(connected);
    },
    stop() {
      clearInterval(heartbeat);
      clearInterval(janitor);
      clearInterval(downTimer);
    },
  };
}

export function takeRestartSlot(store, now = Date.now) {
  const at = now();
  return store.bumpCounter(`conn_restart:${utcDay(at)}`, at + 2 * 86400000, LIVENESS_RESTARTS_PER_DAY).ok;
}

/**
 * Runs the connection until abort or failure. Resolves to { outcome: 'ended' }, { outcome: 'fatal', closeCode }
 * or { outcome: 'failed' }; never throws. A fatal close is latched before this resolves.
 */
export async function connectAccount({ account, abortSignal, gate, exitDeps, onExit, onStatus, store, log, dbPath, userAgent, probeIntervalMs }) {
  const alert = alertQuietly(store, log);
  try {
    await runConnection({
      account,
      abortSignal,
      onInbound: (evt) => gate.onInbound(evt),
      exitDeps,
      onExit: (exit) => {
        onExit(exit);
        gate.attachExit(exit);
      },
      onStatus,
      onAlert: alert,
      takeRestartSlot: () => takeRestartSlot(store),
      log,
      userAgent,
      ...(probeIntervalMs === undefined ? {} : { probeIntervalMs }),
    });
    return { outcome: 'ended' };
  } catch (err) {
    // A fatal close stays stopped. The code is quoted as is; the cause is not inferred.
    if (typeof err?.closeCode === 'number') {
      const savedToFile = saveCloseFile(dbPath, err.closeCode);
      try {
        store.setControl('terminal_close', err.closeCode, 'connection');
        if (savedToFile) dropCloseFile(dbPath);
      } catch {
        log('status_error', { reason: 'terminal_close' });
        if (!savedToFile) unsavedClose = err.closeCode;
      }
      alert('terminal_close', { closeCode: err.closeCode });
      log('connection_fatal', { closeCode: err.closeCode });
      return { outcome: 'fatal', closeCode: err.closeCode };
    }
    const kind = String(err?.name ?? 'Error').slice(0, 32);
    log('connection_error', { kind });
    alert('connection_failed', { kind });
    return { outcome: 'failed' };
  }
}

/**
 * The stop order: timers, then the exit and the gate (which waits out its grace for turns in flight), then the
 * connected flag, and the services (the store) last. Every step runs, whatever the one before it did.
 */
export async function stopRun({ controls, getExit, gate, store, log, closeServices }) {
  controls?.stop();
  try {
    getExit()?.stop();
    await gate?.stop();
  } catch {
    log('status_error', { reason: 'stop' });
  }
  try {
    store.setControl('connected', 'false', 'connection');
  } catch {
    log('status_error', { reason: 'connection' });
  }
  try {
    closeServices();
  } catch {
    log('status_error', { reason: 'services' });
  }
}
