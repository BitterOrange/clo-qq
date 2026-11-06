// Owner commands, group scope only. Parsing is pure. Ack strings are fixed text and carry no state
// beyond mode and pause: no cost, token, model or session key ever reaches a group from here.
const KNOWN = new Set(['clo', 'status', 'new', 'reset', 'stop']);

const ACKS = {
  pauseGroup: '本群已暂停。',
  pauseAll: '已全部暂停。',
  resumeGroup: '本群已恢复。',
  resumeAll: '已全部恢复。',
  resumeInterject: '已恢复插话。',
  '/new': '已开始新的对话。',
  '/reset': '已重置本群对话。',
  '/stop': '已停止当前回复。',
};

const MODE_LABEL = { live: '正常运行', 'dry-run': '试运行' };

export const forwardAck = (authorizedCommand) => ACKS[authorizedCommand];

// Invisible characters and full-width forms cannot hide a command from the owner check.
export function parseCommand(text) {
  const clean = String(text ?? '').normalize('NFKC').replace(/\p{Cf}/gu, '').trim();
  const m = /^\/(\S*)\s*([\s\S]*)$/u.exec(clean);
  if (!m) return null;
  const first = m[1].toLowerCase();
  const name = KNOWN.has(first) ? first : 'other';
  const args = m[2].split(/\s+/u).filter(Boolean);
  return { name, args, standalone: args.length === 0 };
}

// 'local' runs here and never reaches the host. 'forward' reaches it with commands.authorized true.
export function commandRoute(cmd) {
  if (cmd.name === 'new' || cmd.name === 'reset' || cmd.name === 'stop') return cmd.standalone ? 'forward' : 'unknown';
  if (cmd.name === 'status') return cmd.standalone ? 'local' : 'unknown';
  if (cmd.name !== 'clo') return 'unknown';
  const [verb, arg, extra] = cmd.args.map((a) => a.toLowerCase());
  if (extra !== undefined) return 'unknown';
  if (verb === 'status') return arg === undefined ? 'local' : 'unknown';
  if (verb === 'pause') return arg === undefined || arg === 'all' ? 'local' : 'unknown';
  if (verb === 'resume') return arg === undefined || arg === 'all' || arg === 'interject' ? 'local' : 'unknown';
  return 'unknown';
}

// The own runtime's rule: only a listed owner command is a command. Any other slash text is ordinary text, so a
// member's words that happen to start with a slash go through the normal triggers.
export function listedCommand(text) {
  const cmd = parseCommand(text);
  return cmd && commandRoute(cmd) !== 'unknown' ? cmd : null;
}

export function runLocalCommand(cmd, { store, groupKey, effective }) {
  const [verb, arg] = cmd.name === 'status' ? ['status'] : cmd.args.map((a) => a.toLowerCase());
  if (verb === 'status') {
    const p = store.pauseState(groupKey);
    return { ackText: `模式：${MODE_LABEL[effective.mode] ?? effective.mode}。本群：${p.global || p.group ? '已暂停' : '未暂停'}。` };
  }
  if (verb === 'pause') {
    if (arg === 'all') {
      store.setControl('global_paused', '1', 'owner');
      return { ackText: ACKS.pauseAll };
    }
    store.setControl(`group_paused:${groupKey}`, '1', 'owner');
    return { ackText: ACKS.pauseGroup };
  }
  if (verb === 'resume') {
    if (arg === 'all') {
      store.delControl('global_paused');
      return { ackText: ACKS.resumeAll };
    }
    if (arg === 'interject') {
      store.delControl('interject_paused');
      return { ackText: ACKS.resumeInterject };
    }
    store.delControl(`group_paused:${groupKey}`);
    return { ackText: ACKS.resumeGroup };
  }
  throw new Error('runLocalCommand: not a local command');
}
