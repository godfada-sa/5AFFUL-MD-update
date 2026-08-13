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

    bindFromEventEmitter(ev) {
      ev.on('messages.upsert', ({ messages } = {}) => {
        for (const m of messages || []) {
          const jid = m && m.key && m.key.remoteJid;
          if (!jid) continue;
          const list = keepChat(jid);
          list.push(m);
          if (list.length > MAX_MESSAGES_PER_CHAT) list.splice(0, list.length - MAX_MESSAGES_PER_CHAT);
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
        fs.writeFileSync(file, JSON.stringify({ messages: store.messages }));
        lastWriteAt = now;
      } catch (e) {
        // ignore write errors
      }
    },
  };
  return store;
}

module.exports = makeInMemoryStore;
