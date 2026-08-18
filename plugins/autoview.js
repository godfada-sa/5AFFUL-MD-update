const { cmd } = require('../lib/plugins');
const autoView = require('./statusauto.smd');

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

cmd({
  pattern: 'autoview',
  alias: ['statusview'],
  desc: 'Set automatic status-view receipts from 0 to 10 minutes',
  category: 'settings',
  use: '<0-10>',
}, async (message, text, context) => {
  autoView.attach(context.Void || message.bot);
  if (!isOwner(message, context)) return message.reply('Only the bot owner can change auto-view.');

  const input = String(text || '').trim();
  if (!input || ['status', 'get'].includes(input.toLowerCase())) {
    const current = autoView.getMinutes();
    return message.reply(current
      ? `Auto-view is ON. Statuses are marked viewed every *${current} minute(s)*.\nUse *.autoview 0* to disable it.`
      : 'Auto-view is OFF. Use *.autoview 1* through *.autoview 10* to enable it.');
  }

  if (!/^\d+$/.test(input) || Number(input) > 10) {
    return message.reply('Use *.autoview 0* to disable, or a whole number from *1* to *10* minutes.');
  }

  const minutes = autoView.setMinutes(Number(input));
  return message.reply(minutes
    ? `Auto-view is ON. New status receipts will be sent every *${minutes} minute(s)*.`
    : 'Auto-view is OFF. Pending statuses will not be marked viewed.');
});
