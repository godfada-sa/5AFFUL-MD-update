const { cmd, commands } = require('../lib/plugins');
const protection = require('../lib/safful-protection');

// group.smd registers an older exact `.del` command after this plugin. It has
// its own hard-coded ownership check, so it rejects the configured owner
// before this Safful command can run. Retire only that conflicting registration
// once every plugin has been loaded.
setImmediate(() => {
  const legacyDel = commands.find((command) => command.pattern === 'del'
    && String(command.filename || '').toLowerCase().endsWith('group.smd'));
  if (!legacyDel) return;
  legacyDel.pattern = 'legacydel';
  legacyDel.alias = ['legacydelete', 'legacydlt'];
  legacyDel.dontAddCommandList = true;
  console.log('[delete] legacy .del command disabled');
});

function ownerNumber() {
  return String(process.env.OWNER_NUMBER || global.owner || '').replace(/\D/g, '');
}

function isOwner(message, context) {
  if (context?.isCreator || message?.fromMe) return true;
  const owner = ownerNumber();
  const candidates = [message?.sender, message?.senderNum, message?.chat, message?.key?.participantAlt, context?.mek?.key?.participantAlt]
    .map((value) => String(value || '').replace(/\D/g, ''));
  return Boolean(owner && candidates.some((value) => value === owner));
}

function findQuotedContext(content) {
  if (!content || typeof content !== 'object') return null;
  if (content.contextInfo?.stanzaId) return content.contextInfo;

  for (const value of Object.values(content)) {
    if (!value || typeof value !== 'object') continue;
    if (value.contextInfo?.stanzaId) return value.contextInfo;
    if (value.message) {
      const found = findQuotedContext(value.message);
      if (found) return found;
    }
  }
  return null;
}

cmd({
  pattern: 'delete',
  alias: ['del', 'dlt', 'remove'],
  desc: 'Delete a replied message (owner)',
  category: 'owner',
  use: '<reply to message>',
}, async (message, text, context) => {
  if (!isOwner(message, context)) {
    return message.reply('This command is restricted to the configured owner.');
  }

  const replied = message.quoted || message.reply_message;
  const quotedContext = findQuotedContext(context?.mek?.message || message.message);
  if (!replied && !quotedContext) return message.reply('Reply to the message you want to delete, then send *.delete*.');

  try {
    const savedKey = replied?.key || replied?.fakeObj?.key || message.quoted?.fakeObj?.key;
    const requestedId = quotedContext?.stanzaId || savedKey?.id;
    const receivedKey = protection.getCachedMessageKey(message.chat, requestedId);
    // Build the revoke key from the raw reply context. The serializer's
    // quoted.delete() helper can retain a stale chat id when WhatsApp maps a
    // person between their phone JID and LID, which deletes the command rather
    // than the message that was replied to.
    const target = {
      ...(savedKey || {}),
      ...(receivedKey || {}),
      remoteJid: receivedKey?.remoteJid || message.chat,
      id: requestedId,
      fromMe: Boolean(receivedKey?.fromMe ?? savedKey?.fromMe),
    };
    if (!target.id) return message.reply('I could not identify that replied message. Please reply to it directly and try again.');
    if (!target.participant && quotedContext?.participant) target.participant = quotedContext.participant;
    const socket = context?.Void || message.bot;
    await socket.sendMessage(message.chat, { delete: target });
    console.log('[delete] revoke requested', JSON.stringify({ chat: target.remoteJid, id: target.id, participant: target.participant, fromMe: target.fromMe }));
  } catch (error) {
    console.error('Delete command failed:', error.message || error);
    return message.reply('WhatsApp refused the deletion. In a group, make the connected Safful account an admin, then try again.');
  }
});
