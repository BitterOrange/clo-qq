// TQ16, static half. Replaces the old regex scan, which missed aliases and most SDK methods.
// Every file under src/clo-plugin, src/bot and src/tools is parsed, each tree with its own allowlists. Planted
// offenders must all be flagged.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
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
// Model provider SDKs are never imported, anywhere: their own retries and their own fetch would sit outside the one
// chat transport and outside this scan.
const isModelSdk = (source) => typeof source === 'string'
  && (source === '@anthropic-ai/sdk' || source.startsWith('@anthropic-ai/') || source === 'openai' || source.startsWith('openai/'));
// Allowlists hold paths relative to their tree, never bare file names: a new file that shares a name with an allowed
// one somewhere else in the tree gets no rights from it.
// models.js only takes an injected fetch for the console's catalog read. The Gateway never calls it.
// modelChat.js is the one chat transport for every provider; decision.js only hands an injected fetch to it.
const FETCH_FILES = new Set(['lib/core/decision.js', 'lib/core/ledger.js', 'lib/core/models.js', 'lib/core/providers/modelChat.js']);
// Of those, the files that may call fetch. The others may only pass an injected one on (see passOnlyUse).
const FETCH_CALL_FILES = new Set(['lib/core/ledger.js', 'lib/core/models.js', 'lib/core/providers/modelChat.js']);
// The own runtime builds its clients from an injected fetch and never calls it.
const BOT_FETCH_FILES = new Set(['main.mjs', 'services.mjs']);
// The probe tools. They run alone, never beside the Gateway or the bot, and are the only tools that reach a network.
const TOOL_PROBE_FILES = new Set(['q5-probe.mjs', 'q5-anthropic.mjs', 'qq-listener.mjs', 'qq-send-probe.mjs']);
const EXIT_FILE = 'lib/channels/qq/exit.js';
const CONNECTION_FILE = 'lib/channels/qq/connection.js';
// Per tree: who may name fetch, who may call it, who may import the QQ SDK, who may import a network module.
// Exit and connection rules hold by path inside the plugin only.
const SCOPES = {
  plugin: { fetchFiles: FETCH_FILES, fetchCallFiles: FETCH_CALL_FILES, qqSdkFiles: new Set([CONNECTION_FILE]), netFiles: new Set(), channel: true },
  bot: { fetchFiles: BOT_FETCH_FILES, fetchCallFiles: new Set(), qqSdkFiles: new Set(), netFiles: new Set(), channel: false },
  tools: { fetchFiles: TOOL_PROBE_FILES, fetchCallFiles: TOOL_PROBE_FILES, qqSdkFiles: new Set(['qq-listener.mjs', 'qq-send-probe.mjs']), netFiles: new Set(['q5-net-guard.mjs', 'q5-probe.mjs']), channel: false },
};
const PLUGIN = join(ROOT, 'src', 'clo-plugin');
const TREES = { plugin: PLUGIN, bot: join(ROOT, 'src', 'bot'), tools: join(ROOT, 'src', 'tools') };
const BOT_ALLOWED_IN_EXIT = new Set(['api', 'appId']);
const EXIT_API_ALLOWED = new Set(['post', 'get']);

function isSendSurface(name) {
  if (typeof name !== 'string') return false;
  if (SEND_SURFACE.has(name)) return true;
  return (name === 'send' || /^send[A-Z]/.test(name)) && !OWN_SEND_NAMES.has(name);
}

// A computed key that is a string literal names that key just the same: { ['fetch']: go } is { fetch: go }.
const keyName = (node) => (node.computed
  ? (node.key?.type === 'Literal' && typeof node.key.value === 'string' ? node.key.value : null)
  : (node.key?.name ?? node.key?.value ?? null));

const isFetchRef = (node) => (node?.type === 'Identifier' && node.name === 'fetch')
  || (node?.type === 'MemberExpression' && (node.computed ? node.property.type === 'Literal' && node.property.value === 'fetch' : node.property.name === 'fetch'));

const isFetchName = (node) => node?.type === 'Identifier' && node.name === 'fetch';
const isGlobalFetch = (node) => node?.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier'
  && node.object.name === 'globalThis' && node.property.name === 'fetch';
const isShorthandBinding = (prop, holder) => prop?.type === 'Property' && prop.shorthand && holder?.type === 'ObjectPattern';

// In a file that may name fetch but not call it, the only places fetch may stand: bound under its own name by a
// destructuring pattern ({ fetch } or { fetch = globalThis.fetch }), and handed on under its own name in an object
// literal that is itself a call argument (make({ fetch })). Anything else, such as a rename, .call or .apply,
// Reflect.apply, a sequence, an array or an object kept in a variable, could call it out of sight of fetch-call.
// Out of reach of any static scan: a key built at run time, or a function in the same file that reads the passed
// object some other way. Review covers those.
function passOnlyUse(node, [parent, grand, great]) {
  if (isFetchName(node)) {
    if (isShorthandBinding(parent, grand) && parent.value === node) return true;
    if (parent?.type === 'AssignmentPattern' && parent.left === node && isShorthandBinding(grand, great) && grand.value === parent) return true;
    return parent?.type === 'Property' && parent.value === node && !parent.computed && keyName(parent) === 'fetch'
      && grand?.type === 'ObjectExpression' && (great?.type === 'CallExpression' || great?.type === 'NewExpression')
      && great.arguments.includes(grand);
  }
  // The default in { fetch = globalThis.fetch }.
  return isGlobalFetch(node) && parent?.type === 'AssignmentPattern' && parent.right === node && isFetchName(parent.left)
    && isShorthandBinding(grand, great) && grand.value === parent;
}

// Allowlists match the path inside the tree. An absolute path is made relative to its tree; anything else is taken as
// already relative (planted offenders name the path they pretend to have).
function treePath(file, scopeName) {
  return (isAbsolute(file) ? relative(TREES[scopeName], file) : file).replaceAll('\\', '/');
}

export function scanSource(file, code, scopeName = 'plugin') {
  if (!Object.hasOwn(SCOPES, scopeName)) throw new TypeError(`unknown scope ${scopeName}`);
  const scope = SCOPES[scopeName];
  const name = treePath(file, scopeName);
  const isExit = scope.channel && name === EXIT_FILE;
  const isConnection = scope.channel && name === CONNECTION_FILE;
  const mayNameFetch = scope.fetchFiles.has(name);
  const mayCallFetch = scope.fetchCallFiles.has(name);
  const passOnly = mayNameFetch && !mayCallFetch;
  const problems = [];
  const flag = (rule, node) => problems.push({ rule, line: node.loc?.start?.line ?? 0 });
  const ast = parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true });

  function checkImportSource(source, node) {
    if (source === SDK || source?.startsWith?.(`${SDK}/`)) {
      if (!scope.qqSdkFiles.has(name)) flag('sdk-import', node);
    }
    if (NET_MODULES.has(source) && !scope.netFiles.has(name)) flag('net-module', node);
    if (isModelSdk(source)) flag('model-sdk-import', node);
  }

  function visit(node, ancestors) {
    if (!node || typeof node.type !== 'string') return;
    const parent = ancestors[0];
    if (passOnly && isFetchRef(node) && !passOnlyUse(node, ancestors)) {
      const isKey = parent?.type === 'Property' && parent.key === node && !parent.computed;
      const isMemberName = parent?.type === 'MemberExpression' && parent.property === node && !parent.computed;
      const isCallee = parent?.type === 'CallExpression' && parent.callee === node;
      const isInit = parent?.type === 'VariableDeclarator' && parent.init === node;
      // A key is checked by the pattern rule below; a callee and an initialiser have their own rules too.
      if (!isKey && !isMemberName && !isCallee && !isInit) flag('fetch-use', node);
    }
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
        if (isFetchRef(node.callee) && !mayCallFetch) flag('fetch-call', node);
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
        if (isFetchRef(node) && !mayNameFetch) flag('fetch', node);
        break;
      }
      case 'ObjectPattern':
        for (const p of node.properties) {
          const key = p.type === 'Property' ? keyName(p) : null;
          if (key && !isExit && isSendSurface(key)) flag(`destructure:${key}`, p);
          if (key === 'fetch' && !mayNameFetch) flag('fetch', p);
          // { fetch: go } keeps fetch under a name that a later go(...) hides behind.
          const ownName = p.type === 'Property' && !p.computed && (isFetchName(p.value) || (p.value?.type === 'AssignmentPattern' && isFetchName(p.value.left)));
          if (key === 'fetch' && passOnly && !ownName) flag('fetch-alias', p);
        }
        break;
      case 'VariableDeclarator':
        // Aliasing the object hides later member access from a name-based check.
        if (node.init?.type === 'Identifier' && node.init.name === 'bot') flag('bot-alias', node);
        if (node.id?.type === 'ObjectPattern' && node.init?.type === 'Identifier' && node.init.name === 'bot' && !isExit && !isConnection) flag('bot-destructure', node);
        // A file that may only pass fetch on must not keep it under another name, where a call would not show.
        if (isFetchRef(node.init) && !mayCallFetch) flag('fetch-alias', node);
        break;
      case 'Identifier':
        if (node.name === 'fetch' && !mayNameFetch && !(parent?.type === 'Property' && parent.key === node && !parent.computed)) flag('fetch', node);
        if (node.name === 'QQBot' && !isConnection) flag('qqbot-outside-connection', node);
        break;
      default:
        break;
    }
    const down = [node, ...ancestors.slice(0, 2)];
    for (const [k, v] of Object.entries(node)) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      if (Array.isArray(v)) for (const child of v) visit(child, down);
      else if (v && typeof v.type === 'string') visit(v, down);
    }
  }
  visit(ast, []);
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

test('the scan reads the own runtime and the tools too', () => {
  const names = (tree) => jsFiles(TREES[tree]).map((f) => relative(TREES[tree], f).replaceAll('\\', '/'));
  for (const expected of ['main.mjs', 'services.mjs']) assert.ok(names('bot').includes(expected), expected);
  for (const expected of ['q5-probe.mjs', 'q5-net-guard.mjs', 'qq-listener.mjs', 'qq-send-probe.mjs', 'qq-shape.mjs']) assert.ok(names('tools').includes(expected), expected);
});

test('the real own runtime and tools have no violation', () => {
  const found = [];
  const scanned = [];
  for (const tree of ['bot', 'tools']) {
    for (const file of jsFiles(TREES[tree])) {
      scanned.push(`${tree}/${relative(TREES[tree], file).replaceAll('\\', '/')}`);
      for (const p of scanSource(file, readFileSync(file, 'utf8'), tree)) found.push(`${tree}/${relative(TREES[tree], file)}:${p.line} ${p.rule}`);
    }
  }
  assert.deepEqual(found, []);
  for (const expected of ['bot/main.mjs', 'bot/services.mjs', 'tools/q5-probe.mjs', 'tools/qq-listener.mjs']) assert.ok(scanned.includes(expected), expected);
  // Positive control: the same files do name fetch, the QQ SDK or a network module, so only their allowlists let them
  // pass. Scanned as plugin files, or under another name, they are flagged.
  const services = readFileSync(join(TREES.bot, 'services.mjs'), 'utf8');
  assert.ok(scanSource('services.mjs', services, 'plugin').some((p) => p.rule === 'fetch'));
  assert.ok(scanSource('helper.mjs', services, 'bot').some((p) => p.rule === 'fetch'));
  const listener = readFileSync(join(TREES.tools, 'qq-listener.mjs'), 'utf8');
  assert.ok(scanSource('qq-shape.mjs', listener, 'tools').some((p) => p.rule === 'sdk-import'));
  assert.ok(scanSource('qq-shape.mjs', listener, 'tools').some((p) => p.rule === 'fetch'));
  const guard = readFileSync(join(TREES.tools, 'q5-net-guard.mjs'), 'utf8');
  assert.ok(scanSource('qq-shape.mjs', guard, 'tools').some((p) => p.rule === 'net-module'));
});

test('an unknown tree is refused, not scanned with no rules', () => {
  assert.throws(() => scanSource('x.js', 'export {}', 'elsewhere'), TypeError);
  assert.deepEqual(scanSource('x.js', 'export {}', 'tools'), [], 'control: a known tree scans');
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

const headerOf = (code) => /^\/\/ expect: (\S+)(?: as: (\S+))?(?: in: (\S+))?/.exec(code);

test('planted offenders cover the own runtime, the tools and the model SDKs', () => {
  const headers = offenders.map((f) => headerOf(readFileSync(join(OFFENDERS, f), 'utf8')));
  assert.ok(headers.some((h) => h?.[3] === 'bot'));
  assert.ok(headers.some((h) => h?.[3] === 'tools'));
  assert.ok(headers.filter((h) => h?.[1] === 'model-sdk-import').length >= 3);
  assert.ok(headers.some((h) => h?.[1] === 'fetch-call'));
});

for (const file of offenders) {
  // The fixture's first line names the rule it must trip, the file it pretends to be, and its tree.
  const code = readFileSync(join(OFFENDERS, file), 'utf8');
  const header = headerOf(code);
  test(`planted: ${file} is flagged as ${header?.[1]}`, () => {
    assert.ok(header, 'fixture needs an expect header');
    const problems = scanSource(header[2] ?? file, code, header[3] ?? 'plugin');
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

test('control: a fetch is allowed exactly where its allowlist says', () => {
  const call = "export function f({ fetch = globalThis.fetch } = {}) { return fetch('http://127.0.0.1:9/x'); }";
  assert.deepEqual(scanSource('lib/core/providers/modelChat.js', call), []);
  assert.deepEqual(scanSource(join(PLUGIN, 'lib', 'core', 'providers', 'modelChat.js'), call), [], 'an absolute path is made relative');
  assert.deepEqual(scanSource('q5-probe.mjs', call, 'tools'), []);
  assert.ok(scanSource('lib/core/decision.js', call).some((p) => p.rule === 'fetch-call'));
  assert.ok(scanSource('services.mjs', call, 'bot').some((p) => p.rule === 'fetch-call'));
  assert.ok(scanSource('lib/core/openrouterChat.js', call).some((p) => p.rule === 'fetch'));
  const pass = 'export function f({ fetch = globalThis.fetch } = {}, make) { return make({ fetch }); }';
  assert.deepEqual(scanSource('services.mjs', pass, 'bot'), []);
  assert.deepEqual(scanSource('lib/core/decision.js', pass), []);
  assert.ok(scanSource('lib/core/providers/anthropicAdapter.js', pass).some((p) => p.rule === 'fetch'));
});

test('an allowlist is a path in its tree, not a file name', () => {
  const call = "export const post = (u) => fetch(u);";
  assert.deepEqual(scanSource('lib/core/providers/modelChat.js', call), [], 'control: the real path may call fetch');
  for (const elsewhere of ['modelChat.js', 'lib/core/whatever/modelChat.js', 'lib/ledger.js']) {
    assert.ok(scanSource(elsewhere, call).some((p) => p.rule === 'fetch'), elsewhere);
  }
  const pass = 'export function f({ fetch } = {}, make) { return make({ fetch }); }';
  assert.deepEqual(scanSource('services.mjs', pass, 'bot'), [], 'control: the real bot file may pass fetch on');
  assert.deepEqual(scanSource(join(TREES.bot, 'services.mjs'), pass, 'bot'), []);
  assert.ok(scanSource('sub/services.mjs', pass, 'bot').some((p) => p.rule === 'fetch'));
  assert.ok(scanSource(join(TREES.bot, 'sub', 'services.mjs'), pass, 'bot').some((p) => p.rule === 'fetch'));
  const post = "export function f(bot) { return bot.api.post('/x', {}); }";
  assert.deepEqual(scanSource('lib/channels/qq/exit.js', post), [], 'control: the real exit may post');
  assert.ok(scanSource('lib/core/exit.js', post).some((p) => p.rule === 'bot-outside-channel'));
});

test('a pass-only file cannot call fetch another way', () => {
  const url = "'http://127.0.0.1:9/v1/messages'";
  const cases = [
    ['lib/core/decision.js', 'plugin', `export function d({ fetch: go }) { return go(${url}); }`],
    ['lib/core/decision.js', 'plugin', `export function d(o) { const { fetch: go } = o; return go(${url}); }`],
    ['lib/core/decision.js', 'plugin', `export function d(o) { const { ['fetch']: go } = o; return go(${url}); }`],
    ['lib/core/decision.js', 'plugin', `export function d({ fetch }) { return fetch.call(null, ${url}); }`],
    ['lib/core/decision.js', 'plugin', `export function d({ fetch }) { return fetch.apply(null, [${url}]); }`],
    ['lib/core/decision.js', 'plugin', `export function d({ fetch }) { return (0, fetch)(${url}); }`],
    ['lib/core/decision.js', 'plugin', `export function d({ fetch }) { return [fetch][0](${url}); }`],
    ['lib/core/decision.js', 'plugin', `export function d({ fetch }) { const o = { fetch }; return o.fetch(${url}); }`],
    ['lib/core/decision.js', 'plugin', `export function d({ fetch }) { return fetch\`x\`; }`],
    ['services.mjs', 'bot', `export function d({ fetch: go }) { return go(${url}); }`],
    ['services.mjs', 'bot', `export function d() { return Reflect.apply(fetch, null, [${url}]); }`],
    ['main.mjs', 'bot', `export function d({ fetch }) { return Reflect.apply(fetch, null, [${url}]); }`],
    ['main.mjs', 'bot', 'const { fetch: go } = globalThis; export const f = (u) => go(u);'],
    ['main.mjs', 'bot', 'export const f = (u) => globalThis.fetch.call(null, u);'],
  ];
  for (const [file, tree, code] of cases) {
    const problems = scanSource(file, code, tree);
    assert.ok(problems.some((p) => p.rule.startsWith('fetch')), `${file}: ${code} -> ${JSON.stringify(problems)}`);
  }
  // Positive control: the forms the real files use stay clean in the same files.
  const clean = [
    'export function d({ fetch = globalThis.fetch, x } = {}, make) { return make({ fetch, x }); }',
    'export function d({ fetch }, make) { return new make({ a: 1, fetch: fetch }); }',
    'export function d(o, make) { const { fetch } = o; return make({ fetch }); }',
  ];
  for (const code of clean) {
    assert.deepEqual(scanSource('lib/core/decision.js', code), [], code);
    assert.deepEqual(scanSource('services.mjs', code, 'bot'), [], code);
  }
});

test('control: a module whose name only looks like a model SDK is not flagged', () => {
  const code = "import { a } from './openai-notes.js';\nimport { b } from '@anthropic-ai-fake/x';\nexport const c = [a, b];";
  assert.deepEqual(scanSource('other.js', code), []);
  assert.ok(scanSource('other.js', "import A from '@anthropic-ai/sdk';\nexport const c = A;").some((p) => p.rule === 'model-sdk-import'));
});
