// One set of durable services per plugin module instance, created lazily from the plugin config.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createEffectiveReader } from '../../core/config.js';
import { loadPolicy } from '../../core/contentPolicy.js';
import { createDecider } from '../../core/decision.js';
import { createLedger } from '../../core/ledger.js';
import { createLog } from '../../core/log.js';
import { openStore } from '../../core/store.js';
import { createUsageTracker } from './hooks.js';

let current = null;

// The Gateway's name for the key. clo start reads CLO_CHAT_API_KEY from .env and passes it on under this name.
const getKey = () => process.env.OPENROUTER_API_KEY || null;

export function liveSecrets() {
  return [process.env.CLO_QQ_APP_SECRET, process.env.OPENROUTER_API_KEY, process.env.OPENCLAW_GATEWAY_TOKEN].filter(Boolean);
}

function build(effectivePath) {
  const getEffective = createEffectiveReader(effectivePath);
  const eff = getEffective();
  if (!eff) throw new Error('effective config is missing or invalid');
  const cp = eff.contentPolicy;
  const policy = loadPolicy({ policyFile: cp.policyFile, sha256: cp.sha256, rulesFile: cp.rulesFile, crisisFile: cp.crisisFile });
  const runGen = randomUUID();
  const log = createLog(eff.paths.eventLog, { gen: runGen.slice(0, 8) });
  const store = openStore(eff.paths.db, { runGen });
  const ledger = createLedger({ store, getEffective, getKey, log });
  const decide = createDecider({ getKey, getEffective, log });
  const promptFile = eff.paths.systemPromptFile;
  return {
    effectivePath, store, ledger, policy, getEffective, decide, log, runGen,
    usage: null,
    systemPrompt() {
      try {
        return readFileSync(promptFile, 'utf8');
      } catch {
        return null;
      }
    },
  };
}

export function getServices(effectivePath) {
  if (current && (!effectivePath || current.effectivePath === effectivePath)) return current;
  if (!effectivePath) throw new Error('effectivePath is not configured');
  stopServices();
  current = build(effectivePath);
  return current;
}

// Import failure at start pauses paid work: without usage, nothing could settle.
export async function attachUsage(services) {
  if (services.usage) return services.usage;
  try {
    const { onInternalDiagnosticEvent, waitForDiagnosticEventsDrained } = await import('openclaw/plugin-sdk/diagnostic-runtime');
    services.usage = createUsageTracker({
      onInternalDiagnosticEvent,
      waitDrained: waitForDiagnosticEventsDrained,
      ledger: services.ledger,
      log: services.log,
      price: () => services.getEffective()?.models?.primary?.price ?? null,
    });
  } catch {
    services.ledger.pausePaid('usage_unavailable', 'services');
    services.log('usage_unavailable', {});
  }
  return services.usage;
}

export function stopServices() {
  if (!current) return;
  const s = current;
  current = null;
  try {
    s.ledger.stopTimers();
    s.usage?.stop();
  } finally {
    s.store.close();
  }
}
