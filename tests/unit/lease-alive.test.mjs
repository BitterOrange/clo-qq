// The consumer lease's "is that PID alive" off Windows: a process that has exited and was not collected by its parent
// still answers signal 0, and must not keep the lease held. The stand-in is a private Node this file spawned, and it
// is only ever signalled by a PID this file holds the handle of.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import { CONSUMER_LEASE_KEY, exitedUncollected, LEASE_STALE_MS, liveBotLease, pidAlive } from '../../src/clo-plugin/lib/channels/qq/lease.js';
import { cleanChildEnv } from '../harness/clean-env.mjs';
import { LINUX_ONLY, NODE } from '../harness/platform.mjs';

const started = [];
after(() => {
  for (const child of started) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

const stateOf = (pid) => {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/)[0];
  } catch {
    return null;
  }
};
const waitSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

async function standIn() {
  const child = spawn(NODE, ['-e', "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"], { cwd: tmpdir(), env: cleanChildEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
  started.push(child);
  child.on('error', () => {});
  await new Promise((res, rej) => {
    child.stdout.once('data', res);
    child.once('exit', () => rej(new Error('the stand-in ended before it came up')));
  });
  return child;
}

test('pidAlive: this process is alive, and a PID that cannot be one is not', () => {
  assert.equal(pidAlive(process.pid), true);
  for (const bad of [0, -1, 1.5, NaN, null, undefined, '12']) assert.equal(pidAlive(bad), false, String(bad));
});

test('an exited process nobody collected is not alive, though signal 0 still reaches it', { skip: LINUX_ONLY }, async () => {
  const child = await standIn();
  const { pid } = child;
  assert.equal(pidAlive(pid), true, 'positive control: alive while it runs');
  // No await from here to the last assert, so this process cannot collect the child in between.
  process.kill(pid, 'SIGKILL');
  const end = Date.now() + 5000;
  while (stateOf(pid) !== 'Z' && Date.now() < end) waitSync(20);
  assert.equal(stateOf(pid), 'Z', 'positive control: exited and still in the table');
  assert.doesNotThrow(() => process.kill(pid, 0), 'positive control: signal 0 alone would call it alive');
  assert.equal(child.exitCode, null);
  assert.equal(pidAlive(pid), false);

  // The lease read the console and the Gateway use takes the same answer.
  const at = 1000000;
  const store = { getControl: (k) => (k === CONSUMER_LEASE_KEY ? `${pid}:x` : null), controlUpdatedAt: () => at };
  assert.equal(liveBotLease({ store, now: () => at + 1 }), null);
  assert.deepEqual(liveBotLease({ store, now: () => at + 1, isAlive: () => true }), { pid }, 'positive control: the same lease is held when its process is alive');
  assert.equal(liveBotLease({ store, now: () => at + LEASE_STALE_MS, isAlive: () => true }), null, 'positive control: and a stale one is not');
});

test('a PID with no process is not alive, and a running one that is not ours is', { skip: LINUX_ONLY }, async () => {
  const child = await standIn();
  const { pid } = child;
  const exited = new Promise((res) => { child.once('exit', res); });
  child.kill('SIGKILL');
  await exited;
  assert.equal(stateOf(pid), null, 'positive control: collected, so no entry is left');
  assert.equal(pidAlive(pid), false);
  // PID 1 is not this process's child and is running: whatever /proc shows of it, it counts as alive.
  assert.equal(pidAlive(1), true);
});

test('a stat that cannot be read, or a /proc that is not this process\'s view, does not count as exited', () => {
  const pid = 4242;
  const stat = (p, state) => `${p} (node) ${state} 1 ${p} ${p} 0 -1 0 0 0 0 0 0 0 0 20 0 1 0 12345 0 0`;
  const view = (files) => (path) => {
    if (!(path in files)) throw Object.assign(new Error('no entry'), { code: 'EACCES' });
    return files[path];
  };
  const self = { '/proc/self/stat': stat(process.pid, 'R') };
  // Positive control: the same reader with a readable Z entry says exited.
  assert.equal(exitedUncollected(pid, view({ ...self, [`/proc/${pid}/stat`]: stat(pid, 'Z') })), true);
  assert.equal(exitedUncollected(pid, view({ ...self, [`/proc/${pid}/stat`]: stat(pid, 'X') })), true);
  assert.equal(exitedUncollected(pid, view({ ...self, [`/proc/${pid}/stat`]: stat(pid, 'S') })), false);
  assert.equal(exitedUncollected(pid, view(self)), false, 'an unreadable entry');
  assert.equal(exitedUncollected(pid, view({})), false, 'an unreadable /proc/self');
  assert.equal(exitedUncollected(pid, view({ '/proc/self/stat': stat(process.pid + 1, 'R'), [`/proc/${pid}/stat`]: stat(pid, 'Z') })), false, 'another namespace\'s /proc');
  assert.equal(exitedUncollected(pid, view({ ...self, [`/proc/${pid}/stat`]: stat(pid + 1, 'Z') })), false, 'an entry for another PID');
  assert.equal(exitedUncollected(pid, view({ ...self, [`/proc/${pid}/stat`]: 'garbage' })), false, 'an entry that does not parse');
});
