// OpenRouter byte identity across the provider refactor. The goldens in tests/fixtures/provider-golden were written from
// the code before the provider layer and are pinned here by hash, so they cannot drift with the code they check.
// Stubbed fetch only. No network, no model, no QQ.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildRequest } from '../../src/clo-plugin/lib/core/decision.js';
import { createOpenRouterClient } from '../../src/clo-plugin/lib/core/openrouterChat.js';
import { buildTurnRequest, renderUserMessage } from '../../src/clo-plugin/lib/core/turn.js';
import { CLIENT_BODY, CLIENT_CASES, DECISION_CASES, DECISION_PROMPT, runClientCase, SECRET, SYSTEM, TURN_CASES } from '../fixtures/provider-golden/cases.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const DIR = join(ROOT, 'tests', 'fixtures', 'provider-golden');
// Over the parsed JSON, so a line-ending conversion on checkout does not matter but any changed value does.
const PINNED = {
  'turn-bodies.json': 'b200face2349092ef515bb4c81cbea557063d7e35fd1dad9fae04169a343982f',
  'decision-bodies.json': 'ead956b03496474a2b369a15fb6b9ddfd7516fa926843d4295bc91140cd3b3be',
  'client-results.json': '2f03cc925999fad47ca941cfc4de97ba0c975c707417e9bb1c3800b6ccbfbf39',
};
const raw = (name) => readFileSync(join(DIR, name), 'utf8');
const golden = (name) => JSON.parse(raw(name));
const canonicalHash = (name) => createHash('sha256').update(JSON.stringify(golden(name))).digest('hex');

test('the golden files are the pinned ones', () => {
  for (const [name, hash] of Object.entries(PINNED)) assert.equal(canonicalHash(name), hash, name);
  // Positive control: one changed value changes the hash.
  const t = golden('turn-bodies.json');
  t.plain = t.plain.replace('"max_tokens":3000', '"max_tokens":3001');
  assert.notEqual(createHash('sha256').update(JSON.stringify(t)).digest('hex'), PINNED['turn-bodies.json']);
});

test('every case has a golden and every golden a case', () => {
  assert.deepEqual(Object.keys(golden('turn-bodies.json')), Object.keys(TURN_CASES));
  assert.deepEqual(Object.keys(golden('decision-bodies.json')), Object.keys(DECISION_CASES));
  assert.deepEqual(Object.keys(golden('client-results.json')), Object.keys(CLIENT_CASES));
});

test('turn request bodies are byte-identical to the goldens', () => {
  const g = golden('turn-bodies.json');
  for (const [name, c] of Object.entries(TURN_CASES)) {
    assert.equal(JSON.stringify(buildTurnRequest(c.eff, SYSTEM, c.turn)), g[name], name);
  }
  // Positive control: the same fields in another key order are not the same bytes.
  const { model, stream, ...rest } = JSON.parse(g.plain);
  assert.notEqual(JSON.stringify({ stream, model, ...rest }), g.plain);
  assert.deepEqual({ stream, model, ...rest }, JSON.parse(g.plain));
});

test('decision request bodies are byte-identical to the goldens', () => {
  const g = golden('decision-bodies.json');
  for (const [name, c] of Object.entries(DECISION_CASES)) {
    assert.equal(JSON.stringify(buildRequest(c.eff, DECISION_PROMPT, c.args)), g[name], name);
  }
  // The clamped case really is clamped, so the golden pins the clamping too.
  const clamped = JSON.parse(JSON.parse(g.clamped).messages[1].content);
  assert.equal(clamped.lines.length, 15);
  assert.equal([...clamped.lines[0].text].length, 200);
  assert.ok([...clamped.current.text].length <= 800);
});

test('the client posts the built body unchanged', async () => {
  const g = golden('turn-bodies.json');
  const body = buildTurnRequest(TURN_CASES.crisis_history.eff, SYSTEM, TURN_CASES.crisis_history.turn);
  const r = await runClientCase(createOpenRouterClient, { ...CLIENT_CASES.ok, body });
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].body, g.crisis_history);
});

test('every client response shape gives the golden Result, calls and logs', async () => {
  const g = golden('client-results.json');
  for (const [name, c] of Object.entries(CLIENT_CASES)) {
    const got = await runClientCase(createOpenRouterClient, c);
    assert.deepStrictEqual(got, g[name], name);
  }
});

test('no provider text and no Key in any golden, though the responses carried the text', async () => {
  for (const name of Object.keys(PINNED)) {
    assert.equal(raw(name).includes(SECRET), false, name);
    assert.equal(raw(name).includes('GOLDEN-FAKE-KEY'), false, name);
  }
  // Positive control: the responses the client classified did carry the text, and the request did carry the Key.
  const res = await CLIENT_CASES.flagged_403.respond();
  assert.equal((await res.text()).includes(SECRET), true);
  let header = null;
  const c = createOpenRouterClient({ fetch: async (_u, init) => { header = init.headers.Authorization; return CLIENT_CASES.ok.respond(); }, getKey: () => 'GOLDEN-FAKE-KEY', getBaseUrl: () => 'http://127.0.0.1:9/api/v1' });
  await c.post(CLIENT_BODY);
  assert.equal(header, 'Bearer GOLDEN-FAKE-KEY');
});

// From the provider layer on: the OpenRouter adapter builds the same bytes. Skipped, visibly, until that file exists.
const ADAPTER = join(ROOT, 'src', 'clo-plugin', 'lib', 'core', 'providers', 'openrouterAdapter.js');
test('the OpenRouter adapter turnBody is byte-identical to the goldens', { skip: !existsSync(ADAPTER) && 'openrouterAdapter.js is not there yet' }, async () => {
  const { openrouterAdapter } = await import(pathToFileURL(ADAPTER).href);
  const g = golden('turn-bodies.json');
  for (const [name, c] of Object.entries(TURN_CASES)) {
    const { id: model, effort, maxTokens } = c.eff.models.primary;
    const body = openrouterAdapter.turnBody({ model, effort, maxTokens, system: SYSTEM, user: renderUserMessage(c.turn) });
    assert.equal(JSON.stringify(body), g[name], name);
    assert.equal(openrouterAdapter.systemTextOf(body), SYSTEM, `${name}: the system string is the one sent`);
  }
});
