// expect: fetch-alias as: main.mjs in: bot
const go = globalThis.fetch;
export const f = (u) => go(u);
