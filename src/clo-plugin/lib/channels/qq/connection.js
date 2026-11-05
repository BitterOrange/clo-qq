// The only module that imports the SDK or constructs QQBot. It hands the object to createExit and
// nothing else. Everything leaving here towards the gate is a copied, normalized event.
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { createExit } from './exit.js';
import { normalize } from './normalize.js';

export const QQ_INTENTS = 1 << 25;

const FATAL_CLOSES = new Set([4914, 4915]);
const RESTART_DELAYS_MS = [5000, 15000, 30000, 60000];
const ALERT_AFTER_FAILURES = 10;
const PROBE_INTERVAL_MS = 60000;

export const isFatalClose = (err) => FATAL_CLOSES.has(err?.closeCode);

function sleepUntilAborted(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener('abort', done, { once: true });
  });
}

// REST failing and then recovering while the SDK still believes it is connected suggests a half-open
// socket, since the SDK ignores heartbeat acks. Rebuilding spends a session start, so it is capped.
// One failed probe proves little: on a lossy path single failures are routine while the socket works, and rebuilding drops live traffic.
// So only a run of consecutive failures counts as failing.
export const PROBE_FAILS_TO_SUSPECT = 3;

// A READY or RESUMED newer than the first failed probe means the SDK already rebuilt the socket during the
// outage, so a recovery proves nothing about it. The cost: a socket that came back and then went half-open
// within the same run of failures is not rebuilt this time.
export function createLivenessMonitor({ probe, isConnected, restart, takeRestartSlot, lastConnectedAt = () => null, now = Date.now, log = () => {}, intervalMs = PROBE_INTERVAL_MS, setTimer = setInterval, clearTimer = clearInterval, failsToSuspect = PROBE_FAILS_TO_SUSPECT }) {
  let timer = null;
  let failing = false;
  let failingSince = null;
  let consecutiveFails = 0;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const probedAt = now();
      const ok = await probe();
      if (!ok) {
        consecutiveFails += 1;
        failingSince ??= probedAt;
        if (!failing && consecutiveFails >= failsToSuspect) {
          log('liveness_probe', { state: 'failing' });
          failing = true;
        }
        return;
      }
      consecutiveFails = 0;
      const since = failingSince;
      failingSince = null;
      if (!failing) return;
      failing = false;
      log('liveness_probe', { state: 'recovered' });
      if (!isConnected()) return;
      if ((lastConnectedAt() ?? 0) > since) {
        log('liveness_restart', { state: 'already_reconnected' });
        return;
      }
      if (!takeRestartSlot()) {
        log('liveness_restart', { state: 'cap_reached' });
        return;
      }
      log('liveness_restart', { state: 'restarting' });
      restart();
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() {
      if (timer) return;
      timer = setTimer(() => {
        tick().catch(() => log('liveness_probe', { state: 'error' }));
      }, intervalMs);
      timer?.unref?.();
    },
    stop() {
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}

export const DOWN_ALERT_AFTER_MS = 10 * 60000;
// A gap in the heartbeat longer than this means the process or the channel was off, not that a host restart passed.
export const DOWN_CONTINUITY_MS = 5 * 60000;
const DOWN_SINCE_KEY = 'conn_down_since';
const DOWN_ALERTED_KEY = 'conn_down_alerted';

// The host health monitor stops and restarts a channel that stays disconnected, which ends runConnection and
// everything local to it, so the start of an outage has to live in the store. It only ever adds a status line.
export function createDownWatch({ store, log = () => {}, now = Date.now, alertAfterMs = DOWN_ALERT_AFTER_MS, continuityMs = DOWN_CONTINUITY_MS }) {
  const clear = () => {
    store.delControl(DOWN_SINCE_KEY);
    store.delControl(DOWN_ALERTED_KEY);
  };
  const guarded = (fn) => {
    try {
      fn();
    } catch {
      log('status_error', { reason: 'connection_down' });
    }
  };
  return {
    // Call with the heartbeat read before this start wrote its own.
    begin(lastHeartbeatAt) {
      guarded(() => {
        if (lastHeartbeatAt === null || !(now() - Number(lastHeartbeatAt) <= continuityMs)) clear();
      });
    },
    // Idempotent, so a write lost to a locked database is made up on the next call.
    check(connected) {
      guarded(() => {
        const since = store.getControl(DOWN_SINCE_KEY);
        if (connected) {
          if (since !== null) clear();
          return;
        }
        const at = now();
        if (since === null) {
          store.setControl(DOWN_SINCE_KEY, at, 'connection');
          return;
        }
        const durationMs = at - Number(since);
        if (durationMs < alertAfterMs || store.getControl(DOWN_ALERTED_KEY) === since) return;
        store.addAlert('connection_down', { durationMs });
        store.setControl(DOWN_ALERTED_KEY, since, 'connection');
      });
    },
  };
}

// Resolves after abort and socket close. Throws only on a fatal close, which the caller latches.
// exitDeps are passed to createExit; onExit receives the exit, the one object that may send.
export async function runConnection({ account, abortSignal, onInbound, exitDeps, onExit, onStatus = () => {}, onAlert = () => {}, takeRestartSlot = () => true, log = () => {}, userAgent, probeIntervalMs = PROBE_INTERVAL_MS }) {
  const bot = new QQBot({
    appId: account.appId,
    appSecret: account.clientSecret,
    accountId: account.accountId,
    baseUrl: account.apiBaseUrl || undefined,
    tokenBaseUrl: account.tokenBaseUrl || undefined,
    intents: QQ_INTENTS,
    userAgent,
  });
  const exit = createExit({ bot, appId: account.appId, ...exitDeps });
  onExit(exit);

  let connected = false;
  let failures = 0;
  let lastReadyAt = null;
  let lastResumedAt = null;
  let lastDisconnectCode = null;
  // Runs inside SDK handlers and in the catch below that must still see a fatal close, so it never throws.
  const publish = (extra = {}) => {
    try {
      onStatus({ connected, lastReadyAt, lastResumedAt, lastDisconnectCode, ...extra });
    } catch {
      log('status_error', { reason: 'publish' });
    }
  };
  const raiseAlert = (kind, detail) => {
    try {
      onAlert(kind, detail);
    } catch {
      log('status_error', { reason: 'alert' });
    }
  };

  bot.on('ready', (data) => {
    connected = true;
    failures = 0;
    lastReadyAt = Date.now();
    log('connection_ready', {});
    publish({ username: typeof data?.user?.username === 'string' ? data.user.username : null });
  });
  bot.on('resumed', () => {
    connected = true;
    failures = 0;
    lastResumedAt = Date.now();
    log('connection_resumed', {});
    publish();
  });
  bot.on('disconnected', (e) => {
    connected = false;
    lastDisconnectCode = typeof e?.code === 'number' ? e.code : null;
    log('connection_disconnected', { closeCode: lastDisconnectCode, state: e?.willReconnect === false ? 'final' : 'retrying' });
    publish();
  });
  bot.on('error', (err) => {
    log('connection_error', { kind: String(err?.name ?? 'Error').slice(0, 32), code: typeof err?.code === 'string' ? err.code.slice(0, 64) : null, httpStatus: Number.isInteger(err?.httpStatus) ? err.httpStatus : null });
  });
  // Read for each message, so the switch works from the effective file with no restart.
  const keepDisplayName = (groupId) => {
    const groups = exitDeps.getEffective?.()?.qq?.groups;
    return Boolean(groups && Object.hasOwn(groups, groupId)) && groups[groupId]?.displayNames === true;
  };
  bot.on('message', (_ctx, msg) => {
    const evt = normalize(msg.rawEventType, structuredClone(msg.raw), { receivedAt: Date.now(), keepDisplayName });
    if (!evt) {
      log('gate_drop', { reason: 'unknown_event', kind: String(msg.rawEventType ?? '').slice(0, 64) });
      return;
    }
    // Do not hold the SDK's event loop for the length of an agent run.
    void Promise.resolve().then(() => onInbound(evt)).catch(() => log('gate_error', { reason: 'inbound' }));
  });

  const liveness = createLivenessMonitor({
    probe: () => exit.probe(),
    isConnected: () => connected,
    restart: () => bot.stop(),
    takeRestartSlot,
    lastConnectedAt: () => Math.max(lastReadyAt ?? 0, lastResumedAt ?? 0),
    log,
    intervalMs: probeIntervalMs,
  });

  log('connection_open', { code: QQ_INTENTS });
  liveness.start();
  try {
    while (!abortSignal.aborted) {
      try {
        await bot.start(abortSignal);
        // Only a liveness restart returns here without an abort.
        connected = false;
        publish();
      } catch (err) {
        connected = false;
        publish();
        if (isFatalClose(err)) throw err;
        if (abortSignal.aborted) return;
        failures += 1;
        log('connection_start_failed', { attempt: failures, code: typeof err?.code === 'string' ? err.code.slice(0, 64) : null });
        if (failures === ALERT_AFTER_FAILURES) raiseAlert('connection_failing', { count: failures });
        const delay = RESTART_DELAYS_MS[Math.min(failures - 1, RESTART_DELAYS_MS.length - 1)];
        await sleepUntilAborted(delay, abortSignal);
      }
    }
  } finally {
    liveness.stop();
    bot.stop();
    log('connection_closed', {});
  }
}
