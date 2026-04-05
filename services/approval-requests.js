function createApprovalRequestsService({ db, normalizeProjectStatus, insertAuditLog, emitProjectsChanged }) {
  // Ensure approval requests can be used as a notification source for admins.
  let approvalRequestsNotificationsSupported = null;

  function normalizeUsername(value) {
    const v = String(value || '').trim();
    return v || 'Unknown';
  }

  const SESSION_ACTION_CODE_ORDER = [
    'PROJECT_CREATE',
    'PROJECT_UPDATE',
    'PANO_UPLOAD',
    'PANO_RENAME',
    'PANO_UPDATE',
    'LAYOUT_UPLOAD',
    'LAYOUT_RENAME',
    'LAYOUT_UPDATE',
    'HOTSPOT_ADD',
    'HOTSPOT_REMOVE',
    'BLUR_APPLY',
    'BLUR_REMOVE',
    'VIEW_SET',
  ];
  const SESSION_ACTION_CODE_SET = new Set(SESSION_ACTION_CODE_ORDER);

  function normalizeSessionActionCode(action) {
    const raw = String(action || '').trim();
    if (!raw) return null;
    if (SESSION_ACTION_CODE_SET.has(raw)) return raw;

    // Backward compatibility for older audit action keys.
    if (raw === 'project:create') return 'PROJECT_CREATE';
    if (raw.startsWith('project:')) return 'PROJECT_UPDATE';

    if (raw === 'archive:pano:upload') return 'PANO_UPLOAD';
    if (raw === 'archive:pano:rename') return 'PANO_RENAME';
    if (raw === 'archive:pano:update') return 'PANO_UPDATE';

    if (raw === 'archive:floorplan:upload') return 'LAYOUT_UPLOAD';
    if (raw === 'archive:floorplan:rename') return 'LAYOUT_RENAME';
    if (raw === 'archive:floorplan:update') return 'LAYOUT_UPDATE';

    // Backward compatibility for legacy approval-request action codes.
    if (
      raw === 'PROJECT_RENAME' ||
      raw === 'PROJECT_ID_UPDATE' ||
      raw === 'PROJECT_STATUS_CHANGE' ||
      raw === 'PROJECT_INFO_UPDATE'
    ) {
      return 'PROJECT_UPDATE';
    }

    return null;
  }

  function sortSessionActionCodes(codes) {
    const unique = Array.from(new Set((codes || []).filter(Boolean)));
    unique.sort((a, b) => {
      const ia = SESSION_ACTION_CODE_ORDER.indexOf(a);
      const ib = SESSION_ACTION_CODE_ORDER.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
    return unique;
  }

  function applyActionCodeSpecificityRules(codes) {
    const sorted = sortSessionActionCodes((codes || []).filter(Boolean));
    const hasSpecific = sorted.some((code) => !String(code || '').startsWith('PROJECT_'));
    if (!hasSpecific) return sorted;
    return sorted.filter((code) => code !== 'PROJECT_UPDATE');
  }

  async function ensureApprovalRequestNotificationColumns() {
    try {
      await db.query('ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS decided_at TIMESTAMP');
      await db.query('ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS decided_by INTEGER REFERENCES users(id)');
      await db.query('ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS requester_seen_at TIMESTAMP');
      approvalRequestsNotificationsSupported = true;
    } catch (e) {
      // Ignore if migrations aren't applied yet (table missing) or permissions prevent ALTER.
      if (e && e.code === '42P01') return;
      console.warn('[approval_requests] unable to ensure notification columns:', e.message || e);
    }
  }

  async function supportsApprovalRequestNotifications() {
    if (approvalRequestsNotificationsSupported !== null) return approvalRequestsNotificationsSupported;
    try {
      const result = await db.query(
        `SELECT COUNT(*)::int AS cols
         FROM information_schema.columns
         WHERE table_name = 'approval_requests'
           AND column_name IN ('decided_at', 'decided_by', 'requester_seen_at')`
      );
      approvalRequestsNotificationsSupported = (result.rows[0]?.cols ?? 0) >= 3;
    } catch (e) {
      approvalRequestsNotificationsSupported = false;
    }
    return approvalRequestsNotificationsSupported;
  }

  function normalizeApprovalStatus(value) {
    const v = String(value || '').trim().toUpperCase();
    if (v === 'APPROVED') return 'APPROVED';
    if (v === 'REJECTED') return 'REJECTED';
    return 'PENDING';
  }

  function normalizeWorkflowState(value) {
    const v = String(value || '').trim().toUpperCase();
    if (v === 'PUBLISHED') return 'PUBLISHED';
    if (v === 'PENDING_APPROVAL') return 'PENDING_APPROVAL';
    if (v === 'MODIFIED') return 'MODIFIED';
    if (v === 'REJECTED') return 'REJECTED';
    return 'DRAFT';
  }

  function extractProjectInfoChangeSetFromBody(body) {
    if (!body || typeof body !== 'object') return null;
    const changes = body.changes && typeof body.changes === 'object' ? body.changes : null;
    if (!changes) return null;

    const previous =
      changes.previous && typeof changes.previous === 'object'
        ? changes.previous
        : changes.prev && typeof changes.prev === 'object'
          ? changes.prev
          : changes.old && typeof changes.old === 'object'
            ? changes.old
            : changes.from && typeof changes.from === 'object'
              ? changes.from
              : null;

    const next =
      changes.next && typeof changes.next === 'object'
        ? changes.next
        : changes.new && typeof changes.new === 'object'
          ? changes.new
          : changes.to && typeof changes.to === 'object'
            ? changes.to
            : null;

    if (previous && next) return { previous, next };

    // Support: { changes: { name: { from, to }, number: { from, to }, status: { from, to } } }
    const name = changes.name && typeof changes.name === 'object' ? changes.name : null;
    const number = changes.number && typeof changes.number === 'object' ? changes.number : null;
    const status = changes.status && typeof changes.status === 'object' ? changes.status : null;

    if (!name && !number && !status) return null;

    return {
      previous: {
        name: name ? name.from : undefined,
        number: number ? number.from : undefined,
        status: status ? status.from : undefined,
      },
      next: {
        name: name ? name.to : undefined,
        number: number ? number.to : undefined,
        status: status ? status.to : undefined,
      },
    };
  }

  function computeProjectInfoChangeSummary(changeSet) {
    if (!changeSet || typeof changeSet !== 'object') return null;
    const previous = changeSet.previous && typeof changeSet.previous === 'object' ? changeSet.previous : null;
    const next = changeSet.next && typeof changeSet.next === 'object' ? changeSet.next : null;
    if (!previous || !next) return null;

    const prevNameKnown = previous.name !== undefined || next.name !== undefined;
    const prevNumberKnown = previous.number !== undefined || next.number !== undefined;
    const prevStatusKnown = previous.status !== undefined || next.status !== undefined;

    const prevName = prevNameKnown ? String(previous.name ?? '').trim() : '';
    const nextName = prevNameKnown ? String(next.name ?? '').trim() : '';
    const prevNumber = prevNumberKnown ? String(previous.number ?? '').trim() : '';
    const nextNumber = prevNumberKnown ? String(next.number ?? '').trim() : '';
    const prevStatus = prevStatusKnown ? normalizeProjectStatus(previous.status ?? '') : '';
    const nextStatus = prevStatusKnown ? normalizeProjectStatus(next.status ?? '') : '';

    const nameChanged = prevNameKnown && prevName !== nextName;
    const numberChanged = prevNumberKnown && prevNumber !== nextNumber;
    const statusChanged = prevStatusKnown && prevStatus !== nextStatus;
    const changedCount = (nameChanged ? 1 : 0) + (numberChanged ? 1 : 0) + (statusChanged ? 1 : 0);
    if (changedCount === 0) return null;

    const actionCode = 'PROJECT_UPDATE';

    const infoParts = [];
    if (nameChanged) infoParts.push(`Requested name change from '${prevName}' to '${nextName}'`);
    if (numberChanged) infoParts.push(`Requested project number change from '${prevNumber}' to '${nextNumber}'`);
    if (statusChanged) infoParts.push(`Requested status change from '${prevStatus}' to '${nextStatus}'`);

    return {
      action_code: actionCode,
      information: infoParts.join('; '),
    };
  }

  function pickProjectInfoFields(value) {
    const v = value && typeof value === 'object' ? value : {};
    return {
      name: v.name ?? null,
      number: v.number ?? null,
      status: v.status ?? null,
    };
  }

  async function inferProjectInfoChangeSetFromAudit({ projectId, userId }) {
    if (!projectId || userId === undefined || userId === null) return null;
    try {
      const result = await db.query(
        `SELECT metadata
         FROM audit_logs
         WHERE project_id = $1
           AND user_id = $2
           AND action IN (
             'project:update',
             'project:rename',
             'project:name',
             'project:number',
             'project:status',
             'PROJECT_UPDATE'
           )
           AND metadata IS NOT NULL
           AND metadata ? 'old'
           AND metadata ? 'new'
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [String(projectId), Number(userId)]
      );
      const metadata = result.rows[0] && result.rows[0].metadata ? result.rows[0].metadata : null;
      if (!metadata || typeof metadata !== 'object') return null;
      if (!metadata.old || !metadata.new) return null;
      return { previous: metadata.old, next: metadata.new };
    } catch (e) {
      if (e && e.code === '42P01') return null;
      return null;
    }
  }

  async function inferSessionStartAt({ projectId, projectCreatedAt }) {
    const fallback = projectCreatedAt ? new Date(projectCreatedAt) : null;
    if (!projectId) return fallback;
    try {
      const result = await db.query(
        `SELECT created_at
         FROM audit_logs
         WHERE project_id = $1
           AND action IN ('REQ_APPROVED', 'REQ_REJECTED')
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [String(projectId)]
      );
      const createdAt = result.rows[0] && result.rows[0].created_at ? new Date(result.rows[0].created_at) : null;
      if (createdAt && Number.isFinite(createdAt.getTime())) return createdAt;
    } catch (e) {
      if (e && e.code === '42P01') return fallback;
    }
    return fallback;
  }

  async function inferSessionActionCodesFromAudit({ projectId, userId, startAt }) {
    if (!projectId || userId === undefined || userId === null) return [];
    const since = startAt && Number.isFinite(new Date(startAt).getTime()) ? new Date(startAt) : new Date(0);
    try {
      const result = await db.query(
        `SELECT DISTINCT action
         FROM audit_logs
         WHERE project_id = $1
           AND user_id = $2
           AND created_at >= $3`,
        [String(projectId), Number(userId), since]
      );

      const codes = new Set();
      (result.rows || []).forEach((row) => {
        const normalized = normalizeSessionActionCode(row && row.action);
        if (normalized) codes.add(normalized);
      });
      return sortSessionActionCodes(Array.from(codes));
    } catch (e) {
      if (e && e.code === '42P01') return [];
      return [];
    }
  }

  async function inferSessionInfoMessagesFromAudit({ projectId, userId, startAt, limit = 6 }) {
    if (!projectId || userId === undefined || userId === null) return [];
    const since = startAt && Number.isFinite(new Date(startAt).getTime()) ? new Date(startAt) : new Date(0);
    try {
      // Keep the approval request "Information" column focused on tangible assets/features,
      // not redundant project metadata changes (those are handled by the explicit changeSet summary).
      const actions = SESSION_ACTION_CODE_ORDER.filter((code) => !String(code).startsWith('PROJECT_'));
      const result = await db.query(
        `SELECT action, message
         FROM audit_logs
         WHERE project_id = $1
           AND user_id = $2
           AND created_at >= $3
           AND action = ANY($4::text[])
         ORDER BY created_at DESC, id DESC
         LIMIT 60`,
        [String(projectId), Number(userId), since, actions]
      );
      const rows = Array.isArray(result.rows) ? result.rows : [];
      const messages = [];
      for (const row of rows) {
        const msg = row && row.message ? String(row.message).trim() : '';
        if (!msg) continue;
        if (messages.includes(msg)) continue;
        messages.push(msg);
        if (messages.length >= Math.max(0, Number(limit) || 0)) break;
      }
      return messages;
    } catch (e) {
      if (e && e.code === '42P01') return [];
      return [];
    }
  }

  async function listApprovalRequests({ q, status, limit, offset }) {
    const where = [];
    const params = [];
    const add = (val) => {
      params.push(val);
      return `$${params.length}`;
    };

    if (status) {
      where.push(`ar.status = ${add(status)}`);
    }

    if (q) {
      const like = `%${q}%`;
      const p = add(like);
      where.push(`(
        ar.request_type ILIKE ${p}
        OR COALESCE(u.username, '') ILIKE ${p}
        OR COALESCE(pj.name, '') ILIKE ${p}
        OR COALESCE(pj.number, '') ILIKE ${p}
        OR COALESCE(ar.admin_comment, '') ILIKE ${p}
      )`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countRes = await db.query(
      `SELECT COUNT(*)::int AS total
       FROM approval_requests ar
       LEFT JOIN users u ON u.id = ar.requester_id
       LEFT JOIN projects pj ON pj.id = ar.project_id
       ${whereSql}`,
      params
    );

    const rowsRes = await db.query(
      `SELECT
         ar.id,
         ar.created_at,
         ar.project_id,
         pj.number AS project_number,
         pj.name AS project_name,
         ar.request_type,
         ar.status,
         ar.admin_comment,
         ar.payload,
         u.username AS requested_by
       FROM approval_requests ar
       LEFT JOIN users u ON u.id = ar.requester_id
       LEFT JOIN projects pj ON pj.id = ar.project_id
       ${whereSql}
       ORDER BY ar.created_at DESC, ar.id DESC
       LIMIT ${add(limit)} OFFSET ${add(offset)}`,
      params
    );

    const rows = (rowsRes.rows || []).map((row) => {
      const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : null;
      const persistedSummary =
        payload &&
        payload.summary &&
        typeof payload.summary === 'object' &&
        (payload.summary.action_code || payload.summary.action_codes || payload.summary.information)
          ? payload.summary
          : null;

      const computedSummary = payload ? computeProjectInfoChangeSummary(payload.changes) : null;
      const summary = persistedSummary || computedSummary;

      const out = { ...row };
      delete out.payload;
      if (summary) {
        if (Array.isArray(summary.action_codes) && summary.action_codes.length > 0) {
          const normalized = summary.action_codes.map((code) => normalizeSessionActionCode(code)).filter(Boolean);
          if (normalized.length > 0) {
            out.action_code = applyActionCodeSpecificityRules(normalized).join(', ');
          } else if (summary.action_code) {
            out.action_code = String(summary.action_code);
          }
        } else if (summary.action_code) {
          const raw = String(summary.action_code);
          const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
          const normalized = parts.map((p) => normalizeSessionActionCode(p)).filter(Boolean);
          out.action_code = normalized.length > 0 ? applyActionCodeSpecificityRules(normalized).join(', ') : raw;
        }
        if (summary.information) out.information = String(summary.information);
      }
      return out;
    });

    return { total: countRes.rows[0]?.total ?? 0, rows };
  }

  async function createApprovalRequest({ projectId, body, sessionUserId, sessionUsername }) {
    const projRes = await db.query('SELECT * FROM projects WHERE id = $1', [projectId]);
    const project = projRes.rows[0];
    if (!project) return { ok: false, status: 404, json: { success: false, message: 'Project not found' } };

    const currentState = normalizeWorkflowState(project.workflow_state);
    if (currentState === 'PUBLISHED') {
      return {
        ok: false,
        status: 400,
        json: { success: false, message: 'Project is already published. Make changes first to request approval again.' },
      };
    }
    if (currentState === 'PENDING_APPROVAL') {
      return { ok: false, status: 400, json: { success: false, message: 'Project is already pending approval.' } };
    }

    const pendingRes = await db.query(
      'SELECT 1 FROM approval_requests WHERE project_id = $1 AND status = $2 LIMIT 1',
      [projectId, 'PENDING']
    );
    if (pendingRes.rows.length > 0) {
      return {
        ok: false,
        status: 400,
        json: { success: false, message: 'There is already a pending approval request for this project.' },
      };
    }

    const payload = {
      project: {
        id: project.id,
        name: project.name,
        number: project.number,
        status: project.status,
        workflow_state: currentState,
      },
      submitted_at: new Date().toISOString(),
    };

    const bodyChangeSet = extractProjectInfoChangeSetFromBody(body);
    const inferredChangeSet = bodyChangeSet ? null : await inferProjectInfoChangeSetFromAudit({ projectId, userId: sessionUserId });
    const effectiveChangeSet = bodyChangeSet || inferredChangeSet;
    if (effectiveChangeSet) {
      payload.changes = {
        previous: pickProjectInfoFields(effectiveChangeSet.previous),
        next: pickProjectInfoFields(effectiveChangeSet.next),
      };
    }

    const summaryParts = [];
    const projectInfoSummary = payload.changes ? computeProjectInfoChangeSummary(payload.changes) : null;
    if (projectInfoSummary && projectInfoSummary.information) {
      summaryParts.push(String(projectInfoSummary.information));
    }

    const sessionStartAt = await inferSessionStartAt({ projectId, projectCreatedAt: project.created_at });
    const sessionActionCodes = await inferSessionActionCodesFromAudit({
      projectId,
      userId: sessionUserId,
      startAt: sessionStartAt,
    });
    const sessionMessages = await inferSessionInfoMessagesFromAudit({
      projectId,
      userId: sessionUserId,
      startAt: sessionStartAt,
      limit: 8,
    });
    sessionMessages.forEach((m) => {
      if (!m) return;
      if (summaryParts.includes(m)) return;
      summaryParts.push(m);
    });

    const actionCodes = new Set(sessionActionCodes);
    if (projectInfoSummary && projectInfoSummary.action_code) {
      actionCodes.add(String(projectInfoSummary.action_code));
    }
    const finalCodes = applyActionCodeSpecificityRules(Array.from(actionCodes));

    if (finalCodes.length > 0 || summaryParts.length > 0) {
      payload.summary = {
        action_codes: finalCodes,
        action_code: finalCodes.join(', '),
        information: summaryParts.join('; '),
      };
    }

    const insertRes = await db.query(
      `INSERT INTO approval_requests (requester_id, project_id, request_type, payload, status)
       VALUES ($1, $2, $3, $4::jsonb, 'PENDING')
       RETURNING id, created_at, project_id, request_type, status`,
      [sessionUserId, projectId, 'project:publish', JSON.stringify(payload)]
    );

    await db.query("UPDATE projects SET workflow_state = 'PENDING_APPROVAL' WHERE id = $1", [projectId]);
    await emitProjectsChanged();

    try {
      const adminName = normalizeUsername(sessionUsername);
      await insertAuditLog({
        projectId,
        userId: sessionUserId,
        action: 'REQ_SUBMITTED',
        message: `Admin ${adminName} requested approval for ${project.name}`,
        metadata: { requestId: insertRes.rows[0]?.id, request_type: 'project:publish' },
      });
    } catch (e) {}

    return { ok: true, json: { success: true, request: insertRes.rows[0] } };
  }

  async function decideApproval({ id, decision, commentValue, sessionUserId, sessionUsername }) {
    try {
      const reqRes = await db.query('SELECT * FROM approval_requests WHERE id = $1', [id]);
      const request = reqRes.rows[0];
      if (!request) return { ok: false, status: 404, json: { success: false, message: 'Request not found' } };
      if (String(request.status || '').toUpperCase() !== 'PENDING') {
        return { ok: false, status: 400, json: { success: false, message: 'Request is not pending.' } };
      }

      const projectId = request.project_id ? String(request.project_id) : null;
      if (!projectId) return { ok: false, status: 400, json: { success: false, message: 'Request is missing project_id.' } };

      const nextStatus = decision === 'APPROVED' ? 'APPROVED' : 'REJECTED';
      const nextWorkflow = decision === 'APPROVED' ? 'PUBLISHED' : 'REJECTED';
      const supportsNotifications = await supportsApprovalRequestNotifications();
      const decisionPatch = JSON.stringify({
        decided_at_ms: Date.now(),
        decided_by: sessionUsername ? String(sessionUsername) : null,
        decision: nextStatus,
        admin_comment: commentValue || null,
      });

      await db.query('BEGIN');
      if (supportsNotifications) {
        await db.query(
          `UPDATE approval_requests
           SET status = $1,
               admin_comment = $2,
               decided_at = NOW(),
               decided_by = $3,
               requester_seen_at = NULL,
               payload = COALESCE(payload, '{}'::jsonb) || $5::jsonb
           WHERE id = $4`,
          [nextStatus, commentValue || null, Number(sessionUserId) || null, id, decisionPatch]
        );
      } else {
        await db.query(
          `UPDATE approval_requests
           SET status = $1,
               admin_comment = $2,
               payload = COALESCE(payload, '{}'::jsonb) || $4::jsonb
           WHERE id = $3`,
          [nextStatus, commentValue || null, id, decisionPatch]
        );
      }
      await db.query('UPDATE projects SET workflow_state = $1 WHERE id = $2', [nextWorkflow, projectId]);
      await db.query('COMMIT');

      try {
        const actorName = normalizeUsername(sessionUsername);
        const payload = request.payload && typeof request.payload === 'object' ? request.payload : {};
        const projectName =
          payload && payload.project && payload.project.name
            ? String(payload.project.name)
            : payload && payload.project_name
              ? String(payload.project_name)
              : 'Unknown project';

        const trimmedReason = typeof commentValue === 'string' ? commentValue.trim() : '';
        const reason = trimmedReason || 'No reason specified';

        const action = decision === 'APPROVED' ? 'REQ_APPROVED' : 'REQ_REJECTED';
        const message =
          decision === 'APPROVED'
            ? `Super Admin ${actorName} approved request for ${projectName}`
            : `Super Admin ${actorName} rejected request for ${projectName}. Reason: ${reason}`;

        await insertAuditLog({
          projectId,
          userId: sessionUserId,
          action,
          message,
          metadata: { requestId: id, comment: trimmedReason || null },
        });
      } catch (e) {}

      try {
        await emitProjectsChanged();
      } catch (e) {}

      return { ok: true, json: { success: true } };
    } catch (e) {
      try { await db.query('ROLLBACK'); } catch (rollbackErr) {}
      throw e;
    }
  }

  return {
    ensureApprovalRequestNotificationColumns,
    supportsApprovalRequestNotifications,
    normalizeApprovalStatus,
    normalizeWorkflowState,
    extractProjectInfoChangeSetFromBody,
    computeProjectInfoChangeSummary,
    pickProjectInfoFields,
    inferProjectInfoChangeSetFromAudit,
    listApprovalRequests,
    createApprovalRequest,
    decideApproval,
  };
}

module.exports = createApprovalRequestsService;
