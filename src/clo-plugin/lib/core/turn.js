// The own runtime's main turn: one non-streaming request with no tools to the provider the client was built for. The
// client's adapter builds the body; the OpenRouter one is byte for byte what it was before the provider layer. The
// content-policy markers are checked on the exact system string sent. A reply reaches the exit only through collect(),
// once, as the whole text; nothing is posted from here. Provider text never reaches a log, an Error or the ledger.
import { checkSentinels } from './contentPolicy.js';
import { estimateTokens } from './context.js';
import { openrouterAdapter } from './providers/openrouterAdapter.js';

// An optional reply this close to the passive window's end would be paid for and then cut off.
const MIN_OPTIONAL_TURN_MS = 15000;
// Room left after the model call for the exit to post the reply inside the passive window.
const DELIVERY_RESERVE_MS = 15000;
// Her own lines in the recent list. A member cannot take this label: display names containing it are rejected and
// member lines are labelled with U codes.
export const OWN_LABEL = '可洛';
// The silent tokens the exit treats as no reply. Kept in step with the exit's own pattern.
const SILENT = /^[\s\p{P}\p{S}]*(?:NO_REPLY|HEARTBEAT_OK|ANNOUNCE_SKIP|REPLY_SKIP)[\s\p{P}\p{S}]*$/iu;

const shanghaiTime = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function stamp(ms) {
  const p = Object.fromEntries(shanghaiTime.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// Crisis is a routing state only, so the model sees it as an addressed turn.
export function frameLine(turn) {
  const cls = turn.cls === 'crisis' ? 'addressed' : turn.cls;
  return `[clo-turn class=${cls} time=${stamp(turn.msgTs ?? turn.receivedAt)} Asia/Shanghai]`;
}

// Line 1 is the frame. Everything else is one JSON object, so member text cannot start a line or fake a frame.
// History labels are pseudonyms or speaker labels from the gate, never raw IDs.
export function renderUserMessage(turn) {
  const recent = (turn.history ?? []).map((h) => ({
    who: h.own === true ? OWN_LABEL : String(h.sender ?? ''),
    text: String(h.body ?? ''),
  }));
  const speaker = turn.speakerLabel ?? turn.senderLabel ?? null;
  return `${frameLine(turn)}\n${JSON.stringify({ recent, speaker, text: String(turn.text ?? '') })}`;
}

function turnBodyOf(adapter, eff, system, turn) {
  const { primary } = eff.models;
  return adapter.turnBody({ model: primary.id, effort: primary.effort, maxTokens: primary.maxTokens, system, user: renderUserMessage(turn) });
}

// The OpenRouter request, as the goldens and the Q5 probe build it.
export function buildTurnRequest(eff, system, turn) {
  return turnBodyOf(openrouterAdapter, eff, system, turn);
}

const failed = (usage) => ({ started: true, hostError: true, aborted: false, usage });

export function createTurnRunner({ client, getEffective, readSystemPrompt, getExit, log = () => {}, now = Date.now, ledger = null, addAlert = null, beforeRetry = null }) {
  const alert = (kind, data) => {
    try {
      addAlert?.(kind, data);
    } catch {
      // An alert that cannot be written must not change how the turn ends.
    }
  };
  const providerOk = () => {
    try {
      ledger?.noteProviderOk();
    } catch {
      log('ledger_error', { reason: 'provider_ok' });
    }
  };
  const providerError = (data) => {
    try {
      ledger?.noteProviderError(data);
    } catch {
      log('ledger_error', { reason: 'provider_error' });
    }
  };

  // The adapter of the provider the client sends to. A client without one is an OpenRouter client.
  const adapter = client?.adapter ?? openrouterAdapter;

  return async function dispatchTurn(turn, { signal } = {}) {
    const started = now();
    const { eventKey } = turn;
    // A standalone owner command needs no model: the exit acknowledges it.
    if (turn.cls === 'command') return { started: true, hostError: false, aborted: false, usage: null };

    // A required turn may carry a message from someone in danger, which only the gate can tell, so it tries while any time is left.
    const remaining = turn.deadlineAt - started;
    if (remaining <= (turn.required === false ? MIN_OPTIONAL_TURN_MS : 0)) {
      log('turn_expired', { eventKey, tier: turn.tier });
      return { started: false, reason: 'expired_before_dispatch' };
    }

    let eff;
    try {
      eff = getEffective();
    } catch {
      eff = null;
    }
    const primary = eff?.models?.primary;
    // Only a concrete model under the provider's own id rule: on OpenRouter an anthropic/ model with no router, no
    // :suffix variant and no ~ alias; on Anthropic an Opus, Sonnet or Haiku id with no alias and no date.
    if (!primary || typeof primary.id !== 'string' || !adapter.idRule.test(primary.id)) {
      log('turn_refused', { eventKey, reason: 'model' });
      return { started: false, reason: 'model' };
    }

    // The markers are read on the very string that goes into the request. A checker that fails counts as missing.
    let system = null;
    let body = null;
    let check;
    try {
      system = readSystemPrompt();
      body = turnBodyOf(adapter, eff, system, turn);
      check = checkSentinels(adapter.systemTextOf(body), eff.contentPolicy.version);
    } catch {
      check = { ok: false, reason: 'unreadable' };
    }
    // A readable prompt the adapter would not build a request around (an effort or a token limit its provider does not
    // take) is a configuration fault, not a missing marker.
    if (body === null && typeof system === 'string' && system !== '') {
      log('turn_refused', { eventKey, reason: 'request' });
      return { started: false, reason: 'model' };
    }
    if (!check.ok) {
      alert('policy_sentinel', { reason: check.reason });
      log('policy_sentinel', { eventKey, reason: check.reason });
      return { started: false, reason: 'policy_sentinel' };
    }

    // The host used to bound input by its own count. Here the deliberately high estimate decides, before anything is sent.
    const estimate = estimateTokens(adapter.systemTextOf(body)) + estimateTokens(adapter.userTextOf(body));
    if (estimate > primary.contextTokens) {
      log('turn_refused', { eventKey, reason: 'input_bound', count: estimate });
      return { started: false, reason: 'input_bound' };
    }

    // The call is cut off in time for the reply, or the failure line, to be posted. A required turn too close to the end
    // still tries.
    const turnLimitAt = started + eff.timeouts.turnSeconds * 1000;
    let abortAt = Math.min(turnLimitAt, turn.deadlineAt - DELIVERY_RESERVE_MS);
    if (abortAt <= started) abortAt = turn.deadlineAt;

    log('turn_start', { eventKey, groupKey: turn.groupKey, tier: turn.tier });
    let r;
    try {
      r = await client.post(body, { signal, deadlineAt: abortAt, ...(beforeRetry ? { beforeRetry: () => beforeRetry(turn) } : {}) });
    } catch {
      // The client does not throw. If it ever does, whether a request left is unknown, so the turn counts as having run.
      log('turn_model', { eventKey, kind: 'error', reason: 'client_error', durationMs: now() - started });
      return failed(null);
    }

    const { usage } = r;
    log('turn_model', {
      eventKey, kind: r.kind, reason: r.reason, status: r.status, model: usage?.model ?? null, durationMs: now() - started,
      error_type: r.info?.error_type, provider_name: r.info?.provider_name, provider_code: r.info?.provider_code,
    });
    // Numbers only, in the line the Q5 tooling reads.
    if (usage) {
      log('turn_usage', {
        eventKey, inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite,
        model: usage.model, durationMs: now() - started,
      });
    }

    if (r.kind === 'not_sent') {
      // Nothing left this machine, so the hold can go back. A connection that keeps failing still counts as a failure.
      if (r.reason !== 'unavailable') providerError({ httpStatus: null, limitSource: null });
      return { started: false, reason: r.reason === 'unavailable' ? 'unavailable' : 'not_sent' };
    }
    // Only the caller's signal is an abort: a stop or a shutdown, after which nothing is posted for this turn.
    if (r.kind === 'aborted') return { started: true, hostError: false, aborted: true, usage };

    switch (r.reason) {
      case 'http':
      case 'moderation':
      case 'provider_error':
        providerError({ httpStatus: r.status ?? null, limitSource: r.info?.limitSource ?? null });
        return failed(usage);
      case 'timeout':
        // This call's own deadline: a failed turn, so a required one still gets the failure line in the time kept for
        // it. The provider is blamed only when it had the whole turnSeconds; a cut made early to keep the passive
        // window says nothing about it.
        if (abortAt >= turnLimitAt) providerError({ httpStatus: null, limitSource: null });
        return failed(usage);
      case 'bad_body':
      case 'no_choice':
      case 'finish_error':
      case 'network':
        providerError({ httpStatus: r.status ?? null, limitSource: null });
        return failed(usage);
      case 'model_mismatch':
        // No silent swap to another model: nothing it wrote is used.
        alert('model_mismatch', {});
        providerError({ httpStatus: r.status ?? null, limitSource: null });
        return failed(usage);
      default:
        break;
    }
    // The provider answered. A refusal, a tool call or another odd ending is the model's, not a provider failure.
    providerOk();
    if (r.kind !== 'ok') return failed(usage);

    const text = r.message?.content;
    // Empty text may be a refusal too.
    if (typeof text !== 'string' || !text.trim()) return failed(usage);
    if (SILENT.test(text.trim())) return { started: true, hostError: false, aborted: false, usage };
    if (r.finishReason === 'length') log('turn_length', { eventKey, reason: 'length' });
    getExit().collect(turn.turnId, { text, isError: false }, { kind: 'final' });
    return { started: true, hostError: false, aborted: false, usage };
  };
}
