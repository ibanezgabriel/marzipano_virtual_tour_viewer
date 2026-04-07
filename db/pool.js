const { Pool } = require('pg');
require('dotenv').config();

let pool;

function createPool() {
  return new Pool({
    connectionString: process.env.DATABASE_URL || undefined,
    host: process.env.DATABASE_URL ? undefined : process.env.PGHOST,
    port: process.env.DATABASE_URL ? undefined : (process.env.PGPORT ? Number(process.env.PGPORT) : undefined),
    user: process.env.DATABASE_URL ? undefined : process.env.PGUSER,
    password: process.env.DATABASE_URL ? undefined : process.env.PGPASSWORD,
    database: process.env.DATABASE_URL ? undefined : process.env.PGDATABASE,
  });
}

function getPool() {
  if (!pool) {
    pool = createPool();
  }
  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

module.exports = {
  getPool,
  query,
};
