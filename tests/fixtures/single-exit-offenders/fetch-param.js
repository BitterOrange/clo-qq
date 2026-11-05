// expect: fetch
export function f({ fetch: go }) { return go('x'); }
