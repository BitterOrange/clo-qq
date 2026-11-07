// expect: fetch-use as: services.mjs in: bot
export function open({ fetch = globalThis.fetch } = {}) { return Reflect.apply(fetch, null, ['http://127.0.0.1:9/v1/messages']); }
