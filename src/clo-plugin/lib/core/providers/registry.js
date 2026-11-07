// The model API providers this build knows: pure, frozen data, the provider readers and the start checks. No I/O, no
// adapters, no config import.
// Capabilities always come from here by kind; nothing reads them from a file. docs/provider-contract.md is the contract.

export const PROVIDER_KINDS = Object.freeze(['openrouter', 'anthropic']);

const own = (x) => (x?.runtime ?? 'openclaw') === 'own';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v !== '';

// keyReadable: the Key's spend and daily limit can be read with the Key itself (OpenRouter /key).
// reportsCost: responses carry a cost figure. Without one, settlement prices tokens at the locked price.
// hardCap: what stops spend on the provider's side. 'key_daily_limit' is read from the Key; 'attested' rests on the
//   owner's `clo ack hard-cap`, which no program read can check.
// ownerClearsProviderFail: provider_fail can be cleared by the owner. Without a Key read nothing else can lift it.
// countTokens, cache1h: not used in this build on any kind.
export const CAPABILITIES = Object.freeze({
  openrouter: Object.freeze({ keyReadable: true, reportsCost: true, hardCap: 'key_daily_limit', ownerClearsProviderFail: false, countTokens: false, cache1h: false }),
  anthropic: Object.freeze({ keyReadable: false, reportsCost: false, hardCap: 'attested', ownerClearsProviderFail: true, countTokens: false, cache1h: false }),
});

// The .env name of each kind's Key, and the one name it has in the own runtime's child environment.
export const KEY_ENV = Object.freeze({ openrouter: 'CLO_CHAT_API_KEY', anthropic: 'CLO_ANTHROPIC_API_KEY' });
export const CHILD_KEY = Object.freeze({ openrouter: 'OPENROUTER_API_KEY', anthropic: 'CLO_PROVIDER_API_KEY' });
// The paid Anthropic probe's own Key. Never passed to the Gateway or the bot.
export const PROBE_KEY_ENV = Object.freeze({ anthropic: 'CLO_TEST_ANTHROPIC_API_KEY' });

export const DEFAULT_BASE = Object.freeze({ openrouter: 'https://openrouter.ai/api/v1', anthropic: 'https://api.anthropic.com' });
export const ANTHROPIC_VERSION = '2026-10-21';

// Concrete model ids only. OpenRouter: anthropic/ and nothing routed, suffixed or aliased (as turn.js). Anthropic: an
// Opus, Sonnet or Haiku id; no -latest, no dated snapshot, no other model line.
export const MODEL_ID_RULES = Object.freeze({
  openrouter: /^anthropic\/[A-Za-z0-9][A-Za-z0-9._-]*$/,
  anthropic: /^claude-(?:opus|sonnet|haiku)-\d{1,2}(?:-\d{1,2})?$/,
});
// Efforts accepted on the Anthropic kind. Opus 5.5 cannot turn thinking off, so the primary has no 'none'. The decision
// has only 'none' (thinking disabled), because adaptive thinking would use up its small max_tokens.
export const ANTHROPIC_EFFORTS = Object.freeze({
  primary: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
  decision: Object.freeze(['none']),
});

// Provider entries in config.json.
export const PROVIDER_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const PROVIDER_ENTRY_FIELDS = Object.freeze(['kind', 'keyEnv', 'baseUrl', 'models']);

// Result kinds and reasons, unchanged from openrouterChat.js.
export const RESULT_KINDS = Object.freeze(['ok', 'refusal', 'error', 'not_sent', 'aborted']);
export const RESULT_REASONS = Object.freeze({
  ok: Object.freeze([null]),
  not_sent: Object.freeze(['unavailable', 'connect']),
  aborted: Object.freeze(['aborted']),
  error: Object.freeze(['http', 'provider_error', 'bad_body', 'no_choice', 'network', 'timeout', 'tool_calls', 'finish_error', 'finish_reason', 'model_mismatch']),
  refusal: Object.freeze(['moderation', 'refusal', 'content_filter']),
});
export const OPENROUTER_LIMIT_SOURCES = Object.freeze(['openrouter_key_limit', 'openrouter_credits']);
export const ANTHROPIC_LIMIT_SOURCES = Object.freeze(['anthropic_credits', 'anthropic_spend_limit', 'anthropic_permission']);

// Reasons for the paid_paused control added for providers. The three limit sources pause under their own names.
export const PRICE_PAUSE = 'anthropic_price_unexpected';
export const PROVIDER_PAUSES = Object.freeze([...ANTHROPIC_LIMIT_SOURCES, PRICE_PAUSE]);
// Cleared by the owner at the console.
export const OWNER_CLEARED_PROVIDER_PAUSES = Object.freeze([...ANTHROPIC_LIMIT_SOURCES, PRICE_PAUSE]);
export const PRICE_ALERT = 'price_unexpected';

// The hard-cap pause is not a paid_paused reason. It sits in a control of its own per kind, so it never replaces
// another pause and lifting it never clears one. It blocks paid work only while its kind is the active one, so switching
// away needs no attestation, and only a new `clo ack hard-cap` lifts it.
export const HARD_CAP_PAUSE = 'hard_cap_unverified';
export const hardCapPauseKey = (kind) => `hard_cap_paused:${kind}`;
// The hard cap a Key that cannot be read stands on (decision D2), and where its attestation is bound to that Key.
export const HARD_CAP_KINDS = Object.freeze(['workspace_monthly']);
export const hardCapControlKey = (kind) => `hard_cap_key:${kind}`;
// The provider the install runs on, as '<kind>:<name>', written only by `clo provider use` (decision D8). config.json
// names its provider too, but a hand edit there would skip what the switch requires; apply compares the two.
export const ACTIVE_PROVIDER_CONTROL = 'active_provider';
export const providerRecord = (p) => (p ? `${p.kind}:${p.name}` : null);

// livePreconditions codes for providers.
export const LIVE_CODES = Object.freeze({ hardCap: 'hard_cap', keyValid: 'key_valid', providerRules: 'provider_rules' });
// Whether the project's recorded rules (CLAUDE.md section 8.2, DECISIONS.md) allow live on a kind. A kind whose Key
// cannot be read is true only with the rule rows that record the user's consent, landed in the same commit.
export const LIVE_RULES_RECORDED = Object.freeze({ openrouter: true, anthropic: true });
export const providerRulesRecorded = (kind) => LIVE_RULES_RECORDED[kind] === true;

// What is wrong with a hard-cap ack, recorded or asked for: [] when it meets decision D2, a dedicated workspace with a
// monthly spend limit plus prepaid credits with auto-reload off.
export function hardCapAckProblems(ack) {
  if (!isObj(ack)) return ['missing'];
  const problems = [];
  if (!HARD_CAP_KINDS.includes(ack.kind)) problems.push('kind');
  if (ack.prepaidNoReload !== true) problems.push('prepaid_no_reload');
  if (typeof ack.usd !== 'number' || !Number.isFinite(ack.usd) || ack.usd <= 0) problems.push('usd');
  return problems;
}

// Whether `clo ack hard-cap` may run: null, or why not. It never runs in live mode or beside a process: a running
// process holds the Key it started with, which may not be the one in .env, and `clo mode live` must re-check the ack.
export function hardCapAckRefusal({ provider, ack, mode, processRunning }) {
  if (!provider || provider.caps?.hardCap !== 'attested') return 'not_attested';
  if (mode === 'live') return 'live';
  if (processRunning !== false) return 'process';
  if (hardCapAckProblems(ack).length > 0) return 'ack';
  return null;
}

// The check `clo start` and the bot's start both run: {ok: true} or {ok: false, code}. code is a LIVE_CODES value or
// 'provider'. In live mode on a kind whose spend rests on an attested cap it re-runs the whole ack check, not only the
// Key fingerprint; on every kind it checks the recorded rules. keyFp is store.key() of the Key that process holds.
export function liveStartCheck({ provider, mode, ack, control, keyFp }) {
  if (!provider) return { ok: false, code: 'provider' };
  if (mode !== 'live') return { ok: true };
  if (provider.caps?.hardCap === 'attested') {
    if (hardCapAckProblems(ack).length > 0) return { ok: false, code: LIVE_CODES.hardCap };
    if (!nonEmpty(control) || !nonEmpty(keyFp) || control !== keyFp) return { ok: false, code: LIVE_CODES.hardCap };
  }
  if (!providerRulesRecorded(provider.kind)) return { ok: false, code: LIVE_CODES.providerRules };
  return { ok: true };
}

function entry(name, kind, baseUrl, implicit) {
  return Object.freeze({ name, kind, baseUrl, keyEnv: KEY_ENV[kind], childKey: CHILD_KEY[kind], caps: CAPABILITIES[kind], implicit });
}

function implicitOf(x) {
  const base = nonEmpty(x?.openrouter?.baseUrl) ? x.openrouter.baseUrl : DEFAULT_BASE.openrouter;
  return entry('openrouter', 'openrouter', base, true);
}

// Each reader takes one shape only, so a field of the other shape can never pick the provider. Both give
// {name, kind, baseUrl, keyEnv, childKey, caps, implicit}, frozen, or null, which callers treat as nothing to send to.
// On a runtime other than own both give the implicit OpenRouter entry, on openrouter.baseUrl.

// config.json: providers[activeProvider]; without providers, the implicit entry. A top-level apiProvider, the effective
// file's field, gives null: validation refuses it, and live checks must not run for a kind the bot would not use.
export function providerOfConfig(cfg) {
  if (!own(cfg)) return implicitOf(cfg);
  if (cfg.apiProvider !== undefined) return null;
  if (cfg.providers === undefined) return implicitOf(cfg);
  const providers = cfg.providers;
  const name = cfg.activeProvider;
  if (!isObj(providers) || !nonEmpty(name) || !Object.hasOwn(providers, name)) return null;
  const e = providers[name];
  if (!isObj(e) || !PROVIDER_KINDS.includes(e.kind)) return null;
  const fallback = e.kind === 'openrouter' ? implicitOf(cfg).baseUrl : DEFAULT_BASE[e.kind];
  return entry(name, e.kind, nonEmpty(e.baseUrl) ? e.baseUrl : fallback, false);
}

// The effective file: apiProvider {name, kind, baseUrl}; without it, the implicit entry. The config's providers or
// activeProvider in an effective file give null: the generator never writes them there.
export function providerOfEffective(eff) {
  if (!own(eff)) return implicitOf(eff);
  if (eff.providers !== undefined || eff.activeProvider !== undefined) return null;
  if (eff.apiProvider === undefined) return implicitOf(eff);
  const a = eff.apiProvider;
  if (!isObj(a) || !PROVIDER_KINDS.includes(a.kind) || !nonEmpty(a.name)) return null;
  return entry(a.name, a.kind, nonEmpty(a.baseUrl) ? a.baseUrl : DEFAULT_BASE[a.kind], false);
}
