const crypto = require('crypto');
const { query } = require('./pool');
const { hashPassword } = require('./passwords');

const USERNAME_MAX_LENGTH = 40;
const NAME_MAX_LENGTH = 80;
const MIN_PASSWORD_LENGTH = 8;
const SESSION_TTL_HOURS = 12;
const VALID_ROLES = new Set(['admin', 'superadmin']);

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeName(value) {
  return String(value || '').trim();
}

function normalizeRole(value) {
  const role = String(value || '').trim().toLowerCase();
  return VALID_ROLES.has(role) ? role : 'admin';
}

function normalizeBootstrapPassword(value) {
  return String(value || '').trim();
}

function validateUsername(username) {
  const normalized = normalizeUsername(username);
  if (!normalized) return 'Username is required.';
  if (normalized.length > USERNAME_MAX_LENGTH) {
    return `Username must be ${USERNAME_MAX_LENGTH} characters or less.`;
  }
  if (!/^[a-z0-9._-]+$/.test(normalized)) {
    return 'Username can only contain lowercase letters, numbers, ".", "_" and "-".';
  }
  return null;
}

function validateName(name) {
  const normalized = normalizeName(name);
  if (!normalized) return 'Name is required.';
  if (normalized.length > NAME_MAX_LENGTH) {
    return `Name must be ${NAME_MAX_LENGTH} characters or less.`;
  }
  return null;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

function mapUserRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    username: row.username,
    name: row.name,
    role: row.role,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
  };
}

async function findUserByUsername(username) {
  const normalized = normalizeUsername(username);
  if (!normalized) return null;
  const result = await query(
    `SELECT id, username, name, role, password_hash, active_session_id, active_session_expires_at, is_active, created_at
       FROM users
      WHERE username = $1`,
    [normalized]
  );
  return result.rows[0] || null;
}

async function findUserById(id) {
  const result = await query(
    `SELECT id, username, name, role, password_hash, active_session_id, active_session_expires_at, is_active, created_at
       FROM users
      WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

async function listUsers({ role } = {}) {
  const params = [];
  let sql = `
    SELECT id, username, name, role, is_active, created_at
      FROM users
  `;
  if (role) {
    params.push(normalizeRole(role));
    sql += ` WHERE role = $${params.length}`;
  }
  sql += ' ORDER BY created_at ASC, id ASC';
  const result = await query(sql, params);
  return result.rows.map(mapUserRow);
}

async function countActiveSuperAdmins() {
  const result = await query(
    `SELECT COUNT(*)::int AS total
       FROM users
      WHERE role = 'superadmin'
        AND is_active = TRUE`
  );
  return Number(result.rows[0] && result.rows[0].total) || 0;
}

async function createUser({ username, name, role = 'admin', password }) {
  const normalizedUsername = normalizeUsername(username);
  const normalizedName = normalizeName(name);
  const normalizedRole = normalizeRole(role);

  const usernameError = validateUsername(normalizedUsername);
  if (usernameError) throw new Error(usernameError);
  const nameError = validateName(normalizedName);
  if (nameError) throw new Error(nameError);
  const passwordError = validatePassword(password);
  if (passwordError) throw new Error(passwordError);

  const passwordHash = await hashPassword(password);
  const result = await query(
    `INSERT INTO users (username, name, role, password_hash, is_active)
     VALUES ($1, $2, $3, $4, TRUE)
     RETURNING id, username, name, role, is_active, created_at`,
    [normalizedUsername, normalizedName, normalizedRole, passwordHash]
  );
  return mapUserRow(result.rows[0]);
}

async function updateUser(id, updates = {}) {
  const existing = await findUserById(id);
  if (!existing) {
    const error = new Error('User not found.');
    error.code = 'NOT_FOUND';
    throw error;
  }

  const nextUsername = updates.username !== undefined ? normalizeUsername(updates.username) : existing.username;
  const nextName = updates.name !== undefined ? normalizeName(updates.name) : existing.name;
  const nextRole = updates.role !== undefined ? normalizeRole(updates.role) : existing.role;
  const nextIsActive = updates.isActive !== undefined ? Boolean(updates.isActive) : Boolean(existing.is_active);

  const usernameError = validateUsername(nextUsername);
  if (usernameError) throw new Error(usernameError);
  const nameError = validateName(nextName);
  if (nameError) throw new Error(nameError);
  if (updates.password !== undefined && updates.password !== null && updates.password !== '') {
    const passwordError = validatePassword(updates.password);
    if (passwordError) throw new Error(passwordError);
  }

  if ((existing.role === 'superadmin' || nextRole === 'superadmin') && !nextIsActive) {
    const count = await countActiveSuperAdmins();
    if (count <= 1) {
      const error = new Error('At least one active super admin account must remain.');
      error.code = 'LAST_SUPERADMIN';
      throw error;
    }
  }

  const values = [id, nextUsername, nextName, nextRole, nextIsActive];
  let sql = `
    UPDATE users
       SET username = $2,
           name = $3,
           role = $4,
           is_active = $5
  `;

  if (updates.password !== undefined && updates.password !== null && updates.password !== '') {
    values.push(await hashPassword(updates.password));
    sql += `,
           password_hash = $${values.length}
    `;
  }

  sql += `
     WHERE id = $1
     RETURNING id, username, name, role, is_active, created_at
  `;

  const result = await query(sql, values);
  return mapUserRow(result.rows[0]);
}

async function deleteUser(id) {
  const existing = await findUserById(id);
  if (!existing) return false;
  if (existing.role === 'superadmin') {
    const count = await countActiveSuperAdmins();
    if (count <= 1) {
      const error = new Error('At least one active super admin account must remain.');
      error.code = 'LAST_SUPERADMIN';
      throw error;
    }
  }
  const result = await query('DELETE FROM users WHERE id = $1', [id]);
  return result.rowCount > 0;
}

async function createSessionForUser(userId, { ttlHours = SESSION_TTL_HOURS } = {}) {
  const sessionId = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
  await query(
    `UPDATE users
        SET active_session_id = $2,
            active_session_expires_at = $3
      WHERE id = $1`,
    [userId, sessionId, expiresAt]
  );
  return {
    sessionId,
    expiresAt,
  };
}

async function clearSessionForUser(userId) {
  await query(
    `UPDATE users
        SET active_session_id = NULL,
            active_session_expires_at = NULL
      WHERE id = $1`,
    [userId]
  );
}

async function findUserBySession(sessionId) {
  if (!sessionId) return null;
  const result = await query(
    `SELECT id, username, name, role, password_hash, active_session_id, active_session_expires_at, is_active, created_at
       FROM users
      WHERE active_session_id = $1
        AND active_session_expires_at IS NOT NULL
        AND active_session_expires_at > NOW()
      LIMIT 1`,
    [sessionId]
  );
  return result.rows[0] || null;
}

async function ensureBootstrapSuperAdmin() {
  const username = normalizeUsername(process.env.SUPERADMIN_USERNAME || 'superadmin');
  const name = normalizeName(process.env.SUPERADMIN_NAME || 'System Super Admin');
  const password = normalizeBootstrapPassword(process.env.SUPERADMIN_PASSWORD);

  const usernameError = validateUsername(username);
  if (usernameError) throw new Error(`Bootstrap super admin username invalid: ${usernameError}`);
  const nameError = validateName(name);
  if (nameError) throw new Error(`Bootstrap super admin name invalid: ${nameError}`);
  const passwordError = validatePassword(password);
  if (passwordError) throw new Error(`Bootstrap super admin password invalid: ${passwordError}`);

  const passwordHash = await hashPassword(password);
  const result = await query(
    `INSERT INTO users (username, name, role, password_hash, is_active)
     VALUES ($1, $2, 'superadmin', $3, TRUE)
     ON CONFLICT (username)
     DO UPDATE SET
       name = EXCLUDED.name,
       role = 'superadmin',
       password_hash = EXCLUDED.password_hash,
       is_active = TRUE
     RETURNING id, username, name, role, is_active, created_at`,
    [username, name, passwordHash]
  );

  return mapUserRow(result.rows[0]);
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  NAME_MAX_LENGTH,
  USERNAME_MAX_LENGTH,
  countActiveSuperAdmins,
  clearSessionForUser,
  createSessionForUser,
  createUser,
  deleteUser,
  ensureBootstrapSuperAdmin,
  findUserById,
  findUserBySession,
  findUserByUsername,
  listUsers,
  mapUserRow,
  normalizeBootstrapPassword,
  normalizeRole,
  normalizeUsername,
  updateUser,
  validateName,
  validatePassword,
  validateUsername,
};
