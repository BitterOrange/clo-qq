# 可洛（Clo）：本机运行的 QQ 官方机器人

可洛是跑在你自己电脑上的 QQ 官方机器人，基于 OpenClaw 2026.10.9，模型用 OpenRouter 上的 Claude。她的人设是一位冷静、理性、外表清冷而内心温和的神权贵族千金。这是虚构的角色背景，被认真问到时她会直说自己是 AI。

**现在能做：** 在 QQ 群里回应真实 @、回复她的消息、点名（叫她的名字），以及偶尔插话。点名和插话每个群单独打开，默认关。

**还没有做：** 联网搜索、私聊陪伴、提醒、长期记忆，都没有实现。私聊一律不回。只处理文字，图片和语音不下载、不转写，也不发。

## 现状

**只在一个测试群里运行，还没有进真实的群。** 真实 QQ 上跑过 Q3、Q4 的 dry-run、一轮 Q5 付费探测、Q6 的 live（只回应真实 @），Q7 又在测试群里打开了点名和插话。全局暂停在真实 QQ 上验证过；拒答、内容过滤命中、Key 到限额等情况还没有。真实群验收（Q8、Q9、Q10）没有做。

阶段编号、哪些在真实环境验证过、哪些只在模拟环境验证过，见 [DEPLOYMENT.md](DEPLOYMENT.md)。

**分支：** 这里是 `master`，跑的是 OpenClaw 路线，上面的真实记录都来自它。不依赖 OpenClaw 的原生运行时在 [`native-runtime`](https://github.com/BitterOrange/clo-qq/tree/native-runtime) 分支上开发，只有离线测试，真实 QQ 验收还没做，通过之后才合并回来。

## 你需要准备什么

- **Windows x64 和 PowerShell 7。** `setup.ps1` 用到了 Windows PowerShell 5.1 没有的参数。项目自带私有 Node，不用系统 Node，也不改 PATH。
- **够用的内存。** 离线测试（Windows，mock QQ，mock 模型）里，Gateway 空闲约 750–850 MB，跑过一个回合后约 1.2–1.4 GB，几乎都是 OpenClaw 宿主本身。放到 VPS 上至少要 2 GB，4 GB 更稳妥。Linux 上的数字没有量过，真实 QQ 和真实模型下也没有量过。详见 [DEPLOYMENT.md](DEPLOYMENT.md) 的“内存”。
- **你自己注册的 QQ 机器人。** 到 [q.qq.com](https://q.qq.com) 用单独的 QQ 号创建，这个项目不提供账号。个人认证、模型信息这些由平台要求，如实填写。注册后拿到 AppID 和 AppSecret。IP 白名单留空。换号不保证隔离风险。
- **一个你能管理的小测试群。** 不要先用真实的群。群主要愿意打开下面说的权限。
- **一个 OpenRouter Key，带每日限额。** 给这个项目单独建一个 Key，在 OpenRouter 上设每日限额（`limit_reset` 为 daily）。没有每日限额不能进入 live。

**目前只适用于 OpenRouter。** 代码依赖它的这几样东西：

| 依赖 | 用途 |
|---|---|
| 费用上报（`usage.cost`） | 本地账本按它结算每个回合 |
| Key 接口（`/key`）和账户侧限额 | 读限额和用量，和本地账本对账。硬上限也靠它 |
| 模型目录 | 解析并锁定型号，读价格 |
| 错误形状 | 分辨 Key 到限额、余额不足、其他失败 |

其他 OpenAI 兼容接口未来可能加入，但现在不能用：live 拒绝任何地址覆盖。通用接口没有账户侧限额，也没法对账，只剩本地估算管钱，所以这会是一个独立的功能，不是改个地址的事。模型也只接受目录里 `anthropic/` 开头的具体型号。

## 构建和运行

不需要扫码，也不需要手动登录：机器人用 AppID 和 AppSecret 认证。但只有这两个值还不够，下面的步骤都要做。

### 1. 安装

只需要做一次，可重复执行。要能访问 nodejs.org 和 npm 源。

```powershell
cd <项目目录>
.\scripts\setup.ps1 -Runtime
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
if (-not (Test-Path config.json)) { Copy-Item config.example.json config.json }
```

已有的 `.env` 和 `config.json` 不要覆盖。直接 `Copy-Item` 会清掉里面的真实密钥和配置，而且不会提示。

**项目路径要短。** 路径太长时，`start` 的 doctor 报 `hook_registered：插件 clo 没有加载`，不启动，看不出原因在路径。在测试模式下量过：状态目录的路径 130 个字符能过，140 个字符不行。没有在真实部署上量过，放在 `C:\clo` 这样的短路径最稳。

### 2. 填 `.env`

用编辑器在本机填。**不要把这些值贴到聊天里，也不要写进配置或命令行。**

| 键 | 什么时候要 |
|---|---|
| `CLO_QQ_APP_ID` | 启动就要 |
| `CLO_QQ_APP_SECRET` | 启动就要 |
| `CLO_CHAT_API_KEY` | 只有 live 要。这是 OpenRouter Key，启动时映射成宿主要的 `OPENROUTER_API_KEY` |
| `CLO_SEARCH_API_KEY` | 可选，给还没实现的搜索预留，现在没有代码读它 |

### 3. 改 `config.json`

- `qq.enabled` 改成 `true`。
- `qq.appId` 填和 `CLO_QQ_APP_ID` 相同的 AppID，不一致就拒绝启动。
- `budget.keyDailyLimitUsd` 写成你在 OpenRouter 上设的限额，两边要相同。不同时 `mode live` 报 `key_limit` 拒绝，运行中读 Key 时告警 `key_limit_mismatch`。真正挡住请求的是 OpenRouter 上的限额。

`mode` 保持 `dry-run`，只能用命令切到 live。之后再手改 `config.json`，要运行 `.\scripts\clo.ps1 apply` 才生效。`openclaw.json` 是生成的，不要手改。

### 4. 把机器人加进群，打开权限

在 QQ 里把机器人加进测试群。平台 FAQ（读文档得到，当时读的是 2026-10-21 更新的版本）写的是：个人主体的机器人，创建者可以直接把它加进自己是群主或管理员的群。具体的按钮在哪，我们没有记下来，以 QQ 和 q.qq.com 上看到的为准。

“开发体验用户”是管理端“开发设置”里的一张名单，FAQ 说的是给人私聊用的。可洛不回私聊，所以这一步不用设它：我们在一个测试群里观察到，没有列入这张名单的群友 @ 能到达，也看得到回复。真实的群没有试过。

然后请**群主**打开两个开关（入口在群成员名单点机器人头像，或者群机器人选项里的管理按钮）：

- **获取群内全部消息：** 必须开。关着时只收得到 @，点名、插话和上下文都不工作。
- **主动发言：** 也请打开，这是最初测试步骤的做法。我们在一个测试群里观察到它关着时，被动回复不带 @ 的消息也成功了，而可洛的回复都是被动回复；但这只测过一次，所以不把它当作可以不开。

机器人的 QQ 号只是管理员、由群主事后打开，这条路径在测试群里可行，真实群没有试过。

### 5. 启动 dry-run，采集 ID

dry-run 不调用模型，也不发消息。

```powershell
.\scripts\start.ps1                              # 先跑 doctor，不通过就不启动。窗口隐藏，只绑 loopback
.\scripts\status.ps1                             # 连上 QQ 要等一会儿，看“连接：已连接”和 READY 用户名
.\scripts\clo.ps1 targets arm --minutes 5        # 趁群里安静时做。然后你本人在群里发一条消息
.\scripts\clo.ps1 targets list --reveal          # 输出别贴到聊天里
.\scripts\clo.ps1 group add 测试群 --id <群ID>
.\scripts\clo.ps1 owner add 测试群 --id <成员ID>
.\scripts\clo.ps1 targets clear
```

采集只记 ID，不记正文和昵称，最多 15 分钟，只在 dry-run 下可用。“测试群”是你自己起的标签，真正起作用的是群 ID。**群友都能聊天，只有 owner 能管理。** 群 ID 和成员 ID 是两张表，不要混用。空的群列表表示全部关闭；没有 owner 的群不能 live。

**怎么认出自己的成员 ID：** `targets list` 只列 ID 和次数，没有名字和正文。采集期间别人说话也会多一行，`owner add` 也不核对你填的是谁。所以尽量趁群里安静时采集。出现多行时，你自己再发几条，再运行一次 `targets list --reveal`，选次数涨了的那一行。

选错了，别人就成了 owner，你反而没有管理权限。没有 `owner remove` 命令，要手改 `config.json` 里的 `qq.owner.groupMember`，再运行 `.\scripts\clo.ps1 apply`。这一步在 dry-run 下确认不了：owner 发 `/clo status` 不会回复。进入 live 后在群里发一次 `/clo status`，有回复才说明你是 owner。

**确认你的群能收到哪些消息：** 用只监听的工具，步骤见 [docs/q0a-guide.zh.md](docs/q0a-guide.zh.md) 开头的“从 README 第 5 步过来”。要先 `.\scripts\stop.ps1`，听完再 `.\scripts\start.ps1`：它和 Gateway 用同一个 AppID，不会检查 Gateway 在不在，两条连接同时开在真实 QQ 上会怎样没有测过。`.env` 不要重新复制。

### 6. 告知群友

准入群里的消息，部分会发给 OpenRouter 和模型提供方，连普通消息也可能要过一次判定。请你**亲自**告诉群友，机器人不会自己发声明。草稿在 [persona/group-notice.zh.md](persona/group-notice.zh.md)，发之前按里面的说明改。告知完记录一下：

```powershell
.\scripts\clo.ps1 group notice-done 测试群
```

### 7. 填 Key，锁定模型

把 `CLO_CHAT_API_KEY` 填进 `.env`。**Gateway 的环境在启动时固定**，dry-run 启动之后才填的话，要先停再启，否则 `mode live` 报 `gateway_key`。

```powershell
.\scripts\stop.ps1
.\scripts\start.ps1
.\scripts\clo.ps1 model refresh                  # 读目录，解析并锁定型号。不调用模型
```

仓库里的 `versions.lock.json` 已经带一份锁定。目录上的型号变了时，`refresh` 会要求你加 `--qq-platform-notified`，涨价时要加 `--confirm-price`，见“模型”。

### 8. 确认三件事，进入 live

先等刚重启的 Gateway 连好：运行 `.\scripts\status.ps1`，看到“连接：已连接”再往下走。**只看 READY 用户名不够**，它可能是上一次启动留下的。

没连好时 `mode live` 会拒绝，报 `gateway_key` 或 `heartbeat`。`gateway_key` 的提示说要先停再启，你刚重启过的话**不用照做**，再等一会儿重试就行，反复重启反而可能碰上“排错”里的崩溃保护。在 mock 上试过，从启动到能进 live 用了约 80 秒和约 270 秒，两次机器都很忙，只能参考；真实 QQ 上没有量过。

```powershell
.\scripts\clo.ps1 ack identity                   # 先看 status 的 READY 用户名，确认是你的机器人
.\scripts\clo.ps1 ack q0                         # 你确认已经看过自己的群能收到什么
.\scripts\clo.ps1 ack d3 "<你的决定>"            # QQ 协议 §4.2 的决定，见“内容规则和平台规则”。程序不替你判断
.\scripts\clo.ps1 mode live
```

`mode live` 会逐条检查预算、目标、Key 限额、对账、心跳、运行中的 Gateway 是否拿到了这个 Key、身份、告知、Q0、D3、内容策略、doctor，不满足就列出来并拒绝。D3 没有记录时它一定拒绝，也不会去访问 OpenRouter。日预算低于一次必答预留时报 `daily_hold`。退回：`.\scripts\clo.ps1 mode dry-run`，不用重启。它先切到 dry-run 再改配置，后面出错时会说“已经进入 dry-run”，这时机器人已经不调模型、不发送。

这里和命令输出里的几个编号：**Q0** 是只监听、不回复的实测，看你的群能收到什么（见 [docs/q0a-guide.zh.md](docs/q0a-guide.zh.md)）；**D3** 是 QQ 协议 §4.2（模型资质）的决定；**D5** 是告知和同意的决定，包括每个群是否打开显示名开关。

进入 live 后，先在群里 @ 她一次，看有没有回复，再看 `status` 的花费。点名和插话要单独打开，见下一节。

live 之后手改 `config.json` 再 `clo apply`：新群没告知、或确认项是空的，一律拒绝。要加群，先 `clo mode dry-run`，改好再 `clo mode live`。live 时去掉最后一个群也会被拒绝，要先退回 dry-run。

## 日常使用

下面的 `clo` 都是 `.\scripts\clo.ps1`。不带参数运行它会列出全部命令。

```powershell
.\scripts\start.ps1      # 先跑 doctor，不通过就不启动
.\scripts\status.ps1     # 模式、存活、暂停、今日花费、告警
.\scripts\doctor.ps1     # 检查，不改配置和密钥；会在 .runtime 下写缓存文件
.\scripts\stop.ps1       # 只停本项目记录的进程，核对启动时间和命令行后才动手

.\scripts\clo.ps1 pause --all                    # 全局暂停，固定句也不发
.\scripts\clo.ps1 resume --all
.\scripts\clo.ps1 pause --group 测试群
.\scripts\clo.ps1 resume --group 测试群
.\scripts\clo.ps1 resume --interject             # 解除因平台违规两次造成的插话暂停
.\scripts\clo.ps1 group set 测试群 --interject on --name-mention on
.\scripts\clo.ps1 group set 测试群 --display-names on   # 先告知这个群，见“数据和隐私”
.\scripts\clo.ps1 group list
.\scripts\clo.ps1 budget show
.\scripts\clo.ps1 status --ack                   # 把当前告警标记为已读
```

群里的 owner 也可以发 `/clo pause`、`/clo resume`、`/clo status`，回复只有一句，不含费用和模型。owner 还可以发 `/new`、`/reset`、`/stop`。普通成员发这些没有效果。只有首词像命令名（`/` 后面是字母开头的词）才算命令，其他以 `/` 开头的话（比如 `/usr/bin 是什么`）当普通文字，owner 发的也一样；带危险词的话不算命令。这些只用模拟环境验证过。

`clo resume` 只接受上面这几种写法和不带参数，其他写法什么都不恢复。

**判断是否真的在运行：** 看 `status` 里的“判定存活”：进程在，并且心跳在 90 秒内。不要看 `/readyz`，它受通道状态影响。

### 配置项

| 项目 | 位置 | 默认 |
|---|---|---|
| 模式 | `mode`，只能用 `clo mode` 切到 live | `dry-run` |
| 允许的群 | `clo group add` | 空。空表示全部关闭 |
| 把群友显示名发给主模型 | 每群一个，`clo group set <群> --display-names on\|off`，不用重启 | 关。新加的群也是关。开之前先告知这个群 |
| 管理员 | `clo owner add` | 空。没有 owner 的群不能 live |
| 主模型 | `claudeModel` | `opus-latest`，解析后固定成具体型号 |
| 判定模型 | `decisionModel` | `anthropic/claude-haiku-5.5` |
| 日预算 | `budget` | 本地 $2.5/上海日 |
| 插话 | `interject`，再按群打开 | 每群默认关。开了之后冷却 8 分钟，6 次/时，8 次/天 |
| 免打扰 | `quietHours` | 23:00–08:00，只影响插话 |

### 模型

```powershell
.\scripts\clo.ps1 model show
.\scripts\clo.ps1 model refresh                  # 读目录，解析并锁定
.\scripts\clo.ps1 model check                    # 只检查，不改
.\scripts\clo.ps1 model set-primary <id> --qq-platform-notified
.\scripts\clo.ps1 model set-decision <id> --qq-platform-notified
```

- 只接受目录里存在的 `anthropic/` 具体型号，不接受 `openrouter/auto`、`:suffix` 和 `~` 别名，没有 fallback。
- 新版 Opus 上架不会自动切换，`refresh` 才切换。
- 启用 QQ 时，**任何模型变更**都要加 `--qq-platform-notified`，表示你已向平台报告（§4.2）。
- 价格超过每百万 token 输出 $30，或同一型号涨价，要加 `--confirm-price`。

### 在线条件和重启

- **没有自启动。** 电脑关机、睡眠、断网时，可洛不工作。开机后要自己运行 `start.ps1`。项目不会改电源设置。
- **一个进程。** `clo start` 记下的 PID 就是 Gateway 本身，`clo stop` 只结束它和它的子进程。为此启动时关掉了 Node 编译缓存，启动会慢约 0.5–1 秒。
- **错过的消息不补。** 断线和停机期间的 QQ 消息按丢失处理。两次样本里都没有补发（官方事件页的说法与此不符，文档说的“短时间”有多短未知）。短断线后会自动重连，每小时一次的关闭码 1000 是正常现象。
- **重启后不重答。** 未完成的回合不补答，因为正文不落盘。已处理过的消息不会再答。
- **Gateway 死掉时 QQ 上收不到告警。** 告警只在本机日志和 `status` 里。这一版没有看门狗，也不做主动私聊通知。
- **半开的连接（没有收到关闭帧）** 每 60 秒用一次只读 `GET /gateway` 探测。连续 3 次失败才算可疑，之后探测恢复、而 SDK 还认为连着时，重建连接，每天最多 100 次。这段逻辑在真实连接上跑过，但没有确认那是真的半开连接。
- **断线满 10 分钟** 有一条告警 `connection_down`，只在 `status` 和日志里。只用模拟环境验证过。

## 费用

| 限制 | 值 | 谁管 |
|---|---|---|
| 本地日预算 | $2.5/上海日，约 $75/30 天 | 本机账本，到了就停 |
| Key 日限额 | 由你定，要不高于你能接受的日花费。示例值 $1.60/UTC 日，每天重置，约 $48/30 天 | 你在 OpenRouter 上设，这是最后一道闸 |
| 插话 | 它自己花到 $0.75，或全部花费到 $2.10（配置项 `searchUsd`，名字沿用了还没做的搜索额度），先到先停。`budget show` 只显示 $0.75 | 本机账本 |
| 点名 | 全部花费到 $2.25 停 | 本机账本 |
| @ | 全部花费到 $2.5 停 | 本机账本 |
| 被点名回复和 @ | 每人每小时 10 次，共用一个计数。带危险词的 @ 超过后只买一次判定，判定说危险才回复 | 本机 |

示例值 $1.60 低于本地的 $2.10、$2.25 和 $2.5，这不算错误，只是每天先碰到它。

**花完之后：** 插话静默。点名看走到哪一步：连判定都买不起时静默；判定说要回答、而回复的预留不够时，发一句固定的失败句（按当前价格，全部花费约 $1.94 到 $2.25 之间是这样；判定进行中落下付费暂停时也一样）。真实 @ 收到同一句失败句。这几种情况只用模拟环境验证过。

**失败句每群每个钟点（整点到整点）最多 2 条（`failline_rate`），超过后这条 @ 没有任何回复，也没有告警。** 所以预算花完时，同一小时里第三个 @ 她的人什么也收不到。带危险词的消息因预算或付费暂停没有回复时，另有告警 `crisis_refused`，失败句发没发出去都有。只有一种失败句不受这个上限限制，也不占名额：owner 的 `/stop` 中止了正在跑的危险回合、而这个回合还什么都没发出去时（见下面“排错”里 `/stop` 那一行）。

Key 到限额时付费暂停（`openrouter_key_limit`），读到 Key 有额度时自动解除；本地预算到上海时间零点重置。详细情况见“排错”。

- 回复前按最坏情况预留：按当前锁定价格，一次必答回合 $0.312（按两次调用算），一次插话 $0.156，一次判定 $0.00115（按最大输入 10500 token 算出来的，没有跑过；真实测到的一次约 $0.00017）。所以额度比实际花费更早用完。
- **这个预留不是回合费用的上限。** 在 mock 上，调用失败时宿主一个回合最多发过 10 次请求，上下文过长时还会多发压缩请求，压缩的费用不进本机账本。正式运行没有回合内的请求上限。真正的硬上限是 Key 的每日限额。
- 本地数字是估算，真实费用以 OpenRouter 账单为准。对账差额过大或读不到 Key 时，付费自动暂停。
- 实际花费的小样本：测试群 18 次 @ 回复共 $0.2382，平均 $0.0132。没命中缓存的约 $0.03–$0.04，命中的约 $0.005–$0.012。改人设后下一条总是没命中缓存。会话越长越贵，每个会话最多只测到 8 轮，也没有遇到压缩。插话冷却 8 分钟比缓存的 5 分钟长，所以插话通常没有缓存，一次约 $0.04。这些样本很少，不能当预算依据。

另有一个可选的付费探测工具，用来量真实的 token、费用和对账延迟：最坏 $1.5470，最多 9 次模型调用。用法和约束见 [DEPLOYMENT.md](DEPLOYMENT.md) 的“付费探测工具”。

## 数据和隐私

**发给第三方的：** 准入群里的消息，部分会发给 OpenRouter 和模型提供方。判定用 Haiku，回答用 Opus，服务方不一定是 Anthropic 本身。普通消息也可能要过一次判定，并带上近期发言；回答时带上近期群消息；回答过的内容之后还会再发给模型。发言人用代号，开了显示名开关的群，回答请求还带显示名。Gateway 每次启动都会尝试连接 `clawhub.ai`（OpenClaw 的插件目录），没有找到开关。

**告知群友：** 草稿在 [persona/group-notice.zh.md](persona/group-notice.zh.md)，机器人不会发。

**留在本机的：**

| 层 | 内容 | 保留 |
|---|---|---|
| `.runtime/clo/clo.db` | 事件、发送、预算记录。ID 是 HMAC，不存正文和显示名。危险路线能从这里推断出来，见下面“危险路线留下什么” | 事件和发送 14 天，预算 90 天，计数到期就清。告警确认后 14 天清，没确认的一直留着 |
| ID 采集表 | 原始群 ID 和成员 ID，无正文 | `targets clear` 或进入 live 时清空 |
| 内存上下文 | 近期群消息，用化名。开了显示名开关的群，每行还带清洗后的显示名，随这一行过期和清除，也随 `/new`、`/reset` 清除；开关关掉后，这个群下一条任何消息（命令、过期、暂停时的消息也算）或每小时的清理时丢掉；群从名单移除后也一样。关了又马上打开，中间这个群没有任何消息，也没赶上每小时的清理，旧名字还会留着，直到这些行过期。一个成员的所有行共用最新的名字：最新的名字被拒绝时，他之前的行也退回代号 | 最多 40 条或 24 小时，重启即丢 |
| `.runtime/logs/events.jsonl` | 事件 ID、判定、耗时、费用、错误分类，无正文和显示名。显示名被拒绝或缺失时只记 `display_name` 和一个不分类的原因，不记值。引用回复只记匹配结果、散列、长度和格式前缀，不记原值 | 不自动清理 |
| `.runtime/logs/gateway.log` | 宿主直接写到控制台的内容。宿主日志级别是 `silent`，已知会带模型服务方文字的行由 `src/cli/host-output-filter.mjs` 整条拦下，只留一行说明。这是按已知行写的名单，不保证没有别的路径 | 超过 20 MB 时启动轮换一次，只留一份旧的 |
| `.runtime/temp/openclaw/*.log` | 宿主文件日志。`silent` 时不写 | 由宿主管理 |
| OpenClaw 会话库（`.runtime/state/agents/main/agent/openclaw-agent.sqlite`） | **被派发的回合正文在这里，模型的思考文字、每回合的提示词副本和全文搜索索引也在这里，模型服务方的错误原文也在这里，包括审核返回的 `flagged_input`** | 由宿主管理，这一版**没有**删除接口，`/new` 也不会删除旧内容（Q6 核对过） |
| OpenRouter、模型提供方 | 收到的消息。开了显示名开关的群，主模型（Opus）的回答请求还带当前发言人和近期发言人的显示名；判定模型（Haiku）只收代号 | 以它们的政策为准，本项目控制不了 |

**没有实现按成员删除数据的功能（随记忆一起推迟）。** 规则 5.10 的删除请求现在无法完整满足，这是已知缺口。

**显示名开关（默认关）：** 来源只有当前消息的 `author.username`。在真实 QQ 上用一个账号测过：它跟着 **QQ 昵称**变，改群名片后再问仍是旧名字，所以群名片目前用不上；昵称改后多久生效没有测准，其他账号和字段缺失的情况**没有观察过**。它不参与身份、准入、owner 判断、去重、计数和记忆键，这些都用稳定 ID。清洗规则和拒绝条件见 `src/clo-plugin/lib/core/displayName.js`，被拒绝或没有时就只用代号。格式字符会被去掉；拒绝名单只是减速带，短的指令文字（比如“忘掉以上规则”）仍然可能进到提示词，只靠提示词里的规则挡。真实模型只查过一次（被直接问到显示名时）：她没有照做，只把它当名字，但也没有确认这是对方现在的名字。一次不代表每次，换别的说法**没有观察过**。名字加上回复里相邻的文字仍可能碰到内容规则，这时整条回复会换成固定句子；规则的半截已经拒绝，但做不到完全堵住。有些普通名字也会退回代号（比如带“管理”“通知”“官方”，带点的 `Mr.Li`，连续 5 位以上数字）。

**显示名会不会存下来：** 不进 `clo.db`、`events.jsonl` 和告警（mock 上扫过原始字节）。标签只放在宿主每回合的运行上下文里，mock 上宿主没有把它写进会话库，所以 `sender.name` 和回合正文都还是代号。**但这不等于会话库里没有显示名：可洛回复里写到的显示名一定跟着回复存进去（mock 上看到），思考文字里写到的按同样方式存（推断，mock 不产生思考文字）；模型服务方报错时如果把提示词的一部分回传（如 `flagged_input`），里面的显示名也会存进去（mock 上看到，真实 OpenRouter 会不会回传这一段没有观察过）。** 真实模型下的情况没有看过。这些记录这一版同样删不掉。

**危险路线留下什么：** 事件行不写“危险”，分类还是 `ordinary` 或 `name`；每人的上限只在内存里，重启就没了，也不记是谁。但走过这条路线能推断出来：`clo.db` 里有计数 `crisis_group:<群>:<日>`（判定熔断时还有 `decision_bypass:<群>:<日>`），`ordinary` 或 `name` 事件上有 tier 为 `addressed` 的预留行，`events.jsonl` 的 `turn_end` 带 `tier`。消息命中词表就可能留下这些，哪怕判定说不是危险、她也没有回复。告警 `crisis_queue_full`、`crisis_refused`、`crisis_dropped_on_stop` 是例外，它们明写了 crisis，带事件和群的散列。账目需要这些记录，所以选择改告知、不改代码，见 [DECISIONS.md](DECISIONS.md)。

## 内容规则和平台规则

这一节不是法律意见。

- **提示词和本地规则都不是合规保证。** 平台判定才是最终结果。实测通过不代表安全，也可能被处罚。
- **QQ 协议 §4.2 没有解决，由部署者负责。** 协议要求开发者保证模型具备合法资质并向平台报备。项目本身没有核实，也不对外声称模型已备案，程序也不替你判断。你部署时要自己做这个决定，用 `clo ack d3` 记录到 `config.json`。这只是记录，不代表问题已经解决。向平台提供模型信息和报告变更，也由你负责。
- **内容规则命中时：** 被 @ 的人收到固定句，插话静默。不改写、不重试、不换路径。平台返回 40034006 时什么也不发。这些都只减少发出的内容，没有任何功能帮助规避检测。
- **本地规则是一张短表，不含政治词。** 政治话题只靠模型判断，不保证抓全。
- **模型的回答可能出错，也可能不符合人设。** 人设只在测试群里看过少量回复，内容范围在真实消息上还没有触发过。
- **群内可能有未成年人的问题没有解决，** 这一版没有年龄控制。投诉渠道、数据删除等条款也没有实现，见 [DEPLOYMENT.md](DEPLOYMENT.md)。

## 架构

```text
QQ 开放平台
   ↕  官方 SDK @tencent-connect/qqbot-nodejs（WebSocket，AppID + AppSecret）
clo-qq 通道    src/clo-plugin/lib/channels/qq
   ↓
入站闸门       src/clo-plugin/lib/core/gate.js
               准入、去重、暂停、预算、触发分类；点名和插话先过一次判定模型
   ↓
OpenClaw Gateway 回合（只绑 loopback）→ OpenRouter → Claude
   ↓
唯一出口       src/clo-plugin/lib/channels/qq/exit.js
               目标校验、内容规则、限额，然后才发到 QQ
```

控制台在 `src/cli/`，运行状态都在项目的 `.runtime/` 里，不碰默认的 OpenClaw 目录。设计细节见 [docs/group-chat-design.md](docs/group-chat-design.md)。

**为什么用 WebSocket，不用 Webhook。** 机器人主动连出去，只需要出站网络，不用开入站端口、域名和 HTTPS，放到远程服务器上也一样。Webhook 的好处主要是 Serverless 和多副本，而这里每个 AppID 只能有一个实例，用不上。换成 Webhook 还会失去 4914、4915 这类停止信号、连接健康判断和 READY 带来的身份确认，这些都要重新设计；SDK 自带的 Webhook 接收层也要先过安全审查才能对公网开放。原因和没确认的部分见 `DECISIONS.md`。

**未来可能加入微信机器人实现，架构上作预留。** 通道和核心是分层的，但核心里还有 QQ 专用的部分（`qq.*` 配置、写着 QQ 群的判定提示词、`--qq-platform-notified`），要接别的通道得先整理这些。现在没有其他通道的代码。

## 限制

- 只处理文字。图片和语音记成 `[图片]`、`[语音]` 这样的占位符，不下载、不转写。
- 群回复里的网址，只保留对方消息里出现过的，其他的替换成 `[链接已移除]`。因为只测过 `example.com`，其他域名可能被平台拒绝。识别靠规则：带协议的、`www.` 开头的、常见后缀的裸域名、带路径的域名、Markdown 链接目标都算；`evil[.]com` 这样拆开写的和中文域名不算。
- 回复里的 `<@all>`、`<@…>`、`<qqbot-at-…>` 标记会被去掉，不会发到群里。
- 一条回复最多 4 段（约 6000 字），因为每群每分钟只发 4 条。超出部分丢弃。这一分钟发满时，必答回复在被动窗口内等空位；等不到就发一次失败句（也受每群每个钟点 2 条的限制）。插话不等，直接丢弃。
- 判定时当前消息最多 800 字。超长时留头尾，名字或词表里的词落在中间时再留一段，其余省略，判定模型看不到被省略的部分。
- 同一个 4 秒窗口里多人点名：每人最后一条各判一次，最多 3 人，超过时留最新的，其他的合并，不再单独回答。只用模拟环境验证过。每群每分钟只发 4 条，所以同一窗口的最后几条回复可能等不到发送空位。
- 回答一条消息时，模型看不到别的消息里还在等自己回合的真实 @、回复可洛和点名，也看不到已经合并进这类消息的话，这些消息结束后才算上下文。普通聊天和这个人自己更早说的话仍然看得到。所以带名字说的“算了”拦不住前一条的回答，不带名字的模型才看得到；同一个人的后一条抢在前一条之前回答时，前一条可能被回答两次。只用模拟环境验证过。

## 测试

全部离线：mock QQ、mock OpenRouter、临时目录、假密钥。不读 `.env`。子进程都用明确的环境变量启动，不继承 shell 里的 Key。

```powershell
.\.runtime\node\node.exe --test --test-concurrency=1 tests/unit/*.test.mjs
.\.runtime\node\node.exe --test --test-concurrency=1 tests/seam/*.test.mjs
.\.runtime\node\node.exe --test --test-concurrency=1 tests/e2e/*.test.mjs   # 真实 Gateway，一个文件一个文件跑
```

单元和接缝要几分钟，机器忙时更久，没有可靠的时长记录。e2e 串行有记录的一次约 88 分钟。这些测试证明的是接线，不是平台行为。最近的结果和没跑的部分见 [DEPLOYMENT.md](DEPLOYMENT.md)。

## 排错

下表里 `openrouter_key_limit`、`openrouter_credits`、`residual`、判定熔断、`/stop`、失败句上限这几行只用模拟环境验证过，真实 QQ 和真实模型没有测。

| 现象 | 处理 |
|---|---|
| `status` 显示付费暂停 `crash_unsettled` 或 `usage_missing` | 有回合费用不明（Gateway 被杀，或回复发出了却没有用量数字；被中止的回合只要已经发出一段、又没有用量数字，也算这种）。Key 上有差额就按差额结清；Key 上 15 分钟、至少 3 次读取都没有差额，就按 0 结清（来源 `key_delta_none`）。之后如果又出现这笔费用，会记成差额。不想等可以用 `clo budget accept-unsettled` 按预留额结清 |
| 付费暂停 `key_read_failed` | 读不到 Key。读到干净结果后自动恢复 |
| 付费暂停 `residual` | Key 上有本地记录解释不了的花费。先核对 OpenRouter 账单。这笔差额按上海日累计，之后的读数和充值都不会让它减少，所以通常要到上海时间零点后的第一次 Key 读取才解除。没有命令能提前解除，在那之前付费工作一直停着 |
| 付费暂停 `usage_unavailable` | 宿主的用量事件不可用，不会自动恢复。排查后用 `clo budget clear-pause` 解除，并重启 Gateway |
| 付费暂停 `openrouter_key_limit` | Key 的每日限额用完了：OpenRouter 的错误这样说，或者读 Key 时剩余额度为 0。读到 Key 有额度时自动解除；还有未结算记录的话，先转成 `usage_missing`。真实的报错形状没有观察过 |
| 付费暂停 `openrouter_credits` | OpenRouter 账户没钱了：错误这样说，或者 402 没有说明来源。读 Key 看不出余额，所以暂停满 1 小时后，下一次干净的读取才解除（连接时每 10 分钟读一次）。钱还是不够的话，一次判定的 402 或主模型连续 3 次失败就会再暂停。充值后可以用 `clo budget clear-pause` 马上解除；这时如果还有未结算记录或已知差额，付费仍然停着，命令会直说原因和办法 |
| `status` 的暂停行写着“判定 熔断中” | 判定模型连续 3 次超时或出错。只停判定：点名和插话静默（`skipped:decision_paused`），真实 @ 和回复可洛照常，付费不暂停。10 分钟后放行一次试探，成功就恢复，失败再等 10 分钟。带危险词的消息熔断时也能过，有自己的名额。没有手动解除的命令。告警 `decision_paused` 只有一次 |
| 关闭码 4914 或 4915 | 平台关闭了连接，已停止，不重连。**处理完平台那边的事再** `clo ack terminal` 然后 `clo start` |
| 预算花完或付费暂停时，有人 @ 了却完全没回复 | 失败句每群每个钟点最多 2 条（`failline_rate`），超过后静默，不算故障，也没有告警。下一个钟点又有名额。带危险词的消息例外，有告警 `crisis_refused` |
| 发送结果不确定（`uncertain`） | 绝不重发。去群里看有没有发出去 |
| `stop` 说查不到进程状态 | PowerShell 或 WMI 这次没答上来，进程可能还在跑。没有动它，PID 文件保留。稍后再 `clo stop` |
| `stop` 说读不到它的命令行 | 它很可能是用更高权限启动的，还在运行。没有动它，PID 文件保留。从启动它的 shell 里运行 |
| `stop` 说 `clo start` 可能还在运行 | 启动锁被占着，没有动任何进程。等 `start` 结束再 `clo stop` |
| `mode live` 报 `key_limit` | `budget.keyDailyLimitUsd` 和 OpenRouter 上的限额不同。改成相同的再试 |
| `status` 有告警 `crisis_refused` 或 `crisis_dropped_on_stop` | 一条带危险词、或被判定为危险的消息没有得到完整回复：名额用完、判定失败、预算不够或付费暂停，或者正在跑的回合被 `/stop`、看门狗、暂停、被动窗口到期、出口拒绝打断（原因写在告警里，`/stop` 的是 `owner_stop`）；`crisis_dropped_on_stop` 是停机时还在排队或正在跑。这两种告警都明写了 crisis，看 `status`、日志或 `clo.db` 的人能知道这个群里有一条消息走过危险路线。这些只用模拟环境验证过 |
| 某群被自动暂停 | 平台返回了群错误码。确认后 `clo resume --group <群>` |
| 插话被自动暂停 | 一天两次内容违规。确认后 `clo resume --interject` |
| 进程被杀或重启后 | 未完成的回合不补答，因为正文不落盘。已处理过的消息不会再答 |
| `doctor` 报 `render_fresh` | 有人手改了生成的文件。运行 `clo apply` |
| `doctor` 报 `hook_registered：插件 clo 没有加载` | 可能是项目路径太长，见“安装”。把项目挪到短路径再试 |
| 记录的 PID 被别的进程占用 | `stop` 不会动它，只删过期的 PID 文件 |
| 进程活着、`status` 显示没连上，刚连续重启过 | 5 分钟内 3 次非正常退出（`clo stop` 也算）会让宿主暂停通道自动启动。等 5 分钟让它自动恢复，这期间不要再重启。mock 上试过一次：第 4 次启动后通道没起来，不做任何操作，从那次启动算起约 5 分钟后自己连上了；真实 QQ 上没有试过。这一行不会写进日志，见“数据和隐私” |
| 模型拒答、`/stop`、回合超时 | 只影响这一个回合：预留额先记着，用第一行的办法结清，不停别人的回合。例外是中止前已经发出一段、又没有用量数字的回合，按第一行暂停付费。**连续 3 次**主模型调用失败才付费暂停（`provider_fail`），读到干净的 Key 后恢复。这个暂停解除时计数清零，中途被别的原因改写过也一样；还没到 3 次的计数不清。判定模型单独计数，不影响付费。真实的 403 没有遇到过，所以地区错误的真实形状仍然不知道：探测工具只把结构化标记算确认，文字里出现 region 这类词只记成疑似（`region_suspected`） |
| owner 发了 `/stop` | 正在跑的回合停止，普通回合之后不再发失败句。正在跑的是危险回合时：还什么都没发出去，就发一次失败句（这一句不受每钟点 2 条的上限，也不占名额，但暂停时不发，发送满了时在被动窗口内等一次空位），并告警 `crisis_refused`（`owner_stop`，`state` 写着失败句发没发出去）；已经发出一段的，不发失败句，照样告警。被中止的回合已经发出一段又没有用量数字时，按 `usage_missing` 暂停付费。排在 `/stop` 之前、还没开始的真实 @、回复可洛、点名和插话都结束，**不回复，也不花钱**（`skipped:owner_stop`）。带危险词的消息不算在内，仍然继续，宿主拒绝后收到失败句，失败句里有求助信息；但插话路线除非判定说是危险，否则也停。`/stop` 之后发的消息照常回答，只有和 `/stop` 同一秒的 @ 或点名例外：宿主按时间戳拒绝，收到失败句。这个例外只用仿照宿主的假宿主跑过一次 @，还留下一个 `model_failed` 告警和一行未结算；真实 QQ 上的时间戳没有查。普通成员发 `/stop` 没有效果 |

## 其他文档

| 文档 | 内容 |
|---|---|
| [DEPLOYMENT.md](DEPLOYMENT.md) | 现状、在哪里验证过、未解决事项、已知限制、付费探测工具 |
| [DECISIONS.md](DECISIONS.md) | 决定和理由，平台实测得到的事实 |
| [docs/group-chat-design.md](docs/group-chat-design.md) | 群聊部分的设计（英文） |
| [docs/q0a-guide.zh.md](docs/q0a-guide.zh.md) | 只监听、不回复的实测指引 |
| [docs/wiring-trial.md](docs/wiring-trial.md) | 第一次离线接线试验的报告 |
| [persona/](persona/) | 人设、内容范围、判定提示词、告知草稿 |

**许可证：** [AGPL-3.0-only](LICENSE)，`persona/` 里的人设文字也一样。如果你改了代码，又让别人通过网络和改过的版本互动，比如拉进群里给群友用，第 13 条要求你的版本显著地向这些人提供获取对应源码的途径。程序不会替你做这件事，条文也没有细说聊天机器人怎样才算“显著”，这要你自己判断。不改代码只是运行，这一条不适用。这段是说明，不是法律意见。
