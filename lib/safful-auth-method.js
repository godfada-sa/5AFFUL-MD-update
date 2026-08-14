const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const Module = require('module');

const AUTH_DIR = path.join(__dirname, 'Suhail_Baileys');
const CREDS_FILE = path.join(AUTH_DIR, 'creds.json');
const CORE_FILE = path.join(__dirname, 'smd.js');
const AUTH_BACKUP_DIR = path.join(__dirname, 'auth-backups');

// The legacy core can silence console methods according to its log setting.
// It saves the original logger as `global.print`, so use that when it exists
// to keep authentication diagnostics visible during login.
function authLog(...values) {
  const output = typeof global.print === 'function' ? global.print : console.log;
  output(...values);
}

function resetLocalAuthForFreshStart() {
  // This directory is the only local Baileys credential store used by the
  // root bot. Never touch the separate Web.js project or any other path.
  fs.rmSync(AUTH_DIR, { recursive: true, force: true, maxRetries: 2 });
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  console.log('[auth] Cleared the previous local session. A new login is required for this start.');
}

function isUsableSession(credentials) {
  // A failed QR/pairing attempt can already contain account, identity, and
  // secret fields while Baileys still marks it `registered: false`. Treating
  // that partial file as a session prevents both login methods from starting.
  return Boolean(
    credentials?.registered === true
    && credentials?.account
    && credentials?.me?.id
    && credentials?.advSecretKey,
  );
}

function normaliseNumber(value) {
  const number = String(value || '').replace(/\D/g, '');
  return number.length >= 7 && number.length <= 15 ? number : '';
}

function maskedNumber(number) {
  if (!number) return 'not configured';
  if (number.length <= 6) return `+${number}`;
  return `+${number.slice(0, 3)}…${number.slice(-4)}`;
}

function hasSavedSession() {
  try {
    const credentials = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    return isUsableSession(credentials);
  } catch {
    return false;
  }
}

function archiveIncompleteSession() {
  if (!fs.existsSync(CREDS_FILE) || hasSavedSession()) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(AUTH_BACKUP_DIR, `incomplete-session-${stamp}`);
  fs.mkdirSync(AUTH_BACKUP_DIR, { recursive: true });
  fs.renameSync(AUTH_DIR, backup);
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  console.warn('[auth] Archived incomplete credentials and started a fresh login flow.');
}

function disconnectStatusCode(error) {
  return Number(
    error?.output?.statusCode
    || error?.data?.statusCode
    || error?.statusCode
    || error?.status,
  ) || 0;
}

function isLoggedOutDisconnect(update = {}) {
  if (update.connection !== 'close') return false;
  const error = update.lastDisconnect?.error;
  const message = String(error?.message || error || '').toLowerCase();
  return disconnectStatusCode(error) === 401
    || /logged.?out|not authorized|invalid session|bad mac/i.test(message);
}

function archiveLoggedOutSession() {
  if (!fs.existsSync(AUTH_DIR)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(AUTH_BACKUP_DIR, `logged-out-session-${stamp}`);
  fs.mkdirSync(AUTH_BACKUP_DIR, { recursive: true });
  fs.renameSync(AUTH_DIR, backup);
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

function configuredMethod() {
  const method = String(process.env.AUTH_METHOD || '').trim().toLowerCase();
  return method === 'pairing' || method === 'qr' ? method : '';
}

function buildFreshLoginOptions(options = {}, browser, version) {
  return {
    ...options,
    ...(Array.isArray(version) ? { version } : {}),
    browser,
    defaultQueryTimeoutMs: 60_000,
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 10_000,
    syncFullHistory: false,
    // A linked desktop companion marked available can suppress mobile push
    // notifications. This setting is unrelated to the pairing-code exchange.
    markOnlineOnConnect: false,
  };
}

async function refreshWhatsAppWebVersion() {
  try {
    // Baileys can report a bundled revision as "latest" even after WhatsApp
    // Web has advanced. That stale revision still generates a pairing code,
    // but WhatsApp rejects the actual device link. Query WhatsApp Web for the
    // current revision used by its companion service instead.
    const { fetchLatestWaWebVersion } = require('@whiskeysockets/baileys');
    const result = await fetchLatestWaWebVersion();
    const version = result?.version;
    if (!Array.isArray(version) || version.length !== 3) throw new Error('invalid WhatsApp Web version');

    global.__saffulPairingVersion = version;
    const { DEFAULT_CONNECTION_CONFIG } = require('@whiskeysockets/baileys/lib/Defaults');
    DEFAULT_CONNECTION_CONFIG.version = version;
    console.log(`[auth] Live WhatsApp-Web revision: ${version.join('.')}`);
  } catch {
    // `patch-baileys-version.js` supplies a last-known-good fallback for hosts
    // which cannot reach WhatsApp Web at startup.
    console.warn('[auth] Could not refresh the WhatsApp Web revision; using the bundled fallback.');
  }
}

async function ask(question) {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await prompt.question(question)).trim();
  } finally {
    prompt.close();
  }
}

async function prepareAuthentication() {
  await refreshWhatsAppWebVersion();

  if (hasSavedSession()) {
    global.__saffulAuthMethod = 'existing';
    return;
  }

  // Keep properly linked sessions across restarts, but never let a failed
  // pairing attempt block a new QR or phone-number pairing request.
  archiveIncompleteSession();

  let method = configuredMethod();
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  if (!method && interactive) {
    const choice = await ask('\nFresh Safful-Md session. Choose login: [1] Pairing code  [2] QR code (default 1): ');
    method = choice === '2' || choice.toLowerCase() === 'qr' ? 'qr' : 'pairing';
  }

  method ||= 'qr';
  if (method === 'pairing') {
    let number = normaliseNumber(process.env.PAIRING_NUMBER);
    if (!number && interactive) number = normaliseNumber(await ask('Enter the WhatsApp number with country code (no +): '));

    if (!number) {
      console.warn('[auth] PAIRING_NUMBER is required for pairing on a non-interactive host. Falling back to QR login.');
      method = 'qr';
    } else {
      global.__saffulPairingNumber = number;
      console.log('[auth] Pairing-code login selected. The code will be printed in this server console.');
      console.log(`[auth] Pairing target: ${maskedNumber(number)}. It must be the same WhatsApp account entering the code.`);
    }
  }

  global.__saffulAuthMethod = method;
  if (method === 'qr') {
    if (process.env.SAFFUL_AUTH_FALLBACK_FROM_PAIRING === 'true') {
      console.warn('[auth] Pairing-code login was rejected by WhatsApp. Switched to QR login for this fresh session.');
    }
    console.log('[auth] QR login selected. Open the bot QR page after startup.');
  }
}

function installPairingHook() {
  if (global.__saffulPairingHookInstalled) return;
  const previousLoad = Module._load;

  Module._load = function loadSaffulPairingBaileys(request, parent, isMain) {
    const loaded = previousLoad.call(this, request, parent, isMain);
    if (request !== '@whiskeysockets/baileys' || parent?.filename !== CORE_FILE) return loaded;

    const previousCreateSocket = loaded.default;
    const createSaffulSocket = (options = {}) => {
      const number = global.__saffulAuthMethod === 'pairing'
        ? normaliseNumber(global.__saffulPairingNumber || process.env.PAIRING_NUMBER)
        : '';
      const linked = isUsableSession(options.auth?.creds);
      // Use one known-good fresh-companion profile for BOTH QR and phone-code
      // login. Previously the live WhatsApp-Web revision was only applied to
      // pairing-code sockets; QR could still inherit the old core revision.
      const freshLoginOptions = !linked
        ? buildFreshLoginOptions(
          options,
          // Match MEGA-MD's desktop companion profile.
          loaded.Browsers?.macOS?.('Chrome') || ['Mac OS', 'Chrome', ''],
          global.__saffulPairingVersion,
        )
        : options;
      const socket = previousCreateSocket(freshLoginOptions);

      // Keeping a linked session across ordinary restarts is correct. If the
      // user explicitly unlinks the device in WhatsApp, however, its local
      // credentials still look complete. Detect only that 401/logout state,
      // archive it, and restart once into the configured pairing/QR flow.
      if (linked && !socket.__saffulLoggedOutRecoveryAttached) {
        socket.__saffulLoggedOutRecoveryAttached = true;
        socket.ev.on('connection.update', (update = {}) => {
          if (!isLoggedOutDisconnect(update) || global.__saffulLoggedOutRecovery) return;
          global.__saffulLoggedOutRecovery = true;
          try {
            archiveLoggedOutSession();
            global.__saffulAuthMethod = configuredMethod() || 'qr';
            global.__saffulPairingScheduled = false;
            global.__saffulPairingRequested = false;
            console.warn('[auth] Linked device was logged out. Archived its stale credentials and restarting a fresh login flow.');
            setTimeout(() => process.exit(1), 250).unref?.();
          } catch (error) {
            console.error('[auth] Could not reset the logged-out session:', error.message || error);
          }
        });
      }

      if (!number || linked || global.__saffulPairingScheduled) return socket;
      global.__saffulPairingScheduled = true;

      let requested = false;
      let fallbackTimer;
      let retryTimer;
      let codeExpiryTimer;
      let attempts = 0;
      let reportedConnection = '';
      let credentialsReported = false;

      const clearTimers = () => {
        if (fallbackTimer) clearTimeout(fallbackTimer);
        if (retryTimer) clearTimeout(retryTimer);
        if (codeExpiryTimer) clearTimeout(codeExpiryTimer);
      };

      const requestCode = async () => {
        if (requested || global.__saffulPairingRequested) return;
        requested = true;
        try {
          const code = await socket.requestPairingCode(number);
          global.__saffulPairingRequested = true;
          clearTimers();
          const rawCode = String(code).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
          authLog(`\n[auth] Your Safful-Md pairing code: ${rawCode}\n`);
          console.log('[auth] Enter all 8 characters only — do not type a dash or spaces.');
          authLog('[auth] On WhatsApp: Linked devices > Link a device > Link with phone number instead.');
          authLog('[auth] Waiting for WhatsApp to confirm the linked device…');
          codeExpiryTimer = setTimeout(() => {
            authLog('[auth] No confirmation arrived within two minutes. The code has expired; restart for one new code.');
          }, 2 * 60 * 1000);
        } catch (error) {
          requested = false;
          const message = String(error?.message || error);
          if (/connection closed|not open|connection terminated/i.test(message) && attempts < 2) {
            attempts += 1;
            retryTimer = setTimeout(requestCode, 2000);
            return;
          }
          clearTimers();
          global.__saffulPairingScheduled = false;
          authLog('[auth] Pairing-code request failed:', message);
        }
      };

      socket.ev.on('creds.update', () => {
        if (credentialsReported || !global.__saffulPairingRequested) return;
        credentialsReported = true;
        authLog('[auth] Pairing data received; waiting for final WhatsApp confirmation…');
      });

      socket.ev.on('connection.update', (update = {}) => {
        const connection = String(update.connection || '');
        if (connection && connection !== reportedConnection) {
          reportedConnection = connection;
          authLog(`[auth] Pairing connection state: ${connection}`);
        }
        if (update.isNewLogin) {
          authLog('[auth] WhatsApp confirmed a new login; finalizing Safful-Md…');
        }
        if (connection === 'open') {
          clearTimers();
          authLog('[auth] Pairing completed successfully.');
        }
        if (connection === 'close' && global.__saffulPairingRequested) {
          clearTimers();
          const reason = String(update.lastDisconnect?.error?.message || 'WhatsApp closed the pairing stream.');
          const status = disconnectStatusCode(update.lastDisconnect?.error);
          authLog(`[auth] Pairing connection closed${status ? ` (status ${status})` : ''}: ${reason}`);
        }
      });

      // The desktop transport needs a moment to finish its initial companion
      // registration. MEGA-MD uses this same three-second delay before asking
      // WhatsApp for a phone-number pairing code.
      fallbackTimer = setTimeout(requestCode, 3000);

      return socket;
    };

    return new Proxy(loaded, {
      get(target, property, receiver) {
        return property === 'default'
          ? createSaffulSocket
          : Reflect.get(target, property, receiver);
      },
    });
  };

  global.__saffulPairingHookInstalled = true;
}

installPairingHook();

module.exports = {
  prepareAuthentication,
  normaliseNumber,
  maskedNumber,
  buildFreshLoginOptions,
  isUsableSession,
  isLoggedOutDisconnect,
  hasSavedSession,
  resetLocalAuthForFreshStart,
};
