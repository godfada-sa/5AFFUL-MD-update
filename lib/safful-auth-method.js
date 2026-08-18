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
  // Always use console.log so output goes through the sync-write interceptor
  // in index.js and appears in PM2/panel logs. global.print (set by the core)
  // may bypass the interceptor and get buffered or lost.
  console.log(...values);
}

function resetLocalAuthForFreshStart() {
  // This directory is the only local Baileys credential store used by the
  // root bot. Never touch the separate Web.js project or any other path.
  fs.rmSync(AUTH_DIR, { recursive: true, force: true, maxRetries: 2 });
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  authLog('[auth] Cleared the previous local session. A new login is required for this start.');
}

function isUsableSession(credentials) {
  // A session is usable whenever its crypto material is present and complete.
  // Deliberately NOT checking `registered === true`: Baileys flips that flag
  // at the very END of the link handshake, so a process that restarts right
  // after the phone confirms the link (panel restart, crash, watchdog) can
  // still carry `registered: false` while the session is perfectly valid.
  // The old check made boot ARCHIVE that session — the exact 'already paired
  // but the bot cleared it on restart' loop. Baileys re-registers a
  // structurally-complete session on connect, so only genuinely missing
  // material means it is unusable. This matches Levanter, which never touches
  // its session folder.
  return Boolean(
    credentials?.account
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

// Older builds could rename a perfectly valid session folder into
// auth-backups/ (e.g. a stall-triggered "archive" or a mid-pairing restart).
// On boot, if the live folder is empty but a structurally-complete session
// sits in a backup, bring it back so the bot reconnects as the same device
// instead of forcing the operator to pair again. Never restore a logged-out
// backup (401) — that would resurrect a device WhatsApp explicitly unlinked.
function restoreUsableSessionFromBackups() {
  if (process.env.SAFFUL_NO_AUTO_RESTORE === 'true') return false;
  if (hasSavedSession()) return false;
  let candidates = [];
  try {
    candidates = fs.readdirSync(AUTH_BACKUP_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !/^logged-out-/.test(entry.name))
      .map((entry) => ({ name: entry.name, dir: path.join(AUTH_BACKUP_DIR, entry.name) }))
      .sort((a, b) => fs.statSync(b.dir).mtimeMs - fs.statSync(a.dir).mtimeMs);
  } catch {
    return false; // no backups exist
  }
  for (const candidate of candidates) {
    try {
      const creds = JSON.parse(fs.readFileSync(path.join(candidate.dir, 'creds.json'), 'utf8'));
      if (!isUsableSession(creds)) continue;
      fs.rmSync(AUTH_DIR, { recursive: true, force: true, maxRetries: 2 });
      fs.renameSync(candidate.dir, AUTH_DIR);
      authLog(`[auth] Recovered the previously-archived session ('${candidate.name}') — reconnecting as the same device. No pairing needed.`);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

function archiveIncompleteSession() {
  // Only truly broken creds (unparseable / no crypto material at all) reach
  // this point, because isUsableSession now accepts structurally-complete
  // sessions even when `registered` is still false. Never archive a folder
  // that contains usable material — that is what cleared valid sessions on
  // restart. Move only garbage aside so Baileys starts from a clean folder.
  if (!fs.existsSync(CREDS_FILE) || hasSavedSession()) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(AUTH_BACKUP_DIR, `incomplete-session-${stamp}`);
  fs.mkdirSync(AUTH_BACKUP_DIR, { recursive: true });
  fs.renameSync(AUTH_DIR, backup);
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  authLog('[auth] Archived unreadable credentials and started a fresh login flow.');
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
  process.stdout.write('[auth] fetching live WhatsApp-Web revision…\n')
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
    authLog(`[auth] Live WhatsApp-Web revision: ${version.join('.')}`);
  } catch {
    // `patch-baileys-version.js` supplies a last-known-good fallback for hosts
    // which cannot reach WhatsApp Web at startup.
    authLog('[auth] Could not refresh the WhatsApp Web revision; using the bundled fallback.');
  }
  process.stdout.write('[auth] revision resolved\n')
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
  const restored = restoreUsableSessionFromBackups();
  process.stdout.write(`[boot] auth-prep: session=${hasSavedSession() ? 'existing' : 'fresh'}${restored ? ' (recovered from backup)' : ''} method=${configuredMethod() || 'auto'}\n`)

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
      authLog('[auth] PAIRING_NUMBER is required for pairing on a non-interactive host. Falling back to QR login.');
      method = 'qr';
    } else {
      global.__saffulPairingNumber = number;
      authLog('[auth] Pairing-code login selected. The code will be printed in this server console.');
      authLog(`[auth] Pairing target: ${maskedNumber(number)}. It must be the same WhatsApp account entering the code.`);
    }
  }

  global.__saffulAuthMethod = method;
  if (method === 'qr') {
    if (process.env.SAFFUL_AUTH_FALLBACK_FROM_PAIRING === 'true') {
      authLog('[auth] Pairing-code login was rejected by WhatsApp. Switched to QR login for this fresh session.');
    }
    authLog('[auth] QR login selected. Open the bot QR page after startup.');
  }
}

// Branded pairing code, mirroring Levanter's approach: WhatsApp accepts any
// client-generated 8-character code (the server validates the key derived
// from whatever the user types), so make ours unmistakable and easy to type.
function generateSaffulPairingCode() {
  const base = 'SAFFULBT';
  const substitutions = { S: '5', A: '4', B: '8' };
  const chars = base.split('');
  const candidates = [];
  chars.forEach((char, index) => {
    if (substitutions[char]) candidates.push(index);
  });
  if (candidates.length > 0) {
    const index = candidates[Math.floor(Math.random() * candidates.length)];
    chars[index] = substitutions[chars[index]];
  }
  return chars.join('');
}

// The code is the one piece of information the operator must copy by hand
// from a busy server log into the phone. Print it alone, boxed, and spell out
// the digit look-alikes (S/5, A/4, B/8) so a typo never masquerades as a
// broken pairing flow — exactly why Levanter's site shows its code big and
// centred instead of buried in log lines.
function printPairingCodeBanner(rawCode) {
  const line = '='.repeat(52);
  const output = [
    '',
    line,
    '  SAFFUL-MD — ENTER THIS CODE ON YOUR PHONE',
    line,
    '',
    `         ★★   ${rawCode}   ★★`,
    '',
    '  WhatsApp  >  Linked devices  >  Link a device',
    '              >  Link with phone number instead',
    '',
    '  Type all 8 characters EXACTLY (no dashes, no spaces).',
    '  Watch the look-alikes:  S vs 5,  A vs 4,  B vs 8.',
    '  The code expires in 2 minutes.',
    line,
    '',
  ].join('\n');
  authLog(output);
  // The scannable QR art is buffered by index.js (pairing mode). Print it
  // right after this banner so a remote operator can scan it — the /qr
  // localhost link is useless on a VPS/panel.
  global.__saffulPairingBannerPrinted = true;
  const pendingQrArt = global.__saffulPendingQrArt;
  if (pendingQrArt) {
    global.__saffulPendingQrArt = null;
    try { fs.writeSync(1, '\n' + pendingQrArt + '\n'); } catch {}
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

      // The legacy core restarts its stream after a successful pairing (status
      // 515 'Stream Errored (restart required)') and creates a NEW socket via
      // this same wrapped factory. The boot watchdog and connect banner in
      // index.js are bound to the FIRST socket's ev, which never reaches
      // 'open' again after that restart. Track any socket that opens so a
      // fully-connected bot is never killed or left unannounced.
      global.__saffulLatestSocket = socket;
      try {
        socket.ev?.on?.('connection.update', ({ connection } = {}) => {
          if (connection === 'open') global.__saffulSocketOpened = true;
        });
      } catch {}

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
            authLog('[auth] Linked device was logged out. Archived its stale credentials and restarting a fresh login flow.');
            setTimeout(() => process.exit(1), 250).unref?.();
          } catch (error) {
            authLog('[auth] Could not reset the logged-out session:', error.message || error);
          }
        });
      }

      if (!number || linked || global.__saffulPairingScheduled) return socket;
      global.__saffulPairingScheduled = true;

      let requested = false;
      let pairingReady = false;
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

      // WhatsApp silently rejects a pairing-code request (companion_hello)
      // sent before the server has finished registering this socket. The code
      // still prints — because rc14 generates it locally before the stanza is
      // even acknowledged — and the phone then says "couldn't link device".
      // The server's pair-device stanza (which also produces the QR) is the
      // reliable readiness signal, so wait for it instead of a blind delay.
      const armReadinessWait = () => {
        pairingReady = false;
        if (requested) return;
        clearTimeout(fallbackTimer);
        fallbackTimer = setTimeout(() => {
          if (requested || pairingReady) return;
          pairingReady = true;
          authLog('[auth] Registration readiness was not confirmed by the server; requesting the pairing code anyway.');
          void requestCode();
        }, 15000);
      };

      const requestCode = async () => {
        if (requested || global.__saffulPairingRequested) return;
        if (!pairingReady) return;
        requested = true;
        try {
          const code = await socket.requestPairingCode(number, generateSaffulPairingCode());
          global.__saffulPairingRequested = true;
          clearTimers();
          const rawCode = String(code).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
          printPairingCodeBanner(rawCode);
          authLog('[pairing] Code requested from WhatsApp. Waiting for you to enter it on the phone…');
          codeExpiryTimer = setTimeout(() => {
            authLog('[pairing] No confirmation within two minutes — the code has expired.');
            authLog('[pairing] Restart the bot for ONE fresh code. Do not retry rapidly: WhatsApp blocks the account from pairing after repeated failed attempts.');
          }, 2 * 60 * 1000);
        } catch (error) {
          requested = false;
          const message = String(error?.message || error);
          if (/connection closed|not open|connection terminated/i.test(message) && attempts < 2) {
            attempts += 1;
            retryTimer = setTimeout(() => {
              armReadinessWait();
              void requestCode();
            }, 2000);
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
        authLog('[pairing] The phone accepted the code and started the handshake — finalizing…');
      });

      socket.ev.on('connection.update', (update = {}) => {
        const connection = String(update.connection || '');
        if (connection && connection !== reportedConnection) {
          reportedConnection = connection;
          authLog(`[auth] Pairing connection state: ${connection}`);
        }
        if (update.isNewLogin) {
          authLog('[pairing] WhatsApp confirmed the new device — finalizing Safful-Md…');
        }
        if (update.hasQR || update.qr) {
          // pair-device arrived: the companion registration is complete, so
          // WhatsApp is now willing to accept a pairing-code request.
          pairingReady = true;
          clearTimeout(fallbackTimer);
          void requestCode();
        }
        if (connection === 'open') {
          clearTimers();
          authLog('[pairing] Pairing completed — Safful-Md is online.');
        }
        if (connection === 'close' && global.__saffulPairingRequested) {
          clearTimers();
          const reason = String(update.lastDisconnect?.error?.message || 'WhatsApp closed the pairing stream.');
          const status = disconnectStatusCode(update.lastDisconnect?.error);
          const hints = {
            401: ' The account rejected this link (device limit reached, or the session was logged out). Unlink an old device in WhatsApp, or use QR login.',
            403: ' WhatsApp blocked this login attempt. Use QR login, or wait before retrying.',
            428: ' WhatsApp is currently restricting new device links for this number. This can last 24+ hours; repeated attempts prolong it. QR login still works.',
          };
          authLog(`[auth] Pairing connection closed${status ? ` (status ${status})` : ''}: ${reason}${hints[status] || ''}`);
          // A transient network drop invalidates the pending code before the
          // phone accepts it — the phone then says "couldn't link device" even
          // though the code was correct. Re-request ONE fresh code, but never
          // auto-retry a deliberate rejection (logout / block / 24h
          // restriction): retrying those only prolongs the restriction.
          if (!credentialsReported && !update.isNewLogin && status !== 401 && status !== 403 && status !== 428 && attempts < 2) {
            attempts += 1;
            requested = false;
            global.__saffulPairingRequested = false;
            authLog('[pairing] Connection dropped before the code was accepted — requesting a fresh code shortly…');
            retryTimer = setTimeout(() => {
              armReadinessWait();
              void requestCode();
            }, 5000);
          }
        }
      });

      armReadinessWait();

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
