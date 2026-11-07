// Status report for the console. No cost or ID leaves this machine through it; IDs are masked here too.
import { existsSync } from 'node:fs';
import { providerOfConfig, providerOfEffective, runtimeOf } from '../clo-plugin/lib/core/config.js';
import { hardCapPauseKey } from '../clo-plugin/lib/core/providers/registry.js';
import { isQuietHours, shanghaiDay } from '../clo-plugin/lib/core/ids.js';
import { openStore } from '../clo-plugin/lib/core/store.js';
import { maskId, readConfig, readEffective } from './common.mjs';
import { inspectGateway, recordRuntime, RUNTIME_LABEL } from './lifecycle.mjs';

const HEARTBEAT_FRESH_MS = 90000;

const clock = (ms) => (ms === null || ms === undefined ? '无' : new Date(ms + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19));

export function collectStatus(ctx) {
  const { paths, env, now } = ctx;
  const at = now();
  // A broken config must not hide whether the Gateway is up.
  let cfg = null;
  let configError = false;
  try {
    cfg = existsSync(paths.configJson) ? readConfig(ctx) : null;
  } catch {
    configError = true;
  }
  const effective = readEffective(ctx);
  const gateway = inspectGateway(paths, env);
  const report = {
    at,
    configError,
    mode: cfg?.mode ?? null,
    effectiveMode: effective?.mode ?? null,
    // What the next start runs, and what the PID record says is running. They differ until a stop and a start.
    runtime: cfg ? runtimeOf(cfg) : runtimeOf(effective),
    pidRuntime: gateway.record ? recordRuntime(gateway.record) : null,
    qqEnabled: cfg?.qq?.enabled ?? false,
    appIdMasked: cfg?.qq?.appId ? maskId(cfg.qq.appId) : null,
    identityConfirmed: Boolean(cfg?.qq?.appId) && cfg?.acks?.identityConfirmedAppId === cfg?.qq?.appId,
    d3Recorded: typeof cfg?.acks?.d3 === 'string' && cfg.acks.d3.length > 0,
    pid: gateway.record?.pid ?? null,
    pidState: gateway.state,
    quietHoursNow: cfg?.quietHours ? isQuietHours(at, cfg.quietHours) : null,
    groups: [],
    db: null,
    provider: null,
  };
  // The provider config.json names, or, with no readable config, the one the effective file runs on. Only the name, the
  // kind and whether its Key can be read leave here; capabilities come from code by kind.
  const p = cfg ? providerOfConfig(cfg) : (effective ? providerOfEffective(effective) : null);
  if (p) report.provider = { name: p.name, kind: p.kind, implicit: p.implicit, keyReadable: p.caps.keyReadable === true, hardCapPaused: null };
  else if (cfg) report.provider = { name: null, kind: null, implicit: false, keyReadable: false, hardCapPaused: null };
  const groups = cfg?.qq?.groups ?? {};
  if (existsSync(paths.db)) {
    const store = openStore(paths.db, { now });
    try {
      const snap = store.statusSnapshot(at);
      report.db = { ...snap, readyUsername: store.getControl('ready_username'), discoveryUntil: store.getControl('discovery_until'), residualOver: store.getControl('residual_over') };
      // The hard-cap pause of the active kind. It is not a paid_paused reason, so statusSnapshot does not show it.
      if (report.provider?.kind) report.provider.hardCapPaused = store.getControl(hardCapPauseKey(report.provider.kind));
      const owned = cfg?.qq?.owner?.groupMember ?? {};
      report.groups = Object.entries(groups).map(([id, g]) => ({
        label: g.label, idMasked: maskId(id), paused: snap.paused.groups.includes(store.key(id)),
        interject: g.interject, nameMention: g.nameMention, displayNames: g.displayNames === true, noticeGiven: g.noticeGiven, owners: owned[id]?.length ?? 0,
      }));
      report.day = shanghaiDay(at);
    } finally {
      store.close();
    }
  } else {
    const owned = cfg?.qq?.owner?.groupMember ?? {};
    report.groups = Object.entries(groups).map(([id, g]) => ({
      label: g.label, idMasked: maskId(id), paused: false,
      interject: g.interject, nameMention: g.nameMention, displayNames: g.displayNames === true, noticeGiven: g.noticeGiven, owners: owned[id]?.length ?? 0,
    }));
  }
  // /readyz and the ready log line depend on channel state (observed), so neither is used.
  const heartbeatAt = report.db?.heartbeatAt ?? null;
  report.heartbeatFresh = heartbeatAt !== null && at - heartbeatAt <= HEARTBEAT_FRESH_MS;
  report.alive = report.pidState === 'running' && report.heartbeatFresh;
  report.budget = effective?.budget ?? null;
  return report;
}

const yn = (v) => (v ? '是' : '否');

// A residual is today's sum of unattributed rows. Later reads do not remove them, and no command does.
export const RESIDUAL_EXIT = 'Key 上有本地记录解释不了的花费，先核对 OpenRouter 账单。这笔花费按上海日累计，之后的读数和充值都不会让它减少，通常要到上海时间零点后的第一次 Key 读取才解除，没有命令能提前解除。';
export const residualBehind = (reason, over) => (reason !== null && reason !== 'residual' && Number(over ?? 0) >= 2 ? `除了这个原因，还有 residual，解除这个原因也不会恢复付费工作。${RESIDUAL_EXIT}` : '');

export function formatStatus(s) {
  const lines = [];
  if (s.configError) lines.push('config.json 读不了，下面的配置项不可信。');
  lines.push(`模式：${s.mode ?? '无配置'}${s.effectiveMode && s.effectiveMode !== s.mode ? `（生效中：${s.effectiveMode}，运行 clo apply）` : ''}`);
  lines.push(`QQ：${s.qqEnabled ? '启用' : '关闭'}，AppID ${s.appIdMasked ?? '未填'}，身份已确认：${yn(s.identityConfirmed)}${s.db?.readyUsername ? `，READY 用户名：${s.db.readyUsername}` : ''}`);
  lines.push(`D3：${s.d3Recorded ? '已记录' : '未记录，live 会被拒绝'}`);
  const pidText = { none: '没有 PID 文件', gone: '记录的进程已不在', mismatch: 'PID 已被其他进程占用', unknown: '查不到进程状态，可能还在运行', running: `进程 ${s.pid} 在运行` }[s.pidState];
  const label = RUNTIME_LABEL[s.pidRuntime ?? s.runtime] ?? 'Gateway';
  lines.push(`${label}：${pidText}；心跳新鲜：${yn(s.heartbeatFresh)}；判定存活：${yn(s.alive)}`);
  const p = s.provider;
  // Shown once a providers block exists, or whenever the provider is not the implicit OpenRouter one.
  if (p && !p.implicit) {
    lines.push(p.kind ? `模型接口：${p.name}（${p.kind}）` : '模型接口：config.json 没有指定能用的接口，不能调用模型');
    if (p.kind && !p.keyReadable) lines.push('对账：不可用（本地估算）。这个接口读不到 Key 的花费和限额，花费只按本地估算；未结算记录要用 clo budget accept-unsettled 结清，付费暂停要用 clo budget clear-pause 解除。');
  }
  if (p?.hardCapPaused) {
    const why = p.hardCapPaused === 'provider_rules'
      ? '这个接口进入 live 的项目规则还没有记录（CLAUDE.md §8.2、DECISIONS.md），启动检查没有通过'
      : '启动时声明的硬上限和进程用的 Key 对不上，或声明不完整';
    lines.push(`硬上限未核实：${p.name ?? p.kind} 的付费工作已暂停（${p.hardCapPaused}）。${why}。只有在 dry-run、进程停止时重新 clo ack hard-cap ${p.name ?? p.kind} 才解除。`);
  }
  if (s.runtime === 'own' || s.pidRuntime === 'own') lines.push(`运行时：配置为 ${s.runtime}${s.pidRuntime && s.pidRuntime !== s.runtime ? `，记录的进程是 ${s.pidRuntime}，clo stop 再 clo start 才会切换` : ''}`);
  if (s.groups.length === 0) lines.push('群：无（空列表表示全部关闭）');
  for (const g of s.groups) {
    lines.push(`群 ${g.label}（${g.idMasked}）：暂停 ${yn(g.paused)}，插话 ${yn(g.interject)}，点名 ${yn(g.nameMention)}，显示名 ${yn(g.displayNames)}，已告知 ${yn(g.noticeGiven)}，owner ${g.owners} 人`);
  }
  if (!s.db) {
    lines.push('数据库：还没创建（首次启动时创建）');
    return lines.join('\n');
  }
  const d = s.db;
  lines.push(`连接：${d.connected ? '已连接' : '未连接'}；最近 READY：${clock(d.lastReadyAt)}；最近事件：${clock(d.lastEventAt)}；最近心跳：${clock(d.heartbeatAt)}`);
  lines.push(`暂停：全局 ${yn(d.paused.global)}，插话 ${yn(d.paused.interject)}，付费 ${d.paidPaused ?? '否'}，判定 ${d.decisionPausedAt === null ? '否' : `熔断中（最近失败或试探：${clock(d.decisionPausedAt)}）`}`);
  if (d.paidPaused === 'openrouter_credits') lines.push('付费暂停 openrouter_credits：充值后可用 clo budget clear-pause 解除（还有未结算记录时转为 usage_missing），否则等待后自动重试。');
  if (d.paidPaused === 'usage_missing') lines.push('付费暂停 usage_missing：未结算记录结清后自动解除，也可以用 clo budget accept-unsettled 按预留额结清。');
  if (d.paidPaused === 'usage_unavailable') lines.push('付费暂停 usage_unavailable：不会自动解除。排查后用 clo budget clear-pause 解除并重启 Gateway。');
  if (d.paidPaused === 'residual') lines.push(`付费暂停 residual：${RESIDUAL_EXIT}`);
  const behind = residualBehind(d.paidPaused, d.residualOver);
  if (behind) lines.push(`付费暂停 ${d.paidPaused}：${behind}`);
  if (d.terminalClose) lines.push(`平台关闭连接：关闭码 ${d.terminalClose}。已停止，不重连。原因不做推断；处理后用 clo ack terminal 解除。`);
  if (d.discoveryUntil && Number(d.discoveryUntil) > s.at) lines.push(`ID 采集：开启中，到 ${clock(Number(d.discoveryUntil))}`);
  const us = (m) => `$${(m / 1e6).toFixed(4)}`;
  const b = s.budget;
  lines.push(`今日花费（上海日）：插话 ${us(d.spendToday.interject)}${b ? `/$${b.interjectUsd}` : ''}，点名 ${us(d.spendToday.named)}${b ? `/$${b.namedUsd}` : ''}，@ ${us(d.spendToday.addressed)}${b ? `/$${b.addressedUsd}` : ''}，未归属 ${us(d.spendToday.none)}`);
  // ref_key is null both when ref_idx is missing and when it is not a string. Only exit_post's refState tells them apart.
  lines.push(`未结算：${d.unsettled} 笔，${us(d.unsettledMicros)}；发送结果不确定：${d.sendsUncertain} 条；bot_refs：${d.botRefsSeen}（已发送但没有可用 ref_idx：${d.sendsNoRef} 条）；今日判定跳过（总数）：${d.skipClassToday}`);
  const events = Object.entries(d.eventsToday).map(([k, v]) => `${k} ${v}`).join('，');
  lines.push(`今日事件：${events || '无'}`);
  if (d.alerts.length === 0) lines.push('告警：无');
  for (const a of d.alerts) {
    const detail = Object.entries(a.detail).map(([k, v]) => `${k}=${v}`).join(' ');
    lines.push(`告警 #${a.id} ${clock(a.at)} ${a.kind}${detail ? ` ${detail}` : ''}${a.suppressed ? `（另有 ${a.suppressed} 条被合并）` : ''}`);
  }
  return lines.join('\n');
}
