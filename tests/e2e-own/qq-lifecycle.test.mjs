// The own runtime counterpart of tests/e2e/qq-lifecycle.test.mjs: the connection's lifecycle in the real bot process.
// The host rows (channels.stop/start, channel and plugin config reloads, plugins reload, ctx.channelRuntime) have no
// counterpart: the bot has one connection per process, started and stopped by clo start and clo stop. What they
// guarded, never two sockets at once and one reply per message, is proved here across stops, restarts and a second
// process started on the same state.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { fullAt, nextId } from '../fixtures/qq-events.mjs';
import { assertEveryPostLegal, netAttempts, sleep, startBot, startOwnStack, until } from '../harness/own.mjs';

// The bot's exit codes (src/bot/main.mjs EXIT).
const REFUSED = 3;
const TERMINAL = 4;

async function oneMessageOneReply(s) {
  const model = s.agentRequests().length;
  const posts = s.messagePosts().length;
  const id = nextId();
  s.send(fullAt('在吗', { id }));
  await s.waitRow(id);
  await s.waitPosts(posts + 1);
  await sleep(500);
  assert.equal(s.agentRequests().length - model, 1);
  assert.equal(s.messagePosts().length - posts, 1);
  return id;
}

describe('running bot', () => {
  let s;

  before(async () => {
    s = await startOwnStack({ label: 'life', script: () => ({ text: '收到。' }) });
  });

  after(async () => {
    await s?.stop();
    s?.cleanup();
  });

  test('the bot opens exactly one connection with bit 25 only', () => {
    assert.equal(s.qq.opened(), 1);
    assert.equal(s.qq.connected(), 1);
    assert.equal(s.qq.identifies.length, 1);
    assert.equal(s.qq.identifies[0].intents, 1 << 25);
  });

  test('positive control: this stack answers', async () => {
    await oneMessageOneReply(s);
  });

  test('a second bot process on the same state is refused before it connects; the first keeps its one socket', async () => {
    const opened = s.qq.opened();
    const second = await startBot({ tmp: s.tmp, env: s.env, args: s.args, label: 'second', cwd: s.paths.gatewayCwd });
    let ended;
    try {
      ended = await second.waitExit(30000);
    } finally {
      // A second process that did not refuse must not outlive the test.
      if (!second.exited()) await second.kill();
    }
    assert.equal(ended.code, REFUSED);
    assert.ok(s.event('start_refused').some((e) => e.reason === 'running' && e.pid === second.pid), 'refused for the running consumer');
    assert.equal(s.qq.opened(), opened, 'it never opened a socket');
    assert.equal(s.qq.peak(), 1, 'never two sockets at once');
    assert.equal(s.bot.exited(), null, 'the first one runs on');
    await oneMessageOneReply(s);
  });

  test('a requested stop closes the socket and leaves connected false; a new start opens one', async () => {
    const ended = await s.stopBot();
    assert.equal(ended.how, 'requested', 'it stopped on the request, not by a kill');
    assert.equal(ended.code, 0);
    await until(() => s.qq.connected() === 0, 'socket closed after stop', 20000);
    assert.equal(s.control('connected'), 'false');
    assert.equal(s.control('heartbeat_at'), null, 'a stopped bot leaves no heartbeat to read as fresh');
    const opened = s.qq.opened();
    await sleep(3000);
    assert.equal(s.qq.opened(), opened, 'a stopped bot stays stopped');
    await s.start();
    assert.equal(s.qq.peak(), 1);
    assert.equal(s.control('connected'), 'true');
    await oneMessageOneReply(s);
  });

  test('a killed bot is replaced by a new start with one socket and one reply per message', async () => {
    const ended = await s.restart({ graceful: false });
    assert.equal(ended.how, 'killed');
    await until(() => s.qq.connected() === 1, 'one socket after the restart', 30000);
    assert.equal(s.qq.peak(), 1, 'never two sockets at once');
    await oneMessageOneReply(s);
  });

  test('code 1000 reconnects by RESUME and raises no alert', async () => {
    const alerts = s.alerts().length;
    const resumed = s.event('connection_resumed').length;
    s.qq.closeAll(1000);
    await until(() => s.event('connection_resumed').length > resumed, 'RESUMED after 1000', 30000);
    assert.equal(s.alerts().length, alerts);
    assert.equal(s.control('connected'), 'true');
    assert.ok(s.event('connection_disconnected').some((e) => e.closeCode === 1000));
    await oneMessageOneReply(s);
  });

  test('qq turned off in effective.json under a running bot: nothing is answered; turned on again, it answers', async () => {
    s.updateEffective({ qq: { enabled: false } });
    const model = s.agentRequests().length;
    const posts = s.messagePosts().length;
    const id = nextId();
    s.send(fullAt('关了还答吗', { id }));
    await until(() => s.event('gate_drop').some((e) => e.reason === 'qq_disabled'), 'the event to be dropped', 20000);
    await sleep(1500);
    assert.equal(s.agentRequests().length, model, 'no model call');
    assert.equal(s.messagePosts().length, posts, 'no post');
    assert.equal(s.row(id), null, 'no event row');
    s.updateEffective({ qq: { enabled: true } });
    await oneMessageOneReply(s);
  });

  test('last: every POST on this stack is legal', () => {
    assertEveryPostLegal(s, { minPosts: 6 });
    assert.deepEqual(netAttempts(s), []);
  });
});

describe('connection failures', () => {
  test('connected stays false until READY: a socket without READY is not connected', async () => {
    const s = await startOwnStack({ label: 'noready', ready: false, waitReady: false, script: () => ({ text: '好。' }) });
    try {
      await until(() => s.qq.connected() === 1 && s.qq.identifies.length === 1, 'identify', 60000);
      await until(() => s.control('heartbeat_at'), 'heartbeat', 30000);
      assert.notEqual(s.control('connected'), 'true', 'not connected before READY');
      s.qq.sendReady();
      await until(() => s.control('connected') === 'true', 'READY sets connected', 15000);
      assert.equal(s.qq.opened(), 1, 'positive control: the same socket');
    } finally {
      await s.stop();
      s.cleanup();
    }
  });

  test('startup failures and refused sockets never make it give up; it keeps retrying past the old cap of 5', async () => {
    const s = await startOwnStack({ label: 'retry', script: () => ({ text: '回来了。' }), start: false });
    try {
      s.qq.failToken(2);
      await s.start({ waitReady: false });
      await until(() => s.event('connection_start_failed').length >= 2, 'two start failures', 120000);
      await s.waitConnected(undefined, 120000);
      assert.equal(s.bot.exited(), null);
      assert.equal(s.control('terminal_close'), null);

      s.qq.refuseConnections(6);
      s.qq.terminateAll();
      await until(() => s.qq.refused() >= 6, 'six refused sockets', 180000);
      await until(() => s.qq.connected() === 1, 'reconnect after six refusals', 120000);
      await until(() => s.control('connected') === 'true', 'connected again', 30000);
      const id = nextId();
      s.send(fullAt('还在吗', { id }));
      await s.waitRow(id);
      await s.waitPosts(1);
      assert.equal(s.messagePosts().length, 1, 'positive control: replies after recovery');
      assert.equal(s.qq.peak(), 1);
    } finally {
      await s.stop();
      s.cleanup();
    }
  });

  for (const code of [4914, 4915]) {
    test(`a fatal close (${code}) ends the process, is latched, and a restart stays refused`, async () => {
      const s = await startOwnStack({ label: `fatal${code}`, script: () => ({ text: '好。' }) });
      try {
        const before_ = nextId();
        s.send(fullAt('关闭前', { id: before_ }));
        await s.waitRow(before_);
        await s.waitPosts(1);
        assert.equal(s.messagePosts().length, 1, 'positive control');
        const opened = s.qq.opened();
        s.qq.closeAll(code);
        await until(() => s.event('connection_fatal').some((e) => e.closeCode === code), 'fatal close seen', 20000);
        const ended = await s.bot.waitExit(30000);
        assert.equal(ended.code, TERMINAL, 'the bot ends rather than reconnecting');
        await sleep(3000);
        assert.equal(s.qq.opened(), opened, 'no new connection');
        assert.equal(s.qq.connected(), 0);
        assert.equal(s.control('terminal_close'), String(code));
        assert.equal(s.control('connected'), 'false');
        assert.ok(s.alerts().some((a) => a.kind === 'terminal_close' && a.detail.includes(String(code))));
        for (const a of s.alerts()) assert.ok(!/ban|封|处罚|violation/i.test(a.detail), 'quotes the code, infers no cause');

        await s.restart({ waitReady: false });
        const again = await s.bot.waitExit(60000);
        assert.equal(again.code, TERMINAL);
        assert.ok(s.event('start_refused').some((e) => e.reason === 'terminal'), 'refused start');
        assert.equal(s.qq.opened(), opened, 'no connection while latched');
      } finally {
        await s.stop();
        s.cleanup();
      }
    });
  }
});

describe('fatal close while the database is locked', () => {
  test('4914 with the write lock held: the code is not lost, and a restart does not reconnect', async () => {
    const s = await startOwnStack({ label: 'fatallock', script: () => ({ text: '好。' }) });
    let other = null;
    try {
      const opened = s.qq.opened();
      other = new DatabaseSync(s.paths.db);
      other.exec('PRAGMA busy_timeout=0');
      other.exec('BEGIN IMMEDIATE');
      s.qq.closeAll(4914);
      await until(() => s.event('connection_fatal').some((e) => e.closeCode === 4914), 'fatal close seen', 90000);
      await sleep(3000);
      assert.equal(s.qq.opened(), opened, 'it did not reconnect');
      other.exec('ROLLBACK');
      other.close();
      other = null;
      await s.bot.waitExit(60000);
      await s.restart({ waitReady: false });
      const again = await s.bot.waitExit(60000);
      assert.equal(again.code, TERMINAL);
      assert.ok(s.event('start_refused').some((e) => e.reason === 'terminal'), 'refused start');
      assert.equal(s.qq.opened(), opened, 'no connection after the restart');
      assert.equal(s.control('terminal_close'), '4914');
    } finally {
      other?.close();
      await s.stop();
      s.cleanup();
    }
  });
});

describe('refused at start', () => {
  test('qq.enabled false: the bot ends refused with no QQ request', async () => {
    const s = await startOwnStack({ label: 'off', config: { qq: { enabled: false } }, waitReady: false });
    try {
      const ended = await s.bot.waitExit(60000);
      assert.equal(ended.code, REFUSED);
      assert.ok(s.event('start_refused').some((e) => e.reason === 'qq_disabled'));
      assert.equal(s.qq.opened(), 0);
      assert.equal(s.qq.requests.length, 0);
    } finally {
      await s.stop();
      s.cleanup();
    }
  });

  test('runtime openclaw in effective.json: the bot is not the consumer and ends refused; own connects (control)', async () => {
    const s = await startOwnStack({ label: 'rt', effective: { runtime: 'openclaw' }, waitReady: false });
    try {
      const ended = await s.bot.waitExit(60000);
      assert.equal(ended.code, REFUSED);
      assert.ok(s.event('start_refused').some((e) => e.reason === 'runtime'));
      assert.equal(s.qq.opened(), 0);
      assert.equal(s.qq.requests.length, 0);
      s.updateEffective({ runtime: 'own' });
      await s.start({ waitReady: true });
      assert.equal(s.qq.connected(), 1);
    } finally {
      await s.stop();
      s.cleanup();
    }
  });

  test('an env appId that differs from the config refuses to connect, while the right one connects (control)', async () => {
    const s = await startOwnStack({ label: 'acct', env: { CLO_QQ_APP_ID: 'SOME-OTHER-APP-ID' }, waitReady: false });
    try {
      const ended = await s.bot.waitExit(60000);
      assert.equal(ended.code, REFUSED);
      assert.ok(s.event('start_refused').some((e) => e.reason === 'account'));
      assert.ok(s.alerts().some((a) => a.kind === 'account_mismatch'));
      assert.equal(s.qq.opened(), 0);
      await s.start({ env: { CLO_QQ_APP_ID: s.cfg.qq.appId }, waitReady: true });
      assert.equal(s.qq.connected(), 1, 'right account connects');
    } finally {
      await s.stop();
      s.cleanup();
    }
  });
});
