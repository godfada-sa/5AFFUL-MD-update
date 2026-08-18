#!/usr/bin/env node
/*
 * Safful-Md — multi-session launcher
 * ----------------------------------
 * Runs two (or more) independent Safful-Md instances inside ONE server:
 *   - Device A runs from this folder (the same code the panel already runs).
 *   - Device B (and any extra sessions) runs from a sub-folder that this
 *     launcher creates automatically on first start.
 *
 * Each instance keeps its own .env, its own WhatsApp session
 * (lib/Suhail_Baileys), its own SUDO/OWNER_NUMBER and its own PORT, so the
 * two accounts never intercept each other. They are separate processes with
 * separate environments — the same isolation you get from two servers.
 *
 * Usage (Pterodactyl / nodejs panel):
 *   1. Copy this file next to index.js (the container root).
 *   2. In the Startup tab set  MAIN_FILE=launcher.js
 *   3. Start the server. On first boot the launcher creates <root>/bot-b/
 *      with a fresh .env template and prints what to edit.
 *   4. Both pairing codes print to the same console, tagged [A] / [B].
 *
 * Environment controls:
 *   SAFFUL_BOT_ROOT        bot root folder (default: this file's folder)
 *   SAFFUL_MULTI_SESSIONS  comma list of relative session dirs; an empty
 *                          entry means the root itself.
 *                          Default: ",bot-b"  (root + bot-b)
 *   SAFFUL_MULTI_RESPAWN   "false" disables auto-restart of exited bots
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(process.env.SAFFUL_BOT_ROOT || __dirname);
const DEFAULT_SESSIONS = ',bot-b';
const RESPAWN_DELAY_MS = 5000;
const RESPAWN = String(process.env.SAFFUL_MULTI_RESPAWN || 'true').toLowerCase() !== 'false';

// Everything that must NOT be copied when provisioning a new session folder.
const EXCLUDE_PROVISION = new Set([
  'node_modules',
  '.git',
  'temp',
  'release-protected',
  'release-protected.rar',
  'safful-webjs',
  '.safful-tools',
  '.freebuff',
  'session-qr.png',
  '.env',
  'bot.stderr.log',
  'bot.stdout.log',
  'bot.stderr.latest.log',
  'bot.stdout.latest.log',
  'multi-session',
]);

const ENV_TEMPLATE = `# ============================================================
#  Safful-Md — DEVICE B (second session on this server)
#  Edit these for the SECOND WhatsApp account, save, then restart.
# ============================================================
OWNER_NUMBER=233XXXXXXXXX
SUDO=233XXXXXXXXX
OWNER_NAME=Safful
BOT_NAME=Safful-Md-B
PREFIX=.
MODE=private
PORT=8002
TZ=Africa/Accra
SAFFUL_SELF_HOSTED=true
SAFFUL_PRESERVE_DM_NOTIFICATIONS=true
READ_MESSAGE=false
READ_COMMAND=false
WAPRESENCE=unavailable
AUTH_METHOD=pairing
PAIRING_NUMBER=233XXXXXXXXX
`;

const children = [];
let shuttingDown = false;

function sessions() {
  const list = String(process.env.SAFFUL_MULTI_SESSIONS || DEFAULT_SESSIONS)
    .split(',')
    .map((s) => s.trim());
  // Keep at most one "" (root) entry, first wins.
  const seen = new Set();
  return list.filter((s) => {
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  });
}

function provisionSession(dir) {
  const dest = path.join(ROOT, dir);
  if (fs.existsSync(path.join(dest, 'index.js'))) return false; // already provisioned

  fs.mkdirSync(dest, { recursive: true });

  for (const entry of fs.readdirSync(ROOT)) {
    if (entry === dir || entry.endsWith('.log')) continue;
    if (EXCLUDE_PROVISION.has(entry)) continue;
    const src = path.join(ROOT, entry);
    const dst = path.join(dest, entry);
    try {
      fs.cpSync(src, dst, { recursive: true });
    } catch (error) {
      console.log(`[setup] skipped ${entry}: ${error.message || error}`);
    }
  }

  // Never inherit device A's session or config.
  fs.rmSync(path.join(dest, 'lib', 'Suhail_Baileys'), { recursive: true, force: true });
  fs.rmSync(path.join(dest, 'lib', 'auth-backups'), { recursive: true, force: true });
  fs.rmSync(path.join(dest, 'lib', 'store.json'), { force: true });
  fs.rmSync(path.join(dest, '.env'), { force: true });

  // Share the installed node_modules instead of duplicating hundreds of MB.
  const nmSrc = path.join(ROOT, 'node_modules');
  const nmDst = path.join(dest, 'node_modules');
  if (fs.existsSync(nmSrc)) {
    try {
      fs.symlinkSync(nmSrc, nmDst, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      fs.cpSync(nmSrc, nmDst, { recursive: true });
      console.log(`[setup] could not symlink node_modules into ${dir}/ — copied it instead.`);
    }
  }

  fs.writeFileSync(path.join(dest, '.env'), ENV_TEMPLATE);
  return true;
}

function spawnBot(label, dir) {
  const cwd = dir ? path.join(ROOT, dir) : ROOT;
  const tag = `[${label}]`;
  const child = spawn(process.execPath, ['index.js'], {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (d) => process.stdout.write(`${tag} ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`${tag} ${d}`));
  child.on('error', (err) => console.error(`${tag} failed to spawn: ${err.message}`));
  child.on('exit', (code, signal) => {
    if (shuttingDown || !RESPAWN) return;
    console.log(`${tag} exited (code=${code} signal=${signal}) — restarting in ${RESPAWN_DELAY_MS / 1000}s`);
    setTimeout(() => spawnBot(label, dir), RESPAWN_DELAY_MS);
  });

  children.push(child);
  return child;
}

function stopAll(code) {
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 300).unref();
}

function main() {
  if (!fs.existsSync(path.join(ROOT, 'index.js'))) {
    console.error(`[launcher] FATAL: no index.js found at ${ROOT}`);
    console.error('[launcher] Place launcher.js next to the bot\'s index.js, or set SAFFUL_BOT_ROOT.');
    process.exit(1);
  }

  const list = sessions();
  if (list.length === 0) {
    console.error('[launcher] FATAL: SAFFUL_MULTI_SESSIONS resolved to no sessions.');
    process.exit(1);
  }

  const labels = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  list.forEach((dir, i) => {
    const label = labels[i] || `S${i + 1}`;
    if (dir && provisionSession(dir)) {
      console.log(`[setup] Created ${dir}/ with a fresh .env template.`);
      console.log(`[setup] Edit ${path.join(dir, '.env')} with the SECOND account's SUDO / OWNER_NUMBER / PAIRING_NUMBER / PORT, then restart the server.`);
    }
    spawnBot(label, dir);
  });

  console.log(`[launcher] ${list.length} session(s) starting from ${ROOT}`);
}

process.on('SIGTERM', () => stopAll(0));
process.on('SIGINT', () => stopAll(0));

main();
