// TQ21: canary bodies and raw IDs must not rest in the event log or the database, WAL included.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLedger } from '../../src/clo-plugin/lib/core/ledger.js';
import { createLog, LOG_KEYS } from '../../src/clo-plugin/lib/core/log.js';
import { openStore } from '../../src/clo-plugin/lib/core/store.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CORE = join(ROOT, 'src', 'clo-plugin', 'lib', 'core');
const QQ = join(ROOT, 'src', 'clo-plugin', 'lib', 'channels', 'qq');
const dir = mkdtempSync(join(tmpdir(), 'clo-redact-'));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const BODY = '金丝雀正文CANARYBODY7731';
const GROUP = 'CANARYGROUPOPENID7731';
const MEMBER = 'CANARYMEMBEROPENID7731';
const MESSAGE = 'CANARYMESSAGEID7731';
const USERNAME = 'CANARYUSERNAME7731';
const REPLY = '金丝雀回复CANARYREPLY7731';
const CANARIES = [BODY, GROUP, MEMBER, MESSAGE, USERNAME, REPLY];

// The seam half needs GATE and CHANNEL. It runs as soon as both exist with the contract's shape.
async function seamModules() {
  const gatePath = join(CORE, 'gate.js');
  const exitPath = join(QQ, 'exit.js');
  if (!existsSync(gatePath) || !existsSync(exitPath)) return null;
  const gate = await import(pathToFileURL(gatePath).href);
  const exit = await import(pathToFileURL(exitPath).href);
  if (typeof gate.createGate !== 'function' || typeof exit.createExit !== 'function' || exit.createExit.length === 0) return null;
  if (!readFileSync(exitPath, 'utf8').includes('insertSendParts')) return null;
  return { gate, exit };
}
const seam = await seamModules();

function restingBytes(file) {
  return [file, `${file}-wal`, `${file}-shm`].filter(existsSync).map((f) => readFileSync(f));
}
const foundIn = (buffers, needle) => buffers.some((b) => b.includes(Buffer.from(needle, 'utf8')));

test('the scanner can see text resting in the database and WAL (positive control)', () => {
  const db = join(dir, 'control.db');
  const store = openStore(db, { runGen: 'g', now: () => 1000 });
  store.armDiscovery(600000);
  assert.equal(store.recordDiscovery({ groupId: GROUP, memberId: MEMBER, now: 1000 }), true);
  assert.ok(foundIn(restingBytes(db), GROUP), 'discovery is the one place raw IDs rest, and the scan must find them');
  store.clearDiscovery();
  store.close();
});

test('a full turn through store, ledger and log leaves no canary at rest', async () => {
  const db = join(dir, 'turn.db');
  const logFile = join(dir, 'turn.jsonl');
  const store = openStore(db, { runGen: 'g' });
  const log = createLog(logFile);
  const eff = { mode: 'live', budget: { dailyUsd: 2.5, interjectUsd: 0.75, searchUsd: 2.1, namedUsd: 2.25, addressedUsd: 2.5, residualMinUsd: 0.25, residualPct: 0.15, providerFailStreakPause: 3 }, openrouter: { baseUrl: 'http://mock' } };
  const ledger = createLedger({ store, getEffective: () => eff, fetch: async () => { throw new Error('no network'); }, getKey: () => null, log });

  const eventKey = store.key(MESSAGE);
  const groupKey = store.key(GROUP);
  const senderKey = store.key(MEMBER);
  assert.deepEqual(store.claimEvent({ eventKey, groupKey, msgTs: 1, receivedAt: Date.now() }), { fresh: true });
  store.setClass(eventKey, 'at');
  store.transition(eventKey, ['received'], 'queued');
  store.bumpCounter(`sender_addr:${senderKey}:1`, Date.now() + 3600000, 10);
  const hold = ledger.reserve({ tier: 'addressed', category: 'reply', heldMicros: 360000, eventKey, model: 'anthropic/claude-opus-5.5' });
  assert.equal(hold.ok, true);
  store.transition(eventKey, ['queued'], 'approved');
  store.transition(eventKey, ['approved'], 'dispatching');
  const { rows } = store.insertSendParts({ eventKey, groupKey, kind: 'reply', parts: [{ textSha: 'f'.repeat(64) }] });
  store.transition(eventKey, ['dispatching'], 'delivering');
  store.markSend(rows[0].sendId, 'sending');
  store.markSend(rows[0].sendId, 'sent', { httpStatus: 200, refKey: store.key('REF') });
  store.addBotRef(store.key('REF'), groupKey, eventKey);
  store.addAlert('send_uncertain', { eventKey, groupKey, text: BODY, raw: MESSAGE, member: MEMBER, message: BODY, flagged_input: BODY });
  ledger.settle(hold.id, { actualMicros: 1234, source: 'model.usage' });
  store.transition(eventKey, ['delivering'], 'completed', { reason: 'cmd_owner' });

  // What a careless caller might hand the log. Only whitelisted keys may survive.
  log('turn_finished', { eventKey, groupKey, cls: 'at', state: 'completed', text: BODY, content: BODY, groupId: GROUP, memberId: MEMBER, messageId: MESSAGE, username: USERNAME, raw: { id: MESSAGE }, message: BODY, flagged_input: BODY, reply: REPLY });
  log('provider_error', { status: 403, error_type: 'x', provider_name: 'y', provider_code: 'z', message: BODY, raw: BODY, metadata: { flagged_input: BODY } });
  log(`bad event ${BODY}`, { eventKey });
  assert.ok(log.droppedKeys() >= 10, 'the unsafe keys were dropped, not written');

  const buffers = restingBytes(db);
  assert.ok(foundIn(buffers, eventKey), 'positive control: the HMAC key rests there');
  store.close();
  const logText = readFileSync(logFile, 'utf8');
  assert.ok(logText.includes(eventKey), 'positive control: the log recorded the event');
  assert.match(logText, /"status":403/);
  for (const c of CANARIES) {
    assert.equal(foundIn(buffers, c), false, `${c} in the database`);
    assert.ok(!logText.includes(c), `${c} in the log`);
  }
});

test('the log whitelist is exactly the design list, and long values cannot carry a body', () => {
  assert.deepEqual([...LOG_KEYS].sort(), ['eventKey', 'groupKey', 'cls', 'state', 'reason', 'ruleId', 'path', 'count', 'closeCode', 'code', 'httpStatus', 'qqCode', 'durationMs', 'model', 'tier', 'heldMicros', 'actualMicros', 'source', 'seq', 'part', 'attempt', 'generation', 'kind', 'status', 'error_type', 'provider_name', 'provider_code', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'refState', 'refKey', 'refLen', 'refPrefix'].sort());
  const file = join(dir, 'long.jsonl');
  const log = createLog(file, { gen: 'g1', now: () => 5 });
  log('e', { reason: 'x'.repeat(129), code: 7, part: { nested: true } });
  const line = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(line, { code: 7, event: 'e', pid: process.pid, t: 5, gen: 'g1' });
  assert.equal(log.droppedKeys(), 2);
});

test('a log write failure never throws into the bot', () => {
  const log = createLog(join(dir, 'turn.db', 'cannot', 'be', 'a', 'dir.jsonl'));
  log('e', { code: 1 });
});

test('seam run: real gate, store, ledger, policy and exit leave no canary at rest', { skip: seam ? false : 'lib/core/gate.js or the contract exit.js is not on disk yet' }, async () => {
  const { loadPolicy, POLICY_V1_SHA256 } = await import('../../src/clo-plugin/lib/core/contentPolicy.js');
  const db = join(dir, 'seam.db');
  const logFile = join(dir, 'seam.jsonl');
  const store = openStore(db, { runGen: 'seam' });
  const log = createLog(logFile);
  const price = { inputPerM: 5, outputPerM: 20, cacheReadPerM: 0.5, cacheWritePerM: 6.25 };
  const eff = {
    version: 1,
    mode: 'live',
    qq: { enabled: true, appId: 'APP', apiBaseUrl: '', tokenBaseUrl: '', urlMode: 'names', maxPartChars: 1500, maxPartsGroup: 5, interjectMaxChars: 400, groups: { [GROUP]: { label: 'L', interject: false, nameMention: false, noticeGiven: true, cooldownMinutes: 8, perHour: 6, perDay: 8, ownerMemberIds: [] } } },
    names: ['可洛'],
    quietHours: { start: '23:00', end: '08:00', timezone: 'Asia/Shanghai' },
    window: { windowMs: 50, maxPending: 20, maxConcurrentTurns: 2, staleMs: 120000, futureSkewMs: 300000, dispatchDeadlineMs: 180000 },
    limits: { nameDecisionsPerGroupPerHour: 12, decisionsPerGroupPerHour: 60, decisionsPerDay: 300, perSenderAddressedPerHour: 10, crisisRoutePerGroupPerDay: 3, crisisRoutePerSenderPerHour: 2, failureLinePerGroupPerHour: 2, floodPerWindow: 10, minTextChars: 2, sendAccountPerMin: 12, sendAccountPerHour: 120, sendGroupPerMin: 4 },
    budget: { dailyUsd: 2.5, interjectUsd: 0.75, searchUsd: 2.1, namedUsd: 2.25, addressedUsd: 2.5, keyDailyLimitUsd: 3.25, residualMinUsd: 0.25, residualPct: 0.15, providerFailStreakPause: 3 },
    models: { primary: { id: 'anthropic/claude-opus-5.5', selector: 'opus-latest', effort: 'low', maxTokens: 3000, contextTokens: 24000, cacheRetention: 'short', price }, decision: { id: 'anthropic/claude-haiku-5.5', effort: 'none', maxTokens: 200, price } },
    openrouter: { baseUrl: 'http://mock' },
    timeouts: { decisionMs: 8000, turnSeconds: 90 },
    retention: { eventDays: 14, sendDays: 14, reservationDays: 90, contextMaxItems: 40, contextMaxAgeHours: 24, contextMaxTokens: 3000, decisionLines: 15, decisionLineChars: 200, decisionCurrentChars: 800 },
    contentPolicy: { enabled: true, version: '1', sha256: POLICY_V1_SHA256, policyFile: join(ROOT, 'persona', 'CONTENT-POLICY.md'), rulesFile: join(ROOT, 'policy', 'rules.json'), crisisFile: join(ROOT, 'policy', 'crisis-route.json'), linesFile: join(ROOT, 'persona', 'policy-lines.zh.json') },
    privacy: { replaceSystemPrompt: true },
    paths: { db, eventLog: logFile, systemPromptFile: 'unused', decisionPromptFile: join(ROOT, 'persona', 'decision-prompt.zh.md') },
  };
  const getEffective = () => eff;
  const policy = loadPolicy({ policyFile: eff.contentPolicy.policyFile, sha256: POLICY_V1_SHA256, rulesFile: eff.contentPolicy.rulesFile, crisisFile: eff.contentPolicy.crisisFile });
  const ledger = createLedger({ store, getEffective, fetch: async () => { throw new Error('no network'); }, getKey: () => null, log });
  const posts = [];
  const bot = { appId: 'APP', api: { post: async (path, body) => { posts.push({ path, body }); return { id: 'SENT1', ext_info: { ref_idx: 'REF1' } }; } } };
  const exit = seam.exit.createExit({ bot, store, policy, getEffective, secrets: () => [], log, now: Date.now });
  const dispatchTurn = async (turn) => {
    await exit.collect(turn.turnId, { text: REPLY }, { kind: 'final' });
    return { started: true, hostError: false, aborted: false, usage: { costUsd: 0.01, input: 10, output: 2, cacheRead: 0, cacheWrite: 0, model: eff.models.primary.id } };
  };
  const gate = seam.gate.createGate({ store, ledger, policy, getEffective, decide: async () => { throw new Error('an @ needs no decision'); }, dispatchTurn, log, now: Date.now, timers: { setTimer: setTimeout, clearTimer: clearTimeout } });
  gate.attachExit(exit);
  await gate.onInbound({
    kind: 'group', eventType: 'GROUP_AT_MESSAGE_CREATE', messageId: MESSAGE, conversationId: GROUP, senderId: MEMBER, senderIsBot: false,
    text: BODY, hasUserText: true, placeholders: [], timestampMs: Date.now(), receivedAt: Date.now(), isRealAt: true, mentionsAll: false, mentionsOther: false, ambiguousMention: false, refMsgIdx: null, msgIdx: null, msgType: 0,
  });
  await gate.idle();
  assert.equal(posts.length, 1, 'positive control: the reply went out');
  assert.equal(posts[0].body.msg_id, MESSAGE);
  assert.equal(posts[0].body.content, REPLY);
  const buffers = restingBytes(db);
  await gate.stop();
  store.close();
  const after_ = [...buffers, ...restingBytes(db)];
  const logText = readFileSync(logFile, 'utf8');
  assert.ok(logText.length > 0, 'positive control: the log has lines');
  for (const c of CANARIES) {
    assert.equal(foundIn(after_, c), false, `${c} in the database`);
    assert.ok(!logText.includes(c), `${c} in the log`);
  }
});
