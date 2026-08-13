function logHandlerError(eventName, error) {
  console.error(`[raw-dispatcher] ${eventName} handler failed:`, error?.message || error);
}

function attachRawDispatcher(socket, { attachProtection, autoView, statusSave } = {}) {
  if (!socket?.ev || socket.__saffulRawDispatcherAttached) return socket?.__saffulRawDispatcher;

  const upsertHandlers = new Set();
  const updateHandlers = new Set();
  const dispatcher = {
    onUpsert(handler) {
      if (typeof handler !== 'function') throw new TypeError('Raw upsert handler must be a function.');
      upsertHandlers.add(handler);
      return () => upsertHandlers.delete(handler);
    },
    onUpdate(handler) {
      if (typeof handler !== 'function') throw new TypeError('Raw update handler must be a function.');
      updateHandlers.add(handler);
      return () => updateHandlers.delete(handler);
    },
  };

  socket.__saffulRawDispatcher = dispatcher;
  socket.__saffulRawDispatcherAttached = true;

  // Feature modules register with the dispatcher below.  They do not attach
  // their own Baileys listeners when this object is present.
  attachProtection?.(socket);
  autoView?.attach?.(socket);
  statusSave?.attach?.(socket);

  // Do not await feature work here. Command parsing still receives this same
  // WhatsApp event immediately, while each raw feature runs independently.
  const dispatch = (handlers, payload, eventName) => {
    for (const handler of handlers) {
      Promise.resolve()
        .then(() => handler(payload))
        .catch((error) => logHandlerError(eventName, error));
    }
  };

  socket.ev.on('messages.upsert', (event) => dispatch(upsertHandlers, event, 'messages.upsert'));
  socket.ev.on('messages.update', (event) => dispatch(updateHandlers, event, 'messages.update'));
  console.log(`[raw-dispatcher] active: ${upsertHandlers.size} upsert handler(s), ${updateHandlers.size} update handler(s)`);

  return dispatcher;
}

module.exports = attachRawDispatcher;
