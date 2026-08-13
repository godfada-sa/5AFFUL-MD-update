const { cmd } = require('../lib/plugins');
const attachProtection = require('../lib/safful-protection');
const { groupSettings, setGroupSettings, antiDeleteEnabled, setAntiDelete } = attachProtection;

const PROTECTIONS = {
  antispam: { key: 'antiSpam', label: 'Anti-spam', detail: 'Deletes the sixth message from a member within eight seconds.' },
  antilink: { key: 'antiLink', label: 'Anti-link', detail: 'Deletes messages containing web, WhatsApp, or wa.me links.' },
};

function isOwner(message, context) {
  if (context?.isCreator || message?.fromMe) return true;
  const owner = String(process.env.OWNER_NUMBER || global.owner || '').replace(/\D/g, '');
  const candidates = [
    message?.sender,
    message?.senderNum,
    message?.key?.participant,
    message?.key?.participantAlt,
    message?.fakeObj?.key?.participant,
    message?.fakeObj?.key?.participantAlt,
    context?.mek?.key?.participant,
    context?.mek?.key?.participantAlt,
  ];
  return Boolean(owner && candidates.some((jid) => String(jid || '').replace(/\D/g, '') === owner));
}

function stateText(settings) {
  return [
    '*Safful protection status*',
    `Anti-delete (all chats): ${antiDeleteEnabled() ? 'ON' : 'OFF'}`,
    `Anti-spam: ${settings.antiSpam ? 'ON' : 'OFF'}`,
    `Anti-link: ${settings.antiLink ? 'ON' : 'OFF'}`,
  ].join('\n');
}

async function manageProtection(message, text, context, commandName) {
  const protection = PROTECTIONS[commandName];
  if (!message.isGroup) return message.reply('This protection can only be managed in a group.');
  if (!message.isAdmin && !isOwner(message, context)) return message.reply('Only group admins or the bot owner can change protection settings.');

  const action = String(text || '').trim().toLowerCase();
  const current = groupSettings(message.chat);
  if (!action || ['status', 'get'].includes(action)) {
    return message.reply(`${stateText(current)}\n\n${protection.label}: ${protection.detail}\nUse *.${commandName} on* or *.${commandName} off*.`);
  }

  if (!['on', 'off'].includes(action)) return message.reply(`Use *.${commandName} on*, *.${commandName} off*, or *.${commandName} status*.`);

  const next = setGroupSettings(message.chat, { [protection.key]: action === 'on' });
  return message.reply(`*${protection.label} is now ${next[protection.key] ? 'ON' : 'OFF'}.*\n${protection.detail}`);
}

cmd({
  pattern: 'antidelete',
  alias: ['antidel', 'adel'],
  desc: 'Forward deleted messages from every chat to the sudo number',
  category: 'protection',
  use: '<on|off|status>',
}, async (message, text, context) => {
  attachProtection(context?.Void || message.bot);
  if (!isOwner(message, context)) return message.reply('Only the bot owner can control global anti-delete.');

  const action = String(text || '').trim().toLowerCase();
  if (!action || ['status', 'get'].includes(action)) {
    return message.reply(`*SAFFUL ANTI-DELETE*\nStatus: ${antiDeleteEnabled() ? 'ON' : 'OFF'}\nReports are sent privately to the configured sudo number.\n\nUse *.antidelete on* or *.antidelete off*.`);
  }
  if (!['on', 'off'].includes(action)) return message.reply('Use *.antidelete on*, *.antidelete off*, or *.antidelete status*.');

  const enabled = setAntiDelete(action === 'on');
  return message.reply(enabled
    ? '*Anti-delete is ON.* New deleted messages from any private or group chat will be reported to sudo.'
    : '*Anti-delete is OFF.* New messages will no longer be tracked.');
});

for (const [commandName, protection] of Object.entries(PROTECTIONS)) {
  cmd({
    pattern: commandName,
    desc: `Turn ${protection.label.toLowerCase()} on or off`,
    category: 'protection',
    use: '<on|off|status>',
  }, async (message, text, context) => manageProtection(message, text, context, commandName));
}

cmd({
  pattern: 'protection',
  alias: ['protect', 'security'],
  desc: 'Show group protection settings',
  category: 'protection',
}, async (message) => {
  if (!message.isGroup) return message.reply('This command can only be used in a group.');
  await message.reply(`${stateText(groupSettings(message.chat))}\n\nUse .antidelete, .antispam, or .antilink to change a setting.`);
});

cmd({
  on: 'text',
  dontAddCommandList: true,
}, async (message, text, context) => {
  attachProtection(context.Void || message.bot);
});
