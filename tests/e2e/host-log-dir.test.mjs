// Where the host's own file log goes. openclaw.json names logging.file under .runtime/logs/host, and both levels stay
// silent, so a real run writes no host log at all. The default location is outside the project: /tmp/openclaw off
// Windows (shared by every user's runs), the temp folder on Windows. Nothing may land there from these runs.
// The positive control raises the level through the test-mode seam in gatewayEnv (CLO_TEST_HOST_LOG_LEVEL becomes
// OPENCLAW_LOG_LEVEL, which outranks the config): the host then does write, and only under that stack's .runtime.
// The Gateway env here holds only the harness's fake keys, so the info-level log sees no real secret.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fullAt, nextId, push } from '../fixtures/qq-events.mjs';
import { FAKE_MODEL_KEY, FAKE_QQ_SECRET, startStack, unexpectedNetAttempts } from '../harness/gateway.mjs';
import { IS_WINDOWS } from '../harness/platform.mjs';

const LOG_NAME = /^openclaw-\d{4}-\d{2}-\d{2}\.log$/;
const USER_TEXT = 'HOSTLOGBODYCANARY5521';
const PROVIDER_TEXT = 'HOSTLOGPROVIDERCANARY5521';
const stacks = [];
after(async () => {
  for (const s of stacks) {
    await s.stop().catch(() => {});
    s.cleanup();
  }
});

// The host's default log folders for a stack: off Windows the fixed /tmp/openclaw, and the openclaw-<uid> fallback
// under the stack's temp folder; on Windows openclaw under the stack's temp folder (the harness sets TEMP there).
function defaultDirs(s) {
  const temp = join(s.tmp, 'temp');
  const under = existsSync(temp) ? readdirSync(temp).filter((n) => n === 'openclaw' || n.startsWith('openclaw-')).map((n) => join(temp, n)) : [];
  return IS_WINDOWS ? under : ['/tmp/openclaw', ...under];
}

// Every file under the given folders, with size and mtime, so a file that was appended to also counts as changed.
function snapshot(dirs) {
  const out = new Map();
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          const st = statSync(p);
          out.set(p, `${st.size}:${st.mtimeMs}`);
        } catch {
          // Gone between the listing and the stat: another run's file, not ours to judge.
        }
      }
    }
  };
  for (const d of dirs) walk(d);
  return out;
}
const changed = (before, now) => [...now].filter(([p, v]) => before.get(p) !== v).map(([p]) => p);

const hostDir = (s) => join(s.paths.logsDir, 'host');
const hostFiles = (s) => (existsSync(hostDir(s)) ? readdirSync(hostDir(s)) : []);

// One @ turn end to end, so the host has run a model call and a delivery while the log was set.
async function oneTurn(s) {
  await s.waitConnected();
  const id = nextId();
  push(s, fullAt(`问一句 ${USER_TEXT}`, { id }));
  const row = await s.waitRow(id);
  assert.equal(`${row.state}:${row.reason}`, 'completed:sent');
  assert.equal(s.postBodies().at(-1).content, '好的。');
}

// Taken before the Gateway starts. The stack's own temp folder is new, so only the shared folder can hold anything.
// `more` runs further turns on the same stack before it stops.
async function run(label, parentEnv, more = async () => {}) {
  const beforeAll = snapshot(IS_WINDOWS ? [] : ['/tmp/openclaw']);
  const s = await startStack({ label, script: () => ({ text: '好的。' }), parentEnv });
  stacks.push(s);
  await oneTurn(s);
  await more(s);
  await s.stop();
  return { s, beforeAll };
}

test('positive control: the folder comparison sees a new file and a file that was appended to', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clo-hostlog-snap-'));
  try {
    const sub = join(dir, 'openclaw-0');
    mkdirSync(sub);
    writeFileSync(join(dir, 'old.log'), 'a');
    const before = snapshot([dir]);
    assert.deepEqual(changed(before, snapshot([dir])), [], 'unchanged: nothing');
    appendFileSync(join(dir, 'old.log'), 'b');
    writeFileSync(join(sub, 'new.log'), 'c');
    assert.deepEqual(changed(before, snapshot([dir])).sort(), [join(dir, 'old.log'), join(sub, 'new.log')].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rendered config: silent, and named inside .runtime/logs/host; the host writes no file there or in its default folder', { timeout: 300000 }, async () => {
  const { s, beforeAll } = await run('hostlog-silent', {});
  assert.deepEqual(s.config.logging, { level: 'silent', consoleLevel: 'silent', file: join(s.paths.logsDir, 'host', 'openclaw-YYYY-MM-DD.log') });
  assert.equal(s.childEnv.OPENCLAW_LOG_LEVEL, undefined, 'no level override in the env clo start builds');
  assert.deepEqual(hostFiles(s), [], 'silent: no host log file');
  assert.deepEqual(changed(beforeAll, snapshot(defaultDirs(s))), [], 'nothing new or changed in the default folder');
  assert.deepEqual(unexpectedNetAttempts(s.gw), []);
});

test('positive control: the level raised through the test-mode seam writes a dated log under that .runtime only', { timeout: 300000 }, async () => {
  // A second @ turn whose provider error carries a canary: at info the host writes provider error text to its log.
  const failedTurn = async (s) => {
    await s.acceptUnsettled();
    s.model.setScript(() => ({ error: { status: 403, body: { error: { code: 403, message: `flagged ${PROVIDER_TEXT}`, metadata: { provider_name: 'mock' } } } } }));
    const id = nextId();
    push(s, fullAt('再问一句', { id }));
    assert.equal((await s.waitRow(id)).state, 'failed');
  };
  const { s, beforeAll } = await run('hostlog-info', { CLO_TEST_HOST_LOG_LEVEL: 'info' }, failedTurn);
  assert.equal(s.childEnv.OPENCLAW_LOG_LEVEL, 'info', 'the seam reached the child env');
  assert.equal(s.config.logging.level, 'silent', 'the config itself is unchanged: the env outranks it');
  const files = hostFiles(s);
  assert.ok(files.length > 0, 'the host wrote its file log');
  for (const f of files) assert.match(f, LOG_NAME, 'daily rolling name, so the host prunes it after 24 h');
  const text = files.map((f) => readFileSync(join(hostDir(s), f), 'utf8')).join('\n');
  assert.ok(text.length > 0, 'and it is not empty');
  // Provider error text does land here at a raised level (README says so). It is also the positive control for the
  // key checks below: the same scan of the same text finds a planted string.
  assert.ok(text.includes(PROVIDER_TEXT), 'the provider error text is in the info-level host log');
  for (const secret of [FAKE_MODEL_KEY, FAKE_QQ_SECRET]) assert.ok(!text.includes(secret), 'a key in the host log');
  assert.deepEqual(changed(beforeAll, snapshot(defaultDirs(s))), [], 'nothing new or changed in the default folder');
  assert.deepEqual(unexpectedNetAttempts(s.gw), []);
});
