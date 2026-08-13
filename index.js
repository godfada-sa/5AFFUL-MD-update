// Must run before anything requires @whiskeysockets/baileys:
// sets the current WhatsApp client version so QR registration works.
// `npm start` is deliberately a fresh-login entry point. The only exception is
// the internal post-pairing handoff, which keeps the credentials created a few
// moments earlier so the bot can finish starting.
process.env.SAFFUL_DISABLE_SESSION_ID = 'true'
const { resetLocalAuthForFreshStart } = require(__dirname + '/lib/safful-auth-method')
if (process.env.SAFFUL_PRESERVE_AUTH_ON_RESTART !== 'true') {
  resetLocalAuthForFreshStart()
}
require(__dirname + '/patch-baileys-version.js')
require(__dirname + '/lib/brand-console')
require(__dirname + '/lib/safful-history-mode')

// Some Signal-session internals in the legacy stack write ratchet state
// directly to console.log. Those records are not useful operational logs and
// may contain sensitive cryptographic session material. Keep normal logging
// intact, but suppress only those specific debug dumps.
function suppressSensitiveSignalSessionLogs() {
  const suppressible = /^(Closing session:|Removing old closed session:)/
  const installFilter = (method) => {
    const original = console[method].bind(console)
    console[method] = (...values) => {
      const label = typeof values[0] === 'string' ? values[0] : ''
      if (suppressible.test(label)) {
        // libsignal emits this with console.info and includes ratchet keys.
        // Do not print that material into terminals or process logs.
        console.log('[security] Suppressed sensitive Signal-session debug output.')
        return
      }
      original(...values)
    }
  }

  installFilter('log')
  installFilter('info')
}
suppressSensitiveSignalSessionLogs()

const { prepareAuthentication } = require(__dirname + '/lib/safful-auth-method')
const { installAuthRecovery, clearRecoveryState } = require(__dirname + '/lib/safful-auth-recovery')
installAuthRecovery()

const { VERSION } = require(__dirname + '/config')
const attachProtection = require(__dirname + '/lib/safful-protection')
const autoView = require(__dirname + '/plugins/statusauto.smd')
const statusSave = require(__dirname + '/lib/safful-status-save')
const attachRawDispatcher = require(__dirname + '/lib/safful-raw-dispatcher')

function rebrandMessage(value) {
  if (typeof value === 'string') {
    // Apply branding at the final send boundary. This also covers labels that
    // still live inside legacy/obfuscated plugins (such as the song downloader).
    // Do not rewrite URLs: changing a legacy source URL could make media fail.
    if (/^https?:\/\//i.test(value)) return value;
    const replacement = (match) => /(?:md|ᴍᴅ)/i.test(match) ? 'Safful-Md' : 'Safful';
    return value
      .replace(/only[_\s-]*one[_\s-]*empire/gi, 'Safful')
      .replace(/suhail\s*tech\s*info/gi, 'Safful')
      .replace(/suhail(?:[-_ ]*md)?/gi, replacement)
      .replace(/empire(?:[-_ ]*md)?/gi, replacement)
      .replace(/s[ᴜu][ʜh][ᴀa][ɪi][ʟl](?:[-_ ]?[ᴍm][ᴅd])?/gi, replacement)
      .replace(/[ᴇe][ᴍm][ᴘp][ɪi][ʀr][ᴇe](?:[-_ ]?[ᴍm][ᴅd])?/gi, replacement);
  }
  if (Array.isArray(value)) return value.map(rebrandMessage);
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebrandMessage(item)]));
}

function rebrandSocket(sock) {
  if (!sock?.sendMessage || sock.__saffulBrandingAttached) return;
  sock.__saffulBrandingAttached = true;
  const sendMessage = sock.sendMessage.bind(sock);
  sock.sendMessage = (chatId, content, options) => sendMessage(chatId, rebrandMessage(content), options);
  console.log('[branding] Safful outgoing-message branding is active');
}

const start = async () => {
  let bot
  try {
    await prepareAuthentication()
    if (global.__saffulAuthMethod === 'existing') clearRecoveryState()
    // The legacy core owns its socket for the entire login lifecycle. The
    // pairing hook in safful-auth-method requests the code from that exact
    // socket, matching MEGA-MD's working one-socket pairing flow.  Creating a
    // short-lived bootstrap socket here caused WhatsApp to reject the stream
    // before the real bot socket could take over.
    bot = require(__dirname + '/lib/smd')
    console.log(`Safful ${VERSION}`)
    await bot.init()
    bot.logger.info('⏳ Database syncing!')
    await bot.DATABASE.sync()
    const socket = await bot.connect()
    rebrandSocket(socket)
    // These features need raw Baileys events (deletions and statuses), but
    // they share one dispatcher so commands are never delayed by duplicate
    // event listeners scanning the same incoming message.
    attachRawDispatcher(socket, { attachProtection, autoView, statusSave })
  } catch (error) {
    console.error('[startup] Failed to start Safful-Md:', error);
    // A rejected pairing code must not generate an endless stream of new
    // partial sessions. The operator can retry deliberately after WhatsApp
    // allows new-device pairing again, or choose QR from a fresh start.
    if (global.__saffulAuthMethod === 'pairing') return
    // Avoid a CPU-heavy recursive restart loop when a non-auth startup error
    // occurs. The error remains visible and a deliberate retry follows.
    setTimeout(() => void start(), 3000).unref?.();
  }
}
start();
