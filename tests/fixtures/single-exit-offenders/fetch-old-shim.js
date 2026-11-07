// expect: fetch as: lib/core/openrouterChat.js
export function createOpenRouterClient({ fetch }) { return { post: (u) => fetch(u) }; }
