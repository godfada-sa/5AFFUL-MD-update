const { cmd, commands } = require('../lib/plugins');
const { downloadContentFromMessage, getContentType } = require('@whiskeysockets/baileys');
const { createCanvas, loadImage } = require('canvas');
const fs = require('fs');
const path = require('path');
const Config = require('../config');
const { isOwner } = require('../lib/safful-mode');

const MENU_IMAGE = path.join(__dirname, '..', 'lib', 'assets', 'safful-menu.jpg');
const MENU_WIDTH = 1440;
const MENU_COLUMNS = 3;
const PREFERRED_CATEGORIES = ['GENERAL', 'PROTECTION', 'GROUP', 'MEDIA', 'DOWNLOADER', 'CONVERTER', 'STICKER', 'TOOLS', 'FUN', 'OWNER'];

async function toBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function formatUptime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m ${Math.floor(seconds % 60)}s`;
}

function displayCategory(category) {
  const names = {
    ANIME: 'ANIME PICS',
    ANIMEPICS: 'ANIME PICS',
    DOWNLOADER: 'DOWNLOADERS',
    CONVERTER: 'CONVERTERS',
    STICKER: 'STICKERS',
    GENERAL: 'GENERAL',
    PROTECTION: 'PROTECTION',
  };
  return names[category] || category.replace(/_/g, ' ');
}

function orderedCommandGroups(registered) {
  const groups = new Map();
  for (const command of registered) {
    const category = String(command.category || command.type || 'general').toUpperCase();
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(command.pattern);
  }

  return [...groups.entries()]
    .map(([category, names]) => [category, names.sort((left, right) => left.localeCompare(right))])
    .sort(([left], [right]) => {
      const leftIndex = PREFERRED_CATEGORIES.indexOf(left);
      const rightIndex = PREFERRED_CATEGORIES.indexOf(right);
      return (leftIndex === -1 ? PREFERRED_CATEGORIES.length : leftIndex) - (rightIndex === -1 ? PREFERRED_CATEGORIES.length : rightIndex)
        || left.localeCompare(right);
    });
}

function distributeMenuGroups(groups) {
  const columns = Array.from({ length: MENU_COLUMNS }, () => ({ groups: [], height: 0 }));
  for (const group of groups) {
    const height = 58 + (group[1].length * 31) + 24;
    const column = columns.reduce((shortest, candidate) => (
      candidate.height < shortest.height ? candidate : shortest
    ));
    column.groups.push(group);
    column.height += height;
  }
  return columns;
}

function roundRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

async function renderMenuImage({ groups, commandCount, prefix }) {
  const columns = distributeMenuGroups(groups);
  const headerHeight = 380;
  const contentHeight = Math.max(...columns.map((column) => column.height));
  const height = Math.max(1080, headerHeight + contentHeight + 120);
  const canvas = createCanvas(MENU_WIDTH, height);
  const context = canvas.getContext('2d');
  const columnWidth = (MENU_WIDTH - 128 - ((MENU_COLUMNS - 1) * 26)) / MENU_COLUMNS;
  const now = new Date();

  const background = context.createLinearGradient(0, 0, MENU_WIDTH, height);
  background.addColorStop(0, '#071522');
  background.addColorStop(0.54, '#0c2236');
  background.addColorStop(1, '#06111c');
  context.fillStyle = background;
  context.fillRect(0, 0, MENU_WIDTH, height);

  context.fillStyle = '#0e2c42';
  context.fillRect(0, headerHeight - 10, MENU_WIDTH, 10);
  context.fillStyle = '#2dc7f1';
  context.fillRect(0, headerHeight - 10, MENU_WIDTH * 0.36, 10);

  roundRect(context, 64, 56, 246, 246, 28);
  context.fillStyle = '#07111a';
  context.fill();
  if (fs.existsSync(MENU_IMAGE)) {
    try {
      const logo = await loadImage(MENU_IMAGE);
      context.save();
      roundRect(context, 64, 56, 246, 246, 28);
      context.clip();
      context.drawImage(logo, 64, 56, 246, 246);
      context.restore();
    } catch (error) {
      console.error('[menu] logo render failed:', error.message || error);
    }
  }

  context.fillStyle = '#f7fbff';
  context.font = 'bold 58px sans-serif';
  context.fillText('SAFFUL-MD', 350, 120);
  context.fillStyle = '#48d4ff';
  context.font = 'bold 23px sans-serif';
  context.fillText('COMMAND DIRECTORY', 354, 160);
  context.fillStyle = '#cad9e6';
  context.font = '24px sans-serif';
  context.fillText(`Owner: ${Config.ownername || 'Safful'}   |   Prefix: ${prefix}`, 354, 214);
  context.fillText(`${commandCount} commands   |   Uptime: ${formatUptime(process.uptime())}`, 354, 252);
  context.fillText(`Memory: ${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)} MB   |   ${now.toLocaleString()}`, 354, 290);
  context.fillStyle = '#86a7bc';
  context.font = '20px sans-serif';
  context.fillText(`Use ${prefix}menu <command> to view command details.`, 354, 328);

  columns.forEach((column, index) => {
    const x = 64 + (index * (columnWidth + 26));
    let y = headerHeight + 46;

    for (const [category, names] of column.groups) {
      roundRect(context, x, y, columnWidth, 42, 12);
      context.fillStyle = '#153c55';
      context.fill();
      context.fillStyle = '#8ee7ff';
      context.font = 'bold 20px sans-serif';
      context.fillText(displayCategory(category), x + 18, y + 28);
      y += 54;

      context.fillStyle = '#e9f5fc';
      context.font = '21px monospace';
      for (const commandName of names) {
        context.fillText(`- ${prefix}${commandName}`, x + 18, y + 22);
        y += 31;
      }
      y += 24;
    }
  });

  return canvas.toBuffer('image/jpeg', { quality: 0.86, progressive: true });
}

function getQuotedViewOnce(message) {
  const quotedMessage = message.message?.extendedTextMessage?.contextInfo?.quotedMessage
    || message.quoted?.fakeObj?.message;
  if (!quotedMessage) return null;

  let content = quotedMessage;
  let type = getContentType(content);
  while (['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'].includes(type)) {
    content = content[type]?.message;
    type = getContentType(content || {});
  }

  const media = content?.[type];
  return media?.viewOnce && (type === 'imageMessage' || type === 'videoMessage')
    ? { type, media }
    : null;
}

cmd({
  pattern: 'menu',
  alias: ['help', 'commands', 'list'],
  desc: 'Show available commands',
  category: 'general',
}, async (message, text, context) => {
  const prefix = global.prefix || '.';
  const query = String(text || context?.text || '').trim().toLowerCase();
  const registered = commands.filter((command) => command.pattern);

  if (query) {
    const command = registered.find((item) => item.pattern?.toLowerCase() === query)
      || registered.find((item) => item.alias?.map((name) => String(name).toLowerCase()).includes(query));
    if (!command) return message.reply(`Command *${query}* was not found. Use *${prefix}menu* to see all commands.`);

    const aliases = command.alias?.length ? command.alias.map((name) => `${prefix}${name}`).join(', ') : 'None';
    return message.reply(
      `*${Config.botname} - Command info*\n\n`
      + `Command: *${prefix}${command.pattern}*\n`
      + `Description: ${command.desc || command.info || 'No description available'}\n`
      + `Category: ${command.category || command.type || 'general'}\n`
      + `Aliases: ${aliases}`,
    );
  }

  try {
    const image = await renderMenuImage({
      groups: orderedCommandGroups(registered),
      commandCount: registered.length,
      prefix,
    });
    await message.bot.sendMessage(
      message.chat,
      { image, caption: `*${Config.botname} Command Menu*` },
      { quoted: message },
    );
  } catch (error) {
    console.error('[menu] render failed:', error);
    await message.reply('The menu image could not be created. Please try again.');
  }
});

function privateRecipient() {
  const number = String(process.env.SUDO || global.sudo || process.env.OWNER_NUMBER || global.owner || '').replace(/\D/g, '');
  return number ? `${number}@s.whatsapp.net` : null;
}

async function deliverViewOnce(message, quoted, recipient, download = downloadContentFromMessage) {
  const kind = quoted.type === 'imageMessage' ? 'image' : 'video';
  const buffer = await toBuffer(await download(quoted.media, kind));
  await message.bot.sendMessage(
    recipient,
    { [kind]: buffer, caption: quoted.media.caption || 'Saved with Safful-MD .kk' },
  );
}

cmd({
  pattern: 'kk',
  desc: 'Save a replied view-once image or video to the owner private chat',
  category: 'media',
}, async (message, _text, context) => {
  if (!isOwner(message, context)) return;

  const quoted = getQuotedViewOnce(message);
  if (!quoted) return message.reply('Reply to a view-once image or video with *.kk*.');

  const recipient = privateRecipient();
  if (!recipient) return message.reply('No SUDO or owner number is configured for private delivery.');

  try {
    await deliverViewOnce(message, quoted, recipient);
  } catch (error) {
    console.error('View-once download failed:', error);
    await message.reply('I could not retrieve that view-once media. Please try again soon after receiving it.');
  }
});

module.exports = { getQuotedViewOnce, privateRecipient, deliverViewOnce, orderedCommandGroups, renderMenuImage };
