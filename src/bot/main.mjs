// Process entry of the own runtime: clo start runs it with the private Node and an allowlisted environment.
// One QQ connection, one gate, one exit. It listens on no port and imports no host. clo status and
// clo mode live read what it writes into clo.db, the same controls the OpenClaw plugin writes.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGate } from '../clo-plugin/lib/core/gate.js';
import {
  accountMismatch, beginRun, checkStartLatch, claimConsumerLease, connectAccount, holdsConsumerLease, pidAlive, releaseConsumerLease,
  renewConsumerLease, runtimeOf, startControls, stopRun, STOP_REQUEST_KEY,
} from '../clo-plugin/lib/channels/qq/startup.js';
import { keyOf, openBotServices } from './services.mjs';

const USER_AGENT = `clo-qq/1 (Node/${process.versions.node})`;
const ACCOUNT_ID = 'default';

// The exit codes clo start can report when the process ends early.
export const EXIT = Object.freeze({ ok: 0, config: 2, refused: 3, terminal: 4, failed: 5, fatal: 70 });

// A stop clo can ask for without killing the process (lease.js), polled this often.
export { STOP_REQUEST_KEY };
const STOP_POLL_MS = 1000;
// Every timer of a run is unref'd, and a run waiting out a reconnect delay has no socket open. This one holds the
// event loop until the run has ended, so the process never just drains away mid-run.
const KEEP_ALIVE_MS = 2 ** 30;

/** The class of an error, and nothing from its message: provider text may sit there. */
export function errorClass(err) {
  if (err === null || (typeof err !== 'object' && typeof err !== 'function')) return typeof err;
  const name = err.constructor?.name;
  return typeof name === 'string' && /^[A-Za-z_$][\w$]{0,31}$/.test(name) ? name : 'Error';
}

let processLog = null;

/**
 * Process-level handlers: what reaches them is logged by class only, then the process ends. Default Node
 * output would print the message and stack, which may hold provider text. recoverOnStart deals with what was open.
 */
export function installProcessHandlers({ proc = process, exit = (code) => proc.exit(code), write = (s) => proc.stderr.write(s) } = {}) {
  const fatal = (reason) => (err) => {
    const kind = errorClass(err);
    try {
      processLog?.('process_error', { reason, kind });
    } catch {
      // Nothing else can be done here.
    }
    try {
      write(`clo-bot: ${reason} ${kind}\n`);
    } catch {
      // Nor here.
    }
    exit(EXIT.fatal);
  };
  proc.on('uncaughtException', fatal('uncaught_exception'));
  proc.on('unhandledRejection', fatal('unhandled_rejection'));
}

/**
 * One run of the bot: refuses, or connects until the signal aborts, a stop is requested, another run takes the
 * consumer lease, or the connection ends. Resolves to { code, reason }; the services are closed by then.
 */
export async function runBot(opts = {}) {
  const keepAlive = setInterval(() => {}, KEEP_ALIVE_MS);
  try {
    return await runOnce(opts);
  } finally {
    clearInterval(keepAlive);
  }
}

async function runOnce({ env = process.env, signal = null, fetch = globalThis.fetch, factories = {}, pid = process.pid, stopPollMs = STOP_POLL_MS, probeIntervalMs, isAlive = pidAlive } = {}) {
  let services;
  try {
    services = openBotServices(env.CLO_EFFECTIVE_PATH, { env, fetch, factories });
  } catch {
    return { code: EXIT.config, reason: 'services' };
  }
  const { store, ledger, policy, getEffective, decide, log } = services;
  processLog = log;
  // This run's name in the consumer lease. The run part tells two runs in one process apart.
  const leaseToken = `${pid}:${services.runGen}`;
  const close = () => {
    processLog = null;
    try {
      releaseConsumerLease({ store, token: leaseToken });
    } catch {
      log('status_error', { reason: 'lease' });
    }
    services.close();
  };
  const refuse = (code, reason, detail = {}) => {
    log('start_refused', { reason, ...detail });
    close();
    return { code, reason };
  };
  const started = Date.now();
  log('start_account', { kind: 'own' });
  const eff = getEffective();
  // One consumer per AppID: under the OpenClaw runtime the Gateway is the one that connects.
  if (runtimeOf(eff) !== 'own') return refuse(EXIT.refused, 'runtime');
  if (eff.qq?.enabled !== true) return refuse(EXIT.refused, 'qq_disabled');
  const account = {
    accountId: ACCOUNT_ID,
    appId: eff.qq.appId ?? '',
    clientSecret: env.CLO_QQ_APP_SECRET ?? '',
    apiBaseUrl: eff.qq.apiBaseUrl ?? '',
    tokenBaseUrl: eff.qq.tokenBaseUrl ?? '',
  };
  if (accountMismatch({ appId: account.appId, secret: account.clientSecret, envAppId: env.CLO_QQ_APP_ID, eff, requireEnvAppId: true })) {
    try {
      store.addAlert('account_mismatch', {});
    } catch {
      log('status_error', { reason: 'alert' });
    }
    return refuse(EXIT.refused, 'account');
  }
  const dbPath = eff.paths.db;
  const latched = checkStartLatch({ store, dbPath, log });
  if (latched !== null) return refuse(EXIT.terminal, 'terminal', { closeCode: Number(latched) });

  // One consumer per AppID, before recovery touches any row: another live run, or a Gateway still beating, refuses this.
  let lease;
  try {
    lease = claimConsumerLease({ store, token: leaseToken, isAlive });
  } catch {
    log('status_error', { reason: 'lease' });
    close();
    return { code: EXIT.failed, reason: 'start' };
  }
  if (!lease.ok) return refuse(EXIT.refused, lease.reason, { kind: lease.holder });

  try {
    beginRun({ store, getEffective, log, started, key: keyOf(env) });
  } catch {
    log('status_error', { reason: 'start' });
    close();
    return { code: EXIT.failed, reason: 'start' };
  }

  const run = new AbortController();
  let stopReason = null;
  const stopOn = (reason) => {
    if (run.signal.aborted) return;
    stopReason = reason;
    log('bot_stop', { reason });
    run.abort();
  };
  // A run whose lease another run has taken over stops at once: that run believed this one gone.
  const leaseCheck = (renew) => {
    try {
      if (!(renew ? renewConsumerLease : holdsConsumerLease)({ store, token: leaseToken })) stopOn('lease_lost');
    } catch {
      log('status_error', { reason: 'lease' });
    }
  };

  // A valid effective file that names another runtime means this process is no longer the configured consumer: the
  // other runtime may start next. A file that cannot be read says nothing and stops nothing.
  const runtimeCheck = () => {
    const now = getEffective();
    if (now && runtimeOf(now) !== 'own') stopOn('runtime');
  };

  let exitRef = null;
  const dispatchTurn = services.createDispatch(() => exitRef);
  const gate = createGate({ store, ledger, policy, getEffective, decide, dispatchTurn, log, runtime: 'own' });
  const controls = startControls({ store, ledger, getEffective, log, onBeat: () => leaseCheck(true) });

  const onSignal = () => stopOn('signal');
  if (signal?.aborted) stopOn('signal');
  signal?.addEventListener?.('abort', onSignal, { once: true });
  const stopPoll = setInterval(() => {
    leaseCheck(false);
    runtimeCheck();
    try {
      if (store.getControl(STOP_REQUEST_KEY) !== String(pid)) return;
      store.delControl(STOP_REQUEST_KEY);
      stopOn('requested');
    } catch {
      log('status_error', { reason: 'stop_request' });
    }
  }, stopPollMs);
  stopPoll.unref?.();

  const result = await connectAccount({
    account,
    abortSignal: run.signal,
    gate,
    exitDeps: { store, policy, getEffective, secrets: services.secrets, log, runtime: 'own' },
    onExit: (exit) => {
      exitRef = exit;
    },
    onStatus: (state) => controls.noteConnection(state),
    store,
    log,
    dbPath,
    userAgent: USER_AGENT,
    probeIntervalMs,
  });
  clearInterval(stopPoll);
  signal?.removeEventListener?.('abort', onSignal);
  await stopRun({ controls, getExit: () => exitRef, gate, store, log, closeServices: close });
  if (result.outcome === 'fatal') return { code: EXIT.terminal, reason: 'terminal', closeCode: result.closeCode };
  if (result.outcome === 'failed') return { code: EXIT.failed, reason: 'connection' };
  if (stopReason === 'lease_lost') return { code: EXIT.refused, reason: 'lease_lost' };
  if (stopReason === 'runtime') return { code: EXIT.refused, reason: 'runtime' };
  return { code: EXIT.ok, reason: 'stopped' };
}

async function main() {
  installProcessHandlers();
  const stop = new AbortController();
  let signals = 0;
  const onSignal = () => {
    signals += 1;
    // A second signal means the graceful stop is taking too long for whoever sent it.
    if (signals > 1) process.exit(EXIT.failed);
    stop.abort();
  };
  for (const name of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
    try {
      process.on(name, onSignal);
    } catch {
      // Not every signal exists on every platform.
    }
  }
  const { code, reason } = await runBot({ signal: stop.signal });
  if (code !== EXIT.ok) process.stderr.write(`clo-bot: ended (${reason})\n`);
  // Handles left by fetch or the SDK must not keep a stopped bot alive. The log is written synchronously.
  process.exit(code);
}

function isEntry() {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    const a = realpathSync.native(resolve(arg));
    const b = realpathSync.native(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

if (isEntry()) await main();
