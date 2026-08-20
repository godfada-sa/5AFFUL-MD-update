const { cmd } = require('../lib/plugins');

function isOwner(message, context) {
  if (context?.isCreator || message?.fromMe) return true;
  const owner = String(process.env.OWNER_NUMBER || global.owner || '').replace(/\D/g, '');
  return owner && [
    message?.sender,
    message?.senderNum,
    message?.key?.participant,
    message?.key?.participantAlt,
    message?.fakeObj?.key?.participantAlt,
    context?.mek?.key?.participant,
    context?.mek?.key?.participantAlt,
  ].some((jid) => String(jid || '').replace(/\D/g, '') === owner);
}

cmd({
  pattern: 'all',
  desc: 'Mention every group member silently',
  category: 'group',
  use: '<message>',
}, async (message, text, context) => {
  if (!message.isGroup) return message.reply('This command can only be used in a group.');

  const group = await message.bot.groupMetadata(message.chat);
  const members = (group.participants || [])
    .map((participant) => participant.id)
    .filter((jid) => jid && jid !== message.bot.user?.id);

  if (!members.length) return message.reply('There are no members to mention.');

  const body = String(text || '').trim();

  if (message.quoted || (!body && message.isGroup)) {
    // Silent mode: reply to a message or bare .all — send empty mention block
    for (let index = 0; index < members.length; index += 100) {
      const batch = members.slice(index, index + 100);
      const mentions = batch.map((jid) => `@${jid.split('@')[0]}`).join(' ');
      const sentMsg = await message.bot.sendMessage(
        message.chat,
        { text: (index ? '...' : '\u200B') + '\n' + mentions, mentions: batch },
        { quoted: message.quoted || message },
      );
      // Flash fire emoji for 1 second then remove
      try {
        if (sentMsg && sentMsg.key) {
          await message.bot.sendMessage(message.chat, {
            react: { text: '🔥', key: sentMsg.key },
          });
          setTimeout(async () => {
            try {
              await message.bot.sendMessage(message.chat, {
                react: { text: '', key: sentMsg.key },
              });
            } catch {}
          }, 1000);
        }
      } catch {}
    }
  } else {
    // Normal mode: .all <message> — send the message with mentions
    for (let index = 0; index < members.length; index += 100) {
      const batch = members.slice(index, index + 100);
      const mentions = batch.map((jid) => `@${jid.split('@')[0]}`).join(' ');
      await message.bot.sendMessage(
        message.chat,
        { text: `${index ? '...' : body}\n\n${mentions}`, mentions: batch },
        { quoted: message },
      );
    }
  }
});
