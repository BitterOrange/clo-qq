// Tests must give the same result whatever the project has done since. A real `clo model refresh` writes the
// project's versions.lock.json, and copying that into a test root once broke 65 unit tests with no code change.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readModelsLock, readPriceBook } from '../../src/cli/common.mjs';
import { baseConfig, clo, makeRoot, pristineVersionsLock, readJson, ROOT, TEST_ANTHROPIC_BOOK, withProviders, writePriceBook } from './_cli-helper.mjs';

test('a test root starts with no model lock and no change history, whatever the project has locked', () => {
  const r = makeRoot('hermetic');
  try {
    const copied = readJson(join(r.root, 'versions.lock.json'));
    assert.equal(copied.models?.lock, undefined);
    assert.equal(copied.models?.changes, undefined);
    // The per-kind locks and the hand-entered price books go too, so a test that needs one writes its own.
    assert.equal(copied.models?.locks, undefined);
    assert.equal(copied.models?.priceBooks, undefined);
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

test('locks and price books of every kind are stripped, even when the project has them', () => {
  const real = JSON.parse(readFileSync(join(ROOT, 'versions.lock.json'), 'utf8').replace(/^﻿/, ''));
  // Positive control: the project ships a price book, so stripping it is what makes the copy empty.
  assert.ok(real.models?.priceBooks?.anthropic, 'the project has an Anthropic price book');
  const lock = pristineVersionsLock();
  assert.equal(lock.models?.priceBooks, undefined);
  assert.equal(lock.models?.locks, undefined);
  assert.equal(lock.models?.primarySelector, real.models.primarySelector);
});

test('with a pristine copy, an Anthropic entry has no lock and no price book until a test writes one', () => {
  const r = makeRoot('hermetic-anthropic', withProviders(baseConfig(), { active: 'anthropic' }));
  try {
    const paths = { versionsLock: join(r.root, 'versions.lock.json') };
    assert.equal(readModelsLock(paths, 'anthropic'), null);
    assert.equal(readPriceBook(paths, 'anthropic'), null);
    writePriceBook(r.root);
    assert.deepEqual(readPriceBook(paths, 'anthropic'), TEST_ANTHROPIC_BOOK());
  } finally {
    r.cleanup();
  }
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
