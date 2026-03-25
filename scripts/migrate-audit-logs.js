const fs = require('fs');
const path = require('path');
const db = require('../db');

const projectsDir = path.join(__dirname, '../projects');

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (e) {
    return value;
  }
}

function readJsonArray(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn(`Could not read audit JSON: ${filePath}: ${e.message || e}`);
    return [];
  }
}

function parseAuditAssetFilenameFromPath(filePath) {
  const base = path.basename(filePath, '.json');
  const dec1 = safeDecode(base);
  const dec2 = safeDecode(dec1);
  return dec2 || dec1 || base;
}

async function insertAuditLogIfMissing(client, { projectId, action, message, metadata, createdAt, kind, filename }) {
  const created = createdAt ? new Date(createdAt) : new Date();
  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  const metaJson = JSON.stringify(meta);

  await client.query(
    `INSERT INTO audit_logs (project_id, user_id, action, message, metadata, created_at)
     SELECT $1::text, NULL, $2::text, $3::text, $4::jsonb, $5::timestamp
     WHERE NOT EXISTS (
       SELECT 1
       FROM audit_logs
       WHERE project_id = $1::text
         AND action = $2::text
         AND COALESCE(message, '') = COALESCE($3::text, '')
         AND created_at = $5::timestamp
         AND metadata->>'kind' = $6::text
         AND metadata->>'filename' = $7::text
       LIMIT 1
     )`,
    [String(projectId), String(action), message ? String(message) : null, metaJson, created, String(kind), String(filename)]
  );
}

async function migrateProject(client, projectId) {
  const projectPath = path.join(projectsDir, projectId);
  const dataDir = path.join(projectPath, 'data');
  const auditDir = path.join(dataDir, 'audit');
  const panosDir = path.join(auditDir, 'panos');
  const floorplansDir = path.join(auditDir, 'floorplans'); // legacy; treated as "layout"

  let inserted = 0;

  const migrateDir = async (dirPath, kind) => {
    if (!fs.existsSync(dirPath)) return;
    const files = fs.readdirSync(dirPath).filter((f) => f.toLowerCase().endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const filename = parseAuditAssetFilenameFromPath(filePath);
      const entries = readJsonArray(filePath);
      for (const entry of entries) {
        const ts = entry && entry.ts ? entry.ts : null;
        const entryAction = entry && entry.action ? String(entry.action) : 'update';
        const entryMessage = entry && entry.message ? String(entry.message) : entryAction;
        const entryMeta = entry && entry.meta && typeof entry.meta === 'object' ? entry.meta : undefined;

        const action = `archive:${kind}:${entryAction}`;
        const metadata = {
          source: 'archive-files',
          kind,
          filename,
          ...(entryMeta ? { meta: entryMeta } : {}),
        };

        await insertAuditLogIfMissing(client, {
          projectId,
          action,
          message: entryMessage,
          metadata,
          createdAt: ts,
          kind,
          filename,
        });
        inserted += 1;
      }
    }
  };

  await migrateDir(panosDir, 'pano');
  await migrateDir(floorplansDir, 'layout');

  return inserted;
}

async function migrateAll() {
  console.log('🚀 Starting audit log migration (archive files -> Postgres.audit_logs)...');
  const client = await db.getClient();
  try {
    const existsRes = await client.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='audit_logs' LIMIT 1"
    );
    if (existsRes.rows.length === 0) {
      console.error('❌ audit_logs table not found. Run your schema/migrations first.');
      process.exit(1);
    }

    const projectsRes = await client.query('SELECT id FROM projects ORDER BY created_at ASC');
    const projectIds = projectsRes.rows.map((r) => r.id);

    let total = 0;
    for (const projectId of projectIds) {
      try {
        await client.query('BEGIN');
        const count = await migrateProject(client, projectId);
        await client.query('COMMIT');
        total += count;
        console.log(`✅ ${projectId}: processed ${count} archive entries`);
      } catch (e) {
        try {
          await client.query('ROLLBACK');
        } catch {}
        console.error(`❌ ${projectId}: migration failed:`, e.message || e);
      }
    }

    console.log('🎉 Done.');
    console.log(`Total archive entries processed: ${total}`);
    process.exit(0);
  } catch (e) {
    console.error('Migration failed:', e.message || e);
    process.exit(1);
  } finally {
    try {
      client.release();
    } catch {}
  }
}

migrateAll();
