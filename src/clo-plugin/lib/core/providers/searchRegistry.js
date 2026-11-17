// The web search this build knows: pure, frozen data and readers. No I/O, no config import.
// docs/search-contract.md is the contract. Search runs only on the own runtime: the gate calls OpenRouter's Sonar
// directly with its own Key, before the primary model, and the primary model still gets no tools.

// searchProvider in config.json. 'none' is the default and the only value the OpenClaw runtime accepts.
export const SEARCH_OFF = 'none';
export const SEARCH_PROVIDERS = Object.freeze([SEARCH_OFF, 'openrouter-sonar']);
// The one model each search provider calls. Not configurable: a different model is a model change.
export const SEARCH_MODEL = Object.freeze({ 'openrouter-sonar': 'perplexity/sonar-pro' });
// The runtimes that may turn search on. The OpenClaw runtime has no search in this build.
export const SEARCH_RUNTIMES = Object.freeze(['own']);

// The .env name of the search Key, and the one name it has in the bot's environment. The Gateway never gets either.
export const SEARCH_KEY_ENV = 'CLO_SEARCH_API_KEY';
export const SEARCH_CHILD_KEY = 'CLO_SEARCH_KEY';

// CLAUDE.md section 6: at most 2 calls per answer and 10 per day. Config may lower these, never raise them. The other
// ceilings bound what one call can cost and how long it can hold a reply back.
export const SEARCH_CEILINGS = Object.freeze({ perAnswer: 2, perDay: 10, maxTokens: 1000, resultMaxChars: 3000, queryMaxChars: 80, searchMs: 30000 });
export const SEARCH_DEFAULTS = Object.freeze({ perAnswer: 2, perDay: 10, maxTokens: 600, resultMaxChars: 1500, queryMaxChars: 80, searchMs: 20000 });
// The fields the optional search block of config.json may hold. Each is a positive integer up to its ceiling, except
// baseUrl, which only test mode may set, on loopback.
export const SEARCH_BLOCK_LIMITS = Object.freeze(['perAnswer', 'perDay', 'maxTokens', 'resultMaxChars', 'queryMaxChars']);
export const SEARCH_BLOCK_FIELDS = Object.freeze([...SEARCH_BLOCK_LIMITS, 'baseUrl']);

// Whether the project's recorded rules allow live with search on. False until the paid probe has confirmed the Sonar
// fields and price and the rule text for them has landed (docs/search-contract.md, "Unverified"). Until then search can
// be turned on and tested in dry-run and offline, and `clo mode live` refuses while it is on.
export const SEARCH_RULES_RECORDED = false;
export const searchRulesRecorded = () => SEARCH_RULES_RECORDED === true;

// clo.db controls. The first is written only by `clo search enable` and `clo search disable`: the search provider the
// install runs with, so a hand edit of searchProvider (and acks.search with it) is refused by apply and start, the way
// active_provider guards the chat provider. The second is the salted hash of the search Key the running bot holds, or
// 'none', written at each start, so `clo mode live` can tell it is the Key in .env.
export const SEARCH_ENABLED_CONTROL = 'search_enabled';
export const SEARCH_KEY_CONTROL = 'search_key';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// config.json: the search provider it names. A missing field reads as off.
export const searchProviderOf = (cfg) => cfg?.searchProvider ?? SEARCH_OFF;
// config.json: whether search is turned on globally. Per-group switches count only when this is true.
export const searchOnInConfig = (cfg) => searchProviderOf(cfg) !== SEARCH_OFF;
// effective.json: the search block is written only when search is on, so its presence is the switch.
export const searchOfEffective = (e) => (isObj(e?.search) && SEARCH_PROVIDERS.includes(e.search.provider) && e.search.provider !== SEARCH_OFF ? e.search : null);
// effective.json: whether this group may search. Both switches, and the group's own defaults to off.
export const groupSearchOn = (e, groupId) => searchOfEffective(e) !== null && e?.qq?.groups?.[groupId]?.search === true;

// ---- Money (docs/search-contract.md section 7) ----

// What a search reservation's provider column holds. It is neither 'openrouter' nor NULL, so a search row never explains
// the chat Key's reading, and the chat side's reconciliation never settles one.
export const SEARCH_ROW_PROVIDER = 'search';
// The tier and category of a search reservation.
export const SEARCH_TIER = 'search';
// Where versions.lock.json keeps the search model's lock: models.locks.search, beside the chat kinds' locks.
export const SEARCH_LOCK_KEY = 'search';
// The prompt tokens one search call is held at. What we send is a fixed instruction and one query of at most 80 code
// points, a few hundred tokens; the rest is room for retrieved content, in case Sonar counts it as prompt tokens
// (unverified). A settlement above the hold pauses search (cost_above_hold), so a wrong guess shows.
export const SEARCH_HOLD_INPUT_TOKENS = 4000;

// The control that pauses search alone. Chat never reads it; paid_paused still stops search too.
export const SEARCH_PAUSE_KEY = 'search_paused';
// Why search is paused, and how each one ends:
//   fail             3 failures in a row; one trial after the wait, a success lifts it, the owner can lift it
//   key_limit        the search Key's limit or credits (402); a Key read with room left lifts it
//   residual         the search Key's day figure above what the local search rows explain, twice; a clean read lifts it
//   key_read_failed  the search Key could not be read (at start, or twice in a row); a clean read lifts it
//   cost_above_hold  a call settled above its hold: the hold is wrong; only the owner lifts it
// A lower rank never replaces a higher one; an equal rank replaces.
export const SEARCH_PAUSE_RANK = Object.freeze({ cost_above_hold: 3, key_limit: 2, residual: 2, key_read_failed: 1, fail: 1 });
export const SEARCH_PAUSE_REASONS = Object.freeze(Object.keys(SEARCH_PAUSE_RANK));
export const SEARCH_OWNER_CLEARS = Object.freeze(['cost_above_hold', 'fail']);
export const searchPauseRank = (reason) => SEARCH_PAUSE_RANK[reason] ?? 1;

// The daily and per-answer counters. Day: the Shanghai day, as the 10-a-day rule reads. The Key's own limit resets on
// the UTC day; the light reconciliation compares on that day.
export const searchDayCounter = (shanghaiDay) => `search_day:${shanghaiDay}`;
export const searchEventCounter = (eventKey) => `search_event:${eventKey}`;
