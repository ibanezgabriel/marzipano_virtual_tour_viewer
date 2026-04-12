const {
  clearSessionForUser,
  createSessionForUser,
  findUserByUsername,
  hasActiveSession,
} = require('../db/users');
const { verifyPassword } = require('../db/passwords');
const {
  clearSessionCookie,
  serializeUserForClient,
  setSessionCookie,
} = require('../services/auth.service');

async function login(req, res) {
  try {
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');

    if (!username || !password) {
      return res.status(400).json({ message: 'Username and password are required.' });
    }

    const user = await findUserByUsername(username);
    if (!user) {
      return res.status(401).json({ message: 'Invalid username or password.' });
    }

    if (!user.is_active) {
      clearSessionCookie(res);
      return res.status(403).json({ message: 'This account is suspended.' });
    }

    const passwordMatches = await verifyPassword(password, user.password_hash);
    if (!passwordMatches) {
      return res.status(401).json({ message: 'Invalid username or password.' });
    }

    if (hasActiveSession(user)) {
      return res.status(409).json({ message: 'This account is already signed in on another device.' });
    }

    const session = await createSessionForUser(user.id);
    setSessionCookie(res, session.sessionId, session.expiresAt);
    return res.json({ success: true, user: serializeUserForClient(user) });
  } catch (error) {
    console.error('Login failed:', error);
    return res.status(500).json({ message: 'Unable to sign in right now.' });
  }
}

function status(req, res) {
  return res.json({
    authenticated: Boolean(req.authUser),
    user: req.authUser ? serializeUserForClient(req.authUser) : null,
  });
}

function me(req, res) {
  if (!req.authUser) {
    clearSessionCookie(res);
    return res.status(401).json({ message: 'Not signed in.' });
  }
  return res.json({ user: serializeUserForClient(req.authUser) });
}

async function logout(req, res) {
  try {
    if (req.authUser) {
      await clearSessionForUser(req.authUser.id);
    }
  } catch (error) {
    console.error('Logout cleanup failed:', error);
  }

  clearSessionCookie(res);
  return res.json({ success: true });
}

module.exports = {
  login,
  status,
  me,
  logout,
};
