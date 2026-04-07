const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
require("dotenv").config();

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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || undefined,
  host: process.env.DATABASE_URL ? undefined : process.env.PGHOST,
  port: process.env.DATABASE_URL ? undefined : (process.env.PGPORT ? Number(process.env.PGPORT) : undefined),
  user: process.env.DATABASE_URL ? undefined : process.env.PGUSER,
  password: process.env.DATABASE_URL ? undefined : process.env.PGPASSWORD,
  database: process.env.DATABASE_URL ? undefined : process.env.PGDATABASE,
});

async function main() {
  const schemaPath = path.join(__dirname, "..", "db", "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  const statements = splitSql(sql);

  const client = await pool.connect();
  try {
    for (const statement of statements) {
      await client.query(statement);
    }
    console.log(`OK: created/verified ${statements.length} statements from db/schema.sql`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("DB init failed:", err);
  process.exitCode = 1;
});
