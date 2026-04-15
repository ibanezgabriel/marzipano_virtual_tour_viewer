/* Creates the shared database connection pool. */
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const appEnvPath = path.join(__dirname, '..', '.env');
const repoEnvPath = path.join(__dirname, '..', '..', '.env');
dotenv.config({ path: fs.existsSync(appEnvPath) ? appEnvPath : repoEnvPath });

let pool;

/* Sets up create pool. */
function createPool() {
  const rawPassword = process.env.DATABASE_URL ? undefined : process.env.PGPASSWORD;
  const password = rawPassword === undefined ? undefined : String(rawPassword);

  return new Pool({
    connectionString: process.env.DATABASE_URL || undefined,
    host: process.env.DATABASE_URL ? undefined : process.env.PGHOST,
    port: process.env.DATABASE_URL ? undefined : (process.env.PGPORT ? Number(process.env.PGPORT) : undefined),
    user: process.env.DATABASE_URL ? undefined : process.env.PGUSER,
    password,
    database: process.env.DATABASE_URL ? undefined : process.env.PGDATABASE,
  });
}

/* Gets get pool. */
function getPool() {
  if (!pool) {
    pool = createPool();
  }
  return pool;
}

/* Handles query. */
async function query(text, params) {
  return getPool().query(text, params);
}

module.exports = {
  getPool,
  query,
};
