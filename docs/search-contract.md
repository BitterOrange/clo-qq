# Search contract (own runtime only)

This is the implementation contract for web search. The user's decisions are in `DECISIONS.md` ("用户定的（2026-11-17，搜索）"), the rules in `CLAUDE.md` section 6. Where this file and the code disagree, the code and `DECISIONS.md` win, and this file is corrected.

## 0. Status

| Part | State |
|---|---|
| Config, effective file, start env, `doctor`, the `search_rules` live refusal | Implemented, offline tests only (`tests/unit/search-config.test.mjs`, `tests/unit/doctor.test.mjs`) |
| Adapter, the bot's search client and Key, price lock (`clo search lock`), ledger tier, counters, search pauses, light reconciliation, `clo budget` and `clo status` lines | Implemented, offline tests only (section 10) |
| Decision schema and prompt addendum, query cleaning, the gate's search step, the material and the search notes in the primary turn, the source line | Implemented, offline tests only (section 10) |
| `clo search enable`/`disable`/`show`, the per-group switch, the guard against hand edits, the live checks of the search Key, the probe tool | Implemented, offline tests only (sections 8 and 10). The probe has never run with `--approve` |
| Any real request (OpenRouter, Perplexity, QQ) | **None made.** Nothing here has run against the real Sonar API |

Until the paid probe in section 9 has run and its rules have landed, `SEARCH_RULES_RECORDED` in `src/clo-plugin/lib/core/providers/searchRegistry.js` is false and `clo mode live` refuses while search is on (`search_rules`). Search can be turned on in dry-run and in offline tests only.

## 1. Scope

- **Own runtime only.** On the OpenClaw runtime, `searchProvider` other than `none` is refused by config validation (so `clo apply` and `clo start`) and by `doctor` (`search_off`), with the reason that search is on the own runtime only. `render.js` is unchanged: `web_search`, `web_fetch` and `x_search` stay denied, `plugins.allow` stays `clo` and `openrouter`, and `@openclaw/perplexity-plugin` stays locked and unused. The decision request body on the OpenClaw route stays byte-identical.
- **One path.** The gate calls `perplexity/sonar-pro` on OpenRouter (`/chat/completions`) through the project's one send loop (`providers/modelChat.js`), with the search Key. The primary model's request still carries no `tools`. Sonar's text is untrusted material placed in the primary turn's user message; Claude writes the reply, and the whole reply goes through the exit as before.
- **Same with an Anthropic chat provider.** The chat goes straight to Anthropic, search still goes through OpenRouter to Perplexity on the search Key. The search Key's daily limit is search's hard cap either way.
- **Who triggers it.** A real @ or a reply to Clo in a group with search on buys one extra decision call that only asks whether to search and for the query terms (not bought when the search tier or the daily count is spent, or search is paused). That call never decides whether to answer: failure, timeout or bad output means "no search" and the answer goes ahead. A name mention gets the same two fields from the decision it already buys. Interjections never search in this build. The crisis route never searches.
- **Not in scope:** DMs (closed in this build), search on the OpenClaw runtime, search as a model tool.

## 2. Config and the effective file (implemented)

`config.json`:

| Field | Meaning |
|---|---|
| `searchProvider` | `none` (default) or `openrouter-sonar`. Required |
| `acks.search` | `{ provider, at }`, with `provider` equal to `searchProvider`. Required while search is on. Written by `clo search enable` (section 8), so turning search on by editing `searchProvider` alone is refused |
| `budget.searchKeyDailyLimitUsd` | Positive. Required while search is on: the search Key's daily limit as set on OpenRouter. No default, and the project ships no value |
| `search` (optional) | `perAnswer` (1–2, default 2), `perDay` (1–10, default 10), `maxTokens` (≤ 1000, default 600), `resultMaxChars` (≤ 3000, default 1500), `queryMaxChars` (≤ 80, default 80); `baseUrl` only in test mode, on loopback. Unknown fields are refused. The model is not configurable |
| `timeouts.searchMs` (optional) | 1–30000, default 20000, per search call |
| `qq.groups[id].search` (optional) | Boolean, off when left out. Set while search is off globally, it only warns |

The per-answer and per-day caps come from `CLAUDE.md` section 6; config can lower them, never raise them.

`effective.json`: with search off, nothing about search is written, so every file written with search off is byte-identical to before. With search on:

```
search: { provider, model: 'perplexity/sonar-pro', baseUrl, perAnswer, perDay, maxTokens, resultMaxChars, queryMaxChars, searchMs }
budget.searchKeyDailyLimitUsd
qq.groups[id].search   // true or false for every group
```

`baseUrl` defaults to the OpenRouter base the rest of the file uses (in test mode, the OpenRouter test address unless `search.baseUrl` is set). The effective reader treats a search block with an unknown provider, a block that says `none`, or a block on the OpenClaw runtime as no config at all. Readers: `searchOfEffective(e)` and `groupSearchOn(e, groupId)`.

## 3. The Key (implemented)

- `.env` name `CLO_SEARCH_API_KEY`. A separate OpenRouter Key: not the chat Key, not the probe Key.
- `clo start` reads it and passes it to the bot only while search is on, as `CLO_SEARCH_KEY`. The `.env` name never reaches any child. The Gateway gets neither name (`ensureGatewayEnvClean` refuses `CLO_SEARCH_KEY`). It is not a model Key: the bot still holds exactly one model Key.
- In live with search on, `requireSecrets` (start and `doctor`) needs the Key and refuses it when it equals `CLO_CHAT_API_KEY`, without printing either value. The comparison with `CLO_TEST_API_KEY` belongs to the live checks of the console step, since `clo start` does not read the probe Key.
- `doctor` on the own runtime: `search_config` passes when the bot's env holds `CLO_SEARCH_KEY` exactly when search is on, and `effective.json` agrees with `config.json`.

## 4. The adapter and the client (implemented)

`providers/searchAdapter.js` implements what `modelChat.js` needs (`request`, `classify`, `parseError`, `requestedModel`, `retryEvent`), plus `searchBody`. Pure; it never calls `fetch` itself, so the static list of files that may call `fetch` stays as it is (a planted `fetch` in it is flagged: `tests/fixtures/single-exit-offenders/fetch-in-search-adapter.js`). `createSearchAdapter({ resultMaxChars })` fixes the text cut; the bot builds its adapter once, when the services open.

The bot (`src/bot/services.mjs`) builds a second client on the same send loop: Key `searchKeyOf(env, getEffective)`, which is `CLO_SEARCH_KEY` only while the effective file has search on and only when it is not the chat Key (OpenRouter or Anthropic); base `searchBaseOf(getEffective)`, the search block's own `baseUrl`, whatever the chat provider is. The search Key is in `liveSecrets`, so the exit refuses text that holds it.

Request body (field names **unverified**):

```
{ model: 'perplexity/sonar-pro', stream: false, max_tokens: search.maxTokens, usage: { include: true },
  messages: [ { role: 'system', content: <fixed instruction> }, { role: 'user', content: <one query> } ] }
```

No history, no speaker codes, no group or member ids, no `user` field, no attribution headers. The classified result carries only: the text cut to `resultMaxChars`, up to 5 sources as `{ name }`, usage, and the HTTP status (`message` is always null). Provider error text never leaves the adapter. URLs never leave the adapter: they are not stored in `clo.db`, not logged, and not added to the turn's inbound URL list, so a URL the model copies is replaced by the exit's URL guard.

Sources are read from all three shapes (`choices[0].message.annotations[].url_citation`, top-level `search_results`, top-level `citations`), in that order. A name is the main label of the URL's host (`news.bbc.co.uk` gives `bbc`; never a dot, an IP, punycode or a scheme other than http/https). Titles are never used: a title is free web text, the program posts the source line itself, and no model judges it first, while CLAUDE.md section 8.4 leaves political content to the model alone (the local rules have no political words). A citation with no usable host gives no name. Each name once, at most 5.

| `kind` | `reason` | Meaning |
|---|---|---|
| `ok` | null | text and 1 to 5 sources |
| `no_source` | `no_source` | a handled, billed answer with no usable source name; its text is withheld here |
| `error` | `bad_body`, `no_choice`, `tool_calls`, `finish_error`, `finish_reason`, `model_mismatch`, `empty`, `http`, `provider_error` | no text, no sources |
| `refusal` | `refusal`, `content_filter`, `moderation` (a 403 with no limit source) | no text, no sources |

The transport adds `not_sent`, `aborted`, and `error` with `network` or `timeout`, with no text and no sources.

### The price lock

`clo search lock [--confirm-price]` reads the OpenRouter catalog (no Key) and writes `models.locks.search` in `versions.lock.json`: `{ id: 'perplexity/sonar-pro', price: { inputPerM, outputPerM, requestUsd } }`. `prompt` and `completion` are per token; `request` and `web_search` (field names **unverified**) are USD per call and are added into `requestUsd`. Any other price field that is not zero refuses the lock. `--confirm-price` is needed for the first lock, for any change of price up or down, and above $30/M output. A lock is a price, not a model change: `models.changes` is not touched. With search on, `clo apply` (and the lock itself) writes the price into `effective.search.price`; without a lock it is null and the ledger holds nothing for search.

## 5. The decision and the queries (implemented)

`decide({ ..., search: true })` (`decision.js`) asks with a second schema: the four fields as before plus two strings, `search_query_1` and `search_query_2`, empty for none. Two strings rather than an array with `maxItems`, which a strict schema may not accept (section 9). The system prompt is `persona/decision-prompt.zh.md` unchanged followed by `persona/decision-search-addendum.zh.md`. Without `search: true`, and always on the OpenClaw runtime, the request is byte for byte what it was, and an answer carrying the query fields is invalid. The search decision is held at `SEARCH_DECISION_INPUT_TOKENS` (11500) input tokens, `holdMicros('search_decision')`; the plain decision's hold is unchanged.

`parseAnswer(content, { search: true })` adds `search: { need, queries, skipClass }`. `need` is false when `crisis` is true. `searchRequestOf(d)` (`search.js`) turns that into what the step gets: null (no search: no need, an invalid decision, danger, or no non-empty query), `{ refused: true }` when the class is not `none` (the turn is told `refused`, nothing leaves), or `{ queries }`.

Who asks:

- A real @ or a reply to Clo (`runAddressed`): after the sender's hourly slot, one search-only decision (trigger `addressed`), bought only when the group's switch and search are on, live, the group and the whole bot are not paused, the message is not on the crisis list, its own text did not hit a local rule (its search would be refused anyway, and the decision would send the line and its context out once more for nothing), and `ledger.searchRoom({ extraMicros })` says a search could be claimed (price locked, no paid pause, no search pause or a failure pause's trial due, the day's count not full, the search tier able to take one hold on top of `extraMicros`: the search decision's hold and the reply's hold, which are both taken before the search is claimed). It counts against the per-group hourly and daily decision caps, pays from the addressed tier, and is not bought while the decision breaker is open. Whatever happens to it, the reply goes ahead (`approveAndRun`); a `/stop` that arrived meanwhile skips the event.
- A name mention: the decision it buys anyway asks with search when the same conditions hold (a local-rule hit does not stop it: nothing more leaves, and the search is refused locally); it is then held at `holdMicros('search_decision')`, and otherwise at the plain decision's hold. The search request is kept only when the route is `name_addressed`.
- Interjections and the crisis route never ask.

Query terms come from the decision model. The program cleans each one: NFKC, control characters removed, whitespace collapsed, at most `queryMaxChars` code points. A term is refused whole if it holds a URL, a `<@…>` mark, a speaker code, a display name known in the group, or a run of 6 or more digits, or if `policy.checkLeak` (with the turn's raw ids and the process's secrets) or `policy.check` hits. The program can enforce these shapes; it **cannot** guarantee that a term is semantically limited to what is needed. The notice must say so.

## 6. The search step and its states (implemented)

The step runs in the gate after the reply is reserved and the event is `dispatching`, before the primary call, so `/stop`, shutdown and the deadline abort it through the turn's controller. For each of at most `perAnswer` terms:

1. Local checks, no network, no reservation, no count: a refused request or the inbound pre-rule → the whole search is `refused`. A term that fails cleaning on a local rule → that term is `refused`. A term that fails on its shape, length or a privacy guard (`long`, `url`, `mention`, `speaker`, `digits`, `name`, `leak`, `empty`, or a check that threw) → that term is `withheld`: it was not searched this time, which is neither a topic refusal nor a network failure. Such a term is never handed to the model.
2. Time: if `now + searchMs + 45 s (the primary turn's minimum) + 15 s (posting)` is past the passive window's end → that term is `failed`, nothing sent. The call's own deadline is `searchMs`.
   Then the turn is asked whether it may still go on (`mayGoOn`: effective readable, admitted, live, no global, group, terminal or paid pause, no hard-cap pause of the chat kind, the group's search switch on). No: the search stops there, with nothing claimed for that term.
3. One transaction: pauses and `search_paused`; the daily counter (Shanghai day, `perDay`); `ledger.reserve({ tier: 'search', category: 'search', provider: 'search', heldMicros: worst case of one call })`. Any refusal rolls all of it back → `failed` (reason only in the log).
4. Send.
5. Settle by the reservation id: not sent → released (the counts stay used); cost known → settled; no usage (a timeout, a network error, an HTTP error, our own abort) → unsettled, counted at the hold. Health: a connect failure, a timeout, a network or HTTP error and an unreadable answer count toward the 3-failure pause; an answer, with or without sources, or a Sonar refusal, resets it; our own abort counts for nothing. A connect retry is the send loop's one retry, asked first whether the bot is live, unpaused and search unpaused; it takes no hold of its own.
6. Sonar's text that hits a local rule → `refused`, withheld. Text with a leak shape, a secret or a raw id → `failed`, withheld. Source names pass the same checks; none left → `no_source`.

After the step, and before the primary call, the gate reads again what `approveAndRun` checked (`refusalNow`): admission, mode, the global, group and terminal pauses, the paid pause and the chat kind's hard-cap pause. A search can take up to two calls of `searchMs`, so any of these may have come meanwhile. A refusal ends the turn as `approveAndRun` would (`paused:paused`, `dry_run:would_*`, `ignored:admission`, `skipped:paid_paused`), the reply's hold is released, and a paid pause gives a required turn the failure line and a person in danger the alert, as there. A `/stop` during the search keeps its own path. A group switch turned off during the search only stops further calls: the reply goes on with what was found.

The code is `search.js` (`cleanQuery`, `queryItemStatus`, `searchRequestOf`, `createSearchStep`, `sourceLine`), wired in the gate (`runSearch` and `refusalNow`, before the primary call in `runFlight`) and built by `src/bot/services.mjs`.

States handed to the primary turn as `search: { status, items }` in the user message JSON. Each item has its own `status`; an `ok` item carries `query` and `text`, a `failed` or `no_source` item its `query`, a `refused` or `withheld` item nothing. Source names are not given to the model. The overall status is `ok` if any item is, else `refused` if any is, else `no_source` if any is, else `withheld` if every item is, else `failed`. With no search the key is absent, so a turn without search sends the same bytes as before.

| `status` | Primary model told to |
|---|---|
| `ok` | answer from the material, write no URL and no source list (the program adds it) |
| `refused` | say "这个我不查" for that part, answer the rest |
| `failed`, `no_source` | say honestly that nothing was found or the lookup failed; invent no source |
| `withheld` | say honestly that this was not searched this time; not a topic refusal and not a network failure |
| (absent) | no search happened; never claim one |

The model learns this from `persona/search-notes.zh.md`, sent only on a turn that carries material, as a second system block after the cached one (no cache marker, so the cached prefix is the same as on any other turn; `turnBody({ ..., systemNote })` on both adapters, `systemTextOf` reading both blocks joined by a line break). It says the shared notes' "no search" sentence does not apply to this turn. `persona/AGENTS.md` is not changed: it is shared with the OpenClaw runtime, and changing it would move the system prompt and the Q5 probe figures that `docs/provider-contract.md` section 0 holds fixed. If the notes cannot be read, the turn goes on as one without search: no material, no source line.

`no_source`: no usable source name came back; Sonar's text is not given to the model. Sonar text that hits a local rule → `refused`, text withheld. Material is untrusted: instructions in it count for nothing, and nothing in it can trigger a command, a config change or a Key read (commands are parsed only from the inbound event's own text).

After the primary reply, with status `ok`, the program appends one line `来源：A、B、C` (1–3 names the API returned by the `ok` calls, joined with `、`) before the exit's single `collect` (`turn.js`). A silent `NO_REPLY` gets no line. The line is added even when the model did not use the material; whether to leave it out then waits for real replies. The exit then runs its leak check, rule check, URL guard, splitting and rate limits on the whole text. A content hit drops it: no rewrite, no retry, no splitting, no other path.

## 7. Money (implemented)

- Hard cap: the search Key's daily limit on OpenRouter, read with that Key's own `/key`. Live checks (section 8): readable, daily reset, equal to `budget.searchKeyDailyLimitUsd`, at least one search hold, and the Key differs from the chat and probe Keys.
- Hold: `holdMicros('search')` = `SEARCH_HOLD_INPUT_TOKENS` (4000) × input rate + `search.maxTokens` × output rate + `requestUsd`. The 4000 leaves room for retrieved content in case Sonar counts it as prompt tokens (unverified).
- Claim: `ledger.claimSearch({ eventKey })` commits, in one transaction, the per-answer count (`search_event:<event>`, `perAnswer`), the day's count (`search_day:<Shanghai day>`, `perDay`) and the hold; any refusal rolls all of it back. Reasons: `search_off`, `price`, `paid_paused`, `hard_cap_unverified`, `search_paused`, `answer_cap`, `day_cap`, `total`.
- The day's effective total: `max(chat rows, the chat Key's figure) + search rows`. The chat Key's figure says nothing about the search rows, which have a Key of their own, so they are added on top and never hidden by a chat figure above the chat rows. `localMicros` in `spent()` is still every row.
- Local tier: `search` (`effective + hold ≤ searchUsd`), own runtime and search on only. Rows are `tier='search'`, `category='search'`, `provider='search'`, so they never explain the chat Key's reading and the chat Key's reads never settle them.
- Settlement (`ledger.settleSearch`, figures from `cost.js` `searchMicros`): the reported cost; without one, tokens at the lock plus `requestUsd`; without either, unsettled at the hold. A figure above the hold settles at the figure and pauses search (`cost_above_hold`).
- Reconciliation (decision D3, light): `searchTick` reads the search Key at the search base at the first live tick, after any new search row or settlement, while a search row is open or a read-lifted pause stands, and every 10 minutes. It compares `usage_daily` (**field unverified**; missing counts as a failed read) with the UTC day's search rows (settled at their figure, released at 0, others at their hold). A gap above max($0.25, 15% of the figure) twice in a row pauses search (`residual`). A limit unlike `budget.searchKeyDailyLimitUsd`, or a reset that is not daily, alerts once. Nothing is written to `key_snapshots` and nothing is attributed. No `clo.db` migration; schema stays at version 2.
- Unsettled search rows settle at their hold after `unsettledClearMs` (15 minutes), source `search_hold` (over-count, never under-count); then a settlement pause with nothing left unsettled lifts as on any settlement. The same on either chat provider.
- Pauses (`search_paused`) stop search, never chat. A lower rank never replaces a higher one.

| Reason | Set by | Lifted by |
|---|---|---|
| `fail` (rank 1) | 3 failures in a row (`noteSearchError`) | a success after the one trial per 10 minutes, or the owner |
| `key_read_failed` (1) | the search Key unread at the first read, or twice in a row | a clean read |
| `key_limit` (2) | a 402, or a 402/403 with an OpenRouter limit source; a read with no room left | a read with room |
| `residual` (2) | the gap above, twice in a row | a clean read |
| `cost_above_hold` (3) | a settlement above its hold | the owner only (`clo budget clear-search-pause`) |

  The global `paid_paused` and the active chat kind's hard-cap pause still stop search.
- Timing: decision 8 s + 2 × 20 s search + 90 s turn = 138 s, inside 285 s − 15 s. The step's own time check is in section 6.

## 8. Turning it on, the live checks and the probe (implemented)

`clo search enable --confirm [--qq-platform-notified]` (`src/cli/clo.mjs`) follows `clo provider use`. It refuses, writing nothing, without `--confirm`; in live; while a process runs (a recorded one, or a bot holding the account's lease with no record); off the own runtime; without a usable search lock; without `budget.searchKeyDailyLimitUsd` (the amount is the user's, and the command never fills one in); and with QQ enabled but no `--qq-platform-notified`. Then it writes `searchProvider` and `acks.search`, clears `acks.d3` and every group's `noticeGiven`, records `search_enabled` in `clo.db` (`SEARCH_ENABLED_CONTROL`), applies, and appends `{ at, kind: 'search', model, state: 'on', qqPlatformNotified }` to `models.changes` in `versions.lock.json`.

Hand edits: `assertApplicable` (`src/cli/common.mjs`), and so `clo apply`, `clo start` and `clo mode live`, compares `searchProvider` with the record (without one, with the effective file; without that, off) and refuses a difference in either direction. Off is refused too: otherwise the record would still say on, and a later hand edit back on would pass as already recorded, skipping the cleared notices and D3. Only enable and disable pass `searchSwitch`.

`clo search disable` is allowed at any time, in live and beside a running process, since it only takes something away. It needs no platform flag, writes `searchProvider: "none"`, removes `acks.search`, records `search_enabled = none` and a `state: 'off'` change, and leaves notices, D3 and the group switches as they are. The deployer updates what was reported to the platform and the notice. A running bot stops searching at its next read of the effective file.

`clo group set <label> --search on|off`: on clears that group's `noticeGiven` and is refused in live; off, or on when already on, clears nothing. It may be set while search is off globally (a warning says it has no effect). `clo group list` shows it. `clo search show` prints the state, the lock and one hold, whether the search Key is filled (and whether it equals the chat or probe Key, never its value), the configured daily limit, the counts, the recipients and the live-rules note. It makes no request.

With search on, `livePreconditions` (`config.js`) adds, from facts `gatherLiveFacts` collects:

| Code | Passes when |
|---|---|
| `search_runtime` | the own runtime |
| `search_ack` | `acks.search.provider` and the `clo.db` record both name `searchProvider` |
| `search_lock` | `models.locks.search` is a usable lock for the search model |
| `search_key` | `CLO_SEARCH_API_KEY` is in `.env` and equals neither `CLO_CHAT_API_KEY` nor `CLO_TEST_API_KEY` |
| `search_key_limit` | the search Key's `/key` (read through `ledger.readSearchKey`) has a daily limit equal to `budget.searchKeyDailyLimitUsd`, reset daily, at least one search hold, and a `usage_daily` figure |
| `search_process_key` | the `search_key` control the bot writes at each start (`src/bot/main.mjs`: the salted hash of the `CLO_SEARCH_KEY` it holds, or `none`) matches `.env` |
| `search_rules` | `SEARCH_RULES_RECORDED` |

The search Key is sent to `/key` only when the search rules are recorded, D3 is recorded and `search_key` passes. While the rules are unrecorded it is never read, and `search_key_limit` says it was not checked.

The probe (`src/tools/search-probe.mjs`, run through `scripts/search-probe.ps1` or `scripts/search-probe.sh`) settles section 9. Without `--approve` it prints the plan and makes no request; `.env` is not read. With `--approve --max-usd <cap>` it reads only `CLO_TEST_API_KEY` and refuses when that Key has no daily limit or one above the cap, then reads the catalog with no Key and refuses on a missing model, an unknown non-zero price field, or a price above its fixed ceilings (search: $5/M input, $20/M output, $0.02 a call; decision: $2/M, $10/M). It then sends two calls, each compared byte for byte with the plan just before it leaves and never retried: one decision with the search schema and one Sonar call with a fixed query. A call that costs more than its bound stops the run. A closing `/key` read compares the spend. Results (`captures/search-probe-results.jsonl`) hold field names, types, numbers and classifications only: no query, answer, title or URL. The worst case at the ceilings is $0.0619. The plan's optional second Sonar call (to try parameters such as `search_context_size`) is not in it.

## 9. Unverified (to be settled by the paid probe, with the user's approval of the amount)

| Assumption | State |
|---|---|
| Model id `perplexity/sonar-pro`, and the response's `model` equals it | Unverified |
| Where citations are: top-level `citations`, `choices[0].message.annotations[].url_citation`, or `search_results` | Unverified |
| Whether sources carry titles | Unverified |
| Whether `usage.cost` is reported and includes the per-request fee | Unverified |
| Whether retrieved content counts as prompt tokens | Unverified |
| Whether `usage: {include: true}`, `provider.require_parameters` and `max_tokens` are accepted | Unverified |
| The catalog's per-request price field names | Unverified |
| Whether the decision model, under the strict schema, fills `search_query_1` and `search_query_2` as asked (two plain strings, chosen so that array support does not matter) | Unverified |
| Whether `/key` reports `usage_daily`, and how fast it updates | Unverified |
| Whether an aborted or timed-out search is charged | Treated as charged |

The search Key's daily limit and the probe's cap are not decided. Results go to `DECISIONS.md` ("平台实测得到的事实") marked as one sample; if a field differs, the adapter and the mocks change first and the offline tests run again.

## 10. Tests (CLAUDE.md section 10)

Every behaviour gets an offline test with its positive control in the same run, against mocks only. Written so far:

- `tests/unit/search-config.test.mjs` (config, effective, the price in it, live refusal, env, secrets) and the search cases in `tests/unit/doctor.test.mjs`.
- `tests/unit/search-adapter.test.mjs`: body, success in each citation shape, source names (host labels only, a title never), no source, the text cut, every failure shape, HTTP errors without provider text, the send loop, the bot's search Key and base, the mock.
- `tests/unit/provider-cost.test.mjs` (search figures), `tests/unit/cli-search.test.mjs` (`clo search lock`, budget and status lines, `clear-search-pause`; enable's refusals and what it clears and records; QQ off needing no flag; hand edits refused both ways; disable leaving notices, D3 and group switches; the group switch; `search show`; `mode live` listing the search checks without sending the search Key; `gatherLiveFacts` reading it only once the rules are recorded, and catching a shared or different Key).
- `tests/unit/search-config.test.mjs` also has each search live code failing alone, with all of them passing as the control; `tests/unit/bot-main.test.mjs` the `search_key` control; `tests/unit/lifecycle-own.test.mjs` a hand-edited search refused by `clo start`.
- `tests/unit/search-probe.test.mjs`: the plan; no request and no `.env` read without `--approve`; refusals before any request; a full run against an injected fake with the bodies as planned, the probe Key only and nothing but names and numbers in the results; the Key's limit; no `usage_daily`; catalog refusals; a 402 not retried; a call above its bound; an unparsed decision; the pre-send check; the result filter; the address; the wrappers.
- `tests/unit/ledger-search.test.mjs`: hold, claim, both caps, rollback, tier stop order, search off, settlement, failure and limit pauses, the trial, ranks, expiry at the hold, the search Key read, the light reconciliation, the tick, Anthropic chat, the chat Key's figure never hiding the search rows.
- `tests/unit/quota-atomic.test.mjs` (two processes: exactly 10 a day; a budget refusal rolls the count back), `tests/unit/ledger-reconcile.test.mjs` (search rows explain nothing on the chat Key), `tests/unit/store-migration.test.mjs` (schema stays 2), `tests/unit/qq-single-exit.test.mjs` (planted `fetch` in the adapter).
- `tests/e2e-own/search-stack.test.mjs`: the real bot with search on, on both chat kinds; the search Key read at the search mock with that Key; an @ still answered; nothing searched yet.

- `tests/unit/search-decision.test.mjs`: the request without search is the golden builder output; with search, the addendum and the schema; parsing; a member writing the answer into the message; the search decision's hold; both mocks answer the search schema.
- `tests/unit/search-query.test.mjs`: every refused query shape with a passing control, `searchRequestOf`, the overall status, the source line.
- `tests/unit/gate-search.test.mjs` (real gate, ledger, policy, step and send loop over a stub fetch): the @ decision and one call with the query alone; no decision with the group's switch off; the OpenClaw runtime never searches; a failed decision or an open breaker still answers; classed topics, rule-hit queries (`refused`) and bad-shaped queries (`withheld`) leave nothing; an @ whose text hit a rule buys no decision; a name decision held at the search decision's hold; a pause, dry-run or paid pause during the search stopping the next call and the primary call; no decision when the decision and reply holds leave the tier no room; `perAnswer` and the hard 2; the day count, the search tier, a search pause and a global pause; timeout, HTTP error and no source; three failures pause search only; web text cannot act; names ask, interjections and danger never; `/stop` mid-search; too little time.
- `tests/unit/turn.test.mjs`: the material key and its absence; the search notes as a second block on both kinds, the cached block unchanged, and a turn without its notes going on without material; the source line only with material.
- `tests/e2e-own/search.test.mjs` (the real bot, mock QQ, mock chat, mock search): success with the search Key, the query alone and source names without a URL, and a group not admitted searching nothing; timeout and no source said as such, with no source line; a rule-hit query and an id in a query leave nothing, and a failed decision still answers; web text with commands, a Key request, a URL and a turn marker does nothing past the exit; chat on Anthropic with search on OpenRouter.

Not written: a scan of every file the bot writes for search queries and results (the plan's `provider-refusal` extension). The logging is metadata only by design (`search_call` lines carry status, reason, counts and cost), but no test reads the files back yet.
