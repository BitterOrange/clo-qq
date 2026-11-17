// Renders openclaw.json and the workspace files. Pure, apart from reading persona files and writeAtomic.
import { randomBytes } from 'node:crypto';
import { closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkSentinels, sha256Hex } from './contentPolicy.js';
import { mkdirPrivate, PRIVATE_FILE_MODE, PRIVATE_MODES } from './private-fs.js';

// Enumerated on purpose. `group:*` here leaves no callable tool and fails every turn (observed).
export const DENY = [
  'message', 'web_search', 'web_fetch', 'x_search', 'memory_*', 'exec', 'process', 'read', 'write', 'edit', 'apply_patch', 'ls',
  'sessions_*', 'subagents', 'secrets', 'tts', 'cron', 'gateway', 'openclaw', 'session_status', 'tool_call', 'tool_describe', 'tool_search',
];
const FAKE_TEST_KEY = 'sk-or-v1-FAKE-KEY-FOR-LOCAL-MOCK-ONLY';
// The native window is host metadata. contextTokens is what actually caps input.
const NATIVE_CONTEXT_WINDOW = 200000;
// The host's file log. Its default is /tmp/openclaw on Linux and the temp folder on Windows; logging.file moves it.
// This name keeps the host's daily rolling and its 24 h prune of openclaw-*.log in that folder.
export const HOST_LOG_NAME = 'openclaw-YYYY-MM-DD.log';
export function hostLogFile(paths) {
  if (typeof paths.logsDir !== 'string' || !paths.logsDir) throw new Error('render: paths.logsDir is required');
  return join(paths.logsDir, 'host', HOST_LOG_NAME);
}

function providerBlock(effective, testMode) {
  const { primary } = effective.models;
  const price = primary.price ?? { inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0 };
  const model = {
    id: primary.id,
    name: primary.id,
    reasoning: primary.effort !== 'none',
    input: ['text'],
    contextWindow: NATIVE_CONTEXT_WINDOW,
    contextTokens: primary.contextTokens,
    maxTokens: primary.maxTokens,
    cost: { input: price.inputPerM, output: price.outputPerM, cacheRead: price.cacheReadPerM, cacheWrite: price.cacheWritePerM },
  };
  if (!testMode) return { models: [model] };
  return {
    baseUrl: effective.openrouter.baseUrl,
    apiKey: testMode.apiKey ?? FAKE_TEST_KEY,
    api: 'openai-completions',
    request: { allowPrivateNetwork: true },
    models: [model],
  };
}

export function renderOpenclaw(cfg, effective, paths, { testMode = false } = {}) {
  const { primary } = effective.models;
  const channels = {};
  if (effective.qq.enabled) {
    const ch = { enabled: true, appId: effective.qq.appId };
    if (effective.qq.apiBaseUrl) ch.apiBaseUrl = effective.qq.apiBaseUrl;
    if (effective.qq.tokenBaseUrl) ch.tokenBaseUrl = effective.qq.tokenBaseUrl;
    channels['clo-qq'] = ch;
  }
  const defaults = {};
  if (primary.id) {
    const ref = `openrouter/${primary.id}`;
    defaults.model = { primary: ref, fallbacks: [] };
    // params.thinking, not params.effort: the host ignored `effort` and sent reasoning.effort "medium" (observed).
    defaults.models = {
      [ref]: { params: { thinking: primary.effort, maxTokens: primary.maxTokens, cacheRetention: primary.cacheRetention } },
    };
  }
  Object.assign(defaults, {
    workspace: paths.workspace,
    userTimezone: 'Asia/Shanghai',
    skipBootstrap: true,
    contextInjection: 'always',
    bootstrapMaxChars: 20000,
    bootstrapTotalMaxChars: 60000,
    heartbeat: { every: '0m' },
    silentReply: { group: 'allow' },
    timeoutSeconds: effective.timeouts.turnSeconds,
    blockStreamingDefault: 'off',
    compaction: { memoryFlush: { enabled: false } },
  });
  const models = { mode: 'merge', catalogRefresh: { enabled: false } };
  if (primary.id) models.providers = { openrouter: providerBlock(effective, testMode) };

  const gateway = { mode: 'local', bind: 'loopback' };
  if (cfg.gatewayPort !== undefined) gateway.port = cfg.gatewayPort;
  Object.assign(gateway, { auth: { mode: 'token' }, controlUi: { enabled: false }, reload: { mode: 'hybrid' } });

  return {
    gateway,
    // At error level the host still writes provider error text to its console and file logs (observed).
    // Silent stops the file log and subsystem lines; src/cli/host-output-filter.mjs takes its direct console writes.
    // The file is named anyway, so a raised level (OPENCLAW_LOG_LEVEL outranks this) still writes inside .runtime.
    logging: { level: 'silent', consoleLevel: 'silent', file: hostLogFile(paths) },
    update: { checkOnStart: false, auto: { enabled: false } },
    discovery: { mdns: { mode: 'off' } },
    cron: { enabled: false },
    plugins: {
      allow: ['clo', 'openrouter'],
      load: { paths: [join(paths.repoRoot, 'src', 'clo-plugin')] },
      slots: { memory: 'none' },
      entries: {
        clo: { enabled: true, config: { effectivePath: paths.effectiveJson }, hooks: { allowConversationAccess: true } },
        openrouter: { enabled: true },
      },
    },
    channels,
    models,
    agents: { defaults },
    messages: { visibleReplies: 'automatic' },
    session: { dmScope: 'per-channel-peer', resetByType: { group: { mode: 'idle', idleMinutes: 120 } } },
    tools: {
      allow: ['clo_feature_status'],
      toolSearch: false,
      deny: [...DENY],
      media: { image: { enabled: false }, audio: { enabled: false }, video: { enabled: false } },
      elevated: { enabled: false },
    },
  };
}

// The policy block as it sits inside a rendered AGENTS.md, markers included. Null if not whole.
export function extractPolicySection(text, version) {
  const startMark = `<!-- clo-policy:${version} -->`;
  const endMark = `<!-- clo-policy-end:${version} -->`;
  const start = text.indexOf(startMark);
  const end = text.indexOf(endMark);
  if (start < 0 || end < start) return null;
  return text.slice(start, end + endMark.length);
}

export function renderWorkspace(repoRoot, effective) {
  const read = (name) => readFileSync(join(repoRoot, 'persona', name), 'utf8');
  const policy = readFileSync(effective.contentPolicy.policyFile, 'utf8');
  const agents = read('AGENTS.md');
  const soul = read('SOUL.md');
  const identity = read('IDENTITY.md');
  const version = effective.contentPolicy.version;
  if (sha256Hex(policy) !== effective.contentPolicy.sha256) throw new Error('content policy hash mismatch');
  const sentinels = checkSentinels(policy, version);
  if (!sentinels.ok) throw new Error(`content policy sentinels: ${sentinels.reason}`);

  const agentsFile = `${policy}\n\n${agents}`;
  const systemPrompt = `${policy}\n\n${agents}\n${soul}\n${identity}`;
  return {
    files: { 'AGENTS.md': agentsFile, 'SOUL.md': soul, 'IDENTITY.md': identity },
    systemPrompt,
    hashes: {
      policy: sha256Hex(policy),
      agents: sha256Hex(agentsFile),
      soul: sha256Hex(soul),
      identity: sha256Hex(identity),
      systemPrompt: sha256Hex(systemPrompt),
    },
  };
}

// Off Windows the file is always 0600 once written, whatever the umask and whatever mode the file it replaces had: it
// may hold a token, a raw ID or a key name. A stricter mode such as 0400 is not kept, since the project must still be
// able to read and rewrite the file. A folder it has to create is 0700. Windows is unchanged.
export function writeAtomic(path, text) {
  if (PRIVATE_MODES) mkdirPrivate(dirname(path));
  else mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = PRIVATE_MODES ? openSync(tmp, 'wx', PRIVATE_FILE_MODE) : openSync(tmp, 'w');
  try {
    // The umask can only take bits away; this makes the mode exact before any byte is written.
    if (PRIVATE_MODES) fchmodSync(fd, PRIVATE_FILE_MODE);
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // A reader holding the file can make the rename fail briefly on Windows.
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(tmp, path);
      return;
    } catch (err) {
      if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) {
        rmSync(tmp, { force: true });
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}
