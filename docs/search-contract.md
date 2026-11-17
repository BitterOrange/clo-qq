# Search contract (own runtime only)

This is the implementation contract for web search. The user's decisions are in `DECISIONS.md` ("用户定的（2026-11-17，搜索）"), the rules in `CLAUDE.md` section 6. Where this file and the code disagree, the code and `DECISIONS.md` win, and this file is corrected.

## 0. Status

| Part | State |
|---|---|
| Config, effective file, start env, `doctor`, the `search_rules` live refusal | Implemented, offline tests only (`tests/unit/search-config.test.mjs`, `tests/unit/doctor.test.mjs`) |
| Adapter, price lock, ledger tier and counters, decision schema, gate step, source line, console commands, probe | **Not written yet** |
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
| `acks.search` | `{ provider, at }`, with `provider` equal to `searchProvider`. Required while search is on. Written by the console's enable command (not written yet), so turning search on by editing `searchProvider` alone is refused |
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

## 4. The adapter (planned)

`providers/searchAdapter.js` implements what `modelChat.js` needs (`request`, `classify`, `parseError`, `requestedModel`, `retryEvent`). Pure; it never calls `fetch` itself, so the static list of files that may call `fetch` stays as it is.

Request body (field names **unverified**):

```
{ model: 'perplexity/sonar-pro', stream: false, max_tokens: search.maxTokens, usage: { include: true },
  messages: [ { role: 'system', content: <fixed instruction> }, { role: 'user', content: <one query> } ] }
```

No history, no speaker codes, no group or member ids, no `user` field, no attribution headers. The classified result carries only: the text cut to `resultMaxChars`, up to 5 sources as `{ name }`, usage, and the HTTP status. Provider error text never leaves the adapter. URLs never leave the adapter: they are not stored in `clo.db`, not logged, and not added to the turn's inbound URL list, so a URL the model copies is replaced by the exit's URL guard.

## 5. Queries (planned)

Query terms come from the decision model. The program cleans each one: NFKC, control characters removed, whitespace collapsed, at most `queryMaxChars` code points. A term is refused whole if it holds a URL, a `<@…>` mark, a speaker code, a display name known in the group, or a run of 6 or more digits, or if `policy.checkLeak` (with the turn's raw ids and the process's secrets) or `policy.check` hits. The program can enforce these shapes; it **cannot** guarantee that a term is semantically limited to what is needed. The notice must say so.

## 6. The search step and its states (planned)

The step runs in the gate after the reply is reserved and the event is `dispatching`, before the primary call, so `/stop`, shutdown and the deadline abort it through the turn's controller. For each of at most `perAnswer` terms:

1. Local checks, no network, no reservation, no count: the inbound pre-rule or any term check hits → `refused`.
2. Time: if what is left before `deadline − 15 s` cannot hold `searchMs` plus the primary turn's minimum, → `failed`, nothing sent.
3. One transaction: pauses and `search_paused`; the daily counter (Shanghai day, `perDay`); `ledger.reserve({ tier: 'search', category: 'search', provider: 'search', heldMicros: worst case of one call })`. Any refusal rolls all of it back → `failed` (reason only in the log).
4. Send.
5. Settle by the reservation id: not sent → released; cost known → settled; no usage → unsettled.

States handed to the primary turn as `search: { status, items }` in the user message JSON. With no search the key is absent, so a turn without search sends the same bytes as before.

| `status` | Primary model told to |
|---|---|
| `ok` | answer from the material, write no URL and no source list (the program adds it) |
| `refused` | say "这个我不查" for that part, answer the rest |
| `failed`, `no_source` | say honestly that nothing was found or the lookup failed; invent no source |
| (absent) | no search happened; never claim one |

`no_source`: no usable source name came back; Sonar's text is not given to the model. Sonar text that hits a local rule → `refused`, text withheld. Material is untrusted: instructions in it count for nothing, and nothing in it can trigger a command, a config change or a Key read (commands are parsed only from the inbound event's own text).

After the primary reply, with status `ok`, the program appends one line `来源：A、B、C` (1–3 names the API returned) before the exit's single `collect`. The exit then runs its leak check, rule check, URL guard, splitting and rate limits on the whole text. A content hit drops it: no rewrite, no retry, no splitting, no other path.

## 7. Money (planned)

- Hard cap: the search Key's daily limit on OpenRouter, read with that Key's own `/key`. Live checks (console step): readable, daily reset, equal to `budget.searchKeyDailyLimitUsd`, at least one search hold, and the Key differs from the chat and probe Keys.
- Local: tier `search` (`effective + hold ≤ searchUsd`), the daily count, the per-answer count. Rows are `tier='search'`, `category='search'`, `provider='search'`, so they never explain the chat Key's reading.
- Reconciliation (decision D3, light): each heartbeat compares the search Key's `usage_daily` (**field unverified**) with the UTC day's search rows; a gap above the threshold twice in a row pauses search only (`search_paused=residual`). No `clo.db` migration; schema stays at version 2.
- Unsettled search rows settle at their reserved amount when they expire (over-count, never under-count), so they do not hold the chat side's `usage_missing` pause open.
- Pauses stop search, never chat: 3 failures or timeouts in a row → `search_paused=fail` with a probe after 10 minutes; 402 or the Key limit → `search_paused=key_limit`; actual cost above the hold → `search_paused=cost_above_hold`, owner clears. The global `paid_paused` still stops everything.
- Timing: decision 8 s + 2 × 20 s search + 90 s turn = 138 s, inside 285 s − 15 s.

## 8. Turning it on (planned)

The console's enable command follows `clo provider use`: dry-run only, no process running, own runtime, search model price locked, `--qq-platform-notified` when QQ is enabled. It writes `searchProvider` and `acks.search`, records the switch in `clo.db`, clears `acks.d3` and every group's `noticeGiven`, and adds a model change to `versions.lock.json`. Turning on one group's switch clears that group's `noticeGiven`. Disabling needs no platform flag; the deployer updates what was reported to the platform.

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
| Whether a strict schema accepts a string array with `maxItems` (the decision's query field) | Unverified |
| Whether `/key` reports `usage_daily`, and how fast it updates | Unverified |
| Whether an aborted or timed-out search is charged | Treated as charged |

The search Key's daily limit and the probe's cap are not decided. Results go to `DECISIONS.md` ("平台实测得到的事实") marked as one sample; if a field differs, the adapter and the mocks change first and the offline tests run again.

## 10. Tests (CLAUDE.md section 10)

Every behaviour gets an offline test with its positive control in the same run, against mocks only. Written so far: `tests/unit/search-config.test.mjs` (config, effective, live refusal, env, secrets) and the search cases in `tests/unit/doctor.test.mjs`. Still to write with their steps: adapter (success, no source, non-JSON, 4xx, 5xx, refusal, model mismatch), ledger and counters (tier stop order, 11th call refused, rollback), decision and query cleaning (injection in the group message, ids in a "query"), and the end-to-end rows: not admitted → no search; success with source names and no URL; timeout; no source; local-rule block; web text asking for Keys, commands or config; budget, pause and count limits; at most 2 calls; decision failure still answers; `/stop` mid-search; Anthropic chat with OpenRouter search.
