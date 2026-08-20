const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, 'safful-status-save.json');

function readSettings() {
  try {
    return { enabled: false, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {
    return { enabled: false };
  }
}

function writeSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function setEnabled(enabled) {
  const settings = { ...readSettings(), enabled: Boolean(enabled) };
  writeSettings(settings);
  return settings.enabled;
}

function sudoJid() {
  const number = String(process.env.SUDO || global.sudo || process.env.OWNER_NUMBER || global.owner || '').replace(/\D/g, '');
  return number ? `${number}@s.whatsapp.net` : null;
}

function attach(socket) {
  if (!socket || socket.__saffulStatusSaveAttached) return;
  socket.__saffulStatusSaveAttached = true;
  console.log('[savestatus] raw status monitoring attached');

  const handleMessagesUpsert = async ({ messages }) => {
    if (!readSettings().enabled) return;
    const recipient = sudoJid();
    if (!recipient) return;

    for (const message of messages || []) {
      if (message?.key?.remoteJid !== 'status@broadcast' || message.key.fromMe) continue;
      try {
        await socket.copyNForward(recipient, message, true);
        await socket.sendMessage(recipient, {
          text: `*SAFFUL STATUS SAVE*\nFrom: ${message.key.participant || 'Unknown'}\nStatus was saved.`,
        });
      } catch (error) {
        console.error('[savestatus] failed:', error.message || error);
      }
    }
  };

  if (socket.__saffulRawDispatcher?.onUpsert) {
    socket.__saffulRawDispatcher.onUpsert(handleMessagesUpsert);
  } else {
    socket.ev.on('messages.upsert', handleMessagesUpsert);
  }
}

module.exports = { attach, getEnabled: () => readSettings().enabled, setEnabled };
