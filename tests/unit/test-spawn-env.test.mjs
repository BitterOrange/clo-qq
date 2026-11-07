// Every child a test starts gets an explicit environment, so a provider key in the shell cannot reach it.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { osToolEnv } from '../../src/cli/lifecycle.mjs';
import { cleanChildEnv } from '../harness/clean-env.mjs';
import { ROOT } from './_cli-helper.mjs';

function files(dir, out = [], ext = /\.mjs$/) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out, ext);
    else if (ext.test(name)) out.push(p);
  }
  return out;
}

// The text of each spawn or spawnSync call, as far as its closing parenthesis. Strings are skipped while counting.
export function spawnCalls(src) {
  const calls = [];
  for (const m of src.matchAll(/\b(spawn|spawnSync)\(/g)) {
    let depth = 1;
    let quote = null;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i += 1) {
      const ch = src[i];
      if (quote) {
        if (ch === '\\') i += 1;
        else if (ch === quote) quote = null;
      } else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
      else if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
    }
    calls.push(src.slice(m.index, i));
  }
  return calls;
}

test('positive control: the scan tells the two shapes apart', () => {
  const [good, bad] = spawnCalls("spawn(NODE, ['-e', 'x()'], { env: e });\nspawnSync('tasklist', ['(a)'], { windowsHide: true });");
  assert.match(good, /\benv\b/);
  assert.doesNotMatch(bad, /\benv\b/);
});

// A call names an environment, and it is not simply the parent's handed on.
// `env` has to be an option. A call like spawnSync(systemExe(env, 'x'), [], {}) names the word and still inherits.
export const inheritsParent = (call) => !/[{,]\s*env\s*(:|,|})/.test(call) || /\benv\s*:\s*process\.env\b/.test(call) || /\.\.\.\s*process\.env\b/.test(call);

test('positive control: the check catches a missing environment and the parent passed on by name', () => {
  for (const bad of ["spawn(a, [], { stdio: 'pipe' })", 'spawn(a, [], { env: process.env })', 'spawnSync(a, [], { env : process.env, x: 1 })', 'spawn(a, [], { env: { ...process.env, X: 1 } })', "spawnSync(systemExe(env, 'taskkill.exe'), ['/F'], { windowsHide: true })"]) {
    assert.equal(inheritsParent(bad), true, bad);
  }
  for (const good of ['spawn(a, [], { env: cleanChildEnv() })', 'spawn(a, [], { env })', 'spawnSync(a, [], { env: { SystemRoot: process.env.SystemRoot } })', 'spawn(a, [], { env: osToolEnv(env) })', "spawnSync(systemExe(env, 'x'), [], { windowsHide: true, env })", 'spawn(a, [], {\n  cwd,\n  env,\n  stdio })']) {
    assert.equal(inheritsParent(good), false, good);
  }
});

function inherited(dir, ext) {
  const found = [];
  let seen = 0;
  for (const file of files(dir, [], ext)) {
    if (file.endsWith('test-spawn-env.test.mjs')) continue;
    for (const call of spawnCalls(readFileSync(file, 'utf8'))) {
      seen += 1;
      if (inheritsParent(call)) found.push(`${relative(ROOT, file)}: ${call.slice(0, 80)}`);
    }
  }
  return { found, seen };
}

test('no spawn in the tests inherits the parent environment', () => {
  const { found, seen } = inherited(join(ROOT, 'tests'));
  assert.ok(seen >= 15, `positive control: the scan found the spawns (${seen})`);
  assert.deepEqual(found, []);
});

test('no spawn in src inherits it either, so the console and the probe hold to the same rule', () => {
  const { found, seen } = inherited(join(ROOT, 'src'), /\.(mjs|js)$/);
  assert.ok(seen >= 4, `positive control: the scan found the spawns (${seen})`);
  assert.deepEqual(found, []);
});

test('the OS tools get only what they need from a hostile parent', () => {
  const env = osToolEnv({ SystemRoot: 'C:\\W', TEMP: 'C:\\T', PSModulePath: 'C:\\M', OPENROUTER_API_KEY: 'x', CLO_QQ_APP_SECRET: 'x', HTTP_PROXY: 'x', NODE_OPTIONS: 'x', ANTHROPIC_API_KEY: 'x', CLO_ANTHROPIC_API_KEY: 'x', CLO_PROVIDER_API_KEY: 'x', CLO_TEST_ANTHROPIC_API_KEY: 'x' });
  assert.deepEqual(env, { SystemRoot: 'C:\\W', PSModulePath: 'C:\\M', TEMP: 'C:\\T' });
});

test('the clean environment drops provider keys, QQ secrets and proxies from a hostile parent, and keeps the OS parts', () => {
  const parent = {
    SystemRoot: 'C:\\W', TEMP: 'C:\\T', OPENROUTER_API_KEY: 'x', PERPLEXITY_API_KEY: 'x', CLO_QQ_APP_SECRET: 'x', HTTP_PROXY: 'x', https_proxy: 'x', NODE_OPTIONS: 'x', CLO_TEST_ROOT: 'x',
    ANTHROPIC_API_KEY: 'x', CLO_ANTHROPIC_API_KEY: 'x', CLO_PROVIDER_API_KEY: 'x', CLO_TEST_ANTHROPIC_API_KEY: 'x',
  };
  const env = cleanChildEnv({ EXTRA: '1' }, parent);
  for (const k of ['OPENROUTER_API_KEY', 'PERPLEXITY_API_KEY', 'CLO_QQ_APP_SECRET', 'HTTP_PROXY', 'https_proxy', 'NODE_OPTIONS', 'CLO_TEST_ROOT', 'ANTHROPIC_API_KEY', 'CLO_ANTHROPIC_API_KEY', 'CLO_PROVIDER_API_KEY', 'CLO_TEST_ANTHROPIC_API_KEY']) assert.equal(env[k], undefined, k);
  assert.equal(env.SystemRoot, 'C:\\W');
  assert.equal(env.TEMP, 'C:\\T');
  assert.equal(env.EXTRA, '1');
  assert.match(env.PATH, /System32/);
  assert.doesNotMatch(env.PATH, /nodejs/i, 'the system Node is not on PATH');
});
