const fs = require('fs');
const path = require('path');
const Config = require('../config');

const STATE_FILE = path.join(__dirname, 'safful-mode.json');
const MODES = new Set(['public', 'private']);

function normalizeMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return MODES.has(mode) ? mode : 'public';
}

function readSavedMode() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return normalizeMode(saved.mode);
  } catch (_) {
    return normalizeMode(Config.WORKTYPE);
  }
}

let currentMode = readSavedMode();

function applyMode(mode) {
  currentMode = normalizeMode(mode);
  global.SAFFUL_WORKTYPE = currentMode;
  process.env.WORKTYPE = currentMode;
  Config.WORKTYPE = currentMode;
  return currentMode;
}

function getMode() {
  return applyMode(global.SAFFUL_WORKTYPE || currentMode);
}

function setMode(mode) {
  const nextMode = applyMode(mode);
  const temporaryFile = `${STATE_FILE}.tmp`;

  try {
    fs.writeFileSync(temporaryFile, JSON.stringify({ mode: nextMode }, null, 2));
    fs.renameSync(temporaryFile, STATE_FILE);
  } catch (error) {
    try { fs.unlinkSync(temporaryFile); } catch (_) {}
    throw error;
  }

  return nextMode;
}

function digits(value) {
  return String(value || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

function ownerNumbers() {
  return [
    global.owner,
    global.devs,
    global.sudo,
    process.env.OWNER_NUMBER,
    process.env.DEVS,
    process.env.SUDO,
  ]
    .flatMap((entry) => String(entry || '').split(/[\s,;]+/))
    .map(digits)
    .filter(Boolean);
}

function isOwner(message = {}, context = {}) {
  if (message.fromMe || context.isCreator) return true;

  const owners = new Set(ownerNumbers());
  const key = message.key || message.fakeObj?.key || {};
  const candidates = [
    message.sender,
    message.senderNum,
    message.participant,
    key.participant,
    key.remoteJid,
  ];

  return candidates.some((candidate) => owners.has(digits(candidate)));
}

applyMode(currentMode);

module.exports = { getMode, setMode, isOwner, normalizeMode, STATE_FILE };
