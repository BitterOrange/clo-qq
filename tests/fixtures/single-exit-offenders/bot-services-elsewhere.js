// expect: fetch as: sub/services.mjs in: bot
export function open({ fetch }) { return fetch.call(null, 'http://127.0.0.1:9/x'); }
