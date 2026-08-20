const { cmd, commands } = require('../lib/plugins');
const { getMode, isOwner, setMode } = require('../lib/safful-mode');

const MODE_COMMANDS = new Set(['public', 'private']);

async function reply(message, text) {
  if (typeof message.reply === 'function') return message.reply(text);
  return message.bot?.sendMessage(message.chat, { text }, { quoted: message });
}

function registerModeCommand(mode) {
  cmd({
    pattern: mode,
    category: 'settings',
    desc: `Set Safful-MD to ${mode} mode. Owner only.`,
    filename: __filename,
  }, async (message, _text, context) => {
    if (!isOwner(message, context)) return;

    const previous = getMode();
    const active = setMode(mode);
    const scope = active === 'public'
      ? 'Anyone can now use Safful-MD commands in private chats and groups where the bot is enabled.'
      : 'Only the owner can now use Safful-MD commands.';

    await reply(
      message,
      `*SAFFUL-MD MODE*\n\nMode: *${active.toUpperCase()}*${previous === active ? ' (already active)' : ''}\n${scope}`,
    );
  });
}

// Safful's command engine reads WORKTYPE only at startup.  Wrapping the
// registered command handlers gives mode switches immediate effect and keeps
// the rule in one place for every normal command, including aliases.
setImmediate(() => {
  for (const command of commands) {
    if (!command?.pattern || MODE_COMMANDS.has(command.pattern) || command.__saffulModeGuard) continue;
    if (typeof command.function !== 'function') continue;

    const handler = command.function;
    command.function = async (message, text, context) => {
      if (getMode() === 'private' && !isOwner(message, context)) return;
      return handler(message, text, context);
    };
    command.__saffulModeGuard = true;
  }
  console.log(`[mode] Command access guard active (${getMode()} mode)`);
});

registerModeCommand('public');
registerModeCommand('private');
