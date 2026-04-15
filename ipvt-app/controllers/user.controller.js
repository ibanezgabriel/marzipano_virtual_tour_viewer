/* Handles administrator account requests and updates. */
const {
  createUser,
  listUsers,
  normalizeRole,
  updateUser,
} = require('../db/users');
const { serializeUserForClient } = require('../services/auth.service');

/* Returns the requested collection or record. */
async function list(req, res) {
  try {
    const role = req.query && typeof req.query.role === 'string'
      ? normalizeRole(req.query.role)
      : undefined;
    const users = await listUsers({ role });
    return res.json(users.map((user) => serializeUserForClient(user)));
  } catch (error) {
    console.error('Failed to list users:', error);
    return res.status(500).json({ message: 'Unable to load users.' });
  }
}

/* Creates a new record from the request data. */
async function create(req, res) {
  try {
    const user = await createUser({
      username: req.body && req.body.username,
      name: req.body && req.body.name,
      role: req.body && req.body.role ? req.body.role : 'admin',
      password: req.body && req.body.password,
    });
    return res.status(201).json({ user: serializeUserForClient(user) });
  } catch (error) {
    if (error && error.code === '23505') {
      return res.status(409).json({ message: 'Username is already in use.' });
    }
    return res.status(400).json({ message: error.message || 'Unable to create user.' });
  }
}

/* Updates an existing record from the request data. */
async function update(req, res) {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) {
      return res.status(400).json({ message: 'Invalid user id.' });
    }

    const user = await updateUser(id, {
      username: req.body && req.body.username,
      name: req.body && req.body.name,
      role: req.body && req.body.role,
      isActive: req.body && req.body.isActive,
      password: req.body && req.body.password,
    });
    return res.json({ user: serializeUserForClient(user) });
  } catch (error) {
    if (error && error.code === 'NOT_FOUND') {
      return res.status(404).json({ message: 'User not found.' });
    }
    if (error && error.code === 'LAST_SUPERADMIN') {
      return res.status(400).json({ message: error.message });
    }
    if (error && error.code === '23505') {
      return res.status(409).json({ message: 'Username is already in use.' });
    }
    return res.status(400).json({ message: error.message || 'Unable to update user.' });
  }
}

/* Deletes the requested record and its related data. */
function remove(_req, res) {
  return res.status(403).json({ message: 'Account deletion is disabled.' });
}

module.exports = {
  list,
  create,
  update,
  remove,
};
