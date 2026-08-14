const fs = require('fs');
const os = require('os');
const path = require('path');
const { downloadContentFromMessage, extractMessageContent, getContentType } = require('@whiskeysockets/baileys');

const STATE_FILE = path.join(__dirname, 'safful-protection.json');
const MAX_CACHED_MESSAGES = 1000;
const MESSAGE_TTL_MS = 15 * 60 * 1000;
const SPAM_WINDOW_MS = 8 * 1000;
const SPAM_LIMIT = 5;
const VIEW_ONCE_CACHE_DIR = path.join(os.tmpdir(), 'safful-md-antidelete');
const MAX_VIEW_ONCE_BYTES = Math.max(1, Number(process.env.ANTI_DELETE_VIEW_ONCE_MAX_MB || 64)) * 1024 * 1024;
const recentMessageKeys = new Map();
const recentMessageKeysById = new Map();
const MESSAGE_WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'deviceSentMessage',
  'documentWithCaptionMessage',
  'editedMessage',
];

function defaultAntiDelete() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.ANTI_DELETE || '').trim().toLowerCase());
}

function readState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (state && typeof state === 'object') {
      return {
        ...state,
        global: { antiDelete: defaultAntiDelete(), ...(state.global || {}) },
        groups: state.groups || {},
      };
    }
  } catch {
    // Fall through to the environment-backed defaults below.
  }
  return { global: { antiDelete: defaultAntiDelete() }, groups: {} };
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function groupSettings(groupId) {
  const state = readState();
  return {
    antiDelete: false,
    antiSpam: false,
    antiLink: false,
    ...(state.groups?.[groupId] || {}),
  };
}

function setGroupSettings(groupId, changes) {
  const state = readState();
  state.groups = state.groups || {};
  state.groups[groupId] = { ...groupSettings(groupId), ...changes };
  writeState(state);
  return state.groups[groupId];
}

function antiDeleteEnabled() {
  return Boolean(readState().global?.antiDelete);
}

function setAntiDelete(enabled) {
  const state = readState();
  state.global = { ...(state.global || {}), antiDelete: Boolean(enabled) };
  writeState(state);
  return state.global.antiDelete;
}

function getMessageText(message = {}) {
  const content = unwrapContent(message.message || message);
  if (!content || typeof content !== 'object') return '';

  if (typeof content.conversation === 'string') return content.conversation;
  if (typeof content.extendedTextMessage?.text === 'string') return content.extendedTextMessage.text;
  if (typeof content.imageMessage?.caption === 'string') return content.imageMessage.caption;
  if (typeof content.videoMessage?.caption === 'string') return content.videoMessage.caption;
  if (typeof content.documentMessage?.caption === 'string') return content.documentMessage.caption;

  return '';
}

function senderFromKey(key = {}) {
  return key.participant || key.remoteJid || '';
}

function isOwner(jid = '') {
  const owner = String(process.env.OWNER_NUMBER || global.owner || '').replace(/\D/g, '');
  return owner && String(jid).replace(/\D/g, '').startsWith(owner);
}

function sudoJid() {
  const configured = String(process.env.SUDO || global.sudo || process.env.OWNER_NUMBER || global.owner || '');
  const number = configured.replace(/\D/g, '');
  return number ? `${number}@s.whatsapp.net` : null;
}

function hasLink(text = '') {
  return /(?:https?:\/\/|www\.|chat\.whatsapp\.com\/|wa\.me\/)/i.test(text);
}

function isRevoke(update = {}) {
  const protocol = update.message?.protocolMessage;
  if (!protocol) return false;
  return protocol.type === 0 || protocol.type === 'REVOKE';
}

function unwrapContent(content = {}) {
  let current = content;

  // WhatsApp can nest ephemeral and V2 view-once envelopes together. Keep
  // unwrapping until the actual media/text message is reached.
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth += 1) {
    const wrapper = MESSAGE_WRAPPERS.find((name) => current[name]?.message);
    if (!wrapper) break;
    current = current[wrapper].message;
  }
  return current || {};
}

function mediaDescriptor(content, wrappedAsViewOnce = false) {
  for (const [field, kind] of [['imageMessage', 'image'], ['videoMessage', 'video']]) {
    const media = content?.[field];
    if (!media) continue;
    return {
      media,
      kind,
      label: kind,
      isViewOnce: Boolean(wrappedAsViewOnce || media.viewOnce),
      caption: typeof media.caption === 'string' ? media.caption : '',
    };
  }
  return null;
}

function viewOnceMedia(message = {}) {
  const queue = [{ content: message.message || message, wrappedAsViewOnce: false }];
  const visited = new WeakSet();

  while (queue.length) {
    const { content, wrappedAsViewOnce } = queue.shift();
    if (!content || typeof content !== 'object' || visited.has(content)) continue;
    visited.add(content);

    const directMedia = mediaDescriptor(content, wrappedAsViewOnce);
    if (directMedia) return directMedia;

    for (const wrapper of MESSAGE_WRAPPERS) {
      const nested = content[wrapper]?.message;
      if (nested) queue.push({
        content: nested,
        wrappedAsViewOnce: wrappedAsViewOnce || wrapper.startsWith('viewOnceMessage'),
      });
    }
  }

  // Baileys knows about wrapper variants added by WhatsApp after this bot was
  // released. Use its extractor as a final route instead of reporting a
  // perfectly valid deleted media message as "unsupported".
  try {
    const extracted = extractMessageContent(message.message || message);
    const type = getContentType(extracted || {});
    const extractedMedia = mediaDescriptor(extracted, false);
    if (extractedMedia && (type === 'imageMessage' || type === 'videoMessage')) return extractedMedia;
  } catch {}

  return null;
}

async function streamToBuffer(stream, maxBytes = Infinity) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const part = Buffer.from(chunk);
    total += part.length;
    if (total > maxBytes) throw new Error(`view-once media exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB anti-delete cache limit`);
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

function viewOnceContent(viewOnce, buffer) {
  return viewOnce.kind === 'image'
    ? { image: buffer, caption: viewOnce.caption || undefined }
    : {
      video: buffer,
      caption: viewOnce.caption || undefined,
      mimetype: viewOnce.media.mimetype || 'video/mp4',
    };
}

async function captureViewOnceMedia(message) {
  const viewOnce = viewOnceMedia(message);
  if (!viewOnce) return null;
  const declaredSize = Number(viewOnce.media.fileLength || 0);
  if (declaredSize > MAX_VIEW_ONCE_BYTES) {
    console.warn('[anti-delete] skipped view-once media above the configured cache limit');
    return null;
  }

  const stream = await downloadContentFromMessage(viewOnce.media, viewOnce.kind);
  const buffer = await streamToBuffer(stream, MAX_VIEW_ONCE_BYTES);
  await fs.promises.mkdir(VIEW_ONCE_CACHE_DIR, { recursive: true });
  const safeId = String(message?.key?.id || `${Date.now()}-${Math.random()}`).replace(/[^a-zA-Z0-9_-]/g, '');
  const filePath = path.join(VIEW_ONCE_CACHE_DIR, `${safeId}.bin`);
  await fs.promises.writeFile(filePath, buffer);
  return { ...viewOnce, filePath };
}

async function removeCapturedViewOnce(captured) {
  if (!captured?.filePath) return;
  try {
    await fs.promises.unlink(captured.filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('[anti-delete] could not remove cached view-once media:', error.message || error);
  }
}

async function recoverViewOnceMedia(sock, recipient, message, captured) {
  const viewOnce = captured || viewOnceMedia(message);
  if (!viewOnce) return false;

  let buffer;
  if (captured?.filePath) {
    buffer = await fs.promises.readFile(captured.filePath);
  } else {
    // A revoke may arrive before the background capture completes. Fall back
    // to WhatsApp's media URL when it is still available.
    const stream = await downloadContentFromMessage(viewOnce.media, viewOnce.kind);
    buffer = await streamToBuffer(stream, MAX_VIEW_ONCE_BYTES);
  }
  await sock.sendMessage(recipient, viewOnceContent(viewOnce, buffer));
  return true;
}

function revokedMessageKey(message = {}) {
  const protocol = unwrapContent(message.message || {}).protocolMessage;
  if (!protocol || (protocol.type !== 0 && protocol.type !== 'REVOKE') || !protocol.key?.id) return null;
  return {
    ...protocol.key,
    remoteJid: protocol.key.remoteJid || message.key?.remoteJid,
  };
}

function describeMessage(message) {
  const text = getMessageText(message).trim();
  if (text) return text;
  const media = viewOnceMedia(message);
  if (media) return media.isViewOnce ? `[View-once ${media.label}]` : `[${media.label[0].toUpperCase()}${media.label.slice(1)}]`;
  const content = unwrapContent(message.message || message);
  if (content.imageMessage) return '[Image]';
  if (content.videoMessage) return '[Video]';
  if (content.audioMessage) return '[Audio]';
  if (content.stickerMessage) return '[Sticker]';
  if (content.documentMessage) return '[Document]';
  return '[Deleted message content could not be decoded]';
}

function shortText(value, limit = 700) {
  const text = String(value || '').replace(/\r/g, '').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

async function contactName(sock, message) {
  const embeddedName = shortText(message?.pushName || message?.verifiedBizName || message?.businessOwnerJid);
  if (embeddedName) return embeddedName;

  const key = message?.key || {};
  const jid = key.participantAlt || key.participant || key.remoteJidAlt || key.remoteJid;
  if (jid && typeof sock?.getName === 'function') {
    try {
      const resolved = shortText(await sock.getName(jid));
      if (resolved && !resolved.includes('@')) return resolved;
    } catch {}
  }

  return 'Unknown contact';
}

function recoveryCard(name, deletedMessage) {
  const preview = shortText(deletedMessage) || '[Deleted message content could not be decoded]';
  const indentedPreview = preview.split('\n').map((line) => `│ ${line || ' '}`).join('\n');
  return [
    '┌─〔 *SAFFUL ANTI-DELETE* 〕',
    `│ Sender: *${name}*`,
    '│',
    '│ Deleted message:',
    indentedPreview,
    '└────────────────────',
    '_Recovered deleted message._',
  ].join('\n');
}

// Keep the exact raw Baileys key for a short time even when anti-delete is
// disabled. A reply context does not include participantAlt, but the raw key
// does; that alternate identifier is required for reliable group revokes on
// WhatsApp's newer LID addressing.
function rememberMessageKey(message) {
  const key = message?.key;
  if (!key?.id || !key.remoteJid || key.remoteJid === 'status@broadcast') return;
  const entry = { key: { ...key }, receivedAt: Date.now() };
  recentMessageKeys.set(`${key.remoteJid}:${key.id}`, entry);
  recentMessageKeysById.set(key.id, entry);

  const cutoff = Date.now() - MESSAGE_TTL_MS;
  for (const [cacheKey, cached] of recentMessageKeys) {
    if (cached.receivedAt < cutoff) {
      recentMessageKeys.delete(cacheKey);
      if (cached.key?.id) recentMessageKeysById.delete(cached.key.id);
    }
  }
}

function getCachedMessageKey(remoteJid, id) {
  if (!id) return null;
  const entry = recentMessageKeys.get(`${remoteJid}:${id}`) || recentMessageKeysById.get(id);
  return entry?.key ? { ...entry.key } : null;
}

module.exports = function attachProtection(sock) {
  if (!sock || sock.__saffulProtectionAttached) return;
  sock.__saffulProtectionAttached = true;
  console.log('[protection] raw message monitoring attached');

  const cachedMessages = new Map();
  const cachedMessagesById = new Map();
  const spamAttempts = new Map();

  function discardCachedMessage(cachedEntry) {
    if (!cachedEntry?.viewOnceCapture) return;
    void cachedEntry.viewOnceCapture
      .then((captured) => removeCapturedViewOnce(captured))
      .catch(() => {});
  }

  function remember(message) {
    const key = message?.key;
    if (!key?.id || !key.remoteJid || key.remoteJid === 'status@broadcast') return;

    const cached = { message, receivedAt: Date.now() };
    // A view-once URL can stop working as soon as its message is revoked.
    // Capture it while the original upsert is fresh, then retain only a short
    // local file until anti-delete either recovers or expires it.
    if (viewOnceMedia(message)) {
      cached.viewOnceCapture = captureViewOnceMedia(message).catch((error) => {
        console.warn('[anti-delete] could not pre-cache view-once media:', error.message || error);
        return null;
      });
    }
    cachedMessages.set(`${key.remoteJid}:${key.id}`, cached);
    cachedMessagesById.set(key.id, cached);
    if (cachedMessages.size > MAX_CACHED_MESSAGES) {
      const oldestKey = cachedMessages.keys().next().value;
      const oldest = cachedMessages.get(oldestKey);
      cachedMessages.delete(oldestKey);
      if (oldest?.message?.key?.id) cachedMessagesById.delete(oldest.message.key.id);
      discardCachedMessage(oldest);
    }

    const cutoff = Date.now() - MESSAGE_TTL_MS;
    for (const [id, cached] of cachedMessages) {
      if (cached.receivedAt < cutoff) {
        cachedMessages.delete(id);
        if (cached.message?.key?.id) cachedMessagesById.delete(cached.message.key.id);
        discardCachedMessage(cached);
      }
    }
  }

  async function removeAndWarn(message, reason) {
    const key = message.key;
    const chatId = key.remoteJid;
    try {
      await sock.sendMessage(chatId, { delete: key });
      await sock.sendMessage(chatId, { text: `Safful protection: ${reason}` });
    } catch (error) {
      console.error('Safful protection action failed:', error.message || error);
    }
  }

  async function recover(targetKey) {
    if (!targetKey?.remoteJid || targetKey.remoteJid === 'status@broadcast' || !targetKey.id || !antiDeleteEnabled()) return;

    const cachedEntry = cachedMessages.get(`${targetKey.remoteJid}:${targetKey.id}`) || cachedMessagesById.get(targetKey.id);
    const cached = cachedEntry?.message;
      if (!cached) {
        console.log('[anti-delete] revocation received but the original message was not cached', targetKey.id);
        return;
      }
      if (cached.key?.fromMe || isOwner(senderFromKey(cached.key))) return;

      const recipient = sudoJid();
      if (!recipient) return;
      const senderName = await contactName(sock, cached);
      const deletedMessage = describeMessage(cached);
      const report = recoveryCard(senderName, deletedMessage);

      try {
        // Forwarding a view-once envelope is intentionally rejected by
        // WhatsApp. Download and re-send its bytes as ordinary media instead.
        const capturedViewOnce = cachedEntry?.viewOnceCapture ? await cachedEntry.viewOnceCapture : null;
        const recoveredViewOnce = await recoverViewOnceMedia(sock, recipient, cached, capturedViewOnce);
        if (!recoveredViewOnce) await sock.copyNForward(recipient, cached, true);
        await sock.sendMessage(recipient, { text: report });
        console.log('[anti-delete] recovered deleted message', targetKey.id);
      } catch (error) {
        console.error('Safful anti-delete recovery failed:', error.message || error);
        await sock.sendMessage(recipient, { text: report });
      }
      cachedMessages.delete(`${cached.key.remoteJid}:${cached.key.id}`);
      cachedMessagesById.delete(cached.key.id);
      discardCachedMessage(cachedEntry);
  }

  const handleMessagesUpsert = async ({ messages }) => {
    for (const message of messages || []) {
      const targetKey = revokedMessageKey(message);
      if (targetKey) {
        console.log('[anti-delete] revocation event received', targetKey.id);
        await recover(targetKey);
        continue;
      }

      rememberMessageKey(message);
      if (antiDeleteEnabled()) remember(message);
      const key = message?.key;
      const chatId = key?.remoteJid;
      if (!chatId?.endsWith('@g.us') || key.fromMe || isOwner(senderFromKey(key))) continue;

      const settings = groupSettings(chatId);
      if (!settings.antiLink && !settings.antiSpam) continue;

      const text = getMessageText(message);
      if (settings.antiLink && hasLink(text)) {
        await removeAndWarn(message, 'links are not allowed in this group.');
        continue;
      }

      if (settings.antiSpam) {
        const sender = senderFromKey(key);
        const spamKey = `${chatId}:${sender}`;
        const now = Date.now();
        const recent = (spamAttempts.get(spamKey) || []).filter((time) => now - time < SPAM_WINDOW_MS);
        recent.push(now);
        spamAttempts.set(spamKey, recent);
        if (recent.length > SPAM_LIMIT) {
          spamAttempts.set(spamKey, []);
          await removeAndWarn(message, 'please stop spamming.');
        }
      }
    }
  };

  const handleMessagesUpdate = async (updates) => {
    for (const { key, update } of updates || []) {
      if (!key?.remoteJid || !isRevoke(update)) continue;
      await recover({ ...key, ...(update.message?.protocolMessage?.key || {}) });
    }
  };

  if (sock.__saffulRawDispatcher?.onUpsert && sock.__saffulRawDispatcher?.onUpdate) {
    sock.__saffulRawDispatcher.onUpsert(handleMessagesUpsert);
    sock.__saffulRawDispatcher.onUpdate(handleMessagesUpdate);
  } else {
    sock.ev.on('messages.upsert', handleMessagesUpsert);
    sock.ev.on('messages.update', handleMessagesUpdate);
  }
};

module.exports.groupSettings = groupSettings;
module.exports.setGroupSettings = setGroupSettings;
module.exports.antiDeleteEnabled = antiDeleteEnabled;
module.exports.setAntiDelete = setAntiDelete;
module.exports.getCachedMessageKey = getCachedMessageKey;
module.exports.describeMessage = describeMessage;
module.exports.viewOnceMedia = viewOnceMedia;
module.exports.recoverViewOnceMedia = recoverViewOnceMedia;
