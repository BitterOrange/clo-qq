// Two real processes race on one real SQLite file. Nothing here is simulated.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openStore } from '../../src/clo-plugin/lib/core/store.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NODE = join(ROOT, '.runtime', 'node', 'node.exe');
const core = (f) => pathToFileURL(join(ROOT, 'src', 'clo-plugin', 'lib', 'core', f)).href;
const dir = mkdtempSync(join(tmpdir(), 'clo-quota-'));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
const LIMITS = { cooldownMs: 0, perHour: 1000, perDay: 1000, leaseMs: 120000 };

const WORKER = `
import { openStore } from ${JSON.stringify(core('store.js'))};
import { createLedger } from ${JSON.stringify(core('ledger.js'))};
const job = JSON.parse(process.argv[2]);
if (job.kind === 'open') while (Date.now() < job.startAt) { /* barrier before the first touch of the file */ }
const store = openStore(job.db, { runGen: job.name });
const eff = { budget: { dailyUsd: 2.5, interjectUsd: 0.75, searchUsd: 2.1, namedUsd: 2.25, addressedUsd: 2.5 } };
const ledger = createLedger({ store, getEffective: () => eff, fetch: async () => { throw new Error('no network'); }, getKey: () => null });
while (Date.now() < job.startAt) { /* barrier: both processes start together */ }
const out = { attempts: 0, won: 0, ids: [], refused: {} };
for (let i = 0; i < job.iterations; i += 1) {
  let r;
  out.attempts += 1;
  if (job.kind === 'claim') {
    r = store.claimInterject({ groupKey: 'G', eventKey: job.name + i, limits: ${JSON.stringify(LIMITS)} });
    if (r.ok) out.ids.push(r.id);
  } else if (job.kind === 'reserve') {
    r = ledger.reserve({ tier: 'interject', category: 'decision', heldMicros: 10000, eventKey: job.name + i });
  } else if (job.kind === 'counter') {
    r = store.bumpCounter('name_dec:G:1', Date.now() + 3600000, 25);
  } else if (job.kind === 'open') {
    r = store.claimEvent({ eventKey: 'same', groupKey: 'G', receivedAt: Date.now() });
    r = { ok: r.fresh, reason: 'dup' };
  } else if (job.kind === 'parts') {
    r = store.insertSendParts({ eventKey: job.name + i, groupKey: 'G', kind: 'reply', parts: [{ textSha: 'a' }, { textSha: 'b' }], rate: { accountPerMin: 1000, accountPerHour: 1000, groupPerMin: 40 } });
  }
  if (r.ok) out.won += 1;
  else out.refused[r.reason ?? 'max'] = (out.refused[r.reason ?? 'max'] ?? 0) + 1;
}
store.close();
process.stdout.write(JSON.stringify(out));
`;
const workerFile = join(dir, 'worker.mjs');
writeFileSync(workerFile, WORKER);

function race(kind, iterations, db = join(dir, `${kind}.db`)) {
  if (kind !== 'open') openStore(db, { runGen: 'prep' }).close();
  const startAt = Date.now() + 1500;
  const run = (name) => new Promise((res, rej) => {
    const child = spawn(NODE, [workerFile, JSON.stringify({ db, name, kind, iterations, startAt })], {
      cwd: dir,
      env: { SystemRoot: process.env.SystemRoot, NODE_NO_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => (code === 0 ? res(JSON.parse(out)) : rej(new Error(`worker ${name} exit ${code}: ${err}`))));
  });
  return Promise.all([run('a'), run('b')]).then((results) => ({ results, db }));
}

test('private Node is what runs these', () => {
  assert.equal(resolve(process.execPath).toLowerCase(), NODE.toLowerCase());
});

test('two processes creating the same new database both succeed and share one salt', { timeout: 60000 }, async () => {
  const { results, db } = await race('open', 1);
  const [a, b] = results;
  assert.equal(a.attempts + b.attempts, 2);
  assert.equal(a.won + b.won, 1, 'one event row, one winner');
  const store = openStore(db, { runGen: 'check' });
  assert.equal(store.q("SELECT COUNT(*) AS n FROM meta WHERE key='hmac_salt'").get().n, 1);
  store.close();
});

test('interject claim: exactly one process wins a group while the lease lives', { timeout: 60000 }, async () => {
  const { results, db } = await race('claim', 50);
  const [a, b] = results;
  assert.equal(a.attempts + b.attempts, 100, 'both processes really ran');
  assert.equal(a.won + b.won, 1);
  assert.equal((a.refused.inflight ?? 0) + (b.refused.inflight ?? 0), 99);
  const store = openStore(db, { runGen: 'check' });
  assert.equal(store.q("SELECT COUNT(*) AS n FROM interject_log WHERE status='claimed'").get().n, 1);
  store.close();
});

test('tier reservation: the cap holds across processes, and both had to be refused', { timeout: 60000 }, async () => {
  const { results, db } = await race('reserve', 60);
  const [a, b] = results;
  assert.equal(a.won + b.won, 75, '$0.75 at $0.01 each');
  assert.equal((a.refused.tier ?? 0) + (b.refused.tier ?? 0), 45);
  const store = openStore(db, { runGen: 'check' });
  assert.equal(store.q('SELECT SUM(held_micros) AS m FROM reservations').get().m, 750000);
  store.close();
});

test('counter cap holds across processes', { timeout: 60000 }, async () => {
  const { results, db } = await race('counter', 20);
  const [a, b] = results;
  assert.equal(a.won + b.won, 25);
  const store = openStore(db, { runGen: 'check' });
  assert.equal(store.peekCounter('name_dec:G:1'), 25);
  store.close();
});

test('send rate holds across processes and never splits a reply', { timeout: 60000 }, async () => {
  const { results, db } = await race('parts', 30);
  const [a, b] = results;
  assert.equal(a.won + b.won, 20, 'forty parts a minute at two parts a reply');
  const store = openStore(db, { runGen: 'check' });
  assert.equal(store.q('SELECT COUNT(*) AS n FROM sends').get().n, 40);
  const uneven = store.q('SELECT event_key FROM sends GROUP BY event_key HAVING COUNT(*)<>2').all();
  assert.deepEqual(uneven, []);
  store.close();
});
