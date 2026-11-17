// Node's env proxy in the console. Node turns it on at startup from NODE_USE_ENV_PROXY=1 or --use-env-proxy and keeps
// the proxy it read then, so the console cannot undo it from inside: off Windows it refuses to make requests, and
// `mode live` says so before it writes anything. The doctor warning about proxy variables is shown by `mode live` and
// `start` (start: lifecycle.test.mjs). Every proxy and endpoint here is a loopback listener this file owns; children
// get the clean environment and a temp CLO_TEST_ROOT.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { main } from '../../src/cli/clo.mjs';
import { envProxyAtLaunch } from '../../src/cli/common.mjs';
import { cleanChildEnv } from '../harness/clean-env.mjs';
import { IS_WINDOWS, NODE } from '../harness/platform.mjs';
import { CATALOG, configOf, enabledConfig, fakeProvider, makeRoot, readyForLive, ROOT, testEnv } from './_cli-helper.mjs';

const NOT_WINDOWS = IS_WINDOWS ? 'not Windows: the console keeps its earlier behaviour there and never refuses' : false;
const CLO = join(ROOT, 'src', 'cli', 'clo.mjs');
const REFUSED = /启动时带了 .*拒绝联网/;

const roots = [];
const closers = [];
after(async () => {
  for (const c of closers) await c();
  roots.forEach((r) => r.cleanup());
});
const root = (label, cfg) => {
  const r = makeRoot(label, cfg);
  roots.push(r);
  return r.root;
};

// main as the helper's clo() runs it, plus the envProxy a launch with the flag would give.
async function run(r, argv, { fetch, envProxy, env = {} } = {}) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    env: testEnv(r, env),
    fetch: fetch ?? (() => { throw new Error('this test did not expect a network call'); }),
    envProxy,
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
  });
  return { code, out, err };
}

test('what counts as Node env proxy at launch', () => {
  assert.equal(envProxyAtLaunch({ NODE_USE_ENV_PROXY: '1' }), 'NODE_USE_ENV_PROXY');
  assert.equal(envProxyAtLaunch({ NODE_USE_ENV_PROXY: 'true' }), 'NODE_USE_ENV_PROXY', 'any value but 0, in case a later Node widens it');
  assert.equal(envProxyAtLaunch({}, ['--use-env-proxy']), '--use-env-proxy');
  assert.equal(envProxyAtLaunch({ NODE_OPTIONS: '--max-old-space-size=64 --use-env-proxy' }), 'NODE_OPTIONS 里的 --use-env-proxy');
  // Spellings the private Node 24.22.2 turns the proxy on for (the real-launch group below checks some of them end to end).
  for (const opt of ['"--use-env-proxy"', '--use-env-proxy=true', '--use-env-proxy=false', '--use_env_proxy', '--trace-warnings  --use-env-proxy']) {
    assert.equal(envProxyAtLaunch({ NODE_OPTIONS: opt }), 'NODE_OPTIONS 里的 --use-env-proxy', opt);
  }
  for (const arg of ['--use-env-proxy=true', '--use_env_proxy', '--use-env-proxy=false']) {
    assert.equal(envProxyAtLaunch({}, [arg]), '--use-env-proxy', arg);
  }
  for (const env of [{}, { NODE_USE_ENV_PROXY: '0' }, { NODE_USE_ENV_PROXY: '' }, { HTTP_PROXY: 'http://127.0.0.1:1' }, { NODE_OPTIONS: '--max-old-space-size=64' }, { NODE_OPTIONS: '--no-use-env-proxy' }]) {
    assert.equal(envProxyAtLaunch(env, ['--disable-warning=ExperimentalWarning']), null, JSON.stringify(env));
  }
});

test('a context with injected env ignores the env proxy this test process was launched with', async () => {
  // A child launched with the flag, the way a runner started with NODE_USE_ENV_PROXY=1 would be.
  const r = root('hermetic');
  const script = `import { makeContext } from ${JSON.stringify(new URL('../../src/cli/common.mjs', import.meta.url).href)};`
    + `console.log(JSON.stringify({ own: makeContext().envProxy, injected: makeContext({ env: { CLO_TEST_ROOT: process.env.CLO_TEST_ROOT } }).envProxy }));`;
  const res = await new Promise((done) => {
    const child = spawn(NODE, ['--input-type=module', '-e', script], { env: cleanChildEnv({ CLO_TEST_ROOT: r, NODE_USE_ENV_PROXY: '1' }), cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (status) => done({ status, out, err }));
  });
  assert.equal(res.status, 0, res.err);
  const seen = JSON.parse(res.out.trim().split('\n').pop());
  assert.equal(seen.injected, null, 'an injected env is not this launch');
  assert.equal(seen.own, IS_WINDOWS ? null : 'NODE_USE_ENV_PROXY', 'positive control: the process own context sees the launch flag');
});

test('model refresh refuses with the env proxy on and reaches nothing; without it the same refresh works', async () => {
  const r = root('refresh', enabledConfig());
  const p = fakeProvider();
  const refused = await run(r, ['model', 'refresh'], { fetch: p.fetch, envProxy: 'NODE_USE_ENV_PROXY' });
  assert.notEqual(refused.code, 0);
  assert.match(refused.err, REFUSED);
  assert.match(refused.err, /scripts\/clo\.sh/);
  assert.equal(p.calls.length, 0);
  const ok = await run(r, ['model', 'refresh'], { fetch: p.fetch });
  assert.equal(ok.code, 0, `${ok.out}${ok.err}`);
  assert.ok(p.calls.length > 0, 'positive control: the refresh reads the catalog');
});

test('mode live refuses up front with the env proxy on, writes nothing and reads no Key; without it, it goes live', async () => {
  const r = root('live');
  const p = fakeProvider();
  await readyForLive(r, p);
  const before = readFileSync(join(r, 'config.json'), 'utf8');
  const callsBefore = p.calls.length;
  const refused = await run(r, ['mode', 'live'], { fetch: p.fetch, envProxy: '--use-env-proxy' });
  assert.notEqual(refused.code, 0);
  assert.match(refused.err, REFUSED);
  assert.equal(readFileSync(join(r, 'config.json'), 'utf8'), before, 'config untouched');
  assert.equal(p.calls.length, callsBefore, 'no Key read');
  const ok = await run(r, ['mode', 'live'], { fetch: p.fetch });
  assert.equal(ok.code, 0, `${ok.out}${ok.err}`);
  assert.equal(configOf(r).mode, 'live');
  assert.ok(p.calls.some((c) => c.url.endsWith('/key')), 'positive control: live reads the Key');
});

test('mode live shows the parent_proxy warning, and prints none without proxy variables', async () => {
  const shown = root('warn');
  const quiet = root('quiet');
  await readyForLive(shown, fakeProvider());
  await readyForLive(quiet, fakeProvider());
  const withProxy = await run(shown, ['mode', 'live'], { fetch: fakeProvider().fetch, env: { HTTP_PROXY: 'http://127.0.0.1:1' } });
  assert.equal(withProxy.code, 0, `${withProxy.out}${withProxy.err}`);
  assert.match(withProxy.out, /提醒：当前 shell 设了代理变量（HTTP_PROXY）/);
  const without = await run(quiet, ['mode', 'live'], { fetch: fakeProvider().fetch });
  assert.equal(without.code, 0, `${without.out}${without.err}`);
  assert.doesNotMatch(without.out, /提醒：/);
});

test('doctor names the console env proxy in parent_proxy', async () => {
  const r = root('doctor');
  const flagged = await run(r, ['doctor', '--config-only'], { envProxy: 'NODE_USE_ENV_PROXY' });
  assert.match(flagged.out, /\[提醒\] parent_proxy：.*这个控制台进程启动时带了 NODE_USE_ENV_PROXY/);
  const plain = await run(r, ['doctor', '--config-only']);
  assert.match(plain.out, /\[通过\] parent_proxy/, 'control: passes with neither');
});

test('doctor with only the launch flag names the console, not shell variables it does not have', async () => {
  const r = root('doctor-flag-only');
  const flagOnly = await run(r, ['doctor', '--config-only'], { envProxy: '--use-env-proxy' });
  const line = flagOnly.out.split('\n').find((l) => l.includes('parent_proxy')) ?? '';
  assert.match(line, /\[提醒\] parent_proxy：这个控制台进程启动时带了 --use-env-proxy/);
  assert.doesNotMatch(line, /当前 shell 设了代理变量|（无）/);
  const both = await run(r, ['doctor', '--config-only'], { envProxy: '--use-env-proxy', env: { HTTP_PROXY: 'http://127.0.0.1:1' } });
  const bothLine = both.out.split('\n').find((l) => l.includes('parent_proxy')) ?? '';
  assert.match(bothLine, /当前 shell 设了代理变量（HTTP_PROXY）.*；这个控制台进程启动时带了 --use-env-proxy/, 'positive control: with a variable both sentences show');
});

// A real launch of the private Node, the way a user runs the console without the wrapper.
describe('the console run directly with NODE_USE_ENV_PROXY=1', { skip: NOT_WINDOWS }, () => {
  async function listen(server) {
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    closers.push(() => new Promise((res) => server.close(() => res())));
    return server.address().port;
  }
  // The proxy only counts connections and answers 502: nothing goes further.
  async function fakeProxy() {
    const seen = [];
    const server = createNetServer((s) => {
      s.once('data', (d) => {
        seen.push(d.toString('latin1').split('\r\n')[0]);
        s.end('HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n');
      });
      s.on('error', () => {});
    });
    return { seen, url: `http://127.0.0.1:${await listen(server)}` };
  }
  async function catalogServer() {
    const seen = [];
    const server = createHttpServer((req, res) => {
      seen.push(req.url);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url.endsWith('/models') ? { data: CATALOG() } : { error: { message: 'no route' } }));
    });
    return { seen, base: `http://127.0.0.1:${await listen(server)}/api/v1` };
  }
  function node(args, env) {
    return new Promise((res) => {
      const child = spawn(NODE, args, { env: cleanChildEnv(env), cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      const timer = setTimeout(() => child.kill(), 60000);
      child.on('close', (status) => { clearTimeout(timer); res({ status, out, err }); });
    });
  }

  test('premise: with the flag at launch, a fetch goes to the proxy even after the variables are deleted', async () => {
    const proxy = await fakeProxy();
    const target = await catalogServer();
    const script = "for (const k of ['NODE_USE_ENV_PROXY','HTTP_PROXY','http_proxy']) delete process.env[k];"
      + 'fetch(process.argv[1]).then((r) => console.log(r.status), (e) => console.log("error"));';
    const flagged = await node(['-e', script, `${target.base}/models`], { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: proxy.url });
    assert.equal(flagged.status, 0, flagged.err);
    assert.equal(proxy.seen.length, 1, 'the proxy got the request');
    assert.equal(target.seen.length, 0);
    const plain = await node(['-e', script, `${target.base}/models`], { HTTP_PROXY: proxy.url });
    assert.equal(plain.status, 0, plain.err);
    assert.equal(proxy.seen.length, 1, 'without the flag Node ignores HTTP_PROXY');
    assert.equal(target.seen.length, 1, 'control: the request went straight to the endpoint');
  });

  // Looser spellings in NODE_OPTIONS: Node turns the proxy on for each, and the console refuses for each.
  for (const opt of ['"--use-env-proxy"', '--use-env-proxy=true']) {
    test(`NODE_OPTIONS=${opt}: premise, the proxy is used; the console refuses and reaches nothing`, async () => {
      const proxy = await fakeProxy();
      const target = await catalogServer();
      const script = 'fetch(process.argv[1]).then((r) => console.log(r.status), (e) => console.log("error"));';
      const flagged = await node(['-e', script, `${target.base}/models`], { NODE_OPTIONS: opt, HTTP_PROXY: proxy.url });
      assert.equal(flagged.status, 0, flagged.err);
      assert.equal(proxy.seen.length, 1, 'positive control: Node sent the request to the proxy');
      assert.equal(target.seen.length, 0);
      const cfg = enabledConfig();
      cfg.openrouter = { baseUrl: target.base };
      const r = root('direct-opt', cfg);
      const refused = await node([CLO, 'model', 'refresh'], { CLO_TEST_ROOT: r, HTTP_PROXY: proxy.url, NODE_OPTIONS: opt });
      assert.notEqual(refused.status, 0, refused.out);
      assert.match(refused.err, REFUSED);
      assert.deepEqual([proxy.seen.length, target.seen.length], [1, 0], 'the console reached neither');
    });
  }

  test('model refresh refuses and reaches neither proxy nor endpoint; the same run without the flag works', async () => {
    const proxy = await fakeProxy();
    const target = await catalogServer();
    const cfg = enabledConfig();
    cfg.openrouter = { baseUrl: target.base };
    const r = root('direct', cfg);
    const env = { CLO_TEST_ROOT: r, HTTP_PROXY: proxy.url };
    const refused = await node([CLO, 'model', 'refresh'], { ...env, NODE_USE_ENV_PROXY: '1' });
    assert.notEqual(refused.status, 0, refused.out);
    assert.match(refused.err, REFUSED);
    assert.deepEqual([proxy.seen.length, target.seen.length], [0, 0]);
    const ok = await node([CLO, 'model', 'refresh'], env);
    assert.equal(ok.status, 0, `${ok.out}${ok.err}`);
    assert.equal(proxy.seen.length, 0, 'HTTP_PROXY alone does not route the console');
    assert.ok(target.seen.some((u) => u.endsWith('/models')), 'positive control: the catalog was read');
  });
});
