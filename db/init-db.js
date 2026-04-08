const fs = require("fs");
const path = require("path");
require("dotenv").config();
const { getPool } = require("./pool");
const { formatUserId } = require("./users");

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

  const client = await getPool().connect();
  try {
    for (const statement of statements) {
      await client.query(statement);
    }
    await migrateUserIdsToVarchar(client);
    console.log(`OK: created/verified ${statements.length} statements from db/schema.sql`);
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
