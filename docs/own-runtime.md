# 自己的运行时（own）：过渡期说明

用户决定去掉 OpenClaw，改用项目自己的小运行时（见 [DECISIONS.md](../DECISIONS.md) 的“去掉 OpenClaw，改用自己的运行时”）。这份文档写过渡期的情况：两套运行时都在代码里，怎么切换、怎么回退、改了什么、离线测试怎么对应。

## 现状

- **新运行时已经写好，放在配置项 `runtime: "own"` 后面。默认仍是 `openclaw`。** `config.example.json` 写的是 `openclaw`，没写这一项的 `config.json` 也按 `openclaw` 算。
- **现在真正在跑的仍是 OpenClaw 这条路。** README 和 DEPLOYMENT 里的真实 QQ 记录（Q3 到 Q7）全部是在 OpenClaw Gateway 上得到的，对新运行时不算数。
- **新运行时在真实 QQ 上的验收一项都没有做。** 没有连过真实 QQ。真实模型和真实 OpenRouter 只有一次付费探测（Q5，2026-11-07，两个回合，不接 QQ，见下面“付费探测”）。除了那一节，下面所有的“已观察”都是离线的：mock QQ、mock OpenRouter、临时目录、假密钥。
- 按决定，要在测试群里把 Q3 到 Q7 在新运行时上重做一遍，才把默认改成 `own`；改完默认之后，才删 OpenClaw 的代码和依赖，那时再改写 `CLAUDE.md` 里提到宿主的规则。在那之前，`CLAUDE.md` 写的宿主规则仍然适用于 `openclaw` 这条路。

## 切换和回退

同一个 AppID 只能有一个消费者。两套运行时共用一把启动锁和一份 PID 记录：一个在跑时，另一个启动不了；有一个在跑时，`clo apply` 也拒绝把 `runtime` 换成另一个，`config.json` 保持原样。

可洛进程不监听端口，所以它还在 `clo.db` 里写一条连接租约，每次心跳续期。如果 `clo start` 在写下 PID 记录之前被中断，可能留下一个 PID 文件里没有的可洛进程。这时：`clo start`（两种运行时都一样）看到新鲜的租约就拒绝启动；Gateway 里的插件看到它也不连接；`clo stop` 通过 `clo.db` 请它自己停下，不结束任何进程。`effective.json` 换成别的运行时后，可洛进程也会自己停下。这些只在离线测试里验证过。

`clo stop` 结束记录的可洛进程、确认它已退出后，也删掉 `clo.db` 里写着这个进程号的连接租约；写着别的进程号的租约不动。这样进程号被别的程序复用时，下次启动不会被误拒。只在离线测试里验证过。

**切到 own：** 建议先在 dry-run 下切，确认连接和分类正常，再进 live。

```powershell
.\scripts\clo.ps1 mode dry-run        # 建议：先退回 dry-run，不用重启
.\scripts\stop.ps1                    # 停掉 Gateway
# 在 config.json 里加上或改成 "runtime": "own"
.\scripts\clo.ps1 apply               # own 下只写 effective.json 和 system-prompt.md，不生成 openclaw.json
.\scripts\doctor.ps1
.\scripts\start.ps1                   # 启动的是 src/bot/main.mjs，不监听端口
.\scripts\status.ps1                  # 看“运行时：配置为 own”，再等“连接：已连接”
```

确认之后再 `.\scripts\clo.ps1 mode live`，它的检查和 OpenClaw 路线一样。

**回退到 openclaw：** 和上面反过来。

```powershell
.\scripts\stop.ps1                    # 停掉可洛进程
# 在 config.json 里改回 "runtime": "openclaw"（或者删掉这一项）
.\scripts\clo.ps1 apply               # 重新生成 openclaw.json
.\scripts\doctor.ps1
.\scripts\start.ps1
```

几点要知道：

- 切换要停一次进程。停机期间的 QQ 消息按丢失处理，和平时一样。
- own 下她自己说过的话只在内存里，停一次就没了。切回 openclaw 后，宿主会话库里切换之前的内容还在，会接着用。
- **切到 own 不会删掉任何旧数据。** 以前在 OpenClaw 上跑过的话，`.runtime/state` 里的会话库、`.runtime/logs` 里的日志都还在，own 不读也不清它们。
- doctor 在 own 下只查 own 要的东西：系统提示词、锁定的 Node 和 SDK、进程环境、入口文件、不监听端口，不需要 `openclaw.json`。宿主相关的检查只在 openclaw 下跑。禁止的 QQ 和其他平台插件两边都查。
- 付费探测用 `scripts\q5-probe.ps1 -Runtime own`，见下面“付费探测”。

## 改了什么

QQ 连接、gate、唯一出口、账本、内容策略、去重和崩溃恢复都是同一份代码。变的是中间那一段：不再有 OpenClaw Gateway，主回复由 gate 直接交给项目自己的回合程序（`src/clo-plugin/lib/core/turn.js`），它通过 `src/clo-plugin/lib/core/openrouterChat.js` 调 OpenRouter。判定模型也改用这个客户端。进程入口是 `src/bot/main.mjs`。

| 项目 | openclaw（现在默认） | own |
|---|---|---|
| 进程 | Gateway，只绑 loopback，有本地 token | 一个 Node 进程，不监听任何端口，没有 token |
| 主回复的请求 | 宿主构造，回合内可能重试多次，还可能压缩 | 项目自己构造，每回合一次请求，不流式。只有确认没发出去的连接错误（连接超时、连接被拒、DNS 失败）在期限内重试一次 |
| 工具 | 只有惰性的 `clo_feature_status` | 请求里没有 `tools` 字段。模型硬要调工具时，这个回合按失败算，工具里的东西不会发到 QQ |
| 她自己说过的话 | 在宿主会话库里，落盘 | 只在内存上下文里，和群消息同一个有界环（40 条、24 小时、token 上限），标为“可洛”。重启后丢失，`/new`、`/reset` 清空，这个群 120 分钟没有回合也清空 |
| 必答回合返回空或 `NO_REPLY` | 宿主会再调一次 | 发一次失败句，不再调 |
| 必答回合的预留 | 按两次调用算 | 按一次调用算，整段输入按缓存写入价和普通输入价里高的那个算 |
| `/new`、`/reset`、`/stop` | 交给宿主 | 在 gate 里处理，不调模型。`/stop` 直接中止正在进行的请求；危险回合已经交出去的回复不中止，照常发出。不理会中止的回合 5 秒后放弃，预留留作未结算，迟到的文字不会到出口 |
| 和 `/stop` 同一秒的消息 | 宿主按时间戳拒绝，收到失败句（只在假宿主上跑过） | 跳过：不调模型，不发失败句，不预留。带危险词的照常处理 |
| 斜杠文本 | 首词像命令名的才算命令 | 只有列出的 owner 命令算命令，其他斜杠文本（比如 `/think …`）按普通文字走 |
| 主模型连续失败 | 宿主的 `model_call_ended` 计数 | gate 自己计数：连续 3 次暂停付费，402 立即暂停 |
| 宿主提示文字过滤 | 有 | 没有宿主，不需要 |
| 提示缓存 | 宿主决定 | 只在系统提示末尾放一个 ephemeral 标记 |
| OpenRouter 路由 | 宿主发归属请求头 | 加 `provider.require_parameters:true`，不发归属请求头，不发 `user` 字段，上游不锁定 |
| 进程输出 | `.runtime/logs/gateway.log` | 同一个文件 |

这些行为都有离线测试（下面“测试对照”），没有一项在真实 QQ 或真实模型上看过。唯一的例外是请求本身：Q5 的付费探测里，回合程序构造的请求在真实 OpenRouter 上被接受过一次（见下面“付费探测”），但那次没有 gate、出口和账本。新的请求布局也会影响人设和回答质量，Q5 没有记录回答内容，所以这一点还不知道。

## 内存

**只在离线测试里量过**：Windows，私有 Node，mock QQ，mock 模型，用这份代码的 `src/bot/main.mjs`，一次样本。

| 情况 | 私有内存 | 工作集 |
|---|---|---|
| 连上 mock QQ 后空闲 3 秒 | 约 43 MB | 约 78 MB |
| 连着跑完 20 个 @ 回合 | 约 51 MB | 约 83 MB |
| 再过 30 秒 | 约 34 MB | 约 75 MB |

启动时的峰值工作集约 99 MB。同样条件下 Gateway 是空闲约 750–850 MB、一个回合后约 1.2–1.4 GB（见 [DEPLOYMENT.md](../DEPLOYMENT.md) 的“内存”）。

限制：量的时候闸门、出口和账本还是按 openclaw 方式构造的（见下面“已知问题”），走的是 @ 回复这一条路；真实 TLS、真实回复长度、长时间运行、Linux 都没有量过。

## 隐私和数据：应该变好的，还没有确认

按代码，own 下这几样应该不再有：OpenClaw 会话库（回合正文、思考文字、模型服务方错误原文都存在那里）、每次启动访问 `clawhub.ai`、宿主提示词里的主机名和路径。离线时看到的：

- 网络守卫只放行两个 mock 端口，smoke 和 qq-load 两个测试里它没有记录到别的连接、监听或 UDP。
- qq-load 测试里，进程加载的模块没有一个来自 OpenClaw。
- provider-refusal 和 qq-context 测试扫了进程写的文件，没有回合正文和模型服务方文字。

**这些都只是离线结果，真实运行里还没有确认。** 所以 README 和告知草稿里的这几条缺口都**没有关闭**：

- `clawhub.ai` 的外联：照样写着，真实运行确认没有之后才从告知草稿里去掉。
- 会话库里的正文、思考文字、错误原文：openclaw 路线上仍然是这样；以前跑出来的会话库，切到 own 也不会删。
- 按成员删除数据：还是做不到。own 下她的回复只在内存里，但 `clo.db` 的记录、OpenRouter 和模型提供方那边，规则 5.10 的删除请求仍然满足不了。

告知怎么改由用户本人决定（D5）。

## 付费探测（Q5）

`src/tools/q5-probe.mjs` 加了 `--runtime own`，`scripts\q5-probe.ps1` 对应的参数是 `-Runtime own`（默认仍是 `openclaw`）。回合走项目自己的回合程序和 OpenRouter 客户端，不启动 Gateway，也不碰 QQ。每回合最多一次请求，不重试。

原来的计划最坏 $0.9844，比决定里约 $0.10 的上限大，跑不了。用户 2026-11-06 定了新计划（见 [DECISIONS.md](../DECISIONS.md) 的“用户定的（2026-11-06，Q5 和费用）”）：0 次直连调用，两个回合，第 2 回合放得下才发。按新计划，运行前最坏 $0.094144，最多 2 次模型调用（openclaw 版本是 $1.5484、9 次）。工具把它打印成向上取整的 $0.0942，`-MaxUsd` 低于 $0.094144 就拒绝，所以 $0.0941 也不行。

- 第 1 回合：(11817 字节的消息 + 500) × $5.5/M + 1200 × $22/M = $0.094144。价格上限是锁定价加 10%，`max_tokens` 1200 只在探测里用。
- 第 2 回合：发之前用它准确的请求体算界限，已经计入的花费加上它超过 `-MaxUsd` 就记 `skipped_cap`，不发。第 1 回合的回答越长，越可能被跳过。
- 第 1 回合的 $0.094144 有前提：输出不超过 1200、输入不超过消息字节数加 500、实际单价不高于上限。这些在第 1 回合之后才查，超了就停；报告了费用却缺 token 数时查不了，也停（`usage_tokens_missing`）。合计不超过 `-MaxUsd` 的前提是 OpenRouter 报告的用量准确，并且第 2 回合的实际单价不高于上限、输出不超过 1200、输入不超过 B2 估的数。第 2 回合是最后一回合，它之后的检查拦不住什么。无条件的兜底只有 Key 的日限额，它只能拒绝还没开始的请求，限额到了时正在跑的那一个可能越过一点。
- 读 `.env` 里专用的 `CLO_TEST_API_KEY`，不是 `CLO_CHAT_API_KEY`，没有就拒绝运行。不加 `provider.max_price`。

细节见 [DEPLOYMENT.md](../DEPLOYMENT.md) 的“付费探测工具”。

**在真实 OpenRouter 上跑过一次（2026-11-07），一次样本，不接 QQ。** 用户同意后按 `-MaxUsd 0.10` 运行，用专用的 `CLO_TEST_API_KEY`。两个回合都完成，合计 $0.033847，Key 增量一致，61 秒后对上，没有报警。

- 第 1 回合（冷）：prompt 4427 token，其中缓存写入 4359、未缓存输入 68；输出 140，其中思考 51；$0.024867；4.05 秒。
- 第 2 回合（热）：B2 = $0.055044，放得下，发了；prompt 4556，其中缓存读 4359、输入 197；输出 366，其中思考 155；$0.00898；5.65 秒。
- 这一次看到的：系统块是 4359 个真实 token；请求形状（系统块上带 `cache_control` 的 content part、effort low、`max_tokens` 1200、`require_parameters`、没有工具）被接受；缓存先写后读；报告的费用等于 token 乘目录价；服务方是 anthropic，`finish_reason` 是 stop。
- 没有看到的：own 下的判定调用、真实 QQ、拒答、1 小时缓存、中止的请求怎么计费。探测进程里没有 gate、出口和账本，回答内容也没有记录。

所以这只说明回合程序和 OpenRouter 客户端能在真实 OpenRouter 上跑通一次，不算 own 在 QQ 上的验收。Q3 到 Q7 在 own 上仍然都没有做，这次探测也不算其中的 Q5：Q5 要真实模型加 mock QQ，探测里没有 QQ，也没有 gate、出口和账本。

正式运行的省钱办法这一轮没有做，记在 [cost-options.md](cost-options.md)。

## 测试对照

宿主路线的 e2e 在 `tests/e2e/`，启动真实 OpenClaw Gateway；own 的在 `tests/e2e-own/`，启动真实的 `src/bot/main.mjs`，用 `tests/harness/own.mjs`。两边都只用 mock QQ 和 mock OpenRouter。过渡期两套都保留，`tests/e2e/` 继续守 openclaw 路线。

```powershell
.\.runtime\node\node.exe --test --test-concurrency=1 tests/e2e-own/<文件>.test.mjs   # 一个文件一个文件跑
```

| `tests/e2e/` | `tests/e2e-own/` | 怎么对应 |
|---|---|---|
| `dispatch-stalled.test.mjs` | `dispatch-stalled.test.mjs` | 改写：回合程序自己提前截断，gate 在被动窗口结束时中止 |
| `fix2-stop-host.test.mjs` | `fix2-stop-host.test.mjs` | 改写：`/stop` 不出 gate，同一秒的消息跳过 |
| `policy-sentinel.test.mjs` | `policy-sentinel.test.mjs` | 移植；宿主的后备提示词那几行没有对应 |
| `provider-refusal.test.mjs` | `provider-refusal.test.mjs` | 改写：不流式的响应形状，加上对进程写的所有文件的扫描；宿主日志那部分不再有 |
| `q5-probe.test.mjs` | 没有 | own 模式在 `tests/unit/q5-probe.test.mjs` 里，不启动进程 |
| `qq-commands.test.mjs` | `qq-commands.test.mjs` | 移植：命令在 gate 里处理，只有列出的 owner 命令算命令 |
| `qq-context.test.mjs` | `qq-context.test.mjs` | 移植，加上她自己的回复进上下文、不落盘 |
| `qq-controls.test.mjs` | `qq-controls.test.mjs` | 移植 |
| `qq-crash-matrix.test.mjs` | `qq-crash-matrix.test.mjs` | 直接移植，真杀进程 |
| `qq-display-names.test.mjs` | `qq-display-names.test.mjs` | 移植 |
| `qq-first-run.test.mjs` | `qq-first-run.test.mjs` | 移植：真实控制台，`runtime` 为 own |
| `qq-group-reply.test.mjs` | `qq-group-reply.test.mjs` | 移植：每回合一次直接请求 |
| `qq-identity.test.mjs` | `qq-identity.test.mjs` | 移植：每群一个内存环，代替宿主的每群会话 |
| `qq-interject.test.mjs` | `qq-interject.test.mjs` | 移植 |
| `qq-lifecycle.test.mjs` | `qq-lifecycle.test.mjs` | 移植；通道启停、配置重载、插件重载这些宿主行没有对应 |
| `qq-load.test.mjs` | `qq-load.test.mjs` | 宿主加载插件的部分没有对应；改为证明 SDK 能载入、进程里没有宿主模块 |
| `qq-model-live.test.mjs` | `qq-model-live.test.mjs` | 移植：`clo model refresh` 再 `clo mode live`，不生成宿主配置 |
| `qq-multi-payload.test.mjs` | `qq-multi-payload.test.mjs` | 改写：一次请求、没有工具，出口最多收到一段完整文字 |
| `qq-outbound-closed.test.mjs` | `qq-outbound-closed.test.mjs` | 证明这个面不存在：没有宿主和插件入口，没有监听，所有 POST 都是出口的被动回复 |
| `qq-pending-history.test.mjs` | `qq-pending-history.test.mjs` | 移植 |
| `qq-prompt-observation.test.mjs` | `qq-prompt-observation.test.mjs` | 观察，不是闸门：写出模型看到的请求 |
| `qq-prompt-privacy.test.mjs` | `qq-prompt-privacy.test.mjs` | 移植；关掉替换提示词的那一组没有对应 |
| `qq-send-errors.test.mjs` | `qq-send-errors.test.mjs` | 直接移植 |
| `qq-send-rate.test.mjs` | `qq-send-rate.test.mjs` | 直接移植，等真实时钟约一分钟 |
| `qq-settlement.test.mjs` | `qq-settlement.test.mjs` | 移植，加上必答回合按一次调用预留 |
| `qq-slash-text.test.mjs` | `qq-slash-text.test.mjs` | 规则变了：只有列出的 owner 命令算命令 |
| `qq-unsettled-clear.test.mjs` | `qq-unsettled-clear.test.mjs` | 直接移植 |
| `tool-list.test.mjs` | `tool-list.test.mjs` | 证明请求里没有 `tools` 字段，调工具的回答按失败算 |
| 没有 | `smoke.test.mjs` | 新增：一次 @、一次请求、结算、停机、不监听 |

只在宿主上有意义、移植时去掉的检查：宿主提示文字、宿主文件日志、宿主看门狗、`openclaw.json`、通道和插件重载、插件加载。单元测试里 `host-notices`、`host-output-filter`、`render-validate` 和 `render` 的 `openclaw.json` 部分只守 openclaw 路线，切换之前继续跑。

## 已知问题

- 整合时发现 `src/bot/main.mjs` 构造闸门和出口、`src/bot/services.mjs` 构造账本时没有传 `runtime: 'own'`，进程里这三样按 openclaw 的规则跑。已经改了，`tests/unit/bot-main.test.mjs` 在 bot 进程里检查 Key 限额暂停、预留大小、`/stop` 中止回合、她的回复进下一轮上下文。只离线测过。
- e2e-own 全量只以并发 4 跑过，没有串行跑过。
- Q5 只有一次样本，一次冷回合、一次热回合。思考 token（51、155）、回答长度、缓存命中和对账延迟都只有这一个点；判定调用、拒答、429、1 小时缓存和中止请求的计费都没有真实数据。
- 回合程序的一次连接重试不另外预留，用的是回合原来的预留，重试前再查模式、`qq.enabled` 和暂停（`src/bot/services.mjs` 的 `retryAllowed`）。用户定的是重试单独预留，这里没有照做，是开发时的选择，用户还没有确认，见 [DECISIONS.md](../DECISIONS.md) 的“自己的运行时里和上一节不一致的地方”。探测里不重试。
