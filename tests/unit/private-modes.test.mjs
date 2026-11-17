// Off Windows, what the project writes is owner-only: 0700 folders and 0600 files, whatever the umask. Each case runs
// in a child under umask 022, and the same child shows first that a plain write there comes out 0644 (the control).
// Doctor fails on a .env, gateway.token or clo.db that group or others can reach, and warns on config.json.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { makeContext } from '../../src/cli/common.mjs';
import { formatDoctor, FULL_LEVEL, runDoctor } from '../../src/cli/doctor.mjs';
import { openStore } from '../../src/clo-plugin/lib/core/store.js';
import { cleanChildEnv } from '../harness/clean-env.mjs';
import { IS_WINDOWS, NODE } from '../harness/platform.mjs';
import { clo, enabledConfig, fakeProvider, makeRoot, NET_GUARD, ROOT, testEnv } from './_cli-helper.mjs';

const NOT_WINDOWS = IS_WINDOWS ? 'not Windows: Windows has no mode bits, and its writes are unchanged' : false;
const mod = (rel) => pathToFileURL(join(ROOT, rel)).href;
const modeOf = (p) => statSync(p).mode & 0o777;
const temps = [];
const roots = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
  for (const r of roots) r.cleanup();
});
const tempDir = (label) => {
  const d = mkdtempSync(join(tmpdir(), `clo-modes-${label}-`));
  temps.push(d);
  return d;
};

// Runs an ES module body in a child under umask 022 and returns what it printed as JSON. `dir` is its scratch folder.
function underUmask022(body, dir) {
  const script = `process.umask(0o022);\nconst dir = ${JSON.stringify(dir)};\n${body}`;
  const r = spawnSync(NODE, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { env: cleanChildEnv(), encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const PRELUDE = `
import { appendFileSync, chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const m = (p) => statSync(p).mode & 0o777;
`;

describe('owner-only modes off Windows', { skip: NOT_WINDOWS }, () => {
  test('writeAtomic: a new file is 0600 in a new 0700 folder, and a 0644 or 0400 file it replaces comes out 0600', () => {
    const out = underUmask022(`${PRELUDE}
import { writeAtomic } from ${JSON.stringify(mod('src/clo-plugin/lib/core/render.js'))};
writeFileSync(join(dir, 'plain'), 'x');
mkdirSync(join(dir, 'plain-dir'));
writeAtomic(join(dir, 'new', 'deeper', 'file'), 'secret');
writeFileSync(join(dir, 'wide'), 'old');
writeAtomic(join(dir, 'wide'), 'new');
writeFileSync(join(dir, 'strict'), 'old');
chmodSync(join(dir, 'strict'), 0o400);
writeAtomic(join(dir, 'strict'), 'new');
console.log(JSON.stringify({ plain: m(join(dir, 'plain')), plainDir: m(join(dir, 'plain-dir')), file: m(join(dir, 'new', 'deeper', 'file')), dir: m(join(dir, 'new')), deeper: m(join(dir, 'new', 'deeper')), wide: m(join(dir, 'wide')), strict: m(join(dir, 'strict')) }));
`, tempDir('atomic'));
    assert.equal(out.plain, 0o644, 'control: a plain write under this umask is 0644');
    assert.equal(out.plainDir, 0o755, 'control: a plain folder is 0755');
    assert.equal(out.file, 0o600);
    assert.equal(out.dir, 0o700);
    assert.equal(out.deeper, 0o700);
    assert.equal(out.wide, 0o600);
    // Decided: a stricter mode is not kept. The project must still read and rewrite the file.
    assert.equal(out.strict, 0o600);
  });

  test('openStore: clo.db and its -wal and -shm are 0600, and a db an earlier build left 0644 is narrowed', () => {
    const out = underUmask022(`${PRELUDE}
import { DatabaseSync } from 'node:sqlite';
import { existsSync, rmSync } from 'node:fs';
import { openStore } from ${JSON.stringify(mod('src/clo-plugin/lib/core/store.js'))};
const modes = (f) => ({ db: m(f), wal: existsSync(f + '-wal') ? m(f + '-wal') : null, shm: existsSync(f + '-shm') ? m(f + '-shm') : null });
// Control: what SQLite itself makes under this umask, while the connection is open.
mkdirSync(join(dir, 'control'));
const raw = new DatabaseSync(join(dir, 'control', 'x.db'));
raw.exec('PRAGMA journal_mode=WAL');
raw.exec('CREATE TABLE t(x)');
const control = modes(join(dir, 'control', 'x.db'));
raw.close();
// A fresh store, read while it is open so -wal and -shm exist.
const fresh = join(dir, 'fresh', 'clo.db');
const a = openStore(fresh);
const res = { control, fresh: { ...modes(fresh), dir: m(join(dir, 'fresh')) } };
a.close();
// An empty db file an earlier build left 0644: narrowed by opening it.
mkdirSync(join(dir, 'old'));
const old = join(dir, 'old', 'clo.db');
const raw2 = new DatabaseSync(old);
raw2.exec('PRAGMA user_version=0');
raw2.close();
res.before = m(old);
const c = openStore(old);
res.after = modes(old);
c.close();
console.log(JSON.stringify(res));
`, tempDir('store'));
    assert.deepEqual(out.control, { db: 0o644, wal: 0o644, shm: 0o644 }, 'control: SQLite makes 0644 files under this umask');
    assert.deepEqual(out.fresh, { db: 0o600, wal: 0o600, shm: 0o600, dir: 0o700 });
    assert.equal(out.before, 0o644, 'control: the earlier file is wide before it is opened');
    assert.deepEqual(out.after, { db: 0o600, wal: 0o600, shm: 0o600 });
  });

  test('event log and gateway.log: new files 0600 in a 0700 folder, and a 0644 one is narrowed', () => {
    const out = underUmask022(`${PRELUDE}
import { createLog } from ${JSON.stringify(mod('src/clo-plugin/lib/core/log.js'))};
import { openAppendPrivate } from ${JSON.stringify(mod('src/clo-plugin/lib/core/private-fs.js'))};
import { closeSync } from 'node:fs';
appendFileSync(join(dir, 'plain.jsonl'), 'x\\n');
createLog(join(dir, 'logs', 'events.jsonl'))('cli_apply', {});
writeFileSync(join(dir, 'old.jsonl'), 'x\\n');
const before = m(join(dir, 'old.jsonl'));
createLog(join(dir, 'old.jsonl'))('cli_apply', {});
closeSync(openAppendPrivate(join(dir, 'logs', 'gateway.log')));
writeFileSync(join(dir, 'old-gateway.log'), 'x\\n');
closeSync(openAppendPrivate(join(dir, 'old-gateway.log')));
console.log(JSON.stringify({ plain: m(join(dir, 'plain.jsonl')), events: m(join(dir, 'logs', 'events.jsonl')), logs: m(join(dir, 'logs')), before, old: m(join(dir, 'old.jsonl')), gw: m(join(dir, 'logs', 'gateway.log')), oldGw: m(join(dir, 'old-gateway.log')) }));
`, tempDir('log'));
    assert.equal(out.plain, 0o644, 'control');
    assert.equal(out.before, 0o644, 'control');
    assert.deepEqual([out.events, out.logs, out.old, out.gw, out.oldGw], [0o600, 0o700, 0o600, 0o600, 0o600]);
  });

  test('gateway.token and the Q0 salt are 0600 whether new or left 0644, in 0700 folders', () => {
    const out = underUmask022(`${PRELUDE}
import { ensureGatewayToken } from ${JSON.stringify(mod('src/cli/lifecycle.mjs'))};
import { loadSalt } from ${JSON.stringify(mod('src/tools/qq-listener.mjs'))};
const paths = { runtime: join(dir, 'rt'), cloDir: join(dir, 'rt', 'clo') };
ensureGatewayToken(paths);
const res = { token: m(join(dir, 'rt', 'clo', 'gateway.token')), clo: m(join(dir, 'rt', 'clo')), rt: m(join(dir, 'rt')) };
const old = { runtime: join(dir, 'old'), cloDir: join(dir, 'old', 'clo') };
mkdirSync(old.cloDir, { recursive: true });
writeFileSync(join(old.cloDir, 'gateway.token'), 'a'.repeat(64));
res.oldBefore = m(join(old.cloDir, 'gateway.token'));
res.same = ensureGatewayToken(old) === 'a'.repeat(64);
res.oldAfter = m(join(old.cloDir, 'gateway.token'));
const salt = loadSalt(join(dir, 'q0', 'q0-salt'));
res.salt = m(join(dir, 'q0', 'q0-salt'));
res.saltDir = m(join(dir, 'q0'));
writeFileSync(join(dir, 'old-salt'), 'b'.repeat(64));
res.oldSaltBefore = m(join(dir, 'old-salt'));
res.oldSaltSame = loadSalt(join(dir, 'old-salt')) === 'b'.repeat(64);
res.oldSalt = m(join(dir, 'old-salt'));
res.saltLen = salt.length;
console.log(JSON.stringify(res));
`, tempDir('token'));
    assert.equal(out.oldBefore, 0o644, 'control');
    assert.equal(out.oldSaltBefore, 0o644, 'control');
    assert.deepEqual([out.token, out.clo, out.rt], [0o600, 0o700, 0o700]);
    assert.equal(out.same, true, 'the existing token is kept');
    assert.equal(out.oldAfter, 0o600);
    assert.deepEqual([out.salt, out.saltDir, out.oldSalt, out.saltLen], [0o600, 0o700, 0o600, 64]);
    assert.equal(out.oldSaltSame, true);
  });

  test('Q5 result files and the Q0b DM target are 0600, new or left 0644 by an earlier run', () => {
    const out = underUmask022(`${PRELUDE}
import { resultWriter as q5Writer } from ${JSON.stringify(mod('src/tools/q5-probe.mjs'))};
import { resultWriter as anthropicWriter } from ${JSON.stringify(mod('src/tools/q5-anthropic.mjs'))};
import { saveDmTarget } from ${JSON.stringify(mod('src/tools/qq-send-probe.mjs'))};
const res = {};
for (const [name, make] of [['q5', q5Writer], ['anthropic', anthropicWriter]]) {
  const fresh = join(dir, name, 'new', 'r.jsonl');
  make(fresh, [])({ outcome: 'ok' });
  const old = join(dir, name, 'old.jsonl');
  writeFileSync(old, '{}\\n');
  const control = m(old);
  make(old, [])({ outcome: 'ok' });
  res[name] = { fresh: m(fresh), freshDir: m(join(dir, name, 'new')), control, old: m(old) };
}
const target = join(dir, 'q0b-dm-target');
writeFileSync(target, 'OLD');
res.targetControl = m(target);
saveDmTarget(target, 'NEW');
res.target = m(target);
saveDmTarget(join(dir, 'fresh-target'), 'NEW');
res.freshTarget = m(join(dir, 'fresh-target'));
console.log(JSON.stringify(res));
`, tempDir('q5'));
    for (const name of ['q5', 'anthropic']) {
      assert.equal(out[name].control, 0o644, `${name}: control, the old file starts wide`);
      assert.deepEqual([out[name].fresh, out[name].freshDir, out[name].old], [0o600, 0o700, 0o600], name);
    }
    assert.equal(out.targetControl, 0o644, 'control');
    assert.deepEqual([out.target, out.freshTarget], [0o600, 0o600]);
  });

  test('clo apply narrows what an earlier build left wide under .runtime, and leaves .env and config.json to the user', () => {
    const r = makeRoot('apply-modes');
    roots.push(r);
    const rt = join(r.root, '.runtime');
    for (const d of [rt, join(rt, 'clo'), join(rt, 'logs'), join(rt, 'state')]) {
      mkdirSync(d, { recursive: true });
      chmodSync(d, 0o755);
    }
    const files = [join(rt, 'clo', 'effective.json'), join(rt, 'clo', 'gateway.token'), join(rt, 'clo', 'clo.db'), join(rt, 'logs', 'events.jsonl'), join(rt, 'q0-salt')];
    for (const f of files) {
      writeFileSync(f, f.endsWith('.json') ? '{}' : 'x');
      chmodSync(f, 0o644);
    }
    chmodSync(join(r.root, '.env'), 0o644);
    chmodSync(join(r.root, 'config.json'), 0o644);
    const out = underUmask022(`
import { main } from ${JSON.stringify(mod('src/cli/clo.mjs'))};
import { statSync } from 'node:fs';
import { join } from 'node:path';
let text = '';
const code = await main(['apply'], { env: { CLO_TEST_ROOT: dir }, fetch: () => { throw new Error('no network'); }, stdout: { write: (s) => { text += s; } }, stderr: { write: (s) => { text += s; } } });
console.log(JSON.stringify({ code, text }));
`, r.root);
    assert.equal(out.code, 0, out.text);
    for (const d of [rt, join(rt, 'clo'), join(rt, 'logs'), join(rt, 'state'), join(rt, 'workspace'), join(rt, 'home')]) assert.equal(modeOf(d), 0o700, d);
    for (const f of [...files, join(rt, 'clo', 'system-prompt.md')]) assert.equal(modeOf(f), 0o600, f);
    // The user's files keep the mode they had: apply narrows only what is under the runtime folder.
    assert.equal(modeOf(join(r.root, '.env')), 0o644);
    assert.equal(modeOf(join(r.root, 'config.json')), 0o644);
  });

  test('ensurePrivateDirs refuses a folder outside the runtime folder and changes nothing there', async () => {
    const { ensurePrivateDirs } = await import('../../src/clo-plugin/lib/core/private-fs.js');
    const base = tempDir('outside');
    const rt = join(base, '.runtime');
    const outside = join(base, 'repo-folder');
    mkdirSync(outside);
    chmodSync(outside, 0o755);
    ensurePrivateDirs(rt, [join(rt, 'clo')]);
    assert.equal(modeOf(join(rt, 'clo')), 0o700, 'control: a folder inside is made 0700');
    assert.throws(() => ensurePrivateDirs(rt, [outside]), /outside the runtime folder/);
    assert.throws(() => ensurePrivateDirs(rt, [join(rt, '..', 'repo-folder')]), /outside the runtime folder/);
    assert.equal(modeOf(outside), 0o755);
  });

  test('doctor: secret_modes fails on a .env, gateway.token or clo.db others can reach; config.json only warns', async () => {
    const r = makeRoot('doctor-modes', enabledConfig());
    roots.push(r);
    const res = await clo(r.root, ['model', 'refresh'], { fetch: fakeProvider().fetch });
    assert.equal(res.code, 0, res.err);
    const ctx = makeContext({ env: testEnv(r.root, { CLO_TEST_NODE_IMPORT: NET_GUARD }), fetch: () => { throw new Error('no network'); }, stdout: { write() {} }, stderr: { write() {} } });
    const answer = () => ({ status: 0, stdout: JSON.stringify({ plugin: { status: 'loaded' }, typedHooks: [{ name: 'before_agent_run' }, { name: 'before_prompt_build' }, { name: 'before_tool_call' }], policy: { allowConversationAccess: true } }) });
    const run = () => runDoctor(ctx, { level: FULL_LEVEL, run: answer });
    const check = (report, id) => report.checks.find((c) => c.id === id);
    const env = join(r.root, '.env');
    const cfg = join(r.root, 'config.json');
    const token = join(r.root, '.runtime', 'clo', 'gateway.token');
    const db = join(r.root, '.runtime', 'clo', 'clo.db');
    writeFileSync(token, 'a'.repeat(64), { mode: 0o600 });
    openStore(db).close();
    chmodSync(cfg, 0o600);

    const clean = run();
    assert.deepEqual(clean.failed, [], formatDoctor(clean));
    assert.equal(check(clean, 'secret_modes').ok, true, 'control: all owner-only');
    assert.equal(check(clean, 'file_modes').ok, true, 'control');

    for (const [file, name] of [[env, '.env'], [token, '.runtime/clo/gateway.token'], [db, '.runtime/clo/clo.db']]) {
      chmodSync(file, 0o640);
      const bad = run();
      assert.deepEqual(bad.failed, ['secret_modes'], name);
      assert.equal(bad.ok, false);
      assert.ok(check(bad, 'secret_modes').detail.includes(name), check(bad, 'secret_modes').detail);
      chmodSync(file, 0o600);
      assert.equal(check(run(), 'secret_modes').ok, true, `${name}: 0600 passes again`);
    }

    chmodSync(cfg, 0o644);
    const warned = run();
    assert.deepEqual(warned.failed, [], 'config.json does not fail doctor');
    assert.equal(warned.ok, true);
    const fm = check(warned, 'file_modes');
    assert.equal(fm.ok, false);
    assert.equal(fm.severity, 'warn');
    assert.match(fm.detail, /config\.json/);
    // No absolute path in the detail.
    assert.ok(!fm.detail.includes(r.root));
  });
});

test('positive control for the platform condition: the describe above runs here unless this is Windows', () => {
  assert.equal(NOT_WINDOWS === false, !IS_WINDOWS);
});
