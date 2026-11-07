// The provider registry: frozen tables and providerOf. Pure; no files, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as R from '../../src/clo-plugin/lib/core/providers/registry.js';

const { providerOfConfig, providerOfEffective, CAPABILITIES, KEY_ENV, CHILD_KEY, DEFAULT_BASE } = R;

test('every table is frozen, and every kind has an entry in each', () => {
  const tables = ['PROVIDER_KINDS', 'CAPABILITIES', 'KEY_ENV', 'CHILD_KEY', 'PROBE_KEY_ENV', 'DEFAULT_BASE', 'MODEL_ID_RULES', 'ANTHROPIC_EFFORTS',
    'PROVIDER_ENTRY_FIELDS', 'RESULT_KINDS', 'RESULT_REASONS', 'OPENROUTER_LIMIT_SOURCES', 'ANTHROPIC_LIMIT_SOURCES', 'PROVIDER_PAUSES',
    'OWNER_CLEARED_PROVIDER_PAUSES', 'HARD_CAP_KINDS', 'LIVE_CODES', 'LIVE_RULES_RECORDED'];
  for (const name of tables) assert.equal(Object.isFrozen(R[name]), true, name);
  for (const kind of R.PROVIDER_KINDS) {
    for (const t of [CAPABILITIES, KEY_ENV, CHILD_KEY, DEFAULT_BASE, R.MODEL_ID_RULES, R.LIVE_RULES_RECORDED]) assert.ok(Object.hasOwn(t, kind), kind);
    assert.equal(Object.isFrozen(CAPABILITIES[kind]), true, kind);
  }
  for (const list of [...Object.values(R.RESULT_REASONS), ...Object.values(R.ANTHROPIC_EFFORTS)]) assert.equal(Object.isFrozen(list), true);
  // Positive control: a write to a frozen table is refused in strict mode.
  assert.throws(() => { CAPABILITIES.anthropic.keyReadable = true; }, TypeError);
  assert.throws(() => { R.LIVE_RULES_RECORDED.anthropic = true; }, TypeError);
  assert.equal(CAPABILITIES.anthropic.keyReadable, false);
});

test('capabilities and names per kind', () => {
  assert.deepEqual(R.PROVIDER_KINDS, ['openrouter', 'anthropic']);
  assert.deepEqual({ ...CAPABILITIES.openrouter }, { keyReadable: true, reportsCost: true, hardCap: 'key_daily_limit', ownerClearsProviderFail: false, countTokens: false, cache1h: false });
  assert.deepEqual({ ...CAPABILITIES.anthropic }, { keyReadable: false, reportsCost: false, hardCap: 'attested', ownerClearsProviderFail: true, countTokens: false, cache1h: false });
  assert.deepEqual({ ...KEY_ENV }, { openrouter: 'CLO_CHAT_API_KEY', anthropic: 'CLO_ANTHROPIC_API_KEY' });
  assert.deepEqual({ ...CHILD_KEY }, { openrouter: 'OPENROUTER_API_KEY', anthropic: 'CLO_PROVIDER_API_KEY' });
  // Never the name SDKs and maybe the host read on their own.
  assert.equal(Object.values(CHILD_KEY).includes('ANTHROPIC_API_KEY'), false);
  assert.equal(R.PROBE_KEY_ENV.anthropic, 'CLO_TEST_ANTHROPIC_API_KEY');
  assert.equal(R.ANTHROPIC_VERSION, '2026-10-21');
  assert.equal(DEFAULT_BASE.anthropic, 'https://api.anthropic.com');
  assert.equal(DEFAULT_BASE.openrouter, 'https://openrouter.ai/api/v1');
  assert.equal(R.PRICE_PAUSE, 'anthropic_price_unexpected');
  assert.equal(R.HARD_CAP_PAUSE, 'hard_cap_unverified');
  assert.equal(R.hardCapControlKey('anthropic'), 'hard_cap_key:anthropic');
  assert.deepEqual({ ...R.LIVE_CODES }, { hardCap: 'hard_cap', keyValid: 'key_valid', providerRules: 'provider_rules' });
  // The provider pauses that live in paid_paused are the owner's to clear.
  assert.deepEqual([...R.PROVIDER_PAUSES], [...R.ANTHROPIC_LIMIT_SOURCES, R.PRICE_PAUSE]);
  for (const p of R.PROVIDER_PAUSES) assert.equal(R.OWNER_CLEARED_PROVIDER_PAUSES.includes(p), true, p);
  // hard_cap_unverified is not a paid_paused reason: it has a control of its own per kind, so it can neither replace a
  // lower pause in paid_paused nor clear one when it is lifted, and it binds only the kind it was raised for.
  assert.equal(R.PROVIDER_PAUSES.includes(R.HARD_CAP_PAUSE), false);
  assert.equal(R.OWNER_CLEARED_PROVIDER_PAUSES.includes(R.HARD_CAP_PAUSE), false);
  assert.equal(R.hardCapPauseKey('anthropic'), 'hard_cap_paused:anthropic');
  assert.notEqual(R.hardCapPauseKey('anthropic'), R.hardCapPauseKey('openrouter'));
  assert.notEqual(R.hardCapPauseKey('anthropic'), 'paid_paused');
  assert.notEqual(R.hardCapPauseKey('anthropic'), R.hardCapControlKey('anthropic'));
});

test('live rules: recorded for Anthropic and OpenRouter, and for no other kind', () => {
  assert.equal(R.providerRulesRecorded('anthropic'), true);
  assert.equal(R.providerRulesRecorded('openrouter'), true);
  assert.equal(R.providerRulesRecorded('nope'), false);
  for (const kind of R.PROVIDER_KINDS) {
    if (CAPABILITIES[kind].keyReadable) assert.equal(R.providerRulesRecorded(kind), true, kind);
  }
});

test('model id rules: concrete ids only', () => {
  const or = R.MODEL_ID_RULES.openrouter;
  const an = R.MODEL_ID_RULES.anthropic;
  for (const id of ['anthropic/claude-opus-5.5', 'anthropic/claude-haiku-5.5']) assert.equal(or.test(id), true, id);
  for (const id of ['openrouter/auto', 'anthropic/claude-opus-5.5:nitro', '~anthropic/claude-opus-latest', 'openai/gpt-x', 'claude-opus-5-5']) assert.equal(or.test(id), false, id);
  for (const id of ['claude-opus-5-5', 'claude-haiku-5-5', 'claude-sonnet-5', 'claude-haiku-4-5']) assert.equal(an.test(id), true, id);
  for (const id of ['claude-opus-latest', 'claude-haiku-4-5-20251001', 'claude-haiku-20251001', 'claude-fable-5-1', 'claude-mythos-5',
    'anthropic/claude-opus-5.5', 'claude-opus-5-5-fast', 'claude-opus-5-5[1m]', ' claude-opus-5-5', 'claude-opus-5.5']) assert.equal(an.test(id), false, id);
  assert.deepEqual([...R.ANTHROPIC_EFFORTS.primary], ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual([...R.ANTHROPIC_EFFORTS.decision], ['none']);
  assert.equal(R.PROVIDER_NAME_RE.test('openrouter'), true);
  for (const n of ['Openrouter', '1x', '', 'a'.repeat(33), 'has space', 'sk-or-v1-x_y']) assert.equal(R.PROVIDER_NAME_RE.test(n), false, n);
});

test('provider readers: the implicit OpenRouter entry when no provider block is set', () => {
  for (const read of [providerOfConfig, providerOfEffective]) {
    for (const x of [undefined, null, {}, { runtime: 'openclaw' }, { runtime: 'own' }, { runtime: 'own', openrouter: { baseUrl: '' } }]) {
      const p = read(x);
      assert.equal(p.name, 'openrouter');
      assert.equal(p.kind, 'openrouter');
      assert.equal(p.implicit, true);
      assert.equal(p.baseUrl, 'https://openrouter.ai/api/v1');
      assert.equal(p.keyEnv, 'CLO_CHAT_API_KEY');
      assert.equal(p.childKey, 'OPENROUTER_API_KEY');
      assert.equal(p.caps, CAPABILITIES.openrouter);
      assert.equal(Object.isFrozen(p), true);
    }
    // The harnesses' loopback base URL is kept.
    assert.equal(read({ runtime: 'own', openrouter: { baseUrl: 'http://127.0.0.1:9/api/v1' } }).baseUrl, 'http://127.0.0.1:9/api/v1');
  }
  assert.equal(R.providerOf, undefined, 'no reader that takes both shapes');
});

const ANTHROPIC_CFG = {
  runtime: 'own',
  providers: { openrouter: { kind: 'openrouter', keyEnv: 'CLO_CHAT_API_KEY' }, direct: { kind: 'anthropic', keyEnv: 'CLO_ANTHROPIC_API_KEY' } },
  activeProvider: 'direct',
};
const ANTHROPIC_EFF = { runtime: 'own', apiProvider: { name: 'direct', kind: 'anthropic', baseUrl: 'https://api.anthropic.com' } };

test('provider readers: openclaw always runs on OpenRouter, whatever the block says', () => {
  // Positive control first: on the own runtime the same block selects Anthropic.
  const own = providerOfConfig(ANTHROPIC_CFG);
  assert.equal(own.kind, 'anthropic');
  assert.equal(own.name, 'direct');
  assert.equal(own.implicit, false);
  assert.equal(own.baseUrl, 'https://api.anthropic.com');
  assert.equal(own.keyEnv, 'CLO_ANTHROPIC_API_KEY');
  assert.equal(own.childKey, 'CLO_PROVIDER_API_KEY');
  assert.equal(own.caps, CAPABILITIES.anthropic);
  assert.equal(providerOfEffective(ANTHROPIC_EFF).kind, 'anthropic');
  for (const runtime of [undefined, 'openclaw']) {
    const p = providerOfConfig({ ...ANTHROPIC_CFG, runtime });
    assert.equal(p.kind, 'openrouter', String(runtime));
    assert.equal(p.implicit, true);
    assert.equal(providerOfEffective({ ...ANTHROPIC_EFF, runtime }).kind, 'openrouter', `${runtime}: effective`);
    assert.equal(providerOfConfig({ ...ANTHROPIC_CFG, runtime, apiProvider: { name: 'x', kind: 'anthropic' } }).kind, 'openrouter');
  }
});

test('providerOfEffective reads apiProvider', () => {
  const e = providerOfEffective({ runtime: 'own', apiProvider: { name: 'direct', kind: 'anthropic', baseUrl: 'http://127.0.0.1:7/' }, openrouter: { baseUrl: 'http://127.0.0.1:9/api/v1' } });
  assert.equal(e.kind, 'anthropic');
  assert.equal(e.baseUrl, 'http://127.0.0.1:7/');
  const noBase = providerOfEffective({ runtime: 'own', apiProvider: { name: 'direct', kind: 'anthropic' } });
  assert.equal(noBase.baseUrl, 'https://api.anthropic.com');
  const or = providerOfEffective({ runtime: 'own', apiProvider: { name: 'main', kind: 'openrouter', baseUrl: 'http://127.0.0.1:9/api/v1' } });
  assert.equal(or.kind, 'openrouter');
  assert.equal(or.name, 'main');
  assert.equal(or.implicit, false);
});

test('providerOfConfig: an entry, its base URL, and the OpenRouter fallback to openrouter.baseUrl', () => {
  const withBase = providerOfConfig({ ...ANTHROPIC_CFG, providers: { ...ANTHROPIC_CFG.providers, direct: { kind: 'anthropic', baseUrl: 'http://127.0.0.1:8' } } });
  assert.equal(withBase.baseUrl, 'http://127.0.0.1:8');
  const or = providerOfConfig({ ...ANTHROPIC_CFG, activeProvider: 'openrouter', openrouter: { baseUrl: 'http://127.0.0.1:9/api/v1' } });
  assert.equal(or.kind, 'openrouter');
  assert.equal(or.implicit, false);
  assert.equal(or.baseUrl, 'http://127.0.0.1:9/api/v1');
  // The Anthropic entry never falls back to the OpenRouter URL.
  assert.equal(providerOfConfig({ ...ANTHROPIC_CFG, openrouter: { baseUrl: 'http://127.0.0.1:9/api/v1' } }).baseUrl, 'https://api.anthropic.com');
});

test('each reader refuses the other shape\'s field, so a stray one never picks the kind', () => {
  // A config.json with a stray apiProvider naming OpenRouter while the bot would run on Anthropic.
  const stray = { ...ANTHROPIC_CFG, acks: { provider: { name: 'direct' } }, apiProvider: { name: 'openrouter', kind: 'openrouter' } };
  assert.equal(providerOfConfig(stray), null);
  // Positive control: the same config without it reads as Anthropic.
  const { apiProvider, ...clean } = stray;
  assert.ok(apiProvider);
  assert.equal(providerOfConfig(clean).kind, 'anthropic');
  // An effective file carrying the config's fields.
  assert.equal(providerOfEffective({ ...ANTHROPIC_EFF, providers: ANTHROPIC_CFG.providers }), null);
  assert.equal(providerOfEffective({ ...ANTHROPIC_EFF, activeProvider: 'openrouter' }), null);
  assert.equal(providerOfEffective({ runtime: 'own', providers: ANTHROPIC_CFG.providers, activeProvider: 'direct' }), null);
  assert.equal(providerOfEffective(ANTHROPIC_EFF).kind, 'anthropic');
});

test('provider readers: a block they cannot read gives null, never a guess', () => {
  const badCfg = [
    { ...ANTHROPIC_CFG, activeProvider: 'missing' },
    { ...ANTHROPIC_CFG, activeProvider: undefined },
    { ...ANTHROPIC_CFG, activeProvider: 'toString' },
    { ...ANTHROPIC_CFG, providers: { direct: { kind: 'openai' } } },
    { ...ANTHROPIC_CFG, providers: { direct: null } },
    { ...ANTHROPIC_CFG, providers: [] },
    { ...ANTHROPIC_CFG, providers: null },
    { runtime: 'own', apiProvider: null },
  ];
  for (const x of badCfg) assert.equal(providerOfConfig(x), null, JSON.stringify(x));
  const badEff = [
    { runtime: 'own', apiProvider: { name: 'x', kind: 'openai' } },
    { runtime: 'own', apiProvider: { kind: 'anthropic' } },
    { runtime: 'own', apiProvider: null },
  ];
  for (const x of badEff) assert.equal(providerOfEffective(x), null, JSON.stringify(x));
  // Positive control: the same shapes with a readable entry give one.
  assert.notEqual(providerOfConfig(ANTHROPIC_CFG), null);
  assert.notEqual(providerOfEffective({ runtime: 'own', apiProvider: { name: 'x', kind: 'anthropic' } }), null);
});

const GOOD_ACK = Object.freeze({ kind: 'workspace_monthly', usd: 20, prepaidNoReload: true, at: '2000-01-01T00:00:00.000Z' });

test('hard-cap ack: only the D2 pair, a monthly workspace limit plus prepaid with no reload', () => {
  assert.deepEqual([...R.HARD_CAP_KINDS], ['workspace_monthly']);
  assert.deepEqual(R.hardCapAckProblems(GOOD_ACK), []);
  assert.deepEqual(R.hardCapAckProblems({ ...GOOD_ACK, kind: 'prepaid_no_reload' }), ['kind']);
  assert.deepEqual(R.hardCapAckProblems({ kind: 'prepaid_no_reload', usd: 20 }), ['kind', 'prepaid_no_reload']);
  assert.deepEqual(R.hardCapAckProblems({ ...GOOD_ACK, prepaidNoReload: 'yes' }), ['prepaid_no_reload']);
  for (const usd of [0, -1, Number.NaN, Infinity, '20', undefined]) assert.deepEqual(R.hardCapAckProblems({ ...GOOD_ACK, usd }), ['usd'], String(usd));
  for (const a of [null, undefined, [], 'workspace_monthly']) assert.deepEqual(R.hardCapAckProblems(a), ['missing']);
});

test('clo ack hard-cap refuses in live mode and beside a process, so it never vouches for a Key a process already holds', () => {
  const anthropic = providerOfConfig(ANTHROPIC_CFG);
  const ok = { provider: anthropic, ack: GOOD_ACK, mode: 'dry-run', processRunning: false };
  // Positive control: stopped, in dry-run, with the D2 pair.
  assert.equal(R.hardCapAckRefusal(ok), null);
  assert.equal(R.hardCapAckRefusal({ ...ok, processRunning: true }), 'process');
  assert.equal(R.hardCapAckRefusal({ ...ok, processRunning: undefined }), 'process', 'unknown counts as running');
  assert.equal(R.hardCapAckRefusal({ ...ok, mode: 'live' }), 'live');
  assert.equal(R.hardCapAckRefusal({ ...ok, ack: { ...GOOD_ACK, kind: 'prepaid_no_reload' } }), 'ack');
  assert.equal(R.hardCapAckRefusal({ ...ok, ack: { ...GOOD_ACK, prepaidNoReload: false } }), 'ack');
  assert.equal(R.hardCapAckRefusal({ ...ok, provider: providerOfConfig({}) }), 'not_attested');
  assert.equal(R.hardCapAckRefusal({ ...ok, provider: null }), 'not_attested');
});

test('start check: the whole ack, the Key the process holds, and the recorded rules', () => {
  const anthropic = providerOfConfig(ANTHROPIC_CFG);
  const fp = 'fp-a';
  const base = { provider: anthropic, mode: 'live', ack: GOOD_ACK, control: fp, keyFp: fp };
  // The ack passes on Anthropic, whose rules are recorded.
  assert.deepEqual(R.liveStartCheck(base), { ok: true });
  assert.deepEqual(R.liveStartCheck({ ...base, keyFp: 'fp-b' }), { ok: false, code: 'hard_cap' });
  assert.deepEqual(R.liveStartCheck({ ...base, control: null }), { ok: false, code: 'hard_cap' });
  assert.deepEqual(R.liveStartCheck({ ...base, keyFp: null, control: null }), { ok: false, code: 'hard_cap' });
  // A weaker ack bound to the right Key does not carry a live start.
  assert.deepEqual(R.liveStartCheck({ ...base, ack: { kind: 'prepaid_no_reload', usd: 20, prepaidNoReload: false } }), { ok: false, code: 'hard_cap' });
  assert.deepEqual(R.liveStartCheck({ ...base, ack: undefined }), { ok: false, code: 'hard_cap' });
  // A kind whose rules are recorded and whose cap is attested: the matching Key and the D2 ack pass, and only they do.
  const recorded = Object.freeze({ ...anthropic, kind: 'openrouter' });
  assert.deepEqual(R.liveStartCheck({ ...base, provider: recorded }), { ok: true });
  assert.deepEqual(R.liveStartCheck({ ...base, provider: recorded, keyFp: 'fp-b' }), { ok: false, code: 'hard_cap' });
  // OpenRouter has its Key read instead; dry-run sends nothing; no provider is no start.
  assert.deepEqual(R.liveStartCheck({ ...base, provider: providerOfConfig({}), ack: undefined, control: null }), { ok: true });
  assert.deepEqual(R.liveStartCheck({ ...base, mode: 'dry-run', keyFp: 'fp-b' }), { ok: true });
  assert.deepEqual(R.liveStartCheck({ ...base, provider: null }), { ok: false, code: 'provider' });
});

// The fake adapter and client that later clusters test against follow the same contract.
test('the fake adapter and client give contract-shaped Results', async () => {
  const { checkResult, createFakeAdapter, createFakeClient, errorInfo, fakeResponse, fakeResult, fakeUsage, okResult } = await import('../fixtures/fake-adapter.mjs');
  const ad = createFakeAdapter({ kind: 'anthropic' });
  assert.equal(ad.kind, 'anthropic');
  assert.equal(ad.retryEvent, 'anthropic_retry');
  assert.equal(ad.idRule, R.MODEL_ID_RULES.anthropic);
  const req = ad.request('K', 'http://127.0.0.1:9');
  assert.equal(req.url.includes('K'), false, 'the Key is in a header only');
  const body = ad.turnBody({ model: 'claude-opus-5-5', effort: 'low', maxTokens: 3000, system: 'SYS', user: 'USER' });
  assert.equal(ad.systemTextOf(body), 'SYS');
  assert.equal(ad.userTextOf(body), 'USER');
  assert.equal(ad.requestedModel(body), 'claude-opus-5-5');
  const wire = await fakeResponse({ kind: 'ok', message: { content: 'x', refusal: false, toolCalls: 0 }, finishReason: 'stop', usage: fakeUsage('anthropic'), extra: 'dropped' }).json();
  const ok = ad.classify(200, wire, 'claude-opus-5-5');
  assert.deepEqual(checkResult(ok), []);
  assert.equal(ok.kind, 'ok');
  assert.equal(Object.hasOwn(ok, 'extra'), false);
  for (const r of [ad.classify(200, null, null), ad.classify(200, {}, null), ad.parseError(500, null), ok, okResult(), fakeResult('not_sent'),
    fakeResult('error', 'http', { status: 403, info: errorInfo(403, 'anthropic_permission') })]) {
    assert.deepEqual(checkResult(r), [], JSON.stringify(r));
  }
  // Positive control: checkResult does find what is wrong.
  assert.ok(checkResult({ ...okResult(), text: 'x' }).length > 0);
  assert.ok(checkResult(fakeResult('error', 'moderation')).length > 0);
  assert.ok(checkResult(fakeResult('error', 'http', { info: { status: 1 } })).length > 0);

  const c = createFakeClient({ adapter: ad, script: [okResult('一'), () => fakeResult('error', 'timeout')] });
  assert.equal((await c.post(body)).message.content, '一');
  assert.equal((await c.post(body)).reason, 'timeout');
  assert.equal(c.unscripted, 0);
  assert.equal((await c.post(body)).reason, 'network');
  assert.equal(c.unscripted, 1);
  const ctl = new AbortController();
  ctl.abort();
  assert.equal((await c.post(body, { signal: ctl.signal })).kind, 'aborted');
  assert.equal((await createFakeClient({ getKey: () => null }).post(body)).kind, 'not_sent');
  assert.equal(c.posts.length, 3, 'only posts that would leave are recorded');
});

test('fake Keys', async () => {
  const k = await import('../harness/fake-keys.mjs');
  assert.equal(k.FAKE_ANTHROPIC_KEY, 'sk-ant-FAKE-KEY-FOR-LOCAL-MOCK-ONLY');
  assert.equal(k.FAKE_OPENROUTER_KEY, k.FAKE_MODEL_KEY);
  assert.match(k.FAKE_OPENROUTER_KEY, /^sk-or-v1-FAKE-/);
  assert.notEqual(k.FAKE_ANTHROPIC_PROBE_KEY, k.FAKE_ANTHROPIC_KEY);
});

// Contract section 8.2: the facts the v1-to-v2 backup and its restore rest on, shown on a scratch SQLite file. K3's
// store tests cover its own migration; these pin why the recipe is VACUUM INTO, a data_version check, and a restore that
// removes -wal and -shm.
test('schema backup recipe: VACUUM INTO keeps WAL rows, a commit in between is seen, and a restore drops -wal', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const fs = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = fs.mkdtempSync(join(tmpdir(), 'clo-backup-'));
  const file = join(dir, 'clo.db');
  const rows = (f) => { const d = new DatabaseSync(f); try { return { n: d.prepare('SELECT count(*) AS n FROM reservations').get().n, v: d.prepare('PRAGMA user_version').get().user_version }; } finally { d.close(); } };
  const a = new DatabaseSync(file);
  const b = new DatabaseSync(file);
  try {
    a.exec('PRAGMA journal_mode=WAL');
    a.exec('PRAGMA wal_autocheckpoint=0');
    a.exec('CREATE TABLE reservations(id INTEGER PRIMARY KEY, held INTEGER)');
    a.exec('PRAGMA user_version=1');
    a.exec('INSERT INTO reservations(held) VALUES (100), (200)');
    assert.equal(fs.existsSync(`${file}-wal`), true, 'the rows sit in the WAL, not yet in clo.db');
    // A copy of clo.db alone misses them; VACUUM INTO has them, at user_version 1, in a file with no -wal of its own.
    fs.copyFileSync(file, join(dir, 'plain.bak'));
    assert.throws(() => rows(join(dir, 'plain.bak')), /no such table/);
    const bak = join(dir, 'clo.db.v1.bak');
    const dv = b.prepare('PRAGMA data_version').get().data_version;
    b.exec(`VACUUM INTO '${bak.replaceAll("'", "''")}'`);
    assert.deepEqual(rows(bak), { n: 2, v: 1 });
    // It cannot run inside the migration's BEGIN IMMEDIATE, so the step checks data_version under the lock instead.
    b.exec('BEGIN IMMEDIATE');
    assert.equal(b.prepare('PRAGMA data_version').get().data_version, dv, 'positive control: no commit since the snapshot');
    assert.throws(() => b.exec(`VACUUM INTO '${join(dir, 'x.bak').replaceAll("'", "''")}'`), /within a transaction/);
    b.exec('ROLLBACK');
    a.exec('INSERT INTO reservations(held) VALUES (300)');
    b.exec('BEGIN IMMEDIATE');
    assert.notEqual(b.prepare('PRAGMA data_version').get().data_version, dv, 'a commit after the snapshot is seen under the lock');
    b.exec('ROLLBACK');
    // The step itself, then a v2 write that stays in the WAL, as after a killed process.
    a.exec('BEGIN IMMEDIATE');
    a.exec('ALTER TABLE reservations ADD COLUMN provider TEXT');
    a.exec('PRAGMA user_version=2');
    a.exec('COMMIT');
    a.exec("INSERT INTO reservations(held, provider) VALUES (400, 'anthropic')");
    fs.copyFileSync(`${file}-wal`, join(dir, 'stale-wal'));
    fs.copyFileSync(`${file}-shm`, join(dir, 'stale-shm'));
  } finally {
    a.close();
    b.close();
  }
  try {
    const restore = (removeWal) => {
      for (const s of ['', '-wal', '-shm']) fs.rmSync(file + s, { force: true });
      fs.copyFileSync(join(dir, 'clo.db.v1.bak'), file);
      if (!removeWal) {
        fs.copyFileSync(join(dir, 'stale-wal'), `${file}-wal`);
        fs.copyFileSync(join(dir, 'stale-shm'), `${file}-shm`);
      }
      return rows(file);
    };
    // A v2 -wal left beside the restored file is replayed onto it; removed, the restore is the v1 backup.
    assert.notDeepEqual(restore(false), { n: 2, v: 1 });
    assert.deepEqual(restore(true), { n: 2, v: 1 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
