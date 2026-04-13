const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const appEnvPath = path.join(__dirname, '..', '.env');
const repoEnvPath = path.join(__dirname, '..', '..', '.env');
dotenv.config({ path: fs.existsSync(appEnvPath) ? appEnvPath : repoEnvPath });

const { getPool } = require('./pool');
const { ensureBootstrapSuperAdmin } = require('./users');
const { syncAllProjects } = require('./project-sync');

async function main() {
  const bootstrapUser = await ensureBootstrapSuperAdmin();
  const summaries = await syncAllProjects({ createdByUserId: bootstrapUser.id });

  if (summaries.length === 0) {
    console.log('OK: no legacy projects were found to migrate.');
    return;
  }

  summaries.forEach((summary) => {
    console.log(
      `OK: migrated ${summary.projectNumber} (${summary.projectName}) ` +
      `[panoramas=${summary.panoramas}, layouts=${summary.layouts}, audit=${summary.auditEntries}]`
    );
  });
}

main()
  .catch((error) => {
    console.error('Data migration failed:', error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await getPool().end();
  });
