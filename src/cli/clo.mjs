// Console for the project. scripts\clo.ps1 passes its arguments here.
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeKindOf, ConfigError, livePreconditions, OPENROUTER_BASE_URL, providerOfConfig, runtimeOf } from '../clo-plugin/lib/core/config.js';
import { checkSentinels, loadPolicy, sha256Hex } from '../clo-plugin/lib/core/contentPolicy.js';
import { createLedger } from '../clo-plugin/lib/core/ledger.js';
import { anthropicModelChecks, callWorstMicros, checkAnthropicModels, fetchCatalog, lockFromCatalog, lockFromPriceBook, resolveSelector, validateModels } from '../clo-plugin/lib/core/models.js';
import { ACTIVE_PROVIDER_CONTROL, hardCapAckProblems, hardCapAckRefusal, hardCapControlKey, KEY_ENV, liveStartCheck, providerRecord, providerRulesRecorded } from '../clo-plugin/lib/core/providers/registry.js';
import { extractPolicySection, writeAtomic } from '../clo-plugin/lib/core/render.js';
import { apply as applyRender, assertApplicable as checkApplicable, assertValid, CliError, forceEffectiveDryRun, groupByLabel, lockMatches, makeContext, maskId, readConfig, readEffective, readModelsLock, readPriceBook, renderAll, requiredHoldMicros, usableLock, usd, withStore, withStoreAsync, writeConfig, writeModelsLock } from './common.mjs';
import { CONFIG_LEVEL, formatDoctor, FULL_LEVEL, runDoctor } from './doctor.mjs';
import { assertRuntimeSwitchAllowed, assertTestModeWired, inspectGateway, inspectStartLock, parseEnvFile, readPidRecord, recordRuntime, renamedEnvNames, renamedKeyHint, requireSecrets, RUNTIME_LABEL, startLockFile, startRuntime, stopGateway, withStartLock } from './lifecycle.mjs';
import { collectStatus, formatStatus, RESIDUAL_EXIT, residualBehind } from './status.mjs';
import { liveBotLease, releaseLeaseOfPid, STOP_REQUEST_KEY } from '../clo-plugin/lib/channels/qq/lease.js';

const USAGE = `用法：clo <命令>
  apply                              按 config.json 重新生成运行配置
  mode show|dry-run|live             查看或切换模式；live 会先检查全部前置条件
  pause [--group <群>|--all]         暂停（不写参数等于 --all）
  resume [--group <群>|--all|--interject]
  status [--json] [--ack]            --ack 把当前告警标记为已读
  group list | add <群> --id <群ID> | remove <群>
        set <群> [--interject on|off] [--name-mention on|off] [--display-names on|off] | notice-done <群>
  owner add <群> --id <成员ID>
  targets arm --minutes <n> | list [--reveal] | clear
  budget show | accept-unsettled | clear-pause
  policy test <文件> | rule disable <规则ID> --reason <原因> | hash
  model show | set-primary <id> | set-decision <id> | refresh | check
        lock --provider <接口>               按价格表锁定这个接口的模型价格
        [--confirm-price] [--qq-platform-notified]
  provider list | show | add anthropic
           use <接口> --confirm [--qq-platform-notified]   换模型接口，算一次模型变更
  ack identity | q0 | d3 <决定> | terminal
      hard-cap <接口> --kind workspace_monthly --usd <金额> --prepaid-no-reload [--confirm]
  doctor [--config-only] [--json]
  start
  stop`;

const BOOLEAN_FLAGS = new Set(['--all', '--reveal', '--confirm-price', '--qq-platform-notified', '--json', '--ack', '--config-only', '--confirm', '--prepaid-no-reload']);

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positional.push(a);
    } else if (BOOLEAN_FLAGS.has(a) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
      flags[a] = true;
    } else {
      flags[a] = argv[i + 1];
      i += 1;
    }
  }
  return { positional, flags };
}

function need(value, what) {
  if (typeof value !== 'string' || !value) throw new CliError(`缺少${what}。\n\n${USAGE}`);
  return value;
}

function onOff(value, name) {
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new CliError(`${name} 只能是 on 或 off。`);
}

// Every check before a config write, and every apply, in this console go through these two: a runtime switch never
// lands under a running process of the other runtime, and a refused one leaves config.json as it was.
function assertApplicable(ctx, cfg, opts) {
  assertRuntimeSwitchAllowed(ctx, runtimeOf(cfg));
  return checkApplicable(ctx, cfg, opts);
}

function apply(ctx, cfg, opts) {
  assertRuntimeSwitchAllowed(ctx, runtimeOf(cfg));
  return applyRender(ctx, cfg, opts);
}

function printWarnings(ctx, cfg) {
  for (const w of assertValid(ctx, cfg).warnings) ctx.out(`提醒：${w.path} ${w.message}`);
}

function saveAndApply(ctx, cfg) {
  assertApplicable(ctx, cfg);
  writeConfig(ctx, cfg);
  printWarnings(ctx, cfg);
  return apply(ctx, cfg);
}

// --- apply, mode ---

function cmdApply(ctx) {
  const cfg = readConfig(ctx);
  printWarnings(ctx, cfg);
  const r = apply(ctx, cfg);
  const runtime = runtimeOf(r.effective);
  if (runtime === 'own') ctx.out(`已生成运行配置。模式：${r.effective.mode}。运行时：own，不生成 openclaw.json。`);
  else ctx.out(`已生成运行配置。模式：${r.effective.mode}。${r.openclawChanged ? 'openclaw.json 有变化。' : 'openclaw.json 没有变化。'}`);
  return 0;
}

const LIVE_HINTS = {
  budget: '预算必须大于 0，且层级顺序正确',
  daily_hold: '日预算（budget.dailyUsd）不够一次必答回复的预留，@ 永远得不到额度。调高日预算，或调小 claudeModel 的 contextTokens、maxTokens',
  targets: '至少一个群，且每个群都有 owner（clo group add、clo owner add）',
  dm_closed: 'allowedDmUserIds 必须为空',
  key_readable: '读取这个 Key 的信息失败（D3 没有记录时不会去读），或这个 Key 没有每日限额（limit 不能为空，limit_reset 必须是 daily）',
  key_limit: 'config.json 的 budget.keyDailyLimitUsd 和 OpenRouter 上这个 Key 的每日限额不一样。限额低于本地预算没有问题，但两边要写同一个数：改 OpenRouter 上的限额，或改配置后 clo apply',
  reconciled: '对账没有成功',
  heartbeat: 'Gateway 没有在运行，或还没收到过 READY（先在 dry-run 下 clo start）',
  gateway_key: '运行中的 Gateway 还没有记录 .env 里这个 CLO_CHAT_API_KEY。刚启动的 Gateway 要先连接完成，等 clo status 显示已连接再试。如果已经连上，它用的就不是这个 Key：Gateway 的环境在启动时固定，改过 .env 要先 clo stop 再 clo start',
  provider: 'config.json 没有指定能用的模型接口（providers、activeProvider）',
  hard_cap: '这个接口读不到 Key 的花费和限额，要有你本人对硬上限的声明（clo ack hard-cap）：专用、非默认工作区的月度花费上限，加上关闭自动充值的预付费额度，金额至少够一次必答回复的预留，而且声明绑定的就是 .env 里现在这个 Key，也是运行中进程用的 Key。换过 Key 要先停进程，再重新声明',
  key_valid: '用这个 Key 读不到锁定的两个模型，或模型不支持这里要用的设置（D3 没有记录时不会去读）',
  provider_rules: '这个接口进入 live 的项目规则还没有记录：CLAUDE.md §8.2 和 DECISIONS.md 要先写进你同意的规则。在那之前只能 dry-run',
  identity: '机器人身份没有确认（看 clo status，再 clo ack identity）',
  notice: '有群没有确认告知（clo group notice-done <群>）',
  q0: 'Q0 没有确认：你还没有确认看过自己的群能收到什么（clo ack q0）',
  d3: 'D3 没有记录。QQ 协议 §4.2（模型资质）的决定要由你本人做出（clo ack d3 <决定>）',
  policy: '内容策略未启用、哈希不符，或 policy-ok 有误拦',
  numbers: 'contentPolicy.crisis.localNumbers 必须留空：回复里不写未经核实的求助号码',
  doctor: 'doctor 配置检查没有通过（clo doctor）',
  base_urls: '配置里有地址覆盖，只有测试模式允许',
  no_paid_pause: '付费已暂停（看 clo status）',
  models: '模型没有锁定（clo model refresh）',
};

// keyName: the .env name of the active kind's Key. facts: what gatherLiveFacts found, for short codes only.
function liveHint(code, failed, hasKey, keyName = KEY_ENV.openrouter, facts = {}) {
  if ((code === 'key_readable' || code === 'key_valid') && !hasKey) return `.env 里没有 ${keyName}`;
  if (code === 'reconciled' && failed.includes('gateway_key')) return '这次没有对账：Gateway 用的 Key 和 .env 对不上时不对账，先解决 gateway_key';
  if (code === 'gateway_key' && keyName !== KEY_ENV.openrouter) return `运行中的可洛进程还没有记录 .env 里这个 ${keyName}。刚启动的进程要先连接完成，等 clo status 显示已连接再试。如果已经连上，它用的就不是这个 Key：进程的环境在启动时固定，改过 .env 要先 clo stop 再 clo start`;
  // The checker's problems are short codes it made itself, never provider text.
  if (code === 'key_valid' && facts.providerRulesRecorded === false) return '没有检查：这个接口进入 live 的项目规则还没有记录，记录之前不把 Key 发给接口';
  if (code === 'key_valid' && facts.keyProblems?.length) return `${LIVE_HINTS.key_valid}（${facts.keyProblems.join('、')}）`;
  return LIVE_HINTS[code] ?? '';
}

export function policyPasses(ctx, cfg) {
  try {
    const { effective } = renderAll(ctx, cfg);
    const policy = loadPolicy(effective.contentPolicy);
    const text = readFileSync(join(ctx.paths.repoRoot, 'tests', 'fixtures', 'policy-ok.zh.txt'), 'utf8');
    const prompt = readFileSync(effective.contentPolicy.policyFile, 'utf8');
    if (!checkSentinels(prompt, effective.contentPolicy.version).ok) return false;
    return text.split(/\r?\n/).filter(Boolean).every((line) => !policy.check(line).hit);
  } catch {
    return false;
  }
}

// D3 comes first: until it is recorded, this does not contact the provider at all. The provider is config.json's, and
// each check runs by its kind's capabilities: OpenRouter reads its Key; a kind whose Key cannot be read checks the
// attested hard cap's Key binding and that the Key can read both locked models, the last only once the kind's
// project rules are recorded. rulesRecorded: the registry's record; a test passes its own to reach the recorded branch.
export async function gatherLiveFacts(ctx, cfg, { rulesRecorded = providerRulesRecorded } = {}) {
  const facts = { now: ctx.now(), env: ctx.env };
  const provider = providerOfConfig(cfg);
  const kind = provider?.kind ?? null;
  facts.doctorOk = runDoctor(ctx, { level: CONFIG_LEVEL }).ok;
  facts.policyOk = policyPasses(ctx, cfg);
  facts.modelsLocked = Boolean(kind && usableLock(cfg, readModelsLock(ctx.paths, kind), kind));
  // From the registry by kind, never from a file.
  facts.providerRulesRecorded = Boolean(kind) && rulesRecorded(kind) === true;
  // ledger.holdMicros('reply_required') itself, on the effective file just rendered, so the runtime's own hold rule
  // applies. Without a price it is null, and 'models' or the ledger refuses anyway.
  facts.requiredHoldMicros = requiredHoldMicros(readEffective(ctx));
  const secrets = parseEnvFile(ctx.paths.envFile);
  const envKey = kind ? (secrets[KEY_ENV[kind]] ?? null) : null;
  return withStoreAsync(ctx, async (store) => {
    const number = (k) => {
      const v = store.getControl(k);
      return v === null ? null : Number(v);
    };
    facts.heartbeatAt = number('heartbeat_at');
    const running = store.getControl('gateway_key');
    facts.gatewayKeyMatches = Boolean(envKey) && running === store.key(envKey);
    facts.lastReadyAt = number('last_ready_at');
    facts.key = null;
    facts.reconciled = false;
    facts.hardCapKeyMatches = false;
    facts.keyValid = false;
    if (provider?.caps.keyReadable === true) {
      if (cfg.acks?.d3 && envKey) {
        const ledger = createLedger({ store, getEffective: () => readEffective(ctx), fetch: ctx.fetch, getKey: () => envKey, log: ctx.log, now: ctx.now });
        try {
          facts.key = await ledger.readKey();
          // The baseline belongs to the Key that spends. Reconciling with another one would read as a Key change.
          if (facts.gatewayKeyMatches) facts.reconciled = (await ledger.reconcile(ctx.now())).ok;
        } catch {
          facts.key = null;
        }
      }
    } else if (provider) {
      // The attestation is bound to one Key: the one in .env and, while a process is recorded, the one it holds. Mode
      // can turn live under a running process without a new start.
      const control = store.getControl(hardCapControlKey(kind));
      const recorded = readPidRecord(ctx.paths) !== null;
      facts.hardCapKeyMatches = Boolean(envKey) && control !== null && control === store.key(envKey) && (!recorded || running === control);
      // A real check of the Key only once its kind may go live: with no project rules recorded, live is refused
      // anyway, so the Key does not reach the provider for nothing.
      if (facts.providerRulesRecorded && cfg.acks?.d3 && envKey && kind === 'anthropic') {
        const checked = await checkAnthropicModels({ fetch: ctx.fetch, baseUrl: provider.baseUrl, key: envKey, models: anthropicModelChecks(cfg) });
        facts.keyValid = checked.ok === true;
        facts.keyProblems = checked.problems;
      }
    }
    facts.paidPaused = store.getControl('paid_paused');
    return facts;
  });
}

async function cmdModeLive(ctx) {
  const cfg = readConfig(ctx);
  if (cfg.mode === 'live' && readEffective(ctx)?.mode === 'live') {
    ctx.out('已经是 live。');
    return 0;
  }
  const dry = { ...cfg, mode: 'dry-run' };
  assertValid(ctx, dry);
  assertRuntimeSwitchAllowed(ctx, runtimeOf(dry));
  // A hand-edited 'live' goes first, or a refusal below would leave a config that apply and start both refuse.
  if (cfg.mode !== 'dry-run') writeConfig(ctx, dry);
  // Fresh render first, so doctor and the ledger read this config and not a stale one.
  apply(ctx, dry);
  const facts = await gatherLiveFacts(ctx, cfg);
  const result = livePreconditions(cfg, facts);
  if (!result.ok) {
    ctx.out('拒绝进入 live，以下条件未满足：');
    const keyName = KEY_ENV[activeKindOf(cfg)] ?? KEY_ENV.openrouter;
    const hasKey = Boolean(parseEnvFile(ctx.paths.envFile)[keyName]);
    for (const code of result.failed) ctx.out(`  ${code}：${liveHint(code, result.failed, hasKey, keyName, facts)}`);
    const hint = hasKey ? '' : renamedKeyHint(renamedEnvNames(ctx.paths.envFile), [keyName]);
    if (hint) ctx.out(hint);
    ctx.log('cli_mode_refused', { count: result.failed.length });
    return 1;
  }
  const next = { ...cfg, mode: 'live' };
  assertApplicable(ctx, next, { allowLive: true });
  writeConfig(ctx, next);
  withStore(ctx, (store) => store.clearDiscovery());
  apply(ctx, next, { allowLive: true });
  ctx.log('cli_mode', { state: 'live' });
  ctx.out('已进入 live。可洛会回复准入群里的 @，这会产生费用。暂停：clo pause --all');
  return 0;
}

function cmdModeDryRun(ctx) {
  // First, and on its own: nothing that can go wrong below may keep the bot replying.
  forceEffectiveDryRun(ctx);
  try {
    const cfg = { ...readConfig(ctx), mode: 'dry-run' };
    writeConfig(ctx, cfg);
    printWarnings(ctx, cfg);
    apply(ctx, cfg);
  } catch (e) {
    if (!readEffective(ctx)) throw e;
    throw new CliError(`已经进入 dry-run：不调用模型，不发送。但配置没有更新完：\n${e.message}`);
  }
  ctx.log('cli_mode', { state: 'dry-run' });
  ctx.out('已切到 dry-run：不调用模型，不发送。');
  return 0;
}

async function cmdMode(ctx, { positional }) {
  const sub = positional[0] ?? 'show';
  if (sub === 'show') {
    const cfg = readConfig(ctx);
    ctx.out(`config.json：${cfg.mode}；生效中：${readEffective(ctx)?.mode ?? '未生成'}`);
    return 0;
  }
  if (sub === 'live') return cmdModeLive(ctx);
  if (sub === 'dry-run') return cmdModeDryRun(ctx);
  throw new CliError(`不认识的模式：${sub}`);
}

// --- pause, resume ---

function pauseTarget(ctx, flags) {
  if (flags['--group'] && flags['--all']) throw new CliError('--group 和 --all 只能选一个。');
  if (typeof flags['--group'] === 'string') return { group: groupByLabel(readConfig(ctx), flags['--group']) };
  return { all: true };
}

function cmdPause(ctx, { flags }) {
  const target = pauseTarget(ctx, flags);
  withStore(ctx, (store) => {
    if (target.group) {
      const groupKey = store.key(target.group.id);
      store.setControl(`group_paused:${groupKey}`, 'console', 'cli');
      ctx.log('cli_pause', { groupKey });
      ctx.out(`已暂停群 ${target.group.group.label}。`);
    } else {
      store.setControl('global_paused', 'console', 'cli');
      ctx.log('cli_pause', { kind: 'global' });
      ctx.out('已全局暂停。暂停期间固定句也不发。');
    }
  });
  return 0;
}

// A resume reaches further than it looks: whatever pauseTarget cannot read would mean every group.
function assertResumeArgs(positional, flags) {
  const names = Object.keys(flags);
  const known = names.every((n) => ['--group', '--all', '--interject'].includes(n));
  const groupNamed = flags['--group'] === undefined || typeof flags['--group'] === 'string';
  const interjectAlone = flags['--interject'] === undefined || (flags['--interject'] === true && names.length === 1);
  if (positional.length > 0 || !known || !groupNamed || !interjectAlone) {
    throw new CliError('resume 的写法：clo resume、clo resume --all、clo resume --group <群> 或 clo resume --interject。这次什么都没有恢复。');
  }
}

function cmdResume(ctx, { positional, flags }) {
  assertResumeArgs(positional, flags);
  if (flags['--interject']) {
    withStore(ctx, (store) => store.delControl('interject_paused'));
    ctx.log('cli_resume', { kind: 'interject' });
    ctx.out('已解除插话暂停。');
    return 0;
  }
  const target = pauseTarget(ctx, flags);
  withStore(ctx, (store) => {
    if (target.group) {
      const groupKey = store.key(target.group.id);
      store.delControl(`group_paused:${groupKey}`);
      ctx.log('cli_resume', { groupKey });
      ctx.out(`已恢复群 ${target.group.group.label}。`);
    } else {
      store.delControl('global_paused');
      ctx.log('cli_resume', { kind: 'global' });
      ctx.out('已解除全局暂停。分群暂停和付费暂停不受影响。');
    }
  });
  return 0;
}

// --- status ---

function cmdStatus(ctx, { flags }) {
  const report = collectStatus(ctx);
  if (flags['--json']) ctx.out(JSON.stringify(report, null, 2));
  else ctx.out(formatStatus(report));
  if (flags['--ack'] && report.db?.alerts?.length) {
    withStore(ctx, (store) => store.ackAlerts(report.db.alerts.map((a) => a.id)));
    // Standard output stays one JSON document under --json.
    (flags['--json'] ? ctx.err : ctx.out)(`已把 ${report.db.alerts.length} 条告警标记为已读。`);
  }
  return 0;
}

// --- group, owner ---

function cmdGroup(ctx, { positional, flags }) {
  const sub = positional[0];
  const cfg = readConfig(ctx);
  assertValid(ctx, cfg);
  const qq = cfg.qq;
  if (sub === 'list') {
    const entries = Object.entries(qq.groups ?? {});
    if (entries.length === 0) ctx.out('没有群。空列表表示全部关闭。');
    for (const [id, g] of entries) {
      ctx.out(`${g.label}\t${maskId(id)}\t插话 ${g.interject ? '开' : '关'}\t点名 ${g.nameMention ? '开' : '关'}\t显示名 ${g.displayNames === true ? '开' : '关'}\t已告知 ${g.noticeGiven ? '是' : '否'}\towner ${(qq.owner?.groupMember?.[id] ?? []).length}`);
    }
    return 0;
  }
  if (sub === 'add') {
    if (cfg.mode === 'live') throw new CliError('live 下不能加群：新群会立刻被准入，而告知还没做。先 clo mode dry-run。');
    const label = need(positional[1], '群的名称');
    const id = need(flags['--id'], ' --id');
    if (Object.hasOwn(qq.groups, id)) throw new CliError('这个群 ID 已经加过了。');
    qq.groups[id] = { label, interject: false, nameMention: false, noticeGiven: false, displayNames: false };
    qq.allowedGroupIds.push(id);
    saveAndApply(ctx, cfg);
    ctx.out(`已加入群 ${label}（${maskId(id)}）。插话、点名和显示名默认关闭。还需要 clo owner add ${label} --id <成员ID>。`);
    return 0;
  }
  if (sub === 'remove') {
    const { id, group } = groupByLabel(cfg, need(positional[1], '群的名称'));
    if (cfg.mode === 'live' && qq.allowedGroupIds.every((g) => g === id)) throw new CliError('live 下不能移除最后一个群：live 至少要有一个群。先 clo mode dry-run，再移除。');
    delete qq.groups[id];
    qq.allowedGroupIds = qq.allowedGroupIds.filter((g) => g !== id);
    if (qq.owner?.groupMember) delete qq.owner.groupMember[id];
    saveAndApply(ctx, cfg);
    ctx.out(`已移除群 ${group.label}。之后这个群的消息在 gate 第一步就丢弃。`);
    return 0;
  }
  if (sub === 'set') {
    const { group } = groupByLabel(cfg, need(positional[1], '群的名称'));
    if (flags['--interject'] === undefined && flags['--name-mention'] === undefined && flags['--display-names'] === undefined) throw new CliError('要指定 --interject、--name-mention 或 --display-names。');
    if (flags['--interject'] !== undefined) group.interject = onOff(flags['--interject'], '--interject');
    if (flags['--name-mention'] !== undefined) group.nameMention = onOff(flags['--name-mention'], '--name-mention');
    if (flags['--display-names'] !== undefined) group.displayNames = onOff(flags['--display-names'], '--display-names');
    saveAndApply(ctx, cfg);
    ctx.out(`群 ${group.label}：插话 ${group.interject ? '开' : '关'}，点名 ${group.nameMention ? '开' : '关'}，显示名 ${group.displayNames === true ? '开' : '关'}。`);
    if (flags['--display-names'] === 'on') ctx.out('这个开关属于决策点 D5（告知和同意）：群友的显示名会发给主模型。开启前请先告知这个群。');
    return 0;
  }
  if (sub === 'notice-done') {
    const { group } = groupByLabel(cfg, need(positional[1], '群的名称'));
    group.noticeGiven = true;
    saveAndApply(ctx, cfg);
    ctx.out(`已记录：群 ${group.label} 已由你本人告知。机器人自己不发声明。`);
    return 0;
  }
  throw new CliError(USAGE);
}

function cmdOwner(ctx, { positional, flags }) {
  if (positional[0] !== 'add') throw new CliError(USAGE);
  const cfg = readConfig(ctx);
  assertValid(ctx, cfg);
  const { id: groupId, group } = groupByLabel(cfg, need(positional[1], '群的名称'));
  const memberId = need(flags['--id'], ' --id');
  cfg.qq.owner ??= { dm: [], groupMember: {} };
  cfg.qq.owner.groupMember ??= {};
  const list = cfg.qq.owner.groupMember[groupId] ?? [];
  if (!list.includes(memberId)) list.push(memberId);
  cfg.qq.owner.groupMember[groupId] = list;
  saveAndApply(ctx, cfg);
  ctx.out(`群 ${group.label} 的 owner 现在有 ${list.length} 人。`);
  return 0;
}

// --- targets ---

function cmdTargets(ctx, { positional, flags }) {
  const sub = positional[0];
  if (sub === 'arm') {
    const cfg = readConfig(ctx);
    if (cfg.mode !== 'dry-run') throw new CliError('ID 采集只能在 dry-run 下开启。');
    const minutes = Number(flags['--minutes']);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 15) throw new CliError('--minutes 必须是 1 到 15 的整数。');
    withStore(ctx, (store) => store.armDiscovery(ctx.now() + minutes * 60000));
    ctx.log('cli_targets_arm', { count: minutes });
    ctx.out(`ID 采集开启 ${minutes} 分钟：只记录群 ID 和成员 ID，不记录正文和昵称。请在群里发一条消息。`);
    return 0;
  }
  if (sub === 'list') {
    const rows = withStore(ctx, (store) => store.listDiscovery());
    if (rows.length === 0) ctx.out('还没有采集到 ID。');
    const show = (id) => (flags['--reveal'] ? (id ?? '(无)') : maskId(id));
    for (const r of rows) ctx.out(`群 ${show(r.groupId)}\t成员 ${show(r.memberId)}\t${r.count} 次`);
    if (rows.length && !flags['--reveal']) ctx.out('要看完整 ID 才能填配置时，加 --reveal。输出别贴到聊天里。');
    return 0;
  }
  if (sub === 'clear') {
    withStore(ctx, (store) => store.clearDiscovery());
    ctx.out('已清空采集到的 ID，并关闭采集。');
    return 0;
  }
  throw new CliError(USAGE);
}

// --- budget ---

const ACCEPT_HINT = '想按预留额结清，用 clo budget accept-unsettled。';

// The hard-cap pause sits beside paid_paused, and neither budget command lifts it.
function hardCapNote(snap) {
  return snap.hardCapPaused ? `另外，${snap.provider} 接口的硬上限未核实（${snap.hardCapPaused}），付费工作仍暂停；只有重新 clo ack hard-cap 才解除。` : '';
}

function cmdBudget(ctx, { positional }) {
  const sub = positional[0] ?? 'show';
  const effective = readEffective(ctx);
  return withStore(ctx, (store) => {
    const ledger = createLedger({ store, getEffective: () => effective, fetch: ctx.fetch, getKey: () => null, log: ctx.log, now: ctx.now });
    // The kind spending under the effective file. Without a Key read the provider column is always 0 and nothing
    // reconciles: the local estimate is all there is.
    const snap = ledger.snapshot();
    const readable = snap.keyReadable;
    if (sub === 'show') {
      const s = ledger.spent(ctx.now());
      const b = effective?.budget;
      ctx.out(`今日（上海日）有效花费：${usd(s.effectiveMicros)}（本地 ${usd(s.localMicros)}，供应商 ${readable ? usd(s.providerMicros) : '读不到'}）`);
      ctx.out(`分层：插话 ${usd(s.byTier.interject)}${b ? ` / $${b.interjectUsd}` : ''}，点名 ${usd(s.byTier.named)}${b ? ` / 全部到 $${b.namedUsd} 停` : ''}，@ ${usd(s.byTier.addressed)}${b ? ` / 全部到 $${b.addressedUsd} 停` : ''}`);
      ctx.out(`未结算：${s.unsettled} 笔，${usd(s.unsettledMicros)}。付费暂停：${store.getControl('paid_paused') ?? '否'}`);
      if (readable) {
        if (b?.keyDailyLimitUsd !== null && b?.keyDailyLimitUsd !== undefined) ctx.out(`配置写的 Key 日限额：$${b.keyDailyLimitUsd}。要和 OpenRouter 上的限额一样，不一样时 clo mode live 拒绝。`);
        ctx.out('本地花费是保守估算：未结算的按预留额计。真实数字以 OpenRouter 账单为准。');
      } else {
        ctx.out(`对账：不可用（本地估算）。${snap.provider} 接口读不到 Key 的花费和限额，未结算记录不会自动结清，按预留额一直计入，直到 clo budget accept-unsettled。`);
        ctx.out('本地花费是保守估算，按锁定的价格表计算。真实数字以服务方控制台的账单为准。');
      }
      const note = hardCapNote(snap);
      if (note) ctx.out(note);
      return 0;
    }
    if (sub === 'accept-unsettled') {
      const before = store.getControl('paid_paused');
      const n = ledger.acceptUnsettled('cli');
      const after = store.getControl('paid_paused');
      let note = '现在没有付费暂停。';
      if (after === 'residual') note = `但付费工作还没有恢复：现在的暂停原因是 residual。${RESIDUAL_EXIT}`;
      else if (after !== null) note = `但付费工作还没有恢复：现在的暂停原因是 ${after}，这个命令不动它（看 clo status）。`;
      else if (before !== null) note = '崩溃或缺 usage 造成的付费暂停随之解除。';
      ctx.out(`已按预留额结清 ${n} 笔未结算记录。${note}${hardCapNote(snap)}`);
      return 0;
    }
    if (sub === 'clear-pause') {
      const { cleared, reason } = ledger.clearOwnerPause();
      if (reason === null) {
        ctx.out(`现在没有付费暂停。${hardCapNote(snap)}`);
        return 0;
      }
      if (!cleared) {
        const way = { usage_missing: ACCEPT_HINT, crash_unsettled: ACCEPT_HINT, residual: RESIDUAL_EXIT }[reason] ?? '';
        ctx.out(`付费暂停 ${reason} 会由${readable ? ' Key 读取或' : ''}结算解除，这个命令不动它。${way}${residualBehind(reason, store.getControl('residual_over'))}`);
        return 1;
      }
      const restart = reason === 'usage_unavailable' ? '需要重启 Gateway 重新加载。' : '';
      const still = store.getControl('paid_paused');
      if (still !== null) {
        const next = still === 'residual'
          ? RESIDUAL_EXIT
          : `未结算记录结清后自动解除，也可以用 clo budget accept-unsettled 按预留额结清。${residualBehind(still, store.getControl('residual_over'))}`;
        ctx.out(`已解除 ${reason}，但付费工作还没有恢复：现在的暂停原因是 ${still}。${next}${restart}`);
        return 0;
      }
      // Without a Key read nothing else lifts it, so the next failure pauses again at once.
      const again = reason === 'provider_fail' ? '下一次主模型调用失败会立刻再暂停。' : '原因没有消除的话，它会再次暂停。';
      ctx.out(`已解除付费暂停 ${reason}。${again}${restart}${hardCapNote(snap)}`);
      return 0;
    }
    throw new CliError(USAGE);
  });
}

// --- policy ---

function policyFiles(ctx) {
  const cfg = readConfig(ctx);
  return { cfg, cp: renderAll(ctx, cfg).effective.contentPolicy };
}

function cmdPolicy(ctx, { positional, flags }) {
  const sub = positional[0];
  if (sub === 'test') {
    const file = need(positional[1], '文件路径');
    const { cp } = policyFiles(ctx);
    const policy = loadPolicy(cp);
    const lines = readFileSync(resolve(file), 'utf8').split(/\r?\n/);
    let hits = 0;
    let crisis = 0;
    lines.forEach((line, i) => {
      if (!line) return;
      const r = policy.check(line);
      if (r.hit) {
        hits += 1;
        ctx.out(`第 ${i + 1} 行：命中 ${r.ruleId}（${r.category}）`);
      }
      if (policy.isCrisisRoute(line)) crisis += 1;
    });
    ctx.out(`共 ${hits} 行命中规则；${crisis} 行在危险信号短表里（只触发判定，从不拦截）。`);
    return hits ? 1 : 0;
  }
  if (sub === 'rule') {
    if (positional[1] !== 'disable') throw new CliError(USAGE);
    const id = need(positional[2], '规则 ID');
    const reason = need(flags['--reason'], ' --reason');
    const { cp } = policyFiles(ctx);
    const parsed = JSON.parse(readFileSync(cp.rulesFile, 'utf8'));
    const rule = parsed.rules.find((r) => r.id === id);
    if (!rule) throw new CliError(`没有规则 ${id}。`);
    if (rule.status !== 'active') throw new CliError(`规则 ${id} 当前不是 active。`);
    Object.assign(rule, { status: 'disabled', disabledReason: reason, disabledAt: new Date(ctx.now()).toISOString(), disabledBy: 'cli' });
    writeAtomic(cp.rulesFile, `${JSON.stringify(parsed, null, 2)}\n`);
    ctx.log('cli_policy_rule_disabled', { ruleId: id });
    ctx.out(`已停用 ${id} 并记录原因。运行中的 Gateway 重启后才读到新规则。`);
    return 0;
  }
  if (sub === 'hash') {
    const { cp } = policyFiles(ctx);
    const actual = sha256Hex(readFileSync(cp.policyFile));
    ctx.out(`CONTENT-POLICY.md：${actual}`);
    ctx.out(`配置要求：${cp.sha256}${actual === cp.sha256 ? '（一致）' : '（不一致）'}`);
    const agentsFile = join(ctx.paths.workspace, 'AGENTS.md');
    if (existsSync(agentsFile)) {
      const section = extractPolicySection(readFileSync(agentsFile, 'utf8'), cp.version);
      ctx.out(`工作区 AGENTS.md 策略段：${section === null ? '缺失' : sha256Hex(section)}`);
    } else {
      ctx.out('工作区 AGENTS.md：还没生成（clo apply）');
    }
    return actual === cp.sha256 ? 0 : 1;
  }
  throw new CliError(USAGE);
}

// --- model ---

function printModelErrors(v) {
  return `模型检查没有通过：\n${v.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`;
}

async function loadCatalog(ctx, cfg) {
  try {
    return await fetchCatalog({ fetch: ctx.fetch, baseUrl: cfg.openrouter?.baseUrl ?? OPENROUTER_BASE_URL });
  } catch (e) {
    throw new CliError(e.exitCode ? e.message : `读不到模型目录：${e.message}`);
  }
}

// Same model, higher price. A different model is judged by its own ceiling in validateModels.
const PRICE_KEYS = ['inputPerM', 'outputPerM', 'cacheReadPerM', 'cacheWritePerM'];

function raisedPrice(oldLock, lock) {
  if (!oldLock) return false;
  const dearer = (a, b) => a.id === b.id && PRICE_KEYS.some((k) => b.price[k] > a.price[k]);
  return dearer(oldLock.primary, lock.primary) || dearer(oldLock.decision, lock.decision);
}

const samePrice = (a, b) => PRICE_KEYS.every((k) => a.price[k] === b.price[k]);

function budgetWarning(ctx, cfg, effective) {
  const worst = requiredHoldMicros(effective);
  if (worst !== null && worst > cfg.budget.addressedUsd * 1e6) ctx.out(`提醒：一次必答回合预留 ${usd(worst)}，超过日预算 $${cfg.budget.addressedUsd}，这样 @ 永远得不到额度。`);
}

// slot names the one model a set command is about: the other must still resolve to what is locked, and this one counts
// as changed when it resolves differently, even under the same selector. Without a slot the caller has decided both.
function commitModels(ctx, next, catalog, flags, { changed: named, slot = null }) {
  const oldLock = readModelsLock(ctx.paths);
  let changed = named;
  const resolved = slot && oldLock ? tryResolve(next, catalog) : null;
  if (resolved) {
    const other = slot === 'primary' ? 'decision' : 'primary';
    if (oldLock[other]?.id !== resolved[other]) {
      throw new CliError(`${other === 'primary' ? '主模型' : '判定模型'}现在解析到 ${resolved[other]}，和锁定的 ${oldLock[other]?.id} 不同。这个命令只改一个模型，要一起换就运行 clo model refresh（启用 QQ 时要加 --qq-platform-notified）。`);
    }
    if (oldLock[slot]?.id !== resolved[slot]) changed = true;
  }
  const confirmPrice = Boolean(flags['--confirm-price']);
  const qqPlatformNotified = Boolean(flags['--qq-platform-notified']);
  const v = validateModels(next, catalog, { confirmPrice, qqPlatformNotified, change: changed });
  if (!v.ok) throw new CliError(printModelErrors(v));
  for (const w of v.warnings) ctx.out(`提醒：${w.path} ${w.message}`);
  const lock = lockFromCatalog(next, catalog);
  if (raisedPrice(oldLock, lock) && !confirmPrice) throw new CliError('目录价格比锁定时高，加 --confirm-price 才接受。');
  assertApplicable(ctx, next, { lock });
  writeConfig(ctx, next);
  writeModelsLock(ctx, lock, { qqPlatformNotified, changed });
  const { effective } = apply(ctx, next);
  budgetWarning(ctx, next, effective);
  ctx.log('cli_model', { model: lock.primary.id, count: changed ? 1 : 0 });
  ctx.out(`已锁定：主模型 ${lock.primary.id}，判定模型 ${lock.decision.id}。`);
  if (changed && next.qq?.enabled) ctx.out('已记录：你确认向平台报告了这次模型变更（QQ 协议 §4.2）。');
  return 0;
}

function resolvedPair(cfg, catalog) {
  try {
    return { primary: resolveSelector(cfg.claudeModel.id, catalog), decision: resolveSelector(cfg.decisionModel.id, catalog) };
  } catch (e) {
    throw new CliError(e.message);
  }
}

// Null when a selector does not resolve. validateModels then reports that in its usual form.
function tryResolve(cfg, catalog) {
  try {
    return resolvedPair(cfg, catalog);
  } catch {
    return null;
  }
}

// The entries of config.json whose prices come from a hand-entered book, not a catalog: [[name, entry]].
const bookEntries = (cfg) => Object.entries(cfg.providers ?? {}).filter(([, e]) => e?.kind && e.kind !== 'openrouter');

function showBookLocks(ctx, cfg) {
  for (const [name, entry] of bookEntries(cfg)) {
    const lock = readModelsLock(ctx.paths, entry.kind);
    const active = cfg.activeProvider === name ? '（在用）' : '';
    if (!lock) {
      ctx.out(`接口 ${name}（${entry.kind}）${active}：配置 主模型 ${entry.models?.primary}，判定模型 ${entry.models?.decision}；还没锁定价格（clo model lock --provider ${name}）。`);
      continue;
    }
    const fits = lockMatches(cfg, lock, entry.kind, { entryName: name }) ? '' : '（与配置不一致）';
    ctx.out(`接口 ${name}（${entry.kind}）${active}：锁定 主模型 ${lock.primary.id}，判定模型 ${lock.decision.id}${fits}；价格表价格（每百万 token）：主模型 输入 $${lock.primary.price.inputPerM}，输出 $${lock.primary.price.outputPerM}；判定模型 输入 $${lock.decision.price.inputPerM}，输出 $${lock.decision.price.outputPerM}`);
  }
}

// `clo model lock --provider <name>`: the lock of a kind whose API returns no price, from the book in
// versions.lock.json for exactly the entry's ids. No network. A change of the models in use while QQ is enabled is a
// model change under protocol §4.2.
function lockFromBook(ctx, cfg, flags) {
  const name = need(flags['--provider'], ' --provider <接口>');
  const entry = cfg.providers && Object.hasOwn(cfg.providers, name) ? cfg.providers[name] : null;
  if (!entry) throw new CliError(`没有叫 ${name} 的接口。先 clo provider add anthropic，或用 clo provider list 查看。`);
  if (entry.kind === 'openrouter') throw new CliError('OpenRouter 的模型和价格从目录锁定：clo model refresh。');
  const kind = entry.kind;
  const previous = readModelsLock(ctx.paths, kind);
  const book = readPriceBook(ctx.paths, kind);
  const confirmPrice = Boolean(flags['--confirm-price']);
  const qqPlatformNotified = Boolean(flags['--qq-platform-notified']);
  const r = lockFromPriceBook(entry.models, book, { previous, confirmPrice });
  if (!r.ok) throw new CliError(`锁定没有通过：\n${r.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`);
  const { lock } = r;
  const active = cfg.activeProvider === name;
  const changed = Boolean(previous) && (previous.primary?.id !== lock.primary.id || previous.decision?.id !== lock.decision.id);
  if (changed && active && cfg.qq?.enabled && !qqPlatformNotified) {
    throw new CliError('启用 QQ 时更换在用的模型，要先由你本人向平台报告模型变更（QQ 协议 §4.2），再加 --qq-platform-notified。');
  }
  assertApplicable(ctx, cfg, { lock, lockKind: kind });
  writeModelsLock(ctx, lock, { kind, qqPlatformNotified, changed });
  const { effective } = apply(ctx, cfg);
  if (active) budgetWarning(ctx, cfg, effective);
  ctx.log('cli_model', { model: lock.primary.id, count: changed ? 1 : 0, kind });
  ctx.out(`已锁定接口 ${name}：主模型 ${lock.primary.id}，判定模型 ${lock.decision.id}。价格取自 versions.lock.json 的价格表（核对日期 ${book.checkedOn}），接口本身不返回价格，费用按这份价格在本地计算。`);
  if (changed && active && cfg.qq?.enabled) ctx.out('已记录：你确认向平台报告了这次模型变更（QQ 协议 §4.2）。');
  if (!active) ctx.out(`这个接口现在没在用。切换用 clo provider use ${name} --confirm，那也算一次模型变更。`);
  return 0;
}

async function cmdModel(ctx, { positional, flags }) {
  const sub = positional[0] ?? 'show';
  const cfg = readConfig(ctx);
  const lock = readModelsLock(ctx.paths);
  if (sub === 'lock') return lockFromBook(ctx, cfg, flags);
  if (sub === 'show') {
    ctx.out(`配置：主模型 ${cfg.claudeModel.id}（effort ${cfg.claudeModel.effort}，maxTokens ${cfg.claudeModel.maxTokens}），判定模型 ${cfg.decisionModel.id}（effort ${cfg.decisionModel.effort}，maxTokens ${cfg.decisionModel.maxTokens}）`);
    showBookLocks(ctx, cfg);
    if (!lock) {
      ctx.out('锁定：还没有。运行 clo model refresh。没有锁定时不能进入 live。');
      return 0;
    }
    ctx.out(`锁定：主模型 ${lock.primary.id}，判定模型 ${lock.decision.id}${lockMatches(cfg, lock) ? '' : '（与配置不一致）'}`);
    ctx.out(`价格（每百万 token）：主模型 输入 $${lock.primary.price.inputPerM}，输出 $${lock.primary.price.outputPerM}；判定模型 输入 $${lock.decision.price.inputPerM}，输出 $${lock.decision.price.outputPerM}`);
    ctx.out(`单次调用最坏预留：${usd(callWorstMicros(lock.primary.price, cfg.claudeModel))}`);
    return 0;
  }
  if (sub === 'set-primary' || sub === 'set-decision') {
    const id = need(positional[1], '模型 ID');
    const block = sub === 'set-primary' ? 'claudeModel' : 'decisionModel';
    const changed = cfg[block].id !== id;
    const next = { ...cfg, [block]: { ...cfg[block], id } };
    const catalog = await loadCatalog(ctx, next);
    return commitModels(ctx, next, catalog, flags, { changed, slot: sub === 'set-primary' ? 'primary' : 'decision' });
  }
  if (sub === 'refresh') {
    const catalog = await loadCatalog(ctx, cfg);
    const pair = resolvedPair(cfg, catalog);
    const changed = Boolean(lock) && (lock.primary.id !== pair.primary || lock.decision.id !== pair.decision);
    return commitModels(ctx, cfg, catalog, flags, { changed });
  }
  if (sub === 'check') {
    const catalog = await loadCatalog(ctx, cfg);
    const v = validateModels(cfg, catalog, { confirmPrice: Boolean(flags['--confirm-price']) });
    for (const w of v.warnings) ctx.out(`提醒：${w.path} ${w.message}`);
    if (!v.ok) {
      ctx.out(printModelErrors(v));
      return 1;
    }
    const pair = resolvedPair(cfg, catalog);
    ctx.out(`目录里可用：主模型 ${pair.primary}，判定模型 ${pair.decision}。`);
    if (!lock) ctx.out('还没有锁定。运行 clo model refresh。');
    else if (lock.primary.id !== pair.primary || lock.decision.id !== pair.decision) ctx.out(`与锁定不同（锁定 ${lock.primary.id}、${lock.decision.id}）。refresh 才会切换，不会自动换。`);
    else {
      const fresh = lockFromCatalog(cfg, catalog);
      if (samePrice(lock.primary, fresh.primary) && samePrice(lock.decision, fresh.decision)) ctx.out('与锁定一致。');
      else ctx.out('模型没变，但目录价格和锁定时不同。现在仍按锁定的价格计算；refresh 才会更新，涨价时要加 --confirm-price。');
    }
    return 0;
  }
  throw new CliError(USAGE);
}

// --- ack ---

const closeFile = (ctx) => `${ctx.paths.db}.terminal_close`;

function filedCloseCode(ctx) {
  try {
    return readFileSync(closeFile(ctx), 'utf8').trim() || 'unknown';
  } catch (e) {
    return e.code === 'ENOENT' ? null : 'unknown';
  }
}

function cmdAck(ctx, { positional, flags }) {
  const sub = positional[0];
  if (sub === 'terminal') {
    const code = withStore(ctx, (store) => {
      const c = store.getControl('terminal_close');
      store.delControl('terminal_close');
      return c;
    }) ?? filedCloseCode(ctx);
    // A close the store could not take waits in this file, and the next start would read it as a latch.
    rmSync(closeFile(ctx), { force: true });
    if (code) ctx.log('cli_ack_terminal', { closeCode: code });
    ctx.out(code ? `已解除关闭码 ${code} 的锁存。下次 clo start 会再连接；如果平台仍拒绝，还会锁存。` : '没有锁存的关闭码。');
    return 0;
  }
  const cfg = readConfig(ctx);
  cfg.acks ??= { q0Recorded: false, d3: '', identityConfirmedAppId: '' };
  if (sub === 'identity') {
    if (!cfg.qq?.appId) throw new CliError('config.json 的 qq.appId 还没填。');
    cfg.acks.identityConfirmedAppId = cfg.qq.appId;
    writeConfig(ctx, cfg);
    ctx.out(`已确认机器人身份：AppID ${maskId(cfg.qq.appId)}。`);
    return 0;
  }
  if (sub === 'q0') {
    cfg.acks.q0Recorded = true;
    writeConfig(ctx, cfg);
    ctx.out('已记录 Q0：你确认看过自己的群能收到什么。');
    return 0;
  }
  if (sub === 'd3') {
    cfg.acks.d3 = need(positional[1], 'D3 的决定').trim();
    if (!cfg.acks.d3) throw new CliError('D3 的决定不能为空。');
    writeConfig(ctx, cfg);
    ctx.out('已记录 D3。这只是记录你的决定，不代表 QQ 协议 §4.2 的问题已经解决。');
    return 0;
  }
  if (sub === 'hard-cap') return ackHardCap(ctx, cfg, positional, flags);
  throw new CliError(USAGE);
}

// The registry entry of providers[name], active or not: what that entry would be if it were the one in use.
function entryProvider(cfg, name) {
  if (!cfg.providers || !Object.hasOwn(cfg.providers, name)) return null;
  return providerOfConfig({ ...cfg, runtime: 'own', activeProvider: name });
}

const HARD_CAP_REFUSALS = {
  not_attested: (name) => `${name} 接口的花费上限是 Key 自己的每日限额，由 clo mode live 读取核对，不用声明。`,
  live: () => 'live 下不能声明硬上限：之后的 clo mode live 要重新检查整套声明。先 clo mode dry-run。',
  ack: () => '硬上限声明只接受这一种：专用、非默认工作区的月度花费上限（--kind workspace_monthly），并且是关闭了自动充值的预付费额度（--prepaid-no-reload），--usd 写那个月度上限，必须是正数。',
};

// `clo ack hard-cap <name>`: the owner's word for the provider's own stop on a kind whose Key cannot be read (decision
// D2), bound to the fingerprint of the Key in .env now. Only in dry-run with no process: a running process holds the Key
// it started with, which may not be this one. The Key itself is never printed.
function ackHardCap(ctx, cfg, positional, flags) {
  const name = need(positional[1], '接口名称');
  const provider = entryProvider(cfg, name);
  if (!provider) throw new CliError(`没有叫 ${name} 的接口。用 clo provider list 查看。`);
  const usdText = typeof flags['--usd'] === 'string' ? flags['--usd'].trim() : '';
  const ack = {
    kind: typeof flags['--kind'] === 'string' ? flags['--kind'] : null,
    usd: usdText === '' ? Number.NaN : Number(usdText),
    prepaidNoReload: flags['--prepaid-no-reload'] === true,
  };
  const mode = cfg.mode === 'live' || readEffective(ctx)?.mode === 'live' ? 'live' : cfg.mode;
  const proc = processState(ctx);
  const refusal = hardCapAckRefusal({ provider, ack, mode, processRunning: proc.running });
  if (refusal === 'process') throw new CliError(`${proc.why}。运行中的进程用的是它启动时的 Key，不一定是 .env 里现在这个，所以这时不能声明。先 clo stop。`);
  if (refusal) throw new CliError(`${HARD_CAP_REFUSALS[refusal](name)}${refusal === 'ack' ? `（${hardCapAckProblems(ack).join('、')}）` : ''}`);
  const key = parseEnvFile(ctx.paths.envFile, [provider.keyEnv])[provider.keyEnv];
  if (!key) throw new CliError(`.env 里没有 ${provider.keyEnv}。声明要绑定到这个 Key，先由你本人填好。`);
  if (ack.usd > 31 * cfg.budget.dailyUsd && !flags['--confirm']) {
    throw new CliError(`$${ack.usd} 超过本地日预算的 31 倍（$${31 * cfg.budget.dailyUsd}）。上限越高，出错的一天可能花得越多。确实要这么高，加 --confirm。`);
  }
  const next = structuredClone(cfg);
  next.acks.hardCap = { ...next.acks.hardCap, [name]: { kind: ack.kind, usd: ack.usd, prepaidNoReload: true, at: new Date(ctx.now()).toISOString() } };
  saveAndApply(ctx, next);
  // After the config: a binding with no ack, or an ack with no binding, both still refuse live.
  withStore(ctx, (store) => createLedger({ store, getEffective: () => readEffective(ctx), fetch: ctx.fetch, getKey: () => null, log: ctx.log, now: ctx.now }).attestHardCap(provider.kind, key, 'cli'));
  ctx.log('cli_ack_hard_cap', { kind: provider.kind });
  ctx.out(`已记录 ${name} 的硬上限声明：专用工作区每月花费上限 $${ack.usd}，预付费额度，自动充值已关闭。声明绑定 .env 里现在这个 ${provider.keyEnv}；换了 Key，clo start 和 clo mode live 都会拒绝，要停下进程重新声明。`);
  ctx.out(`这个上限只靠你本人的声明，程序读不到，也核实不了。出错的一天里，最多可能花到 $${ack.usd}。`);
  return 0;
}

// --- provider ---

// Who receives the text a reply needs, by kind: what the group notice has to name.
const RECIPIENTS = { openrouter: 'OpenRouter 及实际模型提供方', anthropic: 'Anthropic' };

// A process recorded and not proved gone, or a bot holding the account with no record: { running, why }.
function processState(ctx) {
  const record = readPidRecord(ctx.paths);
  if (record) {
    const { state } = inspectGateway(ctx.paths, ctx.env);
    if (!['gone', 'mismatch', 'none'].includes(state)) {
      return { running: true, why: `${RUNTIME_LABEL[recordRuntime(record)]}（进程 ${record.pid}）${state === 'running' ? '还在运行' : '可能还在运行'}` };
    }
  }
  const untracked = untrackedBot(ctx);
  if (untracked) {
    return { running: true, why: untracked.pid === null ? 'clo.db 里的连接租约读不出来，可能有可洛进程还连着这个 AppID' : `可洛进程（进程 ${untracked.pid}）还连着这个 AppID，PID 文件里没有它` };
  }
  return { running: false, why: '' };
}

function lockState(ctx, cfg, name, kind) {
  const lock = readModelsLock(ctx.paths, kind);
  return usableLock(cfg, lock, kind, kind === 'openrouter' ? undefined : { entryName: name });
}

function hardCapState(ctx, cfg, name, provider) {
  if (provider.caps.hardCap !== 'attested') return 'Key 日限额（clo mode live 读取核对）';
  const ack = cfg.acks?.hardCap?.[name];
  if (hardCapAckProblems(ack).length) return '硬上限未声明（clo ack hard-cap）';
  return `硬上限已声明：每月 $${ack.usd}`;
}

const SWITCH_REFUSALS = {
  paid_paused: '付费暂停还在。暂停是旧接口留下的，换接口不会让它消失；先按 clo status 的提示解除。',
  decision_breaker: '判定熔断还在。先等它恢复，或排查旧接口的问题。',
  reservations: '还有预留中或未结算的记录。它们属于旧接口，先结清（clo budget accept-unsettled），或等它们结算。',
};

// Pauses that only a clean read of the old kind's Key lifts, and that clo budget clear-pause leaves alone. When that
// Key can no longer be read (revoked, account closed), nothing else lifts them: switching to another kind is then the
// way out, so the switch lifts them along with the old Key's read state. Every other pause still refuses the switch.
const SWITCH_LIFTS = new Set(['key_read_failed', 'residual', 'openrouter_key_limit', 'provider_fail']);

class SwitchRefused extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

// One transaction: a lifted pause comes back if the reset then refuses. The new provider is recorded in the same one,
// so apply accepts the config that names it, and only this command can make that record.
function resetForSwitch(ctx, cfg, kind, record) {
  const old = providerOfConfig(cfg);
  const leavesReadableKey = old?.caps?.keyReadable === true && old.kind !== kind;
  try {
    return withStore(ctx, (store) => store.tx(() => {
      const paused = store.getControl('paid_paused');
      const lifted = leavesReadableKey && SWITCH_LIFTS.has(paused) ? paused : null;
      if (lifted) store.delControl('paid_paused');
      const ledger = createLedger({ store, getEffective: () => readEffective(ctx), fetch: ctx.fetch, getKey: () => null, log: ctx.log, now: ctx.now });
      const out = ledger.resetForProviderSwitch();
      if (!out.ok) throw new SwitchRefused(out.reason);
      store.setControl(ACTIVE_PROVIDER_CONTROL, record, 'cli');
      return { ok: true, lifted };
    }));
  } catch (e) {
    if (e instanceof SwitchRefused) return { ok: false, reason: e.reason };
    throw e;
  }
}

function cmdProvider(ctx, { positional, flags }) {
  const sub = positional[0] ?? 'show';
  const cfg = readConfig(ctx);
  assertValid(ctx, cfg);
  const active = providerOfConfig(cfg);
  if (sub === 'list') {
    if (!cfg.providers) {
      ctx.out('openrouter\topenrouter\t在用（默认，没有 providers 配置）');
      return 0;
    }
    for (const [name, e] of Object.entries(cfg.providers)) {
      const p = entryProvider(cfg, name);
      ctx.out(`${name}\t${e.kind}\t${cfg.activeProvider === name ? '在用' : '未用'}\t价格${lockState(ctx, cfg, name, e.kind) ? '已锁定' : '未锁定'}\t${p.caps.keyReadable ? 'Key 可读' : 'Key 读不到（对账不可用）'}\t${hardCapState(ctx, cfg, name, p)}`);
    }
    return 0;
  }
  if (sub === 'show') {
    if (!active) throw new CliError('config.json 没有指定能用的模型接口。');
    const filled = Boolean(parseEnvFile(ctx.paths.envFile, [active.keyEnv])[active.keyEnv]);
    ctx.out(`在用的模型接口：${active.name}（${active.kind}）${active.implicit ? '，默认' : ''}`);
    ctx.out(`Key：.env 的 ${active.keyEnv}，${filled ? '已填' : '未填'}。回复所需的消息发给 ${RECIPIENTS[active.kind]}。`);
    ctx.out(`价格：${lockState(ctx, cfg, active.name, active.kind) ? '已锁定' : '未锁定'}。对账：${active.caps.keyReadable ? '读 Key 核对' : '不可用（本地估算）'}。上限：${hardCapState(ctx, cfg, active.name, active)}`);
    if (active.caps.hardCap === 'attested' && existsSync(ctx.paths.db)) {
      const bound = withStore(ctx, (store) => store.getControl(hardCapControlKey(active.kind)));
      const key = parseEnvFile(ctx.paths.envFile, [active.keyEnv])[active.keyEnv];
      const same = Boolean(key) && withStore(ctx, (store) => bound !== null && bound === store.key(key));
      ctx.out(`硬上限声明绑定的 Key：${bound === null ? '没有' : (same ? '就是 .env 里现在这个' : '不是 .env 里现在这个，要重新声明')}`);
    }
    if (!providerRulesRecorded(active.kind)) ctx.out('这个接口进入 live 的项目规则还没有记录（CLAUDE.md §8.2、DECISIONS.md），现在只能 dry-run。');
    return 0;
  }
  if (sub === 'add') {
    const name = need(positional[1], '接口名称');
    if (name !== 'anthropic') throw new CliError('这一版只能加 anthropic。OpenRouter 不用加，没有 providers 配置时就是它。');
    if (cfg.providers && Object.hasOwn(cfg.providers, name)) throw new CliError(`接口 ${name} 已经加过了。`);
    const next = structuredClone(cfg);
    if (!next.providers) {
      // The implicit OpenRouter entry becomes explicit and stays the one in use.
      next.providers = { openrouter: { kind: 'openrouter', keyEnv: KEY_ENV.openrouter } };
      next.activeProvider = 'openrouter';
      next.acks = { ...next.acks, provider: { name: 'openrouter', at: new Date(ctx.now()).toISOString() } };
    }
    next.providers[name] = { kind: 'anthropic', keyEnv: KEY_ENV.anthropic, models: { primary: 'claude-opus-5-5', decision: 'claude-haiku-5-5' } };
    saveAndApply(ctx, next);
    ctx.out(`已加入接口 ${name}（主模型 claude-opus-5-5，判定模型 claude-haiku-5-5），现在没在用，在用的还是 ${next.activeProvider}。`);
    ctx.out(`要用它：.env 里填 ${KEY_ENV.anthropic}，clo model lock --provider ${name}，再 clo provider use ${name} --confirm。`);
    return 0;
  }
  if (sub === 'use') return useProvider(ctx, cfg, need(positional[1], '接口名称'), flags);
  throw new CliError(USAGE);
}

// `clo provider use <name> --confirm`: a model change under protocol §4.2 and a change of who receives the text
// (decision D8). Only with nothing running and nothing carried over: the old kind's pauses, breaker and open rows stay
// with it, so the switch is refused while any is there.
function useProvider(ctx, cfg, name, flags) {
  if (!cfg.providers || !Object.hasOwn(cfg.providers, name)) throw new CliError(`没有叫 ${name} 的接口。先 clo provider add anthropic，或用 clo provider list 查看。`);
  const kind = cfg.providers[name].kind;
  if (cfg.activeProvider === name) {
    ctx.out(`已经在用 ${name}。`);
    return 0;
  }
  if (!flags['--confirm']) {
    throw new CliError(`换接口算一次模型变更：回复所需的消息改发给 ${RECIPIENTS[kind] ?? kind}。每个群的“已告知”和 D3 记录都会清除，要重新告知、重新记录后才能 live。确认后加 --confirm。`);
  }
  if (cfg.mode === 'live' || readEffective(ctx)?.mode === 'live') throw new CliError('live 下不能换接口。先 clo mode dry-run，再 clo stop。');
  const proc = processState(ctx);
  if (proc.running) throw new CliError(`${proc.why}。进程运行时不能换接口，先 clo stop。`);
  if (runtimeOf(cfg) !== 'own' && kind !== 'openrouter') throw new CliError('OpenClaw 运行时只能用 OpenRouter。要用这个接口，先把 runtime 改成 own。');
  if (!lockState(ctx, cfg, name, kind)) {
    throw new CliError(kind === 'openrouter' ? '没有和配置一致的 OpenRouter 模型锁定。先 clo model refresh。' : `${name} 还没有和配置一致的价格锁定。先 clo model lock --provider ${name}。`);
  }
  const qqPlatformNotified = Boolean(flags['--qq-platform-notified']);
  if (cfg.qq?.enabled && !qqPlatformNotified) {
    throw new CliError('启用 QQ 时换接口算一次模型变更：先由你本人向平台报告模型信息的变更（QQ 协议 §4.2），再加 --qq-platform-notified。');
  }
  const next = structuredClone(cfg);
  next.activeProvider = name;
  next.acks = { ...next.acks, provider: { name, at: new Date(ctx.now()).toISOString() }, d3: '' };
  for (const g of Object.values(next.qq?.groups ?? {})) g.noticeGiven = false;
  // Everything that could refuse comes before the store and the files change.
  assertApplicable(ctx, next, { providerSwitch: true });
  const reset = resetForSwitch(ctx, cfg, kind, providerRecord(providerOfConfig(next)));
  if (!reset.ok) throw new CliError(`没有换接口：${SWITCH_REFUSALS[reset.reason] ?? reset.reason}`);
  if (reset.lifted) ctx.log('paid_resumed', { reason: reset.lifted, source: 'provider_switch' });
  writeConfig(ctx, next);
  printWarnings(ctx, next);
  apply(ctx, next);
  // The models now in use changed: the lock history records it like any other model change.
  writeModelsLock(ctx, readModelsLock(ctx.paths, kind), { kind, qqPlatformNotified, changed: true });
  ctx.log('cli_provider_use', { kind });
  ctx.out(`已换到接口 ${name}（${kind}）。`);
  if (reset.lifted) ctx.out(`旧接口的付费暂停 ${reset.lifted} 只有读到旧 Key 才能解除，换接口时已一并解除。`);
  ctx.out(`回复所需的消息现在发给 ${RECIPIENTS[kind] ?? kind}。已清除每个群的“已告知”和 D3 记录：请你本人重新告知各群（告知草稿要写对接收方），再 clo group notice-done <群>，并重新 clo ack d3 <决定>。`);
  if (cfg.qq?.enabled) ctx.out('已记录：你确认向平台报告了这次模型变更（QQ 协议 §4.2）。');
  const p = entryProvider(next, name);
  if (p.caps.keyReadable !== true) ctx.out(`这个接口读不到 Key：对账不可用，只有本地估算。进入 live 前要 clo ack hard-cap ${name}。`);
  if (!providerRulesRecorded(kind)) ctx.out('这个接口进入 live 的项目规则还没有记录（CLAUDE.md §8.2、DECISIONS.md），记录之前 clo mode live 会拒绝。');
  return 0;
}

// --- doctor, start, stop ---

function cmdDoctor(ctx, { flags }) {
  const report = runDoctor(ctx, { level: flags['--config-only'] ? CONFIG_LEVEL : FULL_LEVEL });
  ctx.out(flags['--json'] ? JSON.stringify(report, null, 2) : formatDoctor(report));
  return report.ok ? 0 : 1;
}

const CMDLINE_HINT = '读不到它的命令行，它很可能是用更高权限启动的，还在运行。从启动它的 shell 里运行这个命令。';

// A bot with no PID record that still holds the account: its lease in clo.db is fresh and its process alive. A start
// that clo was stopped in the middle of can leave one. It listens on no port, so nothing else shows it.
function untrackedBot(ctx) {
  if (!existsSync(ctx.paths.db)) return null;
  return withStore(ctx, (store) => liveBotLease({ store, now: ctx.now }));
}

// The start check the bot also runs (contract section 10): in live mode, on a kind whose spend rests on an attested
// cap, the ack must meet decision D2 and be bound to the Key the child will get, which is the one in .env; and on every
// kind the project's rules must allow live. Outside live it passes, and no database is opened for it.
function assertStartAllowed(ctx, cfg, secrets) {
  const provider = providerOfConfig(cfg);
  const live = cfg.mode === 'live';
  const kind = provider?.kind;
  const envKey = kind ? secrets[KEY_ENV[kind]] : undefined;
  const bound = live && kind ? withStore(ctx, (store) => ({ control: store.getControl(hardCapControlKey(kind)), keyFp: envKey ? store.key(envKey) : null })) : { control: null, keyFp: null };
  const check = liveStartCheck({ provider, mode: cfg.mode, ack: provider ? (cfg.acks?.hardCap?.[provider.name] ?? null) : null, ...bound });
  if (check.ok) return;
  if (check.code === 'provider') throw new CliError('config.json 没有指定能用的模型接口，不启动。');
  if (check.code === 'hard_cap') {
    throw new CliError(`live 下 ${provider.name} 接口的硬上限声明不完整，或绑定的不是 .env 里现在这个 ${provider.keyEnv}。不启动。换过 Key 的话，先 clo mode dry-run，再 clo ack hard-cap ${provider.name} 重新声明。`);
  }
  throw new CliError(`${provider.name}（${provider.kind}）接口进入 live 的项目规则还没有记录（CLAUDE.md §8.2、DECISIONS.md），live 下不启动。先 clo mode dry-run。`);
}

async function startLocked(ctx) {
  const cfg = readConfig(ctx);
  assertTestModeWired(cfg, ctx.env);
  const runtime = runtimeOf(cfg);
  const current = inspectGateway(ctx.paths, ctx.env);
  // One PID record for both runtimes, so whichever is recorded and alive blocks the other: one consumer per AppID.
  if (current.state === 'running') {
    const was = recordRuntime(current.record);
    if (was !== runtime) {
      throw new CliError(`${RUNTIME_LABEL[was]}（${was} 运行时，进程 ${current.record.pid}）还在运行。同一个 AppID 只能有一个消费者，不启动 ${runtime} 运行时。先 clo stop，再 clo start。`);
    }
    throw new CliError(`${RUNTIME_LABEL[was]} 已在运行（进程 ${current.record.pid}）。`);
  }
  if (current.state === 'unknown') {
    throw new CliError(current.cause === 'cmdline_unreadable'
      ? `进程 ${current.record.pid} 可能还在运行。PID 文件保留。${CMDLINE_HINT}`
      : `查不到进程 ${current.record.pid} 的状态，可能还在运行。PID 文件保留，请稍后再试。`);
  }
  if (current.state !== 'none') rmSync(ctx.paths.pidFile, { force: true });
  // Before apply: a runtime switch written now would not stop it, and the other runtime would connect beside it.
  const untracked = untrackedBot(ctx);
  if (untracked) {
    throw new CliError(untracked.pid === null
      ? 'clo.db 里的连接租约读不出来，可能有可洛进程还连着这个 AppID。不启动，请稍后再试。'
      : `有一个可洛进程（进程 ${untracked.pid}）还连着这个 AppID，PID 文件里没有它。同一个 AppID 只能有一个消费者，不启动。先运行 clo stop 请它停下，再 clo start。`);
  }

  const secrets = parseEnvFile(ctx.paths.envFile);
  requireSecrets(cfg, secrets, { renamed: renamedEnvNames(ctx.paths.envFile) });
  assertStartAllowed(ctx, cfg, secrets);
  printWarnings(ctx, cfg);
  apply(ctx, cfg);
  const report = runDoctor(ctx, { level: FULL_LEVEL });
  if (!report.ok) {
    ctx.out(formatDoctor(report));
    throw new CliError('doctor 没有通过，不启动。');
  }
  // A passing report is not printed, and these two would otherwise go unseen until mode live or a separate doctor.
  for (const c of report.checks) {
    if (!c.ok && ['env_old_names', 'env_duplicates'].includes(c.id)) ctx.out(`提醒：${c.detail}`);
  }
  const { pid, port } = await startRuntime(ctx, cfg, { secrets });
  if (runtime === 'own') ctx.out(`可洛进程已启动（own 运行时）：进程 ${pid}，不监听端口，模式 ${cfg.mode}。`);
  else ctx.out(`Gateway 已启动：进程 ${pid}，端口 ${port}（仅 loopback），模式 ${cfg.mode}。`);
  ctx.out('连上 QQ 要等一会儿，用 clo status 确认“心跳新鲜”和“已连接”。');
  return 0;
}

// The check for a running Gateway is inside the lock: two starts must not both find none.
const cmdStart = (ctx) => withStartLock(ctx, () => startLocked(ctx));

function cmdStop(ctx) {
  // A start that is under way has a Gateway the PID file may not show yet, and a stop now would miss it.
  const lock = inspectStartLock(ctx);
  if (lock.state === 'held') {
    ctx.out(lock.cause === 'unreadable'
      ? `启动锁读不出内容，可能有 clo start 正在运行。没有动任何进程。如果确认没有，删除 ${startLockFile(ctx.paths)} 后再试。`
      : `clo start 可能还在运行（进程 ${lock.record.pid}）。没有动任何进程，等它结束再 clo stop。`);
    return 1;
  }
  const r = stopGateway(ctx);
  // No record, but a bot still holds the account: it is asked to stop through clo.db, the way it polls for, and no
  // process is signalled. Its own stop drops the lease and the heartbeat.
  const untracked = !r.stopped && r.reason === 'no_pid_file' ? untrackedBot(ctx) : null;
  if (untracked?.pid) {
    withStore(ctx, (store) => store.setControl(STOP_REQUEST_KEY, String(untracked.pid), 'cli'));
    ctx.log('bot_stop_requested', { count: untracked.pid, kind: 'own' });
    ctx.out(`没有 PID 文件，但可洛进程（进程 ${untracked.pid}）还连着这个 AppID。已请它自己停下，没有结束任何进程。几秒后用 clo status 确认连接已断开。`);
    return 0;
  }
  if (untracked) {
    ctx.out('没有 PID 文件，但 clo.db 里的连接租约读不出来，可能有可洛进程还连着这个 AppID。没有动任何进程，请稍后再试 clo stop。');
    return 1;
  }
  // stoppedPid: a process this stop has just seen gone. A bot killed hard leaves its consumer lease behind, and a lease
  // naming that PID goes with it. A lease naming any other process is left alone.
  const noteDown = (stoppedPid = null) => {
    if (!existsSync(ctx.paths.db)) return;
    withStore(ctx, (store) => {
      store.setControl('connected', 'false', 'cli');
      // A heartbeat only says something while the Gateway runs. A leftover one would read as fresh for a while.
      store.delControl('heartbeat_at');
      if (stoppedPid !== null) releaseLeaseOfPid({ store, pid: stoppedPid });
    });
  };
  if (r.stopped) {
    noteDown(r.pid);
    ctx.out(`已停止 ${RUNTIME_LABEL[r.runtime]}（进程 ${r.pid}）。`);
    return 0;
  }
  if (r.reason === 'lookup_failed') {
    ctx.out(r.cause === 'cmdline_unreadable'
      ? `记录的进程可能还在运行。没有动它，PID 文件保留。${CMDLINE_HINT}`
      : '查不到记录的进程状态，它可能还在运行。没有动它，PID 文件保留，请稍后再试 clo stop。');
    return 1;
  }
  if (r.reason === 'pid_mismatch') {
    ctx.out('记录的 PID 现在属于别的进程，没有动它，已删除过期的 PID 文件。');
    return 1;
  }
  noteDown();
  ctx.out(r.reason === 'not_running' ? '记录的进程已不在，已删除 PID 文件。' : '没有 PID 文件，没有东西要停。');
  return 0;
}

const COMMANDS = {
  apply: cmdApply,
  mode: cmdMode,
  pause: cmdPause,
  resume: cmdResume,
  status: cmdStatus,
  group: cmdGroup,
  owner: cmdOwner,
  targets: cmdTargets,
  budget: cmdBudget,
  policy: cmdPolicy,
  model: cmdModel,
  ack: cmdAck,
  provider: cmdProvider,
  doctor: cmdDoctor,
  start: cmdStart,
  stop: cmdStop,
};

// start.ps1 runs this with no console, so the text goes to a file it prints afterwards.
function outputToFile(argv, io) {
  if (argv[0] !== '--output-file') return { argv, io };
  const write = (s) => appendFileSync(argv[1], s);
  return { argv: argv.slice(2), io: { ...io, stdout: { write }, stderr: { write } } };
}

export async function main(rawArgv, rawIo = {}) {
  const { argv, io } = outputToFile(rawArgv, rawIo);
  const ctx = makeContext(io);
  const [command, ...rest] = argv;
  const handler = Object.hasOwn(COMMANDS, command ?? '') ? COMMANDS[command] : null;
  if (!handler) {
    ctx.out(USAGE);
    return command ? 2 : 0;
  }
  try {
    return await handler(ctx, parseArgs(rest));
  } catch (e) {
    if (e instanceof CliError || e instanceof ConfigError) {
      ctx.err(e.message);
      return e.exitCode ?? 1;
    }
    ctx.err(`内部错误：${e.message}`);
    return 3;
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : '';
if (invoked === fileURLToPath(import.meta.url).toLowerCase()) {
  process.exitCode = await main(process.argv.slice(2));
}
