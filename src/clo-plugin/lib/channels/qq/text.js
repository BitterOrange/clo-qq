// Pure outbound text shaping. The exit checks the policy on the model's text and again on the result of
// shapeForQq, because removing markup can join what the markup split. Code keeps its characters, so the
// result can still hold markup that splits a match; checkFormForQq is the form with none left.
import { findUrls, foldedRemove, isWholeUrl, replaceUrls, urlKey } from '../../core/urls.js';

// The dot of a list number at the start of a line ends nothing.
const SENTENCE_END = /[。！？!?…]+["'”’）)】》]*|(?<!^[ \t]*\d{1,9})\.(?=\s|$)/gm;
const MD_LINK = /!?\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)/g;
// <@all>, <@ID>, spaced forms and the official plugin's tags. Whether QQ renders them from msg_type 0 is
// not known, so none of them leaves.
const MENTION_TAGS = [/<\s*@[^<>]*>/gu, /<\s*\/?\s*qqbot-at-[^<>]*>/giu];
export const URL_REMOVED = '[链接已移除]';
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const ONE_LINE_FENCE = /^\s*(`{3,}|~{3,})\s*(.*?\S)\s*(`{3,}|~{3,})\s*$/;
const FENCE_INFO = /^[A-Za-z0-9_+.#-]*$/;
const INLINE_CODE = /`([^`\n]+)`/g;
const HELD = /\0(\d+)\0/g;
// TLD words that are not also ordinary method names, as net in self.net(x) or info in df.info() are. They
// also count before another label, as in evil.com.hk.
const HOST_ONLY = /\.(?:com|org|edu|gov|cn)(?:\.|$)/;
const BARE_HOST = /^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/;
const CIDR = /^(?:\d{1,3}\.){3}\d{1,3}\/(?:[12]?\d|3[0-2])$/;
const PATH_START = /[/?#]/;

// An ASCII argument list closed on the same line. "evil.xyz(官网)" is a note beside a link, and the path in
// "evil.xyz()/pay" continues an address; neither is a call. Other text may follow, as in df.info().head().
function callFollows(source, at) {
  if (source[at] !== '(') return false;
  let depth = 0;
  for (let i = at; i < source.length; i += 1) {
    const code = source.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
    if (code === 0x28) depth += 1;
    if (code === 0x29) depth -= 1;
    if (depth === 0) return !PATH_START.test(source[i + 1] ?? '');
  }
  return false;
}

function stripMentionTags(text) {
  let out = text;
  for (let previous = null; previous !== out;) {
    previous = out;
    for (const tag of MENTION_TAGS) out = foldedRemove(out, tag);
  }
  return out;
}

const sameFence = (marker, line) => {
  const closing = /^\s*(`{3,}|~{3,})\s*$/.exec(line)?.[1];
  return Boolean(closing) && closing[0] === marker[0] && closing.length >= marker.length;
};

// Drops fence lines and passes each code line through keep. A fence that also carries text keeps the text:
// a whole block written on one line, or a command after an unclosed fence. A single word after a fence is
// the language name.
function unfence(text, keep) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let open = null;
  lines.forEach((line, at) => {
    if (open) {
      const closes = sameFence(open, line);
      out.push(closes ? '' : keep(line));
      if (closes) open = null;
      return;
    }
    const one = ONE_LINE_FENCE.exec(line);
    if (one && one[1][0] === one[3][0]) {
      out.push(keep(one[2]));
      return;
    }
    const fence = FENCE.exec(line);
    if (!fence) {
      out.push(line);
      return;
    }
    const carried = fence[2].trim();
    if (FENCE_INFO.test(carried)) {
      out.push('');
      open = fence[1];
      return;
    }
    out.push(keep(carried));
    if (lines.slice(at + 1).some((later) => sameFence(fence[1], later))) open = fence[1];
  });
  return out.join('\n');
}

function removeMarkup(text) {
  return text
    .replace(MD_LINK, (_m, label, href) => `${label} ${href}`.trim())
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*([^*\n]+?)\*\*/g, '$1')
    .replace(/(?<![\w*])\*([^*\s](?:[^*\n]*[^*\s])?)\*(?![\w*])/g, '$1')
    .replace(/(?<![A-Za-z0-9_])__([^_\n]+?)__(?![A-Za-z0-9_])/g, '$1')
    .replace(/(?<![A-Za-z0-9_])_([^_\s](?:[^_\n]*[^_\s])?)_(?![A-Za-z0-9_])/g, '$1')
    .replace(/~~([^~\n]+?)~~/g, '$1')
    .replace(INLINE_CODE, '$1');
}

// inboundUrls null leaves Markdown link targets unchecked. With keepCode, code is held out of the markup
// and link steps; NUL is taken out of the text first, so the marks cannot be forged.
function tidy(text, { keepCode, inboundUrls = null }) {
  const held = [];
  const hold = (code) => {
    held.push(code);
    return `\0${held.length - 1}\0`;
  };
  const source = String(text ?? '').replaceAll('\0', '');
  let body = unfence(source, keepCode ? hold : (line) => line);
  if (keepCode) body = body.replace(INLINE_CODE, (_m, code) => hold(code));
  if (inboundUrls) body = guardLinkTargets(body, inboundUrls);
  const plain = removeMarkup(body).replace(HELD, (_m, at) => held[Number(at)]);
  // Last, so markup inside a tag cannot hide it. Tags leave code as well.
  return stripMentionTags(plain).replace(/\n{3,}/g, '\n\n').trim();
}

export function stripForQq(text) {
  return tidy(text, { keepCode: true });
}

// Exceptions for what is plainly not a link: a method call and a CIDR block. Only the guard has them. The
// matcher stays strict for display names, and the resend after QQ refuses a URL removes these too. Known
// limit: evil.xyz(official) and evil.net(official) have the shape of self.net(x), so they pass here and only
// that resend removes them.
function readsAsCode(source, { end, key }) {
  if (CIDR.test(key)) return true;
  if (!BARE_HOST.test(key) || key.startsWith('www.') || key.includes('xn--') || HOST_ONLY.test(key)) return false;
  return callFollows(source, end);
}

function unlistedSpans(source, allowed) {
  return findUrls(source).filter((span) => !allowed.has(span.key) && !readsAsCode(source, span));
}

export function guardUrls(text, inboundUrls = []) {
  const allowed = new Set(inboundUrls.map(urlKey));
  const source = String(text ?? '');
  return replaceUrls(source, (span) => (allowed.has(span.key) || readsAsCode(source, span) ? null : URL_REMOVED));
}

export function removeUrls(text) {
  return replaceUrls(text, () => URL_REMOVED);
}

// A Markdown link target is a URL whatever it looks like, even one the matcher would read as plain text.
function guardLinkTargets(text, inboundUrls) {
  const allowed = new Set(inboundUrls.map(urlKey));
  return String(text ?? '').replace(MD_LINK, (whole, label, href) => {
    if (allowed.has(urlKey(href)) || isWholeUrl(href)) return whole;
    return `[${label}](${URL_REMOVED})`;
  });
}

function countKeys(spans) {
  const counts = new Map();
  for (const { key } of spans) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

// Everything that changes the text on its way out, leaving code as written. The result is what the second
// policy check reads. A URL that only markup inside code was hiding must not leave either: if the check
// form shows a URL more times than this form does, the check form is what goes out. Counting matters
// because a visible copy of the same address must not excuse a hidden one.
export function shapeForQq(text, inboundUrls = []) {
  const allowed = new Set(inboundUrls.map(urlKey));
  const shaped = tidy(text, { keepCode: true, inboundUrls });
  const checked = tidy(text, { keepCode: false, inboundUrls });
  const inShaped = countKeys(unlistedSpans(shaped, allowed));
  const inChecked = countKeys(unlistedSpans(checked, allowed));
  const revealed = [...inChecked].some(([key, count]) => count > (inShaped.get(key) ?? 0));
  return guardUrls(revealed ? checked : shaped, inboundUrls);
}

// For checking only, never for posting: the same text with every layer of markup removed, code included,
// mention tags removed and URLs guarded. Run the policy on this as well as on shapeForQq's result.
export function checkFormForQq(text, inboundUrls = []) {
  return guardUrls(tidy(text, { keepCode: false, inboundUrls }), inboundUrls);
}

const insideUrl = (at, spans) => spans.find((span) => span.start < at && at < span.end);

function lastSentenceEnd(text, spans) {
  let cut = -1;
  for (const m of text.matchAll(SENTENCE_END)) {
    const end = m.index + m[0].length;
    if (!insideUrl(end, spans)) cut = end;
  }
  return cut;
}

// The limit itself, unless that is inside a URL. A URL that starts the text and alone exceeds the limit
// has to be cut.
function hardCut(at, spans) {
  return insideUrl(at, spans)?.start || at;
}

// Where to cut a head that is already within the limit. A very short head would waste a part. Spans come
// from the whole text, because a URL the head cuts short looks complete from inside the head.
function cutPoint(head, spans) {
  const minimum = Math.floor(head.length / 4);
  const paragraph = head.lastIndexOf('\n\n');
  if (paragraph >= minimum && paragraph > 0) return paragraph;
  const sentence = lastSentenceEnd(head, spans);
  if (sentence >= minimum && sentence > 0) return sentence;
  const line = head.lastIndexOf('\n');
  if (line >= minimum && line > 0) return line;
  return hardCut(head.length, spans);
}

// One part for an interjection: up to the last sentence end within the limit.
export function clipToSentence(text, maxChars) {
  const whole = String(text ?? '').trim();
  if (!whole) return [];
  const chars = [...whole];
  if (chars.length <= maxChars) return [whole];
  const head = chars.slice(0, maxChars).join('');
  const spans = findUrls(whole);
  const end = lastSentenceEnd(head, spans);
  return [head.slice(0, end > 0 ? end : hardCut(head.length, spans)).trim()];
}

// Parts of at most maxChars characters, on paragraph and then sentence boundaries. Whatever does not
// fit in maxParts is dropped. Characters are code points, so a surrogate pair is never split.
export function splitParts(text, maxChars, maxParts) {
  const parts = [];
  let rest = String(text ?? '').trim();
  while (rest && parts.length < maxParts) {
    const chars = [...rest];
    if (chars.length <= maxChars) {
      parts.push(rest);
      rest = '';
      break;
    }
    const head = chars.slice(0, maxChars).join('');
    const cut = cutPoint(head, findUrls(rest));
    const piece = head.slice(0, cut).trim();
    if (piece) parts.push(piece);
    rest = rest.slice(cut).trim();
  }
  return parts;
}
