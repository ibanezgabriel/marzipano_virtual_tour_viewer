/**
 * Authentication and authorization middleware + helpers.
 *
 * This module is a small dependency-injected "auth bundle" so routes can share:
 * - Session validation (single active session per account)
 * - Role checks (admin vs super_admin)
 * - Page protection (redirects) and API protection (JSON errors)
 */

function createAuthMiddleware({ db }) {
  /**
   * Admin-facing roles (both Admin and Super Admin are treated as "admin" for most tools).
   *
   * @param {string} role
   * @returns {boolean}
   */
  function isAdminRole(role) {
    return role === 'admin' || role === 'super_admin';
  }

  /**
   * Super Admin role check.
   *
   * @param {string} role
   * @returns {boolean}
   */
  function isSuperAdminRole(role) {
    return role === 'super_admin';
  }

  function getSessionFromStore(store, sid) {
    return new Promise((resolve) => {
      if (!store || typeof store.get !== 'function') return resolve(null);
      store.get(sid, (err, sess) => {
        if (err) return resolve(null);
        resolve(sess || null);
      });
    });
  }

  async function clearActiveSessionForUser(userId, expectedSid = null) {
    if (!userId) return;
    try {
      if (expectedSid) {
        await db.query(
          'UPDATE users SET active_session_id = NULL, active_session_expires_at = NULL WHERE id = $1 AND active_session_id = $2',
          [Number(userId), String(expectedSid)]
        );
      } else {
        await db.query(
          'UPDATE users SET active_session_id = NULL, active_session_expires_at = NULL WHERE id = $1',
          [Number(userId)]
        );
      }
    } catch (e) {
      // Best-effort cleanup only.
    }
  }

  async function getCurrentUserFromDb(userId) {
    if (!userId) return null;
    try {
      const r = await db.query(
        'SELECT id, username, role, is_active, active_session_id, active_session_expires_at FROM users WHERE id = $1',
        [Number(userId)]
      );
      return r.rows[0] || null;
    } catch (e) {
      return null;
    }
  }

  async function getValidSessionUser(req) {
    if (!req || !req.session || !req.session.userId) return null;
    const user = await getCurrentUserFromDb(req.session.userId);
    if (!user || user.is_active === false) return null;
    if (user.active_session_id && String(user.active_session_id) !== String(req.sessionID)) return null;
    if (user.active_session_expires_at && new Date(user.active_session_expires_at) <= new Date()) return null;
    return user;
  }

  /**
   * Protects admin HTML pages.
   * - Unauthenticated users are redirected to `login.html`.
   * - Authenticated but unauthorized users receive 403.
   */
  const protectAdmin = (req, res, next) => {
    (async () => {
      const ppath = req.path;
      const requiresAdmin =
        ppath === '/dashboard.html' ||
        ppath === '/project-editor.html' ||
        // Backward-compatible redirects for removed pages.
        ppath === '/staging-dashboard.html' ||
        ppath === '/staging-editor.html';
      const requiresSuperAdmin = ppath === '/superadmindb.html';
      if (!requiresAdmin && !requiresSuperAdmin) return next();

      if (!req.session.userId) return res.redirect('/login.html');

      const user = await getCurrentUserFromDb(req.session.userId);
      if (!user || user.is_active === false) {
        try { req.session.destroy(() => {}); } catch (e) {}
        return res.redirect('/login.html');
      }
      if (user.active_session_id && String(user.active_session_id) !== String(req.sessionID)) {
        try { req.session.destroy(() => {}); } catch (e) {}
        return res.redirect('/login.html');
      }
      if (user.active_session_expires_at && new Date(user.active_session_expires_at) <= new Date()) {
        try { req.session.destroy(() => {}); } catch (e) {}
        return res.redirect('/login.html');
      }

      req.session.username = user.username;
      req.session.role = user.role;

      if (requiresSuperAdmin) {
        if (!isSuperAdminRole(user.role)) {
          if (isAdminRole(user.role)) return res.redirect('/dashboard.html');
          return res.status(403).send('Forbidden');
        }
        return next();
      }

      if (!isAdminRole(user.role)) return res.status(403).send('Forbidden');
      next();
    })().catch((e) => {
      console.error('protectAdmin error:', e);
      res.redirect('/login.html');
    });
  };

  /**
   * Protects write APIs that require an authenticated Admin/Super Admin.
   * Responds with JSON errors instead of redirecting.
   */
  const requireApiAuth = (req, res, next) => {
    (async () => {
      if (!req.session.userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Validate that the session is still the active session for this account.
      const user = await getCurrentUserFromDb(req.session.userId);
      if (!user || user.is_active === false) {
        try { req.session.destroy(() => {}); } catch (e) {}
        return res.status(401).json({ error: 'Unauthorized' });
      }
      if (user.active_session_id && String(user.active_session_id) !== String(req.sessionID)) {
        try { req.session.destroy(() => {}); } catch (e) {}
        return res.status(401).json({ error: 'Unauthorized' });
      }
      if (user.active_session_expires_at && new Date(user.active_session_expires_at) <= new Date()) {
        try { req.session.destroy(() => {}); } catch (e) {}
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Always trust DB role over potentially stale session role.
      req.session.role = user.role;
      req.session.username = user.username;

      if (!isAdminRole(user.role)) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      next();
    })().catch((e) => {
      console.error('requireApiAuth error:', e);
      res.status(500).json({ error: 'Internal server error' });
    });
  };

  /**
   * Protects Super Admin-only APIs.
   */
  const requireSuperAdminApiAuth = (req, res, next) => {
    (async () => {
      if (!req.session.userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const user = await getCurrentUserFromDb(req.session.userId);
      if (!user || user.is_active === false) {
        try { req.session.destroy(() => {}); } catch (e) {}
        return res.status(401).json({ error: 'Unauthorized' });
      }
      if (user.active_session_id && String(user.active_session_id) !== String(req.sessionID)) {
        try { req.session.destroy(() => {}); } catch (e) {}
        return res.status(401).json({ error: 'Unauthorized' });
      }
      if (user.active_session_expires_at && new Date(user.active_session_expires_at) <= new Date()) {
        try { req.session.destroy(() => {}); } catch (e) {}
        return res.status(401).json({ error: 'Unauthorized' });
      }

      req.session.role = user.role;
      req.session.username = user.username;

      if (!isSuperAdminRole(user.role)) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      next();
    })().catch((e) => {
      console.error('requireSuperAdminApiAuth error:', e);
      res.status(500).json({ error: 'Internal server error' });
    });
  };

  return {
    isAdminRole,
    isSuperAdminRole,
    getSessionFromStore,
    clearActiveSessionForUser,
    getCurrentUserFromDb,
    getValidSessionUser,
    protectAdmin,
    requireApiAuth,
    requireSuperAdminApiAuth,
  };
}

module.exports = createAuthMiddleware;

