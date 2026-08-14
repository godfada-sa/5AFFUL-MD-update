function preserveMobileNotifications(sock) {
  if (!sock || sock.__saffulMobileNotificationGuard || process.env.SAFFUL_PRESERVE_DM_NOTIFICATIONS === 'false') return;
  sock.__saffulMobileNotificationGuard = true;

  if (typeof sock.readMessages === 'function') {
    const readMessages = sock.readMessages.bind(sock);
    sock.readMessages = (keys = []) => {
      // Do not let a linked bot mark incoming DMs read. That can prevent the
      // primary WhatsApp app from issuing a personal-message notification.
      // Group receipts and status read receipts remain untouched.
      const allowed = keys.filter((key) => key?.fromMe || key?.remoteJid === 'status@broadcast' || key?.remoteJid?.endsWith('@g.us'));
      return allowed.length ? readMessages(allowed) : Promise.resolve();
    };
  }

  if (typeof sock.sendPresenceUpdate === 'function' && sock.ev?.on) {
    sock.ev.on('connection.update', ({ connection } = {}) => {
      if (connection === 'open') sock.sendPresenceUpdate('unavailable').catch(() => {});
    });
  }

  console.log('[notifications] private-message read receipts are protected.');
}

module.exports = preserveMobileNotifications;
