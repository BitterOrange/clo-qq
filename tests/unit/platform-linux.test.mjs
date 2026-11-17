// The non-Windows side of src/cli/platform.mjs: tying a PID to a process through /proc, and ending only what was
// started. The /proc fixtures are built in a temp folder at run time. Every stand-in is a private Node this file
// spawned, and is only ever signalled by its handle or by a PID checked against its start time.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, afterEach, describe, test } from 'node:test';
import { descendantsOf, endRecordedTree, endSpawnedChild, IS_WINDOWS as SRC_IS_WINDOWS, linuxChildEnv, lookupProcessLinux, parseProcStat, privateNodePath, procRootOf, sameBinary, snapshotLeft } from '../../src/cli/platform.mjs';
import { cleanChildEnv } from '../harness/clean-env.mjs';
import { IS_WINDOWS, LINUX_ONLY, NODE, WINDOWS_ONLY } from '../harness/platform.mjs';
import { ROOT } from './_cli-helper.mjs';

const BOOT = '11111111-2222-3333-4444-555555555555';
const statLine = ({ pid, comm = 'node', state = 'S', ppid = 1, pgrp = pid, session = pid, ticks = '777' }) => `${pid} (${comm}) ${state} ${ppid} ${pgrp} ${session} 0 -1 4194304 87 0 0 0 0 0 0 0 20 0 1 0 ${ticks} 2928640 362 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0 0 0 0 0 0 0 0 0\n`;

// --- Pure: these read no file and start nothing, so they run everywhere. ---

test('parseProcStat counts fields from the last parenthesis, so a command name with ") (" in it reads right', () => {
  const plain = parseProcStat(statLine({ pid: 4242, ppid: 7, pgrp: 4242, session: 4000, ticks: '123456' }));
  assert.deepEqual(plain, { pid: 4242, state: 'S', ppid: 7, pgrp: 4242, session: 4000, startTicks: '123456' }, 'positive control: a plain name');
  const odd = parseProcStat(statLine({ pid: 4242, comm: 'a) R 1 (b c', ppid: 7, pgrp: 4242, session: 4000, ticks: '123456' }));
  assert.deepEqual(odd, plain);
  for (const bad of ['', 'no parentheses 1 2 3', '12 (node) S 1 2', 'x (node) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22', null, undefined, 7]) {
    assert.equal(parseProcStat(bad), null, String(bad));
  }
  assert.equal(parseProcStat(statLine({ pid: 4242, ticks: 'abc' })), null, 'a start time that is not a number');
});

test('the private Node path matches the one the harness writes out for this platform', () => {
  assert.equal(SRC_IS_WINDOWS, IS_WINDOWS);
  assert.equal(IS_WINDOWS, process.platform === 'win32');
  assert.equal(privateNodePath(ROOT), NODE);
  if (!IS_WINDOWS) assert.equal(privateNodePath('/srv/clo'), '/srv/clo/.runtime/node/bin/node');
});

test('the skip reasons: false where a test runs, a reason where it does not', () => {
  assert.equal(WINDOWS_ONLY === false, IS_WINDOWS);
  assert.equal(LINUX_ONLY === false, process.platform === 'linux');
  for (const reason of [WINDOWS_ONLY, LINUX_ONLY]) assert.ok(reason === false || (typeof reason === 'string' && reason.length > 10));
});

test('only test mode can point the lookup at another folder', () => {
  assert.equal(procRootOf({}), '/proc');
  assert.equal(procRootOf({ CLO_TEST_PROC_ROOT: 'elsewhere' }), '/proc', 'ignored without CLO_TEST_ROOT');
  assert.equal(procRootOf({ CLO_TEST_ROOT: 'r' }), '/proc');
  assert.equal(procRootOf({ CLO_TEST_ROOT: 'r', CLO_TEST_PROC_ROOT: 'elsewhere' }), resolve('elsewhere'), 'positive control');
});

// --- Shared by the Linux suites. ---

const roots = [];
function fixture({ self = true, boot = true, entries = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'clo-platform-'));
  roots.push(dir);
  const proc = join(dir, 'proc');
  mkdirSync(join(proc, 'sys', 'kernel', 'random'), { recursive: true });
  if (boot) writeFileSync(join(proc, 'sys', 'kernel', 'random', 'boot_id'), `${BOOT}\n`);
  if (self) {
    mkdirSync(join(proc, 'self'));
    writeFileSync(join(proc, 'self', 'stat'), statLine({ pid: self === true ? process.pid : self }));
  }
  const add = ({ pid, exe = true, statDir = false, cmdline = 'node\0--flag\0entry.mjs\0', ...rest }) => {
    mkdirSync(join(proc, String(pid)), { recursive: true });
    if (statDir) mkdirSync(join(proc, String(pid), 'stat'));
    else writeFileSync(join(proc, String(pid), 'stat'), statLine({ pid, ...rest }));
    if (exe) symlinkSync(NODE, join(proc, String(pid), 'exe'));
    if (cmdline !== null) writeFileSync(join(proc, String(pid), 'cmdline'), cmdline);
  };
  for (const e of entries) add(e);
  return { proc, add, env: { CLO_TEST_ROOT: dir, CLO_TEST_PROC_ROOT: proc } };
}
const dropRoots = () => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
};
const coded = (code) => () => { throw Object.assign(new Error(code), { code }); };
const noPause = () => {};
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const realStat = (pid) => {
  try {
    return parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return null;
  }
};
const outcomeOf = (pid) => lookupProcessLinux(pid).outcome;
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(25);
  }
  return fn();
}

describe('lookup against a /proc built for the test', { skip: LINUX_ONLY }, () => {
  after(dropRoots);

  test('a readable entry is found, with the boot id and start ticks as its identity', () => {
    const f = fixture({ entries: [{ pid: 4242, ticks: '98765' }] });
    assert.deepEqual(lookupProcessLinux(4242, f.env), {
      outcome: 'found',
      info: { startTime: `linux:${BOOT}:98765`, commandLine: `linux-proc:${BOOT}:4242:98765`, argv: 'node --flag entry.mjs' },
    });
    // Another start time is another identity, in both fields.
    const g = fixture({ entries: [{ pid: 4242, ticks: '98766' }] });
    const other = lookupProcessLinux(4242, g.env).info;
    assert.notEqual(other.startTime, `linux:${BOOT}:98765`);
    assert.notEqual(other.commandLine, `linux-proc:${BOOT}:4242:98765`);
  });

  test('a PID that is not a positive integer is gone without reading anything', () => {
    const f = fixture({ entries: [{ pid: 4242 }] });
    const probed = [];
    for (const pid of [0, -1, -4242, 1.5, NaN, '4242', null, undefined]) {
      assert.deepEqual(lookupProcessLinux(pid, f.env, { probe: (p) => probed.push(p) }), { outcome: 'gone' }, String(pid));
    }
    assert.deepEqual(probed, [], 'the kernel is never asked about such a PID');
    assert.equal(lookupProcessLinux(4242, f.env).outcome, 'found', 'positive control');
  });

  test('without its own entry, or with someone else\'s, the folder is not trusted', () => {
    assert.deepEqual(lookupProcessLinux(4242, fixture({ self: false, entries: [{ pid: 4242 }] }).env), { outcome: 'unknown' });
    assert.deepEqual(lookupProcessLinux(4242, fixture({ self: process.pid + 1, entries: [{ pid: 4242 }] }).env), { outcome: 'unknown' }, 'another PID namespace');
    assert.equal(lookupProcessLinux(4242, fixture({ entries: [{ pid: 4242 }] }).env).outcome, 'found', 'positive control: the same folder with a matching self');
  });

  test('without a boot id nothing is known', () => {
    assert.deepEqual(lookupProcessLinux(4242, fixture({ boot: false, entries: [{ pid: 4242 }] }).env), { outcome: 'unknown' });
    assert.equal(lookupProcessLinux(4242, fixture({ entries: [{ pid: 4242 }] }).env).outcome, 'found', 'positive control');
  });

  test('an exited process nobody reaped is gone', () => {
    for (const state of ['Z', 'X']) {
      assert.deepEqual(lookupProcessLinux(4242, fixture({ entries: [{ pid: 4242, state }] }).env), { outcome: 'gone' }, state);
    }
    for (const state of ['S', 'R', 'D', 'T']) {
      assert.equal(lookupProcessLinux(4242, fixture({ entries: [{ pid: 4242, state }] }).env).outcome, 'found', `positive control: ${state}`);
    }
  });

  test('a stat that cannot be read as a file, or does not parse, says nothing', () => {
    const probed = [];
    const probe = (p) => { probed.push(p); throw Object.assign(new Error('x'), { code: 'ESRCH' }); };
    assert.deepEqual(lookupProcessLinux(4242, fixture({ entries: [{ pid: 4242, statDir: true }] }).env, { probe }), { outcome: 'unknown' });
    assert.deepEqual(lookupProcessLinux(4242, fixture({ entries: [{ pid: 4242, ticks: 'junk' }] }).env, { probe }), { outcome: 'unknown' });
    // An entry that names another PID is not this process.
    const f = fixture();
    mkdirSync(join(f.proc, '4242'));
    writeFileSync(join(f.proc, '4242', 'stat'), statLine({ pid: 4243 }));
    assert.deepEqual(lookupProcessLinux(4242, f.env, { probe }), { outcome: 'unknown' });
    assert.deepEqual(probed, [], 'the kernel is only asked when there is no entry');
    assert.deepEqual(lookupProcessLinux(4244, f.env, { probe }), { outcome: 'gone' }, 'positive control: no entry and the kernel agrees');
    assert.deepEqual(probed, [4244]);
  });

  test('no entry is gone only when the kernel says so too', () => {
    const f = fixture({ entries: [{ pid: 4242 }] });
    const asked = [];
    assert.deepEqual(lookupProcessLinux(4300, f.env, { probe: (p) => { asked.push(p); coded('ESRCH')(); } }), { outcome: 'gone' });
    assert.deepEqual(asked, [4300], 'positive control: the probe ran, for that PID');
    assert.deepEqual(lookupProcessLinux(4300, f.env, { probe: coded('EPERM') }), { outcome: 'unknown' }, 'it exists and is hidden');
    assert.deepEqual(lookupProcessLinux(4300, f.env, { probe: () => {} }), { outcome: 'unknown' }, 'it exists and is hidden');
    assert.deepEqual(lookupProcessLinux(4300, f.env, { probe: coded('EINVAL') }), { outcome: 'unknown' });
  });

  test('with no exe link the process is found, and its command line is withheld', () => {
    const f = fixture({ entries: [{ pid: 4242, exe: false, ticks: '555' }, { pid: 4243, ticks: '556' }] });
    const got = lookupProcessLinux(4242, f.env, { pause: noPause });
    assert.equal(got.outcome, 'found');
    assert.equal(got.info.startTime, `linux:${BOOT}:555`);
    assert.equal(got.info.commandLine, null);
    assert.equal(lookupProcessLinux(4243, f.env, { pause: noPause }).info.commandLine, `linux-proc:${BOOT}:4243:556`, 'positive control: with the link');
  });

  test('a missing exe link gets one more look after a short wait, except for a kernel thread', () => {
    const f = fixture({ entries: [{ pid: 4242, exe: false }, { pid: 4250, exe: false, ppid: 2 }, { pid: 2, exe: false, ppid: 0 }, { pid: 4260 }] });
    const waits = [];
    const pause = (ms) => waits.push(ms);
    assert.equal(lookupProcessLinux(4242, f.env, { pause }).info.commandLine, null);
    assert.deepEqual(waits, [50], 'positive control: exactly one wait, of about 50 ms');
    waits.length = 0;
    assert.equal(lookupProcessLinux(4250, f.env, { pause }).info.commandLine, null);
    assert.equal(lookupProcessLinux(2, f.env, { pause }).info.commandLine, null);
    assert.equal(lookupProcessLinux(4260, f.env, { pause }).outcome, 'found');
    assert.deepEqual(waits, [], 'no wait for a kernel thread, and none when the link reads');
  });

  test('the second look is what gets answered: exited by then is gone, readable by then is found in full', () => {
    const f = fixture({ entries: [{ pid: 4242, exe: false, ticks: '9' }, { pid: 4243, exe: false, ticks: '9' }, { pid: 4244, exe: false }] });
    const exits = () => writeFileSync(join(f.proc, '4242', 'stat'), statLine({ pid: 4242, state: 'Z', ticks: '9' }));
    assert.deepEqual(lookupProcessLinux(4242, f.env, { pause: exits }), { outcome: 'gone' });
    const appears = () => symlinkSync(NODE, join(f.proc, '4243', 'exe'));
    assert.equal(lookupProcessLinux(4243, f.env, { pause: appears }).info.commandLine, `linux-proc:${BOOT}:4243:9`);
    const vanishes = () => rmSync(join(f.proc, '4244'), { recursive: true });
    assert.deepEqual(lookupProcessLinux(4244, f.env, { pause: vanishes, probe: coded('ESRCH') }), { outcome: 'gone' });
  });

  test('descendants are found by parent links, and a folder that cannot be listed gives null', () => {
    const f = fixture({ entries: [
      { pid: 100, ppid: 1, ticks: '1' }, { pid: 101, ppid: 100, ticks: '2' }, { pid: 102, ppid: 101, ticks: '3' }, { pid: 103, ppid: 100, ticks: '4' },
      { pid: 200, ppid: 1, ticks: '5' }, { pid: 201, ppid: 200, ticks: '6' },
    ] });
    const sorted = (list) => [...list].sort((a, b) => a.pid - b.pid);
    assert.deepEqual(sorted(descendantsOf(100, f.proc)), [{ pid: 101, startTicks: '2' }, { pid: 102, startTicks: '3' }, { pid: 103, startTicks: '4' }]);
    assert.deepEqual(descendantsOf(102, f.proc), []);
    assert.equal(descendantsOf(100, join(f.proc, 'missing')), null);
  });
});

describe('live processes: identity, and ending only what was started', { skip: LINUX_ONLY }, () => {
  const started = [];
  // Whatever a failed test left behind. A child by its handle; a grandchild only while it still has the start time
  // it had when this file learned its PID.
  const sweep = () => {
    for (const s of started.splice(0)) {
      endSpawnedChild(s.child);
      for (const g of [s.grand, s.self]) {
        if (!g || g.pid <= 1) continue;
        const now = realStat(g.pid);
        if (now && now.startTicks === g.startTicks && now.state !== 'Z') process.kill(g.pid, 'SIGKILL');
      }
    }
  };
  after(() => { sweep(); dropRoots(); });
  afterEach(sweep);

  // A private Node that idles. It can start one idle child of its own, ignore SIGTERM, and rename itself on request.
  const STAND_IN = `
    const { spawn } = require('node:child_process');
    const opts = JSON.parse(process.argv[1]);
    if (opts.trapTerm) process.on('SIGTERM', () => {});
    let grand = 0;
    if (opts.grandchild) grand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: {}, stdio: 'ignore' }).pid;
    process.stdin.on('data', () => { process.title = 'clo-test-renamed'; console.log('renamed'); });
    process.stdin.on('error', () => {});
    setInterval(() => {}, 1000);
    console.log('ready ' + grand);
  `;
  async function standIn({ detached = true, grandchild = false, trapTerm = false } = {}) {
    const child = spawn(NODE, ['-e', STAND_IN, JSON.stringify({ grandchild, trapTerm }), 'known-argument'], { env: cleanChildEnv(), detached, stdio: ['pipe', 'pipe', 'ignore'] });
    const s = { child, pid: child.pid, grand: null, self: null, lines: [] };
    started.push(s);
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const parts = buf.split('\n');
      buf = parts.pop();
      s.lines.push(...parts);
    });
    child.on('error', () => {});
    assert.ok(await until(() => s.lines.length > 0), 'the stand-in came up');
    const grandPid = Number(/^ready (\d+)$/.exec(s.lines[0])?.[1]);
    s.self = { pid: child.pid, startTicks: realStat(child.pid)?.startTicks };
    if (grandchild) {
      assert.ok(grandPid > 1, 'the stand-in reported its child');
      assert.ok(await until(() => realStat(grandPid)?.ppid === child.pid), 'the grandchild is there');
      s.grand = { pid: grandPid, startTicks: realStat(grandPid).startTicks };
    }
    s.record = () => ({ pid: child.pid, startTime: lookupProcessLinux(child.pid).info.startTime });
    return s;
  }
  // Still the process this file learned about, and not exited.
  const sameAlive = (g) => {
    const now = realStat(g.pid);
    return Boolean(now && now.startTicks === g.startTicks && now.state !== 'Z' && now.state !== 'X');
  };
  const recorder = () => {
    const calls = [];
    return { calls, kill: (...a) => { calls.push(a); return true; } };
  };

  test('this process is found on the real /proc, and the test folder is only used in test mode', () => {
    const me = lookupProcessLinux(process.pid);
    assert.equal(me.outcome, 'found');
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const ticks = realStat(process.pid).startTicks;
    assert.match(boot, /^[0-9a-f-]{36}$/);
    assert.equal(me.info.startTime, `linux:${boot}:${ticks}`);
    assert.equal(me.info.commandLine, `linux-proc:${boot}:${process.pid}:${ticks}`);
    assert.match(me.info.argv, /platform-linux\.test\.mjs/);
    const missing = join(tmpdir(), 'clo-platform-no-such-proc');
    assert.equal(lookupProcessLinux(process.pid, { CLO_TEST_PROC_ROOT: missing }).outcome, 'found', 'ignored outside test mode');
    assert.deepEqual(lookupProcessLinux(process.pid, { CLO_TEST_ROOT: 'x', CLO_TEST_PROC_ROOT: missing }), { outcome: 'unknown' }, 'positive control: test mode reads it');
  });

  test('a PID above the kernel\'s limit is gone', () => {
    const max = Number(readFileSync('/proc/sys/kernel/pid_max', 'utf8'));
    assert.ok(max > 1, 'positive control: the limit was read');
    assert.deepEqual(lookupProcessLinux(max + 1), { outcome: 'gone' });
  });

  test('a process that renames itself keeps its identity', async () => {
    const s = await standIn();
    const before = lookupProcessLinux(s.pid).info;
    assert.match(before.argv, /known-argument/);
    s.child.stdin.write('x');
    assert.ok(await until(() => s.lines.includes('renamed')));
    const after = lookupProcessLinux(s.pid).info;
    assert.notEqual(after.argv, before.argv, 'positive control: what the process shows as its command line did change');
    assert.match(after.argv, /clo-test-renamed/);
    assert.equal(after.startTime, before.startTime);
    assert.equal(after.commandLine, before.commandLine);
    assert.ok(before.commandLine);
  });

  test('a killed child that nobody reaped reads gone', async () => {
    const s = await standIn({ detached: false });
    assert.equal(outcomeOf(s.pid), 'found', 'positive control');
    // No await from here to the last assert, so this process cannot reap the child in between.
    process.kill(s.pid, 'SIGKILL');
    const end = Date.now() + 5000;
    while (outcomeOf(s.pid) !== 'gone' && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    assert.equal(outcomeOf(s.pid), 'gone');
    assert.equal(realStat(s.pid)?.state, 'Z', 'positive control: it was still in the table, unreaped');
    assert.equal(s.child.exitCode, null);
  });

  test('endRecordedTree ends the recorded process and its child, and nothing else', async () => {
    const target = await standIn({ grandchild: true });
    const bystander = await standIn({ grandchild: true });
    const leader = realStat(target.pid);
    assert.equal(leader.pgrp, target.pid, 'a detached child leads its group');
    assert.equal(leader.session, target.pid);
    assert.equal(realStat(target.grand.pid).pgrp, target.pid, 'and its child stays in it');
    const listed = endRecordedTree(target.record(), {});
    assert.deepEqual(listed.map((d) => d.pid), [target.grand.pid], 'it returns the descendant it listed');
    assert.ok(await until(() => outcomeOf(target.pid) === 'gone'), 'the recorded process ended');
    assert.ok(await until(() => !sameAlive(target.grand)), 'its child ended');
    assert.deepEqual(snapshotLeft(listed, {}), [], 'and snapshotLeft reads it as gone');
    assert.equal(outcomeOf(bystander.pid), 'found', 'the bystander is untouched');
    assert.ok(sameAlive(bystander.grand), 'and so is its child');
  });

  test('snapshotLeft lists only a listed descendant that is still the same, unexited process', async () => {
    const s = await standIn({ grandchild: true });
    const grand = realStat(s.grand.pid);
    const entry = { pid: s.grand.pid, startTicks: grand.startTicks };
    assert.deepEqual(snapshotLeft([entry], {}), [entry], 'positive control: a running descendant is left');
    assert.deepEqual(snapshotLeft([{ ...entry, startTicks: grand.startTicks + 1 }], {}), [], 'another start time is not ours');
    const f = fixture({ entries: [] });
    assert.deepEqual(snapshotLeft([entry], f.env), [], 'a test /proc proves nothing, so nothing is waited on');
    assert.deepEqual(snapshotLeft(null, {}), []);
    endRecordedTree(s.record(), {});
    assert.ok(await until(() => snapshotLeft([entry], {}).length === 0), 'after the kill it is gone');
  });

  test('a snapshotted descendant is also ended by its own PID, for one that left the group', async () => {
    const target = await standIn({ grandchild: true });
    const sent = [];
    // The group kill is recorded and held back, so only the per-PID kill of the snapshot can end the grandchild.
    const kill = (pid, sig) => {
      sent.push([pid, sig]);
      if (pid > 0) process.kill(pid, sig);
    };
    endRecordedTree(target.record(), {}, { kill });
    assert.deepEqual(sent, [[-target.pid, 'SIGKILL'], [target.grand.pid, 'SIGKILL']]);
    assert.ok(await until(() => !sameAlive(target.grand)), 'the grandchild ended by its own PID');
    assert.equal(outcomeOf(target.pid), 'found', 'positive control: the held-back group kill is what ends the leader');
  });

  test('a record with another start time sends nothing', async () => {
    const s = await standIn();
    const right = s.record();
    const { calls, kill } = recorder();
    for (const wrong of [{ ...right, startTime: `${right.startTime}0` }, { ...right, startTime: '2026-11-01T00:00:00.0000000Z' }, { ...right, startTime: null }, { pid: right.pid }, { ...right, pid: String(right.pid) }, null, {}]) {
      endRecordedTree(wrong, {}, { kill });
      endRecordedTree(wrong, {});
    }
    assert.deepEqual(calls, []);
    await sleep(300);
    assert.equal(outcomeOf(s.pid), 'found', 'the stand-in is still alive');
    endRecordedTree(right, {}, { kill });
    assert.deepEqual(calls, [[-s.pid, 'SIGKILL']], 'positive control: the right record does signal');
    endRecordedTree(right, {});
    assert.ok(await until(() => outcomeOf(s.pid) === 'gone'), 'positive control: and ends it');
  });

  test('with a test /proc in use nothing is signalled, even when it matches a real PID', async () => {
    const s = await standIn();
    const f = fixture({ entries: [{ pid: s.pid, pgrp: s.pid, session: s.pid, ticks: '4321' }] });
    const fake = lookupProcessLinux(s.pid, f.env);
    assert.equal(fake.outcome, 'found', 'the folder does describe this PID as a session leader');
    const record = { pid: s.pid, startTime: fake.info.startTime };
    const { calls, kill } = recorder();
    endRecordedTree(record, f.env, { kill });
    assert.equal(endSpawnedChild(s.child, f.env, { kill }), false);
    assert.deepEqual(calls, [], 'no signal was even attempted');
    // And with the real kill left in place.
    endRecordedTree(record, f.env);
    assert.equal(endSpawnedChild(s.child, f.env), false);
    await sleep(300);
    assert.equal(outcomeOf(s.pid), 'found', 'the stand-in is still alive');
    assert.equal(s.child.exitCode, null);
    assert.equal(s.child.signalCode, null);
    // Positive control: the same calls on the real /proc reach it.
    endRecordedTree(s.record(), {}, { kill });
    assert.deepEqual(calls, [[-s.pid, 'SIGKILL']]);
    assert.equal(endSpawnedChild(s.child), true);
    assert.ok(await until(() => s.child.signalCode === 'SIGKILL'));
  });

  test('PID 1 and below are refused before any kill, and no kill is ever aimed at 0 or -1', async () => {
    const init = lookupProcessLinux(1);
    assert.equal(init.outcome, 'found', 'positive control: a record for PID 1 would match');
    const { calls, kill } = recorder();
    endRecordedTree({ pid: 1, startTime: init.info.startTime }, {}, { kill });
    for (const pid of [1, 0, -1, -2, 1.5, NaN, null, undefined, '7']) {
      endRecordedTree({ pid, startTime: init.info.startTime }, {}, { kill });
      assert.equal(endSpawnedChild({ pid, exitCode: null, signalCode: null }, {}, { kill }), false, String(pid));
    }
    // This process and its own group are never a target either.
    const me = lookupProcessLinux(process.pid);
    endRecordedTree({ pid: process.pid, startTime: me.info.startTime }, {}, { kill });
    assert.equal(endSpawnedChild({ pid: process.pid, exitCode: null, signalCode: null }, {}, { kill }), false);
    assert.deepEqual(calls, []);
    const s = await standIn();
    endRecordedTree(s.record(), {}, { kill });
    assert.equal(endSpawnedChild(s.child, {}, { kill }), true);
    assert.deepEqual(calls, [[-s.pid, 'SIGKILL'], [-s.pid, 'SIGKILL']], 'positive control: the same recorder sees a real target');
  });

  test('when descendants cannot be listed the group is still killed, and one event with no PID says so', async () => {
    const s = await standIn({ grandchild: true });
    const events = [];
    const log = (...a) => events.push(a);
    const { calls, kill } = recorder();
    endRecordedTree(s.record(), {}, { kill, log });
    assert.deepEqual(events, [], 'positive control: nothing is logged when the list reads');
    assert.deepEqual(calls, [[-s.pid, 'SIGKILL'], [s.grand.pid, 'SIGKILL']]);
    endRecordedTree(s.record(), {}, { log, descendants: () => null });
    assert.deepEqual(events, [['stop_descendants_unlisted', {}]]);
    assert.ok(!JSON.stringify(events).includes(String(s.pid)));
    assert.ok(await until(() => outcomeOf(s.pid) === 'gone'), 'the recorded process ended');
    assert.ok(await until(() => !sameAlive(s.grand)), 'and its child, through the group');
  });

  test('endSpawnedChild ends a child that ignores SIGTERM, and what it started', async () => {
    const s = await standIn({ detached: false, grandchild: true, trapTerm: true });
    assert.notEqual(realStat(s.pid).pgrp, s.pid, 'this one does not lead a group, so it is ended PID by PID');
    assert.equal(s.child.kill(), true);
    await sleep(1000);
    assert.equal(s.child.exitCode, null, 'positive control: child.kill() alone does not end it');
    assert.equal(s.child.signalCode, null);
    assert.equal(outcomeOf(s.pid), 'found');
    assert.equal(endSpawnedChild(s.child), true);
    assert.ok(await until(() => s.child.signalCode === 'SIGKILL'), 'the child ended');
    assert.ok(await until(() => !sameAlive(s.grand)), 'its child ended');
    const { calls, kill } = recorder();
    assert.equal(endSpawnedChild(s.child, {}, { kill }), false, 'a handle that saw the exit owns no PID');
    assert.equal(endSpawnedChild(s.child), false);
    assert.deepEqual(calls, []);
  });

  test('endSpawnedChild on a /proc it cannot trust signals the child\'s own PID and nothing else', async () => {
    const s = await standIn({ detached: false, grandchild: true });
    const control = recorder();
    assert.equal(endSpawnedChild(s.child, {}, { kill: control.kill }), true);
    assert.deepEqual(control.calls, [[s.pid, 'SIGKILL'], [s.grand.pid, 'SIGKILL']], 'positive control: a trusted /proc adds the descendants');
    const { calls, kill } = recorder();
    assert.equal(endSpawnedChild(s.child, {}, { kill, trusted: () => false }), true);
    assert.deepEqual(calls, [[s.pid, 'SIGKILL']]);
    const lead = await standIn({ grandchild: true });
    const led = recorder();
    assert.equal(endSpawnedChild(lead.child, {}, { kill: led.kill, trusted: () => false }), true);
    assert.deepEqual(led.calls, [[lead.pid, 'SIGKILL']], 'no group kill either');
  });

  test('endSpawnedChild takes a detached child by its group', async () => {
    const s = await standIn({ grandchild: true });
    const bystander = await standIn({ grandchild: true });
    const { calls, kill } = recorder();
    assert.equal(endSpawnedChild(s.child, {}, { kill }), true);
    assert.deepEqual(calls, [[-s.pid, 'SIGKILL']]);
    assert.equal(endSpawnedChild(s.child), true);
    assert.ok(await until(() => s.child.signalCode === 'SIGKILL'));
    assert.ok(await until(() => !sameAlive(s.grand)));
    assert.equal(outcomeOf(bystander.pid), 'found', 'the bystander is untouched');
    assert.ok(sameAlive(bystander.grand));
  });

  test('the child env additions: the private Node\'s folder as the whole PATH, and a temp folder under the runtime', () => {
    const env = linuxChildEnv({ runtime: '/srv/clo/.runtime', home: '/srv/clo/.runtime/home' }, '/srv/clo/.runtime/node/bin/node');
    assert.deepEqual(env, { PATH: '/srv/clo/.runtime/node/bin', TMPDIR: '/srv/clo/.runtime/temp' });
    assert.ok(!env.PATH.includes(':'), 'no system folder');
  });

  test('sameBinary compares what the paths resolve to', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clo-platform-'));
    roots.push(dir);
    symlinkSync(NODE, join(dir, 'node-link'));
    writeFileSync(join(dir, 'other'), '');
    assert.equal(sameBinary(NODE, process.execPath), true, 'the tests run on the private Node');
    assert.equal(sameBinary(join(dir, 'node-link'), process.execPath), true);
    assert.equal(sameBinary(join(dir, 'other'), process.execPath), false);
    assert.equal(sameBinary(join(dir, 'missing'), process.execPath), false);
    assert.equal(sameBinary(NODE, join(dir, 'missing')), false);
  });
});
