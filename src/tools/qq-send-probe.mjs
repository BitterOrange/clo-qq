// Q0b send probe. It sends one fixed, reviewed text, then stops. It never calls a model and never retries.
//
// Safeguards:
// - Only texts in CASES can be sent. There is no way to pass free text.
// - It needs --approve <case> on the command line, given only after the user has agreed to that send.
// - Passive cases reply only to a message whose text is exactly the trigger, from an allowed target hash.
// - Results record status and error code only, never message text or raw IDs.
//
// Run through scripts\q0-send.ps1, which uses the private Node.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GatewayConnection, TokenManager } from '@tencent-connect/qqbot-nodejs/protocol';
import { hashId, parseQqEnv, scrub } from './qq-shape.mjs';

const USER_AGENT = `clo-q0-probe/0 (Node/${process.versions.node})`;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INTENTS = 1 << 25;
/** How long to keep listening after a send, to see whether the bot receives its own message. */
const ECHO_WATCH_MS = 20000;

export const TRIGGER = '可洛测试发送';

export const CASES = Object.freeze({
  'passive-text': { scope: 'group', mode: 'passive', msg_type: 0, content: '【测试】这是接线测试的固定文字，请忽略。' },
  'passive-url': { scope: 'group', mode: 'passive', msg_type: 0, content: '【测试】纯文本网址：https://example.com' },
  'passive-markdown': { scope: 'group', mode: 'passive', msg_type: 2, markdown: '【测试】Markdown 链接：[示例](https://example.com)' },
  'dm-text': { scope: 'c2c', mode: 'passive', msg_type: 0, content: '【测试】这是接线测试的固定文字，请忽略。' },
  'dm-url': { scope: 'c2c', mode: 'passive', msg_type: 0, content: '【测试】纯文本网址：https://example.com' },
  'dm-markdown': { scope: 'c2c', mode: 'passive', msg_type: 2, markdown: '【测试】Markdown 链接：[示例](https://example.com)' },
  'dm-proactive': { scope: 'c2c', mode: 'proactive', msg_type: 0, content: '【测试】这是 60 分钟后的主动私聊测试，请忽略。' },
});

/** Builds the exact request. Passive replies carry the inbound msg_id and an explicit msg_seq. */
export function buildRequest(caseName, targetId, msgId, msgSeq = 1) {
  const c = CASES[caseName];
  if (!c) throw new Error(`Unknown case ${caseName}`);
  const path = c.scope === 'c2c' ? `/v2/users/${targetId}/messages` : `/v2/groups/${targetId}/messages`;
  const body = { msg_type: c.msg_type, msg_seq: msgSeq };
  if (c.msg_type === 2) body.markdown = { content: c.markdown };
  else body.content = c.content;
  if (c.mode === 'passive') {
    if (!msgId) throw new Error('A passive case needs an inbound message id');
    body.msg_id = msgId;
  }
  return { path, body };
}

/** True only for the exact trigger text from the allowed target. An @ tag or leading space is tolerated. */
export function isTrigger(msg, caseDef, allowHash, salt) {
  const kind = caseDef.scope === 'c2c' ? 'c2c' : 'group';
  if (msg.kind !== kind) return false;
  if (msg.senderIsBot) return false;
  const target = kind === 'c2c' ? msg.senderId : msg.groupOpenid;
  if (hashId(salt, target) !== allowHash) return false;
  const text = String(msg.content ?? '').replace(/<@!?[^>]+>/g, '').trim();
  return text === TRIGGER;
}

async function post(apiBase, token, req) {
  const res = await fetch(`${apiBase}${req.path}`, {
    method: 'POST',
    headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify(req.body),
    signal: AbortSignal.timeout(15000),
  });
  let json = null;
  try { json = await res.json(); } catch { /* status alone is still a result */ }
  return { status: res.status, code: json?.code ?? json?.err_code ?? null, hasId: Boolean(json?.id) };
}

/** Sends at most once, then watches briefly for an echo. Exported so tests can run it against a mock. */
export async function runProbe({ caseName, allowHash, appId, secret, apiBase, tokenBase, salt, resultPath, signal, say = console.log, savedTarget = null, echoWatchMs = ECHO_WATCH_MS }) {
  const c = CASES[caseName];
  if (!c) throw new Error(`Unknown case ${caseName}`);
  const secrets = [secret];
  const tokens = new TokenManager({ userAgent: USER_AGENT, baseUrl: tokenBase });
  const record = (rec) => appendFileSync(resultPath, JSON.stringify({ at: new Date().toISOString(), case: caseName, ...rec }) + '\n');
  const getToken = async () => {
    const t = await tokens.getAccessToken(appId, secret);
    secrets.push(t);
    return t;
  };

  if (c.mode === 'proactive') {
    if (!savedTarget) throw new Error('No saved DM target. Run the dm-text case first.');
    if (hashId(salt, savedTarget) !== allowHash) throw new Error('Saved target does not match the allowed hash.');
    const result = await post(apiBase, await getToken(), buildRequest(caseName, savedTarget, null));
    record({ ...result, mode: 'proactive' });
    say(`Sent once. HTTP ${result.status}, code ${result.code ?? 'none'}. Not retrying.`);
    return { sent: 1, result };
  }

  let sent = 0;
  let result = null;
  let echo = 0;
  let target = null;
  const inner = new AbortController();
  signal?.addEventListener('abort', () => inner.abort());

  const conn = new GatewayConnection({
    account: { accountId: 'q0b', appId, clientSecret: secret },
    abortSignal: inner.signal,
    userAgent: USER_AGENT,
    intents: INTENTS,
    reconnect: { maxAttempts: 5 },
    getAccessToken: () => getToken(),
    clearTokenCache: () => tokens.clearCache(appId),
    getGatewayUrl: async (token) => {
      const res = await fetch(`${apiBase}/gateway`, { headers: { Authorization: `QQBot ${token}`, 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`GET /gateway returned HTTP ${res.status}`);
      return (await res.json()).url;
    },
    onReady: () => say(`Connected. Waiting for the exact text "${TRIGGER}" from the allowed target. Nothing else gets a reply.`),
    onError: (err) => say(`Recoverable error: ${scrub(err?.message, secrets)}`),
    onMessage: async (msg) => {
      if (msg.senderIsBot) {
        echo += 1;
        record({ selfEcho: true, event: msg.rawEventType });
        say(`Received a message from a bot author (${msg.rawEventType}).`);
        return;
      }
      if (sent > 0 || !isTrigger(msg, c, allowHash, salt)) return;
      sent = 1;
      target = c.scope === 'c2c' ? msg.senderId : msg.groupOpenid;
      try {
        result = await post(apiBase, await getToken(), buildRequest(caseName, target, msg.messageId));
      } catch (err) {
        // A timeout may still have been delivered, so this is not retried.
        result = { status: null, code: null, hasId: false, uncertain: true, error: scrub(err?.message, secrets) };
      }
      record({ ...result, mode: c.mode, event: msg.rawEventType, skewMs: Date.now() - Date.parse(msg.timestamp) });
      say(`Sent once. HTTP ${result.status ?? 'unknown'}, code ${result.code ?? 'none'}. Not retrying. Watching ${echoWatchMs / 1000}s for an echo.`);
      setTimeout(() => inner.abort(), echoWatchMs);
    },
  });
  await conn.start().catch((err) => {
    if (!inner.signal.aborted) throw new Error(err?.closeCode ? `Gateway closed with code ${err.closeCode} and will not retry.` : scrub(err?.message, secrets));
  });
  return { sent, result, echo, target };
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function main() {
  const caseName = arg('case');
  const allowHash = arg('allow');
  if (!CASES[caseName] || !allowHash) {
    console.error(`Usage: --case <${Object.keys(CASES).join('|')}> --allow <target hash> --approve <case>`);
    process.exit(2);
  }
  const c = CASES[caseName];
  console.log(`Case ${caseName}. Exact text to be sent:\n  ${c.content ?? c.markdown}`);
  if (arg('approve') !== caseName) {
    console.log('Not approved, so nothing was sent. Pass --approve with the same case name after the user has agreed.');
    process.exit(0);
  }
  const env = parseQqEnv(readFileSync(join(ROOT, '.env'), 'utf8'));
  if (!env.CLO_QQ_APP_ID || !env.CLO_QQ_APP_SECRET) { console.error('QQ credentials are empty in .env.'); process.exit(2); }
  const saltPath = join(ROOT, '.runtime', 'q0-salt');
  if (!existsSync(saltPath)) { console.error('No salt yet. Run the listener first so target hashes exist.'); process.exit(2); }
  const salt = readFileSync(saltPath, 'utf8');
  const resultPath = join(ROOT, 'captures', 'q0b-results.jsonl');
  mkdirSync(dirname(resultPath), { recursive: true });
  // The DM target is kept only here, under the git-ignored runtime directory, for the later proactive case.
  const targetPath = join(ROOT, '.runtime', 'q0b-dm-target');
  const savedTarget = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : null;

  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());
  try {
    const out = await runProbe({
      caseName, allowHash, appId: env.CLO_QQ_APP_ID, secret: env.CLO_QQ_APP_SECRET,
      apiBase: process.env.CLO_QQ_API_BASE || 'https://api.sgroup.qq.com',
      tokenBase: process.env.CLO_QQ_TOKEN_BASE || 'https://bots.qq.com',
      salt, resultPath, signal: ac.signal, savedTarget,
    });
    if (c.scope === 'c2c' && c.mode === 'passive' && out.target) writeFileSync(targetPath, out.target);
    console.log(`Done. Sends: ${out.sent}. Bot-author messages seen: ${out.echo ?? 0}.`);
  } catch (err) {
    console.error(`Stopped: ${err.message}`);
    process.exit(1);
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await main();
