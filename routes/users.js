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
          action: 'USER:CREATE',
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

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const hasUsername = Object.prototype.hasOwnProperty.call(body, 'username');
    const hasRole = Object.prototype.hasOwnProperty.call(body, 'role');
    const hasActive = Object.prototype.hasOwnProperty.call(body, 'is_active');
    if (!hasUsername && !hasRole && !hasActive) {
      return res.status(400).json({ success: false, message: 'No changes provided' });
    }

    let nextUsername = null;
    if (hasUsername) {
      if (!isValidUsername(body.username)) {
        return res.status(400).json({ success: false, message: 'Invalid username' });
      }
      nextUsername = String(body.username).trim();
    }

    try {
      const beforeRes = await db.query('SELECT id, username, role, is_active FROM users WHERE id = $1', [id]);
      const before = beforeRes.rows[0];
      if (!before) return res.status(404).json({ success: false, message: 'User not found' });
      const targetIsSuperAdmin = isSuperAdminRole(before.role);
      const isSelf = req.session.userId && Number(req.session.userId) === id;
      const requestedRole = hasRole ? normalizeUserRole(body.role) : before.role;
      const requestedIsActive = hasActive ? Boolean(body.is_active) : before.is_active;
      const canEditRoleAndStatus = !targetIsSuperAdmin || !isSelf;

      if (isSelf && !targetIsSuperAdmin) {
        return res.status(400).json({ success: false, message: 'You cannot modify your own account from here.' });
      }
      if (
        targetIsSuperAdmin &&
        isSelf &&
        (
          (hasRole && requestedRole !== before.role) ||
          (hasActive && requestedIsActive !== before.is_active)
        )
      ) {
        return res.status(400).json({
          success: false,
          message: 'You cannot change the role or status of your own Super Admin account.',
        });
      }

      if (nextUsername && nextUsername !== before.username) {
        const exists = await db.query('SELECT 1 FROM users WHERE username = $1 AND id <> $2', [nextUsername, id]);
        if (exists.rows.length > 0) {
          return res.status(409).json({ success: false, message: 'Username already exists' });
        }
      }

      const updates = [];
      const params = [];
      const add = (v) => {
        params.push(v);
        return `$${params.length}`;
      };

      let nextRole = before.role;
      if (canEditRoleAndStatus && hasRole) {
        nextRole = normalizeUserRole(body.role);
        if (nextRole !== before.role) {
          updates.push(`role = ${add(nextRole)}`);
        }
      }

      if (hasUsername && nextUsername !== before.username) {
        updates.push(`username = ${add(nextUsername)}`);
      }

      let nextIsActive = before.is_active;
      if (canEditRoleAndStatus && hasActive) {
        nextIsActive = Boolean(body.is_active);
        if (nextIsActive !== before.is_active) {
          updates.push(`is_active = ${add(nextIsActive)}`);
        }
      }

      if (updates.length === 0) {
        return res.status(400).json({ success: false, message: 'No changes provided' });
      }

      if (isSelf && req.sessionID) {
        const expiresAt = req.session.cookie && req.session.cookie.expires
          ? new Date(req.session.cookie.expires)
          : new Date(Date.now() + (Number(req.session.cookie && req.session.cookie.maxAge) || 0));
        updates.push(`active_session_id = ${add(String(req.sessionID))}`);
        updates.push(`active_session_expires_at = ${add(expiresAt)}`);
      } else {
        updates.push('active_session_id = NULL');
        updates.push('active_session_expires_at = NULL');
      }

      const sql = `UPDATE users SET ${updates.join(', ')} WHERE id = ${add(id)} RETURNING id, username, role, is_active, created_at`;
      const updatedRes = await db.query(sql, params);
      const updated = updatedRes.rows[0];

      if (isSelf) {
        req.session.username = updated.username;
        req.session.role = updated.role;
      }

      try {
        await insertAuditLog({
          projectId: null,
          userId: req.session.userId,
          action: 'USER:UPDATE',
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

    const password = req.body && typeof req.body === 'object' ? req.body.password : null;
    if (!isValidPassword(password)) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    }

    try {
      const userRes = await db.query('SELECT id, username, role FROM users WHERE id = $1', [id]);
      const target = userRes.rows[0];
      if (!target) return res.status(404).json({ success: false, message: 'User not found' });
      const targetIsSuperAdmin = isSuperAdminRole(target.role);
      const isSelf = req.session.userId && Number(req.session.userId) === id;

      if (isSelf && !targetIsSuperAdmin) {
        return res.status(400).json({ success: false, message: 'You cannot reset your own password from here.' });
      }

      const saltRounds = 10;
      const hash = await bcrypt.hash(String(password), saltRounds);
      if (isSelf && req.sessionID) {
        const expiresAt = req.session.cookie && req.session.cookie.expires
          ? new Date(req.session.cookie.expires)
          : new Date(Date.now() + (Number(req.session.cookie && req.session.cookie.maxAge) || 0));
        await db.query(
          'UPDATE users SET password_hash = $1, active_session_id = $2, active_session_expires_at = $3 WHERE id = $4',
          [hash, String(req.sessionID), expiresAt, id]
        );
      } else {
        await db.query(
          'UPDATE users SET password_hash = $1, active_session_id = NULL, active_session_expires_at = NULL WHERE id = $2',
          [hash, id]
        );
      }

      try {
        await insertAuditLog({
          projectId: null,
          userId: req.session.userId,
          action: 'USER:PASSWORD_RESET',
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
