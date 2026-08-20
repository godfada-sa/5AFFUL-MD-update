const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const fetch = require('node-fetch');

const PROJECT_ROOT = path.join(__dirname, '..');
const TOOL_DIRECTORY = path.join(PROJECT_ROOT, '.safful-tools');
const DOWNLOAD_DIRECTORY = path.join(PROJECT_ROOT, 'temp', 'safful-song');
const BINARY_NAME = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const DEFAULT_BINARY = path.join(TOOL_DIRECTORY, BINARY_NAME);
const MAX_FILE_SIZE = 50 * 1024 * 1024;

let binaryPromise;

function configuredBinary() {
  const configured = String(process.env.SAFFUL_YTDLP_PATH || '').trim();
  return configured || DEFAULT_BINARY;
}

function ytdlpDownloadUrl() {
  return `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${BINARY_NAME}`;
}

async function downloadBinary(binary) {
  await fs.promises.mkdir(path.dirname(binary), { recursive: true });
  const partial = `${binary}.${process.pid}.download`;

  try {
    const response = await fetch(ytdlpDownloadUrl(), { timeout: 120000 });
    if (!response.ok || !response.body) {
      throw new Error(`yt-dlp download failed (${response.status})`);
    }
    await pipeline(response.body, fs.createWriteStream(partial));
    await fs.promises.rename(partial, binary);
    if (process.platform !== 'win32') await fs.promises.chmod(binary, 0o755);
  } catch (error) {
    await fs.promises.unlink(partial).catch(() => undefined);
    throw error;
  }
}

async function ensureBinary() {
  const binary = configuredBinary();
  if (fs.existsSync(binary)) return binary;

  if (binary !== DEFAULT_BINARY) {
    throw new Error('The SAFFUL_YTDLP_PATH file was not found. Remove that setting or point it to yt-dlp.');
  }

  if (!binaryPromise) {
    binaryPromise = downloadBinary(binary).then(() => binary).catch((error) => {
      binaryPromise = undefined;
      throw error;
    });
  }
  return binaryPromise;
}

function run(binary, args, timeout = 90000) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { windowsHide: true, timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const reason = String(stderr || error.message || 'yt-dlp failed').trim();
        reject(new Error(reason));
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

function mimeFor(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.mp3': return 'audio/mpeg';
    case '.m4a': return 'audio/mp4';
    case '.opus': return 'audio/ogg; codecs=opus';
    case '.ogg': return 'audio/ogg; codecs=opus';
    case '.webm': return 'audio/webm';
    default: return 'audio/mp4';
  }
}

async function downloadAudio(url) {
  const binary = await ensureBinary();
  await fs.promises.mkdir(DOWNLOAD_DIRECTORY, { recursive: true });

  const id = crypto.randomUUID();
  const output = path.join(DOWNLOAD_DIRECTORY, `${id}.%(ext)s`);
  const stdout = await run(binary, [
    '--no-playlist',
    '--no-warnings',
    '--js-runtimes', 'node',
    '--socket-timeout', '20',
    '--retries', '2',
    '--max-filesize', '50M',
    '-f', 'bestaudio[ext=m4a]/bestaudio',
    '--print', 'after_move:filepath',
    '-o', output,
    url,
  ]);

  const filePath = stdout.split(/\r?\n/).map((value) => value.trim())
    .reverse().find((value) => value && fs.existsSync(value));
  if (!filePath) throw new Error('The audio file was not created.');

  const stats = await fs.promises.stat(filePath);
  if (!stats.size || stats.size > MAX_FILE_SIZE) {
    await fs.promises.unlink(filePath).catch(() => undefined);
    throw new Error('That audio is too large to send on WhatsApp. Choose a shorter song.');
  }

  return { filePath, mimeType: mimeFor(filePath) };
}

async function removeDownloadedAudio(filePath) {
  if (!filePath || !path.resolve(filePath).startsWith(path.resolve(DOWNLOAD_DIRECTORY))) return;
  await fs.promises.unlink(filePath).catch(() => undefined);
}

module.exports = { downloadAudio, removeDownloadedAudio };
