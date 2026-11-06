// The host had a second send path (its message CLI reaching the plugin's outbound.sendText), which had to be shown
// closed. The own runtime has no such surface at all: the bot loads no host and no plugin entry, holds no listening
// socket anyone could send through, and every POST it makes is a passive reply from the one exit.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { fullAt, nextId, push } from '../fixtures/qq-events.mjs';
import { assertEveryPostLegal, listeningPids, netAttempts, ROOT, startOwnStack } from '../harness/own.mjs';

// Installed with OpenClaw, read-only here, as unit/qq-single-exit uses it.
const { parse } = await import(pathToFileURL(join(ROOT, '.runtime', 'pkg', 'node_modules', 'acorn', 'dist', 'acorn.mjs')).href);

const ENTRY = join(ROOT, 'src', 'bot', 'main.mjs');
const PLUGIN_ENTRY = join(ROOT, 'src', 'clo-plugin', 'index.js');
const rel = (f) => relative(ROOT, f).replaceAll('\\', '/');

/** Every module the bot entry reaches by static or literal dynamic import: project files and bare specifiers. */
function importGraph(entry) {
  const files = new Set();
  const bare = new Set();
  const computed = [];
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    const ast = parse(readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true });
    const specs = [];
    (function walk(node) {
      if (!node || typeof node.type !== 'string') return;
      if ((node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source) specs.push(node.source.value);
      if (node.type === 'ImportExpression') {
        if (node.source.type === 'Literal') specs.push(node.source.value);
        else computed.push(rel(file));
      }
      for (const v of Object.values(node)) {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v);
      }
    })(ast);
    for (const spec of specs) {
      if (spec.startsWith('.')) {
        const target = resolve(dirname(file), spec);
        assert.ok(existsSync(target), `${rel(file)} imports a missing ${spec}`);
        queue.push(target);
      } else {
        bare.add(spec);
      }
    }
  }
  return { files: [...files].map(rel).sort(), bare: [...bare].sort(), computed };
}

let s;
let listeners;

before(async () => {
  s = await startOwnStack({ label: 'closed', script: () => ({ text: '对照回复。' }) });
});

after(async () => {
  await s?.stop();
  s?.cleanup();
});

test('positive control: a pushed event produces one passive POST', async () => {
  const id = nextId();
  push(s, fullAt('对照', { id }));
  await s.waitRow(id);
  const posts = await s.waitPosts(1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].msg_id, id);
  listeners = listeningPids();
});

test('the bot loads no host and no plugin entry, so there is no outbound.sendText to reach', () => {
  const g = importGraph(ENTRY);
  // Positive control: the walk does reach the modules the bot really runs.
  for (const f of ['src/bot/services.mjs', 'src/clo-plugin/lib/channels/qq/connection.js', 'src/clo-plugin/lib/channels/qq/exit.js', 'src/clo-plugin/lib/core/turn.js']) {
    assert.ok(g.files.includes(f), `the graph reaches ${f}`);
  }
  assert.ok(!g.files.includes(rel(PLUGIN_ENTRY)), 'the plugin entry with the host channel is not loaded');
  assert.deepEqual(g.bare.filter((b) => b === 'openclaw' || b.startsWith('openclaw/') || b.startsWith('@openclaw/') || b.startsWith('@tencent-connect/openclaw')), [], 'no host package');
  assert.deepEqual(g.bare.filter((b) => !b.startsWith('node:')), ['@tencent-connect/qqbot-nodejs'], 'the official SDK is the one package it loads');
  assert.deepEqual(g.computed, [], 'no import whose target cannot be read here');
});

test('nothing listens: no socket of the bot that a second sender could use', () => {
  assert.ok((listeners.get(process.pid) ?? []).some((x) => x.startsWith('tcp ')), 'positive control: netstat shows the mocks listening in this process');
  assert.equal(listeners.get(s.bot.pid), undefined, `the bot held ${JSON.stringify(listeners.get(s.bot.pid))}`);
});

test('last: every POST on this stack is legal, and the bot reached nothing but the mocks', () => {
  assertEveryPostLegal(s, { minPosts: 1 });
  assert.deepEqual(netAttempts(s), []);
});
