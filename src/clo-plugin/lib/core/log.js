// Whitelisted JSONL event log. It must never hold text, raw IDs, usernames or provider messages.
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const LOG_KEYS = new Set([
  'eventKey', 'groupKey', 'cls', 'state', 'reason', 'ruleId', 'path', 'count', 'closeCode', 'code', 'httpStatus',
  'qqCode', 'durationMs', 'model', 'tier', 'heldMicros', 'actualMicros', 'source', 'seq', 'part', 'attempt',
  'generation', 'kind',
  'status', 'error_type', 'provider_name', 'provider_code',
  'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
  'refState', 'refKey', 'refLen', 'refPrefix',
]);

const MAX_VALUE_CHARS = 128;

const REF_MIN_REMAINDER = 8;

// What a line may say about a ref idx: enough to see a format mismatch, never the value. On a short value a prefix would be most of it.
export function refShape(idx) {
  const prefix = /^[A-Z]{2,12}_/.exec(idx)?.[0] ?? null;
  return { refLen: idx.length, refPrefix: prefix !== null && idx.length - prefix.length >= REF_MIN_REMAINDER ? prefix : null };
}

// Keeps whitelisted keys holding short scalars. Anything else counts as dropped.
export function sanitizeData(data) {
  const kept = {};
  let dropped = 0;
  if (data === null || typeof data !== 'object') return { kept, dropped };
  for (const [k, v] of Object.entries(data)) {
    const scalar = v === null || typeof v === 'number' || typeof v === 'boolean'
      || (typeof v === 'string' && v.length <= MAX_VALUE_CHARS);
    if (LOG_KEYS.has(k) && scalar) kept[k] = v;
    else dropped += 1;
  }
  return { kept, dropped };
}

export function createLog(path, { gen = randomUUID().slice(0, 8), now = Date.now } = {}) {
  let droppedKeys = 0;
  let dirReady = false;
  const log = (event, data) => {
    const { kept, dropped } = sanitizeData(data);
    droppedKeys += dropped;
    const name = typeof event === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(event) ? event : 'invalid_event';
    const line = JSON.stringify({ ...kept, event: name, pid: process.pid, t: now(), gen });
    try {
      if (!dirReady) {
        mkdirSync(dirname(path), { recursive: true });
        dirReady = true;
      }
      appendFileSync(path, `${line}\n`);
    } catch {
      // A full disk must not take the bot down or change what it does.
    }
  };
  log.droppedKeys = () => droppedKeys;
  return log;
}
