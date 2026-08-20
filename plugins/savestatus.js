const { cmd } = require('../lib/plugins');
const statusSave = require('../lib/safful-status-save');

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
  ]
    .some((jid) => String(jid || '').replace(/\D/g, '') === owner);
}

cmd({
  pattern: 'savestatus',
  alias: ['statussave'],
  desc: 'Save received WhatsApp statuses to sudo',
  category: 'settings',
  use: '<on|off|status>',
}, async (message, text, context) => {
  if (!isOwner(message, context)) return message.reply('Only the bot owner can manage status saving.');
  statusSave.attach(context.Void || message.bot);

  const action = String(text || '').trim().toLowerCase();
  if (!action || ['status', 'get'].includes(action)) {
    return message.reply(`Status saving is ${statusSave.getEnabled() ? '*ON*' : '*OFF*'}.\nUse *.savestatus on* or *.savestatus off*.`);
  }
  if (!['on', 'off'].includes(action)) return message.reply('Use *.savestatus on*, *.savestatus off*, or *.savestatus status*.');
  const enabled = statusSave.setEnabled(action === 'on');
  return message.reply(enabled
    ? '*Status saving is ON.* New statuses will be copied privately to sudo.'
    : '*Status saving is OFF.*');
});
