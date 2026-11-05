// The Q5 probe through its real command line, with a real Gateway, its own mock QQ, and a mock OpenRouter in this
// process. Everything sits in a temp root, and every key is fake. Nothing here reaches a real service.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { processInfo } from '../../src/cli/lifecycle.mjs';
import { buildPlan, createSpendTracker, FAKE_APP_ID, FIXED, HOST_ADDED, PRIMARY_ID, runGatewayStage, runProbe, TURN_CALL_LIMIT } from '../../src/tools/q5-probe.mjs';
import { cleanChildEnv } from '../harness/clean-env.mjs';
import { NODE, ROOT, sleep, until } from '../harness/gateway.mjs';
import { decisionText, defaultCatalog, startMockOpenRouter } from '../harness/mock-openrouter.mjs';

const PROBE = join(ROOT, 'src', 'tools', 'q5-probe.mjs');
const FAKE_KEY = 'sk-or-v1-CANARYKEY-Q5-E2E-NEVER-PRINT';
const QQ_SECRET_CANARY = 'QQSECRET-CANARY-MUST-NOT-REACH-GATEWAY';
const CONFIG_CANARY = '{"canary":"this file must not be used or changed"}';

const roots = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function makeRoot(label) {
  const root = mkdtempSync(join(tmpdir(), `clo-q5e-${label}-`));
  roots.push(root);
  writeFileSync(join(root, '.env'), `CLO_CHAT_API_KEY=${FAKE_KEY}\nCLO_QQ_APP_ID=REALLOOKINGAPPID\nCLO_QQ_APP_SECRET=${QQ_SECRET_CANARY}\n`);
  writeFileSync(join(root, 'config.json'), CONFIG_CANARY);
  return root;
}

const runRootOf = (root) => {
  const name = readdirSync(root).find((n) => n.startsWith('clo-q5-'));
  return name ? join(root, name) : null;
};

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) continue; // The host links to its own packages. Those are not what this run wrote.
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function startProbe(root, base, { maxUsd = '5', lagMinutes = '1', pollMs = '100' } = {}) {
  const child = spawn(NODE, ['--disable-warning=ExperimentalWarning', PROBE, '--approve', '--max-usd', maxUsd, '--lag-minutes', lagMinutes], {
    cwd: tmpdir(),
    env: cleanChildEnv({ CLO_TEST_ROOT: root, CLO_Q5_TEST_BASE: base, CLO_Q5_TEST_POLL_MS: pollMs, CLO_QQ_APP_SECRET: 'PARENT-QQ-SECRET', OPENROUTER_API_KEY: 'PARENT-KEY-MUST-NOT-PASS', CLO_CHAT_API_KEY: 'PARENT-KEY-MUST-NOT-PASS' }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const done = new Promise((res, rej) => {
    child.on('error', rej);
    child.on('close', (status) => res({ status, stdout, stderr }));
  });
  return { child, done };
}

const resultsOf = (root) => readFileSync(join(root, 'captures', 'q5-results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// Mtimes only, and nothing under the project's .runtime is opened. These two are the files a Gateway setup would
// write. Logs and the database are left out: a Gateway the user runs from the project can change those at any time.
const projectStamps = () => ['state/openclaw.json', 'clo/effective.json'].map((f) => {
  const p = join(ROOT, '.runtime', f);
  return existsSync(p) ? statSync(p).mtimeMs : null;
});

const quotaTurn = (rec) => rec.body?.stream !== false;

test('a whole run: direct calls, two Gateway turns on mock QQ, the lag, and suggestions; no key anywhere, and text only in the temp root\'s session store', { timeout: 600000 }, async () => {
  const root = makeRoot('full');
  const stamps = projectStamps();
  const model = await startMockOpenRouter();
  model.setKey({ usage: 5 });
  const answer = `四个季节。${'CANARYMODELTEXT'}`;
  model.setDecision((rec) => ({ text: decisionText(), usage: { prompt_tokens: rec.body.messages.length === 2 ? 900 : 100, completion_tokens: 12, completion_tokens_details: { reasoning_tokens: 0 }, cost: 0.0002 } }));
  model.setScript((rec) => (quotaTurn(rec)
    ? { text: answer, usage: { prompt_tokens: 3000, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 0 }, total_tokens: 3040 } }
    : { text: answer, usage: { prompt_tokens: 200, completion_tokens: 60, completion_tokens_details: { reasoning_tokens: 25 }, cost: 0.0025 } }));
  let cmdLine = null;
  let gatewayPid = null;
  const { child, done } = startProbe(root, model.base);
  try {
    // The Key catches up a moment after the second turn.
    const bumper = setInterval(() => {
      if (model.requests.filter(quotaTurn).length >= 2) model.setKey({ usage: 5.04 });
    }, 200);
    const watcher = setInterval(() => {
      const run = runRootOf(root);
      const file = run && join(run, '.runtime', 'gateway.pid');
      if (file && existsSync(file) && !cmdLine) {
        gatewayPid = Number(readFileSync(file, 'utf8'));
        cmdLine = processInfo(gatewayPid)?.commandLine ?? null;
      }
    }, 500);
    const r = await done;
    clearInterval(bumper);
    clearInterval(watcher);

    assert.equal(r.status, 0, `${r.stdout.slice(-2000)}\n${r.stderr.slice(-1000)}`);
    assert.match(r.stdout, /Run finished\./);
    assert.match(r.stdout, /Total reported spend: \$/);
    assert.match(r.stdout, /SUGGESTION claudeModel\.maxTokens/);
    assert.match(r.stdout, /Decision prompt: 800 tokens above baseline/);

    // Exactly the plan, and each direct call once.
    const direct = model.requests.filter((rec) => !quotaTurn(rec));
    const turns = model.requests.filter(quotaTurn);
    assert.equal(direct.length, 5);
    assert.equal(turns.length, 2);
    for (const rec of direct) assert.equal(rec.headers.authorization, `Bearer ${FAKE_KEY}`, 'the key went to the provider');
    for (const rec of turns) assert.equal(rec.body.model, PRIMARY_ID);
    const texts = turns.map((rec) => JSON.stringify(rec.body.messages));
    assert.ok(texts[0].includes(FIXED.turns[0]));
    assert.ok(texts[1].includes(FIXED.turns[1]));

    // The plan lists what the host adds. Anything else in these requests means the plan has gone stale.
    const plan = buildPlan(ROOT);
    assert.deepEqual([...new Set(turns.flatMap((rec) => (rec.body.tools ?? []).map((t) => t.function?.name ?? t.name)))], [plan.tool.name]);
    assert.equal(turns[0].body.tools[0].function.description, plan.tool.description);
    assert.deepEqual(turns[0].body.tools[0].function.parameters, plan.tool.parameters);
    const textOf = (m) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => p.text ?? '').join(''));
    let runtimeMessages = 0;
    for (const rec of turns) {
      for (const m of rec.body.messages) {
        const text = textOf(m);
        if (m.role === 'system') {
          assert.ok(text.startsWith('<!-- clo-policy:'), 'the system prompt is the planned one');
        } else if (text.startsWith(HOST_ADDED.runtimeContextPrefix)) {
          runtimeMessages += 1;
          for (const raw of [FAKE_KEY, QQ_SECRET_CANARY, 'Q5FAKEGROUP', 'Q5FAKEMEMBER', 'Q5FAKEOWNER']) assert.ok(!text.includes(raw), `${raw} in the runtime context`);
        } else {
          assert.ok(FIXED.turns.some((t) => text.includes(t)) || (m.role === 'assistant' && text.includes('四个季节')), `not in the plan: ${m.role} ${text.slice(0, 60)}`);
        }
      }
    }
    assert.ok(runtimeMessages >= 2, 'positive control: the runtime context is really there');

    const lines = resultsOf(root);
    const gatewayTurns = lines.filter((l) => l.kind === 'gateway_turn');
    assert.equal(gatewayTurns.length, 2);
    for (const t of gatewayTurns) {
      assert.equal(t.state, 'completed');
      assert.equal(t.posts, 1, 'the reply went to the mock QQ');
      assert.equal(t.modelCalls, 1);
      assert.equal(t.guardRequests, 1, 'the guard sees the same requests the mock does');
      assert.equal(t.refusedRequests, 0);
      assert.equal(t.hiddenCalls, 0);
      assert.equal(t.usageMissing, false);
      assert.equal(t.inputTokens, 3000, 'turn_usage reached the results');
      assert.equal(t.outputTokens, 40);
      assert.ok(t.actualUsd > 0);
      assert.ok(t.heldUsd > 0);
    }
    const lag = lines.find((l) => l.kind === 'lag');
    assert.equal(lag.timedOut, false);
    assert.ok(lag.matchedMs >= 0);
    assert.ok(lines.some((l) => l.kind === 'summary' && l.completed === true));
    assert.ok(lines.filter((l) => l.kind === 'suggestion').length >= 5);

    // No key, no QQ secret and no text, anywhere it wrote. .env itself is the positive control for the scan.
    const run = runRootOf(root);
    assert.ok(run, 'test mode keeps the temp root for this scan');
    const files = walk(root);
    assert.ok(files.length > 10);
    const contains = (needle) => files.filter((f) => readFileSync(f).includes(needle));
    assert.deepEqual(contains(FAKE_KEY).map((f) => f.slice(root.length)), [`${join('\\', '.env')}`], 'the key is only in .env');
    assert.deepEqual(contains(QQ_SECRET_CANARY).map((f) => f.slice(root.length)), [`${join('\\', '.env')}`], 'the real QQ secret never left .env');
    assert.ok(contains('PARENT-KEY-MUST-NOT-PASS').length === 0);
    // The prompts and answers do sit in the host's session store, inside the temp root. That is why it gets deleted.
    for (const needle of ['CANARYMODELTEXT', FIXED.turns[0]]) {
      const holders = contains(needle);
      assert.ok(holders.some((f) => f.includes('openclaw-agent.sqlite')), `positive control: ${needle} in the session store`);
      for (const f of holders) assert.ok(f.startsWith(run), `${needle} outside the temp root: ${f}`);
    }
    for (const text of [r.stdout, r.stderr]) {
      assert.ok(!text.includes(FAKE_KEY));
      assert.ok(!text.includes(QQ_SECRET_CANARY));
      assert.ok(!text.includes('CANARYMODELTEXT'));
    }
    const raw = readFileSync(join(root, 'captures', 'q5-results.jsonl'), 'utf8');
    for (const bad of ['CANARYMODELTEXT', FIXED.question, FIXED.turns[0], FAKE_KEY]) assert.ok(!raw.includes(bad), bad);

    // The Gateway saw only the temp root, the mock and the fake identity.
    const rendered = JSON.parse(readFileSync(join(run, '.runtime', 'state', 'openclaw.json'), 'utf8'));
    const ch = rendered.channels['clo-qq'];
    assert.match(ch.apiBaseUrl, /^http:\/\/127\.0\.0\.1:\d+/);
    assert.match(ch.tokenBaseUrl, /^http:\/\/127\.0\.0\.1:\d+/);
    assert.equal(ch.appId, FAKE_APP_ID);
    assert.ok(rendered.plugins.entries.clo.config.effectivePath.startsWith(run));
    const guardFile = join(run, '.runtime', 'logs', 'q5-net-guard.jsonl');
    const refused = existsSync(guardFile) ? readFileSync(guardFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).host) : [];
    assert.deepEqual(refused.filter((h) => h !== 'clawhub.ai'), [], 'only the known startup lookup was refused');
    assert.equal(lines.find((l) => l.kind === 'gateway').qqRouteAttempt, false);

    // Its own process, no secret on its command line, and gone at the end.
    assert.ok(cmdLine, 'saw the Gateway command line');
    assert.match(cmdLine, /q5-net-guard\.mjs/);
    assert.match(cmdLine, /host-output-filter\.mjs/);
    for (const secret of [FAKE_KEY, QQ_SECRET_CANARY]) assert.ok(!cmdLine.includes(secret), 'a secret on the command line');
    await until(() => processInfo(gatewayPid) === null, 'the Gateway to be gone', 15000);

    assert.equal(readFileSync(join(root, 'config.json'), 'utf8'), CONFIG_CANARY, 'config.json untouched');
    assert.deepEqual(projectStamps(), stamps, 'the project runtime was not touched');
  } finally {
    child.kill();
    await model.stop();
  }
});

test('a turn that costs more than planned stops the run before the next turn', { timeout: 300000 }, async () => {
  const root = makeRoot('cap');
  const model = await startMockOpenRouter();
  model.setKey({ limit: 1 });
  model.setDecision(() => ({ text: decisionText(), usage: { cost: 0.0002 } }));
  // At the locked price, 100k in and 100k out is $2.50, well past a turn's worst case.
  model.setScript((rec) => (quotaTurn(rec)
    ? { text: '四个。', usage: { prompt_tokens: 100000, completion_tokens: 100000, total_tokens: 200000 } }
    : { text: '四个。', usage: { cost: 0.002 } }));
  const worst = JSON.parse(JSON.stringify(await planWorstUsd()));
  const { child, done } = startProbe(root, model.base, { maxUsd: String(worst + 0.01) });
  try {
    const r = await done;
    assert.equal(r.status, 1, r.stdout.slice(-1500));
    assert.match(r.stdout, /Run stopped: cap/);
    assert.equal(model.requests.filter(quotaTurn).length, 1, 'the second turn never ran');
    const lines = resultsOf(root);
    assert.equal(lines.filter((l) => l.kind === 'gateway_turn').length, 1);
    assert.ok(lines.some((l) => l.kind === 'stop' && l.stopReason === 'cap'));
    assert.equal(lines.find((l) => l.kind === 'lag'), undefined, 'a stopped run does not wait on the Key');
  } finally {
    child.kill();
    await model.stop();
  }
});

test('a turn with no usage counts at the worst case and stops the run; it is never free', { timeout: 300000 }, async () => {
  const root = makeRoot('nousage');
  const model = await startMockOpenRouter();
  model.setDecision(() => ({ text: decisionText(), usage: { cost: 0.0002 } }));
  model.setScript((rec) => (quotaTurn(rec) ? { text: '四个。', usage: null } : { text: '四个。', usage: { cost: 0.002 } }));
  const { child, done } = startProbe(root, model.base);
  try {
    const r = await done;
    assert.equal(r.status, 1, r.stdout.slice(-1500));
    assert.match(r.stdout, /Run stopped: gateway_turn_failed/);
    assert.equal(model.requests.filter(quotaTurn).length, 1);
    const [turn] = resultsOf(root).filter((l) => l.kind === 'gateway_turn');
    assert.equal(turn.usageMissing, true);
    assert.equal(turn.countedUsd, turn.worstUsd);
    assert.equal(turn.paidPaused, 'usage_missing');
    assert.match(r.stdout, /Counted at worst case because usage was missing: \$0\.5640/);
    await sleep(0);
  } finally {
    child.kill();
    await model.stop();
  }
});

// Same run, without the command line, so a test can read the stage's own results and pick where the temp root goes.
async function direct(model, { plan = buildPlan(ROOT), maxUsd = 5 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'clo-q5e-direct-'));
  roots.push(dir);
  const said = [];
  const out = await runProbe({ plan, baseUrl: model.base, key: FAKE_KEY, maxUsd, resultPath: join(dir, 'r.jsonl'), say: (t) => said.push(t), testMode: true, parentEnv: cleanChildEnv(), tempParent: dir, repoRoot: ROOT, lagMs: 0 });
  const lines = readFileSync(join(dir, 'r.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { ...out, said: said.join('\n'), lines, dir, turnLines: lines.filter((l) => l.kind === 'gateway_turn'), leftover: readdirSync(dir).filter((n) => n.startsWith('clo-q5-')) };
}

function modelFor(script) {
  return startMockOpenRouter().then((model) => {
    model.setDecision(() => ({ text: decisionText(), usage: { cost: 0.0002 } }));
    let n = 0;
    model.setScript((rec) => {
      if (!quotaTurn(rec)) return { text: '四个。', usage: { cost: 0.002 } };
      n += 1;
      return script(n);
    });
    return model;
  });
}

const fine = { text: '四个。', usage: { prompt_tokens: 3000, completion_tokens: 40, total_tokens: 3040 } };
const worstOf = () => buildPlan(ROOT).totalWorstMicros / 1e6;

for (const [name, step] of [
  ['429s', () => ({ error: { status: 429, body: { error: { code: 429, message: 'slow down' } } } })],
  ['500s', () => ({ error: { status: 500, body: { error: { code: 500, message: 'boom' } } } })],
  ['mid-stream failures', () => ({ text: '四', usage: null, midStreamError: { code: 500, message: 'mid' } })],
]) {
  test(`${name}: the host retries, and its third request in the turn never leaves`, { timeout: 300000 }, async () => {
    const model = await modelFor(step);
    try {
      const r = await direct(model);
      assert.equal(r.stopReason, 'gateway_call_limit', r.said);
      assert.equal(model.requests.filter(quotaTurn).length, TURN_CALL_LIMIT, 'the mock received exactly the limit');
      const [turn] = r.turnLines;
      assert.equal(turn.guardRequests, TURN_CALL_LIMIT);
      assert.equal(turn.refusedRequests, 1);
      assert.equal(turn.countedUsd, turn.worstUsd, 'both attempts count at their worst');
      // Read after the hard kill, once the process has gone. The turn's real row has to come back, not 'timeout'.
      assert.equal(turn.state, 'dispatching');
      assert.ok(turn.heldUsd > 0, 'its hold was read too');
      assert.ok(r.totals.totalMicros / 1e6 <= worstOf(), `total ${r.totals.totalMicros} within the printed worst`);
      assert.deepEqual(r.leftover, [], 'the temp root went, even after this kill');
      const gateway = r.lines.find((l) => l.kind === 'gateway');
      assert.equal(gateway.qqRouteAttempt, false);
    } finally {
      await model.stop();
    }
  });
}

test('compaction: its requests count against the turn, so the limit holds and the spend is counted', { timeout: 300000 }, async () => {
  const model = await modelFor((n) => (n === 1 ? { text: '四个。', usage: { prompt_tokens: 23800, completion_tokens: 900, total_tokens: 24700 } } : fine));
  try {
    const r = await direct(model);
    const turns = model.requests.filter(quotaTurn);
    assert.ok(turns.some((rec) => JSON.stringify(rec.body.messages).includes(HOST_ADDED.compactionPrefix)), 'positive control: compaction did fire, with the prefix the plan prints');
    assert.equal(turns.length, 1 + TURN_CALL_LIMIT);
    assert.equal(r.stopReason, 'gateway_call_limit');
    assert.equal(r.turnLines[1].refusedRequests, 1);
    assert.equal(r.turnLines[1].countedUsd, r.turnLines[1].worstUsd, 'not the small reply figure');
  } finally {
    await model.stop();
  }
});

test('a failed attempt with no usage, then a success: the hidden call counts at its worst, and the run stops', { timeout: 300000 }, async () => {
  const model = await modelFor((n) => (n === 1 ? { text: '四', usage: null, midStreamError: { code: 500, message: 'mid' } } : fine));
  try {
    const r = await direct(model);
    const [turn] = r.turnLines;
    assert.equal(turn.state, 'completed');
    assert.equal(turn.modelCalls, 2);
    assert.equal(turn.modelCallErrors, 1);
    assert.equal(turn.hiddenCalls, 1);
    assert.equal(turn.usageMissing, true);
    assert.ok(turn.countedUsd > turn.actualUsd + 0.28, `counted ${turn.countedUsd}, settled ${turn.actualUsd}`);
    assert.equal(r.stopReason, 'gateway_turn_failed', 'a call error in the turn stops the run, even though it ended well');
    assert.match(r.said, /1 call\(s\) with no usage of their own/);
  } finally {
    await model.stop();
  }
});

test('a tool round: two good calls in a turn stay within the limit, count conservatively, and the run goes on', { timeout: 300000 }, async () => {
  const model = await modelFor((n) => (n === 1 ? { toolCall: { name: 'clo_feature_status', arguments: {} }, usage: { prompt_tokens: 300, completion_tokens: 10, total_tokens: 310 } } : fine));
  try {
    const r = await direct(model);
    assert.equal(r.stopReason, null, r.said);
    assert.equal(r.turnLines[0].modelCalls, 2);
    assert.equal(r.turnLines[0].hiddenCalls, 1);
    assert.equal(r.turnLines[1].hiddenCalls, 0);
    assert.ok(r.totals.totalMicros / 1e6 <= worstOf());
  } finally {
    await model.stop();
  }
});

test('the second layer: if the guard does not stop the host, the events do, and the Gateway is killed', { timeout: 300000 }, async () => {
  const model = await modelFor(() => ({ error: { status: 429, body: { error: { code: 429, message: 'slow' } } } }));
  try {
    const r = await direct(model, { plan: { ...buildPlan(ROOT), guardCallLimit: 99 } });
    assert.equal(r.stopReason, 'gateway_call_limit', r.said);
    assert.equal(r.turnLines[0].refusedRequests, 0, 'the guard let them through in this test');
    assert.ok(r.turnLines[0].modelCalls > TURN_CALL_LIMIT);
    assert.ok(model.requests.filter(quotaTurn).length <= TURN_CALL_LIMIT + 2, `${model.requests.filter(quotaTurn).length} requests`);
    assert.deepEqual(r.leftover, []);
  } finally {
    await model.stop();
  }
});

test('a clean two-turn run deletes its temp root, and the session store goes with it', { timeout: 300000 }, async () => {
  const model = await modelFor(() => fine);
  try {
    const r = await direct(model);
    assert.equal(r.stopReason, null, r.said);
    assert.equal(r.turnLines.length, 2);
    assert.deepEqual(r.leftover, []);
    assert.doesNotMatch(r.said, /Could not remove/);
  } finally {
    await model.stop();
  }
});

test('an interrupt during a turn ends the run and still deletes the temp root', { timeout: 300000 }, async () => {
  const model = await modelFor(() => fine);
  const dir = mkdtempSync(join(tmpdir(), 'clo-q5e-abort-'));
  roots.push(dir);
  const ac = new AbortController();
  const said = [];
  try {
    const watcher = setInterval(() => {
      if (model.requests.filter(quotaTurn).length >= 1) ac.abort();
    }, 100);
    const r = await runProbe({ plan: buildPlan(ROOT), baseUrl: model.base, key: FAKE_KEY, maxUsd: 5, resultPath: join(dir, 'r.jsonl'), say: (t) => said.push(t), testMode: true, parentEnv: cleanChildEnv(), tempParent: dir, repoRoot: ROOT, lagMs: 0, signal: ac.signal });
    clearInterval(watcher);
    assert.equal(r.stopReason, 'interrupted');
    assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('clo-q5-')), []);
    assert.ok(model.requests.filter(quotaTurn).length <= 1);
  } finally {
    await model.stop();
  }
});

test('positive control for the QQ stop: an attempt to reach QQ is refused, recorded, and stops the run', { timeout: 300000 }, async () => {
  const model = await modelFor(() => fine);
  const dir = mkdtempSync(join(tmpdir(), 'clo-q5e-qq-'));
  roots.push(dir);
  // Loaded after the guard. The lookup answers loopback, so even a broken guard sends nothing off this machine.
  const attempt = join(dir, 'attempt.mjs');
  writeFileSync(attempt, `
import net from 'node:net';
const lookup = (h, o, cb) => (o && o.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4));
const s = net.connect({ host: 'api.sgroup.qq.com', port: 9, lookup });
s.on('error', () => {});
`);
  const lines = [];
  try {
    const r = await runGatewayStage({ plan: buildPlan(ROOT), catalog: defaultCatalog(), baseUrl: model.base, key: FAKE_KEY, tracker: createSpendTracker(5e6), record: (l) => lines.push(l), say: () => {}, testMode: true, parentEnv: cleanChildEnv(), tempParent: dir, repoRoot: ROOT, testImports: [attempt] });
    assert.equal(r.stop, 'qq_route_attempt');
    const gateway = lines.find((l) => l.kind === 'gateway');
    assert.equal(gateway.qqRouteAttempt, true);
    assert.ok(gateway.refusedHosts.includes('api.sgroup.qq.com'), 'the guard log reached the results');
    assert.ok(gateway.refusedHosts.includes('clawhub.ai'), 'and so did the startup lookup');
  } finally {
    await model.stop();
  }
});

// For the host's own route, with nothing reaching OpenRouter. The plugin's start-up Key read gets a local answer, or it
// would pause paid calls before the model route is tried. The optional lookup answer lets a request get as far as being
// created. 6.0.0.1 looks public to the host's address check and is not routed anywhere, and the guard refuses the
// connection in any case, because it only allows a name that does not exist.
function nativeImport(dir, { answerLookup }) {
  const file = join(dir, 'native-import.mjs');
  writeFileSync(file, `
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
${answerLookup ? `
const realLookup = dns.lookup;
dns.lookup = function lookup(h, ...rest) {
  if (h !== 'openrouter.ai') return Reflect.apply(realLookup, this, [h, ...rest]);
  const cb = rest.at(-1);
  const o = typeof rest[0] === 'object' && rest[0] ? rest[0] : {};
  queueMicrotask(() => (o.all ? cb(null, [{ address: '6.0.0.1', family: 4 }]) : cb(null, '6.0.0.1', 4)));
  return {};
};
const realPromise = dns.promises.lookup;
dns.promises.lookup = async function lookup(h, ...rest) {
  if (h !== 'openrouter.ai') return Reflect.apply(realPromise, this, [h, ...rest]);
  const o = typeof rest[0] === 'object' && rest[0] ? rest[0] : {};
  return o.all ? [{ address: '6.0.0.1', family: 4 }] : { address: '6.0.0.1', family: 4 };
};
syncBuiltinESMExports();
` : ''}
const real = globalThis.fetch;
globalThis.fetch = (url, init) => (String(url).endsWith('/key')
  ? Promise.resolve(new Response(JSON.stringify({ data: { usage: 0, limit: 3.25, limit_remaining: 3.25, limit_reset: 'daily', usage_daily: 0 } }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  : real(url, init));
`);
  return file;
}

async function nativeStage(label, { answerLookup, plan = buildPlan(ROOT) }) {
  const dir = mkdtempSync(join(tmpdir(), `clo-q5e-${label}-`));
  roots.push(dir);
  const lines = [];
  // Not test mode, so no base URL is rendered and the host uses its own route to openrouter.ai.
  const r = await runGatewayStage({ plan, catalog: defaultCatalog(), baseUrl: 'https://openrouter.ai/api/v1', key: FAKE_KEY, tracker: createSpendTracker(5e6), record: (l) => lines.push(l), say: () => {}, testMode: false, parentEnv: cleanChildEnv(), tempParent: dir, repoRoot: ROOT, guardAllowedHost: 'model.invalid', testImports: [nativeImport(dir, { answerLookup })] });
  return { r, lines, turn: lines.find((l) => l.kind === 'gateway_turn'), gateway: lines.find((l) => l.kind === 'gateway'), leftover: readdirSync(dir).filter((n) => n.startsWith('clo-q5-')) };
}

test('the native route: the guard counts its real requests, and the third ends the Gateway before it connects', { timeout: 300000 }, async () => {
  const { r, lines, turn, gateway, leftover } = await nativeStage('native', { answerLookup: true });
  assert.equal(r.stop, 'gateway_call_limit', JSON.stringify(lines));
  assert.equal(turn.guardRequests, TURN_CALL_LIMIT, 'the guard saw this route, which is what the printed limit rests on');
  assert.equal(turn.refusedRequests, 1);
  assert.ok(gateway.refusedHosts.includes('openrouter.ai'), 'each connection was refused here');
  assert.deepEqual(leftover, []);
});

test('the native route with its lookups refused: no request exists to count, and the events still end the Gateway', { timeout: 300000 }, async () => {
  const { r, lines, turn, gateway, leftover } = await nativeStage('native-refused', { answerLookup: false });
  assert.equal(r.stop, 'gateway_call_limit', JSON.stringify(lines));
  assert.equal(turn.guardRequests, 0);
  assert.ok(turn.modelCalls > TURN_CALL_LIMIT, 'the second layer acted');
  assert.ok(gateway.refusedHosts.includes('openrouter.ai'));
  assert.deepEqual(leftover, []);
});

test('more host calls than the guard counted means the limit cannot be trusted, and the run stops saying so', { timeout: 420000 }, async () => {
  // A limit high enough that nothing is killed, on the route where the guard has nothing to count.
  const plan = { ...buildPlan(ROOT), turnCallLimit: 99, guardCallLimit: 99 };
  const { r, lines, turn } = await nativeStage('native-blind', { answerLookup: false, plan });
  assert.equal(r.stop, 'guard_missed_requests', JSON.stringify(lines));
  assert.equal(turn.guardRequests, 0);
  assert.ok(turn.modelCalls > 0);
});

async function planWorstUsd() {
  const { buildPlan } = await import('../../src/tools/q5-probe.mjs');
  return buildPlan(ROOT).totalWorstMicros / 1e6;
}
