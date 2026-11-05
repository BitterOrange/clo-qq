// Raw gateway payloads with the observed shapes (no real bodies or IDs).
import { BOT_MEMBER, GROUP_A, MEMBER, MEMBER2 } from '../harness/gateway.mjs';

let serial = 0;
export const nextId = (prefix = 'MSG') => `${prefix}${String(++serial).padStart(6, '0')}${Date.now().toString(36).toUpperCase()}`;

function base({ id = nextId(), group = GROUP_A, member = MEMBER, bot = false, content = '', timestamp, extra = {}, ext = [], username = 'SENDER-DISPLAY-NAME' } = {}) {
  return {
    id,
    content,
    timestamp: timestamp ?? new Date().toISOString(),
    group_openid: group,
    group_id: group,
    message_type: 0,
    message_scene: { source: 'default', ext: ['msg_idx=INDEX1', 'auth_token=AUTH1', ...ext] },
    attachments: [],
    author: { member_openid: member, id: member, bot, ...(username === null ? {} : { username }), member_role: 'member', union_openid: '' },
    ...extra,
  };
}

const botMention = (id = BOT_MEMBER) => ({ scope: 'single', bot: true, is_you: true, id, member_openid: id, member_role: 'member', username: 'BOT-DISPLAY-NAME' });
const otherMention = (id = MEMBER2) => ({ scope: 'single', bot: false, is_you: false, id, member_openid: id, member_role: 'member', username: 'OTHER-DISPLAY-NAME' });
const allMention = { scope: 'all', is_you: true, username: 'ALL-DISPLAY-NAME' };

// Each returns [eventType, payload].
export const groupAtOff = (text, o = {}) => ['GROUP_AT_MESSAGE_CREATE', base({ ...o, content: ` ${text}` })];
export const fullAt = (text, o = {}) => ['GROUP_MESSAGE_CREATE', base({ ...o, content: `<@${BOT_MEMBER}> ${text}`, extra: { mentions: [botMention()], ...o.extra } })];
export const atAll = (text, o = {}) => ['GROUP_MESSAGE_CREATE', base({ ...o, content: `<@all> ${text}`, extra: { mentions: [allMention] } })];
export const atOther = (text, o = {}) => ['GROUP_MESSAGE_CREATE', base({ ...o, content: `<@${MEMBER2}> ${text}`, extra: { mentions: [otherMention()] } })];
export const atBotAndAll = (text, o = {}) => ['GROUP_MESSAGE_CREATE', base({ ...o, content: `<@${BOT_MEMBER}> <@all> ${text}`, extra: { mentions: [botMention(), allMention] } })];
export const plain = (text, o = {}) => ['GROUP_MESSAGE_CREATE', base({ ...o, content: text })];
export const quoted = (text, refIdx, o = {}) => ['GROUP_MESSAGE_CREATE', base({ ...o, content: text, ext: [`ref_msg_idx=${refIdx}`] })];
export const ambiguousBot = (text, o = {}) => ['GROUP_MESSAGE_CREATE', base({ ...o, content: `<@${BOT_MEMBER}> ${text}`, extra: { mentions: [{ scope: 'single', bot: true, is_you: false, id: BOT_MEMBER, member_openid: BOT_MEMBER, username: 'X' }] } })];

const imageAttachment = { content: '', content_type: 'image/jpeg', filename: 'a.jpg', height: 1, size: 1, url: 'https://multimedia.example/IMAGE', width: 1 };

// '@ + image' as observed: type 103, msg_elements, parallel_message, top-level attachments empty.
export const atImage = (text, o = {}) => ['GROUP_MESSAGE_CREATE', base({
  ...o,
  content: `<@${BOT_MEMBER}> ${text}`,
  ext: ['ref_msg_idx=REF-OF-ELEMENT-NOT-QUOTE'],
  extra: {
    message_type: 103,
    mentions: [botMention()],
    msg_elements: [{ content: 'QUOTED-ELEMENT-TEXT', message_type: 0, msg_idx: 'ELEMENT-INDEX', attachments: [imageAttachment] }],
    parallel_message: { msg_nodes: [{ content: 'PARALLEL-NODE-TEXT', message_type: 0 }] },
    attachments: [],
  },
})];
export const image103 = (text, refIdx, o = {}) => ['GROUP_MESSAGE_CREATE', base({
  ...o,
  content: text,
  ext: refIdx ? [`ref_msg_idx=${refIdx}`] : [],
  extra: {
    message_type: 103,
    msg_elements: [{ content: 'QUOTED-ELEMENT-TEXT', message_type: 0, msg_idx: 'ELEMENT-INDEX', attachments: [imageAttachment] }],
    parallel_message: { msg_nodes: [{ content: 'PARALLEL-NODE-TEXT', message_type: 0 }] },
    attachments: [],
  },
})];
export const imageOnly = (o = {}) => ['GROUP_MESSAGE_CREATE', base({ ...o, content: '', extra: { attachments: [imageAttachment] } })];

export const dm = (text, o = {}) => ['C2C_MESSAGE_CREATE', {
  id: o.id ?? nextId(),
  content: text,
  timestamp: new Date().toISOString(),
  message_type: 0,
  author: { user_openid: o.member ?? MEMBER, id: o.member ?? MEMBER, bot: false },
}];

export function push(s, [type, payload]) {
  s.qq.push(type, payload);
  return payload.id;
}
