// The clo-qq channel on @tencent-connect/qqbot-nodejs, for OpenClaw. Group chat only in this build.
import {
  createChannelPluginBase,
  createChatChannelPlugin,
  defineChannelPluginEntry,
} from 'openclaw/plugin-sdk/channel-core';
import { defineStableChannelIngressIdentity } from 'openclaw/plugin-sdk/channel-ingress-runtime';
import { createGate } from './lib/core/gate.js';
import { utcDay } from './lib/core/ids.js';
import { runConnection } from './lib/channels/qq/connection.js';
import { createDispatcher } from './lib/channels/qq/dispatch.js';
import { registerHooks } from './lib/channels/qq/hooks.js';
import { attachUsage, getServices, liveSecrets, stopServices } from './lib/channels/qq/services.js';
import { registerTools } from './lib/channels/qq/tools.js';

const CHANNEL_ID = 'clo-qq';
const ACCOUNT_ID = 'default';
const USER_AGENT = `clo-qq/1 (Node/${process.versions.node})`;
const HEARTBEAT_MS = 30000;
const JANITOR_MS = 3600000;
// Well below the 1000 a day session_start_limit the plan records. The SDK's own reconnects also count.
const LIVENESS_RESTARTS_PER_DAY = 100;

const identity = defineStableChannelIngressIdentity({
  key: 'clo-peer',
  // Peer ids are derived hashes, lowercase by construction.
  normalize: (value) => (typeof value === 'string' && value ? value : null),
  sensitivity: 'pii',
});

let pluginRuntime = null;
let pluginConfig = null;
let sendAttemptLog = () => {};

const section = (cfg) => cfg?.channels?.[CHANNEL_ID] ?? null;

function resolveAccount(cfg, accountId) {
  const s = section(cfg) ?? {};
  return {
    accountId: accountId ?? ACCOUNT_ID,
    enabled: s.enabled === true,
    appId: s.appId ?? '',
    clientSecret: process.env.CLO_QQ_APP_SECRET ?? '',
    apiBaseUrl: s.apiBaseUrl ?? '',
    tokenBaseUrl: s.tokenBaseUrl ?? '',
  };
}

const isConfigured = (account) => Boolean(account.appId && account.clientSecret);

function effectivePathOf(cfg) {
  return cfg?.plugins?.entries?.clo?.config?.effectivePath ?? pluginConfig?.effectivePath ?? null;
}

/** Picks the host channel helpers. The host type says external plugins must handle their absence. */
export function pickChannelRuntime(ctxRuntime, fallbackRuntime, override) {
  if (override === 'none') return null;
  if (override === 'fallback') return fallbackRuntime ?? null;
  return ctxRuntime ?? fallbackRuntime ?? null;
}

const testOverride = () => (process.env.CLO_TEST_ROOT ? process.env.CLO_TEST_IGNORE_HOST_RUNTIME : undefined);

function terminal(ctx, lastError) {
  // terminalDisconnect stops the host's auto-restart, which would otherwise retry an empty start.
  ctx.setStatus({ ...ctx.getStatus(), running: false, connected: false, terminalDisconnect: true, lastError });
}

async function startAccount(ctx) {
  const { account } = ctx;
  const rt = pickChannelRuntime(ctx.channelRuntime, pluginRuntime?.channel, testOverride());
  let services;
  try {
    services = getServices(effectivePathOf(ctx.cfg));
  } catch {
    terminal(ctx, 'services unavailable');
    return;
  }
  const { store, ledger, policy, getEffective, decide, log } = services;
  sendAttemptLog = log;
  const started = Date.now();
  log('start_account', {
    kind: ctx.channelRuntime ? 'ctx.channelRuntime' : 'none',
    source: rt && rt === ctx.channelRuntime ? 'ctx.channelRuntime' : (rt ? 'api.runtime.channel' : 'none'),
  });
  if (!rt) {
    // No way to dispatch: staying offline is safer than consuming messages that cannot be answered.
    log('start_refused', { reason: 'no_channel_runtime' });
    terminal(ctx, 'channel runtime unavailable');
    return;
  }
  const appEnv = process.env.CLO_QQ_APP_ID;
  if (!isConfigured(account) || (appEnv && appEnv !== account.appId) || getEffective()?.qq?.appId !== account.appId) {
    log('start_refused', { reason: 'account' });
    store.addAlert('account_mismatch', {});
    terminal(ctx, 'account does not match configuration');
    return;
  }
  const latched = store.getControl('terminal_close');
  if (latched !== null) {
    log('start_refused', { reason: 'terminal', closeCode: Number(latched) });
    terminal(ctx, `gateway closed with code ${latched}`);
    return;
  }

  // This process's environment is fixed now. Salted hash only: clo mode live compares it with .env.
  store.setControl('gateway_key', process.env.OPENROUTER_API_KEY ? store.key(process.env.OPENROUTER_API_KEY) : 'none', 'start');
  const recovered = store.recoverOnStart(started);
  log('recovery', { count: recovered.crash_unknown + recovered.restart_dropped, reason: recovered.paid_paused ? 'crash_unsettled' : null });
  store.janitor(started, getEffective().retention);
  const usage = await attachUsage(services);

  let exitRef = null;
  const dispatchTurn = createDispatcher({ rt, getCfg: () => ctx.cfg, account, getExit: () => exitRef, identity, usage, log });
  const gate = createGate({ store, ledger, policy, getEffective, decide, dispatchTurn, log });

  const onStatus = ({ connected, lastReadyAt, lastResumedAt, lastDisconnectCode, username }) => {
    store.setControl('connected', connected ? 'true' : 'false', 'connection');
    if (lastReadyAt) store.setControl('last_ready_at', lastReadyAt, 'connection');
    if (username) store.setControl('ready_username', username, 'connection');
    ctx.setStatus({
      ...ctx.getStatus(),
      connected,
      lastConnectedAt: lastResumedAt ?? lastReadyAt ?? undefined,
      lastDisconnect: lastDisconnectCode === null ? undefined : { at: Date.now(), status: lastDisconnectCode },
    });
  };

  const beat = () => {
    try {
      store.setControl('heartbeat_at', Date.now(), 'heartbeat');
    } catch {
      log('heartbeat_error', {});
    }
  };
  beat();
  const heartbeat = setInterval(beat, HEARTBEAT_MS);
  heartbeat.unref?.();
  const janitor = setInterval(() => {
    try {
      const eff = getEffective();
      if (eff) store.janitor(Date.now(), eff.retention);
    } catch {
      log('janitor_error', {});
    }
  }, JANITOR_MS);
  janitor.unref?.();
  ledger.startTimers();

  ctx.setStatus({ ...ctx.getStatus(), running: true, connected: false, lastStartAt: started, terminalDisconnect: false, lastError: null });

  const takeRestartSlot = () => {
    const at = Date.now();
    return store.bumpCounter(`conn_restart:${utcDay(at)}`, at + 2 * 86400000, LIVENESS_RESTARTS_PER_DAY).ok;
  };
  const stopAll = async () => {
    clearInterval(heartbeat);
    clearInterval(janitor);
    exitRef?.stop();
    await gate.stop();
    try {
      store.setControl('connected', 'false', 'connection');
    } catch {
      log('status_error', {});
    }
    stopServices();
  };

  try {
    await runConnection({
      account,
      abortSignal: ctx.abortSignal,
      onInbound: (evt) => gate.onInbound(evt),
      exitDeps: { store, policy, getEffective, secrets: liveSecrets, log },
      onExit: (exit) => {
        exitRef = exit;
        gate.attachExit(exit);
      },
      onStatus,
      onAlert: (kind, detail) => store.addAlert(kind, detail),
      takeRestartSlot,
      log,
      userAgent: USER_AGENT,
    });
  } catch (err) {
    // A fatal close stays stopped. The code is quoted as is; the cause is not inferred.
    if (typeof err?.closeCode === 'number') {
      store.setControl('terminal_close', err.closeCode, 'connection');
      store.addAlert('terminal_close', { closeCode: err.closeCode });
      log('connection_fatal', { closeCode: err.closeCode });
      await stopAll();
      terminal(ctx, `gateway closed with code ${err.closeCode}`);
      return;
    }
    log('connection_error', { kind: String(err?.name ?? 'Error').slice(0, 32) });
    await stopAll();
    terminal(ctx, 'connection failed');
    return;
  }
  await stopAll();
  ctx.setStatus({ ...ctx.getStatus(), running: false, connected: false, lastStopAt: Date.now() });
}

const base = createChannelPluginBase({
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: 'Clo QQ',
    selectionLabel: 'Clo QQ',
    docsPath: '/channels/clo-qq',
    blurb: 'Clo QQ channel.',
  },
  capabilities: { chatTypes: ['group'] },
  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
  config: {
    // qq disabled means no account, so startAccount is never called.
    listAccountIds: (cfg) => (section(cfg)?.enabled === true ? [ACCOUNT_ID] : []),
    resolveAccount,
    isEnabled: (account) => account.enabled,
    isConfigured,
    inspectAccount: (cfg, accountId) => {
      const account = resolveAccount(cfg, accountId);
      return { accountId: account.accountId, enabled: account.enabled, configured: isConfigured(account) };
    },
  },
  setup: {
    applyAccountConfig: ({ cfg }) => cfg,
  },
});

const channelPlugin = {
  ...createChatChannelPlugin({ base }),
  gateway: { startAccount },
  outbound: {
    deliveryMode: 'direct',
    // Nothing may send outside a reply to an admitted inbound message. There is no row that could allow it.
    sendText: async () => {
      sendAttemptLog('outbound_send_attempt', {});
      throw new Error('clo-qq: outbound.sendText is closed; replies go through the inbound turn only');
    },
  },
};

export default defineChannelPluginEntry({
  id: 'clo',
  name: 'Clo',
  description: 'Clo QQ channel.',
  plugin: channelPlugin,
  setRuntime: (runtime) => {
    pluginRuntime = runtime;
  },
  registerFull(api) {
    pluginConfig = api.pluginConfig ?? null;
    registerTools(api);
    registerHooks(api, { getServices: () => getServices(pluginConfig?.effectivePath) });
  },
});
