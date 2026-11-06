# 离线接线试验报告（路线 B）

日期：2026-11-02。这是决策点 D4 的依据之一。

> **独立复核的修正（优先于下文）。** 复核者重跑了全部测试，两轮都通过（53 项 e2e），并用故意改坏代码的方式确认了主要测试确实会失败。结论“能接入”成立，但下文有几处需要修正：
> - 下文“计划的策略”少了 `group:*`。**按计划原样 deny `group:*`，每个回合都会在调用模型前失败**（`No callable tools remain`），必须改成逐项列出。
> - TQ13 不算通过：只有加上 `tools.toolSearch:false` 且去掉 `group:*`，工具列表才精确，而且还没有测试断言这一点。
> - TQ15 实测失败：会话键被转成小写，ID 只差大小写的两个群共用一个会话，上下文会串群。
> - `channelRuntime` 真正缺失的情况没有在真实运行中出现过，只在插件侧模拟过。
> - 这几项测试不够硬，Q1 要重写：CLI 零 POST 断言（不可能失败）、`plugins reload` 测试（把重载换成 `--version` 也能过）、单一出口扫描（漏掉多种 SDK 调用），以及“所有 POST 都合法”的检查（排在后面几项测试之前）。
> - net-guard 不覆盖 worker 线程和辅助子进程，也不是抓包。
> - OpenClaw 文档说**所有**插件 API 都是实验性的，不只是 ingress；`gateway.startAccount` 只有类型定义，几乎没有文档。升级前必须重测。

## 结论

**路线 B 能接入真实的 OpenClaw 2026.10.9 Gateway。** 自写的 `clo-qq` 通道基于 `@tencent-connect/qqbot-nodejs@1.0.5`，不需要 webhook，不需要打补丁，不需要 `@tencent-connect/openclaw-qqbot`。一条 `GROUP_AT_MESSAGE_CREATE` 事件走完了这条路：

mock QQ → SDK WebSocket → 我们的 gate → 真实 agent run → 真实 provider 路径 → mock 模型 → 我们的 exit → mock QQ 群消息路由。回复只发一次，带 `msg_id` 和 `msg_seq`。

**这不代表 QQ 上线可行。** 全程没有接触腾讯和 OpenRouter。平台资格、协议 §4.2、真实事件形状都没有被这次试验回答。代码是接线骨架，不是成品：没有去重、账本、内容策略，发送记录只在内存里。

## 跑了什么

- 宿主：真实 Gateway（`openclaw.mjs gateway run`），私有 Node 24.22.2。没有替换加载器、派发或插件宿主。
- 假的只有两端：`tests/harness/mock-qq.mjs`（真实 SDK 连它）和 `tests/harness/mock-openrouter.mjs`。密钥都是明显的假值。
- 每个 Gateway 用独立临时目录，`OPENCLAW_HOME`、`OPENCLAW_STATE_DIR`、`OPENCLAW_CONFIG_PATH`、`OPENCLAW_WORKSPACE_DIR`、`HOME`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、`TEMP` 全部指向它。子进程环境按白名单构造，代理变量和真实密钥进不去。
- `tests/harness/net-guard.mjs` 用 `--import` 预加载，记录并拒绝所有非 loopback 的连接和 DNS 查询。
- 全套 e2e（53 项）从干净临时状态连跑两轮，**两轮 53 项全部通过，0 失败**（第一轮约 14 分钟，第二轮约 13 分钟）。群回复和生命周期两份观察，两轮除时间、运行时长和 PID 外一致；提示词观察只比对了工具列表和关键结论。`tests/unit/qq-listener.test.mjs` 8 项也通过（`mock-qq` 只增加了计数）。

## 各 TQ 结果

| TQ | 结果 | 依据 |
|---|---|---|
| TQ10 纯 ESM SDK 加载 | **通过（已观察）**，未动用 npm-pack 回退 | 插件从 `plugins.load.paths` 加载；SDK 在 Gateway 进程内取 token 并 identify，意图值 `1<<25`。插件目录和 `.runtime/pkg` 都没有 SDK，依赖是从 `src/clo-plugin` 向上找到项目根 `node_modules` 的 |
| TQ11 生命周期 | **通过（已观察）** | 见下 |
| TQ12 群回复 | **通过（已观察）**，有一处必须由 exit 兜底 | 见下 |
| TQ13 工具和提示词 | 只观察，**`tools.allow` 默认不精确** | 见下 |
| TQ14 中止词和命令 | 只观察，只测了 `stop` | 见下 |
| TQ15 openid 大小写 | 未测，但发现相关问题 | 会话键被转成小写，见“进入 Q1 的问题” |
| TQ16 出口唯一 | **部分** | mock 收到的每个 POST 都是 token 或对已准入消息的回复；静态扫描只有 `exit.js` 调 SDK 发送面；CLI `message send` 被关闭的 `outbound.sendText` 拒绝，零 POST。没有做计划里的桩 fetch 版本，也没有 `sends` 持久行 |

### TQ11 明细

- `startAccount` 打开且只打开一个连接。
- `channels.stop` 触发 abort，socket 关闭，`startAccount` 返回，之后保持关闭；`channels.start` 重开一个。
- 改 `channels.clo-qq` 配置：账户重启，新增 1 个连接。
- 改 `plugins.entries.clo.config`（换代）：加载了新的模块实例，事件顺序是旧连接关闭 → 新 `startAccount` → 新连接。
- `openclaw plugins reload clo --wait`：新增 1 个连接。
- 整个过程 mock 记录的**同时连接峰值始终是 1**，之后推一条消息只有一次模型请求和一次回复。
- `enabled:false` 和完全没有 `channels.clo-qq`：无账户、无连接、mock 收到零请求。运行中改 `enabled:false`：socket 关闭且不重连。
- 致命关闭 4914：不会重连。这是我们的处理：捕获后设置 `terminalDisconnect: true`。宿主对“退出的通道”默认 5 秒起退避、最多 10 次自动重启（读源码；不处理时的重启没有单独跑）。
- **`ctx.channelRuntime`：** 每次运行真实宿主都传了，所以“缺失”无法在不桩宿主的情况下真实产生。试验用插件侧开关模拟：
  - 回退到 `api.runtime.channel`：完整回合成功。
  - 两者都没有：拒绝启动，零连接，宿主日志 `auto-restart skipped, terminal disconnect`，只调用一次 `startAccount`；`/readyz` 返回 503 并列出 `clo-qq`。这种情况下也不会打出 `[gateway] ready` 这一行。
- **scheduler：** 我们用 V1 适配器（不写 `apiVersion`），`ctx.scheduler` 实际也传了，V1 不要求它。V2（`apiVersion: 2`）的类型和文档写明必须有，宿主对两版提供同一能力（读文档，未跑 V2）。

### TQ12 明细

| 情形 | 模型请求 | QQ POST |
|---|---|---|
| 准入群 @ | 1 | 1，`/v2/groups/GROUP_ADMITTED/messages`，`msg_id`=入站 ID，`msg_seq`=1，`msg_type`=0 |
| 同群再一条 | 1 | 1，新 `msg_id`，`msg_seq`=1 |
| 准入私聊 | 1 | 1，`/v2/users/USER_ADMITTED/messages` |
| 未准入群、`author.bot`、未准入私聊 | 0 | 0 |
| 非 owner 的 `/status /new /reset /stop /clo pause /help` | 0 | 0 |
| @ 且模型回 `NO_REPLY`（含前后空白） | **2** | 0（靠 exit 丢弃，见下） |
| 非 @、`silentReply.group:"allow"`、模型回 `NO_REPLY` | 1 | 0，`deliver` 不被调用 |
| 非 @、默认策略、模型回 `NO_REPLY`（只跑过一次探测，不在测试集内） | 2 | 0（同样靠 exit 丢弃） |
| 模型硬调被拒的 `message` | 2 | 1，只有最终文字，工具文本没到 QQ |
| 模型经 `tool_call` 调 `message` 或 `exec` | 2 | 1，工具结果 `Unknown tool id` |

- `tools` 里没有 `message`，`tool_choice` 是 `auto`。提示词写明 “Your text replies are automatically sent”。`message` 被拒时自动回复正常，**没有强制工具路径**。
- **`NO_REPLY` 的实际行为（重要）：** 字面 `NO_REPLY` 不会被发出，但 @ 是“必须回复”的回合：宿主先追加一次付费重试（“The previous attempt did not produce a user-visible answer…”），再把 `⚠️ Agent couldn't generate a response. Please try again.` 作为 `isError` 的 final 交给 `deliver`。第一版骨架把这句发到了 mock 群里，测试因此失败。现在 exit 丢弃 `isError` 载荷（`host-error-text`），测试才通过。代价是被 @ 的人收不到任何东西；计划里的固定句要在 Q2 实现。

### TQ13 观察：模型看到的工具

| 配置 | 直接工具 | 延迟工具（可经 `tool_call` 调用） |
|---|---|---|
| `allow:[clo_feature_status]` + `deny`（计划的策略） | `tool_call` `tool_describe` `tool_search` | `clo_feature_status` |
| 同上 + `tools.toolSearch:false` | **`clo_feature_status`（精确）** | 无 |
| `allow:[]` + `deny` | `tool_call` `tool_describe` `tool_search` | 无 |
| 只有 `deny` | `apply_patch edit exec ls process read sessions_yield tool_call tool_describe tool_search write` | 26 个，含 `sessions_*`、`subagents`、`secrets`、`tts` 等，无 `message` |
| 无策略（对照） | 同上 11 个 | 28 个，**含 `message`** 和 `web_fetch` |

对照组说明 deny 确实起作用。建议计划补上 `tools.toolSearch:false`，这样工具列表才真正精确。

### TQ13 观察：系统提示词顺序

系统消息分两块，顺序是：

1. `openclaw:attempt:STABLE`：角色句 → Tooling → Deferred Tool Schemas → Tool Call Style → Execution Bias → Promised Work → Care → Runtime Context → OpenClaw Control → Workspace → Documentation →（Bootstrap Pending）→ Workspace Files → Project Context → `AGENTS.md` → `SOUL.md` → `IDENTITY.md` → `USER.md` →（`BOOTSTRAP.md`）
2. `openclaw:attempt:DYNAMIC`：Temporal Context → Assistant Output Directives → Messaging → Conversation Context（Message Context 和群聊说明）→ Runtime

**workspace `AGENTS.md` 的内容确实出现在系统消息里**，在 STABLE 块内，两个哨兵标记按序都在。默认配置下位于第 6073 字符（共 21829）；`skipBootstrap:true` 时也在，位于第 5576 字符（共 9777）。

对内容策略的影响：
- 它在工作区文件里最靠前，但**不是提示词最靠前**，前面有约 5500–6000 字符宿主文字。
- 把 `skipBootstrap:true` 当成“AGENTS.md 会消失”的检查是错的（已观察，它不会消失）。
- 不设 `skipBootstrap` 时，宿主会往新工作区写默认的 `SOUL/IDENTITY/USER/BOOTSTRAP.md` 并注入，多约 12000 字符，还加一段 “First visible reply must follow BOOTSTRAP.md”，会直接干扰人设。

### TQ14 观察（只测了 `stop`）

- 我们的通道拥有 socket，所以**宿主不可能抢在我们的 handler 之前拦截**；所有消息先过 gate。
- 过 gate 之后，宿主的中止看 `CommandAuthorized`：
  - 非 owner 空闲时发 `stop`：当普通文字，1 次模型请求，正常回答（要花钱）。
  - 非 owner 在别人的回合进行中发 `stop`：**没有中止**，两个回合都答完。
  - owner 在回合进行中发 `stop`：**中止了**，只发出 `⚙️ Agent was aborted.`（经 exit）。
- 非 owner 句中的 `/reset`（“帮我 /reset 一下”）：当普通文字。
- owner 的 `/status`：0 次模型请求，host 的状态文字经 exit 发到**群里**，含版本、时间、运行时长、模型。Q2 要决定是否允许进群。

## 进入 Q1 的问题

都是这次实际看到的，除非另外注明。

1. **会话键被转小写：** `agent:main:clo-qq:group:group_admitted`。计划说 openid 区分大小写，只差大小写的两个 ID 会落到同一会话（读 `session-key` 源码推断，未构造碰撞）。发送路径不受影响，exit 用的是原值。TQ15 要处理这件事。
2. **`session.dmScope` 默认把私聊并进主会话：** 不设时键是 `agent:main:main`；设 `per-channel-peer` 后是 `agent:main:clo-qq:direct:user_admitted`。必须显式设置。
3. **提示词会把本机信息发给模型服务方：** `host=<机器名>`、`os`、`shell`、工作目录和文档路径（含 Windows 用户名）、会话键。这要写进 D5 的披露，或者想办法减少。
4. **宿主固定文字与项目规则有张力：** 群聊说明含 “Write like a human”、“mostly lurk”；仍提到 `message(action=send)`（告诉模型只在发文件时用，工具已被拒）。Execution Bias 写 “Actionable request: act now”。`AGENTS.md` 要明确优先级。
5. **宿主启动时会访问外网：** `models.catalogRefresh.enabled:false` 能关掉 `catalog.openclaw.ai`；但 `clawhub.ai` 的官方插件目录由启动后的预热任务（`server-startup-post-attach` 的 `plugins` 项）发起，**读源码没有找到开关**。试验里被 net-guard 在 DNS 之前拒绝，没有请求发出；真实运行时它会发出。e2e 的网络断言明确排除了这一个主机，其他任何主机都算失败。
6. **每个 NO_REPLY 的 @ 回合是两次付费调用，** 账本预留要算进去。
7. **插话路径需要 `silentReply.group:"allow"`，** 否则非 @ 的静默也会触发重试和错误文字。
8. **`/readyz` 和 `[gateway] ready` 受通道状态影响：** `clo-qq` 停止时 `/readyz` 是 503。`status` 和 doctor 不能把它当成 Gateway 存活判断。
9. **`rt.inbound.ingress.resolve` 对非官方插件可用，** 返回 `dispatch`/`activation_allowed`；骨架只记录、没有按结果拦截，Q1 要决定。
10. **SDK 依赖靠目录向上查找解析，** 插件必须留在项目内；挪到别处或走 `plugins install` 没有试。
11. **首回合慢：** Gateway 启动约 25–45 秒，第一回合 mock 模型瞬时返回也要约 16–20 秒（工具目录等），之后每回合 2–3 秒。这是一次测试的值，且测试时只有一个 Gateway。

## 依赖的宿主接口

| 接口 | 状态 |
|---|---|
| `defineChannelPluginEntry`、`createChannelPluginBase`、`createChatChannelPlugin`（`plugin-sdk/channel-core`） | 公开文档 |
| `gateway.startAccount(ctx)`：`abortSignal`、`account`、`cfg`、`getStatus`、`setStatus`、`scheduler` | 公开类型；文档只有零散提及 |
| `ctx.channelRuntime`；回退 `api.runtime.channel`（经 `setRuntime`） | 类型注释写明可能缺失；后者公开文档 |
| `runtime.channel.routing.resolveAgentRoute` | 公开文档 |
| `runtime.channel.inbound.run`，`adapter.ingest/resolveTurn`，路由式 plan 的 `delivery.deliver` | 公开文档 |
| `runtime.channel.inbound.buildContext`，传 `channelIngress` | 公开文档，文档主要面向内置通道 |
| `runtime.channel.inbound.ingress.resolve`、`defineStableChannelIngressIdentity` | 公开文档，**标注实验性** |
| `deliver` 返回 `suppression: {reason:"channel_transform"}` | 公开文档 |
| 载荷 `isError`，`info.kind` | 公开类型，通道文档未说明其含义（靠观察） |
| `replyOptions.disableBlockStreaming` | 公开类型，通用文档未说明 |
| 状态字段 `terminalDisconnect` | **类型里有，文档没有。行为靠读源码和观察**；停止重启这件事依赖它 |
| `reload.configPrefixes` | 类型和文档都有提及 |
| `api.registerTool` + manifest `contracts.tools` | 公开文档 |
| `outbound.deliveryMode/sendText` | 公开文档 |
| `openclaw/plugin-sdk/*` 由加载器别名解析（项目根没有装 `openclaw`） | 文档写明“由宿主提供” |
| 配置：`plugins.load.paths/allow/slots`，`channels.<id>`，`messages.visibleReplies`，`session.dmScope`，`tools.allow/deny/toolSearch`，`agents.defaults.silentReply/skipBootstrap/heartbeat`，`models.providers.*`，`models.catalogRefresh`，`update.*`，`discovery.mdns`，`cron.enabled` | 公开文档 |
| CLI：`gateway run`，`gateway call channels.stop/start`，`plugins reload`，`message send` | 公开文档 |

没有用未导出的内部模块，也没有 patch dist。腾讯插件的 `dispatch.ts` 只读过，确认宿主调用方向，没有复制代码。

## 观察到的和读到的

- **观察到的：** 上面表格里的所有结果。
- **只读源码或文档，未运行：** V2 适配器要求；宿主对通道退出的自动重启策略；会话键小写造成碰撞；`clawhub.ai` 预热没有开关。
- **net-guard 的边界：** 它钩的是 `net.Socket.connect` 和 `dns.lookup`，不是抓包。没有验证 worker 线程里也生效（记录到的命中都来自主流程）。“没有外发”的依据是这个钩子，加上所有 provider 地址都指向 mock。

## 还不知道的

- 真实 QQ 的一切：事件形状、`is_you`、全量模式、发送错误码、资格门槛。
- 真实 OpenRouter 的请求形状。OpenRouter 插件按 base URL 判断是否走原生路线，mock 的地址不是 `openrouter.ai`，所以这里没有归因头、`reasoning` 或缓存标记。Q5 要重查。`models.providers.openrouter.request.allowPrivateNetwork` 是这次测试才用的配置。
- 优雅停机。Windows 上只测了 `taskkill /T /F`（当时 Gateway 由启动器派生，进程 ID 不同；停止后已确认都不在了。现在记录的 PID 就是 Gateway 本身，没有启动器）和 `channels.stop`。没有测 Ctrl+C、关机、睡眠。
- 重启后的去重和 SDK 重连时的重复投递（骨架没有去重）。
- 回合进行中重载通道时，迟到的 `deliver` 会怎样（exit 持有的 SDK 对象已经停止）。
- 同一回合多段回复、长回复分段（只见过一个 final）。
- `before_agent_run` 哨兵（TQ27）、`before_tool_call`、记忆、提醒、搜索、压缩：这次都没接。
- 其他中止词（`停止`、`暂停` 等）。owner 的私聊 ID 路径。
- 全量模式事件下 `@` 和非 `@` 的真实分类。这里 `GROUP_MESSAGE_CREATE` 就当非 @。

## 如何重跑

```powershell
cd <项目目录>
.\.runtime\node\node.exe --test --test-concurrency=1 --test-reporter=spec "tests/e2e/*.test.mjs"
```

当时 53 项约 13–15 分钟，现在 e2e 文件多了，全量串行约 90 分钟。只连 loopback，不需要任何真实密钥，也不读 `.env`。`qq-prompt-observation` 把详细观察写到临时目录里一个新的 `clo-prompt-observation-*` 文件夹（含完整系统提示词）并打印路径，不写进项目。`%TEMP%` 下 `clo-e2e-*` 是临时目录，测试结束时清理。当时还有 `clo-e2e-compile-cache` 作 Node 编译缓存；现在 harness 关闭编译缓存（`NODE_DISABLE_COMPILE_CACHE=1`），不再创建它，旧的文件夹可随时删除。

文件：`src/clo-plugin/`、`tests/e2e/`（`qq-load`、`qq-lifecycle`、`qq-group-reply`、`qq-prompt-observation`）、`tests/harness/`（`gateway`、`mock-openrouter`、`mock-qq`、`net-guard`）。

本文不是法律意见。
