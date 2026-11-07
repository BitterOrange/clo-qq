// expect: fetch-use as: lib/core/decision.js
export function decide({ fetch }) { return (0, fetch)('http://127.0.0.1:9/v1/messages'); }
