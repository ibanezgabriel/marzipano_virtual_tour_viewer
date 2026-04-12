require('dotenv').config();

const { ensureBootstrapSuperAdmin } = require('./users');
const { getPool } = require('./pool');

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
