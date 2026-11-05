// expect: destructure:apiRequest
export function f(x) { const { apiRequest: quiet } = x; return quiet; }
