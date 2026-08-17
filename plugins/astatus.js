const { cmd } = require('../lib/plugins');
const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, '..', 'lib', 'safful-astatus.json');
// Reply words that trigger the status forward (matches the original gist).
const TRIGGERS = /\b(?:send|snd|sent|snt|ayak|sd|st|ayakko|cent|cnt|cend)\b/i;

function readEnabled() {
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (typeof saved.enabled === 'boolean') return saved.enabled;
  } catch {}
  // Default ON: works out of the box; disable with .astatus off
  return true;
}

function saveEnabled(value) {
  fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify({ enabled: value }, null, 2)}\n`, 'utf8');
}

let enabled = readEnabled();

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

cmd({
  pattern: 'astatus',
  alias: ['autostatus', 'statusreply'],
  desc: 'Auto-forward a status to anyone who replies to it with send/snd/sent',
  category: 'status',
  use: '<on|off|status>',
}, async (message, text, context) => {
  if (!isOwner(message, context)) return message.reply('Only the bot owner can control auto status replies.');

  const action = String(text || '').trim().toLowerCase();
  if (!action || ['status', 'get'].includes(action)) {
    return message.reply(`*AUTO STATUS REPLY*\nStatus: ${enabled ? 'ON' : 'OFF'}\nWhen someone replies to one of your statuses with *send / snd / sent*, the bot sends them that status.\n\nUse *.astatus on* or *.astatus off*.`);
  }
  if (!['on', 'off'].includes(action)) return message.reply('Use *.astatus on*, *.astatus off*, or *.astatus status*.');

  enabled = action === 'on';
  saveEnabled(enabled);
  return message.reply(enabled
    ? '*Auto status reply is ON.* Reply "send" to any of your statuses to receive it.'
    : '*Auto status reply is OFF.* Statuses will no longer be forwarded on request.');
});

// Event listener: any incoming text message that replies to a status broadcast
// in a private chat with a trigger word gets the status forwarded back.
cmd({
  on: 'text',
  dontAddCommandList: true,
}, async (message, text, context) => {
  if (!enabled) return;
  if (message?.fromMe || message?.isGroup) return;

  const quoted = message?.quoted;
  const remoteJid = quoted?.key?.remoteJid
    || message?.data?.reply_message?.key?.remoteJid
    || '';
  if (remoteJid !== 'status@broadcast') return;

  const body = String(text || '').trim();
  if (!TRIGGERS.test(body)) return;

  try {
    // forwardMessage() defaults to forwarding the quoted status to this chat.
    await message.forwardMessage();
  } catch (error) {
    console.error('[astatus] forward failed:', error.message || error);
  }
});

module.exports = { getEnabled: () => enabled };
