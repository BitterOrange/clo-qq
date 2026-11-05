// Pure outbound text shaping. The exit checks the policy on the model's text and again on the result of
// shapeForQq, because removing markup can join what the markup split.
import { foldedRemove, isWholeUrl, replaceUrls, urlKey } from '../../core/urls.js';

const SENTENCE_END = /[。！？!?…]+["'”’）)】》]*|\.(?=\s|$)/g;
const MD_LINK = /!?\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)/g;
// <@all>, <@ID>, spaced forms and the official plugin's tags. Whether QQ renders them from msg_type 0 is
// not known, so none of them leaves.
const MENTION_TAGS = [/<\s*@[^<>]*>/gu, /<\s*\/?\s*qqbot-at-[^<>]*>/giu];
export const URL_REMOVED = '[链接已移除]';

function stripMentionTags(text) {
  let out = text;
  for (let previous = null; previous !== out;) {
    previous = out;
    for (const tag of MENTION_TAGS) out = foldedRemove(out, tag);
  }
  return out;
}

export function stripForQq(text) {
  const plain = String(text ?? '')
    .replace(/^\s*(```|~~~).*$/gm, '')
    .replace(MD_LINK, (_m, label, href) => `${label} ${href}`.trim())
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*([^*\n]+?)\*\*/g, '$1')
    .replace(/(?<![\w*])\*([^*\s](?:[^*\n]*[^*\s])?)\*(?![\w*])/g, '$1')
    .replace(/(?<![A-Za-z0-9_])__([^_\n]+?)__(?![A-Za-z0-9_])/g, '$1')
    .replace(/(?<![A-Za-z0-9_])_([^_\s](?:[^_\n]*[^_\s])?)_(?![A-Za-z0-9_])/g, '$1')
    .replace(/~~([^~\n]+?)~~/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1');
  // Last, so markup inside a tag cannot hide it.
  return stripMentionTags(plain).replace(/\n{3,}/g, '\n\n').trim();
}

export function guardUrls(text, inboundUrls = []) {
  const allowed = new Set(inboundUrls.map(urlKey));
  return replaceUrls(text, ({ key }) => (allowed.has(key) ? null : URL_REMOVED));
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

// Everything that changes the text on its way out. The result is what the second policy check reads.
export function shapeForQq(text, inboundUrls = []) {
  return guardUrls(stripForQq(guardLinkTargets(text, inboundUrls)), inboundUrls);
}

function lastSentenceEnd(text) {
  let cut = -1;
  for (const m of text.matchAll(SENTENCE_END)) cut = m.index + m[0].length;
  return cut;
}

// Where to cut a head that is already within the limit. A very short head would waste a part.
function cutPoint(head) {
  const minimum = Math.floor(head.length / 4);
  const paragraph = head.lastIndexOf('\n\n');
  if (paragraph >= minimum && paragraph > 0) return paragraph;
  const sentence = lastSentenceEnd(head);
  if (sentence >= minimum && sentence > 0) return sentence;
  const line = head.lastIndexOf('\n');
  if (line >= minimum && line > 0) return line;
  return head.length;
}

// One part for an interjection: up to the last sentence end within the limit.
export function clipToSentence(text, maxChars) {
  const whole = String(text ?? '').trim();
  if (!whole) return [];
  const chars = [...whole];
  if (chars.length <= maxChars) return [whole];
  const head = chars.slice(0, maxChars).join('');
  const end = lastSentenceEnd(head);
  return [(end > 0 ? head.slice(0, end) : head).trim()];
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
    const cut = cutPoint(head);
    const piece = head.slice(0, cut).trim();
    if (piece) parts.push(piece);
    rest = rest.slice(cut).trim();
  }
  return parts;
}
