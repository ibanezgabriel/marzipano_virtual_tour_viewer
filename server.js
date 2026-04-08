require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const {
  clearAllSessions,
  clearSessionForUser,
  createSessionForUser,
  createUser,
  findUserBySession,
  findUserByUsername,
  hasActiveSession,
  listUsers,
  mapUserRow,
  normalizeRole,
  updateUser,
} = require('./db/users');
const { verifyPassword } = require('./db/passwords');
const { syncProjectByToken } = require('./db/project-sync');
const {
  buildTilesForImage,
  readTilesMeta,
  tileIdFromFilename,
  removeDirIfExists
} = require('./public/js/tiler');

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const http = require('http');
const { Server } = require('socket.io');

const projectsDir = path.join(__dirname, 'projects');
const projectsManifestPath = path.join(projectsDir, 'projects.json');
const MAX_PROJECT_NUMBER_LENGTH = 20;
const ALLOWED_PROJECT_STATUSES = new Set(['on-going', 'completed']);
const SESSION_COOKIE_NAME = 'ipvt_session';
const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: false,
  path: '/',
};
const AUTH_REQUIRED_PAGE_PATHS = new Set(['/dashboard.html', '/project-editor.html', '/user-management.html']);
const SUPERADMIN_ONLY_PAGE_PATHS = new Set(['/user-management.html']);
const SUPERADMIN_HOME_PATH = '/user-management.html';
const ADMIN_HOME_PATH = '/dashboard.html';

if (!fs.existsSync(projectsDir)) {
  fs.mkdirSync(projectsDir, { recursive: true });
}



function getProjectsManifest() {
  try {
    const raw = fs.readFileSync(projectsManifestPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    let changed = false;
    const normalized = parsed.map((p) => {
      if (!p || typeof p !== 'object') return p;
      const status = normalizeProjectStatus(p.status);
      if (p.status !== status) changed = true;
      return { ...p, status };
    });
    if (changed) {
      writeProjectsManifest(normalized);
    }
    return normalized;
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Error reading projects manifest:', e);
    return [];
  }
}

function writeProjectsManifest(projects) {
  const normalized = Array.isArray(projects)
    ? projects.map((p) => {
        if (!p || typeof p !== 'object') return p;
        return { ...p, status: normalizeProjectStatus(p.status) };
      })
    : projects;
  fs.writeFileSync(projectsManifestPath, JSON.stringify(normalized, null, 2), 'utf8');
}

function emitProjectsChanged() {
  try {
    const projects = getProjectsManifest();
    io.emit('projects:changed', projects);
  } catch (e) {
    console.error('Socket emit error:', e);
  }
}

/**
 * Look up a project by either its internal id or its human-facing number.
 * Returns the full project object or null if not found.
 */
function findProjectByIdOrNumber(token) {
  if (!token) return null;
  const value = String(token).trim();
  if (!value) return null;
  const projects = getProjectsManifest();
  return projects.find((p) => p.id === value || (p.number && String(p.number).trim() === value)) || null;
}

function sanitizeProjectId(name) {
  return name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '') || 'project';
}

function normalizeProjectStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'in-progress') return 'on-going';
  return ALLOWED_PROJECT_STATUSES.has(normalized) ? normalized : 'on-going';
}

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
      } catch (error) {
        cookies[name] = value;
      }
    });
  return cookies;
}

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

async function getAuthenticatedUserFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[SESSION_COOKIE_NAME];
  if (!sessionId) return null;

  const user = await findUserBySession(sessionId);
  if (!user) return null;

  if (!user.is_active) {
    try {
      await clearSessionForUser(user.id);
    } catch (error) {}
    return null;
  }

  return user;
}

async function attachAuthenticatedUser(req, _res, next) {
  if (req.authUser !== undefined) return next();
  try {
    req.authUser = await getAuthenticatedUserFromRequest(req);
    return next();
  } catch (error) {
    console.error('Authentication lookup failed:', error);
    return next(error);
  }
}

function setSessionCookie(res, sessionId, expiresAt) {
  res.cookie(SESSION_COOKIE_NAME, sessionId, {
    ...SESSION_COOKIE_OPTIONS,
    expires: expiresAt,
  });
}

function clearSessionCookie(res) {
  res.cookie(SESSION_COOKIE_NAME, '', {
    ...SESSION_COOKIE_OPTIONS,
    expires: new Date(0),
  });
}

function redirectToLogin(req, res) {
  const redirect = encodeURIComponent(req.originalUrl || req.url || '/dashboard.html');
  res.redirect(`/login.html?redirect=${redirect}`);
}

function getHomePathForUser(user) {
  return user && user.role === 'superadmin' ? SUPERADMIN_HOME_PATH : ADMIN_HOME_PATH;
}

async function syncProjectToDatabaseOrThrow(projectToken, actorUserId) {
  return syncProjectByToken(projectToken, { createdByUserId: actorUserId });
}

function requireAuthenticatedApi(req, res, next) {
  if (req.authUser) return next();
  clearSessionCookie(res);
  return res.status(401).json({ message: 'Authentication required.' });
}

function requireSuperAdminApi(req, res, next) {
  if (!req.authUser) {
    clearSessionCookie(res);
    return res.status(401).json({ message: 'Authentication required.' });
  }
  if (req.authUser.role !== 'superadmin') {
    return res.status(403).json({ message: 'Super admin access is required.' });
  }
  return next();
}

function isProtectedMutationRequest(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return false;
  const requestPath = req.path || '';
  return (
    requestPath === '/api/projects' ||
    /^\/api\/projects\/[^/]+$/.test(requestPath) ||
    requestPath === '/upload' ||
    requestPath === '/upload-floorplan' ||
    requestPath === '/upload-floorplan/update' ||
    requestPath === '/api/floorplans/rename' ||
    /^\/api\/floorplans\/[^/]+$/.test(requestPath) ||
    requestPath === '/api/floorplans/order' ||
    requestPath === '/api/panos/order' ||
    requestPath === '/upload/rename' ||
    requestPath === '/upload/update' ||
    requestPath === '/api/floorplan-hotspots' ||
    requestPath === '/api/blur-masks' ||
    requestPath === '/api/hotspots' ||
    requestPath === '/api/initial-views' ||
    /^\/upload\/[^/]+$/.test(requestPath)
  );
}

/** Get paths for a project. projectId must be validated (no .., no slashes). */
function getProjectPaths(projectId) {
  if (!projectId || projectId.includes('..') || /[\/\\]/.test(projectId)) return null;
  const base = path.join(projectsDir, projectId);
  return {
    base,
    upload: path.join(base, 'upload'),
    floorplans: path.join(base, 'floorplans'),
    tiles: path.join(base, 'tiles'),
    data: path.join(base, 'data'),
  };
}

function ensureProjectDirs(projectId) {
  const p = getProjectPaths(projectId);
  if (!p) return null;
  [p.upload, p.floorplans, p.tiles, p.data].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
  return p;
}

/** Resolve paths: require project id */
function resolvePaths(req) {
  const projectToken = req.query.project || (req.body && req.body.project);
  const project = findProjectByIdOrNumber(projectToken);
  const projectId = project ? project.id : projectToken;
  const p = getProjectPaths(projectId);
  if (!p) return null;
  return {
    uploadsDir: p.upload,
    floorplansDir: p.floorplans,
    tilesDir: p.tiles,
    hotspotsPath: path.join(p.data, 'hotspots.json'),
    blurMasksPath: path.join(p.data, 'blur-masks.json'),
    floorplanHotspotsPath: path.join(p.data, 'floorplan-hotspots.json'),
    initialViewsPath: path.join(p.data, 'initial-views.json'),
    panoramaOrderPath: path.join(p.data, 'panorama-order.json'),
    floorplanOrderPath: path.join(p.data, 'floorplan-order.json'),
    projectId,
  };
}

// ---- Audit log (per active pano / floorplan) ----
const AUDIT_LOG_MAX_ENTRIES = 250;

function getAuditDirs(paths) {
  const dataDir = path.dirname(paths.hotspotsPath);
  const base = path.join(dataDir, 'audit');
  return {
    base,
    panos: path.join(base, 'panos'),
    floorplans: path.join(base, 'floorplans'),
    imagesBase: path.join(base, 'images'),
    panoImages: path.join(base, 'images', 'panos'),
    floorplanImages: path.join(base, 'images', 'floorplans'),
  };
}

function ensureDirSync(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function auditLogPath(paths, kind, filename) {
  const dirs = getAuditDirs(paths);
  const safe = encodeURIComponent(String(filename || ''));
  const baseDir = kind === 'floorplan' ? dirs.floorplans : dirs.panos;
  return path.join(baseDir, `${safe}.json`);
}

function auditImagePath(paths, kind, storedFilename) {
  const dirs = getAuditDirs(paths);
  const baseDir = kind === 'floorplan' ? dirs.floorplanImages : dirs.panoImages;
  return path.join(baseDir, storedFilename);
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch (e) {
    return value;
  }
}

function resolveArchiveImagePath(paths, kind, storedFilename) {
  const dirs = getAuditDirs(paths);
  const baseDir = kind === 'floorplan' ? dirs.floorplanImages : dirs.panoImages;
  const candidates = new Set();
  const raw = String(storedFilename || '');
  const dec1 = safeDecodeURIComponent(raw);
  const dec2 = safeDecodeURIComponent(dec1);

  [raw, dec1, dec2, encodeURIComponent(raw), encodeURIComponent(dec1)]
    .filter(Boolean)
    .forEach((name) => {
      if (name.includes('..') || name.includes('/') || name.includes('\\')) return;
      candidates.add(name);
    });

  for (const candidate of candidates) {
    const candidatePath = path.join(baseDir, candidate);
    if (fs.existsSync(candidatePath)) return candidatePath;
  }

  // Legacy fallback: some older logs may store only a suffix of the archived filename.
  try {
    const files = fs.readdirSync(baseDir);
    for (const candidate of candidates) {
      const match = files.find((name) => name === candidate || name.endsWith(`-${candidate}`));
      if (match) return path.join(baseDir, match);
    }
  } catch (e) {}

  return null;
}

function createAuditImageStoredFilename(filename) {
  const encoded = encodeURIComponent(String(filename || 'image'));
  const nonce = Math.random().toString(36).slice(2, 8);
  return `${Date.now()}-${nonce}-${encoded}`;
}

function storeReplacedImageInAudit(paths, kind, originalFilename, sourcePath) {
  if (!paths || !sourcePath || !fs.existsSync(sourcePath)) return null;
  const dirs = getAuditDirs(paths);
  ensureDirSync(dirs.base);
  ensureDirSync(dirs.imagesBase);
  ensureDirSync(kind === 'floorplan' ? dirs.floorplanImages : dirs.panoImages);
  const storedFilename = createAuditImageStoredFilename(originalFilename);
  const targetPath = auditImagePath(paths, kind, storedFilename);
  fs.copyFileSync(sourcePath, targetPath);
  return {
    kind,
    originalFilename: String(originalFilename || ''),
    storedFilename,
  };
}

function readJsonFileOrDefault(filePath, defaultValue) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed ?? defaultValue;
  } catch (e) {
    if (e && e.code === 'ENOENT') return defaultValue;
    console.error('Error reading json file:', filePath, e);
    return defaultValue;
  }
}

function readAuditEntries(paths, kind, filename) {
  const filePath = auditLogPath(paths, kind, filename);
  const parsed = readJsonFileOrDefault(filePath, null);
  return Array.isArray(parsed) ? parsed : null;
}

function writeAuditEntries(paths, kind, filename, entries) {
  const dirs = getAuditDirs(paths);
  ensureDirSync(dirs.base);
  ensureDirSync(kind === 'floorplan' ? dirs.floorplans : dirs.panos);
  const filePath = auditLogPath(paths, kind, filename);
  fs.writeFileSync(filePath, JSON.stringify(entries, null, 2), 'utf8');
}

function appendAuditEntry(paths, kind, filename, { action, message, meta } = {}, { dedupeWindowMs = 0 } = {}) {
  if (!paths || !filename) return;
  try {
    const existing = readAuditEntries(paths, kind, filename) || [];
    const nowIso = new Date().toISOString();
    const entry = {
      ts: nowIso,
      action: action || 'update',
      message: message || action || 'Update',
      ...(meta && typeof meta === 'object' ? { meta } : {}),
    };
    if (dedupeWindowMs > 0 && existing.length > 0) {
      const last = existing[existing.length - 1];
      const lastTs = last && last.ts ? new Date(last.ts).getTime() : 0;
      const nowTs = Date.now();
      const sameAction = last && last.action === entry.action && last.message === entry.message;
      if (sameAction && lastTs && nowTs - lastTs < dedupeWindowMs) {
        return;
      }
    }
    const updated = [...existing, entry].slice(-AUDIT_LOG_MAX_ENTRIES);
    writeAuditEntries(paths, kind, filename, updated);
  } catch (e) {
    console.error('Error appending audit entry:', e);
  }
}

function buildAuditMeta(meta, user) {
  const nextMeta = meta && typeof meta === 'object' ? { ...meta } : {};
  const userId = user && String(user.id || '').trim();
  if (userId) {
    nextMeta.createdByUserId = userId;
  }
  return Object.keys(nextMeta).length > 0 ? nextMeta : undefined;
}

function initAuditLogIfMissing(paths, kind, filename) {
  if (!paths || !filename) return;
  const existing = readAuditEntries(paths, kind, filename);
  if (Array.isArray(existing)) return;
  const baseline = [
    {
      ts: new Date().toISOString(),
      action: 'archive-enabled',
      message: 'No previous records are available.',
    },
  ];
  try {
    writeAuditEntries(paths, kind, filename, baseline);
  } catch (e) {
    console.error('Error initializing audit log:', e);
  }
}

function parseReplacedFilenamesFromAuditMessage(message) {
  const text = String(message || '');
  const match = text.match(/replaced\s+"([^"]+)"\s+with\s+"([^"]+)"/i);
  if (!match) return null;
  const oldFilename = (match[1] || '').trim();
  const newFilename = (match[2] || '').trim();
  if (!oldFilename || !newFilename) return null;
  return { oldFilename, newFilename };
}

function repairArchiveMetaInEntry(paths, kind, entry) {
  if (!entry || typeof entry !== 'object') return { entry, changed: false };
  const replaced = parseReplacedFilenamesFromAuditMessage(entry.message);
  if (!replaced) return { entry, changed: false };

  const currentMeta = entry.meta && typeof entry.meta === 'object' ? entry.meta : {};
  const currentArchived = currentMeta.archivedImage && typeof currentMeta.archivedImage === 'object'
    ? currentMeta.archivedImage
    : null;
  const metaKind = currentArchived && currentArchived.kind === 'floorplan' ? 'floorplan' : kind;
  const originalFilename = currentArchived && currentArchived.originalFilename
    ? String(currentArchived.originalFilename)
    : replaced.oldFilename;
  const currentStored = currentArchived && currentArchived.storedFilename
    ? String(currentArchived.storedFilename)
    : '';

  let resolvedPath = null;
  if (currentStored) {
    resolvedPath = resolveArchiveImagePath(paths, metaKind, currentStored);
  }
  if (!resolvedPath && originalFilename) {
    resolvedPath = resolveArchiveImagePath(paths, metaKind, originalFilename);
  }
  if (!resolvedPath) return { entry, changed: false };

  const resolvedStoredFilename = path.basename(resolvedPath);
  const nextArchived = {
    kind: metaKind,
    originalFilename,
    storedFilename: resolvedStoredFilename,
  };
  const sameAsCurrent =
    currentArchived &&
    currentArchived.kind === nextArchived.kind &&
    String(currentArchived.originalFilename || '') === nextArchived.originalFilename &&
    String(currentArchived.storedFilename || '') === nextArchived.storedFilename;
  if (sameAsCurrent) return { entry, changed: false };

  return {
    entry: {
      ...entry,
      meta: {
        ...currentMeta,
        archivedImage: nextArchived,
      },
    },
    changed: true,
  };
}

function readAndRepairAuditEntries(paths, kind, filename) {
  const existing = readAuditEntries(paths, kind, filename) || [];
  if (!Array.isArray(existing) || existing.length === 0) return Array.isArray(existing) ? existing : [];
  let changed = false;
  const repaired = existing.map((entry) => {
    const result = repairArchiveMetaInEntry(paths, kind, entry);
    if (result.changed) changed = true;
    return result.entry;
  });
  if (changed) {
    try {
      writeAuditEntries(paths, kind, filename, repaired);
    } catch (e) {
      console.error('Error writing repaired audit entries:', e);
    }
  }
  return repaired;
}

function renameAuditLog(paths, kind, oldFilename, newFilename) {
  if (!paths || !oldFilename || !newFilename || oldFilename === newFilename) return;
  try {
    const oldPath = auditLogPath(paths, kind, oldFilename);
    if (!fs.existsSync(oldPath)) return;
    const dirs = getAuditDirs(paths);
    ensureDirSync(dirs.base);
    ensureDirSync(kind === 'floorplan' ? dirs.floorplans : dirs.panos);
    const newPath = auditLogPath(paths, kind, newFilename);
    if (!fs.existsSync(newPath)) {
      fs.renameSync(oldPath, newPath);
      return;
    }
    const oldEntries = readJsonFileOrDefault(oldPath, []);
    const newEntries = readJsonFileOrDefault(newPath, []);
    const merged = [...(Array.isArray(newEntries) ? newEntries : []), ...(Array.isArray(oldEntries) ? oldEntries : [])];
    merged.sort((a, b) => new Date(a.ts || 0).getTime() - new Date(b.ts || 0).getTime());
    fs.writeFileSync(newPath, JSON.stringify(merged.slice(-AUDIT_LOG_MAX_ENTRIES), null, 2), 'utf8');
    fs.unlinkSync(oldPath);
  } catch (e) {
    console.error('Error renaming audit log:', e);
  }
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value)
      .sort()
      .forEach((k) => {
        out[k] = sortDeep(value[k]);
      });
    return out;
  }
  return value;
}

function stableStringify(value) {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(sortDeep(value));
  } catch (e) {
    return String(value);
  }
}

function diffChangedTopLevelKeys(beforeObj, afterObj) {
  const before = beforeObj && typeof beforeObj === 'object' ? beforeObj : {};
  const after = afterObj && typeof afterObj === 'object' ? afterObj : {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [];
  keys.forEach((k) => {
    if (stableStringify(before[k]) !== stableStringify(after[k])) changed.push(k);
  });
  return changed;
}

function normalizeTopLevelArrayMap(obj) {
  const source = obj && typeof obj === 'object' ? obj : {};
  const normalized = {};
  Object.keys(source).forEach((key) => {
    const value = source[key];
    if (!Array.isArray(value) || value.length === 0) return;
    normalized[key] = value;
  });
  return normalized;
}

function getArrayCountByKey(obj, key) {
  if (!obj || typeof obj !== 'object') return 0;
  return Array.isArray(obj[key]) ? obj[key].length : 0;
}

function buildCollectionChangeMessage(labelSingular, labelPlural, beforeCount, afterCount) {
  const before = Math.max(0, Number(beforeCount) || 0);
  const after = Math.max(0, Number(afterCount) || 0);
  if (after > before) {
    const delta = after - before;
    return delta === 1 ? `${labelSingular} added.` : `${delta} ${labelPlural} added.`;
  }
  if (after < before) {
    const delta = before - after;
    return delta === 1 ? `${labelSingular} removed.` : `${delta} ${labelPlural} removed.`;
  }
  return `${labelPlural.charAt(0).toUpperCase()}${labelPlural.slice(1)} updated (${after}).`;
}

// Middleware to parse JSON bodies
app.use(express.json());

app.use(async (req, res, next) => {
  const requestPath = req.path || '';
  if (!AUTH_REQUIRED_PAGE_PATHS.has(requestPath)) return next();

  try {
    const user = await getAuthenticatedUserFromRequest(req);
    if (!user) {
      clearSessionCookie(res);
      return redirectToLogin(req, res);
    }

    req.authUser = user;

    if (user.role === 'superadmin' && requestPath !== SUPERADMIN_HOME_PATH) {
      return res.redirect(SUPERADMIN_HOME_PATH);
    }

    if (SUPERADMIN_ONLY_PAGE_PATHS.has(requestPath) && user.role !== 'superadmin') {
      return res.redirect(ADMIN_HOME_PATH);
    }

    return next();
  } catch (error) {
    console.error('Protected page check failed:', error);
    return res.status(503).send('Authentication is temporarily unavailable.');
  }
});

app.use(async (req, res, next) => {
  if (!isProtectedMutationRequest(req)) return next();

  try {
    const user = await getAuthenticatedUserFromRequest(req);
    if (!user) {
      clearSessionCookie(res);
      return res.status(401).json({ message: 'Authentication required.' });
    }

    req.authUser = user;
    return next();
  } catch (error) {
    console.error('Protected API check failed:', error);
    return res.status(503).json({ message: 'Authentication is temporarily unavailable.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const username = String((req.body && req.body.username) || '').trim().toLowerCase();
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
});

app.get('/api/auth/status', attachAuthenticatedUser, (req, res) => {
  return res.json({
    authenticated: Boolean(req.authUser),
    user: req.authUser ? serializeUserForClient(req.authUser) : null,
  });
});

app.get('/api/auth/me', attachAuthenticatedUser, (req, res) => {
  if (!req.authUser) {
    clearSessionCookie(res);
    return res.status(401).json({ message: 'Not signed in.' });
  }
  return res.json({ user: serializeUserForClient(req.authUser) });
});

app.post('/api/auth/logout', attachAuthenticatedUser, async (req, res) => {
  try {
    if (req.authUser) {
      await clearSessionForUser(req.authUser.id);
    }
  } catch (error) {
    console.error('Logout cleanup failed:', error);
  }

  clearSessionCookie(res);
  return res.json({ success: true });
});

app.get('/api/users', attachAuthenticatedUser, requireSuperAdminApi, async (req, res) => {
  try {
    const role = req.query && typeof req.query.role === 'string' ? normalizeRole(req.query.role) : undefined;
    const users = await listUsers({ role });
    return res.json(users.map((user) => serializeUserForClient(user)));
  } catch (error) {
    console.error('Failed to list users:', error);
    return res.status(500).json({ message: 'Unable to load users.' });
  }
});

app.post('/api/users', attachAuthenticatedUser, requireSuperAdminApi, async (req, res) => {
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
});

app.put('/api/users/:id', attachAuthenticatedUser, requireSuperAdminApi, async (req, res) => {
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
});

app.delete('/api/users/:id', attachAuthenticatedUser, requireSuperAdminApi, async (req, res) => {
  return res.status(403).json({ message: 'Account deletion is disabled.' });
});

// Serve static files
/**
 * Block access to admin.html and client.html when a project is requested
 * but the project does not exist or has no uploaded panoramas. This
 * runs before the static file middleware so we can conditionally deny
 * serving those pages.
 */
function getProjectIdFromQuery(req) {
  if (req.query && typeof req.query === 'object') {
    let token = null;
    if (typeof req.query.project === 'string' && req.query.project.length > 0) {
      token = req.query.project;
    } else {
      const keys = Object.keys(req.query);
      if (keys.length === 1 && req.query[keys[0]] === '') token = keys[0];
    }
    if (token) {
      const project = findProjectByIdOrNumber(token);
      return project ? project.id : token;
    }
  }
  return null;
}

app.use((req, res, next) => {
  const ppath = req.path || '';
  // Only guard admin.html and client.html; allow other static assets
  if (ppath !== '/dashboard.html' && ppath !== '/project-viewer.html') return next();
  try {
    const projectId = getProjectIdFromQuery(req);
    // If no project specified, let the page load (admin shows list, client may show generic view)
    if (!projectId) return next();

    const p = getProjectPaths(projectId);
    if (!p || !fs.existsSync(p.base)) {
      const safeId = String(projectId || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
      return res.status(404).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Project not found</title>
  <style>
    html,body{height:100%;margin:0;background:#f7f7fb;font-family:Inter,system-ui,Segoe UI,Roboto,Arial,sans-serif}
    .wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{max-width:640px;width:100%;background:white;border-radius:12px;box-shadow:0 8px 30px rgba(22,30,60,0.08);padding:32px;text-align:center}
    .title{font-size:20px;margin:0 0 8px;font-weight:700;font-style:italic}
    .sub{color:#555;margin:0 0 16px}
    .hint{color:#777;font-size:13px}
    .actions{margin-top:18px}
    .btn{display:inline-block;padding:10px 14px;border-radius:8px;background:#2563eb;color:white;text-decoration:none;font-weight:600}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1 class="title">Project not found</h1>
      <p class="sub">We couldn't find the project<strong style="font-style:italic"> ${safeId || '(unspecified)'}</strong>.</p>
  </div>
</body>
</html>`);
    }

    // Admin may access an empty project (to upload/manage)
    if (ppath === '/dashboard.html') return next();

    // Client requires at least one generated tileset (meta.json under tiles)
    const tilesDir = p.tiles;
    const hasReadyTiles = (tilesRoot) => {
      try {
        if (!fs.existsSync(tilesRoot)) return false;
        const children = fs.readdirSync(tilesRoot, { withFileTypes: true });
        for (const d of children) {
          if (!d.isDirectory()) continue;
          const metaPath = path.join(tilesRoot, d.name, 'meta.json');
          if (fs.existsSync(metaPath)) return true;
        }
      } catch (e) {
        console.error('Error checking tiles:', e);
      }
      return false;
    };

    if (!hasReadyTiles(tilesDir)) {
      return res.status(404).send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not ready</title><style>html,body{height:100%;margin:0} .c{height:100vh;display:flex;align-items:center;justify-content:center;font-family:Arial,sans-serif} .msg{font-style:italic;font-weight:700}</style></head><body><div class="c"><div class="msg">Project is not yet published.</div></div></body></html>`);
    }

    return next();
  } catch (e) {
    console.error('Error in dashboard/project-viewer guard middleware:', e);
    return next();
  }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));



// Project-scoped static: /projects/:id/upload and /projects/:id/tiles
const projectRouter = express.Router({ mergeParams: true });
projectRouter.use('/upload', (req, res, next) => {
  const token = req.params.projectId;
  const project = findProjectByIdOrNumber(token);
  const id = project ? project.id : token;
  if (id.includes('..') || id.includes('/') || id.includes('\\')) return res.status(400).send('Invalid project');
  const p = getProjectPaths(id);
  if (!p) return res.status(400).send('Invalid project');
  if (!fs.existsSync(p.upload)) return next();
  express.static(p.upload)(req, res, next);
});
projectRouter.use('/floorplans', (req, res, next) => {
  const token = req.params.projectId;
  const project = findProjectByIdOrNumber(token);
  const id = project ? project.id : token;
  if (id.includes('..') || id.includes('/') || id.includes('\\')) return res.status(400).send('Invalid project');
  const p = getProjectPaths(id);
  if (!p) return res.status(400).send('Invalid project');
  if (!fs.existsSync(p.floorplans)) return next();
  express.static(p.floorplans)(req, res, next);
});
projectRouter.use('/tiles', (req, res, next) => {
  const token = req.params.projectId;
  const project = findProjectByIdOrNumber(token);
  const id = project ? project.id : token;
  if (id.includes('..') || id.includes('/') || id.includes('\\')) return res.status(400).send('Invalid project');
  const p = getProjectPaths(id);
  if (!p) return res.status(400).send('Invalid project');
  if (!fs.existsSync(p.tiles)) return next();
  express.static(p.tiles)(req, res, next);
});
app.use('/projects/:projectId', projectRouter);

// Create HTTP server and socket.io for realtime updates
const https = require('https');

const sslOptions = {
  key: fs.readFileSync(path.join(__dirname, 'key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'cert.pem')),
};

const server = https.createServer(sslOptions, app);
const io = new Server(server);

io.on('connection', (socket) => {
  // Allow clients to join project-specific rooms so they only receive relevant pano events
  socket.on('joinProject', (projectId) => {
    try {
      if (typeof projectId === 'string' && projectId.length > 0) socket.join(`project:${projectId}`);
    } catch (e) {}
  });
  socket.on('leaveProject', (projectId) => {
    try {
      if (typeof projectId === 'string' && projectId.length > 0) socket.leave(`project:${projectId}`);
    } catch (e) {}
  });
});

// Multer: dynamic destination based on project (set by route)
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const projectToken = req.query.project || (req.body && req.body.project);
      const project = findProjectByIdOrNumber(projectToken);
      const projectId = project ? project.id : projectToken;
      const p = getProjectPaths(projectId);
      if (!p) return cb(new Error('Project required'), null);
      const dir = p.upload;
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      cb(null, Date.now() + '-' + file.originalname);
    },
  }),
});

// Separate storage for floor plan images (project-scoped "floorplans" directory)
const floorplanUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const projectToken = req.query.project || (req.body && req.body.project);
      const project = findProjectByIdOrNumber(projectToken);
      const projectId = project ? project.id : projectToken;
      const p = getProjectPaths(projectId);
      if (!p) return cb(new Error('Project required'), null);
      const dir = p.floorplans;
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      cb(null, Date.now() + '-' + file.originalname);
    },
  }),
});

async function listUploadedImages(uploadsDir) {
  const files = await fs.promises.readdir(uploadsDir);
  return files.filter(file => /\.(jpg|jpeg|png|gif|webp|jfif)$/i.test(file));
}

async function listFloorplanImages(floorplansDir) {
  try {
    const files = await fs.promises.readdir(floorplansDir);
    return files.filter(file => /\.(jpg|jpeg|png|gif|webp|jfif)$/i.test(file));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Error reading floorplans dir:', e);
    return [];
  }
}

function readFloorplanOrder(floorplanOrderPath) {
  try {
    const raw = fs.readFileSync(floorplanOrderPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Error reading floorplan order:', e);
    return [];
  }
}

function writeFloorplanOrder(floorplanOrderPath, order) {
  const dir = path.dirname(floorplanOrderPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(floorplanOrderPath, JSON.stringify(order, null, 2), 'utf8');
}

function readFloorplanHotspots(floorplanHotspotsPath) {
  try {
    const raw = fs.readFileSync(floorplanHotspotsPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Error reading floor plan hotspots:', e);
    return {};
  }
}

function writeFloorplanHotspots(floorplanHotspotsPath, hotspots) {
  const dir = path.dirname(floorplanHotspotsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(floorplanHotspotsPath, JSON.stringify(hotspots, null, 2), 'utf8');
}

function readBlurMasks(blurMasksPath) {
  try {
    const raw = fs.readFileSync(blurMasksPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Error reading blur masks:', e);
    return {};
  }
}

function writeBlurMasks(blurMasksPath, blurMasks) {
  const dir = path.dirname(blurMasksPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(blurMasksPath, JSON.stringify(blurMasks, null, 2), 'utf8');
}

function renameBlurMasksForPano(paths, oldFilename, newFilename) {
  if (!oldFilename || !newFilename || oldFilename === newFilename) {
    return { changed: false, blurMasks: null };
  }
  const blurMasks = readBlurMasks(paths.blurMasksPath);
  if (!Object.prototype.hasOwnProperty.call(blurMasks, oldFilename)) {
    return { changed: false, blurMasks: null };
  }
  const oldList = Array.isArray(blurMasks[oldFilename]) ? blurMasks[oldFilename] : [];
  const newList = Array.isArray(blurMasks[newFilename]) ? blurMasks[newFilename] : [];
  blurMasks[newFilename] = [...newList, ...oldList];
  delete blurMasks[oldFilename];
  writeBlurMasks(paths.blurMasksPath, blurMasks);
  return { changed: true, blurMasks };
}

function clearBlurMasksForPano(paths, filename) {
  if (!filename) return { changed: false, blurMasks: null };
  const blurMasks = readBlurMasks(paths.blurMasksPath);
  if (!Object.prototype.hasOwnProperty.call(blurMasks, filename)) {
    return { changed: false, blurMasks: null };
  }
  delete blurMasks[filename];
  writeBlurMasks(paths.blurMasksPath, blurMasks);
  return { changed: true, blurMasks };
}

function clearFloorplanHotspotsForFilenames(paths, filenames) {
  const names = Array.from(new Set((filenames || []).filter(Boolean)));
  if (names.length === 0) return { changed: false, hotspots: null };
  const hotspots = readFloorplanHotspots(paths.floorplanHotspotsPath);
  let changed = false;
  names.forEach((name) => {
    if (Object.prototype.hasOwnProperty.call(hotspots, name)) {
      delete hotspots[name];
      changed = true;
    }
  });
  if (changed) writeFloorplanHotspots(paths.floorplanHotspotsPath, hotspots);
  return { changed, hotspots };
}

function floorplanOrderReplace(paths, oldFilename, newFilename) {
  const order = readFloorplanOrder(paths.floorplanOrderPath);
  const i = order.indexOf(oldFilename);
  if (i !== -1) order[i] = newFilename;
  else order.push(newFilename);
  const deduped = [];
  const seen = new Set();
  for (const f of order) {
    if (seen.has(f)) continue;
    seen.add(f);
    deduped.push(f);
  }
  writeFloorplanOrder(paths.floorplanOrderPath, deduped);
  return deduped;
}

/** Return ordered list of floor plan filenames; stored order first, then any new files not in list. */
async function getOrderedFloorplanFilenames(paths) {
  const existing = await listFloorplanImages(paths.floorplansDir);
  const existingSet = new Set(existing);
  let order = readFloorplanOrder(paths.floorplanOrderPath).filter(f => existingSet.has(f));
  const inOrder = new Set(order);
  const appended = existing.filter(f => !inOrder.has(f));
  const result = [...order, ...appended];
  const orderChanged = order.length !== result.length || appended.length > 0;
  if (orderChanged && result.length > 0) {
    writeFloorplanOrder(paths.floorplanOrderPath, result);
  }
  return result;
}

function floorplanOrderAppend(paths, filenames) {
  const order = readFloorplanOrder(paths.floorplanOrderPath);
  const set = new Set(order);
  let changed = false;
  for (const f of filenames || []) {
    if (!f || set.has(f)) continue;
    order.push(f);
    set.add(f);
    changed = true;
  }
  if (changed) writeFloorplanOrder(paths.floorplanOrderPath, order);
  return order;
}

/** Return ordered list of panorama filenames: stored order first, then any new uploads not in list. */
async function getOrderedFilenames(paths) {
  const existing = await listUploadedImages(paths.uploadsDir);
  const existingSet = new Set(existing);
  let parsedOrder = [];
  try {
    const raw = fs.readFileSync(paths.panoramaOrderPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) parsedOrder = parsed;
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Error reading panorama order:', e);
  }
  const seen = new Set();
  const order = parsedOrder.filter((f) => {
    if (!existingSet.has(f) || seen.has(f)) return false;
    seen.add(f);
    return true;
  });
  const inOrder = new Set(order);
  const appended = existing.filter(f => !inOrder.has(f));
  const result = [...order, ...appended];
  const orderChanged = parsedOrder.length !== order.length || parsedOrder.some((v, i) => v !== order[i]);
  if ((orderChanged || appended.length > 0) && result.length > 0) {
    writePanoramaOrder(paths.panoramaOrderPath, result);
  }
  return result;
}

function readPanoramaOrder(panoramaOrderPath) {
  try {
    const raw = fs.readFileSync(panoramaOrderPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Error reading panorama order:', e);
    return [];
  }
}

function writePanoramaOrder(panoramaOrderPath, order) {
  fs.writeFileSync(panoramaOrderPath, JSON.stringify(order, null, 2), 'utf8');
}

function panoramaOrderReplace(paths, oldFilename, newFilename) {
  const order = readPanoramaOrder(paths.panoramaOrderPath);
  const replaced = order.map((f) => (f === oldFilename ? newFilename : f));
  const deduped = [];
  const seen = new Set();
  for (const f of replaced) {
    if (seen.has(f)) continue;
    seen.add(f);
    deduped.push(f);
  }
  if (!seen.has(newFilename)) deduped.push(newFilename);
  writePanoramaOrder(paths.panoramaOrderPath, deduped);
}

function panoramaOrderRemove(paths, filename) {
  const order = readPanoramaOrder(paths.panoramaOrderPath).filter(f => f !== filename);
  writePanoramaOrder(paths.panoramaOrderPath, order);
}

function panoramaOrderAppend(paths, filenames) {
  const order = readPanoramaOrder(paths.panoramaOrderPath);
  const set = new Set(order);
  for (const f of filenames) if (!set.has(f)) { order.push(f); set.add(f); }
  writePanoramaOrder(paths.panoramaOrderPath, order);
}

async function ensureTilesForFilename(paths, filename) {
  const meta = await readTilesMeta({ tilesRootDir: paths.tilesDir, filename });
  if (meta) return meta;

  const imagePath = path.join(paths.uploadsDir, filename);
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image not found: ${filename}`);
  }

  await buildTilesForImage({
    imagePath,
    filename,
    tilesRootDir: paths.tilesDir
  });
  const builtMeta = await readTilesMeta({ tilesRootDir: paths.tilesDir, filename });
  if (!builtMeta) throw new Error('Tiles built but meta.json missing');
  return builtMeta;
}

// ---- Project APIs ----
app.get('/api/projects', (req, res) => {
  const projects = getProjectsManifest();
  res.json(projects);
});

app.post('/api/projects', async (req, res) => {
  const { name, number, status } = req.body || {};
  if (number === undefined || number === null || !String(number).trim()) {
    return res.status(400).json({ success: false, message: 'Project number is required' });
  }
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ success: false, message: 'Project name is required' });
  }
  const trimmedName = name.trim();
  const trimmedNumber = String(number).trim();
  if (!/^[A-Za-z0-9-]+$/.test(trimmedNumber)) {
    return res.status(400).json({ success: false, message: 'Project number can only contain letters, numbers, and "-"' });
  }
  if (trimmedNumber.length > MAX_PROJECT_NUMBER_LENGTH) {
    return res.status(400).json({ success: false, message: `Project number must be ${MAX_PROJECT_NUMBER_LENGTH} characters or less` });
  }
  let id = sanitizeProjectId(name);
  const projects = getProjectsManifest();
  const normalized = trimmedName.toLowerCase();
  if (projects.some((p) => (p.name || '').trim().toLowerCase() === normalized)) {
    return res.status(409).json({ success: false, message: 'A project with this name already exists' });
  }
  if (projects.some((p) => String(p.number || '').trim() === trimmedNumber)) {
    return res.status(409).json({ success: false, message: 'A project with this number already exists' });
  }
  if (projects.some(p => p.id === id)) {
    let suffix = 1;
    while (projects.some(p => p.id === `${id}-${suffix}`)) suffix++;
    id = `${id}-${suffix}`;
  }
  const finalId = id;
  ensureProjectDirs(finalId);
  const project = { id: finalId, name: trimmedName, number: trimmedNumber, status: normalizeProjectStatus(status) };
  projects.push(project);
  writeProjectsManifest(projects);
  try {
    await syncProjectToDatabaseOrThrow(finalId, req.authUser && req.authUser.id);
  } catch (error) {
    console.error('Project database sync failed after create:', error);
    return res.status(500).json({ success: false, message: 'Project saved, but database sync failed.' });
  }
  // Notify connected clients about project list changes
  emitProjectsChanged();
  res.json(project);
});

app.put('/api/projects/:id', async (req, res) => {
  const projectToken = String(req.params.id || '').trim();
  if (!projectToken || projectToken.includes('..') || projectToken.includes('/') || projectToken.includes('\\')) {
    return res.status(400).json({ success: false, message: 'Invalid project id' });
  }
  const { name, number, status } = req.body || {};
  if (number === undefined || number === null || !String(number).trim()) {
    return res.status(400).json({ success: false, message: 'Project number is required' });
  }
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ success: false, message: 'Project name is required' });
  }
  const projects = getProjectsManifest();
  const idx = projects.findIndex((project) => (
    String(project && project.id || '').trim() === projectToken ||
    String(project && project.number || '').trim() === projectToken
  ));
  if (idx === -1) return res.status(404).json({ success: false, message: 'Project not found' });
  const oldId = String(projects[idx].id || '').trim();
  const trimmedName = name.trim();
  const trimmedNumber = String(number).trim();
  if (!/^[A-Za-z0-9-]+$/.test(trimmedNumber)) {
    return res.status(400).json({ success: false, message: 'Project number can only contain letters, numbers, and "-"' });
  }
  if (trimmedNumber.length > MAX_PROJECT_NUMBER_LENGTH) {
    return res.status(400).json({ success: false, message: `Project number must be ${MAX_PROJECT_NUMBER_LENGTH} characters or less` });
  }
  const normalized = trimmedName.toLowerCase();
  if (projects.some((p, i) => i !== idx && (p.name || '').trim().toLowerCase() === normalized)) {
    return res.status(409).json({ success: false, message: 'A project with this name already exists' });
  }
  if (projects.some((p, i) => i !== idx && String(p.number || '').trim() === trimmedNumber)) {
    return res.status(409).json({ success: false, message: 'A project with this number already exists' });
  }

  let newId = sanitizeProjectId(trimmedName);
  if (projects.some((p, i) => i !== idx && p.id === newId)) {
    let suffix = 1;
    while (projects.some((p, i) => i !== idx && p.id === `${newId}-${suffix}`)) suffix++;
    newId = `${newId}-${suffix}`;
  }

  if (newId !== oldId) {
    const oldPaths = getProjectPaths(oldId);
    const newPaths = getProjectPaths(newId);
    if (oldPaths && newPaths && fs.existsSync(oldPaths.base)) {
      if (fs.existsSync(newPaths.base)) {
        return res.status(409).json({ success: false, message: `A project folder "${newId}" already exists` });
      }
      try {
        fs.renameSync(oldPaths.base, newPaths.base);
      } catch (e) {
        console.error('Error renaming project folder:', e);
        return res.status(500).json({ success: false, message: `Failed to rename folder: ${e.message || e}` });
      }
    }
    projects[idx].id = newId;
  }
  projects[idx].name = trimmedName;
  projects[idx].number = trimmedNumber;
  projects[idx].status = normalizeProjectStatus(status || projects[idx].status);
  writeProjectsManifest(projects);
  try {
    await syncProjectToDatabaseOrThrow(projects[idx].id, req.authUser && req.authUser.id);
  } catch (error) {
    console.error('Project database sync failed after update:', error);
    return res.status(500).json({ success: false, message: 'Project updated, but database sync failed.' });
  }
  emitProjectsChanged();
  res.json(projects[idx]);
});

app.delete('/api/projects/:id', (req, res) => {
  res.status(403).json({ success: false, message: 'Project deletion is disabled.' });
});

// ---- Simple in-memory job tracking for async tile processing ----
const jobs = new Map();
function createJob(filenames, projectId) {
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const job = {
    id,
    projectId,
    filenames,
    status: 'processing', // 'processing' | 'done' | 'error'
    percent: 0,
    message: '',
    error: null
  };
  jobs.set(id, job);
  return job;
}
function getJob(id) {
  return jobs.get(id) || null;
}
app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json({ id: job.id, status: job.status, percent: job.percent, message: job.message, error: job.error });
});

// ---- Archive APIs (audit log per pano / floor plan) ----
app.get('/api/archive/panos/:filename', (req, res) => {
  const filename = req.params.filename;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const imagePath = path.join(paths.uploadsDir, filename);
  if (!fs.existsSync(imagePath)) return res.status(404).json({ error: 'Not found' });
  initAuditLogIfMissing(paths, 'pano', filename);
  const entries = readAndRepairAuditEntries(paths, 'pano', filename);
  res.json(entries);
});

app.get('/api/archive/floorplans/:filename', (req, res) => {
  const filename = req.params.filename;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const imagePath = path.join(paths.floorplansDir, filename);
  if (!fs.existsSync(imagePath)) return res.status(404).json({ error: 'Not found' });
  initAuditLogIfMissing(paths, 'floorplan', filename);
  const entries = readAndRepairAuditEntries(paths, 'floorplan', filename);
  res.json(entries);
});

app.get('/api/archive/images/:kind/:storedFilename', (req, res) => {
  const kindToken = req.params.kind;
  const storedFilename = req.params.storedFilename;
  const kind =
    kindToken === 'floorplan' || kindToken === 'floorplans'
      ? 'floorplan'
      : kindToken === 'pano' || kindToken === 'panos'
        ? 'pano'
        : null;
  if (!kind) return res.status(400).json({ error: 'Invalid archive image kind' });
  if (!storedFilename) return res.status(400).json({ error: 'storedFilename required' });
  if (storedFilename.includes('..') || storedFilename.includes('/') || storedFilename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid storedFilename' });
  }
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const filePath = resolveArchiveImagePath(paths, kind, storedFilename);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.resolve(filePath));
});

// ---- Panorama APIs (project-scoped via ?project=id) ----
app.post('/upload', upload.array("panorama", 20), async (req, res)=>{
  if(!req.files || req.files.length === 0) {
    return res.status(400).json({
      success: false,
      message: "no file uploaded"
    });
  }
  const paths = resolvePaths(req);
  if (!paths) {
    return res.status(400).json({ success: false, message: 'Project required' });
  }
  const filenames = req.files.map(f => f.filename);
  try {
    filenames.forEach((name) => {
      appendAuditEntry(paths, 'pano', name, {
        action: 'upload',
        message: 'Panorama uploaded.',
        meta: buildAuditMeta(undefined, req.authUser),
      });
    });
  } catch (e) {}
  try {
    await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
  } catch (error) {
    console.error('Project database sync failed after panorama upload:', error);
    return res.status(500).json({ success: false, message: 'Panorama uploaded, but database sync failed.' });
  }
  const job = createJob(filenames, paths.projectId);
  res.json({
    success: true,
    jobId: job.id,
    uploaded: filenames
  });
  // Do not notify immediately; wait until tiles are built and emit 'panos:ready'
  (async () => {
    try {
      let overall = 0;
      const totalFiles = filenames.length;
      for (let i = 0; i < filenames.length; i++) {
        const name = filenames[i];
        job.message = `Processing ${name} (${i+1}/${totalFiles})`;
        await buildTilesForImage({
          imagePath: path.join(paths.uploadsDir, name),
          filename: name,
          tilesRootDir: paths.tilesDir,
          onProgress: (frac) => {
            // Map per-file progress to overall percent
            const combined = ((i + frac) / totalFiles) * 100;
            if (combined > overall) overall = combined;
            job.percent = Math.min(100, Math.max(0, Math.round(overall)));
          }
        });
      }
      panoramaOrderAppend(paths, filenames);
      // Notify clients that tiles are ready for these panos
      try { io.to(`project:${paths.projectId}`).emit('panos:ready', { filenames }); } catch (e) { console.error('Socket emit error:', e); }
      job.percent = 100;
      job.status = 'done';
      job.message = 'Completed';
    } catch (e) {
      console.error('Tile generation failed:', e);
      const msg = `Tile generation failed: ${e.message || e}`;
      job.status = 'error';
      job.error = msg;
      job.message = msg;
    }
  })();
});

// ---- Floor plan APIs (project-scoped via ?project=id) ----
app.post('/upload-floorplan', floorplanUpload.array('floorplan', 20), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ success: false, message: 'no file uploaded' });
  }
  const paths = resolvePaths(req);
  if (!paths) {
    return res.status(400).json({ success: false, message: 'Project required' });
  }
  const filenames = req.files.map((f) => f.filename);
  try {
    filenames.forEach((name) => {
      appendAuditEntry(paths, 'floorplan', name, {
        action: 'upload',
        message: 'Floor plan uploaded.',
        meta: buildAuditMeta(undefined, req.authUser),
      });
    });
  } catch (e) {}
  let updatedOrder = null;
  try {
    updatedOrder = floorplanOrderAppend(paths, filenames);
  } catch (e) {
    console.error('Error updating floor plan order on upload:', e);
  }
  try {
    if (updatedOrder) io.to(`project:${paths.projectId}`).emit('floorplans:order', { order: updatedOrder });
  } catch (e) {
    console.error('Socket emit error:', e);
  }
  try {
    await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
  } catch (error) {
    console.error('Project database sync failed after floor plan upload:', error);
    return res.status(500).json({ success: false, message: 'Floor plan uploaded, but database sync failed.' });
  }
  res.json({ success: true, uploaded: filenames });
});

// Update/replace a single floor plan image and adopt the uploaded filename.
// Body fields (multipart/form-data):
// - floorplan: new image file
// - oldFilename: existing floorplan filename to replace
app.put('/upload-floorplan/update', floorplanUpload.single('floorplan'), async (req, res) => {
  const cleanupUploadedFile = async () => {
    if (!req.file || !req.file.path) return;
    try {
      await fs.promises.unlink(req.file.path);
    } catch (e) {}
  };

  const oldFilename = req.body && req.body.oldFilename;
  if (!oldFilename) {
    await cleanupUploadedFile();
    return res.status(400).json({ success: false, message: 'Old filename is required' });
  }
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No new file uploaded' });
  }
  if (oldFilename.includes('..') || oldFilename.includes('/') || oldFilename.includes('\\')) {
    await cleanupUploadedFile();
    return res.status(400).json({ success: false, message: 'Invalid filename' });
  }
  const paths = resolvePaths(req);
  if (!paths) {
    await cleanupUploadedFile();
    return res.status(400).json({ success: false, message: 'Project required' });
  }
  const oldFilePath = path.join(paths.floorplansDir, oldFilename);
  if (!fs.existsSync(oldFilePath)) {
    await cleanupUploadedFile();
    return res.status(404).json({ success: false, message: 'Old floor plan not found' });
  }
  const newFilename = req.file.filename;
  try {
    const hotspotCleanup = clearFloorplanHotspotsForFilenames(paths, [oldFilename, newFilename]);
    if (hotspotCleanup.changed) {
      try {
        io.to(`project:${paths.projectId}`).emit('floorplan-hotspots:changed', hotspotCleanup.hotspots);
      } catch (e) {
        console.error('Socket emit error:', e);
      }
    }

    if (oldFilename === newFilename) {
      try {
        appendAuditEntry(paths, 'floorplan', newFilename, {
          action: 'update',
          message: 'Floor plan updated.',
          meta: buildAuditMeta(undefined, req.authUser),
        });
      } catch (e) {}
      try {
        await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
      } catch (error) {
        console.error('Project database sync failed after floor plan update:', error);
        return res.status(500).json({ success: false, message: 'Floor plan updated, but database sync failed.' });
      }
      return res.json({
        success: true,
        message: 'Floor plan updated successfully',
        oldFilename,
        newFilename,
        filename: newFilename
      });
    }

    let archivedImage = null;
    try {
      archivedImage = storeReplacedImageInAudit(paths, 'floorplan', oldFilename, oldFilePath);
    } catch (archiveErr) {
      throw new Error(`Could not archive replaced floor plan: ${archiveErr.message || archiveErr}`);
    }

    await fs.promises.unlink(oldFilePath);

    try {
      renameAuditLog(paths, 'floorplan', oldFilename, newFilename);
      appendAuditEntry(paths, 'floorplan', newFilename, {
        action: 'update',
        message: `Floor plan updated (replaced "${oldFilename}" with "${newFilename}").`,
        meta: buildAuditMeta(
          archivedImage
          ? {
              archivedImage: {
                kind: 'floorplan',
                originalFilename: archivedImage.originalFilename,
                storedFilename: archivedImage.storedFilename,
              },
            }
          : undefined,
          req.authUser
        ),
      });
    } catch (e) {}

    let updatedOrder = null;
    try {
      updatedOrder = floorplanOrderReplace(paths, oldFilename, newFilename);
    } catch (e) {
      console.error('Error updating floor plan order:', e);
    }

    try {
      io.to(`project:${paths.projectId}`).emit('floorplans:order', { order: updatedOrder });
    } catch (e) {
      console.error('Socket emit error:', e);
    }
    try {
      await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
    } catch (error) {
      console.error('Project database sync failed after floor plan replace:', error);
      return res.status(500).json({ success: false, message: 'Floor plan updated, but database sync failed.' });
    }

    return res.json({
      success: true,
      message: 'Floor plan updated successfully',
      oldFilename,
      newFilename,
      filename: newFilename
    });
  } catch (e) {
    console.error('Error updating floor plan:', e);
    await cleanupUploadedFile();
    return res.status(500).json({ success: false, message: 'Error updating floor plan' });
  }
});

// Rename a floor plan file.
app.put('/api/floorplans/rename', async (req, res) => {
  const { oldFilename, newFilename } = req.body || {};
  if (!oldFilename || !newFilename) {
    return res.status(400).json({ success: false, message: 'Both old and new filenames are required' });
  }
  if (
    oldFilename.includes('..') || oldFilename.includes('/') || oldFilename.includes('\\') ||
    newFilename.includes('..') || newFilename.includes('/') || newFilename.includes('\\')
  ) {
    return res.status(400).json({ success: false, message: 'Invalid filename' });
  }
  const paths = resolvePaths(req);
  if (!paths) {
    return res.status(400).json({ success: false, message: 'Project required' });
  }
  const oldPath = path.join(paths.floorplansDir, oldFilename);
  const newPath = path.join(paths.floorplansDir, newFilename);
  if (!fs.existsSync(oldPath)) {
    return res.status(404).json({ success: false, message: 'File not found' });
  }
  if (fs.existsSync(newPath)) {
    return res.status(409).json({ success: false, message: 'An image with this name already exists' });
  }
  try {
    await fs.promises.rename(oldPath, newPath);
    try {
      const order = readFloorplanOrder(paths.floorplanOrderPath);
      const newOrder = order.map(f => f === oldFilename ? newFilename : f);
      writeFloorplanOrder(paths.floorplanOrderPath, newOrder);
    } catch (e) {}
    try {
      renameAuditLog(paths, 'floorplan', oldFilename, newFilename);
      appendAuditEntry(paths, 'floorplan', newFilename, {
        action: 'rename',
        message: `Floor plan renamed from "${oldFilename}" to "${newFilename}".`,
        meta: buildAuditMeta(undefined, req.authUser),
      });
    } catch (e) {}
    try {
      await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
    } catch (error) {
      console.error('Project database sync failed after floor plan rename:', error);
      return res.status(500).json({ success: false, message: 'Floor plan renamed, but database sync failed.' });
    }
    return res.json({ success: true, message: 'Floor plan renamed successfully', oldFilename, newFilename });
  } catch (err) {
    console.error('Error renaming floor plan:', err);
    return res.status(500).json({ success: false, message: 'Error renaming file' });
  }
});

// Delete a floor plan image.
app.delete('/api/floorplans/:filename', (req, res) => {
  res.status(403).json({ success: false, message: 'Floor plan deletion is disabled.' });
});

app.get('/api/floorplans', async (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    const files = await getOrderedFloorplanFilenames(paths);
    res.json(files);
  } catch (e) {
    res.status(500).json({ error: 'Unable to list floor plans' });
  }
});

app.put('/api/floorplans/order', (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const body = req.body;
  if (!body || !Array.isArray(body.order)) return res.status(400).json({ error: 'Invalid payload' });
  const ok = body.order.every(f => typeof f === 'string' && f.length > 0 && !f.includes('..') && !/[\\\/]/.test(f));
  if (!ok) return res.status(400).json({ error: 'Invalid filenames in order' });
  try {
    const dir = path.dirname(paths.floorplanOrderPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    writeFloorplanOrder(paths.floorplanOrderPath, body.order);
    res.json({ success: true });
    try { io.to(`project:${paths.projectId}`).emit('floorplans:order', { order: body.order }); } catch (e) { console.error('Socket emit error:', e); }
  } catch (e) {
    console.error('Error writing floorplan order:', e);
    res.status(500).json({ error: 'Unable to save order' });
  }
});

app.get('/upload', (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  fs.readdir(paths.uploadsDir, (err, files) => {
    if (err) return res.status(500).json({ error: 'Unable to read directory' });
    const images = (files || []).filter(file => /\.(jpg|jpeg|png|gif|webp)$/i.test(file));
    res.json(images);
  });
});

app.get('/api/panos', async (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  try {
    const files = await getOrderedFilenames(paths);
    const result = [];
    for (const filename of files) {
      let meta = await readTilesMeta({ tilesRootDir: paths.tilesDir, filename });
      result.push({
        filename,
        tileId: tileIdFromFilename(filename),
        tileReady: Boolean(meta),
        tileSize: meta?.tileSize,
        levels: meta?.levels,
        aspectOk: meta?.aspectOk
      });
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Persist panorama order. Body: { order: [filenames...] }
app.put('/api/panos/order', (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const body = req.body;
  if (!body || !Array.isArray(body.order)) return res.status(400).json({ error: 'Invalid payload' });
  // Validate filenames are strings
  const ok = body.order.every(f => typeof f === 'string' && f.length > 0 && !f.includes('..') && !/[\\\/]/.test(f));
  if (!ok) return res.status(400).json({ error: 'Invalid filenames in order' });
  try {
    
    const dir = path.dirname(paths.panoramaOrderPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    writePanoramaOrder(paths.panoramaOrderPath, body.order);
    res.json({ success: true });
    try { io.to(`project:${paths.projectId}`).emit('panos:order', { order: body.order }); } catch (e) { console.error('Socket emit error:', e); }
  } catch (e) {
    console.error('Error writing panorama order:', e);
    res.status(500).json({ error: 'Unable to save order' });
  }
});

app.get('/api/panos/:filename', async (req, res) => {
  const filename = req.params.filename;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  try {
    const meta = await ensureTilesForFilename(paths, filename);
    res.json(meta);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.put('/upload/rename', async (req, res) => {
  const { oldFilename, newFilename } = req.body;

  if (!oldFilename || !newFilename) {
    return res.status(400).json({
      success: false,
      message: 'Both old and new filenames are required'
    });
  }

  if (oldFilename.includes('..') || oldFilename.includes('/') || oldFilename.includes('\\') ||
      newFilename.includes('..') || newFilename.includes('/') || newFilename.includes('\\')) {
    return res.status(400).json({
      success: false,
      message: 'Invalid filename'
    });
  }

  const paths = resolvePaths(req);
  if (!paths) {
    return res.status(400).json({
      success: false,
      message: 'Project required'
    });
  }
  const oldFilePath = path.join(paths.uploadsDir, oldFilename);
  const newFilePath = path.join(paths.uploadsDir, newFilename);

  if (!fs.existsSync(oldFilePath)) {
    return res.status(404).json({
      success: false,
      message: 'File not found'
    });
  }

  if (fs.existsSync(newFilePath)) {
    return res.status(409).json({
      success: false,
      message: 'An image with this name already exists'
    });
  }

  try {
    await fs.promises.rename(oldFilePath, newFilePath);
    const oldTileId = tileIdFromFilename(oldFilename);
    const newTileId = tileIdFromFilename(newFilename);
    const oldTilesPath = path.join(paths.tilesDir, oldTileId);
    const newTilesPath = path.join(paths.tilesDir, newTileId);
    if (fs.existsSync(oldTilesPath) && !fs.existsSync(newTilesPath)) {
      try {
        fs.renameSync(oldTilesPath, newTilesPath);
        const metaPath = path.join(newTilesPath, 'meta.json');
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          meta.filename = newFilename;
          meta.id = newTileId;
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
        }
      } catch (e) {
        console.error('Error renaming tiles folder:', e);
      }
    }

    panoramaOrderReplace(paths, oldFilename, newFilename);
    const blurRename = renameBlurMasksForPano(paths, oldFilename, newFilename);
    if (blurRename.changed) {
      try { io.to(`project:${paths.projectId}`).emit('blur-masks:changed', blurRename.blurMasks); } catch (e) { console.error('Socket emit error:', e); }
    }
    try {
      renameAuditLog(paths, 'pano', oldFilename, newFilename);
      appendAuditEntry(paths, 'pano', newFilename, {
        action: 'rename',
        message: `Panorama renamed from "${oldFilename}" to "${newFilename}".`,
        meta: buildAuditMeta(undefined, req.authUser),
      });
    } catch (e) {}
    try {
      await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
    } catch (error) {
      console.error('Project database sync failed after panorama rename:', error);
      return res.status(500).json({ success: false, message: 'Panorama renamed, but database sync failed.' });
    }
    try { io.to(`project:${paths.projectId}`).emit('pano:renamed', { oldFilename, newFilename }); } catch (e) { console.error('Socket emit error:', e); }
    res.json({
      success: true,
      message: 'File renamed successfully',
      oldFilename,
      newFilename
    });
  } catch (err) {
    console.error('Error renaming panorama:', err);
    return res.status(500).json({
      success: false,
      message: 'Error renaming file'
    });
  }
});

app.put('/upload/update', upload.single('panorama'), (req, res) => {
  const oldFilename = req.body.oldFilename;
  if (!oldFilename) {
    return res.status(400).json({ success: false, message: 'Old filename is required' });
  }
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No new file uploaded' });
  }
  if (oldFilename.includes('..') || oldFilename.includes('/') || oldFilename.includes('\\')) {
    return res.status(400).json({ success: false, message: 'Invalid filename' });
  }
  const paths = resolvePaths(req);
  if (!paths) {
    return res.status(400).json({ success: false, message: 'Project required' });
  }
  const oldFilePath = path.join(paths.uploadsDir, oldFilename);
  if (!fs.existsSync(oldFilePath)) {
    return res.status(404).json({ success: false, message: 'Old file not found' });
  }
  const newFilename = req.file.filename;
  const job = createJob([newFilename], paths.projectId);
  res.json({
    success: true,
    jobId: job.id,
    newFilename,
    oldFilename
  });
  (async () => {
    try {
      job.message = `Replacing ${oldFilename}…`;
      let archivedImage = null;
      try {
        archivedImage = storeReplacedImageInAudit(paths, 'pano', oldFilename, oldFilePath);
      } catch (archiveErr) {
        throw new Error(`Could not archive replaced panorama: ${archiveErr.message || archiveErr}`);
      }
      await fs.promises.unlink(oldFilePath).catch((err) => {
        console.error('Error deleting old file:', err);
      });
      await removeDirIfExists(path.join(paths.tilesDir, tileIdFromFilename(oldFilename)));
      await buildTilesForImage({
        imagePath: path.join(paths.uploadsDir, newFilename),
        filename: newFilename,
        tilesRootDir: paths.tilesDir,
        onProgress: (frac) => {
          job.percent = Math.min(100, Math.max(0, Math.round(frac * 100)));
        }
      });
      panoramaOrderReplace(paths, oldFilename, newFilename);
      const blurRename = renameBlurMasksForPano(paths, oldFilename, newFilename);
      if (blurRename.changed) {
        try { io.to(`project:${paths.projectId}`).emit('blur-masks:changed', blurRename.blurMasks); } catch (e) { console.error('Socket emit error:', e); }
      }
      try {
        renameAuditLog(paths, 'pano', oldFilename, newFilename);
        appendAuditEntry(paths, 'pano', newFilename, {
          action: 'update',
          message: `Panorama updated (replaced "${oldFilename}" with "${newFilename}").`,
          meta: buildAuditMeta(
            archivedImage
            ? {
                archivedImage: {
                  kind: 'pano',
                  originalFilename: archivedImage.originalFilename,
                  storedFilename: archivedImage.storedFilename,
                },
              }
            : undefined,
            req.authUser
          ),
        });
      } catch (e) {}
      await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
      job.percent = 100;
      job.status = 'done';
      job.message = 'Update completed';
      try { io.to(`project:${paths.projectId}`).emit('pano:updated', { oldFilename, newFilename }); } catch (e) { console.error('Socket emit error:', e); }
    } catch (e) {
      console.error('Error updating image tiles:', e);
      const msg = `Error updating image tiles: ${e.message || e}`;
      job.status = 'error';
      job.error = msg;
      job.message = msg;
    }
  })();
});

app.get('/api/hotspots', (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  fs.readFile(paths.hotspotsPath, 'utf8', (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') return res.json({});
      return res.status(500).json({ error: 'Unable to read hotspots' });
    }
    try {
      const obj = JSON.parse(data);
      res.json(typeof obj === 'object' && obj !== null ? obj : {});
    } catch (e) {
      res.json({});
    }
  });
});

app.get('/api/blur-masks', (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  fs.readFile(paths.blurMasksPath, 'utf8', (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') return res.json({});
      return res.status(500).json({ error: 'Unable to read blur masks' });
    }
    try {
      const obj = JSON.parse(data);
      res.json(typeof obj === 'object' && obj !== null ? obj : {});
    } catch (e) {
      res.json({});
    }
  });
});

// Floor plan hotspots: same shape as pano hotspots but keyed by floor plan filename.
app.get('/api/floorplan-hotspots', (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  fs.readFile(paths.floorplanHotspotsPath, 'utf8', (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') return res.json({});
      return res.status(500).json({ error: 'Unable to read floor plan hotspots' });
    }
    try {
      const obj = JSON.parse(data);
      res.json(typeof obj === 'object' && obj !== null ? obj : {});
    } catch (e) {
      res.json({});
    }
  });
});

app.post('/api/floorplan-hotspots', async (req, res) => {
  const body = req.body;
  if (typeof body !== 'object' || body === null) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const beforeRaw = readJsonFileOrDefault(paths.floorplanHotspotsPath, {});
  const before = normalizeTopLevelArrayMap(beforeRaw);
  const normalizedBody = normalizeTopLevelArrayMap(body);
  const changed = diffChangedTopLevelKeys(before, normalizedBody);
  const json = JSON.stringify(normalizedBody, null, 2);
  const dir = path.dirname(paths.floorplanHotspotsPath);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(paths.floorplanHotspotsPath, json, 'utf8');
    try {
      changed.forEach((filename) => {
        const fp = path.join(paths.floorplansDir, filename);
        if (!fs.existsSync(fp)) return;
        const beforeCount = getArrayCountByKey(before, filename);
        const afterCount = getArrayCountByKey(normalizedBody, filename);
        const message = buildCollectionChangeMessage('Floor plan hotspot', 'floor plan hotspots', beforeCount, afterCount);
        appendAuditEntry(
          paths,
          'floorplan',
          filename,
          {
            action: 'hotspots',
            message,
            meta: buildAuditMeta(undefined, req.authUser),
          },
          { dedupeWindowMs: 5000 }
        );
      });
    } catch (e) {}
    await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
    res.json({ success: true, unchanged: changed.length === 0 });
    if (changed.length === 0) return;
    try { io.to(`project:${paths.projectId}`).emit('floorplan-hotspots:changed', normalizedBody); } catch (e) { console.error('Socket emit error:', e); }
  } catch (error) {
    console.error('Floor plan hotspot save failed:', error);
    return res.status(500).json({ error: 'Unable to save floor plan hotspots' });
  }
});

app.post('/api/blur-masks', async (req, res) => {
  const body = req.body;
  if (typeof body !== 'object' || body === null) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const beforeRaw = readJsonFileOrDefault(paths.blurMasksPath, {});
  const before = normalizeTopLevelArrayMap(beforeRaw);
  const normalizedBody = normalizeTopLevelArrayMap(body);
  const changed = diffChangedTopLevelKeys(before, normalizedBody);
  const json = JSON.stringify(normalizedBody, null, 2);
  const dir = path.dirname(paths.blurMasksPath);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(paths.blurMasksPath, json, 'utf8');
    try {
      changed.forEach((filename) => {
        const img = path.join(paths.uploadsDir, filename);
        if (!fs.existsSync(img)) return;
        const beforeCount = getArrayCountByKey(before, filename);
        const afterCount = getArrayCountByKey(normalizedBody, filename);
        if (beforeCount === afterCount) return;
        const message = buildCollectionChangeMessage('Blur mask', 'blur masks', beforeCount, afterCount);
        appendAuditEntry(
          paths,
          'pano',
          filename,
          {
            action: 'blur',
            message,
            meta: buildAuditMeta(undefined, req.authUser),
          },
          { dedupeWindowMs: 15000 }
        );
      });
    } catch (e) {}
    await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
    res.json({ success: true, unchanged: changed.length === 0 });
    if (changed.length === 0) return;
    try { io.to(`project:${paths.projectId}`).emit('blur-masks:changed', normalizedBody); } catch (e) { console.error('Socket emit error:', e); }
  } catch (error) {
    console.error('Blur mask save failed:', error);
    return res.status(500).json({ error: 'Unable to save blur masks' });
  }
});

app.post('/api/hotspots', async (req, res) => {
  const body = req.body;
  if (typeof body !== 'object' || body === null) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const beforeRaw = readJsonFileOrDefault(paths.hotspotsPath, {});
  const before = normalizeTopLevelArrayMap(beforeRaw);
  const normalizedBody = normalizeTopLevelArrayMap(body);
  const changed = diffChangedTopLevelKeys(before, normalizedBody);
  const json = JSON.stringify(normalizedBody, null, 2);
  try {
    await fs.promises.mkdir(path.dirname(paths.hotspotsPath), { recursive: true });
    await fs.promises.writeFile(paths.hotspotsPath, json, 'utf8');
    try {
      changed.forEach((filename) => {
        const img = path.join(paths.uploadsDir, filename);
        if (!fs.existsSync(img)) return;
        const beforeCount = getArrayCountByKey(before, filename);
        const afterCount = getArrayCountByKey(normalizedBody, filename);
        const message = buildCollectionChangeMessage('Hotspot', 'hotspots', beforeCount, afterCount);
        appendAuditEntry(
          paths,
          'pano',
          filename,
          {
            action: 'hotspots',
            message,
            meta: buildAuditMeta(undefined, req.authUser),
          },
          { dedupeWindowMs: 5000 }
        );
      });
    } catch (e) {}
    await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
    res.json({ success: true, unchanged: changed.length === 0 });
    if (changed.length === 0) return;
    try { io.to(`project:${paths.projectId}`).emit('hotspots:changed', normalizedBody); } catch (e) { console.error('Socket emit error:', e); }
  } catch (error) {
    console.error('Hotspot save failed:', error);
    return res.status(500).json({ error: 'Unable to save hotspots' });
  }
});

// Per-image initial view parameters (yaw, pitch, fov) for each panorama
app.get('/api/initial-views', (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  fs.readFile(paths.initialViewsPath, 'utf8', (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') return res.json({});
      return res.status(500).json({ error: 'Unable to read initial views' });
    }
    try {
      const obj = JSON.parse(data);
      res.json(typeof obj === 'object' && obj !== null ? obj : {});
    } catch (e) {
      res.json({});
    }
  });
});

app.post('/api/initial-views', async (req, res) => {
  const body = req.body;
  if (typeof body !== 'object' || body === null) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const before = readJsonFileOrDefault(paths.initialViewsPath, {});
  const changed = diffChangedTopLevelKeys(before, body);
  const json = JSON.stringify(body, null, 2);
  const dir = path.dirname(paths.initialViewsPath);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(paths.initialViewsPath, json, 'utf8');
    try {
      changed.forEach((filename) => {
        const img = path.join(paths.uploadsDir, filename);
        if (!fs.existsSync(img)) return;
        appendAuditEntry(
          paths,
          'pano',
          filename,
          {
            action: 'initial-view',
            message: 'Initial view saved.',
            meta: buildAuditMeta(undefined, req.authUser),
          },
          { dedupeWindowMs: 3000 }
        );
      });
    } catch (e) {}
    await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
    res.json({ success: true });
    try { io.to(`project:${paths.projectId}`).emit('initial-views:changed', body); } catch (e) { console.error('Socket emit error:', e); }
  } catch (error) {
    console.error('Initial view save failed:', error);
    return res.status(500).json({ error: 'Unable to save initial views' });
  }
});

app.delete('/upload/:filename', (req, res) => {
  res.status(403).json({ success: false, message: 'Panorama deletion is disabled.' });
});

async function startServer() {
  await clearAllSessions();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at https://localhost:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error('Server startup failed:', error);
  process.exit(1);
});
