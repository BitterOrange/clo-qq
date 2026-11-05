// expect: bot-outside-channel
export function f(bot) { return bot.on('x', () => {}); }
