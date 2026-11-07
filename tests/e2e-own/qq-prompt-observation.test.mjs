// The own runtime counterpart of tests/e2e/qq-prompt-observation.test.mjs. Observation, not a gate: writes what the
// model is shown to prompt.json in a fresh temp directory and prints the path. It asserts only the facts the build
// depends on: the request the bot builds is the whole of what the model sees, with no host text or tool in it.
// The wire shape is each provider's own; the facts asserted are the same on both.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fullAt, nextId } from '../fixtures/qq-events.mjs';
import { NEVER_SENT } from '../harness/model-view.mjs';
import { netAttempts, PROVIDER, startOwnStack, TEST_IDS } from '../harness/own.mjs';

const PRIMARY_ID = TEST_IDS.primary;

const sections = (text) => text.split('\n').filter((l) => /^#{1,4}\s/.test(l)).map((l) => l.trim());
const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');

let s;
let req;
let report;

before(async () => {
  s = await startOwnStack({ provider: PROVIDER, label: 'obs', script: () => ({ text: '观察回复。' }) });
  const id = nextId();
  s.send(fullAt('观察', { id }));
  await s.waitRow(id);
  req = s.agentRequests()[0];
  const v = s.view(req);
  const system = v.system;
  const user = v.user;
  report = {
    kind: s.kind,
    requestKeys: Object.keys(req.body).sort(),
    model: req.body.model,
    roles: req.body.messages.map((m) => m.role),
    tools: req.body.tools ?? null,
    sectionOrder: sections(system),
    systemChars: system.length,
    systemSha: sha(system),
    fileSha: s.systemPromptSha(),
    policyAt: system.indexOf('clo-policy:1'),
    cacheMarkers: v.cacheMarkers,
    userFrame: typeof user === 'string' ? user.split('\n')[0] : null,
    userKeys: typeof user === 'string' ? Object.keys(JSON.parse(user.slice(user.indexOf('\n') + 1))) : null,
    headers: Object.keys(req.headers).sort(),
    unexpectedNet: netAttempts(s),
  };
});

after(async () => {
  await s?.stop();
  s?.cleanup();
  if (report) {
    const file = join(mkdtempSync(join(tmpdir(), 'clo-prompt-observation-own-')), 'prompt.json');
    writeFileSync(file, JSON.stringify({ own: report }, null, 2));
    console.log(`prompt observation: ${file}`);
  }
});

// One body per provider kind, chosen by the stack's kind when the test runs.
const byKind = (bodies) => () => bodies[s.kind]();

test('the request keys are exactly the ones the runner builds, with the locked model and no tools', byKind({ anthropic: () => {
  assert.deepEqual(report.requestKeys, ['max_tokens', 'messages', 'model', 'output_config', 'system']);
  assert.equal(report.model, PRIMARY_ID);
  assert.equal(report.tools, null);
  for (const k of NEVER_SENT.anthropic) assert.equal(Object.hasOwn(req.body, k), false, `no ${k}`);
  assert.equal(req.body.thinking, undefined, 'Opus thinking is adaptive and not sent');
  assert.equal(req.body.max_tokens, s.eff.models.primary.maxTokens);
  assert.deepEqual(req.body.output_config, { effort: s.eff.models.primary.effort });
  assert.equal(req.headers['anthropic-version'], '2026-10-21');
  for (const h of ['authorization', 'anthropic-beta']) assert.equal(req.headers[h], undefined, `no ${h} header`);
}, openrouter: () => {
  assert.deepEqual(report.requestKeys, ['max_tokens', 'messages', 'model', 'provider', 'reasoning', 'stream', 'usage']);
  assert.equal(report.model, PRIMARY_ID);
  assert.equal(report.tools, null);
  assert.equal(req.body.stream, false);
  assert.deepEqual(req.body.provider, { require_parameters: true });
  assert.deepEqual(req.body.usage, { include: true });
  assert.equal(req.body.max_tokens, s.eff.models.primary.maxTokens);
  assert.deepEqual(req.body.reasoning, { effort: s.eff.models.primary.effort });
} }));

test('one system message, byte for byte the rendered file, then one user message; the policy block is in it', () => {
  // Anthropic carries the system text beside the messages, as one text block.
  assert.deepEqual(report.roles, s.kind === 'anthropic' ? ['user'] : ['system', 'user']);
  if (s.kind === 'anthropic') assert.equal(req.body.system.length, 1);
  assert.equal(report.systemSha, report.fileSha);
  assert.ok(report.policyAt >= 0);
  assert.ok(report.sectionOrder.length > 0, 'positive control: the section scan found headings');
  assert.deepEqual(report.sectionOrder.filter((h) => /Tooling|Runtime Context|OpenClaw|Skills|Heartbeat/i.test(h)), [], 'no host section');
});

test('exactly one cache marker, at the end of the system block', byKind({ anthropic: () => {
  assert.deepEqual(report.cacheMarkers, ['.system[0]']);
  assert.deepEqual(req.body.system[0].cache_control, { type: 'ephemeral' }, 'the default five-minute lifetime');
}, openrouter: () => {
  assert.deepEqual(report.cacheMarkers, ['.messages[0].content[0]']);
  assert.equal(req.body.messages[0].content.length, 1);
} }));

test('the user message is the frame line and the JSON the runner documents', () => {
  assert.match(report.userFrame, /^\[clo-turn class=at time=\d{4}-\d\d-\d\d \d\d:\d\d Asia\/Shanghai\]$/);
  assert.deepEqual(report.userKeys, ['recent', 'speaker', 'text']);
});

test('no network beyond the mocks', () => {
  assert.deepEqual(report.unexpectedNet, []);
});
