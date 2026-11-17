// Q0a read-only listener. It connects to the QQ gateway and records redacted event shapes.
//
// It has no way to reply: it does not import the SDK's QQBot, MessageApi or ApiClient, and makes
// exactly two kinds of HTTP request, the token request and GET /gateway. It never loads model or
// search keys, and it saves no message text, names or raw IDs.
//
// Run through scripts\q0-listen.ps1, which uses the private Node.
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GatewayConnection, TokenManager } from '@tencent-connect/qqbot-nodejs/protocol';
import { IS_WINDOWS, isEntryPath } from '../cli/platform.mjs';
import { mkdirPrivate, narrowMode, privateAppender, writeFilePrivate } from '../clo-plugin/lib/core/private-fs.js';
import { parseQqEnv, scrub, summarizeMessage, summarizeRaw } from './qq-shape.mjs';

/** Only the group-and-C2C intent bit. No interaction or guild events. */
export const LISTENER_INTENTS = 1 << 25;
const USER_AGENT = `clo-q0-listener/0 (Node/${process.versions.node})`;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Off Windows the salt is 0600 in a 0700 folder: with it, the hashes in the captures can be matched to raw IDs.
export function loadSalt(path) {
  if (existsSync(path)) {
    if (!IS_WINDOWS) narrowMode(path);
    return readFileSync(path, 'utf8');
  }
  if (IS_WINDOWS) mkdirSync(dirname(path), { recursive: true });
  else mkdirPrivate(dirname(path));
  if (!IS_WINDOWS) narrowMode(dirname(path));
  const salt = randomBytes(32).toString('hex');
  if (IS_WINDOWS) writeFileSync(path, salt, { flag: 'wx' });
  else writeFilePrivate(path, salt, { flag: 'wx' });
  return salt;
}

/** Starts the listener and resolves when it stops. Exported so tests can run it against a mock. */
export async function runListener({ appId, secret, apiBase, tokenBase, capturePath, salt, signal, say = console.log }) {
  const counts = new Map();
  const secrets = [secret];
  // Off Windows the capture file is 0600. Its name carries the start time, so it is normally new; one that exists is narrowed.
  const appendCapture = IS_WINDOWS ? null : privateAppender(capturePath);
  const write = (rec) => {
    if (IS_WINDOWS) appendFileSync(capturePath, JSON.stringify(rec) + '\n');
    else appendCapture(JSON.stringify(rec) + '\n');
    counts.set(rec.event, (counts.get(rec.event) ?? 0) + 1);
  };
  const tokens = new TokenManager({ userAgent: USER_AGENT, baseUrl: tokenBase });

  const getGatewayUrl = async (accessToken) => {
    secrets.push(accessToken);
    const res = await fetch(`${apiBase}/gateway`, {
      method: 'GET',
      headers: { Authorization: `QQBot ${accessToken}`, 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`GET /gateway returned HTTP ${res.status}`);
    const body = await res.json();
    if (typeof body?.url !== 'string') throw new Error('GET /gateway returned no url');
    return body.url;
  };

  const conn = new GatewayConnection({
    account: { accountId: 'q0', appId, clientSecret: secret },
    abortSignal: signal,
    userAgent: USER_AGENT,
    intents: LISTENER_INTENTS,
    // Bounded: a wrong secret or a closed bot must stop, not retry forever.
    reconnect: { maxAttempts: 30 },
    getAccessToken: () => tokens.getAccessToken(appId, secret),
    clearTokenCache: () => tokens.clearCache(appId),
    getGatewayUrl,
    onReady: () => {
      write({ receivedAt: new Date().toISOString(), event: 'READY', apiBase });
      say(`Connected with intents ${LISTENER_INTENTS}. Send your samples now; press Ctrl+C to stop.`);
    },
    onResumed: () => write({ receivedAt: new Date().toISOString(), event: 'RESUMED' }),
    onError: (err) => say(`Recoverable error: ${scrub(err?.message, secrets)}`),
    onDisconnected: ({ code, willReconnect }) => {
      write({ receivedAt: new Date().toISOString(), event: 'DISCONNECTED', code, willReconnect });
      say(`Disconnected, close code ${code}, will reconnect: ${willReconnect}`);
    },
    onMessage: (msg) => {
      const rec = summarizeMessage(msg, { salt, receivedAt: new Date().toISOString() });
      write(rec);
      const at = rec.mentions?.some((m) => m.is_you === true) ? 'is_you' : rec.mentions?.length ? 'mentions' : 'no-mention';
      say(`${rec.event}  ${at}  text length ${rec.content.length}  attachments ${rec.attachments.length}`);
    },
    onRawEvent: (type, data) => {
      write(summarizeRaw(type, data, { receivedAt: new Date().toISOString() }));
      say(`${type} (shape recorded)`);
    },
  });

  try {
    await conn.start();
  } catch (err) {
    const closeCode = err?.closeCode;
    write({ receivedAt: new Date().toISOString(), event: 'STOPPED', closeCode: closeCode ?? null, code: err?.code ?? null });
    throw new Error(closeCode ? `Gateway closed with code ${closeCode} and will not retry.` : scrub(err?.message, secrets));
  }
  return counts;
}

async function main() {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) {
    console.error('No .env file. Copy .env.example to .env and fill in CLO_QQ_APP_ID and CLO_QQ_APP_SECRET locally.');
    process.exit(2);
  }
  const env = parseQqEnv(readFileSync(envPath, 'utf8'));
  if (!env.CLO_QQ_APP_ID || !env.CLO_QQ_APP_SECRET) {
    console.error('CLO_QQ_APP_ID or CLO_QQ_APP_SECRET is empty in .env. Fill them in locally; do not paste them into chat.');
    process.exit(2);
  }
  const apiBase = process.env.CLO_QQ_API_BASE || 'https://api.sgroup.qq.com';
  const tokenBase = process.env.CLO_QQ_TOKEN_BASE || 'https://bots.qq.com';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const capturePath = join(ROOT, 'captures', `q0a-${stamp}.jsonl`);
  if (IS_WINDOWS) mkdirSync(dirname(capturePath), { recursive: true });
  else {
    mkdirPrivate(dirname(capturePath));
    narrowMode(dirname(capturePath));
  }
  const salt = loadSalt(join(ROOT, '.runtime', 'q0-salt'));

  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());
  process.on('SIGTERM', () => ac.abort());

  console.log(`Read-only listener. No replies are possible. Capture: ${capturePath}`);
  try {
    const counts = await runListener({ appId: env.CLO_QQ_APP_ID, secret: env.CLO_QQ_APP_SECRET, apiBase, tokenBase, capturePath, salt, signal: ac.signal });
    console.log('Stopped. Events recorded:');
    for (const [k, v] of counts) console.log(`  ${k}: ${v}`);
  } catch (err) {
    console.error(`Stopped: ${err.message}`);
    console.error(`Capture so far: ${capturePath}`);
    process.exit(1);
  }
}

// Windows keeps its comparison; elsewhere both paths go through realpath, so a symlink still runs.
const isMain = IS_WINDOWS ? resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url) : isEntryPath(process.argv[1], import.meta.url);
if (isMain) await main();
