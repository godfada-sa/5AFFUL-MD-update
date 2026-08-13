/**
 * SEND TEST (one-shot)
 * -------------------------------------------
 * Connects with the bot's existing session and sends a text message
 * to a given number, then exits.
 *
 *   node send-test.js <number-with-country-code> <text>
 *
 * NOTE: this opens a second connection to the SAME WhatsApp account.
 * Run it only while the bot is STOPPED, or the connections will fight
 * ("Connection Replaced"). Restart the bot afterwards.
 */
require(__dirname + '/patch-baileys-version.js');

const path = require('path');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

const SESSION_DIR = path.join(__dirname, 'lib', 'Suhail_Baileys');
const target = process.argv[2];
const text = process.argv[3] || 'Test from your WhatsApp bot — session check.';

if (!target) {
  console.log('Usage: node send-test.js <number-with-country-code> [text]');
  process.exit(1);
}

(async () => {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ['Windows', 'chrome', ''],
    markOnlineOnConnect: false,
    shouldSyncHistoryMessage: () => true,
    syncFullHistory: false,
  });
  sock.ev.on('creds.update', saveCreds);

  let done = false;
  const finish = (code) => {
    if (done) return;
    done = true;
    setTimeout(() => process.exit(code), 800);
  };

  sock.ev.on('connection.update', async (update) => {
    if (update.connection === 'open') {
      const jid = target.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
      console.log('Connected. Sending to', jid, '...');
      try {
        const res = await sock.sendMessage(jid, { text });
        console.log('SENT OK. message id:', res?.key?.id || '?');
        console.log('Now check the second phone — the message should appear there.');
        finish(0);
      } catch (e) {
        console.log('SEND FAILED:', e?.message || e);
        finish(1);
      }
    }
    if (update.connection === 'close') {
      const code = update.lastDisconnect?.error instanceof Boom
        ? update.lastDisconnect.error.output.statusCode
        : update.lastDisconnect?.error?.output?.statusCode;
      console.log('Connection closed (code ' + code + '), reconnecting...');
    }
  });

  setTimeout(() => {
    console.log('Timed out after 90s — did not connect/send.');
    process.exit(1);
  }, 90000);
})();
