# Clo group-chat build: frozen design contract

Date: 2026-11-02. Scope: plan Q1 + Q2, group chat only. Audience: the implementers working in parallel on disjoint files.

"The plan" below means the plan approved at the start of the project, and "the research" means its research notes. Neither is in this repository. Where this document relies on them, it states the rule itself.

Precedence: `DECISIONS.md` and the review notes in `docs/wiring-trial.md` override the plan. This document applies them. If it conflicts with a hard constraint in the task, the constraint wins and the implementer reports the conflict.

When this was written, nothing here had run on real QQ or real OpenRouter. `DEPLOYMENT.md` says what has run since. Offline tests prove wiring, not platform behaviour.

## 0. Assumptions and open items

| # | Assumption | Basis | If false |
|---|---|---|---|
| A1 | `inbound.run` resolves only after all `deliver` calls for the turn | Observed once per turn in the trial; multi-payload not observed | `e2e/qq-multi-payload` fails. CHANNEL reports it; flush must then key off a turn-end hook |
| A2 | Returning `visibleReplySent:true` from a buffering `deliver` stops the host's required-reply retry | Read: `docs/concepts/messages.md` ("still-owned delivery prevents duplicate recovery") | Same test fails. Report it; do not send early, because that breaks TQ25 |
| A3 | `before_prompt_build` returning `systemPrompt` replaces the prompt, and `before_agent_run` sees the replacement | Read in `attempt-system-prompt-prepare-*.mjs`, not run | Set `privacy.replaceSystemPrompt` default to `false` and report what remains (§8.3) |
| A4 | `message.inboundHistory` with `sessionTranscript:{historyLimit,historyKind:"recent"}` reaches the model and does not persist the extra lines into the transcript | Read in `docs/plugins/sdk-channel-inbound.md`, not run | `e2e/qq-context` fails. Report. Do not fall back to inlining history without saying so, because that writes non-addressed text to the transcript |
| A5 | `model.usage` is emitted for a run, carrying `sessionKey` and token counts | Type read; not run | Every turn goes `unsettled`, which fails closed. `e2e/qq-settlement` reports it |
| A6 | Send response has `ext_info.ref_idx` and it equals later `ref_msg_idx` verbatim | SDK type only. `q0b-results.jsonl` recorded only `hasId` | Reply-to-bot never fires; those messages stay `ordinary`. `status` prints `botRefsSeen`. Check at Q6 |
| A7 | Standalone owner `/new` and `/reset` start no model turn | Read in `docs/tools/slash-commands.md` | `e2e/qq-commands` fails. Drop them from the allowed set |
| A8 | SQLite WAL on the project path works under the private Node | `node:sqlite` opened on `:memory:` under 24.22.2 (SQLite 3.53.4), WAL on disk not run | `unit/store` fails. Report; do not silently drop durability |

Open items that block `live` and that code cannot resolve:
- **D3 (§4.2) is undecided in `DECISIONS.md`.** `clo mode live` refuses until the user records it (§7.3).
- `qq.maxPartChars` is provisional at 1500. Q0b did not measure it.
- A half-open socket (no close frame) is not detected beyond what the SDK does. The plan's REST liveness probe and in-process rebuild are deferred; Q9 (TQ20) decides whether they are needed.

## 1. Files and owners

A file has one owner. Only the owner edits it. A non-owner needing a change asks; it does not patch. If a dependency is not on disk yet, stub it inside your own test against the signatures in §3. Paths are relative to the project root; `lib/` means `src/clo-plugin/lib/`.

### CORE

```text
lib/core/store.js          SQLite, events, sends, interject log, counters, control, alerts, recovery
lib/core/config.js         paths, business config, validation, effective reader, live preconditions
lib/core/ledger.js         reservations, settlement, tiers, key reconcile
lib/core/contentPolicy.js  rules, normalization, leak check, crisis route, sentinels, fixed lines
lib/core/models.js         selector, catalog validation, prices, hold arithmetic
lib/core/render.js         openclaw.json, workspace files, replacement system prompt
lib/core/ids.js            hmac keys, session peer id, day and hour buckets, quiet hours, crashpoint
lib/core/log.js            whitelisted JSONL event log
persona/SOUL.md  persona/IDENTITY.md  persona/AGENTS.md  persona/examples.md
persona/group-notice.zh.md  persona/CONTENT-POLICY.md  persona/policy-lines.zh.json
persona/decision-prompt.zh.md
policy/rules.json  policy/crisis-route.json
tests/fixtures/policy-ok.zh.txt  tests/fixtures/policy-hit.zh.txt
tests/fixtures/claude-md-7x.sha256  tests/fixtures/render/
tests/unit/store.test.mjs  ledger.test.mjs  ledger-reconcile.test.mjs  quota-atomic.test.mjs
tests/unit/content-policy.test.mjs  policy-render.test.mjs  config.test.mjs  render.test.mjs
tests/unit/render-validate.test.mjs  models.test.mjs  qq-identity.test.mjs  qq-redaction.test.mjs
```

### GATE

```text
lib/core/gate.js           G0-G16 orchestration, classify()
lib/core/decision.js       direct decision fetch and validation
lib/core/window.js         per-group serial queues, addressed lane, 4 s window, concurrency cap
lib/core/rules.js          pure local rules: cooldown peek, quiet hours, noise, flood, caps
lib/core/context.js        in-memory ring buffer, pseudonyms
lib/core/commands.js       owner command parsing and local handling
tests/fixtures/inbound.mjs
tests/unit/classify.test.mjs  gate-identity.test.mjs  gate-commands.test.mjs  gate-limits.test.mjs
tests/unit/window.test.mjs  decision-policy.test.mjs  rules.test.mjs  prompt-injection-policy.test.mjs
tests/seam/policy-pregate.test.mjs  seam/failure-line.test.mjs  seam/qq-replay.test.mjs
```

Seam tests run real gate, store, ledger, policy and exit in one process against `mock-qq`, with a fake `dispatchTurn`. They need CORE and CHANNEL on disk, so they go green last.

### CHANNEL

```text
src/clo-plugin/index.js  openclaw.plugin.json  package.json
lib/channels/qq/connection.js  normalize.js  exit.js  dispatch.js  hooks.js  services.js  tools.js
tests/harness/mock-qq.mjs  mock-openrouter.mjs  gateway.mjs  net-guard.mjs
tests/fixtures/qq-events.mjs  tests/fixtures/single-exit-offenders/
tests/unit/normalize.test.mjs  qq-send-results.test.mjs  qq-passive.test.mjs  qq-policy-exit.test.mjs
tests/unit/qq-single-exit.test.mjs  qq-exit-runtime.test.mjs
tests/e2e/qq-load.test.mjs  qq-lifecycle.test.mjs  qq-group-reply.test.mjs  qq-prompt-observation.test.mjs
tests/e2e/tool-list.test.mjs  qq-commands.test.mjs  qq-identity.test.mjs  qq-outbound-closed.test.mjs
tests/e2e/qq-multi-payload.test.mjs  policy-sentinel.test.mjs  provider-refusal.test.mjs
tests/e2e/qq-interject.test.mjs  qq-crash-matrix.test.mjs  qq-settlement.test.mjs
tests/e2e/qq-prompt-privacy.test.mjs  qq-context.test.mjs
```

### OPS

```text
src/cli/clo.mjs  src/cli/lifecycle.mjs  src/cli/doctor.mjs  src/cli/status.mjs
scripts/_env.ps1  start.ps1  stop.ps1  status.ps1  doctor.ps1  clo.ps1
config.example.json  .env.example  README.md  DEPLOYMENT.md
tests/unit/script-bans.test.mjs  cli-mode.test.mjs  cli-group.test.mjs  cli-model.test.mjs
tests/unit/doctor.test.mjs  lifecycle.test.mjs
```

Do not touch: `CLAUDE.md`, the plan, the research notes, `src/tools/qq-listener.mjs`, `src/tools/qq-send-probe.mjs`, `captures/`, `.env`, `.runtime/q0-salt`, `.runtime/q0b-dm-target`, `scripts/q0-*.ps1`. `scripts/setup.ps1` stays as is. `src/tools/qq-shape.mjs` stays unused by the build. No new npm packages. `tests/unit/qq-single-exit` may import `acorn` from `.runtime/pkg/node_modules` (already installed with OpenClaw; not a project dependency).

## 2. Data shapes

### 2.1 InboundEvent (`normalize` output, memory only, holds raw IDs and text)

```js
{
  kind: 'group' | 'direct',
  eventType: 'GROUP_AT_MESSAGE_CREATE' | 'GROUP_MESSAGE_CREATE' | 'C2C_MESSAGE_CREATE',
  messageId: string,            // raw.id, exact case
  conversationId: string,       // group_openid or user_openid, exact case
  senderId: string | null,      // member_openid or user_openid, exact case
  senderIsBot: boolean,         // raw.author.bot === true
  text: string,                 // tags removed, trimmed, placeholders appended; never contains <@...>
  hasUserText: boolean,         // text remains apart from placeholders
  placeholders: string[],       // '[图片]' '[语音]' '[视频]' '[文件]' '[非文字消息]'
  timestampMs: number | null,   // Date.parse(raw.timestamp); null when invalid
  receivedAt: number,
  isRealAt: boolean,            // see §5.2
  mentionsAll: boolean,         // some scope==='all', or a <@all> tag
  mentionsOther: boolean,       // a scope==='single' mention with is_you!==true
  ambiguousMention: boolean,    // a mention with bot===true and is_you!==true. Logged, never a signal
  refMsgIdx: string | null,     // 'ref_msg_idx=' value from message_scene.ext[], verbatim
  msgIdx: string | null,        // 'msg_idx=' value from message_scene.ext[], verbatim
  msgType: number | null,       // raw.message_type
}
```

Normalize rules, all from observed shapes:
- Input is `structuredClone(raw)`. It never receives ctx or the SDK object.
- `<@X>`, `<@!X>`, `<@all>` tags are always removed. Mention of the bot leaves nothing. A mention of another member becomes `@群友`. `<@all>` becomes `@所有人`.
- Read own text from `content` only. Do not read `msg_elements[].content` or `parallel_message.msg_nodes[].content`, because those can be quoted material.
- `attachments` and `msg_elements[].attachments` only produce placeholders. Nothing is downloaded. `attachments` can be empty at top level on type 103.
- Parse `ref_msg_idx` and `msg_idx` from `message_scene.ext` yourself. Do not use the SDK's `msg.refMsgIdx`: it prefers `msg_elements[0].msg_idx` on type 103, which is not "the message being quoted".
- `mentions[].username` is dropped here. `author.username` is dropped too, unless the event's group has `displayNames` on: then it passes as `displayNameRaw`, unchecked, and the gate sanitizes it (`lib/core/displayName.js`) and deletes the raw field. See `DECISIONS.md`, display name row.
- Unknown event type returns `null`.

### 2.2 Turn (gate to dispatch and exit, memory only)

```js
{
  turnId: string,               // randomUUID
  eventKey: string, groupKey: string,
  groupId: string, messageId: string, // raw, used only by exit and dispatch
  cls: 'at' | 'reply_bot' | 'name_addressed' | 'crisis' | 'interject' | 'command',
  tier: 'interject' | 'named' | 'addressed' | 'none',  // §5.3
  required: boolean,            // true for all but 'interject'
  authorizedCommand: null | '/new' | '/reset' | '/stop',
  text: string,                 // InboundEvent.text
  history: Array<{ sender: string, body: string, timestamp: number }>, // host HistoryEntry shape. Leaves out other open lines that get their own handling (GATE item 23)
  inboundUrls: string[],        // URLs in text, for the outbound guard
  replyReservationId: string | null,
  interjectLogId: string | null,
  receivedAt: number, msgTs: number | null,
  deadlineAt: number,           // min(msgTs, receivedAt) + 285000
}
```

### 2.3 Effective (`.runtime/clo/effective.json`, written only by `clo apply`)

```js
{
  version: 1, generatedAt: iso, mode: 'dry-run' | 'live',
  qq: { enabled, appId, apiBaseUrl, tokenBaseUrl, urlMode: 'names',
        maxPartChars, maxPartsGroup: 5, interjectMaxChars: 400,
        groups: { [groupId]: { label, interject, nameMention, noticeGiven,
                               cooldownMinutes, perHour, perDay, ownerMemberIds: string[] } } },
  names: string[],
  quietHours: { start: '23:00', end: '08:00', timezone: 'Asia/Shanghai' },
  window: { windowMs: 4000, maxPending: 20, maxConcurrentTurns: 2, staleMs: 120000,
            futureSkewMs: 300000, dispatchDeadlineMs: 180000 },
  limits: { nameWindowMax: 3, nameDecisionsPerGroupPerHour: 12, decisionsPerGroupPerHour: 60, decisionsPerDay: 300,
            perSenderAddressedPerHour: 10, crisisRoutePerGroupPerDay: 3, crisisRoutePerSenderPerHour: 2,
            failureLinePerGroupPerHour: 2, floodPerWindow: 10, minTextChars: 2,
            sendAccountPerMin: 12, sendAccountPerHour: 120, sendGroupPerMin: 4 },
  budget: { dailyUsd, interjectUsd, searchUsd, namedUsd, addressedUsd,
            keyDailyLimitUsd, residualMinUsd: 0.25, residualPct: 0.15,
            providerFailStreakPause: 3,
            decisionRetryMs?, creditsRetryMs?, unsettledClearMs?, unsettledClearReads? }, // optional; left out, the ledger's defaults apply
  models: {
    primary:  { id, selector, effort, maxTokens, contextTokens, cacheRetention, price },
    decision: { id, effort, maxTokens, price },
  },                            // price: { inputPerM, outputPerM, cacheReadPerM, cacheWritePerM }
  openrouter: { baseUrl },      // 'https://openrouter.ai/api/v1' unless test mode
  timeouts: { decisionMs: 8000, turnSeconds: 90 },
  retention: { eventDays: 14, sendDays: 14, reservationDays: 90, contextMaxItems: 40,
               contextMaxAgeHours: 24, contextMaxTokens: 3000, decisionLines: 15, decisionLineChars: 200, decisionCurrentChars: 800 },
  contentPolicy: { enabled, version: '1', sha256, policyFile, rulesFile, crisisFile, linesFile },
  privacy: { replaceSystemPrompt: boolean },
  paths: { db, eventLog, systemPromptFile, decisionPromptFile },
}
```

Effective never holds a secret. Secrets come from `process.env` of the Gateway: `CLO_QQ_APP_SECRET`, `CLO_CHAT_API_KEY` (passed to the host as `OPENROUTER_API_KEY`).

## 3. Module contracts

All functions take injected deps so tests pass `now`, `fetch` and timers. `now` returns epoch ms. Money is integer micro-USD everywhere outside `effective.json` and CLI output.

### 3.1 ids.js

```js
export function hmacKey(salt, value)              // lowercase hex, 32 chars. value is exact-case
export function sessionPeerId(kind, rawId)        // 'g'|'u' + sha256('clo-peer\0'+rawId) hex, first 32. Lowercase by construction
export function shanghaiDay(ms)                   // 'YYYY-MM-DD'
export function utcDay(ms)
export function hourBucket(ms)                    // floor(ms/3600000)
export function isQuietHours(ms, quietHours)      // handles the wrap across midnight
export function crashpoint(name)                  // process.exit(77) if CLO_TEST_ROOT set and CLO_TEST_CRASH_AT===name; else no-op
```

Crash points: `after_claim`, `deciding`, `approved`, `dispatching`, `before_post`, `after_post`, `before_settle`.

### 3.2 log.js

```js
export function createLog(path)   // (event, data) => void. Appends JSONL
```

Only these data keys pass; anything else is dropped silently and counted in `droppedKeys`: `eventKey groupKey cls state reason ruleId path count closeCode code httpStatus qqCode durationMs model tier heldMicros actualMicros source seq part attempt generation kind`, plus the provider whitelist `status error_type provider_name provider_code`. The `event` name and `pid`, `t`, `gen` are always written. The log never holds text, raw IDs, usernames, `flagged_input`, `raw` or `message`.

### 3.3 config.js

```js
export function resolvePaths(env = process.env)
// { repoRoot, root, runtime, configJson, envFile, versionsLock, stateDir, openclawJson, home,
//   workspace, gatewayCwd, cloDir, effectiveJson, db, logsDir, eventLog, gatewayLog, pidFile, systemPromptFile }
// CLO_TEST_ROOT moves everything except repoRoot under that directory. repoRoot holds persona, policy, plugin code.

export function loadBusinessConfig(path)                   // throws ConfigError
export function validateBusinessConfig(cfg, { env })       // { ok, errors: [{ path, message }] }
export function buildEffective(cfg, { paths, modelsLock, env })   // Effective
export function createEffectiveReader(path)                // () => Effective | null. mtime cached; null when unreadable or invalid
export function livePreconditions(cfg, facts)              // { ok, failed: string[] } §7.3
export class ConfigError extends Error {}
```

### 3.4 store.js

```js
export function openStore(dbFile, { runGen, now })   // Store. Creates schema, WAL, salt in meta
// Store:
close()
tx(fn)                                   // BEGIN IMMEDIATE; COMMIT; ROLLBACK and rethrow on throw
key(rawId)                               // hmacKey with meta salt
claimEvent({ eventKey, groupKey, msgTs, receivedAt })   // { fresh: true } | { fresh: false, state }
setClass(eventKey, cls)
openEventKeys(groupKey, classes, since)  // event keys of this group, in these classes, received since then, not yet terminal. Reads only
mergedIntoOpen(groupKey, classes, since) // { eventKey, mergedInto } of the same, already merged into an event received since then and not yet terminal. Reads only
transition(eventKey, fromStates, toState, { reason, mergedInto } = {})  // boolean: false if not in fromStates
recoverOnStart(now)                      // §4.4. Returns counts per action
getControl(key) / setControl(key, value, by) / delControl(key)
pauseState(groupKey)                     // { global, group, interject, paid: null|reason, terminal: null|code }
peekInterject({ groupKey, limits, now })                // { ok } | { ok: false, reason: 'cooldown'|'hour'|'day'|'inflight' }
claimInterject({ groupKey, eventKey, limits, now })     // { ok: true, id } | as above. Atomic
consumeInterject(id, now) / releaseInterject(id)
bumpCounter(key, expiresAt, max)         // { ok, value }. ok=false leaves value unchanged. Atomic
peekCounter(key)                         // number
insertSendParts({ eventKey, groupKey, kind, parts: [{ textSha }], rate, now })
                                         // { ok: true, rows: [{ sendId, msgSeq, part }] } | { ok: false, reason }. Atomic over all parts
markSend(sendId, state, { qqCode, httpStatus, refKey } = {})
addBotRef(refKey, groupKey, eventKey) / hasBotRef(refKey, groupKey)
addAlert(kind, detail)                   // detail is whitelisted. At most 6/h per kind; the rest bump a suppressed count
listAlerts({ sinceMs }) / ackAlerts(ids)
statusSnapshot(now)                      // §7.5
armDiscovery(untilMs) / recordDiscovery({ groupId, memberId, now }) / listDiscovery() / clearDiscovery()
janitor(now, retention)
```

`limits` for interject: `{ cooldownMs, perHour, perDay, leaseMs: 120000 }`. `rate`: `{ accountPerMin, accountPerHour, groupPerMin }`.

### 3.5 ledger.js

```js
export function createLedger({ store, getEffective, fetch, getKey, log, now })
reserve({ tier, category, heldMicros, eventKey, model })
    // { ok: true, id } | { ok: false, reason: 'paid_paused'|'tier'|'total' }. Atomic. §4.5 rule
holdMicros(kind)                         // kind: 'decision'|'reply_required'|'reply_optional'|'tool_round'
settle(id, { actualMicros, source, model })
release(id)
markUnsettled(id)
applyLateUsage(eventKey, { actualMicros, source, model })
spent(now)     // { effectiveMicros, localMicros, providerMicros, byTier: { interject, named, addressed }, unsettled }
readKey()      // { limitMicros, remainingMicros, limitReset, usageMicros, usageDailyMicros }. Throws on failure
reconcile(now) // { ok, residualMicros, paused }
startTimers() / stopTimers()
acceptUnsettled(by)
```

### 3.6 contentPolicy.js

```js
export function loadPolicy({ policyFile, sha256, rulesFile, crisisFile })  // Policy. Throws on hash mismatch or parse failure
Policy.check(text)                 // { hit: false } | { hit: true, ruleId, category }. May throw; callers fail closed
Policy.checkLeak(text, { secrets, rawIds })   // same shape, category 'leak'
Policy.isCrisisRoute(text)         // boolean. Never blocks anything
export function normalizeCopy(text)            // NFKC, lower case, zero-width and whitespace removed
export function checkSentinels(systemPrompt, version)
    // { ok: true } | { ok: false, reason: 'no-prompt'|'missing-start'|'missing-end'|'order' }
export function loadFixedLines(file)   // { policyDropped, modelFailed }
```

### 3.7 models.js

```js
export async function fetchCatalog({ fetch, baseUrl })
export function resolveSelector(id, catalog)   // 'opus-latest' -> concrete id, or throws. Rules: the selector rules in the research notes
export function validateModels(cfg, catalog, { confirmPrice, qqPlatformNotified, change })  // { ok, errors }
export function priceFor(id, catalog)          // { inputPerM, outputPerM, cacheReadPerM, cacheWritePerM }
export function callWorstMicros(price, { contextTokens, maxTokens })   // contextTokens*inputPerM + maxTokens*outputPerM
```

The plan's arithmetic is `24000×$5/M + 3000×$20/M = $0.18`, on the input price. Keep it; Q5 revisits.

### 3.8 render.js

```js
export function renderOpenclaw(cfg, effective, paths, { testMode })   // plain object, deterministic key order
export function renderWorkspace(repoRoot, effective)
    // { files: { 'AGENTS.md', 'SOUL.md', 'IDENTITY.md' }, systemPrompt: string, hashes: {...} }
export function writeAtomic(path, text)
```

### 3.9 Gate side

```js
// gate.js
export function classify(evt, { hasBotRef, names })   // { cls: 'at'|'reply_bot'|'name'|'ordinary', ambiguous } §5.2
export function createGate({ store, ledger, policy, getEffective, decide, dispatchTurn, log, now, timers })
// -> { attachExit(exit), onInbound(evt): Promise<void>, idle(): Promise<void>, stop(): Promise<void> }

// decision.js
export function createDecider({ fetch, getKey, getEffective, promptFile, log, now })
// -> decide({ trigger: 'ordinary'|'name'|'crisis_route', lines: [{ sender, text }], current: { sender, text }, signal })
// -> Promise<Decision>
// Decision: { action: 'reply'|'skip', skipClass, crisis, invalid: null|'timeout'|'json'|'empty'|'length'|'http',
//             paid: boolean, actualMicros: number|null, model: string|null }

// window.js
export function createGroupQueues({ windowMs, maxPending, maxConcurrentTurns, setTimer, clearTimer, onError, onDrop, isUrgent })
// -> { addressed(groupKey, task, record, { yielding }), ordinary(groupKey, evtRecord, onFlush), idle(), stop() }
// Per-group serial. The addressed lane is drained before a flushed window, except that an urgent window goes ahead of
// yielding tasks. maxConcurrentTurns is global.

// rules.js
export function evaluateOrdinary({ group, evt, prerule, quiet, interjectPeek, pause, windowCount, limits, now })
// -> { ok: true } | { ok: false, reason: 'interject_off'|'interject_latch'|'quiet'|'cooldown'|'hour'|'day'|'inflight'|'noise'|'flood'|'prerule' }

// context.js
export function createContextBuffer({ maxItems, maxAgeMs, maxTokens })
// -> { push(groupKey, { senderKey, text, ts, eventKey }), history(groupKey, excludeEventKey, now), lines(groupKey, excludeEventKey, count, chars, now), clear(groupKey) }
// Pseudonyms are 'U1', 'U2' by first appearance per group, process lifetime only.
// push may carry a sanitized displayName, held on the line. history(..., { showNames: true }) labels it 'U1（显示名：小明）'. lines() never does.
// history(..., { hide }) leaves out the lines of those event keys (a Set). They take no room under the token cap. lines() has no such option.
// ownEarlier(groupKey, senderKey, arrival) gives the event keys of this member's lines from before that arrival. push takes the arrival.

// commands.js
export function parseCommand(text)
// -> null | { name: 'clo'|'status'|'new'|'reset'|'stop'|'other', args: string[], standalone: boolean }
export function runLocalCommand(cmd, { store, group, groupKey, effective }) // -> { ackText } or throws. Fixed ack strings live here
```

### 3.10 Channel side

```js
// connection.js. Only module that imports the SDK or constructs QQBot.
export const QQ_INTENTS = 1 << 25;
export async function runConnection({ account, abortSignal, onInbound, makeExit, onStatus, log, userAgent })
// Resolves after abort and socket close. Throws GatewayError with closeCode only on 4914 and 4915. §9
// onStatus({ connected, lastReadyAt, lastResumedAt, lastDisconnectCode })

// normalize.js
export function normalize(eventType, rawClone, { receivedAt })   // InboundEvent | null

// exit.js. Only module that holds the SDK object. Only POST path.
export function createExit({ bot, store, policy, getEffective, secrets, log, now })
// -> {
//   beginTurn(turn),
//   collect(turnId, { text, isError }, { kind }),     // host deliver result, buffers only
//   finishTurn(turnId, { hostError, aborted }),       // Promise<{ state, reason }> §6
//   sendFixed(ref, lineKey),                          // Promise<{ sent, reason }>
//   commandAck(ref, ackText),                         // Promise<{ sent, reason }>
//   stop(),
// }
// ref: { eventKey, groupKey, groupId, messageId, receivedAt, msgTs }

// dispatch.js
export function createDispatcher({ rt, getCfg, account, getExit, usage, log, now })
// -> dispatchTurn(turn): Promise<{ started, hostError, aborted, usage: null|{ costUsd, input, output, cacheRead, cacheWrite, model } }>

// hooks.js
export function registerHooks(api, { getServices })   // before_prompt_build, before_agent_run, before_tool_call, model_call_ended
export function createUsageTracker({ onInternalDiagnosticEvent, waitDrained, ledger, log })
// -> { open(sessionKey, turn), turnFor(sessionKey), close(turnId): Promise<usage|null>, stop() }

// services.js. One set per module instance, created lazily from plugin config effectivePath.
export function getServices(effectivePath)   // { store, ledger, policy, getEffective, decide, log, usage, runGen, systemPrompt() }
export function stopServices()
```

Gate calls in order for one turn: `store.transition(... 'dispatching')`, `exit.beginTurn(turn)`, `await dispatchTurn(turn)`, `await exit.finishTurn(...)`, then settle (§4.5) and the terminal transition.

## 4. Durable state

File: `.runtime/clo/clo.db`, `node:sqlite` `DatabaseSync`. Pragmas: `journal_mode=WAL`, `synchronous=FULL`, `busy_timeout=5000`, `foreign_keys=ON`, `user_version=1`. The Gateway and `clo.mjs` both open it; all multi-step writes use `store.tx`.

**At-rest identifiers are HMAC keys.** No raw openid, message ID, text or username is stored, except `discovery` (§7.6). Consequence: nothing can be re-sent after a restart, because the raw `msg_id` and text are gone. That is intended.

### 4.1 Schema

```sql
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- hmac_salt, schema

CREATE TABLE events(
  event_key TEXT PRIMARY KEY, group_key TEXT NOT NULL, cls TEXT,
  state TEXT NOT NULL, reason TEXT, merged_into TEXT,
  run_gen TEXT NOT NULL, msg_ts INTEGER, received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX events_state ON events(state);
CREATE INDEX events_received ON events(received_at);

CREATE TABLE sends(
  send_id TEXT PRIMARY KEY,               -- event_key:msg_seq
  event_key TEXT NOT NULL, group_key TEXT NOT NULL,
  kind TEXT NOT NULL,                     -- reply | reply_url_stripped | fixed_line | command_ack
  msg_seq INTEGER NOT NULL, part INTEGER NOT NULL, text_sha TEXT NOT NULL,
  state TEXT NOT NULL,                    -- pending | sending | sent | failed | uncertain | aborted
  qq_code INTEGER, http_status INTEGER, ref_key TEXT, run_gen TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(event_key, msg_seq));
CREATE INDEX sends_created ON sends(created_at);
CREATE INDEX sends_group ON sends(group_key, created_at);

CREATE TABLE reservations(
  id TEXT PRIMARY KEY, local_day TEXT NOT NULL, utc_day TEXT NOT NULL,
  tier TEXT NOT NULL,                     -- interject | named | addressed | none
  category TEXT NOT NULL,                 -- decision | reply | tool_round | adjustment | unattributed
  held_micros INTEGER NOT NULL, actual_micros INTEGER,
  status TEXT NOT NULL,                   -- held | settled | released | unsettled
  source TEXT,                            -- usage.cost | model.usage | computed | key_delta | manual
  event_key TEXT, model TEXT, run_gen TEXT NOT NULL,
  created_at INTEGER NOT NULL, settled_at INTEGER);
CREATE INDEX reservations_day ON reservations(local_day, status);

CREATE TABLE interject_log(
  id TEXT PRIMARY KEY, group_key TEXT NOT NULL, event_key TEXT NOT NULL,
  status TEXT NOT NULL,                   -- claimed | consumed | released
  local_day TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX interject_group ON interject_log(group_key, at);

CREATE TABLE counters(key TEXT PRIMARY KEY, value INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE control(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL);
CREATE TABLE bot_refs(ref_key TEXT PRIMARY KEY, group_key TEXT NOT NULL, event_key TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE key_snapshots(taken_at INTEGER PRIMARY KEY, usage_micros INTEGER, usage_daily_micros INTEGER,
  limit_micros INTEGER, remaining_micros INTEGER, limit_reset TEXT);
CREATE TABLE alerts(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL,
  detail TEXT NOT NULL, suppressed INTEGER NOT NULL DEFAULT 0, acked_at INTEGER);
CREATE TABLE discovery(group_id TEXT NOT NULL, member_id TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  count INTEGER NOT NULL, PRIMARY KEY(group_id, member_id));
```

Control keys: `global_paused`, `group_paused:<groupKey>`, `interject_paused`, `paid_paused`, `decision_paused`, `credits_probe`, `residual_over`, `terminal_close`, `heartbeat_at`, `last_ready_at`, `last_event_at`, `connected`, `discovery_until`.

Counter keys: `name_dec:<groupKey>:<hour>`, `dec_group:<groupKey>:<hour>`, `dec_day:<localDay>`, `sender_addr:<senderKey>:<hour>`, `crisis_group:<groupKey>:<localDay>`, `decision_bypass:<groupKey>:<localDay>`, `failline:<groupKey>:<hour>`, `skip_class:<localDay>`, `violation:<localDay>`, `policy_drop:<localDay>:<ruleId>:<path>`, `provider_fail_streak`, `decision_fail_streak`.

**Crisis has no durable per-member record.** The per-sender crisis caps are in-memory `Map`s in the gate, lost on restart. `skip_class` is a single daily total with no category, group or member, per the plan and TQ28. The per-group counters do leave a trace of the route: see Contract changes, GATE item 4.

### 4.2 Event states

Non-terminal: `received`, `queued`, `deciding`, `approved`, `dispatching`, `delivering`.

Terminal: `ignored`, `stale`, `merged`, `paused`, `dry_run`, `skipped`, `completed`, `silent`, `policy_dropped`, `failed`, `restart_dropped`, `crash_unknown`.

Every `at`, `reply_bot` and `name_addressed` event reaches a terminal state with a reason. `reason` values: `cmd_non_owner`, `cmd_unknown`, `cmd_owner`, `would_at`, `would_reply_bot`, `would_name`, `would_window`, `would_cmd`, `sender_rate`, `queue_full`, `expired_before_dispatch`, `budget`, `paid_paused`, `decision_paused`, `name_off`, `owner_stop`, `decision_skip`, `decision_invalid`, `decision_cap`, `prerule`, `interject_off`, `interject_latch`, `quiet`, `cooldown`, `hour`, `day`, `inflight`, `noise`, `flood`, `ingress`, `required_no_text`, `host_error`, `aborted`, `send_rate`, `deadline`, `passive_expired`, `platform_violation`, `group_error`, `send_uncertain`, `exit_refused`.

### 4.3 Durable ordering

Each write commits before its effect. A crash between any two leaves the earlier fact on disk.

1. **O1 claim:** `claimEvent` commits `received` before anything else about the message happens. Duplicate means stop.
2. **O2 context:** ring buffer push (memory) only after O1.
3. **O3 decision:** `tx{ claimInterject (ordinary only), counters, reserve decision hold }`, state `deciding`, commits before `fetch`.
4. **O4 reply:** `tx{ recheck pause, reserve reply hold, state approved }` commits. Then `tx{ state dispatching, consumeInterject }` commits. Then `inbound.run`.
5. **O5 send:** `insertSendParts` commits all parts `pending` and the rate check atomically, with state `delivering`. Before each POST, `markSend(sending)` commits. After, `markSend(sent|failed|uncertain)` commits, and `addBotRef` if there is a ref.
6. **O6 finish:** settle reservations, then terminal transition.

### 4.4 Crash matrix (`recoverOnStart`, runs at every `startAccount`, only on rows whose `run_gen` differs)

| Crash point | Durable state | Restart action | Re-send or re-run |
|---|---|---|---|
| Before O1 | none | Nothing. If QQ redelivers, it is a new event and G3 applies | Only via normal gate |
| After O1, before O3 (`received`, `queued`) | Event | `restart_dropped` | No (no body) |
| `deciding` | Event, decision hold `held`, maybe claim | Hold `unsettled`, claim `released`, event `restart_dropped` | No |
| `approved` | Event, reply hold `held`, maybe claim | Hold `released`, claim `released`, event `restart_dropped` | No (no model ran) |
| `dispatching` | Event, reply hold `held`, claim `consumed` | Hold `unsettled`, `paid_paused=crash_unsettled`, event `crash_unknown`, alert | Never |
| `delivering`, send `pending` | Parts not begun | Send `aborted`; event `crash_unknown`; hold `unsettled` | Never |
| `delivering`, send `sending` | POST may have happened | Send `uncertain`; event `crash_unknown`; hold `unsettled`; alert | Never |
| Send `sent`, before O6 | All parts sent | Event `completed`; hold `unsettled` | Never |
| After O6 | Terminal | Nothing | No |
| Same message redelivered after any of the above | Row exists | G1 drops it | No |

`paid_paused=crash_unsettled` clears when reconcile settles all unsettled rows, or by `clo budget accept-unsettled`.

Reload of the plugin generation goes through the same path. `gate.stop()` marks the instance stopped. A late `deliver` or `finishTurn` on a stopped exit returns `exit_refused` and never POSTs.

### 4.5 Ledger

**Holds** (`callWorst` = `callWorstMicros(primary.price, primary)`, $0.18 at locked price):

| Kind | Hold |
|---|---|
| `decision` | `DECISION_INPUT_TOKENS × decision.inputPerM + maxTokens × decision.outputPerM`. `DECISION_INPUT_TOKENS` is 10500: `estimateTokens` of the largest input (prompt + 15 lines of 200 + current of 800, all characters JSON writes as `\uXXXX`, about 10240). A held figure, not a measured one |
| `reply_required` | `2 × callWorst`. Required turns can retry once on `NO_REPLY` or empty (observed: 2 calls) |
| `reply_optional` | `1 × callWorst` |
| `tool_round` | `1 × callWorst`, per tool call, at `before_tool_call` |

**Tier rule, inside `reserve`:**

| Tier | Allowed if |
|---|---|
| `interject` | `byTier.interject + hold ≤ interjectUsd` and `effective + hold ≤ searchUsd` |
| `named` | `effective + hold ≤ namedUsd` |
| `addressed` | `effective + hold ≤ addressedUsd` (equal to `dailyUsd`) |

`effective = max(local settled + held + unsettled for the Shanghai day, provider figure for the same period)`. `paid_paused` refuses every tier. Validator requires `interjectUsd ≤ searchUsd ≤ namedUsd ≤ addressedUsd = dailyUsd`. `searchUsd` has no search behind it in this build; it stays as interjection's global stop so the plan's stop order holds.

**State machine:** `held → settled | released | unsettled`, `unsettled → settled` (key delta or late usage, or manual).

| Event | Decision hold | Reply hold | Interject claim |
|---|---|---|---|
| Local skip before G12 | none | none | none |
| Valid decision `skip` | settle actual | none | `released` |
| Decision timeout, invalid, HTTP error | settle if usage present, else `unsettled` | none | `released` |
| Budget refused at G14 | already settled | none | `released` |
| `approved`, not dispatched (pause or deadline) | n/a | `released` | `released` |
| Dispatched, usage seen | n/a | settle | `consumed` at dispatch |
| Dispatched, `NO_REPLY` on optional turn | n/a | settle | stays `consumed`; cooldown runs |
| Dispatched, no usage within 2 s drain after finish | n/a | `unsettled`, `paid_paused=usage_missing` | stays `consumed` |
| Send refused, uncertain or policy dropped | n/a | settle from usage; never zeroed | stays `consumed` |
| Crash | §4.4 | §4.4 | §4.4 |

**Settlement amounts:** `usage.cost` for decisions. For replies, `costUsd` from `model.usage`; if absent or zero with tokens present, compute from tokens at the locked price and set `source:'computed'`. Zero usage is never treated as free. A `model.usage` with no open turn becomes an `unattributed` row with `tier:'none'`, counted in effective.

**Reconcile:** `GET {baseUrl}/key` at start, every 10 minutes while connected, every 60 s while anything is unsettled. Lifetime `usage` deltas between snapshots give the provider figure. Deltas settle `unsettled` first, the remainder becomes `unattributed`. Residual over `max(residualMinUsd, residualPct)` on two reads, or read failure at start or twice running, sets `paid_paused`. A read with `remaining ≤ 0` sets `openrouter_key_limit`, subject to rank. Auto-resume only on a clean read, and not for every reason: see CORE item 13.

**Provider errors for decisions:** 402 and 403 branch on `error.metadata.limit_source`. `openrouter_key_limit` and `openrouter_credits` set `paid_paused`, and a 402 with no recognised source sets `openrouter_credits`. These do not count below. Other 403: alert `provider_403`, and the failure counts. Timeouts and other HTTP or network failures count. They bump `decision_fail_streak`, not `provider_fail_streak`, and never set `paid_paused`. At `providerFailStreakPause` consecutive failures the decision breaker opens: control `decision_paused`, one alert and log line `decision_paused`. While open, `ordinary` and `name` decisions end `skipped:decision_paused` inside the G12 transaction, with no claim, cap or hold. Real @, reply-to-bot and already approved replies are not touched. After `budget.decisionRetryMs` (default 10 minutes) one trial is admitted across all groups. A claim refused later gives the trial back. Any paid answer that is not `http` or `timeout`, including invalid JSON, closes the breaker and clears the streak (`decision_resumed`). A failure restarts the timer with no second alert. Our own shutdown cancelling a call counts as neither. Provider text is never sent to QQ and never logged.

**Crisis past the open breaker:** a message matching the crisis list, on the `ordinary` or `name` path, passes while the breaker refuses only if the normal crisis caps have room (read, not taken) and it takes a slot of the same size counted apart: `decision_bypass:<groupKey>:<localDay>` and an in-memory per-sender list. Otherwise `skipped:decision_paused`. A slot is taken in the claim transaction and rolls back with it. Past the wait such a message takes the normal trial and no slot. `crisis_route` does not consult the breaker at all and takes the real caps at the claim, so an outage in quiet hours or cooldown still spends them (open, DEPLOYMENT.md). A crisis decision's result closes or restarts the breaker like any other.

**Primary failures:** `provider_fail_streak` counts only `model_call_ended` errors. At the limit, `paid_paused=provider_fail`, or `openrouter_credits` while `credits_probe` is live. The host gives no status there (`errorCategory` is a JS class name, `failureKind` is transport only, read in 2026.10.9), so an exhausted account with room on the Key repeats failure streak, `provider_fail`, clean read.

**Reason rank:** one order for `paid_paused`, in `store.js`: `usage_unavailable` 4, the two limit reasons 3, `crash_unsettled` and `usage_missing` 2, everything else 1. A lower rank never overwrites a higher one, in recovery as well. An equal rank overwrites.

## 5. Gate

### 5.1 Execution order

G numbers keep their plan meaning. **Run in the order listed**, which differs from the numbers: non-admitted traffic must drop before any write, so G2 precedes G1.

| Order | Step | Action | On hit: event state |
|---|---|---|---|
| 0 | G0 discovery | Only if `discovery_until > now` and mode is `dry-run`: `recordDiscovery`. No text | continue |
| 1 | G2 identity and admission | `getEffective()` non-null; `qq.enabled`; `terminal_close` unset; `kind==='group'` (DM: drop, reason `dm_closed`, no row, even if a list is non-empty); `messageId`, `conversationId`, `senderId` present; `senderIsBot` false; `conversationId` in `qq.groups` by **exact-case** compare | No row. Log `gate_drop` with reason only |
| 2 | G1 dedupe | `store.claimEvent`. `crashpoint('after_claim')` | Duplicate: return, no state change |
| 3 | G3 stale | `timestampMs` null, or `receivedAt - ts > staleMs`, or `ts - receivedAt > futureSkewMs` | `stale`. Not buffered |
| 4 | G4 command | `parseCommand(evt.text)`. Prefix `/` or `／` after normalize. Non-owner (sender not in `group.ownerMemberIds`, exact case): `ignored:cmd_non_owner`, not buffered, no reply. Owner: §5.4. Unknown owner command: `ignored:cmd_unknown` | as stated |
| 5 | G5 type | If `!hasUserText`, mark placeholder-only. Never downloads | continue |
| 6 | G6 classify | `classify(evt, ...)`, `setClass`. Log `ambiguous_mention` if flagged | continue |
| 7 | Context push | `policy.check(text)`. Clean and has user text: push. Hit or throw: not buffered, `prerule=true`. No hit record | continue |
| 8 | G8 pause | `pauseState`. Global or group paused | `paused`. No fixed line |
| 9 | G9 mode | Not `live`: evaluate rules read-only, write `dry_run` with `would_*`. No model, reservation, hold or send | `dry_run` |
| 10 | G7 lane | `at`, `reply_bot`: addressed lane, state `queued`, never merged. `name`, `ordinary`: window lane, state `queued`. Over `maxPending`: `skipped:queue_full`, plus alert `crisis_queue_full` if the message matches the crisis list | as stated |
| 11 | G10 window | First message opens a fixed 4 s window per group. At close: each sender's last `name` with user text, at most `nameWindowMax` senders, newest kept, each judged on its own (GATE item 22). No name: the last with user text that is not noise. Others `merged`. None: all `skipped:noise` | `merged` |
| 12 | G11 local rules | See table below | `skipped:<reason>` |
| 13 | G12 claim | `tx{ decision breaker (§4.5), claimInterject (ordinary), bumpCounter decision caps, reserve decision hold (§5.3 tier) }`, state `deciding`, `crashpoint('deciding')` | Refused: `skipped:<reason>`. An `ordinary` crisis-list message refused `budget` tries `crisis_route` instead, on its caps |
| 14 | G13 decision | `decide()`, 8 s abort. Only `ordinary`, `name`, `crisis_route` call it. Settle per §4.5 | Skip: `skipped:decision_skip` or `decision_invalid` |
| 15 | G14 reserve | Recheck `getEffective`, admission (with `qq.enabled`), pause, mode, account, `dispatchDeadlineMs` since `receivedAt`. `tx{ reserve reply hold, state approved }`. `crashpoint('approved')` | Budget: `skipped:budget`, then fixed line if required. Paused: `paused`. Late: `skipped:expired_before_dispatch` with alert |
| 16 | G15 dispatch | `tx{ state dispatching, consumeInterject }`, `crashpoint('dispatching')`, history from the buffer without other open lines that get their own handling (GATE item 23), `exit.beginTurn`, `dispatchTurn` | |
| 17 | G16 finish | `exit.finishTurn`, `crashpoint('before_settle')`, settle, terminal transition | `completed`, `silent`, `policy_dropped`, `failed` |

**G11 rules:**

| Class | Rules, first failure wins |
|---|---|
| `ordinary` | `group.interject`; `interject_paused` unset; not quiet hours; `peekInterject` (cooldown, hour, day, inflight); not noise (`hasUserText`, length ≥ `minTextChars`, not emoji-only); window count ≤ `floodPerWindow`; `prerule` false. No model call without a new qualifying inbound message; there is no timer-driven speech anywhere |
| `name` | `group.nameMention`, else treat as `ordinary`; name decision cap per hour. Quiet hours and interjection cooldown do not apply. A name queued from a window rereads the switch: off now, it ends `skipped:name_off`, unless it reads as danger, which is treated as `ordinary` (window rules, crisis route). With interjection also off that is `skipped:interject_off` |
| `at`, `reply_bot` | `sender_addr` per hour cap, else `skipped:sender_rate` |
| Crisis route | If an `ordinary` event fails on `quiet`, `cooldown`, `hour`, `day`, `inflight` or `prerule`, and `group.interject` is on, and `policy.isCrisisRoute(text)`, and `crisis_group` and the in-memory per-sender cap both have room: do not skip. Call the decision once with `trigger:'crisis_route'` |

The crisis list only ever adds one decision, within its caps, including past an open decision breaker (§4.5). It never blocks. It is not consulted for `noise`, `flood`, `interject_off` or `interject_latch`.

**Decision result handling (all forced locally, whatever the model says):**
- Order in `routeDecision`: invalid, `crisis_route`, `crisis:true` with a cap slot, `skipClass`, `action`.
- `parseAnswer` keeps the model's `action` and `skip_class` under `crisis:true`, because past the caps they decide. A non-`none` `skip_class` with `crisis:false` forces `action:'skip'`. `need_search` is ignored; it is always false in this build.
- A non-`none` `skip_class` bumps `skip_class:<localDay>` only on a real skip. A crisis reply on a flagged topic leaves no class count.
- `ordinary`, `action:'reply'`, `skipClass:'none'`: continue as `interject`.
- `ordinary` or `name`, `crisis:true`, cap slot taken: continue as `crisis`. Release any interject claim. Past the caps, crisis means nothing: the class and action decide.
- `name`, `action:'reply'`, `skipClass:'none'`: `name_addressed`. The plan's JSON has no `addressed` field, so for this trigger `reply` means she is being addressed.
- `crisis_route`: reply only if `crisis===true`; class `crisis`, whatever the class says. `action:'reply'` with `crisis:false` is a skip.
- Timeout, invalid JSON, empty, `finish_reason:'length'`: skip. Five consecutive paid skips raise one alert.

**Decision request:** `POST {baseUrl}/chat/completions`, `model`, `stream:false`, `reasoning:{effort}`, `max_tokens`, `response_format` strict JSON schema with the four fields, `provider:{require_parameters:true}`, `usage:{include:true}`, no `temperature`, no `tool_choice`, no `tools`. Messages: one system message (file text), one user message `JSON.stringify({trigger, lines, current})`. Senders are pseudonyms. Lines from the buffer, up to `decisionLines`, each clamped to `decisionLineChars`. `current.text` is at most `decisionCurrentChars` code points, through `shapeCurrentText`: head + … + a window around each focus the ends would lose (the last name, the last crisis term) + … + tail. Parts that touch are joined, so … only marks text left out. A crisis term spread wider than an eighth of the limit has its filler removed. An effective file with no `decisionCurrentChars` falls back to `decisionLineChars`.

### 5.2 Classification from observed facts

`isRealAt = eventType==='GROUP_AT_MESSAGE_CREATE' || mentions.some(m => m.scope==='single' && m.is_you===true)`.

Priority in `classify`: `at` > `reply_bot` > `name` > `ordinary`. `reply_bot` means `refMsgIdx` non-null and `hasBotRef(store.key(refMsgIdx), groupKey)`. `name` means a configured word appears in `text`: `可洛`, `可洛小姐`, and `Clo` case-insensitive at a word boundary. The decision judges whether she is really being addressed.

| Observed shape | Class | Pays |
|---|---|---|
| `GROUP_AT_MESSAGE_CREATE`, leading space, no `mentions` (full-message off) | `at` | addressed |
| `GROUP_MESSAGE_CREATE`, `scope:'single', bot:true, is_you:true` (full-message on) | `at` | addressed |
| Same, plus `<@all>` | `at` | addressed |
| `scope:'all', is_you:true`, `bot` absent | `ordinary`, `mentionsAll` | interject |
| `scope:'single', bot:false, is_you:false` (another member) | `ordinary`, `mentionsOther`; `name` if a name word is also present | interject or named |
| `mentions[].bot===true` with `is_you` not true | `ordinary`, `ambiguousMention` logged. Never a fallback | interject |
| No `mentions`, name word in text | `name` | named |
| No `mentions`, plain `@可洛` typed by hand | `name`. Not a real @ | named |
| No `mentions`, URL or anything else | `ordinary` | interject |
| Type 103, `scope:'single', is_you:true`, `[图片]` | `at`. Placeholder in text. Not reply-to-bot on its own | addressed |
| Type 103, no mention, `ref_msg_idx` matches `bot_refs` | `reply_bot` | addressed |
| Type 103, no mention, no match | `ordinary` with placeholder. Placeholder-only: context only, `skipped:noise` | interject |
| Type 0, `ref_msg_idx` matches `bot_refs` | `reply_bot` | addressed |
| `author.bot===true` | Dropped at G2 | none |
| Slash text after tag removal | Command at G4, before classify | none, or addressed per §5.4 |
| `C2C_MESSAGE_CREATE` | Dropped at G2, reason `dm_closed` | none |

### 5.3 Who pays

| Work | Tier | Hold |
|---|---|---|
| `ordinary` decision | `interject` | `decision` |
| `name` decision | `named` | `decision` |
| `crisis_route` decision | `addressed` | `decision` |
| `interject` reply | `interject` | `reply_optional` |
| `name_addressed` reply | `named` | `reply_required` |
| `at`, `reply_bot`, `crisis` reply | `addressed` | `reply_required` |
| `tool_round` | Same tier as the turn | `tool_round`. Refused means `before_tool_call` blocks |
| Owner `/new`, `/reset`, `/stop`, compaction | `none` | No hold. Any `model.usage` lands as `unattributed` |

Local turn context passed to the host: `wasMentioned` and `explicitlyMentionedBot` are true for every class except `interject`. So only `interject` may stay silent under `silentReply.group:'allow'`.

### 5.4 Owner commands (group scope only)

Owner means sender is in `group.ownerMemberIds`, exact case. `qq.owner.dm` is not consulted; the observed `user_openid`/`member_openid` match is two samples only.

| Command | Handling | Reaches host | Reply |
|---|---|---|---|
| `/clo status`, `/status` | Local | Never | Fixed one line: mode, this group paused or not. No cost, token, model, session key |
| `/clo pause`, `/clo resume` | Local, this group. `all` for global. `resume interject` clears the latch | Never | Fixed ack |
| `/clo model`, any other `/clo` | Ignored. Model changes are console only | Never | None |
| `/new`, `/reset`, standalone only | Forward with `commands.authorized:true`. Bypasses the queue | Yes | Host text discarded; exit sends a fixed ack |
| `/stop`, standalone only | Forward with `commands.authorized:true`, bypasses the queue, sets `aborted` on the group's in-flight turn. Messages older than it that have not started (real @, reply-to-bot, name, window representative) end `skipped:owner_stop` and spend nothing, because the host refuses any turn no newer than `/stop`. Crisis-list messages still go on and get the failure line. An interjection route stops even with crisis words unless the model flagged crisis, and also when its timestamp is no newer than `/stop`'s. A reply waiting for send room stops too, unless written for a person in danger. A member's `/stop` has no effect | Yes | Same. The aborted turn finishes `failed:aborted` and sends no fixed line |
| Anything else | `ignored:cmd_unknown` | Never | None |

- `commands.authorized` is `true` only for the two rows above. An owner's ordinary message gets `false`, so inline directives and bare abort words do nothing special.
- In dry-run every command is `dry_run:would_cmd`, sends nothing, reaches no host. Control in dry-run is console only.
- Commands bypass G8, so an owner can resume. Their ack goes through `exit.commandAck`, which requires `live` but is exempt from pause.
- A non-owner's `stop`, `停止` and similar are plain text.

## 6. Exit

`connection.js` constructs the SDK object and hands it only to `createExit`. Nothing else may hold it. `outbound.sendText` throws unconditionally and logs `outbound_send_attempt`, which is stricter than the plan's "no row, no send".

### 6.1 `collect` (the host `deliver` callback)

| Payload | Result |
|---|---|
| Turn unknown, stopped, or `kind!=='final'` | `{visibleReplySent:false, suppression:{reason:'channel_transform', cancelReason}}` |
| `isError:true` | Set `turn.hostError`, log `exit_drop host-error-text`, same suppression. Provider and host text never reach QQ |
| Empty, or a silent token (`NO_REPLY`, `HEARTBEAT_OK`, `ANNOUNCE_SKIP`, `REPLY_SKIP`, any case, surrounding space) | Same suppression |
| Command turn | Discard text, same suppression. `finishTurn` sends the ack |
| Otherwise | Append to the turn buffer. Return `{messageIds:[], visibleReplySent:true}`. No POST |

### 6.2 `finishTurn`

Text = buffer joined with `\n\n`. Then:

0. Command turn: `commandAck` with the fixed ack, state `completed:cmd_owner`. Host text is discarded. Stop here.
1. Aborted: state `failed:aborted`. Nothing sent.
2. Empty text: required turn sends `modelFailed` through `sendFixed`, state `failed`, reason `host_error` or `required_no_text`, alert, unless paused. Optional turn: state `silent`.
3. `authorizeReply`, in order. Each failure is a drop with a logged reason:
   1. `getEffective()` readable. 2. `mode==='live'`. 3. `terminal_close` unset. 4. `appId` matches. 5. Turn in `dispatching`, group still admitted. 6. Not paused (global or group). 7. `now < deadlineAt`, otherwise `failed:deadline`. Never converts to proactive.
4. `policy.checkLeak` on the whole text with current secrets and this turn's raw IDs, then `policy.check`. A throw counts as a hit. **Hit:** state `policy_dropped`. Required class sends `policyDropped` once. `interject` is silent. Bump `policy_drop:<day>:<ruleId>:<path>`. No retry, no rewrite, no re-generation, no split, no alternate path.
5. Plain text: strip Markdown emphasis, headings and fences; `[a](b)` becomes `a b`. `msg_type` stays 0. This and step 6 run after the policy check, so the policy sees the model's own text.
6. URL guard: any `http(s)` URL not in `turn.inboundUrls` becomes `[链接已移除]`. Search is out of scope, so no other source of URLs exists.
7. Split: group `maxPartsGroup` parts of at most `maxPartChars`, on paragraph then sentence boundaries, then truncated. `interject`: 1 part, cut at the last sentence end within `interjectMaxChars`.
8. `insertSendParts` atomically (rate). State `delivering`. Refused: `failed:send_rate`, alert, no fixed line.
9. For each part: `crashpoint('before_post')`, `markSend(sending)`, `bot.api.post(path, {content, msg_type:0, msg_id, msg_seq})`, `crashpoint('after_post')`, record the result. Stop at the first non-success; remaining parts `aborted`.

Group route only: `/v2/groups/{encodeURIComponent(groupId)}/messages`. `msg_id` is always present. There is no code path without it. `kind:'c2c'` is not built in this build.

`msg_seq` comes from the `sends` table: `MAX(msg_seq)+1` for the event, not a hash. Fixed lines and URL-stripped resends get a new seq.

### 6.3 Send results (SDK `ApiError`: `httpStatus`, `bizCode`)

| Result | Send state | Event result | Other effect |
|---|---|---|---|
| 200 with `id` | `sent` | Continue | `addBotRef(store.key(ext_info.ref_idx))` if present |
| 200 without `id` | `uncertain` | `failed:send_uncertain` | Alert |
| 40054010 (URL refused) | `failed` | One resend with all URLs removed, new seq, kind `reply_url_stripped`. Second refusal: `failed:group_error` | Never obfuscates URLs |
| 40054005 (dedupe) | `sent` only if a prior `sent` row for this event and seq has the same `text_sha`; otherwise `uncertain` | `completed` or `failed:send_uncertain` | Not assumed sent |
| 40034128, 40034005, 304103 (passive window or ID expired) | `failed` | `failed:passive_expired` | Addressed: alert |
| 40034006 (content violation) | `failed` | `failed:platform_violation` | No retry, no rewrite, **no fixed line**, text never feeds rules or prompts. `violation:<day>` at 2 sets `interject_paused` and alerts |
| 40054002, 40034101, 40054003 | `failed` | `failed:group_error` | `group_paused:<groupKey>`, alert |
| 40034105, 40034100, 40054013 (DM codes) | `failed` | `failed:group_error` | Should not occur here. Alert |
| Timeout, network error, unknown code | `uncertain` | `failed:send_uncertain` | Never re-POST |

Alerts go to the event log and the `alerts` table, read by `status`. No proactive DM, because that path is unproven.

### 6.4 `sendFixed` and `commandAck`

`sendFixed` applies: effective readable, `live`, no terminal, admitted, **not paused**, within deadline, `failline` counter for `modelFailed`, `policy.check` on the line, one part, kind `fixed_line`. `commandAck` is the same but exempt from pause and `failline`, kind `command_ack`. If refused for send rate it waits for room once, inside the passive window, then alerts `command_ack_refused`. Both are passive replies with `msg_id` and use the same POST routine as `finishTurn`.

`authorizeReply`, `sendOneLine` and `mayRetrySend` treat `qq.enabled=false` the same as the group being removed (`not_admitted`), because the host defers the channel reload until active work ends, so turning QQ off does not stop a running turn by itself.

## 7. Configuration and modes

### 7.1 `config.json` (gitignored), shipped as `config.example.json`

```json
{
  "mode": "dry-run",
  "gatewayPort": 18790,
  "budget": { "dailyUsd": 2.5, "interjectUsd": 0.75, "searchUsd": 2.10, "namedUsd": 2.25, "addressedUsd": 2.5, "keyDailyLimitUsd": 1.60 },
  "claudeModel": { "id": "opus-latest", "effort": "low", "maxTokens": 3000, "cacheRetention": "short", "contextTokens": 24000 },
  "decisionModel": { "id": "anthropic/claude-haiku-5.5", "effort": "none", "maxTokens": 200 },
  "searchProvider": "none",
  "timeouts": { "decisionMs": 8000, "turnSeconds": 90 },
  "names": ["可洛", "可洛小姐", "Clo"],
  "interject": { "cooldownMinutes": 8, "perHour": 6, "perDay": 8, "windowMs": 4000 },
  "quietHours": { "start": "23:00", "end": "08:00", "timezone": "Asia/Shanghai" },
  "retention": { "eventDays": 14, "sendDays": 14, "reservationDays": 90, "contextMaxItems": 40, "contextMaxAgeHours": 24, "contextMaxTokens": 3000 },
  "qq": {
    "enabled": false, "appId": "", "apiBaseUrl": "", "tokenBaseUrl": "",
    "owner": { "dm": [], "groupMember": {} },
    "allowedDmUserIds": [], "allowedGroupIds": [], "groups": {},
    "urlMode": "names", "maxPartChars": 1500
  },
  "contentPolicy": {
    "enabled": true, "version": "1", "file": "persona/CONTENT-POLICY.md", "sha256": "",
    "outputFilter": { "rulesFile": "policy/rules.json", "categories": ["sexual", "crime", "privacy"] },
    "crisis": { "routeTermsFile": "policy/crisis-route.json", "localNumbers": "", "numbersVerifiedOn": "" }
  },
  "privacy": { "replaceSystemPrompt": true },
  "acks": { "q0Recorded": false, "d3": "", "identityConfirmedAppId": "" }
}
```

Group entry:

```json
"groups": { "<group_openid>": { "label": "测试群", "interject": false, "nameMention": false, "noticeGiven": false } }
```

Optional per-group `cooldownMinutes`, `perHour`, `perDay` override `interject`. Default `perDay` is 8 (plan Q7 starts at 6-8; CLAUDE.md §5.3 allows up to 24, which the budget does not cover).

### 7.2 Mapping from CLAUDE.md §4

| §4 key | Here | Validation |
|---|---|---|
| `mode` | `mode` | `dry-run` or `live`. Only `clo mode` writes `live` |
| `accountId` | `qq.appId`; host account is the constant `default` | Non-empty when `qq.enabled`. Must equal `CLO_QQ_APP_ID` at start |
| `ownerUserIds` | `qq.owner.groupMember[groupId]: string[]`; `qq.owner.dm` unused | Enabled group needs at least one owner. Admin rights separate from chat rights |
| `allowedDmUserIds` | `qq.allowedDmUserIds` | **Must be empty in this build** |
| `allowedGroupIds` | `qq.allowedGroupIds` | Empty means closed. Each ID needs a `qq.groups` entry and the reverse. These are group IDs, never sender IDs. Any admitted-group member may chat |
| `claudeModel`, `decisionModel` | same | §3.7 |
| `searchProvider` | same | **Must be `none` in this build** |
| budget, timeouts | `budget`, `timeouts` | Tier ordering §4.5. Timeouts positive |
| Interjection rules | `interject`, `groups[id].interject`, `names` | Off per group by default |
| Quiet hours | `quietHours` | Timezone `Asia/Shanghai` only |
| Retention | `retention` | Context caps at or below 40 items, 24 h |

Rejected always: group or owner IDs containing whitespace; `openrouter/auto`; `qq.urlMode` other than `names`; a non-empty `qq.apiBaseUrl` or `tokenBaseUrl` unless `CLO_TEST_ROOT` is set and the URL is loopback; `crisis.localNumbers` without `numbersVerifiedOn`. IDs differing only by case are distinct and are not rejected.

### 7.3 Modes

| State | Connects to QQ | Gate | Model, decision, reservations | Sends |
|---|---|---|---|---|
| `qq.enabled:false` | No account, `startAccount` never called | None | None | None |
| `dry-run` | Yes | G0 through G9, read-only rules, `would_*` rows | Zero | Zero: exit refuses. No key needed |
| `live` | Yes | Full | Yes | Yes, through exit |

The gate reads mode per message from `effective.json`. No restart needed. `clo mode live` runs `livePreconditions`, all of which must hold:

| Code | Condition |
|---|---|
| `budget` | `dailyUsd > 0` and tier ordering valid |
| `targets` | `allowedGroupIds` non-empty, every group has an owner |
| `dm_closed` | `allowedDmUserIds` empty |
| `key_readable` | `GET /key` works, `limit` non-null, `limit_reset:'daily'` |
| `reconciled` | One successful reconcile |
| `heartbeat` | `heartbeat_at` within 90 s and `last_ready_at` set |
| `identity` | `acks.identityConfirmedAppId === qq.appId`. `clo status` shows masked appId and the READY username for the user to confirm with `clo ack identity` |
| `notice` | Every group `noticeGiven:true`, set with `clo group notice-done <label>` |
| `q0` | `acks.q0Recorded` true |
| `d3` | `acks.d3` is non-empty. **Currently unmet: D3 is pending** |
| `policy` | `contentPolicy.enabled`, hash matches, rules and crisis list parse, `policy-ok` passes |
| `numbers` | `localNumbers` empty, or `numbersVerifiedOn` set |
| `doctor` | The doctor config checks (§7.5) pass |
| `base_urls` | No overrides, unless test mode |
| `no_paid_pause` | `paid_paused` unset |

### 7.4 Rendered `openclaw.json`

Generated only by `clo apply` and `clo mode`, never hand-edited. `tests/unit/render-validate` runs the real `openclaw config validate --json` on it with fake env. A key the validator rejects is removed and reported; do not guess a replacement.

```js
{
  gateway: { mode:'local', bind:'loopback', auth:{mode:'token'}, controlUi:{enabled:false}, reload:{mode:'hybrid'} },
  update: { checkOnStart:false, auto:{enabled:false} },
  discovery: { mdns:{mode:'off'} },
  cron: { enabled:false },
  plugins: {
    allow: ['clo','openrouter'], load: { paths:[<repoRoot>/src/clo-plugin] }, slots: { memory:'none' },
    entries: {
      clo: { enabled:true, config:{ effectivePath }, hooks:{ allowConversationAccess:true } },
      openrouter: { enabled:true },
    },
  },
  channels: { 'clo-qq': /* present only if qq.enabled */ { enabled:true, appId, apiBaseUrl, tokenBaseUrl } },
  models: { mode:'merge', catalogRefresh:{enabled:false},
    providers: { openrouter: { models:[{ id, name, reasoning, input:['text'], contextWindow, maxTokens, cost:<locked price> }],
                               /* baseUrl, apiKey fake, allowPrivateNetwork: test mode only */ } } },
  agents: { defaults: {
    model: { primary:'openrouter/<id>', fallbacks:[] },
    models: { 'openrouter/<id>': { params:{ effort, maxTokens, cacheRetention } } },
    workspace, userTimezone:'Asia/Shanghai',
    skipBootstrap:true, contextInjection:'always', bootstrapMaxChars:20000, bootstrapTotalMaxChars:60000,
    heartbeat:{ every:'0m' }, silentReply:{ group:'allow' },
    timeoutSeconds:90, blockStreamingDefault:'off',
    compaction:{ memoryFlush:{ enabled:false } },
  } },
  messages: { visibleReplies:'automatic' },
  session: { dmScope:'per-channel-peer', resetByType:{ group:{ mode:'idle', idleMinutes:120 } } },
  tools: { allow:['clo_feature_status'], toolSearch:false, deny:DENY, media:{ image:{enabled:false}, audio:{enabled:false}, video:{enabled:false} }, elevated:{enabled:false} },
}
```

`DENY` is enumerated. **It must not contain `group:*`** (observed: `No callable tools remain`, every turn fails):

```js
['message','web_search','web_fetch','x_search','memory_*','exec','process','read','write','edit','apply_patch','ls',
 'sessions_*','subagents','secrets','tts','cron','gateway','openclaw','session_status','tool_call','tool_describe','tool_search']
```

CHANNEL verifies the final tool list on the real Gateway (`e2e/tool-list`) and the deny list includes everything the "deny only" run in `prompt.json` showed. `e2e/qq-prompt-observation` writes that file under a fresh `clo-prompt-observation-*` folder in the temp directory and prints the path. Secrets are only env: `CLO_QQ_APP_SECRET` read by `resolveAccount` from `process.env`; `CLO_CHAT_API_KEY`, mapped at start to the `OPENROUTER_API_KEY` that the host provider and `getKey()` read. `PERPLEXITY_API_KEY` is never set.

The real-provider half of this render (no `baseUrl`, env key, native OpenRouter route, attribution headers, cache markers) cannot be exercised offline; the trial's mock URL does not take that route. Q5 verifies it, and until then it is read, not observed.

The plugin config schema becomes `{ effectivePath, generationTag }` and the channel schema `{ enabled, appId, apiBaseUrl, tokenBaseUrl, reloadTag }`. `clientSecret` and `trial*` keys are removed. The trial's logging moves to `lib/core/log.js`; e2e reads `eventLog` instead of `trial.jsonl`.

### 7.5 `status` and `doctor`

`store.statusSnapshot(now)` returns mode-independent facts: `paused`, `paidPaused`, `terminalClose`, `connected`, `lastReadyAt`, `heartbeatAt`, spend by tier for today, `unsettled`, event terminal counts today, sends `uncertain`, unacked alerts, `botRefsSeen`, `sendsNoRef` (state `sent`, null `ref_key`, null `qq_code`; a null key can also mean `ref_idx` was not a string, and only `exit_post`'s `refState` tells them apart), `decisionPausedAt`, `skipClassToday`. `clo status` adds mode, masked appId, group labels, project PID liveness.

**Liveness:** project PID alive and `heartbeat_at` fresh (plugin timer every 30 s). `/readyz` and `[gateway] ready` are not liveness; they depend on channel state (observed). `connected` is set `true` only from the SDK `ready` or `resumed` events and `false` on `disconnected`. `startAccount` sets `running` only.

**Doctor checks** (read only; values never printed): lock versions match installed; `openclaw-qqbot` and `@agent-wechat/agent-wechat` absent; `plugins.entries.clo.hooks.allowConversationAccess===true`; hook `before_agent_run` registered via `openclaw plugins inspect clo --runtime --json`; `skipBootstrap:true`; actual `bootstrapMaxChars` and `bootstrapTotalMaxChars` hold AGENTS.md whole; `contextInjection` not `never` or `continuation-skip`, including any `agents.entries` and `agents.list` override; `tools.allow` non-empty, `toolSearch:false`, `group:*` not in deny; `silentReply.group:'allow'`; `session.dmScope:'per-channel-peer'`; `AGENTS.md` policy section sha equals `CONTENT-POLICY.md`; persona hashes match; `CLAUDE.md` §7.1-7.5 hash matches `tests/fixtures/claude-md-7x.sha256`; `openclaw.json` matches a fresh render; DB `user_version`; `allowedDmUserIds` empty; proxy env and `PERPLEXITY_API_KEY` absent in the Gateway env; Node path is private; warns if the project is under a cloud-synced folder.

### 7.6 CLI

`scripts\clo.ps1` passes to `src/cli/clo.mjs`:

`apply`; `mode show|dry-run|live`; `pause [--group <label>|--all]`; `resume [--group <label>|--all|--interject]`; `status`; `group list|add <label> --id <id>|remove <label>|set <label> --interject on|off --name-mention on|off|notice-done <label>`; `owner add <label> --id <id>`; `targets arm --minutes <n>|list [--reveal]|clear`; `budget show|accept-unsettled`; `policy test <file>|rule disable <id> --reason <text>|hash`; `model show|set-primary <id>|set-decision <id>|refresh|check` with `--confirm-price` and `--qq-platform-notified` (required for any model change when `qq.enabled`); `ack identity|q0|d3 <value>`; `doctor`; `start`; `stop`.

**Discovery:** group IDs and owner IDs must be learned somehow, and non-admitted traffic normally writes nothing. `targets arm` sets `discovery_until` (15 minutes at most, dry-run only). While armed, the gate writes raw `group_openid` and `member_openid` to `discovery`, no text or names. `list` masks unless `--reveal`. `clear` and any `mode live` wipe the table. This is the only place raw IDs rest in SQLite.

**Lifecycle** (`src/cli/lifecycle.mjs`; `.ps1` scripts are thin wrappers):
- `start`: refuses if the PID file's process is alive and matches. `clo apply`. Parses `.env` for **named keys only** (`CLO_QQ_APP_ID`, `CLO_QQ_APP_SECRET`, `CLO_CHAT_API_KEY`). Spawns `openclaw.mjs gateway run --port <p> --bind loopback` with the private Node, `detached`, `windowsHide`, stdio to `gatewayLog`, **cwd = `paths.gatewayCwd` (empty dir, never the project root)**, env built from an allowlist like `tests/harness/gateway.mjs` `childEnv`, never inherited. The Gateway token is random, created once in `.runtime/clo/gateway.token`, passed by env and never printed. Writes PID, start time and command-line digest. Not run against real QQ in this build.
- `stop`: reads the PID file, checks start time and command line, `taskkill /PID <pid> /T /F`. Never by name. Removes the PID file.
- `CLO_TEST_ROOT` set: `.env` is read from `$CLO_TEST_ROOT/.env`. **`resolvePaths` throws if `envFile` would resolve to the real project `.env` while `CLO_TEST_ROOT` is set.** Also in test mode only: `CLO_TEST_NODE_IMPORT` adds `net-guard`.
- `_env.ps1` honours `CLO_TEST_ROOT` for `$Rt`.
- Real runs keep the plugin's `OPENCLAW_OFFLINE` unset; the harness sets it. Q5 records whether that matters.

## 8. Host wiring

### 8.1 Identity and session

`peer.id`, `conversation.id`, `routePeer`, `reply.to`, `originatingTo`, `nativeChannelId`, `from`, `sender.id`, `subject.stableId` all use `sessionPeerId(...)`, not raw IDs. The host never sees a raw openid. That fixes the observed lowercasing bleed (TQ15) and keeps openids out of the prompt. Exit and the gate alone keep raw IDs, from the Turn. Sender label in `HistoryEntry` is the `U1` pseudonym, or the `U1（显示名：小明）` label for a group with `displayNames` on, where `turn.speakerLabel` also goes to the host as a structured context entry. `sender.name` and the frame body stay on the code, because the host stores those with the turn.

`rt.inbound.ingress.resolve` keeps being called for `channelIngress`. If `ingress.admission` is not the observed allow value `dispatch`, release the hold and end `skipped:ingress`. The gate's decision stays authoritative in the other direction: `dispatch` from the host does not admit anything the gate refused.

### 8.2 Turn body

`bodyForAgent` is framed: first line `[clo-turn class=<cls> time=<YYYY-MM-DD HH:mm> Asia/Shanghai]`, then the text. `rawBody` and `commandBody` are unframed. Authorized commands pass the bare command. `persona/AGENTS.md` says only the first line counts, and only `class=interject` may answer `NO_REPLY`. A member typing a look-alike line changes nothing that local rules bound.

### 8.3 System prompt privacy

Observed: the prompt carries `host=<machine name>`, `os`, `shell`, a workspace path and docs path containing the Windows username, and the session key.

Documented option: `before_prompt_build` returning `systemPrompt` replaces the whole prompt. So with `privacy.replaceSystemPrompt:true`, the hook returns the file `paths.systemPromptFile`: `CONTENT-POLICY` + `AGENTS` + `SOUL` + `IDENTITY`, rendered by `renderWorkspace`. That also removes the host text in tension with the project: "Write like a human", "mostly lurk", `message(action=send)`, Execution Bias.

- Workspace `AGENTS.md` is still written with the same policy on top, so if the hook fails open (`before_prompt_build` failures log and skip) the host prompt still carries the policy, and `before_agent_run` still checks it.
- `before_agent_run` runs in both modes and fails closed.
- The channel addendum goes in `AGENTS.md`, below the policy end marker, since this build is group-only. When DM returns it moves to `GroupSystemPrompt`.
- `e2e/qq-prompt-privacy` asserts, across every model request body in the run: no machine hostname, no Windows username, no `Windows_NT`, no project root path, no temp path, no fake raw openid, no appId, with a positive control (the policy sentinel and a canary from the text are present). A second stack with `replaceSystemPrompt:false` records what remains. If the replacement breaks a turn, the default becomes `false`.

**What remains regardless, to be reported in `DEPLOYMENT.md`:** the compaction request is not covered (host fixed prompt; not triggered offline); `clawhub.ai` startup traffic has no documented switch (observed refused by net-guard); cache-marker behaviour of a replaced prompt on real OpenRouter is unknown until Q5; host fallback mode leaves `host`, `os`, `shell`, paths, and a hashed session key.

### 8.4 Hooks

| Hook | Behaviour |
|---|---|
| `before_prompt_build` | As §8.3. Returns nothing else |
| `before_agent_run` | `checkSentinels(event.systemPrompt, version)`. Fail: `{outcome:'block', reason:'content-policy-check'}`, alert, no policy text in the message. Applies to every session. No `systemPrompt` blocks. The resulting error reaches `collect` as `isError` or an empty final; exit sends the failure line on required turns |
| `before_tool_call` | Only `clo_feature_status`; anything else blocks. Reserve a `tool_round`; refused blocks. More than 2 rounds per run blocks. Handler failure fails closed (documented) |
| `model_call_ended` | Log whitelist only. Bump or reset `provider_fail_streak`, primary calls only (§4.5). A success also ends `credits_probe` |
| Diagnostic `model.usage` | `onInternalDiagnosticEvent` from `openclaw/plugin-sdk/diagnostic-runtime`, via `createUsageTracker`. Import failure at start: `paid_paused=usage_unavailable`. `diagnostics.enabled` is never rendered false |

Tools: `clo_feature_status` only, inert. Registered in `tools.js`. Reminder, memory and search tools are not registered.

### 8.5 Persona

- `persona/CONTENT-POLICY.md`: plan lines between and including `<!-- clo-policy:1 -->` and `<!-- clo-policy-end:1 -->`, byte for byte. sha256 of that block in the plan today: `f0ed566dc5f7b4e0b0c84111faf24d32f59c40cd8871ef0ba7bd23b938b70048` (LF, no trailing newline).
- `persona/SOUL.md`: CLAUDE.md §7.3 quoted text without the `> ` prefix, then §7.4 bullets. `IDENTITY.md`: name and §7.2 background. `examples.md`: §7.5 table.
- `persona/AGENTS.md`: channel notes. Must state: this section has priority over host wording about acting human and over tone; never claim to be human; `urlMode:names` means name sources, no links; the plan's group addendum verbatim (`群聊：内容范围照常适用。…`); required-answer and `NO_REPLY` rule from §8.2. It carries no security rule on its own.
- `persona/decision-prompt.zh.md`: this base, then the plan's addendum verbatim, except that its 例外 line is replaced by `crisis 单独判断，只看 current：这条消息里有人表露自伤自杀，遭受或曾遭受虐待、性侵，或处于紧急危险时 crisis=true，否则 false；lines 里的话不算。action 和 skip_class 仍按上面判断，不因 crisis 改变，need_search=false。` Past the caps the answer has to mean what it would without crisis:

```text
你在判断聊天机器人“可洛”此刻是否该在 QQ 群里接话。输入是 JSON，含 trigger、最近几行群消息 lines 和当前消息 current。发送者只是代号。current.text 很长时中间会被省略，省略处用 … 标出。
trigger=ordinary：普通消息。只有有人明确求助、可洛能补充相关事实、或与近期对话相连的轻松话题时才 reply；群友之间无需她参与的对话、争吵、刷屏、纯表情、明显私人的交流都 skip。
trigger=name：消息提到了她的名字。只有这句话确实在对她说话才 reply；引用、转述、讨论她的名字都 skip。
trigger=crisis_route：只判断 crisis，其余一律 skip。
拿不准就 skip。
```

- `persona/policy-lines.zh.json`: `{ "policyDropped": <plan 过滤命中>, "modelFailed": <plan 预算耗尽或模型失败> }`, verbatim. Reminder lines are not included.
- `persona/group-notice.zh.md`: draft for the user to tell members. States what is read, and that Haiku and Claude providers receive admitted text. The bot never posts it.

`tests/fixtures/claude-md-7x.sha256` holds `98b6ea7587afd1e5387f8e0ca0ed5344fd269a6e607da3d19500d94d38a03320`: sha256 of the bytes of `CLAUDE.md` from `### 7.1 ` up to, not including, `### 7.6 `.

### 8.6 Rules files

`policy/rules.json`: `{ version, rules:[{ id, category, pattern, basis, addedBy, addedAt, status }] }`. Categories `sexual`, `crime`, `privacy` only. `pattern` is a `u`-flag RegExp source run on `normalizeCopy(text)`. A short hand-written list. **No political term. No self-harm term.** Not imported from any community list. Outbound text is never altered.

`policy/crisis-route.json`: `{ version, terms:[...], basis, addedBy, addedAt }`. Self-harm, abuse and emergency phrases. Only `isCrisisRoute` reads it.

`policy-ok.zh.txt`: ordinary sentences and crisis replies (abuse, overdose, being scammed, first aid, 110 and 120). Any rule hit fails CI. `policy-hit.zh.txt` is the positive control.

## 9. Connection

- `new QQBot({ appId, appSecret, accountId, baseUrl, tokenBaseUrl, intents: 1<<25, userAgent })`. **Remove `reconnect:{maxAttempts:5}`.** SDK default is `Infinity` with delays `[1000,2000,5000,10000,30000,60000]`, and it refreshes or re-identifies on 4004, 4006, 4007, 4008, 4009 (read). Reconnect after 1000 and 1006 is observed.
- No `sessionPersistence`, no SDK `historyBuffer`, no middleware.
- `start()` rejecting `GatewayError` with `closeCode` 4914 or 4915 is fatal: `terminal_close=<code>`, status `{running:false, connected:false, terminalDisconnect:true, lastError:'gateway closed with code <code>'}`, alert quoting the code with no inferred cause, return without rethrow.
- Any other rejection, such as a token fetch failing at startup, must not reach the host: its restart gives up after 10 tries (read). `runConnection` loops itself, `bot.start` again after backoff `[5000,15000,30000,60000]` with the last repeating, until abort. The SDK says a stopped bot can be started again. Ten consecutive failures raise one alert and the loop keeps going.
- `ready` and `resumed` set `connected:true` and `last_ready_at`. `disconnected` sets `connected:false` and logs the code. Hourly code 1000 then RESUME is expected and raises no alert.
- A message during a disconnect is treated as lost (two samples). Dedupe and staleness stay on because the SDK warns about duplicate delivery. README states the loss.
- Handler: `normalize(msg.rawEventType, structuredClone(msg.raw), { receivedAt })`. `void onInbound(...).catch(log)`. `rawEvent` (`GROUP_ADD_ROBOT`, `FRIEND_ADD` and others) is not subscribed.
- `ctx.channelRuntime` absent: fall back to `api.runtime.channel`; both absent: `terminalDisconnect`, zero connections (kept from the trial).
- Heartbeat timer every 30 s writes `heartbeat_at`, stopped on abort.

## 10. Test map

Rules for every test file:
- R1. Temp cwd, fake keys, loopback mocks, net-guard. Never read `.env`. Private Node only.
- R2. Every negative assertion has a positive control in the same run. "0 POSTs" needs a prior POST from the same stack in that file.
- R3. The "every POST is legal" check runs last in its file, as both the final `test` and in `after`, against `sends` rows from the temp DB: each message POST maps to one `sent`, `failed` or `uncertain` row, carries `msg_id`, and has a monotonic `msg_seq`.
- R4. Every e2e model call asserts `model`, `max_tokens`, `reasoning.effort` if present, no `fallbacks`.
- R5. Do not weaken a test to pass it.

Replacements for the weak tests:

| Old test | Replacement |
|---|---|
| CLI zero-POST (cannot fail) | `e2e/qq-outbound-closed`: run `openclaw message send`; assert non-zero exit, **`outbound_send_attempt` in the event log or our closed message in stderr**, zero new POST. Positive control: a pushed event produced one POST immediately before |
| `plugins reload` (passes with `--version`) | `e2e/qq-lifecycle`: assert a new `MODULE_INSTANCE`, old socket closed, peak connections 1, and one message gives one reply |
| Regex single-exit scan | `unit/qq-single-exit`: parse every file under `src/clo-plugin/` with `acorn`. Fail on: import of the SDK outside `connection.js`; dynamic import of it; `connection.js` passing `bot` anywhere but `createExit`; member access or destructure of `api`, `apiClient`, `messageApi`, `mediaApi`, `chunkedMediaApi`, `tokenManager`, `getCredentials`, `send*`, `apiRequest`, `openStream`, `uploadMedia`, `recallMessage`, `acknowledgeInteraction`, `sendWakeup` outside `exit.js`; bracket access on the bot; `fetch` outside `decision.js` and `ledger.js`. A fixture directory of planted offenders (aliases included) must all be flagged |
| Same | `unit/qq-exit-runtime`: stub `globalThis.fetch` and wrap the bot in a recording `Proxy`; run scenarios; assert only exit touched send members, every message-route POST has a `sends` row, the rest are token or gateway |
| "Every POST legal" mid-file | R3 |

### 10.1 CLAUDE.md §10

| Row | Test file | Status |
|---|---|---|
| Non-allowlisted group, DM, wrong account | `unit/gate-identity`, `e2e/qq-group-reply` | In scope. DM asserts zero model, zero reply |
| Own message, catch-up, replay | `unit/gate-identity`, `seam/qq-replay`, `e2e/qq-crash-matrix` | In scope |
| Real @ in admitted group | `e2e/qq-group-reply` | In scope |
| Non-owner @ and admin attempt | `unit/gate-commands`, `e2e/qq-commands` | In scope |
| Other's @ or name only | `unit/classify` | In scope |
| @all | `unit/classify`, `e2e/qq-group-reply` | In scope |
| Irrelevant or failed decision | `unit/decision-policy`, `e2e/qq-interject` | In scope |
| Good interjection within quota | `e2e/qq-interject` | In scope |
| Concurrent ordinary, atomic quota | `unit/quota-atomic` (two processes on real SQLite), `unit/window` | In scope |
| Real @ during cooldown | `unit/gate-limits`, `e2e/qq-interject` | In scope |
| Pause, no budget, owner impersonation | `unit/gate-limits`, `seam/failure-line`, `unit/gate-commands` | In scope |
| Search success, timeout, no source | none | **Deferred (search)** |
| Injection for keys or cross-group history | `unit/prompt-injection-policy`, `unit/qq-policy-exit` (leak), `e2e/qq-identity` (cross-group) | In scope for group paths |
| Restart, uncertain send | `e2e/qq-crash-matrix`, `unit/qq-send-results` | In scope |
| DM memory vs group memory | none. Group context isolation is in `e2e/qq-identity`, `e2e/qq-context` | **Deferred (memory, DM)** |
| Reminder create, cancel, restart, due | none | **Deferred (reminders)** |

### 10.2 TQ items

| TQ | Test file | Status |
|---|---|---|
| TQ01-09 | Q0 records in `DECISIONS.md` | Done or real-only; not in this build |
| TQ10 | `e2e/qq-load` | In scope |
| TQ11 | `e2e/qq-lifecycle` | In scope |
| TQ12 | `e2e/qq-group-reply` | In scope |
| TQ13 | `e2e/tool-list` | In scope: exact tool list with `toolSearch:false`, and a control without policy that offers `message` |
| TQ14 | `e2e/qq-commands`, `unit/gate-commands` | In scope, including mid-text `/model`, `/think`, bare `stop` and `停止` from non-owner and owner |
| TQ15 | `unit/qq-identity`, **`e2e/qq-identity` on the real Gateway**: two groups whose IDs differ only by case. Canary from one absent in the other's model body; two session keys; POST paths keep exact case. Positive control: same-group second turn does see the canary | In scope |
| TQ16 | `unit/qq-single-exit`, `unit/qq-exit-runtime`, `e2e/qq-outbound-closed` | In scope |
| TQ17 | `unit/qq-send-results` | In scope, full error table |
| TQ18 | `unit/qq-passive` | In scope: 285 s, 5 parts, 400 chars interject, never proactive |
| TQ19 | `seam/qq-replay`, `e2e/qq-crash-matrix` | In scope |
| TQ20 | Q9 real | Not in this build |
| TQ21 | `unit/qq-redaction`: canary body and raw IDs absent from event log and DB after a seam run; `e2e/qq-group-reply` scans gateway log too and reports transcript contents | In scope. **Delete part deferred with memory** |
| TQ22 | `unit/content-policy` | In scope. `policy-ok` false positive fails CI |
| TQ23 | `unit/qq-policy-exit` | In scope for group |
| TQ24 | `unit/qq-send-results` | In scope |
| TQ25 | `e2e/qq-multi-payload` | In scope. Forbidden phrase across two payloads: zero POST; clean two payloads: one flush, parts in order |
| TQ26 | `seam/policy-pregate` | In scope |
| TQ27 | `e2e/policy-sentinel`, `unit/doctor` | In scope: missing, truncated, order swapped, no prompt all block with zero model calls; intact passes (control); missing `allowConversationAccess` fails doctor and observes no hook |
| TQ28 | `unit/decision-policy` | In scope, plus: no member-to-category row (schema assertion) |
| TQ29 | none | **Deferred (search)** |
| TQ30 | none | **Deferred (memory, reminders)** |
| TQ31 | `e2e/provider-refusal` | In scope: 403, 200 with `message.refusal`, mid-stream error, empty text. Text never reaches QQ; failure line once |
| TQ32 | `unit/prompt-injection-policy` | In scope, code paths only: config, lists, markers unchanged; no model behaviour asserted |
| TQ33 | `unit/policy-render` | In scope: policy file equals plan block; `AGENTS.md` section sha; §7.1-7.5 baseline |
| TQ34 | `seam/failure-line` | In scope: once with rate limit; not when paused |

### 10.3 Other design items

| Item | Test file |
|---|---|
| Crash matrix, each row, kill at named crashpoint | `e2e/qq-crash-matrix` (real Gateway), `unit/store` (recovery table on real SQLite) |
| Ledger state machine, tier rule, reconcile, residual | `unit/ledger`, `unit/ledger-reconcile` |
| Real `model.usage` settlement, hold release, no-usage branch | `e2e/qq-settlement` |
| NO_REPLY on required turn: 2 model calls, `isError` dropped, fixed line, alert | `e2e/qq-group-reply` |
| NO_REPLY on interject: 1 call, silent, cooldown consumed | `e2e/qq-interject` |
| `/status` in group: no cost, token, session key | `e2e/qq-commands` |
| Connection: no giving up after many failures; 4914 and 4915 terminal; `connected` only from READY | `e2e/qq-lifecycle` (mock supports withholding READY and refusing connections for N attempts) |
| Prompt privacy | `e2e/qq-prompt-privacy` |
| Recent context reaches model, not transcript | `e2e/qq-context` |
| A line with its own turn still to come stays out of the turn before it | `unit/gate-pending-history`, `e2e/qq-pending-history` |
| Normalize on captured shapes | `unit/normalize` with `fixtures/qq-events` (type 103, `<@all>`, leading space, `mentions` forms) |
| Script bans | `unit/script-bans` |
| Start, stop, status with mocks and project PID only | `unit/lifecycle` |
| Live preconditions | `unit/cli-mode`, `unit/config` |
| Render golden, real validator | `unit/render`, `unit/render-validate` |

### 10.4 Harness additions (CHANNEL owns; others use read-only)

`mock-qq`: `setSendScript(fn)` returning `{ status, body }` for error codes; `{ ready: false }` option; `refuseConnections(n)`; response `ext_info.ref_idx` when scripted. Keep existing `push`, `closeAll`, `requests`, `opened`, `peak`, `connected`.

`mock-openrouter`: `GET /models` from a fixture catalog; `GET /key` via `setKey(obj)`; script steps gain `usage`, `error:{status, body}`, `refusal`, `midStreamError`. Non-streaming decision bodies supported. The mock's `model` config row cost stays settable.

`gateway`: `startStack({ effective, config, env })`, writing `effective.json` and fake `CLO_QQ_APP_SECRET`, `CLO_CHAT_API_KEY` (passed to the host as `OPENROUTER_API_KEY`). `s.events()` reads `eventLog`. `s.db()` opens the temp DB read-only. Crash tests pass `CLO_TEST_ROOT` and `CLO_TEST_CRASH_AT`. Stops are by handle or PID only. Spawn cwd stays the temp dir.

## 11. Deviations from the plan, for the report

1. G2 runs before G1, since non-admitted traffic must leave no row.
2. Real @ and reply-to-bot are never merged. Each has its own passive window and terminal row.
3. Required reply hold is 2 rounds, from the observed `NO_REPLY` behaviour.
4. `outbound.sendText` always throws, rather than checking for a row.
5. At-rest IDs are HMAC keys, and the host sees only `sessionPeerId`. This goes beyond the plan.
6. Per-sender crisis cap is memory only, reconciling the plan's cap with "crisis is not retained" and TQ28.
7. Name decisions are charged to `named`, not `interject`, so a spent interject tier cannot silence a direct name address.
8. Interject quota and cooldown are consumed when the model runs, not when a message lands. So `NO_REPLY` costs a cooldown. This is the conservative reading of CLAUDE.md §5.4.
9. Replacement system prompt is new (§8.3) and subject to A3.
10. Group addendum sits in `AGENTS.md` for now.
11. REST liveness probe deferred.
12. Owner `/new`, `/reset`, `/stop` host text is replaced by fixed acks. `/status` never reaches the host.

## 12. Integration order

CORE and GATE and CHANNEL and OPS start together against §3. Each runs its own unit tests with stubs where needed. Merge check, in order:

1. `node --test tests/unit/*.test.mjs`
2. `node --test tests/seam/*.test.mjs`
3. Relevant e2e files one at a time. Full e2e only at the end (about 15 minutes before this build's additions, and it will grow), with `--test-concurrency=1`.

Report per test file: passed, failed, skipped. Report observed versus read. If something cannot work, give the blocker with its exact error text.

## Contract changes

Corrections and additions made while building, smallest first. Each overrides the section it names.

The 2026-11-05 edits here and in the sections above (decision breaker, reason rank, credits wait, several names in a window, crisis caps, `/stop`, longer decision input) describe code run offline only. Nothing of them has run on real QQ or with a real model, and the Gateway has not been restarted.

### From CORE

**Corrections**

1. **§7.4 `params.thinking`, not `params.effort`.** Observed once on the real Gateway with the mock model: `params:{effort:'low'}` was ignored and the request carried `reasoning:{effort:'medium'}`. `params:{thinking:'low'}` produced `reasoning:{effort:'low'}`. `thinking` is also the documented key (`docs/tools/thinking.md`). Real OpenRouter is still unverified (Q5).
2. **§7.4 provider row gains `contextTokens`.** It is the documented input cap (`custom-providers.md`); without it the 24000 cap behind the hold arithmetic is not enforced by the host. `contextWindow` is a constant 200000, host metadata only. Q5 should check it against the catalog.
3. **§4.4 `delivering` rows also set `paid_paused=crash_unsettled`** when a hold goes `unsettled`, including the "all sent, before O6" row. The table set it only for `dispatching`. In all of these the model ran and the cost is unknown, §4.5 pauses on the same condition (`usage_missing`), and CLAUDE.md §8 says to pause new paid requests when settlement is unclear. A crashed turn with no hold, such as an owner command, does not pause. `deciding` still does not pause: §4.5 leaves decision holds unsettled without one. An `after_post` or `before_settle` crash therefore stays paused until reconcile settles the row or `clo budget accept-unsettled`, so `e2e/qq-crash-matrix` control messages after those crashes need one of those.
4. **R4: the token limit field is `max_completion_tokens`** on the mock route (observed), not `max_tokens`. With `reasoning:true` in the test render, `reasoning.effort` is present and can be asserted.

**Additions to §3**

5. `validateBusinessConfig` also returns `warnings`. A group with no owner is an error only when `mode` is `live`, and a warning in dry-run. Otherwise `clo group add` could never precede `clo owner add`.
6. `modelsLock` for `buildEffective` is `{ primary: { id, selector, price }, decision: { id, price } }`, produced by `models.lockFromCatalog(cfg, catalog)`. `null` is allowed before a catalog read: `models.primary.id` and prices are then null, `renderOpenclaw` omits the model and provider blocks, and `holdMicros` throws, so nothing paid can proceed.
7. `livePreconditions(cfg, facts)`, facts: `{ now, key, reconciled, heartbeatAt, lastReadyAt, policyOk, doctorOk, paidPaused, modelsLocked, env }`. `key` is a `readKey()` result or null. `heartbeatAt` and `lastReadyAt` are numbers. Code `models` is added, and fails only when `modelsLocked === false`.
8. Test-only config key `openrouter.baseUrl`, under the same rule as `qq.apiBaseUrl`: `CLO_TEST_ROOT` set and loopback. It feeds `effective.openrouter.baseUrl`. `renderOpenclaw`'s `testMode` is truthy, optionally `{ apiKey }`.
9. Paths not fixed by §3.3: `gatewayCwd` is `.runtime/gateway-cwd`, `eventLog` is `.runtime/logs/events.jsonl`, `gatewayLog` is `.runtime/logs/gateway.log`, `pidFile` is `.runtime/pids/gateway.json`, `systemPromptFile` is `.runtime/clo/system-prompt.md`.
10. Store adds `getEvent`, `getSend`, `sendsForEvent`, `getMeta`, `setMeta`, `spendByTier`, and exposes `db`, `q(sql)`, `runGen`. `tx` nests with savepoints and throws if `fn` returns a promise. `insertSendParts` does **not** change the event state: exit wraps it and the `delivering` transition in one `store.tx`. Rate refusal reasons are `account_minute`, `account_hour`, `group_minute`; the event reason stays `send_rate`.
11. `transition` throws on an unknown state or a terminal origin. `transition` and `setClass` throw if `reason` or `cls` is not a short token, so no text can reach the row by mistake. `markSend` returns false on a backward move.
12. Ledger adds `pausePaid(reason, by)`, `noteProviderError({ httpStatus, limitSource })`, `noteProviderOk()` for primary errors, and `noteDecisionError`, `noteDecisionOk`, `admitDecision` for decisions (§4.5); `hooks.js` and the gate report through these. `clearOwnerPause()` backs `clo budget clear-pause`. `reconcile(now, { atStart })`. `settle` returns `{ status }`: `settled`, `unchanged`, or `unsettled`, the last when `actualMicros` is zero or not an integer, except with `source:'manual'`. `applyLateUsage(null, ...)` writes an `unattributed` row. `spent().unsettled` is a count; `unsettledMicros` is added.
13. Reconcile detail left open by §4.5: `unexplained = usage since baseline - settled since baseline - held now`. It settles `unsettled` rows oldest first, each up to its hold, and the rest becomes an `unattributed` row with `source:'key_delta'`. The residual is today's sum of those rows, and the threshold is `max(residualMinUsd, residualPct × provider figure for today)`. A clean read clears `key_read_failed`, `residual`, `provider_fail`, and `openrouter_key_limit` if the key has room; a limit pause clearing with unsettled rows left becomes `usage_missing`. `residual` is today's sum, so it normally lifts only at the first read of a new Shanghai day. `openrouter_credits` clears on a clean read only `budget.creditsRetryMs` (default 1 hour) after the pause was set, since a Key read says nothing about credits. `crash_unsettled` and `usage_missing` clear only at zero unsettled rows. `usage_unavailable` never clears on its own. `clo budget clear-pause` clears `openrouter_credits` and `usage_unavailable` only. It ends the primary streak, then pauses again as `residual` if `residual_over` is 2 or more, or `usage_missing` if rows are unsettled, and says so. `accept-unsettled` and late usage run the same residual check. A figure read before a pause was set says nothing about it. When the usage figure falls (a new Key), unsettled rows settle at their hold with `source:'key_changed'`.

`credits_probe` bounds what follows a credits pause. It is set when one lifts or is relabelled to the Key limit. While live, a primary failure streak pauses as `openrouter_credits`, not `provider_fail`, so a round of failures happens at most once per wait. It ends on any paid success, or 24 hours after it was set (`CREDITS_PROBE_TTL_MS`, a choice, not a spec value). A pause cannot age it, so a lift restarts it. A credits pause relabelled to the Key limit lifts when the Key has room, with no wait.

A provider_fail streak that reached the limit ends when the pause clears under any label (`key_read_failed`, `usage_missing`, `crash_unsettled`, `residual`, either limit reason). A shorter streak has paused nothing and carries across.
14. `log.droppedKeys()` reads the counter. `createLog(path, { gen, now })`. Values longer than 128 characters or not scalar are dropped too. `sessionPeerId` takes `'g'`/`'group'` or `'u'`/`'user'`/`'direct'`.

### From GATE

**What CHANNEL needs to know**

1. **Turn gains three fields.** `senderId` (raw, exact case, memory only; dispatch needs it for `sessionPeerId`, exit for the leak check), `senderLabel` (the `U1` pseudonym for the current message; `null` on command turns), and `ackText` on command turns only. §6.2 step 0 sends `turn.ackText`. `commands.forwardAck('/new')` returns the same string if exit prefers to look it up.
2. **`dispatchTurn` may return `{ started: false, reason }`**, for the §8.1 ingress refusal. The gate releases the hold, calls `exit.finishTurn(turnId, { hostError: false, aborted: true })` only to clear the turn, ignores its result, and ends `skipped:<reason>` (default `ingress`). A `dispatchTurn` that throws counts as `{ started: true, hostError: true, usage: null }`, so its cost goes `unsettled`.
3. **`finishTurn` must return a terminal state.** A state outside §4.2 or a throw ends `failed:exit_refused`. A null reason becomes the state name, so every row has one. The gate runs the terminal transition from `dispatching` or `delivering`, and for command acks from `received`, so `sendFixed` and `commandAck` must not require a particular event state. `sendFixed` for G14 runs after the event is already terminal.
4. **`crisis` is not persisted or logged as a class by the gate**, because the plan says crisis is routing state only ("不留存"). The row keeps `cls` `ordinary` or `name`; only `turn.cls` in memory is `crisis`. **Exit and dispatch must not write `turn.cls` to the event log or a row when it is `crisis`.** Use `tier` instead. Tests expecting `cls='crisis'` on a row should read `turn.cls`. **The route can still be inferred, and accounting needs what shows it:** the counters `crisis_group:<groupKey>:<localDay>` and `decision_bypass:<groupKey>:<localDay>` in `clo.db`; a reservation with tier `addressed` on an event whose class is `ordinary` or `name`; and `turn_end` with `tier` in `events.jsonl`. A crisis-list match can leave these even when the decision says no crisis and nothing is sent. No row names a member. One exception names the route outright: the alert kind `crisis_queue_full`, with `eventKey` and `groupKey`. The choice was to change the group notice, not the code (`DECISIONS.md`).
5. **`createDecider` returns the `decide` function itself** and takes optional `setTimer`, `clearTimer`. It does not take a ledger, against CORE item 12: `Decision` carries `httpStatus` and `limitSource` and the gate reports to `ledger.noteDecisionError` and `noteDecisionOk`, so provider health cannot be lost by a wiring mistake. `invalid` adds `'unavailable'` (no key, no config or no prompt file), always with `paid:false`, and then no request leaves the machine and the hold is released.
6. **`createGate` `timers`** is `{ setTimer, clearTimer }`, both optional. Window and context caps are read once, from the Effective at the first admitted message; changing them needs a plugin reload. Mode, groups, limits, names and budget are read per message.
7. **`last_event_at`** is written by the gate at admission. Connection should not write it.

**Behaviour added or read differently**

8. **§5.1 G10 representative:** last `name` with user text, else the last with user text **that is not noise**, else the last with user text. As written, `我想死` followed by `唉` would pick `唉`, fail on noise, and silently merge the first message.
9. **Crisis route looks at the whole window.** Each sender's last message matching the crisis list is a candidate. It is rescued if the crisis caps have room and the rules pass or fail on an eligible reason. Rescued messages are judged one per person: the last one in the flush, the others through the addressed lane, and an earlier line of the same person merges into theirs. As written, a listed phrase followed by a second message in the same 4 s would never be consulted.
10. **`name` + `crisis:true`** routes as `crisis` under the same caps as `ordinary` + `crisis:true`, the plan's exception being unconditional. §5.1 lists only `ordinary`. When the caps are spent, or for `ordinary` likewise, the answer falls back to its `action`, so asking for `crisis=true` cannot change a tier.
11. **`crisis:true` on the open `ordinary` or `name` path also consumes the crisis caps** (`crisis_group`, per-sender map), at result time. The plan requires this ("`crisis=true` 另受每群和每人上限约束") and TQ28 tests it. On `crisis_route` the caps are taken at G12, so a refused one keeps the original skip reason.
12. **Rechecks before spending:** window flush, queued names and queued crisis messages also recheck admission (with `qq.enabled`), pause, mode, account and `dispatchDeadlineMs` before G12, so queued work spends nothing on a decision that G14 would refuse. Same outcomes and reasons as G14. A decision already out when the account changes is still paid, and G14 refuses it.
13. **`interject_paused` is rechecked inside the G14 transaction** for `interject`, ending `skipped:interject_latch`.
14. **`decision_fail_streak` counts decision timeouts and network failures** as well as HTTP errors. A 200 with an unusable body counts as provider OK. "Five consecutive paid skips" is read as five consecutive **invalid** paid decisions; a valid `skip` is normal in a quiet group and resets the count. Alert kind `decision_invalid_streak`.
15. **Extra reason tokens in §4.2:** `old`, `future`, `no_timestamp` (on `stale`), `paused` (on `paused`, also `merged` on `merged`), `restart` (on `restart_dropped`), `admission` (on `ignored`), `no_effective`, `decision_paused`, `name_off`, `owner_stop` (on `skipped`), `gate_error` (on `failed`), plus the host's `ingress`. `gate_drop` reasons, which have no row: `no_effective`, `qq_disabled`, `terminal`, `dm_closed`, `no_identity`, `bot`, `not_admitted`.
16. **Queues:** `addressed(groupKey, task, record)` and `ordinary(...)` return `{ ok }` or `{ ok:false, reason:'queue_full'|'stopped' }`. `maxPending` is per lane per group, so an ordinary flood cannot crowd out a real @. In the addressed lane, queued names yield (`{ yielding: true }`): they stay behind later non-yielding tasks and take no room from real @, reply-to-bot and crisis tasks, so the lane can hold up to 2 × `maxPending` for a group (20 non-yielding plus 20 yielding by default). A name is refused with `queue_full` when the whole lane is at or over `maxPending`. A flushed window counts until it starts. In the window lane, a crisis-list record is refused only by other urgent records, counted per group, not per sender, and an urgent window goes ahead of yielding tasks. `createGroupQueues` also takes `onError`, `onDrop` and `isUrgent`.
17. **Context:** adds `pseudonym(groupKey, senderKey)` and `sweep(now)`; the gate sweeps hourly so expired text leaves RAM even in a quiet group. The token cap is an estimate (2 per non-ASCII character, 1 per 3 ASCII), not a tokenizer. Q5 can check it.
18. **Commands:** adds `commandRoute(cmd)`: `local`, `forward` or `unknown`. `parseCommand` also strips format characters and applies NFKC, so `​/clo pause` cannot pass as chat. `runLocalCommand` does not use `group`.

**Open**

19. **§5.1 step 7 and the §5.2 table disagree on placeholder-only messages:** step 7 buffers only messages with user text, the table says "context only". Built per step 7, because it is the procedure. They do not enter the ring.
20. **"Wrong account" (CLAUDE.md §10) cannot be tested at the gate.** `InboundEvent` has no account, and the socket belongs to one `appId`. The check is `authorizeReply` step 4 in exit, so that row needs `unit/qq-policy-exit` or `unit/qq-passive`. `unit/gate-identity` covers disabled, terminal, non-admitted and case differences.
21. A message containing `clo-turn` or `clo-policy` matches the name rule, since `-` is a word boundary, and costs one capped name decision when `nameMention` is on. It gains no tier. Left as is.
22. **Several names in one window** (2026-11-05, offline only). `selectNameRecords` picks each sender's last `name` with user text, at most `limits.nameWindowMax` (3) senders, newest kept. A missing or invalid limit judges one. The lead is the last rescued crisis message, else the first crisis message among the names, else the first name. It is judged in the flush. Other names go through the addressed lane, yielding, read fresh by `judgeName`. Everything else merges: `mergedInto` is the same sender's rescued crisis line, else the same sender's selected name, else the last selected. A name in danger that the rules cannot rescue is kept outside the cap of names. A person's name line in danger followed by a later rescued danger line in one window is one turn on the later line: the name line waits behind it and ends `merged` if that line got its decision. If that decision says no crisis, the name line gets no reply (open, DEPLOYMENT.md). If the later line got no decision, the name line is judged itself. Selected names and their replies still count against every decision cap. One window can now cost several decisions and turns, and the real `sendGroupPerMin` of 4 was not tested against that.
23. **What a turn's history holds** (2026-11-05, offline only). The buffer, minus three kinds of line. First, lines of other events of this group that have not ended and whose class gets its own handling: `at`, `reply_bot`, `name`, `name_addressed`. Otherwise a line that arrived before a turn was built is answered in that turn and again in its own. Second, lines of those classes merged into such an event, from every turn but that event's own: that turn speaks for them, and without this rule another person's turn reads a question its asker has just taken back. Third, for the turns of one flush, `rec.heldBack`: rescued danger lines queued behind this one. Those are usually class `ordinary`, and crisis is deliberately not on the row, so the query cannot see them; the list is built from the queue order and lives only on the record. `approveAndRun` reads the keys with `store.openEventKeys` and `store.mergedIntoOpen` just before it builds the turn, so `events` decides and no shared set in memory can go stale. Once such an event ends, `merged` and `skipped` included, its line is ordinary context for later turns. `ordinary` lines stay visible even if they arrived after the current message: a later correction is useful, and it normally gets no reply of its own. The exception is the same person's earlier lines (`context.ownEarlier`, by arrival, since QQ timestamps are whole seconds): they stay visible even with their own turn still to come, so a danger reply or an @ saying "that one above" is not written without the words just before it. This takes in a name line folded under its sender's later danger line (item 22). The cost is chosen: that earlier line can be answered twice, when a person's later line overtakes it. Rows older than `window.dispatchDeadlineMs` hide nothing, since they can get no turn, so a row stuck open by a store fault costs at most that long. A withdrawal said with her name (`可洛，算了`) is itself such a line, so it cannot reach the earlier turn; said without her name it can. Hidden lines take no room under `contextMaxTokens`. They still count for a member's newest label, which belongs to the member and not to one line. `context.lines`, what a decision reads, is unchanged. The read runs with a hold taken, so a throw logs `history_hide_error` and the turn goes on hiding nothing: a double answer at worst. No index was added: `EXPLAIN QUERY PLAN` shows each query starting from an index on `events` and the target found by primary key, and a test reads the plan of the statements the store really prepares.

### From OPS

**Additions to §7.6**

1. `clo ack terminal` clears `terminal_close`. Nothing else did, so a fatal close would have latched for good. `clo status --ack` marks the listed alerts read, since `store.ackAlerts` had no caller. `status --json`, `doctor --json` and `doctor --config-only` are added. The live precondition `doctor` runs the config level, which does not spawn the host.
2. The model lock lives in `versions.lock.json` under `models.lock`, with an append-only `models.changes` recording `qqPlatformNotified`. `clo model refresh` also picks up a model edited by hand in `config.json`.
3. Test-only environment: `CLO_TEST_NODE_IMPORT` is required for `start` in test mode, and `CLO_TEST_GATEWAY_ENTRY` replaces `openclaw.mjs` for `gateway run` and `plugins inspect`. `start` in test mode also refuses non-loopback QQ or OpenRouter URLs, and the console's `fetch` refuses non-loopback hosts.

**Rules added because the contract left a hole**

4. `clo apply` and `clo start` refuse `mode:'live'` in `config.json` unless `effective.json` is already live. Otherwise hand-editing the file would skip every precondition in §7.3.
5. `clo apply` refuses when the config names a model other than the locked one, rather than running on the old lock. Only `clo model` changes the lock.
6. `clo group add` refuses while live: the new group would be admitted before the notice is given.
7. `clo mode live` makes no OpenRouter request while `acks.d3` is empty. `key_readable` and `reconciled` then show as failed along with `d3`. Same-model price rises need `--confirm-price`, not only the absolute ceiling in `validateModels`.
8. The console reads keys from `.env` only, never from its own environment, so a key set in the shell is not used.

**Corrections to §7.6 Lifecycle**

9. Gateway env adds `OPENCLAW_NO_RESPAWN=1` and `OPENCLAW_EXEC_SHELL_SNAPSHOT=0`, as `docs/gateway/embedding.md` advises for a host tracking a PID (read). Observed once through `lifecycle.mjs` with the skeleton plugin: 45 s to a mock connection, peak 1, `openclaw.json` not rewritten by the host, `stop` closed the socket and the process was gone.
10. `start.ps1` and `clo.ps1 start` launch the console through `Start-Process -WindowStyle Hidden`, with `--output-file` carrying its text back. Observed: when `powershell.exe` runs with captured stdout, a plain `& node` path leaks that pipe through node into the detached Gateway, and the caller's read does not finish until the Gateway exits. Direct `node clo.mjs start` from a non-PowerShell parent does not have this problem. `Start-Process -Wait` is not used, because it also waits for descendants (read).

**Requests to CHANNEL**

11. The manifest must accept `plugins.entries.clo.config.effectivePath` (§7.4). Until it does, `plugins inspect` exits 1 with `must not have additional properties: "effectivePath"`, so doctor's `hook_registered`, `clo start`, and the two real-host tests in `unit/doctor` and `unit/lifecycle` fail. Doctor requires the typed hooks `before_agent_run`, `before_prompt_build` and `before_tool_call` (§8.4).
12. §7.3 says `clo status` shows the READY username, but no control key carries it. `status` reads `control.ready_username` and shows it if set. CHANNEL would need to write it from the SDK `ready` event. It is the bot's own name, not a member's. Without it, `status` shows the masked AppID only.

### From CHANNEL

**Assumptions, as run on the real Gateway with mocks**

1. A1: `inbound.run` resolved after `deliver` every time. Five reply shapes (text around tool calls, several tool rounds, reply directives, long text, many paragraphs) gave **one** final payload holding only the last assistant text, so two finals could not be provoked. The join across payloads is proven in `unit/qq-policy-exit`. `e2e/qq-multi-payload` asserts the one-final fact, so an upgrade that changes it fails there.
2. A2 holds: a buffering `deliver` returning `visibleReplySent:true` gave one model call and no retry.
3. A3 holds: the replacement reached the model, `before_agent_run` saw it, and the host's section headers were gone.
4. A4 holds: history reached the prompt and no byte of it was in the host's state files, while addressed text was.
5. A5 holds: `model.usage` arrives with the session key before the drain ends, and a `NO_REPLY` required turn is counted.
6. A6 at the time was only the SDK type on real QQ. The mock returns `ext_info.ref_idx`. Since then real sends returned `ref_idx` 20 times of 20, and one real quote matched (Q7). `exit_post` carries `refState`, and an inbound `ref_msg_idx` logs `reply_ref`, with `refKey`, `refLen` and `refPrefix`. `refPrefix` is written only when at least 8 characters of the value stay out of the line.
7. A7 holds: `/new` and `/reset` made no model call and spent nothing.

**Contract changes**

8. `runConnection` takes `exitDeps`, `onExit`, `onAlert`, `takeRestartSlot` and `probeIntervalMs` in place of `makeExit`. It calls `createExit` itself, so `connection.js` is the only file that ever names the SDK object apart from `exit.js`.
9. `createExit` also takes optional `appId`, falling back to `bot.appId`. No bound appId fails closed. `secrets` may be an array or a function. It adds `probe()`: one read-only `GET /gateway`, the only other thing reachable.
10. §6.2: aborted is checked before the command branch, because the gate uses `aborted` to clear a host-refused turn and no ack may follow it. A pause during the run ends `paused:paused`, not `failed`.
11. Reason tokens: `completed:sent`, `silent:no_reply`, `silent:host_error`, `policy_dropped:<ruleId>`. The path in `policy_drop:<day>:<ruleId>:<path>` is the tier, because `crisis` must not be recorded.
12. §6.3 40054005: `sent` when a `sent` row under this event has the same `text_sha`, at any seq. `UNIQUE(event_key, msg_seq)` means no earlier row can share the seq, so the literal reading could never be true.
13. §8.1 goes further: the host's `messageId`, `replyToId` and `raw.id` are the HMAC `eventKey`, not the raw message ID. `capabilities.chatTypes` is `['group']`.
14. §8.2: `crisis` frames as `class=addressed`, because the frame line is kept in the host transcript and crisis is not retained. `persona/AGENTS.md` only distinguishes `interject`, so the rule is unchanged.
15. §0 and §11.11 deferred the REST liveness probe. The build task asked for it, so it is built: every 60 s, `GET /gateway`. A failure followed by a recovery, while the SDK still reports connected, rebuilds the connection in process, capped by counter `conn_restart:<utcDay>` at 100 a day, well under the 1000 a day the plan records. `session_start_limit` itself is not read, and no real half-open socket has been seen.
16. `terminal_close` set: `startAccount` refuses to connect until `clo ack terminal`, matching README.
17. New modules `lib/channels/qq/text.js` and `tests/unit/qq-connection.test.mjs`, `tests/e2e/qq-controls.test.mjs`, `tests/e2e/qq-send-errors.test.mjs`.

**Changes in other owners' files**

18. `render.js` renders `logging: { level:'error', consoleLevel:'error' }`. Observed: at the default level the host writes the provider's error message, and on a mid-stream error its metadata, to `gateway.log` and its own file log. At `error` neither file held it. The cost is that the host's own warnings, including the crash-loop line below, no longer appear in those logs. Goldens updated.
19. `ledger.js` and `decision.js` default `fetch` to `globalThis.fetch`, so `services.js` never names it and the single-exit scan stays strict. The scan also allows `models.js`, which only takes an injected fetch for the console.
20. `tests/unit/qq-redaction` moved its top-level `await` above the first test: a root `after` hook raced the seam test as soon as it stopped being skipped. Its fake bot gained `appId`.

**Host behaviour found while building**

21. Observed: three unclean boots in five minutes make the host refuse channel auto-start (`channel autostart suppressed by crash-loop breaker`, documented in `docs/gateway/restart-recovery.md`). `clo stop` uses `taskkill /F`, which counts as unclean, so three stop-and-start cycles in five minutes leave the bot offline with a healthy process until the window drains or `openclaw gateway call channels.start`. In that safe mode, once, a message after a manual `channels.start` got zero model calls and the failure line. The cause was not diagnosed. `e2e/qq-crash-matrix` uses one stack per row to stay out of it.
22. Observed: a 403 is classed by the host as `reason=auth`, and identical paragraphs in one reply are collapsed to one.
