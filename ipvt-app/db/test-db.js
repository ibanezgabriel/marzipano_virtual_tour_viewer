/* Runs a quick database connectivity check. */
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const appEnvPath = path.join(__dirname, '..', '.env');
const repoEnvPath = path.join(__dirname, '..', '..', '.env');
dotenv.config({ path: fs.existsSync(appEnvPath) ? appEnvPath : repoEnvPath });

const { getPool } = require('./pool');

/* Handles main. */
async function main() {
  const result = await getPool().query(
    `SELECT
       current_database() AS database_name,
       current_user AS database_user,
       NOW() AS server_time`
  );
  const row = result.rows[0] || {};
  console.log(`OK: connected to ${row.database_name} as ${row.database_user}`);
  console.log(`Server time: ${row.server_time}`);
}

main()
  .catch((error) => {
    console.error('DB connectivity test failed:', error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await getPool().end();
  });
