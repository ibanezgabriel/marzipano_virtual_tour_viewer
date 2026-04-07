const fs = require("fs");
const path = require("path");
require("dotenv").config();
const { getPool } = require("./pool");

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

async function main() {
  const schemaPath = path.join(__dirname, "..", "db", "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  const statements = splitSql(sql);

  const client = await getPool().connect();
  try {
    for (const statement of statements) {
      await client.query(statement);
    }
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
