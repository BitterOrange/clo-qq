// Tests must give the same result whatever the project has done since. A real `clo model refresh` writes the
// project's versions.lock.json, and copying that into a test root once broke 65 unit tests with no code change.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { clo, makeRoot, pristineVersionsLock, readJson, ROOT } from './_cli-helper.mjs';

test('a test root starts with no model lock and no change history, whatever the project has locked', () => {
  const r = makeRoot('hermetic');
  try {
    const copied = readJson(join(r.root, 'versions.lock.json'));
    assert.equal(copied.models?.lock, undefined);
    assert.equal(copied.models?.changes, undefined);
    // Positive control: the rest of the file still comes across, since tests read the versions in it.
    const real = JSON.parse(readFileSync(join(ROOT, 'versions.lock.json'), 'utf8').replace(/^﻿/, ''));
    for (const k of Object.keys(real).filter((name) => name !== 'models')) assert.deepEqual(copied[k], real[k], k);
    assert.equal(copied.models?.primarySelector, real.models?.primarySelector);
  } finally {
    r.cleanup();
  }
});

test('the helper strips a lock from the file it reads, and never writes to the project', () => {
  const before = readFileSync(join(ROOT, 'versions.lock.json'), 'utf8');
  const lock = pristineVersionsLock();
  assert.equal(lock.models?.lock, undefined);
  assert.equal(readFileSync(join(ROOT, 'versions.lock.json'), 'utf8'), before);
});

test('with a pristine copy, the console reports no lock', async () => {
  const r = makeRoot('hermetic-show');
  try {
    const shown = await clo(r.root, ['model', 'show']);
    assert.equal(shown.code, 0, shown.err);
    assert.match(shown.out, /未锁定|没有锁定|no lock|未解析/i);
  } finally {
    r.cleanup();
  }
});
