const fs = require('fs');
const path = require('path');
const db = require('../db');

const projectsDir = path.join(__dirname, '../projects');

function readJsonFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    console.error(`Error reading ${filePath}:`, e.message);
  }
  return null;
}

async function migrate() {
  console.log('🚀 Starting Panorama Migration...');

  // 1. Get all projects from the DATABASE to ensure exact ID matching
  let dbProjects = [];
  try {
    const res = await db.query('SELECT id FROM projects');
    dbProjects = res.rows;
  } catch (err) {
    console.error('❌ Failed to fetch projects from DB:', err.message);
    process.exit(0);
  }

  for (const p of dbProjects) {
    const projectId = p.id;
    console.log(`\n📂 Processing Project: ${projectId}`);
    
    const pPath = path.join(projectsDir, projectId);
    
    // Check if folder exists (works on Windows even if casing differs)
    if (!fs.existsSync(pPath)) {
      console.log(`   ⚠️  Folder not found for project ${projectId}, skipping.`);
      continue;
    }

    const uploadsDir = path.join(pPath, 'upload');
    const dataDir = path.join(pPath, 'data');

    if (!fs.existsSync(uploadsDir)) {
      console.log(`   ⚠️  No upload folder, skipping.`);
      continue;
    }

    // Read legacy JSON data
    const order = readJsonFile(path.join(dataDir, 'panorama-order.json')) || [];
    const initialViews = readJsonFile(path.join(dataDir, 'initial-views.json')) || {};
    const blurMasks = readJsonFile(path.join(dataDir, 'blur-masks.json')) || {};

    // Get actual files on disk
    const files = fs.readdirSync(uploadsDir).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));

    // Combine order and unordered files
    const allFiles = new Set([...order, ...files]);
    
    let rank = 0;
    for (const filename of allFiles) {
      // If file doesn't actually exist on disk, skip it (cleanup)
      if (!files.includes(filename)) {
        console.log(`   ⚠️  Skipping missing file: ${filename}`);
        continue;
      }

      const view = initialViews[filename] || {};
      const blur = blurMasks[filename] || [];
      
      try {
        await db.query(`
          INSERT INTO panoramas (project_id, filename, rank, initial_view, blur_mask, is_active)
          VALUES ($1, $2, $3, $4, $5, true)
          ON CONFLICT (project_id, filename) 
          DO UPDATE SET 
            rank = EXCLUDED.rank,
            initial_view = EXCLUDED.initial_view,
            blur_mask = EXCLUDED.blur_mask
        `, [
          projectId, 
          filename, 
          rank++, 
          JSON.stringify(view), 
          JSON.stringify(blur)
        ]);
        console.log(`   ✅ Imported: ${filename}`);
      } catch (err) {
        console.error(`   ❌ Failed to import ${filename}: ${err.message}`);
      }
    }
  }

  console.log('\n🎉 Panorama migration complete.');
  process.exit(0);
}

migrate();