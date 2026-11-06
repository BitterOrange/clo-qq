// `clo model refresh` against the mock catalog, then `clo mode live`, on the real own-runtime bot started by `clo start`
// in dry-run with no lock. This is the order the README gives. Also the clear refusals when the alias row is missing or
// differs. Under the own runtime no host config is written: the bot reads the lock from effective.json at each turn.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fullAt, nextId } from '../fixtures/qq-events.mjs';
import { allocPort, GROUP_A, MEMBER, OWNER, pidAlive, PRIMARY_ID, DECISION_ID, until } from '../harness/gateway.mjs';
import { defaultCatalog, startMockOpenRouter } from '../harness/mock-openrouter.mjs';
import { startMockQq } from '../harness/mock-qq.mjs';
import { APP_ID, baseConfig, clo, configOf, effectiveOf, FAKE_KEY, makeRoot, NET_GUARD, readJson, withDb } from '../unit/_cli-helper.mjs';

let qq;
let model;
let r;
let env;
let botPid;
const pidFile = () => join(r.root, '.runtime', 'pids', 'gateway.json');
const hostConfig = () => join(r.root, '.runtime', 'state', 'openclaw.json');
const run = (argv, opts = {}) => clo(r.root, argv, { env, fetch: globalThis.fetch, ...opts });
const lockFile = () => join(r.root, 'versions.lock.json');
const refreshRefused = async (pattern) => {
  const res = await run(['model', 'refresh']);
  assert.equal(res.code, 1, `${res.out}${res.err}`);
  assert.match(res.err, pattern);
  assert.equal(readJson(lockFile()).models?.lock, undefined, 'nothing was locked');
};

before(async () => {
  qq = await startMockQq();
  model = await startMockOpenRouter();
  const cfg = baseConfig();
  cfg.runtime = 'own';
  cfg.gatewayPort = await allocPort();
  cfg.openrouter = { baseUrl: model.base };
  cfg.qq.enabled = true;
  cfg.qq.appId = APP_ID;
  cfg.qq.apiBaseUrl = qq.base;
  cfg.qq.tokenBaseUrl = qq.base;
  // The mock Key's default limit differs from the example config, and clo mode live refuses a difference.
  model.setKey({ limit: cfg.budget.keyDailyLimitUsd, limit_remaining: cfg.budget.keyDailyLimitUsd });
  r = makeRoot('own-model-live', cfg);
  env = { CLO_TEST_NODE_IMPORT: NET_GUARD, CLO_NET_GUARD_LOG: join(r.root, 'net-guard.jsonl') };
});

after(async () => {
  if (r) {
    await run(['stop']).catch(() => {});
    r.cleanup();
  }
  await qq?.stop();
  await model?.stop();
});

test('refresh refuses clearly when the alias row is missing, and locks nothing', async () => {
  model.setCatalog(defaultCatalog().filter((m) => !m.id.startsWith('~')));
  await refreshRefused(/alias row is absent.*Choose an id explicitly/s);
});

test('refresh refuses clearly when the alias row differs in price', async () => {
  model.setCatalog(defaultCatalog().map((m) => (m.id.startsWith('~') ? { ...m, pricing: { ...m.pricing, completion: '0.00003' } } : m)));
  await refreshRefused(/differs from the alias row in price or reasoning/);
});

test('refresh refuses clearly when the alias row differs in reasoning', async () => {
  model.setCatalog(defaultCatalog().map((m) => (m.id.startsWith('~') ? { ...m, reasoning: { ...m.reasoning, mandatory: false } } : m)));
  await refreshRefused(/differs from the alias row in price or reasoning/);
});

test('with no lock, mode live is refused and names the models', async () => {
  model.setCatalog(defaultCatalog());
  const res = await run(['mode', 'live']);
  assert.equal(res.code, 1);
  assert.match(res.out, /models：/);
  assert.equal(configOf(r.root).mode, 'dry-run');
});

test('dry-run start with no lock runs the own bot, then refresh on the default catalog locks the concrete model', { timeout: 120000 }, async () => {
  const started = await run(['start']);
  assert.equal(started.code, 0, `${started.out}${started.err}`);
  await until(() => {
    const snapshot = withDb(r.root, (store) => store.statusSnapshot());
    return snapshot.connected && snapshot.heartbeatAt;
  }, 'the bot to connect and beat', 60000);
  assert.equal(model.requests.length, 0);
  const rec = readJson(pidFile());
  assert.equal(rec.runtime, 'own');
  assert.equal(rec.port, null, 'the own runtime listens on no port');
  botPid = rec.pid;

  const refreshed = await run(['model', 'refresh']);
  assert.equal(refreshed.code, 0, `${refreshed.out}${refreshed.err}`);
  assert.ok(refreshed.out.includes(PRIMARY_ID));
  const lock = readJson(lockFile()).models.lock;
  assert.equal(lock.primary.id, PRIMARY_ID, 'the concrete row, not the alias');
  assert.equal(lock.primary.selector, 'opus-latest');
  assert.equal(lock.decision.id, DECISION_ID);
  assert.deepEqual(lock.primary.price, { inputPerM: 5, outputPerM: 20, cacheReadPerM: 0.5, cacheWritePerM: 6.25 });
  const eff = effectiveOf(r.root);
  assert.equal(eff.runtime, 'own');
  assert.equal(eff.models.primary.id, PRIMARY_ID, 'the bot reads the concrete id from effective.json');
  assert.equal(existsSync(hostConfig()), false, 'no host config is written under the own runtime');
  assert.equal(model.requests.length, 0, 'locking calls no model');
});

test('live preconditions, in README order, then a real @ gets a reply from the locked model', { timeout: 120000 }, async () => {
  await until(() => qq.connected() === 1 && withDb(r.root, (store) => store.statusSnapshot().connected), 'the connection', 60000);
  for (const argv of [['group', 'add', '测试群', '--id', GROUP_A], ['owner', 'add', '测试群', '--id', OWNER], ['ack', 'q0'], ['ack', 'identity'], ['ack', 'd3', '测试决定，只在假环境里'], ['group', 'notice-done', '测试群']]) {
    const res = await run(argv);
    assert.equal(res.code, 0, `${argv.join(' ')}: ${res.out}${res.err}`);
  }
  const keyReadsBefore = model.other.filter((o) => o.url.endsWith('/key')).length;
  const live = await run(['mode', 'live']);
  assert.equal(live.code, 0, `${live.out}${live.err}`);
  assert.match(live.out, /已进入 live/);
  assert.ok(model.other.filter((o) => o.url.endsWith('/key')).length > keyReadsBefore, 'it read the Key');
  const eff = effectiveOf(r.root);
  assert.equal(eff.mode, 'live');

  model.setScript(() => ({ text: '收到。', usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } }));
  const id = nextId();
  qq.push(...fullAt('现在可以回答了吗', { id, group: GROUP_A, member: MEMBER }));
  await until(() => qq.messagePosts().length === 1, 'the reply to reach the mock QQ', 60000);
  const [rec] = model.agentRequests();
  assert.ok(rec, 'a model request was made');
  assert.equal(rec.headers.authorization, `Bearer ${FAKE_KEY}`, 'the bot got CLO_CHAT_API_KEY from .env');
  assert.equal(rec.body.model, PRIMARY_ID);
  assert.equal(rec.body.max_tokens, eff.models.primary.maxTokens);
  assert.deepEqual(rec.body.reasoning, { effort: eff.models.primary.effort });
  for (const k of ['fallbacks', 'models', 'tools']) assert.equal(rec.body[k], undefined, `no ${k}`);
  assert.equal(JSON.parse(qq.messagePosts()[0].body).content, '收到。');
  assert.equal(readJson(pidFile()).pid, botPid, 'refresh and live happened in the same bot process');
  assert.ok(pidAlive(botPid));
  const hold = await until(() => withDb(r.root, (store) => {
    const row = store.q('SELECT status, actual_micros FROM reservations WHERE event_key=?').get(store.key(id));
    return row?.status === 'settled' ? row : null;
  }), 'the hold to settle at the locked price', 30000);
  assert.equal(hold.actual_micros, 7000);
});

test('a later catalog with no alias refuses a refresh, keeps the lock and stays live', async () => {
  const before_ = readJson(lockFile()).models.lock;
  model.setCatalog(defaultCatalog().filter((m) => !m.id.startsWith('~')));
  const res = await run(['model', 'refresh']);
  assert.equal(res.code, 1);
  assert.match(res.err, /alias row is absent/);
  assert.deepEqual(readJson(lockFile()).models.lock, before_);
  assert.equal(configOf(r.root).mode, 'live');
  model.setCatalog(defaultCatalog());
});

test('stop ends it, and nothing at all was refused: the own runtime makes no startup lookup', async () => {
  assert.equal((await run(['stop'])).code, 0);
  await until(() => qq.connected() === 0, 'the socket to close', 15000);
  await until(() => !pidAlive(botPid), 'the bot process to end', 15000);
  const log = join(r.root, 'net-guard.jsonl');
  const hosts = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).host) : [];
  assert.deepEqual(hosts, []);
});
