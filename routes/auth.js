const express = require('express');

function createAuthRouter({ db, bcrypt, auth }) {
  const router = express.Router();

  router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username and password required' });
    }

    try {
      const result = await db.query('SELECT * FROM users WHERE username = $1', [username]);
      const user = result.rows[0];

      if (!user) {
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
      }

      // Block suspended users (if column exists).
      if (user.is_active === false) {
        return res.status(403).json({ success: false, message: 'Account is suspended. Please contact the Super Admin.' });
      }

      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) {
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
      }

      // Enforce: one active session per account (prevents concurrent logins across browsers/incognito).
      try {
        const now = new Date();
        const activeSid = user.active_session_id ? String(user.active_session_id) : null;
        const activeExp = user.active_session_expires_at ? new Date(user.active_session_expires_at) : null;
        const hasUnexpired = Boolean(activeSid && activeExp && activeExp > now);

        if (activeSid) {
          if (hasUnexpired) {
            // MemoryStore sessions are cleared on server restart; avoid permanent lockout in that case.
            const existing = await auth.getSessionFromStore(req.sessionStore, activeSid);
            if (existing) {
              return res.status(409).json({
                success: false,
                message: 'Account in session. Please log out first.',
              });
            }
          }
          // Session was expired or missing from store: clear the stale DB record and allow login.
          await auth.clearActiveSessionForUser(user.id, activeSid);
        }
      } catch (e) {
        // If the columns don't exist yet (or store is unavailable), skip the single-session check.
      }

      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.role = user.role;

      // Save the session before recording its id in Postgres.
      await new Promise((resolve, reject) => {
        req.session.save((err) => (err ? reject(err) : resolve()));
      });

      try {
        const expiresAt = req.session.cookie && req.session.cookie.expires
          ? new Date(req.session.cookie.expires)
          : new Date(Date.now() + (Number(req.session.cookie && req.session.cookie.maxAge) || 0));
        await db.query(
          'UPDATE users SET active_session_id = $1, active_session_expires_at = $2 WHERE id = $3',
          [String(req.sessionID), expiresAt, Number(user.id)]
        );
      } catch (e) {
        // Best-effort: login is still valid even if we can't persist session tracking.
      }

      return res.json({ success: true, user: { username: user.username, role: user.role } });
    } catch (err) {
      console.error('Login error:', err);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  });

  /**
   * Logs out the current session.
   *
   * Output: `{ success: true }` on success.
   */
  router.post('/logout', (req, res) => {
    const userId = req.session && req.session.userId ? req.session.userId : null;
    const sid = req.sessionID;
    req.session.destroy((err) => {
      if (err) return res.status(500).json({ success: false });
      res.clearCookie('connect.sid', { path: '/', secure: true, httpOnly: true });
      auth.clearActiveSessionForUser(userId, sid).catch(() => {});
      res.json({ success: true });
    });
  });

  /**
   * Returns the current session identity (used by the frontend to guard pages).
   *
   * Output:
   * - `{ loggedIn: true, username, role }`
   * - `{ loggedIn: false }`
   */
  router.get('/me', (req, res) => {
    (async () => {
      if (!req.session.userId) return res.json({ loggedIn: false });

      const user = await auth.getCurrentUserFromDb(req.session.userId);
      if (!user || user.is_active === false) {
        try { req.session.destroy(() => {}); } catch (e) {}
        return res.json({ loggedIn: false });
      }
      if (user.active_session_id && String(user.active_session_id) !== String(req.sessionID)) {
        try { req.session.destroy(() => {}); } catch (e) {}
        return res.json({ loggedIn: false });
      }
      if (user.active_session_expires_at && new Date(user.active_session_expires_at) <= new Date()) {
        try { req.session.destroy(() => {}); } catch (e) {}
        return res.json({ loggedIn: false });
      }

      req.session.username = user.username;
      req.session.role = user.role;

      res.json({ loggedIn: true, id: user.id, username: user.username, role: user.role });
    })().catch((e) => {
      console.error('/api/me error:', e);
      res.json({ loggedIn: false });
    });
  });

  return router;
}

module.exports = createAuthRouter;

