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

// ── Uptime Guardian — installed BEFORE any require() ─────────────────────
// WhatsApp forces a session rotation (status 515) every ~12-24 hours. The
// obfuscated core catches this and calls process.exit(1). If we override
// process.exit AFTER modules load, they save a reference to the OLD exit
// and our override is bypassed.
//
// This override is installed at the very top so every module (smd.js,
// safful-auth-recovery, etc.) gets our override as the "real" process.exit.
// By default it allows all exits. After the first successful WhatsApp
// connection, activate() is called to suppress exits during reconnectable
// disconnects (515, 408).
// ──────────────────────────────────────────────────────────────────────────
const __uptime = {
  active: false,
  reconnectCount: 0,
  suppressUntil: 0,
  origExit: process.exit.bind(process),
}
process.exit = function (code) {
  if (__uptime.active && __uptime.suppressUntil > Date.now() && code !== 0) {
    process.stdout.write('[uptime] Suppressing process.exit(' + code + ') — reconnectable disconnect in progress.\n')
    return
  }
  return __uptime.origExit(code)
}
global.__saffulUptimeSuppress = function (ms) {
  if (!__uptime.active) {
    __uptime.active = true
    process.stdout.write('[uptime] Guardian activated — will suppress reconnectable disconnects\n')
  }
  __uptime.reconnectCount += 1
  __uptime.suppressUntil = Date.now() + ms
}
global.__saffulUptimeReconnected = function () {
  if (__uptime.reconnectCount > 0) {
    process.stdout.write('[uptime] Reconnected after ' + __uptime.reconnectCount + ' suppressed disconnect(s) — uptime preserved\n')
    __uptime.reconnectCount = 0
  }
}
// ── End Uptime Guardian ─────────────────────────────────────────────────

const fs = require('fs')
const path = require('path')

// ── Temp File Cleanup ────────────────────────────────────────────────────
try {
  const tempDir = path.join(__dirname, 'temp')
  if (fs.existsSync(tempDir)) {
    const cutoff = Date.now() - 60 * 60 * 1000
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

// ── QR Art Holding ───────────────────────────────────────────────────────
// In pairing mode, hold QR art until the pairing code banner prints,
// then emit it once. Prevents duplicate QR blocks in panel logs.
let __saffulQrArtShown = false
let __saffulPendingQrArt = null
const __saffulOrigStdoutWrite = process.stdout.write.bind(process.stdout)
process.stdout.write = function (chunk) {
  const str = typeof chunk === 'string' ? chunk : String(chunk)
  if (str.includes('\u2580') && str.split('\n').filter(l => l.replace(/\s/g, '')).length >= 5) {
    const pairingMode = String(process.env.AUTH_METHOD || '').trim().toLowerCase() === 'pairing'
    if (pairingMode) {
      if (__saffulQrArtShown) return true
      __saffulQrArtShown = true
      if (global.__saffulPairingBannerPrinted) {
        return __saffulOrigStdoutWrite('\n' + str + '\n')
      } else {
        __saffulPendingQrArt = str
        return true
      }
    }
  }
  // Flush held QR art when non-art output arrives after banner
  if (__saffulPendingQrArt && global.__saffulPairingBannerPrinted) {
    __saffulOrigStdoutWrite('\n' + __saffulPendingQrArt + '\n')
    __saffulPendingQrArt = null
  }
  return __saffulOrigStdoutWrite(chunk)
}
global.__saffulFlushPendingQrArt = function () {
  if (__saffulPendingQrArt) {
    __saffulOrigStdoutWrite('\n' + __saffulPendingQrArt + '\n')
    __saffulPendingQrArt = null
  }
}

// Must run before anything requires @whiskeysockets/baileys.
if (process.env.SAFFUL_ENABLE_SESSION_ID !== 'true') process.env.SAFFUL_DISABLE_SESSION_ID = 'true'
require(__dirname + '/patch-baileys-version.js')
require(__dirname + '/lib/safful-optional-sharp')
require(__dirname + '/lib/brand-console')
require(__dirname + '/lib/safful-history-mode')
const { installOutgoingMessagePolicy, rebrandSocket } = require(__dirname + '/lib/safful-outgoing-message-policy')
installOutgoingMessagePolicy()
const preserveMobileNotifications = require(__dirname + '/lib/safful-mobile-notifications')
preserveMobileNotifications.installMobileNotificationGuard()

function suppressSensitiveSignalSessionLogs() {
  const suppressible = /^(Closing session:|Removing old closed session:)/
  const installFilter = (method) => {
    const original = console[method].bind(console)
    console[method] = (...values) => {
      const label = typeof values[0] === 'string' ? values[0] : ''
      if (suppressible.test(label)) {
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

// ── Global Error Handlers ────────────────────────────────────────────────
let __saffulCrashCount = 0
const __saffulCrashWindow = 10 * 60 * 1000
let __saffulCrashWindowStart = Date.now()
process.on('uncaughtException', (error) => {
  const now = Date.now()
  if (now - __saffulCrashWindowStart > __saffulCrashWindow) {
    __saffulCrashCount = 0
    __saffulCrashWindowStart = now
  }
  __saffulCrashCount += 1
  process.stdout.write(`[uptime] UNCAUGHT EXCEPTION (crash #${__saffulCrashCount}): ${error?.stack || error}\n`)
  if (__saffulCrashCount >= 5) {
    process.stdout.write('[uptime] Too many crashes in short window — exiting for PM2 backoff.\n')
    process.exit(1)
  }
})
process.on('unhandledRejection', (reason) => {
  process.stdout.write(`[uptime] UNHANDLED REJECTION (suppressed): ${reason?.stack || reason}\n`)
})

const { prepareAuthentication } = require(__dirname + '/lib/safful-auth-method')
const { installAuthRecovery, clearRecoveryState } = require(__dirname + '/lib/safful-auth-recovery')
installAuthRecovery()

const Config = require(__dirname + '/config')
const { VERSION } = Config
const attachProtection = require(__dirname + '/lib/safful-protection')
attachProtection.installEarlyCaptureHook()
process.stdout.write('[anti-delete] pre-core capture hook armed\n')
const autoView = require(__dirname + '/plugins/statusauto.smd')
const statusSave = require(__dirname + '/lib/safful-status-save')
const attachRawDispatcher = require(__dirname + '/lib/safful-raw-dispatcher')

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
  const liveSocket = () =>
    (global.__saffulLatestSocket && typeof global.__saffulLatestSocket?.sendMessage === 'function'
      ? global.__saffulLatestSocket
      : socket)
  const sendBanner = async () => {
    if (connectedBannerSent) return
    const current = liveSocket()
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

    try {
      const probe = await fetch('https://web.whatsapp.com', { method: 'HEAD', signal: AbortSignal.timeout(8000) })
      process.stdout.write(`[boot] WhatsApp reachable (HTTP ${probe.status})\n`)
    } catch (probeError) {
      process.stdout.write(`[boot] WARNING: cannot reach web.whatsapp.com — ${probeError?.message || probeError}\n`)
    }

    const socket = await bot.connect()
    process.stdout.write('[boot] socket created\n')

    const reportConnection = (update = {}) => {
      const state = String(update.connection || '')
      if (!state || state === lastConnectionState) return
      lastConnectionState = state
      const error = update.lastDisconnect?.error
      const reason = error ? ` — ${error?.message || error}` : ''
      process.stdout.write(`[boot] connection state: ${state}${reason}\n`)
    }
    socket.ev?.on?.('connection.update', reportConnection)

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
    attachProtection.installSocketRawCapture(socket)
    rebrandSocket(socket)
    preserveMobileNotifications(socket)
    attachRawDispatcher(socket, { attachProtection, autoView, statusSave })
    notifyConnectedOnce(socket)
    process.stdout.write('[boot] hooks attached — ready\n')

    // ── Uptime Guardian activation ─────────────────────────────────────
    const RECONNECTABLE_CODES = new Set([408, 515])
    let _guardianActivated = false
    socket.ev?.on?.('connection.update', (update = {}) => {
      if (update.connection === 'open') {
        if (!_guardianActivated) {
          _guardianActivated = true
          global.__saffulUptimeSuppress(0)
        }
        global.__saffulUptimeReconnected()
      }
      if (_guardianActivated && update.connection === 'close') {
        const statusCode = update?.lastDisconnect?.error?.output?.statusCode
          || update?.lastDisconnect?.error?.data?.statusCode
        if (RECONNECTABLE_CODES.has(statusCode)) {
          global.__saffulUptimeSuppress(15000)
          process.stdout.write(
            `[uptime] Reconnectable disconnect (code ${statusCode}) — ` +
            `suppressing exit for 15s. Baileys will reconnect.\n`,
          )
        }
      }
    })

    // ── Memory Watchdog ──────────────────────────────────────────────────
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

    const gcInterval = setInterval(() => {
      if (global.gc) global.gc()
    }, 6 * 60 * 60 * 1000)
    gcInterval.unref?.()

  } catch (error) {
    process.stdout.write(`[boot] FAILED at '${bootPhase}': ${error?.stack || error}\n`)
    console.error('[startup] Failed to start Safful-Md:', error);
    if (global.__saffulAuthMethod === 'pairing') return
    setTimeout(() => void start(), 3000).unref?.();
  }
}
start();
