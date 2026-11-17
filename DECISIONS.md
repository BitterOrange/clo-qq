# 决策记录

本文记录决定和理由，以及平台实测得到的事实。文中的“已批准的计划”是项目开始时批准的计划，它和调研记录都不在这个仓库里。需要用到的规则，本文和 `docs/group-chat-design.md` 已经写明。

“用户”指这个项目的作者和部署者。你自己部署时，涉及协议和告知的决定要自己做。

`CLAUDE.md` 是当前的任务书，已从最初的微信任务书改写为 QQ 版。事实描述不一致时，以代码和本文为准。

## 已定（2026-11-02，用户确认）

| 项目 | 决定 |
|---|---|
| 平台 | 只做 QQ 官方机器人，不打补丁、不扫码 |
| 目标群 | QQ 群，群主要愿意打开权限。创建者是管理员的路径未证实，Q0a 先测 |
| 机器人账号 | 单独的 QQ 号。换号不保证隔离风险 |
| 使用者所在地 | 部署者负责确认本人、本机和群友都在模型服务方支持的地区内。项目不核验 |
| 主模型 | Opus Latest，由选择器 `opus-latest` 解析并固定，可用配置文件和命令修改 |
| 判定模型 | `anthropic/claude-haiku-5.5`，`effort:none`，可修改 |
| 预算 | 本地 $2.5/天（上海日）。Key 限额见下面“用户定的” |
| 媒体 | 首版只处理文字 |
| 政治话题 | 按内容范围第 1 条，群聊私聊相同；接受 §7.2“能直说不同意见”、§7.3“清楚作答”、§7.4“不隐瞒信息”在这些话题上收窄 |
| 本地词表 | 自有短表，不含政治词；政治内容只靠模型判断，不保证抓全 |
| 不做的事 | 不用代理、不做规避、不改写内容绕过审核、不用 NapCat 等非官方协议 |

## 已定（2026-11-03，用户确认）

| 项目 | 决定 |
|---|---|
| D3 协议 §4.2 | 由每个部署者自己决定，用 `clo ack d3` 记录。程序不替你判断。项目没有核实模型的资质或备案情况，所以项目文档和可洛都不对外声称“已备案”“已具备资质”。向平台提供模型信息和报告变更，也由部署者负责 |
| 内容管控 | 尽可能屏蔽不适宜内容。沿用已批准的内容策略，平台判定仍是最终结果 |
| 平台未确认的条文 | §6.3、过滤机制是否足够、40034006 的范围，含义都没有得到平台确认，按未知处理 |
| `clawhub.ai` | 接受 Gateway 启动时尝试连接它，并写进告知内容。离线测试里只看到 DNS 查询，真实连接发送什么尚未观察 |
| 模型拒答（F13） | 保留：单次拒答、`/stop`、超时不暂停付费，连续失败才暂停。这比最初任务书的“结算不明时暂停”宽松，是确认过的取舍。这里的连续失败现在只指主模型，判定模型见下面的“判定熔断”。中止前已经发出一段、又没有用量数字的回合例外，要暂停，见“用户定的（2026-11-06）” |
| 断线消息 | 按断线期间的消息丢失、无法取回处理。依据：两次样本、没有读取历史的公开接口。官方文档写 Resume 会补发，这一矛盾没有得到平台确认 |

## 修复时定的行为（2026-11-05，开发时定的，用户还没有逐条确认）

除非另有说明，都只用模拟环境验证过，真实 QQ 和真实模型没有测。细节和没解决的部分见 `DEPLOYMENT.md` 的“进真实群前要修”。

| 项目 | 现在的行为 |
|---|---|
| 判定熔断 | 判定模型连续 3 次超时或出错，只停判定，不暂停付费。熔断期间点名和插话都静默（`skipped:decision_paused`），**真实 @ 和回复可洛照常**。10 分钟后放行一次试探，成功就恢复。带危险词的消息也能过，名额单独算，用完就静默。限额错误不算熔断，仍然暂停全部付费 |
| 同一窗口多人点名 | 4 秒窗口里**最多判 3 条**：每人最后一条，超过 3 人时留最新的。其他消息合并，不单独回答。之前只判最后一条，别人的问题可能丢 |
| 回合里看不到什么 | 看不到别的消息里还在等自己回合的真实 @、回复可洛和点名，以及已合并进这类消息的话，结束后才算上下文。普通聊天和这个人自己更早说的话看得到：宁可前一条可能被答两次，也不让回复危险消息或“上面那个怎么修”时看不到前面的话。所以带名字的“算了”拦不住前一条的回答 |
| 余额用完（`openrouter_credits`） | 读 Key 看不出余额，所以**满 1 小时才重试**，也可以充值后用 `clo budget clear-pause`。失败的重试花不花钱没有观察过。之前读到干净的 Key 就解除，没钱时会反复恢复 |
| 余额探测 24 小时 | 余额暂停解除后 24 小时内，主模型连续失败仍按没钱算。24 小时是开发时选的值，不是规格，可以改 |
| 危险信号和告知 | 改告知，不改代码。路线留下的痕迹账目要用（`crisis_group` 计数、`ordinary` 或 `name` 事件上的 `addressed` 预留行、`turn_end` 的 `tier`），不留就算不准账。新草稿在 `persona/group-notice.zh.md` |
| 危险上限用完之后 | `crisis=true` 不再单独决定回复。超过上限后按模型答的 `skip_class` 和 `action` 走，被标记的话题不回复。判定提示词这一行因此和已批准计划的原文不同 |
| `/stop` 之前排队的消息 | owner 发 `/stop` 后，排在它之前、还没开始的消息**不回复，连真实 @ 也一样**（`skipped:owner_stop`），不花钱。带危险词的除外。之后发的照常回答。依据：宿主本来就会拒绝这些回合，放行只会多发一条失败句。和 `CLAUDE.md` §5.2 “被问时尽量回答，硬限制优先”不冲突 |
| `qq.enabled` 关掉 | 排队的工作和出口都按群被移除处理，正在跑的回合的回复也发不出去 |

## 用户定的（2026-11-05，文件级审查之后）

用户确认（2026-11-05）：下面几条决定记下时还没有实现。2026-11-06 的第一批修复实现了这四条。**它们都只在模拟环境验证过**（假对象，或真实 Gateway 加 mock QQ 和 mock 模型），真实 QQ 和真实模型没有测。

| 项目 | 决定 | 现状 |
|---|---|---|
| 危险消息的 @ 超过每人每小时上限 | 走危险路线，只买一次判定，模型判定确实危险才回复。不直接回复，否则玩笑话也会占名额。要同步改设计里 G11 那一行 | 已实现，设计已改。没有危险路线的名额时不买判定，记 `skipped:sender_rate` 并告警 `crisis_refused` |
| 不是命令的斜杠文本 | 只有首词长得像命令名才算命令，其他当普通文字，owner 发的也一样。和已批准计划里“未授权斜杠文本绝不传下去”不同。动手前要先测宿主怎么解析这种文本 | 已实现，动手前测过宿主（真实 Gateway，mock QQ，mock 模型），结果在设计第 5.4 节。owner 发的只测了一部分 |
| `keyDailyLimitUsd` | 示例配置用 $1.60，由部署者按自己在 OpenRouter 上设的限额改。实际限额和配置不符时，`clo mode live` 拒绝，读 Key 时告警。这个限额低于本地预算 $2.5 不算错误，只是每天实际花费先碰到它。限额按每天重置处理 | 已实现：`clo mode live` 报 `key_limit`，读 Key 时告警 `key_limit_mismatch`，都按微美元精确比较。告警不暂停付费 |
| `localNumbers` | 拒绝非空值，因为接进危险回复会改变对危险中的人说的话。要同步改计划和设计里的写法 | 已实现，设计已改。配置校验和进 live 的检查都拒绝。`numbersVerifiedOn` 还留在模板里，没有代码读它 |

## 用户定的（2026-11-06）

用户确认（2026-11-06）：下面两条按开发时的建议做。都已实现，**只在模拟环境验证过**（假对象，或真实 Gateway 加 mock QQ 和 mock 模型），真实 QQ 和真实模型没有测。上面 2026-11-05 的决定仍然有效：超过上限的危险消息不经模型判定就不直接回复；固定句不改，也不加新的。

| 项目 | 决定 | 现状 |
|---|---|---|
| `/stop` 中止正在跑的危险回合 | 这个回合还什么都没发出去时，发一次固定的失败句（`modelFailed`），并告警。只有这一种情况不受失败句每群每钟点的上限限制，也不占名额，其他情况都不例外。已经发出一段时不发失败句，照样告警。排队的危险消息本来就是这样，这条让正在跑的回合一致。普通回合 `/stop` 后照旧静默 | 已实现。告警 `crisis_refused`，原因 `owner_stop`，带 `state`：`line_sent` 是失败句发出去了，`line_refused` 是没发出去。失败句仍受暂停、被动窗口和发送速率约束：每群每分钟的发送满了时，在被动窗口内等一次空位再发，还是不行就不发，告警照样有 |
| 回合以 `aborted` 结束，至少一段真的发出去了，却没有用量数字 | 按 `CLAUDE.md` §8.2“回复发出却没有用量数字”处理，按 `usage_missing` 暂停付费，按现有规则解除，不为解除另写代码。什么都没发出去的中止回合照旧：单独一次 `/stop` 不暂停 | 已实现 |

## 第一批修复时选的数值和行为（2026-11-06，开发时定的，用户还没有确认）

都只在模拟环境验证过。数值可以改。

| 项目 | 现在的值或行为 | 说明 |
|---|---|---|
| 危险 @ 的额外位置（`window.js` 的 `urgentExtra`） | 每群 3 个 | 队列满时带危险词的真实 @ 还能进。不插队 |
| 每人的危险名额（`urgentPerSender`） | 每人 2 个 | 超过后这个人的危险行按普通聊天排队，不再占紧急位置，也不让窗口提前 |
| 普通消息的判定上限 | 每群每小时和每天上限的 5/6，向上取整（60 变 50，300 变 250） | 给点名留位置。点名用全部，危险路线计入总数但不受这两个上限限制 |
| 断线告警（`DOWN_ALERT_AFTER_MS`） | 10 分钟，`connection_down` | 计划没有给数字。启动时心跳间隔超过 5 分钟就重新计时，这样 Gateway 关着的时间不算断线 |
| 上下文单行上限 | `max(contextMaxTokens 的一半, 256)` token | 超过就截短并标出，只影响 `history()` 给模型的文字 |
| 回合中止的宽限 | 5 秒 | 到期后中止回合，再等 5 秒看它有没有结束 |
| 可选回合的最短剩余时间 | 15 秒 | 插话离期限不到 15 秒就不开始 |
| 等发送空位时查 `/stop` | 每 250 毫秒 | |
| `retention.reservationDays` | 必须大于 30 | 对账基线和预算记录要活得比 30 天的重置长 |
| 带危险词的文字 | 永远不算命令，即使前面有像命令的词 | 只按斜杠规则的话，这种话会被静默丢掉。宿主对 `/think high …` 仍不调模型，这个人收到失败句，并有 `model_failed` 告警 |
| `crisis_refused` 的范围 | 除了被拒绝，判定失败、模型说危险但名额已用完、折叠的点名行因内容规则没有回复（`reply_dropped`）也会告警。正在跑的危险回合没有把回复发完时也告警：`/stop`（`owner_stop`）、看门狗中止（`aborted`）、暂停（`paused`）、过了被动窗口（`deadline`）、出口拒绝（`exit_refused`）；批准之后预算不够（`budget`）或付费暂停（`paid_paused`）也告警。停机时丢掉的危险回合，包括正在跑的，告警 `crisis_dropped_on_stop` | 比决定的范围宽 |
| 模型判定的危险 | 模型说 `crisis=true` 的消息，即使不在危险词表上，之后各路线也按危险处理 | 不然超过上限后模型判定危险的这一条会被当成普通回合 |
| 命令的形状 | 包括 `@…` 和 `:…` 结尾，所以 `/new@bot`、`/think:high` 仍被忽略 | 宿主其实会把它们交给模型 |
| 迟到的用量 | 已关闭但还欠用量的回合，只认它关闭之前开始的那次运行的用量。关闭之后才开始的运行（事件时间减 `durationMs` 不早于关闭时间）算给正在跑的回合，没有就算给最近关闭的回合。`durationMs` 缺失或无效时照旧算给欠用量的回合 | 宿主卡住回合的恢复会强制清掉旧运行，下一回合可能立刻开始，之前它的用量会被算到旧回合上。这条路径是读宿主源码得出的，没有在真实运行中观察到 |
| 折叠的点名行 | 后面那条的回合什么都没说时，点名行自己判定一次。发送结果不确定、回复只发出一部分、内容规则拒绝，都不再判定 | 不重发和内容命中不重试的规则优先。所以一条危险的点名行在内容规则拒绝的路径上可能没有回复，只有告警 |
| 配置和模型锁不符 | 检查提前到写 `config.json` 之前（`assertApplicable`） | `clo apply` 照样查。dry-run 先写配置，同样的拒绝显示在“已经进入 dry-run”之后 |
| 30 天对账基线重置 | 还要等预留、未结算的行结束，并且上报延迟内没有刚结算的真实费用 | 否则迟到的扣费会变成假差额 |

第一次提交之前要做的（用户确认，2026-11-05）：

| 项目 | 决定 |
|---|---|
| 接口 | 现在只改名：`CLO_CHAT_API_KEY`、`CLO_SEARCH_API_KEY`。启动时把前者映射成宿主要的 `OPENROUTER_API_KEY`。文档和 `.env.example` 写明目前只适用于 OpenRouter，其他 OpenAI 兼容接口未来可加。通用接口没有账户侧限额，只剩本地估算管钱，算独立功能 |
| 项目定位 | 介绍和文档都写 QQ 机器人。微信只留“未来可能加入，架构上作预留” |
| `CLAUDE.md` 第 7.4 节和 `persona/SOUL.md` | “默认适合微信真实聊天”两处都改成 QQ 聊天，并更新校验基线。这是用户明确同意的例外，第 7.1–7.5 节其他内容不动 |
| `CLAUDE.md` 第 7.1 节 | 删掉社区二创的来源说明和链接，换成一句“原创适配”，并更新校验基线。这是用户明确同意的第二个例外，`persona/` 不受影响 |
| 公开 | 仓库按公开处理。提交前做隐私审计，调研记录、部署日志这类内容移出仓库 |
| 不改的 | `doctor` 拒绝微信插件的检查保留，防止同一账号出现第二个消费者。目录名 `clo-wechat` 等 Gateway 停下时再改 |
| 顺序 | 合并重复回答的修复并重测，然后改名、整理文档、加 `.gitattributes`、第一次提交，最后才开第一批修复 |

## 接入和部署方式（2026-11-06，用户确认）

| 项目 | 决定 | 理由 |
|---|---|---|
| 事件接入 | 继续用 WebSocket，不做 Webhook | 只需要出站网络，不用入站端口、域名和 HTTPS。Webhook 的好处主要是 Serverless 和多副本，这里每个 AppID 只有一个实例，用不上。换了还会失去 4914、4915、连接健康判断和 READY 的身份确认 |
| 远程部署 | 小 VPS 跑同一套代码 | 改动最小，gate、出口和账本的行为不变。要先做跨平台，并在目标环境重新做真实 QQ 验收 |
| Cloudflare Workers | 暂不做 | 跑不了 OpenClaw（常驻进程、依赖体积、`node:sqlite`、子进程），等于重写运行层，还必须走 Webhook。Workers 的容器方案要付费，不比 VPS 省 |

什么时候重新考虑：平台明确要下线 WebSocket，或者确实需要 Serverless。

没有确认的：
- Webhook 对所有机器人是否开放。看到一处官方文档改动说还在灰度，可能已过时，也没有实测。
- WebSocket 是否会下线。只看到第三方项目的说法，没有找到官方公告。
- 真要做 Webhook，不能直接把 SDK 自带的接收层放到公网，要先做安全审查，并自己处理回调验证、时间戳和监听地址。这些都没有实现，也没有测过。
- VPS 的内存只在 Windows 的离线测试里量过（见下一节和 `DEPLOYMENT.md` 的“内存”），Linux 上没有量过。服务器所在地区、QQ 的 IP 白名单要由部署者在部署时确认。不能靠选节点或代理绕过模型服务方的地区限制。

## 先调 OpenClaw（2026-11-06，用户定的）

用户选择先调 OpenClaw 的内存设置，暂不换掉 OpenClaw。

| 项目 | 决定 | 现状 |
|---|---|---|
| Node 编译缓存 | Gateway 不用。设 `NODE_DISABLE_COMPILE_CACHE=1`，不再设 `NODE_COMPILE_CACHE` | 已实现。宿主不再重新拉起自己，`clo start` 记下的 PID 就是 Gateway。启动慢约 0.5–1 秒 |
| 新生代大小 | Gateway 加 Node 参数 `--max-semi-space-size=8`。`NODE_OPTIONS` 不传给子进程，所以写在启动参数里 | 已实现 |

数字只在离线测试里量过：空闲约 750–850 MB，一个回合后约 1.2–1.4 GB，见 `DEPLOYMENT.md` 的“内存”。真实 QQ 和真实模型下没有量过。

**没定：** 长期要不要去掉 OpenClaw。内存几乎都花在宿主上，去掉 clo 插件只少约 50 MB，再要明显变小只能换掉宿主。换掉要做多少事、值不值，没有评估。

## 去掉 OpenClaw，改用自己的运行时（2026-11-06，用户定的）

用户同意规划里的全部推荐答案（“全按建议”）。这取代了上一节“长期要不要去掉 OpenClaw”这一条。下面都还没有实现，也没有在真实 QQ 上验证。

| 项目 | 决定 |
|---|---|
| 方向 | 去掉 OpenClaw，改成项目自己的小运行时：官方 QQ SDK、gate、发送出口、账本、内容策略照旧，主回复直接调 OpenRouter |
| 过渡 | 两套运行时并存，配置 `runtime` 取 `openclaw` 或 `own`，切换前默认 `openclaw`。两套共用一把启动锁和 PID 记录，同一个 AppID 只有一个消费者。新运行时在测试群重做真实验收 Q3 到 Q7 之后才切换，切换后再删 OpenClaw 相关的代码和依赖。回退：改回 `openclaw` 再重启 |
| 可洛自己的回复 | 只放在内存上下文里，和群消息用同一个有界环（40 条、24 小时、token 上限），重启后丢失，`/new`、`/reset` 清空，闲置 120 分钟清空 |
| 付费调用的重试 | 不重试。只有确认没发出去的连接错误（连接超时、连接被拒、DNS 失败）在期限内重试一次，并单独预留 |
| 必答回合返回空或 NO_REPLY | 发失败句，不重试。必答回合的预留从 2 倍降到 1 倍 callWorst，可缓存部分按缓存写入价计 |
| 流式 | 第一版不用流式。付费探测显示中止的请求仍被计费时再考虑 |
| 提示缓存 | 只在系统提示末尾放一个 5 分钟的 ephemeral 标记，用户消息不放。由付费探测确认实际读到缓存 |
| OpenRouter 路由 | 上游不锁定，和现在一样；加 `provider.require_parameters:true`；不发归属请求头，也不发 user 字段。是否只走 Anthropic 以后另定 |
| 回复被截断（length） | 保持现状：发出已有部分，记 length |
| 拒答和审核 403 | F13 不变。402 和 Key 限额（limit_source）立即按余额或 Key 限额暂停，不计入连败 |
| `/stop` 和同一秒的消息 | 保持现状：同一秒不算更新，跳过，带危险词的除外。改由 gate 明确实现 |
| 不是命令的斜杠文本 | 只有列出的 owner 命令算命令，其他斜杠文本按普通文字走正常触发 |
| 搜索 | 已定（2026-11-17）：gate 直接调 perplexity/sonar-pro，把结果当作不可信资料交给主回复，引用照样过出口内容策略，只在 own 运行时。细节见下面“用户定的（2026-11-17，搜索）”。原来写的是“启用搜索时再定”加这条倾向 |
| acorn | 作为测试用的固定版本 devDependency 加入，锁文件带校验值，单出口的静态检查要用它 |
| Linux 和 VPS | 以后单独做，在 Windows 切换之后。新运行时本身不依赖 PowerShell |
| 真实验收的花费 | Q3、Q4 $0；Q5 付费探测上限约 $0.10，按下面“用户定的（2026-11-06，Q5 和费用）”的两回合计划跑，计划最坏 $0.094144，开始前另外确认金额（2026-11-07 按 $0.10 跑过一次，实际 $0.0338）；Q6、Q7 测试群上限约 $0.40。只用现有测试群 |
| `CLAUDE.md` 里提到宿主的规则 | 在切换时改写（§2、§3、§5.4、§6、§8.2、§11），保留每条的本意：一个消费者、一个出口、每次模型调用前检查内容范围标记、这一版不带工具、Key 日限额是硬上限。§7.1 到 §7.5 不动 |
| 告知草稿里的 clawhub.ai 和会话库 | 真实运行确认没有这些外联和落盘之后才从草稿里去掉，告知由用户本人做（D5） |
| 换 Claude API | 现在不做接口抽象，`openrouterChat.js` 是将来唯一要改的地方。（已被下面“用户定的（2026-11-07，Provider）”的共用接口层取代，这一行留作历史） |

## 自己的运行时里和上一节不一致的地方（开发时定的，用户还没有确认）

只用离线测试验证过（mock OpenRouter）。用户不同意的话，按上一节改代码。

| 项目 | 现在的值或行为 | 说明 |
|---|---|---|
| 连接重试的预留 | 重试不另外预留，用的是这个回合原来的那一份预留。重试前只再查一次模式是 live、`qq.enabled`、全局、分群、终止和付费暂停，任何一项不满足或读不到就不重试（`src/bot/services.mjs` 的 `retryAllowed`） | 上一节用户定的是“并单独预留”，代码没有照做，这是开发时的选择。理由：只有判断第一次请求没发出去时才重试，按这个判断第一次没有费用，原来的预留够一次调用的最坏数。这个判断错了的话，这个回合的实际花费可能超过这一份预留 |

## 用户定的（2026-11-06，Q5 和费用）

新运行时的 Q5 按原来的计划最坏要 $0.9844，比上面约 $0.10 的上限大，跑不了。用户定了下面几条。探测的改动写好时只用离线测试验证过（mock OpenRouter，不发真实请求）。付费的那一次由用户确认金额 $0.10 后，于 2026-11-07 在真实 OpenRouter 上跑过一次，不接 QQ，结果见“平台实测得到的事实”里的“own 的 Q5 真实探测”。这不是 own 在 QQ 上的验收。

| 项目 | 决定 |
|---|---|
| Q5 的形状 | own 的探测只跑两个回合，不做判定调用，也不做直连主模型的调用。第 2 回合按条件发：发之前用它准确的请求体算出界限，加上已经计入的花费会超过 `--max-usd` 时记 `skipped_cap`，不发 |
| 探测的 `max_tokens` | 1200，只在探测里用。正式配置的 `claudeModel.maxTokens` 仍是 3000，`contextTokens` 仍是 24000 |
| 价格界限 | 锁定价加 10%：输入 $5.5、输出 $22（每百万 token）。输入按 max(输入 $4, 缓存写入 $5) × 1.1 算。目录价高于它就拒绝运行 |
| `provider.max_price` | 正式运行和探测都**不加**，保持默认路由。用户以后可能在冷启动时考虑 Fast Mode，见 [docs/cost-options.md](docs/cost-options.md) |
| 探测的 Key | 专用的 `CLO_TEST_API_KEY`，单独建，日限额不高于这次探测的上限。own 模式的探测没有它就拒绝运行；openclaw 模式仍读 `CLO_CHAT_API_KEY`。机器人不用它 |
| 正式运行的省钱改动 | 这一轮不做，只把办法记下来，见 [docs/cost-options.md](docs/cost-options.md)，以后逐项再定 |

计划打印的数字：0 次直连调用，2 个回合，最多 2 次模型调用。第 1 回合的界限是 (11817 字节的消息 + 500) × $5.5/M + 1200 × $22/M = $0.094144，这也是运行前的最坏数。工具把它打印成向上取整的 $0.0942，并写出 94144 微美元；`--max-usd` 低于 94144 微美元就拒绝，所以 $0.0941 会被拒绝。第 2 回合的界限运行时才算，见下一节。

去掉判定调用和直连调用的理由：它们量的东西输入都被哈希锁定，或者自上次实测以来没有变过，第 1 回合本身就是一次带完整系统提示词的直连调用。考虑过、没有采用的：

- `max_tokens` 300–600：不高于 OpenRouter 文档写的思考预算下限 1024，请求很可能被拒。
- 按原来的 $8/$30 上限算：光第 1 回合就是 12317 × $8 + 1200 × $30 ≈ $0.1345，超过 $0.10。
- 两个静态界限的回合（`max_tokens` 1200）：第 2 回合的字节界限要算上第 1 回合的回答。回答按空算，按锁定价（输入按缓存写入价 $5、输出 $20）合计约 $0.1717，按 $5.5/$22 约 $0.1888；第 2 回合单独按 $5.5/$22 约 $0.0947，回答越长越多。以前这里写的两个数用这些算式对不上，已去掉。
- 按估算 token 数定界限：估算和真实 token 的比例只有两个样本，证明不了。
- 留一次判定调用：$0.094144 + $0.007438 = $0.101582，超过 $0.10。
- 留三次直连主模型调用：最坏合计 $0.4094。

## 开发时定的，用户还没有确认（2026-11-06，Q5 探测）

都在 `src/tools/q5-probe.mjs` 里，只用离线测试验证过。数值可以改。

| 项目 | 现在的值或行为 | 说明 |
|---|---|---|
| 第 2 回合的余量 | B2 = min(字节界限, (ceil(1.05 × P1) + 第 2 回合用户消息的字节数 + 64) × $5.5/M + 1200 × $22/M)。P1 是第 1 回合报告的 prompt token，缓存读加缓存写更多时取后者 | 两回合的系统文字逐字节相同，所以从 P1 出发。1.05 和 64 是给分词差异和换了服务方留的余量，不是从数据推出来的。B2 靠的是 OpenRouter 报告的用量，也靠第 2 回合的单价不高于上限、输入不超过这个估计；这两条在第 2 回合发之前都查不了 |
| 1 小时缓存写入不按 own 的上限查 | 目录里的 `input_cache_write_1h`（$8）高于 own 的 $5.5，不因此拒绝；但它仍按一般的主模型上限 $8 查，高于 $8 就拒绝 | 发送前的检查拒绝任何带 `ttl` 的请求，所以这个价格收不到。测试把 `ttl` 那项检查关掉，确认这时按 $5.5 拒绝。探测以后要是用 `ttl`，这个例外就要去掉 |
| 第 1 回合之后的停止检查 | `completion_tokens` 超过 1200（`completion_above_bound`）；`prompt_tokens` 超过消息字节数 + 500（`prompt_above_bound`）；报告的费用高于 token 数乘锁定价加 10%（输入 $4.4、输出 $22、缓存读 $0.22、缓存写 $5.5，每百万 token）再加 1000 微美元的容差（`price_above_bound`）；报告了费用却缺 `prompt_tokens` 或 `completion_tokens`，前面几项查不了（`usage_tokens_missing`）。任一项成立就停，不发第 2 回合。另外，第 1 回合发之前按实际请求体再算一次界限，高于打印的就不发（`bound_above_plan`） | 不加 `max_price` 时，意外路由到 2 倍价格的端点主要靠 `price_above_bound` 拦。这些都只能在第 1 回合扣费之后查 |
| 探测 `max_tokens` 的下限 | 1200 这个值是用户定的，见上一节，不在这里改。这里只记下限的理由，和一处没统一的数 | OpenRouter 文档写 effort low 的思考预算是 max(min(max_tokens × 0.2, 128000), 1024)，`max_tokens` 要严格大于它，所以不能是 1024 或更低。按 $5.5/$22，`max_tokens` 高于 (100000 − 12317 × 5.5) / 22 ≈ 1466 时，光第 1 回合的界限就超过 $0.10；人设变长，这个数会变小（以前写的“约 1300”是只算了 1200、1300、1500 三个值得出的）。2026-11-07 的真实探测里，effort low 加 `max_tokens` 1200 的请求被接受过一次，思考 51 和 155 token；只有这一次。项目里判定模型的思考下限另写了 2000（`models.js`），两个数没有统一，怎么统一还没有定 |
| 第 1 回合的保证写成有条件的 | 打印的计划写：第 1 回合不超过 $0.0942（94144 微美元，向上取整），前提是输出不超过 1200、输入不超过消息字节数 + 500、实际单价不高于上限 | 计划原文写的是“第 1 回合严格不超过 $0.0941”（$0.0941 是向下取整的数）。这三条在请求发出前都查不了，所以改成有条件的说法。两回合合计不超过 `--max-usd` 的前提是 OpenRouter 报告的用量准确，并且第 2 回合的实际单价不高于上限、输出不超过 1200、输入不超过 B2 估的数。计划原文只写了用量准确这一条。第 2 回合是最后一回合，它之后的检查只能报告。无条件的兜底只有 Key 的日限额，它也只能拒绝还没开始的请求，限额到了时正在跑的那一个可能越过一点 |
| 第 2 回合被跳过时的汇总 | 运行仍算完成（`completed:true`），汇总里另记 `skipped`，结尾打印哪一回合没有量到 | 跳过是计划里的一支，不是失败；但缓存读取没有量到，要看得出来 |
| Key 余额的提示 | own 下 Key 当天剩余低于 `--max-usd` 就提示，openclaw 下仍按最坏数 | own 的最坏数只算第 1 回合，两回合合计可能花到 `--max-usd` |

## 用户定的（2026-11-07，Provider）

用户同意规划里的共用接口层（“按你来”），以及下面几条推荐答案。这取代了“去掉 OpenClaw，改用自己的运行时”一节里“换 Claude API：现在不做接口抽象”那一行，那一行留作历史。表里的“规划 D2”这类编号是这次接口规划里的编号，和下面“待定（决策点 D）”、`CLAUDE.md` 里的 D2、D3、D5 不是一回事。

现状：都写进了代码，只在离线测试里验证过（mock QQ、mock OpenRouter、mock Anthropic）。**真实 Anthropic 上一次都没有跑过**，Anthropic 的付费探测（`scripts\q5-anthropic.ps1`）也没有跑过，真实 QQ 上更没有。

| 项目 | 决定 |
|---|---|
| 共用接口层 | 做。own 运行时的模型调用经过一层共用的接口，现在有 OpenRouter 和 Anthropic 两种，用 `config.json` 的 `providers` 和 `activeProvider` 选一个。同一时间只用一个：不做自动切换、优先级，也不在失败后换另一个。openclaw 运行时只能用 OpenRouter，请求和行为和以前逐字节相同 |
| 硬上限（规划 D2） | Anthropic 的普通 Key 读不到花费和限额，也没有按 Key 的每日限额。所以用一个专用的、非默认的工作区，设很小的月度花费上限（约 $20），再加上关闭了自动充值的预付费额度。部署者用 `clo ack hard-cap` 声明这两样，声明绑定 `.env` 里那个 Key 的指纹（`clo.db` 里只存它的 HMAC）。每次可洛进程启动和 `clo start` 都重新核对：Key 换了或声明不全，`clo start` 拒绝，进程启动时付费暂停为 `hard_cap_unverified`，只有重新声明才解除。没有声明不能 live。这个上限只靠部署者本人的话，程序读不到；出错的一天最多可能花到这个月度上限 |
| 对账（规划 D3） | Anthropic 上不对账，也不放 Admin Key（它要组织级的高权限凭据，个人账户也没有）。`status` 显示“对账：不可用（本地估算）”，花费只按锁定的价格表在本地算 |
| 未结算记录（规划 D4） | Anthropic 上读不到 Key，“15 分钟、至少读 3 次 Key 都没有差额就按 0 结清”那条用不上。未结算的行一直按预留额计入，直到 owner 在控制台运行 `clo budget accept-unsettled`。确认没有发出去的行照旧释放。这样只会多算，不会少算 |
| 暂停怎么解除（规划 D5） | 读不到 Key 的接口上，`provider_fail` 和 `anthropic_*` 这几种付费暂停由 owner 用 `clo budget clear-pause` 解除。原因还在的话，下一次就立刻再暂停 |
| 怎么调 Anthropic（规划 D7） | 用项目自己的 `fetch`，走和 OpenRouter 共用的那一个发送循环。不用 Anthropic SDK，不加新依赖。SDK 默认会对 429、5xx 和连接错误重试，和“只重试确认没发出去的连接错误”冲突 |
| 换接口算模型变更（规划 D8） | `clo provider use` 算一次模型变更：启用 QQ 时要加 `--qq-platform-notified`，表示部署者本人已向平台报告（协议 §4.2）。它清除每个群的“已告知”和 D3（协议 §4.2）的记录，所以换完要重新告知、重新 `clo ack d3`，live 才会通过。告知的接收方也变了：直连 Anthropic 时，文字直接发给 Anthropic，不经过 OpenRouter。只有这个命令能换：它在 `clo.db` 里记下换到的接口（`active_provider`），`clo apply` 和 `clo start` 发现 `config.json` 里在用的接口和记下的不一样就拒绝，手改 `activeProvider` 和 `acks.provider` 跳不过这些步骤。没有记录时按生效配置里的接口，生效配置也没有时按 OpenRouter |
| 改写的规则 | `CLAUDE.md` 第 4 节的密钥表和“只适用于 OpenRouter”那一段、第 6 节、第 8.2 节按上面几条改写，两种接口分开写清楚。“Key 日限额是硬上限”在 Anthropic 上换成声明的工作区月度上限。其他 OpenAI 兼容接口仍然不能用。第 7.1 到 7.5 节不动。代码里 live 的 `provider_rules` 一项（`src/clo-plugin/lib/core/providers/registry.js` 的 `LIVE_RULES_RECORDED`）以这几行为依据，和这几行在同一次提交里对 Anthropic 打开 |
| 告知草稿 | `persona/group-notice.zh.md` 里“消息发给谁”那一句改成占位，由部署者按在用的接口填。**改过的草稿要用户本人看过**，告知仍由用户本人做（D5） |
| D6 结算顺序（用户确认） | 用户 2026-11-07 确认按现在的做法：own 运行时走 OpenRouter 时，有上报的费用就按上报的结算，没有上报才按 token 乘锁定价；上报高于算出来的 1.10 倍时记一条告警，不暂停付费。理由和代价见下一节“OpenRouter 在 own 上怎么结算（规划 D6）”那一行 |

## 开发时定的，用户还没有确认（2026-11-07，Provider）

都只在离线测试里验证过。用户不同意的话，按用户的决定改代码。

| 项目 | 现在的值或行为 | 说明 |
|---|---|---|
| OpenRouter 在 own 上怎么结算（规划 D6） | 有上报的费用（`usage.cost`）就按上报的结算，比按 token 乘锁定价算出来的高或低都一样；没有上报时才按 token 乘锁定价。上报高于算出来的 1.10 倍时记一条 `cost_above_computed` 告警，`clo status` 里能看到，它不暂停付费。openclaw 路线不变 | 规划写的是取两者中较大的，做的时候改成按上报的：Key 实际扣的就是上报的数，对账也拿结算数去比 Key 的读数。按较大的结算，多算的那部分会被当成 Key 已经解释过的花费，盖住之后真的扣了的钱，也会让丢了的行按 0 结清。代价是一条贵的路线如果上报得少，本机也跟着少算，这由 Key 的每日限额兜住。这一项和接口层分开做，是为了让接口层在 OpenRouter 上逐字节不变（有固定的请求体样本守着） |
| 判定的 effort（规划 D9） | 判定模型 Haiku 的 `effort` 只接受 `none`，发出去是关闭思考（`thinking: disabled`）加 `output_config.effort: low`。主模型 Opus 拒绝 `none`，只接受 low 到 max | 按资料，Haiku 5.5 在 effort high 及以下可以关闭思考，Opus 5.5 关闭思考会返回 400。不关的话，自适应思考可能把判定的 200 个输出 token 用完。**没有在真实 API 上确认**，等付费探测 |
| Anthropic 的 403（规划 D10） | 403 `permission_error` 立刻付费暂停为 `anthropic_permission`，owner 解除，从不算拒答 | Anthropic 的 403 是地区或权限问题，拒答是 HTTP 200 加 `stop_reason: refusal`。照搬 OpenRouter“没有来源的 403 算审核”的规则，地区封锁会一次次重复。真实的 403 形状没有观察过 |
| 429 和 529（规划 D11） | 计入主模型连续 3 次失败的计数（`provider_fail`），和其他不是限额的错误一样。月度花费上限的 429（`enforced_spend_limit_reached`）算 `anthropic_spend_limit`，不算普通的 429 | 这个机器人的量很小，429 不常见，值得停下来看。那个错误码在响应里的位置没有确认 |
| `clo.db` 第 2 版（规划 D12） | 预算记录（`reservations`）加一列 `provider`，存接口的**类型**（`openrouter` 或 `anthropic`），不存名字；空值算 OpenRouter。从第 1 版升到第 2 版有明确的一步，升级前用 `VACUUM INTO` 把整个库（连 WAL 里的）复制成 `clo.db.v1.bak`。备份在升级后满 `retention.eventDays` 天（默认 14 天）由运行中进程的清理删除，升级中途被杀留下的临时副本一小时后删除。README 的“数据和隐私”列了这两个文件 | 存类型，因为接口名可以随便起，按名字对账会把改了名的 OpenRouter 行漏掉。旧版本的程序拒绝打开第 2 版的库，回退到旧版本要用这份备份，步骤在 README 的“排错” |
| 规划之后审查加的几条 | 读不到 Key 的接口进 live 要过 `provider_rules`；可洛进程和 `clo start` 启动时核对硬上限声明绑定的 Key；Anthropic 探测的静态上限算上美国区的 1.1 倍；`clo provider use` 在判定熔断、有预留或未结算的行时拒绝，有付费暂停时也拒绝（从 OpenRouter 换走时有四种例外，见下一行），换成功后清掉残差、余额探测、连败计数和读 Key 失败的状态；进程按在用接口的类型取 Key；单出口的静态检查扩到 `src/bot` 和 `src/tools`；检查 Anthropic 模型的能力；判定的 effort 只留 `none`；型号只接受 Opus、Sonnet、Haiku 这几条线的具体编号 | 都有离线测试，各带正向对照 |
| 从 OpenRouter 换走时解除的付费暂停 | 从读得到 Key 的接口（现在只有 OpenRouter）换到别的类型时，`clo provider use` 先删掉 `key_read_failed`、`residual`、`openrouter_key_limit`、`provider_fail` 这四种付费暂停，再做换接口的检查；后面的检查拒绝时它们恢复原样。其他付费暂停照样拒绝换。换完打印一行，日志记 `paid_resumed` | 审查的意见原本是“有付费暂停就拒绝换”。这四种只有再读到旧 Key 才会解除，`clo budget clear-pause` 也不管；Key 被作废或账户关了时，照原意见就永远换不走。代价：`residual` 说明 Key 上有本机解释不了的花费，可能是 Key 泄露了，换接口会把它清掉，程序不替部署者去查。README 写了换之前先去 OpenRouter 上看这个 Key 的用量。`status` 里 `residual` 的说明写“没有命令能提前解除”，没有提这个例外 |
| 401 和 404 | 和其他错误一样计入连败，不立刻暂停 | 要不要改成立刻暂停没有定 |
| 价格表 | Anthropic 接口不返回价格。价格是手抄进 `versions.lock.json` 的价格表（来源和核对日期写在里面），`clo model lock --provider anthropic` 从这份表锁定，第一次和涨价时都要 `--confirm-price` | 抄错了，本地估算就跟着错，而 Anthropic 上没有对账能发现 |

## Linux 上跑离线测试（2026-11-16，用户定的）

用户决定：在 Windows 切换之前，先让离线测试能在 Linux x64 上跑，只当作以后做 Linux 的铺垫。具体怎么做（下一节）是开发时定的，用户还没有逐项确认。“去掉 OpenClaw，改用自己的运行时”一节里“Linux 和 VPS：以后单独做，在 Windows 切换之后”那一行不变，Linux 部署仍然没有做，也不支持。

现状：代码里加了不是 Windows 时走的分支，Windows 执行的语句原样留在原处。**改完之后 Windows 上一次都没有跑过**，这里没有 Windows 可以跑。Linux 这边只有离线测试（mock QQ、mock 模型），完整的离线测试只在一个以 root 运行的容器里跑过，另外开发者在同一个容器里换成普通用户手动走过一次 dry-run 流程（见下面“Ubuntu 真实测试前发现的问题”一节）；没有连过真实 QQ、OpenRouter 或 Anthropic。

## Ubuntu 上做真实 QQ 测试（2026-11-16，用户定的）

用户决定：在用户自己的 Ubuntu 26.04 x64 机器上做真实 QQ 测试。这放宽了第 1 节“项目要求 Windows 和 PowerShell”：Linux 上的真实测试允许做，但还没有做，Linux 部署也还不算支持。真实验收要在 Ubuntu 上从 Q3 起重新走，Windows 上的结果不能算 Ubuntu 的。

同一天用户确认了下一节里的四项：

| 项目 | 用户的决定 |
|---|---|
| 怎么停 | 保持只发 SIGKILL，和 Windows 的 `taskkill /T /F` 一致 |
| 子进程的 PATH | 保持只有私有 Node 的 `bin` 目录；真实运行里宿主找不到系统命令时再按需加 |
| 宿主的日志目录在 `.runtime` 之外 | 真实测试之前先查清：锁定版本的宿主能不能把日志放进 `.runtime/`，真实运行时会写什么。能改就改；不能改就写进 README 的“数据保留”并告诉用户。查清之前不做真实测试 |
| 动到的“不能改”的文件 | 认可这个例外 |

同一天用户还定了：Ubuntu 上的真实 QQ 测试两套运行时（`openclaw` 和 `own`）都测。`openclaw` 运行时要先把宿主的文件日志用受支持的配置键 `logging.file` 放进 `.runtime/`，这要改 `render.js` 和渲染的基准文件，是 `docs/provider-contract.md` 第 0 节“不能改”的又一个例外，用户在选“两套都测”时一并接受了。`own` 运行时不启动 OpenClaw，没有 `/tmp/openclaw` 的问题；它在真实 QQ 上一次都没有跑过，Ubuntu 上的验收也就是计划里切换前要做的 own 验收（Q3 到 Q7）。

原定 Q3 之前要做的三项：`versions.lock.json` 加 Linux Node 的条目和校验值，Linux 的安装脚本，宿主日志放进 `.runtime/`。三项都已做，只用离线测试验证过：

- `versions.lock.json` 加了 `nodeLinuxX64`（24.22.2，`node-v24.22.2-linux-x64.tar.xz`），校验值开发时和 nodejs.org 的 `SHASUMS256.txt` 对过，一致；压缩包本身没有下载核对，第一次真的下载是在用户的 Ubuntu 上跑 `setup.sh` 时。
- `scripts/setup.sh` 和 `clo.sh`、`start.sh`、`stop.sh`、`status.sh`、`doctor.sh`、`_env.sh` 已加。
- 宿主的文件日志用 `logging.file` 放进了 `.runtime/logs/host/`，见“开发时定的，用户还没有确认（2026-11-16，Linux）”一节的“宿主的日志目录”。宿主在 Linux 上仍会建 `/tmp/openclaw` 放临时文件，这一点挪不走，写进了 README 的“数据保留”。

2026-11-17 用户确认了“开发时定的，用户还没有确认（2026-11-16，Linux）”一节里当时列出的默认做法，包括：`setup.sh` 装 OpenClaw 要加 `--runtime`，缺锁文件就拒绝，不拒绝以 root 运行；`.env`、数据库、Gateway token 别人能读时 `start` 拒绝，`config.json` 只提醒；程序不改已有的 `.env` 和 `config.json` 的权限。用户同时提出让新建的 `.env` 一开始就是 0600：git 只记可执行位，`.env.example` 带不了 0600，所以改成 `setup.sh` 在 `.env`、`config.json` 不存在时用 umask 077 从模板复制（0600），已有的不动。只在离线测试里验证过（`tests/unit/setup-sh.test.mjs`）。

同一天用户定了期限余量的修法：所有被动窗口和回合期限的检查都留 1 秒（`exit.js` 的 `SEND_MARGIN_MS`），离期限不到 1 秒就不再开始发送，等待也要在期限前 1 秒结束；每一段在真正 POST 之前再查一次窗口，过了就把这一段记成 `aborted`，不发。起因是 `tests/e2e-own/dispatch-stalled.test.mjs` 在用户的 Ubuntu 机器上偶尔失败：检查时还剩几毫秒，失败固定句在窗口之后才发出去。`turn.js` 没改：期限到了才超时的回合仍记 `failed`，它的失败固定句会被这 1 秒挡住。只在离线测试里验证过（`tests/unit/qq-passive.test.mjs` 里 1 秒边界两侧各一个、POST 之前再查一次的测试；去掉 POST 前那次检查，这个测试会失败）。代价：理论上离窗口结束不到 1 秒时本来还来得及的回复也不发了。

2026-11-17 已观察：在用户的 Ubuntu 机器上用普通用户真的跑了一次 `bash scripts/setup.sh --runtime`（之前装的 Node 先挪开，没有删）。Node 压缩包真的从 nodejs.org 下载，校验值核对通过，解出来的 `node` 和之前装的逐字节相同；根目录和 `.runtime/pkg` 的 `npm ci` 都完成，锁文件里的版本和完整性核对通过；缺的 `.env`、`config.json` 建成了 0600。**npm 11.19.1 没有运行依赖包的安装脚本**：它报 5 个包（`openclaw`、`esbuild`、`koffi`、`protobufjs`、`@google/genai`）的安装脚本“不在 allowScripts 里”，跳过了。这和容器里一直用来测试的安装状态一样（那里也没跑这些脚本）；OpenClaw 的那个脚本读源码是清理旧版本残留的文件，全新安装用不上；esbuild、koffi 的脚本处理平台相关的二进制文件，不跑会不会影响真实运行没有查清。Windows 上 `setup.ps1` 用同一个 npm，应该同样跳过，没有在 Windows 上看过。另外 `.runtime` 原来是 775（Ubuntu 默认 umask 002），`setup.sh` 现在把 `.runtime` 本身收紧到 0700（只在离线测试里验证过）。

2026-11-17 已观察：在用户的 Ubuntu 机器上，两种运行时的 Q3、Q4 都走通了，都是 dry-run，没有调用模型，也没有发送。
- openclaw：连上 QQ，收到 READY，用户确认了机器人身份（`clo ack identity`）。Gateway 只监听回环地址。宿主没有写日志文件（级别 silent）。群名单为空时，用户的一次真实 @ 在第一步被丢弃（`gate_drop`，原因 `not_admitted`）。中途断线一次（关闭码 1006），6 秒后自动恢复。采集到测试群 ID 和用户的成员 ID（各一个，原始 ID 没有出现在聊天和日志里），加进配置后采集被清空；之后用户的一次真实 @ 记成 `dry_run`/`would_at`。`stop` 之后没有留下进程，`.runtime/temp` 下留下一个 `oc-br-*` 文件夹（已知）。`/tmp/openclaw` 是一个空文件夹，在离线测试时就已经建了。
- own：同一个配置改成 `runtime: own`，连上 QQ，READY 用户名相同，进程不监听端口。用户的一次真实 @ 记成 `dry_run`/`would_at`。`stop` 正常。own 运行时上没有单独看名单为空时的丢弃（openclaw 上看过，两种运行时用同一段 gate 代码）。
- 每种情况只看了一条消息。

还没做的：Q5（付费探测）要用户同意金额；进 live 之前还要用户做 D3、告知群友，以及第 8 步的确认。

2026-11-17 用户定的：之后的实现和测试都优先用 own 运行时。openclaw 运行时保留，可以回退，但新功能和真实验收先在 own 上做。

## Ubuntu 真实测试前发现的问题（2026-11-16，还没有修）

开发时在同一个容器里换成一个普通用户（不是 root），手动把 Q3、Q4 的 dry-run 流程在两种运行时上各走了一遍。这是开发者自己报告的，不在任何一次记录下来的测试运行里，也不是在 Ubuntu 26.04 上做的：测试模式、mock QQ、mock 模型，复制了现成的 `.runtime`，直接运行 `src/cli/clo.mjs`。按开发者的报告，每一步都能以普通用户完成，`stop` 之后没有留下进程。走查发现的两个阻塞项（Linux 没有安装办法、README 只有 PowerShell 命令）已由上面的 `setup.sh` 和包装脚本补上，只用离线测试验证过。下面这些除标了“已修”的，都还没有修，**目前没有阻塞项**，但“严重”的几项建议在真实测试前先处理：

| 严重程度 | 运行时 | 文件 | 问题 | 怎么修 |
|---|---|---|---|---|
| 严重（已修） | 两种 | `src/cli/clo.mjs`（入口判断） | 通过符号链接的路径运行时，`clo` 什么都不做，退出码 0，用户会以为 `start`、`stop` 已执行。`scripts/clo.sh` 用的是不解析链接的路径，项目目录本身是链接时同样中招。`src/tools/qq-listener.mjs` 末行同样 | 已修，只在离线测试里验证过。`platform.mjs` 加了 `isEntryPath`，两边都先 `realpath` 再比，和 `src/bot/main.mjs` 的 `isEntry` 一样。`clo.mjs`、`qq-listener.mjs`、`qq-send-probe.mjs`、`q5-probe.mjs`、`q5-anthropic.mjs` 不是 Windows 时用它，Windows 仍是原来的比较。`_env.sh` 用 `cd -P`、`pwd -P` 求项目根，交给 Node 的是真实路径。测试：`tests/unit/entry-symlink.test.mjs`（真实路径、链接的目录、链接的文件都打印用法；从链接目录 import 时不运行），`lifecycle.test.mjs` 里经由链接目录调用 `clo.sh`。包装脚本只在项目文件夹（或 `scripts/` 文件夹）是链接时修好了。从别的文件夹链接到脚本文件本身（`~/bin/clo` 指向 `scripts/clo.sh`）原来是 `source _env.sh` 找不到文件、报 bash 错误；不用外部命令读不出文件链接的目标，所以没有支持，6 个包装脚本现在在旁边没有 `_env.sh` 时报一句说明（改链接文件夹），退出码 2，什么都不运行。同一个文件夹里链接到脚本（`scripts/clo` 指向 `clo.sh`）照常运行。只在离线测试里验证过，测试在 `lifecycle.test.mjs` 的同一个测试里（`clo.sh`、`status.sh`、`start.sh` 三个） |
| 严重（已修） | 两种 | `src/clo-plugin/lib/core/render.js` 的 `writeAtomic`，`lifecycle.mjs`，`clo.db` | 默认 umask 下 `.env`、`config.json`（原始群 ID 和 owner ID）、`clo.db` 及 `-wal`/`-shm`、`gateway.token`、Q0 的 `q0-salt` 和采集文件都是 0644，`.runtime` 各目录 0755；用户 `chmod 600 config.json` 后，任何一次写配置又变回 0644。`doctor` 不查文件权限 | 已修，只在离线测试里验证过，Windows 上没有跑过。新文件 `src/clo-plugin/lib/core/private-fs.js`，只在不是 Windows 时改模式。`writeAtomic` 的临时文件用 0600 建，写入前再 `fchmod` 成 0600，新建的文件夹 0700；替换的文件不管原来是 0644 还是 0400，写完都是 0600（不沿用更严的模式，见下一节）。`apply`、`clo start` 建的 `.runtime` 子目录是 0700，已有的放宽过的会收紧；`apply` 还收紧 `.runtime` 下项目自己的文件（`gateway.token`、`clo.db` 及 `-wal`/`-shm`/`.v1.bak`、`effective.json`、`events.jsonl`、`gateway.log`、`q0-salt`、`q0b-dm-target`），不动 `.env` 和 `config.json`。`clo.db` 在 SQLite 打开前先建成 0600（SQLite 给 `-wal`、`-shm` 用主文件的模式），旧文件打开时收紧；迁移时的 v1 备份也收紧。事件日志、`gateway.log`、`gateway.token`、Q0 的盐和采集文件、Q0b 的私聊目标、Q0b 和 Q5 的结果文件都是 0600。后来补的：Q0b 的 `q0b-results.jsonl` 和 Q5 的结果文件跨运行追加，原来已有的文件不收紧，Q5 已有的 `captures/` 也不收紧；现在写第一行前先收紧文件（`private-fs.js` 的 `privateAppender`），Q5 两个工具运行前收紧 `captures/`，Q0 的采集文件名带时间，一般是新的，已有时同样收紧。测试：`private-modes.test.mjs` 里 Q5 两个写结果的函数和私聊目标（各有 0644 的对照），`qq-send-probe.test.mjs` 里真的跑一次探测（mock QQ），原来 0644 的结果文件写完是 0600，旧的行还在。Q0 采集文件没有单独的模式测试。`doctor` 只在不是 Windows、完整级别时多两项：`secret_modes` 失败（`.env`、`gateway.token`、`clo.db` 一族，组或其他用户有任何权限都算），`file_modes` 只提醒（`config.json`、`.runtime` 和几个子目录、上面那些状态和日志文件）；`mode live` 用的配置级别不查。README 的 Linux 安装改用 `cp -n`，加 `chmod 600 .env` 和 `chmod 600 config.json`。Windows 执行的语句不变。测试：`tests/unit/private-modes.test.mjs`（子进程里 umask 022，同一个子进程先证明普通写出来是 0644）；`_cli-helper.mjs` 的 `.env` 改成 0600 建 |
| 严重（已修） | 两种 | `src/cli/clo.mjs`、`src/cli/common.mjs`、`src/cli/doctor.mjs`、`scripts/_env.sh` | 直接用私有 Node 运行 `clo.mjs`（不经 `clo.sh`）时，没有东西清掉代理变量；设了 `NODE_USE_ENV_PROXY=1` 和 `HTTPS_PROXY` 时，私有 Node 的 `fetch` 确实走代理（`clo model refresh`、`mode live` 读 Key、Anthropic 模型检查），违反“不用代理”。`doctor` 的 `parent_proxy` 只是告警，`start` 和 `mode live` 通过时不显示。`clo.sh` 已清掉代理变量，但不清 `NODE_OPTIONS`。子进程的环境按白名单构造，不受影响 | 已修，只在离线测试里验证过，Windows 上没有跑过。选的是拒绝，不是删变量：用私有 Node 24.22.2 和本机回环上的假代理核对过，启动时带了 `NODE_USE_ENV_PROXY=1`（或 `--use-env-proxy`，包括写在 `NODE_OPTIONS` 里）时，进程里删掉这些变量之后 `fetch` 仍然走代理，回环地址也走；没带它时 Node 的 `fetch` 不认 `HTTP_PROXY`。所以 `common.mjs` 在控制台加载时记下启动时的情况，不是 Windows 时 `ctx.fetch` 一律拒绝，报中文说明（用 `scripts/clo.sh`，或去掉这两样再运行）；`mode live` 在写任何东西、读 Key 之前就拒绝。只设了 `HTTP_PROXY` 这类变量不拒绝。后来补的：原来只认恰好是 `--use-env-proxy` 的写法，`NODE_OPTIONS` 里带引号的 `"--use-env-proxy"`、`--use-env-proxy=true` 漏掉了，而私有 Node 对这些都会走代理（`=false`、`--use_env_proxy` 也走，回环假代理核对过）。现在命令行和 `NODE_OPTIONS` 里去掉引号后提到 `use-env-proxy` 的都算，只有单独的 `--no-use-env-proxy` 不算。测试里带引号和 `=true` 两种写法真的启动私有 Node，先证明请求到了假代理，再证明控制台拒绝。另外，测试注入 `env` 时 `makeContext` 不再沿用测试进程自己启动时的情况（原来测试进程带了 `NODE_USE_ENV_PROXY=1` 时，正向对照会失败），有一个子进程测试核对这一点。`doctor` 的 `parent_proxy` 在只有启动标志、没有代理变量时原来写成“当前 shell 设了代理变量（无）”，现在两句分开，只写真有的那句。`doctor` 的 `parent_proxy` 也写出控制台的这种情况；`start` 和 `mode live` 现在显示 `parent_proxy` 的提醒（`mode live` 顺带也显示 `.env` 旧名字和重复行这两条提醒，原来只有 `start` 显示）。`_env.sh` 另外清 `NODE_OPTIONS`，`_env.ps1` 没动。测试：`tests/unit/env-proxy.test.mjs`（写法的单元测试，真的用私有 Node 带标志启动，先证明删变量后请求仍到了假代理，再证明控制台拒绝、假代理和假目录都没收到请求；去掉标志后同一个命令成功）；`lifecycle.test.mjs` 里 `start` 显示提醒、没有代理变量时不显示，`_env.sh` 清掉 `NODE_USE_ENV_PROXY` 和 `NODE_OPTIONS` |
| 一般（文档已补，代码没改） | openclaw | `src/cli/platform.mjs`（停止只发 SIGKILL） | 每次启动留下一个 `oc-br-*` 套接字目录；项目路径超过约 62 字节（中文字符每个 3 字节）时这个目录落到 `/tmp` 而不是 `.runtime/temp`，`stop` 后仍在 | README 的 Linux 部分已写明项目路径最好不超过约 60 字节、只用 ASCII，目录不检查也不清理。还没做（可选）：`doctor` 在 Linux 上对套接字路径超过 103 字节告警，`clo start` 清理 `.runtime/temp` 下没人监听的 `oc-br-*` |
| 一般 | openclaw | 宿主（锁定版本） | 即使日志是 `silent` 并已指到 `.runtime/logs/host`，宿主在 Linux 上仍会建 `/tmp/openclaw`（0700）放临时文件。走查只覆盖了 dry-run；带模型回合的 live 路径下还会建什么，没有在全新的 `/tmp` 上查过 | 不改上游代码。Q5 之前在全新的 `/tmp`（私有挂载）上用 mock 跑一次带回合的流程，把 `/tmp` 下多出的东西列进 README 的“数据保留”；在那之前告诉用户 Q3、Q4 会建一个空的 `/tmp/openclaw` |
| 一般（已修） | own | `src/cli/clo.mjs`（`liveHint`） | own 运行时用 OpenRouter 时，`mode live` 的拒绝原因 `gateway_key`、`reconciled` 说的是“运行中的 Gateway”，但 own 运行时没有 Gateway | 已修，只在离线测试里验证过。`liveHint` 按 `config.json` 的运行时选措辞，own 时这两项一律说“可洛进程”；openclaw 的文字不变。README 的 `mode live` 一段跟着改。`heartbeat` 的提示原来在 own 下也说“Gateway 没有在运行”，2026-11-17 改成“可洛进程没有在运行”，openclaw 不变（同一个测试文件里先看 openclaw 的说法，再看 own 的）。测试：`tests/unit/cli-mode.test.mjs`（同一个目录先在 openclaw 下看到 Gateway 的说法，再换 own 看到可洛进程的说法） |
| 一般（已修） | 两种 | `src/cli/common.mjs`（`readConfig`） | 没有 `config.json` 时的报错叫用户运行 PowerShell 的 `Copy-Item`，这是 Linux 用户最先可能看到的错误 | 已修，只在离线测试里验证过。不是 Windows 时说 `cp -n config.example.json config.json`，Windows 的文字不变（Windows 上没有跑过）。测试：`tests/unit/cli-mode.test.mjs`（同一个目录先证明有 `config.json` 时命令成功，删掉后报对应平台的复制命令） |
| 一般（已修） | 两种 | `src/clo-plugin/lib/core/config.js` | `clo group add` 之后在中文输出里夹着一句英文提醒（“has no owner yet; live will refuse”），和平台无关，但每个做 Q4 的人都会看到 | 已修，只在离线测试里验证过。改成中文：`提醒：qq.groups.<名> 还没有 owner，live 会拒绝；下一步 clo owner add <名> --id <成员ID>`，Windows 上也一样（这条和平台无关）。`group add` 里仍显示，和它自己的提示有重复。测试：`tests/unit/cli-group.test.mjs`（没有 owner 时显示中文提醒，加了 owner 后不再显示） |

走查没有覆盖的：Ubuntu 26.04 本身（AppArmor、systemd-logind 的 `KillUserProcesses`、`hidepid` 挂载的 `/proc`）；真实的 TLS、DNS 和不带 `OPENCLAW_OFFLINE` 时对 `clawhub.ai` 的访问；`mode live` 只走到拒绝为止；用不同于启动者的用户运行 `clo`，两个用户共用一个目录。

## 开发时定的，用户还没有确认（2026-11-16，Linux）

都只在上面说的那一个容器里用离线测试验证过，Windows 上没有验证。用户不同意的话，按用户的决定改代码。实现在 `src/cli/platform.mjs`，测试在 `tests/unit/platform-linux.test.mjs`。

| 项目 | 现在的值或行为 | 说明 |
|---|---|---|
| Linux 上怎么认一个进程 | 启动标识（`/proc/sys/kernel/random/boot_id`）、PID、启动时刻（`/proc/<pid>/stat` 里的 tick 数）。不比较程序路径，也不比较命令行。PID 记录的格式没有变 | Linux 上命令行不固定：宿主会改 `process.title`，`/proc` 里的命令行跟着变；私有 Node 的目录换掉后程序路径也变。拿它们比，活着的 Gateway 会被判成“不是同一个”，PID 记录被删掉。PID 被别的进程重用由这三项排除。查不到（`/proc` 读不了、不是自己的 PID 命名空间、读不到启动标识）一律算“不知道”，不算“没了” |
| 已退出但没被回收的进程 | 状态是 Z 或 X 的算已经结束 | `clo stop` 等进程结束时自己不回收子进程，这个容器的 1 号进程也不及时回收，不这样就永远等不到。这种 PID 不会被重新分配，丢掉它的记录是安全的。没有测过：主线程退出而其他线程还在的进程也显示 Z |
| 消费者租约里的同一条规则 | `lease.js` 在不是 Windows 时多查一步：`/proc` 显示这个 PID 是 Z 或 X 就算不在了；读不到或看不懂仍算还在。Windows 的路径没有动 | 不加的话，被杀掉又没被回收的机器人进程会挡住 `clo start`，按 `LEASE_STALE_MS`（3 倍心跳间隔）推算最多约 90 秒，这个时长没有实际观察过；`clo stop` 还会说“已请它自己停下”。测试在 `tests/unit/lease-alive.test.mjs` |
| 怎么停 | 只发 SIGKILL，没有先发 SIGTERM 的阶段。先重新核对记录里的进程，再对它自己的进程组发信号，再逐个结束事先记下、启动时刻没变的子孙进程。`stop` 等主进程退出，也等这些子孙进程退出（同一个 15 秒期限）；主进程退了而子孙还在时，`stop` 报错，提示先别再 `start`（2026-11-16 加：一次完整运行里 `stop` 返回后 18 毫秒还看到一个子进程，重跑 3 次没再出现；只在离线测试里验证过）。PID 不大于 1、自己的 PID、自己的进程组一律不发。测试用的假 `/proc` 下从不发信号 | 和 Windows 上 `taskkill /T /F` 对应。Gateway 收到 SIGTERM 会怎样没有量过，被强杀之后费用怎么算的规则也只按强杀想过。已知缺口：在记下子孙之后才生出来、又离开了这个会话的进程会漏掉；列不出子孙时仍然杀进程组，日志记一条（不含 PID） |
| 子进程的 PATH | 只有私有 Node 的 `bin` 目录，另加 `TMPDIR` 指向 `.runtime/temp`。不带 `/usr/bin`、`/bin` | 离线测试里真实 Gateway 用这个 PATH 跑通了。真实运行里宿主如果要找系统工具会找不到，那时再加 |
| Windows 名字的环境变量 | `USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、`TEMP`、`TMP` 在 Linux 的子进程里照样设，没有作用 | 少一处分支，原有的测试不用改。设计 Linux 部署时再清理 |
| 共用的 `.runtime` | 不做防护 | 一个 `.runtime` 在 Windows 和 WSL 之间、或两个容器之间共用时，活着的进程可能被判成“没了”。Linux 这边加防护管不了 Windows 那边。README 写了一个 `.runtime` 只给一个系统、一个容器用 |
| 经由符号链接运行 | 不是 Windows 时，`clo.mjs` 和 Q0、Q5 探测工具判断“是不是被直接运行”时，把 `argv[1]` 和自己的路径都解析成真实路径再比；`_env.sh` 的项目根用 `pwd -P`。包装脚本只支持链接文件夹：从别的文件夹链接到脚本文件本身时报错退出，因为包装脚本不用外部命令，读不出文件链接的目标。Windows 的比较没动：`clo.mjs`、Q5 工具不分大小写，Q0 工具区分大小写，都不解析链接 | 只在离线测试里验证过。Windows 上经由目录联接（junction）运行 `clo.mjs` 仍会什么都不做，没有改，也没有在 Windows 上试过 |
| 私有 Node 的位置 | `.runtime/node/bin/node`。`doctor` 在 Linux 上比较解析符号链接之后的真实路径，Windows 上仍是原来不分大小写的比较 | |
| 跳过的测试 | 不是 Windows 时跳过 8 个：7 个运行 `.ps1` 包装脚本的，1 个检查 Windows 环境变量形状的（它有两个 Linux 对应的测试，在 Windows 上跳过）。读 `/proc` 的测试在 Windows 上跳过。另有 3 个在运行时看机器决定：2 个要找一个系统不让看身份的进程，1 个要让写文件失败（root 下做不到，所以在这个容器里是跳过的。开发时换成普通用户手动跑过一次，只是开发者自己报告的，完整运行里没有它）。找“系统不让看身份的进程”时跳过 1 号进程，这个容器里找到的是内核线程。Windows 上另跳过 10 个运行 `.sh` 的测试（`lifecycle.test.mjs` 4 个，`setup-sh.test.mjs` 6 个），所以 Windows 上跳过的 LINUX_ONLY 一共 14 个。`entry-symlink.test.mjs` 里经由符号链接运行的一组测试在 Windows 上也跳过（Windows 上建目录链接要管理员权限，Windows 也保留原来的比较）；`private-modes.test.mjs` 里检查文件模式的一组测试和 `qq-send-probe.test.mjs` 里检查结果文件模式的 1 个测试在 Windows 上也跳过（Windows 没有模式位，写法不变）；`env-proxy.test.mjs` 里直接启动控制台的一组测试在 Windows 上也跳过（Windows 上控制台不因为环境代理拒绝） | 每一处跳过都列在 `tests/unit/platform-skips.test.mjs`，没列的跳过会让这个文件失败 |
| 宿主的日志目录 | `render.js` 给 `openclaw.json` 加了 `logging.file`，指向 `.runtime/logs/host/openclaw-YYYY-MM-DD.log`，两个级别仍是 `silent`。只用宿主支持的配置项，不改上游代码。文件名用这个形式，宿主照样按天换文件、删掉 24 小时以前的。Windows 上日志也从 `.runtime/temp/openclaw` 移到同一个位置。`doctor` 新增 `host_log_level`（两个级别都要是 `silent`）和 `host_log_file`（路径要在项目的 `.runtime/logs/host` 里，Windows 上不分大小写；指到 `.runtime` 的别的目录也不通过，因为宿主按天删旧日志就在日志所在的目录里删）。`gatewayEnv` 只在测试模式下把 `CLO_TEST_HOST_LOG_LEVEL` 换成 `OPENCLAW_LOG_LEVEL` 传给宿主，真实启动不传；`doctor` 看到子进程环境里有 `OPENCLAW_LOG_LEVEL` 就报错。已有的安装在运行 `clo apply` 之前，`render_fresh` 和 `host_log_file` 两项检查不通过 | 用户在 2026-11-16 决定在 Ubuntu 上用两种运行时做真实 QQ 测试时，接受了改 `render.js` 和渲染基准文件。`tests/e2e/host-log-dir.test.mjs` 起真实 Gateway（mock QQ、mock 模型），每个栈跑一个 @ 回合：`silent` 时 `.runtime/logs/host` 和 `/tmp/openclaw` 都没有新文件或改动；同一个文件里，用测试模式把级别调到 `info` 的栈确实写出了带日期的日志，只写在它自己的 `.runtime/logs/host` 里，`/tmp/openclaw` 没有变化，日志里也没有假 Key；同一个栈上第二个回合让 mock 模型返回带标记的错误，`info` 级别的日志里找得到这段服务方错误原文，这也是“没有假 Key”这项检查的正向对照。`info` 到 `trace` 级别、正常回合下，开发时没有在日志里看到消息正文，这只是一次手动观察，没有写成测试。`tests/e2e/provider-refusal.test.mjs` 在两个平台上都改读 `.runtime/logs/host`；主栈是 `silent`，这个目录一直是空的，所以同一个文件末尾另起一个级别调到 `info` 的栈，跑一次同样的拒答，确认服务方文字确实写进了这个目录，作为同一次运行里的正向对照。只在 Linux 离线测试里看过，Windows 上没有跑过。`/tmp/openclaw` 的比较看的是整个共用目录，别的程序同时往里写会让测试失败 |
| 宿主在 Linux 上仍用 `/tmp/openclaw` 放临时文件 | 没有处理，只记在这里。日志已经不写这里，但锁定版本的宿主仍把它当作临时目录（0700，所有运行共用），放媒体、上下文映射之类的文件，`clo` 不清理 | 没有受支持的配置项能挪走它，不改上游代码。和“OpenClaw 状态和项目运行数据都放在 `.runtime/`”仍然不一致，只在 Linux 上 |
| 文件和文件夹的模式 | 不是 Windows 时，项目新建的文件夹 0700、文件 0600，和 umask 无关。`writeAtomic` 替换文件后一律 0600：原文件是 0400 这样更严的也不保留，因为项目之后还要读、还要重写它。已有的文件和文件夹只清掉组和其他用户的位，属主的位不动。只收紧 `.runtime` 下项目自己的东西；`ensurePrivateDirs` 拒绝 `.runtime` 以外的路径，项目根、`.env`、`config.json` 不自动改。`captures/` 文件夹在 Q0、Q5 工具写入时收紧，跨运行追加的结果文件在写第一行前收紧。实现在 `src/clo-plugin/lib/core/private-fs.js`，测试在 `tests/unit/private-modes.test.mjs` | Gateway 自己写的文件（会话库、宿主日志）的模式不归项目管，宿主进程的 umask 没有改，靠所在的 `.runtime` 子目录是 0700 挡住别人。`versions.lock.json` 被 `clo model lock`、`refresh` 重写后也是 0600，git 只记可执行位，不影响。测试都以 root 跑，root 不受模式限制，所以只用 `stat` 核对了模式位，没有以另一个普通用户试过读不读得到 |
| `doctor` 的权限检查 | `secret_modes`（失败）：`.env`、`.runtime/clo/gateway.token`、`clo.db` 和 `-wal`、`-shm`、`-journal`、`.v1.bak`，组或其他用户有任何一位就算。`file_modes`（提醒）：`config.json`、`.runtime` 和 `clo`、`logs`、`state` 目录、`effective.json`、`events.jsonl`、`gateway.log`（含 `.1`）、`q0-salt`、`q0b-dm-target`。只在完整级别查，所以 `clo start` 会因为 `.env` 被拒，`mode live` 不会。详情只写相对路径 | `.env` 是用户的文件，`start` 不替用户改，只叫用户 `chmod 600`。`apply` 在 `start` 的 doctor 之前运行，旧版本留下的 `gateway.token`、`clo.db` 已被它收紧，所以升级后只有 `.env` 可能让 `start` 停下。单独运行 `clo doctor` 时，没 apply 过的旧安装这两项也会报失败 |
| 动到的“不能改”的文件 | `docs/provider-contract.md` 第 0 节列为不能改的 `tests/harness/gateway.mjs`、`tests/e2e/` 下的几个测试和 `src/tools/q5-probe.mjs` 都加了只在不是 Windows 时走的分支，Windows 执行的语句逐字没变。契约第 0 节已经注明这个例外 | 用户已确认（2026-11-16，见上一节） |
| 需要 root 的 e2e | `tests/e2e/qq-first-run.test.mjs` 在 Linux 上要读每个进程的 `fd` 目录，确认只有记录里的进程在听 Gateway 端口。普通用户读不了别人的进程，这个断言会失败，所以这个文件在 Linux 上要以 root 跑 | 只在 root 下跑过 |
| `clo stop` 在 Linux 上查不到进程时 | 离线测试里“查不到就不发信号”只能在测试用的假 `/proc` 下造出来，而假 `/proc` 下本来就不发信号，所以那条测试在 Linux 上分不出 `stopGateway` 有没有在“不知道”时发信号，有分量的只有“记录保留”和退出码。真实 `/proc` 下造不出“不知道”，又不能为此改 Windows 也执行的 `stopGateway` | 已知缺口 |
| Linux 的 Node 条目 | `versions.lock.json` 里另加 `nodeLinuxX64`，原来的 `node` 条目（Windows）一个字不改，两者版本相同。`setup.sh` 在私有 Node 还不存在时，用 sed 按已知的行格式读这个条目，只认恰好一个 64 位小写十六进制的校验值，文件名和下载地址必须是由版本号推出来的那两个；装好 Node 之后再按 JSON 读一遍，两边不一致就停 | 没有用 Python：第 1 节不许为胶水代码加 Python 依赖。`versions.lock.json` 的这段格式由测试固定 |
| Linux 的安装脚本 | `scripts/setup.sh [--runtime]`，步骤和 `setup.ps1 -Runtime` 一样：下载、核对校验值（不对就删掉文件，什么都不装）、解压到 `.runtime/node`，根目录 `npm ci --ignore-scripts`，`.runtime/pkg` 按 `runtime-lock/` 执行 `npm ci`，再核对锁文件里的版本和完整性。和 Windows 不同的地方：锁文件缺失时直接停下，不会改用 `npm install`；只支持 x86_64；`curl -q` 不读用户的 curlrc；不拒绝以 root 运行（README 要求用普通用户） | 只用离线测试验证过：假的压缩包、假的 node，PATH 里没有 curl，npm 一次都没有真的跑过。在普通用户下、在 Ubuntu 26.04 上都没有跑过 |
| Linux 的包装脚本 | `clo.sh`、`start.sh`、`stop.sh`、`status.sh`、`doctor.sh` 都先 source `_env.sh`，再用 `exec` 让私有 Node 运行 `src/cli/clo.mjs`。`_env.sh` 清掉和 `_env.ps1` 同一组代理变量，另外清 `NODE_OPTIONS`（`_env.ps1` 不清，没有改），测试模式下把状态目录移到 `CLO_TEST_ROOT`，PATH 只在 npm 的子 shell 里改。`start` 不需要 Windows 那种 `--output-file` 绕法：Gateway 的输出直接写日志文件，不占调用方的管道 | 离线测试（`lifecycle.test.mjs`）里看到：`clo.sh start` 很快返回，假 Gateway 在 bash 退出后还在运行，`stop.sh` 能结束它；路径带空格时也能用。只在以 root 运行的容器里跑过 |
| 脚本禁用项 | `script-bans.test.mjs` 也扫描 `.sh`，新增的禁用项：按名字找进程（pgrep、pidof）、sudo 等提权、全局 npm 安装、apt 等系统包管理器、改 shell 配置文件、关闭 TLS 校验、Linux 防火墙、systemctl enable 和 crontab、屏蔽睡眠。每一项都有正向对照 | |
| 提示词观察测试不再在临时目录留文件夹 | `tests/e2e/qq-prompt-observation.test.mjs` 和 `tests/e2e-own/` 下的同名测试原来每次都在临时目录留一个 `clo-prompt-observation-*` 文件夹给人看。现在默认把观察结果以 JSON 打印在测试输出里，不写磁盘；设了 `CLO_KEEP_PROMPT_OBSERVATION=1` 才照旧写文件夹并打印路径。断言没有改 | 两个平台都适用，Windows 上没有跑过。`docs/wiring-trial.md`、`docs/group-chat-design.md` 已同步 |
| 控制台遇到 Node 的环境代理 | 不是 Windows 时，控制台启动时带了 `NODE_USE_ENV_PROXY`（除 `0` 和空值以外的任何值都算，24.22.2 实际只认 `1`）或 `--use-env-proxy`（命令行或 `NODE_OPTIONS` 里，去掉引号后提到 `use-env-proxy` 的都算，包括 `=true`、`=false`、下划线写法）就拒绝联网。只写了 `--no-use-env-proxy` 不算；它和打开的写法同时出现时照样拒绝，没有细分。只设了 `HTTP_PROXY` 这类变量时只提醒，不拒绝，也不从进程环境里删 | 只看启动时的情况，因为 Node 只在启动时读。拒绝而不是删：删了也撤不掉（见上一节）。`NODE_OPTIONS` 里的 `--require`、`--import` 能加载任意代码，直接运行时控制台不查，只有 `clo.sh` 清掉它。Windows 上不拒绝，Windows 上直接运行时会不会走代理没有试过 |
| 故意没做的 | Q0、Q5 探测脚本的 shell 版本；这个容器里没有运行的 npm 安装脚本怎么处理；SIGTERM 停止；`doctor` 在启动失败时打印的“退出码 timeout”；`CMDLINE_HINT` 的措辞（Linux 上“用更高权限启动”不一定是原因）；Linux 上的内存和时长；任何真实 QQ、OpenRouter、Anthropic 调用 | 这些要么改了会动 Windows 的输出，要么属于 Linux 部署，等用户决定做 Linux 时再做 |
| Linux 上的几处提示措辞 | 没有 `config.json` 时说 `cp -n config.example.json config.json`；own 运行时 `mode live` 的 `gateway_key`、`reconciled` 说“可洛进程”；群没有 owner 的提醒改成中文，带下一步的 `clo owner add <名> --id <成员ID>`。README 写项目路径最好不超过约 60 字节、只用 ASCII | 都是开发时选的说法。约 60 字节的界限来自走查时看到的约 62 字节，没有在真实部署上量过 |

## 用户定的（2026-11-17，搜索）

用户同意搜索规划里的全部推荐答案（“按推荐”），并决定先只做 own 运行时。表里的 D0 到 D7 是这次搜索规划里的编号，和下面“待定（决策点 D）”、`CLAUDE.md` 里的 D2、D3、D5 不是一回事。用户原话里的“D5 走甲”按规划的推荐（仍搜）记。

现状（2026-11-17）：写进了配置、生成的运行配置、启动时的环境、`doctor`，Sonar 的请求和响应读法（适配器）、可洛进程里的搜索客户端、搜索模型的价格锁定（`clo search lock`）、账本里的搜索层级、次数、搜索自己的暂停和对搜索 Key 的轻对账（见下一节），离线测试通过。判定、gate 里的搜索步骤、来源行、打开搜索的控制台命令都还没有写，所以现在一次搜索都不会发生；任何真实请求都没有发过。搜索打开时 `clo mode live` 一律拒绝（`search_rules`），直到真实探测做完、规则写进来。

| 项目 | 决定 |
|---|---|
| D0 搜索的路径 | 改写 `CLAUDE.md` §6“默认搜索方案”：own 运行时的 gate 在主模型之前直接调 OpenRouter 上的 `perplexity/sonar-pro`，用单独的搜索 Key（`CLO_SEARCH_API_KEY`），不经过 `web_search` 工具和 `@openclaw/perplexity-plugin`。主模型的请求里仍然没有工具。`CLAUDE.md` §7.1–7.5 不动 |
| 先做哪个运行时 | 只做 own。openclaw 运行时这一版没有搜索：`searchProvider` 不是 `none` 时配置校验、`clo apply` 和 `doctor` 都拒绝，并说明搜索只在 own 运行时 |
| D1 真实 @ 怎么知道要不要搜 | 每条真实 @ 和回复可洛，在搜索打开的群里多买一次 Haiku 判定，只问要不要搜和搜索词。搜索额度用完或搜索暂停时不买。这次判定不决定回不回，失败就当不搜 |
| D2 来源怎么进回复 | 程序在模型文字后面追加一行“来源：…”，只用接口实际返回的来源，QQ 里只写名称（`qq.urlMode:names`） |
| D3 搜索 Key 的对账 | 轻方案：搜索 Key 的每日限额是硬上限；本地有自己的层级和次数；按 UTC 日拿 `/key` 的 `usage_daily` 和当天的搜索行比；`clo.db` 不迁移，仍是第 2 版。未结算的搜索行到期按预留额结清，只多算不少算 |
| D4 插话搜不搜 | 第一版不搜。危险路线也不搜 |
| D5 对话接口是 Anthropic 时 | 仍搜，经 OpenRouter 到 Perplexity，用搜索 Key 自己的日限额作硬上限。告知草稿要写清：对话直连 Anthropic，搜索经 OpenRouter |
| D6 “这个我不查”谁来说 | 主模型说：程序把“拒绝”状态交给它，问题里能答的部分照常答 |
| D7 启用的范围 | 全局开关算一次模型变更：清 D3 和每个群的“已告知”，启用 QQ 时要 `--qq-platform-notified`。再加每群开关，先只在测试群开 |
| 金额 | 搜索 Key 的每日限额和付费探测的上限还没定。配置要求写明 `budget.searchKeyDailyLimitUsd`，没写就不能打开搜索；不替用户填数 |

## 开发时定的，用户还没有确认（2026-11-17，搜索）

都只在离线测试里验证过。用户不同意的话，按用户的决定改代码。实现合同是 `docs/search-contract.md`。

| 项目 | 现在的值或行为 | 说明 |
|---|---|---|
| 配置的形状 | `searchProvider` 取 `none` 或 `openrouter-sonar`。打开时还要 `acks.search`（`{provider, at}`，以后由 `clo search enable` 写，手改 `searchProvider` 不够）和正数的 `budget.searchKeyDailyLimitUsd`。可选的 `search` 块：`perAnswer`、`perDay`、`maxTokens`、`resultMaxChars`、`queryMaxChars`，另有 `timeouts.searchMs` 和每群的 `qq.groups[id].search` | 模型不能配置，换模型就是模型变更 |
| 次数和长度的上限 | 每次回答 2 次、每天 10 次，配置只能调低。默认和上限：`maxTokens` 600（上限 1000），`resultMaxChars` 1500（上限 3000），`queryMaxChars` 80（上限 80），`searchMs` 20000（上限 30000） | 任务书写的是“每次回答最多 2 次，每天最多 10 次”，这里理解成上限，允许更严。其余数字是开发时选的，没有真实数据支撑 |
| 生成的运行配置 | 搜索关着时 `effective.json` 一个字节都不变：不写 `search` 块、每群的 `search`、`searchKeyDailyLimitUsd`、`searchMs`。打开时才写，读取方发现不认识的搜索块，或搜索块出现在 openclaw 运行时上，就当作没有配置 | 和 `apiProvider` 一样 |
| 搜索的地址 | 默认 `https://openrouter.ai/api/v1`。测试模式可以用 `search.baseUrl` 指到本机；没写时跟着 OpenRouter 的测试地址 | 正式运行不能改地址 |
| 子进程里的名字 | 搜索 Key 只在搜索打开时交给可洛进程，名字是 `CLO_SEARCH_KEY`；`.env` 里的名字 `CLO_SEARCH_API_KEY` 照旧不许进任何子进程，Gateway 两个名字都拿不到 | 它不算模型 Key，可洛进程里仍然恰好一个模型 Key |
| 和对话 Key 相同 | live 下搜索打开时，`clo start` 和 `doctor` 发现搜索 Key 和 `CLO_CHAT_API_KEY` 是同一个就拒绝，不打印值 | 和探测 Key 的比较放在以后的 `clo mode live` 检查里，`clo start` 不读探测 Key |
| live 的拦截 | 新增 `search_rules`：搜索打开时 `clo mode live` 拒绝，live 下手改打开搜索时 `clo apply` 也拒绝。常量 `SEARCH_RULES_RECORDED` 现在是 false，真实探测确认 Sonar 的字段和价格、规则写进来之后才改 | 照 `provider_rules` 的写法 |
| `doctor` | openclaw 运行时保留 `search_off`，提示搜索只在 own 运行时。own 运行时换成 `search_config`：可洛进程的环境里有搜索 Key 的名字，当且仅当搜索打开，并且 `effective.json` 和 `config.json` 一致 | |
| 搜索请求的内容 | 只有模型、`stream:false`、`max_tokens`、`usage:{include:true}`、一段固定的系统指令和一条搜索词。没有历史、发言人代号、群和成员编号、`user` 字段和归属请求头 | 字段名没有用真实请求核实 |
| 来源从哪里读 | 三种写法都读：`choices[0].message.annotations[]` 里的 `url_citation`、顶层的 `search_results`、顶层的 `citations`。有可用标题用标题（去控制字符、带网址或括号的不要，最多 30 字），没有就用网址主机名的主要部分（比如 `reuters`，不带点，所以不会被当成网址）。重复的只留一个，最多 5 个。网址本身不出适配器 | 哪一种是真的没有核实。一个可用来源都没有时，适配器把这次结果标成 `no_source`，Sonar 的文字不交出去 |
| 搜索模型的价格 | `clo search lock` 从 OpenRouter 模型目录读 `perplexity/sonar-pro` 的价格（不带 Key），写进 `versions.lock.json` 的 `models.locks.search`。`prompt`、`completion` 按每百万 token 换算，`request` 和 `web_search` 当作每次调用的固定费用加在一起。目录里还有别的不为零的价格字段，就拒绝锁定。第一次锁定、价格有任何变化（涨或降）、输出价超过每百万 $30，都要 `--confirm-price`。锁价不算模型变更，不记进 `models.changes`；打开搜索时才算 | 按次收费的字段名没有核实。没有锁价时运行配置里的搜索价格是 null，账本不给搜索预留，所以不会搜索 |
| 一次搜索的预留 | 按 4000 个输入 token、`maxTokens` 个输出 token 和每次的固定费用算最坏数。用 mock 价格（输入 $3、输出 $15 每百万，每次 $0.005）是 $0.026 | 4000 是给检索内容留的余量：Sonar 算不算进输入 token 不知道。结算超过预留就只停搜索（`cost_above_hold`），由 owner 解除 |
| 结算的算法 | 有上报的费用就按上报的（这是搜索 Key 实际被扣的）；没有就按 token 乘锁定价再加每次的固定费用；都没有就记未结算，按预留额计 | 上报的费用含不含按次费用没有核实 |
| 搜索行 | 层级 `search`，类别 `search`，`provider` 列写 `search`。所以对话 Key 的对账既不拿它解释读数，也不会把它结清或按 0 结清。只在 own 运行时、搜索打开、没有搜索暂停、当天总花费加上这次预留不超过 `searchUsd` 时才能预留。全局付费暂停和当前对话接口的硬上限暂停也挡住搜索 | 搜索没有对话就没有用处，所以对话停了搜索也停 |
| 次数怎么数 | 每次回答的次数和每天的次数（上海日）都是计数器，和预留在同一个事务里：任何一项被拒，整个回滚，计数不变 | 两个进程同时抢也只成 10 次（`tests/unit/quota-atomic.test.mjs`） |
| 搜索自己的暂停 | 控制项 `search_paused`，只停搜索，不碰付费暂停。连续 3 次失败停（`fail`），10 分钟后放一次试探，成功就解除，owner 也可以解除；402 或 OpenRouter 的限额来源停（`key_limit`），读到搜索 Key 还有余额才解除；读不到搜索 Key（启动时一次，之后连续两次）停（`key_read_failed`），读到就解除；对账差额连续两次超过阈值停（`residual`），读到对得上就解除；结算超过预留停（`cost_above_hold`），只有 owner 能解除。等级高的不会被低的覆盖 | owner 用 `clo budget clear-search-pause` 解除，只能解除 `cost_above_hold` 和 `fail` |
| 轻对账 | live 下可洛进程启动后的第一次心跳、之后有新的搜索行或结算、有没结清的搜索行、有读 Key 才能解除的暂停时、或者每 10 分钟，用搜索 Key 读 `搜索地址/key`。拿 `usage_daily` 和本机当天（UTC 日）搜索行的合计比（结清的按实际，释放的按 0，其余按预留额）。阈值和对话那边一样：$0.25 和读数的 15% 取大的。读数里没有 `usage_daily` 算读取失败。Key 的限额和 `budget.searchKeyDailyLimitUsd` 不一样、或不是按日重置，告警一次。不写 `key_snapshots`，不把差额记成行 | 依赖 `usage_daily`，没有核实这个字段存在、多久更新 |
| 到期的未结算搜索行 | 未结算超过 15 分钟（`budget.unsettledClearMs`）就按预留额结清，来源记 `search_hold`。之后没有别的未结算行时，崩溃或缺用量造成的付费暂停照常解除 | 对话接口是 Anthropic 时也一样 |
| 可洛进程里的搜索 Key | 只有运行配置里搜索打开时才用；和对话 Key（OpenRouter 或 Anthropic）相同就不用。出口把它当作密钥，含它的文字不发 | 和 `clo start` 的检查重复，防的是不经 `clo start` 启动的情况 |
| 运行中的规则检查 | 可洛进程发搜索请求前不再检查 `SEARCH_RULES_RECORDED`，只靠 `clo mode live` 和 `clo apply` 拒绝 | 运行时也拦的话，离线的端到端测试没法在 live 下测搜索。手改运行配置成 live 绕过控制台的情况，对话那边的 Anthropic 有运行时检查，搜索这里没有 |
| 状态显示 | `clo status` 和 `clo budget show` 在搜索打开、或有搜索暂停、或当天有搜索花费时多一行：当天次数、花费、`searchUsd`、搜索暂停、配置的搜索 Key 日限额 | |

## 待定（决策点 D）

| 编号 | 问题 | 依据 |
|---|---|---|
| D4 | 路线 B（自写通道）是否可行；不通时才讨论打补丁的官方插件 | 离线接线试验，以及测试群上的运行 |
| D5 | 告知和同意：内容、是否群公告、是否首条披露 AI、投诉渠道、未成年人、是否保留私聊陪伴、危险时是否通知 owner、每个群是否打开显示名开关 | Q0 |

另外待定：正式运行的省钱办法，每一项都没有实现，各自写了什么时候再定，见 [docs/cost-options.md](docs/cost-options.md)。

另外待定，要用户决定：own 运行时的连接重试不另外预留，用的是这个回合原来的那一份预留，而用户定的是“在期限内重试一次，并单独预留”。这个不一致已经记在“自己的运行时里和上一节不一致的地方”，接口层的改动没有动它，两种接口上都一样。是照用户原来的决定改代码，还是接受现在的做法，还没有定。

## 已废弃的结论

不要再引用：
- “QQ 没有封号风险”，或“平台没有针对 AI 的规则”。
- “Sonnet 5.5 可关闭思考”。
- “OpenClaw 会检查插件的 peer 范围”。
- “2026.9.36 可作为等价回退”。
- “空白名单会自然耗尽事件”。
- “每天费用 $1.32–2.04”。
- “提示词能满足合规要求”。

## 平台实测得到的事实

除下列“已观察”的项目外，其余都来自源码和文档阅读，尚未实测。样本都很小，通常只有一两个账号和一两个临时测试群。

| 已观察 | 结果 |
|---|---|
| 连接 | 取得 token，经 `api.sgroup.qq.com` 取得网关地址，以意图 `1 << 25` 收到 READY |
| 没开全量时 | @ 消息事件为 `GROUP_AT_MESSAGE_CREATE`，正文去掉 @ 后留一个前导字符，没有 `mentions` 字段，也没有 @ 标记。不带 @ 的消息未到达 |
| 全量模式 | 群主打开读取全部消息后，所有消息都变成 `GROUP_MESSAGE_CREATE`，**@ 事件被替代**。@ 机器人：`mentions[0]` 为 `scope:single, bot:true, is_you:true`。@ 普通群友：`scope:single, bot:false, is_you:false`。**@所有人：`scope:all, is_you:true`，`bot` 缺失**。正文保留 `<@…>` 标记。只提名字、带网址的消息照常到达且无 `mentions`。作者都是 `bot:false` |
| 谁能打开开关 | 机器人 QQ 只是管理员时，开关由群主在机器人入群后打开（入口：群成员名单点机器人头像，或群机器人选项里的管理按钮）。这条路径在测试群可行，真实群尚未试。入群时收到 `GROUP_ADD_ROBOT`。没有验证未做个人认证的机器人 |
| 普通群友 | 没有列入开发体验用户的群友，在测试群里 @ 能到达，不带 @ 的消息能触发被动回复，也看得到回复。真实群尚未试 |
| ID | 同一发送者在两个群的 `member_openid` 散列相同（样本：一个发送者）。两个账号私聊的 `user_openid` 与群里的 `member_openid` 散列也相同。和计划里的推测不符，样本很小 |
| 私聊 | `C2C_MESSAGE_CREATE` 到达；加好友时另有 `FRIEND_ADD`。既不是机器人主人、也没列入开发体验用户的账号，加好友按钮是灰色的，发不了私聊。这一版私聊一律不回 |
| 连接稳定性 | 约每小时一次关闭码 1000，随后自动恢复（RESUMED），2 到 11 秒。偶有 1006 和取 token 的网络错误，也自行恢复 |
| 断线补发 | 两次对照，都是断网后以 RESUMED 恢复原会话，断网期间的消息（不带 @、@、私聊）都没有补发。**官方事件页写明短时间内重连会补发遗漏事件，和这两次样本不符。** 文档说的“短时间”有多短未知，更短的断线可能不同。设计上按“会丢”处理，不开启会话持久化；去重和陈旧判断仍保留，因为 SDK 警告重连可能重复投递 |
| 历史消息接口（读文档，未探测） | 官方文档的群聊和单聊消息接口只有发送、撤回、流式和媒体上传，没有读取或列出消息的接口。**不会去试探未公开的接口** |
| 被动回复 | 对不带 @ 的消息做被动回复：HTTP 200，群里看得到。之后 20 秒内没有收到机器人自己的消息。**当时主动发言关着，所以被动回复未 @ 的消息不需要这个权限**（一次样本） |
| 网址 | 被动回复含纯文本 `https://example.com`：HTTP 200，完整显示、能点开，没有出现 40054010。**只测了 example.com，其他域名可能不同** |
| Markdown | `msg_type:2`：HTTP 200，未见 40034127，显示为可点的链接 |
| 主动私聊 | 不带 `msg_id`，沉默约 78 分钟后，对一个账号：HTTP 200，看到了。只测了一次，48 小时以上沉默后的复测（Q10）未做，提醒仍不算可用 |
| Q3 真实连接 | 名单为空时，普通消息和 @ 都记为 `gate_drop not_admitted`，没有回复。只监听 loopback，花费 $0 |
| 连接超时时的发送（已改，真实 QQ 上未单独观察） | 部分网络路径上新连接容易超时，原因未知。SDK 把网络错误包成 `httpStatus: 0` 的 `ApiError`，不保留原始错误，原来一律记成 `uncertain`，所以模型费用已花而对方收不到回复。现在只有确认没发出去的（连接超时、连接被拒、DNS 失败、取 token 的网络错误）才用同一 `msg_seq` 重试，最多 4 次，每次重试前后都重查暂停、模式、名单和被动窗口。其他一律还是 `uncertain`，不重发。4 次都失败记为 `failed`（`send_not_connected`）并告警。插话只试 1 次。已知限制：`fetch` 会跟随重定向，服务器处理完 POST 再重定向到连不上的地址时判断会错，靠同一 `msg_seq` 让平台去重（QQ 是否按此去重未验证）；`/stop` 现在也停正在重试的回复（只在模拟环境验证过）；多个地址全部被拒时文字可能只剩 `fetch failed`，按 `uncertain` 处理。**依赖 SDK 1.0.5 的文字格式**，格式变了只会退回 `uncertain`，不会多发 |
| 存活探测误判（已修，未根治） | 丢包时单次探测失败很常见，原逻辑“失败后恢复就重建连接”重建得太勤。改为连续 3 次失败才算可疑，又改为探测遇到确认没连上的错误先重试，一次探测最多 3 次。**新逻辑在真实网络上的效果待观察** |
| Q6 测试群 @ | **退出标准达到，但范围窄。** 18 次 @ 各一条回复，都是 HTTP 200，各一行预留且已结算，每回合一次模型调用，花费 $0.2382，与 Key 增量基本一致。回复没有重复，包括重试过的两条。普通消息静默，没有判定调用。空闲重启后恢复计数 0，没有补发；**当时没有回合在跑，也没有收到重复投递，所以去重和回合恢复没有被真正考验。** 回合耗时中位数约 11 秒。连接超时重试：26 次尝试失败 6 次，都在第二次成功。文字不在 `clo.db`、日志和 `openclaw.sqlite` 里，在会话库里（已告知）。工具只有惰性的 `clo_feature_status`。**全局暂停已验证：** 暂停时 @ 没有回复，记为 `paused`，没有模型调用和发送；恢复后没有补答。**上下文已验证：** 被静默的普通消息确实作为上下文到达模型。**没有验证：** 分群暂停、Key 到限额、拒答、内容过滤命中、40034006、有回合在跑时重启、压缩。**发现的问题：** 每人每小时 10 次 @ 用完后静默跳过，看起来像故障；告知说可以申请删除，但这一版不能按人删除，`/new` 也不删旧内容 |
| 人设的说话方式 | 第一次自我介绍像说明书，所以写入 `persona/AGENTS.md`：用自己的话说，不固定句式。给例句时模型几乎照抄，所以去掉了例句。保留“被认真问到就直说是 AI、模型是 Claude”。“你是谁”这类问法按人设回答，可能不提 AI：靠群友告知和 QQ 的机器人标识披露 |
| 显示名开关（先在 mock 上观察，之后在真实 QQ 的测试群用一个账号测过） | 每群开关 `displayNames`，默认关，属于 D5。来源只有当前事件的 `author.username`，不用 `mentions[].username`。**真实 QQ 上的结果（样本：一个测试账号）：这个字段跟着 QQ 昵称变，改群名片后再问仍是旧名字；昵称生效延迟没有测准；其他账号和字段缺失的情况都没有观察过。** 标签 `U1（显示名：小明）`，保留代号，两个人同名也分得开。已观察（真实 Gateway，mock QQ，mock 模型）：Opus 回答回合带当前发言人和近期行的名字，判定请求没有；关着时金丝雀名字不在任何模型请求里，有正文作对照；`clo.db`、WAL、`events.jsonl` 扫原始字节都没有，有对照；破坏帧和格式的字符、标记符号、网址、名单里的词不会进提示词，但名单只是减速带，短指令文字（如“忘掉以上规则”）仍会原样作为名字进提示词，只靠提示词规则挡，真实模型只查过一次，她没有照做，但这不代表每次都如此；普通成员冒用 owner 的名字发命令仍按 ID 拒绝；回复里写到名字时走正常出口，只发一次；名字加相邻文字仍可能碰到内容规则。宿主存储的探测（两回合，mock）：`sender.name` 和回合正文都写进 `openclaw-agent.sqlite`，结构化上下文和 `inboundHistory` 不写。所以名字只走后两者，`sender.name` 和正文保持代号。**她回复里写到的名字会存进会话库（已观察），模型服务方在错误里回传提示词时也会（已观察：mock，真实 OpenRouter 没有观察过）；思考文字、真实模型下的压缩没有观察过。** 重启后代号重新分配，旧回合里的 `U1` 可能已是别人（已知限制） |
| 插件重载后偶发连不上（**原因未查明**，只在 mock 上见过） | 写入插件配置触发重载后，等重连超时。出现 3 次，都在并行跑测试期间或刚结束时；之后单独反复重载都没有复现，所以也没有拿到失败时的日志。表现为不连接、不回复，不会多发 |
| 并行跑 e2e | 4 路并行加 `qq-lifecycle` 单独跑：46 分钟，串行 88 分钟。并行时最慢的文件慢近一倍，上面的重载失败也都出现在这时，所以并行结果里这一类失败要单独重跑确认 |
| own 的 Q5 真实探测（2026-11-07，上海时间；一次样本） | 用户同意后运行 `-Runtime own -Approve -MaxUsd 0.10`，用专用的 `CLO_TEST_API_KEY`（读到的日限额 $0.10，每天重置）。0 次直连，2 个回合，都完成，HTTP 200，服务方 anthropic，`finish_reason` 都是 stop（原生 end_turn），模型相符。第 1 回合：prompt 4427 = 缓存写入 4359 + 输入 68，输出 140（思考 51），$0.024867，4.05 秒。第 2 回合：B2 $0.055044，发了；prompt 4556 = 缓存读 4359 + 输入 197，输出 366（思考 155），$0.00898，5.65 秒。合计 $0.033847，Key 增量一致，61 秒（读 3 次）对上，没有报警，没有缺用量。**由此观察到的（一次）：** own 的系统块是 4359 个真实 token（之前估 4350–4400）；请求形状（带 `cache_control` 的系统 content part、effort low、`max_tokens` 1200、`require_parameters`、没有工具）被接受；缓存先写后读 4359；两回合的费用都等于 token 乘目录价。**没有观察到：** own 下的判定调用、真实 QQ、gate、出口和账本（探测里没有）、拒答、1 小时缓存、中止的请求怎么计费；回答内容没有记录，人设和回答质量没有观察。这次探测不算 own 的 Q5 阶段（Q5 要真实模型加 mock QQ），Q3 到 Q7 在 own 上都没有做。数字见 `DEPLOYMENT.md` |
| Q5 真实探测 | 全部成功，花费 $0.0559，Key 增量一致，61 秒对上。数字见 `DEPLOYMENT.md`。**小样本，回复内容未记录，人设和回复质量未观察；没有遇到 403、拒答、429。** 第一次启动在付费前被工具拒绝（花费 $0）：真实目录的 `input_cache_write_1h` 和 Haiku 的 `overrides` 是 mock 没有的字段。改为两者都要过价格上限检查，超过仍然拒绝。这说明 mock 目录和真实目录有差别 |
| Q4 采集和真实分类 | dry-run，测试账号。5 条样例：普通消息、@ 群友或手打 @、@所有人、文字提名字都是 `interject_off`，真实 @ 是 `would_at`。没有调用模型，没有发送，花费 $0。样例里的标记词没有落盘。**每种消息只测了一条** |
| 群聊版离线构建 | 独立复核跑了两遍全量，单元 731、接缝 29、端到端 164，0 失败，0 跳过。端到端用真实 Gateway，QQ 和模型都是 mock。详见 `docs/group-chat-design.md`、`DEPLOYMENT.md` |
| 斜杠文本（真实 Gateway，mock QQ，mock 模型；不是真实 QQ） | 宿主对已知命令不调模型，带参数和大写的也一样；其他斜杠开头的文字交给模型。逐项结果在 `docs/group-chat-design.md` 第 5.4 节。owner 发的只测了一部分 |
| 拒答和未结算的暂停（F13） | 单次模型拒答、`/stop`、超时不再暂停付费，连续 3 次失败才暂停（暂定，现在只指主模型）。没有 Key 扣费的未结算行，15 分钟且至少读 3 次 Key 后按 0 结清（暂定）。比最初任务书的“结算不明时暂停”宽松，依据已批准计划的结算规则 |

## 根据实测对计划的修正

已批准计划的 G6 写的是“`GROUP_AT_MESSAGE_CREATE` 或 `mentions[].is_you`”，**这个规则是错的**：@所有人的 `is_you` 也是 true。改为：

- 真实 @：`GROUP_AT_MESSAGE_CREATE`（全量未开时），或存在 `scope==='single' && is_you===true` 的 mention。
- `scope==='all'` 算普通消息。
- `mentions[].bot===true` 不再作为备用信号，因为 `is_you` 已确认存在。
- `normalize` 必须先去掉正文里的 `<@…>` 标记再交给模型，这些标记含有 ID。

## 离线接线试验的结果（详见 `docs/wiring-trial.md`）

路线 B 能接入真实的 OpenClaw 2026.10.9（只模拟 QQ 和模型，经独立复核，53 项 e2e 两轮通过）。这不证明 QQ 上线可行。

Q1 要按此修改计划：
- `tools.deny` 不能写 `group:*`，否则每个回合都失败；改为逐项列出。加 `tools.toolSearch:false`。
- 插话要 `agents.defaults.silentReply.group:'allow'`，否则每次沉默都多花一次模型调用，还会产生错误文本。
- 必须被回答的回合返回 `NO_REPLY` 时会花两次模型调用，再出一条 `isError`。出口要丢弃它，改发固定句并通知 owner。
- `session.dmScope` 明确设为 `per-channel-peer`，默认值会把所有私聊放进同一个会话。
- 会话键会转成小写。实测的真实 openid 都是全大写，碰撞不太可能发生，但 TQ15 仍要解决。
- `skipBootstrap:true` 保留 `AGENTS.md`，并去掉约 12000 字符的默认模板。`AGENTS.md` 前面还有约 5500 字符的宿主文字，包括“Write like a human”，内容范围和 AI 身份要自己写明优先级。
- 致命关闭要设 `terminalDisconnect`，否则宿主会自动重启连接。`/readyz` 不能当作 Gateway 存活信号。
- owner 在群里发 `/status` 会把费用、token 和会话键发到群里，要拦下或改到私聊。

待决定或披露：
- **提示词会把主机名、系统、shell 和含 Windows 用户名的路径发给模型提供方。** 要在 Q1 尽量减少，并在 D5 披露。
- **Gateway 每次启动都会尝试访问 `clawhub.ai`**，源码里没找到开关（测试中被拦截）。已决定接受并披露。

本文不是法律意见。
