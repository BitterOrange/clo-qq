# Model API provider contract

This is the contract for the common model API layer on the own runtime. Every cluster that builds a part of it codes against the names, signatures and shapes here. The base modules (`registry.js`, `cost.js`) and the test fakes already exist. Everything else is specified only by its interface. The owning cluster writes the implementation.

Status: offline only. Nothing here has run on the real Anthropic API, and the paid Anthropic probe (K7, `scripts/q5-anthropic.ps1`) has not run either. The facts marked **unverified** come from the planning dossier and must be confirmed by that probe before anyone relies on them. The user's decisions are recorded in `DECISIONS.md` (用户定的（2026-11-07，Provider）, and the developer defaults under 开发时定的，用户还没有确认（2026-11-07，Provider）), and the rule text in `CLAUDE.md` sections 4, 6 and 8.2. `provider_rules` opens for Anthropic only in the same commit as those rows (section 11.3).

## 0. Invariants nobody may break

- **OpenClaw path unchanged.** With `runtime` other than `own`, every module behaves byte for byte as before the layer existed:
  - `providerOfConfig()` and `providerOfEffective()` return the implicit OpenRouter entry there, whatever the file says.
  - The OpenRouter request bodies equal `tests/fixtures/provider-golden/*.json`.
  - The render goldens, `tests/unit/openrouter-chat.test.mjs` and `tests/e2e/*` pass unedited.
  - `buildPlan(ROOT, {runtime: 'openclaw'}).totalWorstMicros` stays `1548352`; the own figure stays `94144` (src/tools/q5-probe.mjs).
  - Files that must not change: `render.js`, `hooks.js`, `channels/qq/services.js`, `index.js`, `startup.js`, `tests/harness/gateway.mjs`, `tests/e2e/`, `src/tools/q5-probe.mjs` (its behaviour: one code comment was corrected), `src/tools/q5-net-guard.mjs`.
- **Anthropic models only.** Ids must match `MODEL_ID_RULES[kind]`. There are no fallbacks: no `fallbacks` field, no model list, no second provider tried after a failure.
- **No streaming.** `stream` is never `true`. Nothing reaches QQ before the whole reply has passed the exit.
- **Provider text stays inside the adapter.** Error messages, `request_id`, `stop_details.explanation`, thinking text and tool bodies never leave it. They never reach a log, an `Error`, the ledger or QQ. Only the short scalars listed in section 4 leave.
- **Keys stay out of sight.** A Key goes only in a request header. It never appears in a URL, a log, a command line, an `Error`, a result or test output.
- **Retry only what was never sent.** The one retry is for `not_sent/connect`, at most once, before the deadline, and only after `beforeRetry` allows it. No HTTP status is retried: not 429, not 529, not 5xx.
- **The one fetch site.** Only `modelChat.js` (chat), `models.js` (catalog and model reads) and `ledger.js` (OpenRouter `/key`) may call `fetch` for a model provider. The `@anthropic-ai/sdk` and `openai` packages are never imported. K1 extends the `qq-single-exit.test.mjs` scan to `src/bot` and to `src/tools`, where only the probe files may fetch, and plants an offender under a bot-like path.

## 1. Module map

| Path (under `src/clo-plugin/lib/core/`) | Owner | Role |
|---|---|---|
| `providers/registry.js` | K0 (exists) | Kinds, capabilities, names, the two provider readers, the hard-cap and start checks |
| `providers/cost.js` | K0 (exists); K9 takes it over | `usageMicros`, `computeMicros`, `settleMicros`, `worstCaseMicros` |
| `providers/modelChat.js` | K1 | `createChatClient()`: the only chat fetch site; added to `FETCH_FILES` |
| `providers/openrouterAdapter.js` | K1 | `export const openrouterAdapter` |
| `providers/anthropicAdapter.js` | K1 | `export const anthropicAdapter` |
| `providers/index.js` | K1 | `export function adapterFor(kind)`; throws `TypeError` for an unknown kind |
| `openrouterChat.js` | K1 | Becomes a shim: `createOpenRouterClient(o) = createChatClient({adapter: openrouterAdapter, ...o})`, and it re-exports `isConnectFailure` and `mapUsage` |
| `turn.js`, `decision.js`, `gate.js` | K2 | Callers |
| `ledger.js`, `store.js` | K3 | Money state, schema v2 |
| `config.js`, `models.js` | K4 | Validation, effective file, model checks |

| Test fake | Owner | Role |
|---|---|---|
| `tests/fixtures/fake-adapter.mjs` | K0 (exists) | Scripted adapter and client (section 12) |
| `tests/harness/fake-keys.mjs` | K0 (exists) | Fake Keys |
| `tests/fixtures/provider-golden/` | K0 (exists) | OpenRouter goldens. Never regenerated |

`qq-single-exit.test.mjs` matches `FETCH_FILES` by basename, so `modelChat.js` must stay a unique basename. `providers/index.js` shares its basename with `src/clo-plugin/index.js`. That is harmless only while neither is in `FETCH_FILES` and no scan rule is keyed on `index.js`.

## 2. `providers/registry.js` (exists)

Pure, frozen data. It imports nothing.

```js
PROVIDER_KINDS = ['openrouter', 'anthropic']
CAPABILITIES[kind] = { keyReadable, reportsCost, hardCap, ownerClearsProviderFail, countTokens, cache1h }
  // openrouter: true,  true,  'key_daily_limit', false, false, false
  // anthropic:  false, false, 'attested',        true,  false, false
KEY_ENV   = { openrouter: 'CLO_CHAT_API_KEY',  anthropic: 'CLO_ANTHROPIC_API_KEY' }   // .env names
CHILD_KEY = { openrouter: 'OPENROUTER_API_KEY', anthropic: 'CLO_PROVIDER_API_KEY' }   // own-runtime child env names; the first carries CLO_CHAT_API_KEY
PROBE_KEY_ENV = { anthropic: 'CLO_TEST_ANTHROPIC_API_KEY' }                           // the paid probe only
DEFAULT_BASE = { openrouter: 'https://openrouter.ai/api/v1', anthropic: 'https://api.anthropic.com' }
ANTHROPIC_VERSION = '2026-10-21'
MODEL_ID_RULES = { openrouter: /^anthropic\/[A-Za-z0-9][A-Za-z0-9._-]*$/,           // as turn.js MODEL_ID
                   anthropic:  /^claude-(?:opus|sonnet|haiku)-\d{1,2}(?:-\d{1,2})?$/ } // no -latest, no date, no other line
ANTHROPIC_EFFORTS = { primary: ['low','medium','high','xhigh','max'], decision: ['none'] }
PROVIDER_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/
PROVIDER_ENTRY_FIELDS = ['kind', 'keyEnv', 'baseUrl', 'models']
RESULT_KINDS, RESULT_REASONS                       // section 4
OPENROUTER_LIMIT_SOURCES = ['openrouter_key_limit', 'openrouter_credits']
ANTHROPIC_LIMIT_SOURCES  = ['anthropic_credits', 'anthropic_spend_limit', 'anthropic_permission']
PRICE_PAUSE = 'anthropic_price_unexpected'
PROVIDER_PAUSES = [...ANTHROPIC_LIMIT_SOURCES, PRICE_PAUSE]                 // new paid_paused reasons
OWNER_CLEARED_PROVIDER_PAUSES = [...ANTHROPIC_LIMIT_SOURCES, PRICE_PAUSE]
PRICE_ALERT = 'price_unexpected'
HARD_CAP_PAUSE = 'hard_cap_unverified'          // not a paid_paused reason: section 8.1
hardCapPauseKey(kind)   -> 'hard_cap_paused:<kind>'   // the hard-cap pause control, one per kind
HARD_CAP_KINDS = ['workspace_monthly']
hardCapControlKey(kind) -> 'hard_cap_key:<kind>'      // store.key() of the attested Key
hardCapAckProblems(ack) -> string[]             // [] or some of 'missing', 'kind', 'prepaid_no_reload', 'usd'
hardCapAckRefusal({ provider, ack, mode, processRunning }) -> null | 'not_attested' | 'live' | 'process' | 'ack'
liveStartCheck({ provider, mode, ack, control, keyFp }) -> { ok: true } | { ok: false, code: 'provider' | 'hard_cap' | 'provider_rules' }
LIVE_CODES = { hardCap: 'hard_cap', keyValid: 'key_valid', providerRules: 'provider_rules' }
LIVE_RULES_RECORDED = { openrouter: true, anthropic: true }   // anthropic flipped with the DECISIONS.md and CLAUDE.md rows of 2026-11-07
providerRulesRecorded(kind) -> LIVE_RULES_RECORDED[kind] === true
providerOfConfig(cfg)    -> { name, kind, baseUrl, keyEnv, childKey, caps, implicit } | null   // frozen
providerOfEffective(eff) -> the same shape | null
```

There is no reader that takes both shapes. A field of one shape in a file of the other must never pick the provider: a stray `apiProvider` in config.json would make `clo mode live` check one kind while the bot runs on another.

Both readers, first:
1. If `runtime` is not `'own'` (absent counts as `'openclaw'`), they return the implicit entry: `{name: 'openrouter', kind: 'openrouter', implicit: true}`. Its `baseUrl` is `openrouter.baseUrl` when that is a non-empty string, otherwise `DEFAULT_BASE.openrouter`.

`providerOfConfig(cfg)`, for config.json and everything that reads it (`clo` commands, livePreconditions):
2. A top-level `apiProvider` gives `null`. K4 validation also refuses it by name (section 9.1).
3. If `providers` is absent, the implicit entry.
4. Otherwise `providers[activeProvider]`, an own property only. An entry or kind it cannot read gives `null`. A missing `baseUrl` becomes the implicit OpenRouter base for an OpenRouter entry and `DEFAULT_BASE[kind]` for the others. An Anthropic entry never falls back to `openrouter.baseUrl`.

`providerOfEffective(eff)`, for the effective file and everything in the bot and the plugin:
2. A `providers` or `activeProvider` field gives `null`. The generator never writes them there (section 9.2).
3. If `apiProvider` is absent, the implicit entry.
4. Otherwise `apiProvider`. A `name` that is not a non-empty string, or a kind it does not know, gives `null`. A missing `baseUrl` becomes `DEFAULT_BASE[kind]`.

`null` means nothing can be sent. Every caller must handle it: a client gives `not_sent/unavailable`, live mode refuses, and `liveStartCheck` gives code `provider`. Validation (K4) and `isEffectiveShape` keep `null` from occurring outside bugs.

The hard-cap helpers are pure, so K5 (console) and K2 (bot) share one definition. Their callers are in sections 7 and 10:
- `hardCapAckProblems(ack)` is `[]` only for decision D2's pair: `kind === 'workspace_monthly'` and `prepaidNoReload === true`, with `usd` a finite number above 0. A missing ack gives `['missing']`.
- `hardCapAckRefusal` gives `not_attested` unless `provider.caps.hardCap === 'attested'`, then `live` when `mode === 'live'`, then `process` unless `processRunning === false` (unknown counts as running), then `ack` when `hardCapAckProblems(ack)` is not empty.
- `liveStartCheck` gives code `provider` for a null provider. Outside live mode it passes. In live mode, on a kind whose `caps.hardCap === 'attested'`, it gives `hard_cap` when `hardCapAckProblems(ack)` is not empty, or when `control` or `keyFp` is not a non-empty string, or when they differ. Then, on every kind, it gives `provider_rules` unless `providerRulesRecorded(kind)`. `control` is the `hardCapControlKey(kind)` control. `keyFp` is `store.key()` of the Key the starting process will hold.

Capabilities are always looked up by kind in code. They are never read from a file.

## 3. Adapter interface (K1)

An adapter is a plain object. It never fetches, prices or pauses.

```
{ kind, retryEvent, idRule,
  request(key, baseUrl) -> { url, headers },
  turnBody({ model, effort, maxTokens, system, user }) -> body,
  decisionBody({ model, effort, maxTokens, system, user, schema: { name, schema } }) -> body,
  systemTextOf(body) -> string,  userTextOf(body) -> string,  requestedModel(body) -> string | null,
  parseError(status, parsedOrNull) -> Result,                // any non-2xx, or a 2xx carrying an error object
  classify(status, parsedOrNull, requestedModel) -> Result } // a 2xx
```

- `system` must appear unchanged, as one string, in the body. `systemTextOf(body)` returns exactly that string, so the content-scope sentinel check runs on the bytes sent.
- `retryEvent` is `'openrouter_retry'` (unchanged) or `'anthropic_retry'`.
- `idRule` is `MODEL_ID_RULES[kind]`.

### 3.1 OpenRouter adapter

- `request(key, base)` gives `{url: base + '/chat/completions', headers: {Authorization: 'Bearer ' + key, 'Content-Type': 'application/json'}}`.
- `turnBody` returns the object `buildTurnRequest` returns today (turn.js), with the same keys in the same order. `user` is `renderUserMessage(turn)`.
- `decisionBody` returns the object decision.js `buildRequest` returns today. `response_format` is today's `RESPONSE_FORMAT`, `strict: true` included.
- `parseError` and `classify` are today's `errorInfo`/`classify` logic from openrouterChat.js, unchanged. That includes the rule that a 403 with no `limit_source` is `refusal/moderation`.
- Proof: `tests/unit/provider-golden.test.mjs`. Its adapter case is skipped until `openrouterAdapter.js` exists, then runs on its own.

### 3.2 Anthropic adapter (raw fetch, no SDK: decision D7)

**Request**
- `request(key, base)` gives `{url: base + '/v1/messages', headers: {'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json'}}`. No other header, and no beta header.
- The body keys are a subset of `model, max_tokens, system, messages, output_config, thinking`.
- Never sent: `stream`, `fallbacks`, `speed`, `inference_geo`, `metadata`, `tools`, `tool_choice`, `temperature`, `top_p`, `top_k`, `service_tier`.

**Turn body**
```
{ model, max_tokens: maxTokens,
  system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: user }],
  output_config: { effort } }
```
No `thinking` key: Opus 5.5 thinking is adaptive and cannot be disabled. `effort` must be in `ANTHROPIC_EFFORTS.primary`, and `turnBody` throws `TypeError` otherwise.

**Decision body**, for effort `'none'`, the only effort allowed (decision D9):
```
{ model, max_tokens: maxTokens, system,
  messages: [{ role: 'user', content: user }],
  thinking: { type: 'disabled' },
  output_config: { effort: 'low', format: { type: 'json_schema', schema: schema.schema } } }
```
`schema.schema` is the same object as today's `RESPONSE_FORMAT.json_schema.schema`. **Unverified:** that Haiku 5.5 accepts this combination (thinking disabled, effort low, a format).

**Response, `classify` on a 2xx**
- `message.content`: the `text` blocks of `content`, joined in order. A `content` that is not an array gives `error/no_choice`. Blocks of type `thinking` and `redacted_thinking` are dropped.
- `message.refusal` is `stop_reason === 'refusal'`, and `message.toolCalls` is the number of `tool_use` blocks.
- `stop_reason` mapping:

| `stop_reason` | Result |
|---|---|
| `end_turn` | `finishReason` `'stop'` |
| `max_tokens` | `finishReason` `'length'` |
| `refusal` | kind `refusal`, reason `refusal` |
| `tool_use` | kind `error`, reason `tool_calls` |
| anything else | kind `error`, reason `finish_reason` |

- `body.model !== requestedModel` gives `error/model_mismatch`. **Unverified:** that `body.model` echoes the bare id unchanged.
- Usage mapping. Nothing is subtracted, because `input_tokens` already excludes cache tokens.

```
input  = usage.input_tokens
output = usage.output_tokens                   // includes thinking tokens, billed as output
cacheRead = usage.cache_read_input_tokens
if usage.cache_creation is an object:
  cacheWrite   = cache_creation.ephemeral_5m_input_tokens
  cacheWrite1h = cache_creation.ephemeral_1h_input_tokens
else:
  cacheWrite   = usage.cache_creation_input_tokens
  cacheWrite1h = null                          // split unknown: priced at the 1h rate and flagged
costUsd = null
model = shortString(body.model)
geo   = shortString(usage.inference_geo) ?? null   // never omitted
speed = shortString(usage.speed) ?? null           // never omitted
```
  **Unverified:** the response field names `usage.inference_geo` and `usage.speed`. If the real API omits them, every Anthropic settlement flags `geo_unknown`/`speed_unknown` and pauses. That fails safe, and the probe would show it at once.
  - A body with no `usage` gives `usage: null`, which is never free.
  - A count is a finite number at or above 0. An unreadable count is never read as 0, because `computeMicros` would then settle billed tokens below their hold for good, and nothing reconciles an Anthropic Key. The adapter maps:
    - `input_tokens` or `output_tokens` that is not a count: `input` or `output` is `null`. `computeMicros` then gives `null` and the row stays unsettled, counted at its hold.
    - `cache_read_input_tokens`: a count as it is; absent or `null` is 0; anything else is `null`. The same for `cache_creation_input_tokens`, called the total below. **Unverified:** whether the API ever omits these two or sends `null`.
    - The write split is used only when `cache_creation` is an object whose `ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens` are both counts, and the total is absent, `null`, or equal to their sum. Otherwise, if the total is a count, `cacheWrite` is the total and `cacheWrite1h` is `null`: unsplit, priced at the 1h rate and flagged. If the total is not a count either, `cacheWrite` is `null`.
  - The adapter must always set `cacheWrite1h`, `geo` and `speed`, to a value or to `null`. `cost.js` reads an absent field as "this provider has no such field" (section 6).

**Errors, `parseError`**
- Body shape: `{type: 'error', error: {type, message}, request_id}`. `message` and `request_id` are read for nothing and dropped.
- `info` is `{status, error_type: shortString(error.type), provider_name: null, provider_code: null, limitSource}`. `usage` is mapped as above when present.

| Response | Result |
|---|---|
| 402 `billing_error`, or a 400 whose `error.message` starts with "Your credit balance is too low" (**unverified**) | `error/http`, `limitSource` `anthropic_credits` |
| A 400 whose `error.message` starts with "You have reached your specified" (**unverified**), or a 429 with `error_code === 'enforced_spend_limit_reached'` in its error details (location **unverified**) | `error/http`, `limitSource` `anthropic_spend_limit` |
| 403 `permission_error` | `error/http`, `limitSource` `anthropic_permission`. Never a refusal (decision D10) |
| Anything else, including 401, 404, 429 `rate_limit_error`, 500 and 529 `overloaded_error` | `error/http`, `limitSource` null |
| A 2xx carrying `type: 'error'` | `error/provider_error` |

The adapter only matches the message prefixes; their text never leaves it.

401 and 404 count toward the provider_fail streak like any other error. Making them immediate pauses is an open choice, listed in section 15.

## 4. Result

The keys are exactly those of today's openrouterChat.js results:

```
{ kind, reason, status,
  message: { content, refusal: boolean, toolCalls: number } | null,
  finishReason: 'stop' | 'length' | string | null,
  usage: { input, output, cacheRead, cacheWrite, costUsd: number|null, model: string|null,
           cacheWrite1h?: number|null, geo?: string|null, speed?: string|null } | null,
  info: { status, error_type, provider_name, provider_code, limitSource } | null }
```

| kind | reasons |
|---|---|
| `ok` | `null`. The caller still decides whether the content is usable |
| `not_sent` | `unavailable` (no Key or base URL), `connect` |
| `aborted` | `aborted` (the caller's signal) |
| `error` | `http`, `provider_error`, `bad_body`, `no_choice`, `network`, `timeout` (the call's own deadline), `tool_calls`, `finish_error`, `finish_reason`, `model_mismatch` |
| `refusal` | `moderation` (OpenRouter 403 with no limit source), `refusal`, `content_filter` (OpenRouter only) |

- `limitSource` is `null`, one of `OPENROUTER_LIMIT_SOURCES`, one of `ANTHROPIC_LIMIT_SOURCES`, or any other OpenRouter string, which passes through as today.
- OpenRouter usage never carries `cacheWrite1h`, `geo` or `speed`.
- `tests/fixtures/fake-adapter.mjs` `checkResult(r)` lists contract violations. The K1 contract test runs it on every adapter Result.

## 5. Chat client (K1, `providers/modelChat.js`)

```
createChatClient({ adapter, fetch = globalThis.fetch, getKey, getBaseUrl, log = () => {}, now = Date.now,
                   retryMinMs = 15000, retryDelayMs = 1000 })
  -> { adapter, post(body, { signal, deadlineAt, beforeRetry } = {}) -> Promise<Result> }
```

- The loop is today's `createOpenRouterClient` post loop, moved over unchanged: never throws, `redirect: 'error'`, `isConnectFailure`, the two abort causes, one connect retry.
- URL and headers come from `adapter.request(getKey(), getBaseUrl())`. A 2xx without an error object goes to `adapter.classify`; anything else goes to `adapter.parseError`. The retry log event is `adapter.retryEvent`.
- A `getKey()` or `getBaseUrl()` that throws, or returns an empty or non-string value, gives `not_sent/unavailable` with no fetch.
- The own runtime builds its client with a `getBaseUrl` that returns `null` when `providerOfEffective(getEffective())?.kind !== prov.kind`, the kind it was built for. So a Key can never go to the other provider after a config change.

## 6. `providers/cost.js` (exists)

```
usageMicros(usage, price)        -> { micros, source: 'model.usage' | 'computed' } | null
computeMicros(usage, price)      -> { micros, source: 'computed', flags: string[] } | null
settleMicros(usage, price, { kind, runtime }) -> { micros, source, flags } | null
worstCaseMicros({ input, output }, price, { geoUs = true } = {}) -> micros   // throws without a usable price or counts
GEO_US_MULTIPLIER = 1.1, FAST_MULTIPLIER = 2
```

**usageMicros**
- A byte copy of gate.js `usageMicros`: reported cost first, then tokens at the locked price; zero is never free.
- `provider-cost.test.mjs` checks `toString()` equality and a table of inputs.
- K2 makes gate.js re-export it, so `hooks.js` keeps importing it from gate.js untouched.

**Price fields**
```
{ inputPerM, outputPerM, cacheReadPerM?, cacheWritePerM?, cacheWrite1hPerM?,
  long?: { aboveTokens, inputPerM, outputPerM, cacheReadPerM?, cacheWritePerM?, cacheWrite1hPerM? } }
```
- Missing optional rates fall back to multiples of `inputPerM`: cache read ×1, five-minute write ×1.25, one-hour write ×2.
- A missing or invalid `inputPerM` or `outputPerM` gives `null`. So does a `long` card that is present but unreadable.

**computeMicros**, which prices tokens only:
- `input`, `output`, `cacheRead` and `cacheWrite` are required. Any of them missing, or not a finite number at or above 0, gives `null`. So does a `cacheWrite1h` that is present and neither `null` nor such a number. Usage with missing parts never settles below its hold.
- The prompt is `input + cacheRead + cacheWrite + cacheWrite1h`. Above `long.aboveTokens` prompt tokens, the long card applies (Haiku 5.5: above 100000).
- `output` already holds the reasoning tokens. Nothing is added for them.
- Field conventions:

| Field | Value | Effect |
|---|---|---|
| `cacheWrite1h` | a number | the split is known; priced at the 1h rate, flag `cache_1h` when > 0 |
| | `null` while `cacheWrite > 0` | all of `cacheWrite` at the 1h rate, flag `cache_unsplit` |
| | absent | `cacheWrite` at the five-minute rate, no flag |
| `geo` | absent or `'global'` | standard |
| | `'us'` | ×1.1, flag `geo_us` |
| | `null` or any other value | ×1.1, flag `geo_unknown` |
| `speed` | absent or `'standard'` | standard |
| | `'fast'` | ×2, flag `speed_fast` |
| | `null` or any other value | ×2, flag `speed_unknown` |

- The multipliers stack and apply to every token class. **Unverified:** both points, though each choice only over-counts. The 2× fast rate is the documented Opus 5.5 figure and is applied to any model.
- Rounding: up to the next micro, after a float sum is rounded to 1e-6 micro, so 4400.000000000001 is 4400.
- Zero tokens, or an unusable usage or price, give `null`.

**settleMicros**
- Kind `openrouter` on the OpenClaw runtime, or with no runtime named: `usageMicros(...)` with `flags: []`, today's order.
- Kind `anthropic`: `computeMicros(...)`. A `costUsd` there is ignored.
- Any other kind gives `null`, so the row stays unsettled at its hold.
- Kind `openrouter` on `runtime === 'own'` (decision D6, built apart from this layer by K9): the reported cost settles whenever there is one, above or below the tokens at the locked price. The tokens at the lock (`computeMicros`) settle only when none was reported. When the reported cost is above 1.10× the computed one, the result also carries `alerts: ['cost_above_computed']`, which never pauses; each settlement site in `gate.js` records it as an alert, which `clo status` lists. The plan said max(computed, reported). It settles at the reported cost because that is what the Key is charged and what reconciliation compares against; a figure above the bill would read as spend the Key explains. The OpenClaw path never changes.

**worstCaseMicros**
- A static bound for one call: every input token at max(input rate, five-minute write rate) of the card that `input` falls on, plus all output at the output rate, ×1.1 unless `geoUs: false`.
- One-hour writes and fast mode are never requested, so they are not in it.
- An `input` or `output` that is not a finite number at or above 0 throws `TypeError`.
- K7 must keep the sum of its calls at or below 100000 micros ($0.10) with `geoUs` left on. For example, two Opus turns at 4500 input / 1000 output plus one Haiku decision at 10500/200 total 95054 micros.

## 7. Callers (K2)

**turn.js**
- `ad = client.adapter ?? openrouterAdapter`, `body = ad.turnBody({...})`.
- The sentinel check reads `ad.systemTextOf(body)`. The input estimate reads `systemTextOf` + `userTextOf`.
- The model id rule is `ad.idRule`.
- `buildTurnRequest(eff, system, turn)` stays exported as the OpenRouter wrapper, because the goldens call it.

**decision.js**
- The same pattern. `buildRequest` stays exported as the OpenRouter wrapper.
- Cost:
  - With `caps.reportsCost`, `costMicros` stays as it is, source `'usage.cost'`.
  - Otherwise it is `settleMicros(usage, decision.price, {kind})`, source `'computed'`.
- The decider returns `costSource`, and gate `settleDecision` uses `d.costSource ?? 'usage.cost'`.
- An Anthropic decision that ends at HTTP 200 with `stop_reason` `max_tokens` and invalid JSON is a skip, settled as `'computed'`, not unsettled.

**gate.js**
- `usageMicros` becomes a re-export from cost.js.
- `settleReply` runs on both runtimes (the shared `runTurn`). Only the late-usage site of an abandoned run is own-only. So every settlement site calls `settleMicros(usage, price, { kind: providerOfEffective(eff).kind, runtime })`. On the OpenClaw path `providerOfEffective` gives openrouter, and the result equals today's.
- Required test: with runtime `openclaw` and an effective file that carries a provider block, `settleReply` still yields source `'model.usage'` from the host's `costUsd`.
- Non-empty `flags` raise alert `PRICE_ALERT` with detail `{flags}` and call `ledger.pausePaid(PRICE_PAUSE)`. The call is still settled at its computed figure.

**src/bot/services.mjs and main.mjs**
- `prov = providerOfEffective(eff)` at open, and `keyOf(env, kind) = env[CHILD_KEY[kind]] || null`. Every caller passes `prov.kind`. That includes `main.mjs`, which stores `gateway_key = store.key(keyOf(env, prov.kind))`, and the ledger's `getKey`. With kind anthropic, `keyOf(env)` without a kind would be `null`.
- `liveSecrets` covers `CLO_QQ_APP_SECRET`, `OPENROUTER_API_KEY` (the child name of `CLO_CHAT_API_KEY`) and `CLO_PROVIDER_API_KEY`.
- Client: `createChatClient({adapter: adapterFor(prov.kind), getKey, getBaseUrl})`, with the guard from section 5.
- At bot start, `liveStartCheck({ provider: prov, mode: eff.mode, ack: eff.apiProvider?.hardCap ?? null, control: store.getControl(hardCapControlKey(prov.kind)), keyFp: store.key(keyOf(env, prov.kind)) })`. The Key is the one in the bot's own environment, not the one in .env.
  - On `{ok: false}` with code `hard_cap` or `provider_rules`, call `ledger.pauseHardCap(prov.kind, 'start', code)`. On code `provider`, nothing can be sent anyway.
  - On `{ok: true}` it lifts nothing. Only the ack lifts the pause (section 10).
  - Tests: a mismatched Key, a weaker ack (`prepaid_no_reload`, or `prepaidNoReload` false) bound to the right Key, and `provider_rules` false, each with the matching Key and the D2 ack as the positive control.

## 8. Ledger and store (K3)

### 8.1 Ledger
```
createLedger({ ...today's options, getProvider = () => providerOfEffective(getEffective()) })
```
When `!caps.keyReadable`:
- `readKey()` rejects with `Error('key read unsupported')` before any fetch.
- `tick()` returns early, so no `key_read_failed` pause appears at start.
- `reconcile()` returns `{ ok: false, unsupported: true }` and pauses nothing.
- The unsettled-to-zero rule (15 minutes and 3 Key reads) never runs. Unsettled rows stay counted at their hold until `acceptUnsettled()` (decision D4). Rows definitely not sent are released, as today.

Other changes:
- `reserve()` writes `reservations.provider`: the provider **kind**, or `NULL` when `implicit`. `NULL` reads as openrouter. The explained sum in the residual check counts only rows whose provider `IS NULL OR = 'openrouter'`. Test this with an OpenRouter entry under another name.
- `pauseOnLimit(httpStatus, limitSource)`: an `ANTHROPIC_LIMIT_SOURCES` value pauses under its own name at any status, but only while the active kind is anthropic. Everything else runs today's logic.
- The provider_fail streak counts 429 and 529 like any other non-limit error (decision D11).
- The `CREDITS_PROBE` relabel of a streak to `openrouter_credits` happens only on kind openrouter.
- `clearOwnerPause()` accepts today's `OWNER_CLEARS`, plus `OWNER_CLEARED_PROVIDER_PAUSES`, plus `provider_fail` when `caps.ownerClearsProviderFail` (decision D5).
  - Clearing `provider_fail` sets the streak to one below the limit, so the next failure pauses again at once.
  - An anthropic_* limit source pauses again on its next occurrence.
  - `usage_missing` is still re-paused while unsettled rows exist, so the owner runs accept-unsettled first, then clear-pause.
- `rebaseKey()` deletes the `key_baseline` meta.
- `resetForProviderSwitch()` returns `{ ok: true }` or `{ ok: false, reason }`.
  - It refuses (`reason` `'paid_paused'`, `'decision_breaker'` or `'reservations'`) while `paid_paused` is set, while the decision breaker is set, or while any reservation is held or unsettled.
  - A hard-cap pause control never makes it refuse, for any kind. Switching away from a kind whose Key was never attested needs no attestation.
  - Otherwise it clears `residual_over`, `credits_probe`, `provider_fail_streak` and `key_limit_seen`, plus any key-read failure state, and calls `rebaseKey()`. It leaves every hard-cap pause control in place.

**The hard-cap pause.** It is not a `paid_paused` reason and has no `PAUSE_RANK`. It lives in the control `hardCapPauseKey(kind)`, one per kind. That way it can never replace a lower pause in `paid_paused` (`usage_unavailable`, `usage_missing`, an `anthropic_*` reason), and lifting it can never clear one.
- `pauseHardCap(kind, by, code)` sets `hardCapPauseKey(kind)` to `code` (`'hard_cap'` or `'provider_rules'`), adds alert `paid_paused` with `{reason: HARD_CAP_PAUSE, code}`, and logs `paid_paused` with `{reason: HARD_CAP_PAUSE}`. It does not touch `paid_paused`.
- `reserve()` first refuses with `{ok: false, reason: HARD_CAP_PAUSE}` while `hardCapPauseKey(getProvider().kind)` is set, then checks `paid_paused` as today. Callers treat that reason as they treat `'paid_paused'`. A pause raised for anthropic blocks nothing while openrouter is active. It blocks again if anthropic becomes active again without a new ack.
- `liftHardCapPause(kind)` deletes `hardCapPauseKey(kind)` and nothing else. `paid_paused` and whatever sits in it stay as they are.
- Nothing else lifts it: not `clearOwnerPause`, `tick`, a settlement, a clean read, nor a start whose check passes.
- `snapshot()` (and so `clo status`) reports the hard-cap pause of the active kind beside `paid_paused`.
- Tests: a lower pause (`usage_missing` with an unsettled row) under a hard-cap pause survives `liftHardCapPause`, and `reserve()` still refuses with `paid_paused`. Positive control: with no lower pause, `reserve()` succeeds after the lift. And a hard-cap pause on anthropic does not block `reserve()` with openrouter active.

### 8.2 Store
- `SCHEMA_VERSION = 2`.
- A fresh db is created at v2 directly. An older build refuses a v2 db, as it does today for any newer schema.

**The 1→2 step, with its backup.** `openDb` runs clo.db in WAL mode, so committed rows can sit in `clo.db-wal`. A file copy of `clo.db` alone misses them. `VACUUM INTO` writes a consistent snapshot that includes them, but SQLite refuses it inside a transaction. So the step is:
1. Read `PRAGMA data_version` as `dv`.
2. `VACUUM INTO` the path `clo.db.v1.bak.<pid>.tmp`, outside any transaction. The pid keeps two processes from writing one file.
3. `BEGIN IMMEDIATE`.
4. If `user_version` is already 2, another process migrated and made the backup: `ROLLBACK`, delete the tmp file, done.
5. If `PRAGMA data_version` differs from `dv`, a commit landed after the snapshot: `ROLLBACK`, delete the tmp file, and go back to step 1. After 5 tries, throw and leave the db at v1.
6. Rename the tmp file to `clo.db.v1.bak`, replacing any older one. This is still under the lock.
7. `ALTER TABLE reservations ADD COLUMN provider TEXT`, meta `schema = 2`, meta `migrated_v2_at = <now ms>`, `user_version = 2`, `COMMIT`.

A process killed before step 7 leaves the db at v1, so the next open runs the step again and replaces the backup. `janitor` deletes `clo.db.v1.bak` once now minus `migrated_v2_at` exceeds `retention.eventDays` days. It also deletes any `clo.db.v1.bak.*.tmp` older than one hour. README's data-retention table lists both files and both rules (K8).

**Restore** (README, K8). This is for going back to a build that only reads v1. The backup holds nothing written after the migration: not the ledger rows, and not the controls either. A `terminal_close` (4914/4915), a `global_paused` or `group_paused:<g>` (including those set by platform codes), `interject_paused`, `paid_paused` and unacknowledged alerts written since are all gone, and the old build reconnects and sends as if none had been set. Dry-run still connects to QQ, so it does not stand in for them.
1. Check `clo status` first. With a terminal close, a paid pause, an interject auto-pause or an unacknowledged alert, do not restore: deal with each as README says. Global and group pauses are noted and set again with `clo pause` on the old build before it starts. The old build only uses OpenRouter, so an Anthropic deployment switches back first (`clo provider use openrouter --confirm`).
2. `clo stop`, and check that `clo status` shows no process, recorded or untracked.
3. Move `clo.db`, `clo.db-wal` and `clo.db-shm` out of the folder together. A v2 `-wal` left beside the restored file is replayed onto it, and the "restored" db is then partly v2.
4. Move (rename) `clo.db.v1.bak` to `clo.db`. The old build has no janitor for the moved-out v2 files, so the deployer deletes them.
5. The restored ledger under-counts spend since the migration. Stay in dry-run until the next Shanghai day begins.

Tests (K3): a row committed only in the WAL is in the backup; a commit between steps 1 and 3 sends the step back to step 1; two stores opened together give one v2 db and one backup. `tests/unit/provider-registry.test.mjs` pins the SQLite facts these steps rely on.

`PAUSE_RANK` additions:

| reason | rank | lifted by |
|---|---|---|
| `anthropic_credits`, `anthropic_spend_limit`, `anthropic_permission`, `anthropic_price_unexpected` | 3 | owner `clo budget clear-pause` |

`hard_cap_unverified` has no rank, because it is not a `paid_paused` reason (section 8.1).

## 9. Config, effective file, models (K4)

### 9.1 Config
```json
"providers": {
  "openrouter": { "kind": "openrouter", "keyEnv": "CLO_CHAT_API_KEY" },
  "anthropic":  { "kind": "anthropic", "keyEnv": "CLO_ANTHROPIC_API_KEY",
                  "models": { "primary": "claude-opus-5-5", "decision": "claude-haiku-5-5" } }
},
"activeProvider": "openrouter",
"acks": { "provider": { "name": "openrouter", "at": "<iso>" },
          "hardCap": { "anthropic": { "kind": "workspace_monthly", "usd": 20, "prepaidNoReload": true, "at": "<iso>" } } }
```

Validation refuses a top-level `apiProvider` in config.json by name, with or without `providers`. That field belongs to the effective file only (section 2).

Without `providers`, behaviour and every generated file are exactly today's. With `providers`, validation requires:
- `activeProvider` names an entry, and equals `acks.provider.name`.
- Names match `PROVIDER_NAME_RE`. Fields are only `PROVIDER_ENTRY_FIELDS`. `fallbacks`, `priority`, `failover`, `order` and `backup` are refused by name.
- `keyEnv === KEY_ENV[kind]`, so there is at most one entry per kind.
- `baseUrl` follows the existing test-mode loopback rule. A top-level `openrouter.baseUrl` together with an openrouter entry `baseUrl` is an error.
- With runtime other than own, the active kind is openrouter.
- OpenRouter entries have no `models`.
- Anthropic entries have `models.primary` and `models.decision` matching `MODEL_ID_RULES.anthropic`, `claudeModel.effort` in `ANTHROPIC_EFFORTS.primary`, and `decisionModel.effort` in `ANTHROPIC_EFFORTS.decision`.

### 9.2 Effective file
- `eff.apiProvider = { name, kind, baseUrl, hardCap }`, present only with runtime own and `providers` set. `hardCap` is a copy of `acks.hardCap[name]`, or `null` when there is none. The bot's start check reads it (section 7).
- The effective file never carries `providers` or `activeProvider`. `providerOfEffective` gives `null` if it does.
- With the anthropic kind active, `models.primary` and `models.decision` take their ids from the entry, with `selector = id`. Their prices come from `versions.lock.json` `models.locks.anthropic`: the primary price has `cacheWrite1hPerM`, the decision price has the `long` card.
- `openrouter: { baseUrl }` is always emitted.
- `isEffectiveShape` returns null for an `apiProvider.kind` it does not know.

### 9.3 Lock
- `models.lock` (OpenRouter) is unchanged.
- New: `models.priceBooks.anthropic = { checkedOn, source, models: { <id>: price } }` and `models.locks.anthropic = { primary: { id, selector, price }, decision: { id, price } }`.
- `readModelsLock(paths, kind = 'openrouter')`.

### 9.4 livePreconditions(cfg, facts)
- For a kind with `caps.keyReadable`, the codes are unchanged.
- Otherwise `key_readable`, `key_limit` and `reconciled` are not checked, and these are added:
  - `hard_cap`: `hardCapAckProblems(cfg.acks.hardCap[provider.name])` is empty (decision D2: `kind === 'workspace_monthly'` and `prepaidNoReload === true`, `usd > 0`), `usdToMicros(usd) >= facts.requiredHoldMicros`, and `facts.hardCapKeyMatches === true`.
  - `key_valid`: `facts.keyValid === true`.
  - `provider_rules`: `facts.providerRulesRecorded === true`.
- New facts:
  - `provider`: the `providerOfConfig(cfg)` result. A null provider is a failed precondition.
  - `hardCapKeyMatches`: the control `hardCapControlKey(kind)` equals `store.key(current .env Key)`, and, while a process is recorded, also equals the `gateway_key` control. Mode can turn live under a running bot without a new start, so this check must cover the Key that process holds.
  - `keyValid`: `checkAnthropicModels` passed for both locked ids.
  - `providerRulesRecorded`: `providerRulesRecorded(kind)` from the registry, never from a file.
- Test `provider_rules` both ways by passing the fact.

### 9.5 models.js
```
checkAnthropicModels({ fetch, baseUrl, key, ids, signal }) -> { ok, rows: [{ id, maxTokens, caps }], problems: string[] }
```
- It sends `GET {baseUrl}/v1/models/{id}` with `x-api-key` and `anthropic-version`, `redirect: 'error'`, and the Key in the header only.
- It refuses when a needed capability is missing: the configured effort level, thinking `disabled` for the decision model, and structured outputs for the decision model.
- **Unverified:** the JSON paths of those capability leaves and whether the call is free. Keep them in one constant table marked unverified, and confirm them with the free call before locking.
- `clo model refresh` (the OpenRouter catalog) never touches `models.locks.anthropic` or `models.priceBooks`.

## 10. Console, lifecycle, doctor (K5)

**Env**
- `.env` name `CLO_ANTHROPIC_API_KEY`. `CHILD_ENV_NAMES` is unchanged, and a separate `PROVIDER_ENV_FILE_KEYS = ['CLO_ANTHROPIC_API_KEY']` holds the new name.
- `ownEnv(paths, parentEnv, { secrets, kind })` for kind anthropic deletes `OPENROUTER_API_KEY` (where `CLO_CHAT_API_KEY` would go) and sets `CLO_PROVIDER_API_KEY`. Exactly one model Key reaches the own child. The Gateway never gets `CLO_PROVIDER_API_KEY`.
- `FORBIDDEN_CHILD_ENV` gains `^CLO_ANTHROPIC_API_KEY$`, `^CLO_TEST_ANTHROPIC_API_KEY$` and `^ANTHROPIC_API_KEY$` for every child.
- `requireSecrets` in live needs `KEY_ENV[active kind]`. doctor `bot_env` requires exactly one model-Key child name, the active kind's.

**Commands**
- `clo provider add anthropic` writes `providers` and makes the implicit openrouter entry explicit. `activeProvider` and `acks.provider` stay at openrouter.
- `clo provider use <name> --confirm [--qq-platform-notified]`. This is a model change under protocol §4.2 (decision D8).
  - It is refused when:
    - mode is live;
    - a process is recorded or untracked;
    - runtime is openclaw and the kind is not openrouter;
    - the target kind has no usable lock;
    - `qq.enabled` is set without `--qq-platform-notified`;
    - `ledger.resetForProviderSwitch()` refuses.
  - Before that reset, in the same transaction: when the old kind's `caps.keyReadable` is true and the target kind differs, a `paid_paused` of `key_read_failed`, `residual`, `openrouter_key_limit` or `provider_fail` (`SWITCH_LIFTS` in `src/cli/clo.mjs`) is deleted, because only a read of the old Key lifts those and that Key may be gone. If the reset then refuses, the pause is back. Any other `paid_paused` still refuses the switch. A lift prints one line and logs `paid_resumed` with `source: 'provider_switch'`. This departs from the review's "refuse while paid_paused is set" and is recorded in `DECISIONS.md` as a developer choice.
  - On success, it:
    1. writes `activeProvider` and `acks.provider`;
    2. clears every group's `noticeGiven` and `acks.d3`;
    3. prints the notice and D3 reminder;
    4. runs `clo apply`.
- `clo ack hard-cap <name> --kind workspace_monthly --usd N --prepaid-no-reload [--confirm]`
  - It builds `ack = {kind, usd: N, prepaidNoReload: <flag given>}` and refuses when `hardCapAckRefusal({provider, ack, mode: cfg.mode, processRunning})` is not null. `provider` is the registry entry for `providers[name]`. `processRunning` is false only when no process is recorded or untracked. So it refuses:
    - a kind other than `workspace_monthly`, or a missing `--prepaid-no-reload`;
    - in live mode, so that the next `clo mode live` re-runs the whole `hard_cap` check;
    - while a process runs. A running process holds the Key it started with, which may not be the one now in .env, so an ack then could vouch for a Key the process does not hold.
  - It writes `acks.hardCap[name]` and sets control `hardCapControlKey(kind)` to `store.key(current .env Key)`.
  - It calls `ledger.liftHardCapPause(kind)`, which lifts only the hard-cap pause (section 8.1).
  - It refuses `N > 31 × budget.dailyUsd` without `--confirm`.
  - It prints that the cap rests on the owner's word and that one day can spend up to N.
  - Tests: each refusal, with a stopped dry-run ack of the D2 pair as the positive control.
- `clo start` refuses when `liveStartCheck({provider: providerOfConfig(cfg), mode: cfg.mode, ack: cfg.acks?.hardCap?.[name] ?? null, control, keyFp: store.key(current .env Key)})` gives `{ok: false}`. The .env Key is the one the child will get. Test a mismatched Key, a weaker ack and `provider_rules`, with the matching Key and the D2 ack as the positive control.
- A hard-cap pause never blocks `clo provider use`. The way back from an unattested Anthropic Key to OpenRouter is `clo provider use openrouter --confirm`, which asks for no attestation. The pause stays recorded for anthropic and applies again if anthropic becomes active again without a new ack.
- `clo budget clear-pause` allows `provider_fail` only when `caps.ownerClearsProviderFail`. Test both kinds.
- `clo status` shows `对账：不可用（本地估算）` for a kind whose Key cannot be read, and `硬上限未核实` while the active kind's hard-cap pause control is set.

**Recorded switch.** A control `active_provider = '<kind>:<name>'` (`ACTIVE_PROVIDER_CONTROL`), written only by `clo provider use`, in the same transaction as `resetForProviderSwitch`. `assertApplicable`, and so `clo apply`, `clo start` and `clo mode live`, refuses when the config's provider differs from it, in dry-run and in live. Without the control, the provider of the effective file counts; without that file, the implicit OpenRouter. That closes a hand edit of both `activeProvider` and `acks.provider`, which validation alone accepts.

## 11. Pauses, alerts, logs

### 11.1 Alerts
- `PRICE_ALERT` (`price_unexpected`, detail `{flags}`).
- `cost_above_computed` (K9 only).
- `paid_paused` with `{reason}`, as today.

### 11.2 Logs
- No new log keys. The retry event is `anthropic_retry` with `{attempt, reason: 'connect'}`.
- Never logged: request ids, provider messages, Keys, Key hashes.

### 11.3 Live on a kind whose Key cannot be read
It needs, together:
- `hard_cap`;
- `key_valid`;
- `provider_rules`.

`clo mode live` checks all three. `clo start` and the bot's start check `hard_cap` and `provider_rules` again through `liveStartCheck` (sections 7 and 10). So a stray field, a hand edit or a re-ack cannot carry live past a rule that is not recorded.

`provider_rules` passes only when `LIVE_RULES_RECORDED[kind]` is true. K8 wrote the `DECISIONS.md` and `CLAUDE.md` rows that record the user's consent. `anthropic` flips to true in the same commit as those rows, together with the test assertions that pin it false (in `provider-registry`, `config`, `bot-main`, `cli-mode`, `cli-provider` and `lifecycle-own`). No other change may flip it. `tests/unit/doc-status.test.mjs` fails while the rows and the flag disagree.

## 12. Test fakes (exist)

`tests/harness/fake-keys.mjs` exports:
- `FAKE_ANTHROPIC_KEY = 'sk-ant-FAKE-KEY-FOR-LOCAL-MOCK-ONLY'`
- `FAKE_ANTHROPIC_PROBE_KEY`
- `FAKE_MODEL_KEY` and its alias `FAKE_OPENROUTER_KEY`, re-exported from `tests/harness/gateway.mjs`

`tests/fixtures/fake-adapter.mjs` exports:
- `createFakeAdapter({ kind, idRule, retryEvent })`
  - It implements section 3 and records calls in `adapter.calls`.
  - Its wire format is a body `{fake: <Result fields>}`, which `fakeResponse(fields, status)` builds. A real `createChatClient` can drive it over a scripted fetch.
  - Its `request` puts the Key in an `x-fake-key` header.
- `createFakeClient({ adapter, script, getKey, getBaseUrl })`, the section 5 shape over a script of Results or `(body, opts) => Result`.
  - It never throws.
  - A null Key gives `not_sent`, and an aborted signal gives `aborted`.
  - An unscripted post gives `error/network` and increments `client.unscripted`, which tests should assert is 0.
- `fakeResult(kind, reason, over)`, `okResult(content, { kind, usage, finishReason, status })`, `fakeUsage(kind, over)`, `errorInfo(status, limitSource, over)`.
- `checkResult(r)` and the constants `RESULT_KEYS` and `INFO_KEYS`.

## 13. OpenRouter goldens (exist)

`tests/fixtures/provider-golden/` holds:
- `cases.mjs` (the inputs);
- `turn-bodies.json` and `decision-bodies.json` (`JSON.stringify` of today's builders, byte-exact strings);
- `client-results.json` (Result, calls with the Key masked, and logs for 34 response shapes, through today's `createOpenRouterClient`).

`provider-golden.test.mjs` pins each golden's canonical hash. Never regenerate them: a mismatch means the OpenRouter path changed.

## 14. Unverified facts (confirm with the paid probe, K7)

- That Haiku 5.5 accepts `thinking: {type: 'disabled'}` with `output_config.effort: 'low'` and `output_config.format`.
- Whether Opus 5.5 at effort low leaves text within `max_tokens` 3000, given that thinking counts toward it.
- The usage field names `inference_geo` and `speed`, and the workspace default geo.
- Whether `cache_read_input_tokens` and `cache_creation_input_tokens` are ever absent or `null`, and that the `cache_creation` leaves sum to `cache_creation_input_tokens`.
- That `body.model` echoes the bare id.
- The error shapes for exhausted credits, spend limits and region or permission 403s, and where `enforced_spend_limit_reached` sits.
- Whether errored or aborted requests are billed (decision D4).
- That `GET /v1/models/{id}` is free, and its capability leaf paths.
- That geo and fast multipliers stack and apply to cache tokens. Pricing assumes both, which only over-counts.

## 15. Decisions behind this contract

**User decisions** (2026-11-07, recorded in `DECISIONS.md`): the common layer itself, D2 hard cap, D3–D5 no reconciliation and owner-cleared pauses, D7 raw fetch, D8 provider switch as a model change.

**Developer defaults** the user has not confirmed (开发时定的，用户还没有确认, also in `DECISIONS.md`): D6 (K9), D9 effort mapping, D10 403 handling, D11 429/529 in the streak, D12 schema v2 with kind in `reservations.provider` and the backup rule in 8.2.

**Folded-in review findings:**
- the `provider_rules` precondition;
- the hard-cap fingerprint check at start;
- from the contract review: the ack refuses in live mode and beside a process; the hard-cap pause sits in its own per-kind control, so it neither replaces nor clears another pause, and switching away needs no attestation; only the D2 pair is an ack, and the start checks re-run it with `provider_rules`; one provider reader per file shape; unreadable token counts settle nothing; the schema backup by `VACUUM INTO` and its restore;
- the 1.1× geo factor in the probe bound;
- the switch refusals and resets;
- `keyOf` by the active kind;
- the OpenClaw-path `settleReply` test;
- the single-exit scan over `src/bot` and `src/tools`;
- Anthropic model capability checks;
- the decision effort limited to `none`;
- the model line limited to Opus, Sonnet and Haiku.

**Open:** whether 401 and 404 should pause at once instead of counting toward the streak. Separately, and not changed by this layer: the own runtime's connect retry runs under the turn's one hold, while the user decided on a separate hold; that is listed in `DECISIONS.md` (待定) for the user.
