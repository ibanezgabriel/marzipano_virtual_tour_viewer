const express = require('express');
const multer = require('multer'); 
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  buildTilesForImage,
  readTilesMeta,
  tileIdFromFilename,
  removeDirIfExists
} = require('./public/js/tiler');
const session = require('express-session');
const bcrypt = require('bcrypt');
const db = require('./db');

const app = express();
const PORT = 3000;
const http = require('http');
const { Server } = require('socket.io');

const projectsDir = path.join(__dirname, 'projects');
const MAX_PROJECT_NUMBER_LENGTH = 20;
const ALLOWED_PROJECT_STATUSES = new Set(['on-going', 'completed']);

if (!fs.existsSync(projectsDir)) {
  fs.mkdirSync(projectsDir, { recursive: true });
}

let auditLogsDbDisabled = false;
async function insertAuditLog({ projectId, userId, action, message, metadata, createdAt } = {}) {
  if (auditLogsDbDisabled) return;
  if (!action) return;
  try {
    const created = createdAt ? new Date(createdAt) : new Date();
    const projectIdValue = projectId === undefined || projectId === null ? null : String(projectId);
    await db.query(
      `INSERT INTO audit_logs (project_id, user_id, action, message, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        projectIdValue,
        userId ? Number(userId) : null,
        String(action),
        message ? String(message) : null,
        JSON.stringify(metadata && typeof metadata === 'object' ? metadata : {}),
        created,
      ]
    );
  } catch (e) {
    // If schema migration hasn't been applied yet, avoid spamming errors on every request.
    if (e && (e.code === '42P01' || /audit_logs/i.test(String(e.message || '')))) {
      auditLogsDbDisabled = true;
      console.warn('[audit_logs] table not available; DB audit logging disabled until migrated.');
      return;
    }
    console.warn('[audit_logs] insert failed:', e.message || e);
  }
}

async function emitProjectsChanged() {
  try {
    const res = await db.query('SELECT * FROM projects ORDER BY created_at ASC');
    io.emit('projects:changed', res.rows);
  } catch (e) {
    console.error('Socket emit error:', e);
  }
}

/**
 * Look up a project by either its internal id or its human-facing number.
 * Returns the full project object or null if not found.
 */
async function findProjectByIdOrNumber(token) {
  if (!token) return null;
  const value = String(token).trim();
  if (!value) return null;
  try {
    // Single bind variable is intentional: we compare the same token against both columns.
    const res = await db.query('SELECT * FROM projects WHERE id = $1 OR number = $1', [value]);
    return res.rows[0] || null;
  } catch (err) {
    console.error('Error finding project:', err);
    return null;
  }
}

function createStoredUploadFilename(originalName) {
  const base = path.basename(String(originalName || 'image'));
  const safe = base
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  const nonce = crypto.randomBytes(4).toString('hex');
  return `${Date.now()}-${nonce}-${safe || 'image'}`;
}

function sanitizeProjectId(name) {
  return name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '') || 'project';
}

function normalizeProjectStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'in-progress') return 'on-going';
  return ALLOWED_PROJECT_STATUSES.has(normalized) ? normalized : 'on-going';
}

/** Get paths for a project. projectId must be validated (no .., no slashes). */
function getProjectPaths(projectId) {
  if (!projectId || projectId.includes('..') || /[\/\\]/.test(projectId)) return null;
  const base = path.join(projectsDir, projectId);
  return {
    base,
    upload: path.join(base, 'upload'),
    layouts: path.join(base, 'layouts'),
    floorplans: path.join(base, 'floorplans'),
    tiles: path.join(base, 'tiles'),
    data: path.join(base, 'data'),
  };
}

function ensureProjectDirs(projectId) {
  const p = getProjectPaths(projectId);
  if (!p) return null;
  [p.upload, p.layouts, p.floorplans, p.tiles, p.data].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
  return p;
}

/** Resolve paths: require project id */
async function resolvePaths(req) {
  const projectToken = req.query.project || (req.body && req.body.project);
  const project = await findProjectByIdOrNumber(projectToken);
  const projectId = project ? project.id : projectToken;
  const p = getProjectPaths(projectId);
  if (!p) return null;
  return {
    uploadsDir: p.upload,
    // New name: layouts. Keep legacy floorplans directory as a fallback for older projects.
    layoutsDir: p.layouts,
    floorplansDir: p.layouts,
    floorplansLegacyDir: p.floorplans,
    tilesDir: p.tiles,
    hotspotsPath: path.join(p.data, 'hotspots.json'),
    // New names: layout-*.json, but keep legacy floorplan-*.json as fallback.
    layoutHotspotsPath: path.join(p.data, 'layout-hotspots.json'),
    floorplanHotspotsPath: path.join(p.data, 'floorplan-hotspots.json'),
    layoutOrderPath: path.join(p.data, 'layout-order.json'),
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

function appendAuditEntry(
  paths,
  kind,
  filename,
  { action, message, meta } = {},
  { dedupeWindowMs = 0, userId = null } = {}
) {
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

    // Best-effort mirror into Postgres audit_logs for project-level activity tracking.
    const dbAction = `archive:${kind}:${entry.action}`;
    const metadata = {
      kind,
      filename,
      ...(entry.meta && typeof entry.meta === 'object' ? { meta: entry.meta } : {}),
    };
    insertAuditLog({
      projectId: paths.projectId,
      userId,
      action: dbAction,
      message: entry.message,
      metadata,
      createdAt: entry.ts,
    }).catch(() => {});
  } catch (e) {
    console.error('Error appending audit entry:', e);
  }
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

// ---- Authentication & Session ----
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev_secret_key_change_in_prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password required' });
  }

  try {
    const result = await db.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];

    if (user && await bcrypt.compare(password, user.password_hash)) {
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.role = user.role;
      return res.json({ success: true, user: { username: user.username, role: user.role } });
    } else {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ success: false });
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

app.get('/api/me', (req, res) => {
  if (req.session.userId) {
    res.json({ loggedIn: true, username: req.session.username, role: req.session.role });
  } else {
    res.json({ loggedIn: false });
  }
});

// Middleware to protect admin pages
function isAdminRole(role) {
  return role === 'admin' || role === 'super_admin';
}

function isSuperAdminRole(role) {
  return role === 'super_admin';
}

const protectAdmin = (req, res, next) => {
  const ppath = req.path;
  if (ppath === '/dashboard.html' || ppath === '/project-editor.html') {
    if (!req.session.userId) {
      return res.redirect('/');
    }
    if (!isAdminRole(req.session.role)) {
      return res.status(403).send('Forbidden');
    }
  }
  next();
};
app.use(protectAdmin);

// Middleware to protect Write APIs (Admin + Super Admin)
const requireApiAuth = (req, res, next) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!isAdminRole(req.session.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};

// Middleware to protect Super Admin-only APIs
const requireSuperAdminApiAuth = (req, res, next) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!isSuperAdminRole(req.session.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};

// ---- User management (Super Admin only) ----
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

app.get('/api/users', requireSuperAdminApiAuth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, username, role, created_at FROM users ORDER BY created_at ASC'
    );
    res.json(result.rows);
  } catch (e) {
    console.error('Error listing users:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/users', requireSuperAdminApiAuth, async (req, res) => {
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
       RETURNING id, username, role, created_at`,
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

async function getProjectIdFromQuery(req) {
  if (req.query && typeof req.query === 'object') {
    let token = null;
    if (typeof req.query.project === 'string' && req.query.project.length > 0) {
      token = req.query.project;
    } else {
      const keys = Object.keys(req.query);
      if (keys.length === 1 && req.query[keys[0]] === '') token = keys[0];
    }
    if (token) {
      const project = await findProjectByIdOrNumber(token);
      return project ? project.id : token;
    }
  }
  return null;
}

app.use(async (req, res, next) => {
  const ppath = req.path || '';
  if (ppath !== '/dashboard.html' && ppath !== '/project-viewer.html') return next();
  try {
    const projectId = await getProjectIdFromQuery(req);
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

    if (ppath === '/dashboard.html') return next();

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
projectRouter.use('/upload', async (req, res, next) => {
  const token = req.params.projectId;
  const project = await findProjectByIdOrNumber(token);
  const id = project ? project.id : token;
  if (id.includes('..') || id.includes('/') || id.includes('\\')) return res.status(400).send('Invalid project');
  const p = getProjectPaths(id);
  if (!p) return res.status(400).send('Invalid project');
  if (!fs.existsSync(p.upload)) return next();
  express.static(p.upload)(req, res, next);
});
projectRouter.use(['/layouts', '/floorplans'], async (req, res, next) => {
  const token = req.params.projectId;
  const project = await findProjectByIdOrNumber(token);
  const id = project ? project.id : token;
  if (id.includes('..') || id.includes('/') || id.includes('\\')) return res.status(400).send('Invalid project');
  const p = getProjectPaths(id);
  if (!p) return res.status(400).send('Invalid project');

  const middleware = [];
  if (fs.existsSync(p.layouts)) middleware.push(express.static(p.layouts));
  if (fs.existsSync(p.floorplans)) middleware.push(express.static(p.floorplans));
  if (middleware.length === 0) return next();

  let idx = 0;
  const run = (err) => {
    if (err) return next(err);
    const mw = middleware[idx++];
    if (!mw) return next();
    mw(req, res, run);
  };
  run();
});
projectRouter.use('/tiles', async (req, res, next) => {
  const token = req.params.projectId;
  const project = await findProjectByIdOrNumber(token);
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
    destination: async (req, file, cb) => {
      const projectToken = req.query.project || (req.body && req.body.project);
      const project = await findProjectByIdOrNumber(projectToken);
      const projectId = project ? project.id : projectToken;
      const p = getProjectPaths(projectId);
      if (!p) return cb(new Error('Project required'), null);
      const dir = p.upload;
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      cb(null, createStoredUploadFilename(file.originalname));
    },
  }),
});

// Separate storage for layout images (project-scoped "layouts" directory; legacy fallback: "floorplans")
const floorplanUpload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      const projectToken = req.query.project || (req.body && req.body.project);
      const project = await findProjectByIdOrNumber(projectToken);
      const projectId = project ? project.id : projectToken;
      const p = getProjectPaths(projectId);
      if (!p) return cb(new Error('Project required'), null);
      const dir = p.layouts;
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      cb(null, createStoredUploadFilename(file.originalname));
    },
  }),
});

async function listUploadedImages(uploadsDir) {
  const files = await fs.promises.readdir(uploadsDir);
  return files.filter(file => /\.(jpg|jpeg|png|gif|webp|jfif)$/i.test(file));
}

async function listFloorplanImages(primaryDir, legacyDir = null) {
  const dirs = [primaryDir, legacyDir].filter(Boolean);
  const uniqueDirs = Array.from(new Set(dirs));
  const files = new Set();

  for (const dir of uniqueDirs) {
    try {
      const names = await fs.promises.readdir(dir);
      names
        .filter((file) => /\.(jpg|jpeg|png|gif|webp|jfif)$/i.test(file))
        .forEach((file) => files.add(file));
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('Error reading layouts dir:', e);
    }
  }

  return Array.from(files);
}

function resolveFloorplanImagePath(paths, filename) {
  const candidates = [];
  if (paths && paths.layoutsDir) candidates.push(path.join(paths.layoutsDir, filename));
  if (paths && paths.floorplansLegacyDir) candidates.push(path.join(paths.floorplansLegacyDir, filename));
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return candidates[0] || null;
}

function readFloorplanOrder(primaryPath, legacyPath) {
  try {
    const raw = fs.readFileSync(primaryPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Error reading layout order:', e);
  }
  try {
    if (!legacyPath) return [];
    const raw = fs.readFileSync(legacyPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Error reading legacy floorplan order:', e);
  }
  return [];
}

function writeFloorplanOrder(primaryPath, order) {
  const dir = path.dirname(primaryPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(primaryPath, JSON.stringify(order, null, 2), 'utf8');
}

function readFloorplanHotspots(primaryPath, legacyPath) {
  try {
    const raw = fs.readFileSync(primaryPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Error reading layout hotspots:', e);
  }
  try {
    if (!legacyPath) return {};
    const raw = fs.readFileSync(legacyPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Error reading legacy floor plan hotspots:', e);
  }
  return {};
}

function writeFloorplanHotspots(primaryPath, hotspots) {
  const dir = path.dirname(primaryPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(primaryPath, JSON.stringify(hotspots, null, 2), 'utf8');
}

function clearFloorplanHotspotsForFilenames(paths, filenames) {
  const names = Array.from(new Set((filenames || []).filter(Boolean)));
  if (names.length === 0) return { changed: false, hotspots: null };
  const hotspots = readFloorplanHotspots(paths.layoutHotspotsPath, paths.floorplanHotspotsPath);
  let changed = false;
  names.forEach((name) => {
    if (Object.prototype.hasOwnProperty.call(hotspots, name)) {
      delete hotspots[name];
      changed = true;
    }
  });
  if (changed) writeFloorplanHotspots(paths.layoutHotspotsPath, hotspots);
  return { changed, hotspots };
}

function floorplanOrderReplace(paths, oldFilename, newFilename) {
  const order = readFloorplanOrder(paths.layoutOrderPath, paths.floorplanOrderPath);
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
  writeFloorplanOrder(paths.layoutOrderPath, deduped);
  return deduped;
}

/** Return ordered list of floor plan filenames; stored order first, then any new files not in list. */
async function getOrderedFloorplanFilenames(paths) {
  const existing = await listFloorplanImages(paths.layoutsDir, paths.floorplansLegacyDir);
  const existingSet = new Set(existing);
  let order = readFloorplanOrder(paths.layoutOrderPath, paths.floorplanOrderPath).filter(f => existingSet.has(f));
  const inOrder = new Set(order);
  const appended = existing.filter(f => !inOrder.has(f));
  const result = [...order, ...appended];
  const orderChanged = order.length !== result.length || appended.length > 0;
  if (orderChanged && result.length > 0) {
    writeFloorplanOrder(paths.layoutOrderPath, result);
  }
  return result;
}

function floorplanOrderAppend(paths, filenames) {
  const order = readFloorplanOrder(paths.layoutOrderPath, paths.floorplanOrderPath);
  const set = new Set(order);
  let changed = false;
  for (const f of filenames || []) {
    if (!f || set.has(f)) continue;
    order.push(f);
    set.add(f);
    changed = true;
  }
  if (changed) writeFloorplanOrder(paths.layoutOrderPath, order);
  return order;
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
app.get('/api/projects', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM projects ORDER BY created_at ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/projects', requireApiAuth, async (req, res) => {
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
  const normalized = trimmedName.toLowerCase();

  try {
    const existing = await db.query('SELECT id FROM projects WHERE LOWER(name) = $1 OR number = $2', [normalized, trimmedNumber]);
    if (existing.rows.length > 0) {
      const isName = existing.rows.some(r => r.name && r.name.toLowerCase() === normalized);
      return res.status(409).json({ success: false, message: `A project with this ${isName ? 'name' : 'number'} already exists` });
    }
    
    let suffix = 0;
    let finalId = id;
    while (true) {
      const check = await db.query('SELECT 1 FROM projects WHERE id = $1', [finalId]);
      if (check.rows.length === 0) break;
      suffix++;
      finalId = `${id}-${suffix}`;
    }
    
    ensureProjectDirs(finalId);
  
    const insertRes = await db.query(
      'INSERT INTO projects (id, name, number, status) VALUES ($1, $2, $3, $4) RETURNING *',
      [finalId, trimmedName, trimmedNumber, normalizeProjectStatus(status)]
    );
  
    await emitProjectsChanged();
    await insertAuditLog({
      projectId: finalId,
      userId: req.session.userId,
      action: 'project:create',
      message: `Project created: ${trimmedName} (${trimmedNumber}).`,
      metadata: {
        id: finalId,
        name: trimmedName,
        number: trimmedNumber,
        status: normalizeProjectStatus(status),
      },
    });
    res.json(insertRes.rows[0]);

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.put('/api/projects/:id', requireApiAuth, async (req, res) => {
  const oldId = req.params.id;
  if (oldId.includes('..') || oldId.includes('/') || oldId.includes('\\')) {
    return res.status(400).json({ success: false, message: 'Invalid project id' });
  }
  const { name, number, status } = req.body || {};
  if (number === undefined || number === null || !String(number).trim()) {
    return res.status(400).json({ success: false, message: 'Project number is required' });
  }
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ success: false, message: 'Project name is required' });
  }
  
  try {
    const currentRes = await db.query('SELECT * FROM projects WHERE id = $1', [oldId]);
    if (currentRes.rows.length === 0) return res.status(404).json({ success: false, message: 'Project not found' });
    const currentProject = currentRes.rows[0];

    const trimmedName = name.trim();
    const trimmedNumber = String(number).trim();
    if (!/^[A-Za-z0-9-]+$/.test(trimmedNumber)) {
      return res.status(400).json({ success: false, message: 'Project number can only contain letters, numbers, and "-"' });
    }
    if (trimmedNumber.length > MAX_PROJECT_NUMBER_LENGTH) {
      return res.status(400).json({ success: false, message: `Project number must be ${MAX_PROJECT_NUMBER_LENGTH} characters or less` });
    }
    const normalized = trimmedName.toLowerCase();

    const conflictRes = await db.query('SELECT * FROM projects WHERE (LOWER(name) = $1 OR number = $2) AND id != $3', [normalized, trimmedNumber, oldId]);
    if (conflictRes.rows.length > 0) {
      return res.status(409).json({ success: false, message: 'A project with this name already exists' });
    }

    let newId = sanitizeProjectId(trimmedName);
    if (newId !== oldId) {
      let suffix = 0;
      let baseId = newId;
      while (true) {
        const check = await db.query('SELECT 1 FROM projects WHERE id = $1 AND id != $2', [newId, oldId]);
        if (check.rows.length === 0) break;
        suffix++;
        newId = `${baseId}-${suffix}`;
      }
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
    }
  
    const updateRes = await db.query(
      'UPDATE projects SET id = $1, name = $2, number = $3, status = $4, updated_at = NOW() WHERE id = $5 RETURNING *',
      [newId, trimmedName, trimmedNumber, normalizeProjectStatus(status || currentProject.status), oldId]
    );

    await emitProjectsChanged();
    await insertAuditLog({
      projectId: newId,
      userId: req.session.userId,
      action: newId !== oldId ? 'project:rename' : 'project:update',
      message:
        newId !== oldId
          ? `Project renamed: ${oldId} -> ${newId}.`
          : `Project updated: ${newId}.`,
      metadata: {
        oldId,
        newId,
        old: {
          name: currentProject.name,
          number: currentProject.number,
          status: currentProject.status,
        },
        new: {
          name: trimmedName,
          number: trimmedNumber,
          status: normalizeProjectStatus(status || currentProject.status),
        },
      },
    });
    res.json(updateRes.rows[0]);

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.delete('/api/projects/:id', requireApiAuth, (req, res) => {
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
    status: 'processing',
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

// ---- Archive APIs (audit log per pano / layout) ----
app.get('/api/archive/panos/:filename', async (req, res) => {
  const filename = req.params.filename;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const paths = await resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const imagePath = path.join(paths.uploadsDir, filename);
  if (!fs.existsSync(imagePath)) return res.status(404).json({ error: 'Not found' });
  initAuditLogIfMissing(paths, 'pano', filename);
  const entries = readAndRepairAuditEntries(paths, 'pano', filename);
  res.json(entries);
});

async function handleArchiveLayouts(req, res) {
  const filename = req.params.filename;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const paths = await resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const imagePath = resolveFloorplanImagePath(paths, filename);
  if (!fs.existsSync(imagePath)) return res.status(404).json({ error: 'Not found' });
  initAuditLogIfMissing(paths, 'floorplan', filename);
  const entries = readAndRepairAuditEntries(paths, 'floorplan', filename);
  res.json(entries);
}

app.get('/api/archive/floorplans/:filename', handleArchiveLayouts);
app.get('/api/archive/layouts/:filename', handleArchiveLayouts);

app.get('/api/archive/images/:kind/:storedFilename', async (req, res) => {
  const kindToken = req.params.kind;
  const storedFilename = req.params.storedFilename;
  const kind =
    kindToken === 'floorplan' || kindToken === 'floorplans' || kindToken === 'layout' || kindToken === 'layouts'
      ? 'floorplan'
      : kindToken === 'pano' || kindToken === 'panos'
        ? 'pano'
        : null;
  if (!kind) return res.status(400).json({ error: 'Invalid archive image kind' });
  if (!storedFilename) return res.status(400).json({ error: 'storedFilename required' });
  if (storedFilename.includes('..') || storedFilename.includes('/') || storedFilename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid storedFilename' });
  }
  const paths = await resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const filePath = resolveArchiveImagePath(paths, kind, storedFilename);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.resolve(filePath));
});

// ---- Panorama APIs (project-scoped via ?project=id) ----
app.post('/upload', requireApiAuth, upload.array("panorama", 20), async (req, res)=>{
  if(!req.files || req.files.length === 0) {
    return res.status(400).json({
      success: false,
      message: "no file uploaded"
    });
  }
  const paths = await resolvePaths(req);
  if (!paths) {
    return res.status(400).json({ success: false, message: 'Project required' });
  }
  const filenames = req.files.map(f => f.filename);
  
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const rankRes = await client.query(
      'SELECT COALESCE(MAX(rank), -1)::int as maxr FROM panoramas WHERE project_id = $1',
      [paths.projectId]
    );
    let currentRank = Number(rankRes.rows[0]?.maxr ?? -1) + 1;

    for (const filename of filenames) {
      const upsertRes = await client.query(
        `INSERT INTO panoramas (project_id, filename, rank, is_active)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (project_id, filename)
         DO UPDATE SET is_active = true
         RETURNING id, (xmax = 0) AS inserted`,
        [paths.projectId, filename, currentRank]
      );
      if (upsertRes.rows[0]?.inserted) currentRank += 1;
    }

    await client.query('COMMIT');

    try {
      filenames.forEach((name) => {
        appendAuditEntry(
          paths,
          'pano',
          name,
          { action: 'upload', message: 'Panorama uploaded.' },
          { userId: req.session.userId }
        );
      });
    } catch (e) {}
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (rollbackErr) {}
    // Best-effort cleanup of the just-uploaded files if we couldn't persist to the DB.
    try {
      filenames.forEach((name) => {
        const img = path.join(paths.uploadsDir, name);
        if (fs.existsSync(img)) fs.unlinkSync(img);
      });
    } catch (cleanupErr) {}
    console.error('Error saving uploaded panoramas to DB:', e);
    return res.status(500).json({
      success: false,
      message: 'Upload saved to disk but failed to persist to database',
      error: String(e.message || e),
    });
  } finally {
    try { client.release(); } catch (e) {}
  }

  const job = createJob(filenames, paths.projectId);
  res.json({
    success: true,
    jobId: job.id,
    uploaded: filenames
  });

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
            const combined = ((i + frac) / totalFiles) * 100;
            if (combined > overall) overall = combined;
            job.percent = Math.min(100, Math.max(0, Math.round(overall)));
          }
        });
      }
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

// ---- Layout APIs (project-scoped via ?project=id) ----
async function handleLayoutUpload(req, res) {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ success: false, message: 'no file uploaded' });
  }
  const paths = await resolvePaths(req);
  if (!paths) {
    return res.status(400).json({ success: false, message: 'Project required' });
  }
  const filenames = req.files.map((f) => f.filename);
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Backward compatibility: older DBs may still have `floorplans` instead of `layouts`.
    const regRes = await client.query("SELECT to_regclass('public.layouts') AS reg");
    const layoutsTable = regRes.rows[0] && regRes.rows[0].reg ? 'layouts' : 'floorplans';

    const rankRes = await client.query(
      `SELECT COALESCE(MAX(rank), -1)::int as maxr FROM ${layoutsTable} WHERE project_id = $1`,
      [paths.projectId]
    );
    let currentRank = Number(rankRes.rows[0]?.maxr ?? -1) + 1;
    for (const filename of filenames) {
      const upsertRes = await client.query(
        `INSERT INTO ${layoutsTable} (project_id, filename, rank)
         VALUES ($1, $2, $3)
         ON CONFLICT (project_id, filename)
         DO UPDATE SET rank = ${layoutsTable}.rank
         RETURNING id, (xmax = 0) AS inserted`,
        [paths.projectId, filename, currentRank]
      );
      if (upsertRes.rows[0]?.inserted) currentRank += 1;
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (rollbackErr) {}
    try {
      filenames.forEach((name) => {
        const img = path.join(paths.floorplansDir, name);
        if (fs.existsSync(img)) fs.unlinkSync(img);
      });
    } catch (cleanupErr) {}
    console.error('Error saving uploaded layouts to DB:', e);
    return res.status(500).json({
      success: false,
      message: 'Upload saved to disk but failed to persist to database',
      error: String(e.message || e),
    });
  } finally {
    try { client.release(); } catch (e) {}
  }
  try {
    filenames.forEach((name) => {
      appendAuditEntry(
        paths,
        'floorplan',
        name,
        { action: 'upload', message: 'Layout uploaded.' },
        { userId: req.session.userId }
      );
    });
  } catch (e) {}
  let updatedOrder = null;
  try {
    updatedOrder = floorplanOrderAppend(paths, filenames);
  } catch (e) {
    console.error('Error updating layout order on upload:', e);
  }
  try {
    if (updatedOrder) {
      io.to(`project:${paths.projectId}`).emit('floorplans:order', { order: updatedOrder });
      io.to(`project:${paths.projectId}`).emit('layouts:order', { order: updatedOrder });
    }
  } catch (e) {
    console.error('Socket emit error:', e);
  }
  res.json({ success: true, uploaded: filenames });
}

app.post('/upload-floorplan', requireApiAuth, floorplanUpload.array('floorplan', 20), handleLayoutUpload);
app.post('/upload-layout', requireApiAuth, floorplanUpload.array('layout', 20), handleLayoutUpload);

async function handleLayoutUpdate(req, res) {
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
  const paths = await resolvePaths(req);
  if (!paths) {
    await cleanupUploadedFile();
    return res.status(400).json({ success: false, message: 'Project required' });
  }
  const oldFilePath = resolveFloorplanImagePath(paths, oldFilename);
  if (!fs.existsSync(oldFilePath)) {
    await cleanupUploadedFile();
    return res.status(404).json({ success: false, message: 'Old layout not found' });
  }
  const newFilename = req.file.filename;
  try {
    const hotspotCleanup = clearFloorplanHotspotsForFilenames(paths, [oldFilename, newFilename]);
    if (hotspotCleanup.changed) {
      try {
        io.to(`project:${paths.projectId}`).emit('floorplan-hotspots:changed', hotspotCleanup.hotspots);
        io.to(`project:${paths.projectId}`).emit('layout-hotspots:changed', hotspotCleanup.hotspots);
      } catch (e) {
        console.error('Socket emit error:', e);
      }
    }

    if (oldFilename === newFilename) {
      try {
        appendAuditEntry(
          paths,
          'floorplan',
          newFilename,
          { action: 'update', message: 'Layout updated.' },
          { userId: req.session.userId }
        );
      } catch (e) {}
      return res.json({
        success: true,
        message: 'Layout updated successfully',
        oldFilename,
        newFilename,
        filename: newFilename
      });
    }

    let archivedImage = null;
    try {
      archivedImage = storeReplacedImageInAudit(paths, 'floorplan', oldFilename, oldFilePath);
    } catch (archiveErr) {
      throw new Error(`Could not archive replaced layout: ${archiveErr.message || archiveErr}`);
    }

    await fs.promises.unlink(oldFilePath);

    try {
      renameAuditLog(paths, 'floorplan', oldFilename, newFilename);
      appendAuditEntry(
        paths,
        'floorplan',
        newFilename,
        {
          action: 'update',
          message: `Layout updated (replaced "${oldFilename}" with "${newFilename}").`,
          ...(archivedImage
            ? {
                meta: {
                  archivedImage: {
                    kind: 'floorplan',
                    originalFilename: archivedImage.originalFilename,
                    storedFilename: archivedImage.storedFilename,
                  },
                },
              }
            : {}),
        },
        { userId: req.session.userId }
      );
    } catch (e) {}

    let updatedOrder = null;
    try {
      updatedOrder = floorplanOrderReplace(paths, oldFilename, newFilename);
    } catch (e) {
      console.error('Error updating layout order:', e);
    }

    try {
      io.to(`project:${paths.projectId}`).emit('floorplans:order', { order: updatedOrder });
      io.to(`project:${paths.projectId}`).emit('layouts:order', { order: updatedOrder });
    } catch (e) {
      console.error('Socket emit error:', e);
    }

    return res.json({
      success: true,
      message: 'Layout updated successfully',
      oldFilename,
      newFilename,
      filename: newFilename
    });
  } catch (e) {
    console.error('Error updating layout:', e);
    await cleanupUploadedFile();
    return res.status(500).json({ success: false, message: 'Error updating layout' });
  }
}

app.put('/upload-floorplan/update', requireApiAuth, floorplanUpload.single('floorplan'), handleLayoutUpdate);
app.put('/upload-layout/update', requireApiAuth, floorplanUpload.single('layout'), handleLayoutUpdate);

async function handleLayoutRename(req, res) {
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
  const paths = await resolvePaths(req);
  if (!paths) {
    return res.status(400).json({ success: false, message: 'Project required' });
  }

  const oldPath = resolveFloorplanImagePath(paths, oldFilename);
  if (!fs.existsSync(oldPath)) {
    return res.status(404).json({ success: false, message: 'File not found' });
  }
  const newExists =
    (paths.layoutsDir && fs.existsSync(path.join(paths.layoutsDir, newFilename))) ||
    (paths.floorplansLegacyDir && fs.existsSync(path.join(paths.floorplansLegacyDir, newFilename)));
  if (newExists) {
    return res.status(409).json({ success: false, message: 'An image with this name already exists' });
  }
  const newPath = path.join(path.dirname(oldPath), newFilename);
  fs.rename(oldPath, newPath, (err) => {
    if (err) {
      console.error('Error renaming layout:', err);
      return res.status(500).json({ success: false, message: 'Error renaming file' });
    }
    try {
      const order = readFloorplanOrder(paths.layoutOrderPath, paths.floorplanOrderPath);
      const newOrder = order.map(f => f === oldFilename ? newFilename : f);
      writeFloorplanOrder(paths.layoutOrderPath, newOrder);
    } catch (e) {}
    try {
      renameAuditLog(paths, 'floorplan', oldFilename, newFilename);
      appendAuditEntry(
        paths,
        'floorplan',
        newFilename,
        {
          action: 'rename',
          message: `Layout renamed from "${oldFilename}" to "${newFilename}".`,
        },
        { userId: req.session.userId }
      );
    } catch (e) {}
    return res.json({ success: true, message: 'Layout renamed successfully', oldFilename, newFilename });
  });
}

app.put('/api/floorplans/rename', requireApiAuth, handleLayoutRename);
app.put('/api/layouts/rename', requireApiAuth, handleLayoutRename);

app.delete('/api/floorplans/:filename', requireApiAuth, (req, res) => {
  res.status(403).json({ success: false, message: 'Floor plan deletion is disabled.' });
});

app.delete('/api/layouts/:filename', requireApiAuth, (req, res) => {
  res.status(403).json({ success: false, message: 'Layout deletion is disabled.' });
});

async function handleLayoutsList(req, res) {
  const paths = await resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    const files = await getOrderedFloorplanFilenames(paths);
    res.json(files);
  } catch (e) {
    res.status(500).json({ error: 'Unable to list layouts' });
  }
}

app.get('/api/floorplans', handleLayoutsList);
app.get('/api/layouts', handleLayoutsList);

async function handleLayoutsOrder(req, res) {
  const paths = await resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const body = req.body;
  if (!body || !Array.isArray(body.order)) return res.status(400).json({ error: 'Invalid payload' });
  const ok = body.order.every(f => typeof f === 'string' && f.length > 0 && !f.includes('..') && !/[\\\/]/.test(f));
  if (!ok) return res.status(400).json({ error: 'Invalid filenames in order' });
  try {
    const dir = path.dirname(paths.layoutOrderPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    writeFloorplanOrder(paths.layoutOrderPath, body.order);
    res.json({ success: true });
    try {
      io.to(`project:${paths.projectId}`).emit('floorplans:order', { order: body.order });
      io.to(`project:${paths.projectId}`).emit('layouts:order', { order: body.order });
    } catch (e) { console.error('Socket emit error:', e); }
  } catch (e) {
    console.error('Error writing floorplan order:', e);
    res.status(500).json({ error: 'Unable to save order' });
  }
}

app.put('/api/floorplans/order', requireApiAuth, handleLayoutsOrder);
app.put('/api/layouts/order', requireApiAuth, handleLayoutsOrder);

app.get('/upload', async (req, res) => {
  const paths = await resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  fs.readdir(paths.uploadsDir, (err, files) => {
    if (err) return res.status(500).json({ error: 'Unable to read directory' });
    const images = (files || []).filter(file => /\.(jpg|jpeg|png|gif|webp)$/i.test(file));
    res.json(images);
  });
});

app.get('/api/panos', async (req, res) => {
  const paths = await resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  console.log(`[DEBUG] /api/panos: Fetching panoramas for project_id: '${paths.projectId}'`);
  try {
    const resultRes = await db.query(
      'SELECT filename FROM panoramas WHERE project_id = $1 AND is_active = true ORDER BY rank ASC', 
      [paths.projectId]
    );
    console.log(`[DEBUG] /api/panos: DB query returned ${resultRes.rows.length} rows.`);
    const files = resultRes.rows.map(r => r.filename);

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

app.put('/api/panos/order', requireApiAuth, async (req, res) => {
  const paths = await resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const body = req.body;
  if (!body || !Array.isArray(body.order)) return res.status(400).json({ error: 'Invalid payload' });
  const ok = body.order.every(f => typeof f === 'string' && f.length > 0 && !f.includes('..') && !/[\\\/]/.test(f));
  if (!ok) return res.status(400).json({ error: 'Invalid filenames in order' });
  try {
    for (let i = 0; i < body.order.length; i++) {
      const filename = body.order[i];
      await db.query('UPDATE panoramas SET rank = $1 WHERE project_id = $2 AND filename = $3', [i, paths.projectId, filename]);
    }
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
  const paths = await resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  try {
    const meta = await ensureTilesForFilename(paths, filename);
    res.json(meta);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.put('/upload/rename', requireApiAuth, async (req, res) => {
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

  const paths = await resolvePaths(req);
  if (!paths) {
    return res.status(400).json({
      success: false,
      message: 'Project required'
    });
  }

  const checkRes = await db.query('SELECT id FROM panoramas WHERE project_id = $1 AND filename = $2', [paths.projectId, oldFilename]);
  if (checkRes.rows.length === 0) return res.status(404).json({ success: false, message: 'Panorama not found in database' });

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

  fs.rename(oldFilePath, newFilePath, async (err) => {
    if (err) {
      return res.status(500).json({
        success: false,
        message: 'Error renaming file'
      });
    }

    await db.query('UPDATE panoramas SET filename = $1 WHERE project_id = $2 AND filename = $3', [newFilename, paths.projectId, oldFilename]);

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

    try {
      renameAuditLog(paths, 'pano', oldFilename, newFilename);
      appendAuditEntry(
        paths,
        'pano',
        newFilename,
        {
          action: 'rename',
          message: `Panorama renamed from "${oldFilename}" to "${newFilename}".`,
        },
        { userId: req.session.userId }
      );
    } catch (e) {}
    try { io.to(`project:${paths.projectId}`).emit('pano:renamed', { oldFilename, newFilename }); } catch (e) { console.error('Socket emit error:', e); }
    res.json({
      success: true,
      message: 'File renamed successfully',
      oldFilename,
      newFilename
    });
  });
});

app.put('/upload/update', requireApiAuth, upload.single('panorama'), async (req, res) => {
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
  const paths = await resolvePaths(req);
  if (!paths) {
    return res.status(400).json({ success: false, message: 'Project required' });
  }

  const checkRes = await db.query('SELECT id FROM panoramas WHERE project_id = $1 AND filename = $2', [paths.projectId, oldFilename]);
  if (checkRes.rows.length === 0) return res.status(404).json({ success: false, message: 'Panorama not found in database' });

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

      await db.query('UPDATE panoramas SET filename = $1 WHERE project_id = $2 AND filename = $3', [newFilename, paths.projectId, oldFilename]);

      try {
        renameAuditLog(paths, 'pano', oldFilename, newFilename);
        appendAuditEntry(
          paths,
          'pano',
          newFilename,
          {
            action: 'update',
            message: `Panorama updated (replaced "${oldFilename}" with "${newFilename}").`,
            ...(archivedImage
              ? {
                  meta: {
                    archivedImage: {
                      kind: 'pano',
                      originalFilename: archivedImage.originalFilename,
                      storedFilename: archivedImage.storedFilename,
                    },
                  },
                }
              : {}),
          },
          { userId: req.session.userId }
        );
      } catch (e) {}
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

app.get('/api/hotspots', async (req, res) => {
  const paths = await resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  try {
    const result = await db.query(
      `SELECT
         hs.id,
         src.filename AS source_filename,
         hs.yaw,
         hs.pitch,
         hs.rotation,
         tgt.filename AS target_filename
       FROM hotspots hs
       JOIN panoramas src ON src.id = hs.source_pano_id
       LEFT JOIN panoramas tgt ON tgt.id = hs.target_pano_id
       WHERE src.project_id = $1
       ORDER BY src.filename ASC, hs.id ASC`,
      [paths.projectId]
    );
    const out = {};
    result.rows.forEach((row) => {
      const source = row.source_filename;
      if (!source) return;
      if (!out[source]) out[source] = [];
      out[source].push({
        id: row.id,
        yaw: row.yaw,
        pitch: row.pitch,
        linkTo: row.target_filename || undefined,
      });
    });
    res.json(out);
  } catch (err) {
    console.error('Error getting hotspots:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/blur-masks', async (req, res) => {
  const paths = await resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  try {
    const result = await db.query('SELECT filename, blur_mask FROM panoramas WHERE project_id = $1', [paths.projectId]);
    const out = {};
    result.rows.forEach(r => {
      out[r.filename] = r.blur_mask || [];
    });
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

async function handleLayoutHotspotsGet(req, res) {
  const paths = await resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  try {
    const result = await db.query(
      `SELECT
         lh.id,
         l.filename AS layout_filename,
         lh.x_coord,
         lh.y_coord,
         p.filename AS target_filename
       FROM layout_hotspots lh
       JOIN layouts l ON l.id = lh.layout_id
       LEFT JOIN panoramas p ON p.id = lh.target_pano_id
       WHERE l.project_id = $1
       ORDER BY l.filename ASC, lh.id ASC`,
      [paths.projectId]
    );
    const out = {};
    result.rows.forEach((row) => {
      const layoutFilename = row.layout_filename;
      if (!layoutFilename) return;
      if (!out[layoutFilename]) out[layoutFilename] = [];
      out[layoutFilename].push({
        id: row.id,
        x: row.x_coord,
        y: row.y_coord,
        linkTo: row.target_filename || undefined,
      });
    });
    res.json(out);
  } catch (e) {
    console.error('Error getting layout hotspots:', e);
    res.status(500).json({ error: 'Database error' });
  }
}

async function handleLayoutHotspotsPost(req, res) {
  const body = req.body;
  if (typeof body !== 'object' || body === null) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const paths = await resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const normalizedBody = normalizeTopLevelArrayMap(body);

  const stripIds = (obj) => {
    const out = {};
    Object.entries(obj || {}).forEach(([key, list]) => {
      if (!Array.isArray(list)) return;
      out[key] = list.map((h) => ({
        x: Number(h.x),
        y: Number(h.y),
        linkTo: h.linkTo || undefined,
      }));
    });
    return out;
  };

  // Current DB state for audit comparison (ignore ids)
  const beforeStripped = {};
  try {
    const resDb = await db.query(
      `SELECT
         l.filename AS layout_filename,
         lh.x_coord,
         lh.y_coord,
         p.filename AS target_filename
       FROM layout_hotspots lh
       JOIN layouts l ON l.id = lh.layout_id
       LEFT JOIN panoramas p ON p.id = lh.target_pano_id
       WHERE l.project_id = $1
       ORDER BY l.filename ASC, lh.id ASC`,
      [paths.projectId]
    );
    resDb.rows.forEach((row) => {
      const layoutFilename = row.layout_filename;
      if (!layoutFilename) return;
      if (!beforeStripped[layoutFilename]) beforeStripped[layoutFilename] = [];
      beforeStripped[layoutFilename].push({
        x: row.x_coord,
        y: row.y_coord,
        linkTo: row.target_filename || undefined,
      });
    });
  } catch (e) {}

  const strippedBody = stripIds(normalizedBody);
  const changed = diffChangedTopLevelKeys(beforeStripped, strippedBody);

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const panoRes = await client.query(
      'SELECT id, filename FROM panoramas WHERE project_id = $1',
      [paths.projectId]
    );
    const panoIdByFilename = new Map(panoRes.rows.map((r) => [r.filename, r.id]));

    const layoutRes = await client.query(
      'SELECT id, filename, rank FROM layouts WHERE project_id = $1',
      [paths.projectId]
    );
    const layoutIdByFilename = new Map(layoutRes.rows.map((r) => [r.filename, r.id]));

    const missingLayouts = Object.keys(strippedBody).filter((name) => name && !layoutIdByFilename.has(name));
    if (missingLayouts.length > 0) {
      const rankRes = await client.query(
        'SELECT COALESCE(MAX(rank), -1)::int as maxr FROM layouts WHERE project_id = $1',
        [paths.projectId]
      );
      let rank = Number(rankRes.rows[0]?.maxr ?? -1) + 1;
      for (const filename of missingLayouts) {
        await client.query(
          `INSERT INTO layouts (project_id, filename, rank)
           VALUES ($1, $2, $3)
           ON CONFLICT (project_id, filename) DO NOTHING`,
          [paths.projectId, filename, rank++]
        );
      }
      const refreshed = await client.query('SELECT id, filename FROM layouts WHERE project_id = $1', [paths.projectId]);
      refreshed.rows.forEach((r) => layoutIdByFilename.set(r.filename, r.id));
    }

    await client.query(
      `DELETE FROM layout_hotspots
       WHERE layout_id IN (SELECT id FROM layouts WHERE project_id = $1)`,
      [paths.projectId]
    );

    for (const [layoutFilename, list] of Object.entries(strippedBody)) {
      const layoutId = layoutIdByFilename.get(layoutFilename);
      if (!layoutId || !Array.isArray(list)) continue;
      for (const h of list) {
        const targetId = h.linkTo ? panoIdByFilename.get(h.linkTo) : null;
        await client.query(
          'INSERT INTO layout_hotspots (layout_id, target_pano_id, x_coord, y_coord) VALUES ($1, $2, $3, $4)',
          [layoutId, targetId || null, Number(h.x), Number(h.y)]
        );
      }
    }

    await client.query('COMMIT');

    try {
      const json = JSON.stringify(normalizedBody, null, 2);
      const dir = path.dirname(paths.layoutHotspotsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      await fs.promises.writeFile(paths.layoutHotspotsPath, json, 'utf8');
    } catch (e) {}

    res.json({ success: true, unchanged: changed.length === 0 });
    if (changed.length === 0) return;

    try {
      io.to(`project:${paths.projectId}`).emit('floorplan-hotspots:changed', normalizedBody);
      io.to(`project:${paths.projectId}`).emit('layout-hotspots:changed', normalizedBody);
    } catch (e) { console.error('Socket emit error:', e); }

    try {
      changed.forEach((filename) => {
        const fp = resolveFloorplanImagePath(paths, filename);
        if (!fp || !fs.existsSync(fp)) return;
        const beforeCount = getArrayCountByKey(beforeStripped, filename);
        const afterCount = getArrayCountByKey(strippedBody, filename);
        const message = buildCollectionChangeMessage('Layout hotspot', 'layout hotspots', beforeCount, afterCount);
        appendAuditEntry(
          paths,
          'floorplan',
          filename,
          { action: 'hotspots', message },
          { dedupeWindowMs: 5000, userId: req.session.userId }
        );
      });
    } catch (e) {}
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) {}
    console.error('Error saving layout hotspots:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    try { client.release(); } catch (e) {}
  }
}

app.get('/api/floorplan-hotspots', handleLayoutHotspotsGet);
app.get('/api/layout-hotspots', handleLayoutHotspotsGet);
app.post('/api/floorplan-hotspots', requireApiAuth, handleLayoutHotspotsPost);
app.post('/api/layout-hotspots', requireApiAuth, handleLayoutHotspotsPost);

app.post('/api/blur-masks', requireApiAuth, async (req, res) => {
  const body = req.body;
  if (typeof body !== 'object' || body === null) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const paths = await resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  
  let before = {};
  try {
    const currentRes = await db.query('SELECT filename, blur_mask FROM panoramas WHERE project_id = $1', [paths.projectId]);
    currentRes.rows.forEach(r => before[r.filename] = r.blur_mask || []);
  } catch(e) {}

  const normalizedBody = normalizeTopLevelArrayMap(body);
  const changed = diffChangedTopLevelKeys(before, normalizedBody);

  try {
    for (const filename of Object.keys(normalizedBody)) {
      const maskData = JSON.stringify(normalizedBody[filename]);
      await db.query('UPDATE panoramas SET blur_mask = $1 WHERE project_id = $2 AND filename = $3', 
        [maskData, paths.projectId, filename]);
    }

    res.json({ success: true, unchanged: changed.length === 0 });

    if (changed.length === 0) return;
    try { io.to(`project:${paths.projectId}`).emit('blur-masks:changed', normalizedBody); } catch (e) { console.error('Socket emit error:', e); }
    try {
      changed.forEach((filename) => {
        const img = path.join(paths.uploadsDir, filename);
        if (!fs.existsSync(img)) return;
        const beforeCount = getArrayCountByKey(before, filename);
        const afterCount = getArrayCountByKey(normalizedBody, filename);
        const message = buildCollectionChangeMessage('Blur mask', 'blur masks', beforeCount, afterCount);
        appendAuditEntry(
          paths,
          'pano',
          filename,
          { action: 'blur', message },
          { dedupeWindowMs: 15000, userId: req.session.userId }
        );
      });
    } catch (e) {}
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/hotspots', requireApiAuth, async (req, res) => {
  const body = req.body;
  if (typeof body !== 'object' || body === null) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const paths = await resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });

  const normalizedBody = normalizeTopLevelArrayMap(body);

  const stripIds = (obj) => {
    const out = {};
    Object.entries(obj || {}).forEach(([key, list]) => {
      if (!Array.isArray(list)) return;
      out[key] = list.map((h) => ({
        yaw: Number(h.yaw),
        pitch: Number(h.pitch),
        linkTo: h.linkTo || undefined,
      }));
    });
    return out;
  };

  // Current DB state for audit comparison (ignore ids)
  const beforeStripped = {};
  try {
    const resDb = await db.query(
      `SELECT
         src.filename AS source_filename,
         hs.yaw,
         hs.pitch,
         tgt.filename AS target_filename
       FROM hotspots hs
       JOIN panoramas src ON src.id = hs.source_pano_id
       LEFT JOIN panoramas tgt ON tgt.id = hs.target_pano_id
       WHERE src.project_id = $1
       ORDER BY src.filename ASC, hs.id ASC`,
      [paths.projectId]
    );
    resDb.rows.forEach((row) => {
      const source = row.source_filename;
      if (!source) return;
      if (!beforeStripped[source]) beforeStripped[source] = [];
      beforeStripped[source].push({
        yaw: row.yaw,
        pitch: row.pitch,
        linkTo: row.target_filename || undefined,
      });
    });
  } catch (e) {}

  const strippedBody = stripIds(normalizedBody);
  const changed = diffChangedTopLevelKeys(beforeStripped, strippedBody);

  // Persist (DB is canonical; file is legacy/backup)
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const panoRes = await client.query(
      'SELECT id, filename FROM panoramas WHERE project_id = $1',
      [paths.projectId]
    );
    const panoIdByFilename = new Map(panoRes.rows.map((r) => [r.filename, r.id]));

    await client.query(
      `DELETE FROM hotspots
       WHERE source_pano_id IN (SELECT id FROM panoramas WHERE project_id = $1)`,
      [paths.projectId]
    );

    for (const [sourceFilename, list] of Object.entries(strippedBody)) {
      const sourceId = panoIdByFilename.get(sourceFilename);
      if (!sourceId || !Array.isArray(list)) continue;
      for (const h of list) {
        const targetId = h.linkTo ? panoIdByFilename.get(h.linkTo) : null;
        await client.query(
          'INSERT INTO hotspots (source_pano_id, target_pano_id, yaw, pitch, rotation) VALUES ($1, $2, $3, $4, $5)',
          [sourceId, targetId || null, Number(h.yaw), Number(h.pitch), 0]
        );
      }
    }

    await client.query('COMMIT');

    try {
      const json = JSON.stringify(normalizedBody, null, 2);
      await fs.promises.writeFile(paths.hotspotsPath, json, 'utf8');
    } catch (e) {}

    res.json({ success: true, unchanged: changed.length === 0 });
    if (changed.length === 0) return;

    try { io.to(`project:${paths.projectId}`).emit('hotspots:changed', normalizedBody); } catch (e) { console.error('Socket emit error:', e); }

    try {
      changed.forEach((filename) => {
        const img = path.join(paths.uploadsDir, filename);
        if (!fs.existsSync(img)) return;
        const beforeCount = getArrayCountByKey(beforeStripped, filename);
        const afterCount = getArrayCountByKey(strippedBody, filename);
        const message = buildCollectionChangeMessage('Hotspot', 'hotspots', beforeCount, afterCount);
        appendAuditEntry(
          paths,
          'pano',
          filename,
          { action: 'hotspots', message },
          { dedupeWindowMs: 5000, userId: req.session.userId }
        );
      });
    } catch (e) {}
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (rollbackErr) {}
    console.error('Error saving hotspots:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    try { client.release(); } catch (e) {}
  }
});

app.get('/api/initial-views', async (req, res) => {
  const paths = await resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  try {
    const result = await db.query('SELECT filename, initial_view FROM panoramas WHERE project_id = $1', [paths.projectId]);
    const out = {};
    result.rows.forEach(r => {
      out[r.filename] = r.initial_view || {};
    });
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/initial-views', requireApiAuth, async (req, res) => {
  const body = req.body;
  if (typeof body !== 'object' || body === null) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const paths = await resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  
  let before = {};
  try {
    const currentRes = await db.query('SELECT filename, initial_view FROM panoramas WHERE project_id = $1', [paths.projectId]);
    currentRes.rows.forEach(r => before[r.filename] = r.initial_view || {});
  } catch(e) {}

  const changed = diffChangedTopLevelKeys(before, body);

  try {
    for (const filename of Object.keys(body)) {
      const viewData = JSON.stringify(body[filename]);
      await db.query('UPDATE panoramas SET initial_view = $1 WHERE project_id = $2 AND filename = $3', 
        [viewData, paths.projectId, filename]);
    }

    res.json({ success: true });
    try { io.to(`project:${paths.projectId}`).emit('initial-views:changed', body); } catch (e) { console.error('Socket emit error:', e); }
    try {
      changed.forEach((filename) => {
        const img = path.join(paths.uploadsDir, filename);
        if (!fs.existsSync(img)) return;
        appendAuditEntry(
          paths,
          'pano',
          filename,
          { action: 'initial-view', message: 'Initial view saved.' },
          { dedupeWindowMs: 3000, userId: req.session.userId }
        );
      });
    } catch (e) {}
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.delete('/upload/:filename', requireApiAuth, (req, res) => {
  res.status(403).json({ success: false, message: 'Panorama deletion is disabled.' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at https://localhost:${PORT}`);
});
