const { cmd } = require('../lib/plugins');
const { downloadContentFromMessage, getContentType } = require('@whiskeysockets/baileys');

function ownerJid() {
  const number = String(process.env.SUDO || process.env.OWNER_NUMBER || global.sudo || global.owner || '').replace(/\D/g, '');
  return number ? `${number}@s.whatsapp.net` : null;
}

function isOwner(message, context) {
  if (context?.isCreator || message?.fromMe) return true;
  const owner = String(process.env.OWNER_NUMBER || global.owner || '').replace(/\D/g, '');
  const candidates = [
    message?.sender,
    message?.senderNum,
    message?.key?.participant,
    message?.key?.participantAlt,
    message?.fakeObj?.key?.participantAlt,
    context?.mek?.key?.participant,
    context?.mek?.key?.participantAlt,
  ];
  return Boolean(owner && candidates.some((jid) => String(jid || '').replace(/\D/g, '') === owner));
}

function findStatusContext(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);

  if (value.contextInfo?.remoteJid === 'status@broadcast' && value.contextInfo.quotedMessage) {
    return value.contextInfo;
  }

  for (const item of Object.values(value)) {
    const found = findStatusContext(item, seen);
    if (found) return found;
  }
  return null;
}

function unwrapMessage(content) {
  let current = content;
  let type = getContentType(current || {});
  while (['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'].includes(type)) {
    current = current?.[type]?.message;
    type = getContentType(current || {});
  }
  return { type, data: current?.[type], content: current };
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

cmd({
  pattern: 'save',
  alias: ['dlstatus', 'statusdl', 'swdl'],
  desc: 'Save a replied contact status privately',
  category: 'downloader',
  use: '<reply to a status>',
}, async (message, text, context) => {
  if (!isOwner(message, context)) return message.reply('Only the bot owner can save statuses.');

  const raw = context?.mek?.message || message.message || message.fakeObj?.message;
  const statusContext = findStatusContext(raw);
  const recipient = ownerJid();
  const socket = context?.Void || message.bot;

  if (!recipient || !socket?.sendMessage) return message.reply('Status saving is unavailable because the owner number is not configured.');
  if (!statusContext?.quotedMessage) {
    return message.reply('Reply to a contact status with *.save*.');
  }

  const quoted = unwrapMessage(statusContext.quotedMessage);
  try {
    if (quoted.type === 'conversation' || quoted.type === 'extendedTextMessage') {
      const statusText = quoted.content?.conversation || quoted.data?.text || '';
      if (!statusText) return socket.sendMessage(recipient, { text: '*SAFFUL STATUS SAVE*\nThis status has no downloadable text.' });
      await socket.sendMessage(recipient, { text: `*SAFFUL STATUS SAVE*\n\n${statusText}` });
      return;
    }

    const mediaKinds = {
      imageMessage: 'image',
      videoMessage: 'video',
      audioMessage: 'audio',
    };
    const kind = mediaKinds[quoted.type];
    if (!kind || !quoted.data) {
      return socket.sendMessage(recipient, { text: '*SAFFUL STATUS SAVE*\nThis status type cannot be saved.' });
    }

    const buffer = await streamToBuffer(await downloadContentFromMessage(quoted.data, kind));
    const content = kind === 'audio'
      ? { audio: buffer, mimetype: quoted.data.mimetype || 'audio/ogg', ptt: false }
      : { [kind]: buffer, caption: quoted.data.caption || '' };
    await socket.sendMessage(recipient, content);
    console.log('[save] status saved privately');
  } catch (error) {
    console.error('[save] status download failed:', error.message || error);
    await socket.sendMessage(recipient, { text: '*SAFFUL STATUS SAVE*\nFailed to download that status. Try again before it expires.' });
  }
});
