const fs = require('fs');
const path = require('path');
const db = require('../db');

const projectsDir = path.join(__dirname, '../projects');

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`Could not read JSON: ${filePath}: ${e.message || e}`);
    return null;
  }
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

function stripPanoHotspotIds(obj) {
  const out = {};
  Object.entries(obj || {}).forEach(([key, list]) => {
    if (!Array.isArray(list)) return;
    out[key] = list.map((h) => ({
      yaw: Number(h.yaw),
      pitch: Number(h.pitch),
      linkTo: h.linkTo || undefined,
      rotation: Number(h.rotation || 0),
    }));
  });
  return out;
}

function stripLayoutHotspotIds(obj) {
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
}

async function migrateProject(projectId) {
  const projectPath = path.join(projectsDir, projectId);
  const dataDir = path.join(projectPath, 'data');
  const panoHotspotsPath = path.join(dataDir, 'hotspots.json');
  const layoutHotspotsPath = path.join(dataDir, 'layout-hotspots.json');
  const legacyFloorplanHotspotsPath = path.join(dataDir, 'floorplan-hotspots.json');

  const panoRaw = readJsonIfExists(panoHotspotsPath);
  const layoutRaw =
    readJsonIfExists(layoutHotspotsPath) ??
    readJsonIfExists(legacyFloorplanHotspotsPath);

  const panoNormalized = stripPanoHotspotIds(normalizeTopLevelArrayMap(panoRaw));
  const layoutNormalized = stripLayoutHotspotIds(normalizeTopLevelArrayMap(layoutRaw));

  const shouldMigratePanos = fs.existsSync(panoHotspotsPath) && Object.keys(panoNormalized).length > 0;
  const shouldMigrateLayouts =
    (fs.existsSync(layoutHotspotsPath) || fs.existsSync(legacyFloorplanHotspotsPath)) &&
    Object.keys(layoutNormalized).length > 0;

  if (!shouldMigratePanos && !shouldMigrateLayouts) {
    return { projectId, panoInserted: 0, layoutInserted: 0, skipped: true };
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const panoRes = await client.query(
      'SELECT id, filename FROM panoramas WHERE project_id = $1',
      [projectId]
    );
    const panoIdByFilename = new Map(panoRes.rows.map((r) => [r.filename, r.id]));

    let panoInserted = 0;
    if (shouldMigratePanos) {
      await client.query(
        `DELETE FROM hotspots
         WHERE source_pano_id IN (SELECT id FROM panoramas WHERE project_id = $1)`,
        [projectId]
      );

      for (const [sourceFilename, list] of Object.entries(panoNormalized)) {
        const sourceId = panoIdByFilename.get(sourceFilename);
        if (!sourceId || !Array.isArray(list)) continue;
        for (const h of list) {
          const targetId = h.linkTo ? panoIdByFilename.get(h.linkTo) : null;
          await client.query(
            'INSERT INTO hotspots (source_pano_id, target_pano_id, yaw, pitch, rotation) VALUES ($1, $2, $3, $4, $5)',
            [sourceId, targetId || null, Number(h.yaw), Number(h.pitch), Number(h.rotation || 0)]
          );
          panoInserted += 1;
        }
      }
    }

    let layoutInserted = 0;
    if (shouldMigrateLayouts) {
      const layoutRes = await client.query(
        'SELECT id, filename, rank FROM layouts WHERE project_id = $1',
        [projectId]
      );
      const layoutIdByFilename = new Map(layoutRes.rows.map((r) => [r.filename, r.id]));
      const missingLayouts = Object.keys(layoutNormalized).filter((name) => name && !layoutIdByFilename.has(name));
      if (missingLayouts.length > 0) {
        const rankRes = await client.query(
          'SELECT COALESCE(MAX(rank), -1)::int as maxr FROM layouts WHERE project_id = $1',
          [projectId]
        );
        let rank = Number(rankRes.rows[0]?.maxr ?? -1) + 1;
        for (const filename of missingLayouts) {
          await client.query(
            `INSERT INTO layouts (project_id, filename, rank)
             VALUES ($1, $2, $3)
             ON CONFLICT (project_id, filename) DO NOTHING`,
            [projectId, filename, rank++]
          );
        }
        const refreshed = await client.query('SELECT id, filename FROM layouts WHERE project_id = $1', [projectId]);
        refreshed.rows.forEach((r) => layoutIdByFilename.set(r.filename, r.id));
      }

      await client.query(
        `DELETE FROM layout_hotspots
         WHERE layout_id IN (SELECT id FROM layouts WHERE project_id = $1)`,
        [projectId]
      );

      for (const [layoutFilename, list] of Object.entries(layoutNormalized)) {
        const layoutId = layoutIdByFilename.get(layoutFilename);
        if (!layoutId || !Array.isArray(list)) continue;
        for (const h of list) {
          const targetId = h.linkTo ? panoIdByFilename.get(h.linkTo) : null;
          await client.query(
            'INSERT INTO layout_hotspots (layout_id, target_pano_id, x_coord, y_coord) VALUES ($1, $2, $3, $4)',
            [layoutId, targetId || null, Number(h.x), Number(h.y)]
          );
          layoutInserted += 1;
        }
      }
    }

    await client.query('COMMIT');
    return { projectId, panoInserted, layoutInserted, skipped: false };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw err;
  } finally {
    try {
      client.release();
    } catch {}
  }
}

async function migrateAll() {
  console.log('🚀 Starting hotspot migration (files -> Postgres)...');

  let projects = [];
  try {
    const res = await db.query('SELECT id FROM projects ORDER BY created_at ASC');
    projects = res.rows.map((r) => r.id);
  } catch (e) {
    console.error('❌ Could not load projects from DB:', e.message || e);
    process.exit(1);
  }

  let totalPano = 0;
  let totalLayout = 0;
  let skipped = 0;

  for (const projectId of projects) {
    try {
      const result = await migrateProject(projectId);
      if (result.skipped) {
        skipped += 1;
        console.log(`⚠️  ${projectId}: no non-empty hotspot files found (skipped)`);
        continue;
      }
      totalPano += result.panoInserted;
      totalLayout += result.layoutInserted;
      console.log(`✅ ${projectId}: pano hotspots=${result.panoInserted}, layout hotspots=${result.layoutInserted}`);
    } catch (e) {
      console.error(`❌ ${projectId}: migration failed:`, e.message || e);
    }
  }

  console.log('🎉 Done.');
  console.log(`Totals: pano hotspots inserted=${totalPano}, layout hotspots inserted=${totalLayout}, projects skipped=${skipped}`);
  process.exit(0);
}

migrateAll();
