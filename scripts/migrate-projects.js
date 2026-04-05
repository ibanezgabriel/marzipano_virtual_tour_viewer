const fs = require('fs');
const path = require('path');
const db = require('../db');

const projectsDir = path.join(__dirname, '../projects');
const projectsManifestPath = path.join(projectsDir, 'projects.json');

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function humanizeProjectName(id) {
  const raw = String(id || '').trim();
  if (!raw) return '';
  const spaced = raw.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return spaced
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function listProjectIdsFromFolders() {
  try {
    if (!fs.existsSync(projectsDir)) return [];
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => name && !name.startsWith('.'));
  } catch (e) {
    return [];
  }
}

function hasReadyTiles(tilesRoot) {
  try {
    if (!tilesRoot || !fs.existsSync(tilesRoot)) return false;
    const children = fs.readdirSync(tilesRoot, { withFileTypes: true });
    for (const d of children) {
      if (!d.isDirectory()) continue;
      const metaPath = path.join(tilesRoot, d.name, 'meta.json');
      if (fs.existsSync(metaPath)) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

async function ensureWorkflowColumn() {
  await db.query(
    "ALTER TABLE projects ADD COLUMN IF NOT EXISTS workflow_state VARCHAR(30) NOT NULL DEFAULT 'DRAFT'"
  );
}

async function migrate() {
  console.log('🚀 Starting Project Migration...');

  if (!fs.existsSync(projectsDir)) {
    console.log(`❌ Projects folder not found: ${projectsDir}`);
    process.exit(1);
  }

  const manifest = readJsonIfExists(projectsManifestPath);
  const manifestProjects = Array.isArray(manifest) ? manifest : [];
  const manifestIds = new Set(manifestProjects.map((p) => String(p && p.id ? p.id : '').trim()).filter(Boolean));

  const folderIds = listProjectIdsFromFolders();
  const folderProjects = folderIds
    .filter((id) => !manifestIds.has(id))
    .map((id) => ({
      id,
      name: humanizeProjectName(id),
      number: id,
      status: 'on-going',
      _source: 'folder-scan',
    }));

  const projects = [
    ...manifestProjects.map((p) => ({ ...p, _source: 'projects.json' })),
    ...folderProjects,
  ].filter((p) => p && typeof p === 'object');

  if (projects.length === 0) {
    console.log(`❌ No projects found in ${projectsDir} (and no projects.json). Nothing to migrate.`);
    process.exit(0);
  }

  const manifestCount = manifestProjects.length;
  const folderCount = folderProjects.length;
  if (manifestCount > 0) {
    console.log(`📂 Found ${manifestCount} projects in projects.json (+${folderCount} from folder scan).`);
  } else {
    console.log(`📂 Found ${folderCount} projects by scanning folders (projects.json not found).`);
  }

  try {
    await ensureWorkflowColumn();
  } catch (e) {
    console.error('❌ Could not ensure projects.workflow_state column:', e.message || e);
    process.exit(1);
  }

  for (const p of projects) {
    const id = String(p.id || '').trim();
    if (!id || id.includes('..') || id.includes('/') || id.includes('\\')) {
      console.log(`⚠️  Skipped (invalid id): ${p && p.id ? String(p.id) : '(missing id)'}`);
      continue;
    }

    // Validate that the project folder actually exists on disk
    // This prevents adding "ghost" projects to the database
    const projectPath = path.join(projectsDir, id);
    if (!fs.existsSync(projectPath)) {
      console.log(`⚠️  Skipped (folder missing): ${p.name || id} (${id})`);
      continue;
    }

    const name = String(p.name || '').trim() || humanizeProjectName(id) || id;
    const number = String(p.number || '').trim() || id;
    const status = String(p.status || '').trim() || 'on-going';
    const tilesDir = path.join(projectPath, 'tiles');
    const workflowState = hasReadyTiles(tilesDir) ? 'PUBLISHED' : 'DRAFT';

    try {
      // Upsert: Insert if not exists, otherwise do nothing
      const res = await db.query(
        `INSERT INTO projects (id, name, number, status, workflow_state) 
         VALUES ($1, $2, $3, $4, $5) 
         ON CONFLICT (id) DO NOTHING 
         RETURNING id`,
        [id, name, number, status, workflowState]
      );

      if (res.rows.length > 0) {
        console.log(`✅ Migrated: ${name} (${id}) [${workflowState}]`);
      } else {
        console.log(`⚠️  Skipped (already exists): ${name} (${id})`);
      }
    } catch (err) {
      console.error(`❌ Failed to migrate ${name} (${id}):`, err.message);
    }
  }

  console.log('🎉 Migration complete.');
  process.exit(0);
}

migrate();
