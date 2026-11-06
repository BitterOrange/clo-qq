// The Q5 paid probe, with a mock OpenRouter and fake keys. Nothing here can reach OpenRouter or QQ.
// The real Gateway path is in tests/e2e/q5-probe.test.mjs; here a stand-in stage keeps these tests quick.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  assertIsolated, assertNoQqRoute, assertOwnNoQqRoute, buildPlan, OWN_TURN_CALL_LIMIT, ownEffective, runOwnStage, classifyError, createSpendTracker, extraPriceFields, FAKE_APP_ID, FAKE_QQ_SECRET, FIXED, HOST_ADDED, parseCli, priceAboveCeiling, PRICE_CEILING, PRIMARY_ID,
  probeConfig, q5GatewayEnv, renderForProbe, reportedCostMicros, resolveEndpoint, restrictedFetch, runGatewayStage, runProbe, sanitizeResult, suggestConfig, sweepOldRunRoots, tokenCostMicros, TURN_CALL_LIMIT, watchStopSignals,
} from '../../src/tools/q5-probe.mjs';
import { GATEWAY_NODE_FLAGS, gatewayArgs } from '../../src/cli/lifecycle.mjs';
import { resolvePaths } from '../../src/clo-plugin/lib/core/config.js';
import { DECISION_INPUT_TOKENS, replyHoldMicros } from '../../src/clo-plugin/lib/core/ledger.js';
import { cleanChildEnv } from '../harness/clean-env.mjs';
import { decisionText, defaultCatalog, startMockOpenRouter } from '../harness/mock-openrouter.mjs';
import { NODE, ROOT } from './_cli-helper.mjs';

const PROBE = join(ROOT, 'src', 'tools', 'q5-probe.mjs');
const GUARD = pathToFileURL(join(ROOT, 'src', 'tools', 'q5-net-guard.mjs')).href;
const NET_GUARD = pathToFileURL(join(ROOT, 'tests', 'harness', 'net-guard.mjs')).href;
const FAKE_KEY = 'sk-or-v1-CANARYKEY-Q5-UNIT-NEVER-PRINT';
const CANARY = 'CANARYTEXT可洛不该落盘';

const dirs = [];
const mocks = [];
after(async () => {
  for (const m of mocks) await m.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const tempDir = (label) => {
  const d = mkdtempSync(join(tmpdir(), `clo-q5u-${label}-`));
  dirs.push(d);
  return d;
};

// A Key whose daily limit is below these tests' caps, as the tool now requires.
const WITHIN_CAP = { limit: 0.1, limit_remaining: 0.1 };

async function mock() {
  const m = await startMockOpenRouter();
  mocks.push(m);
  const setKey = m.setKey;
  m.setKey = (over) => setKey({ ...WITHIN_CAP, ...over });
  m.setKey({});
  m.setScript(() => ({ text: '四个。', usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.001 } }));
  m.setDecision(() => ({ text: decisionText(), usage: { prompt_tokens: 50, completion_tokens: 5, cost: 0.0001 } }));
  return m;
}

const plan = buildPlan(ROOT);
const roomy = (p = plan) => (p.totalWorstMicros + 1000) / 1e6;

// A stage that spends nothing and just notes it was reached.
const stage = () => {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    return { stop: null };
  };
  fn.calls = calls;
  return fn;
};

async function run(m, over = {}) {
  const dir = tempDir('run');
  const said = [];
  const gatewayStage = over.gatewayStage ?? stage();
  const resultPath = join(dir, 'captures', 'q5-results.jsonl');
  const out = await runProbe({
    plan, baseUrl: m.base, key: FAKE_KEY, maxUsd: roomy(over.plan ?? plan), resultPath, say: (s) => said.push(s), gatewayStage, repoRoot: ROOT, testMode: true,
    lagMs: 0, pollMs: 1, ...over,
  });
  const raw = existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : '';
  const lines = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { ...out, said: said.join('\n'), raw, lines, gatewayStage };
}

const paid = (m) => m.requests.length;

// Fails closed: the .env under the test root is recorded by any read, and the record stays outside it.
function tracker(dir) {
  const file = join(dir, 'fs-tracker.mjs');
  writeFileSync(file, `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const LOG = process.env.CLO_FS_LOG;
const seen = (p) => { if (typeof p === 'string' && /[\\\\/]\\.env$/i.test(p)) fs.appendFileSync(LOG, p + '\\n'); };
for (const name of ['readFileSync', 'openSync', 'statSync', 'existsSync']) {
  const orig = fs[name];
  fs[name] = function tracked(p, ...rest) { seen(p); return orig.call(this, p, ...rest); };
}
syncBuiltinESMExports();
`);
  return pathToFileURL(file).href;
}

// Not spawnSync: the mock lives in this process and has to answer while the child waits.
function cli(args, { root, base = 'http://127.0.0.1:9/api/v1', extra = {}, imports = [] }) {
  return new Promise((res, rej) => {
    const child = spawn(NODE, [...imports.map((i) => `--import=${i}`), '--disable-warning=ExperimentalWarning', PROBE, ...args], {
      cwd: tmpdir(),
      env: cleanChildEnv({ CLO_TEST_ROOT: root, CLO_Q5_TEST_BASE: base, ...extra }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    // None of these runs should get as far as starting a Gateway. If one does, fail and take its whole tree down.
    const limit = setTimeout(() => spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { cwd: tmpdir(), env: cleanChildEnv(), windowsHide: true }), 45000);
    child.on('error', rej);
    child.on('close', (status) => {
      clearTimeout(limit);
      res({ status, stdout, stderr });
    });
  });
}

function cliRoot(label, envText = `CLO_CHAT_API_KEY=${FAKE_KEY}\nCLO_QQ_APP_SECRET=REAL-LOOKING-QQ-SECRET\n`) {
  const root = tempDir(label);
  writeFileSync(join(root, '.env'), envText);
  return root;
}

// --- without approval ---

test('without --approve: exact prompts, call count, model IDs and worst case; no request and .env not read', async () => {
  const m = await mock();
  const root = cliRoot('noapprove');
  const fsLog = join(root, 'fs.log');
  const r = await cli([], { root, base: m.base, imports: [tracker(root), NET_GUARD], extra: { CLO_FS_LOG: fsLog, CLO_NET_GUARD_LOG: join(root, 'net.jsonl') } });
  assert.equal(r.status, 0, r.stderr);
  for (const text of [FIXED.baselineSystem, FIXED.question, JSON.stringify(FIXED.decisionInput), ...FIXED.turns]) assert.ok(r.stdout.includes(text), `missing: ${text}`);
  for (const f of ['CONTENT-POLICY.md', 'AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'decision-prompt.zh.md']) {
    assert.ok(r.stdout.includes(readFileSync(join(ROOT, 'persona', f), 'utf8').trimEnd()), `missing the whole of ${f}`);
  }
  assert.ok(r.stdout.includes(PRIMARY_ID));
  assert.ok(r.stdout.includes('anthropic/claude-haiku-5.5'));
  assert.ok(r.stdout.includes(`At most ${plan.maxModelCalls} model calls`));
  assert.ok(r.stdout.includes(`$${(plan.totalWorstMicros / 1e6).toFixed(4)}`));
  assert.match(r.stdout, /no request was made and \.env was not read/);
  assert.equal(paid(m) + m.other.length, 0, 'no request');
  assert.equal(existsSync(fsLog), false, '.env was touched');
  assert.equal(existsSync(join(root, 'captures')), false, 'nothing written');
});

test('positive control: the same watchers do see the .env read and the request once it is approved', async () => {
  const m = await mock();
  m.setKey({ limit: null, limit_reset: null });
  const root = cliRoot('control');
  const fsLog = join(root, 'fs.log');
  const r = await cli(['--approve', '--max-usd', '100'], { root, base: m.base, imports: [tracker(root)], extra: { CLO_FS_LOG: fsLog } });
  assert.equal(r.status, 1);
  assert.ok(readFileSync(fsLog, 'utf8').includes('.env'), 'the tracker works');
  assert.ok(m.other.some((o) => o.url.endsWith('/key')), 'the mock counts requests');
  assert.equal(paid(m), 0, 'a key with no daily limit gets no paid call');
  assert.match(r.stdout, /no daily limit/);
});

test('--approve needs --max-usd, and a cap under the worst case refuses, both with no request and no .env read', async () => {
  const m = await mock();
  const root = cliRoot('nocap');
  const fsLog = join(root, 'fs.log');
  const noCap = await cli(['--approve'], { root, base: m.base, imports: [tracker(root)], extra: { CLO_FS_LOG: fsLog } });
  assert.equal(noCap.status, 2);
  assert.match(noCap.stderr, /--max-usd/);
  const tooLow = await cli(['--approve', '--max-usd', '0.01'], { root, base: m.base, imports: [tracker(root)], extra: { CLO_FS_LOG: fsLog } });
  assert.equal(tooLow.status, 2);
  assert.match(tooLow.stderr, /above --max-usd/);
  assert.equal(paid(m) + m.other.length, 0);
  assert.equal(existsSync(fsLog), false);
});

test('no free text: an unknown argument stops it, and only fixed texts and persona files can be sent', async () => {
  for (const args of [['--text', '你好'], ['你好'], ['--max-usd', 'lots'], ['--lag-minutes', '99'], ['--approve', '--prompt', 'x']]) {
    assert.ok(parseCli(args).error, args.join(' '));
  }
  assert.deepEqual(parseCli(['--approve', '--max-usd', '2.5', '--lag-minutes', '5']), { approve: true, maxUsd: 2.5, lagMinutes: 5, runtime: 'openclaw' });
  assert.equal(parseCli(['--runtime', 'own']).runtime, 'own');
  for (const args of [['--runtime'], ['--runtime', 'OWN'], ['--runtime', 'gateway']]) assert.ok(parseCli(args).error, args.join(' '));
  const m = await mock();
  await run(m);
  const allowed = new Set([FIXED.baselineSystem, FIXED.question, JSON.stringify(FIXED.decisionInput), plan.texts.policy, plan.texts.decisionPrompt, plan.texts.systemPrompt]);
  assert.equal(paid(m), plan.calls.length, 'positive control: requests were made');
  for (const rec of m.requests) for (const msg of rec.body.messages) assert.ok(allowed.has(msg.content), `not a fixed text: ${String(msg.content).slice(0, 40)}`);
  const src = readFileSync(PROBE, 'utf8');
  assert.ok(!/process\.argv\[[2-9]\]/.test(src), 'no positional text');
});

test('the persona files in the plan must still match the policy hash the Gateway requires', () => {
  assert.ok(plan.texts.systemPrompt.includes(plan.texts.policy));
  assert.equal(plan.calls.length, 5);
  assert.equal(plan.turns.length, 2);
  assert.equal(plan.maxModelCalls, 9);
  const sum = plan.calls.reduce((a, c) => a + c.worstMicros, 0) + plan.turns.reduce((a, t) => a + t.worstMicros, 0);
  assert.equal(plan.totalWorstMicros, sum);
  // A turn holds two worst-case calls, like the budget's required-reply hold.
  assert.equal(plan.turns[0].worstMicros, 2 * (plan.contextTokens * PRICE_CEILING.primary.inputPerM + plan.primaryMaxTokens * PRICE_CEILING.primary.outputPerM));
});

// --- cap ---

test('tracker: reported cost and missing usage both count, and it refuses what could pass the cap', () => {
  const t = createSpendTracker(1000);
  assert.equal(t.canAfford(1000), true);
  t.addReported(400);
  assert.equal(t.canAfford(600), true);
  assert.equal(t.canAfford(601), false);
  t.addMissing(500);
  assert.equal(t.canAfford(101), false, 'missing usage is not free');
  assert.equal(t.canAfford(100), true);
  assert.deepEqual(t.totals(), { reportedMicros: 400, countedAtWorstMicros: 500, missingCount: 1, totalMicros: 900, capMicros: 1000 });
  for (const usage of [null, undefined, {}, { cost: 0 }, { cost: -1 }, { cost: 'x' }, { cost: NaN }]) assert.equal(reportedCostMicros(usage), null);
  assert.equal(reportedCostMicros({ cost: 0.0012 }), 1200);
});

const noTurns = { ...plan, turns: [], totalWorstMicros: plan.calls.reduce((a, c) => a + c.worstMicros, 0) };

test('positive control for the cap: with low reported costs every planned call runs and the stage is reached', async () => {
  const m = await mock();
  const r = await run(m);
  assert.equal(r.stopReason, null);
  assert.equal(paid(m), plan.calls.length);
  assert.equal(r.gatewayStage.calls.length, 1);
  assert.equal(r.totals.countedAtWorstMicros, 0);
  assert.ok(r.totals.reportedMicros > 0);
  assert.match(r.said, /Total reported spend: \$0\.003/);
});

test('missing usage counts at the worst case, and that is what stops the last call', async () => {
  const m = await mock();
  // The first call runs slightly over its worst case, and every later one reports nothing.
  let n = 0;
  const over = (plan.calls[0].worstMicros + 2000) / 1e6;
  m.setDecision(() => {
    n += 1;
    return n === 1 ? { text: decisionText(), usage: { cost: over } } : { text: decisionText(), usage: null };
  });
  m.setScript(() => ({ text: '四个。', usage: null }));
  const r = await run(m, { plan: noTurns });
  assert.equal(r.stopReason, 'cap');
  assert.equal(paid(m), plan.calls.length - 1, 'stopped before the call that could pass the cap');
  assert.ok(r.totals.countedAtWorstMicros > 0);
  assert.equal(r.gatewayStage.calls.length, 0);
  assert.ok(r.lines.some((l) => l.kind === 'call' && l.usageMissing === true));
  assert.ok(r.lines.some((l) => l.kind === 'stop' && l.stopReason === 'cap'));
});

test('positive control: the same overrun with real usage later on does not stop the run', async () => {
  const m = await mock();
  let n = 0;
  const over = (plan.calls[0].worstMicros + 2000) / 1e6;
  m.setDecision(() => {
    n += 1;
    return { text: decisionText(), usage: { cost: n === 1 ? over : 0.0001 } };
  });
  const r = await run(m, { plan: noTurns });
  assert.equal(r.stopReason, null);
  assert.equal(paid(m), plan.calls.length);
});

test('a usage.cost of zero is not free either', async () => {
  const m = await mock();
  m.setScript(() => ({ text: '四个。', usage: { cost: 0 } }));
  const r = await run(m);
  assert.equal(r.totals.missingCount, 3, 'the three primary calls');
});

test('direct calls that overspend stop the run before the Gateway even starts', async () => {
  const m = await mock();
  m.setDecision(() => ({ text: decisionText(), usage: { cost: 3 } }));
  const r = await run(m);
  assert.equal(r.stopReason, 'cap');
  assert.equal(r.gatewayStage.calls.length, 0);
});

test('a plan above the cap throws before any request', async () => {
  const m = await mock();
  await assert.rejects(run(m, { maxUsd: 0.01 }), /above --max-usd/);
  assert.equal(paid(m) + m.other.length, 0);
});

// --- no retries, stop rules ---

test('a 500, a 400 or a dropped connection is sent once, counted at worst, and the run moves on', async () => {
  const m = await mock();
  let n = 0;
  m.setScript(() => {
    n += 1;
    return { error: { status: n === 1 ? 500 : 400, body: { error: { message: `boom ${CANARY}`, code: n === 1 ? 500 : 400 } } } };
  });
  const r = await run(m);
  assert.equal(r.stopReason, null);
  assert.equal(paid(m), plan.calls.length, 'one request per planned call, no retry');
  const bodies = m.requests.map((rec) => JSON.stringify(rec.body));
  assert.equal(new Set(bodies).size, bodies.length, 'no body was sent twice');
  assert.equal(r.totals.missingCount, 3);
  assert.deepEqual(r.calls.filter((c) => c.role === 'primary').map((c) => c.class), ['server', 'bad_request', 'bad_request']);

  // fetch itself failing, whatever its error text says.
  const failing = await mock();
  const fetchImpl = (url, init) => {
    if (url.endsWith('/chat/completions')) {
      failing.requests.push({ body: JSON.parse(init.body) });
      return Promise.reject(new Error(`socket ${FAKE_KEY}`));
    }
    return fetch(url, init);
  };
  const dropped = await run(failing, { fetchImpl });
  assert.equal(failing.requests.length, plan.calls.length);
  assert.equal(dropped.totals.missingCount, plan.calls.length);
  assert.ok(!dropped.said.includes(FAKE_KEY));
  assert.ok(!dropped.raw.includes(FAKE_KEY));
});

for (const [status, cls] of [[401, 'auth'], [402, 'payment'], [403, 'forbidden_other'], [429, 'rate_limit']]) {
  test(`HTTP ${status} stops the run after one request, and is recorded`, async () => {
    const m = await mock();
    m.setDecision(() => ({ error: { status, body: { error: { code: status, message: `no ${CANARY}`, metadata: { provider_name: 'Anthropic' } } } } }));
    const r = await run(m);
    assert.equal(r.stopReason, cls);
    assert.equal(paid(m), 1);
    assert.equal(r.gatewayStage.calls.length, 0);
    const line = r.lines.find((l) => l.kind === 'call');
    assert.equal(line.httpStatus, status);
    assert.equal(line.class, cls);
    assert.equal(r.lines.at(-1).kind, 'measure');
    assert.ok(r.lines.some((l) => l.kind === 'summary' && l.completed === false && l.stopReason === cls));
    assert.ok(!r.raw.includes(CANARY));
  });
}

test('a region error stops at once, on any status, and nothing else is called', async () => {
  for (const [status, body, cls] of [
    [403, { error: { code: 403, message: 'This model is not available in your region.', metadata: { provider_name: 'Anthropic' } } }, 'region_suspected'],
    [400, { error: { code: 400, message: 'unsupported_country_region_territory' } }, 'region'],
    [403, { error: { code: 403, message: 'blocked', metadata: { reason: 'country not allowed' } } }, 'region_suspected'],
  ]) {
    const m = await mock();
    m.setDecision(() => ({ error: { status, body } }));
    const r = await run(m, { lagMs: 60000 });
    assert.equal(r.stopReason, cls);
    assert.equal(paid(m), 1);
    assert.equal(r.gatewayStage.calls.length, 0);
    assert.equal(m.other.filter((o) => o.url.endsWith('/key')).length, 2, 'the opening read and one closing read, with no lag polling');
    assert.equal(r.lag, null);
    assert.match(r.said, /region error/);
  }
});

test('a region word in a 200 body also stops, as suspected', () => {
  const c = classifyError(200, { code: 403, message: 'not available in your region' });
  assert.equal(c.class, 'region_suspected');
  assert.equal(c.stop, true);
});

test('only a structured marker is a confirmed region error: a word in free text is suspected, and quoted text does not count', () => {
  assert.equal(classifyError(400, { code: 400, type: 'unsupported_country_region_territory' }).class, 'region');
  assert.equal(classifyError(500, { code: 500, message: 'upstream server in another region restarted' }).class, 'region_suspected');
  assert.equal(classifyError(403, { code: 403, metadata: { reasons: ['text mentions a country'], flagged_input: 'x' } }).class, 'moderation');
  assert.equal(classifyError(403, { code: 403, metadata: { raw: 'the country is mentioned here' } }).class, 'forbidden_other', 'raw is quoted provider text');
  assert.equal(classifyError(400, { code: 400, message: 'bad', metadata: { reasons: ['region'] } }).class, 'bad_request');
  assert.equal(classifyError(500, { code: 500, message: 'plain failure' }).class, 'server', 'positive control');
});

test('a suspected region error says it is not confirmed', async () => {
  const m = await mock();
  m.setDecision(() => ({ error: { status: 500, body: { error: { code: 500, message: 'upstream server in another region restarted' } } } }));
  const r = await run(m);
  assert.equal(r.stopReason, 'region_suspected');
  assert.match(r.said, /may be a region error/);
  assert.doesNotMatch(r.said, /reported a region error/);
});

test('classifier controls: an ordinary 403 is not region, and the metadata shape comes back as names and types only', () => {
  const c = classifyError(403, { code: 403, type: 'forbidden', message: `flagged ${CANARY}`, metadata: { reasons: [CANARY], flagged_input: CANARY, provider_name: 'Anthropic', 'has space': 1, raw: CANARY } });
  assert.equal(c.class, 'moderation');
  assert.equal(c.stop, true);
  assert.deepEqual(c.metadataKeys, ['reasons', 'flagged_input', 'provider_name', 'other_key', 'raw']);
  assert.deepEqual(c.metadataTypes, ['reasons:array', 'flagged_input:string', 'provider_name:string', 'other_key:number', 'raw:string']);
  assert.ok(!JSON.stringify(c).includes(CANARY));
  // A region word inside the flagged text is the user's text, not the provider's verdict.
  assert.equal(classifyError(403, { code: 403, metadata: { flagged_input: 'which country is it' } }).class, 'moderation');
  assert.equal(classifyError(402, { code: 402, metadata: { limit_source: 'openrouter_credits' } }).class, 'credits');
  assert.equal(classifyError(403, { code: 403, metadata: { limit_source: 'openrouter_key_limit' } }).limitSource, 'openrouter_key_limit');
  assert.equal(classifyError(500, { code: 500 }).stop, false);
});

test('a Gateway stage that reports a stop ends the run, with no lag wait', async () => {
  const m = await mock();
  const r = await run(m, { gatewayStage: async () => ({ stop: 'gateway_turn_failed' }), lagMs: 60000 });
  assert.equal(r.stopReason, 'gateway_turn_failed');
  assert.equal(r.lag, null);
  assert.equal(m.other.filter((o) => o.url.endsWith('/key')).length, 2, 'the opening read and one closing read');
  assert.equal(r.lines.filter((l) => l.kind === 'key_check').length, 1);
});

// --- the Key is the real ceiling ---

test('a daily limit above --max-usd refuses the run with no paid call', async () => {
  const m = await mock();
  m.setKey({ limit: 1000000, limit_remaining: 1000000 });
  const r = await run(m);
  assert.equal(r.stopReason, 'key_limit_above_cap');
  assert.equal(paid(m), 0);
  assert.equal(r.gatewayStage.calls.length, 0);
  assert.match(r.said, /above --max-usd/);
  const atCap = await mock();
  atCap.setKey({ limit: roomy(), limit_remaining: roomy() });
  assert.equal((await run(atCap)).stopReason, null, 'positive control: a limit equal to the cap passes');
});

test('Key spend above the cap or the tracker ends the run as not completed, even when the lag matched at once', async () => {
  const m = await mock();
  m.setKey({ usage: 10 });
  const r = await run(m, {
    lagMs: 60000,
    pollMs: 1,
    gatewayStage: async () => {
      m.setKey({ usage: 510 });
      return { stop: null };
    },
  });
  assert.equal(r.stopReason, 'key_delta_above_cap');
  assert.ok(r.lag.matchedMs !== null, 'the lag did match early, which is what hid this before');
  assert.deepEqual(r.keyCheck.flags, ['key_delta_above_cap', 'key_delta_above_tracker']);
  assert.match(r.said, /WARNING: the Key shows more than the cap/);
  const summary = r.lines.find((l) => l.kind === 'summary');
  assert.equal(summary.completed, false);
  assert.deepEqual(summary.flags, ['key_delta_above_cap', 'key_delta_above_tracker']);
  assert.equal(r.lines.find((l) => l.kind === 'key_check').keyDeltaUsd, 500);
});

test('Key spend above the tracker alone is flagged, and a figure matching it is not', async () => {
  const over = await mock();
  over.setKey({ usage: 10 });
  const r = await run(over, { gatewayStage: async () => { over.setKey({ usage: 10.5 }); return { stop: null }; } });
  assert.equal(r.stopReason, 'key_delta_above_tracker');
  assert.match(r.said, /something else used this Key/);
  const fine = await mock();
  fine.setKey({ usage: 10 });
  const ok = await run(fine, { gatewayStage: async () => { fine.setKey({ usage: 10.0032 }); return { stop: null }; } });
  assert.equal(ok.stopReason, null, 'positive control');
  assert.deepEqual(ok.keyCheck.flags, []);
});

test('the Key is read after a stop too, and a stop keeps its reason while the flag is recorded', async () => {
  const m = await mock();
  m.setKey({ usage: 10 });
  const r = await run(m, { gatewayStage: async () => { m.setKey({ usage: 510 }); return { stop: 'gateway_turn_failed' }; } });
  assert.equal(r.stopReason, 'gateway_turn_failed');
  assert.ok(r.keyCheck.flags.includes('key_delta_above_cap'));
  assert.match(r.said, /WARNING: the Key shows more than the cap/);
});

test('a Key that cannot be read at the end means an unknown spend, so the run is not completed', async () => {
  const m = await mock();
  const r = await run(m, { gatewayStage: async () => { m.setKeyStatus(500); return { stop: null }; } });
  assert.equal(r.stopReason, 'key_unreadable');
  assert.match(r.said, /Could not read the Key at the end/);
});

test('with nothing paid tried, there is no closing read', async () => {
  const m = await mock();
  m.setKey({ limit: null, limit_remaining: null });
  const r = await run(m);
  assert.equal(r.stopReason, 'no_daily_limit');
  assert.equal(m.other.filter((o) => o.url.endsWith('/key')).length, 1);
  assert.equal(r.keyCheck, null);
});

// --- what the plan says ---

test('the turn limit is the plan figure, and it reaches the Gateway as a live limit', () => {
  assert.equal(TURN_CALL_LIMIT, 2);
  assert.equal(plan.turnCallLimit, TURN_CALL_LIMIT);
  assert.equal(plan.turns[0].worstMicros, TURN_CALL_LIMIT * plan.turnCallWorstMicros);
  assert.equal(plan.maxModelCalls, plan.calls.length + plan.turns.length * TURN_CALL_LIMIT);
  // Each planned request at its own worst case is exactly the printed total, so nothing is left outside it.
  const eachAtWorst = plan.calls.reduce((a, c) => a + c.worstMicros, 0) + plan.turns.length * TURN_CALL_LIMIT * plan.turnCallWorstMicros;
  assert.equal(plan.totalWorstMicros, eachAtWorst);
});

test('the plan shows what the host adds: the runtime context, the tool schema, the resend and the compaction prompt', async () => {
  const root = cliRoot('hostadded');
  const r = await cli([], { root });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Added by the host in Gateway turns, not written by this tool:/);
  assert.ok(r.stdout.includes(HOST_ADDED.runtimeContextPrefix));
  assert.ok(r.stdout.includes(HOST_ADDED.compactionPrefix));
  assert.match(r.stdout, /turn 2 also resends/);
  const { registerTools } = await import('../../src/clo-plugin/lib/channels/qq/tools.js');
  let tool = null;
  registerTools({ registerTool: (t) => { tool = t; } });
  assert.ok(r.stdout.includes(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters })), 'the exact schema');
  assert.match(r.stdout, /limited to 2 model requests/);
  assert.match(r.stdout, /must not be above --max-usd/);
});

// --- prices ---

test('a price the estimate does not cover refuses the run; one for something never sent is noted', async () => {
  for (const [field, value] of [['request', '5'], ['internal_reasoning', '0.001'], ['some_new_price', '1']]) {
    const m = await mock();
    m.setCatalog(defaultCatalog().map((r) => (r.id.includes('opus') ? { ...r, pricing: { ...r.pricing, [field]: value } } : r)));
    const r = await run(m);
    assert.equal(r.stopReason, 'catalog_primary_price_outside_estimate', field);
    assert.equal(paid(m), 0, field);
    assert.equal(r.gatewayStage.calls.length, 0, field);
  }
  const m = await mock();
  m.setCatalog(defaultCatalog().map((r) => (r.id.includes('haiku') ? { ...r, pricing: { ...r.pricing, request: '1' } } : r)));
  assert.equal((await run(m)).stopReason, 'catalog_decision_price_outside_estimate');

  const unused = await mock();
  unused.setCatalog(defaultCatalog().map((r) => (r.id.includes('opus') ? { ...r, pricing: { ...r.pricing, web_search: '0.01', image: '1', request: '0', internal_reasoning: '0' } } : r)));
  const passed = await run(unused);
  assert.equal(passed.stopReason, null, 'real rows carry these, and this tool sends no search or image');
  assert.match(passed.said, /also prices web_search, image/);
  assert.deepEqual(passed.lines.find((l) => l.kind === 'catalog').unusedPriceFields, ['web_search', 'image']);
  assert.deepEqual(extraPriceFields({ pricing: { prompt: '1', completion: '1', input_cache_read: '1', input_cache_write: '1' } }), { refused: [], unused: [] });
  assert.deepEqual(extraPriceFields({ pricing: { discount: 'x' } }).refused, ['discount'], 'unreadable is not zero');
});

test('real catalog rows pass, and their extra fields are still bounded by the ceilings', async () => {
  // Copied from the real catalog. An earlier version refused these, because the mock had neither field.
  const opus = { prompt: '0.000004', completion: '0.00002', web_search: '0.01', input_cache_read: '0.0000002', input_cache_write: '0.000005', input_cache_write_1h: '0.000008' };
  const haiku = { prompt: '0.0000001', completion: '0.0000005', web_search: '0.01', input_cache_read: '0.00000001', input_cache_write: '0.000000125', input_cache_write_1h: '0.0000002', overrides: [{ min_prompt_tokens: 100000, prompt: '0.0000005', completion: '0.0000025', input_cache_read: '0.00000005', input_cache_write: '0.000000625', input_cache_write_1h: '0.000001' }] };
  const priced = (o, h) => defaultCatalog().map((r) => {
    if (r.id.includes('opus')) return { ...r, pricing: o };
    if (r.id.includes('haiku')) return { ...r, pricing: h };
    return r;
  });
  const real = await mock();
  real.setCatalog(priced(opus, haiku));
  assert.equal((await run(real)).stopReason, null, 'the exact real rows run');
  assert.deepEqual(extraPriceFields({ pricing: haiku }), { refused: [], unused: ['web_search'] });
  assert.equal(priceAboveCeiling({ pricing: opus }, PRICE_CEILING.primary), false, 'exactly at the $8 ceiling is not above it');

  const refusals = [
    ['a 1h write above the ceiling', { ...opus, input_cache_write_1h: '0.000009' }, haiku, 'catalog_primary_price_above_ceiling'],
    ['an override input above the ceiling', opus, { ...haiku, overrides: [{ min_prompt_tokens: 1, prompt: '0.000003' }] }, 'catalog_decision_price_above_ceiling'],
    ['an override output above the ceiling', opus, { ...haiku, overrides: [{ min_prompt_tokens: 1, completion: '0.000011' }] }, 'catalog_decision_price_above_ceiling'],
    ['a later override above the ceiling', opus, { ...haiku, overrides: [...haiku.overrides, { min_prompt_tokens: 200000, input_cache_write_1h: '0.000003' }] }, 'catalog_decision_price_above_ceiling'],
    ['an override with an unknown rate', opus, { ...haiku, overrides: [{ min_prompt_tokens: 1, request: '1' }] }, 'catalog_decision_price_outside_estimate'],
    ['overrides that are not a list', opus, { ...haiku, overrides: { prompt: '0.0000001' } }, 'catalog_decision_price_outside_estimate'],
    ['an override rate that cannot be read', opus, { ...haiku, overrides: [{ prompt: 'cheap' }] }, 'catalog_decision_price_outside_estimate'],
    ['a nested override', opus, { ...haiku, overrides: [{ prompt: ['0.1'] }] }, 'catalog_decision_price_outside_estimate'],
  ];
  for (const [name, o, h, stop] of refusals) {
    const m = await mock();
    m.setCatalog(priced(o, h));
    const r = await run(m);
    assert.equal(r.stopReason, stop, name);
    assert.equal(paid(m), 0, name);
  }
});

test('a reported cost far below the tokens at catalog price counts at the tokens', async () => {
  const m = await mock();
  m.setScript(() => ({ text: '四个。', usage: { prompt_tokens: 2000000, completion_tokens: 2000000, cost: 0.000001 } }));
  m.setDecision(() => ({ text: decisionText(), usage: { prompt_tokens: 50, completion_tokens: 5, cost: 0.0001 } }));
  const big = await run(m, { plan: noTurns, maxUsd: 1000 });
  // 2M at $5 plus 2M at $20: $50 a call.
  const first = big.lines.find((l) => l.id === 'primary_baseline');
  assert.equal(first.costUsd, 0.000001, 'the reported figure is still recorded');
  assert.equal(first.tokenCostUsd, 50);
  assert.equal(first.countedUsd, 50);
  assert.ok(big.totals.reportedMicros >= 150e6);

  const stops = await mock();
  stops.setScript(() => ({ text: '四个。', usage: { prompt_tokens: 2000000, completion_tokens: 2000000, cost: 0.000001 } }));
  const r = await run(stops, { plan: noTurns });
  assert.equal(r.stopReason, 'cap', 'and it stops the run');
  assert.equal(stops.requests.filter((q) => q.body.model === PRIMARY_ID).length, 1);

  const price = { inputPerM: 5, outputPerM: 20, cacheReadPerM: 0.5, cacheWritePerM: 6.25 };
  assert.equal(tokenCostMicros({ prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 20 } }, price), 40 * 5 + 40 * 0.5 + 20 * 6.25 + 10 * 20);
  assert.equal(tokenCostMicros({}, price), null);
  // Positive control: a normal row counts the reported figure, not the tokens.
  const normal = await mock();
  const fine = await run(normal, { plan: noTurns });
  assert.equal(fine.lines.find((l) => l.id === 'primary_baseline').countedUsd, 0.001);
});

// --- redirects ---

function redirectServer(routes) {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const route = routes(req);
      res.writeHead(route.status ?? 200, { 'Content-Type': 'application/json', ...(route.location ? { Location: route.location } : {}) });
      res.end(JSON.stringify(route.body ?? {}));
    });
  });
  return new Promise((r) => {
    server.listen(0, '127.0.0.1', () => r({ origin: `http://127.0.0.1:${server.address().port}`, stop: () => new Promise((d) => { server.closeAllConnections(); server.close(d); }) }));
  });
}

test('a redirect is refused: nothing reaches another origin, and a 307 does not send a paid POST again', async () => {
  const elsewhere = [];
  const other = await redirectServer((req) => {
    elsewhere.push(`${req.method} ${req.url}`);
    return { body: {} };
  });
  const posts = [];
  const first = await redirectServer((req) => {
    if (req.url.endsWith('/key')) return { body: { data: { usage: 0, limit: 0.1, limit_remaining: 0.1, limit_reset: 'daily' } } };
    if (req.url.endsWith('/models')) return { body: { data: defaultCatalog() } };
    posts.push(req.url);
    return { status: 307, location: `${other.origin}/api/v1/chat/completions` };
  });
  try {
    const r = await run({ base: `${first.origin}/api/v1` }, { plan: noTurns, baseUrl: `${first.origin}/api/v1`, gatewayStage: stage() });
    assert.deepEqual(elsewhere, [], 'the other origin saw nothing');
    assert.equal(posts.length, plan.calls.length, 'each call was sent once');
    assert.ok(r.calls.every((c) => c.class === 'network'));
    assert.equal(r.totals.missingCount, plan.calls.length, 'and each counts at its worst');

    const keyMoved = await redirectServer(() => ({ status: 302, location: `${other.origin}/api/v1/key` }));
    const moved = await run({ base: `${keyMoved.origin}/api/v1` }, { baseUrl: `${keyMoved.origin}/api/v1` });
    await keyMoved.stop();
    assert.equal(moved.stopReason, 'key_read_network');
    assert.deepEqual(elsewhere, []);
  } finally {
    await first.stop();
    await other.stop();
  }
});

test('its fetch refuses another origin before calling anything, and always asks for no redirects', async () => {
  const seen = [];
  const http = restrictedFetch('http://127.0.0.1:5/api/v1', (url, init) => {
    seen.push({ url, init });
    return 'called';
  });
  assert.throws(() => http('http://127.0.0.1:6/api/v1/key', {}), /outside the model host/);
  assert.throws(() => http('https://example.invalid/key'), /outside the model host/);
  assert.equal(seen.length, 0);
  assert.equal(http('http://127.0.0.1:5/api/v1/key', { method: 'GET' }), 'called');
  assert.equal(http('http://127.0.0.1:5/api/v1/key'), 'called');
  assert.deepEqual(seen.map((c) => c.init.redirect), ['error', 'error']);
});

// --- stopping and the temp root ---

test('an interrupt between direct calls stops before the next one', async () => {
  const m = await mock();
  const ac = new AbortController();
  // Between calls: the first has been read in full, so it is paid and reported.
  const fetchImpl = async (url, init) => {
    const res = await fetch(url, init);
    if (!url.endsWith('/chat/completions')) return res;
    const text = await res.text();
    ac.abort();
    return new Response(text, { status: res.status });
  };
  const r = await run(m, { fetchImpl, signal: ac.signal });
  assert.equal(r.stopReason, 'interrupted');
  assert.equal(paid(m), 1);
  assert.equal(r.gatewayStage.calls.length, 0);
  // Not even tried, so the unsent call adds nothing to the spend. An aborted fetch alone would also send nothing.
  assert.equal(r.calls.length, 1);
  assert.equal(r.totals.missingCount, 0);
});

test('every way of being told to stop aborts the run, and the handlers come off', () => {
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    const ac = new AbortController();
    const before = process.listenerCount(name);
    const off = watchStopSignals(ac);
    assert.equal(process.listenerCount(name), before + 1, name);
    process.emit(name);
    assert.equal(ac.signal.aborted, true, name);
    off();
    assert.equal(process.listenerCount(name), before, name);
  }
  const src = readFileSync(PROBE, 'utf8');
  assert.match(src, /const stopWatching = watchStopSignals\(ac\);/, 'main uses it');
  assert.match(src, /signal: ac\.signal/, 'and passes the signal on');
});

test('a temp root left by a hard kill is removed at the next start, unless its Gateway is alive or it may be starting', () => {
  const parent = tempDir('sweep');
  const make = (name, pid) => {
    const dir = join(parent, name);
    mkdirSync(join(dir, '.runtime'), { recursive: true });
    writeFileSync(join(dir, '.runtime', 'store.txt'), 'prompts and answers');
    if (pid) writeFileSync(join(dir, '.runtime', 'gateway.pid'), String(pid));
    return dir;
  };
  const dead = make('clo-q5-dead', 111);
  const alive = make('clo-q5-alive', 222);
  const newest = make('clo-q5-new');
  const old = make('clo-q5-old');
  const unrelated = make('clo-q5u-other', 111);
  const when = new Date(Date.now() - 3600000);
  utimesSync(old, when, when);
  const said = [];
  const removed = sweepOldRunRoots(parent, { say: (t) => said.push(t), isAlive: (pid) => pid === 222 });
  assert.deepEqual(removed.sort(), ['clo-q5-dead', 'clo-q5-old']);
  assert.equal(existsSync(dead), false);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(alive), true);
  assert.equal(existsSync(newest), true);
  assert.equal(existsSync(unrelated), true, 'only its own folders');
  assert.match(said.join(), /Removed 2 temp root/);
  assert.deepEqual(sweepOldRunRoots(join(parent, 'missing')), []);
  assert.match(readFileSync(PROBE, 'utf8'), /if \(!env\.CLO_TEST_ROOT\) sweepOldRunRoots\(tmpdir\(\), \{ say \}\);/, 'main calls it, and never in test mode');
});

// --- the wiring around the Gateway spawn, with a stand-in child so no Gateway starts ---

function standInSpawn() {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.pid = 999999;
    setImmediate(() => child.emit('exit', 0));
    return child;
  };
  fn.calls = calls;
  return fn;
}

const HOSTILE_PARENT = {
  SystemRoot: process.env.SystemRoot, CLO_QQ_APP_SECRET: 'REAL-LOOKING-QQ-SECRET', CLO_QQ_APP_ID: 'REALAPPID', HTTP_PROXY: 'http://x', OPENROUTER_API_KEY: 'PARENT-KEY', CLO_CHAT_API_KEY: 'PARENT-KEY', PERPLEXITY_API_KEY: 'x', NODE_OPTIONS: '--x', OPENCLAW_STATE_DIR: 'C:\\project\\.runtime\\state',
};

async function stageWith(over = {}) {
  const parent = tempDir('stage');
  const spawnImpl = standInSpawn();
  const said = [];
  const lines = [];
  const out = await runGatewayStage({
    plan, catalog: defaultCatalog(), baseUrl: 'http://127.0.0.1:9/api/v1', key: FAKE_KEY, tracker: createSpendTracker(100e6), record: (l) => lines.push(l), say: (t) => said.push(t), testMode: true, parentEnv: HOSTILE_PARENT, tempParent: parent, repoRoot: ROOT, spawnImpl, ...over,
  });
  return { out, parent, spawnImpl, said, lines, runRoots: readdirSync(parent).filter((n) => n.startsWith('clo-q5-')) };
}

test('the Gateway is spawned with the allowlist, the fake QQ identity, the guard and its limit, and nothing from the parent', async () => {
  const { out, spawnImpl, lines } = await stageWith();
  assert.equal(out.stop, 'gateway_not_connected', 'the stand-in exits, which is how this test ends');
  assert.equal(spawnImpl.calls.length, 1);
  const [{ args, opts }] = spawnImpl.calls;
  assert.ok(args.some((a) => a.startsWith('--import=') && a.endsWith('q5-net-guard.mjs')));
  assert.ok(args.some((a) => a.startsWith('--import=') && a.endsWith('host-output-filter.mjs')));
  assert.ok(args.indexOf('gateway') > args.findIndex((a) => a.endsWith('q5-net-guard.mjs')), 'the guard loads before the host');
  const { env } = opts;
  assert.equal(env.OPENROUTER_API_KEY, FAKE_KEY);
  assert.equal(env.CLO_CHAT_API_KEY, undefined);
  assert.equal(env.CLO_QQ_APP_SECRET, FAKE_QQ_SECRET);
  assert.equal(env.CLO_QQ_APP_ID, FAKE_APP_ID);
  for (const k of ['HTTP_PROXY', 'PERPLEXITY_API_KEY']) assert.equal(env[k], undefined, k);
  assert.match(env.NODE_OPTIONS, /^--import=file:.*q5-net-guard\.mjs$/, 'not the parent value');
  assert.ok(!JSON.stringify(env).includes('PARENT-KEY'));
  assert.ok(!JSON.stringify(env).includes('REAL-LOOKING-QQ-SECRET'));
  assert.ok(!JSON.stringify(env).includes('C:\\\\project'));
  assert.equal(env.CLO_Q5_TURN_CALL_LIMIT, String(TURN_CALL_LIMIT));
  assert.equal(env.CLO_Q5_MODEL_ORIGIN, 'http://127.0.0.1:9');
  assert.ok(env.CLO_NET_GUARD_LOG, 'refusals are recorded somewhere');
  assert.ok(env.CLO_Q5_CALL_LOG);
  assert.ok(env.CLO_Q5_TURN_FILE);
  assert.equal(lines.find((l) => l.kind === 'gateway').state, 'gateway_not_connected');
});

test('the Gateway gets the same Node flags as clo start, before any import, and the same host command', async () => {
  const { spawnImpl } = await stageWith();
  const [{ args }] = spawnImpl.calls;
  const port = Number(args[args.indexOf('--port') + 1]);
  const paths = resolvePaths({});
  // Built from gatewayArgs, not the constant alone, so a flag lifecycle adds inline is caught too.
  const startArgs = gatewayArgs(paths, {}, port);
  const flagsOf = (a) => a.slice(0, a.findIndex((x) => x.startsWith('--import=')));
  assert.ok(GATEWAY_NODE_FLAGS.length > 0, 'positive control: clo start does pass flags');
  assert.deepEqual(flagsOf(startArgs), [...GATEWAY_NODE_FLAGS], 'control: lifecycle puts them first');
  assert.deepEqual(flagsOf(args), flagsOf(startArgs));
  const tail = (a) => a.slice(a.indexOf('gateway'));
  assert.deepEqual(tail(args), tail(startArgs));
  assert.equal(args[args.indexOf('gateway') - 1].replace(/\\/g, '/').split('/').pop(), startArgs[startArgs.indexOf('gateway') - 1].replace(/\\/g, '/').split('/').pop());
});

test('outside test mode the guard names only the model host, and the native route has no test switches', async () => {
  const { spawnImpl } = await stageWith({ testMode: false, baseUrl: 'https://openrouter.ai/api/v1', testImports: ['C:\\never.mjs'] });
  const [{ args, opts }] = spawnImpl.calls;
  assert.equal(opts.env.CLO_Q5_ALLOWED_HOST, 'openrouter.ai');
  assert.equal(opts.env.CLO_Q5_MODEL_ORIGIN, 'https://openrouter.ai');
  assert.equal(opts.env.CLO_TEST_ROOT, undefined);
  assert.equal(opts.env.OPENCLAW_OFFLINE, undefined);
  assert.ok(!args.some((a) => a.includes('never.mjs')), 'test imports are refused here');
  const narrowed = await stageWith({ testMode: false, baseUrl: 'https://openrouter.ai/api/v1', guardAllowedHost: 'model.invalid' });
  assert.equal(narrowed.spawnImpl.calls[0].opts.env.CLO_Q5_ALLOWED_HOST, 'model.invalid');
});

test('the temp root is deleted at the end, unless a test asks to keep it', async () => {
  const gone = await stageWith();
  assert.deepEqual(gone.runRoots, []);
  const kept = await stageWith({ keepRunRoot: true });
  assert.equal(kept.runRoots.length, 1, 'positive control: the folder was made');
});

test('a run root inside the project is refused before anything starts, and leaves nothing behind', async () => {
  // A stand-in project: this only reaches the isolation check, so no project file is read.
  const fakeRepo = tempDir('fakerepo');
  const spawnImpl = standInSpawn();
  await assert.rejects(runGatewayStage({
    plan, catalog: defaultCatalog(), baseUrl: 'http://127.0.0.1:9/api/v1', key: FAKE_KEY, tracker: createSpendTracker(1e6), record: () => {}, say: () => {}, testMode: true, parentEnv: {}, tempParent: fakeRepo, repoRoot: fakeRepo, spawnImpl,
  }), /inside the project/);
  assert.equal(spawnImpl.calls.length, 0);
  assert.deepEqual(readdirSync(fakeRepo).filter((n) => n.startsWith('clo-q5-')), []);
});

test('a render with no QQ address never reaches a spawn', async () => {
  const dir = tempDir('emptyqq');
  const args = { repoRoot: ROOT, paths: resolvePaths({ CLO_TEST_ROOT: dir }), port: 7, catalog: defaultCatalog(), baseUrl: 'https://openrouter.ai/api/v1', key: FAKE_KEY, testMode: false };
  // Config validation accepts an empty address, because that is how the real SDK default is chosen. This check does not.
  assert.throws(() => renderForProbe({ ...args, qqBase: '' }), /QQ endpoint is not loopback/);
});

// --- the key ---

test('the key never reaches output or results, even when the provider echoes it', async () => {
  const m = await mock();
  m.setScript(() => ({ text: `echo ${FAKE_KEY}`, usage: { cost: 0.001 } }));
  const r = await run(m);
  assert.equal(m.requests[0].headers.authorization, `Bearer ${FAKE_KEY}`, 'positive control: the key did go to the provider');
  assert.ok(!r.said.includes(FAKE_KEY));
  assert.ok(!r.raw.includes(FAKE_KEY));
});

test('a key with no recognisable shape is still kept out of the results file', async () => {
  const plainKey = 'PLAINLOOKINGKEY12345';
  // The gate passes this as an identifier, so only the writer's own scrub can catch it.
  assert.equal(sanitizeResult({ state: plainKey }).state, plainKey);
  const m = await mock();
  const dir = tempDir('plainkey');
  const resultPath = join(dir, 'r.jsonl');
  const gatewayStage = async ({ record }) => {
    record({ kind: 'gateway', state: plainKey, reason: 'visible_control' });
    return { stop: null };
  };
  await runProbe({ plan, baseUrl: m.base, key: plainKey, maxUsd: roomy(), resultPath, say: () => {}, gatewayStage, repoRoot: ROOT, testMode: true, lagMs: 0, pollMs: 1 });
  const raw = readFileSync(resultPath, 'utf8');
  assert.ok(raw.includes('visible_control'), 'positive control: the line was written');
  assert.ok(!raw.includes(plainKey));
});

test('the CLI keeps the key out of stdout, stderr and results, and takes only that name from .env', async () => {
  const m = await mock();
  m.setKey({ limit: null });
  const root = cliRoot('clikey');
  const r = await cli(['--approve', '--max-usd', '100'], { root, base: m.base });
  assert.equal(r.status, 1);
  for (const text of [r.stdout, r.stderr, readFileSync(join(root, 'captures', 'q5-results.jsonl'), 'utf8')]) {
    assert.ok(!text.includes(FAKE_KEY));
    assert.ok(!text.includes('REAL-LOOKING-QQ-SECRET'));
  }
  const src = readFileSync(PROBE, 'utf8');
  assert.equal(src.match(/parseEnvFile\(/g).length, 1, 'one read of .env');
  assert.ok(src.includes("parseEnvFile(paths.envFile, ['CLO_CHAT_API_KEY'])"));
  assert.ok(!/process\.env\.(OPENROUTER_API_KEY|CLO_CHAT_API_KEY)\s*=/.test(src), 'never put into its own environment');
});

test('an empty key is refused with no request', async () => {
  const m = await mock();
  const root = cliRoot('emptykey', 'CLO_CHAT_API_KEY=\n');
  const r = await cli(['--approve', '--max-usd', '100'], { root, base: m.base });
  assert.equal(r.status, 2);
  assert.equal(paid(m) + m.other.length, 0);
});

test('a .env with only the old key name is refused with no request, naming the new one and printing no value', async () => {
  const m = await mock();
  const root = cliRoot('oldname', `OPENROUTER_API_KEY=${FAKE_KEY}\n`);
  const r = await cli(['--approve', '--max-usd', '100'], { root, base: m.base });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /CLO_CHAT_API_KEY/);
  assert.ok(!`${r.stdout}${r.stderr}`.includes(FAKE_KEY));
  assert.equal(paid(m) + m.other.length, 0);
});

test('a proxy variable refuses the run before .env is read', async () => {
  const m = await mock();
  const root = cliRoot('proxy');
  const fsLog = join(root, 'fs.log');
  const r = await cli(['--approve', '--max-usd', '100'], { root, base: m.base, imports: [tracker(root)], extra: { CLO_FS_LOG: fsLog, HTTPS_PROXY: 'http://127.0.0.1:1' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /proxy/i);
  assert.equal(existsSync(fsLog), false);
});

for (const [name, key] of [['no limit', { limit: null, limit_remaining: null }], ['a monthly limit', { limit_reset: 'monthly' }], ['no reset', { limit_reset: null }]]) {
  test(`a key with ${name} is refused, with no paid call`, async () => {
    const m = await mock();
    m.setKey(key);
    const r = await run(m);
    assert.equal(r.stopReason, 'no_daily_limit');
    assert.equal(paid(m), 0);
    assert.equal(r.gatewayStage.calls.length, 0);
  });
}

test('a key endpoint that refuses stops the run with no paid call', async () => {
  const m = await mock();
  m.setKeyStatus(401);
  const r = await run(m);
  assert.equal(r.stopReason, 'key_read_auth');
  assert.equal(paid(m), 0);
});

// --- the catalog ---

test('the catalog can stop the run before any paid call', async () => {
  const cases = [
    ['a newer Opus', (c) => [...c, { ...c[0], id: 'anthropic/claude-opus-6', created: 200 }], 'catalog_primary_id_differs'],
    ['no alias row', (c) => c.filter((r) => !r.id.startsWith('~')), 'catalog_selector_refused'],
    ['alias price differs', (c) => c.map((r) => (r.id.startsWith('~') ? { ...r, pricing: { ...r.pricing, completion: '0.0001' } } : r)), 'catalog_selector_refused'],
    ['price above the ceiling', (c) => c.map((r) => (r.id.includes('opus') ? { ...r, pricing: { ...r.pricing, completion: '0.00005' } } : r)), 'catalog_primary_price_above_ceiling'],
    ['no decision model', (c) => c.filter((r) => !r.id.includes('haiku')), 'catalog_price_missing'],
  ];
  for (const [what, edit, reason] of cases) {
    const m = await mock();
    m.setCatalog(edit(defaultCatalog()));
    const r = await run(m);
    assert.equal(r.stopReason, reason, what);
    assert.equal(paid(m), 0, what);
    assert.equal(r.gatewayStage.calls.length, 0, what);
  }
});

// --- QQ and project state ---

test('no QQ route: only a loopback QQ with the fake identity passes, and an empty URL does not', () => {
  const good = () => ({ channels: { 'clo-qq': { apiBaseUrl: 'http://127.0.0.1:5/', tokenBaseUrl: 'http://127.0.0.1:5/', appId: FAKE_APP_ID } } });
  const eff = () => ({ qq: { apiBaseUrl: 'http://127.0.0.1:5/', tokenBaseUrl: 'http://127.0.0.1:5/', appId: FAKE_APP_ID } });
  assertNoQqRoute(good(), eff());
  for (const edit of [
    (o) => { o.channels['clo-qq'].apiBaseUrl = 'https://api.sgroup.qq.com'; },
    (o) => { o.channels['clo-qq'].tokenBaseUrl = 'https://bots.qq.com'; },
    (o) => { delete o.channels['clo-qq'].apiBaseUrl; },
    (o) => { o.channels['clo-qq'].appId = 'REALAPPID'; },
    (o) => { delete o.channels['clo-qq']; },
  ]) {
    const o = good();
    edit(o);
    assert.throws(() => assertNoQqRoute(o, eff()), /loopback|identity/);
  }
  assert.throws(() => assertNoQqRoute(good(), { qq: { ...eff().qq, apiBaseUrl: '' } }), /loopback/);
});

test('the probe has no QQ SDK, no QQ address, and takes no QQ secret', () => {
  const src = readFileSync(PROBE, 'utf8');
  for (const bad of ['@tencent-connect', 'sgroup.qq.com', 'bots.qq.com', 'CLO_QQ_API_BASE', "'.env'"]) assert.ok(!src.includes(bad), bad);
  assert.ok(src.includes("tests/harness/mock-qq.mjs"), 'the mock is what it connects');
});

test('the Gateway env: fake QQ identity, the key only by env, nothing from a hostile parent', () => {
  const dir = tempDir('env');
  const paths = resolvePaths({ CLO_TEST_ROOT: dir });
  const parent = {
    SystemRoot: process.env.SystemRoot, CLO_QQ_APP_SECRET: 'REAL-LOOKING-QQ-SECRET', CLO_QQ_APP_ID: 'REALAPPID', HTTP_PROXY: 'http://x', OPENROUTER_API_KEY: 'PARENT-KEY', CLO_CHAT_API_KEY: 'PARENT-KEY', PERPLEXITY_API_KEY: 'x', NODE_OPTIONS: '--x', OPENCLAW_STATE_DIR: 'C:\\project\\.runtime\\state', CLO_TEST_ROOT: 'C:\\project',
  };
  const env = q5GatewayEnv(paths, parent, { key: FAKE_KEY, token: 'T', allowedHost: 'openrouter.ai', guardLog: 'g.log', testMode: false, modelOrigin: 'https://openrouter.ai', callLog: 'c.log', turnFile: 't', turnCallLimit: 2 });
  assert.equal(env.CLO_QQ_APP_SECRET, FAKE_QQ_SECRET);
  assert.equal(env.CLO_QQ_APP_ID, FAKE_APP_ID);
  assert.equal(env.OPENROUTER_API_KEY, FAKE_KEY);
  assert.equal(env.CLO_CHAT_API_KEY, undefined);
  assert.equal(env.CLO_Q5_ALLOWED_HOST, 'openrouter.ai');
  for (const k of ['HTTP_PROXY', 'PERPLEXITY_API_KEY', 'CLO_TEST_ROOT', 'OPENCLAW_OFFLINE']) assert.equal(env[k], undefined, k);
  assert.match(env.NODE_OPTIONS, /^--import=file:.*q5-net-guard\.mjs$/, 'the parent value does not pass, and a Node child gets the guard');
  for (const k of ['OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH', 'OPENCLAW_WORKSPACE_DIR', 'OPENCLAW_HOME', 'TEMP', 'APPDATA']) assert.ok(env[k].startsWith(dir), `${k} is outside the temp root`);
  assert.equal(q5GatewayEnv(paths, parent, { key: FAKE_KEY, token: 'T', allowedHost: '', guardLog: 'g.log', testMode: true }).OPENCLAW_OFFLINE, '1');
});

test('isolation: a temp root passes, and a root inside the project is refused', () => {
  const dir = tempDir('iso');
  assertIsolated(resolvePaths({ CLO_TEST_ROOT: dir }), ROOT);
  assert.throws(() => assertIsolated(resolvePaths({ CLO_TEST_ROOT: join(ROOT, 'tests', 'inside') }), ROOT), /inside the project/);
  // Same characters at the start, but a different folder.
  assertIsolated(resolvePaths({ CLO_TEST_ROOT: `${ROOT}-not-inside` }), ROOT);
  const cfg = probeConfig({ repoRoot: ROOT, qqBase: 'http://127.0.0.1:5', port: 7 });
  assert.equal(cfg.qq.appId, FAKE_APP_ID);
  assert.equal(cfg.openrouter, undefined, 'the real run takes the host native route');
  assert.equal(cfg.mode, 'live');
  assert.ok(!readFileSync(PROBE, 'utf8').includes("'config.json'"), 'never named as a file to read');
});

test('the real render: native route, no key or base URL on disk, QQ still loopback, and the guard names only OpenRouter', () => {
  const dir = tempDir('realrender');
  const paths = resolvePaths({ CLO_TEST_ROOT: dir });
  const args = { repoRoot: ROOT, paths, qqBase: 'http://127.0.0.1:5', port: 7, catalog: defaultCatalog(), baseUrl: 'https://openrouter.ai/api/v1', key: FAKE_KEY };
  const real = renderForProbe({ ...args, testMode: false });
  const provider = real.openclaw.models.providers.openrouter;
  assert.equal(provider.baseUrl, undefined);
  assert.equal(provider.apiKey, undefined);
  assert.equal(provider.request, undefined, 'no private-network allowance on the real route');
  assert.equal(real.effective.openrouter.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(real.effective.mode, 'live');
  assert.equal(real.openclaw.agents.defaults.model.primary, `openrouter/${PRIMARY_ID}`);
  assert.deepEqual(real.openclaw.agents.defaults.model.fallbacks, []);
  assert.match(real.openclaw.channels['clo-qq'].apiBaseUrl, /^http:\/\/127\.0\.0\.1/);
  assert.ok(!real.rendered.includes(FAKE_KEY));
  // Positive control: the test render does carry the mock's address, so the assertions above can tell them apart.
  const mocked = renderForProbe({ ...args, baseUrl: 'http://127.0.0.1:6/api/v1', testMode: true });
  assert.equal(mocked.openclaw.models.providers.openrouter.baseUrl, 'http://127.0.0.1:6/api/v1');
  assert.throws(() => renderForProbe({ ...args, qqBase: 'https://api.sgroup.qq.com', testMode: false }), /invalid config|loopback/);
  assert.throws(() => renderForProbe({ ...args, key: 'openrouter', testMode: false }), /reached openclaw\.json/, 'a key that shows up in the file is refused');
});

test('the endpoint is fixed outside test mode, and test mode takes loopback only', () => {
  assert.deepEqual(resolveEndpoint({}), { baseUrl: 'https://openrouter.ai/api/v1', testMode: false });
  assert.throws(() => resolveEndpoint({ CLO_Q5_TEST_BASE: 'http://127.0.0.1:1' }), /only allowed in test mode/);
  assert.throws(() => resolveEndpoint({ CLO_TEST_ROOT: 'x' }), /loopback/);
  assert.throws(() => resolveEndpoint({ CLO_TEST_ROOT: 'x', CLO_Q5_TEST_BASE: 'https://openrouter.ai/api/v1' }), /loopback/);
  assert.equal(resolveEndpoint({ CLO_TEST_ROOT: 'x', CLO_Q5_TEST_BASE: 'http://127.0.0.1:1/api/v1' }).testMode, true);
});

test('its own fetch cannot leave the model host', async () => {
  const m = await mock();
  const hits = [];
  const fetchImpl = (url, init) => {
    hits.push(url);
    return fetch(url, init);
  };
  await run(m, { fetchImpl });
  assert.ok(hits.length > 0);
  assert.ok(hits.every((u) => u.startsWith(m.base)));
});

// The guard runs for real in a child, since it patches process-wide. Custom lookups mean no DNS query leaves.
function guardChild(allowedHost, script, extra = {}) {
  const dir = tempDir('guard');
  const log = join(dir, 'g.jsonl');
  const r = spawnSync(NODE, [`--import=${GUARD}`, '--input-type=module', '-e', script], {
    cwd: dir,
    env: cleanChildEnv({ CLO_Q5_ALLOWED_HOST: allowedHost, CLO_NET_GUARD_LOG: log, ...extra }),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  assert.equal(r.status, 0, r.stderr);
  return { result: JSON.parse(r.stdout), hosts: existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).host) : [] };
}

const GUARD_SCRIPT = (hosts) => `
import net from 'node:net';
import dns from 'node:dns';
const server = net.createServer((s) => s.end());
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const lookup = (h, o, cb) => (o && o.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4));
const tryConnect = (host) => new Promise((res) => {
  const s = net.connect({ host, port, lookup });
  s.once('connect', () => { s.destroy(); res('connected'); });
  s.once('error', (e) => res(e.code));
});
const tryLookup = (host) => new Promise((res) => dns.lookup(host, (e) => res(e ? e.code : 'resolved')));
const result = {};
for (const h of ${JSON.stringify(hosts)}) result[h] = await tryConnect(h);
result.loopback = await tryConnect('127.0.0.1');
result.lookupQq = await tryLookup('api.sgroup.qq.com');
server.close();
console.log(JSON.stringify(result));
`;

test('the guard refuses QQ, Tencent and everything unnamed, even with a resolver that would reach loopback', () => {
  const { result, hosts } = guardChild('model.invalid', GUARD_SCRIPT(['api.sgroup.qq.com', 'bots.qq.com', 'x.tencent.com', 'clawhub.ai', 'other.invalid', 'model.invalid']));
  for (const h of ['api.sgroup.qq.com', 'bots.qq.com', 'x.tencent.com', 'clawhub.ai', 'other.invalid']) assert.equal(result[h], 'ECONNREFUSED', h);
  assert.equal(result['model.invalid'], 'connected', 'positive control: the named host passes');
  assert.equal(result.loopback, 'connected', 'positive control: the mock QQ stays reachable');
  assert.equal(result.lookupQq, 'ENOTFOUND');
  assert.ok(hosts.includes('bots.qq.com'));
  assert.ok(!hosts.includes('model.invalid'));
});

test('the guard refuses a QQ host even when it is the named one', () => {
  const { result } = guardChild('bots.qq.com', GUARD_SCRIPT(['bots.qq.com', 'evil.bots.qq.com']));
  assert.equal(result['bots.qq.com'], 'ECONNREFUSED');
  assert.equal(result['evil.bots.qq.com'], 'ECONNREFUSED');
});

test('loopback means a real loopback address: a name that starts with 127. is refused', () => {
  const { result, hosts } = guardChild('', GUARD_SCRIPT(['127.evil.invalid', '127.x.qq.com', '127.0.0.1.nip.invalid', '::ffff:7f00:1']));
  for (const h of ['127.evil.invalid', '127.x.qq.com', '127.0.0.1.nip.invalid', '::ffff:7f00:1']) assert.equal(result[h], 'ECONNREFUSED', h);
  assert.equal(result.loopback, 'connected', 'positive control');
  assert.ok(hosts.includes('127.evil.invalid'));
});

// The default resolver is pointed at loopback first, so a broken guard still sends no query off this machine.
const RESOLVE_SCRIPT = `
import dns, { lookup as namedLookup, resolve4 as namedResolve4 } from 'node:dns';
import { lookup as promiseNamedLookup } from 'node:dns/promises';
dns.setServers(['127.0.0.1']);
const cb = (fn, ...a) => new Promise((res) => { try { fn(...a, (e) => res(e ? e.code : 'answered')); } catch (e) { res(e.code); } });
const pr = (fn, ...a) => fn(...a).then(() => 'answered', (e) => e.code);
const custom = new dns.Resolver();
custom.setServers(['127.0.0.1']);
const pcustom = new dns.promises.Resolver();
pcustom.setServers(['127.0.0.1']);
const result = {
  resolve4: await cb(dns.resolve4, 'r4.invalid'),
  resolve: await cb(dns.resolve, 'r.invalid'),
  resolveTxt: await cb(dns.resolveTxt, 'txt.invalid'),
  reverse: await cb(dns.reverse, '8.8.8.8'),
  customResolver: await cb(custom.resolve4.bind(custom), 'c.invalid'),
  promiseLookup: await pr(dns.promises.lookup, 'pl.invalid'),
  promiseResolve4: await pr(dns.promises.resolve4, 'pr.invalid'),
  promiseCustom: await pr(pcustom.resolve4.bind(pcustom), 'pc.invalid'),
  namedLookup: await cb(namedLookup, 'nl.invalid'),
  namedResolve4: await cb(namedResolve4, 'nr.invalid'),
  promiseNamedLookup: await pr(promiseNamedLookup, 'pnl.invalid'),
};
console.log(JSON.stringify(result));
`;

test('every kind of DNS query is refused, through the module, a Resolver, the promises API and named imports', () => {
  const { result, hosts } = guardChild('', RESOLVE_SCRIPT);
  for (const [name, code] of Object.entries(result)) assert.equal(code, 'ENOTFOUND', name);
  for (const h of ['r4.invalid', 'pl.invalid', 'pr.invalid', 'c.invalid', 'pc.invalid', 'nl.invalid', 'pnl.invalid', '8.8.8.8']) assert.ok(hosts.includes(h), h);
});

test('a Node child that keeps the environment loads the guard too', () => {
  const script = `
import { spawnSync } from 'node:child_process';
const keptEnv = process.env; // This child's own clean environment, which is the point of the test.
const r = spawnSync(process.execPath, ['--input-type=module', '-e', \`
import net from 'node:net';
const lookup = (h, o, cb) => (o && o.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4));
const s = net.connect({ host: 'api.sgroup.qq.com', port: 9, lookup });
s.once('connect', () => { console.log('connected'); s.destroy(); });
s.once('error', (e) => console.log(e.message));
\`], { encoding: 'utf8', env: keptEnv });
console.log(JSON.stringify({ child: r.stdout.trim() }));
`;
  const { result, hosts } = guardChild('', script, { NODE_OPTIONS: `--import=${GUARD}` });
  assert.match(result.child, /q5-net-guard: refused/);
  assert.ok(hosts.includes('api.sgroup.qq.com'));
});

// The limit ends the process, so it runs in a child, against a server here that counts what really arrives.
async function limitChild(script, { turn = 't1', limit = 2 } = {}) {
  const dir = tempDir('limit');
  const arrived = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      arrived.push(`${req.method} ${req.url}`);
      res.end('{}');
    });
  });
  await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const callLog = join(dir, 'calls.jsonl');
  const turnFile = join(dir, 'turn');
  writeFileSync(turnFile, turn);
  const status = await new Promise((res, rej) => {
    const child = spawn(NODE, [`--import=${GUARD}`, '--input-type=module', '-e', script(origin)], {
      cwd: dir,
      env: cleanChildEnv({ CLO_Q5_ALLOWED_HOST: '', CLO_NET_GUARD_LOG: join(dir, 'g.jsonl'), CLO_Q5_MODEL_ORIGIN: origin, CLO_Q5_CALL_LOG: callLog, CLO_Q5_TURN_FILE: turnFile, CLO_Q5_TURN_CALL_LIMIT: String(limit) }),
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', rej);
    child.on('close', res);
  });
  server.closeAllConnections();
  await new Promise((r) => { server.close(r); });
  const log = existsSync(callLog) ? readFileSync(callLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { status, arrived, log };
}

const THREE_FETCH = (origin) => `
for (let i = 0; i < 3; i += 1) await (await fetch('${origin}/api/v1/chat/completions', { method: 'POST', body: '{}' })).text();
process.exit(0);
`;

test('the request over the limit never arrives: the process ends first, and the refusal is on record', async () => {
  const r = await limitChild(THREE_FETCH);
  assert.equal(r.arrived.length, 2, 'two arrived, the third did not');
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.log.map((l) => l.refused), [false, false, true]);
});

test('positive control: under the limit every request passes and the process ends normally', async () => {
  const r = await limitChild(THREE_FETCH, { limit: 3 });
  assert.equal(r.arrived.length, 3);
  assert.equal(r.status, 0);
  assert.deepEqual(r.log.map((l) => l.refused), [false, false, false]);
});

test('no model request is allowed outside a planned turn', async () => {
  const r = await limitChild(THREE_FETCH, { turn: 'none' });
  assert.equal(r.arrived.length, 0);
  assert.notEqual(r.status, 0);
});

test('a GET to the model host, and a POST elsewhere, are not model requests', async () => {
  const script = (origin) => `
for (let i = 0; i < 4; i += 1) await (await fetch('${origin}/api/v1/key')).text();
process.exit(0);
`;
  const r = await limitChild(script, { limit: 0 });
  assert.equal(r.arrived.length, 4);
  assert.equal(r.status, 0);
  assert.deepEqual(r.log, []);
});

test('the limit also covers a request made with node:http', async () => {
  const script = (origin) => `
import http from 'node:http';
const post = () => new Promise((res, rej) => {
  const q = http.request('${origin}/api/v1/chat/completions', { method: 'POST' }, (r) => { r.resume(); r.on('end', res); });
  q.on('error', rej);
  q.end('{}');
});
for (let i = 0; i < 3; i += 1) await post();
process.exit(0);
`;
  const r = await limitChild(script);
  assert.equal(r.arrived.length, 2);
  assert.notEqual(r.status, 0);
});

// --- results hold no text ---

test('results hold numbers and classes: no prompt, model text, flagged input, raw or provider message', async () => {
  const m = await mock();
  m.setDecision(() => ({ text: `答 ${CANARY}`, usage: { prompt_tokens: 777, completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 3 }, prompt_tokens_details: { cached_tokens: 2 }, cost: 0.0002 } }));
  let n = 0;
  m.setScript(() => {
    n += 1;
    if (n === 1) return { text: `模型的回答 ${CANARY}`, finishReason: `reason ${CANARY}`, usage: { cost: 0.001 } };
    return { error: { status: 403, body: { error: { code: 403, message: `provider said ${CANARY}`, metadata: { flagged_input: CANARY, raw: `raw ${CANARY}`, reasons: [CANARY], provider_name: CANARY } } } } };
  });
  const r = await run(m);
  assert.equal(r.stopReason, 'moderation');
  assert.ok(!r.raw.includes('CANARYTEXT'), 'a canary reached the results');
  assert.ok(!r.said.includes('CANARYTEXT'), 'a canary reached the output');
  for (const text of [FIXED.question, FIXED.baselineSystem, FIXED.turns[0], plan.texts.policy.slice(0, 40)]) assert.ok(!r.raw.includes(text));
  // Positive control: the mock did send the canary, and the numbers did arrive.
  const first = r.lines.find((l) => l.id === 'decision_with_prompt');
  assert.equal(first.promptTokens, 777);
  assert.equal(first.reasoningTokens, 3);
  assert.equal(first.cachedTokens, 2);
  assert.equal(first.costUsd, 0.0002);
  assert.equal(first.finishReason, 'stop');
  assert.ok(first.contentChars > 0);
  const refused = r.lines.find((l) => l.class === 'moderation');
  assert.deepEqual(refused.metadataKeys, ['flagged_input', 'raw', 'reasons', 'provider_name']);
  assert.equal(r.lines.find((l) => l.id === 'primary_baseline').finishReason, 'other', 'an unknown finish_reason is not copied');
});

test('the writer gate refuses anything shaped like a key, even in a field that takes short identifiers', () => {
  const key = `sk-or-v1-${'a1b2c3d4'.repeat(8)}`;
  assert.equal(key.length, 73);
  const out = sanitizeResult({ kind: 'x', reason: key, keyLimitReset: key, source: 'sk-short', refusedHosts: [key, 'clawhub.ai', 'sk-or-v1-x'], state: 'fine_value' });
  assert.deepEqual(out, { kind: 'x', refusedHosts: ['clawhub.ai'], state: 'fine_value' });
});

test('a /key answer echoing the key cannot put it in the results file', async () => {
  const m = await mock();
  m.setKey({ limit_reset: FAKE_KEY });
  const r = await run(m);
  assert.equal(r.stopReason, 'no_daily_limit');
  assert.ok(!r.raw.includes(FAKE_KEY));
  assert.equal(r.lines.find((l) => l.kind === 'key_read').keyLimitReset, 'other', 'a value outside the list is noted, not copied');
});

test('provider words in plain ASCII stay out of errorType, providerName and the metadata names', async () => {
  const words = 'ascii_text_as_key_name';
  const c = classifyError(500, { code: 500, type: 'ASCII-provider-words_here', metadata: { provider_name: 'ascii-provider-words', [words]: 1, provider_name_2: 2 } });
  assert.equal(c.errorType, 'other');
  assert.equal(c.providerName, 'other');
  assert.deepEqual(c.metadataKeys, ['provider_name', 'other_key']);
  assert.ok(!JSON.stringify(c).includes('ascii'));
  assert.ok(!JSON.stringify(c).includes('ASCII'));
  // Positive controls: known names still come through, which is what Q5 is there to read.
  const known = classifyError(403, { code: 403, type: 'forbidden', metadata: { provider_name: 'Amazon Bedrock', limit_source: 'openrouter_key_limit', model_slug: 'x' } });
  assert.equal(known.errorType, 'forbidden');
  assert.equal(known.providerName, 'amazon_bedrock');
  assert.deepEqual(known.metadataKeys, ['provider_name', 'limit_source', 'model_slug']);
  const m = await mock();
  m.setScript(() => ({ text: '四个。', usage: { cost: 0.001 } }));
  const r = await run(m, { plan: noTurns, fetchImpl: async (url, init) => {
    if (url.endsWith('/chat/completions') && JSON.parse(init.body).max_tokens !== 200) {
      return new Response(JSON.stringify({ model: 'x', provider: 'ascii-provider-words', choices: [{ message: { content: 'a' }, finish_reason: 'stop' }], usage: { cost: 0.001 } }));
    }
    return fetch(url, init);
  } });
  assert.ok(!r.raw.includes('ascii-provider-words'));
  assert.ok(r.lines.some((l) => l.providerName === 'other'));
});

test('the writer gate: unknown keys, text with spaces and non-ASCII never pass, and plain figures do', () => {
  const out = sanitizeResult({
    kind: 'call', costUsd: 0.5, usageMissing: false, class: 'ok', state: 'a b', reason: CANARY, model: 'x', message: 'y', metadataKeys: ['fine', 'not fine', CANARY], tier: null, durationMs: Infinity, id: { a: 1 },
  });
  assert.deepEqual(out, { kind: 'call', costUsd: 0.5, usageMissing: false, class: 'ok', metadataKeys: ['fine'], tier: null });
});

// --- lag and suggestions ---

test('the lag: from the last paid call until the Key shows the reported spend', async () => {
  const m = await mock();
  m.setKey({ usage: 10 });
  const r = await run(m, {
    lagMs: 60000,
    pollMs: 10,
    gatewayStage: async () => {
      setTimeout(() => m.setKey({ usage: 10.0032 }), 60);
      return { stop: null };
    },
  });
  assert.equal(r.stopReason, null);
  assert.ok(r.lag.matchedMs >= 40, `matched at ${r.lag.matchedMs}`);
  assert.equal(r.lag.timedOut, false);
  assert.ok(r.lag.polls >= 2);
  const line = r.lines.find((l) => l.kind === 'lag');
  assert.equal(line.keyDeltaUsd, 0.0032);
  assert.equal(line.reportedUsd, 0.0032);
});

test('a Key that never catches up times out, and a suggestion says so', async () => {
  const m = await mock();
  m.setKey({ usage: 10 });
  const r = await run(m, { lagMs: 60, pollMs: 10 });
  assert.equal(r.lag.timedOut, true);
  assert.equal(r.lag.matchedMs, null);
  assert.equal(r.suggestions.find((s) => s.name === 'ledger.UNSETTLED_CLEAR_MS').basis, 'lag_not_reached_rerun_longer');
});

test('suggestions come from the figures, and are only ever labelled and printed', async () => {
  const base = { plan, calls: [], turns: [], lag: null, prices: null };
  const pick = (list, name) => list.find((s) => s.name === name);
  const empty = suggestConfig(base);
  assert.equal(pick(empty, 'claudeModel.maxTokens').basis, 'no_data');
  assert.equal(pick(empty, 'claudeModel.maxTokens').suggested, plan.primaryMaxTokens);
  assert.equal(pick(empty, 'ledger.UNSETTLED_CLEAR_MS').basis, 'no_data');

  const call = (over) => ({ class: 'ok', role: 'primary', completionTokens: 100, finishReason: 'stop', ...over });
  assert.equal(pick(suggestConfig({ ...base, calls: [call({})] }), 'claudeModel.maxTokens').basis, 'keep_small_sample');
  assert.equal(pick(suggestConfig({ ...base, calls: [call({ completionTokens: 2000 })] }), 'claudeModel.maxTokens').suggested, 4000);
  assert.equal(pick(suggestConfig({ ...base, calls: [call({ finishReason: 'length' })] }), 'claudeModel.maxTokens').suggested, plan.primaryMaxTokens * 2);
  const hold = (promptTokens) => pick(suggestConfig({ ...base, calls: [call({ id: 'decision_with_prompt', role: 'decision', promptTokens, completionTokens: 10 })] }), 'ledger.decisionHoldInputTokens');
  assert.equal(pick(empty, 'ledger.decisionHoldInputTokens').current, DECISION_INPUT_TOKENS, 'the current hold is the ledger\'s');
  assert.equal(hold(300).current, DECISION_INPUT_TOKENS);
  assert.equal(hold(300).suggested, DECISION_INPUT_TOKENS, 'a short input measuring small is no reason to cut the hold');
  assert.equal(hold(300).basis, 'keep');
  assert.equal(hold(1000).suggested, DECISION_INPUT_TOKENS, 'nor one in the usual range');
  assert.equal(hold(1000).basis, 'keep');
  assert.ok(hold(1500).suggested > DECISION_INPUT_TOKENS, 'scaled to the largest input, not doubled');
  assert.equal(hold(1500).basis, 'largest_input_above_hold');
  assert.equal(pick(suggestConfig({ ...base, calls: [call({ class: 'server' })] }), 'budget.providerFailStreakPause').basis, 'failures_seen_review_by_hand');
  assert.equal(pick(suggestConfig({ ...base, lag: { matchedMs: 20 * 60000, firstDeltaMs: 1 } }), 'ledger.UNSETTLED_CLEAR_MS').suggested, 40 * 60000);
  assert.equal(pick(suggestConfig({ ...base, lag: { matchedMs: 1000, firstDeltaMs: 1 } }), 'ledger.UNSETTLED_CLEAR_MS').suggested, 15 * 60000);
  assert.equal(pick(suggestConfig({ ...base, prices: { inputPerM: 5, outputPerM: 20, cacheWritePerM: 6.25 } }), 'ledger.replyRequiredHoldUsd').suggested, 2 * (24000 * 6.25 + 3000 * 20) / 1e6);

  const m = await mock();
  const r = await run(m);
  assert.match(r.said, /SUGGESTION claudeModel\.maxTokens/);
  assert.match(r.said, /suggestions only: nothing was changed/);
  assert.ok(!/writeConfig|writeFileSync\([^)]*configJson|writeAtomic\([^)]*configJson/.test(readFileSync(PROBE, 'utf8')), 'no route to writing config.json');
});

test('it reports the policy block and the decision prompt as tokens above their baselines', async () => {
  const m = await mock();
  m.setDecision((rec) => ({ text: decisionText(), usage: { prompt_tokens: rec.body.messages.length === 2 ? 900 : 100, completion_tokens: 5, cost: 0.0001 } }));
  m.setScript((rec) => ({ text: '四个。', usage: { prompt_tokens: rec.body.messages[0].content === plan.texts.policy ? 2600 : 600, completion_tokens: 5, cost: 0.001 } }));
  const r = await run(m);
  assert.match(r.said, /Content-policy block: 2000 tokens above baseline\. Decision prompt: 800 tokens above baseline\./);
  assert.equal(r.lines.find((l) => l.name === 'content_policy_block').tokens, 2000);
});

test('requests match what the Gateway would send: the decision builder, the rendered system prompt, no fallback', async () => {
  const m = await mock();
  await run(m);
  const byCall = Object.fromEntries(plan.calls.map((c, i) => [c.id, m.requests[i]]));
  const d = byCall.decision_with_prompt.body;
  assert.equal(d.model, 'anthropic/claude-haiku-5.5');
  assert.equal(d.stream, false);
  assert.equal(d.max_tokens, 200);
  assert.deepEqual(d.reasoning, { effort: 'none' });
  assert.ok(d.response_format);
  assert.equal(d.messages[0].content, plan.texts.decisionPrompt);
  assert.equal(JSON.parse(d.messages[1].content).current.text, FIXED.decisionInput.current.text);
  const full = byCall.primary_full_prompt.body;
  assert.equal(full.model, PRIMARY_ID);
  assert.equal(full.max_tokens, 3000);
  assert.deepEqual(full.reasoning, { effort: 'low' });
  assert.equal(full.fallbacks, undefined);
  assert.equal(full.models, undefined);
  assert.equal(full.messages[0].content, plan.texts.systemPrompt);
});

// --- the wrapper ---

const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function ps(args, root) {
  return spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-File', join(ROOT, 'scripts', 'q5-probe.ps1'), ...args], {
    cwd: tmpdir(),
    env: cleanChildEnv({ CLO_TEST_ROOT: root, CLO_Q5_TEST_BASE: 'http://127.0.0.1:9/api/v1', PSModulePath: process.env.PSModulePath }),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
  });
}

test('the wrapper is ASCII, uses the private Node, and carries output and exit codes', () => {
  const text = readFileSync(join(ROOT, 'scripts', 'q5-probe.ps1'));
  assert.ok(text.every((b) => b < 128), 'scripts/q5-probe.ps1 must be ASCII');
  const src = text.toString();
  assert.ok(src.includes('_env.ps1'), 'clears proxy variables');
  assert.ok(src.includes('$NodeExe'));

  const root = cliRoot('ps');
  const plain = ps([], root);
  assert.equal(plain.status, 0, plain.stderr);
  assert.ok(plain.stdout.includes(FIXED.question), 'UTF-8 survives the pipe');
  assert.match(plain.stdout, /no request was made/);
  const noCap = ps(['-Approve'], root);
  assert.equal(noCap.status, 2);
  assert.match(`${noCap.stdout}${noCap.stderr}`, /--max-usd/);
  const low = ps(['-Approve', '-MaxUsd', '0.01'], root);
  assert.equal(low.status, 2);
});

// --- the own runtime: the project's turn runner in this process, against the mock OpenRouter ---

const ownPlan = buildPlan(ROOT, { runtime: 'own' });
const isOwnTurn = (rec) => Array.isArray(rec.body?.messages?.[0]?.content);
const ownRequests = (m) => m.requests.filter(isOwnTurn);
const FAKE_IDS = ['Q5FAKEGROUP', 'Q5FAKEOWNER', 'Q5FAKEMEMBER', 'Q5FAKEBOT', FAKE_APP_ID, '127.0.0.1'];
// The own turns answer this unless a test says otherwise. The direct primary calls keep the mock's default.
const ANSWER = '四个：春夏秋冬。';

async function ownMock(turnStep) {
  const m = await mock();
  m.setScript((rec, n) => (isOwnTurn(rec)
    ? (turnStep?.(rec, ownRequests(m).length) ?? { text: ANSWER, usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.002 } })
    : { text: '四个。', usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.001 } }));
  return m;
}

const ownRun = (m, over = {}) => run(m, { plan: ownPlan, gatewayStage: async () => { throw new Error('the Gateway stage must not run'); }, ...over });

test('own plan: one request per turn at one worst-case call, no tool, and a user message with no ID in it', () => {
  assert.equal(ownPlan.runtime, 'own');
  assert.equal(OWN_TURN_CALL_LIMIT, 1);
  assert.equal(ownPlan.turnCallLimit, 1);
  assert.deepEqual(ownPlan.turns.map((t) => t.id), ['own_turn_1', 'own_turn_2']);
  assert.equal(ownPlan.turns[0].worstMicros, ownPlan.turnCallWorstMicros);
  assert.equal(ownPlan.maxModelCalls, ownPlan.calls.length + ownPlan.turns.length);
  assert.equal(ownPlan.totalWorstMicros, ownPlan.calls.reduce((a, c) => a + c.worstMicros, 0) + ownPlan.turns.length * ownPlan.turnCallWorstMicros);
  assert.equal(ownPlan.tool, undefined, 'the own runner sends no tools');
  // Positive control: the Gateway plan holds two calls a turn and carries the tool schema.
  assert.equal(plan.turns[0].worstMicros, 2 * ownPlan.turnCallWorstMicros);
  assert.ok(plan.tool);
  assert.equal(ownPlan.userPreview.length, 2);
  const [first, second] = ownPlan.userPreview.map((u) => u.split('\n'));
  assert.match(first[0], /^\[clo-turn class=at time=\S+ \S+ Asia\/Shanghai\]$/);
  assert.equal(JSON.parse(first[1]).text, FIXED.turns[0]);
  assert.deepEqual(JSON.parse(second[1]).recent.map((r) => r.who), ['U1', '可洛']);
  for (const id of FAKE_IDS) assert.ok(!ownPlan.userPreview.join('\n').includes(id), id);
  assert.throws(() => buildPlan(ROOT, { runtime: 'gateway' }), /unknown runtime/);
});

test('own plan without --approve: the runner layout is printed, with no request and no .env read', async () => {
  const m = await mock();
  const root = cliRoot('ownplan');
  const fsLog = join(root, 'fs.log');
  const r = await cli(['--runtime', 'own'], { root, base: m.base, imports: [tracker(root)], extra: { CLO_FS_LOG: fsLog } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /plan \(runtime own\)/);
  assert.match(r.stdout, /no Gateway, no QQ and no mock QQ/);
  for (const u of ownPlan.userPreview) assert.ok(r.stdout.includes(u), 'the exact user message');
  assert.ok(!r.stdout.includes(HOST_ADDED.runtimeContextPrefix), 'nothing the host would add');
  assert.ok(r.stdout.includes(`At most ${ownPlan.maxModelCalls} model calls`));
  assert.equal(paid(m) + m.other.length, 0);
  assert.equal(existsSync(fsLog), false);
  // Positive control: the default is still the Gateway plan.
  const gw = await cli([], { root });
  assert.ok(gw.stdout.includes(HOST_ADDED.runtimeContextPrefix));
  assert.doesNotMatch(gw.stdout, /runtime own/);
});

test('own run: both turns go through the runner, one request each, with the locked model, the cache marker and no ID', async () => {
  const m = await ownMock();
  const parent = tempDir('ownparent');
  const r = await ownRun(m, { tempParent: parent });
  assert.equal(r.stopReason, null, r.said);
  assert.equal(m.requests.length, ownPlan.calls.length + 2, 'positive control: the direct calls ran too');
  const reqs = ownRequests(m);
  assert.equal(reqs.length, 2, 'exactly one request per turn');
  for (const rec of reqs) {
    const b = rec.body;
    assert.equal(b.model, PRIMARY_ID);
    assert.equal(b.stream, false);
    assert.equal(b.max_tokens, ownPlan.primaryMaxTokens);
    assert.deepEqual(b.reasoning, { effort: ownPlan.primaryEffort });
    assert.deepEqual(b.provider, { require_parameters: true });
    assert.deepEqual(b.usage, { include: true });
    for (const k of ['tools', 'tool_choice', 'models', 'route', 'user', 'fallbacks']) assert.equal(b[k], undefined, k);
    assert.equal(b.messages.length, 2);
    assert.deepEqual(b.messages[0].content, [{ type: 'text', text: ownPlan.texts.systemPrompt, cache_control: { type: 'ephemeral' } }]);
    assert.equal(typeof b.messages[1].content, 'string');
    assert.equal(rec.headers['http-referer'], undefined, 'no attribution header');
    assert.equal(rec.headers['x-title'], undefined);
    assert.equal(rec.headers.authorization, `Bearer ${FAKE_KEY}`);
    for (const id of FAKE_IDS) assert.ok(!b.messages[1].content.includes(id), id);
  }
  const [u1, u2] = reqs.map((rec) => JSON.parse(rec.body.messages[1].content.split('\n')[1]));
  assert.equal(u1.text, FIXED.turns[0]);
  assert.deepEqual(u1.recent, []);
  assert.equal(u2.text, FIXED.turns[1]);
  assert.deepEqual(u2.recent, [{ who: 'U1', text: FIXED.turns[0] }, { who: '可洛', text: ANSWER }], 'her answer to turn 1 is in turn 2 as her own line');
  const lines = r.lines.filter((l) => l.kind === 'own_turn');
  assert.deepEqual(lines.map((l) => [l.state, l.guardRequests, l.collects, l.cacheMarker, l.sameSystem]), [['completed', 1, 1, true, true], ['completed', 1, 1, true, true]]);
  assert.deepEqual(lines.map((l) => l.countedUsd), [0.002, 0.002]);
  assert.equal(r.totals.countedAtWorstMicros, 0);
  assert.equal(r.lines.find((l) => l.kind === 'own_stage').state, 'finished');
  assert.equal(r.lines.find((l) => l.kind === 'run_start').runtime, 'own');
  assert.ok(!r.raw.includes(ANSWER), 'the answer is not in the results');
  assert.ok(!r.raw.includes(FAKE_KEY));
  assert.deepEqual(readdirSync(parent), [], 'no temp root: nothing on disk in this mode');
  assert.equal(existsSync(join(tmpdir(), 'clo-q5-own-unused')), false);
});

test('a warm turn reads the cache marker: the cache read is recorded, and its absence is said', async () => {
  const warm = await ownMock((rec, n) => ({
    text: ANSWER,
    usage: { prompt_tokens: 4400, completion_tokens: 20, cost: n === 1 ? 0.025 : 0.007, prompt_tokens_details: n === 1 ? { cache_write_tokens: 4350 } : { cached_tokens: 4350, cache_write_tokens: 0 } },
  }));
  const r = await ownRun(warm);
  assert.equal(r.stopReason, null, r.said);
  const [t1, t2] = r.lines.filter((l) => l.kind === 'own_turn');
  assert.equal(t1.cacheWriteTokens, 4350);
  assert.equal(t1.cacheHit, null, 'the first turn is cold by definition');
  assert.equal(t2.cachedTokens, 4350);
  assert.equal(t2.cacheReadTokens, 4350, 'the runner read it from the same response');
  assert.equal(t2.cacheHit, true);
  const measure = r.lines.find((l) => l.name === 'warm_cache_read');
  assert.equal(measure.tokens, 4350);
  assert.equal(measure.cacheHit, true);
  assert.match(r.said, /Warm turn read 4350 tokens from the cache/);
  // The marker was on both requests, so a miss is the route's doing, not ours.
  const [b1, b2] = ownRequests(warm).map((q) => q.body.messages[0].content);
  assert.deepEqual(b1, b2, 'the cached prefix is byte for byte the same');

  const cold = await ownMock();
  const c = await ownRun(cold);
  assert.equal(c.stopReason, null);
  assert.equal(c.lines.find((l) => l.name === 'warm_cache_read').cacheHit, false);
  assert.match(c.said, /warm turn read nothing from the cache/);
  assert.doesNotMatch(c.said, /Warm turn read \d+/);
});

test('a turn with no usage counts at its worst and stops the run; a zero cost is not free either', async () => {
  for (const usage of [null, { prompt_tokens: 4000, completion_tokens: 20, cost: 0 }]) {
    const m = await ownMock(() => ({ text: ANSWER, usage }));
    const r = await ownRun(m);
    assert.equal(r.stopReason, 'usage_missing', JSON.stringify(usage));
    assert.equal(ownRequests(m).length, 1, 'the second turn did not run');
    const line = r.lines.find((l) => l.kind === 'own_turn');
    assert.equal(line.usageMissing, true);
    assert.equal(line.countedUsd, ownPlan.turnCallWorstMicros / 1e6);
    assert.equal(r.totals.countedAtWorstMicros, ownPlan.turnCallWorstMicros);
    assert.equal(r.totals.missingCount, 1);
  }
});

test('the cap is checked before each turn: a first turn that overspent leaves no room for the second', async () => {
  // Turn 1 reports everything the plan left for it and the turn after, and a little more.
  const over = (ownPlan.totalWorstMicros - ownPlan.turnCallWorstMicros) / 1e6 + 0.01;
  const m = await ownMock(() => ({ text: ANSWER, usage: { prompt_tokens: 100, completion_tokens: 20, cost: over } }));
  const r = await ownRun(m);
  assert.equal(r.stopReason, 'cap');
  assert.equal(ownRequests(m).length, 1);
  assert.equal(r.lines.find((l) => l.kind === 'own_stage').state, 'cap');
  // Positive control: a first turn that stays within its worst leaves room, and the second turn runs.
  const fine = await ownMock(() => ({ text: ANSWER, usage: { prompt_tokens: 100, completion_tokens: 20, cost: ownPlan.turnCallWorstMicros / 1e6 } }));
  const ok = await ownRun(fine);
  assert.equal(ok.stopReason, null);
  assert.equal(ownRequests(fine).length, 2);
});

test('no retry on the own runtime: a 500, a 429 or a refused connection is one request, counted at worst', async () => {
  for (const [status, stop] of [[500, 'own_turn_failed'], [429, 'rate_limit']]) {
    const m = await ownMock(() => ({ error: { status, body: { error: { code: status, message: `no ${CANARY}` } } } }));
    const r = await ownRun(m);
    assert.equal(r.stopReason, stop, String(status));
    assert.equal(ownRequests(m).length, 1, `${status}: one request, no retry`);
    const line = r.lines.find((l) => l.kind === 'own_turn');
    assert.equal(line.httpStatus, status);
    assert.equal(line.state, 'failed');
    assert.equal(line.collects, 0, 'nothing reached the exit');
    assert.equal(line.usageMissing, true);
    assert.ok(!r.raw.includes(CANARY));
  }
  // A connection refused before anything left is the one case the runner would retry. The probe refuses even that.
  const m = await ownMock();
  let attempts = 0;
  const fetchImpl = (url, init) => {
    if (url.endsWith('/chat/completions') && Array.isArray(JSON.parse(init.body).messages[0].content)) {
      attempts += 1;
      const err = new TypeError('fetch failed');
      err.cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', syscall: 'connect' });
      return Promise.reject(err);
    }
    return fetch(url, init);
  };
  const r = await ownRun(m, { fetchImpl });
  assert.equal(attempts, 1, 'the connect retry was refused');
  assert.equal(r.stopReason, 'own_turn_not_started');
  assert.equal(r.lines.find((l) => l.kind === 'own_turn').countedUsd, ownPlan.turnCallWorstMicros / 1e6, 'an attempt is counted at worst all the same');
});

test('a second request in one turn is refused before it leaves, and stops the run', async () => {
  const twice = (n) => (args) => runOwnStage({
    ...args,
    factories: {
      createTurnRunner: ({ client, getEffective }) => async (turn, { signal } = {}) => {
        let r;
        for (let i = 0; i < n; i += 1) {
          r = await client.post({ model: getEffective().models.primary.id, messages: [{ role: 'system', content: [{ type: 'text', text: ownPlan.texts.systemPrompt, cache_control: { type: 'ephemeral' } }] }, { role: 'user', content: 'x' }] }, { signal });
        }
        return { started: true, hostError: r.kind !== 'ok', aborted: false, usage: r.usage };
      },
    },
  });
  const m = await ownMock();
  const r = await ownRun(m, { ownStage: twice(2) });
  assert.equal(r.stopReason, 'turn_call_limit');
  assert.equal(ownRequests(m).length, 1, 'the second request never arrived');
  const line = r.lines.find((l) => l.kind === 'own_turn');
  assert.equal(line.guardRequests, 1);
  assert.equal(line.refusedRequests, 1);
  // Positive control: the same stand-in runner with one request passes the limit.
  const ok = await ownMock();
  const single = await ownRun(ok, { ownStage: twice(1) });
  assert.equal(single.lines.find((l) => l.kind === 'own_turn').refusedRequests, 0);
  assert.equal(ownRequests(ok).length, 1);
  assert.notEqual(single.stopReason, 'turn_call_limit');
});

test('no QQ route on the own runtime: a QQ address is refused before it leaves, and the config is fake and loopback', async () => {
  const seen = [];
  const fetchImpl = (url, init) => {
    seen.push(url);
    return fetch(url, init);
  };
  const qqClient = (args) => runOwnStage({
    ...args,
    factories: {
      createOpenRouterClient: ({ fetch: f }) => ({
        post: async () => {
          await f('https://api.sgroup.qq.com/v2/groups/x/messages', { method: 'POST', body: '{}' }).catch(() => {});
          return { kind: 'not_sent', reason: 'connect', status: null, message: null, finishReason: null, usage: null, info: null };
        },
      }),
    },
  });
  const m = await ownMock();
  const r = await ownRun(m, { fetchImpl, ownStage: qqClient });
  assert.equal(r.stopReason, 'qq_route_attempt');
  const stage = r.lines.find((l) => l.kind === 'own_stage');
  assert.equal(stage.qqRouteAttempt, true);
  assert.deepEqual(stage.refusedHosts, ['api.sgroup.qq.com']);
  assert.ok(seen.length > 0, 'positive control: the probe did fetch');
  assert.ok(!seen.some((u) => u.includes('qq.com')), 'nothing went to QQ');

  const eff = ownEffective({ repoRoot: ROOT, catalog: defaultCatalog(), baseUrl: 'https://openrouter.ai/api/v1', testMode: false });
  assert.equal(eff.runtime, 'own');
  assert.equal(eff.openrouter.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(eff.models.primary.id, PRIMARY_ID);
  assertOwnNoQqRoute(eff);
  for (const edit of [(e) => { e.qq.apiBaseUrl = 'https://api.sgroup.qq.com'; }, (e) => { e.qq.tokenBaseUrl = ''; }, (e) => { e.qq.appId = 'REALAPPID'; }, (e) => { e.runtime = 'openclaw'; }]) {
    const e = structuredClone(eff);
    edit(e);
    assert.throws(() => assertOwnNoQqRoute(e), /loopback|identity|own runtime/);
  }
  assert.throws(() => ownEffective({ repoRoot: ROOT, catalog: defaultCatalog(), baseUrl: 'http://127.0.0.1:6/api/v1', testMode: false }), /another model host/, 'outside test mode only the real host');
  assert.doesNotMatch(readFileSync(PROBE, 'utf8').split('// --- the own runtime stage')[1].split('// --- Key lag ---')[0], /mock-qq|qqbot|@tencent-connect|connectAccount|runConnection/, 'the own stage has no QQ client of any kind');
});

test('an interrupt during an own turn aborts the request: nothing reaches the exit, it counts at worst, and no turn follows', async () => {
  const ac = new AbortController();
  const m = await ownMock(() => {
    setTimeout(() => ac.abort(), 20);
    return { text: ANSWER, delayMs: 2000, usage: { cost: 0.002 } };
  });
  const started = Date.now();
  const r = await ownRun(m, { signal: ac.signal });
  assert.ok(Date.now() - started < 1900, 'the runner gave up at the abort, not at the answer');
  assert.equal(r.stopReason, 'interrupted');
  assert.equal(ownRequests(m).length, 1);
  const line = r.lines.find((l) => l.kind === 'own_turn');
  assert.equal(line.state, 'aborted');
  assert.equal(line.collects, 0);
  assert.equal(line.contentChars, 0);
  assert.equal(line.countedUsd, ownPlan.turnCallWorstMicros / 1e6, 'an aborted request may still be billed');
  assert.equal(r.lag, null);
});

test('a system prompt without the policy markers sends nothing on the own runtime', async () => {
  const broken = { ...ownPlan, texts: { ...ownPlan.texts, systemPrompt: ownPlan.texts.systemPrompt.replace(/<!-- clo-policy:1 -->/g, '') } };
  assert.notEqual(broken.texts.systemPrompt, ownPlan.texts.systemPrompt, 'the marker was there to remove');
  const m = await ownMock();
  const r = await ownRun(m, { plan: broken, maxUsd: roomy(ownPlan) });
  assert.equal(r.stopReason, 'own_turn_not_started');
  assert.equal(ownRequests(m).length, 0);
  const line = r.lines.find((l) => l.kind === 'own_turn');
  assert.equal(line.reason, 'policy_sentinel');
  assert.equal(line.countedUsd, 0, 'nothing left, so nothing is counted');
});

test('own suggestions: the required hold is the own ledger figure, and a cut-off own turn asks for more tokens', () => {
  const prices = { inputPerM: 5, outputPerM: 20, cacheReadPerM: 0.5, cacheWritePerM: 6.25 };
  const pick = (list, name) => list.find((s) => s.name === name);
  const own = pick(suggestConfig({ plan: ownPlan, calls: [], turns: [], lag: null, prices }), 'ledger.replyRequiredHoldUsd').suggested;
  const expected = replyHoldMicros('reply_required', { price: prices, contextTokens: ownPlan.contextTokens, maxTokens: ownPlan.primaryMaxTokens }, 'own');
  assert.equal(own, expected / 1e6);
  assert.equal(own, (24000 * 6.25 + 3000 * 20) / 1e6);
  assert.equal(pick(suggestConfig({ plan, calls: [], turns: [], lag: null, prices }), 'ledger.replyRequiredHoldUsd').suggested, 2 * own, 'positive control: the Gateway hold is twice that');
  const cut = suggestConfig({ plan: ownPlan, calls: [], turns: [{ outputTokens: 2990, finishReason: 'length', hostNotices: 0 }], lag: null, prices: null });
  assert.equal(pick(cut, 'claudeModel.maxTokens').basis, 'truncated_in_probe');
  const whole = suggestConfig({ plan: ownPlan, calls: [], turns: [{ outputTokens: 100, finishReason: 'stop', hostNotices: 0 }], lag: null, prices: null });
  assert.equal(pick(whole, 'claudeModel.maxTokens').basis, 'keep_small_sample');
});
