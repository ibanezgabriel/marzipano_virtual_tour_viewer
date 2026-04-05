const fs = require('fs');
const path = require('path');
const db = require('../db');

const projectsDir = path.join(__dirname, '../projects');

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

async function ensureColumn() {
  await db.query("ALTER TABLE projects ADD COLUMN IF NOT EXISTS workflow_state VARCHAR(30) NOT NULL DEFAULT 'DRAFT'");
}

async function migrate() {
  console.log('🚦 Migrating project workflow_state...');
  await ensureColumn();

  const res = await db.query('SELECT * FROM projects ORDER BY created_at ASC');
  const projects = res.rows || [];
  let published = 0;
  let drafted = 0;
  let skipped = 0;

  for (const p of projects) {
    const id = String(p.id || '').trim();
    if (!id) continue;
    const folderName = (p.folder_name && String(p.folder_name).trim()) || id;

    const current = String(p.workflow_state || '').trim().toUpperCase() || 'DRAFT';
    // Do not overwrite future states if they already exist.
    if (current !== 'DRAFT' && current !== 'PUBLISHED') {
      skipped += 1;
      continue;
    }

    const tilesDir = path.join(projectsDir, folderName, 'tiles');
    const next = hasReadyTiles(tilesDir) ? 'PUBLISHED' : 'DRAFT';
    await db.query('UPDATE projects SET workflow_state = $1 WHERE id = $2', [next, id]);
    if (next === 'PUBLISHED') published += 1;
    else drafted += 1;
  }

  console.log(`✅ Done. Set PUBLISHED=${published}, DRAFT=${drafted}, skipped=${skipped}.`);
  process.exit(0);
}

migrate().catch((e) => {
  console.error('❌ Workflow state migration failed:', e.message || e);
  process.exit(1);
});
