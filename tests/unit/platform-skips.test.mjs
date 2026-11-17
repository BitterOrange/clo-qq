// The skip inventory. A test that does not run somewhere is skipped in the open: every skip in tests/ is listed here
// with its condition, and one that is not listed fails this file until it is. Nothing here runs a skipped test.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { IS_WINDOWS, LINUX_ONLY, WINDOWS_ONLY } from '../harness/platform.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SELF = 'tests/unit/platform-skips.test.mjs';

function files(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files(p, out);
    else if (e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

const TITLE = /^\s*(?:test|describe|it)(?:\.skip)?\((['"`])((?:\\.|(?!\1).)*)\1/;
const OPTION = /\bskip: (.+?) \}, (?:async )?\(/;
const CALL = /\bt\.skip\((.*)\);/;

// Every skip in a text, as { title, when }: the test or describe it belongs to, and the condition or reason as written.
function skipsIn(text) {
  const lines = text.split(/\r?\n/);
  const found = [];
  lines.forEach((line, i) => {
    if (/^\s*\/\//.test(line) || !/\bskip\s*:|\.skip\(|\{\s*skip\s*[,}]/.test(line)) return;
    let at = i;
    while (at >= 0 && !TITLE.test(lines[at])) at -= 1;
    const title = at >= 0 ? TITLE.exec(lines[at])[2] : null;
    const when = (OPTION.exec(line) ?? CALL.exec(line))?.[1] ?? null;
    found.push({ title, when, line: i + 1 });
  });
  return found;
}

// Where each one is skipped:
// - WINDOWS_ONLY: everywhere but Windows. The test runs a .ps1 through powershell.exe.
// - WINDOWS_ENV_SHAPE: everywhere but Windows. It asserts the Windows shape of the clean environment; NOT_WINDOWS marks
//   its twins, which are skipped on Windows.
// - NOT_WINDOWS in entry-symlink.test.mjs: skipped on Windows, where a folder symlink needs admin rights and the
//   console keeps its own entry check.
// - NOT_WINDOWS in private-modes.test.mjs and qq-send-probe.test.mjs: skipped on Windows, which has no mode bits; its
//   writes are unchanged.
// - NOT_WINDOWS in env-proxy.test.mjs: skipped on Windows, where the console keeps its earlier behaviour and never
//   refuses for Node's env proxy.
// - LINUX_ONLY: everywhere but Linux. The test reads /proc, or runs a .sh through bash (the Linux install and the
//   console wrappers, whose start and stop look processes up in /proc).
// - t.skip(...): at run time, only when the machine cannot show the case (the reason is the text).
// - OPENROUTER_ONLY, ANTHROPIC_ONLY, PROVIDER: by the provider the run was started for, on every platform.
// - existsSync(...), seam: only while a file the test needs is not on disk.
const INVENTORY = [
  ['tests/e2e-own/provider-refusal.test.mjs', 'one refusal does not stop the next member; three in a row pause paid work', "PROVIDER === 'anthropic' && 'an Anthropic refusal carries usage: see the next test'"],
  ['tests/e2e-own/provider-refusal.test.mjs', 'stop_reason refusal on Anthropic: settled from tokens, and refusals in a row do not pause; errors in a row do', "PROVIDER !== 'anthropic' && 'runs with CLO_TEST_PROVIDER=anthropic'"],
  ['tests/e2e-own/qq-model-live.test.mjs', 'refresh refuses clearly when the alias row is missing, and locks nothing', 'OPENROUTER_ONLY'],
  ['tests/e2e-own/qq-model-live.test.mjs', 'refresh refuses clearly when the alias row differs in price', 'OPENROUTER_ONLY'],
  ['tests/e2e-own/qq-model-live.test.mjs', 'refresh refuses clearly when the alias row differs in reasoning', 'OPENROUTER_ONLY'],
  ['tests/e2e-own/qq-model-live.test.mjs', 'with no lock, mode live is refused and names the models', 'OPENROUTER_ONLY'],
  ['tests/e2e-own/qq-model-live.test.mjs', 'dry-run start with no lock runs the own bot, then refresh on the default catalog locks the concrete model', 'OPENROUTER_ONLY'],
  ['tests/e2e-own/qq-model-live.test.mjs', 'live preconditions, in README order, then a real @ gets a reply from the locked model', 'OPENROUTER_ONLY'],
  ['tests/e2e-own/qq-model-live.test.mjs', 'a later catalog with no alias refuses a refresh, keeps the lock and stays live', 'OPENROUTER_ONLY'],
  ['tests/e2e-own/qq-model-live.test.mjs', 'anthropic: with no lock and no hard-cap ack, mode live is refused and names both', 'ANTHROPIC_ONLY'],
  ['tests/e2e-own/qq-model-live.test.mjs', 'anthropic: the lock comes from the price book with no network, and the hard cap is attested while stopped', 'ANTHROPIC_ONLY'],
  ['tests/e2e-own/qq-model-live.test.mjs', 'anthropic: dry-run start runs the own bot, then live is refused by provider_rules, the Key unchecked, until the rule rows land', 'ANTHROPIC_ONLY'],
  ['tests/e2e-own/qq-unsettled-clear.test.mjs', 'usage missing pauses paid work, then the next clean Key read settles at zero and resumes it', 'OPENROUTER_ONLY'],
  ['tests/e2e-own/qq-unsettled-clear.test.mjs', 'anthropic: usage missing pauses paid work and stays counted at its hold past a tick, until accept-unsettled', 'ANTHROPIC_ONLY'],
  ['tests/unit/cli-mode.test.mjs', 'mode dry-run does not claim to have stopped when the effective file cannot be written', "t.skip('this user can write into a read-only folder, so the write cannot be made to fail')"],
  ['tests/unit/cli-mode.test.mjs', 'a Gateway whose command line the OS withholds: stop and start say to use the shell that started it', "t.skip('no process here withholds what it is from this user')"],
  ['tests/unit/doc-status.test.mjs', 'public docs hold none of the local private terms', "!existsSync(PRIVATE_TERMS) && 'no local list'"],
  ['tests/unit/entry-symlink.test.mjs', 'called through a symlink', 'NOT_WINDOWS'],
  ['tests/unit/env-proxy.test.mjs', 'the console run directly with NODE_USE_ENV_PROXY=1', 'NOT_WINDOWS'],
  ['tests/unit/lease-alive.test.mjs', 'an exited process nobody collected is not alive, though signal 0 still reaches it', 'LINUX_ONLY'],
  ['tests/unit/lease-alive.test.mjs', 'a PID with no process is not alive, and a running one that is not ours is', 'LINUX_ONLY'],
  ['tests/unit/lifecycle.test.mjs', 'the PowerShell wrappers carry output and exit codes, with a temp root that has spaces', 'WINDOWS_ONLY'],
  ['tests/unit/lifecycle.test.mjs', 'start.ps1 returns promptly and leaves the Gateway up after PowerShell exits; stop.ps1 ends it', 'WINDOWS_ONLY'],
  ['tests/unit/lifecycle.test.mjs', '_env.ps1 clears proxy variables and moves only project state in test mode', 'WINDOWS_ONLY'],
  ['tests/unit/lifecycle.test.mjs', 'the scripts work from a folder whose path has spaces', 'WINDOWS_ONLY'],
  ['tests/unit/lifecycle.test.mjs', 'the bash wrappers carry output and exit codes, with a temp root that has spaces', 'LINUX_ONLY'],
  ['tests/unit/lifecycle.test.mjs', 'clo.sh start returns promptly and leaves the Gateway up after bash exits; stop.sh ends it', 'LINUX_ONLY'],
  ['tests/unit/lifecycle.test.mjs', '_env.sh clears proxy variables and moves only project state in test mode', 'LINUX_ONLY'],
  ['tests/unit/lifecycle.test.mjs', 'the bash scripts work from a folder whose path has spaces, called by any path', 'LINUX_ONLY'],
  ['tests/unit/lifecycle.test.mjs', 'a process whose command line the OS withholds is unknown: the record stays and nothing is signalled', "t.skip('no process here withholds what it is from this user')"],
  ['tests/unit/platform-linux.test.mjs', 'lookup against a /proc built for the test', 'LINUX_ONLY'],
  ['tests/unit/platform-linux.test.mjs', 'live processes: identity, and ending only what was started', 'LINUX_ONLY'],
  ['tests/unit/setup-sh.test.mjs', 'setup.sh removes a tarball whose checksum differs and installs nothing; one that matches is installed', 'LINUX_ONLY'],
  ['tests/unit/setup-sh.test.mjs', 'setup.sh is repeatable, and --runtime installs the host packages from runtime-lock', 'LINUX_ONLY'],
  ['tests/unit/setup-sh.test.mjs', 'setup.sh stops when an installed lockfile entry differs from versions.lock.json', 'LINUX_ONLY'],
  ['tests/unit/setup-sh.test.mjs', 'setup.sh refuses a malformed or inconsistent Node entry before any download', 'LINUX_ONLY'],
  ['tests/unit/setup-sh.test.mjs', 'setup.sh verifies the Node it extracted against what the JSON entry says', 'LINUX_ONLY'],
  ['tests/unit/setup-sh.test.mjs', 'setup.sh creates a missing .env and config.json owner-only, and never touches existing ones', 'LINUX_ONLY'],
  ['tests/unit/private-modes.test.mjs', 'owner-only modes off Windows', 'NOT_WINDOWS'],
  ['tests/unit/qq-send-probe.test.mjs', 'an existing wider result file is narrowed to 0600 off Windows, and keeps its earlier lines', 'NOT_WINDOWS'],
  ['tests/unit/provider-golden.test.mjs', 'the OpenRouter adapter turnBody is byte-identical to the goldens', "!existsSync(ADAPTER) && 'openrouterAdapter.js is not there yet'"],
  ['tests/unit/q5-anthropic.test.mjs', 'the wrapper is ASCII with LF, uses the private Node, and carries output and exit codes', 'WINDOWS_ONLY'],
  ['tests/unit/q5-probe.test.mjs', 'the wrapper is ASCII, uses the private Node, and carries output and exit codes', 'WINDOWS_ONLY'],
  ['tests/unit/q5-probe.test.mjs', 'the wrapper passes -Runtime through, and refuses a runtime it does not know', 'WINDOWS_ONLY'],
  ['tests/unit/qq-redaction.test.mjs', 'seam run: real gate, store, ledger, policy and exit leave no canary at rest', "seam ? false : 'lib/core/gate.js or the contract exit.js is not on disk yet'"],
  ['tests/unit/test-spawn-env.test.mjs', 'the clean environment drops provider keys, QQ secrets and proxies from a hostile parent, and keeps the OS parts', 'WINDOWS_ENV_SHAPE'],
  ['tests/unit/test-spawn-env.test.mjs', 'off Windows the OS-tool environment takes no key, proxy or loader setting from a hostile parent', 'NOT_WINDOWS'],
  ['tests/unit/test-spawn-env.test.mjs', 'off Windows the clean environment drops keys, proxies and loader settings, and its PATH is the private Node folder only', 'NOT_WINDOWS'],
];
const row = ([file, title, when]) => `${file} | ${title} | ${when}`;

function scan() {
  const out = [];
  for (const f of files(join(ROOT, 'tests')).sort()) {
    const rel = relative(ROOT, f).replace(/\\/g, '/');
    if (rel === SELF) continue;
    for (const s of skipsIn(readFileSync(f, 'utf8'))) out.push({ file: rel, ...s });
  }
  return out;
}

test('the scanner sees each way a skip can be written, and nothing in a plain test', () => {
  const sample = [
    "test('one', { timeout: 5, skip: WINDOWS_ONLY }, async () => {",
    '});',
    "describe('two', { skip: LINUX_ONLY }, () => {",
    "  test('three', async (t) => {",
    "    if (x === null) return t.skip('nothing to look at');",
    '  });',
    '});',
    "test.skip('four', () => {});",
    "test('five', { skip }, () => {});",
    "// a comment about `{ skip }` and skip: is not a skip",
    "test('six: a skip decision', { timeout: 5 }, () => { decisionOf({ action: 'skip', skipClass: 'none' }); });",
  ].join('\n');
  assert.deepEqual(skipsIn(sample).map((s) => [s.title, s.when]), [
    ['one', 'WINDOWS_ONLY'],
    ['two', 'LINUX_ONLY'],
    ['three', "'nothing to look at'"],
    ['four', null],
    ['five', null],
  ]);
});

test('every skip in tests/ is in the inventory, with its test and its condition', () => {
  const found = scan();
  assert.ok(found.length > 0, 'positive control: the scan found skips');
  for (const s of found) assert.ok(s.title && s.when, `${s.file}:${s.line} has a skip this scan cannot read: write it on the test's own line, or as t.skip('reason')`);
  const seen = found.map((s) => row([s.file, s.title, /^'/.test(s.when) ? `t.skip(${s.when})` : s.when])).sort();
  assert.deepEqual(seen, INVENTORY.map(row).sort());
});

test('the platform skips are the ones counted: seven PowerShell wrapper tests, the /proc tests and nine bash script tests', () => {
  const count = (when) => INVENTORY.filter((r) => r[2] === when).length;
  assert.equal(count('WINDOWS_ONLY'), 7);
  assert.equal(count('LINUX_ONLY'), 14);
  assert.equal(count('WINDOWS_ENV_SHAPE'), 1);
  // Two in test-spawn-env, the symlink group in entry-symlink, the owner-only modes group in private-modes, the
  // direct-launch group in env-proxy, the result-file mode test in qq-send-probe.
  assert.equal(count('NOT_WINDOWS'), 6);
});

test('on its own platform a platform skip is off, and elsewhere it gives a reason', () => {
  if (IS_WINDOWS) {
    assert.equal(WINDOWS_ONLY, false);
    assert.equal(LINUX_ONLY, 'Linux only: reads /proc');
    return;
  }
  assert.equal(WINDOWS_ONLY, 'Windows only: runs a .ps1 through powershell.exe');
  assert.equal(LINUX_ONLY, process.platform === 'linux' ? false : 'Linux only: reads /proc');
});
