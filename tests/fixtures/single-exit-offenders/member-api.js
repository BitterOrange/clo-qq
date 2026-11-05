// expect: send-surface:api
export function f(x) { return x.api.post('/v2/groups/a/messages', {}); }
