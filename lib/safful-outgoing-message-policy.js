const Module = require('module');
const path = require('path');

function rebrandMessage(value) {
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) return value;
    const replacement = (match) => /(?:md|ᴍᴅ)/i.test(match) ? 'Safful-Md' : 'Safful';
    return value
      .replace(/only[_\s-]*one[_\s-]*empire/gi, 'Safful')
      .replace(/suhail\s*tech\s*info/gi, 'Safful')
      .replace(/suhail(?:[-_ ]*md)?/gi, replacement)
      .replace(/empire(?:[-_ ]*md)?/gi, replacement)
      .replace(/s[ᴜu][ʜh][ᴀa][ɪi][ʟl](?:[-_ ]?[ᴍm][ᴅd])?/gi, replacement)
      .replace(/[ᴇe][ᴍm][ᴘp][ɪi][ʀr][ᴇe](?:[-_ ]?[ᴍm][ᴅd])?/gi, replacement);
  }
  if (Array.isArray(value)) return value.map(rebrandMessage);
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebrandMessage(item)]));
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (!content || typeof content !== 'object' || Buffer.isBuffer(content)) return '';
  return Object.values(content).map(messageText).join('\n');
}

function isLegacyStartupAnnouncement(content) {
  const text = messageText(content);
  return /(?:suhail|safful)[\s_-]*md\s+connected/i.test(text)
    && /prefix\s*:.*plugins\s*:.*mode\s*:.*database\s*:/is.test(text);
}

function rebrandSocket(sock) {
  if (!sock?.sendMessage || sock.__saffulBrandingAttached) return sock;
  sock.__saffulBrandingAttached = true;
  const sendMessage = sock.sendMessage.bind(sock);
  sock.sendMessage = (chatId, content, options) => {
    // The old core announces every reconnect in WhatsApp. Reconnects are
    // normal on managed hosts, so keep them in the server console only.
    if (isLegacyStartupAnnouncement(content)) {
      console.log('[startup] Suppressed legacy WhatsApp connection announcement.');
      return Promise.resolve();
    }
    return sendMessage(chatId, rebrandMessage(content), options);
  };
  console.log('[branding] Safful outgoing-message branding is active');
  return sock;
}

function installOutgoingMessagePolicy() {
  if (global.__saffulOutgoingMessagePolicyInstalled) return;
  global.__saffulOutgoingMessagePolicyInstalled = true;

  const corePath = path.join(__dirname, 'smd.js');
  const originalLoad = Module._load;
  Module._load = function loadSaffulOutgoingMessagePolicy(request, parent, isMain) {
    const loaded = originalLoad.call(this, request, parent, isMain);
    if (request !== '@whiskeysockets/baileys' || parent?.filename !== corePath) return loaded;

    const createSocket = loaded.default;
    const createBrandedSocket = (options = {}) => rebrandSocket(createSocket(options));
    return new Proxy(loaded, {
      get(target, property, receiver) {
        return property === 'default' ? createBrandedSocket : Reflect.get(target, property, receiver);
      },
    });
  };
}

module.exports = { installOutgoingMessagePolicy, rebrandMessage, rebrandSocket, isLegacyStartupAnnouncement };
