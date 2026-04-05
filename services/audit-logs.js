function createAuditLogsService({ db }) {
  // Ensure audit logs can store project name/number snapshots.
  async function ensureAuditLogSnapshotColumns() {
    try {
      await db.query('ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS project_number VARCHAR(50)');
      await db.query('ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS project_name VARCHAR(255)');
    } catch (e) {
      // Ignore if migrations aren't applied yet (table missing) or permissions prevent ALTER.
      if (e && e.code === '42P01') return;
      console.warn('[audit_logs] unable to ensure snapshot columns:', e.message || e);
    }
  }

  let auditLogsDbDisabled = false;

  /**
   * Persists an audit log event to PostgreSQL.
   *
   * Notes:
   * - This function is designed to be safe even if migrations haven't been applied yet.
   *   If the `audit_logs` table doesn't exist, DB audit logging is disabled to avoid
   *   spamming the console on every request.
   *
   * @param {object} [params]
   * @param {string|null} [params.projectId] - associated project id (if any)
   * @param {string|null} [params.projectNumber] - project number snapshot (optional)
   * @param {string|null} [params.projectName] - project name snapshot (optional)
   * @param {number|null} [params.userId] - actor user id (if any)
   * @param {string} params.action - short action key, e.g. "project.create"
   * @param {string|null} [params.message] - human-readable description
   * @param {object} [params.metadata] - additional structured data stored as JSONB
   * @param {Date|string|number|null} [params.createdAt] - timestamp override (defaults to now)
   * @returns {Promise<void>}
   */
  async function insertAuditLog({ projectId, projectNumber, projectName, userId, action, message, metadata, createdAt } = {}) {
    if (auditLogsDbDisabled) return;
    if (!action) return;
    try {
      const created = createdAt ? new Date(createdAt) : new Date();
      const projectIdValue = projectId === undefined || projectId === null ? null : String(projectId);

      let projectNumberValue = projectNumber === undefined || projectNumber === null ? null : String(projectNumber);
      let projectNameValue = projectName === undefined || projectName === null ? null : String(projectName);

      // If callers didn't provide a snapshot, best-effort lookup from the current projects table.
      if (projectIdValue && (!projectNumberValue || !projectNameValue)) {
        try {
          const projRes = await db.query('SELECT number, name FROM projects WHERE id = $1', [projectIdValue]);
          const proj = projRes.rows[0] || null;
          if (proj) {
            if (!projectNumberValue && proj.number) projectNumberValue = String(proj.number);
            if (!projectNameValue && proj.name) projectNameValue = String(proj.name);
          }
        } catch (e) {
          // ignore lookup failures (audit log still records action/message)
        }
      }

      const metadataJson = JSON.stringify(metadata && typeof metadata === 'object' ? metadata : {});

      await db.query(
        `INSERT INTO audit_logs (project_id, project_number, project_name, user_id, action, message, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [projectIdValue, projectNumberValue, projectNameValue, userId ? Number(userId) : null, String(action), message ? String(message) : null, metadataJson, created]
      );
    } catch (e) {
      // If schema migration hasn't been applied yet, avoid spamming errors on every request.
      if (e && (e.code === '42P01' || /audit_logs/i.test(String(e.message || '')))) {
        auditLogsDbDisabled = true;
        console.warn('[audit_logs] table not available; DB audit logging disabled until migrated.');
        return;
      }
      // If snapshot columns aren't present yet, fall back to the legacy insert.
      if (e && e.code === '42703') {
        try {
          const created = createdAt ? new Date(createdAt) : new Date();
          const projectIdValue = projectId === undefined || projectId === null ? null : String(projectId);
          await db.query(
            `INSERT INTO audit_logs (project_id, user_id, action, message, metadata, created_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
            [
              projectIdValue,
              userId ? Number(userId) : null,
              String(action),
              message ? String(message) : null,
              JSON.stringify(metadata && typeof metadata === 'object' ? metadata : {}),
              created,
            ]
          );
          return;
        } catch (inner) {
          console.warn('[audit_logs] legacy insert failed:', inner.message || inner);
          return;
        }
      }
      console.warn('[audit_logs] insert failed:', e.message || e);
    }
  }

  async function listAuditLogs({ q, limit, offset }) {
    const where = [];
    const params = [];
    const add = (val) => {
      params.push(val);
      return `$${params.length}`;
    };

    // Exclude micro-actions from the Super Admin audit view.
    // (These can be very noisy and aren't meaningful for oversight.)
    where.push(
      `NOT (
        a.action ILIKE ${add('%hotspots%')}
        OR a.action ILIKE ${add('%blur%')}
        OR a.action ILIKE ${add('%initial-view%')}
      )`
    );

    if (q) {
      const like = `%${q}%`;
      const p = add(like);
      where.push(`(
        a.action ILIKE ${p}
        OR a.message ILIKE ${p}
        OR COALESCE(u.username, '') ILIKE ${p}
        OR COALESCE(a.project_name, pj.name, '') ILIKE ${p}
        OR COALESCE(a.project_number, pj.number, '') ILIKE ${p}
      )`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countRes = await db.query(
      `SELECT COUNT(*)::int AS total
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN projects pj ON pj.id = a.project_id
       ${whereSql}`,
      params
    );

    const rowsRes = await db.query(
      `SELECT
         a.id,
         a.created_at,
         a.action,
         a.message,
         a.project_id,
         COALESCE(a.project_number, pj.number) AS project_number,
         COALESCE(a.project_name, pj.name) AS project_name,
         u.username AS created_by
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN projects pj ON pj.id = a.project_id
       ${whereSql}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ${add(limit)} OFFSET ${add(offset)}`,
      params
    );

    return { total: countRes.rows[0]?.total ?? 0, rows: rowsRes.rows };
  }

  return {
    ensureAuditLogSnapshotColumns,
    insertAuditLog,
    listAuditLogs,
  };
}

module.exports = createAuditLogsService;

