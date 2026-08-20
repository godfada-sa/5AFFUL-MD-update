const { cmd } = require('../lib/plugins');
const QRCode = require('qrcode');

cmd({
  pattern: 'qr',
  alias: ['qrcode', 'generateqr'],
  desc: 'Generate a QR code from text or link',
  category: 'tools',
  use: '<text or link>',
}, async (message, text) => {
  const content = text || (message.quoted?.text) || '';
  if (!content) {
    return message.reply('Provide text or a link to generate a QR code.\nExample: `.qr https://google.com`');
  }

  try {
    const buffer = await QRCode.toBuffer(content, {
      type: 'png',
      width: 1024,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    });

    await message.bot.sendMessage(message.chat, {
      image: buffer,
      caption: `*QR Code Generated*\n\n*Content:* ${content}`,
    });
  } catch (error) {
    console.error('[qr] generation failed:', error.message || error);
    await message.reply('Failed to generate QR code. Text may be too long.');
  }
});
