// Runs one approved turn through the host. The host only ever sees derived peer ids and the HMAC event
// key: raw openids and message IDs stay with the gate and the exit.
import { sessionPeerId } from '../../core/ids.js';

const CHANNEL_ID = 'clo-qq';
const shanghaiTime = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function stamp(ms) {
  const p = Object.fromEntries(shanghaiTime.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// Crisis is a routing state only. It is not kept, so it does not enter the session transcript either.
export function frameBody(turn) {
  const cls = turn.cls === 'crisis' ? 'addressed' : turn.cls;
  return `[clo-turn class=${cls} time=${stamp(turn.msgTs ?? turn.receivedAt)} Asia/Shanghai]\n${turn.text}`;
}

// A structured entry reaches the model in the host's per-turn runtime context, which it did not store in the mock runs.
// sender.name and the frame body are both stored with the turn, so they keep the code name.
const speakerContext = (label) => ({ channelStructuredContext: [{ label: '当前发言人', source: 'clo', type: 'current_speaker', payload: { speaker: label } }] });

function deadlineTimer(ms) {
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve('deadline'), Math.max(ms, 0));
    timer.unref?.();
  });
  return { expired, clear: () => clearTimeout(timer) };
}

export function createDispatcher({ rt, getCfg, account, getExit, identity, usage, log = () => {}, now = Date.now }) {
  return async function dispatchTurn(turn) {
    const cfg = getCfg();
    const peer = sessionPeerId('g', turn.groupId);
    const sender = sessionPeerId('u', turn.senderId);
    const conversation = { kind: 'group', id: peer };
    const target = `group:${peer}`;
    const route = rt.routing.resolveAgentRoute({ cfg, channel: CHANNEL_ID, accountId: account.accountId, peer: conversation });

    const channelIngress = await rt.inbound.ingress.resolve({
      channelId: CHANNEL_ID,
      accountId: account.accountId,
      identity,
      subject: { stableId: sender },
      conversation,
      contextBinding: {
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        messageId: turn.eventKey,
        inboundEventKind: 'user_request',
        nativeChannelId: peer,
      },
      event: { kind: 'message', authMode: 'inbound', mayPair: false },
      policy: { dmPolicy: 'allowlist', groupPolicy: 'open' },
      allowFrom: [],
      groupAllowFrom: [],
      route: { id: 'clo-gate', allowed: true, enabled: true },
      readStoreAllowFrom: async () => [],
    });
    const admission = channelIngress?.ingress?.admission ?? null;
    if (admission !== 'dispatch') {
      log('turn_ingress', { eventKey: turn.eventKey, reason: 'not_dispatch', state: admission });
      return { started: false, reason: 'ingress' };
    }

    const timestamp = turn.msgTs ?? turn.receivedAt;
    const authorized = turn.authorizedCommand !== null;
    const body = authorized ? turn.authorizedCommand : frameBody(turn);
    const addressed = turn.cls !== 'interject';
    const history = authorized ? [] : turn.history ?? [];
    const ctxPayload = rt.inbound.buildContext({
      channel: CHANNEL_ID,
      accountId: account.accountId,
      messageId: turn.eventKey,
      messageIdFull: turn.eventKey,
      timestamp,
      from: `${CHANNEL_ID}:${target}`,
      sender: { id: sender, name: turn.senderLabel ?? 'owner' },
      ...(!authorized && turn.speakerLabel ? { supplemental: speakerContext(turn.speakerLabel) } : {}),
      conversation: { ...conversation, nativeChannelId: peer, routePeer: conversation },
      route: { agentId: route.agentId, accountId: route.accountId, routeSessionKey: route.sessionKey, dispatchSessionKey: route.sessionKey },
      reply: { to: target, originatingTo: target, nativeChannelId: peer, replyToId: turn.eventKey, sourceReplyDeliveryMode: 'channel' },
      message: {
        inboundEventKind: 'user_request',
        body,
        rawBody: turn.text,
        bodyForAgent: body,
        commandBody: turn.text,
        ...(history.length ? { inboundHistory: history } : {}),
      },
      ...(history.length ? { sessionTranscript: { historyLimit: history.length, historyKind: 'recent' } } : {}),
      access: {
        commands: { authorized },
        mentions: { canDetectMention: true, wasMentioned: addressed, explicitlyMentionedBot: addressed },
      },
      channelIngress,
    });

    // A standalone command starts no model call, and it must not take the place of a turn in flight.
    if (turn.cls !== 'command') usage?.open(route.sessionKey, turn);
    log('turn_start', { eventKey: turn.eventKey, groupKey: turn.groupKey, tier: turn.tier });
    const run = rt.inbound.run({
      channel: CHANNEL_ID,
      accountId: account.accountId,
      raw: { id: turn.eventKey },
      adapter: {
        ingest: () => ({ id: turn.eventKey, timestamp, rawText: turn.text, textForAgent: body, textForCommands: turn.text, raw: { id: turn.eventKey } }),
        resolveTurn: () => ({
          cfg,
          channel: CHANNEL_ID,
          accountId: account.accountId,
          route: { agentId: route.agentId, sessionKey: route.sessionKey },
          ctxPayload,
          messageId: turn.eventKey,
          record: { onRecordError: () => log('record_error', { eventKey: turn.eventKey }) },
          replyOptions: { disableBlockStreaming: true },
          delivery: {
            deliver: async (payload, info) => getExit().collect(turn.turnId, { text: payload?.text, isError: payload?.isError === true }, { kind: info?.kind }),
            onError: () => log('deliver_error', { eventKey: turn.eventKey }),
          },
        }),
      },
    });

    // A run that never ends must not hold the group's queue. Past the passive window nothing could be sent anyway.
    let hostError = false;
    let aborted = false;
    const watchdog = deadlineTimer(turn.deadlineAt - now());
    try {
      const outcome = await Promise.race([run.then(() => 'done'), watchdog.expired]);
      if (outcome === 'deadline') {
        aborted = true;
        log('turn_watchdog', { eventKey: turn.eventKey });
        run.catch(() => {});
      }
    } catch {
      hostError = true;
      log('dispatch_error', { eventKey: turn.eventKey });
    } finally {
      watchdog.clear();
    }
    const seen = usage ? await usage.close(turn.turnId) : null;
    return { started: true, hostError, aborted, usage: seen };
  };
}
