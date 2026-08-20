const fs = require('fs');
const path = require('path');
const pino = require('pino');
const {
  default: makeWASocket,
  Browsers,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} = require('@whiskeysockets/baileys');

const PROJECT_ROOT = path.join(__dirname, '..');
const AUTH_DIRECTORY = path.join(__dirname, 'Suhail_Baileys');
const BACKUP_DIRECTORY = path.join(__dirname, 'auth-backups');

function isCompleteSession(credentials) {
  return Boolean(credentials?.registered === true && credentials?.account && credentials?.me?.id && credentials?.advSecretKey);
}

function archiveIncompleteSession() {
  const credentialsPath = path.join(AUTH_DIRECTORY, 'creds.json');
  let credentials;
  try {
    credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  } catch {
    return;
  }
  if (isCompleteSession(credentials)) return;

  fs.mkdirSync(BACKUP_DIRECTORY, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(BACKUP_DIRECTORY, `incomplete-pairing-${stamp}`);
  fs.renameSync(AUTH_DIRECTORY, backup);
  fs.mkdirSync(AUTH_DIRECTORY, { recursive: true });
  console.warn('[auth] Removed incomplete credentials from a previous failed pairing attempt.');
}

async function startCleanPairing(number) {
  archiveIncompleteSession();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIRECTORY);
  const liveVersion = await fetchLatestWaWebVersion().catch(() => undefined);
  const version = Array.isArray(liveVersion?.version) ? liveVersion.version : global.__saffulPairingVersion;
  const socket = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }).child({ level: 'fatal' })),
    },
    ...(Array.isArray(version) ? { version } : {}),
    // Announce the same companion client identity used by the deployed Linux
    // service. This avoids the macOS identity that was being rejected during
    // the phone-number pairing handshake on this host.
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    defaultQueryTimeoutMs: 60_000,
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 10_000,
    markOnlineOnConnect: true,
    syncFullHistory: false,
    generateHighQualityLinkPreview: true,
    getMessage: async () => ({ conversation: '' }),
    logger: pino({ level: 'silent' }),
  });

  socket.ev.on('creds.update', saveCreds);

  return new Promise((resolve, reject) => {
    let codeRequested = false;
    let settled = false;
    let pairingTimer;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(pairingTimer);
      socket.ev.removeAllListeners('connection.update');
      socket.ev.removeAllListeners('creds.update');
      if (error) reject(error);
      else resolve();
    };

    const requestCode = async () => {
      if (codeRequested || settled) return;
      codeRequested = true;
      try {
        const code = await socket.requestPairingCode(number);
        const rawCode = String(code).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
        console.log(`\n[auth] Your Safful-Md pairing code: ${rawCode}\n`);
        console.log('[auth] Enter all 8 characters only — do not type a dash or spaces.');
        console.log('[auth] On WhatsApp: Linked devices > Link a device > Link with phone number instead.');
      } catch (error) {
        finish(new Error(`[auth] Pairing-code request failed: ${error?.message || error}`));
      }
    };

    socket.ev.on('connection.update', async (update = {}) => {
      if (update.connection === 'open') {
        try {
          await saveCreds();
          if (!isCompleteSession(state.creds)) {
            finish(new Error('[auth] WhatsApp opened a connection without saving a complete linked session.'));
            return;
          }
          console.log('[auth] Pairing completed. Starting Safful-Md with the saved session.');
          finish();
          // Closing the transport does not log the device out; Safful-Md will
          // immediately open its own socket using these persisted credentials.
          void socket.ws.close();
        } catch (error) {
          finish(error);
        }
      }

      if (update.connection === 'close' && !settled) {
        const message = String(update.lastDisconnect?.error?.message || 'WhatsApp closed the pairing connection.');
        finish(new Error(`[auth] Pairing was rejected before completion: ${message}`));
      }
    });

    // Match MEGA-MD's known working pairing timing. It allows the socket's
    // registration sequence to settle before the companion-code request,
    // rather than coupling the request to the QR event lifecycle.
    setTimeout(requestCode, 3000);
    pairingTimer = setTimeout(() => {
      finish(new Error('[auth] Pairing timed out. No credentials were accepted.'));
    }, 2 * 60 * 1000);
  });
}

module.exports = { startCleanPairing, isCompleteSession };
