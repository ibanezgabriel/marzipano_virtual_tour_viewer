function createDbBootstrapService({ db }) {
  // Ensure the DB has the columns required to enforce "one active session per account".
  // (Safe to run repeatedly; uses IF NOT EXISTS.)
  async function ensureSingleSessionColumns() {
    try {
      await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS active_session_id VARCHAR(255)');
      await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS active_session_expires_at TIMESTAMP');
      await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE');
      await db.query('UPDATE users SET is_active = TRUE WHERE is_active IS NULL');
    } catch (e) {
      console.warn('[users] unable to ensure single-session columns:', e.message || e);
    }
  }

  // Ensure the DB has the columns required for the request/approve workflow state machine.
  async function ensureProjectWorkflowColumns() {
    try {
      await db.query("ALTER TABLE projects ADD COLUMN IF NOT EXISTS workflow_state VARCHAR(30) NOT NULL DEFAULT 'DRAFT'");
    } catch (e) {
      console.warn('[projects] unable to ensure workflow columns:', e.message || e);
    }
  }

  // Keep the on-disk project folder name decoupled from the project id so
  // renaming a project (display name) can also rename its folder without
  // rewriting primary keys / foreign keys.
  async function ensureProjectFolderColumns() {
    try {
      await db.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS folder_name VARCHAR(255)');
      await db.query("UPDATE projects SET folder_name = id WHERE folder_name IS NULL OR folder_name = ''");
    } catch (e) {
      console.warn('[projects] unable to ensure folder columns:', e.message || e);
    }
  }

  return {
    ensureSingleSessionColumns,
    ensureProjectWorkflowColumns,
    ensureProjectFolderColumns,
  };
}

module.exports = createDbBootstrapService;
