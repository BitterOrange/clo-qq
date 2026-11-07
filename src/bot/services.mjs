// The durable services of the own runtime, one set per process, built from effective.json. No host import.
// The main reply and the judging model share one chat client, for the provider the effective file names when the
// services open; the turn runner hands its text to the exit.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createEffectiveReader } from '../clo-plugin/lib/core/config.js';
import { loadPolicy } from '../clo-plugin/lib/core/contentPolicy.js';
import { createDecider } from '../clo-plugin/lib/core/decision.js';
import { createLedger } from '../clo-plugin/lib/core/ledger.js';
import { createLog } from '../clo-plugin/lib/core/log.js';
import { adapterFor } from '../clo-plugin/lib/core/providers/index.js';
import { createChatClient } from '../clo-plugin/lib/core/providers/modelChat.js';
import {
  CHILD_KEY, hardCapControlKey, hardCapPauseKey, LIVE_CODES, liveStartCheck, providerOfEffective, providerRulesRecorded,
} from '../clo-plugin/lib/core/providers/registry.js';
import { openStore } from '../clo-plugin/lib/core/store.js';
import { createTurnRunner } from '../clo-plugin/lib/core/turn.js';

// clo start passes the active kind's Key under that kind's child name (OPENROUTER_API_KEY, the Gateway's name, for
// OpenRouter). Every caller names the kind it runs on: without it this reads the OpenRouter name, which an Anthropic
// run does not have.
export const keyOf = (env, kind = 'openrouter') => (typeof kind === 'string' && Object.hasOwn(CHILD_KEY, kind) ? env[CHILD_KEY[kind]] || null : null);

/** Every secret this process holds. The exit refuses text that contains one. */
export function liveSecrets(env) {
  return [env.CLO_QQ_APP_SECRET, env.OPENROUTER_API_KEY, env.CLO_PROVIDER_API_KEY].filter(Boolean);
}

/**
 * Where this process may send a request for kind: the base URL of the provider the effective file names now, or null
 * when the file is unreadable, names no provider or names another kind. So a Key never goes to another provider, or to
 * a default address, after the file changes under a running process.
 */
export function providerBaseOf(getEffective, kind) {
  const eff = getEffective();
  if (!eff) return null;
  const p = providerOfEffective(eff);
  if (!p || p.kind !== kind) return null;
  // The implicit OpenRouter entry sends where it always did, to openrouter.baseUrl, and to no default when that is unset.
  const base = p.implicit ? eff.openrouter?.baseUrl : p.baseUrl;
  return typeof base === 'string' && base !== '' ? base : null;
}

// The provider's answer as the runner judged it. The gate counts the streak from the result of a turn that started,
// so the runner reports to this recorder instead of the ledger, and nothing is counted twice.
function providerRecorder() {
  let noted = null;
  return {
    sink: {
      noteProviderOk() {
        noted = { ok: true };
      },
      noteProviderError({ httpStatus = null, limitSource = null } = {}) {
        noted = { ok: false, httpStatus, limitSource };
      },
    },
    get: () => noted,
  };
}

/**
 * The start check again, at the last point before a Key leaves this process: true when the Key may be used now.
 * A kind whose spend rests on the Key's own limit and whose rules are recorded (OpenRouter) needs nothing more. On any
 * other kind, unless the file reads dry-run (where the gate sends nothing), the check runs as in live mode on the file
 * as it is now and on the Key held. So a file edited to live while the process runs, or a start check that saw no
 * live file, cannot carry paid work past an unattested cap or an unrecorded rule (docs/provider-contract.md 11.3).
 * A failure pauses paid work under the hard-cap pause, as the start check does. Any failure to read says no.
 */
export function keyUseAllowed({ getEffective, store, ledger, provider, key }) {
  if (!provider) return false;
  if (provider.caps?.hardCap !== 'attested' && providerRulesRecorded(provider.kind)) return true;
  try {
    const eff = getEffective();
    if (!eff) return false;
    if (eff.mode === 'dry-run') return true;
    const check = liveStartCheck({
      provider,
      mode: 'live',
      ack: eff.apiProvider?.hardCap ?? null,
      control: store.getControl(hardCapControlKey(provider.kind)),
      keyFp: key ? store.key(key) : null,
    });
    if (check.ok) return true;
    if (check.code === LIVE_CODES.hardCap || check.code === LIVE_CODES.providerRules) ledger?.pauseHardCap(provider.kind, 'request', check.code);
    return false;
  } catch {
    return false;
  }
}

/**
 * Before the client's one retry of a request that never left: the turn may go on only while the bot is live and
 * nothing it belongs to is paused. Any failure to read says no.
 */
export function retryAllowed({ getEffective, store }, turn) {
  try {
    const eff = getEffective();
    if (!eff || eff.mode !== 'live' || eff.qq?.enabled !== true) return false;
    const p = store.pauseState(turn?.groupKey ?? null);
    if (p.global || p.group || p.terminal || p.paid) return false;
    // The hard-cap pause of the kind spending now, which lives beside paid_paused.
    const prov = providerOfEffective(eff);
    return Boolean(prov) && store.getControl(hardCapPauseKey(prov.kind)) === null;
  } catch {
    return false;
  }
}

/**
 * The own runtime's dispatchTurn: the turn runner with the alerts, the retry check and the provider verdict wired in.
 * A started turn the runner judged a provider failure carries { info: { status, limitSource } } for the gate, which
 * counts the streak and pauses on a Key or credit limit. A turn that did not start is not counted by the gate, so a
 * failure the runner still blames on the provider (a connection that keeps failing) is counted here.
 */
export function createOwnDispatch({ makeRunner, client, getEffective, readSystemPrompt, getExit, log, now, store, ledger }) {
  const addAlert = (kind, detail) => store.addAlert(kind, detail);
  const beforeRetry = (turn) => retryAllowed({ getEffective, store }, turn);
  return async function dispatchTurn(turn, opts) {
    const verdict = providerRecorder();
    const runner = makeRunner({ client, getEffective, readSystemPrompt, getExit, log, now, ledger: verdict.sink, addAlert, beforeRetry });
    const result = await runner(turn, opts);
    const noted = verdict.get();
    if (!noted || noted.ok || !result || typeof result !== 'object') return result;
    if (result.started === false) {
      try {
        ledger.noteProviderError({ httpStatus: noted.httpStatus, limitSource: noted.limitSource });
      } catch {
        log('ledger_error', { reason: 'provider_error' });
      }
      return result;
    }
    return { ...result, info: result.info ?? { status: noted.httpStatus, limitSource: noted.limitSource } };
  };
}

/**
 * Opens the services, or throws before anything is open when effective.json is missing or invalid.
 * The provider is the one effective.json names now; a later change to it reaches no request (providerBaseOf), and
 * the process must be restarted to use another. With no provider named, nothing is ever sent.
 * factories replaces the client and turn-runner constructors, for tests only.
 */
export function openBotServices(effectivePath, { env = process.env, fetch = globalThis.fetch, now = Date.now, factories = {} } = {}) {
  if (!effectivePath) throw new Error('effective path is not set');
  const getEffective = createEffectiveReader(effectivePath);
  const eff = getEffective();
  if (!eff) throw new Error('effective config is missing or invalid');
  const cp = eff.contentPolicy;
  const policy = loadPolicy({ policyFile: cp.policyFile, sha256: cp.sha256, rulesFile: cp.rulesFile, crisisFile: cp.crisisFile });
  const runGen = randomUUID();
  const log = createLog(eff.paths.eventLog, { gen: runGen.slice(0, 8) });
  const store = openStore(eff.paths.db, { runGen });
  const provider = providerOfEffective(eff);
  const kind = provider?.kind ?? null;
  // The Key of the kind opened with, and only while the file still names that kind: the ledger's Key read and the
  // decider both go through this too. On a kind whose cap is attested it is also the start check again (keyUseAllowed).
  let ledger;
  const getKey = () => {
    if (kind === null || providerBaseOf(getEffective, kind) === null) return null;
    const key = keyOf(env, kind);
    return key !== null && keyUseAllowed({ getEffective, store, ledger, provider, key }) ? key : null;
  };
  const getBaseUrl = () => (kind === null ? null : providerBaseOf(getEffective, kind));
  // With no provider there is no adapter to pick. The OpenRouter one stands in, under a Key that is always null.
  const adapter = adapterFor(kind ?? 'openrouter');
  const makeClient = factories.createChatClient ?? createChatClient;
  const makeRunner = factories.createTurnRunner ?? createTurnRunner;
  try {
    ledger = createLedger({ store, getEffective, fetch, getKey, log, now, runtime: 'own' });
    const client = makeClient({ adapter, fetch, getKey, getBaseUrl, log, now });
    const decide = createDecider({ fetch, client, getKey, getEffective, log, now });
    // Read at each turn, so the bytes the runner checks are the bytes on disk now. Missing reads as null.
    const readSystemPrompt = () => {
      const file = getEffective()?.paths?.systemPromptFile;
      if (!file) return null;
      try {
        return readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    };
    let closed = false;
    return {
      effectivePath, store, ledger, policy, getEffective, decide, log, runGen, client, getKey, readSystemPrompt, provider,
      secrets: () => liveSecrets(env),
      /** The dispatchTurn the gate calls. getExit returns the exit once the connection has made it. */
      createDispatch(getExit) {
        return createOwnDispatch({ makeRunner, client, getEffective, readSystemPrompt, getExit, log, now, store, ledger });
      },
      close() {
        if (closed) return;
        closed = true;
        try {
          ledger.stopTimers();
        } finally {
          store.close();
        }
      },
    };
  } catch (err) {
    ledger?.stopTimers();
    store.close();
    throw err;
  }
}
