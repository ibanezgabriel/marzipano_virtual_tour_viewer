/* Implements database helpers for user records and sessions. */
const crypto = require('crypto');
const { query } = require('./pool');
const { hashPassword } = require('./passwords');

const USERNAME_MAX_LENGTH = 40;
const NAME_MAX_LENGTH = 80;
const MIN_PASSWORD_LENGTH = 8;
const SESSION_TTL_HOURS = 1;
const VALID_ROLES = new Set(['admin', 'superadmin']);
const USER_ID_PREFIX = 'ADM-';
const USER_ID_PAD = 3;
const USER_ID_PATTERN = /^ADM-(\d+)$/i;

/* Updates normalize username. */
function normalizeUsername(value) {
  // Preserve exact casing as entered; use lower(...) only for comparisons.
  return String(value || '').trim();
}

/* Updates normalize name. */
function normalizeName(value) {
  return String(value || '').trim();
}

/* Updates normalize role. */
function normalizeRole(value) {
  const role = String(value || '').trim().toLowerCase();
  return VALID_ROLES.has(role) ? role : 'admin';
}

/* Updates normalize bootstrap password. */
function normalizeBootstrapPassword(value) {
  return String(value || '').trim();
}

/* Validates validate username. */
function validateUsername(username) {
  const normalized = normalizeUsername(username);
  if (!normalized) return 'Username is required.';
  if (normalized.length > USERNAME_MAX_LENGTH) {
    return `Username must be ${USERNAME_MAX_LENGTH} characters or less.`;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    return 'Username can only contain letters, numbers, ".", "_" and "-".';
  }
  return null;
}

/* Validates validate name. */
function validateName(name) {
  const normalized = normalizeName(name);
  if (!normalized) return 'Name is required.';
  if (normalized.length > NAME_MAX_LENGTH) {
    return `Name must be ${NAME_MAX_LENGTH} characters or less.`;
  }
  return null;
}

/* Validates validate password. */
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

/* Handles extract user number. */
function extractUserNumber(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  const admMatch = normalized.match(USER_ID_PATTERN);
  if (admMatch) return Number(admMatch[1]);
  if (/^\d+$/.test(normalized)) return Number(normalized);
  return null;
}

/* Handles format user id. */
function formatUserId(value) {
  const number = extractUserNumber(value);
  if (!Number.isInteger(number) || number <= 0) {
    return String(value || '').trim();
  }
  return `${USER_ID_PREFIX}${String(number).padStart(USER_ID_PAD, '0')}`;
}

/* Handles has active session. */
function hasActiveSession(user) {
  if (!user || !user.active_session_id || !user.active_session_expires_at) return false;
  return new Date(user.active_session_expires_at).getTime() > Date.now();
}

/* Handles map user row. */
function mapUserRow(row) {
  if (!row) return null;
  return {
    id: formatUserId(row.id),
    username: row.username,
    name: row.name,
    role: row.role,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
  };
}

/* Gets find user by username. */
async function findUserByUsername(username) {
  const raw = normalizeUsername(username);
  if (!raw) return null;
  const result = await query(
    `SELECT id, username, name, role, password_hash, active_session_id, active_session_expires_at, is_active, created_at
       FROM users
      WHERE lower(username) = lower($1)
      LIMIT 1`,
    [raw]
  );
  return result.rows[0] || null;
}

/* Gets find user by id. */
async function findUserById(id) {
  const result = await query(
    `SELECT id, username, name, role, password_hash, active_session_id, active_session_expires_at, is_active, created_at
       FROM users
      WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

/* Gets list users. */
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

/* Handles count active super admins. */
async function countActiveSuperAdmins() {
  const result = await query(
    `SELECT COUNT(*)::int AS total
       FROM users
      WHERE role = 'superadmin'
        AND is_active = TRUE`
  );
  return Number(result.rows[0] && result.rows[0].total) || 0;
}

/* Gets get next user id. */
async function getNextUserId() {
  const result = await query(
    `SELECT id
       FROM users
      ORDER BY CASE
        WHEN id ~ '^ADM-[0-9]+$' THEN substring(id from '[0-9]+$')::int
        WHEN id ~ '^[0-9]+$' THEN id::int
        ELSE 0
      END DESC,
      created_at DESC,
      id DESC
      LIMIT 1`
  );
  const lastNumber = extractUserNumber(result.rows[0] && result.rows[0].id);
  return formatUserId((lastNumber || 0) + 1);
}

/* Sets up create user. */
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
  const nextUserId = await getNextUserId();
  const result = await query(
    `INSERT INTO users (id, username, name, role, password_hash, is_active)
     VALUES ($1, $2, $3, $4, $5, TRUE)
     RETURNING id, username, name, role, is_active, created_at`,
    [nextUserId, normalizedUsername, normalizedName, normalizedRole, passwordHash]
  );
  return mapUserRow(result.rows[0]);
}

/* Updates update user. */
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

/* Cleans up delete user. */
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

/* Sets up create session for user. */
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

/* Cleans up clear session for user. */
async function clearSessionForUser(userId) {
  await query(
    `UPDATE users
        SET active_session_id = NULL,
            active_session_expires_at = NULL
      WHERE id = $1`,
    [userId]
  );
}

/* Cleans up clear all sessions. */
async function clearAllSessions() {
  await query(
    `UPDATE users
        SET active_session_id = NULL,
            active_session_expires_at = NULL`
  );
}

/* Gets find user by session. */
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

/* Sets up ensure bootstrap super admin. */
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
  const existing = await findUserByUsername(username);
  if (existing) {
    const result = await query(
      `UPDATE users
          SET name = $2,
              role = 'superadmin',
              password_hash = $3,
              is_active = TRUE
        WHERE username = $1
        RETURNING id, username, name, role, is_active, created_at`,
      [username, name, passwordHash]
    );
    return mapUserRow(result.rows[0]);
  }

  const nextUserId = await getNextUserId();
  const result = await query(
    `INSERT INTO users (id, username, name, role, password_hash, is_active)
     VALUES ($1, $2, $3, 'superadmin', $4, TRUE)
     RETURNING id, username, name, role, is_active, created_at`,
    [nextUserId, username, name, passwordHash]
  );

  return mapUserRow(result.rows[0]);
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  NAME_MAX_LENGTH,
  USERNAME_MAX_LENGTH,
  countActiveSuperAdmins,
  clearSessionForUser,
  clearAllSessions,
  createSessionForUser,
  createUser,
  deleteUser,
  ensureBootstrapSuperAdmin,
  extractUserNumber,
  findUserById,
  findUserBySession,
  findUserByUsername,
  formatUserId,
  hasActiveSession,
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
