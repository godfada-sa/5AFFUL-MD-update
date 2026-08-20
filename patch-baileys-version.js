/**
 * BAILEYS VERSION PATCH
 * -------------------------------------------
 * Baileys 6.17.16 bundles an outdated WhatsApp client version
 * (2.3000.1019707846). WhatsApp's server rejects the registration
 * handshake for old versions, so the bot never receives a QR code
 * and loops "Connection closed, reconnecting...." forever.
 *
 * This patch sets the CURRENT WhatsApp version as the default so
 * every socket (bot core, session tool, plugins) uses it.
 *
 * If scanning stops working months from now, refresh the version:
 *   node -e "require('@whiskeysockets/baileys').fetchLatestBaileysVersion().then(v=>console.log(v.version))"
 * and update VERSION below.
 */
const { DEFAULT_CONNECTION_CONFIG } = require('@whiskeysockets/baileys/lib/Defaults');

const VERSION = [2, 3000, 1045118668]; // verified 2026-08-13, fallback when live refresh is unavailable

DEFAULT_CONNECTION_CONFIG.version = VERSION;
