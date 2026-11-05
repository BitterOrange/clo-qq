// Local content rules. check() only reads a normalized copy; outbound text is never altered here.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/gu;

export const POLICY_CATEGORIES = ['sexual', 'crime', 'privacy'];

// sha256 of the plan's block, version 1. Used when config leaves contentPolicy.sha256 empty.
export const POLICY_V1_SHA256 = 'f0ed566dc5f7b4e0b0c84111faf24d32f59c40cd8871ef0ba7bd23b938b70048';

export function normalizeCopy(text) {
  if (typeof text !== 'string') throw new TypeError('normalizeCopy: text must be a string');
  return text.normalize('NFKC').toLowerCase().replace(INVISIBLE, '').replace(/\s+/gu, '');
}

// Reordering a long run of mixed marks is quadratic. Stream-safe text (UAX #15) has at most 30 marks in a row, so
// only garbage reaches this, and it can be cut.
const MAX_RUN_POINTS = 32;

// Code points NFKC can change only together: a base and its marks, or pieces that compose, like jamo and halfwidth kana.
function* nfkcRuns(text) {
  let run = '';
  let size = 0;
  for (const point of text) {
    const alone = point.normalize('NFKC');
    if (run && size < MAX_RUN_POINTS && (/^\p{M}/u.test(alone) || (run + point).normalize('NFKC') !== run.normalize('NFKC') + alone)) {
      run += point;
      size += 1;
    } else {
      if (run) yield run;
      run = point;
      size = 1;
    }
  }
  if (run) yield run;
}

// Unit i of the copy came from code points from[i] up to, not including, to[i] of text. Shaped a run at a time,
// so it reads as the whole string would, short of a run cut at the cap. It only steers what the decision model sees.
export function mappedCopy(text, shape) {
  let copy = '';
  const from = [];
  const to = [];
  let at = 0;
  for (const run of nfkcRuns(text)) {
    const piece = shape(run);
    const end = at + [...run].length;
    copy += piece;
    for (let i = 0; i < piece.length; i += 1) {
      from.push(at);
      to.push(end);
    }
    at = end;
  }
  return { copy, from, to };
}

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

// Shorter needles would match ordinary words.
const MIN_LEAK_NEEDLE = 6;
const LEAK_SHAPES = [
  { ruleId: 'leak.key_shape', re: /(?<![a-z0-9])sk-(or|ant)-[a-z0-9_-]{8,}/u },
  { ruleId: 'leak.marker', re: /clo-policy(-end)?:\d|<!--clo-|\[clo-turn/u },
];

function compileRules(parsed) {
  if (!Array.isArray(parsed?.rules)) throw new Error('rules file: rules must be an array');
  const seen = new Set();
  const active = [];
  for (const r of parsed.rules) {
    if (typeof r?.id !== 'string' || !r.id || seen.has(r.id)) throw new Error('rules file: bad or duplicate rule id');
    seen.add(r.id);
    if (!POLICY_CATEGORIES.includes(r.category)) throw new Error(`rules file: ${r.id} has a bad category`);
    for (const f of ['pattern', 'basis', 'addedBy', 'addedAt', 'status']) {
      if (typeof r[f] !== 'string' || !r[f]) throw new Error(`rules file: ${r.id} is missing ${f}`);
    }
    const re = new RegExp(r.pattern, 'u');
    if (r.status === 'active') active.push({ id: r.id, category: r.category, re });
  }
  return active;
}

function compileCrisis(parsed) {
  if (!Array.isArray(parsed?.terms)) throw new Error('crisis file: terms must be an array');
  return parsed.terms.map((t) => {
    if (typeof t !== 'string' || !t) throw new Error('crisis file: bad term');
    return normalizeCopy(t);
  });
}

export function loadPolicy({ policyFile, sha256, rulesFile, crisisFile }) {
  const actual = sha256Hex(readFileSync(policyFile));
  if (actual !== (sha256 || POLICY_V1_SHA256)) throw new Error('content policy hash mismatch');
  const rules = compileRules(JSON.parse(readFileSync(rulesFile, 'utf8')));
  const crisis = compileCrisis(JSON.parse(readFileSync(crisisFile, 'utf8')));

  return {
    sha256: actual,
    ruleCount: rules.length,
    check(text) {
      const copy = normalizeCopy(text);
      for (const r of rules) {
        if (r.re.test(copy)) return { hit: true, ruleId: r.id, category: r.category };
      }
      return { hit: false };
    },
    checkLeak(text, { secrets = [], rawIds = [] } = {}) {
      const copy = normalizeCopy(text);
      const leak = (ruleId) => ({ hit: true, ruleId, category: 'leak' });
      for (const [list, ruleId] of [[secrets, 'leak.secret'], [rawIds, 'leak.raw_id']]) {
        for (const v of list) {
          if (typeof v !== 'string' || v.length < MIN_LEAK_NEEDLE) continue;
          if (copy.includes(normalizeCopy(v))) return leak(ruleId);
        }
      }
      for (const { ruleId, re } of LEAK_SHAPES) {
        if (re.test(copy)) return leak(ruleId);
      }
      return { hit: false };
    },
    isCrisisRoute(text) {
      if (typeof text !== 'string') return false;
      const copy = normalizeCopy(text);
      return crisis.some((t) => copy.includes(t));
    },
    // The last listed term, as code point offsets into text, on the same copy isCrisisRoute reads.
    lastCrisisSpan(text) {
      if (typeof text !== 'string') return null;
      const { copy, from, to } = mappedCopy(text, normalizeCopy);
      let last = null;
      for (const term of crisis) {
        const index = term ? copy.lastIndexOf(term) : -1;
        if (index >= 0 && (!last || index > last.index)) last = { index, length: term.length };
      }
      return last && { start: from[last.index], end: to[last.index + last.length - 1] };
    },
  };
}

function markerIndex(prompt, name, version) {
  const escaped = String(version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${name}:${escaped}(?![0-9A-Za-z.])`).exec(prompt);
  return m ? m.index : -1;
}

export function checkSentinels(systemPrompt, version) {
  if (typeof systemPrompt !== 'string' || !systemPrompt) return { ok: false, reason: 'no-prompt' };
  const start = markerIndex(systemPrompt, 'clo-policy', version);
  const end = markerIndex(systemPrompt, 'clo-policy-end', version);
  if (start < 0) return { ok: false, reason: 'missing-start' };
  if (end < 0) return { ok: false, reason: 'missing-end' };
  if (end < start) return { ok: false, reason: 'order' };
  return { ok: true };
}

export function loadFixedLines(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  for (const k of ['policyDropped', 'modelFailed']) {
    if (typeof parsed[k] !== 'string' || !parsed[k]) throw new Error(`fixed lines: ${k} is missing`);
  }
  return { policyDropped: parsed.policyDropped, modelFailed: parsed.modelFailed };
}
