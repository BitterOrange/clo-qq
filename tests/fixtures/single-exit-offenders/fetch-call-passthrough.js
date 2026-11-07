// expect: fetch-call as: lib/core/decision.js
export function decide({ fetch }) { return fetch('http://127.0.0.1:9/v1/messages'); }
