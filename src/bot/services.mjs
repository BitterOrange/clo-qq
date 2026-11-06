// The durable services of the own runtime, one set per process, built from effective.json. No host import.
// The main reply and the judging model share one OpenRouter client; the turn runner hands its text to the exit.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createEffectiveReader } from '../clo-plugin/lib/core/config.js';
import { loadPolicy } from '../clo-plugin/lib/core/contentPolicy.js';
import { createDecider } from '../clo-plugin/lib/core/decision.js';
import { createLedger } from '../clo-plugin/lib/core/ledger.js';
import { createLog } from '../clo-plugin/lib/core/log.js';
import { createOpenRouterClient } from '../clo-plugin/lib/core/openrouterChat.js';
import { openStore } from '../clo-plugin/lib/core/store.js';
import { createTurnRunner } from '../clo-plugin/lib/core/turn.js';

// clo start passes the chat Key under this name, the same one the Gateway gets.
export const keyOf = (env) => env.OPENROUTER_API_KEY || null;

/** Every secret this process holds. The exit refuses text that contains one. */
export function liveSecrets(env) {
  return [env.CLO_QQ_APP_SECRET, env.OPENROUTER_API_KEY].filter(Boolean);
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
 * Before the client's one retry of a request that never left: the turn may go on only while the bot is live and
 * nothing it belongs to is paused. Any failure to read says no.
 */
export function retryAllowed({ getEffective, store }, turn) {
  try {
    const eff = getEffective();
    if (!eff || eff.mode !== 'live' || eff.qq?.enabled !== true) return false;
    const p = store.pauseState(turn?.groupKey ?? null);
    return !(p.global || p.group || p.terminal || p.paid);
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
  const getKey = () => keyOf(env);
  const makeClient = factories.createOpenRouterClient ?? createOpenRouterClient;
  const makeRunner = factories.createTurnRunner ?? createTurnRunner;
  let ledger;
  try {
    ledger = createLedger({ store, getEffective, fetch, getKey, log, now, runtime: 'own' });
    const client = makeClient({ fetch, getKey, getBaseUrl: () => getEffective()?.openrouter?.baseUrl ?? null, log, now });
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
      effectivePath, store, ledger, policy, getEffective, decide, log, runGen, client, getKey, readSystemPrompt,
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
