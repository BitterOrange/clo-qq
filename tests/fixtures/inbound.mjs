// Builders for gate tests: InboundEvent shapes, an Effective, and a real gate on real SQLite with a
// fake clock, fake timers, a fake decide, a fake dispatch and a fake exit. No network, no sleeps.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadPolicy } from '../../src/clo-plugin/lib/core/contentPolicy.js';
import { createGate } from '../../src/clo-plugin/lib/core/gate.js';
import { createLedger } from '../../src/clo-plugin/lib/core/ledger.js';
import { openStore } from '../../src/clo-plugin/lib/core/store.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// 12:00 in Shanghai.
export const T0 = Date.UTC(2026, 10, 3, 4, 0, 0);
export const GROUP_A = 'GROUPAAAA11112222333344445555';
export const GROUP_B = 'GROUPBBBB11112222333344445555';
export const OWNER = 'OWNERMEMBER111122223333';
export const MEMBER = 'PLAINMEMBER111122223333';
export const MEMBER2 = 'OTHERMEMBER111122223333';

const dirs = [];
const openStores = new Set();
const openMocks = new Set();
after(async () => {
  // A failed test may not have reached its own close. Windows keeps an open file from being removed,
  // and an open mock server keeps the test process alive.
  for (const m of openMocks) await m.stop();
  for (const s of openStores) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

export function tempDir(prefix = 'clo-gate-') {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const PRIMARY_PRICE = { inputPerM: 5, outputPerM: 20, cacheReadPerM: 0.5, cacheWritePerM: 6.25 };
const DECISION_PRICE = { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, cacheWritePerM: 1.25 };

export function groupEntry(over = {}) {
  return { label: 'g', interject: true, nameMention: true, noticeGiven: true, cooldownMinutes: 8, perHour: 6, perDay: 8, ownerMemberIds: [OWNER], ...over };
}

export function makeEffective(over = {}) {
  const eff = {
    version: 1,
    generatedAt: new Date(T0).toISOString(),
    mode: 'live',
    qq: {
      enabled: true, appId: 'FAKE-APP', apiBaseUrl: '', tokenBaseUrl: '', urlMode: 'names',
      maxPartChars: 1500, maxPartsGroup: 5, interjectMaxChars: 400,
      groups: { [GROUP_A]: groupEntry(), [GROUP_B]: groupEntry({ label: 'b' }) },
    },
    names: ['可洛', '可洛小姐', 'Clo'],
    quietHours: { start: '23:00', end: '08:00', timezone: 'Asia/Shanghai' },
    window: { windowMs: 4000, maxPending: 20, maxConcurrentTurns: 2, staleMs: 120000, futureSkewMs: 300000, dispatchDeadlineMs: 180000 },
    limits: {
      nameWindowMax: 3, nameDecisionsPerGroupPerHour: 12, decisionsPerGroupPerHour: 60, decisionsPerDay: 300,
      perSenderAddressedPerHour: 10, crisisRoutePerGroupPerDay: 3, crisisRoutePerSenderPerHour: 2,
      failureLinePerGroupPerHour: 2, floodPerWindow: 10, minTextChars: 2,
      sendAccountPerMin: 12, sendAccountPerHour: 120, sendGroupPerMin: 4,
    },
    budget: { dailyUsd: 2.5, interjectUsd: 0.75, searchUsd: 2.1, namedUsd: 2.25, addressedUsd: 2.5, keyDailyLimitUsd: 3.25, residualMinUsd: 0.25, residualPct: 0.15, providerFailStreakPause: 3 },
    models: {
      primary: { id: 'anthropic/fake-opus', selector: 'opus-latest', effort: 'low', maxTokens: 3000, contextTokens: 24000, cacheRetention: 'short', price: PRIMARY_PRICE },
      decision: { id: 'anthropic/fake-haiku', effort: 'none', maxTokens: 200, price: DECISION_PRICE },
    },
    openrouter: { baseUrl: 'http://127.0.0.1:9/api/v1' },
    timeouts: { decisionMs: 8000, turnSeconds: 90 },
    retention: { eventDays: 14, sendDays: 14, reservationDays: 90, contextMaxItems: 40, contextMaxAgeHours: 24, contextMaxTokens: 3000, decisionLines: 15, decisionLineChars: 200, decisionCurrentChars: 800 },
    contentPolicy: {
      enabled: true, version: '1', sha256: '',
      policyFile: join(ROOT, 'persona', 'CONTENT-POLICY.md'),
      rulesFile: join(ROOT, 'policy', 'rules.json'),
      crisisFile: join(ROOT, 'policy', 'crisis-route.json'),
      linesFile: join(ROOT, 'persona', 'policy-lines.zh.json'),
    },
    privacy: { replaceSystemPrompt: false },
    paths: { db: '', eventLog: '', systemPromptFile: '', decisionPromptFile: join(ROOT, 'persona', 'decision-prompt.zh.md') },
  };
  return deepMerge(eff, over);
}

function deepMerge(base, over) {
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') deepMerge(base[k], v);
    else base[k] = v;
  }
  return base;
}

export const loadRealPolicy = () => loadPolicy({
  policyFile: join(ROOT, 'persona', 'CONTENT-POLICY.md'),
  sha256: '',
  rulesFile: join(ROOT, 'policy', 'rules.json'),
  crisisFile: join(ROOT, 'policy', 'crisis-route.json'),
});

let msgCounter = 0;

// The InboundEvent of design section 2.1. Default: ordinary text from a plain member in group A.
export function inbound(over = {}, at = T0) {
  msgCounter += 1;
  const placeholders = over.placeholders ?? [];
  const text = over.text ?? '今天的讨论挺有意思';
  return {
    kind: 'group',
    eventType: 'GROUP_MESSAGE_CREATE',
    messageId: `MSGID${String(msgCounter).padStart(8, '0')}UPPER`,
    conversationId: GROUP_A,
    senderId: MEMBER,
    senderIsBot: false,
    text,
    hasUserText: placeholders.length === 0 ? text.length > 0 : text.replace(placeholders.join(' '), '').trim().length > 0,
    placeholders,
    timestampMs: at,
    receivedAt: at,
    isRealAt: false,
    mentionsAll: false,
    mentionsOther: false,
    ambiguousMention: false,
    refMsgIdx: null,
    msgIdx: null,
    msgType: 0,
    ...over,
  };
}

export const atEvent = (over = {}, at = T0) => inbound({ isRealAt: true, text: '你好，帮我看个问题', ...over }, at);

export const decisionOf = (over = {}) => ({
  action: 'reply', skipClass: 'none', crisis: false, invalid: null, paid: true,
  actualMicros: 3000, model: 'anthropic/fake-haiku', httpStatus: 200, limitSource: null, ...over,
});

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export const USAGE = { costUsd: 0.01, input: 100, output: 50, cacheRead: 0, cacheWrite: 0, model: 'anthropic/fake-opus' };

export function fakeExit(over = {}) {
  const exit = {
    begun: [],
    finished: [],
    fixed: [],
    acks: [],
    beginTurn(turn) {
      exit.begun.push(turn);
    },
    async finishTurn(turnId, flags) {
      exit.finished.push({ turnId, ...flags });
      if (flags.aborted) return { state: 'failed', reason: 'aborted' };
      return exit.result ?? { state: 'completed', reason: 'sent' };
    },
    async sendFixed(ref, lineKey) {
      exit.fixed.push({ ref, lineKey });
      return { sent: true, reason: null };
    },
    async commandAck(ref, ackText) {
      exit.acks.push({ ref, ackText });
      return { sent: true, reason: null };
    },
    result: null,
    ...over,
  };
  return exit;
}

export function makeHarness({ effective, decide, dispatch, exit, dbFile, start = T0, attach = true, runGen = 'gen-1', log } = {}) {
  const clock = { t: start };
  const now = () => clock.t;
  const eff = { current: effective === undefined ? makeEffective() : effective };
  const getEffective = () => eff.current;

  let timerId = 0;
  const timerList = new Map();
  const timers = {
    setTimer(fn, ms) {
      timerId += 1;
      timerList.set(timerId, { at: clock.t + ms, fn });
      return timerId;
    },
    clearTimer(id) {
      timerList.delete(id);
    },
  };

  const file = dbFile ?? join(tempDir(), 'clo.db');
  const store = openStore(file, { runGen, now });
  openStores.add(store);
  const logs = [];
  const logFn = log ?? ((event, data) => logs.push({ event, ...data }));
  const ledger = createLedger({ store, getEffective, fetch: async () => { throw new Error('no network in this test'); }, getKey: () => 'FAKE-KEY', now, log: logFn });
  const policy = loadRealPolicy();

  const decideCalls = [];
  const decideFn = decide ?? (async () => decisionOf());
  const dispatched = [];
  const dispatchFn = dispatch ?? (async () => ({ started: true, hostError: false, aborted: false, usage: USAGE }));
  const exitObj = exit ?? fakeExit();

  const gate = createGate({
    store,
    ledger,
    policy,
    getEffective,
    decide: async (req) => {
      decideCalls.push(req);
      return decideFn(req);
    },
    dispatchTurn: async (turn) => {
      dispatched.push(turn);
      return dispatchFn(turn);
    },
    log: logFn,
    now,
    timers,
  });
  if (attach) gate.attachExit(exitObj);

  const h = {
    clock, now, eff, store, ledger, policy, gate, logs, timers, file,
    exit: exitObj,
    decideCalls,
    dispatched,
    // Fires due timers in order, moving the clock as it goes.
    advance(ms) {
      const target = clock.t + ms;
      for (;;) {
        const due = [...timerList.entries()].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timerList.delete(due[0]);
        clock.t = Math.max(clock.t, due[1].at);
        due[1].fn();
      }
      clock.t = target;
    },
    async send(evt) {
      await gate.onInbound(evt);
      return evt;
    },
    // Sends one event, then closes its window and waits for everything to end.
    async sendAndFlush(evt, flushMs = 4000) {
      await gate.onInbound(evt);
      h.advance(flushMs);
      await gate.idle();
      return evt;
    },
    event: (over) => inbound(over, clock.t),
    at: (over) => atEvent(over, clock.t),
    row: (evt) => store.getEvent(store.key(evt.messageId)),
    state: (evt) => {
      const r = store.getEvent(store.key(evt.messageId));
      return r ? `${r.state}${r.reason ? `:${r.reason}` : ''}` : null;
    },
    log: logFn,
    reservations: (evt) => store.q('SELECT * FROM reservations WHERE event_key=? ORDER BY created_at, category').all(store.key(evt.messageId)),
    allEvents: () => store.q('SELECT * FROM events').all(),
    counters: () => store.q('SELECT key, value FROM counters').all().map((r) => ({ ...r })),
    control: () => store.q('SELECT key, value FROM control').all().map((r) => ({ ...r })),
    claims: () => store.q('SELECT * FROM interject_log ORDER BY at').all().map((r) => ({ ...r })),
    async close() {
      await gate.stop();
      store.close();
    },
  };
  return h;
}

export const FAKE_SECRET = 'FAKE-SECRET-VALUE-123456';

// Seam stack: real gate, store, ledger, policy and exit, with the real SDK talking to mock-qq.
// Only the host is fake: h.script(turn) stands in for what a model run delivers. Set h.nextPostError
// to make the next message POST fail the way the SDK reports it, before it reaches the mock.
export async function seamMock() {
  const { startMockQq } = await import('../harness/mock-qq.mjs');
  const mock = await startMockQq();
  const stop = mock.stop;
  mock.stop = async () => {
    openMocks.delete(mock);
    await stop();
  };
  openMocks.add(mock);
  return mock;
}

export async function seamStack(opts = {}) {
  const { createExit } = await import('../../src/clo-plugin/lib/channels/qq/exit.js');
  const { QQBot } = await import('@tencent-connect/qqbot-nodejs');
  const mock = opts.mock ?? await seamMock();
  const sdk = new QQBot({
    appId: 'FAKE-APP', appSecret: FAKE_SECRET, accountId: 'default',
    baseUrl: mock.base, tokenBaseUrl: mock.base, intents: 1 << 25, userAgent: 'clo-seam-test',
  });
  let h = null;
  const bot = new Proxy(sdk, {
    get(target, prop) {
      if (prop !== 'api') return Reflect.get(target, prop);
      const { api } = target;
      return {
        ...api,
        post: async (path, body) => {
          if (h?.nextPostError) {
            const err = h.nextPostError;
            h.nextPostError = null;
            throw err;
          }
          return api.post(path, body);
        },
      };
    },
  });
  h = makeHarness({
    ...opts,
    attach: false,
    dispatch: async (turn) => {
      h.seen.push(turn);
      return h.script(turn);
    },
  });
  const exit = createExit({ bot, store: h.store, policy: h.policy, getEffective: () => h.eff.current, secrets: [FAKE_SECRET], log: h.log, now: h.now, sleep: async (ms) => h.advance(ms) });
  for (const name of ['beginTurn', 'collect', 'finishTurn', 'sendFixed', 'commandAck', 'stop']) {
    assert.equal(typeof exit[name], 'function', `exit.js has no ${name}: the section 3.10 exit is not on disk yet`);
  }
  h.exit = exit;
  h.gate.attachExit(exit);
  h.mock = mock;
  h.seen = [];
  h.nextPostError = null;
  h.replyText = '这是一条普通的回复。';
  h.usage = USAGE;
  h.script = async (turn) => {
    if (h.replyText !== null) exit.collect(turn.turnId, { text: h.replyText }, { kind: 'final' });
    return { started: true, hostError: false, aborted: false, usage: h.usage };
  };
  h.posts = () => mock.requests
    .filter((r) => r.method === 'POST' && r.path.endsWith('/messages'))
    .map((r) => ({ path: r.path, body: JSON.parse(r.body) }));
  const closeStore = h.close;
  let closed = false;
  h.close = async () => {
    if (closed) return;
    closed = true;
    await h.gate.stop();
    exit.stop();
    await closeStore();
    if (!opts.mock) await mock.stop();
  };
  // Crossing the per-group send limit is not what these tests are about.
  h.nextTurn = () => h.advance(20000);
  return h;
}

// R3: run last. Every message POST maps to one sends row, carries msg_id, and msg_seq only rises.
export function assertEveryPostLegal(h, { minPosts = 1 } = {}) {
  const posts = h.posts();
  assert.ok(posts.length >= minPosts, 'positive control: this stack did post');
  const rows = h.store.q("SELECT * FROM sends WHERE state IN ('sent','failed','uncertain')").all();
  const bySha = new Map();
  for (const r of rows) {
    const list = bySha.get(r.text_sha) ?? [];
    list.push(r);
    bySha.set(r.text_sha, list);
  }
  const lastSeq = new Map();
  for (const { path, body } of posts) {
    assert.ok(body.msg_id, 'msg_id is always present');
    assert.equal(body.msg_type, 0);
    assert.match(path, /^\/v2\/groups\/[^/]+\/messages$/);
    const sha = createHash('sha256').update(body.content, 'utf8').digest('hex');
    const list = bySha.get(sha);
    assert.ok(list?.length, 'a sends row exists for this POST');
    list.shift();
    assert.ok(body.msg_seq > (lastSeq.get(body.msg_id) ?? 0), 'msg_seq rises per msg_id');
    lastSeq.set(body.msg_id, body.msg_seq);
  }
}
