// expect: fetch-alias as: lib/core/decision.js
export function decide({ fetch: go }) { return go('http://127.0.0.1:9/v1/messages'); }
