const fs = require('fs');
const path = require('path');
const db = require('../db');

const projectsDir = path.join(__dirname, '../projects');
const projectsManifestPath = path.join(projectsDir, 'projects.json');

async function migrate() {
  console.log('🚀 Starting Project Migration...');

  if (!fs.existsSync(projectsManifestPath)) {
    console.log('❌ No projects.json found. Nothing to migrate.');
    process.exit(0);
  }

  let projects = [];
  try {
    const raw = fs.readFileSync(projectsManifestPath, 'utf8');
    projects = JSON.parse(raw);
  } catch (e) {
    console.error('❌ Invalid JSON in projects.json');
    process.exit(1);
  }

  if (!Array.isArray(projects)) {
    console.log('❌ projects.json is not an array.');
    process.exit(0);
  }

  console.log(`📂 Found ${projects.length} projects in JSON.`);

  for (const p of projects) {
    // Validate that the project folder actually exists on disk
    // This prevents adding "ghost" projects to the database
    const projectPath = path.join(projectsDir, p.id);
    if (!fs.existsSync(projectPath)) {
        console.log(`⚠️  Skipped (folder missing): ${p.name} (${p.id})`);
        continue;
    }

    try {
      // Upsert: Insert if not exists, otherwise do nothing
      const res = await db.query(
        `INSERT INTO projects (id, name, number, status, created_at) 
         VALUES ($1, $2, $3, $4, NOW()) 
         ON CONFLICT (id) DO NOTHING 
         RETURNING id`,
        [p.id, p.name, p.number, p.status || 'on-going']
      );

      if (res.rows.length > 0) {
        console.log(`✅ Migrated: ${p.name} (${p.id})`);
      } else {
        console.log(`⚠️  Skipped (already exists): ${p.name} (${p.id})`);
      }
    } catch (err) {
      console.error(`❌ Failed to migrate ${p.name}:`, err.message);
    }
  }

  console.log('🎉 Migration complete.');
  process.exit(0);
}

migrate();