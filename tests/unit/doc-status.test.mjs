// README and DEPLOYMENT are what the user reads before agreeing to anything, so their claims about status and spend
// are checked here. These pin wording that was found false, and figures that come from the code.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { PROBE_FAILS_TO_SUSPECT } from '../../src/clo-plugin/lib/channels/qq/connection.js';
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
  for (const m of DEPLOYMENT.matchAll(/-MaxUsd (\d+\.\d+)/g)) assert.ok(Number(m[1]) * 1e6 >= plan.totalWorstMicros, `the example ${m[0]} would be refused`);
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
const PUBLIC_DOCS = ['README.md', 'DEPLOYMENT.md', 'DECISIONS.md', 'docs/group-chat-design.md', 'docs/q0a-guide.zh.md', 'docs/wiring-trial.md'];

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
