// Read-only checks. A detail may name a key or a size; it never holds a secret or an ID.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkSentinels, sha256Hex } from '../clo-plugin/lib/core/contentPolicy.js';
import { extractPolicySection } from '../clo-plugin/lib/core/render.js';
import { SCHEMA_VERSION } from '../clo-plugin/lib/core/store.js';
import { isTestMode, readConfig, readVersionsLock, renderAll } from './common.mjs';
import { duplicateLinesHint, ensureGatewayEnvClean, gatewayEnvForCheck, hostCliEnv, inspectArgs, oldLinesHint, parseEnvFile, privateNode, renamedEnvNames, requireSecrets } from './lifecycle.mjs';

const FORBIDDEN = ['@tencent-connect/openclaw-qqbot', '@openclaw/qqbot', '@agent-wechat/agent-wechat', '@tencent-weixin/openclaw-weixin'];
const FORBIDDEN_DIR = /qqbot|agent-wechat|openclaw-weixin/i;
const BAD_INJECTION = new Set(['never', 'continuation-skip']);
const REQUIRED_HOOKS = ['before_agent_run', 'before_prompt_build', 'before_tool_call'];
const DEFAULT_BOOTSTRAP_MAX = 20000;
const DEFAULT_BOOTSTRAP_TOTAL = 60000;
const CLOUD_DIR = /(^|[\\/])(OneDrive[^\\/]*|Dropbox|Google Drive|GoogleDrive|iCloud ?Drive|iCloudDrive|Box Sync|坚果云|Nutstore|百度网盘同步盘|BaiduSyncdisk|腾讯微云|WeDrive)([\\/]|$)/i;
const GITIGNORED = ['.env', 'config.json', '.runtime/'];
const PROXY_KEY = /proxy/i;

export const CONFIG_LEVEL = 'config';
export const FULL_LEVEL = 'full';

function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonical(v[k]);
    return out;
  }
  return v;
}
const sameJson = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function agentOverrides(openclaw) {
  const agents = openclaw?.agents ?? {};
  const list = Array.isArray(agents.list) ? agents.list : [];
  const entries = agents.entries && typeof agents.entries === 'object' ? Object.values(agents.entries) : [];
  return [...list, ...entries].filter((a) => a && typeof a === 'object');
}

function hasKeyMatching(node, re) {
  if (!node || typeof node !== 'object') return false;
  return Object.entries(node).some(([k, v]) => re.test(k) || hasKeyMatching(v, re));
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function installedVersion(root, name) {
  return readJson(join(root, 'node_modules', ...name.split('/'), 'package.json')).version;
}

function lockedIntegrity(lockFile, name) {
  return readJson(lockFile).packages?.[`node_modules/${name}`]?.integrity ?? null;
}

// The host names the bad config key here. Its JSON error has no message text from us or from QQ.
function hostIssue(stdout) {
  try {
    const first = JSON.parse(stdout).issues?.[0];
    return first ? `（${first.path}: ${first.message}）` : '';
  } catch {
    return '';
  }
}

// Parses the host's own view of the plugin. The output has paths in it, so only the verdict comes back.
export function inspectHooks(ctx, { run = spawnSync } = {}) {
  const r = run(privateNode(ctx.paths), inspectArgs(ctx.paths, ctx.env), {
    cwd: ctx.paths.gatewayCwd, env: hostCliEnv(ctx.paths, ctx.env), encoding: 'utf8', timeout: 180000, windowsHide: true, maxBuffer: 1 << 26,
  });
  if (r.status !== 0) return { ok: false, detail: `plugins inspect 退出码 ${r.status ?? 'timeout'}${hostIssue(r.stdout)}` };
  let report;
  try {
    report = JSON.parse(r.stdout);
  } catch {
    return { ok: false, detail: 'plugins inspect 的输出不是 JSON' };
  }
  if (report.plugin?.status !== 'loaded') return { ok: false, detail: '插件 clo 没有加载' };
  const names = (report.typedHooks ?? []).map((h) => h?.name);
  const missing = REQUIRED_HOOKS.filter((h) => !names.includes(h));
  if (missing.length) return { ok: false, detail: `未注册的 hook：${missing.join('、')}` };
  if (report.policy?.allowConversationAccess !== true) return { ok: false, detail: '宿主报告 allowConversationAccess 不是 true' };
  return { ok: true, detail: `已注册：${REQUIRED_HOOKS.join('、')}` };
}

export function runDoctor(ctx, { level = FULL_LEVEL, run = spawnSync, packageRoots = null } = {}) {
  const { paths, env } = ctx;
  const checks = [];
  const add = (id, ok, detail = '', severity = 'error') => checks.push({ id, ok: Boolean(ok), severity, detail });
  const attempt = (id, fn, severity = 'error') => {
    try {
      const r = fn();
      if (typeof r === 'string') add(id, false, r, severity);
      else add(id, r === true || r?.ok === true, r?.detail ?? '', severity);
    } catch (e) {
      add(id, false, `检查出错：${e.exitCode ? e.message : (e.code ?? e.constructor.name)}`, severity);
    }
  };

  let cfg = null;
  let fresh = null;
  let onDisk = null;
  attempt('config_valid', () => {
    cfg = readConfig(ctx);
    fresh = renderAll(ctx, cfg);
    return true;
  });
  attempt('openclaw_json', () => {
    onDisk = readJson(paths.openclawJson);
    return true;
  });

  const defaults = onDisk?.agents?.defaults ?? {};
  const overrides = agentOverrides(onDisk);
  const bothCfg = (fn) => (!onDisk ? '没有 openclaw.json，先运行 clo apply' : fn());

  attempt('forbidden_plugins', () => {
    const roots = packageRoots ?? [paths.repoRoot, join(paths.repoRoot, '.runtime', 'pkg')];
    const found = FORBIDDEN.filter((n) => roots.some((r) => existsSync(join(r, 'node_modules', ...n.split('/')))));
    for (const dir of [join(paths.stateDir, 'extensions'), join(paths.home, '.openclaw', 'extensions')]) {
      if (existsSync(dir)) found.push(...readdirSync(dir).filter((n) => FORBIDDEN_DIR.test(n)));
    }
    const plugins = onDisk?.plugins ?? {};
    const names = [...(plugins.allow ?? []), ...Object.keys(plugins.entries ?? {}), ...(plugins.load?.paths ?? []).map((p) => basename(p))];
    found.push(...names.filter((n) => FORBIDDEN_DIR.test(n)));
    return found.length ? `发现第二个消费者：${found.join('、')}` : true;
  });

  attempt('lock_versions', () => {
    const lock = readVersionsLock(paths);
    if (!lock) return '没有 versions.lock.json';
    const repoLock = join(paths.repoRoot, 'package-lock.json');
    const runtimeLock = join(paths.repoRoot, 'runtime-lock', 'package-lock.json');
    const pkgRoot = packageRoots?.[1] ?? join(paths.repoRoot, '.runtime', 'pkg');
    const sdkRoot = packageRoots?.[0] ?? paths.repoRoot;
    const bad = [];
    if (process.versions.node !== lock.node?.version) bad.push('node');
    for (const [name, root, file] of [
      ['@tencent-connect/qqbot-nodejs', sdkRoot, repoLock],
      ['openclaw', pkgRoot, runtimeLock],
      ['@openclaw/perplexity-plugin', pkgRoot, runtimeLock],
    ]) {
      const want = lock.npm?.[name];
      if (!want || installedVersion(root, name) !== want.version || lockedIntegrity(file, name) !== want.integrity) bad.push(name);
    }
    return bad.length ? `与锁定版本不符：${bad.join('、')}` : true;
  });

  attempt('private_node', () => {
    const want = resolve(privateNode(paths)).toLowerCase();
    return resolve(process.execPath).toLowerCase() === want || '没有用项目私有 Node 运行';
  });

  attempt('conversation_access', () => bothCfg(() => onDisk.plugins?.entries?.clo?.hooks?.allowConversationAccess === true
    || 'plugins.entries.clo.hooks.allowConversationAccess 不是 true，before_agent_run 不会生效'));
  attempt('skip_bootstrap', () => bothCfg(() => defaults.skipBootstrap === true || 'agents.defaults.skipBootstrap 不是 true'));
  attempt('context_injection', () => bothCfg(() => {
    const values = [defaults.contextInjection, ...overrides.map((a) => a.contextInjection)];
    return values.some((v) => BAD_INJECTION.has(v)) ? 'contextInjection 会去掉 AGENTS.md（含 agents.entries、agents.list 的覆盖）' : true;
  }));
  attempt('bootstrap_limits', () => bothCfg(() => {
    const maxes = [defaults.bootstrapMaxChars ?? DEFAULT_BOOTSTRAP_MAX, ...overrides.map((a) => a.bootstrapMaxChars).filter(Number.isFinite)];
    const totals = [defaults.bootstrapTotalMaxChars ?? DEFAULT_BOOTSTRAP_TOTAL, ...overrides.map((a) => a.bootstrapTotalMaxChars).filter(Number.isFinite)];
    const sizes = ['AGENTS.md', 'SOUL.md', 'IDENTITY.md'].map((f) => readFileSync(join(paths.workspace, f), 'utf8').length);
    if (sizes[0] > Math.min(...maxes)) return `AGENTS.md 有 ${sizes[0]} 字符，超过 bootstrapMaxChars ${Math.min(...maxes)}，策略可能被截断`;
    const total = sizes.reduce((a, b) => a + b, 0);
    if (total > Math.min(...totals)) return `工作区文件共 ${total} 字符，超过 bootstrapTotalMaxChars ${Math.min(...totals)}`;
    return { ok: true, detail: `AGENTS.md ${sizes[0]} 字符` };
  }));
  attempt('node_turn', () => bothCfg(() => onDisk.nodeHost?.workerRuns?.enabled !== true || 'nodeHost.workerRuns 开着，回合可能走 node turn'));
  attempt('tools_policy', () => bothCfg(() => {
    const t = onDisk.tools ?? {};
    if (!Array.isArray(t.allow) || t.allow.length === 0) return 'tools.allow 为空';
    if (t.toolSearch !== false) return 'tools.toolSearch 不是 false';
    if ((t.deny ?? []).some((d) => String(d).startsWith('group:'))) return 'tools.deny 含 group:*，每个回合都会失败';
    if (!(t.deny ?? []).includes('message')) return 'tools.deny 没有 message';
    return true;
  }));
  attempt('silent_reply', () => bothCfg(() => defaults.silentReply?.group === 'allow' || 'silentReply.group 不是 allow'));
  attempt('dm_scope', () => bothCfg(() => onDisk.session?.dmScope === 'per-channel-peer' || 'session.dmScope 不是 per-channel-peer'));
  attempt('no_fallback_model', () => bothCfg(() => (defaults.model?.fallbacks ?? []).length === 0 || 'agents.defaults.model.fallbacks 不为空'));

  attempt('policy_section', () => {
    const policyFile = fresh?.effective.contentPolicy.policyFile;
    if (!policyFile) return '没有配置';
    const agents = readFileSync(join(paths.workspace, 'AGENTS.md'), 'utf8');
    const section = extractPolicySection(agents, fresh.effective.contentPolicy.version);
    if (section === null) return 'AGENTS.md 里没有完整的内容策略段';
    return sha256Hex(section) === sha256Hex(readFileSync(policyFile)) || 'AGENTS.md 的策略段与 CONTENT-POLICY.md 不一致';
  });
  attempt('persona_hashes', () => {
    if (!fresh) return '没有配置';
    for (const [name, text] of Object.entries(fresh.workspace.files)) {
      if (readFileSync(join(paths.workspace, name), 'utf8') !== text) return `${name} 与 persona 渲染结果不一致，运行 clo apply`;
    }
    if (existsSync(join(paths.workspace, 'BOOTSTRAP.md'))) return '工作区里有 BOOTSTRAP.md';
    const prompt = readFileSync(paths.systemPromptFile, 'utf8');
    if (prompt !== fresh.workspace.systemPrompt) return 'system-prompt.md 与渲染结果不一致，运行 clo apply';
    const s = checkSentinels(prompt, fresh.effective.contentPolicy.version);
    return s.ok || `system-prompt.md 的策略标记：${s.reason}`;
  });
  attempt('claude_md_baseline', () => {
    const bytes = readFileSync(join(paths.repoRoot, 'CLAUDE.md'));
    const start = bytes.indexOf(Buffer.from('### 7.1 '));
    const end = bytes.indexOf(Buffer.from('### 7.6 '));
    if (start < 0 || end < start) return 'CLAUDE.md 没有 §7.1 到 §7.6 的标题';
    const want = readFileSync(join(paths.repoRoot, 'tests', 'fixtures', 'claude-md-7x.sha256'), 'utf8').trim();
    return createHash('sha256').update(bytes.subarray(start, end)).digest('hex') === want || 'CLAUDE.md §7.1–7.5 与基线不一致';
  });
  attempt('render_fresh', () => {
    if (!fresh || !onDisk) return '没有配置';
    return sameJson(fresh.openclaw, onDisk) || 'openclaw.json 与新渲染的结果不一致，不要手改；运行 clo apply';
  });
  attempt('effective_mode', () => {
    if (!cfg) return '没有配置';
    const e = readJson(paths.effectiveJson);
    return e.mode === cfg.mode || 'effective.json 的 mode 与 config.json 不一致，运行 clo apply';
  });
  attempt('db_version', () => {
    if (!existsSync(paths.db)) return { ok: true, detail: '数据库还没创建，首次启动时创建' };
    const db = new DatabaseSync(paths.db, { readOnly: true });
    try {
      return db.prepare('PRAGMA user_version').get().user_version === SCHEMA_VERSION || 'clo.db 的 schema 版本不符';
    } finally {
      db.close();
    }
  });
  attempt('dm_closed', () => {
    if (!cfg) return '没有配置';
    return (Array.isArray(cfg.qq?.allowedDmUserIds) && cfg.qq.allowedDmUserIds.length === 0) || 'allowedDmUserIds 必须为空';
  });
  attempt('search_off', () => {
    if (!cfg) return '没有配置';
    return cfg.searchProvider === 'none' || 'searchProvider 必须是 none';
  });
  attempt('gateway_env', () => {
    const child = gatewayEnvForCheck(paths, env);
    const bad = ensureGatewayEnvClean(child);
    if (bad.length) return `Gateway 环境含有不该有的变量：${bad.join('、')}`;
    // The host's openrouter provider and the plugin read this name.
    return Boolean(child.OPENROUTER_API_KEY) || 'Gateway 环境里没有 OPENROUTER_API_KEY 这个名字，Key 传不过去';
  });
  attempt('proxy_config', () => bothCfg(() => !hasKeyMatching(onDisk, PROXY_KEY) || 'openclaw.json 含 proxy 设置'));
  attempt('live_gate', () => {
    if (!cfg) return '没有配置';
    if (cfg.mode !== 'live') return { ok: true, detail: '当前是 dry-run' };
    return (typeof cfg.acks?.d3 === 'string' && cfg.acks.d3.length > 0) || 'config.json 是 live，但 D3 没有记录';
  });

  // Warnings: they do not stop a start.
  const inParent = Object.keys(env).filter((k) => PROXY_KEY.test(k));
  add('parent_proxy', inParent.length === 0, inParent.length ? `当前 shell 设了代理变量（${inParent.join('、')}），Gateway 环境不会继承，但本机其他工具可能走代理` : '', 'warn');
  add('cloud_folder', !CLOUD_DIR.test(paths.repoRoot), CLOUD_DIR.test(paths.repoRoot) ? '项目在云同步目录里，SQLite 和 .env 可能被同步或损坏，建议移走' : '', 'warn');
  attempt('gitignore', () => {
    const text = readFileSync(join(paths.repoRoot, '.gitignore'), 'utf8').split(/\r?\n/);
    const missing = GITIGNORED.filter((g) => !text.includes(g));
    return missing.length ? `.gitignore 缺少：${missing.join('、')}` : true;
  }, 'warn');

  if (level === FULL_LEVEL) {
    attempt('env_file', () => {
      if (!cfg) return '没有配置';
      requireSecrets(cfg, parseEnvFile(paths.envFile), { renamed: renamedEnvNames(paths.envFile) });
      return true;
    });
    // A leftover old line is ignored, whatever the mode. Say so, because it looks like it still does something.
    attempt('env_old_names', () => oldLinesHint(paths.envFile) || true, 'warn');
    attempt('env_duplicates', () => duplicateLinesHint(paths.envFile) || true, 'warn');
    attempt('hook_registered', () => {
      if (!statSync(paths.openclawJson, { throwIfNoEntry: false })) return '没有 openclaw.json';
      return inspectHooks(ctx, { run });
    });
  }

  const failed = checks.filter((c) => !c.ok && c.severity === 'error');
  return { ok: failed.length === 0, level, testMode: isTestMode(env), checks, failed: failed.map((c) => c.id) };
}

export function formatDoctor(report) {
  const lines = [];
  for (const c of report.checks) {
    const mark = c.ok ? '通过' : (c.severity === 'warn' ? '提醒' : '失败');
    lines.push(`[${mark}] ${c.id}${c.detail ? `：${c.detail}` : ''}`);
  }
  lines.push(report.ok ? 'doctor：没有发现阻止启动的问题。' : `doctor：${report.failed.length} 项失败（${report.failed.join('、')}）。`);
  return lines.join('\n');
}
