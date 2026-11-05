// Console for the project. scripts\clo.ps1 passes its arguments here.
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, livePreconditions, OPENROUTER_BASE_URL } from '../clo-plugin/lib/core/config.js';
import { checkSentinels, loadPolicy, sha256Hex } from '../clo-plugin/lib/core/contentPolicy.js';
import { createLedger } from '../clo-plugin/lib/core/ledger.js';
import { callWorstMicros, fetchCatalog, lockFromCatalog, resolveSelector, validateModels } from '../clo-plugin/lib/core/models.js';
import { extractPolicySection, writeAtomic } from '../clo-plugin/lib/core/render.js';
import { apply, assertValid, CliError, groupByLabel, lockMatches, makeContext, maskId, readConfig, readEffective, readModelsLock, renderAll, usd, withStore, withStoreAsync, writeConfig, writeModelsLock } from './common.mjs';
import { CONFIG_LEVEL, formatDoctor, FULL_LEVEL, runDoctor } from './doctor.mjs';
import { assertTestModeWired, inspectGateway, parseEnvFile, renamedEnvNames, renamedKeyHint, requireSecrets, startGateway, stopGateway } from './lifecycle.mjs';
import { collectStatus, formatStatus, RESIDUAL_EXIT, residualBehind } from './status.mjs';

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
        [--confirm-price] [--qq-platform-notified]
  ack identity | q0 | d3 <决定> | terminal
  doctor [--config-only] [--json]
  start
  stop`;

const BOOLEAN_FLAGS = new Set(['--all', '--reveal', '--confirm-price', '--qq-platform-notified', '--json', '--ack', '--config-only']);

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

function printWarnings(ctx, cfg) {
  for (const w of assertValid(ctx, cfg).warnings) ctx.out(`提醒：${w.path} ${w.message}`);
}

function saveAndApply(ctx, cfg) {
  writeConfig(ctx, cfg);
  printWarnings(ctx, cfg);
  return apply(ctx, cfg);
}

// --- apply, mode ---

function cmdApply(ctx) {
  const cfg = readConfig(ctx);
  printWarnings(ctx, cfg);
  const r = apply(ctx, cfg);
  ctx.out(`已生成运行配置。模式：${r.effective.mode}。${r.openclawChanged ? 'openclaw.json 有变化。' : 'openclaw.json 没有变化。'}`);
  return 0;
}

const LIVE_HINTS = {
  budget: '预算必须大于 0，且层级顺序正确',
  targets: '至少一个群，且每个群都有 owner（clo group add、clo owner add）',
  dm_closed: 'allowedDmUserIds 必须为空',
  key_readable: '读取这个 Key 的信息失败（D3 没有记录时不会去读），或这个 Key 没有每日限额（limit 不能为空，limit_reset 必须是 daily）',
  reconciled: '对账没有成功',
  heartbeat: 'Gateway 没有在运行，或还没收到过 READY（先在 dry-run 下 clo start）',
  gateway_key: '运行中的 Gateway 没有 .env 里这个 CLO_CHAT_API_KEY。它的环境在启动时固定，改过 .env 要先 clo stop 再 clo start',
  identity: '机器人身份没有确认（看 clo status，再 clo ack identity）',
  notice: '有群没有确认告知（clo group notice-done <群>）',
  q0: 'Q0 没有确认：你还没有确认看过自己的群能收到什么（clo ack q0）',
  d3: 'D3 没有记录。QQ 协议 §4.2（模型资质）的决定要由你本人做出（clo ack d3 <决定>）',
  policy: '内容策略未启用、哈希不符，或 policy-ok 有误拦',
  numbers: 'crisis.localNumbers 填了但没有核实日期',
  doctor: 'doctor 配置检查没有通过（clo doctor）',
  base_urls: '配置里有地址覆盖，只有测试模式允许',
  no_paid_pause: '付费已暂停（看 clo status）',
  models: '模型没有锁定（clo model refresh）',
};

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

// D3 comes first: until it is recorded, this does not contact OpenRouter at all.
async function gatherLiveFacts(ctx, cfg) {
  const facts = { now: ctx.now(), env: ctx.env };
  facts.doctorOk = runDoctor(ctx, { level: CONFIG_LEVEL }).ok;
  facts.policyOk = policyPasses(ctx, cfg);
  facts.modelsLocked = lockMatches(cfg, readModelsLock(ctx.paths));
  const secrets = parseEnvFile(ctx.paths.envFile);
  return withStoreAsync(ctx, async (store) => {
    const number = (k) => {
      const v = store.getControl(k);
      return v === null ? null : Number(v);
    };
    facts.heartbeatAt = number('heartbeat_at');
    const running = store.getControl('gateway_key');
    facts.gatewayKeyMatches = Boolean(secrets.CLO_CHAT_API_KEY) && running === store.key(secrets.CLO_CHAT_API_KEY);
    facts.lastReadyAt = number('last_ready_at');
    facts.key = null;
    facts.reconciled = false;
    if (cfg.acks?.d3 && secrets.CLO_CHAT_API_KEY) {
      const ledger = createLedger({ store, getEffective: () => readEffective(ctx), fetch: ctx.fetch, getKey: () => secrets.CLO_CHAT_API_KEY, log: ctx.log, now: ctx.now });
      try {
        facts.key = await ledger.readKey();
        facts.reconciled = (await ledger.reconcile(ctx.now())).ok;
      } catch {
        facts.key = null;
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
  assertValid(ctx, { ...cfg, mode: 'dry-run' });
  // Fresh render first, so doctor and the ledger read this config and not a stale one.
  apply(ctx, { ...cfg, mode: 'dry-run' });
  const facts = await gatherLiveFacts(ctx, cfg);
  const result = livePreconditions(cfg, facts);
  if (!result.ok) {
    ctx.out('拒绝进入 live，以下条件未满足：');
    const hasKey = Boolean(parseEnvFile(ctx.paths.envFile).CLO_CHAT_API_KEY);
    for (const code of result.failed) ctx.out(`  ${code}：${code === 'key_readable' && !hasKey ? '.env 里没有 CLO_CHAT_API_KEY' : LIVE_HINTS[code] ?? ''}`);
    const hint = hasKey ? '' : renamedKeyHint(renamedEnvNames(ctx.paths.envFile), ['CLO_CHAT_API_KEY']);
    if (hint) ctx.out(hint);
    ctx.log('cli_mode_refused', { count: result.failed.length });
    return 1;
  }
  const next = { ...cfg, mode: 'live' };
  writeConfig(ctx, next);
  withStore(ctx, (store) => store.clearDiscovery());
  apply(ctx, next, { allowLive: true });
  ctx.log('cli_mode', { state: 'live' });
  ctx.out('已进入 live。可洛会回复准入群里的 @，这会产生费用。暂停：clo pause --all');
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
  if (sub === 'dry-run') {
    const cfg = { ...readConfig(ctx), mode: 'dry-run' };
    saveAndApply(ctx, cfg);
    ctx.log('cli_mode', { state: 'dry-run' });
    ctx.out('已切到 dry-run：不调用模型，不发送。');
    return 0;
  }
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

function cmdResume(ctx, { flags }) {
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
    ctx.out(`已把 ${report.db.alerts.length} 条告警标记为已读。`);
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

function cmdBudget(ctx, { positional }) {
  const sub = positional[0] ?? 'show';
  const effective = readEffective(ctx);
  return withStore(ctx, (store) => {
    const ledger = createLedger({ store, getEffective: () => effective, fetch: ctx.fetch, getKey: () => null, log: ctx.log, now: ctx.now });
    if (sub === 'show') {
      const s = ledger.spent(ctx.now());
      const b = effective?.budget;
      ctx.out(`今日（上海日）有效花费：${usd(s.effectiveMicros)}（本地 ${usd(s.localMicros)}，供应商 ${usd(s.providerMicros)}）`);
      ctx.out(`分层：插话 ${usd(s.byTier.interject)}${b ? ` / $${b.interjectUsd}` : ''}，点名 ${usd(s.byTier.named)}${b ? ` / 全部到 $${b.namedUsd} 停` : ''}，@ ${usd(s.byTier.addressed)}${b ? ` / 全部到 $${b.addressedUsd} 停` : ''}`);
      ctx.out(`未结算：${s.unsettled} 笔，${usd(s.unsettledMicros)}。付费暂停：${store.getControl('paid_paused') ?? '否'}`);
      if (b?.keyDailyLimitUsd !== null && b?.keyDailyLimitUsd !== undefined) ctx.out(`Key 日限额应设为 $${b.keyDailyLimitUsd}（在 OpenRouter 上设置，这里只记录）。`);
      ctx.out('本地花费是保守估算：未结算的按预留额计。真实数字以 OpenRouter 账单为准。');
      return 0;
    }
    if (sub === 'accept-unsettled') {
      const n = ledger.acceptUnsettled('cli');
      const held = store.getControl('paid_paused') === 'residual' ? `但付费工作还没有恢复：现在的暂停原因是 residual。${RESIDUAL_EXIT}` : '崩溃或缺 usage 造成的付费暂停随之解除。';
      ctx.out(`已按预留额结清 ${n} 笔未结算记录。${held}`);
      return 0;
    }
    if (sub === 'clear-pause') {
      const { cleared, reason } = ledger.clearOwnerPause();
      if (reason === null) {
        ctx.out('现在没有付费暂停。');
        return 0;
      }
      if (!cleared) {
        const way = { usage_missing: ACCEPT_HINT, crash_unsettled: ACCEPT_HINT, residual: RESIDUAL_EXIT }[reason] ?? '';
        ctx.out(`付费暂停 ${reason} 会由 Key 读取或结算解除，这个命令不动它。${way}${residualBehind(reason, store.getControl('residual_over'))}`);
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
      ctx.out(`已解除付费暂停 ${reason}。原因没有消除的话，它会再次暂停。${restart}`);
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
function raisedPrice(oldLock, lock) {
  if (!oldLock) return false;
  const dearer = (a, b) => a.id === b.id && ['inputPerM', 'outputPerM', 'cacheReadPerM', 'cacheWritePerM'].some((k) => b.price[k] > a.price[k]);
  return dearer(oldLock.primary, lock.primary) || dearer(oldLock.decision, lock.decision);
}

function budgetWarning(ctx, cfg, lock) {
  const worst = 2 * callWorstMicros(lock.primary.price, cfg.claudeModel);
  if (worst > cfg.budget.addressedUsd * 1e6) ctx.out(`提醒：一次必答回合预留 ${usd(worst)}，超过日预算 $${cfg.budget.addressedUsd}，这样 @ 永远得不到额度。`);
}

function commitModels(ctx, next, catalog, flags, { changed }) {
  const confirmPrice = Boolean(flags['--confirm-price']);
  const qqPlatformNotified = Boolean(flags['--qq-platform-notified']);
  const v = validateModels(next, catalog, { confirmPrice, qqPlatformNotified, change: changed });
  if (!v.ok) throw new CliError(printModelErrors(v));
  for (const w of v.warnings) ctx.out(`提醒：${w.path} ${w.message}`);
  const oldLock = readModelsLock(ctx.paths);
  const lock = lockFromCatalog(next, catalog);
  if (raisedPrice(oldLock, lock) && !confirmPrice) throw new CliError('目录价格比锁定时高，加 --confirm-price 才接受。');
  writeConfig(ctx, next);
  writeModelsLock(ctx, lock, { qqPlatformNotified, changed });
  apply(ctx, next);
  budgetWarning(ctx, next, lock);
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

async function cmdModel(ctx, { positional, flags }) {
  const sub = positional[0] ?? 'show';
  const cfg = readConfig(ctx);
  const lock = readModelsLock(ctx.paths);
  if (sub === 'show') {
    ctx.out(`配置：主模型 ${cfg.claudeModel.id}（effort ${cfg.claudeModel.effort}，maxTokens ${cfg.claudeModel.maxTokens}），判定模型 ${cfg.decisionModel.id}（effort ${cfg.decisionModel.effort}，maxTokens ${cfg.decisionModel.maxTokens}）`);
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
    return commitModels(ctx, next, catalog, flags, { changed });
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
    else ctx.out('与锁定一致。');
    return 0;
  }
  throw new CliError(USAGE);
}

// --- ack ---

function cmdAck(ctx, { positional }) {
  const sub = positional[0];
  if (sub === 'terminal') {
    const code = withStore(ctx, (store) => {
      const c = store.getControl('terminal_close');
      store.delControl('terminal_close');
      return c;
    });
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
  throw new CliError(USAGE);
}

// --- doctor, start, stop ---

function cmdDoctor(ctx, { flags }) {
  const report = runDoctor(ctx, { level: flags['--config-only'] ? CONFIG_LEVEL : FULL_LEVEL });
  ctx.out(flags['--json'] ? JSON.stringify(report, null, 2) : formatDoctor(report));
  return report.ok ? 0 : 1;
}

async function cmdStart(ctx) {
  const cfg = readConfig(ctx);
  assertTestModeWired(cfg, ctx.env);
  const current = inspectGateway(ctx.paths, ctx.env);
  if (current.state === 'running') throw new CliError(`Gateway 已在运行（进程 ${current.record.pid}）。`);
  if (current.state === 'unknown') throw new CliError(`查不到进程 ${current.record.pid} 的状态，可能还在运行。PID 文件保留，请稍后再试。`);
  if (current.state !== 'none') rmSync(ctx.paths.pidFile, { force: true });

  const secrets = parseEnvFile(ctx.paths.envFile);
  requireSecrets(cfg, secrets, { renamed: renamedEnvNames(ctx.paths.envFile) });
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
  const { pid, port } = await startGateway(ctx, cfg, { secrets });
  ctx.out(`Gateway 已启动：进程 ${pid}，端口 ${port}（仅 loopback），模式 ${cfg.mode}。`);
  ctx.out('连上 QQ 通常要 30–45 秒，用 clo status 确认“心跳新鲜”和“已连接”。');
  return 0;
}

function cmdStop(ctx) {
  const r = stopGateway(ctx);
  const noteDown = () => {
    if (existsSync(ctx.paths.db)) withStore(ctx, (store) => store.setControl('connected', 'false', 'cli'));
  };
  if (r.stopped) {
    noteDown();
    ctx.out(`已停止 Gateway（进程 ${r.pid}）。`);
    return 0;
  }
  if (r.reason === 'lookup_failed') {
    ctx.out('查不到记录的进程状态，它可能还在运行。没有动它，PID 文件保留，请稍后再试 clo stop。');
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
