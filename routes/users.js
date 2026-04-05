const express = require('express');

function createUsersRouter({ db, bcrypt, insertAuditLog, requireSuperAdminApiAuth, isSuperAdminRole }) {
  const router = express.Router();

  function isValidUsername(username) {
    const value = String(username || '').trim();
    if (!value) return false;
    if (value.length > 50) return false;
    return /^[A-Za-z0-9_.-]+$/.test(value);
  }

  function isValidPassword(password) {
    const value = String(password || '');
    return value.length >= 8;
  }

  function normalizeUserRole(role) {
    const value = String(role || '').trim().toLowerCase();
    if (value === 'super_admin') return 'super_admin';
    return 'admin';
  }

  router.get('/users', requireSuperAdminApiAuth, async (req, res) => {
    const q = String((req.query && req.query.q) || '').trim();
    try {
      if (q) {
        const like = `%${q}%`;
        const result = await db.query(
          `SELECT id, username, role, is_active, created_at
           FROM users
           WHERE username ILIKE $1 OR role ILIKE $1
           ORDER BY created_at ASC`,
          [like]
        );
        return res.json(result.rows);
      }

      const result = await db.query('SELECT id, username, role, is_active, created_at FROM users ORDER BY created_at ASC');
      res.json(result.rows);
    } catch (e) {
      console.error('Error listing users:', e);
      res.status(500).json({ error: 'Database error' });
    }
  });

  router.post('/users', requireSuperAdminApiAuth, async (req, res) => {
    const { username, password, role } = req.body || {};
    if (!isValidUsername(username)) {
      return res.status(400).json({ success: false, message: 'Invalid username' });
    }
    if (!isValidPassword(password)) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    }
    const nextRole = normalizeUserRole(role);
    try {
      const exists = await db.query('SELECT 1 FROM users WHERE username = $1', [String(username).trim()]);
      if (exists.rows.length > 0) {
        return res.status(409).json({ success: false, message: 'Username already exists' });
      }

      const saltRounds = 10;
      const hash = await bcrypt.hash(String(password), saltRounds);
      const insertRes = await db.query(
        `INSERT INTO users (username, password_hash, role)
         VALUES ($1, $2, $3)
         RETURNING id, username, role, is_active, created_at`,
        [String(username).trim(), hash, nextRole]
      );

      try {
        await insertAuditLog({
          projectId: null,
          userId: req.session.userId,
          action: 'user:create',
          message: `User created: ${insertRes.rows[0].username} (${insertRes.rows[0].role}).`,
          metadata: { user: { id: insertRes.rows[0].id, username: insertRes.rows[0].username, role: insertRes.rows[0].role } },
        });
      } catch (e) {}

      res.json({ success: true, user: insertRes.rows[0] });
    } catch (e) {
      console.error('Error creating user:', e);
      res.status(500).json({ success: false, message: 'Database error' });
    }
  });

  router.patch('/users/:id', requireSuperAdminApiAuth, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ success: false, message: 'Invalid user id' });

    // Disallow self-modification here to avoid accidental lockout.
    if (req.session.userId && Number(req.session.userId) === id) {
      return res.status(400).json({ success: false, message: 'You cannot modify your own account from here.' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const hasUsername = Object.prototype.hasOwnProperty.call(body, 'username');
    const hasRole = Object.prototype.hasOwnProperty.call(body, 'role');
    const hasActive = Object.prototype.hasOwnProperty.call(body, 'is_active');
    if (!hasUsername && !hasRole && !hasActive) {
      return res.status(400).json({ success: false, message: 'No changes provided' });
    }

    const updates = [];
    const params = [];
    const add = (v) => {
      params.push(v);
      return `$${params.length}`;
    };

    let nextRole = null;
    if (hasRole) {
      nextRole = normalizeUserRole(body.role);
      updates.push(`role = ${add(nextRole)}`);
    }

    let nextUsername = null;
    if (hasUsername) {
      if (!isValidUsername(body.username)) {
        return res.status(400).json({ success: false, message: 'Invalid username' });
      }
      nextUsername = String(body.username).trim();
      updates.push(`username = ${add(nextUsername)}`);
    }

    let nextIsActive = null;
    if (hasActive) {
      nextIsActive = Boolean(body.is_active);
      updates.push(`is_active = ${add(nextIsActive)}`);
    }

    // Any admin action should revoke active session to enforce immediate effect.
    updates.push('active_session_id = NULL');
    updates.push('active_session_expires_at = NULL');

    try {
      const beforeRes = await db.query('SELECT id, username, role, is_active FROM users WHERE id = $1', [id]);
      const before = beforeRes.rows[0];
      if (!before) return res.status(404).json({ success: false, message: 'User not found' });
      if (isSuperAdminRole(before.role)) {
        return res.status(403).json({ success: false, message: 'Super Admin accounts cannot be modified.' });
      }

      if (nextUsername && nextUsername !== before.username) {
        const exists = await db.query('SELECT 1 FROM users WHERE username = $1 AND id <> $2', [nextUsername, id]);
        if (exists.rows.length > 0) {
          return res.status(409).json({ success: false, message: 'Username already exists' });
        }
      }

      const sql = `UPDATE users SET ${updates.join(', ')} WHERE id = ${add(id)} RETURNING id, username, role, is_active, created_at`;
      const updatedRes = await db.query(sql, params);
      const updated = updatedRes.rows[0];

      try {
        await insertAuditLog({
          projectId: null,
          userId: req.session.userId,
          action: 'user:update',
          message: nextUsername && nextUsername !== before.username
            ? `Username changed: ${before.username} -> ${updated.username}.`
            : `User updated: ${updated.username}.`,
          metadata: {
            before: { username: before.username, role: before.role, is_active: before.is_active },
            after: { username: updated.username, role: updated.role, is_active: updated.is_active },
            targetUser: { id: updated.id, username: updated.username },
          },
        });
      } catch (e) {}

      res.json({ success: true, user: updated });
    } catch (e) {
      console.error('Error updating user:', e);
      res.status(500).json({ success: false, message: 'Database error' });
    }
  });

  router.post('/users/:id/reset-password', requireSuperAdminApiAuth, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ success: false, message: 'Invalid user id' });

    if (req.session.userId && Number(req.session.userId) === id) {
      return res.status(400).json({ success: false, message: 'You cannot reset your own password from here.' });
    }

    const password = req.body && typeof req.body === 'object' ? req.body.password : null;
    if (!isValidPassword(password)) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    }

    try {
      const userRes = await db.query('SELECT id, username, role FROM users WHERE id = $1', [id]);
      const target = userRes.rows[0];
      if (!target) return res.status(404).json({ success: false, message: 'User not found' });
      if (isSuperAdminRole(target.role)) {
        return res.status(403).json({ success: false, message: 'Super Admin accounts cannot be modified.' });
      }

      const saltRounds = 10;
      const hash = await bcrypt.hash(String(password), saltRounds);
      await db.query(
        'UPDATE users SET password_hash = $1, active_session_id = NULL, active_session_expires_at = NULL WHERE id = $2',
        [hash, id]
      );

      try {
        await insertAuditLog({
          projectId: null,
          userId: req.session.userId,
          action: 'user:password_reset',
          message: `Password reset for user: ${target.username}.`,
          metadata: { targetUser: { id: target.id, username: target.username } },
        });
      } catch (e) {}

      res.json({ success: true });
    } catch (e) {
      console.error('Error resetting password:', e);
      res.status(500).json({ success: false, message: 'Database error' });
    }
  });

  return router;
}

module.exports = createUsersRouter;

