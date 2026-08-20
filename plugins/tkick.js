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

// --- LID/PN-aware identity matching --------------------------------------
// Baileys 7 (and the newer WhatsApp-Web revisions) can address group members
// by LID (@lid) instead of the phone-number jid (@s.whatsapp.net). A group
// participant entry carries the id (either format) plus the other form in the
// `lid` and `phoneNumber` fields. The core's own `isBotAdmin` compares only
// `participant.id === botNumber` with the socket's PN jid, which fails in
// LID-addressed groups. So we compare every identity form on both sides.

function normJid(jid) {
  return String(jid || '')
    .replace(/:\d+@/g, '@')        // strip Baileys device suffix (…:22@ → …@)
    .replace(/@c\.us$/g, '@s.whatsapp.net'); // legacy server form
}

// Does any identity of set A equal any identity of set B?
// Each side is a list of jids; every non-empty normalized jid counts.
function sameIdentity(aJids, bJids) {
  const a = new Set();
  for (const j of aJids || []) {
    const n = normJid(j);
    if (n && n.includes('@')) a.add(n);
  }
  if (!a.size) return false;
  for (const j of bJids || []) {
    const n = normJid(j);
    if (n && n.includes('@') && a.has(n)) return true;
  }
  return false;
}

// Every jid the bot could be known by (socket user contact + core fields).
function botIdentities(message) {
  const user = message?.bot?.user || message?.bot?.authState?.creds?.me || {};
  return [
    user.id,
    user.lid,
    user.phoneNumber,
    message?.user,
    message?.botNumber,
    message?.bot?.decodeJid ? message.bot.decodeJid(user.id) : null,
  ].filter(Boolean);
}

// Every jid form a participant entry carries.
function participantIdentities(p) {
  return [p?.id, p?.lid, p?.phoneNumber].filter(Boolean);
}

function isBotAdminIn(participants, message) {
  const botIds = botIdentities(message);
  return participants.some((p) => p?.admin && sameIdentity(botIds, participantIdentities(p)));
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

  // Permission gate: owner/sudo always allowed; otherwise the SENDER must be a
  // group admin. We re-check the sender against the participants list with the
  // same LID/PN-aware matching instead of trusting the core's strict isAdmin.
  // The core already caches group metadata on the message; refresh only if missing.
  let participants = message?.metadata?.participants;
  if (!participants?.length) {
    try {
      const group = await message.bot.groupMetadata(message.chat);
      participants = group?.participants || [];
    } catch {}
  }

  const senderIsAdmin = isOwner(message, context)
    || participants.some((p) => p?.admin && sameIdentity([message.sender, message.key?.participant], participantIdentities(p)));
  if (!senderIsAdmin) return message.reply('Only group admins or the bot owner can use this command.');

  // Resolve the target first: reply participant → mention → typed JID/number.
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

  // The bot itself must be a group admin to kick — checked against the
  // participants using every identity form (id/lid/phoneNumber) so it works in
  // LID-addressed groups where the core's strict isBotAdmin fails. If metadata
  // is unavailable, fall back to the core's own field.
  const botIsAdmin = (participants?.length ? isBotAdminIn(participants, message) : false)
    || message.isBotAdmin === true;
  if (!botIsAdmin) return message.reply('I am not an administrator in this group.');

  const targetIds = [target, /^\d+$/.test(jidToNum(target)) ? target : null].filter(Boolean);

  // Never kick an admin (or the bot itself).
  const botIds = botIdentities(message);
  if (participants?.length && !participants.some((p) => sameIdentity(targetIds, participantIdentities(p)))) {
    return message.reply('That member is not in this group.');
  }
  if (participants.some((p) => p?.admin && sameIdentity(targetIds, participantIdentities(p)))) {
    return message.reply(`❌ I cannot kick @${jidToNum(target)} — they are an administrator.`);
  }
  if (sameIdentity(targetIds, botIds)) return message.reply("I can't kick myself.");

  // Capture EVERY identity form of the target while they are still a member:
  // the participant entry carries id (either LID or PN), plus the other form
  // in the `lid` / `phoneNumber` fields. The re-add below may reject one form
  // (WhatsApp's 'add' can refuse @lid jids), so we try them all.
  const memberEntry = participants.find((p) => sameIdentity(targetIds, participantIdentities(p)));
  const targetJids = [...new Set([
    target,
    ...[memberEntry?.id, memberEntry?.lid, memberEntry?.phoneNumber].filter(Boolean),
  ].filter(Boolean))];

  await message.reply(`@${jidToNum(target)} will be kicked and re-added in 5 minutes.`, { mentions: [target] });
  try {
    // The serialized message has no kick/add methods — those exist only on
    // group-event messages. Use the socket's groupParticipantsUpdate directly.
    // (smsg sets message.bot to the socket: `bot: _0x5eedaa ? sock : {}`.)
    const socket = message.bot;
    if (!socket?.groupParticipantsUpdate) throw new Error('No WhatsApp socket for groupParticipantsUpdate');
    await socket.groupParticipantsUpdate(message.chat, [target], 'remove');

    await sleep(REJOIN_DELAY_MS);

    // The socket captured at kick time may be stale if the bot reconnected
    // during the 5-minute wait — prefer the core's freshest socket.
    const liveSocket = (global.__saffulLatestSocket
      && typeof global.__saffulLatestSocket.groupParticipantsUpdate === 'function')
      ? global.__saffulLatestSocket
      : socket;
    if (!liveSocket?.groupParticipantsUpdate) throw new Error('No WhatsApp socket for groupParticipantsUpdate');

    // Try every identity form we captured; the first successful 'add' wins.
    let added = false;
    let lastError;
    for (const jid of targetJids) {
      try {
        await liveSocket.groupParticipantsUpdate(message.chat, [jid], 'add');
        added = true;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!added) throw lastError || new Error('Re-add failed for every identity form');

    await message.reply(`@${jidToNum(target)} has been added back to the group.`, { mentions: [target] });
  } catch (error) {
    console.error('[tkick] failed:', error.message || error);
    await message.reply('Something went wrong while kicking/re-adding that member.');
  }
});
