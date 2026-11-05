// Pure helpers for the Q0 listener. Output must never contain message text, names, or raw IDs.
import { createHmac } from 'node:crypto';

const ALLOWED_ENV = new Set(['CLO_QQ_APP_ID', 'CLO_QQ_APP_SECRET']);

/** Reads only the QQ credentials from .env text. Model and search keys are never loaded. */
export function parseQqEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || !ALLOWED_ENV.has(m[1])) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** Keyed hash: the same ID compares equal across runs, but the capture does not reveal it. */
export function hashId(salt, id) {
  if (typeof id !== 'string' || id === '') return null;
  return 'id_' + createHmac('sha256', salt).update(id).digest('hex').slice(0, 12);
}

/** Letter-case pattern only, for deciding how openids must be compared (TQ15). */
export function idCase(id) {
  if (typeof id !== 'string' || id === '') return null;
  const upper = /[A-Z]/.test(id);
  const lower = /[a-z]/.test(id);
  if (upper && lower) return 'mixed';
  if (upper) return 'upper';
  if (lower) return 'lower';
  return 'none';
}

/** Structure only: keys and types. Strings are reduced to their length. */
export function shapeOf(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (depth >= 4) return `array(${value.length})`;
    return { array: value.length, first: value.length ? shapeOf(value[0], depth + 1) : null };
  }
  switch (typeof value) {
    case 'string': return `string(${value.length})`;
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'object': {
      if (depth >= 4) return 'object';
      const out = {};
      for (const k of Object.keys(value).sort()) out[k] = shapeOf(value[k], depth + 1);
      return out;
    }
    default: return typeof value;
  }
}

function sceneSource(scene) {
  const s = scene?.source;
  if (typeof s !== 'string') return null;
  return /^[A-Za-z_]{1,32}$/.test(s) ? s : '<other>';
}

function sceneExtKeys(scene) {
  if (!Array.isArray(scene?.ext)) return [];
  return scene.ext
    .filter((e) => typeof e === 'string' && e.includes('='))
    .map((e) => e.slice(0, e.indexOf('=')).trim());
}

function contentFlags(content) {
  const c = typeof content === 'string' ? content : '';
  return {
    length: c.length,
    hasAtTag: /<@!?[^>]+>/.test(c),
    hasAtAllTag: /<@(?:!)?(?:all|everyone)>/i.test(c),
    hasPlainAt: c.includes('@'),
    hasUrl: /https?:\/\//i.test(c),
    startsWithSlash: /^\s*\//.test(c),
  };
}

function mentionFlags(m) {
  return {
    scope: typeof m?.scope === 'string' ? m.scope : null,
    bot: typeof m?.bot === 'boolean' ? m.bot : null,
    is_you: typeof m?.is_you === 'boolean' ? m.is_you : null,
    hasId: Boolean(m?.id),
    hasMemberOpenid: Boolean(m?.member_openid),
    hasUserOpenid: Boolean(m?.user_openid),
    hasName: Boolean(m?.nickname || m?.username),
  };
}

/** One redacted capture line for a message event. */
export function summarizeMessage(msg, { salt, receivedAt }) {
  const raw = msg.raw ?? {};
  const created = Date.parse(msg.timestamp);
  const received = Date.parse(receivedAt);
  return {
    receivedAt,
    event: msg.rawEventType,
    kind: msg.kind,
    timestampValid: Number.isFinite(created),
    skewMs: Number.isFinite(created) ? received - created : null,
    messageId: hashId(salt, msg.messageId),
    group: hashId(salt, msg.groupOpenid),
    sender: hashId(salt, msg.senderId),
    senderCase: idCase(msg.senderId),
    groupCase: idCase(msg.groupOpenid),
    authorBot: typeof raw.author?.bot === 'boolean' ? raw.author.bot : null,
    usernamePresent: Boolean(raw.author?.username),
    content: contentFlags(msg.content),
    mentions: Array.isArray(msg.mentions) ? msg.mentions.map(mentionFlags) : null,
    attachments: Array.isArray(msg.attachments)
      ? msg.attachments.map((a) => (typeof a?.content_type === 'string' ? a.content_type.split(';')[0] : null))
      : [],
    msgType: typeof msg.msgType === 'number' ? msg.msgType : null,
    sceneSource: sceneSource(msg.messageScene),
    sceneExtKeys: sceneExtKeys(msg.messageScene),
    hasRefMsgIdx: Boolean(msg.refMsgIdx),
    hasMsgIdx: Boolean(msg.msgIdx),
    msgElements: Array.isArray(msg.msgElements) ? msg.msgElements.length : 0,
    rawShape: shapeOf(raw),
  };
}

/** One redacted capture line for any other gateway event. */
export function summarizeRaw(type, data, { receivedAt }) {
  return { receivedAt, event: type, rawShape: shapeOf(data) };
}

/** Removes known secrets from an error message before it is shown or saved. */
export function scrub(text, secrets) {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (s) out = out.split(s).join('<redacted>');
  }
  return out.replace(/QQBot\s+[A-Za-z0-9._~+/=-]+/g, 'QQBot <redacted>').replace(/"access_token"\s*:\s*"[^"]*"/g, '"access_token":"<redacted>"');
}
