// A group member's display name as data for a prompt. Whoever holds the name chose it, and nothing here treats it as
// identity: admission, owner checks, dedupe and counters all stay on stable IDs. QQ's author.username was observed to
// follow the nickname, not the group card. Pure: the policy, names and IDs come in as arguments.
//
// The word lists are a speed bump and not the defence. Short instruction text and new lookalikes still get through; what
// holds is that a name grants nothing and the prompt calls it data. The format rules, by contrast, are meant to be complete.
import { findUrls } from './urls.js';

export const DISPLAY_NAME_MAX_POINTS = 16;
// Far longer than a name, so it is not one. It also bounds the work done on a hostile payload.
const MAX_RAW_UNITS = 512;

const LINE_BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]/gu;
// Control, format (bidi and zero-width included), private use, unassigned, fillers and the blank braille cell.
const INVISIBLE = /[\p{C}\p{Default_Ignorable_Code_Point}\u2800]/gu;
// Would close or fake the frame, a JSON string, a history line or the label around the name. * ~ # _ are markup: the exit
// removes them, which would join what they split or erase a line starting with a fence. @ reads as a mention once posted.
const FORMAT_BREAKERS = /[[\]<>{}|`\\"()=:*~#_@]/gu;
const SUBSTANCE = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;
const NOT_LETTERS = /[\p{P}\p{S}\p{Z}\p{M}\p{C}\p{Default_Ignorable_Code_Point}]/gu;

// Cyrillic, Greek and Armenian letters that read as Latin ones. Not complete: a name still proves nothing wherever this misses.
const LOOKALIKES = {
  а: 'a', в: 'b', с: 'c', ԁ: 'd', е: 'e', һ: 'h', н: 'h', і: 'i', ј: 'j', к: 'k', м: 'm', ո: 'n', о: 'o', р: 'p', г: 'r', ѕ: 's', т: 't', у: 'y', х: 'x',
  α: 'a', ε: 'e', η: 'n', ι: 'i', κ: 'k', μ: 'm', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ս: 'u', '∪': 'u',
};
const LOOKALIKE_RE = new RegExp(`[${Object.keys(LOOKALIKES).join('')}]`, 'gu');

const MARKERS = ['cloturn', 'clopolicy'];
// Whole words, in any spacing and with a number after them: "Clover" and "badminton" are ordinary names, "c l o酱" is not.
const RESERVED_WORDS = ['clo', 'owner', 'admin', 'root', 'mod', 'bot', 'sudo', 'superuser', 'operator', 'staff'];
// Anywhere in the text, with spacing and digits ignored. The first line is the host's control tokens, which it eats from a reply.
const RESERVED_TEXT = [
  'noreply', 'heartbeatok', 'replyskip', 'announceskip',
  'anthropic', 'claude', 'openrouter', 'openclaw', 'assistant', 'developer', 'administrator', 'moderator', 'system', 'ignore', 'instruction', 'prompt', 'jailbreak',
  '可洛', '克劳德', '克勞德', '系统', '系統', '管理', '群管', '超管', '群主', '羣主', '主人', '版主', '站长', '站長', '开发者', '開發者', '开发人员', '開發人員', '部署者',
  '官方', '客服', '腾讯', '騰訊', '安全中心', '通知', '公告', '机器人', '機器人', '助手', '显示名', '顯示名', '发言人', '發言人',
  '忽略', '无视', '無視', '指令', '提示词', '提示詞', '越狱', '越獄', '你必须', '你必須', '你现在是', '你現在是', '扮演',
];
const SEPARATORS = String.raw`[^\p{L}\p{N}]*`;
const spacedWord = (word) => new RegExp(`(?<![a-z0-9])${[...word].join(SEPARATORS)}\\d*(?![a-z0-9])`, 'u');
const RESERVED_WORD_RES = RESERVED_WORDS.map(spacedWord);
// An internal code name anywhere in the name, which would make one member read as another or get a code into a reply.
const CODE_TOKEN = new RegExp(String.raw`(?<![a-z0-9])u${SEPARATORS}[\p{Nd}〇零一二三四五六七八九十]+(?![a-z0-9])`, 'u');
// Label.label reads as a host even where the shared URL matcher lets it pass as text. Stricter here, since a name rarely needs it.
const DOTTED = /[a-z0-9][a-z0-9-]*\s*[.·•‧。]\s*[a-z0-9]/u;
// A QQ number, a phone number or the start of one. Digits split by punctuation count as one run.
const LONG_DIGITS = /\p{Nd}{5,}/u;
// The exit reads a whole reply with spacing removed, so a name that is half a rule trips it once a common word sits beside it.
// One probe per branch of policy/rules.json is enough: it refuses the half, whatever the reply would have put next to it.
const JOINED_BEFORE = ['加我'];
const JOINED_AFTER = ['群', '资源', '制作步骤', '货源', '注册', '教程', '源码', '是123456', 'aaaaaaaa'];

function stable(text) {
  let out = text;
  for (let i = 0; i < 4; i += 1) {
    const next = out.normalize('NFKC').replace(LINE_BREAKS, ' ').replace(INVISIBLE, '');
    if (next === out) break;
    out = next;
  }
  return out;
}

const collapse = (text) => text.replace(/\s+/gu, ' ').trim();
const cap = (text) => [...text].slice(0, DISPLAY_NAME_MAX_POINTS).join('').trim();
const fold = (text) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(LOOKALIKE_RE, (c) => LOOKALIKES[c]);
const bareOf = (text) => fold(text).replace(NOT_LETTERS, '');
const isAscii = (text) => /^[\x00-\x7f]*$/u.test(text);

function hasMarker(text) {
  const bare = bareOf(text);
  return MARKERS.some((m) => bare.includes(m));
}

// The full stop forms are Chinese ways of hiding a host name.
const hasUrl = (text) => findUrls(text.replace(/[。｡]/gu, '.')).length > 0;

function isReserved(text, names) {
  const folded = fold(text);
  const bare = folded.replace(NOT_LETTERS, '');
  const noDigits = bare.replace(/\p{N}/gu, '');
  if (CODE_TOKEN.test(folded)) return true;
  if (RESERVED_WORD_RES.some((re) => re.test(folded))) return true;
  if (RESERVED_TEXT.some((w) => noDigits.includes(w))) return true;
  return names.some((raw) => {
    const name = bareOf(String(raw));
    if (!name) return false;
    if (!isAscii(name)) return bare.includes(name) || noDigits.includes(name);
    return spacedWord(name).test(folded);
  });
}

const hits = (policy, text, rawIds) => policy.check(text).hit !== false || policy.checkLeak(text, { secrets: [], rawIds }).hit !== false;

// A hit here would otherwise cost a whole reply at the exit, as soon as she repeated the name. A throw counts as a hit.
function policyRejects(policy, text, rawIds, withNeighbours) {
  try {
    if (hits(policy, text, rawIds)) return true;
    if (!withNeighbours) return false;
    return JOINED_BEFORE.some((w) => hits(policy, w + text, rawIds)) || JOINED_AFTER.some((w) => hits(policy, text + w, rawIds));
  } catch {
    return true;
  }
}

function refusal(text, { policy, names, rawIds }, withNeighbours) {
  if (hasMarker(text)) return 'marker';
  if (hasUrl(text)) return 'url';
  if (isReserved(text, names)) return 'reserved';
  if (DOTTED.test(fold(text))) return 'url';
  if (!SUBSTANCE.test(text)) return 'empty';
  if (policyRejects(policy, text, rawIds, withNeighbours)) return 'policy';
  if (LONG_DIGITS.test(bareOf(text))) return 'digits';
  return null;
}

// { name, reason }. name is null unless reason is 'ok'. The reason never carries the value.
export function checkDisplayName(raw, { policy, names = [], rawIds = [] } = {}) {
  const refuse = (reason) => ({ name: null, reason });
  if (typeof raw !== 'string' || raw.length === 0) return refuse('absent');
  if (raw.length > MAX_RAW_UNITS) return refuse('too_long');
  const visible = stable(raw);
  const cleaned = collapse(stable(visible.replace(FORMAT_BREAKERS, '')));
  // Before the breakers are removed as well: without its colon, "https://a" reads as no URL at all.
  if (hasMarker(visible)) return refuse('marker');
  if (hasUrl(visible)) return refuse('url');
  if (!cleaned) return refuse('empty');
  const deps = { policy, names, rawIds };
  const whole = refusal(cleaned, deps, false);
  if (whole) return refuse(whole);
  // Again on what is kept: the cut can expose a word or a URL, as "abcdefghij adminton" would.
  const name = cap(cleaned);
  const kept = refusal(name, deps, true);
  if (kept) return refuse(kept);
  return { name, reason: 'ok' };
}

export const sanitizeDisplayName = (raw, deps) => checkDisplayName(raw, deps).name;

// The one label format. The code stays, so two members with one name remain two people.
export const speakerLabel = (code, name) => (name ? `${code}（显示名：${name}）` : code);
