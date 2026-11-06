// README and DEPLOYMENT are what the user reads before agreeing to anything, so their claims about status and spend
// are checked here. These pin wording that was found false, and figures that come from the code.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { DOWN_ALERT_AFTER_MS, PROBE_FAILS_TO_SUSPECT } from '../../src/clo-plugin/lib/channels/qq/connection.js';
import { buildPlan } from '../../src/tools/q5-probe.mjs';
import { makeRoot, ROOT } from './_cli-helper.mjs';

const read = (name) => readFileSync(join(ROOT, name), 'utf8');
const README = read('README.md');
const DEPLOYMENT = read('DEPLOYMENT.md');
const plan = buildPlan(ROOT);
const worst = `$${(plan.totalWorstMicros / 1e6).toFixed(4)}`;

const assertGone = (text, phrases, where) => {
  for (const phrase of phrases) assert.ok(!text.includes(phrase), `${where} still says: ${phrase}`);
};

test('the status text matches the recorded runs up to Q6, and still says what has not happened', () => {
  assertGone(DEPLOYMENT, ['可洛没有在真实 QQ 或真实 OpenRouter 上跑过一次', '等写入 `config.json`', '通道已写入，只在 mock 上看过', '**没有运行，本阶段禁止**', '真实目录没读过', '`versions.lock.json` 里还没有 `models.lock`'], 'DEPLOYMENT');
  assertGone(README, ['没有在真实 QQ 或真实 OpenRouter 上跑过', '第一次读真实目录，尚未实测'], 'README');
  for (const text of [README, DEPLOYMENT]) {
    assert.match(text, /Q3、Q4/);
    assert.match(text, /dry-run/);
    assert.match(text.slice(0, 800), /只在一个测试群里运行，还没有进真实的群/, 'the top of the file says how far it has gone, and no further');
    assert.match(text.slice(0, 800), /打开了点名和插话/);
  }
  assert.match(DEPLOYMENT, /真实 QQ 上的 `start` \| 已运行：dry-run（Q3、Q4），以及 live（Q6，只有测试群）/);
  assert.match(DEPLOYMENT, /Q6 测试群 @ \| 退出标准达到/);
  assert.match(DEPLOYMENT, /分群暂停、拒答、内容过滤命中、有回合在跑时重启都没有验证/, 'what Q6 did not show stays stated until it is shown');
  assert.match(README, /`\/new` 也不会删除旧内容/);
  assert.match(DEPLOYMENT, /Q5 付费探测 \| 已运行一次/);
  assert.match(DEPLOYMENT, /人设效果\*\*仍未观察\*\*/, 'one probe says nothing about reply quality');
});

test('neither file claims the model is filed or qualified', () => {
  for (const [name, text] of [['README', README], ['DEPLOYMENT', DEPLOYMENT]]) {
    for (const line of text.split('\n')) {
      if (/已备案|已具备资质|具备合法资质/.test(line)) assert.match(line, /不|没有|未/, `${name}: ${line}`);
    }
  }
  assert.match(README, /不对外声称模型已备案/);
});

test('the figures the user agrees to are the ones the plan prints', () => {
  assert.equal(plan.turnCallLimit, 2);
  for (const [name, text] of [['README', README], ['DEPLOYMENT', DEPLOYMENT]]) {
    assert.ok(text.includes(`最坏费用 ${worst}`) || text.includes(`最坏 ${worst}`), `${name} has the worst case`);
    assert.ok(text.includes(`最多 ${plan.maxModelCalls} 次模型调用`), `${name} has the call count`);
  }
  // Each example is checked against the plan of the runtime its line names.
  const ownPlan = buildPlan(ROOT, { runtime: 'own' });
  let examples = 0;
  for (const line of DEPLOYMENT.split('\n')) {
    for (const m of line.matchAll(/-MaxUsd (\d+\.\d+)/g)) {
      const bound = /-Runtime own\b/.test(line) ? ownPlan.totalWorstMicros : plan.totalWorstMicros;
      assert.ok(Number(m[1]) * 1e6 >= bound, `the example ${m[0]} would be refused: ${line.slice(0, 80)}`);
      examples += 1;
    }
  }
  assert.ok(examples >= 3, 'positive control: the examples of both runtimes were found');
  const turnRow = `$${(plan.turns.reduce((a, t) => a + t.worstMicros, 0) / 1e6).toFixed(4)}`;
  assert.ok(DEPLOYMENT.includes(turnRow), 'the Gateway row of the table, which moved with the probe text');
});

test('the spend text says what bounds it, and does not lean on the old assumption', () => {
  assertGone(README, ['每回合宿主可能调用两次模型', '所以按两次计入上限', '可能重试一次'], 'README');
  assertGone(DEPLOYMENT, ['所以每回合按两次计入上限'], 'DEPLOYMENT');
  assert.match(README, /真正的硬上限是 Key 的每日限额/);
  assert.match(DEPLOYMENT, /高于 `-MaxUsd` 时工具拒绝启动/);
  assert.match(README, /这个预留不是回合费用的上限/, 'the production hold rests on the same two calls');
  assert.match(DEPLOYMENT, /正式运行的回合没有请求上限/);
  assert.match(DEPLOYMENT, /真实路线只验证到连接被拒绝这一步/);
  assert.match(DEPLOYMENT, /真实路线只离线验证到“连接被拒绝”这一步/);
});

test('the region text does not call a guess confirmed', () => {
  assert.match(README, /region_suspected/);
  assert.match(DEPLOYMENT, /region_suspected/);
});

test('the liveness text describes the logic that is in the code', () => {
  assert.equal(PROBE_FAILS_TO_SUSPECT, 3);
  assertGone(README, ['探测失败又恢复、而 SDK 还认为连着时'], 'README');
  assertGone(DEPLOYMENT, ['失败又恢复且 SDK 仍认为连着时', '只在 mock 上驱动过判断逻辑'], 'DEPLOYMENT');
  assert.match(README, /连续 3 次失败才算可疑/);
  assert.match(DEPLOYMENT, /连续 3 次失败才算可疑/);
});

test('it does not claim a complete list of production changes, which nothing here can prove', () => {
  assertGone(DEPLOYMENT, ['这一轮对正式运行代码唯一的改动'], 'DEPLOYMENT');
  assert.match(DEPLOYMENT, /这里不声称有完整清单/);
});

test('the probe text separates the state it isolates from the programs it runs', () => {
  assertGone(DEPLOYMENT, ['不读真实的 `.runtime` 和 `config.json`'], 'DEPLOYMENT');
  assert.match(DEPLOYMENT, /不读真实的 `\.runtime` 状态和 `config\.json`，只用项目 `\.runtime` 里的私有 Node 和宿主程序/);
});

test('the display name text states what real QQ showed, and only for the one account tested', () => {
  const DECISIONS = read('DECISIONS.md');
  const row = DECISIONS.split('\n').find((l) => l.startsWith('| 显示名开关'));
  assert.ok(row, 'an evidence row exists');
  assert.match(row, /用一个账号测过/);
  assert.match(row, /跟着 QQ 昵称变.*其他账号和字段缺失的情况都没有观察过/);
  assert.match(README, /用一个账号测过：它跟着 \*\*QQ 昵称\*\*变.*\*\*没有观察过\*\*/);
  assert.match(DEPLOYMENT, /跟着 QQ 昵称变.*延迟没有测准/);
  assert.match(DEPLOYMENT, /\*\*没有验证：\*\* 其他账号上是否一样、字段会不会缺失/);
  assert.match(README, /回复里写到的显示名一定跟着回复存进去/, 'the session store is not called clean');
  assert.match(DEPLOYMENT, /要 Gateway 重启一次才生效/);
});

test('the display name text says what the filter does not do, and how a name still gets stored', () => {
  const row = read('DECISIONS.md').split('\n').find((l) => l.startsWith('| 显示名开关'));
  assertGone(row, ['恶意名字不会原样进提示词'], 'DECISIONS');
  assert.match(row, /短指令文字.*仍会原样作为名字进提示词/);
  assert.match(README, /短的指令文字.*仍然可能进到提示词/);
  assert.match(DEPLOYMENT, /短指令文字能进提示词/);
  assert.match(DEPLOYMENT, /在真实的群打开之前，要先用真实模型查一次/);
  assert.match(README, /相邻的文字仍可能碰到内容规则/);
  assert.match(DEPLOYMENT, /相邻的文字仍可能碰到内容规则/);
  assert.match(README, /`flagged_input`.*里面的显示名也会存进去/);
  assert.match(DEPLOYMENT, /`flagged_input`.*里面的名字也存进去/);
  assertGone(README, ['思考文字里写到的也会'], 'README');
  assertGone(DEPLOYMENT, ['关掉后立刻停'], 'DEPLOYMENT');
  assert.match(DEPLOYMENT, /进行中的回合和它的重试不受影响/);
  assert.match(README, /下一条任何消息（命令、过期、暂停时的消息也算）/);
  assert.match(DEPLOYMENT, /只有单元测试，不含 e2e/);
});

test('the group notice does not claim what has not been observed, and is honest about the IDs', () => {
  const notice = read('persona/group-notice.zh.md');
  assertGone(notice, ['QQ 号和账号 ID 不会发出去', '昵称是你自己起的', '当时的昵称', '昵称或群名片，这样'], 'the notice');
  assert.match(notice, /原始 QQ 号和账号 ID 不发，但每个人和这个群各会带一个由 ID 算出的固定编号/);
  assert.match(notice, /如果有人把 QQ 号写进显示名，程序会尽量拦下，但不保证都拦得住/);
  assert.match(notice, /目前测到的是 QQ 昵称，不是群名片（只用一个账号测过）/);
  assert.match(notice, /不一定是本人起的/);
  assert.match(notice, /显示名（这个群现在：<开\/关>）/, 'names are per group, so the notice says which state this group is in');
  assert.match(notice, /只在模拟环境里验证过/);
  assert.match(notice, /模型服务方报错时返回的内容里也可能带上/);
});

test('the temp-root text says what happens when it cannot be deleted', () => {
  assert.match(DEPLOYMENT, /临时目录里有文字/);
  assert.match(DEPLOYMENT, /进程被强杀时删不掉/);
});

// The repo is public. These hold what was decided for the public text.
const PUBLIC_DOCS = ['README.md', 'DEPLOYMENT.md', 'DECISIONS.md', 'docs/group-chat-design.md', 'docs/q0a-guide.zh.md', 'docs/wiring-trial.md', 'docs/own-runtime.md', 'docs/cost-options.md'];

test('public docs do not send a reader to files that are not in the repo, or name private things', () => {
  const documentation = /^(?:127\.0\.0\.1|0\.0\.0\.0|192\.0\.2\.\d+|198\.51\.100\.\d+|203\.0\.113\.\d+)$/;
  for (const name of PUBLIC_DOCS) {
    const text = read(name);
    assertGone(text, ['.private', 'C:\\Users\\'], name);
    assert.doesNotMatch(text, /\bhost=[^<\s`]/, `${name} has a host= value`);
    for (const [ip] of text.matchAll(/(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g)) assert.match(ip, documentation, `${name} has a network address`);
    for (const [, target] of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      if (/^[a-z]+:/i.test(target) || !/[./]/.test(target)) continue; // a URL, or code such as f(b)
      assert.ok(existsSync(join(ROOT, dirname(name), target)), `${name} links to a file that is not in the repo: ${target}`);
    }
  }
});

// Terms specific to one deployment stay out of the repo, so their list does too. It lives in the ignored .private folder,
// and this check runs only where that file exists.
const PRIVATE_TERMS = join(ROOT, '.private', 'public-denylist.json');

test('public docs hold none of the local private terms', { skip: !existsSync(PRIVATE_TERMS) && 'no local list' }, () => {
  const terms = JSON.parse(readFileSync(PRIVATE_TERMS, 'utf8'));
  assert.ok(terms.length > 0);
  for (const name of PUBLIC_DOCS) {
    const text = read(name);
    terms.forEach((term, i) => assert.ok(!text.includes(term), `${name} has private term number ${i}`));
  }
});

test('the project is a QQ bot, and WeChat appears only as the future note and the doctor rule', () => {
  for (const name of PUBLIC_DOCS) {
    if (name === 'DECISIONS.md') continue; // its 用户定的 section records this very decision
    for (const line of read(name).split('\n')) {
      if (!/微信|wechat|weixin/i.test(line)) continue;
      const isNote = name === 'README.md' && line.includes('未来可能加入微信机器人实现，架构上作预留');
      const isDoctorRule = /doctor/i.test(line) && line.includes('@agent-wechat/agent-wechat');
      assert.ok(isNote || isDoctorRule, `${name}: ${line.slice(0, 80)}`);
    }
  }
  assert.match(README, /QQ 官方机器人/);
  assert.match(README, /核心里还有 QQ 专用的部分/, 'room for other channels is stated honestly');
  assert.equal(JSON.parse(read('versions.lock.json')).parked, undefined);
});

test('the docs use the new key names and do not claim other endpoints work', () => {
  for (const name of PUBLIC_DOCS) {
    const text = read(name);
    assertGone(text, ['CLO_SEARCH_OPENROUTER_KEY'], name);
    for (const line of text.split('\n')) {
      if (line.includes('OPENROUTER_API_KEY')) assert.match(line, /CLO_CHAT_API_KEY/, `${name}: the old name only beside the new one, as what the host reads`);
    }
  }
  for (const key of ['CLO_QQ_APP_ID', 'CLO_QQ_APP_SECRET', 'CLO_CHAT_API_KEY', 'CLO_SEARCH_API_KEY']) assert.ok(README.includes(key), key);
  assert.match(README, /目前只适用于 OpenRouter/);
  assert.match(README, /其他 OpenAI 兼容接口未来可能加入，但现在不能用/);
  assert.match(README, /账户侧限额/);
});

test('the money section has the example Key limit and the local budget', () => {
  assert.match(README, /\$1\.60\/UTC 日，每天重置/);
  assert.match(README, /本地日预算 \| \$2\.5\/上海日/);
  assertGone(README, ['$3.25', '已完成部署'], 'README');
  assertGone(DEPLOYMENT, ['$3.25', '已完成部署'], 'DEPLOYMENT');
});

test('the first-run steps name what AppID and AppSecret alone do not cover', () => {
  assert.match(README, /不需要扫码，也不需要手动登录/);
  for (const step of ['qq.enabled', 'targets arm', 'group add', 'owner add', 'group notice-done', 'model refresh', 'ack identity', 'ack q0', 'ack d3', 'mode live', '获取群内全部消息', '主动发言', 'group-notice.zh.md']) {
    assert.ok(README.includes(step), step);
  }
  assert.match(README, /没有自启动/);
  assert.match(README, /错过的消息不补/);
  if (!existsSync(join(ROOT, 'LICENSE'))) assert.match(README, /许可证：\*\* 还没有决定/);
});

test('every console command the README shows is in the console usage', () => {
  const usage = read('src/cli/clo.mjs').split('const USAGE = ')[1].split('`;')[0];
  const seen = new Set();
  for (const m of README.matchAll(/scripts.clo\.ps1 ([a-z-]+)(?: ([a-z-]+))?/g)) {
    seen.add(m[1]);
    assert.match(usage, new RegExp(`^\\s*(?:用法：clo <命令>\\s*)?${m[1]}\\b`, 'm'), m[0]);
    if (m[2]) assert.ok(usage.includes(m[2]), m[0]);
  }
  assert.ok(seen.has('group') && seen.has('mode') && seen.has('targets'), 'positive control: the commands were found');
});

test('every relative link in the README resolves to a file in the repo', () => {
  const links = [...README.matchAll(/\]\((?!https?:)([^)#]+)\)/g)].map((m) => m[1]);
  assert.ok(links.length >= 5, 'positive control');
  for (const link of links) assert.ok(existsSync(join(ROOT, link)), link);
});

test('the steps say to wait for the connection, and that the READY name alone does not show it', () => {
  const step8 = README.slice(README.indexOf('### 8. 确认三件事'), README.indexOf('## 日常使用'));
  assert.ok(step8.indexOf('连接：已连接') !== -1 && step8.indexOf('连接：已连接') < step8.indexOf('mode live'), 'the wait comes before the command');
  assert.match(step8, /只看 READY 用户名不够/);
  assert.match(step8, /`gateway_key`.*不用照做/s, 'a reader who has just restarted is not sent round again');
  assertGone(README, ['通常要 30–45 秒', '按之前的记录，单元和接缝'], 'README');
});

test('a command the README gives can be run as written', () => {
  // The host CLI is not on PATH and needs the project state and the Gateway token. Nothing wraps channels.start.
  assertGone(README, ['openclaw gateway call'], 'README');
});

test('the Q0 guide tells a reader from step 5 what differs, before anything that conflicts', () => {
  const guide = read('docs/q0a-guide.zh.md');
  const section = guide.slice(guide.indexOf('## 从 README 第 5 步过来'), guide.indexOf('## 一、准备'));
  assert.ok(section.length > 0 && guide.indexOf('复制 `.env.example` 为') > guide.indexOf('## 一、准备'), 'the note comes first');
  assert.match(section, /先停 Gateway.*stop\.ps1/);
  assert.match(section, /不要再复制 `\.env\.example`/);
  assert.match(section, /没有测过/, 'what two connections do on real QQ is not claimed');
  assert.match(section, /start\.ps1/);
  assert.match(README, /q0a-guide\.zh\.md.*从 README 第 5 步过来/);
});

test('picking the owner ID says how to tell rows apart, how to undo it, and when it can be confirmed', () => {
  assert.match(README, /趁群里安静时/);
  assert.match(README, /选次数涨了的那一行/);
  assert.match(README, /没有 `owner remove` 命令.*qq\.owner\.groupMember/);
  assert.match(README, /dry-run 下确认不了.*进入 live 后/);
  assert.doesNotMatch(read('src/cli/clo.mjs').split('const USAGE = ')[1].split('`;')[0], /owner remove/, 'if a remove command is added, this text is out of date');
});

test('step 4 says what is known about adding the bot and the 体验用户 list, and how sure it is', () => {
  const step4 = README.slice(README.indexOf('### 4. 把机器人加进群'), README.indexOf('### 5. 启动 dry-run'));
  assert.match(step4, /读文档得到/);
  assert.match(step4, /开发体验用户/);
  assert.match(step4, /一个测试群里观察到/);
  assert.match(step4, /我们没有记下来/);
});

test('what happens when the money runs out matches the exit', () => {
  const cap = Number(read('src/clo-plugin/lib/core/config.js').match(/failureLinePerGroupPerHour: (\d+)/)[1]);
  assert.ok(README.includes(`每个钟点（整点到整点）最多 ${cap} 条（\`failline_rate\`）`), 'the cap on failure lines');
  assert.ok(DEPLOYMENT.includes(`每个钟点最多 ${cap} 条（\`failline_rate\`）`));
  assertGone(README, ['插话和点名静默。'], 'README');
  assert.match(README, /点名看走到哪一步.*回复的预留不够时，发一句固定的失败句/);
});

test('the interjection row has both lines the ledger applies', () => {
  const { budget } = JSON.parse(read('config.example.json'));
  const row = README.split('\n').find((l) => l.startsWith('| 插话 |') && l.includes('本机账本'));
  assert.ok(row, 'the row exists');
  assert.ok(row.includes(`$${budget.interjectUsd.toFixed(2)}`), 'its own line');
  assert.ok(row.includes(`$${budget.searchUsd.toFixed(2)}`), 'the total line, which the ledger applies under the name searchUsd');
  assert.ok(row.includes('`searchUsd`'));
});

test('what the notice draft says is described as it now reads', () => {
  assert.match(read('persona/group-notice.zh.md'), /这个版本还不能删除已经留在本机的记录/);
  assertGone(DEPLOYMENT, ['草稿说可以申请删除'], 'DEPLOYMENT');
  assert.match(DEPLOYMENT, /草稿已写明这一版不能删除本机记录/);
});

test('what was not checked in Q7 and after is still stated', () => {
  const rows = DEPLOYMENT.split('\n');
  const named = rows.find((l) => l.startsWith('| 点名 |'));
  const interject = rows.find((l) => l.startsWith('| 插话 |'));
  assert.match(named, /转发、夜间点名没有验证/);
  assert.match(interject, /都是同一个账号发的/);
  assert.match(interject, /其他成员的消息、真实群聊里判定准不准没有验证/);
  assert.match(DEPLOYMENT, /预留和预算还没有按 Q5、Q6 的真实数字调整/);
  assert.match(DEPLOYMENT, /连续失败的暂停拦不住同一回合内已经开始的重试/);
  assert.match(DEPLOYMENT, /一个成员的所有行共用最新的标签/);
  assert.match(README, /一个成员的所有行共用最新的名字/);
});

test('the /stop same-second case says it was seen only on a fake host, and what it left behind', () => {
  for (const text of [README, DEPLOYMENT]) {
    assert.match(text, /假宿主跑过一次 @，还留下一个 `model_failed` 告警和一行未结算/);
  }
  assert.match(DEPLOYMENT, /等待发送空位的部分只有单元测试，没有在真实 Gateway 上跑过/);
});

test('the path limit is stated with how it was measured', () => {
  assert.match(README, /项目路径要短/);
  assert.match(README, /`hook_registered：插件 clo 没有加载`/);
  assert.match(README, /没有在真实部署上量过/);
});

test('DECISIONS says what CLAUDE.md is', () => {
  assert.match(read('DECISIONS.md'), /`CLAUDE\.md` 是当前的任务书，已从最初的微信任务书改写为 QQ 版/);
});

test('the decisions made on 2026-11-05 are described as built, in simulation only, and the design says the same', () => {
  const DECISIONS = read('DECISIONS.md');
  const DESIGN = read('docs/group-chat-design.md');
  const section = DECISIONS.slice(DECISIONS.indexOf('## 用户定的'), DECISIONS.indexOf('第一次提交之前要做的'));
  assert.match(section, /第一批修复实现了这四条/);
  assert.match(section, /都只在模拟环境验证过/);
  assert.match(section, /真实 QQ 和真实模型没有测/);
  assert.match(DEPLOYMENT, /## 第一批修复[^\n]*\n\n[^\n]*\*\*都只在模拟环境验证过\*\*/);
  assertGone(DEPLOYMENT, ['里有几条决定还没有实现'], 'DEPLOYMENT');
  assertGone(README, ['这个字段现在只用来显示'], 'README');
  assertGone(DESIGN, ['undecided in `DECISIONS.md`', 'D3 is pending', '`localNumbers` empty, or `numbersVerifiedOn` set', '`crisis.localNumbers` without `numbersVerifiedOn`', 'counted per group, not per sender'], 'design');
  const g11 = DESIGN.split('\n').find((l) => l.startsWith('| `at`, `reply_bot` |'));
  assert.match(g11, /`crisis_route`.*`crisis:true`.*`crisis_refused`/);
  const g4 = DESIGN.split('\n').find((l) => l.startsWith('| 4 | G4 command'));
  assert.match(g4, /Other slash text is plain text.*for the owner too/);
  assert.match(DESIGN, /`no_reply`\)/);
  assert.match(DESIGN, /exit stopped, deadline, owner `\/stop`/);
});

test('the decisions made on 2026-11-06 are recorded as built in simulation only, and their open items are gone', () => {
  const DECISIONS = read('DECISIONS.md');
  const DESIGN = read('docs/group-chat-design.md');
  const CLAUDE = read('CLAUDE.md');
  const section = DECISIONS.slice(DECISIONS.indexOf('## 用户定的（2026-11-06）'), DECISIONS.indexOf('## 第一批修复时选的数值和行为'));
  assert.ok(section.length > 0, 'positive control: the section was found');
  assert.match(section, /只在模拟环境验证过/);
  assert.match(section, /`owner_stop`/);
  assert.match(section, /`usage_missing`/);
  assertGone(DEPLOYMENT, ['正在跑的危险回合被 `/stop` 中止，** 结束为 `failed:aborted`，没有求助句', '`failed:aborted` 可能跟在已发出的段落后面'], 'DEPLOYMENT');
  assertGone(CLAUDE, ['决定了但还没有实现', '这条还没有实现'], 'CLAUDE.md');
  assertGone(DESIGN, ['If that decision says no crisis, the name line gets no reply'], 'design');
  assert.match(DESIGN, /ends `merged` if that turn said something; a turn that said nothing does not absorb it/);
  assert.match(DESIGN, /{ exemptFromCap: true }/);
  const open = DEPLOYMENT.slice(DEPLOYMENT.indexOf('## 进真实群前要修'), DEPLOYMENT.indexOf('## 第一批修复'));
  assert.match(open, /`crisis_refused` 和 `crisis_dropped_on_stop`.*草稿没有改/, 'the notice wording stays open for the user');
  assert.match(README, /这两种告警都明写了 crisis/);
});

test('the political-topic row records all three narrowings the task book names', () => {
  const row = read('DECISIONS.md').split('\n').find((l) => l.startsWith('| 政治话题'));
  for (const section of ['§7.2', '§7.3', '§7.4']) assert.ok(row.includes(section), section);
});

test('the numbers chosen during the fix are recorded as they are in the code, and as unconfirmed', () => {
  const DECISIONS = read('DECISIONS.md');
  const section = DECISIONS.slice(DECISIONS.indexOf('## 第一批修复时选的数值和行为'), DECISIONS.indexOf('## 待定'));
  assert.match(section, /用户还没有确认/);
  const queues = read('src/clo-plugin/lib/core/window.js');
  const extra = Number(queues.match(/urgentExtra = (\d+)/)[1]);
  const perSender = Number(queues.match(/urgentPerSender = (\d+)/)[1]);
  assert.ok(section.split('\n').find((l) => l.includes('`urgentExtra`')).includes(`每群 ${extra} 个`));
  assert.ok(section.split('\n').find((l) => l.includes('`urgentPerSender`')).includes(`每人 ${perSender} 个`));
  assert.equal(DOWN_ALERT_AFTER_MS, 10 * 60000);
  assert.match(section, /`DOWN_ALERT_AFTER_MS`.*10 分钟/);
});

test('fixed gaps have left the open lists, and what still awaits a decision stays there', () => {
  assertGone(DEPLOYMENT, ['危险窗口的名额按群算', '`/stop` 的记录只在内存里', '解除一次暂停，余额探测的 24 小时就重新算', '假的 `crisis_queue_full`。读代码得出'], 'DEPLOYMENT');
  const open = DEPLOYMENT.slice(DEPLOYMENT.indexOf('## 还没解决，要部署者决定'), DEPLOYMENT.indexOf('## 已知的小缺口'));
  for (const item of ['判定失败', '`crisis_route` 不管熔断', '`residual` 没有 owner 放行办法', '余额探测的 24 小时', '要不要插队', '预留和预算还没有按']) assert.ok(open.includes(item), item);
  assert.match(DEPLOYMENT, /\*\*事件日志不轮转：\*\*/);
  assert.match(DEPLOYMENT, /\*\*优雅停机：\*\* 没有/);
});

// The dual-runtime period: the own runtime exists, is not the default, and has no real acceptance. Until the cutover the
// docs must say so, and must not close the privacy gaps that only a real run on it could close.
const OWN_DOC = read('docs/own-runtime.md');
const DESIGN_DOC = read('docs/group-chat-design.md');

test('the own runtime is described as built, not the default, and not accepted on real QQ', () => {
  assert.equal(JSON.parse(read('config.example.json')).runtime, 'openclaw', 'the template still names the default');
  for (const [name, text] of [['README', README], ['DEPLOYMENT', DEPLOYMENT], ['own-runtime', OWN_DOC]]) {
    assert.match(text, /runtime: "own"/, `${name} names the switch`);
    assert.match(text, /默认仍是 `openclaw`|仍是 `openclaw`|默认值 `openclaw`/, `${name} says what the default is`);
  }
  assert.match(README, /现在跑的也是它，上面这些真实记录都是在 OpenClaw 上得到的/);
  assert.match(README, /新运行时在真实 QQ 上的验收一项都没有做/);
  assert.match(DEPLOYMENT, /\| 自己的运行时（own）上的 Q3 到 Q7 \| \*\*未做\*\*/);
  assert.match(DEPLOYMENT, /\| 真实 QQ、真实模型、真实 OpenRouter \| \*\*都没有跑过\*\* \|/);
  assert.match(OWN_DOC, /新运行时在真实 QQ 上的验收一项都没有做/);
  assert.match(OWN_DOC, /现在真正在跑的仍是 OpenClaw 这条路/);
  assert.match(DESIGN_DOC, /that is still the default \(`runtime: 'openclaw'`\) and what runs/);
  assert.match(DESIGN_DOC, /no real QQ acceptance has been done on it/);
  for (const [name, text] of [['README', README], ['DEPLOYMENT', DEPLOYMENT], ['own-runtime', OWN_DOC], ['design', DESIGN_DOC]]) {
    assertGone(text, ['默认是 `own`', '已切换到 own', 'own 运行时已上线', 'own 已验收', 'default is `own`'], name);
  }
});

test('the switch and the rollback are written out, with the steps the console needs', () => {
  const sw = OWN_DOC.slice(OWN_DOC.indexOf('**切到 own：**'), OWN_DOC.indexOf('**回退到 openclaw：**'));
  const back = OWN_DOC.slice(OWN_DOC.indexOf('**回退到 openclaw：**'), OWN_DOC.indexOf('几点要知道'));
  assert.ok(sw.length > 0 && back.length > 0, 'positive control: both blocks were found');
  for (const block of [sw, back]) {
    const order = ['stop.ps1', 'clo.ps1 apply', 'doctor.ps1', 'start.ps1'].map((step) => block.indexOf(step));
    assert.ok(order.every((i) => i >= 0), 'every step is there');
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'stop, then apply, then doctor, then start');
  }
  assert.match(sw, /"runtime": "own"/);
  assert.match(back, /"runtime": "openclaw"/);
  assert.match(OWN_DOC, /切到 own 不会删掉任何旧数据/);
  // The refusal the text promises is the console's.
  assert.match(read('src/cli/lifecycle.mjs'), /不能在它运行时把运行时换成/);
});

test('what the own runtime changes is stated with how far it was checked', () => {
  assert.match(OWN_DOC, /请求里没有 `tools` 字段/);
  assert.match(OWN_DOC, /只在内存上下文里，和群消息同一个有界环（40 条、24 小时、token 上限）/);
  assert.match(OWN_DOC, /重启后丢失，`\/new`、`\/reset` 清空，这个群 120 分钟没有回合也清空/);
  assert.equal(read('src/clo-plugin/lib/core/context.js').match(/OWN_IDLE_MS = (\d+) \* 60000/)[1], '120', 'the idle figure is the code\'s');
  assert.match(OWN_DOC, /\*\*只在离线测试里量过\*\*：Windows，私有 Node，mock QQ，mock 模型/);
  assert.match(DEPLOYMENT, /\*\*自己的运行时（own）：\*\* 同样的离线条件、一次样本/);
  assert.match(OWN_DOC, /这些都只是离线结果，真实运行里还没有确认/);
  assert.match(OWN_DOC, /没有一项在真实 QQ 或真实模型上看过/);
});

test('the clawhub.ai, session-store and deletion gaps stay open during the dual-runtime period', () => {
  // Still stated for the path that runs.
  assert.match(README, /Gateway 每次启动都会尝试连接 `clawhub\.ai`/);
  assert.match(README, /这一版\*\*没有\*\*删除接口，`\/new` 也不会删除旧内容/);
  assert.match(README, /\*\*没有实现按成员删除数据的功能/);
  assert.match(README, /所以上面的会话库和 `clawhub\.ai` 两条照样成立，告知草稿也不改/);
  assert.match(OWN_DOC, /所以 README 和告知草稿里的这几条缺口都\*\*没有关闭\*\*/);
  assert.match(DEPLOYMENT, /\*\*缺口都没有关闭\*\*/);
  const notice = read('persona/group-notice.zh.md');
  assert.match(notice, /clawhub\.ai/, 'the notice draft still names it, until a real run shows otherwise');
  for (const [name, text] of [['README', README], ['DEPLOYMENT', DEPLOYMENT], ['own-runtime', OWN_DOC]]) {
    assertGone(text, ['不再访问 `clawhub.ai`（已确认）', '会话库的缺口已关闭', '已经可以按成员删除', '缺口已关闭'], name);
  }
});

test('every host e2e file has a row in the mapping, and every own e2e file it names exists', () => {
  const host = readdirSync(join(ROOT, 'tests', 'e2e')).filter((f) => f.endsWith('.test.mjs'));
  const own = readdirSync(join(ROOT, 'tests', 'e2e-own')).filter((f) => f.endsWith('.test.mjs'));
  assert.ok(host.length >= 20 && own.length >= 20, 'positive control: both suites were found');
  const table = OWN_DOC.slice(OWN_DOC.indexOf('| `tests/e2e/` | `tests/e2e-own/` |'), OWN_DOC.indexOf('只在宿主上有意义'));
  const rows = table.split('\n').filter((l) => /^\| (`[^`]+`|没有) \| (`[^`]+`|没有) \|/.test(l) && !l.startsWith('| `tests/')).map((l) => l.split('|').map((c) => c.trim().replace(/`/g, '')));
  const left = rows.map((r) => r[1]).filter((c) => c !== '没有');
  const right = rows.map((r) => r[2]).filter((c) => c !== '没有');
  assert.deepEqual([...left].sort(), [...host].sort(), 'each host file once, and nothing else');
  for (const f of right) assert.ok(own.includes(f), `the mapping names tests/e2e-own/${f}, which does not exist`);
  assert.deepEqual([...right].sort(), [...own].sort(), 'every own file is in the mapping');
  for (const r of rows) if (r[2] === '没有') assert.ok(r[3].length > 0, `${r[1]} says why it has no counterpart`);
});

test('the own probe figures are the ones its plan prints, and nothing says it has run', () => {
  const ownPlan = buildPlan(ROOT, { runtime: 'own' });
  const ownWorst = `$${(ownPlan.totalWorstMicros / 1e6).toFixed(4)}`;
  const [t1, t2] = ownPlan.turns;
  assert.notEqual(ownWorst, worst, 'positive control: the two plans differ');
  // The shape the user agreed to on 2026-11-06.
  assert.equal(ownPlan.calls.length, 0);
  assert.equal(ownPlan.turns.length, 2);
  assert.equal(ownPlan.maxModelCalls, 2);
  assert.ok(ownPlan.totalWorstMicros <= 100000, 'within the agreed Q5 cap of about $0.10');
  assert.equal(ownPlan.totalWorstMicros, t1.boundMicros, 'the static worst case is turn 1');
  assert.ok(t2.gated && t2.boundMicros === null, 'turn 2 is bounded at run time');
  const counted = `最坏 ${ownWorst}，最多 ${ownPlan.maxModelCalls} 次模型调用`;
  for (const [name, text] of [['own-runtime', OWN_DOC], ['DEPLOYMENT', DEPLOYMENT], ['README', README]]) {
    assert.ok(text.includes(counted), `${name} has the own worst case and call count`);
  }
  assert.ok(OWN_DOC.includes(`openclaw 版本是 ${worst}、${plan.maxModelCalls} 次`));
  const t1Formula = `(${t1.messageBytes} 字节的消息 + 500) × $${ownPlan.priceCeiling.inputPerM}/M + ${ownPlan.probeMaxTokens} × $${ownPlan.priceCeiling.outputPerM}/M`;
  assert.ok(OWN_DOC.includes(t1Formula), 'own-runtime.md has the turn-1 arithmetic');
  assert.ok(DEPLOYMENT.includes(t1Formula), 'DEPLOYMENT has the turn-1 arithmetic');
  assert.ok(DECISIONS_TEXT().includes(t1Formula), 'DECISIONS has the turn-1 arithmetic');
  assert.ok(DEPLOYMENT.includes(`${ownPlan.turn2BaseUserBytes} 字节加上第 1 回合的回答`), 'the turn-2 message size is the plan\'s');
  assert.ok(DEPLOYMENT.includes('skipped_cap') && OWN_DOC.includes('skipped_cap'));
  // The Key the own probe reads, and the script switch that selects it.
  const ps1 = read('scripts/q5-probe.ps1');
  assert.match(ps1, /\[ValidateSet\('openclaw', 'own'\)\]\s*\[string\]\$Runtime = 'openclaw'/, 'the ps1 can pick the runtime, openclaw by default');
  assert.match(ps1, /'--runtime', \$Runtime/);
  for (const [name, text] of [['own-runtime', OWN_DOC], ['DEPLOYMENT', DEPLOYMENT], ['README', README]]) {
    assert.ok(text.includes('-Runtime own'), `${name} names the switch`);
    assert.ok(text.includes('CLO_TEST_API_KEY'), `${name} names the probe Key`);
  }
  // The gaps that A closed are gone, and the old plan is not presented as the current one.
  for (const [name, text] of [['own-runtime', OWN_DOC], ['DEPLOYMENT', DEPLOYMENT]]) {
    assertGone(text, ['还没有传 `--runtime` 的参数', '还不能选运行时', '不能选运行时', '照这个计划跑不了', '照现在的计划跑不了', '最多 7 次模型调用'], name);
  }
  // It has not run on real OpenRouter, and no doc says otherwise.
  assert.match(OWN_DOC, /\*\*只用 mock 测过，没有在真实 OpenRouter 上跑过。\*\*/);
  assert.match(DEPLOYMENT, /\*\*own 版本（`-Runtime own`）：没有在真实 OpenRouter 上跑过，只用 mock 测过。\*\*/);
  assert.match(README, /还没有在真实 OpenRouter 上跑过/);
  assert.match(DECISIONS_TEXT(), /own 的 Q5 没有在真实 OpenRouter 上跑过/);
  for (const [name, text] of [['own-runtime', OWN_DOC], ['DEPLOYMENT', DEPLOYMENT], ['README', README], ['DECISIONS', DECISIONS_TEXT()], ['cost-options', read('docs/cost-options.md')]]) {
    assertGone(text, ['own 的 Q5 已运行', 'own 的 Q5 已验证', 'own 版本已运行', '在真实 OpenRouter 上跑过一次', '新运行时的 Q5 已'], name);
  }
  // The guarantee is stated with what it rests on, not as unconditional.
  for (const [name, text] of [['own-runtime', OWN_DOC], ['DEPLOYMENT', DEPLOYMENT]]) {
    assert.match(text, new RegExp(`第 1 回合的 \\${ownWorst} 有前提|第 1 回合不超过 \\${ownWorst}，前提是`), `${name} states the turn-1 premise`);
    assert.match(text, /无条件的兜底只有 Key 的日限额/, name);
    // The total rests on turn 2's price and prompt as well as on accurate usage.
    assert.match(text, /用量准确，并且第 2 回合的(?:花费不超过 B2，即)?实际单价不高于上限、输出不超过 1200(?: token)?、输入不超过 B2 估的数/, `${name} states the turn-2 premise`);
    assertGone(text, ['合计不超过 `-MaxUsd`，前提是 OpenRouter 报告的用量准确。', '合计不超过 `-MaxUsd` 的前提是 OpenRouter 报告的用量准确。'], name);
    assertGone(text, ['严格不超过'], name);
  }
  assert.match(DECISIONS_TEXT(), /用量准确，并且第 2 回合的实际单价不高于上限、输出不超过 1200、输入不超过 B2 估的数/, 'DECISIONS states the turn-2 premise');
  assertGone(DECISIONS_TEXT(), ['两回合合计不超过 `--max-usd` 的前提是 OpenRouter 报告的用量准确；'], 'DECISIONS');
});

const DECISIONS_TEXT = () => read('DECISIONS.md');

test('the user decisions of 2026-11-06 on Q5 and cost are recorded, and the unconfirmed probe values apart from them', () => {
  const DECISIONS = DECISIONS_TEXT();
  const user = DECISIONS.slice(DECISIONS.indexOf('## 用户定的（2026-11-06，Q5 和费用）'), DECISIONS.indexOf('## 开发时定的，用户还没有确认（2026-11-06，Q5 探测）'));
  const dev = DECISIONS.slice(DECISIONS.indexOf('## 开发时定的，用户还没有确认（2026-11-06，Q5 探测）'), DECISIONS.indexOf('## 待定（决策点 D）'));
  assert.ok(user.length > 200 && dev.length > 200, 'positive control: both sections were found, in order');
  const ownPlan = buildPlan(ROOT, { runtime: 'own' });
  for (const item of ['第 2 回合按条件发', `\`max_tokens\` | ${ownPlan.probeMaxTokens}`, `$${ownPlan.priceCeiling.inputPerM}`, `$${ownPlan.priceCeiling.outputPerM}`, '`provider.max_price`', '**不加**', 'Fast Mode', 'CLO_TEST_API_KEY', 'docs/cost-options.md']) {
    assert.ok(user.includes(item), `the user section has ${item}`);
  }
  for (const item of ['1.05', '+ 64', '`input_cache_write_1h`', '`completion_above_bound`', '`prompt_above_bound`', '`price_above_bound`', '1024', '用户还没有确认']) {
    assert.ok(dev.includes(item), `the developer section has ${item}`);
  }
  // The probe max_tokens has one owner: the user. The developer section may give the
  // floor reasoning, but must not list the value itself as an open developer choice.
  const maxTokens = ownPlan.probeMaxTokens;
  const userRow = user.split('\n').find((l) => l.startsWith('| 探测的 `max_tokens`'));
  assert.ok(userRow && userRow.includes(`| ${maxTokens}`), 'positive control: the user section owns the probe max_tokens value');
  const devRows = dev.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| 项目'));
  assert.ok(devRows.length >= 4, 'positive control: the developer rows were found');
  for (const row of devRows) {
    const [label, value] = row.split('|').slice(1, 3).map((c) => c.trim());
    assert.ok(!label.includes(String(maxTokens)), `developer row label does not claim ${maxTokens}: ${label}`);
    assert.ok(!/`max_tokens` 取/.test(value), `developer row does not set max_tokens as its own value: ${label}`);
  }
  const floorRow = devRows.find((l) => l.includes('1024'));
  assert.ok(floorRow, 'the floor reasoning stays in the developer section');
  assert.match(floorRow, new RegExp(`${maxTokens} 这个值是用户定的`), 'the floor row says the value is the user\'s');
  assert.match(floorRow, /`models\.js`/, 'the unreconciled models.js floor stays noted');
  const capRow = DECISIONS.split('\n').find((l) => l.startsWith('| 真实验收的花费'));
  assert.match(capRow, /Q5 付费探测上限约 \$0\.10/);
  assert.match(capRow, /用户定的（2026-11-06，Q5 和费用）/, 'the cap row points at the new plan');
});

test('cost-options says plainly that nothing in it is implemented, and keeps Fast Mode and the rejected compression', () => {
  const doc = read('docs/cost-options.md');
  const head = doc.slice(0, 400);
  assert.match(head, /\*\*这里列的办法都没有实现。\*\*/);
  assert.match(head, /这一轮正式运行不做省钱改动/);
  for (const line of doc.split('\n')) {
    if (/已实现|已经实现|已完成|已上线/.test(line)) assert.match(line, /没有|未|不/, `cost-options: ${line.slice(0, 80)}`);
  }
  // Every listed lever carries the fields the plan asked for.
  const levers = doc.slice(doc.indexOf('## 列入的办法'), doc.indexOf('## 排除的办法')).split(/\n### /).slice(1);
  assert.equal(levers.length, 10, 'the ten listed levers');
  for (const lever of levers) {
    for (const field of ['**做法：**', '**要不要你同意：**', '**风险：**', '**文件和测试：**', '**什么时候再决定：**']) assert.ok(lever.includes(field), `${lever.split('\n')[0]}: ${field}`);
    assert.match(lever, /\*\*估计(省|多花)多少：\*\*/, lever.split('\n')[0]);
  }
  const fast = levers.find((l) => l.startsWith('9. Fast Mode'));
  assert.ok(fast, 'Fast Mode is listed');
  for (const item of ['你提的', '$8/$40', '2 倍', '新的价格锁', '预留跟着翻倍', 'Q5 的价格界限要重写', '基础型号不会被路由到 fast 端点']) assert.ok(fast.includes(item), `Fast Mode: ${item}`);
  const rejected = doc.slice(doc.indexOf('## 排除的办法'));
  const compression = rejected.split('\n').find((l) => l.startsWith('| 落盘或跨重启的摘要'));
  assert.ok(compression, 'the rejected compression idea is listed');
  assert.match(compression, /正文不落盘/, 'with its reason');
  assert.match(compression, /没有长期记忆/);
  const rolling = rejected.split('\n').find((l) => l.startsWith('| 只放内存的滚动摘要'));
  assert.match(rolling, /和第 4 项缩小窗口一样多/);
  assert.match(doc, /估计/);
  assert.match(OWN_DOC, /\[cost-options\.md\]\(cost-options\.md\)/, 'own-runtime.md links it');
  assert.match(README, /\| \[docs\/cost-options\.md\]\(docs\/cost-options\.md\) \|/, 'the README docs table lists it');
});

test('the design contract marks its host sections as openclaw only, and records the own deltas as offline', () => {
  assert.match(DESIGN_DOC, /## 8\. Host wiring\n\nApplies to `runtime: 'openclaw'` only/);
  const own = DESIGN_DOC.slice(DESIGN_DOC.indexOf('### From the own runtime'));
  assert.ok(own.length > 100, 'positive control: the section exists');
  assert.match(own, /^Offline only/m);
  assert.match(own, /Nothing here has run on real QQ, with a real model or against real OpenRouter/);
  assert.match(own, /no `tools` field/);
  assert.match(own, /same second as `\/stop` is skipped/);
});

// These cross into files other copies own. They fail until the docs are merged with the code and templates they
// describe, on purpose: the docs must not ship without them.
test('merged tree: every key the README tells you to fill in is in the template and is read', async () => {
  const { parseEnvFile } = await import('../../src/cli/lifecycle.mjs');
  const section = README.slice(README.indexOf('### 2. 填 `.env`'), README.indexOf('### 3. 改 `config.json`'));
  const keys = [...section.matchAll(/^\| `([A-Z0-9_]+)` \|/gm)].map((m) => m[1]);
  assert.ok(keys.length >= 4, 'positive control: the table was found');
  const template = read('.env.example');
  for (const key of keys) assert.match(template, new RegExp(`^${key}=`, 'm'), `.env.example has no ${key}`);
  const r = makeRoot('doc-env');
  try {
    const file = join(r.root, 'docs.env');
    writeFileSync(file, 'CLO_QQ_APP_ID=FAKE\nCLO_QQ_APP_SECRET=FAKE\nCLO_CHAT_API_KEY=FAKE-KEY\n');
    assert.equal(parseEnvFile(file).CLO_CHAT_API_KEY, 'FAKE-KEY', 'the key the README names reaches the parser');
  } finally {
    r.cleanup();
  }
});

test('merged tree: the template has the example Key limit and .private is ignored', () => {
  assert.equal(JSON.parse(read('config.example.json')).budget.keyDailyLimitUsd, 1.6);
  assert.match(read('.gitignore'), /^\.private\/?$/m);
});
