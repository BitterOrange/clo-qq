// TQ11: startAccount lifecycle under the real Gateway.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fullAt, nextId, push } from '../fixtures/qq-events.mjs';
import { assertEveryPostLegal, deepMerge, sleep, startStack, unexpectedNetAttempts, until } from '../harness/gateway.mjs';

const instances = (s) => new Set(s.events().map((e) => e.gen));
const editConfig = (gw, patch) => gw.writeConfig(deepMerge(gw.readConfig(), patch));

async function oneMessageOneReply(s) {
  const model = s.model.agentRequests().length;
  const posts = s.messagePosts().length;
  const id = nextId();
  push(s, fullAt('在吗', { id }));
  await s.waitRow(id);
  await sleep(500);
  assert.equal(s.model.agentRequests().length - model, 1);
  assert.equal(s.messagePosts().length - posts, 1);
}

describe('running account', () => {
  let s;

  before(async () => {
    s = await startStack({ label: 'life', script: () => ({ text: '收到。' }) });
    await s.waitConnected();
  });

  after(async () => {
    await s?.stop();
    s?.cleanup();
  });

  test('startAccount opens exactly one connection with bit 25 only', () => {
    assert.equal(s.qq.opened(), 1);
    assert.equal(s.qq.connected(), 1);
    assert.equal(s.qq.identifies.length, 1);
    assert.equal(s.qq.identifies[0].intents, 1 << 25);
  });

  test('positive control: this stack answers', async () => {
    await oneMessageOneReply(s);
  });

  test('channels.stop aborts startAccount, closes the socket, and channels.start reopens one', async () => {
    const stop = s.gw.cli(['gateway', 'call', 'channels.stop', '--params', '{"channel":"clo-qq"}', '--json']);
    assert.equal(stop.status, 0, stop.stderr);
    await until(() => s.qq.connected() === 0, 'socket closed after abort', 20000);
    await until(() => s.event('connection_closed').length > 0, 'startAccount returned', 20000);
    await sleep(3000);
    assert.equal(s.qq.connected(), 0, 'a manual stop stays stopped');
    assert.equal(s.control('connected'), 'false');

    const start = s.gw.cli(['gateway', 'call', 'channels.start', '--params', '{"channel":"clo-qq"}', '--json']);
    assert.equal(start.status, 0, start.stderr);
    await s.waitConnected(2);
    assert.equal(s.qq.peak(), 1);
    assert.equal(s.control('connected'), 'true');
  });

  test('a channel config reload restarts the account without two connections', async () => {
    const openedBefore = s.qq.opened();
    const startsBefore = s.event('start_account').length;
    editConfig(s.gw, { channels: { 'clo-qq': { reloadTag: 'r1' } } });
    await until(() => s.event('start_account').length > startsBefore, 'account restart', 30000);
    await until(() => s.qq.opened() > openedBefore && s.qq.connected() === 1, 'reconnected', 30000);
    await sleep(2000);
    assert.equal(s.qq.connected(), 1);
    assert.equal(s.qq.peak(), 1, 'never two sockets at once');
  });

  test('a plugin entry config change (generation swap) leaves one connection and one reply', async () => {
    const openedBefore = s.qq.opened();
    const gens = instances(s).size;
    editConfig(s.gw, { plugins: { entries: { clo: { config: { generationTag: 'g1' } } } } });
    await until(() => s.qq.opened() > openedBefore && s.qq.connected() === 1, 'reconnect after generation swap', 45000);
    await sleep(2000);
    assert.equal(s.qq.connected(), 1);
    assert.equal(s.qq.peak(), 1, 'never two sockets at once');
    assert.ok(instances(s).size > gens, 'a new set of services was built');
    await until(() => s.control('connected') === 'true', 'connected', 30000);
    await oneMessageOneReply(s);
  });

  // The old test passed if the command were replaced with --version. These assert what a reload does.
  test('openclaw plugins reload clo: new module instance, old socket closed, peak 1, one message gives one reply', async () => {
    const openedBefore = s.qq.opened();
    const gens = instances(s);
    const closed = s.event('connection_closed').length;
    const r = s.gw.cli(['plugins', 'reload', 'clo', '--wait', '--json'], { timeoutMs: 120000 });
    assert.equal(r.status, 0, r.stderr.slice(-400));
    await until(() => s.event('connection_closed').length > closed, 'the old socket closed', 45000);
    await until(() => s.qq.opened() > openedBefore && s.qq.connected() === 1, 'a new connection after reload', 45000);
    const fresh = [...instances(s)].filter((g) => !gens.has(g));
    assert.ok(fresh.length >= 1, 'the reload built a new generation');
    assert.equal(s.qq.peak(), 1, 'never two sockets at once');
    await sleep(1000);
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

  test('turning qq off closes the socket and starts nothing; turning it on reopens one', async () => {
    editConfig(s.gw, { channels: { 'clo-qq': { enabled: false } } });
    await until(() => s.qq.connected() === 0, 'socket closed after disable', 30000);
    const opened = s.qq.opened();
    await sleep(6000);
    assert.equal(s.qq.opened(), opened, 'no reconnect while disabled');
    editConfig(s.gw, { channels: { 'clo-qq': { enabled: true } } });
    await until(() => s.qq.connected() === 1, 'socket reopened', 30000);
  });

  test('last: every POST on this stack is legal', () => {
    assertEveryPostLegal(s, { minPosts: 4 });
    assert.deepEqual(unexpectedNetAttempts(s.gw), []);
  });
});

describe('connection failures', () => {
  test('connected stays false until READY: a socket without READY is not connected', async () => {
    const s = await startStack({ label: 'noready', ready: false, script: () => ({ text: '好。' }) });
    try {
      await until(() => s.qq.connected() === 1 && s.qq.identifies.length === 1, 'identify', 90000);
      await until(() => s.dbExists() && s.control('heartbeat_at'), 'heartbeat', 30000);
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
    const s = await startStack({ label: 'retry', script: () => ({ text: '回来了。' }), start: false });
    try {
      // The SDK's own reconnect handles refused sockets, the channel's loop handles a token failure at start.
      s.qq.failToken(2);
      await s.restart({ waitReady: false });
      await until(() => s.event('connection_start_failed').length >= 2, 'two start failures', 120000);
      await s.waitConnected(undefined, 120000);
      assert.equal(s.gw.exited(), null);
      assert.equal(s.control('terminal_close'), null);

      s.qq.refuseConnections(6);
      s.qq.terminateAll();
      await until(() => s.qq.refused() >= 6, 'six refused sockets', 180000);
      await until(() => s.qq.connected() === 1, 'reconnect after six refusals', 120000);
      await until(() => s.control('connected') === 'true', 'connected again', 30000);
      const id = nextId();
      push(s, fullAt('还在吗', { id }));
      await s.waitRow(id);
      assert.equal(s.messagePosts().length, 1, 'positive control: replies after recovery');
    } finally {
      await s.stop();
      s.cleanup();
    }
  });

  for (const code of [4914, 4915]) {
    test(`a fatal close (${code}) stays stopped, is latched, and sets terminalDisconnect rather than restarting`, async () => {
      const s = await startStack({ label: `fatal${code}`, script: () => ({ text: '好。' }) });
      try {
        await s.waitConnected();
        const before_ = nextId();
        push(s, fullAt('关闭前', { id: before_ }));
        await s.waitRow(before_);
        assert.equal(s.messagePosts().length, 1, 'positive control');
        const opened = s.qq.opened();
        s.qq.closeAll(code);
        await until(() => s.event('connection_fatal').some((e) => e.closeCode === code), 'fatal close seen', 20000);
        await sleep(9000);
        assert.equal(s.qq.opened(), opened, 'the first host restart would come after about 5 s');
        assert.equal(s.qq.connected(), 0);
        assert.equal(s.control('terminal_close'), String(code));
        assert.equal(s.control('connected'), 'false');
        assert.ok(s.alerts().some((a) => a.kind === 'terminal_close' && a.detail.includes(String(code))));
        for (const a of s.alerts()) assert.ok(!/ban|封|处罚|violation/i.test(a.detail), 'quotes the code, infers no cause');

        // A restart does not reconnect while the latch is on.
        await s.restart();
        await until(() => s.event('start_refused').some((e) => e.reason === 'terminal'), 'refused start', 60000);
        await sleep(6000);
        assert.equal(s.qq.opened(), opened, 'no connection while latched');
      } finally {
        await s.stop();
        s.cleanup();
      }
    });
  }
});

describe('qq disabled at startup', () => {
  test('enabled:false means no account, no connection, no QQ request', async () => {
    const s = await startStack({ label: 'off', config: { qq: { enabled: false } } });
    try {
      await sleep(8000);
      assert.equal(s.qq.opened(), 0);
      assert.equal(s.qq.requests.length, 0);
      assert.equal(s.event('start_account').length, 0);
      assert.equal(s.config.channels['clo-qq'], undefined);
    } finally {
      await s.stop();
      s.cleanup();
    }
  });
});

describe('ctx.channelRuntime absent', () => {
  // The real host passed it in every run, so its absence cannot be produced without stubbing the host.
  // A test-only setting makes the plugin behave as if it were missing. The host stays real.
  test('fallback to api.runtime.channel still completes a real turn', async () => {
    const s = await startStack({ label: 'nort-fb', env: { CLO_TEST_IGNORE_HOST_RUNTIME: 'fallback' }, script: () => ({ text: '回退路径。' }) });
    try {
      await s.waitConnected();
      assert.ok(s.event('start_account').some((e) => e.source === 'api.runtime.channel'));
      const id = nextId();
      push(s, fullAt('走回退', { id }));
      await s.waitRow(id);
      assert.equal(s.model.agentRequests().length, 1);
      assert.equal(s.messagePosts().length, 1);
    } finally {
      await s.stop();
      s.cleanup();
    }
  });

  test('no runtime at all: no connection, no QQ request, no restart loop', async () => {
    const s = await startStack({ label: 'nort-none', env: { CLO_TEST_IGNORE_HOST_RUNTIME: 'none' } });
    try {
      await until(() => s.event('start_refused').length > 0, 'refused start', 30000);
      await sleep(9000);
      assert.equal(s.qq.opened(), 0);
      assert.equal(s.qq.requests.length, 0);
      assert.equal(s.event('start_account').length, 1, 'the host did not retry');
    } finally {
      await s.stop();
      s.cleanup();
    }
  });
});

describe('wrong account', () => {
  test('an env appId that differs from the config refuses to connect, while the right one connects (control)', async () => {
    const s = await startStack({ label: 'acct', env: { CLO_QQ_APP_ID: 'SOME-OTHER-APP-ID' } });
    try {
      await until(() => s.event('start_refused').some((e) => e.reason === 'account'), 'refused start', 30000);
      await sleep(3000);
      assert.equal(s.qq.opened(), 0);
      await s.restart({ env: { CLO_QQ_APP_ID: s.cfg.qq.appId } });
      await until(() => s.qq.connected() === 1, 'right account connects', 90000);
    } finally {
      await s.stop();
      s.cleanup();
    }
  });
});
