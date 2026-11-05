// One URL matcher, for the inbound list and the outbound guard, so both compare the same form.
// Matching runs on a folded copy (NFKC, no format characters); spans map back to the original text.
const STOP = String.raw`\s<>"'，。！？；、）)\]】》`;
const LABEL = String.raw`[a-z0-9](?:[a-z0-9-]*[a-z0-9])?`;
// Digits and hyphens up to the first letter, so a long run has one way to match and cannot backtrack.
const WORD_LABEL = String.raw`[0-9-]*[a-z][a-z0-9-]*`;
const ASCII_PATH = String.raw`[a-z0-9\-._~%+=&/?#:@]`;
const PORT_PATH = String.raw`(?::\d{1,5})?(?:[/?#]${ASCII_PATH}*)?`;
// Enough to read as a host with no path. English words that happen to be TLDs (in, me, us, to, is) and
// file extensions (md, py, sh, rs) are left out: "sign.in" and "README.md" are ordinary text.
const TLDS = 'com|net|org|edu|gov|cn|info|biz|xyz|top|site|online|shop|club|vip|cc|tv|io|co|ai|app|dev|link|live|pro|wang|tech|store|fun|icu|ink|work|mobi|asia|hk|tw|jp|kr|uk|de|fr|ru|sg|au|ca';
// With a path, any alphabetic ending counts, except these: "Node.js/Deno" is not a URL.
const FILE_ENDINGS = 'js|mjs|cjs|ts|tsx|jsx|py|md|txt|sh|rs|go|c|h|cpp|hpp|cs|rb|pl|php|html|htm|css|json|yaml|yml|toml|xml|csv|log|ini|cfg|conf|exe|dll|bat|ps1|zip|gz|tar|rar|png|jpg|jpeg|gif|svg|pdf|doc|docx|xls|xlsx|ppt|pptx|mp3|mp4';

// With a scheme: an ASCII host and path, or anything up to the end of the host for schemeUrlEnd to judge.
const ASCII_CHAR = String.raw`(?:(?![${STOP}])[\x21-\x7e])`;
const HOST_CHAR = String.raw`(?:(?![${STOP}/?#])[\x21-\x7e])`;

const URL_SOURCE = [
  String.raw`(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*://(?:${HOST_CHAR}*[/?#]${ASCII_CHAR}*|[^${STOP}/?#]+)`,
  String.raw`(?<![a-z0-9.@-])www\.(?:${LABEL}\.)*${LABEL}${PORT_PATH}`,
  String.raw`(?<![a-z0-9.@-])(?:${LABEL}\.)+(?:${TLDS}|xn--[a-z0-9-]+)(?![a-z0-9-])(?:\.${LABEL})*${PORT_PATH}`,
  String.raw`(?<![a-z0-9.@-])(?:${LABEL}\.)*${WORD_LABEL}\.(?!(?:${FILE_ENDINGS})(?![a-z0-9-]))[a-z]{2,24}(?![a-z0-9-])[/?#]${ASCII_PATH}+`,
  String.raw`(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5}(?:[/?#]${ASCII_PATH}*)?|[/?#]${ASCII_PATH}+)`,
].join('|');

const TRAILING = /[.,;:!?]+$/u;
const FORMAT_CHAR = /\p{Cf}/u;
// NFKC would turn these into ASCII that can sit inside a URL. In Chinese text they end one.
const KEEP_WIDE = new Set(['，', '！', '？', '；', '（', '）', '…']);

function fold(text) {
  let copy = '';
  const map = [];
  let at = 0;
  for (const ch of text) {
    if (!FORMAT_CHAR.test(ch)) {
      const nf = KEEP_WIDE.has(ch) ? ch : ch.normalize('NFKC');
      for (let i = 0; i < nf.length; i += 1) map.push(at);
      copy += nf;
    }
    at += ch.length;
  }
  map.push(text.length);
  return { copy, map };
}

const ASCII_HEAD = /^[a-z][a-z0-9+.-]*:\/\/[\x21-\x7e]*/iu;
const REST_OF_URL = new RegExp(String.raw`[^${STOP}]*`, 'uy');

// In Chinese text a URL with a scheme has no stop character near its end. It ends at the first non-ASCII
// character once the host is complete, and a path that mixes in Chinese is cut there too, since nothing
// separates it from the sentence after it. A host that goes on after that character, as in
// https://www.例子.com/x, is taken whole to the next stop: cutting there would let the address through.
// Only that case reads on, so text full of cut URLs is still read once.
function schemeUrlEnd(copy, m) {
  const head = ASCII_HEAD.exec(m[0])?.[0];
  if (!head || head.length === m[0].length) return m[0];
  const host = head.slice(head.indexOf('://') + 3);
  if (host && !/[.-]$/u.test(host) && !m[0].slice(head.length).includes('.')) return head;
  REST_OF_URL.lastIndex = m.index + m[0].length;
  return m[0] + REST_OF_URL.exec(copy)[0];
}

// Scheme and host compare in any case; the rest as written.
export function urlKey(url) {
  const { copy } = fold(String(url));
  return copy.replace(/^(?:[a-z][a-z0-9+.-]*:\/\/)?[^/?#]*/iu, (head) => head.toLowerCase());
}

export function findUrls(text) {
  const { copy, map } = fold(String(text ?? ''));
  const out = [];
  const pattern = new RegExp(URL_SOURCE, 'giu');
  for (let m = pattern.exec(copy); m; m = pattern.exec(copy)) {
    const whole = schemeUrlEnd(copy, m);
    // What was cut off is ordinary text again and may hold another URL.
    pattern.lastIndex = m.index + whole.length;
    const found = whole.replace(TRAILING, '');
    if (!found) continue;
    out.push({ start: map[m.index], end: map[m.index + found.length], key: urlKey(found) });
  }
  return out;
}

// A replacer returning null keeps the original characters.
export function replaceUrls(text, replacer) {
  const source = String(text ?? '');
  let out = '';
  let last = 0;
  for (const span of findUrls(source)) {
    out += source.slice(last, span.start) + (replacer(span) ?? source.slice(span.start, span.end));
    last = span.end;
  }
  return out + source.slice(last);
}

// Replaces matches of a regex that is tested on the folded copy, so full-width forms cannot hide.
export function foldedRemove(text, pattern) {
  const source = String(text ?? '');
  const { copy, map } = fold(source);
  let out = '';
  let last = 0;
  for (const m of copy.matchAll(pattern)) {
    out += source.slice(last, map[m.index]);
    last = map[m.index + m[0].length];
  }
  return out + source.slice(last);
}

export const isWholeUrl = (text) => {
  const spans = findUrls(text);
  return spans.length === 1 && spans[0].start === 0 && spans[0].end === String(text).length;
};
