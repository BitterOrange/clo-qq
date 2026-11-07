// clo.db schema 1 to 2 (contract section 8.2): reservations.provider, the v1 backup taken by VACUUM INTO, its retention,
// and the pause ranks the provider reasons need. Every negative case has its positive control in the same run.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createLedger } from '../../src/clo-plugin/lib/core/ledger.js';
import { PROVIDER_PAUSES } from '../../src/clo-plugin/lib/core/providers/registry.js';
import { SCHEMA_VERSION, backupFileOf, openStore, pauseRank } from '../../src/clo-plugin/lib/core/store.js';
import { cleanChildEnv } from '../harness/clean-env.mjs';

const dir = mkdtempSync(join(tmpdir(), 'clo-migrate-'));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
let n = 0;
const T0 = Date.UTC(2026, 10, 3, 4, 0, 0);
const DAY = 24 * 3600000;
const STORE_URL = pathToFileURL(join(import.meta.dirname, '..', '..', 'src', 'clo-plugin', 'lib', 'core', 'store.js')).href;

// The schema-1 layout exactly as builds before the provider column created it.
const V1_SCHEMA = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE events(
  event_key TEXT PRIMARY KEY, group_key TEXT NOT NULL, cls TEXT,
  state TEXT NOT NULL, reason TEXT, merged_into TEXT,
  run_gen TEXT NOT NULL, msg_ts INTEGER, received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX events_state ON events(state);
CREATE INDEX events_received ON events(received_at);
CREATE TABLE sends(
  send_id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL, group_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  msg_seq INTEGER NOT NULL, part INTEGER NOT NULL, text_sha TEXT NOT NULL,
  state TEXT NOT NULL,
  qq_code INTEGER, http_status INTEGER, ref_key TEXT, run_gen TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(event_key, msg_seq));
CREATE INDEX sends_created ON sends(created_at);
CREATE INDEX sends_group ON sends(group_key, created_at);
CREATE TABLE reservations(
  id TEXT PRIMARY KEY, local_day TEXT NOT NULL, utc_day TEXT NOT NULL,
  tier TEXT NOT NULL,
  category TEXT NOT NULL,
  held_micros INTEGER NOT NULL, actual_micros INTEGER,
  status TEXT NOT NULL,
  source TEXT,
  event_key TEXT, model TEXT, run_gen TEXT NOT NULL,
  created_at INTEGER NOT NULL, settled_at INTEGER);
CREATE INDEX reservations_day ON reservations(local_day, status);
CREATE TABLE interject_log(
  id TEXT PRIMARY KEY, group_key TEXT NOT NULL, event_key TEXT NOT NULL,
  status TEXT NOT NULL,
  local_day TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX interject_group ON interject_log(group_key, at);
CREATE TABLE counters(key TEXT PRIMARY KEY, value INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE control(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL);
CREATE TABLE bot_refs(ref_key TEXT PRIMARY KEY, group_key TEXT NOT NULL, event_key TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE key_snapshots(taken_at INTEGER PRIMARY KEY, usage_micros INTEGER, usage_daily_micros INTEGER,
  limit_micros INTEGER, remaining_micros INTEGER, limit_reset TEXT);
CREATE TABLE alerts(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL,
  detail TEXT NOT NULL, suppressed INTEGER NOT NULL DEFAULT 0, acked_at INTEGER);
CREATE TABLE discovery(group_id TEXT NOT NULL, member_id TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  count INTEGER NOT NULL, PRIMARY KEY(group_id, member_id));
`;

// A v1 db with two reservations. With keep, the writer stays open with checkpoints off, so later rows sit in -wal only.
function v1Db({ keep = false } = {}) {
  const file = join(dir, `m${++n}`, 'clo.db');
  mkdirSync(join(dir, `m${n}`), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA wal_autocheckpoint=0');
  db.exec(V1_SCHEMA);
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('hmac_salt', 'ab'.repeat(32));
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('schema', '1');
  db.exec('PRAGMA user_version=1');
  const add = (id, status = 'settled') => db.prepare(`INSERT INTO reservations(id, local_day, utc_day, tier, category, held_micros, actual_micros, status, run_gen, created_at)
    VALUES (?, '2026-11-03', '2026-11-03', 'addressed', 'reply', 1000, 900, ?, 'old', ?)`).run(id, status, T0);
  add('R1');
  add('R2', 'unsettled');
  if (!keep) {
    db.close();
    return { file, add: null, db: null };
  }
  return { file, add, db };
}

const readOnly = (file, fn) => {
  const d = new DatabaseSync(file, { readOnly: true });
  try {
    return fn(d);
  } finally {
    d.close();
  }
};
const versionOf = (file) => readOnly(file, (d) => d.prepare('PRAGMA user_version').get().user_version);
const idsOf = (file) => readOnly(file, (d) => d.prepare('SELECT id FROM reservations ORDER BY id').all().map((r) => r.id));
const columns = (db) => db.prepare('PRAGMA table_info(reservations)').all().map((c) => c.name);
const tmpFiles = (file) => readdirSync(join(file, '..')).filter((f) => f.endsWith('.tmp'));

test('a fresh db is created at v2 directly: the provider column, no backup, no migration time', () => {
  assert.equal(SCHEMA_VERSION, 2);
  const file = join(dir, `fresh${++n}.db`);
  const store = openStore(file, { now: () => T0 });
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.ok(columns(store.db).includes('provider'));
  assert.equal(store.getMeta('schema'), '2');
  assert.equal(store.getMeta('migrated_v2_at'), null);
  store.close();
  assert.equal(existsSync(backupFileOf(file)), false);
});

test('a v1 db with rows migrates to v2: old rows read as openrouter, the same salt, the same layout as a fresh db, and a v1 backup', () => {
  const { file } = v1Db();
  const store = openStore(file, { runGen: 'new', now: () => T0 + 5 });
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(store.getMeta('schema'), '2');
  assert.equal(store.getMeta('migrated_v2_at'), String(T0 + 5));
  assert.equal(store.getMeta('hmac_salt'), 'ab'.repeat(32), 'Key fingerprints and identifiers keep their meaning');
  const rows = store.q('SELECT id, status, provider FROM reservations ORDER BY id').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ id: 'R1', status: 'settled', provider: null }, { id: 'R2', status: 'unsettled', provider: null }]);
  const fresh = openStore(join(dir, `fresh${++n}.db`));
  assert.deepEqual(columns(store.db), columns(fresh.db));
  fresh.close();

  // The ledger counts the old rows as before, and a new reservation carries its provider.
  const eff = { runtime: 'own', mode: 'live', budget: { dailyUsd: 2.5, interjectUsd: 0.75, searchUsd: 2.1, namedUsd: 2.25, addressedUsd: 2.5 }, openrouter: { baseUrl: 'http://mock/api/v1' }, apiProvider: { name: 'anthropic', kind: 'anthropic' } };
  const ledger = createLedger({ store, getEffective: () => eff, fetch: null, getKey: () => null, now: () => T0 + 10 });
  assert.equal(ledger.spent(T0 + 10).unsettled, 1);
  const { id } = ledger.reserve({ tier: 'addressed', category: 'reply', heldMicros: 1000, eventKey: 'N' });
  assert.equal(store.q('SELECT provider FROM reservations WHERE id=?').get(id).provider, 'anthropic');
  store.close();

  const bak = backupFileOf(file);
  assert.ok(existsSync(bak), 'the backup exists');
  assert.equal(versionOf(bak), 1, 'at schema 1, for a build that reads only v1');
  assert.deepEqual(idsOf(bak), ['R1', 'R2']);
  assert.ok(!readOnly(bak, columns).includes('provider'));
  assert.deepEqual(tmpFiles(file), [], 'no scratch file is left');

  // Reopening a v2 db migrates nothing again and keeps the backup as it was.
  const again = openStore(file, { now: () => T0 + DAY });
  assert.equal(again.getMeta('migrated_v2_at'), String(T0 + 5));
  again.close();
});

test('the backup never holds the raw IDs of a capture: clearing clo.db at live leaves none behind (control: the rest is copied)', () => {
  const { file } = v1Db();
  // Placeholder IDs, long enough to find in the file's bytes.
  const GROUP = 'RAWGROUPPLACEHOLDER0001';
  const MEMBER = 'RAWMEMBERPLACEHOLDER0002';
  const raw = new DatabaseSync(file);
  raw.prepare('INSERT INTO discovery(group_id, member_id, first_seen, last_seen, count) VALUES (?, ?, ?, ?, 1)').run(GROUP, MEMBER, T0, T0);
  raw.prepare('INSERT INTO control(key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)').run('discovery_until', String(T0 + 600000), T0, 'cli');
  raw.prepare('INSERT INTO control(key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)').run('paid_paused', 'provider_fail', T0, 'ledger');
  raw.close();
  // Positive control on the premise: the v1 file itself holds them.
  const v1Bytes = readFileSync(file);
  assert.ok(v1Bytes.includes(GROUP) && v1Bytes.includes(MEMBER));

  const store = openStore(file, { now: () => T0 + 5 });
  assert.equal(store.listDiscovery().length, 1, 'control: the migration leaves the capture in clo.db as it was');
  store.clearDiscovery();
  assert.equal(store.listDiscovery().length, 0);
  store.close();

  const bak = backupFileOf(file);
  assert.equal(readOnly(bak, (d) => d.prepare('SELECT COUNT(*) AS n FROM discovery').get().n), 0);
  assert.equal(readOnly(bak, (d) => d.prepare("SELECT COUNT(*) AS n FROM control WHERE key='discovery_until'").get().n), 0);
  const bytes = readFileSync(bak);
  assert.ok(!bytes.includes(GROUP) && !bytes.includes(MEMBER), 'not even in a free page');
  // Positive control: everything else is in the copy.
  assert.deepEqual(idsOf(bak), ['R1', 'R2']);
  assert.equal(readOnly(bak, (d) => d.prepare("SELECT value FROM control WHERE key='paid_paused'").get().value), 'provider_fail');
  assert.equal(versionOf(bak), 1);
  assert.deepEqual(readdirSync(join(file, '..')).filter((f) => f.startsWith('clo.db.v1.bak')), ['clo.db.v1.bak'], 'no -wal, -shm or scratch file beside it');
});

test('a row committed only in the WAL is in the backup', () => {
  const v1 = v1Db({ keep: true });
  v1.add('WAL_ONLY');
  // Positive control on the premise: the main file alone does not hold the row yet.
  const copy = join(dir, `copy${++n}.db`);
  copyFileSync(v1.file, copy);
  // Nothing was checkpointed, so the main file may not even hold the tables yet.
  const copied = (() => {
    try {
      return idsOf(copy);
    } catch (err) {
      assert.match(err.message, /no such table/);
      return [];
    }
  })();
  assert.ok(!copied.includes('WAL_ONLY'), 'a plain copy of clo.db misses it');
  const store = openStore(v1.file, { now: () => T0 });
  store.close();
  v1.db.close();
  assert.ok(idsOf(backupFileOf(v1.file)).includes('WAL_ONLY'));
});

test('a commit between the snapshot and the lock sends the step back to the snapshot', () => {
  // Positive control: with no writer the snapshot is taken once.
  const quiet = v1Db({ keep: true });
  const quietCalls = [];
  openStore(quiet.file, { onMigrationSnapshot: (a) => quietCalls.push(a) }).close();
  quiet.db.close();
  assert.deepEqual(quietCalls, [0]);

  const v1 = v1Db({ keep: true });
  const calls = [];
  const store = openStore(v1.file, {
    onMigrationSnapshot: (attempt) => {
      calls.push(attempt);
      if (attempt === 0) v1.add('LATE');
    },
  });
  assert.deepEqual(calls, [0, 1], 'the first snapshot is thrown away');
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
  store.close();
  v1.db.close();
  assert.ok(idsOf(backupFileOf(v1.file)).includes('LATE'), 'the backup is the second snapshot, with the late row');
  assert.deepEqual(tmpFiles(v1.file), []);
});

test('writers at every try: the step gives up after 5, the db stays at v1 with no backup and no scratch file', () => {
  const v1 = v1Db({ keep: true });
  let i = 0;
  assert.throws(() => openStore(v1.file, { onMigrationSnapshot: () => v1.add(`W${i++}`) }), /stays at schema 1/);
  assert.equal(i, 5);
  v1.db.close();
  assert.equal(versionOf(v1.file), 1);
  assert.equal(existsSync(backupFileOf(v1.file)), false);
  assert.deepEqual(tmpFiles(v1.file), []);
  // The next open, with nobody writing, migrates.
  const store = openStore(v1.file);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
  store.close();
});

test('a migration killed after its snapshot leaves v1; the next open migrates and replaces the backup', () => {
  const { file } = v1Db();
  writeFileSync(backupFileOf(file), 'an older backup');
  assert.throws(() => openStore(file, { onMigrationSnapshot: () => { throw new Error('killed'); } }), /killed/);
  assert.equal(versionOf(file), 1);
  assert.equal(tmpFiles(file).length, 1, 'what a killed process leaves for the janitor');
  const store = openStore(file);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
  store.close();
  assert.equal(versionOf(backupFileOf(file)), 1, 'the older backup was replaced');
  assert.deepEqual(tmpFiles(file), [], 'the same process reused and removed its scratch file');
});

test('two processes opening one v1 db together give one v2 db and one backup', async () => {
  const { file } = v1Db();
  const child = join(dir, `child${++n}.mjs`);
  writeFileSync(child, `import { existsSync, writeFileSync } from 'node:fs';
import { openStore } from ${JSON.stringify(STORE_URL)};
const [file, role, mark] = process.argv.slice(2);
let attempts = 0;
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const store = openStore(file, { onMigrationSnapshot: () => {
  attempts += 1;
  if (role !== 'first') return;
  writeFileSync(mark + '.snap', '');
  // Hold here, outside any transaction, until the other process has migrated.
  for (let i = 0; i < 800 && !existsSync(mark + '.done'); i += 1) wait(25);
} });
const v = store.db.prepare('PRAGMA user_version').get().user_version;
const cols = store.db.prepare('PRAGMA table_info(reservations)').all().filter((c) => c.name === 'provider').length;
store.close();
if (role === 'second') writeFileSync(mark + '.done', '');
process.stdout.write(JSON.stringify({ v, cols, attempts }));
`);
  const mark = join(dir, `mark${n}`);
  const run = (role) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', child, file, role, mark], { env: cleanChildEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`child ${role} exited ${code}: ${err.slice(0, 400)}`))));
  });
  const first = run('first');
  for (let i = 0; i < 800 && !existsSync(`${mark}.snap`); i += 1) await new Promise((r) => setTimeout(r, 25));
  assert.ok(existsSync(`${mark}.snap`), 'the first process took its snapshot');
  const second = await run('second');
  const one = await first;
  assert.deepEqual(second, { v: 2, cols: 1, attempts: 1 }, 'the second migrated while the first held its snapshot');
  assert.deepEqual(one, { v: 2, cols: 1, attempts: 1 }, 'the first found v2 under the lock and stopped');
  assert.equal(versionOf(file), 2);
  assert.equal(versionOf(backupFileOf(file)), 1);
  assert.deepEqual(tmpFiles(file), [], 'neither scratch file is left');
});

test('a db newer than v2 is refused and left as it is (control: v2 opens)', () => {
  const file = join(dir, `newer${++n}.db`);
  openStore(file).close();
  const ok = openStore(file);
  ok.close();
  const d = new DatabaseSync(file);
  d.exec('PRAGMA user_version=3');
  d.close();
  assert.throws(() => openStore(file), /schema 3 is newer than this build \(2\)/);
  assert.equal(versionOf(file), 3);
  assert.equal(existsSync(backupFileOf(file)), false);
});

test('the janitor deletes the backup after retention.eventDays, and scratch files after an hour', () => {
  const { file } = v1Db();
  const store = openStore(file, { now: () => T0 });
  const retention = { eventDays: 30, sendDays: 30, reservationDays: 90 };
  const stale = `${backupFileOf(file)}.4242.tmp`;
  const recent = `${backupFileOf(file)}.4343.tmp`;
  const other = join(file, '..', 'unrelated.tmp');
  for (const f of [stale, recent, other]) writeFileSync(f, 'x');
  const sec = (ms) => ms / 1000;
  const at = T0 + 30 * DAY;
  utimesSync(stale, sec(at - 3600001), sec(at - 3600001));
  utimesSync(recent, sec(at - 60000), sec(at - 60000));
  utimesSync(other, sec(at - 3 * 3600000), sec(at - 3 * 3600000));

  const kept = store.janitor(at, retention);
  assert.equal(kept.backup, 0, 'positive control: not yet past its days');
  assert.equal(kept.backupTmp, 1);
  assert.ok(existsSync(backupFileOf(file)));
  assert.equal(existsSync(stale), false);
  assert.ok(existsSync(recent), 'a scratch file a migration may be writing now stays');
  assert.ok(existsSync(other), 'only the backup scratch files are the janitor\'s');

  const gone = store.janitor(at + 1, retention);
  assert.equal(gone.backup, 1);
  assert.equal(existsSync(backupFileOf(file)), false);
  assert.equal(store.janitor(at + 2, retention).backup, 0, 'already gone');
  store.close();
});

test('the provider pauses rank with the OpenRouter limits: above crash_unsettled, below usage_unavailable', () => {
  for (const reason of PROVIDER_PAUSES) {
    assert.equal(pauseRank(reason), 3, reason);
    assert.equal(pauseRank(reason), pauseRank('openrouter_key_limit'));
    assert.ok(pauseRank(reason) > pauseRank('crash_unsettled'));
    assert.ok(pauseRank(reason) < pauseRank('usage_unavailable'));
  }
  assert.equal(pauseRank('hard_cap_unverified'), 1, 'not a paid_paused reason, so it has no rank of its own');
  assert.equal(pauseRank('anthropic_unknown'), 1, 'control: an unlisted reason still ranks lowest');
});

test('recovery does not overwrite a provider pause with crash_unsettled (control: provider_fail is replaced)', () => {
  for (const [reason, want] of [...PROVIDER_PAUSES.map((r) => [r, r]), ['provider_fail', 'crash_unsettled']]) {
    const file = join(dir, `rec${++n}.db`);
    const a = openStore(file, { runGen: 'a', now: () => T0 });
    a.claimEvent({ eventKey: 'E1', groupKey: 'G1', msgTs: T0, receivedAt: T0 });
    for (const [from, to] of [['received', 'queued'], ['queued', 'deciding'], ['deciding', 'approved'], ['approved', 'dispatching']]) a.transition('E1', from, to);
    a.q(`INSERT INTO reservations(id, local_day, utc_day, tier, category, held_micros, status, event_key, run_gen, created_at)
         VALUES ('H1', '2026-11-03', '2026-11-03', 'addressed', 'reply', 1000, 'held', 'E1', 'a', ?)`).run(T0);
    a.setControl('paid_paused', reason, 'test');
    a.close();
    const b = openStore(file, { runGen: 'b', now: () => T0 + 1 });
    b.recoverOnStart(T0 + 1);
    assert.equal(b.getControl('paid_paused'), want, reason);
    b.close();
  }
});

test('statusSnapshot lists the hard-cap pause of each kind beside paid_paused', () => {
  const store = openStore(join(dir, `snap${++n}.db`), { now: () => T0 });
  assert.deepEqual(store.statusSnapshot(T0).hardCapPaused, {});
  store.setControl('hard_cap_paused:anthropic', 'hard_cap', 'ledger');
  const s = store.statusSnapshot(T0);
  assert.deepEqual(s.hardCapPaused, { anthropic: 'hard_cap' });
  assert.equal(s.paidPaused, null);
  store.close();
});
