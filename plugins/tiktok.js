const { cmd } = require('../lib/plugins');
const { smdJson } = require('../lib');
const Config = require('../config');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// TikWM (https://www.tikwm.com) is the current reliable no-watermark TikTok
// downloader: video posts return data.play (no watermark), data.hdplay (HD) and
// data.music (audio); photo / slideshow posts return data.images (array of image
// URLs). The legacy handler in downloader.smd was hardcoded to the suspended
// api-smd.onrender.com host, so this plugin replaces it. The old names
// (tiktokold/ttold/ttdlold) are pruned at startup.
//
// Modes: default (video), `mp3` (audio), `doc` (document), and `save`
// (download the media to the bot's media/ folder, owner only).

const TIKWM_ENDPOINT = 'https://www.tikwm.com/api/?url=';

function isValidTiktokUrl(value) {
  return /tiktok/i.test(String(value || ''));
}

function pickVideoUrl(data) {
  // hdplay is only present when hd=1 succeeds; play is always the clean URL.
  return data?.hdplay || data?.play || data?.wmplay || null;
}

function photoImages(data) {
  return Array.isArray(data?.images) ? data.images.filter(Boolean) : [];
}

function isOwner(message, context) {
  if (context?.isCreator || message?.fromMe) return true;
  const owner = String(process.env.OWNER_NUMBER || global.owner || global.sudo || '').replace(/\D/g, '');
  const candidates = [
    message?.sender,
    message?.senderNum,
    message?.key?.participant,
    message?.fakeObj?.key?.participantAlt,
    context?.mek?.key?.participant,
  ];
  return Boolean(owner && candidates.some((jid) => String(jid || '').replace(/\D/g, '') === owner));
}

// media/ folder lives next to the repo root (one level above plugins/).
function mediaDir() {
  return path.join(__dirname, '..', 'media');
}

async function downloadToFile(url, dest) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 60000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Referer': 'https://www.tiktok.com/',
    },
  });
  fs.writeFileSync(dest, Buffer.from(response.data));
  return fs.statSync(dest).size;
}

function relativeName(fullPath) {
  return path.relative(path.join(__dirname, '..'), fullPath).split(path.sep).join('/');
}

// Photo / slideshow post: WhatsApp can't receive a multi-image album in one
// send, so send every slide individually. Caption only the first one so the
// group chat doesn't get spammed with repeats.
async function sendPhotoPost(message, data, type, caption) {
  const images = photoImages(data);
  if (!images.length) return false;

  const max = 10;
  const shown = images.slice(0, max);
  for (let i = 0; i < shown.length; i++) {
    if (type === 'document') {
      await message.bot.sendMessage(message.chat, {
        document: { url: shown[i] },
        fileName: `tiktok_photo_${i + 1}.jpg`,
        mimetype: 'image/jpeg',
        caption: i === 0 ? caption : '',
      }, { quoted: message });
    } else {
      await message.send(shown[i], { caption: i === 0 ? caption : '' }, 'image', message);
    }
  }
  if (images.length > max) {
    await message.reply(`*_${images.length} images_* — sending the first ${max}.`);
  }
  return true;
}

// save mode: download the media into media/ and reply with where it went.
async function saveMedia(message, data, type) {
  const dir = mediaDir();
  fs.mkdirSync(dir, { recursive: true });
  const base = String(data.id || Date.now());

  // Photo / slideshow post — save every slide.
  const images = photoImages(data);
  if (images.length) {
    const saved = [];
    for (let i = 0; i < images.length; i++) {
      const dest = path.join(dir, `tiktok_${base}_${i + 1}.jpg`);
      await downloadToFile(images[i], dest);
      saved.push(relativeName(dest));
    }
    const list = saved.slice(0, 3).map((f) => `\`${f}\``).join('\n');
    const more = saved.length > 3 ? `\n+${saved.length - 3} more` : '';
    return message.reply(`*Saved ${saved.length} image${saved.length === 1 ? '' : 's'} to \`media/\`*\n${list}${more}`);
  }

  const videoUrl = pickVideoUrl(data);
  if (!videoUrl) return message.reply('Error While Downloading Your Video');

  if (type === 'audio' && data.music) {
    const dest = path.join(dir, `tiktok_${base}.mp3`);
    await downloadToFile(data.music, dest);
    return message.reply(`*Saved audio to \`media/\`*\n\`${relativeName(dest)}\``);
  }

  const dest = path.join(dir, `tiktok_${base}.mp4`);
  await downloadToFile(videoUrl, dest);
  return message.reply(`*Saved video to \`media/\`*\n\`${relativeName(dest)}\``);
}

cmd({
  pattern: 'tiktok',
  alias: ['tt', 'ttdl'],
  desc: 'Downloads Tiktok Videos/Images Via Url.',
  category: 'downloader',
  filename: __filename,
  use: '<add tiktok url.>',
}, async (message, input, context) => {
  try {
    const raw = String(input || '');
    const isSave = raw.toLowerCase().includes('save');
    const type = raw.toLowerCase().includes('doc') ? 'document'
      : raw.toLowerCase().includes('mp3') ? 'audio' : 'video';

    if (!input) {
      return message.reply(`*Uhh Please, Provide me tiktok Video/Image Url*\n*_Ex ${(global.prefix || '.')}tiktok https://www.tiktok.com/@dakwahmuezza/video/7150544062221749531_*`);
    }

    const url = raw.trim().split(/\s+/)[0];
    if (!isValidTiktokUrl(url)) {
      return message.reply('*Uhh Please, Give me Valid Tiktok Url!*');
    }

    if (isSave && !isOwner(message, context)) {
      return message.reply('Only the bot owner can save media.');
    }

    let response = null;
    try {
      response = await smdJson(TIKWM_ENDPOINT + encodeURIComponent(url) + '&hd=1');
    } catch {
      try {
        response = await smdJson(TIKWM_ENDPOINT + encodeURIComponent(url));
      } catch {
        response = null;
      }
    }

    if (!response || response.code !== 0 || !response.data) {
      return message.reply('Error While Downloading Your Video');
    }

    const data = response.data;
    const title = String(data.title || data.content_desc || '').trim();
    const author = String(data.author?.unique_id || data.author?.nickname || '').trim();
    const caption = [title ? `*${title.slice(0, 100)}*` : '', author ? `_@${author.slice(0, 40)}_` : '', Config.caption]
      .filter(Boolean).join('\n');

    if (isSave) {
      return await saveMedia(message, data, type);
    }

    // Photo / slideshow post — images instead of a video.
    if (photoImages(data).length) {
      const sent = await sendPhotoPost(message, data, type, caption);
      if (!sent) return message.reply('Error While Downloading Your Video');
      return true;
    }

    const videoUrl = pickVideoUrl(data);
    if (!videoUrl) return message.reply('Error While Downloading Your Video');

    if (type === 'document') {
      // message.send has no document case, so use the raw socket.
      return message.bot.sendMessage(message.chat, {
        document: { url: videoUrl },
        fileName: `tiktok_${data.id || Date.now()}.mp4`,
        mimetype: 'video/mp4',
        caption,
      }, { quoted: message });
    }

    const mediaUrl = type === 'audio' && data.music ? data.music : videoUrl;
    return message.send(mediaUrl, { caption }, type, message);
  } catch (error) {
    console.error('[tiktok] error:', error?.message || error);
    return message.error(`${error?.message || error}\n\ncommand: tiktok`, error);
  }
});
