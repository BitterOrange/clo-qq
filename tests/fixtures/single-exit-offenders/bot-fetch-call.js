// expect: fetch-call as: services.mjs in: bot
export function open({ fetch = globalThis.fetch } = {}) { return fetch('http://127.0.0.1:9/v1/messages', { method: 'POST' }); }
