// Observation, not a gate: prints what the model is shown, as JSON. It asserts only facts the build depends on.
// Nothing is left on disk by default; with CLO_KEEP_PROMPT_OBSERVATION=1 the JSON also goes to prompt.json in a fresh
// clo-prompt-observation-* temp folder, whose path is printed and which is left there to read (delete it by hand).
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fullAt, nextId, push } from '../fixtures/qq-events.mjs';
import { startStack, unexpectedNetAttempts } from '../harness/gateway.mjs';

const report = {};

const sections = (text) => text.split('\n').filter((l) => /^#{1,4}\s/.test(l)).map((l) => l.trim());

async function observe(label, options) {
  const s = await startStack({ label: 'obs', script: () => ({ text: '观察回复。' }), ...options });
  try {
    await s.waitConnected();
    const id = nextId();
    push(s, fullAt('观察', { id }));
    await s.waitRow(id);
    const req = s.model.agentRequests()[0];
    assert.ok(req, 'the model was called');
    const system = req.body.messages.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    const out = {
      tools: (req.body.tools ?? []).map((t) => t.function?.name ?? t.name),
      sectionOrder: sections(system),
      systemChars: system.length,
      policyAt: system.indexOf('clo-policy:1'),
      nonSystemRoles: req.body.messages.filter((m) => m.role !== 'system').map((m) => m.role),
      requestKeys: Object.keys(req.body),
      unexpectedNet: unexpectedNetAttempts(s.gw),
    };
    report[label] = out;
    return out;
  } finally {
    await s.stop();
    s.cleanup();
  }
}

after(() => {
  const json = JSON.stringify(report, null, 2);
  console.log(`prompt observation:\n${json}`);
  if (process.env.CLO_KEEP_PROMPT_OBSERVATION === '1') {
    const file = join(mkdtempSync(join(tmpdir(), 'clo-prompt-observation-')), 'prompt.json');
    writeFileSync(file, json);
    console.log(`prompt observation kept: ${file}`);
  }
});

test('replacement prompt: the policy block leads and the tool list is exact', async () => {
  const o = await observe('replacement');
  assert.deepEqual(o.tools, ['clo_feature_status']);
  assert.ok(o.policyAt >= 0);
  assert.deepEqual(o.unexpectedNet, []);
});

test('host prompt with skipBootstrap: AGENTS.md stays in, after the host text', async () => {
  const o = await observe('hostFallback', { effective: { privacy: { replaceSystemPrompt: false } } });
  assert.ok(o.policyAt > 0, 'host text comes first');
  assert.deepEqual(o.unexpectedNet, []);
});
