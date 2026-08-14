// Must run before anything requires @whiskeysockets/baileys:
// sets the current WhatsApp client version so QR registration works.
// Persist the local Baileys credentials across normal restarts. A fresh login
// happens only when no usable local session exists (or when the user removes
// the credential folder deliberately).
process.env.SAFFUL_DISABLE_SESSION_ID = 'true'
require(__dirname + '/patch-baileys-version.js')
require(__dirname + '/lib/safful-optional-sharp')
require(__dirname + '/lib/brand-console')
require(__dirname + '/lib/safful-history-mode')
const { installOutgoingMessagePolicy, rebrandSocket } = require(__dirname + '/lib/safful-outgoing-message-policy')
installOutgoingMessagePolicy()
const preserveMobileNotifications = require(__dirname + '/lib/safful-mobile-notifications')
// Install before the legacy core is loaded. This makes its own listeners use
// the guarded socket rather than attaching the protection after login.
preserveMobileNotifications.installMobileNotificationGuard()

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
// Must run before the legacy core is required: deleted view-once media is
// downloaded from the untouched incoming envelope, not its later command copy.
attachProtection.installEarlyCaptureHook()
const autoView = require(__dirname + '/plugins/statusauto.smd')
const statusSave = require(__dirname + '/lib/safful-status-save')
const attachRawDispatcher = require(__dirname + '/lib/safful-raw-dispatcher')

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
    preserveMobileNotifications(socket)
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
