/**
 * GET SESSION (offline QR scanner)
 * -------------------------------------------
 * Connects to WhatsApp directly from this machine and shows a QR code
 * for you to scan with your phone — no third-party session websites.
 *
 *   node get-session.js
 *
 * The QR is printed in the terminal AND saved as session-qr.png
 * (open it and scan with your phone's camera).
 *
 * After you scan:
 *   - the session (creds.json + keys) is saved into lib/Suhail_Baileys/
 *   - this tool exits
 *   - start the bot normally:  node index.js   (it auto-connects)
 *
 * Re-running with an existing session skips the QR and just connects.
 */
require(__dirname + '/patch-baileys-version.js');

const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

const SESSION_DIR = path.join(__dirname, 'lib', 'Suhail_Baileys');
const QR_FILE = path.join(__dirname, 'session-qr.png');

(async () => {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  const hasSession = fs.existsSync(path.join(SESSION_DIR, 'creds.json'));
  console.log('Session folder:', SESSION_DIR);
  console.log(hasSession
    ? 'Existing session found — connecting... (no QR needed)'
    : 'No session yet — a QR code will appear below. Scan it with:\n    WhatsApp → Settings → Linked devices → Link a device\n');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    browser: ['Windows', 'chrome', ''],
    markOnlineOnConnect: false,
    // NOTE: do NOT enable syncFullHistory here — WhatsApp closes the
    // connection (code 428) when full history sync is requested on a
    // fresh registration, so the QR never appears.
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    if (update.qr) {
      try {
        await qrcode.toFile(QR_FILE, update.qr, { width: 512 });
        console.log('\n[QR] saved as: ' + QR_FILE + '  (open it and scan with your phone)\n');
      } catch (e) {
        console.log('[QR] png save failed:', e.message);
      }
    }
    if (update.connection === 'open') {
      console.log('\n✅ Connected! Session saved to ' + SESSION_DIR);
      console.log('Now start the bot:  node index.js');
      setTimeout(() => process.exit(0), 1500);
    }
    if (update.connection === 'close') {
      const code = update.lastDisconnect?.error instanceof Boom
        ? update.lastDisconnect.error.output.statusCode
        : update.lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log('❌ Logged out. Delete the files in ' + SESSION_DIR + ' and re-run.');
        process.exit(1);
      }
      if (code === DisconnectReason.connectionReplaced) {
        console.log('❌ Session replaced by another device. Close WhatsApp on the other device and re-run.');
        process.exit(1);
      }
      console.log('Connection closed (code ' + code + '), reconnecting...');
    }
  });

  setTimeout(() => {
    console.log('\nTimed out after 120s without scanning. Re-run to get a fresh QR.');
    process.exit(0);
  }, 120000);
})();
