const { cmd } = require('../lib/plugins');
const { downloadAudio, removeDownloadedAudio } = require('../lib/safful-ytdlp');

function isYouTubeUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'youtu.be' || host.endsWith('.youtu.be') || host === 'youtube.com' || host.endsWith('.youtube.com');
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
  if (isYouTubeUrl(query)) return { url: query, title: 'Safful song' };

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
    await message.reply('🎵 Searching and preparing your audio...');
    const video = await findVideo(query);
    audio = await downloadAudio(video.url);
    await socket.sendMessage(message.chat, {
      audio: { url: audio.filePath },
      mimetype: audio.mimeType,
      fileName: `${safeFileName(video.title)}${require('path').extname(audio.filePath)}`,
      ptt: false,
    }, { quoted: message });
  } catch (error) {
    console.error('[song] download failed:', error.message || error);
    await message.reply('I could not download that audio right now. Please try another song or a direct YouTube link.');
  } finally {
    if (audio?.filePath) await removeDownloadedAudio(audio.filePath);
  }
});
