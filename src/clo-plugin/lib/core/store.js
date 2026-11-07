// Durable state on node:sqlite. Identifiers at rest are HMAC keys; only `discovery` holds raw IDs.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hmacKey, shanghaiDay, shanghaiDayStart } from './ids.js';
import { sanitizeData } from './log.js';

export const SCHEMA_VERSION = 2;
export const NON_TERMINAL_STATES = ['received', 'queued', 'deciding', 'approved', 'dispatching', 'delivering'];
export const TERMINAL_STATES = ['ignored', 'stale', 'merged', 'paused', 'dry_run', 'skipped', 'completed', 'silent',
  'policy_dropped', 'failed', 'restart_dropped', 'crash_unknown'];
const ALL_STATES = new Set([...NON_TERMINAL_STATES, ...TERMINAL_STATES]);
const TERMINAL = new Set(TERMINAL_STATES);
const SEND_MOVES = {
  pending: new Set(['sending', 'aborted', 'failed']),
  sending: new Set(['sent', 'failed', 'uncertain', 'aborted']),
};
// A reason or class is a token. This keeps message text out of the database even on a caller's mistake.
const TOKEN = /^[A-Za-z0-9_:.-]{1,64}$/;
const HOUR = 3600000;
const DAY = 24 * HOUR;
const ALERTS_PER_HOUR = 6;
const DISCOVERY_MAX_MS = 15 * 60000;
const DISCOVERY_MAX_ROWS = 1000;
const SNAPSHOT_KEEP_MS = 14 * DAY;
const WAL_WAIT_MS = 5000;
// The one order for paid_paused. A lower rank never overwrites a higher one; an equal rank overwrites.
// The provider pauses (registry PROVIDER_PAUSES) sit beside the OpenRouter limits: no settlement pause may replace them.
// The hard-cap pause has no rank: it is not a paid_paused reason, it lives in a control of its own per kind.
const PAUSE_RANK = {
  usage_unavailable: 4,
  openrouter_key_limit: 3, openrouter_credits: 3,
  anthropic_credits: 3, anthropic_spend_limit: 3, anthropic_permission: 3, anthropic_price_unexpected: 3,
  crash_unsettled: 2, usage_missing: 2,
};
export const pauseRank = (reason) => PAUSE_RANK[reason] ?? 1;

const SCHEMA = `
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
  created_at INTEGER NOT NULL, settled_at INTEGER,
  provider TEXT);
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

const placeholders = (n) => new Array(n).fill('?').join(',');

// Changing the journal mode can report a lock at once, without waiting for busy_timeout (observed
// when two processes create the file together), so it gets its own bounded wait.
function enableWal(db) {
  const deadline = Date.now() + WAL_WAIT_MS;
  for (;;) {
    try {
      db.exec('PRAGMA journal_mode=WAL');
      return;
    } catch (err) {
      if (!/locked|busy/i.test(err.message) || Date.now() > deadline) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

// The v1 copy kept for going back to a build that reads only v1. It is first written to <backup>.<pid>.tmp.
export const backupFileOf = (dbFile) => `${dbFile}.v1.bak`;
const MIGRATE_TRIES = 5;
const sqlString = (v) => `'${String(v).replaceAll("'", "''")}'`;

function createFresh(db, version) {
  db.exec('BEGIN IMMEDIATE');
  try {
    // Another process may have created it while this one waited for the lock.
    if (version() === 0) {
      db.exec(SCHEMA);
      db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('hmac_salt', randomBytes(32).toString('hex'));
      db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('schema', String(SCHEMA_VERSION));
      db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// The backup outlives `clo mode live` and `clo targets clear`, which empty `discovery` in clo.db only, so the copy
// never holds the raw IDs: a capture lasts minutes, and a build going back to v1 can capture again. secure_delete and
// VACUUM leave no page of the deleted rows in the file. It is rewritten in rollback-journal mode, so closing it leaves
// no -wal or -shm beside it.
function scrubBackup(file) {
  const b = new DatabaseSync(file);
  try {
    b.exec('PRAGMA journal_mode=DELETE');
    b.exec('PRAGMA secure_delete=ON');
    b.exec('DELETE FROM discovery');
    b.prepare('DELETE FROM control WHERE key=?').run('discovery_until');
    b.exec('VACUUM');
  } finally {
    b.close();
  }
}

// Schema 1 to 2: reservations.provider, the provider kind of a row (NULL is the implicit OpenRouter entry).
// The db runs in WAL mode, so committed rows can sit in -wal and a copy of the main file alone would miss them.
// VACUUM INTO writes a consistent snapshot with them, but not inside a transaction, so the step takes the snapshot
// first and then, under the write lock, checks that no other connection committed since (data_version). The
// backup is put in place under that lock, so a db at v2 always has the copy of the v1 it came from.
function migrateV1(db, dbFile, version, at, onSnapshot) {
  const bak = backupFileOf(dbFile);
  const tmp = `${bak}.${process.pid}.tmp`;
  const dataVersion = () => db.prepare('PRAGMA data_version').get().data_version;
  for (let attempt = 0; attempt < MIGRATE_TRIES; attempt += 1) {
    const dv = dataVersion();
    rmSync(tmp, { force: true });
    db.exec(`VACUUM INTO ${sqlString(tmp)}`);
    try {
      scrubBackup(tmp);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    onSnapshot?.(attempt);
    db.exec('BEGIN IMMEDIATE');
    try {
      if (version() !== 1) {
        // Another process migrated, and made the backup, while this one took its snapshot.
        db.exec('ROLLBACK');
        rmSync(tmp, { force: true });
        return;
      }
      if (dataVersion() !== dv) {
        db.exec('ROLLBACK');
        rmSync(tmp, { force: true });
        continue;
      }
      renameSync(tmp, bak);
      db.exec('ALTER TABLE reservations ADD COLUMN provider TEXT');
      db.prepare("UPDATE meta SET value=? WHERE key='schema'").run('2');
      db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('migrated_v2_at', String(at));
      db.exec('PRAGMA user_version=2');
      db.exec('COMMIT');
      return;
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      rmSync(tmp, { force: true });
      throw err;
    }
  }
  throw new Error(`clo.db migration to schema 2 kept meeting other writers (${MIGRATE_TRIES} tries); it stays at schema 1`);
}

function openDb(dbFile, { now = Date.now, onMigrationSnapshot } = {}) {
  mkdirSync(dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  try {
    db.exec('PRAGMA busy_timeout=5000');
    enableWal(db);
    db.exec('PRAGMA synchronous=FULL');
    db.exec('PRAGMA foreign_keys=ON');
    const version = () => db.prepare('PRAGMA user_version').get().user_version;
    for (;;) {
      const found = version();
      if (found > SCHEMA_VERSION) throw new Error(`clo.db schema ${found} is newer than this build (${SCHEMA_VERSION})`);
      if (found === SCHEMA_VERSION) return db;
      if (found === 0) createFresh(db, version);
      else if (found === 1) migrateV1(db, dbFile, version, now(), onMigrationSnapshot);
      else throw new Error(`clo.db schema ${found} has no migration in this build`);
    }
  } catch (err) {
    db.close();
    throw err;
  }
}

export function openStore(dbFile, { runGen = randomUUID(), now = Date.now, onMigrationSnapshot } = {}) {
  const db = openDb(dbFile, { now, onMigrationSnapshot });
  const statements = new Map();
  const q = (sql) => {
    let s = statements.get(sql);
    if (!s) {
      s = db.prepare(sql);
      statements.set(sql, s);
    }
    return s;
  };
  const salt = q("SELECT value FROM meta WHERE key='hmac_salt'").get().value;
  let depth = 0;
  let closed = false;

  function tx(fn) {
    const nested = depth > 0;
    const sp = `clo_sp_${depth}`;
    db.exec(nested ? `SAVEPOINT ${sp}` : 'BEGIN IMMEDIATE');
    depth += 1;
    try {
      const out = fn();
      if (out && typeof out.then === 'function') throw new TypeError('store.tx: fn must be synchronous');
      db.exec(nested ? `RELEASE ${sp}` : 'COMMIT');
      return out;
    } catch (err) {
      db.exec(nested ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK');
      throw err;
    } finally {
      depth -= 1;
    }
  }

  const checkToken = (v, what) => {
    if (v !== undefined && v !== null && !(typeof v === 'string' && TOKEN.test(v))) throw new TypeError(`store: bad ${what}`);
  };

  function getControl(key) {
    return q('SELECT value FROM control WHERE key=?').get(key)?.value ?? null;
  }
  function controlUpdatedAt(key) {
    return q('SELECT updated_at FROM control WHERE key=?').get(key)?.updated_at ?? null;
  }
  function setControl(key, value, by = 'system') {
    q(`INSERT INTO control(key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
      .run(key, String(value), now(), String(by));
  }
  function delControl(key) {
    q('DELETE FROM control WHERE key=?').run(key);
  }

  function addAlert(kind, detail = {}) {
    checkToken(kind, 'alert kind');
    const at = now();
    return tx(() => {
      const recent = q('SELECT COUNT(*) AS n, MAX(id) AS last FROM alerts WHERE kind=? AND at>?').get(kind, at - HOUR);
      if (recent.n >= ALERTS_PER_HOUR) {
        q('UPDATE alerts SET suppressed=suppressed+1 WHERE id=?').run(recent.last);
        return null;
      }
      const { kept } = sanitizeData(detail);
      return Number(q('INSERT INTO alerts(at, kind, detail) VALUES (?, ?, ?)').run(at, kind, JSON.stringify(kept)).lastInsertRowid);
    });
  }

  function peekInterject({ groupKey, limits, now: at = now() }) {
    const day = shanghaiDay(at);
    const consumed = q(`SELECT MAX(at) AS last, SUM(at>?) AS hour, SUM(local_day=?) AS day
                        FROM interject_log WHERE group_key=? AND status='consumed'`).get(at - HOUR, day, groupKey);
    if (consumed.last !== null && limits.cooldownMs > 0 && at - consumed.last < limits.cooldownMs) return { ok: false, reason: 'cooldown' };
    if ((consumed.hour ?? 0) >= limits.perHour) return { ok: false, reason: 'hour' };
    if ((consumed.day ?? 0) >= limits.perDay) return { ok: false, reason: 'day' };
    const live = q("SELECT COUNT(*) AS n FROM interject_log WHERE group_key=? AND status='claimed' AND at>?").get(groupKey, at - limits.leaseMs);
    if (live.n > 0) return { ok: false, reason: 'inflight' };
    return { ok: true };
  }

  function claimInterject({ groupKey, eventKey, limits, now: at = now() }) {
    return tx(() => {
      q("UPDATE interject_log SET status='released' WHERE group_key=? AND status='claimed' AND at<=?").run(groupKey, at - limits.leaseMs);
      const peek = peekInterject({ groupKey, limits, now: at });
      if (!peek.ok) return peek;
      const id = randomUUID();
      q("INSERT INTO interject_log(id, group_key, event_key, status, local_day, at) VALUES (?, ?, ?, 'claimed', ?, ?)")
        .run(id, groupKey, eventKey, shanghaiDay(at), at);
      return { ok: true, id };
    });
  }

  function peekCounter(key) {
    const row = q('SELECT value, expires_at FROM counters WHERE key=?').get(key);
    return row && row.expires_at > now() ? row.value : 0;
  }

  function bumpCounter(key, expiresAt, max) {
    return tx(() => {
      const value = peekCounter(key);
      if (max !== undefined && max !== null && value >= max) return { ok: false, value };
      q(`INSERT INTO counters(key, value, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at`).run(key, value + 1, expiresAt);
      return { ok: true, value: value + 1 };
    });
  }

  function insertSendParts({ eventKey, groupKey, kind, parts, rate, now: at = now() }) {
    if (!Array.isArray(parts) || parts.length === 0) return { ok: false, reason: 'no_parts' };
    return tx(() => {
      if (rate) {
        const live = "state<>'aborted'";
        const minute = q(`SELECT COUNT(*) AS n FROM sends WHERE created_at>? AND ${live}`).get(at - 60000).n;
        if (minute + parts.length > rate.accountPerMin) return { ok: false, reason: 'account_minute' };
        const hour = q(`SELECT COUNT(*) AS n FROM sends WHERE created_at>? AND ${live}`).get(at - HOUR).n;
        if (hour + parts.length > rate.accountPerHour) return { ok: false, reason: 'account_hour' };
        const group = q(`SELECT COUNT(*) AS n FROM sends WHERE group_key=? AND created_at>? AND ${live}`).get(groupKey, at - 60000).n;
        if (group + parts.length > rate.groupPerMin) return { ok: false, reason: 'group_minute' };
      }
      let seq = q('SELECT COALESCE(MAX(msg_seq), 0) AS m FROM sends WHERE event_key=?').get(eventKey).m;
      const rows = parts.map((p, part) => {
        seq += 1;
        const sendId = `${eventKey}:${seq}`;
        q(`INSERT INTO sends(send_id, event_key, group_key, kind, msg_seq, part, text_sha, state, run_gen, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
          .run(sendId, eventKey, groupKey, kind, seq, part, p.textSha, runGen, at, at);
        return { sendId, msgSeq: seq, part };
      });
      return { ok: true, rows };
    });
  }

  // How long until `need` more parts would fit every send limit. Infinity if they never could.
  function sendWaitMs({ groupKey, need, rate, now: at = now() }) {
    const live = "state<>'aborted'";
    const windows = [
      { limit: rate.accountPerMin, span: 60000, rows: q(`SELECT created_at AS t FROM sends WHERE created_at>? AND ${live} ORDER BY created_at`).all(at - 60000) },
      { limit: rate.accountPerHour, span: HOUR, rows: q(`SELECT created_at AS t FROM sends WHERE created_at>? AND ${live} ORDER BY created_at`).all(at - HOUR) },
      { limit: rate.groupPerMin, span: 60000, rows: q(`SELECT created_at AS t FROM sends WHERE group_key=? AND created_at>? AND ${live} ORDER BY created_at`).all(groupKey, at - 60000) },
    ];
    let wait = 0;
    for (const { limit, span, rows } of windows) {
      if (need > limit) return Infinity;
      const over = rows.length + need - limit;
      if (over > 0) wait = Math.max(wait, rows[over - 1].t + span - at);
    }
    return wait;
  }

  function markHolds(eventKey, fromCategory, status, counts, label) {
    const cond = fromCategory ? ' AND category=?' : '';
    const args = fromCategory ? [status, eventKey, fromCategory] : [status, eventKey];
    const r = q(`UPDATE reservations SET status=? WHERE event_key=? AND status='held'${cond}`).run(...args);
    counts[label] += Number(r.changes);
    return Number(r.changes);
  }

  function setPaidPaused(reason) {
    const old = getControl('paid_paused');
    if (old !== null && pauseRank(old) > pauseRank(reason)) return false;
    setControl('paid_paused', reason, 'recovery');
    addAlert('paid_paused', { reason });
    return true;
  }

  // Section 4.4. Runs on rows left by an earlier generation only.
  function recoverOnStart(at = now()) {
    return tx(() => {
      const counts = {
        restart_dropped: 0, crash_unknown: 0, completed: 0, holds_unsettled: 0, holds_released: 0,
        claims_released: 0, sends_uncertain: 0, sends_aborted: 0, paid_paused: 0,
      };
      const uncertainEvents = new Set();
      for (const s of q("SELECT send_id, event_key, state FROM sends WHERE state IN ('pending','sending') AND run_gen<>?").all(runGen)) {
        const next = s.state === 'sending' ? 'uncertain' : 'aborted';
        q('UPDATE sends SET state=?, updated_at=? WHERE send_id=?').run(next, at, s.send_id);
        counts[next === 'uncertain' ? 'sends_uncertain' : 'sends_aborted'] += 1;
        if (next === 'uncertain') uncertainEvents.add(s.event_key);
      }
      const end = (key, state) => {
        q("UPDATE events SET state=?, reason='restart', updated_at=? WHERE event_key=?").run(state, at, key);
        counts[state] += 1;
      };
      const releaseClaim = (key) => {
        counts.claims_released += Number(q("UPDATE interject_log SET status='released' WHERE event_key=? AND status='claimed'").run(key).changes);
      };
      const open = q(`SELECT event_key, state FROM events WHERE state IN (${placeholders(NON_TERMINAL_STATES.length)}) AND run_gen<>?`)
        .all(...NON_TERMINAL_STATES, runGen);
      let replyUnsettled = 0;
      for (const ev of open) {
        const key = ev.event_key;
        if (ev.state === 'received' || ev.state === 'queued') {
          end(key, 'restart_dropped');
        } else if (ev.state === 'deciding') {
          markHolds(key, null, 'unsettled', counts, 'holds_unsettled');
          releaseClaim(key);
          end(key, 'restart_dropped');
        } else if (ev.state === 'approved') {
          // The reply model never ran, so its hold is released. Anything else held stays conservative.
          markHolds(key, 'reply', 'released', counts, 'holds_released');
          markHolds(key, null, 'unsettled', counts, 'holds_unsettled');
          releaseClaim(key);
          end(key, 'restart_dropped');
        } else if (ev.state === 'dispatching') {
          replyUnsettled += markHolds(key, null, 'unsettled', counts, 'holds_unsettled');
          end(key, 'crash_unknown');
          addAlert('crash_unknown', { eventKey: key, state: ev.state });
        } else {
          replyUnsettled += markHolds(key, null, 'unsettled', counts, 'holds_unsettled');
          const parts = q('SELECT state FROM sends WHERE event_key=?').all(key);
          if (parts.length > 0 && parts.every((p) => p.state === 'sent')) {
            end(key, 'completed');
          } else {
            end(key, 'crash_unknown');
            if (uncertainEvents.has(key)) addAlert('crash_send_uncertain', { eventKey: key, state: ev.state });
          }
        }
      }
      // An old hold with no open event (for example a crash inside finish) is unknown money, never free.
      counts.holds_unsettled += Number(q("UPDATE reservations SET status='unsettled' WHERE status='held' AND run_gen<>?").run(runGen).changes);
      if (replyUnsettled > 0 && setPaidPaused('crash_unsettled')) counts.paid_paused = 1;
      setControl('connected', 'false', 'recovery');
      return counts;
    });
  }

  function spendByTier(localDay) {
    const out = { interject: 0, named: 0, addressed: 0, none: 0 };
    for (const r of q(`SELECT tier, COALESCE(SUM(CASE status WHEN 'settled' THEN actual_micros WHEN 'released' THEN 0 ELSE held_micros END), 0) AS m
                       FROM reservations WHERE local_day=? GROUP BY tier`).all(localDay)) {
      out[r.tier] = r.m;
    }
    return out;
  }

  // The v1 copy lives for retention.eventDays after the migration; a scratch copy a killed migration left, one hour.
  function sweepBackups(at, retention) {
    const out = { backup: 0, backupTmp: 0 };
    const migratedAt = Number(store.getMeta('migrated_v2_at'));
    const bak = backupFileOf(dbFile);
    if (Number.isFinite(migratedAt) && migratedAt > 0 && at - migratedAt > retention.eventDays * DAY) {
      try {
        statSync(bak);
        rmSync(bak, { force: true });
        out.backup = 1;
      } catch {
        // Already gone.
      }
    }
    const prefix = `${basename(bak)}.`;
    let names = [];
    try {
      names = readdirSync(dirname(bak));
    } catch {
      return out;
    }
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
      const file = join(dirname(bak), name);
      try {
        if (at - statSync(file).mtimeMs > HOUR) {
          rmSync(file, { force: true });
          out.backupTmp += 1;
        }
      } catch {
        // Gone, or held by a migration that is running now.
      }
    }
    return out;
  }

  const store = {
    db,
    q,
    runGen,
    now,
    close() {
      if (closed) return;
      closed = true;
      statements.clear();
      db.close();
    },
    tx,
    key: (rawId) => hmacKey(salt, rawId),
    getMeta: (key) => q('SELECT value FROM meta WHERE key=?').get(key)?.value ?? null,
    setMeta(key, value) {
      q('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
    },

    claimEvent({ eventKey, groupKey, msgTs = null, receivedAt }) {
      const at = receivedAt ?? now();
      const r = q(`INSERT OR IGNORE INTO events(event_key, group_key, state, run_gen, msg_ts, received_at, updated_at)
                   VALUES (?, ?, 'received', ?, ?, ?, ?)`).run(eventKey, groupKey, runGen, msgTs, at, at);
      if (Number(r.changes) === 1) return { fresh: true };
      return { fresh: false, state: q('SELECT state FROM events WHERE event_key=?').get(eventKey)?.state ?? null };
    },
    getEvent(eventKey) {
      return q('SELECT * FROM events WHERE event_key=?').get(eventKey) ?? null;
    },
    setClass(eventKey, cls) {
      checkToken(cls, 'class');
      q('UPDATE events SET cls=?, updated_at=? WHERE event_key=?').run(cls, now(), eventKey);
    },
    // One group's events of these classes, received since then, that have not ended. Reads only. No new index: events_state
    // and events_received both narrow it to few rows.
    openEventKeys(groupKey, classes, since) {
      return q(`SELECT event_key FROM events WHERE state IN (${placeholders(NON_TERMINAL_STATES.length)}) AND group_key=? AND cls IN (${placeholders(classes.length)}) AND received_at>=?`)
        .all(...NON_TERMINAL_STATES, groupKey, ...classes, since)
        .map((r) => r.event_key);
    },
    // The same for events already merged into one that has not ended. Reads only. merged_into has no index, so this starts
    // from the merged rows received since then and finds each target by its primary key.
    mergedIntoOpen(groupKey, classes, since) {
      return q(`SELECT m.event_key, m.merged_into FROM events m JOIN events t ON t.event_key=m.merged_into WHERE m.state='merged' AND m.group_key=? AND m.cls IN (${placeholders(classes.length)}) AND m.received_at>=? AND t.state IN (${placeholders(NON_TERMINAL_STATES.length)}) AND t.received_at>=?`)
        .all(groupKey, ...classes, since, ...NON_TERMINAL_STATES, since)
        .map((r) => ({ eventKey: r.event_key, mergedInto: r.merged_into }));
    },
    transition(eventKey, fromStates, toState, { reason = null, mergedInto = null } = {}) {
      const from = Array.isArray(fromStates) ? fromStates : [fromStates];
      if (!ALL_STATES.has(toState)) throw new TypeError(`store.transition: unknown state ${toState}`);
      for (const s of from) {
        if (!ALL_STATES.has(s)) throw new TypeError(`store.transition: unknown state ${s}`);
        if (TERMINAL.has(s)) throw new TypeError(`store.transition: ${s} is terminal`);
      }
      checkToken(reason, 'reason');
      const r = q(`UPDATE events SET state=?, reason=?, merged_into=?, updated_at=? WHERE event_key=? AND state IN (${placeholders(from.length)})`)
        .run(toState, reason, mergedInto, now(), eventKey, ...from);
      return Number(r.changes) === 1;
    },
    recoverOnStart,

    getControl,
    controlUpdatedAt,
    setControl,
    delControl,
    pauseState(groupKey) {
      return {
        global: getControl('global_paused') !== null,
        group: groupKey ? getControl(`group_paused:${groupKey}`) !== null : false,
        interject: getControl('interject_paused') !== null,
        paid: getControl('paid_paused'),
        terminal: getControl('terminal_close'),
      };
    },

    peekInterject,
    claimInterject,
    consumeInterject(id, at = now()) {
      const r = q("UPDATE interject_log SET status='consumed', at=?, local_day=? WHERE id=? AND status='claimed'").run(at, shanghaiDay(at), id);
      return Number(r.changes) === 1;
    },
    releaseInterject(id) {
      return Number(q("UPDATE interject_log SET status='released' WHERE id=? AND status='claimed'").run(id).changes) === 1;
    },
    bumpCounter,
    peekCounter,

    insertSendParts,
    sendWaitMs,
    markSend(sendId, state, { qqCode = null, httpStatus = null, refKey = null } = {}) {
      return tx(() => {
        const row = q('SELECT state FROM sends WHERE send_id=?').get(sendId);
        if (!row || !SEND_MOVES[row.state]?.has(state)) return false;
        q(`UPDATE sends SET state=?, qq_code=COALESCE(?, qq_code), http_status=COALESCE(?, http_status),
           ref_key=COALESCE(?, ref_key), updated_at=? WHERE send_id=?`).run(state, qqCode, httpStatus, refKey, now(), sendId);
        return true;
      });
    },
    getSend(sendId) {
      return q('SELECT * FROM sends WHERE send_id=?').get(sendId) ?? null;
    },
    sendsForEvent(eventKey) {
      return q('SELECT * FROM sends WHERE event_key=? ORDER BY msg_seq').all(eventKey);
    },
    addBotRef(refKey, groupKey, eventKey) {
      q('INSERT OR IGNORE INTO bot_refs(ref_key, group_key, event_key, created_at) VALUES (?, ?, ?, ?)').run(refKey, groupKey, eventKey, now());
    },
    hasBotRef(refKey, groupKey) {
      return q('SELECT 1 AS y FROM bot_refs WHERE ref_key=? AND group_key=?').get(refKey, groupKey) !== undefined;
    },

    addAlert,
    listAlerts({ sinceMs = 0, unackedOnly = false } = {}) {
      const rows = q(`SELECT id, at, kind, detail, suppressed, acked_at FROM alerts WHERE at>=?${unackedOnly ? ' AND acked_at IS NULL' : ''} ORDER BY id`).all(sinceMs);
      return rows.map((a) => ({ id: a.id, at: a.at, kind: a.kind, detail: JSON.parse(a.detail), suppressed: a.suppressed, ackedAt: a.acked_at }));
    },
    ackAlerts(ids) {
      tx(() => {
        for (const id of ids) q('UPDATE alerts SET acked_at=? WHERE id=? AND acked_at IS NULL').run(now(), id);
      });
    },

    spendByTier,
    statusSnapshot(at = now()) {
      const day = shanghaiDay(at);
      const events = {};
      for (const r of q('SELECT state, COUNT(*) AS n FROM events WHERE received_at>=? GROUP BY state').all(shanghaiDayStart(at))) events[r.state] = r.n;
      const number = (key) => {
        const v = getControl(key);
        return v === null ? null : Number(v);
      };
      const unsettled = q("SELECT COUNT(*) AS n, COALESCE(SUM(held_micros), 0) AS m FROM reservations WHERE status='unsettled'").get();
      return {
        paused: {
          global: getControl('global_paused') !== null,
          interject: getControl('interject_paused') !== null,
          groups: q("SELECT key FROM control WHERE key LIKE 'group_paused:%'").all().map((r) => r.key.slice('group_paused:'.length)),
        },
        paidPaused: getControl('paid_paused'),
        // The hard-cap pause of each kind that has one: {kind: code}. Which kind is active is the caller's to know.
        hardCapPaused: Object.fromEntries(q("SELECT key, value FROM control WHERE key LIKE 'hard_cap_paused:%' ORDER BY key").all()
          .map((r) => [r.key.slice('hard_cap_paused:'.length), r.value])),
        decisionPausedAt: controlUpdatedAt('decision_paused'),
        terminalClose: getControl('terminal_close'),
        connected: getControl('connected') === 'true',
        lastReadyAt: number('last_ready_at'),
        lastEventAt: number('last_event_at'),
        heartbeatAt: number('heartbeat_at'),
        spendToday: spendByTier(day),
        unsettled: unsettled.n,
        unsettledMicros: unsettled.m,
        eventsToday: events,
        sendsUncertain: q("SELECT COUNT(*) AS n FROM sends WHERE state='uncertain'").get().n,
        alerts: store.listAlerts({ unackedOnly: true }),
        botRefsSeen: q('SELECT COUNT(*) AS n FROM bot_refs').get().n,
        // A dedupe answer (qq_code set) is marked sent with no response body, so it says nothing about ref_idx.
        sendsNoRef: q("SELECT COUNT(*) AS n FROM sends WHERE state='sent' AND ref_key IS NULL AND qq_code IS NULL").get().n,
        skipClassToday: peekCounter(`skip_class:${day}`),
      };
    },

    armDiscovery(untilMs) {
      setControl('discovery_until', Math.min(untilMs, now() + DISCOVERY_MAX_MS), 'cli');
    },
    recordDiscovery({ groupId, memberId = null, now: at = now() }) {
      const until = getControl('discovery_until');
      if (until === null || Number(until) <= at) return false;
      const member = memberId ?? '';
      return tx(() => {
        const known = q('SELECT 1 AS y FROM discovery WHERE group_id=? AND member_id=?').get(groupId, member);
        if (!known && q('SELECT COUNT(*) AS n FROM discovery').get().n >= DISCOVERY_MAX_ROWS) return false;
        q(`INSERT INTO discovery(group_id, member_id, first_seen, last_seen, count) VALUES (?, ?, ?, ?, 1)
           ON CONFLICT(group_id, member_id) DO UPDATE SET last_seen=excluded.last_seen, count=count+1`).run(groupId, member, at, at);
        return true;
      });
    },
    listDiscovery() {
      return q('SELECT group_id, member_id, first_seen, last_seen, count FROM discovery ORDER BY first_seen').all()
        .map((r) => ({ groupId: r.group_id, memberId: r.member_id || null, firstSeen: r.first_seen, lastSeen: r.last_seen, count: r.count }));
    },
    clearDiscovery() {
      tx(() => {
        q('DELETE FROM discovery').run();
        delControl('discovery_until');
      });
    },

    janitor(at, retention) {
      const removed = tx(() => {
        const removed = {};
        const count = (name, r) => { removed[name] = Number(r.changes); };
        const terminal = [...TERMINAL];
        count('events', q(`DELETE FROM events WHERE received_at<? AND state IN (${placeholders(terminal.length)})`)
          .run(at - retention.eventDays * DAY, ...terminal));
        count('sends', q("DELETE FROM sends WHERE created_at<? AND state NOT IN ('pending','sending')").run(at - retention.sendDays * DAY));
        count('botRefs', q('DELETE FROM bot_refs WHERE created_at<?').run(at - retention.sendDays * DAY));
        count('reservations', q("DELETE FROM reservations WHERE created_at<? AND status IN ('settled','released')").run(at - retention.reservationDays * DAY));
        count('interject', q('DELETE FROM interject_log WHERE at<?').run(at - 2 * DAY));
        count('counters', q('DELETE FROM counters WHERE expires_at<=?').run(at));
        count('alerts', q('DELETE FROM alerts WHERE acked_at IS NOT NULL AND acked_at<?').run(at - retention.eventDays * DAY));
        count('snapshots', q('DELETE FROM key_snapshots WHERE taken_at<?').run(at - SNAPSHOT_KEEP_MS));
        return removed;
      });
      return Object.assign(removed, sweepBackups(at, retention));
    },
  };
  return store;
}
