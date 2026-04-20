/* Registers websocket listeners for project updates and session presence. */
const { clearSessionForUser, findUserBySession } = require('../db/users');
const { SESSION_COOKIE_NAME } = require('../config/auth');
const { findProjectByIdOrNumber } = require('../services/project-manifest.service');

const SESSION_DISCONNECT_GRACE_MS = 60_000;
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

// sessionId -> { userId, sockets: Map<socketId, { tabState: string, updatedAt: number }>, timeoutId: Timeout | null }
const sessionPresence = new Map();

function shouldScheduleLogoutForDisconnectReason(reason) {
  // "transport close" happens for tab close, refresh, and navigation.
  // We apply a grace period so refresh/navigation reconnects cancel the cleanup.
  return reason === 'transport close' || reason === 'io client disconnect';
}

function isSocketAuthorizedForProjects(socket) {
  const session = socket && socket.request && socket.request.session;
  const user = session && session.user;
  if (!user) return false;
  return TRACKED_ROLES.has(user.role);
}

function normalizeTabState(value) {
  const state = String(value || '').trim().toLowerCase();
  if (state === 'closing') return 'closing';
  if (state === 'hidden') return 'hidden';
  if (state === 'visible') return 'visible';
  if (state === 'active') return 'visible';
  return 'unknown';
}

function registerSocketHandlers(io) {
  io.use(async (socket, next) => {
    try {
      const cookies = parseCookies(socket.handshake && socket.handshake.headers && socket.handshake.headers.cookie);
      const sessionId = cookies[SESSION_COOKIE_NAME];
      if (!sessionId) return next();

      const user = await findUserBySession(sessionId);
      if (!user || !TRACKED_ROLES.has(user.role) || !user.is_active) return next();

      socket.request.session = {
        id: sessionId,
        user: {
          id: user.id,
          role: user.role,
        },
      };
      socket.data.sessionId = sessionId;
      socket.data.userId = user.id;
      socket.data.tabState = 'unknown';
    } catch (_error) {}
    return next();
  });

  io.on('connection', async (socket) => {
    // Best-effort: track authenticated admin sessions so closing a tab frees the session.
    try {
      const sessionId = socket.data && socket.data.sessionId;
      const userId = socket.data && socket.data.userId;
      if (sessionId && userId && isSocketAuthorizedForProjects(socket)) {
        const entry = sessionPresence.get(sessionId) || { userId, sockets: new Map(), timeoutId: null };
        entry.userId = userId;
        entry.sockets.set(socket.id, { tabState: socket.data.tabState || 'unknown', updatedAt: Date.now() });
        if (entry.timeoutId) {
          clearTimeout(entry.timeoutId);
          entry.timeoutId = null;
        }
        sessionPresence.set(sessionId, entry);
      }
    } catch (_error) {}

    socket.on('tabState', (payload) => {
      try {
        const state = normalizeTabState(payload && payload.state);
        socket.data.tabState = state;

        const sessionId = socket.data && socket.data.sessionId;
        if (!sessionId) return;
        const entry = sessionPresence.get(sessionId);
        if (!entry) return;
        const socketEntry = entry.sockets.get(socket.id);
        if (!socketEntry) return;
        socketEntry.tabState = state;
        socketEntry.updatedAt = Date.now();
        entry.sockets.set(socket.id, socketEntry);
        sessionPresence.set(sessionId, entry);
      } catch (_error) {}
    });

    socket.on('joinProject', (projectToken) => {
      try {
        if (!isSocketAuthorizedForProjects(socket)) return;
        const token = String(projectToken || '').trim();
        if (!token) return;
        const project = findProjectByIdOrNumber(token);
        if (!project) return;
        socket.join(`project:${project.id}`);
      } catch (_error) {}
    });

    socket.on('leaveProject', (projectToken) => {
      try {
        const token = String(projectToken || '').trim();
        if (!token) return;
        const project = findProjectByIdOrNumber(token);
        if (!project) return;
        socket.leave(`project:${project.id}`);
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

        // Only terminate the session when the browser tab explicitly signaled it's closing.
        // This prevents accidental logouts on flaky networks / VPN reconnects.
        const lastTabState = socket.data && socket.data.tabState;
        if (lastTabState !== 'closing') return;

        if (entry.timeoutId) clearTimeout(entry.timeoutId);
        entry.timeoutId = setTimeout(async () => {
          try {
            const current = sessionPresence.get(sessionId);
            if (!current || current.sockets.size > 0) return;
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
