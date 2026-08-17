const { cmd } = require('../lib/plugins');
const { sleep } = require('../lib');

const REJOIN_DELAY_MS = 5 * 60 * 1000;

function isOwner(message, context) {
  if (context?.isCreator || message?.fromMe) return true;
  const owner = String(process.env.OWNER_NUMBER || global.owner || '').replace(/\D/g, '');
  return Boolean(owner && [
    message?.sender,
    message?.senderNum,
    message?.key?.participant,
    message?.key?.participantAlt,
    message?.fakeObj?.key?.participantAlt,
    context?.mek?.key?.participant,
    context?.mek?.key?.participantAlt,
  ].some((jid) => String(jid || '').replace(/\D/g, '') === owner));
}

function jidToNum(jid) {
  return String(jid || '').split('@')[0];
}

function mentionJids(message, context) {
  return message?.mention
    || message?.mentionedJid
    || message?.data?.message?.extendedTextMessage?.contextInfo?.mentionedJid
    || context?.mek?.message?.extendedTextMessage?.contextInfo?.mentionedJid
    || [];
}

cmd({
  pattern: 'tkick',
  desc: 'Kick a member and re-add them after 5 minutes',
  category: 'group',
  use: '<@mention|reply|number>',
}, async (message, text, context) => {
  if (!message.isGroup) return message.reply('This command can only be used in a group.');
  if (!isOwner(message, context) && !message.isAdmin) return message.reply('Only group admins or the bot owner can use this command.');

  // Bot must be an admin to kick.
  const group = await message.bot.groupMetadata(message.chat);
  const botIsAdmin = (group.participants || []).some(
    (participant) => participant.id === message.bot.user?.id && participant.admin,
  );
  if (!botIsAdmin) return message.reply('I am not an administrator in this group.');

  // Resolve the target: reply participant → mention → typed JID/number.
  let target = message.quoted?.key?.participant;
  if (!target) {
    const mentions = mentionJids(message, context);
    target = mentions[0];
  }
  if (!target && text) {
    const cleaned = String(text).trim();
    target = /^\d+$/.test(cleaned) ? `${cleaned}@s.whatsapp.net` : cleaned;
  }
  if (!target) return message.reply('Reply to a message, mention someone, or give a number.\nExample: *.tkick* on a reply');

  // Never kick an admin (or the bot itself).
  const targetParticipant = (group.participants || []).find((participant) => participant.id === target);
  if (!targetParticipant) return message.reply('That member is not in this group.');
  if (targetParticipant.admin) return message.reply(`❌ I cannot kick @${jidToNum(target)} — they are an administrator.`);
  if (target === message.bot.user?.id) return message.reply("I can't kick myself.");

  await message.reply(`@${jidToNum(target)} will be kicked and re-added in 5 minutes.`, { mentions: [target] });
  try {
    await message.kick(target);
    await sleep(REJOIN_DELAY_MS);
    await message.add(target);
    await message.reply(`@${jidToNum(target)} has been added back to the group.`, { mentions: [target] });
  } catch (error) {
    console.error('[tkick] failed:', error.message || error);
    await message.reply('Something went wrong while kicking/re-adding that member.');
  }
});
