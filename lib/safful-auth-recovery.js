const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const AUTH_DIRECTORY = path.join(__dirname, 'Suhail_Baileys');
const BACKUP_DIRECTORY = path.join(__dirname, 'auth-backups');
const RECOVERY_STATE = path.join(__dirname, 'safful-auth-recovery.json');
const RECOVERY_WINDOW_MS = 15 * 60 * 1000;
const MAX_RECOVERIES_PER_WINDOW = 1;

function hasRegisteredSession() {
  try {
    const credentials = JSON.parse(fs.readFileSync(path.join(AUTH_DIRECTORY, 'creds.json'), 'utf8'));
    return Boolean(credentials?.account && credentials?.me?.id && credentials?.advSecretKey);
  } catch {
    return false;
  }
}

function readRecoveryState() {
  try {
    const state = JSON.parse(fs.readFileSync(RECOVERY_STATE, 'utf8'));
    if (Date.now() - Number(state?.startedAt || 0) < RECOVERY_WINDOW_MS) return state;
  } catch {}
  return { attempts: 0, startedAt: Date.now() };
}

function writeRecoveryState(state) {
  fs.writeFileSync(RECOVERY_STATE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function clearRecoveryState() {
  // `unlinkSync` does not support a `force` option.  On a normal first start
  // this marker is absent, so treating that as an error caused the root bot to
  // restart itself in a tight loop before it could connect.
  try {
    fs.unlinkSync(RECOVERY_STATE);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function canRecoverFreshSession() {
  if (process.env.SAFFUL_AUTH_AUTORECOVER === 'false') return false;
  if (!['pairing', 'qr'].includes(global.__saffulAuthMethod)) return false;
  if (hasRegisteredSession()) return false;
  return readRecoveryState().attempts < MAX_RECOVERIES_PER_WINDOW;
}

function archiveFailedAuth() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(BACKUP_DIRECTORY, `auto-recovery-${stamp}`);
  fs.mkdirSync(BACKUP_DIRECTORY, { recursive: true });
  if (fs.existsSync(AUTH_DIRECTORY)) fs.renameSync(AUTH_DIRECTORY, backup);
  fs.mkdirSync(AUTH_DIRECTORY, { recursive: true });
  return backup;
}

function restartFreshLogin(exit) {
  const state = readRecoveryState();
  state.attempts += 1;
  if (!state.startedAt) state.startedAt = Date.now();
  writeRecoveryState(state);
  archiveFailedAuth();

  const useQrFallback = global.__saffulAuthMethod === 'pairing' && global.__saffulPairingRequested === true;
  const childEnvironment = { ...process.env };
  if (useQrFallback) {
    // WhatsApp may generate a pairing code and still reject its companion
    // handshake. Never loop on that rejected partial state: retain pairing as
    // an explicit login option, but recover this failed attempt via QR.
    childEnvironment.AUTH_METHOD = 'qr';
    childEnvironment.SAFFUL_AUTH_FALLBACK_FROM_PAIRING = 'true';
    delete childEnvironment.PAIRING_NUMBER;
    console.warn('[auth] Pairing code was rejected. Resetting temporary auth state and switching this attempt to QR login.');
  } else {
    console.warn('[auth] Fresh login failed. Resetting its temporary auth state and restarting the login flow once.');
  }
  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'index.js')], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: 'inherit',
    env: childEnvironment,
    windowsHide: false,
  });
  child.once('error', (error) => {
    console.error('[auth] Automatic login restart failed:', error.message || error);
    exit(1);
  });
  child.unref();
  setTimeout(() => exit(0), 250);
}

function restartSavedSession(exit) {
  console.log('[auth] Pairing completed. Restarting with the newly saved session.');
  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'index.js')], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: 'inherit',
    // The connected pairing bootstrap has just saved a valid local session.
    // This internal handoff must not be mistaken for a user-run `npm start`,
    // which intentionally clears credentials for a brand-new pairing.
    env: { ...process.env, SAFFUL_PRESERVE_AUTH_ON_RESTART: 'true' },
    windowsHide: false,
  });
  child.once('error', (error) => {
    console.error('[auth] Saved-session restart failed:', error.message || error);
    exit(1);
  });
  child.unref();
  setTimeout(() => exit(0), 250);
}

function installAuthRecovery() {
  if (process.__saffulAuthRecoveryInstalled) return;
  process.__saffulAuthRecoveryInstalled = true;
  const originalExit = process.exit.bind(process);
  let recovering = false;

  process.exit = (code = 0) => {
    if (recovering) return originalExit(code);
    recovering = true;
    try {
      if (hasRegisteredSession() && ['pairing', 'qr'].includes(global.__saffulAuthMethod)) {
        restartSavedSession(originalExit);
      } else if (canRecoverFreshSession()) {
        restartFreshLogin(originalExit);
      } else {
        originalExit(code);
      }
    } catch (error) {
      console.error('[auth] Automatic login reset failed:', error.message || error);
      originalExit(code || 1);
    }
  };
}

module.exports = { installAuthRecovery, clearRecoveryState, hasRegisteredSession };
