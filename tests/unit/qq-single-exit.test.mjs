// TQ16, static half. Replaces the old regex scan, which missed aliases and most SDK methods.
// Every file under src/clo-plugin is parsed. Planted offenders must all be flagged.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
// Installed with OpenClaw. Not a project dependency.
const { parse } = await import(pathToFileURL(join(ROOT, '.runtime', 'pkg', 'node_modules', 'acorn', 'dist', 'acorn.mjs')).href);

const SDK = '@tencent-connect/qqbot-nodejs';
const SEND_SURFACE = new Set(['api', 'apiClient', 'messageApi', 'mediaApi', 'chunkedMediaApi', 'tokenManager', 'getCredentials',
  'apiRequest', 'openStream', 'uploadMedia', 'recallMessage', 'acknowledgeInteraction', 'sendWakeup', 'gateway']);
// Our own names that start with send. Nothing else starting with send is allowed outside exit.js.
const OWN_SEND_NAMES = new Set(['sendFixed', 'sendDays']);
const NET_MODULES = new Set(['ws', 'undici', 'node:http', 'node:https', 'node:net', 'node:tls', 'http', 'https', 'net', 'tls']);
// models.js only takes an injected fetch for the console's catalog read. The Gateway never calls it.
// openrouterChat.js is the one OpenRouter client; decision.js and turn.js reach the model through it.
const FETCH_FILES = new Set(['decision.js', 'ledger.js', 'models.js', 'openrouterChat.js']);
const BOT_ALLOWED_IN_EXIT = new Set(['api', 'appId']);
const EXIT_API_ALLOWED = new Set(['post', 'get']);

function isSendSurface(name) {
  if (typeof name !== 'string') return false;
  if (SEND_SURFACE.has(name)) return true;
  return (name === 'send' || /^send[A-Z]/.test(name)) && !OWN_SEND_NAMES.has(name);
}

const keyName = (node) => (node.computed ? null : (node.key?.name ?? node.key?.value ?? null));

export function scanSource(file, code) {
  const name = basename(file);
  const isExit = name === 'exit.js';
  const isConnection = name === 'connection.js';
  const problems = [];
  const flag = (rule, node) => problems.push({ rule, line: node.loc?.start?.line ?? 0 });
  const ast = parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true });

  function checkImportSource(source, node) {
    if (source === SDK || source?.startsWith?.(`${SDK}/`)) {
      if (!isConnection) flag('sdk-import', node);
    }
    if (NET_MODULES.has(source)) flag('net-module', node);
  }

  function visit(node, parent) {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'ImportDeclaration':
        checkImportSource(node.source.value, node);
        break;
      case 'ImportExpression':
        if (node.source.type === 'Literal') {
          if (node.source.value === SDK) flag('sdk-dynamic-import', node);
          checkImportSource(node.source.value, node);
        } else {
          flag('computed-dynamic-import', node);
        }
        break;
      case 'CallExpression':
        if (node.callee.type === 'Identifier' && node.callee.name === 'require') flag('require', node);
        for (const arg of node.arguments) {
          if (arg.type === 'Identifier' && arg.name === 'bot') flag('bot-as-argument', arg);
          if (arg.type === 'ObjectExpression') {
            for (const p of arg.properties) {
              const value = p.value;
              if (value?.type !== 'Identifier' || value.name !== 'bot') continue;
              const allowed = isConnection && node.callee.type === 'Identifier' && node.callee.name === 'createExit';
              if (!allowed) flag('bot-in-object', p);
            }
          }
        }
        break;
      case 'MemberExpression': {
        const prop = node.computed ? null : node.property.name;
        if (node.object.type === 'Identifier' && node.object.name === 'bot') {
          if (node.computed) flag('bracket-on-bot', node);
          else if (isExit && !BOT_ALLOWED_IN_EXIT.has(prop)) flag('bot-member-in-exit', node);
          else if (isConnection && !['on', 'start', 'stop'].includes(prop)) flag('bot-member-in-connection', node);
          else if (!isExit && !isConnection) flag('bot-outside-channel', node);
        }
        if (!isExit && isSendSurface(prop)) flag(`send-surface:${prop}`, node);
        if (isExit && node.object.type === 'MemberExpression' && node.object.property?.name === 'api' && !EXIT_API_ALLOWED.has(prop)) flag('exit-api-method', node);
        if (prop === 'fetch' && !FETCH_FILES.has(name)) flag('fetch', node);
        break;
      }
      case 'ObjectPattern':
        for (const p of node.properties) {
          const key = p.type === 'Property' ? keyName(p) : null;
          if (key && !isExit && isSendSurface(key)) flag(`destructure:${key}`, p);
          if (key === 'fetch' && !FETCH_FILES.has(name)) flag('fetch', p);
        }
        break;
      case 'VariableDeclarator':
        // Aliasing the object hides later member access from a name-based check.
        if (node.init?.type === 'Identifier' && node.init.name === 'bot') flag('bot-alias', node);
        if (node.id?.type === 'ObjectPattern' && node.init?.type === 'Identifier' && node.init.name === 'bot' && !isExit && !isConnection) flag('bot-destructure', node);
        break;
      case 'Identifier':
        if (node.name === 'fetch' && !FETCH_FILES.has(name) && !(parent?.type === 'Property' && parent.key === node && !parent.computed)) flag('fetch', node);
        if (node.name === 'QQBot' && !isConnection) flag('qqbot-outside-connection', node);
        break;
      default:
        break;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      if (Array.isArray(v)) for (const child of v) visit(child, node);
      else if (v && typeof v.type === 'string') visit(v, node);
    }
  }
  visit(ast, null);
  return problems;
}

function jsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry !== 'node_modules') jsFiles(p, out);
    } else if (/\.(js|mjs|cjs)$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

const PLUGIN = join(ROOT, 'src', 'clo-plugin');
const OFFENDERS = join(HERE, '..', 'fixtures', 'single-exit-offenders');

test('the scan really reads the whole plugin', () => {
  const files = jsFiles(PLUGIN).map((f) => relative(PLUGIN, f).replaceAll('\\', '/'));
  for (const expected of ['index.js', 'lib/channels/qq/connection.js', 'lib/channels/qq/exit.js', 'lib/channels/qq/dispatch.js', 'lib/channels/qq/hooks.js', 'lib/channels/qq/services.js', 'lib/core/gate.js']) {
    assert.ok(files.includes(expected), expected);
  }
});

test('the real plugin has no violation', () => {
  const found = [];
  for (const file of jsFiles(PLUGIN)) {
    for (const p of scanSource(file, readFileSync(file, 'utf8'))) found.push(`${relative(PLUGIN, file)}:${p.line} ${p.rule}`);
  }
  assert.deepEqual(found, []);
});

test('exit.js is where the POST is, once, and connection.js builds the bot once', () => {
  const exit = readFileSync(join(PLUGIN, 'lib', 'channels', 'qq', 'exit.js'), 'utf8');
  assert.equal(exit.match(/bot\.api\.post\(/g)?.length, 1);
  assert.equal(exit.match(/bot\.api\.get\(/g)?.length, 1);
  const conn = readFileSync(join(PLUGIN, 'lib', 'channels', 'qq', 'connection.js'), 'utf8');
  assert.equal(conn.match(/new QQBot\(/g)?.length, 1);
  assert.equal(conn.match(/createExit\(/g)?.length, 1);
});

const offenders = readdirSync(OFFENDERS).filter((f) => f.endsWith('.js'));

test('there are planted offenders to find', () => {
  assert.ok(offenders.length >= 20, `${offenders.length}`);
});

for (const file of offenders) {
  // The fixture's first line names the rule it must trip, and the file it pretends to be.
  const code = readFileSync(join(OFFENDERS, file), 'utf8');
  const header = /^\/\/ expect: (\S+)(?: as: (\S+))?/.exec(code);
  test(`planted: ${file} is flagged as ${header?.[1]}`, () => {
    assert.ok(header, 'fixture needs an expect header');
    const problems = scanSource(header[2] ?? file, code);
    assert.ok(problems.some((p) => p.rule === header[1] || p.rule.startsWith(`${header[1]}:`)), `found: ${JSON.stringify(problems)}`);
  });
}

test('control: a harmless file with similar words is not flagged', () => {
  const code = `
    import { readFileSync } from 'node:fs';
    export const sendFixedLater = null;
    export function f(store, exit, api) {
      api.on('x', () => {});
      api.registerTool({});
      const fetched = readFileSync('x');
      return [store.sendsForEvent('k'), exit.sendFixed('r', 'l'), exit.collect('t'), fetched];
    }`;
  assert.deepEqual(scanSource('other.js', code), []);
});
