// Turns a copied raw gateway payload into an InboundEvent. It never sees the SDK object or the host.
// <@...> tags, which hold IDs, never leave this file. Display names stop here too, with one exception: author.username of
// a group event whose group has the switch on, passed unchecked as displayNameRaw for the gate to sanitize or drop.
// mentions[].username never leaves.
const TAG = /<@!?([^<>\s]*)>/g;
const ALL_WORD = '@所有人';
const OTHER_WORD = '@群友';
const GROUP_EVENTS = new Set(['GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE']);

function placeholderFor(att) {
  const type = String(att?.content_type ?? '').toLowerCase();
  if (type.startsWith('image/') || type === 'image') return '[图片]';
  if (type.startsWith('audio/') || type === 'voice') return '[语音]';
  if (type.startsWith('video/') || type === 'video') return '[视频]';
  if (type || att?.filename) return '[文件]';
  return '[非文字消息]';
}

// Top-level attachments can be empty on type 103, with the real ones under msg_elements.
function placeholdersOf(raw) {
  const out = [];
  const add = (list) => {
    for (const att of Array.isArray(list) ? list : []) {
      const p = placeholderFor(att);
      if (!out.includes(p)) out.push(p);
    }
  };
  add(raw.attachments);
  for (const el of Array.isArray(raw.msg_elements) ? raw.msg_elements : []) add(el?.attachments);
  return out;
}

function sceneValue(raw, name) {
  const ext = raw.message_scene?.ext;
  if (!Array.isArray(ext)) return null;
  const prefix = `${name}=`;
  for (const entry of ext) {
    if (typeof entry === 'string' && entry.startsWith(prefix) && entry.length > prefix.length) return entry.slice(prefix.length);
  }
  return null;
}

function stripTags(content, mentions, eventType) {
  const you = new Set();
  for (const m of mentions) {
    if (m?.scope === 'single' && m?.is_you === true) {
      for (const id of [m.id, m.member_openid, m.user_openid]) if (id) you.add(id);
    }
  }
  return content.replace(TAG, (_all, id) => {
    if (id.toLowerCase() === 'all') return ALL_WORD;
    if (you.has(id)) return '';
    // A full-message-off @ names only the bot. An ID we cannot place is never kept.
    return eventType === 'GROUP_AT_MESSAGE_CREATE' ? '' : OTHER_WORD;
  });
}

function parseTime(raw) {
  if (typeof raw.timestamp !== 'string') return null;
  const ms = Date.parse(raw.timestamp);
  return Number.isFinite(ms) ? ms : null;
}

function build(eventType, raw, { kind, conversationId, senderId, receivedAt, isRealAt, mentions }) {
  const content = typeof raw.content === 'string' ? raw.content : '';
  const body = stripTags(content, mentions, eventType).trim();
  const placeholders = placeholdersOf(raw);
  if (!body && placeholders.length === 0 && raw.message_type !== undefined && raw.message_type !== 0) placeholders.push('[非文字消息]');
  const said = body.split(OTHER_WORD).join('').split(ALL_WORD).join('').trim();
  return {
    kind,
    eventType,
    messageId: raw.id,
    conversationId: conversationId ?? null,
    senderId: senderId ?? null,
    senderIsBot: raw.author?.bot === true,
    text: [body, ...placeholders].filter(Boolean).join(' '),
    hasUserText: said.length > 0,
    placeholders,
    timestampMs: parseTime(raw),
    receivedAt,
    isRealAt,
    mentionsAll: mentions.some((m) => m?.scope === 'all') || /<@all>/i.test(content),
    mentionsOther: mentions.some((m) => m?.scope === 'single' && m?.is_you !== true),
    ambiguousMention: mentions.some((m) => m?.bot === true && m?.is_you !== true),
    refMsgIdx: sceneValue(raw, 'ref_msg_idx'),
    msgIdx: sceneValue(raw, 'msg_idx'),
    msgType: typeof raw.message_type === 'number' ? raw.message_type : null,
  };
}

export function normalize(eventType, raw, { receivedAt = Date.now(), keepDisplayName = () => false } = {}) {
  if (raw === null || typeof raw !== 'object') return null;
  const mentions = Array.isArray(raw.mentions) ? raw.mentions : [];
  if (GROUP_EVENTS.has(eventType)) {
    const evt = build(eventType, raw, {
      kind: 'group',
      conversationId: raw.group_openid,
      senderId: raw.author?.member_openid,
      receivedAt,
      mentions,
      isRealAt: eventType === 'GROUP_AT_MESSAGE_CREATE' || mentions.some((m) => m?.scope === 'single' && m?.is_you === true),
    });
    if (typeof raw.author?.username === 'string' && keepDisplayName(raw.group_openid) === true) evt.displayNameRaw = raw.author.username;
    return evt;
  }
  if (eventType === 'C2C_MESSAGE_CREATE') {
    const senderId = raw.author?.user_openid;
    return build(eventType, raw, { kind: 'direct', conversationId: senderId, senderId, receivedAt, mentions: [], isRealAt: false });
  }
  return null;
}
