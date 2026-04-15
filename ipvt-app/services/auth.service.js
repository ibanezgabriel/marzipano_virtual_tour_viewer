/* Provides shared authentication and session helpers. */
const {
  clearSessionForUser,
  findUserBySession,
  mapUserRow,
} = require('../db/users');
const {
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_OPTIONS,
  SUPERADMIN_HOME_PATH,
  ADMIN_HOME_PATH,
} = require('../config/auth');

/* Handles parse cookies. */
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

/* Gets get home path for user. */
function getHomePathForUser(user) {
  return user && user.role === 'superadmin' ? SUPERADMIN_HOME_PATH : ADMIN_HOME_PATH;
}

/* Handles serialize user for client. */
function serializeUserForClient(userRow) {
  const user = userRow && Object.prototype.hasOwnProperty.call(userRow, 'isActive')
    ? userRow
    : mapUserRow(userRow);
  if (!user) return null;
  return {
    ...user,
    roleLabel: user.role === 'superadmin' ? 'SuperAdmin' : 'Admin',
    statusLabel: user.isActive ? 'Active' : 'Suspended',
    homePath: getHomePathForUser(user),
  };
}

/* Gets get authenticated user from request. */
async function getAuthenticatedUserFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[SESSION_COOKIE_NAME];
  if (!sessionId) return null;

  const user = await findUserBySession(sessionId);
  if (!user) return null;

  if (!user.is_active) {
    try {
      await clearSessionForUser(user.id);
    } catch (_error) {}
    return null;
  }

  return user;
}

/* Updates set session cookie. */
function setSessionCookie(res, sessionId, expiresAt) {
  res.cookie(SESSION_COOKIE_NAME, sessionId, {
    ...SESSION_COOKIE_OPTIONS,
    expires: expiresAt,
  });
}

/* Cleans up clear session cookie. */
function clearSessionCookie(res) {
  res.cookie(SESSION_COOKIE_NAME, '', {
    ...SESSION_COOKIE_OPTIONS,
    expires: new Date(0),
  });
}

/* Handles redirect to login. */
function redirectToLogin(req, res) {
  const redirect = encodeURIComponent(req.originalUrl || req.url || '/dashboard.html');
  res.redirect(`/login.html?redirect=${redirect}`);
}

module.exports = {
  getAuthenticatedUserFromRequest,
  serializeUserForClient,
  setSessionCookie,
  clearSessionCookie,
  redirectToLogin,
  getHomePathForUser,
};
