// Smoke run of the own runtime: the real bot process (src/bot/main.mjs, spawned with clo start's env and arguments),
// mock QQ, mock OpenRouter, and a net guard that lets the bot reach those two mocks and nothing else.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import { checkSentinels } from '../../src/clo-plugin/lib/core/contentPolicy.js';
import { fullAt, nextId } from '../fixtures/qq-events.mjs';
import { cleanChildEnv } from '../harness/clean-env.mjs';
import { NODE } from '../harness/gateway.mjs';
import {
  assertEveryPostLegal, BOT_MEMBER, FAKE_MODEL_KEY, FAKE_QQ_SECRET, GROUP_A, listeningPids, MEMBER, netAttempts, pidAlive, PRIMARY_ID, processTree, readJsonl,
  startOwnStack,
} from '../harness/own.mjs';

const suiteStart = Date.now();
const REPLY = '可洛的冒烟回复。';
// Usage with a cache write, so settlement has a real figure to take. The provider's cost ($0.0234) is below the tokens at
// the locked price (400 input at $5/M, 40 output at $20/M, 3600 five-minute writes at $6.25/M), and it still settles:
// it is what the Key is charged.
const USAGE = { prompt_tokens: 4000, completion_tokens: 40, total_tokens: 4040, cost: 0.0234, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 3600 } };
const USAGE_COMPUTED_MICROS = 400 * 5 + 40 * 20 + 3600 * 6.25;

let s;
let id;
let botPid;
let listenersWhileUp;
let treeWhileUp;
let stopped;

const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
// Every cache_control marker anywhere in a request body.
function cacheMarkers(node, out = []) {
  if (Array.isArray(node)) for (const v of node) cacheMarkers(v, out);
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'cache_control') out.push(v);
      else cacheMarkers(v, out);
    }
  }
  return out;
}

before(async () => {
  s = await startOwnStack({ label: 'smoke', script: () => ({ text: REPLY, usage: USAGE }) });
  botPid = s.bot.pid;
  id = nextId();
  s.send(fullAt('冒烟测试的问题', { id }));
  await s.waitRow(id);
  await s.waitPosts(1);
  listenersWhileUp = listeningPids();
  treeWhileUp = processTree(botPid);
  stopped = await s.stop();
});

after(() => {
  s?.cleanup();
});

test('one real @ gets exactly one reply, passive, with msg_id and msg_seq 1', () => {
  const row = s.row(id);
  assert.equal(`${row.state}:${row.reason}`, 'completed:sent');
  assert.equal(row.cls, 'at');
  const posts = s.postBodies();
  assert.equal(posts.length, 1, 'exactly one message POST');
  assert.equal(posts[0].path, `/v2/groups/${GROUP_A}/messages`);
  assert.equal(posts[0].msg_id, id);
  assert.equal(posts[0].msg_seq, 1);
  assert.equal(posts[0].content, REPLY);
  assert.equal(s.sends(id).length, 1);
  assert.equal(s.sends(id)[0].state, 'sent');
  assertEveryPostLegal(s);
});

test('the bot ran as the own runtime, with no mismatch against effective.json', () => {
  assert.equal(s.eff.runtime, 'own');
  assert.equal(s.event('start_account').at(-1)?.kind, 'own');
  assert.deepEqual(s.event('runtime_mismatch'), [], 'the gate and exit were built as the own runtime');
});

test('one model request: no tools, one cache marker at the end of the system block, sentinels on the sent system text', () => {
  const reqs = s.agentRequests();
  assert.equal(reqs.length, 1, 'one main request');
  assert.equal(s.decisionRequests().length, 0, 'a real @ needs no judging call');
  const { body, headers } = reqs[0];
  assert.equal(body.model, PRIMARY_ID);
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, s.eff.models.primary.maxTokens);
  assert.deepEqual(body.reasoning, { effort: s.eff.models.primary.effort });
  assert.deepEqual(body.usage, { include: true });
  assert.equal(body.provider?.require_parameters, true);
  for (const k of ['tools', 'tool_choice', 'functions', 'user', 'fallbacks', 'models']) assert.equal(body[k], undefined, `no ${k}`);
  for (const h of ['http-referer', 'x-title', 'referer']) assert.equal(headers[h], undefined, `no ${h} header`);
  assert.equal(headers.authorization, `Bearer ${FAKE_MODEL_KEY}`);

  assert.equal(body.messages.length, 2);
  const [system, user] = body.messages;
  assert.equal(system.role, 'system');
  assert.equal(system.content.length, 1);
  const block = system.content[0];
  assert.deepEqual(block.cache_control, { type: 'ephemeral' });
  assert.deepEqual(cacheMarkers(body), [{ type: 'ephemeral' }], 'exactly one cache marker in the whole body');
  assert.equal(sha(block.text), sha(s.systemPrompt), 'the system text is the rendered prompt, byte for byte');
  assert.equal(sha(readFileSync(s.paths.systemPromptFile, 'utf8')), sha(block.text));
  assert.deepEqual(checkSentinels(block.text, s.eff.contentPolicy.version), { ok: true });

  assert.equal(user.role, 'user');
  assert.match(user.content, /^\[clo-turn class=at time=\d{4}-\d\d-\d\d \d\d:\d\d Asia\/Shanghai\]\n\{/);
  const payload = JSON.parse(user.content.slice(user.content.indexOf('\n') + 1));
  assert.equal(payload.text, '冒烟测试的问题');
  const wire = JSON.stringify(body);
  for (const raw of [BOT_MEMBER, MEMBER, GROUP_A, id, FAKE_QQ_SECRET]) assert.ok(!wire.includes(raw), 'no raw ID or secret reaches the model');
  assert.ok(!wire.includes('<@'), 'no mention tag');
});

test('usage settles the reply hold at the provider cost, even below the tokens at the locked price', () => {
  const rows = s.reservations(id);
  assert.ok(rows.length >= 1, 'a hold was taken');
  const reply = rows.find((r) => r.category === 'reply') ?? rows[0];
  assert.equal(reply.status, 'settled');
  assert.ok(USAGE_COMPUTED_MICROS > Math.ceil(USAGE.cost * 1e6), 'the fixture puts the tokens above the reported cost');
  const p = s.eff.models.primary.price;
  assert.deepEqual([p.inputPerM, p.outputPerM, p.cacheWritePerM], [5, 20, 6.25], 'the lock the figure above assumes');
  assert.equal(reply.actual_micros, Math.ceil(USAGE.cost * 1e6));
  assert.equal(reply.source, 'model.usage');
  assert.ok(reply.held_micros >= reply.actual_micros, 'the hold covered the call');
  assert.deepEqual(s.allReservations().filter((r) => r.status === 'held' || r.status === 'unsettled'), [], 'nothing left open');
  assert.equal(s.control('paid_paused'), null);
});

test('stop ends the process on its own stop request and leaves nothing running', () => {
  assert.equal(stopped.how, 'requested', 'the bot ended on its stop request, not by taskkill');
  assert.equal(stopped.code, 0);
  assert.ok(treeWhileUp.some((p) => p.pid === botPid), 'positive control: the process list saw the bot while it ran');
  // Windows attaches a console host to every console program; it is the OS's, not something the bot started.
  const children = treeWhileUp.filter((p) => p.ppid === botPid);
  assert.deepEqual(children.filter((p) => p.name.toLowerCase() !== 'conhost.exe').map((p) => p.name), [], 'the bot started no child process');
  assert.equal(pidAlive(botPid), false, 'the bot process is gone');
  assert.deepEqual(children.map((p) => p.pid).filter(pidAlive), [], 'its console host is gone too');
  assert.equal(s.event('bot_stop').at(-1)?.reason, 'requested');
});

test('nothing listens: no TCP listener or UDP socket of the bot, and the guard recorded no attempt', () => {
  assert.ok((listenersWhileUp.get(process.pid) ?? []).some((x) => x.startsWith('tcp ')), 'positive control: netstat shows the mocks listening in this process');
  assert.equal(listenersWhileUp.get(botPid), undefined, `the bot held ${JSON.stringify(listenersWhileUp.get(botPid))}`);
  assert.deepEqual(netAttempts(s), [], 'no refused connection, lookup, listen or UDP socket');
});

test('the allowlist guard refuses a loopback port outside the mocks and lets an allowed one through', async () => {
  // A stand-in for a listener on the machine that is not a mock: the guard must refuse it even though it is loopback.
  const other = createServer((sock) => sock.end());
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  const otherPort = other.address().port;
  const allowed = createServer((sock) => sock.end());
  try {
    // The guard only knows the ports it was written with, which are closed now; one of them is reopened here.
    const guardSrc = readFileSync(s.guardFile, 'utf8');
    const allowedPort = JSON.parse(/const ALLOW = new Set\((\[[^\]]*\])\)/.exec(guardSrc)[1])[0];
    await new Promise((r, j) => { allowed.once('error', j); allowed.listen(allowedPort, '127.0.0.1', r); });
    const log = join(s.tmp, 'guard-probe.jsonl');
    const probe = `import net from 'node:net';
const go = (port) => new Promise((r) => { const c = net.connect({ host: '127.0.0.1', port }); c.on('connect', () => { c.destroy(); r('ok'); }); c.on('error', (e) => r(e.code)); });
const srv = net.createServer();
const listen = await new Promise((r) => { srv.once('error', (e) => r(e.code)); srv.once('listening', () => { srv.close(); r('ok'); }); srv.listen(0, '127.0.0.1'); });
console.log(JSON.stringify({ other: await go(${otherPort}), allowed: await go(${allowedPort}), listen }));`;
    const r = spawnSync(NODE, [`--import=${pathToFileURL(s.guardFile).href}`,'--input-type=module', '-e', probe], {
      cwd: s.tmp, env: cleanChildEnv({ CLO_NET_GUARD_LOG: log }), encoding: 'utf8', windowsHide: true, timeout: 30000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim()), { other: 'ECONNREFUSED', allowed: 'ok', listen: 'EACCES' });
    assert.deepEqual(readJsonl(log).map((v) => `${v.kind}:${v.port ?? ''}`).sort(), ['listen:0', `port:${otherPort}`]);
  } finally {
    await new Promise((r) => other.close(r));
    await new Promise((r) => allowed.close(r));
  }
});

test('timings', (t) => {
  assert.equal(s.boots.length, 1);
  t.diagnostic(`boot to READY: ${s.boots[0]} ms`);
  t.diagnostic(`suite so far: ${Date.now() - suiteStart} ms`);
});
