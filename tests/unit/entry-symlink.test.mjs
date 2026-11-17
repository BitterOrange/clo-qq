// The "run directly" check at the end of the console and the probe tools. Off Windows both paths go through realpath,
// so the console still runs when reached through a symlinked folder or file. Windows keeps its own comparison, and
// a folder symlink needs admin rights there, so the symlink cases run only off Windows. Every child gets the clean
// environment and a temp CLO_TEST_ROOT; none of them reads the project's .env or state.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { isEntryPath } from '../../src/cli/platform.mjs';
import { cleanChildEnv } from '../harness/clean-env.mjs';
import { IS_WINDOWS, NODE } from '../harness/platform.mjs';
import { ROOT } from './_cli-helper.mjs';

const NOT_WINDOWS = IS_WINDOWS ? 'not Windows: a folder symlink needs admin rights, and Windows keeps its own comparison' : false;
const CLO = join(ROOT, 'src', 'cli', 'clo.mjs');
const USAGE_HEAD = '用法：clo <命令>';

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })));
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), 'clo-entry-'));
  dirs.push(d);
  return d;
}

function run(args) {
  const testRoot = tempDir();
  mkdirSync(join(testRoot, '.runtime'), { recursive: true });
  return spawnSync(NODE, args, { env: cleanChildEnv({ CLO_TEST_ROOT: testRoot }), encoding: 'utf8', timeout: 60000, cwd: tempDir() });
}

test('clo.mjs run by its own path prints the usage and exits 0', () => {
  const r = run([CLO]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.startsWith(USAGE_HEAD), r.stdout.slice(0, 200));
});

describe('called through a symlink', { skip: NOT_WINDOWS }, () => {
  test('clo.mjs reached through a symlinked folder or file prints the usage; importing it runs nothing', () => {
    const direct = run([CLO]);
    assert.ok(direct.stdout.startsWith(USAGE_HEAD), 'positive control: the real path');

    const links = tempDir();
    symlinkSync(ROOT, join(links, 'repo'), 'dir');
    symlinkSync(CLO, join(links, 'clo-link.mjs'));
    for (const p of [join(links, 'repo', 'src', 'cli', 'clo.mjs'), join(links, 'clo-link.mjs')]) {
      const r = run([p]);
      assert.equal(r.status, 0, `${p}: ${r.stderr}`);
      assert.equal(r.stdout, direct.stdout, p);
    }

    // Imported by another script, through the same symlinked folder: main does not run.
    const importer = join(tempDir(), 'importer.mjs');
    writeFileSync(importer, `await import(${JSON.stringify(pathToFileURL(join(links, 'repo', 'src', 'cli', 'clo.mjs')).href)});\nprocess.stdout.write('imported');\n`);
    const imp = run([importer]);
    assert.equal(imp.status, 0, imp.stderr);
    assert.equal(imp.stdout, 'imported');
  });

  test('isEntryPath: true for the file and for a symlink to it, false for another file, a missing one or none', () => {
    const links = tempDir();
    symlinkSync(ROOT, join(links, 'repo'), 'dir');
    const url = pathToFileURL(CLO).href;
    assert.equal(isEntryPath(CLO, url), true, 'positive control');
    assert.equal(isEntryPath(join(links, 'repo', 'src', 'cli', 'clo.mjs'), url), true);
    assert.equal(isEntryPath(join(links, 'repo', 'src', 'cli', 'doctor.mjs'), url), false);
    assert.equal(isEntryPath(join(links, 'missing.mjs'), url), false);
    assert.equal(isEntryPath(undefined, url), false);
    assert.equal(isEntryPath('', url), false);
  });
});
