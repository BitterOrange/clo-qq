// TQ15, unit half. The real Gateway half is e2e/qq-identity.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildEffective, validateBusinessConfig } from '../../src/clo-plugin/lib/core/config.js';
import { CRASH_POINTS, hmacKey, hourBucket, isQuietHours, sessionPeerId, shanghaiDay, shanghaiDayStart, utcDay } from '../../src/clo-plugin/lib/core/ids.js';
import { openStore } from '../../src/clo-plugin/lib/core/store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const dir = mkdtempSync(join(tmpdir(), 'clo-identity-'));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
const sample = JSON.parse(readFileSync(join(HERE, '..', 'fixtures', 'render', 'config.sample.json'), 'utf8'));
const paths = { repoRoot: ROOT, db: 'db', eventLog: 'log', systemPromptFile: 'sp' };

const UPPER = 'AB12CD34EF56AB12CD34EF56AB12CD34';
const LOWER = UPPER.toLowerCase();

test('peer IDs differ for IDs that differ only by case, and survive host lowercasing', () => {
  const a = sessionPeerId('g', UPPER);
  const b = sessionPeerId('g', LOWER);
  assert.notEqual(a, b);
  assert.equal(a, a.toLowerCase(), 'the host lowercases session keys, so nothing may change');
  assert.equal(b, b.toLowerCase());
  assert.notEqual(a.toLowerCase(), b.toLowerCase(), 'still distinct after the host lowercases');
});

test('control: lowercasing the raw IDs is what collides', () => {
  assert.equal(UPPER.toLowerCase(), LOWER.toLowerCase());
});

test('peer IDs hide the raw ID, are stable, and have the documented form', () => {
  const g = sessionPeerId('g', UPPER);
  assert.match(g, /^g[0-9a-f]{32}$/);
  assert.ok(!g.includes(LOWER) && !g.includes(UPPER));
  assert.equal(sessionPeerId('group', UPPER), g);
  assert.equal(sessionPeerId('g', UPPER), g);
  assert.match(sessionPeerId('u', UPPER), /^u[0-9a-f]{32}$/);
  assert.equal(sessionPeerId('direct', UPPER), sessionPeerId('u', UPPER));
});

test('a group and a user with the same raw ID do not share a session peer', () => {
  assert.notEqual(sessionPeerId('g', UPPER), sessionPeerId('u', UPPER));
});

test('bad input is refused, not silently keyed', () => {
  assert.throws(() => sessionPeerId('x', UPPER), /unknown kind/);
  assert.throws(() => sessionPeerId('g', ''), /rawId/);
  assert.throws(() => sessionPeerId('g', null), /rawId/);
  assert.throws(() => hmacKey('', UPPER), /salt/);
  assert.throws(() => hmacKey('s', ''), /value/);
});

test('HMAC keys are case-sensitive, salted, and lowercase hex of 32 chars', () => {
  const a = hmacKey('salt', UPPER);
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, hmacKey('salt', LOWER));
  assert.notEqual(a, hmacKey('other', UPPER));
});

test('the store dedupes and keys by exact case', () => {
  const store = openStore(join(dir, 'a.db'), { runGen: 'g' });
  const a = store.key(UPPER);
  const b = store.key(LOWER);
  assert.notEqual(a, b);
  assert.deepEqual(store.claimEvent({ eventKey: a, groupKey: 'G', receivedAt: 1 }), { fresh: true });
  assert.deepEqual(store.claimEvent({ eventKey: b, groupKey: 'G', receivedAt: 1 }), { fresh: true });
  store.addBotRef(a, 'G', 'E');
  assert.equal(store.hasBotRef(b, 'G'), false);
  store.close();
});

test('Shanghai day and hour buckets', () => {
  const lateUtc = Date.UTC(2026, 10, 3, 15, 59, 59);
  assert.equal(shanghaiDay(lateUtc), '2026-11-03');
  assert.equal(shanghaiDay(lateUtc + 1000), '2026-11-04');
  assert.equal(utcDay(lateUtc + 1000), '2026-11-03');
  assert.equal(shanghaiDayStart(lateUtc), Date.UTC(2026, 10, 2, 16, 0, 0));
  assert.equal(hourBucket(7200000), 2);
  assert.equal(hourBucket(7199999), 1);
});

test('quiet hours wrap across midnight, in Shanghai time', () => {
  const qh = { start: '23:00', end: '08:00', timezone: 'Asia/Shanghai' };
  const at = (h, m) => Date.UTC(2026, 10, 3, h - 8, m, 0);
  assert.equal(isQuietHours(at(22, 59), qh), false);
  assert.equal(isQuietHours(at(23, 0), qh), true);
  assert.equal(isQuietHours(at(3, 0), qh), true);
  assert.equal(isQuietHours(at(7, 59), qh), true);
  assert.equal(isQuietHours(at(8, 0), qh), false);
  const daytime = { start: '09:00', end: '17:00', timezone: 'Asia/Shanghai' };
  assert.equal(isQuietHours(at(9, 0), daytime), true);
  assert.equal(isQuietHours(at(17, 0), daytime), false);
  assert.equal(isQuietHours(at(3, 0), { start: '08:00', end: '08:00', timezone: 'Asia/Shanghai' }), false);
  assert.throws(() => isQuietHours(0, { ...qh, timezone: 'UTC' }), /timezone/);
  assert.throws(() => isQuietHours(0, { ...qh, start: 'late' }), /bad time/);
});

test('crashpoint exits with 77 only in test mode at the named point', () => {
  const run = (env) => spawnSync(process.execPath, ['--input-type=module', '-e', `import { crashpoint } from ${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'clo-plugin', 'lib', 'core', 'ids.js')).href)}; crashpoint('deciding'); process.exit(0);`], {
    cwd: dir,
    env: { SystemRoot: process.env.SystemRoot, ...env },
    windowsHide: true,
  }).status;
  assert.equal(run({ CLO_TEST_ROOT: dir, CLO_TEST_CRASH_AT: 'deciding' }), 77);
  assert.equal(run({ CLO_TEST_ROOT: dir, CLO_TEST_CRASH_AT: 'approved' }), 0);
  assert.equal(run({ CLO_TEST_CRASH_AT: 'deciding' }), 0, 'never outside test mode');
  assert.deepEqual(CRASH_POINTS, ['after_claim', 'deciding', 'approved', 'dispatching', 'before_post', 'after_post', 'before_settle']);
});

test('config keeps two groups whose IDs differ only by case, each with its own owners', () => {
  const cfg = structuredClone(sample);
  cfg.qq.allowedGroupIds = [UPPER, LOWER];
  cfg.qq.groups = {
    [UPPER]: { label: '大写群', interject: false, nameMention: false, noticeGiven: false },
    [LOWER]: { label: '小写群', interject: true, nameMention: false, noticeGiven: false },
  };
  cfg.qq.owner.groupMember = { [UPPER]: ['OWNER_ONE'], [LOWER]: ['owner_one'] };
  const v = validateBusinessConfig(cfg, { env: {} });
  assert.deepEqual(v.errors, []);
  const eff = buildEffective(cfg, { paths, env: {} });
  assert.equal(eff.qq.groups[UPPER].label, '大写群');
  assert.equal(eff.qq.groups[LOWER].label, '小写群');
  assert.deepEqual(eff.qq.groups[UPPER].ownerMemberIds, ['OWNER_ONE']);
  assert.deepEqual(eff.qq.groups[LOWER].ownerMemberIds, ['owner_one']);
  assert.deepEqual(Object.keys(eff.qq.groups).sort(), [UPPER, LOWER].sort());
});
