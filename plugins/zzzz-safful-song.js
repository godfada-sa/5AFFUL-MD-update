const { cmd } = require('../lib/plugins');
const { downloadAudio, removeDownloadedAudio } = require('../lib/safful-ytdlp');

function isYouTubeUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'youtu.be' || host.endsWith('.youtu.be')
      || host === 'youtube.com' || host.endsWith('.youtube.com');
  } catch {
    return false;
  }
}

function safeFileName(value) {
  return String(value || 'Safful song')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'Safful song';
}

async function findVideo(query) {
  if (isYouTubeUrl(query)) return { url: query, title: 'Your requested audio' };

  const search = require('secktor-pack');
  const result = await search.search(query);
  const video = (result?.all || []).find((item) => item?.type === 'video' && item?.url);
  if (!video) throw new Error('No YouTube result was found for that song.');
  return { url: video.url, title: video.title || query };
}

cmd({
  pattern: 'song',
  alias: ['audio', 'music', 'mp3'],
  desc: 'Search and download a song as audio',
  category: 'downloader',
  use: '<song name or YouTube link>',
}, async (message, text, context) => {
  const query = String(text || '').trim();
  if (!query) return message.reply('Usage: *.song <song name or YouTube link>*');

  const socket = context?.Void || message.bot;
  let audio;
  try {
    await message.reply('🎵 *Searching...*');
    const video = await findVideo(query);
    await message.reply(`🎧 *Preparing audio...*\n_${safeFileName(video.title)}_`);

    audio = await downloadAudio(video.url);
    await socket.sendMessage(message.chat, {
      audio: { url: audio.filePath },
      mimetype: audio.mimeType,
      fileName: `${safeFileName(video.title)}${require('path').extname(audio.filePath)}`,
      ptt: false,
    }, { quoted: message });
  } catch (error) {
    console.error('[song] download failed:', error.message || error);
    if (error?.message?.includes('too large')) {
      await message.reply(error.message);
    } else {
      const reason = String(error?.message || error || 'unknown error').slice(0, 220);
      const isBotCheck = /not a bot|Sign in to confirm|bot[ -]?check|LOGINREQUIRED|unavailable for this IP/i.test(reason);
      if (isBotCheck) {
        await message.reply(`❌ *Download failed.*\n\n_${reason}_\n\nYour server IP is flagged by YouTube (datacenter IPs often are). The bot retried with every player client — if all of them are blocked, no free method works from this IP. Try: a different host/VPS, or point SAFFUL_YTDLP_PATH at yt-dlp with cookies for a residential account.`);
      } else {
        await message.reply(`❌ *Download failed.*\n\n_${reason}_\n\nTry another song or a direct YouTube link. If this keeps happening, the server IP may be blocked by YouTube — try a different host.`);
      }
    }
  } finally {
    if (audio?.filePath) await removeDownloadedAudio(audio.filePath);
  }
});
