/**
 * store-shim.js — minimal in-memory message store
 * ------------------------------------------------
 * Baileys v7 removed makeInMemoryStore. The bot's obfuscated core still
 * destructures it from '@whiskeysockets/baileys', so this shim provides just
 * the API surface the bot actually uses:
 *   - bindFromEventEmitter(ev)   keep a rolling log of incoming messages
 *   - messages[jid].array        chat history (used by the /chat web route)
 *   - getMessages(jid, id)       look up one message by id (getMessage option)
 *   - loadFromFile / writeToFile JSON persistence to store.json
 */
const fs = require('fs');

function boundedInt(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, minimum), maximum) : fallback;
}

// The cache is for live replies and retry lookups—not a local WhatsApp archive.
const MAX_MESSAGES_PER_CHAT = boundedInt(process.env.SAFFUL_CACHE_MESSAGES, 120, 25, 500);
const MAX_CACHED_CHATS = boundedInt(process.env.SAFFUL_CACHE_CHATS, 100, 10, 500);
const WRITE_INTERVAL_MS = boundedInt(process.env.SAFFUL_STORE_WRITE_SECONDS, 60, 15, 600) * 1000;

function messageList(value) {
  const list = Array.isArray(value) ? value : value && Array.isArray(value.array) ? value.array : [];
  return list.filter(Boolean).slice(-MAX_MESSAGES_PER_CHAT);
}

function latestMessageTime(list) {
  const timestamp = list.at(-1)?.messageTimestamp;
  const numeric = Number(timestamp);
  return Number.isFinite(numeric) ? numeric : 0;
}

function makeInMemoryStore() {
  const lastActivity = new Map();
  let lastWriteAt = 0;

  function keepChat(jid) {
    if (!store.messages[jid] && Object.keys(store.messages).length >= MAX_CACHED_CHATS) {
      const oldest = Object.keys(store.messages).sort((left, right) => (
        (lastActivity.get(left) || 0) - (lastActivity.get(right) || 0)
      ))[0];
      if (oldest) {
        delete store.messages[oldest];
        lastActivity.delete(oldest);
      }
    }

    if (!store.messages[jid]) store.messages[jid] = { array: [] };
    lastActivity.set(jid, Date.now());
    return store.messages[jid].array;
  }

  const store = {
    messages: {}, // jid -> { array: [message...] }
    contacts: {}, // jid -> { name, ... } — required by the core's getName()

    bindFromEventEmitter(ev) {
      ev.on('messages.upsert', ({ messages } = {}) => {
        for (const m of messages || []) {
          const jid = m && m.key && m.key.remoteJid;
          if (!jid) continue;
          const list = keepChat(jid);
          list.push(m);
          if (list.length > MAX_MESSAGES_PER_CHAT) list.splice(0, list.length - MAX_MESSAGES_PER_CHAT);
        }
        // Self-trim: if total cached chats exceeds limit, drop oldest chats
        const totalChats = Object.keys(store.messages).length;
        if (totalChats > MAX_CACHED_CHATS + 20) {
          const sorted = Object.keys(store.messages)
            .sort((a, b) => (lastActivity.get(a) || 0) - (lastActivity.get(b) || 0));
          const excess = totalChats - MAX_CACHED_CHATS;
          for (let i = 0; i < excess; i++) {
            delete store.messages[sorted[i]];
            lastActivity.delete(sorted[i]);
          }
        }
      });
      // Populate contacts so the core's getName() can resolve JIDs
      ev.on('contacts.upsert', (contacts) => {
        for (const c of contacts || []) {
          if (c && c.id) store.contacts[c.id] = c;
        }
      });
      ev.on('contacts.update', (updates) => {
        for (const u of updates || []) {
          if (u && u.id && store.contacts[u.id]) {
            Object.assign(store.contacts[u.id], u);
          }
        }
      });
    },

    async getMessages(jid, id) {
      const chat = store.messages[jid];
      const list = chat && chat.array ? chat.array : Array.isArray(chat) ? chat : [];
      return list.find((m) => m && m.key && m.key.id === id);
    },

    // Baileys v6 store API names the bot's obfuscated core still uses
    bind(ev) {
      return this.bindFromEventEmitter(ev);
    },

    async loadMessage(jid, id) {
      return this.getMessages(jid, id);
    },

    loadFromFile(file) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (data && typeof data === 'object') {
          const chats = Object.entries(data.messages || {})
            .map(([jid, value]) => [jid, messageList(value)])
            .filter(([, list]) => list.length > 0)
            .sort(([, left], [, right]) => latestMessageTime(left) - latestMessageTime(right))
            .slice(-MAX_CACHED_CHATS);

          store.messages = {};
          lastActivity.clear();
          for (const [jid, list] of chats) {
            store.messages[jid] = { array: list };
            lastActivity.set(jid, latestMessageTime(list));
          }
        }
      } catch (e) {
        // no/corrupt file — start fresh
      }
      return store;
    },

    readFromFile(file) {
      return this.loadFromFile(file);
    },

    writeToFile(file) {
      try {
        const now = Date.now();
        if (now - lastWriteAt < WRITE_INTERVAL_MS) return;
        const serialized = JSON.stringify({ messages: store.messages });
        // Guard against writing excessively large stores to disk (>5MB).
        // If the store is this big, trim it first to prevent disk pressure.
        if (serialized.length > 5 * 1024 * 1024) {
          process.stdout.write(`[store] WARN: store serialized to ${Math.round(serialized.length / 1024)}KB — trimming before write\n`);
          this.trim();
          const trimmed = JSON.stringify({ messages: store.messages });
          fs.writeFileSync(file, trimmed);
        } else {
          fs.writeFileSync(file, serialized);
        }
        lastWriteAt = now;
      } catch (e) {
        // ignore write errors
      }
    },

    // Memory watchdog calls this to trim the store when heap is high.
    // Drops the oldest 50% of chats and halves message arrays.
    trim() {
      const jids = Object.keys(store.messages);
      const toRemove = Math.ceil(jids.length / 2);
      const sorted = jids.sort((a, b) =>
        (lastActivity.get(a) || 0) - (lastActivity.get(b) || 0),
      );
      for (let i = 0; i < toRemove; i++) {
        delete store.messages[sorted[i]];
        lastActivity.delete(sorted[i]);
      }
      // Also halve the remaining message arrays
      for (const jid of Object.keys(store.messages)) {
        const arr = store.messages[jid]?.array;
        if (Array.isArray(arr) && arr.length > 20) {
          store.messages[jid].array = arr.slice(-20);
        }
      }
    },
  };
  // Register the trim function globally so the memory watchdog in index.js
  // can call it to free memory when heap is high.
  if (typeof global !== 'undefined') {
    global.__saffulStoreTrim = () => store.trim();
  }

  return store;
}

module.exports = makeInMemoryStore;
