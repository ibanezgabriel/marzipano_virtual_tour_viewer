const fs = require('fs');

function createApprovalRequestsService({ db, projectsService, normalizeProjectStatus, insertAuditLog, emitProjectsChanged }) {
  // Ensure approval requests can be used as a notification source for admins.
  let approvalRequestsNotificationsSupported = null;

  function normalizeUsername(value) {
    const v = String(value || '').trim();
    return v || 'Unknown';
  }

  function createServiceError(status, message) {
    const error = new Error(message);
    error.status = Number(status) || 500;
    return error;
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
  const SESSION_ACTIVITY_GAP_MS = 1000;

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

  function isProjectActionCode(code) {
    return String(code || '').startsWith('PROJECT_');
  }

  function normalizeCreatedAt(value) {
    const date = value ? new Date(value) : null;
    if (!date || !Number.isFinite(date.getTime())) return null;
    return date;
  }

  function normalizeInformationText(value) {
    const text = String(value || '').trim();
    return text || '';
  }

  function extractAssetNameFromMessage(actionCode, message, metadata) {
    const meta = metadata && typeof metadata === 'object' ? metadata : null;
    if (meta) {
      if (meta.asset_name) return String(meta.asset_name);
      if (meta.filename) return String(meta.filename);
    }

    const text = normalizeInformationText(message);
    if (!text) return null;

    let match = null;
    if (actionCode === 'PANO_RENAME' || actionCode === 'LAYOUT_RENAME') {
      match = text.match(/to "([^"]+)"\.?$/);
      return match ? String(match[1]) : null;
    }
    if (actionCode === 'PANO_UPDATE' || actionCode === 'LAYOUT_UPDATE') {
      match = text.match(/with "([^"]+)"\)\.?$/);
      return match ? String(match[1]) : null;
    }
    match = text.match(/ on ([^;]+)$/);
    return match ? String(match[1]).trim() : null;
  }

  function inferActionCodeFromInformation(message) {
    const text = normalizeInformationText(message);
    if (!text) return null;
    if (/^Requested name change from /i.test(text)) return 'PROJECT_UPDATE';
    if (/^Requested project number change from /i.test(text)) return 'PROJECT_UPDATE';
    if (/^Requested status change from /i.test(text)) return 'PROJECT_UPDATE';
    if (/^Panorama renamed from /i.test(text)) return 'PANO_RENAME';
    if (/^Panorama updated \(replaced /i.test(text)) return 'PANO_UPDATE';
    if (/^Panorama updated\.?$/i.test(text)) return 'PANO_UPDATE';
    if (/^Panorama uploaded\.?$/i.test(text)) return 'PANO_UPLOAD';
    if (/^Layout renamed from /i.test(text)) return 'LAYOUT_RENAME';
    if (/^Layout updated \(replaced /i.test(text)) return 'LAYOUT_UPDATE';
    if (/^Layout updated\.?$/i.test(text)) return 'LAYOUT_UPDATE';
    if (/^Layout uploaded\.?$/i.test(text)) return 'LAYOUT_UPLOAD';
    if (/^Hotspot added on /i.test(text)) return 'HOTSPOT_ADD';
    if (/^Hotspot removed on /i.test(text)) return 'HOTSPOT_REMOVE';
    if (/^Blur applied on /i.test(text)) return 'BLUR_APPLY';
    if (/^Blur removed on /i.test(text)) return 'BLUR_REMOVE';
    if (/^Initial view set on /i.test(text)) return 'VIEW_SET';
    return null;
  }

  function createSummaryEntry({ actionCode, message, assetName, createdAt, source }) {
    const normalizedActionCode = normalizeSessionActionCode(actionCode) || actionCode || null;
    const normalizedMessage = normalizeInformationText(message);
    if (!normalizedMessage) return null;
    const created = normalizeCreatedAt(createdAt);
    return {
      action_code: normalizedActionCode,
      message: normalizedMessage,
      asset_name: assetName ? String(assetName) : null,
      created_at_ms: created ? created.getTime() : null,
      source: source ? String(source) : 'audit',
    };
  }

  function buildSummaryEntryFromAuditRow(row) {
    const actionCode = normalizeSessionActionCode(row && row.action);
    const message = row && row.message ? String(row.message) : '';
    if (!actionCode || !message || isProjectActionCode(actionCode)) return null;
    return createSummaryEntry({
      actionCode,
      message,
      assetName: extractAssetNameFromMessage(actionCode, message, row && row.metadata),
      createdAt: row && row.created_at,
      source: 'audit',
    });
  }

  function dedupeSummaryEntries(entries) {
    const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
    const renameAssetKeys = new Set();
    list.forEach((entry) => {
      if (!entry || !entry.asset_name) return;
      if (entry.action_code === 'PANO_RENAME') renameAssetKeys.add(`pano:${entry.asset_name}`);
      if (entry.action_code === 'LAYOUT_RENAME') renameAssetKeys.add(`layout:${entry.asset_name}`);
    });

    const seen = new Set();
    const out = [];
    list.forEach((entry) => {
      if (!entry || !entry.message) return;
      const assetKey =
        entry.action_code === 'PANO_UPDATE' && entry.asset_name
          ? `pano:${entry.asset_name}`
          : entry.action_code === 'LAYOUT_UPDATE' && entry.asset_name
            ? `layout:${entry.asset_name}`
            : null;
      if (assetKey && renameAssetKeys.has(assetKey)) return;

      const dedupeKey = `${entry.action_code || ''}|${entry.asset_name || ''}|${entry.message}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      out.push(entry);
    });
    return out;
  }

  function filterSummaryEntriesByActionCodes(entries, actionCodes) {
    const allowed = new Set((actionCodes || []).filter(Boolean));
    const filtered = (entries || []).filter((entry) => {
      if (!entry || !entry.message) return false;
      if (!entry.action_code) return allowed.size === 0;
      return allowed.size === 0 ? true : allowed.has(entry.action_code);
    });
    return dedupeSummaryEntries(filtered);
  }

  function buildSummaryInformation(entries) {
    return (entries || [])
      .map((entry) => normalizeInformationText(entry && entry.message))
      .filter(Boolean)
      .join('; ');
  }

  function parseInformationSegments(value) {
    return String(value || '')
      .split('; ')
      .map((part) => part.trim())
      .filter(Boolean);
  }

  function getSummaryActionCodes(summary) {
    if (!summary || typeof summary !== 'object') return [];
    if (Array.isArray(summary.action_codes) && summary.action_codes.length > 0) {
      return applyActionCodeSpecificityRules(
        summary.action_codes.map((code) => normalizeSessionActionCode(code)).filter(Boolean)
      );
    }
    if (summary.action_code) {
      return applyActionCodeSpecificityRules(
        String(summary.action_code)
          .split(',')
          .map((part) => normalizeSessionActionCode(part))
          .filter(Boolean)
      );
    }
    return [];
  }

  function getStoredSummaryEntries(summary) {
    if (!summary || typeof summary !== 'object') return [];
    if (Array.isArray(summary.information_entries) && summary.information_entries.length > 0) {
      return summary.information_entries
        .map((entry) =>
          createSummaryEntry({
            actionCode: entry && entry.action_code ? entry.action_code : inferActionCodeFromInformation(entry && entry.message),
            message: entry && entry.message,
            assetName:
              entry && entry.asset_name
                ? entry.asset_name
                : extractAssetNameFromMessage(
                    entry && entry.action_code ? String(entry.action_code) : inferActionCodeFromInformation(entry && entry.message),
                    entry && entry.message,
                    null
                  ),
            createdAt: entry && entry.created_at_ms ? Number(entry.created_at_ms) : null,
            source: entry && entry.source ? entry.source : 'summary',
          })
        )
        .filter(Boolean);
    }

    return parseInformationSegments(summary.information).map((message) => {
      const actionCode = inferActionCodeFromInformation(message);
      return createSummaryEntry({
        actionCode,
        message,
        assetName: extractAssetNameFromMessage(actionCode, message, null),
        createdAt: null,
        source: 'summary',
      });
    }).filter(Boolean);
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

  async function applyApprovedProjectMetadataChange({ client, projectId, changeSet }) {
    const next = changeSet && typeof changeSet === 'object' && changeSet.next && typeof changeSet.next === 'object'
      ? changeSet.next
      : null;
    if (!next) {
      throw createServiceError(400, 'Approval request is missing project changes.');
    }

    const currentRes = await client.query('SELECT * FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
    const currentProject = currentRes.rows[0];
    if (!currentProject) {
      throw createServiceError(404, 'Project not found');
    }

    const trimmedName =
      next.name === undefined || next.name === null
        ? String(currentProject.name || '').trim()
        : String(next.name).trim();
    const trimmedNumber =
      next.number === undefined || next.number === null
        ? String(currentProject.number || '').trim()
        : String(next.number).trim();

    if (!trimmedNumber) {
      throw createServiceError(400, 'Project number is required');
    }
    if (!trimmedName) {
      throw createServiceError(400, 'Project name is required');
    }
    if (!/^[A-Za-z0-9-]+$/.test(trimmedNumber)) {
      throw createServiceError(400, 'Project number can only contain letters, numbers, and "-"');
    }
    if (
      projectsService &&
      Number.isFinite(Number(projectsService.MAX_PROJECT_NUMBER_LENGTH)) &&
      trimmedNumber.length > Number(projectsService.MAX_PROJECT_NUMBER_LENGTH)
    ) {
      throw createServiceError(
        400,
        `Project number must be ${projectsService.MAX_PROJECT_NUMBER_LENGTH} characters or less`
      );
    }

    const normalizedName = trimmedName.toLowerCase();
    const conflictRes = await client.query(
      'SELECT * FROM projects WHERE (LOWER(name) = $1 OR number = $2) AND id != $3',
      [normalizedName, trimmedNumber, projectId]
    );
    if (conflictRes.rows.length > 0) {
      const conflict = conflictRes.rows[0] || {};
      const conflictName = String(conflict.name || '').trim().toLowerCase();
      const conflictNumber = String(conflict.number || '').trim();
      if (conflictName === normalizedName) {
        throw createServiceError(409, 'A project with this name already exists');
      }
      if (conflictNumber === trimmedNumber) {
        throw createServiceError(409, 'A project with this number already exists');
      }
      throw createServiceError(409, 'A project with this name already exists');
    }

    const nextStatus = normalizeProjectStatus(next.status === undefined ? currentProject.status : next.status);
    const prevStatus = normalizeProjectStatus(currentProject.status);
    const nameChanged = trimmedName !== currentProject.name;
    const numberChanged = trimmedNumber !== currentProject.number;
    const statusChanged = nextStatus !== prevStatus;

    if (!nameChanged && !numberChanged && !statusChanged) {
      return {
        changed: false,
        currentProject,
        updatedProject: currentProject,
        audit: null,
      };
    }

    const currentFolderName =
      (projectsService && projectsService.getProjectFolderName(currentProject)) || String(projectId || '').trim();
    let nextFolderName = currentFolderName;
    let folderRenamedOnDisk = false;
    let folderRenameFrom = null;
    let folderRenameTo = null;

    const folderNameInDb = Object.prototype.hasOwnProperty.call(currentProject, 'folder_name')
      ? String(currentProject.folder_name || '').trim()
      : null;
    const shouldSyncFolderToName =
      nameChanged || (folderNameInDb !== null && (!folderNameInDb || folderNameInDb === String(projectId || '').trim()));

    if (shouldSyncFolderToName && projectsService) {
      const desiredBase = projectsService.sanitizeProjectId(trimmedName);
      if (desiredBase && desiredBase !== currentFolderName) {
        let suffix = 0;
        let candidate = desiredBase;
        while (suffix < 200) {
          const candidatePaths = projectsService.getProjectPaths(candidate);
          if (!candidatePaths) break;
          if (!fs.existsSync(candidatePaths.base)) break;
          suffix += 1;
          candidate = `${desiredBase}-${suffix}`;
        }
        nextFolderName = candidate || currentFolderName;
      }
    }

    if (nextFolderName !== currentFolderName && projectsService) {
      const currentPaths = projectsService.getProjectPaths(currentFolderName);
      const legacyPaths =
        currentFolderName !== String(projectId || '').trim()
          ? projectsService.getProjectPaths(String(projectId || '').trim())
          : null;
      const targetPaths = projectsService.getProjectPaths(nextFolderName);

      if (!targetPaths) {
        throw createServiceError(400, 'Invalid project folder name');
      }

      const sourceCandidates = [currentPaths && currentPaths.base, legacyPaths && legacyPaths.base].filter(Boolean);
      const sourceDir = sourceCandidates.find((value) => fs.existsSync(value)) || null;

      if (!sourceDir) {
        projectsService.ensureProjectDirs(nextFolderName);
      } else if (fs.existsSync(targetPaths.base)) {
        throw createServiceError(409, 'A project folder with this name already exists');
      } else {
        try {
          fs.renameSync(sourceDir, targetPaths.base);
          folderRenamedOnDisk = true;
          folderRenameFrom = sourceDir;
          folderRenameTo = targetPaths.base;
        } catch (error) {
          console.error('Error renaming project folder:', error);
          throw createServiceError(500, 'Failed to rename project folder');
        }
      }
    }

    let updateRes = null;
    try {
      updateRes = await client.query(
        `UPDATE projects
         SET name = $1,
             number = $2,
             status = $3,
             folder_name = $4,
             workflow_state = 'PUBLISHED',
             updated_at = NOW()
         WHERE id = $5
         RETURNING *`,
        [trimmedName, trimmedNumber, nextStatus, nextFolderName, projectId]
      );
    } catch (error) {
      if (folderRenamedOnDisk) {
        try {
          fs.renameSync(folderRenameTo, folderRenameFrom);
        } catch (rollbackErr) {
          console.error('Error rolling back project folder rename:', rollbackErr);
        }
      }

      if (error && error.code === '42703') {
        updateRes = await client.query(
          `UPDATE projects
           SET name = $1,
               number = $2,
               status = $3,
               workflow_state = 'PUBLISHED',
               updated_at = NOW()
           WHERE id = $4
           RETURNING *`,
          [trimmedName, trimmedNumber, nextStatus, projectId]
        );
      } else {
        throw error;
      }
    }

    const messageParts = [];
    if (nameChanged) messageParts.push(`Name: "${currentProject.name}" -> "${trimmedName}"`);
    if (numberChanged) messageParts.push(`Number: "${currentProject.number}" -> "${trimmedNumber}"`);
    if (statusChanged) messageParts.push(`Status: "${prevStatus}" -> "${nextStatus}"`);

    let action = 'project:update';
    if (nameChanged && numberChanged) action = 'project:rename';
    else if (nameChanged) action = 'project:name';
    else if (numberChanged) action = 'project:number';
    else if (statusChanged) action = 'project:status';

    return {
      changed: true,
      currentProject,
      updatedProject: updateRes.rows[0] || null,
      audit: {
        projectId,
        projectNumber: trimmedNumber,
        projectName: trimmedName,
        action,
        message: messageParts.join('; '),
        metadata: {
          old: {
            name: currentProject.name,
            number: currentProject.number,
            status: currentProject.status,
          },
          new: {
            name: trimmedName,
            number: trimmedNumber,
            status: nextStatus,
          },
          via: 'approval:project:update',
        },
      },
    };
  }

  async function inferProjectInfoChangeSetFromAudit({ projectId, userId, startAt }) {
    if (!projectId || userId === undefined || userId === null) return null;
    const params = [String(projectId), Number(userId)];
    let timeSql = '';
    if (startAt && Number.isFinite(new Date(startAt).getTime())) {
      params.push(new Date(startAt));
      timeSql = `AND created_at >= $${params.length}`;
    }
    try {
      const result = await db.query(
        `SELECT metadata
         FROM audit_logs
         WHERE project_id = $1
           AND user_id = $2
           ${timeSql}
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
        params
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

  async function inferApprovalBoundaryAt({ projectId, projectCreatedAt }) {
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

  async function inferSessionStartAt({ projectId, projectCreatedAt, userId }) {
    const boundary = await inferApprovalBoundaryAt({ projectId, projectCreatedAt });
    if (!projectId || userId === undefined || userId === null) return boundary;
    const since = boundary && Number.isFinite(new Date(boundary).getTime()) ? new Date(boundary) : new Date(0);
    try {
      const result = await db.query(
        `SELECT action, created_at
         FROM audit_logs
         WHERE project_id = $1
           AND user_id = $2
           AND created_at >= $3
         ORDER BY created_at DESC, id DESC
         LIMIT 80`,
        [String(projectId), Number(userId), since]
      );
      const rows = Array.isArray(result.rows) ? result.rows : [];
      const events = rows
        .map((row) => ({
          action: normalizeSessionActionCode(row && row.action),
          created_at: normalizeCreatedAt(row && row.created_at),
        }))
        .filter((row) => row.action && row.created_at);

      if (events.length === 0) return boundary;

      let oldest = events[0].created_at;
      let previous = events[0].created_at;
      for (let i = 1; i < events.length; i += 1) {
        const current = events[i].created_at;
        if (!current) break;
        if (previous.getTime() - current.getTime() > SESSION_ACTIVITY_GAP_MS) break;
        oldest = current;
        previous = current;
      }
      return oldest;
    } catch (e) {
      if (e && e.code === '42P01') return boundary;
      return boundary;
    }
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

  async function inferSessionInfoEntriesFromAudit({ projectId, userId, startAt, limit = 20 }) {
    if (!projectId || userId === undefined || userId === null) return [];
    const since = startAt && Number.isFinite(new Date(startAt).getTime()) ? new Date(startAt) : new Date(0);
    try {
      const result = await db.query(
        `SELECT action, message, metadata, created_at
         FROM audit_logs
         WHERE project_id = $1
           AND user_id = $2
           AND created_at >= $3
         ORDER BY created_at DESC, id DESC
         LIMIT $4`,
        [String(projectId), Number(userId), since, Math.max(1, Number(limit) || 1)]
      );
      return dedupeSummaryEntries(
        (Array.isArray(result.rows) ? result.rows : [])
          .map((row) => buildSummaryEntryFromAuditRow(row))
          .filter(Boolean)
      ).slice(0, Math.max(0, Number(limit) || 0));
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
        const finalCodes = getSummaryActionCodes(summary);
        if (finalCodes.length > 0) {
          out.action_code = finalCodes.join(', ');
        } else if (summary.action_code) {
          out.action_code = String(summary.action_code);
        }

        let summaryEntries = getStoredSummaryEntries(summary);
        if (summaryEntries.length === 0 && computedSummary && computedSummary.information) {
          summaryEntries = [
            createSummaryEntry({
              actionCode: computedSummary.action_code,
              message: computedSummary.information,
              assetName: null,
              createdAt: null,
              source: 'computed',
            }),
          ].filter(Boolean);
        }

        const filteredEntries = filterSummaryEntriesByActionCodes(summaryEntries, finalCodes);
        const information = buildSummaryInformation(filteredEntries);
        if (information) out.information = information;
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
    const requestedType = body && typeof body === 'object' ? String(body.request_type || '').trim() : '';
    const bodyChangeSet = extractProjectInfoChangeSetFromBody(body);
    const isPublishedMetadataRequest =
      currentState === 'PUBLISHED' &&
      requestedType === 'project:update' &&
      !!bodyChangeSet;
    const effectiveRequestType = isPublishedMetadataRequest ? 'project:update' : 'project:publish';

    if (currentState === 'PUBLISHED' && !isPublishedMetadataRequest) {
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

    const sessionStartAt = isPublishedMetadataRequest
      ? null
      : await inferSessionStartAt({
          projectId,
          projectCreatedAt: project.created_at,
          userId: sessionUserId,
        });
    const inferredChangeSet = bodyChangeSet
      ? null
      : await inferProjectInfoChangeSetFromAudit({ projectId, userId: sessionUserId, startAt: sessionStartAt });
    const effectiveChangeSet = bodyChangeSet || inferredChangeSet;
    if (effectiveChangeSet) {
      payload.changes = {
        previous: pickProjectInfoFields(effectiveChangeSet.previous),
        next: pickProjectInfoFields(effectiveChangeSet.next),
      };
    }

    const projectInfoSummary = payload.changes ? computeProjectInfoChangeSummary(payload.changes) : null;
    const summaryEntries = [];
    if (isPublishedMetadataRequest && !projectInfoSummary) {
      return {
        ok: false,
        status: 400,
        json: { success: false, message: 'No project changes were provided for approval.' },
      };
    }

    let finalCodes = [];
    if (isPublishedMetadataRequest) {
      if (projectInfoSummary && projectInfoSummary.information) {
        finalCodes = applyActionCodeSpecificityRules([projectInfoSummary.action_code]);
        const projectEntry = createSummaryEntry({
          actionCode: projectInfoSummary.action_code,
          message: projectInfoSummary.information,
          assetName: null,
          createdAt: null,
          source: 'project_info',
        });
        if (projectEntry) summaryEntries.push(projectEntry);
      }
    } else {
      const sessionActionCodes = await inferSessionActionCodesFromAudit({
        projectId,
        userId: sessionUserId,
        startAt: sessionStartAt,
      });
      const sessionEntries = await inferSessionInfoEntriesFromAudit({
        projectId,
        userId: sessionUserId,
        startAt: sessionStartAt,
        limit: 24,
      });

      const actionCodes = new Set(sessionActionCodes);
      if (projectInfoSummary && projectInfoSummary.action_code) {
        actionCodes.add(String(projectInfoSummary.action_code));
      }
      finalCodes = applyActionCodeSpecificityRules(Array.from(actionCodes));

      if (projectInfoSummary && projectInfoSummary.information && finalCodes.includes(projectInfoSummary.action_code)) {
        const projectEntry = createSummaryEntry({
          actionCode: projectInfoSummary.action_code,
          message: projectInfoSummary.information,
          assetName: null,
          createdAt: null,
          source: 'project_info',
        });
        if (projectEntry) summaryEntries.push(projectEntry);
      }
      summaryEntries.push(...filterSummaryEntriesByActionCodes(sessionEntries, finalCodes));
    }

    const information = buildSummaryInformation(summaryEntries);

    if (finalCodes.length > 0 || information) {
      payload.summary = {
        action_codes: finalCodes,
        action_code: finalCodes.join(', '),
        information_entries: summaryEntries,
        information,
      };
    }

    const insertRes = await db.query(
      `INSERT INTO approval_requests (requester_id, project_id, request_type, payload, status)
       VALUES ($1, $2, $3, $4::jsonb, 'PENDING')
       RETURNING id, created_at, project_id, request_type, status`,
      [sessionUserId, projectId, effectiveRequestType, JSON.stringify(payload)]
    );

    if (!isPublishedMetadataRequest) {
      await db.query("UPDATE projects SET workflow_state = 'PENDING_APPROVAL' WHERE id = $1", [projectId]);
      await emitProjectsChanged();
    }

    try {
      const adminName = normalizeUsername(sessionUsername);
      await insertAuditLog({
        projectId,
        userId: sessionUserId,
        action: 'REQ_SUBMITTED',
        message: `Admin ${adminName} requested approval for ${project.name}`,
        metadata: { requestId: insertRes.rows[0]?.id, request_type: effectiveRequestType },
      });
    } catch (e) {}

    return { ok: true, json: { success: true, request: insertRes.rows[0] } };
  }

  async function decideApproval({ id, decision, commentValue, sessionUserId, sessionUsername }) {
    const client = await db.getClient();
    let transactionOpen = false;
    let requestType = 'project:publish';
    let projectChanged = false;
    let approvedProjectAudit = null;
    let projectId = null;
    let request = null;

    try {
      const supportsNotifications = await supportsApprovalRequestNotifications();

      await client.query('BEGIN');
      transactionOpen = true;

      const reqRes = await client.query('SELECT * FROM approval_requests WHERE id = $1 FOR UPDATE', [id]);
      request = reqRes.rows[0];
      if (!request) {
        throw createServiceError(404, 'Request not found');
      }
      if (String(request.status || '').toUpperCase() !== 'PENDING') {
        throw createServiceError(400, 'Request is not pending.');
      }

      projectId = request.project_id ? String(request.project_id) : null;
      if (!projectId) {
        throw createServiceError(400, 'Request is missing project_id.');
      }

      requestType = String(request.request_type || '').trim() || 'project:publish';
      const nextStatus = decision === 'APPROVED' ? 'APPROVED' : 'REJECTED';
      const decisionPatch = JSON.stringify({
        decided_at_ms: Date.now(),
        decided_by: sessionUsername ? String(sessionUsername) : null,
        decision: nextStatus,
        admin_comment: commentValue || null,
      });

      const payload = request.payload && typeof request.payload === 'object' ? request.payload : {};
      const requestChangeSet = extractProjectInfoChangeSetFromBody({
        changes: payload && payload.changes && typeof payload.changes === 'object' ? payload.changes : null,
      });

      if (decision === 'APPROVED' && requestType === 'project:update') {
        const applied = await applyApprovedProjectMetadataChange({
          client,
          projectId,
          changeSet: requestChangeSet,
        });
        projectChanged = !!(applied && applied.changed);
        approvedProjectAudit = applied && applied.audit ? applied.audit : null;
      } else if (requestType !== 'project:update') {
        const nextWorkflow = decision === 'APPROVED' ? 'PUBLISHED' : 'REJECTED';
        await client.query('UPDATE projects SET workflow_state = $1 WHERE id = $2', [nextWorkflow, projectId]);
        projectChanged = true;
      }

      if (supportsNotifications) {
        await client.query(
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
        await client.query(
          `UPDATE approval_requests
           SET status = $1,
               admin_comment = $2,
               payload = COALESCE(payload, '{}'::jsonb) || $4::jsonb
           WHERE id = $3`,
          [nextStatus, commentValue || null, id, decisionPatch]
        );
      }
      await client.query('COMMIT');
      transactionOpen = false;

      if (approvedProjectAudit) {
        try {
          await insertAuditLog({
            ...approvedProjectAudit,
            userId: sessionUserId,
          });
        } catch (e) {}
      }

      try {
        const actorName = normalizeUsername(sessionUsername);
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
        if (projectChanged) {
          await emitProjectsChanged();
        }
      } catch (e) {}

      return { ok: true, json: { success: true } };
    } catch (e) {
      if (transactionOpen) {
        try { await client.query('ROLLBACK'); } catch (rollbackErr) {}
      }
      if (e && e.status) {
        return { ok: false, status: e.status, json: { success: false, message: e.message || 'Request failed' } };
      }
      throw e;
    } finally {
      try { client.release(); } catch (releaseErr) {}
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
    inferApprovalBoundaryAt,
    listApprovalRequests,
    createApprovalRequest,
    decideApproval,
  };
}

module.exports = createApprovalRequestsService;
