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
  pattern: 'tagnotadmin',
  alias: ['tagmembers', 'tagallmembers'],
  desc: 'Mention every group member except admins',
  category: 'group',
  use: '<message>',
}, async (message, text, context) => {
  if (!message.isGroup) return message.reply('This command can only be used in a group.');
  if (!message.isAdmin && !isOwner(message, context)) return message.reply('Only group admins or the bot owner can use this command.');

  const group = await message.bot.groupMetadata(message.chat);
  const members = (group.participants || [])
    .filter((participant) => !participant.admin)
    .map((participant) => participant.id)
    .filter((jid) => jid && jid !== message.bot.user?.id);

  if (!members.length) return message.reply('There are no non-admin members to mention.');

  const body = String(text || '').trim() || 'Hello everyone';
  for (let index = 0; index < members.length; index += 100) {
    const batch = members.slice(index, index + 100);
    const mentions = batch.map((jid) => `@${jid.split('@')[0]}`).join(' ');
    await message.bot.sendMessage(
      message.chat,
      { text: `${index ? 'Continued:' : body}\n\n${mentions}`, mentions: batch },
      { quoted: message },
    );
  }
});
