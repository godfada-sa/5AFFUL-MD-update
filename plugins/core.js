const { cmd } = require('../lib/plugins');
const Config = require('../config');

function formatUptime(seconds) {
  const units = [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]];
  let remaining = Math.floor(seconds);

  return units
    .map(([label, size]) => {
      const value = Math.floor(remaining / size);
      remaining %= size;
      return value ? `${value}${label}` : '';
    })
    .filter(Boolean)
    .join(' ') || '0s';
}

cmd({
  pattern: 'alive',
  alias: ['status', 'bot'],
  desc: 'Show whether the bot is online',
  category: 'general',
}, async (message) => {
  await message.reply(
    `*${Config.botname} is online*\n\n` +
    `Uptime: ${formatUptime(process.uptime())}\n` +
    `Prefix: ${global.prefix || '.'}`,
  );
});

cmd({
  pattern: 'uptime',
  alias: ['runtime'],
  desc: 'Show the bot running time',
  category: 'general',
}, async (message) => {
  await message.reply(`*${Config.botname} uptime:* ${formatUptime(process.uptime())}`);
});

cmd({
  pattern: 'ping',
  alias: ['speed'],
  desc: 'Check bot response time',
  category: 'general',
}, async (message) => {
  const started = Date.now();
  await message.reply(`*Pong!* ${Date.now() - started} ms`);
});
