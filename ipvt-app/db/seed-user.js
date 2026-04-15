/* Seeds a default user account for local setup. */
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const appEnvPath = path.join(__dirname, '..', '.env');
const repoEnvPath = path.join(__dirname, '..', '..', '.env');
dotenv.config({ path: fs.existsSync(appEnvPath) ? appEnvPath : repoEnvPath });

const { ensureBootstrapSuperAdmin } = require('./users');
const { getPool } = require('./pool');

/* Handles main. */
async function main() {
  const superAdmin = await ensureBootstrapSuperAdmin();
  console.log(`OK: bootstrap super admin is ready (${superAdmin.username})`);
}

main()
  .catch((error) => {
    console.error('User seed failed:', error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await getPool().end();
  });
