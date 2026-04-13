const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const appEnvPath = path.join(__dirname, "..", ".env");
const repoEnvPath = path.join(__dirname, "..", "..", ".env");
dotenv.config({ path: fs.existsSync(appEnvPath) ? appEnvPath : repoEnvPath });
const { Client } = require("pg");
const { getPool } = require("./pool");
const { formatUserId } = require("./users");

function quoteIdentifier(identifier) {
  const value = String(identifier || "").trim();
  if (!/^[a-zA-Z0-9_]+$/.test(value)) {
    throw new Error(
      `Refusing to quote unsafe database identifier "${value}". ` +
      `Use only letters, numbers, and underscores for PGDATABASE, or create the database manually.`
    );
  }
  return `"${value}"`;
}

function getTargetDatabaseName() {
  if (process.env.DATABASE_URL) {
    try {
      const url = new URL(process.env.DATABASE_URL);
      const db = (url.pathname || "").replace(/^\//, "").trim();
      return db || "";
    } catch (_error) {
      return "";
    }
  }
  return String(process.env.PGDATABASE || "").trim();
}

function buildAdminConnectionOptions(targetDbName) {
  if (process.env.DATABASE_URL) {
    const url = new URL(process.env.DATABASE_URL);
    // Connect to a known existing database to create the target one if missing.
    url.pathname = "/postgres";
    return { connectionString: url.toString() };
  }
  const rawPassword = process.env.PGPASSWORD;
  const password = rawPassword === undefined ? undefined : String(rawPassword);
  return {
    host: process.env.PGHOST,
    port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
    user: process.env.PGUSER,
    password,
    database: "postgres",
  };
}

async function ensureDatabaseExists() {
  const targetDbName = getTargetDatabaseName();
  if (!targetDbName) return;

  let adminClient = null;
  try {
    adminClient = new Client(buildAdminConnectionOptions(targetDbName));
    await adminClient.connect();
  } catch (error) {
    // Fallback: some installs don't have the "postgres" database available.
    try {
      if (adminClient) await adminClient.end();
    } catch (_e) {}
    adminClient = null;
    if (process.env.DATABASE_URL) throw error;
    const rawPassword = process.env.PGPASSWORD;
    const password = rawPassword === undefined ? undefined : String(rawPassword);
    adminClient = new Client({
      host: process.env.PGHOST,
      port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
      user: process.env.PGUSER,
      password,
      database: "template1",
    });
    await adminClient.connect();
  }

  try {
    const exists = await adminClient.query(
      "SELECT 1 FROM pg_database WHERE datname = $1 LIMIT 1",
      [targetDbName]
    );
    if (exists.rowCount > 0) return;
    await adminClient.query(`CREATE DATABASE ${quoteIdentifier(targetDbName)}`);
  } finally {
    await adminClient.end();
  }
}

function splitSql(sql) {
  const noLineComments = sql
    .split("\n")
    .map((line) => line.replace(/--.*$/g, ""))
    .join("\n");

  return noLineComments
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function getColumnType(client, tableName, columnName) {
  const result = await client.query(
    `SELECT data_type
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2`,
    [tableName, columnName]
  );
  return result.rows[0] ? result.rows[0].data_type : null;
}

async function tableExists(client, tableName) {
  const result = await client.query(
    `SELECT 1
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = $1
      LIMIT 1`,
    [tableName]
  );
  return result.rowCount > 0;
}

async function columnExists(client, tableName, columnName) {
  const result = await client.query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2
      LIMIT 1`,
    [tableName, columnName]
  );
  return result.rowCount > 0;
}

async function getColumnPosition(client, tableName, columnName) {
  const result = await client.query(
    `SELECT ordinal_position
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2`,
    [tableName, columnName]
  );
  return result.rows[0] ? Number(result.rows[0].ordinal_position) : null;
}

async function resetSerialSequence(client, tableName, columnName = "id") {
  await client.query(
    `SELECT setval(
       pg_get_serial_sequence($1, $2),
       COALESCE((SELECT MAX(id) FROM ${tableName}), 0),
       (SELECT COUNT(*) > 0 FROM ${tableName})
     )`,
    [tableName, columnName]
  );
}

async function recreatePanoramaHotspotsTable(client) {
  if (!(await tableExists(client, "panorama_hotspots"))) return;

  const projectIdPosition = await getColumnPosition(client, "panorama_hotspots", "project_id");
  const panoramaIdPosition = await getColumnPosition(client, "panorama_hotspots", "panorama_id");
  if (projectIdPosition === 2 && panoramaIdPosition === 3) {
    await client.query("CREATE INDEX IF NOT EXISTS idx_panorama_hotspots_project_id ON panorama_hotspots(project_id)");
    return;
  }

  await client.query("DROP INDEX IF EXISTS idx_panorama_hotspots_project_id");
  await client.query("DROP INDEX IF EXISTS idx_panorama_hotspots_panorama_id");
  await client.query("DROP INDEX IF EXISTS idx_panorama_hotspots_target_panorama_id");
  await client.query("ALTER TABLE panorama_hotspots RENAME TO panorama_hotspots_old");
  await client.query(`
    CREATE TABLE panorama_hotspots (
      id BIGSERIAL PRIMARY KEY,
      project_id BIGINT NOT NULL REFERENCES projects(id),
      panorama_id BIGINT NOT NULL REFERENCES panoramas(id),
      target_panorama_id BIGINT NOT NULL REFERENCES panoramas(id),
      yaw DOUBLE PRECISION NOT NULL,
      pitch DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    INSERT INTO panorama_hotspots (id, project_id, panorama_id, target_panorama_id, yaw, pitch, created_at)
    SELECT pho.id, pa.project_id, pho.panorama_id, pho.target_panorama_id, pho.yaw, pho.pitch, pho.created_at
      FROM panorama_hotspots_old AS pho
      JOIN panoramas AS pa ON pa.id = pho.panorama_id
  `);
  await client.query("DROP TABLE panorama_hotspots_old");
  await client.query("CREATE INDEX IF NOT EXISTS idx_panorama_hotspots_project_id ON panorama_hotspots(project_id)");
  await client.query("CREATE INDEX IF NOT EXISTS idx_panorama_hotspots_panorama_id ON panorama_hotspots(panorama_id)");
  await client.query("CREATE INDEX IF NOT EXISTS idx_panorama_hotspots_target_panorama_id ON panorama_hotspots(target_panorama_id)");
  await resetSerialSequence(client, "panorama_hotspots");
}

async function recreateLayoutHotspotsTable(client) {
  if (!(await tableExists(client, "layout_hotspots"))) return;

  const projectIdPosition = await getColumnPosition(client, "layout_hotspots", "project_id");
  const layoutIdPosition = await getColumnPosition(client, "layout_hotspots", "layout_id");
  if (projectIdPosition === 2 && layoutIdPosition === 3) {
    await client.query("CREATE INDEX IF NOT EXISTS idx_layout_hotspots_project_id ON layout_hotspots(project_id)");
    return;
  }

  await client.query("DROP INDEX IF EXISTS idx_layout_hotspots_project_id");
  await client.query("DROP INDEX IF EXISTS idx_layout_hotspots_layout_id");
  await client.query("DROP INDEX IF EXISTS idx_layout_hotspots_target_panorama_id");
  await client.query("ALTER TABLE layout_hotspots RENAME TO layout_hotspots_old");
  await client.query(`
    CREATE TABLE layout_hotspots (
      id BIGSERIAL PRIMARY KEY,
      project_id BIGINT NOT NULL REFERENCES projects(id),
      layout_id BIGINT NOT NULL REFERENCES layouts(id),
      target_panorama_id BIGINT NOT NULL REFERENCES panoramas(id),
      x DOUBLE PRECISION NOT NULL,
      y DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    INSERT INTO layout_hotspots (id, project_id, layout_id, target_panorama_id, x, y, created_at)
    SELECT lho.id, l.project_id, lho.layout_id, lho.target_panorama_id, lho.x, lho.y, lho.created_at
      FROM layout_hotspots_old AS lho
      JOIN layouts AS l ON l.id = lho.layout_id
  `);
  await client.query("DROP TABLE layout_hotspots_old");
  await client.query("CREATE INDEX IF NOT EXISTS idx_layout_hotspots_project_id ON layout_hotspots(project_id)");
  await client.query("CREATE INDEX IF NOT EXISTS idx_layout_hotspots_layout_id ON layout_hotspots(layout_id)");
  await client.query("CREATE INDEX IF NOT EXISTS idx_layout_hotspots_target_panorama_id ON layout_hotspots(target_panorama_id)");
  await resetSerialSequence(client, "layout_hotspots");
}

async function recreateBlurMasksTable(client) {
  if (!(await tableExists(client, "blur_masks"))) return;

  const projectIdPosition = await getColumnPosition(client, "blur_masks", "project_id");
  const panoramaIdPosition = await getColumnPosition(client, "blur_masks", "panorama_id");
  if (projectIdPosition === 2 && panoramaIdPosition === 3) {
    await client.query("CREATE INDEX IF NOT EXISTS idx_blur_masks_project_id ON blur_masks(project_id)");
    return;
  }

  await client.query("DROP INDEX IF EXISTS idx_blur_masks_project_id");
  await client.query("DROP INDEX IF EXISTS idx_blur_masks_panorama_id");
  await client.query("ALTER TABLE blur_masks RENAME TO blur_masks_old");
  await client.query(`
    CREATE TABLE blur_masks (
      id BIGSERIAL PRIMARY KEY,
      project_id BIGINT NOT NULL REFERENCES projects(id),
      panorama_id BIGINT NOT NULL REFERENCES panoramas(id),
      yaw DOUBLE PRECISION NOT NULL,
      pitch DOUBLE PRECISION NOT NULL,
      radius DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    INSERT INTO blur_masks (id, project_id, panorama_id, yaw, pitch, radius, created_at)
    SELECT bm.id, pa.project_id, bm.panorama_id, bm.yaw, bm.pitch, bm.radius, bm.created_at
      FROM blur_masks_old AS bm
      JOIN panoramas AS pa ON pa.id = bm.panorama_id
  `);
  await client.query("DROP TABLE blur_masks_old");
  await client.query("CREATE INDEX IF NOT EXISTS idx_blur_masks_project_id ON blur_masks(project_id)");
  await client.query("CREATE INDEX IF NOT EXISTS idx_blur_masks_panorama_id ON blur_masks(panorama_id)");
  await resetSerialSequence(client, "blur_masks");
}

async function dropProjectsLegacyIdColumnIfExists(client) {
  if (await columnExists(client, "projects", "legacy_id")) {
    await client.query("DROP INDEX IF EXISTS idx_projects_legacy_id");
    await client.query("ALTER TABLE projects DROP COLUMN legacy_id");
  }
}

async function migrateUserIdsToVarchar(client) {
  await client.query("ALTER TABLE layouts DROP CONSTRAINT IF EXISTS layouts_created_by_fkey");
  await client.query("ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_created_by_fkey");

  const usersIdType = await getColumnType(client, "users", "id");
  if (usersIdType && usersIdType !== "character varying" && usersIdType !== "text") {
    await client.query("ALTER TABLE users ALTER COLUMN id DROP DEFAULT");
    await client.query(
      `ALTER TABLE users
          ALTER COLUMN id TYPE VARCHAR(20)
          USING ('ADM-' || LPAD(id::text, 3, '0'))`
    );
  }

  const layoutsCreatedByType = await getColumnType(client, "layouts", "created_by");
  if (layoutsCreatedByType && layoutsCreatedByType !== "character varying" && layoutsCreatedByType !== "text") {
    await client.query(
      `ALTER TABLE layouts
          ALTER COLUMN created_by TYPE VARCHAR(20)
          USING ('ADM-' || LPAD(created_by::text, 3, '0'))`
    );
  } else {
    await client.query(
      `ALTER TABLE layouts
          ALTER COLUMN created_by TYPE VARCHAR(20)
          USING created_by::varchar(20)`
    );
  }

  const auditCreatedByType = await getColumnType(client, "audit_logs", "created_by");
  if (auditCreatedByType && auditCreatedByType !== "character varying" && auditCreatedByType !== "text") {
    await client.query(
      `ALTER TABLE audit_logs
          ALTER COLUMN created_by TYPE VARCHAR(20)
          USING ('ADM-' || LPAD(created_by::text, 3, '0'))`
    );
  } else {
    await client.query(
      `ALTER TABLE audit_logs
          ALTER COLUMN created_by TYPE VARCHAR(20)
          USING created_by::varchar(20)`
    );
  }

  const users = await client.query("SELECT id FROM users ORDER BY created_at ASC NULLS LAST, id ASC");
  for (const row of users.rows) {
    const oldId = String(row.id || "").trim();
    const newId = formatUserId(oldId);
    if (!oldId || !newId || oldId === newId) continue;
    await client.query("UPDATE layouts SET created_by = $1 WHERE created_by = $2", [newId, oldId]);
    await client.query("UPDATE audit_logs SET created_by = $1 WHERE created_by = $2", [newId, oldId]);
    await client.query("UPDATE users SET id = $1 WHERE id = $2", [newId, oldId]);
  }

  await client.query(
    `ALTER TABLE layouts
        ADD CONSTRAINT layouts_created_by_fkey
        FOREIGN KEY (created_by) REFERENCES users(id)`
  );
  await client.query(
    `ALTER TABLE audit_logs
        ADD CONSTRAINT audit_logs_created_by_fkey
        FOREIGN KEY (created_by) REFERENCES users(id)`
  );
}

async function main() {
  const schemaPath = path.join(__dirname, "..", "db", "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  const statements = splitSql(sql);

  await ensureDatabaseExists();

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const statement of statements) {
      await client.query(statement);
    }
    await dropProjectsLegacyIdColumnIfExists(client);
    await recreatePanoramaHotspotsTable(client);
    await recreateLayoutHotspotsTable(client);
    await recreateBlurMasksTable(client);
    await migrateUserIdsToVarchar(client);
    await client.query("COMMIT");
    console.log(`OK: created/verified ${statements.length} statements from db/schema.sql`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

main().catch((err) => {
  console.error("DB init failed:", err);
  process.exitCode = 1;
}).finally(async () => {
  await getPool().end();
});
