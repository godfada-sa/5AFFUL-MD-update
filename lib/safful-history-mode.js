/**
 * Keeps Baileys in live-only mode without editing the legacy obfuscated core.
 * Protection, status, and command listeners still receive every new event;
 * only the initial backlog download is disabled.
 */
const Module = require('module');
const path = require('path');

if (process.env.SAFFUL_FULL_HISTORY !== 'true' && !global.__saffulHistoryHookInstalled) {
  const corePath = path.join(__dirname, 'smd.js');
  const originalLoad = Module._load;

  Module._load = function loadSaffulLiveOnlyBaileys(request, parent, isMain) {
    const loaded = originalLoad.call(this, request, parent, isMain);
    if (request !== '@whiskeysockets/baileys' || parent?.filename !== corePath) return loaded;

    const originalCreateSocket = loaded.default;
    const createLiveOnlySocket = (options = {}) => originalCreateSocket({
      ...options,
      shouldSyncHistoryMessage: () => false,
      downloadHistory: false,
      syncFullHistory: false,
    });

    // Baileys is an immutable module namespace, so return a proxy only to the
    // legacy core instead of mutating its exports for every other caller.
    return new Proxy(loaded, {
      get(target, property, receiver) {
        return property === 'default'
          ? createLiveOnlySocket
          : Reflect.get(target, property, receiver);
      },
    });
  };

  global.__saffulHistoryHookInstalled = true;
  console.log('[history] Safful live-only cache mode is active');
}
