const Module = require('module');
const path = require('path');

const CORE_PATH = path.join(__dirname, 'smd.js');

function isDirectConversation(jid) {
  return typeof jid === 'string' && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'));
}

function preserveMobileNotifications(sock) {
  if (!sock || sock.__saffulMobileNotificationGuard || process.env.SAFFUL_PRESERVE_DM_NOTIFICATIONS === 'false') return;
  sock.__saffulMobileNotificationGuard = true;

  if (typeof sock.readMessages === 'function') {
    const readMessages = sock.readMessages.bind(sock);
    sock.readMessages = (keys = []) => {
      // Do not let a linked bot mark incoming DMs read. That can prevent the
      // primary WhatsApp app from issuing a personal-message notification.
      // Group receipts and status read receipts remain untouched.
      const allowed = keys.filter((key) => key?.fromMe || key?.remoteJid === 'status@broadcast' || key?.remoteJid?.endsWith('@g.us'));
      return allowed.length ? readMessages(allowed) : Promise.resolve();
    };
  }

  if (typeof sock.sendReceipt === 'function') {
    const sendReceipt = sock.sendReceipt.bind(sock);
    sock.sendReceipt = (jid, participant, messageIds, type) => {
      // The legacy core can bypass readMessages and invoke Baileys' receipt
      // primitive directly. Prevent only direct-chat read receipts; status,
      // group, delivery, and call receipts retain their normal behavior.
      if (isDirectConversation(jid) && (type === 'read' || type === 'read-self')) return Promise.resolve();
      return sendReceipt(jid, participant, messageIds, type);
    };
  }

  if (typeof sock.sendPresenceUpdate === 'function' && sock.ev?.on) {
    const sendPresenceUpdate = sock.sendPresenceUpdate.bind(sock);
    sock.sendPresenceUpdate = (presence, jid) => {
      // A global "available" presence from the companion can make WhatsApp
      // treat the primary device as active. Keep the bot offline globally;
      // chat-specific typing/presence features remain available.
      if (!jid && presence === 'available') return sendPresenceUpdate('unavailable');
      return sendPresenceUpdate(presence, jid);
    };
    sock.ev.on('connection.update', ({ connection } = {}) => {
      if (connection === 'open') sock.sendPresenceUpdate('unavailable').catch(() => {});
    });
  }

  process.stdout.write('[notifications] direct-message read receipts and presence are protected\n');
}

function installMobileNotificationGuard() {
  if (global.__saffulMobileNotificationHookInstalled) return;
  global.__saffulMobileNotificationHookInstalled = true;

  const previousLoad = Module._load;
  Module._load = function loadSaffulMobileNotificationGuard(request, parent, isMain) {
    const loaded = previousLoad.call(this, request, parent, isMain);
    if (request !== '@whiskeysockets/baileys' || parent?.filename !== CORE_PATH) return loaded;

    const createSocket = loaded.default;
    const createProtectedSocket = (options = {}) => {
      const socket = createSocket(options);
      // Do not alter presence or receipts while WhatsApp is registering a
      // brand-new companion. The guard is irrelevant before login and can
      // interfere with the pairing handshake. `index.js` attaches it after a
      // successful fresh login; later restarts are protected here immediately.
      if (options.auth?.creds?.registered === true) preserveMobileNotifications(socket);
      return socket;
    };

    return new Proxy(loaded, {
      get(target, property, receiver) {
        return property === 'default' ? createProtectedSocket : Reflect.get(target, property, receiver);
      },
    });
  };
}

module.exports = preserveMobileNotifications;
module.exports.installMobileNotificationGuard = installMobileNotificationGuard;
