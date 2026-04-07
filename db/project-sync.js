require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { getPool } = require('./pool');
const { ensureBootstrapSuperAdmin } = require('./users');

const projectRoot = path.join(__dirname, '..');
const projectsDir = path.join(projectRoot, 'projects');
const projectsManifestPath = path.join(projectsDir, 'projects.json');
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.jfif']);

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      console.warn(`Warning: could not read ${path.relative(projectRoot, filePath)}:`, error.message || error);
    }
    return fallback;
  }
}

function normalizeProjectStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (status === 'in-progress') return 'on-going';
  if (status === 'completed') return 'completed';
  return 'on-going';
}

function listFiles(dirPath, allowedExtensions = null) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => {
        if (!allowedExtensions) return true;
        return allowedExtensions.has(path.extname(name).toLowerCase());
      })
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      console.warn(`Warning: could not list ${path.relative(projectRoot, dirPath)}:`, error.message || error);
    }
    return [];
  }
}

function getProjectsManifest() {
  const manifest = readJson(projectsManifestPath, []);
  return Array.isArray(manifest) ? manifest : [];
}

function findManifestProjectByToken(token) {
  const value = String(token || '').trim();
  if (!value) return null;
  const manifest = getProjectsManifest();
  return manifest.find(
    (project) =>
      project &&
      typeof project === 'object' &&
      (String(project.id || '').trim() === value || String(project.number || '').trim() === value)
  ) || null;
}

function getAuditEntries(projectPath, kind, fallbackUserId) {
  const dirPath = path.join(projectPath, 'data', 'audit', kind);
  const files = listFiles(dirPath, null).filter((name) => name.endsWith('.json'));
  return files.flatMap((filename) => {
    const decodedName = decodeURIComponent(filename.replace(/\.json$/i, ''));
    const entries = readJson(path.join(dirPath, filename), []);
    if (!Array.isArray(entries)) return [];
    return entries.map((entry) => {
      const metadata = entry && entry.meta && typeof entry.meta === 'object'
        ? { ...entry.meta, kind, filename: decodedName }
        : { kind, filename: decodedName };
      const createdByUserId = Number(metadata.createdByUserId) || Number(fallbackUserId);

      return {
        kind,
        filename: decodedName,
        action: entry && entry.action ? String(entry.action) : 'update',
        message: entry && entry.message ? String(entry.message) : 'Migrated audit log entry.',
        metadata,
        createdAt: entry && entry.ts ? entry.ts : null,
        createdByUserId,
      };
    });
  });
}

function gatherPanoramaFilenames(projectPath) {
  const uploadDir = path.join(projectPath, 'upload');
  const initialViews = readJson(path.join(projectPath, 'data', 'initial-views.json'), {});
  const hotspots = readJson(path.join(projectPath, 'data', 'hotspots.json'), {});
  const blurMasks = readJson(path.join(projectPath, 'data', 'blur-masks.json'), {});

  const names = new Set(listFiles(uploadDir, IMAGE_EXTENSIONS));
  [initialViews, hotspots, blurMasks].forEach((collection) => {
    if (!collection || typeof collection !== 'object') return;
    Object.keys(collection).forEach((filename) => names.add(filename));
  });

  Object.values(hotspots || {}).forEach((entries) => {
    if (!Array.isArray(entries)) return;
    entries.forEach((entry) => {
      if (entry && entry.linkTo) names.add(String(entry.linkTo));
    });
  });

  const floorplanHotspots = readJson(path.join(projectPath, 'data', 'floorplan-hotspots.json'), {});
  Object.values(floorplanHotspots || {}).forEach((entries) => {
    if (!Array.isArray(entries)) return;
    entries.forEach((entry) => {
      if (entry && entry.linkTo) names.add(String(entry.linkTo));
    });
  });

  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

function gatherLayoutFilenames(projectPath) {
  const layoutDir = path.join(projectPath, 'floorplans');
  const floorplanHotspots = readJson(path.join(projectPath, 'data', 'floorplan-hotspots.json'), {});
  const names = new Set(listFiles(layoutDir, IMAGE_EXTENSIONS));
  if (floorplanHotspots && typeof floorplanHotspots === 'object') {
    Object.keys(floorplanHotspots).forEach((filename) => names.add(filename));
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

async function clearProjectData(client, projectId) {
  await client.query('DELETE FROM audit_logs WHERE project_id = $1', [projectId]);
  await client.query(
    `DELETE FROM layout_hotspots
      WHERE layout_id IN (
        SELECT id FROM layouts WHERE project_id = $1
      )`,
    [projectId]
  );
  await client.query(
    `DELETE FROM panorama_hotspots
      WHERE panorama_id IN (
        SELECT id FROM panoramas WHERE project_id = $1
      )`,
    [projectId]
  );
  await client.query(
    `DELETE FROM blur_masks
      WHERE panorama_id IN (
        SELECT id FROM panoramas WHERE project_id = $1
      )`,
    [projectId]
  );
  await client.query('DELETE FROM layouts WHERE project_id = $1', [projectId]);
  await client.query('DELETE FROM panoramas WHERE project_id = $1', [projectId]);
}

async function upsertProjectRow(client, { legacyId, projectNumber, projectName, status }) {
  const existing = await client.query(
    `SELECT id
       FROM projects
      WHERE legacy_id = $1
         OR (legacy_id IS NULL AND project_number = $2)
      ORDER BY CASE WHEN legacy_id = $1 THEN 0 ELSE 1 END
      LIMIT 1`,
    [legacyId, projectNumber]
  );

  if (existing.rowCount > 0) {
    const result = await client.query(
      `UPDATE projects
          SET legacy_id = $2,
              project_number = $3,
              project_name = $4,
              status = $5
        WHERE id = $1
        RETURNING id`,
      [existing.rows[0].id, legacyId, projectNumber, projectName, status]
    );
    return result.rows[0].id;
  }

  const result = await client.query(
    `INSERT INTO projects (legacy_id, project_number, project_name, status)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [legacyId, projectNumber, projectName, status]
  );
  return result.rows[0].id;
}

async function syncProjectWithClient(client, project, { createdByUserId } = {}) {
  const legacyId = String(project && project.id || '').trim();
  const projectName = String(project && project.name || '').trim();
  const projectNumber = String(project && project.number || '').trim();
  const status = normalizeProjectStatus(project && project.status);

  if (!legacyId || !projectName || !projectNumber) {
    throw new Error(`Project manifest entry is incomplete: ${JSON.stringify(project)}`);
  }

  let ownerUserId = Number(createdByUserId) || 0;
  if (!ownerUserId) {
    const bootstrapUser = await ensureBootstrapSuperAdmin();
    ownerUserId = Number(bootstrapUser.id);
  }

  const projectPath = path.join(projectsDir, legacyId);
  const initialViews = readJson(path.join(projectPath, 'data', 'initial-views.json'), {});
  const hotspots = readJson(path.join(projectPath, 'data', 'hotspots.json'), {});
  const blurMasks = readJson(path.join(projectPath, 'data', 'blur-masks.json'), {});
  const floorplanHotspots = readJson(path.join(projectPath, 'data', 'floorplan-hotspots.json'), {});

  const projectId = await upsertProjectRow(client, {
    legacyId,
    projectNumber,
    projectName,
    status,
  });

  await clearProjectData(client, projectId);

  const panoramaMap = new Map();
  const panoramaFilenames = gatherPanoramaFilenames(projectPath);
  for (const filename of panoramaFilenames) {
    const initialView = initialViews && typeof initialViews === 'object' ? initialViews[filename] : null;
    const result = await client.query(
      `INSERT INTO panoramas (project_id, filename, initial_yaw, initial_pitch, initial_fov)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        projectId,
        filename,
        initialView && Number.isFinite(Number(initialView.yaw)) ? Number(initialView.yaw) : null,
        initialView && Number.isFinite(Number(initialView.pitch)) ? Number(initialView.pitch) : null,
        initialView && Number.isFinite(Number(initialView.fov)) ? Number(initialView.fov) : null,
      ]
    );
    panoramaMap.set(filename, result.rows[0].id);
  }

  const layoutMap = new Map();
  const layoutFilenames = gatherLayoutFilenames(projectPath);
  for (const filename of layoutFilenames) {
    const result = await client.query(
      `INSERT INTO layouts (project_id, layout_filename, created_by)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [projectId, filename, ownerUserId]
    );
    layoutMap.set(filename, result.rows[0].id);
  }

  for (const [sourceFilename, entries] of Object.entries(hotspots || {})) {
    const panoramaId = panoramaMap.get(sourceFilename);
    if (!panoramaId || !Array.isArray(entries)) continue;
    for (const entry of entries) {
      const targetPanoramaId = panoramaMap.get(entry && entry.linkTo ? String(entry.linkTo) : '');
      if (!targetPanoramaId) continue;
      await client.query(
        `INSERT INTO panorama_hotspots (panorama_id, target_panorama_id, yaw, pitch, label)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          panoramaId,
          targetPanoramaId,
          Number(entry.yaw),
          Number(entry.pitch),
          entry && entry.label ? String(entry.label) : null,
        ]
      );
    }
  }

  for (const [sourceFilename, entries] of Object.entries(blurMasks || {})) {
    const panoramaId = panoramaMap.get(sourceFilename);
    if (!panoramaId || !Array.isArray(entries)) continue;
    for (const entry of entries) {
      await client.query(
        `INSERT INTO blur_masks (panorama_id, yaw, pitch, radius)
         VALUES ($1, $2, $3, $4)`,
        [
          panoramaId,
          Number(entry.yaw),
          Number(entry.pitch),
          Number(entry.radiusRatio ?? entry.radius),
        ]
      );
    }
  }

  for (const [layoutFilename, entries] of Object.entries(floorplanHotspots || {})) {
    const layoutId = layoutMap.get(layoutFilename);
    if (!layoutId || !Array.isArray(entries)) continue;
    for (const entry of entries) {
      const targetPanoramaId = panoramaMap.get(entry && entry.linkTo ? String(entry.linkTo) : '');
      if (!targetPanoramaId) continue;
      await client.query(
        `INSERT INTO layout_hotspots (layout_id, target_panorama_id, x, y, label)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          layoutId,
          targetPanoramaId,
          Number(entry.x),
          Number(entry.y),
          entry && entry.label ? String(entry.label) : null,
        ]
      );
    }
  }

  const auditEntries = [
    ...getAuditEntries(projectPath, 'panos', ownerUserId),
    ...getAuditEntries(projectPath, 'floorplans', ownerUserId),
  ];

  for (const entry of auditEntries) {
    await client.query(
      `INSERT INTO audit_logs (
        project_id,
        project_number,
        project_name,
        created_by,
        action,
        message,
        metadata,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, COALESCE($8::timestamptz, NOW()))`,
      [
        projectId,
        projectNumber,
        projectName,
        Number(entry.createdByUserId) || ownerUserId,
        entry.action,
        entry.message,
        JSON.stringify(entry.metadata || {}),
        entry.createdAt,
      ]
    );
  }

  return {
    legacyId,
    projectNumber,
    projectName,
    projectId,
    panoramas: panoramaMap.size,
    layouts: layoutMap.size,
    hotspotGroups: Object.keys(hotspots || {}).length,
    blurMaskGroups: Object.keys(blurMasks || {}).length,
    floorplanHotspotGroups: Object.keys(floorplanHotspots || {}).length,
    auditEntries: auditEntries.length,
  };
}

async function syncProjectByToken(token, { createdByUserId } = {}) {
  const project = findManifestProjectByToken(token);
  if (!project) {
    throw new Error(`Project not found in manifest for token "${token}"`);
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const summary = await syncProjectWithClient(client, project, { createdByUserId });
    await client.query('COMMIT');
    return summary;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function syncAllProjects({ createdByUserId } = {}) {
  const manifest = getProjectsManifest();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const summaries = [];
    for (const project of manifest) {
      summaries.push(await syncProjectWithClient(client, project, { createdByUserId }));
    }
    await client.query('COMMIT');
    return summaries;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  findManifestProjectByToken,
  getProjectsManifest,
  normalizeProjectStatus,
  syncAllProjects,
  syncProjectByToken,
  syncProjectWithClient,
};
