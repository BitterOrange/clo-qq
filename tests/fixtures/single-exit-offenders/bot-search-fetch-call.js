// expect: fetch-call as: services.mjs in: bot
export function f({ fetch = globalThis.fetch } = {}) { const search = (u) => fetch(u); return search('http://127.0.0.1:9/key'); }
