const { cmd } = require('../lib/plugins');
const { isOwner } = require('../lib/safful-mode');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const STORE_FILE = path.join(PROJECT_ROOT, 'lib', 'store.json');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPrivateJid(jid) {
  if (!jid || typeof jid !== 'string') return false;
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
}

// Best-effort list of private chats the bot recently interacted with, from the
// persisted store cache. Groups/newsletters/status are filtered out because
// groups are fetched fresh from the socket.
function recentPrivateChats() {
  try {
    const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    const keys = Object.keys(data?.messages || {});
    return keys.filter(isPrivateJid);
  } catch {
    return [];
  }
}

cmd({
  pattern: 'broadcast',
  alias: ['bc', 'bcast', 'broadcastall', 'bcall'],
  desc: 'Send a message to all groups and recent private chats',
  category: 'owner',
  use: '<message>',
}, async (message, text, context) => {
  if (!isOwner(message, context)) return message.reply('*Owner only.*');

  const content = String(text || '').trim();
  if (!content) {
    return message.reply('Usage: *.broadcast <message>*\nSends the message to every group the bot is in, plus recent private chats.');
  }

  const socket = context?.Void || message.bot;
  if (!socket?.sendMessage) return message.reply('The bot socket is not ready yet. Try again shortly.');

  await message.reply('📢 *Broadcasting...* please wait.');

  const targets = new Set();
  try {
    const groups = await socket.groupFetchAllParticipating();
    for (const jid of Object.keys(groups || {})) {
      if (isPrivateJid(jid) === false && jid.endsWith('@g.us')) targets.add(jid);
    }
  } catch (error) {
    console.error('[broadcast] group fetch failed:', error.message || error);
  }
  for (const jid of recentPrivateChats()) targets.add(jid);

  // Send the message exactly as typed — no banner, no emoji, no sender name.
  const caption = content;

  let sent = 0;
  let failed = 0;
  const errors = [];
  let index = 0;
  for (const jid of targets) {
    index += 1;
    let retries = 0;
    while (retries < 3) {
      try {
        await socket.sendMessage(jid, { text: caption });
        sent += 1;
        break;
      } catch (error) {
        retries += 1;
        if (retries >= 3) {
          failed += 1;
          if (errors.length < 5) errors.push(`${jid.slice(0, 15)}: ${String(error?.message || error).slice(0, 80)}`);
        } else {
          // Wait before retrying (exponential backoff: 1s, 2s)
          await sleep(retries * 1000);
        }
      }
    }
    // Breathing room every 10 sends to avoid WhatsApp rate limiting.
    if (index % 10 === 0) await sleep(1200);
  }

  const failedNote = failed
    ? `\nFailed: ${failed}${errors.length ? `\n${errors.join('\n')}` : ''}`
    : '';
  return message.reply(`✅ *Broadcast complete*\n\nTargets: ${targets.size}\nDelivered: ${sent}${failedNote}`);
});

module.exports = { PROJECT_ROOT, STORE_FILE, recentPrivateChats };
