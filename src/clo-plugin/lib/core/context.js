// Recent messages for one process, in memory only. Bounded by item count, age and an estimated token
// cap. A restart loses it. Senders leave this module as pseudonyms. A sanitized display name rests on the line it came
// with, so it expires and clears with that line, and leaves only through history() when the caller asks for names.
import { speakerLabel } from './displayName.js';

// Not a tokenizer: a deliberately high guess of 2 tokens per non-ASCII character, 1 per 3 ASCII.
export function estimateTokens(text) {
  let ascii = 0;
  let other = 0;
  for (const ch of String(text)) {
    if (ch.codePointAt(0) < 128) ascii += 1;
    else other += 1;
  }
  return other * 2 + Math.ceil(ascii / 3);
}

const clamp = (text, chars) => [...String(text)].slice(0, chars).join('');

// One line may take half the token cap, so a very long line leaves room for the lines around it. Under the floor a
// line is ordinary speech: it is read whole or not at all, which is what a very small cap still gets.
const LINE_FLOOR_TOKENS = 256;
const SHORTENED = '…（太长，后面省略）';

function fitTokens(text, budget) {
  if (estimateTokens(text) <= budget) return text;
  const room = budget - estimateTokens(SHORTENED);
  let ascii = 0;
  let other = 0;
  let kept = '';
  for (const ch of String(text)) {
    if (ch.codePointAt(0) < 128) ascii += 1;
    else other += 1;
    if (other * 2 + Math.ceil(ascii / 3) > room) break;
    kept += ch;
  }
  return kept + SHORTENED;
}

export function createContextBuffer({ maxItems, maxAgeMs, maxTokens }) {
  const groups = new Map();

  function groupOf(key) {
    let g = groups.get(key);
    if (!g) {
      g = { items: [], names: new Map() };
      groups.set(key, g);
    }
    return g;
  }

  function pseudonym(groupKey, senderKey) {
    const { names } = groupOf(groupKey);
    let name = names.get(senderKey);
    if (!name) {
      name = `U${names.size + 1}`;
      names.set(senderKey, name);
    }
    return name;
  }

  const prune = (g, at) => {
    g.items = g.items.filter((i) => at - i.ts <= maxAgeMs);
  };

  const live = (groupKey, excludeEventKey, at) => {
    const g = groups.get(groupKey);
    if (!g) return [];
    prune(g, at);
    return g.items.filter((i) => i.eventKey !== excludeEventKey);
  };

  // One member, one label: the newest line decides, and a newest line with no usable name means no name.
  function newestNames(groupKey, at, current) {
    const names = new Map();
    const g = groups.get(groupKey);
    if (g) {
      prune(g, at);
      for (const i of g.items) names.set(i.sender, i.displayName ?? null);
    }
    if (current) names.set(current.sender, current.displayName ?? null);
    return names;
  }

  return {
    pseudonym,

    // Caps for everything read from here on. A missing cap stays as it is. Lines over a lower item cap go now; lines
    // over a lower age cap go at the next read or sweep.
    configure(next = {}) {
      maxItems = next.maxItems ?? maxItems;
      maxAgeMs = next.maxAgeMs ?? maxAgeMs;
      maxTokens = next.maxTokens ?? maxTokens;
      for (const g of groups.values()) {
        if (g.items.length > maxItems) g.items.splice(0, g.items.length - maxItems);
      }
    },

    push(groupKey, { senderKey, text, ts, eventKey, displayName = null, arrival }) {
      const sender = pseudonym(groupKey, senderKey);
      const g = groupOf(groupKey);
      g.items.push({ sender, text, ts, eventKey, displayName, arrival });
      if (g.items.length > maxItems) g.items.splice(0, g.items.length - maxItems);
      return sender;
    },

    // Newest entries that fit the token cap, oldest first, in the host's HistoryEntry shape.
    // Labels count toward the cap only when they are sent, so without names this is what it always was.
    // A line over the per-line cap is shortened here and only here, so one long message cannot empty the history. The
    // cap is weighed against the words alone; a label still counts toward the total.
    // hide: event keys to leave out. They take no room under the cap. A hidden line still counts for newestNames: a label
    // belongs to the member, not to one line.
    history(groupKey, excludeEventKey, at, { showNames = false, current = null, hide = null } = {}) {
      const names = showNames ? newestNames(groupKey, at, current) : null;
      const lineCap = Math.max(Math.floor(maxTokens / 2), LINE_FLOOR_TOKENS);
      const out = [];
      let tokens = 0;
      for (const i of live(groupKey, excludeEventKey, at).filter((l) => !hide?.has(l.eventKey)).reverse()) {
        const sender = names ? speakerLabel(i.sender, names.get(i.sender)) : i.sender;
        const body = fitTokens(i.text, lineCap);
        tokens += estimateTokens(body) + (names ? estimateTokens(sender) : 0);
        if (tokens > maxTokens) break;
        out.push({ sender, body, timestamp: i.ts });
      }
      return out.reverse();
    },

    // Event keys of this member's lines that came before the given arrival. QQ timestamps are whole seconds, so arrival decides.
    ownEarlier(groupKey, senderKey, arrival) {
      const g = groups.get(groupKey);
      const sender = g?.names.get(senderKey);
      if (!sender) return [];
      return g.items.filter((i) => i.sender === sender && i.arrival < arrival).map((i) => i.eventKey);
    },

    forgetNames(groupKey) {
      const g = groups.get(groupKey);
      if (g) for (const i of g.items) i.displayName = null;
    },

    // For a switch turned off while a group has gone quiet.
    retainNames(groupKeys) {
      for (const [key, g] of groups) {
        if (groupKeys.has(key)) continue;
        for (const i of g.items) i.displayName = null;
      }
    },

    lines(groupKey, excludeEventKey, count, chars, at) {
      return live(groupKey, excludeEventKey, at).slice(-count).map((i) => ({ sender: i.sender, text: clamp(i.text, chars) }));
    },

    // Drops expired text even when a group has gone quiet. Returns the count of items still held.
    sweep(at) {
      let held = 0;
      for (const g of groups.values()) {
        prune(g, at);
        held += g.items.length;
      }
      return held;
    },

    clear(groupKey) {
      const g = groups.get(groupKey);
      if (g) g.items = [];
    },
  };
}
