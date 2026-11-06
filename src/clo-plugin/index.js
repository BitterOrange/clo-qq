// The clo-qq channel on @tencent-connect/qqbot-nodejs, for OpenClaw. Group chat only in this build.
import {
  createChannelPluginBase,
  createChatChannelPlugin,
  defineChannelPluginEntry,
} from 'openclaw/plugin-sdk/channel-core';
import { defineStableChannelIngressIdentity } from 'openclaw/plugin-sdk/channel-ingress-runtime';
import { createGate } from './lib/core/gate.js';
import { createDispatcher } from './lib/channels/qq/dispatch.js';
import { registerHooks } from './lib/channels/qq/hooks.js';
import { attachUsage, getServices, liveSecrets, stopServices } from './lib/channels/qq/services.js';
import { accountMismatch, beginRun, checkStartLatch, connectAccount, liveBotLease, runtimeOf, startControls, stopRun } from './lib/channels/qq/startup.js';
import { registerTools } from './lib/channels/qq/tools.js';

const CHANNEL_ID = 'clo-qq';
const ACCOUNT_ID = 'default';
const USER_AGENT = `clo-qq/1 (Node/${process.versions.node})`;

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

/** Wraps dispatchTurn so the host's health policy sees a running turn as busy, not as a channel to restart. */
export function trackRuns(dispatchTurn, ctx, now = Date.now) {
  let active = 0;
  let startedAt = null;
  // A status report must not change how a turn ends.
  const report = (at) => {
    try {
      ctx.setStatus({ ...ctx.getStatus(), busy: active > 0, activeRuns: active, activeRunStartedAt: active > 0 ? startedAt : null, lastRunActivityAt: at });
    } catch {
      // Without the report the host may restart the channel mid-turn, and nothing here can prevent that.
    }
  };
  return async (...args) => {
    const at = now();
    if (active === 0) startedAt = at;
    active += 1;
    report(at);
    try {
      return await dispatchTurn(...args);
    } finally {
      active -= 1;
      report(now());
    }
  };
}

export async function startAccount(ctx) {
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
  // One consumer per AppID: with the own runtime configured, the bot process is the one that connects.
  if (runtimeOf(getEffective()) !== 'openclaw') {
    log('start_refused', { reason: 'runtime' });
    terminal(ctx, 'another runtime is configured');
    return;
  }
  // A bot clo lost track of (no PID record) may still hold the account under the old runtime: it listens on no port,
  // so only its lease shows it. Connecting beside it would make two consumers of one AppID.
  if (liveBotLease({ store }) !== null) {
    log('start_refused', { reason: 'running', kind: 'bot' });
    terminal(ctx, 'another consumer holds the account');
    return;
  }
  if (accountMismatch({ appId: account.appId, secret: account.clientSecret, envAppId: process.env.CLO_QQ_APP_ID, eff: getEffective() })) {
    log('start_refused', { reason: 'account' });
    store.addAlert('account_mismatch', {});
    terminal(ctx, 'account does not match configuration');
    return;
  }
  const dbPath = getEffective().paths.db;
  const latched = checkStartLatch({ store, dbPath, log });
  if (latched !== null) {
    log('start_refused', { reason: 'terminal', closeCode: Number(latched) });
    terminal(ctx, `gateway closed with code ${latched}`);
    return;
  }

  beginRun({ store, getEffective, log, started, key: process.env.OPENROUTER_API_KEY });
  const usage = await attachUsage(services);

  let exitRef = null;
  const dispatchTurn = trackRuns(createDispatcher({ rt, getCfg: () => ctx.cfg, account, getExit: () => exitRef, identity, usage, log }), ctx);
  const gate = createGate({ store, ledger, policy, getEffective, decide, dispatchTurn, log });
  const controls = startControls({ store, ledger, getEffective, log });

  // The host's view comes first: a locked database must not leave it believing an old state.
  const onStatus = (state) => {
    const { connected, lastReadyAt, lastResumedAt, lastDisconnectCode } = state;
    ctx.setStatus({
      ...ctx.getStatus(),
      connected,
      lastConnectedAt: lastResumedAt ?? lastReadyAt ?? undefined,
      lastDisconnect: lastDisconnectCode === null ? undefined : { at: Date.now(), status: lastDisconnectCode },
    });
    controls.noteConnection(state);
  };

  ctx.setStatus({ ...ctx.getStatus(), running: true, connected: false, lastStartAt: started, terminalDisconnect: false, lastError: null, busy: false, activeRuns: 0, activeRunStartedAt: null });

  const result = await connectAccount({
    account,
    abortSignal: ctx.abortSignal,
    gate,
    exitDeps: { store, policy, getEffective, secrets: liveSecrets, log },
    onExit: (exit) => {
      exitRef = exit;
    },
    onStatus,
    store,
    log,
    dbPath,
    userAgent: USER_AGENT,
  });
  // The host still has to hear terminal once everything has stopped.
  await stopRun({ controls, getExit: () => exitRef, gate, store, log, closeServices: stopServices });
  if (result.outcome === 'fatal') {
    terminal(ctx, `gateway closed with code ${result.closeCode}`);
    return;
  }
  if (result.outcome === 'failed') {
    terminal(ctx, 'connection failed');
    return;
  }
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
