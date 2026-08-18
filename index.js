// ---------------------------------------------------------------------------
// Node engine guard. The bundled Baileys rc14 is ESM-only ("type": "module")
// and require() of ES modules needs Node 22.12+/23+ (backported to 20.19+).
// Node 21 and older 20.x crash with ERR_REQUIRE_ESM the moment the core loads
// baileys, so print an actionable message instead of a raw stack trace.
// ---------------------------------------------------------------------------
function saffulCheckNodeVersion() {
  const [major, minor] = String(process.versions.node || '').split('.').map(Number)
  const supported = major >= 23 || (major === 22 && minor >= 12) || (major === 20 && minor >= 19)
  if (supported) return
  process.stdout.write(
    '\n============================================================\n' +
    '  SAFFUL-MD: unsupported Node.js version (' + process.versions.node + ')\n' +
    '  This bot needs Node.js 22.12+ (or 20.19+/23+) because its Baileys\n' +
    '  core is ESM-only and must be loaded with require(esm). Node 21 and\n' +
    '  older 20.x cannot run it (ERR_REQUIRE_ESM).\n' +
    '  Fix: in your hosting panel change the Node image to 22+ and restart.\n' +
    '  Pterodactyl image: ghcr.io/parkervcp/yolks:nodejs_22\n' +
    '============================================================\n'
  )
  process.exit(1)
}
saffulCheckNodeVersion()

const fs = require('fs')
const path = require('path')

// ── Temp File Cleanup ────────────────────────────────────────────────────
// On startup, remove stale temp files left behind by sticker/audio processing
// (lib/exif.js) that weren't cleaned up after a previous crash. Only files
// older than 1 hour are removed to avoid deleting files from a concurrent run.
// ──────────────────────────────────────────────────────────────────────────
try {
  const tempDir = path.join(__dirname, 'temp')
  if (fs.existsSync(tempDir)) {
    const cutoff = Date.now() - 60 * 60 * 1000  // 1 hour
    for (const name of fs.readdirSync(tempDir)) {
      if (name === '.gitkeep' || name === '.gitignore') continue
      try {
        const fp = path.join(tempDir, name)
        const stat = fs.statSync(fp)
        if (stat.isFile() && stat.mtimeMs < cutoff) fs.unlinkSync(fp)
      } catch {}
    }
  }
} catch {}

// ---------------------------------------------------------------------------
// Real-time log streaming. Hosting panels (Pterodactyl, PM2, docker) capture
// process output through a pipe, and Node buffers pipe writes asynchronously:
// while the pairing handshake is running the event loop is busy with crypto,
// so queued log lines can arrive seconds late — or all at once after login.
// Writing straight to fd 1/2 synchronously makes every line appear the moment
// it is produced. This also covers console.log / global.print downstream.
// ---------------------------------------------------------------------------
function __saffulSyncWrite(fd, chunk) {
  try {
    let out = chunk
    if (typeof out === 'string' && __saffulIsQrArt(out)) {
      // WhatsApp issues a fresh QR every ~20-30s and the core re-renders the
      // full ASCII block each time (on stdout AND stderr, so PM2 doubles it).
      // Show the art exactly once. In pairing mode the art is held back and
      // printed right after the pairing-code banner — a localhost /qr link is
      // useless on a remote panel — then refreshes stay silent.
      const pairingMode = String(process.env.AUTH_METHOD || '').trim().toLowerCase() === 'pairing'
      if (pairingMode) {
        if (__saffulQrArtShown) return
        __saffulQrArtShown = true
        if (global.__saffulPairingBannerPrinted) {
          // Banner already out; emit the art immediately after it.
          out = '\n' + out + '\n'
        } else {
          // Banner not printed yet — hold the art so it can follow it.
          global.__saffulPendingQrArt = out
          return
        }
      }
    }
    if (typeof out === 'string') fs.writeSync(fd, out)
    else if (Buffer.isBuffer(out)) fs.writeSync(fd, out)
    else fs.writeSync(fd, String(out))
  } catch { /* never let logging break the bot */ }
}
let __saffulQrArtShown = false
function __saffulIsQrArt(chunk) {
  if (typeof chunk !== 'string') return false
  const lines = chunk.split('\n')
  if (lines.length < 5) return false
  let artLines = 0
  for (const line of lines) {
    const stripped = line.replace(/\s/g, '')
    if (!stripped) continue
    // QR terminal art is made only of block/half-block characters. Text
    // banners (SAFFUL-MD logo uses box-drawing glyphs) are not matched.
    if (/^[\u2580-\u259F\u25A0\u25A1]+$/.test(stripped)) artLines++
  }
  return artLines >= 5
}
process.stdout.write = (chunk) => { __saffulSyncWrite(1, chunk); return true }
process.stderr.write = (chunk) => { __saffulSyncWrite(2, chunk); return true }
// Must run before anything requires @whiskeysockets/baileys:
// sets the current WhatsApp client version so QR registration works.
// Persist the local Baileys credentials across normal restarts. A fresh login
// happens only when no usable local session exists (or when the user removes
// the credential folder deliberately).
// Loading a session string generated elsewhere (pair-on-a-website model) is
// disabled by default as a security measure. Opt in with
// SAFFUL_ENABLE_SESSION_ID=true + SESSION_ID=<session> to use that workflow.
if (process.env.SAFFUL_ENABLE_SESSION_ID !== 'true') process.env.SAFFUL_DISABLE_SESSION_ID = 'true'
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

// ── Global Error Handlers (uptime-safe) ──────────────────────────────────
// Uncaught exceptions still kill the process (can't safely continue), but
// unhandled rejections are logged and suppressed. Most rejections in WhatsApp
// bots are transient (failed message sends, stale references) and killing
// the process for them destroys uptime for no reason.
// ────────────────────────────────────────────────────────────────────────
let __saffulCrashCount = 0
const __saffulCrashWindow = 10 * 60 * 1000  // 10 minutes
let __saffulCrashWindowStart = Date.now()
process.on('uncaughtException', (error) => {
  const now = Date.now()
  if (now - __saffulCrashWindowStart > __saffulCrashWindow) {
    __saffulCrashCount = 0
    __saffulCrashWindowStart = now
  }
  __saffulCrashCount += 1
  process.stdout.write(`[uptime] UNCAUGHT EXCEPTION (crash #${__saffulCrashCount}): ${error?.stack || error}\n`)
  // Many uncaught exceptions are recoverable (plugin errors, stale refs).
  // Only kill the process if it's crashing in a tight loop (5+ in 10 min).
  if (__saffulCrashCount >= 5) {
    process.stdout.write('[uptime] Too many crashes in short window — exiting for PM2 backoff.\n')
    process.exit(1)
  }
  // Let the event loop continue — most exceptions are transient.
})
process.on('unhandledRejection', (reason) => {
  process.stdout.write(`[uptime] UNHANDLED REJECTION (suppressed): ${reason?.stack || reason}\n`)
  // Do NOT throw — let the bot keep running. Most rejections are transient.
})

const { prepareAuthentication } = require(__dirname + '/lib/safful-auth-method')
const { installAuthRecovery, clearRecoveryState } = require(__dirname + '/lib/safful-auth-recovery')
installAuthRecovery()

const Config = require(__dirname + '/config')
const { VERSION } = Config
const attachProtection = require(__dirname + '/lib/safful-protection')
// Must run before the legacy core is required: deleted view-once media is
// downloaded from the untouched incoming envelope, not its later command copy.
attachProtection.installEarlyCaptureHook()
process.stdout.write('[anti-delete] pre-core capture hook armed\n')
const autoView = require(__dirname + '/plugins/statusauto.smd')
const statusSave = require(__dirname + '/lib/safful-status-save')
const attachRawDispatcher = require(__dirname + '/lib/safful-raw-dispatcher')

// Rebuild the same login banner the legacy core prints, so the operator gets
// it privately once per process instead of only in the server console.
let connectedBannerSent = false
function connectedBannerText() {
  const handlers = Config.HANDLERS
  const prefa = !handlers || ['false', 'null', ' ', '', 'empty'].includes(String(handlers))
  const prefix = prefa ? '' : String(handlers)[0] || ''
  const pluginCount = Array.isArray(require(__dirname + '/lib/plugins').commands)
    ? require(__dirname + '/lib/plugins').commands.length
    : 0
  const mode = String(global.WORKTYPE || Config.WORKTYPE || 'private')
  const dbUrl = String(global.DATABASE_URL || '')
  let database = 'JSON(no db)'
  if (/^mongodb/i.test(dbUrl)) database = 'MongoDB'
  else if (/^postgres/i.test(dbUrl)) database = 'PostgreSQL'
  return [
    'Safful-Md Connected',
    '',
    `  Prefix  : [ ${prefix} ]`,
    `  Plugins : ${pluginCount}`,
    `  Mode    : ${mode}`,
    `  Database: ${database}`,
  ].join('\n')
}

function sudoRecipient() {
  const configured = String(process.env.SUDO || global.sudo || process.env.OWNER_NUMBER || global.owner || '')
  const number = configured.replace(/\D/g, '')
  return number ? `${number}@s.whatsapp.net` : null
}

function notifyConnectedOnce(socket) {
  if (connectedBannerSent || !socket?.ev?.on || typeof socket?.sendMessage !== 'function') return
  const recipient = sudoRecipient()
  if (!recipient) {
    process.stdout.write('[connect-banner] no sudo number configured, skipping\n')
    return
  }
  let warnedWaiting = false
  // The core replaces the socket after a successful pairing (status 515
  // restart), so the socket passed in here can go stale. Use the newest
  // socket the auth hook has seen for both the check and the send.
  const liveSocket = () =>
    (global.__saffulLatestSocket && typeof global.__saffulLatestSocket?.sendMessage === 'function'
      ? global.__saffulLatestSocket
      : socket)
  const sendBanner = async () => {
    if (connectedBannerSent) return
    const current = liveSocket()
    // Only send once the session is actually usable (logged-in user present).
    if (!current?.user?.id) {
      if (!warnedWaiting) {
        warnedWaiting = true
        process.stdout.write('[connect-banner] waiting for logged-in session before sending\n')
      }
      return false
    }
    try {
      process.stdout.write(`[connect-banner] sending connected message to ${recipient}\n`)
      await current.sendMessage(recipient, { text: connectedBannerText() })
      connectedBannerSent = true
      process.stdout.write('[connect-banner] connected message sent to sudo once\n')
      return true
    } catch (error) {
      process.stdout.write(`[connect-banner] send failed, will retry: ${error?.message || error}\n`)
      return false
    }
  }
  socket.ev.on('connection.update', ({ connection } = {}) => {
    if (connection === 'open') void sendBanner()
  })
  // Robust fallback: poll until the session is usable and the message lands,
  // up to ~60 seconds. The per-process flag guarantees exactly one send.
  let attempts = 0
  const retry = setInterval(() => {
    attempts += 1
    if (connectedBannerSent || attempts > 15) {
      clearInterval(retry)
      return
    }
    void sendBanner()
  }, 4000)
  retry.unref?.()
}

let bootPhase = 'auth-prep'
const start = async () => {
  let bot
  let lastConnectionState = ''
  try {
    await prepareAuthentication()
    if (global.__saffulAuthMethod === 'existing') clearRecoveryState()
    process.stdout.write(`[boot] auth method: ${global.__saffulAuthMethod || 'unknown'} (pairing number: ${global.__saffulPairingNumber || 'n/a'})\n`)

    bootPhase = 'core-load'
    process.stdout.write('[boot] loading core module…\n')
    // The legacy core owns its socket for the entire login lifecycle. The
    // pairing hook in safful-auth-method requests the code from that exact
    // socket, matching MEGA-MD's working one-socket pairing flow.  Creating a
    // short-lived bootstrap socket here caused WhatsApp to reject the stream
    // before the real bot socket could take over.
    bot = require(__dirname + '/lib/smd')
    process.stdout.write('[boot] core loaded\n')
    console.log(`Safful ${VERSION}`)

    bootPhase = 'session-init'
    process.stdout.write('[boot] initializing session…\n')
    await bot.init()
    process.stdout.write('[boot] session initialized\n')

    bootPhase = 'database-sync'
    process.stdout.write('[boot] syncing database…\n')
    bot.logger.info('⏳ Database syncing!')
    await bot.DATABASE.sync()
    process.stdout.write('[boot] database ready\n')

    bootPhase = 'socket-create'
    process.stdout.write('[boot] connecting to WhatsApp…\n')

    // One-line egress check so a blocked panel network is identified at once,
    // before the socket can sit in 'connecting' for minutes.
    try {
      const probe = await fetch('https://web.whatsapp.com', { method: 'HEAD', signal: AbortSignal.timeout(8000) })
      process.stdout.write(`[boot] WhatsApp reachable (HTTP ${probe.status})\n`)
    } catch (probeError) {
      process.stdout.write(`[boot] WARNING: cannot reach web.whatsapp.com — ${probeError?.message || probeError}\n`)
    }

    const socket = await bot.connect()
    process.stdout.write('[boot] socket created\n')

    // Stream the socket lifecycle to the panel even though the legacy core
    // runs Baileys with a silent logger and silences console.log.
    const reportConnection = (update = {}) => {
      const state = String(update.connection || '')
      if (!state || state === lastConnectionState) return
      lastConnectionState = state
      const error = update.lastDisconnect?.error
      const reason = error ? ` — ${error?.message || error}` : ''
      process.stdout.write(`[boot] connection state: ${state}${reason}\n`)
    }
    socket.ev?.on?.('connection.update', reportConnection)

    // Recovery watchdog: a socket that never reaches 'open' is either blocked
    // egress or a stale session. Never leave the bot silently dead.
    //
    // CRITICAL: the session folder is NEVER auto-archived here. Archiving is
    // what caused the 'already paired but cleared on restart' loop: a restart
    // right after the phone confirmed the link left `registered: false`, the
    // watchdog renamed the whole folder away, and the next boot asked to pair
    // again. Levanter never touches its session folder — neither do we. A
    // stalled socket just restarts the process with the session intact, and
    // Baileys re-registers on reconnect. If the operator wants a fresh login,
    // they delete lib/Suhail_Baileys themselves.
    //
    // Fresh logins (QR/pairing) get a longer window because they need human
    // time to open /qr and scan before the registration completes.
    const freshLogin = global.__saffulAuthMethod === 'pairing' || global.__saffulAuthMethod === 'qr'
    const stallTimeoutMs = 5 * 60 * 1000
    let opened = false
    const sessionLive = () => opened || global.__saffulSocketOpened === true
    const recoverStalledConnection = () => {
      if (sessionLive()) return
      process.stdout.write(
        freshLogin
          ? '[boot] still waiting for login (QR/pairing) after 5 minutes — restarting to refresh the login screen; session preserved.\n'
          : '[boot] connection did not open — restarting the process to retry; session preserved (never auto-cleared).\n',
      )
      process.exit(1)
    }
    const watchdog = setTimeout(recoverStalledConnection, stallTimeoutMs)
    watchdog.unref?.()
    socket.ev?.on?.('connection.update', ({ connection } = {}) => {
      if (connection === 'open') {
        opened = true
        clearTimeout(watchdog)
        process.stdout.write('[boot] connection open\n')
      }
    })
    const livenessPoll = setInterval(() => {
      if (!sessionLive()) return
      clearTimeout(watchdog)
      clearInterval(livenessPoll)
      if (!opened) process.stdout.write('[boot] session confirmed live on restarted socket — watchdog disarmed\n')
    }, 5000)
    livenessPoll.unref?.()

    bootPhase = 'attach-hooks'
    // Intercept Baileys at its emit boundary before the legacy message
    // listener sees a view-once envelope and rewrites it.
    attachProtection.installSocketRawCapture(socket)
    rebrandSocket(socket)
    preserveMobileNotifications(socket)
    // These features need raw Baileys events (deletions and statuses), but
    // they share one dispatcher so commands are never delayed by duplicate
    // event listeners scanning the same incoming message.
    attachRawDispatcher(socket, { attachProtection, autoView, statusSave })
    notifyConnectedOnce(socket)
    process.stdout.write('[boot] hooks attached — ready\n')

    // ── Uptime Guardian (MUST be last emit wrapper) ─────────────────────
    // WhatsApp forces a session rotation (status 515) every ~12-24 hours.
    // The obfuscated core catches this and calls process.exit(1), killing
    // the bot and resetting PM2 uptime. This guardian intercepts the
    // connection.update event at the EventEmitter boundary: for reconnectable
    // disconnects (515 restartRequired, 408 timedOut) it suppresses the event
    // so the core never sees it and never exits. Baileys handles reconnection
    // internally — the core just needs to not kill itself.
    //
    // CRITICAL: This MUST be installed AFTER preserveMobileNotifications and
    // installSocketRawCapture so it becomes the outermost emit wrapper. If
    // installed before them, their emit replacement would overwrite this
    // guardian and the suppression would stop working.
    //
    // BUG FIX: Only activate after the first successful connection. During
    // QR/pairing login, WhatsApp sends a 515 (restartRequired) as part of
    // the auth handshake — suppressing it blocks login from completing.
    // Once connected for the first time, we activate the guardian.
    //
    // Fatal disconnects (401 loggedOut, 403 forbidden, 411 mismatch, 440
    // replaced, 500 badSession) are left alone — those genuinely need a
    // restart.
    // ─────────────────────────────────────────────────────────────────────
    const RECONNECTABLE_CODES = new Set([408, 515])  // timedOut, restartRequired
    if (socket?.ev) {
      const _origEmit = socket.ev.emit.bind(socket.ev)
      let _uptimeReconnectCount = 0
      let _uptimeGuardianActive = false
      // Activate guardian only AFTER the first successful connection.
      // During QR/pairing login WhatsApp sends a 515 as part of the auth
      // handshake — suppressing it blocks login from completing.
      socket.ev.emit = function (event, ...args) {
        if (event === 'connection.update') {
          const update = args[0]
          if (update?.connection === 'open') {
            if (!_uptimeGuardianActive) {
              _uptimeGuardianActive = true
              process.stdout.write('[uptime] Guardian activated — will suppress reconnectable disconnects\n')
            }
            if (_uptimeReconnectCount > 0) {
              process.stdout.write(`[uptime] Reconnected after ${_uptimeReconnectCount} suppressed disconnect(s) — uptime preserved\n`)
            }
          }
          if (_uptimeGuardianActive && update?.connection === 'close') {
            const statusCode = update?.lastDisconnect?.error?.output?.statusCode
            || update?.lastDisconnect?.error?.data?.statusCode
            if (RECONNECTABLE_CODES.has(statusCode)) {
              _uptimeReconnectCount += 1
              process.stdout.write(
                `[uptime] Reconnectable disconnect (code ${statusCode}, count ${_uptimeReconnectCount}) — ` +
                `suppressing to prevent unnecessary restart. Baileys will reconnect.\n`,
              )
              return true
            }
          }
        }
        return _origEmit(event, ...args)
      }
    }

    // ── Memory Watchdog ──────────────────────────────────────────────────
    // Check heap usage every 30 minutes. Clean the message store if it gets
    // too large, and log a warning at high watermark. If heap exceeds 800MB
    // the store is force-trimmed; above 1GB the process exits for PM2 to
    // restart cleanly (fresh memory).
    const MEMORY_WARN_MB = 500
    const MEMORY_CLEAN_MB = 650
    const MEMORY_FATAL_MB = 800
    const memoryCheck = setInterval(() => {
      const used = process.memoryUsage()
      const heapMB = Math.round(used.heapUsed / 1024 / 1024)
      const rssMB = Math.round(used.rss / 1024 / 1024)
      if (heapMB > MEMORY_FATAL_MB) {
        process.stdout.write(`[memory] FATAL: heap ${heapMB}MB / RSS ${rssMB}MB — exiting for PM2 clean restart\n`)
        process.exit(1)
      }
      if (heapMB > MEMORY_CLEAN_MB) {
        process.stdout.write(`[memory] CLEANING: heap ${heapMB}MB / RSS ${rssMB}MB — trimming store\n`)
        try {
          if (typeof global.__saffulStoreTrim === 'function') global.__saffulStoreTrim()
        } catch {}
        if (global.gc) global.gc()
      } else if (heapMB > MEMORY_WARN_MB) {
        process.stdout.write(`[memory] WARN: heap ${heapMB}MB / RSS ${rssMB}MB\n`)
        if (global.gc) global.gc()
      }
    }, 30 * 60 * 1000)
    memoryCheck.unref?.()

    // Force periodic GC every 6 hours to prevent slow heap bloat.
    const gcInterval = setInterval(() => {
      if (global.gc) global.gc()
    }, 6 * 60 * 60 * 1000)
    gcInterval.unref?.()

  } catch (error) {
    process.stdout.write(`[boot] FAILED at '${bootPhase}': ${error?.stack || error}\n`)
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
