/* Registers websocket listeners for project updates and session presence. */
const { clearSessionForUser, findUserBySession } = require('../db/users');
const { SESSION_COOKIE_NAME } = require('../config/auth');

const SESSION_DISCONNECT_GRACE_MS = 10_000;
const TRACKED_ROLES = new Set(['admin', 'superadmin']);

function parseCookies(cookieHeader) {
  const cookies = {};
  String(cookieHeader || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const separatorIndex = part.indexOf('=');
      if (separatorIndex <= 0) return;
      const name = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();
      try {
        cookies[name] = decodeURIComponent(value);
      } catch (_error) {
        cookies[name] = value;
      }
    });
  return cookies;
}

// sessionId -> { userId, sockets: Set<socketId>, timeoutId: Timeout | null }
const sessionPresence = new Map();

function shouldScheduleLogoutForDisconnectReason(reason) {
  // "transport close" happens for tab close, refresh, and navigation.
  // We apply a grace period so refresh/navigation reconnects cancel the cleanup.
  return reason === 'transport close' || reason === 'io client disconnect';
}

function registerSocketHandlers(io) {
  io.on('connection', async (socket) => {
    // Best-effort: track authenticated admin sessions so closing a tab frees the session.
    try {
      const cookies = parseCookies(socket.handshake && socket.handshake.headers && socket.handshake.headers.cookie);
      const sessionId = cookies[SESSION_COOKIE_NAME];
      if (sessionId) {
        const user = await findUserBySession(sessionId);
        if (user && TRACKED_ROLES.has(user.role)) {
          socket.data.sessionId = sessionId;
          socket.data.userId = user.id;
          const entry = sessionPresence.get(sessionId) || { userId: user.id, sockets: new Set(), timeoutId: null };
          entry.userId = user.id;
          entry.sockets.add(socket.id);
          if (entry.timeoutId) {
            clearTimeout(entry.timeoutId);
            entry.timeoutId = null;
          }
          sessionPresence.set(sessionId, entry);
        }
      }
    } catch (_error) {}

    socket.on('joinProject', (projectId) => {
      try {
        if (typeof projectId === 'string' && projectId.length > 0) {
          socket.join(`project:${projectId}`);
        }
      } catch (_error) {}
    });

    socket.on('leaveProject', (projectId) => {
      try {
        if (typeof projectId === 'string' && projectId.length > 0) {
          socket.leave(`project:${projectId}`);
        }
      } catch (_error) {}
    });

    socket.on('disconnect', (reason) => {
      try {
        const sessionId = socket.data && socket.data.sessionId;
        const userId = socket.data && socket.data.userId;
        if (!sessionId || !userId) return;
        const entry = sessionPresence.get(sessionId);
        if (!entry) return;
        entry.sockets.delete(socket.id);
        if (entry.sockets.size > 0) return;
        if (!shouldScheduleLogoutForDisconnectReason(reason)) return;

        if (entry.timeoutId) clearTimeout(entry.timeoutId);
        entry.timeoutId = setTimeout(async () => {
          try {
            await clearSessionForUser(userId);
          } catch (_error) {}
          try {
            sessionPresence.delete(sessionId);
          } catch (_error) {}
        }, SESSION_DISCONNECT_GRACE_MS);
        sessionPresence.set(sessionId, entry);
      } catch (_error) {}
    });
  });
}

module.exports = {
  registerSocketHandlers,
};
