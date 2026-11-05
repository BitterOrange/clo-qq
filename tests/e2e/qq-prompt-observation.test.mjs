// Observation, not a gate: writes what the model is shown to prompt.json in a fresh temp directory and prints the path.
// It is left there to read. It asserts only facts the build depends on.
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
  const file = join(mkdtempSync(join(tmpdir(), 'clo-prompt-observation-')), 'prompt.json');
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`prompt observation: ${file}`);
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
