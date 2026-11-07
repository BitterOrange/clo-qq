// expect: bot-outside-channel as: lib/core/exit.js
export function f(bot) { return bot.api.post('/v2/groups/x/messages', {}); }
