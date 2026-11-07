// expect: fetch-alias as: main.mjs in: bot
const { fetch: go } = globalThis;
export const f = (u) => go(u);
