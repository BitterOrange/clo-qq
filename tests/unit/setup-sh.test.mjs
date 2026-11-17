// Plan: the Linux install. versions.lock.json carries a Linux x64 Node entry beside the Windows one, and setup.sh
// installs only what that entry names. setup.sh runs here against a copy of the repo with a stand-in tarball, a
// stand-in node and no curl on PATH, so nothing is downloaded and npm never runs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LINUX_ONLY, NODE } from '../harness/platform.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCK = JSON.parse(readFileSync(join(ROOT, 'versions.lock.json'), 'utf8').replace(/^﻿/, ''));
const NAME = 'node-v24.22.2-linux-x64';
const bases = [];
after(() => bases.forEach((b) => rmSync(b, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })));

test('versions.lock.json has a well-formed Linux x64 Node entry, and the Windows entry is as it was', () => {
  const l = LOCK.nodeLinuxX64;
  assert.deepEqual(Object.keys(l).sort(), ['file', 'sha256', 'url', 'version']);
  assert.equal(l.version, LOCK.node.version, 'one Node version on every platform');
  assert.equal(l.version, '24.22.2');
  assert.equal(l.file, `node-v${l.version}-linux-x64.tar.xz`);
  assert.equal(l.url, `https://nodejs.org/dist/v${l.version}/${l.file}`);
  assert.match(l.sha256, /^[0-9a-f]{64}$/);
  assert.equal(l.sha256, '48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75');
  // Windows code reads the `node` entry: it keeps its keys and values.
  assert.deepEqual(LOCK.node, {
    version: '24.22.2',
    file: 'node-v24.22.2-win-x64.zip',
    url: 'https://nodejs.org/dist/v24.22.2/node-v24.22.2-win-x64.zip',
    sha256: 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2',
  });
  // setup.sh reads the entry line by line before any Node exists, so it must keep the shape JSON.stringify gives.
  // A Windows checkout may hold it with CRLF; a Linux one has LF.
  const text = readFileSync(join(ROOT, 'versions.lock.json'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(text.includes(`  "nodeLinuxX64": {\n    "version": "${l.version}",\n    "file": "${l.file}",\n    "url": "${l.url}",\n    "sha256": "${l.sha256}"\n  },\n`));
});

// A PATH holding only the tools setup.sh uses. No curl: a run that reached the download could not fetch anything.
function toolDir(base) {
  const bin = join(base, 'bin');
  mkdirSync(bin);
  for (const t of ['sed', 'wc', 'uname', 'sha256sum', 'tar', 'xz', 'mkdir', 'rm', 'mv', 'cp']) {
    const at = ['/usr/bin', '/bin'].map((d) => join(d, t)).find((p) => existsSync(p));
    assert.ok(at, `${t} is on this machine`);
    symlinkSync(at, join(bin, t));
  }
  assert.equal(existsSync(join(bin, 'curl')), false);
  return bin;
}

// A copy of the repo with the scripts and lock files, a stand-in Node tarball and a lock entry naming its checksum.
// The stand-in node answers --version, hands -e scripts to the real private Node, and logs anything else (npm).
function fakeRepo(label, { sha } = {}) {
  const base = mkdtempSync(join(tmpdir(), `clo-setup-${label}-`));
  bases.push(base);
  const repo = join(base, 'my repo (copy)');
  const state = join(base, 'state root');
  for (const d of ['scripts', 'runtime-lock', join(state, '.runtime'), join(base, 'pack', NAME, 'bin')]) mkdirSync(join(d.startsWith(base) ? '' : repo, d), { recursive: true });
  for (const f of ['_env.sh', 'setup.sh']) cpSync(join(ROOT, 'scripts', f), join(repo, 'scripts', f));
  for (const f of ['.env.example', 'config.example.json']) cpSync(join(ROOT, f), join(repo, f));
  cpSync(join(ROOT, 'package-lock.json'), join(repo, 'package-lock.json'));
  for (const f of ['package.json', 'package-lock.json']) cpSync(join(ROOT, 'runtime-lock', f), join(repo, 'runtime-lock', f));
  const node = join(base, 'pack', NAME, 'bin', 'node');
  writeFileSync(node, '#!/bin/bash\ncase "$1" in\n  --version) echo v24.22.2 ;;\n  -e) exec "$FAKE_REAL_NODE" "$@" ;;\n  *) printf \'%s\\n\' "$*" >> "$FAKE_NODE_LOG" ;;\nesac\n');
  chmodSync(node, 0o755);
  const tarball = join(base, `${NAME}.tar.xz`);
  // tar -J runs xz, so tar gets the same PATH setup.sh gets and nothing else from this process.
  const bin = toolDir(base);
  const packed = spawnSync('tar', ['-cJf', tarball, '-C', join(base, 'pack'), NAME], { env: { PATH: bin }, encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const real = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  const lock = structuredClone(LOCK);
  lock.nodeLinuxX64.sha256 = sha ?? real;
  writeFileSync(join(repo, 'versions.lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  const log = join(base, 'npm.log');
  const env = { PATH: bin, CLO_TEST_ROOT: state, FAKE_REAL_NODE: NODE, FAKE_NODE_LOG: log, HTTPS_PROXY: 'http://127.0.0.1:1' };
  const placeTarball = () => cpSync(tarball, join(state, '.runtime', `${NAME}.tar.xz`));
  const run = (args = []) => spawnSync('/bin/bash', [join(repo, 'scripts', 'setup.sh'), ...args], { env, encoding: 'utf8', timeout: 60000, cwd: tmpdir() });
  const npmCalls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  return { repo, state, run, placeTarball, npmCalls, real, lockFile: join(repo, 'versions.lock.json') };
}

const installedNode = (r) => join(r.repo, '.runtime', 'node', 'bin', 'node');
const parked = (r) => join(r.state, '.runtime', `${NAME}.tar.xz`);

test('setup.sh removes a tarball whose checksum differs and installs nothing; one that matches is installed', { timeout: 120000, skip: LINUX_ONLY }, () => {
  const bad = fakeRepo('mismatch', { sha: 'a'.repeat(64) });
  bad.placeTarball();
  const res = bad.run();
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stderr, /checksum mismatch: got [0-9a-f]{64}\. The file was removed/);
  assert.equal(existsSync(parked(bad)), false, 'the tarball is gone');
  assert.equal(existsSync(installedNode(bad)), false, 'no Node was installed');
  assert.deepEqual(bad.npmCalls(), [], 'npm never ran');

  // Positive control: the same tarball with its own checksum goes in, and the root install runs from the lockfile.
  const good = fakeRepo('match');
  good.placeTarball();
  const ok = good.run();
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /Private Node: v24\.22\.2/);
  assert.match(ok.stdout, /QQ SDK: locked version and integrity verified/);
  assert.doesNotMatch(ok.stdout, /OpenClaw/, 'the host packages only with --runtime');
  assert.ok(existsSync(installedNode(good)));
  assert.equal(existsSync(parked(good)), false, 'the tarball is removed after extraction');
  const calls = good.npmCalls();
  assert.equal(calls.length, 1);
  assert.match(calls[0], /npm-cli\.js ci --ignore-scripts --no-audit --no-fund$/);
  assert.ok(calls[0].startsWith(join(good.repo, '.runtime', 'node', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')), 'the private npm');
});

test('setup.sh is repeatable, and --runtime installs the host packages from runtime-lock', { timeout: 120000, skip: LINUX_ONLY }, () => {
  const r = fakeRepo('again');
  r.placeTarball();
  assert.equal(r.run().status, 0);
  // Second run: no tarball, no curl. A Node that already reports the version is kept, so nothing is fetched.
  const again = r.run(['--runtime']);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.doesNotMatch(again.stdout, /Downloading/);
  assert.match(again.stdout, /OpenClaw and search plugin: locked versions and integrity verified/);
  const calls = r.npmCalls();
  assert.equal(calls.length, 3);
  assert.match(calls[2], /npm-cli\.js ci --no-audit --no-fund$/);
  assert.deepEqual(readFileSync(join(r.repo, '.runtime', 'pkg', 'package-lock.json')), readFileSync(join(ROOT, 'runtime-lock', 'package-lock.json')));
  const unknown = r.run(['--runtme']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown argument: --runtme/);
});

test('setup.sh stops when an installed lockfile entry differs from versions.lock.json', { timeout: 120000, skip: LINUX_ONLY }, () => {
  const r = fakeRepo('integrity');
  r.placeTarball();
  assert.equal(r.run(['--runtime']).status, 0, 'positive control: the untouched lockfiles pass');
  const file = join(r.repo, 'runtime-lock', 'package-lock.json');
  const l = JSON.parse(readFileSync(file, 'utf8'));
  l.packages['node_modules/openclaw'].integrity = 'sha512-TAMPERED';
  writeFileSync(file, JSON.stringify(l, null, 2));
  const res = r.run(['--runtime']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /openclaw integrity in the lockfile differs from versions\.lock\.json/);
  assert.doesNotMatch(res.stdout, /Setup finished/);
});

test('setup.sh refuses a malformed or inconsistent Node entry before any download', { timeout: 120000, skip: LINUX_ONLY }, () => {
  // Positive control: the project's own lock passes the strict read and reaches the download, which cannot run here.
  const own = fakeRepo('ownlock');
  cpSync(join(ROOT, 'versions.lock.json'), own.lockFile);
  const reached = own.run();
  assert.equal(reached.status, 1);
  assert.match(reached.stdout, /Downloading node-v24\.22\.2-linux-x64\.tar\.xz/);
  assert.match(reached.stderr, /Download failed\. Nothing was installed\./);

  const cases = [
    ['short hash', (t) => t.replace(/("sha256": ")([0-9a-f]{64})(")(?=\n  },\n  "npm")/, '$1abc$3'), /nodeLinuxX64\.sha256 is missing or malformed/],
    ['upper-case hash', (t) => t.replace(/("sha256": ")([0-9a-f]{64})(")(?=\n  },\n  "npm")/, (_m, a, h, c) => a + h.toUpperCase() + c), /nodeLinuxX64\.sha256 is missing or malformed/],
    ['two hashes', (t) => t.replace(/(    "sha256": "[0-9a-f]{64}")(\n  },\n  "npm")/, `$1,\n    "sha256": "${'b'.repeat(64)}"$2`), /nodeLinuxX64\.sha256 is missing or malformed/],
    ['no entry', (t) => t.replace('"nodeLinuxX64"', '"nodeLinux"'), /nodeLinuxX64\.version is missing or malformed/],
    ['another host', (t) => t.replace('https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-x64', 'https://example.invalid/dist/v24.22.2/node-v24.22.2-linux-x64'), /entry is inconsistent/],
    ['another file', (t) => t.replace(/node-v24\.22\.2-linux-x64\.tar\.xz",\n    "url"/, 'node-v24.22.2-linux-arm64.tar.xz",\n    "url"'), /entry is inconsistent/],
  ];
  for (const [what, edit, expected] of cases) {
    const r = fakeRepo('malformed');
    const text = readFileSync(join(ROOT, 'versions.lock.json'), 'utf8');
    const changed = edit(text);
    assert.notEqual(changed, text, `${what}: the edit applied`);
    writeFileSync(r.lockFile, changed);
    const res = r.run();
    assert.equal(res.status, 1, what);
    assert.match(res.stderr, expected, what);
    assert.doesNotMatch(res.stdout, /Downloading/, `${what}: stopped before the download`);
    assert.equal(existsSync(installedNode(r)), false, what);
  }
});

test('setup.sh verifies the Node it extracted against what the JSON entry says', { timeout: 120000, skip: LINUX_ONLY }, () => {
  // A lock whose strict read and JSON read disagree: JSON keeps the last of two entries with the same key.
  const r = fakeRepo('jsonread');
  r.placeTarball();
  const text = readFileSync(r.lockFile, 'utf8');
  writeFileSync(r.lockFile, text.replace('  "npm": {', `  "nodeLinuxX64": { "version": "24.22.3" },\n  "npm": {`));
  const res = r.run();
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stderr, /reads differently as JSON/);
  assert.deepEqual(r.npmCalls(), []);
  // Positive control: without the second key the same repo installs.
  writeFileSync(r.lockFile, text);
  assert.equal(r.run().status, 0);
});

test('setup.sh creates a missing .env and config.json owner-only, and never touches existing ones', { timeout: 120000, skip: LINUX_ONLY }, () => {
  const r = fakeRepo('envfiles');
  r.placeTarball();
  const env = join(r.repo, '.env');
  const cfg = join(r.repo, 'config.json');
  // The template's own mode shows the copy's mode does not come from it: git checks it out by the umask.
  chmodSync(join(r.repo, '.env.example'), 0o644);
  assert.equal(statSync(join(r.repo, '.env.example')).mode & 0o777, 0o644, 'positive control: the template is readable by others');
  const first = r.run();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(statSync(env).mode & 0o777, 0o600);
  assert.equal(statSync(cfg).mode & 0o777, 0o600);
  assert.deepEqual(readFileSync(env), readFileSync(join(r.repo, '.env.example')));
  assert.deepEqual(readFileSync(cfg), readFileSync(join(r.repo, 'config.example.json')));
  assert.match(first.stdout, /Created \.env from \.env\.example/);
  // A file the user already has keeps its content and mode, even a wide one.
  writeFileSync(env, 'CLO_QQ_APP_ID=already-filled\n');
  chmodSync(env, 0o644);
  const again = r.run();
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(readFileSync(env, 'utf8'), 'CLO_QQ_APP_ID=already-filled\n');
  assert.equal(statSync(env).mode & 0o777, 0o644, 'left as the user had it; doctor reports it');
  assert.doesNotMatch(again.stdout, /Created/);
});
