const { cmd } = require('../lib/plugins');
const { smdJson } = require('../lib');
const Config = require('../config');

// X/Twitter media downloader backed by the free fxtwitter API (vxtwitter as a
// fallback host). Video tweets come back with one best-quality mp4 in
// media.videos[].url; photo tweets come back as media.photos[] entries that are
// objects carrying a .url field.

const FX_ENDPOINT = 'https://api.fxtwitter.com';
const VX_ENDPOINT = 'https://api.vxtwitter.com';

function parseTweetUrl(value) {
  const match = String(value || '').match(/x\.com|twitter\.com/i)
    ? String(value).match(/(?:x\.com|twitter\.com|mobile\.twitter\.com)\/([^\/?#]+)\/status\/(\d+)/i)
    : null;
  if (!match) return null;
  return { user: match[1].replace(/^@/, ''), id: match[2] };
}

function isUrl(value) {
  return typeof value === 'string' && /^https?:\/\//.test(value);
}

function mediaUrl(entry) {
  if (typeof entry === 'string') return entry;
  return isUrl(entry?.url) ? entry.url : null;
}

cmd({
  pattern: 'x',
  alias: ['twitter', 'twt', 'twtdl', 'xtwitter'],
  desc: 'Downloads X/Twitter Videos & Images Via Url.',
  category: 'downloader',
  filename: __filename,
  use: '<add x/twitter url.>',
}, async (message, input) => {
  try {
    if (!input) {
      return message.reply(`*Uhh Please, Provide me X/Twitter Url*\n*_Ex ${(global.prefix || '.')}x https://x.com/KidRock/status/2037987671671292134_*`);
    }

    const url = String(input).trim().split(/\s+/)[0];
    const parsed = parseTweetUrl(url);
    if (!parsed) {
      return message.reply('*Uhh Please, Give me Valid X/Twitter Url!*');
    }

    let json = null;
    for (const endpoint of [FX_ENDPOINT, VX_ENDPOINT]) {
      try {
        const response = await smdJson(`${endpoint}/${parsed.user}/status/${parsed.id}`);
        if (response?.code === 200 && response?.tweet) {
          json = response;
          break;
        }
      } catch {
        // try the next host
      }
    }

    if (!json || !json.tweet) {
      return message.reply('*Tweet not found. It may be private, deleted, or the account is suspended.*');
    }

    const tweet = json.tweet;
    const photos = (tweet.media?.photos || []).map(mediaUrl).filter(Boolean);
    const videos = (tweet.media?.videos || []).map(mediaUrl).filter(Boolean);
    const video = videos[0] || null;

    const author = String(tweet.author?.screen_name || tweet.author?.name || '').trim();
    const text = String(tweet.text || '').trim();
    const caption = [text ? `*${text.slice(0, 120)}*` : '', author ? `_@${author.slice(0, 40)}_` : '', Config.caption]
      .filter(Boolean).join('\n');

    if (video) {
      return message.send(video, { caption }, 'video', message);
    }

    if (photos.length) {
      for (let i = 0; i < photos.length; i++) {
        await message.send(photos[i], { caption: i === 0 ? caption : '' }, 'image', message);
      }
      return true;
    }

    return message.reply('*No media found in this tweet.*');
  } catch (error) {
    console.error('[x] error:', error?.message || error);
    return message.error(`${error?.message || error}\n\ncommand: x`, error);
  }
});
