// Runs the filter in a real child, the way the Gateway loads it, since it patches process streams.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { shouldWithhold } from '../../src/cli/host-output-filter.mjs';
import { cleanChildEnv } from '../harness/clean-env.mjs';
import { NODE, ROOT } from './_cli-helper.mjs';

const FILTER = pathToFileURL(join(ROOT, 'src', 'cli', 'host-output-filter.mjs')).href;

function run(script) {
  return spawnSync(NODE, [`--import=${FILTER}`, '-e', script], { cwd: tmpdir(), env: cleanChildEnv(), encoding: 'utf8', windowsHide: true, timeout: 30000 });
}

test('a host failure line goes, whole, including lines a provider put inside it', () => {
  const r = run(`console.error('Embedded agent failed before reply: LLM request rejected: CANARY1\\nCANARY2 on its own line'); console.error('ordinary startup error'); console.log('ordinary out');`);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stderr.includes('CANARY'));
  assert.match(r.stderr, /ordinary startup error/, 'positive control: other lines are kept');
  assert.match(r.stderr, /\[clo\] a host error line was withheld/);
  assert.match(r.stdout, /ordinary out/);
});

test('stdout is covered too, and a Buffer or a callback write still works', () => {
  const r = run(`console.log('lane task error: lane=x error="CANARY"'); process.stderr.write(Buffer.from('flagged_input CANARY\\n'), () => process.stderr.write('after callback\\n'));`);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('CANARY'));
  assert.ok(!r.stderr.includes('CANARY'));
  assert.match(r.stderr, /after callback/);
});

test('the patterns: every host line seen to carry provider text', () => {
  for (const line of ['Embedded agent failed before reply: x', 'lane task error: lane=a', 'Auto-compaction failed (x)', 'Live model switch failed after 3', 'LLM request rejected: x', 'x flagged_input y']) {
    assert.equal(shouldWithhold(line), true, line);
  }
  assert.equal(shouldWithhold('gateway listening'), false);
  assert.equal(shouldWithhold(Buffer.from('LLM request failed')), true);
});
