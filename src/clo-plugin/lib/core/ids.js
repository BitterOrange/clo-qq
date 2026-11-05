// Identifiers and time buckets. Pure, except crashpoint.
import { createHash, createHmac } from 'node:crypto';

const SHANGHAI_OFFSET_MS = 8 * 3600000;

export function hmacKey(salt, value) {
  if (typeof salt !== 'string' || !salt) throw new TypeError('hmacKey: salt required');
  if (typeof value !== 'string' || !value) throw new TypeError('hmacKey: value required');
  return createHmac('sha256', salt).update(value, 'utf8').digest('hex').slice(0, 32);
}

const PEER_PREFIX = { g: 'g', group: 'g', u: 'u', user: 'u', direct: 'u' };

// The host lowercases session keys, so a peer id must be lowercase by construction (TQ15).
export function sessionPeerId(kind, rawId) {
  const prefix = PEER_PREFIX[kind];
  if (!prefix) throw new TypeError(`sessionPeerId: unknown kind ${kind}`);
  if (typeof rawId !== 'string' || !rawId) throw new TypeError('sessionPeerId: rawId required');
  return prefix + createHash('sha256').update(`clo-peer\0${rawId}`, 'utf8').digest('hex').slice(0, 32);
}

export function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function shanghaiDay(ms) {
  return new Date(ms + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

// Epoch ms of 00:00 Asia/Shanghai on the day containing ms.
export function shanghaiDayStart(ms) {
  return Date.parse(`${shanghaiDay(ms)}T00:00:00.000Z`) - SHANGHAI_OFFSET_MS;
}

export function hourBucket(ms) {
  return Math.floor(ms / 3600000);
}

function minutesOf(hhmm) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm ?? '');
  if (!m) throw new RangeError(`bad time ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function isQuietHours(ms, quietHours) {
  if (quietHours.timezone !== 'Asia/Shanghai') throw new RangeError(`unsupported timezone ${quietHours.timezone}`);
  const start = minutesOf(quietHours.start);
  const end = minutesOf(quietHours.end);
  if (start === end) return false;
  const d = new Date(ms + SHANGHAI_OFFSET_MS);
  const t = d.getUTCHours() * 60 + d.getUTCMinutes();
  return start < end ? t >= start && t < end : t >= start || t < end;
}

export const CRASH_POINTS = ['after_claim', 'deciding', 'approved', 'dispatching', 'before_post', 'after_post', 'before_settle'];

export function crashpoint(name) {
  if (process.env.CLO_TEST_ROOT && process.env.CLO_TEST_CRASH_AT === name) process.exit(77);
}
