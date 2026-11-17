// Runs test files one at a time, each in its own `node --test` with an environment built here from an allowlist, and
// prints one line per file and a total. Used by CI and usable by hand. Run it with the private Node:
//   .runtime/node/bin/node tests/run-files.mjs [options] <folder or file>...
// Options:
//   --shard K/N        only every N-th file of the sorted list, starting at the K-th (1-based)
//   --exclude FILE     leave this file out (repeatable)
//   --provider NAME    sets CLO_TEST_PROVIDER for the files (openrouter or anthropic)
//   --timeout SECONDS  per file, default 900
//   --out DIR          where the per-file TAP goes, default .runtime/test-results
// Exit code 0 only when at least one file ran and every file passed. No key, token or proxy reaches a test: the
// environment is built from the names below, never copied from the shell that started this.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IS_WINDOWS = process.platform === 'win32';

function fail(message) {
  console.error(message);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { shard: null, exclude: new Set(), provider: null, timeout: 900, out: join(ROOT, '.runtime', 'test-results'), paths: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) fail(`${a} needs a value`);
      i += 1;
      return argv[i];
    };
    if (a === '--shard') {
      const m = /^(\d+)\/(\d+)$/.exec(value());
      if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2])) fail('--shard takes K/N with 1 <= K <= N');
      opts.shard = { k: Number(m[1]), n: Number(m[2]) };
    } else if (a === '--exclude') opts.exclude.add(rel(value()));
    else if (a === '--provider') {
      opts.provider = value();
      if (!['openrouter', 'anthropic'].includes(opts.provider)) fail('--provider takes openrouter or anthropic');
    } else if (a === '--timeout') {
      opts.timeout = Number(value());
      if (!Number.isInteger(opts.timeout) || opts.timeout < 1) fail('--timeout takes whole seconds');
    } else if (a === '--out') opts.out = resolve(value());
    else if (a.startsWith('--')) fail(`Unknown option: ${a}`);
    else opts.paths.push(a);
  }
  if (opts.paths.length === 0) fail('Name at least one test folder or file.');
  return opts;
}

// A path as the project names it: relative to the root, with forward slashes.
function rel(p) {
  return relative(ROOT, resolve(ROOT, p)).replace(/\\/g, '/');
}

function testFiles(paths) {
  const out = new Set();
  for (const p of paths) {
    const abs = resolve(ROOT, p);
    if (!existsSync(abs)) fail(`Not found: ${p}`);
    if (statSync(abs).isDirectory()) {
      for (const name of readdirSync(abs)) {
        if (name.endsWith('.test.mjs')) out.add(rel(join(abs, name)));
      }
    } else out.add(rel(abs));
  }
  return [...out].sort();
}

// The environment each file gets. Off Windows: a PATH with the private Node first and the system folders the tests'
// own helpers use (bash, tar, sha256sum), plus HOME, TMPDIR and a UTF-8 locale. On Windows: the OS variables
// Node and powershell.exe need, and a PATH of the private Node, System32 and Windows PowerShell.
function childEnv(provider) {
  const env = {};
  const copy = (names) => {
    for (const k of names) {
      if (process.env[k]) env[k] = process.env[k];
    }
  };
  if (IS_WINDOWS) {
    copy(['SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'CommonProgramFiles']);
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    env.PATH = [join(ROOT, '.runtime', 'node'), join(systemRoot, 'System32'), systemRoot, join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(';');
  } else {
    copy(['HOME', 'TMPDIR']);
    env.PATH = [join(ROOT, '.runtime', 'node', 'bin'), '/usr/local/bin', '/usr/bin', '/bin'].join(':');
    env.LANG = 'C.UTF-8';
  }
  if (provider) env.CLO_TEST_PROVIDER = provider;
  return env;
}

// The totals node:test writes at the end of its TAP report.
function totals(tapFile) {
  const t = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
  if (!existsSync(tapFile)) return null;
  for (const line of readFileSync(tapFile, 'utf8').split(/\r?\n/)) {
    const m = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line);
    if (m) t[m[1]] = Number(m[2]);
  }
  return t;
}

const opts = parseArgs(process.argv.slice(2));
let files = testFiles(opts.paths).filter((f) => !opts.exclude.has(f));
if (opts.shard) files = files.filter((_, i) => i % opts.shard.n === opts.shard.k - 1);
if (files.length === 0) fail('No test files selected.');
mkdirSync(opts.out, { recursive: true });

const env = childEnv(opts.provider);
console.log(`Node ${process.version}, ${files.length} file(s)${opts.shard ? `, shard ${opts.shard.k}/${opts.shard.n}` : ''}${opts.provider ? `, CLO_TEST_PROVIDER=${opts.provider}` : ''}, temp ${tmpdir()}`);
const results = [];
for (const file of files) {
  const tap = join(opts.out, `${file.replace(/[\\/]/g, '__')}.tap`);
  const started = Date.now();
  console.log(`\n=== ${file}`);
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=tap', `--test-reporter-destination=${tap}`, file], {
    cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'], timeout: opts.timeout * 1000, killSignal: 'SIGKILL', windowsHide: true,
  });
  const seconds = Math.round((Date.now() - started) / 1000);
  const t = totals(tap);
  let verdict = 'ok';
  if (r.error?.code === 'ETIMEDOUT') verdict = `timed out after ${opts.timeout} s`;
  else if (r.error) verdict = `could not run: ${r.error.code ?? r.error.message}`;
  else if (r.status !== 0) verdict = `exit ${r.status ?? r.signal}`;
  else if (!t || t.tests === 0) verdict = 'no tests reported';
  else if (t.fail > 0 || t.cancelled > 0) verdict = 'failures reported';
  results.push({ file, seconds, t, verdict });
}

console.log('\n=== Summary');
for (const { file, seconds, t, verdict } of results) {
  const counts = t ? `${t.pass} pass, ${t.fail} fail, ${t.cancelled} cancelled, ${t.skipped} not run, ${t.todo} todo` : 'no report';
  console.log(`${verdict === 'ok' ? 'PASS' : 'FAIL'}  ${file}  ${seconds} s  ${counts}${verdict === 'ok' ? '' : `  (${verdict})`}`);
}
const bad = results.filter((r) => r.verdict !== 'ok');
console.log(`\n${results.length - bad.length}/${results.length} file(s) passed. TAP reports in ${opts.out}`);
process.exit(bad.length === 0 ? 0 : 1);
