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

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// config.json: the search provider it names. A missing field reads as off.
export const searchProviderOf = (cfg) => cfg?.searchProvider ?? SEARCH_OFF;
// config.json: whether search is turned on globally. Per-group switches count only when this is true.
export const searchOnInConfig = (cfg) => searchProviderOf(cfg) !== SEARCH_OFF;
// effective.json: the search block is written only when search is on, so its presence is the switch.
export const searchOfEffective = (e) => (isObj(e?.search) && SEARCH_PROVIDERS.includes(e.search.provider) && e.search.provider !== SEARCH_OFF ? e.search : null);
// effective.json: whether this group may search. Both switches, and the group's own defaults to off.
export const groupSearchOn = (e, groupId) => searchOfEffective(e) !== null && e?.qq?.groups?.[groupId]?.search === true;
