const fs = require('fs');
const path = require('path');

const AUDIT_LOG_MAX_ENTRIES = 250;

function getAuditDirs(paths) {
  const dataDir = path.dirname(paths.hotspotsPath);
  const base = path.join(dataDir, 'audit');
  return {
    base,
    panos: path.join(base, 'panos'),
    floorplans: path.join(base, 'floorplans'),
    projects: path.join(base, 'projects'),
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
  const baseDir =
    kind === 'project'
      ? dirs.projects
      : kind === 'floorplan'
        ? dirs.floorplans
        : dirs.panos;
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
  } catch (_error) {
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

  try {
    const files = fs.readdirSync(baseDir);
    for (const candidate of candidates) {
      const match = files.find((name) => name === candidate || name.endsWith(`-${candidate}`));
      if (match) return path.join(baseDir, match);
    }
  } catch (_error) {}

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
  } catch (error) {
    if (error && error.code === 'ENOENT') return defaultValue;
    console.error('Error reading json file:', filePath, error);
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
  ensureDirSync(
    kind === 'project'
      ? dirs.projects
      : kind === 'floorplan'
        ? dirs.floorplans
        : dirs.panos
  );
  const filePath = auditLogPath(paths, kind, filename);
  fs.writeFileSync(filePath, JSON.stringify(entries, null, 2), 'utf8');
}

function appendAuditEntry(paths, kind, filename, { action, message, meta } = {}, { dedupeWindowMs = 0 } = {}) {
  if (!paths || !filename) return;
  try {
    const existing = readAuditEntries(paths, kind, filename) || [];
    const entry = {
      ts: new Date().toISOString(),
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
  } catch (error) {
    console.error('Error appending audit entry:', error);
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
  } catch (error) {
    console.error('Error initializing audit log:', error);
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
    } catch (error) {
      console.error('Error writing repaired audit entries:', error);
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
  } catch (error) {
    console.error('Error renaming audit log:', error);
  }
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value)
      .sort()
      .forEach((key) => {
        out[key] = sortDeep(value[key]);
      });
    return out;
  }
  return value;
}

function stableStringify(value) {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(sortDeep(value));
  } catch (_error) {
    return String(value);
  }
}

function diffChangedTopLevelKeys(beforeObj, afterObj) {
  const before = beforeObj && typeof beforeObj === 'object' ? beforeObj : {};
  const after = afterObj && typeof afterObj === 'object' ? afterObj : {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [];
  keys.forEach((key) => {
    if (stableStringify(before[key]) !== stableStringify(after[key])) changed.push(key);
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

module.exports = {
  readJsonFileOrDefault,
  resolveArchiveImagePath,
  storeReplacedImageInAudit,
  appendAuditEntry,
  buildAuditMeta,
  initAuditLogIfMissing,
  readAndRepairAuditEntries,
  renameAuditLog,
  diffChangedTopLevelKeys,
  normalizeTopLevelArrayMap,
  getArrayCountByKey,
  buildCollectionChangeMessage,
};
