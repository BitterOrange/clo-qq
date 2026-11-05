// Pure local rules. Nothing here writes, spends or sends.
import { findUrls } from './urls.js';

const NOT_TEXT = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\p{P}\p{S}\p{Z}\p{C}\p{M}]/gu;
// QQ face tags. Read in the platform docs, not seen in a capture; harmless if they never occur.
const FACE_TAG = /<(?:faceType=|emoji:)[^<>]*>/g;
const MAX_URLS = 20;

// Rule failures the crisis list may rescue. Not noise, flood, interject_off or interject_latch.
export const CRISIS_ELIGIBLE = new Set(['quiet', 'cooldown', 'hour', 'day', 'inflight', 'prerule']);

export function userTextOf(evt) {
  let text = evt.text ?? '';
  for (const p of evt.placeholders ?? []) text = text.split(p).join('');
  return text;
}

export function isNoise(evt, { minTextChars }) {
  if (!evt.hasUserText) return true;
  const solid = userTextOf(evt).replace(FACE_TAG, '').replace(NOT_TEXT, '');
  return [...solid].length < minTextChars;
}

export function evaluateOrdinary({ group, evt, prerule, quiet, interjectPeek, pause, windowCount, limits }) {
  if (!group?.interject) return { ok: false, reason: 'interject_off' };
  if (pause?.interject) return { ok: false, reason: 'interject_latch' };
  if (quiet) return { ok: false, reason: 'quiet' };
  if (!interjectPeek.ok) return { ok: false, reason: interjectPeek.reason };
  if (isNoise(evt, limits)) return { ok: false, reason: 'noise' };
  if (windowCount > limits.floodPerWindow) return { ok: false, reason: 'flood' };
  if (prerule) return { ok: false, reason: 'prerule' };
  return { ok: true };
}

// Last name with user text, else the last message that says something, else the last with any text.
export function pickRepresentative(records, limits) {
  const withText = records.filter((r) => r.evt.hasUserText);
  return withText.findLast((r) => r.cls === 'name')
    ?? withText.findLast((r) => !isNoise(r.evt, limits))
    ?? withText.at(-1)
    ?? null;
}

// The name messages of one window worth a decision: each sender's last, in arrival order, newest senders
// kept. An effective file written before nameWindowMax existed judges one, as it always did.
export function selectNameRecords(records, { nameWindowMax }) {
  const last = new Map();
  for (const r of records) {
    if (r.cls !== 'name' || !r.evt.hasUserText) continue;
    last.delete(r.senderKey);
    last.set(r.senderKey, r);
  }
  return [...last.values()].slice(-(nameWindowMax > 0 ? nameWindowMax : 1));
}

// In the form the outbound guard compares.
export function extractUrls(text) {
  return [...new Set(findUrls(text).map((u) => u.key))].slice(0, MAX_URLS);
}
