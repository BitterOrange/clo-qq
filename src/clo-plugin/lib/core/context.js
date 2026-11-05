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

    push(groupKey, { senderKey, text, ts, eventKey, displayName = null, arrival }) {
      const sender = pseudonym(groupKey, senderKey);
      const g = groupOf(groupKey);
      g.items.push({ sender, text, ts, eventKey, displayName, arrival });
      if (g.items.length > maxItems) g.items.splice(0, g.items.length - maxItems);
      return sender;
    },

    // Newest entries that fit the token cap, oldest first, in the host's HistoryEntry shape.
    // Labels count toward the cap only when they are sent, so without names this is what it always was.
    // hide: event keys to leave out. They take no room under the cap. A hidden line still counts for newestNames: a label
    // belongs to the member, not to one line.
    history(groupKey, excludeEventKey, at, { showNames = false, current = null, hide = null } = {}) {
      const names = showNames ? newestNames(groupKey, at, current) : null;
      const out = [];
      let tokens = 0;
      for (const i of live(groupKey, excludeEventKey, at).filter((l) => !hide?.has(l.eventKey)).reverse()) {
        const sender = names ? speakerLabel(i.sender, names.get(i.sender)) : i.sender;
        tokens += estimateTokens(i.text) + (names ? estimateTokens(sender) : 0);
        if (tokens > maxTokens) break;
        out.push({ sender, body: i.text, timestamp: i.ts });
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
