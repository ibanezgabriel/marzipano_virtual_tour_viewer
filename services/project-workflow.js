function createProjectWorkflowService({ db, emitProjectsChanged, insertAuditLog, isSuperAdminRole }) {
  /**
   * Marks a published project as "MODIFIED" (moves it back to staging) the first time it is edited.
   * No-op for projects that are already non-published or already modified.
   *
   * This enables "re-approval" flows: once modified, admins can request approval again.
   *
   * @param {string} projectId
   * @param {number|null} userId
   * @param {string|null} actorRole
   * @param {object} [metadata]
   * @returns {Promise<boolean>} true if the workflow state was changed
   */
  async function markProjectModifiedIfPublished(projectId, userId, actorRole, metadata = {}) {
    if (!projectId) return false;
    // Super Admin edits are authoritative and should not force a re-approval cycle.
    if (isSuperAdminRole(actorRole)) return false;
    try {
      const updated = await db.query(
        "UPDATE projects SET workflow_state = 'MODIFIED', updated_at = NOW() WHERE id = $1 AND workflow_state = 'PUBLISHED' RETURNING id",
        [String(projectId)]
      );
      if (updated.rowCount > 0) {
        await emitProjectsChanged();
        try {
          await insertAuditLog({
            projectId,
            userId: userId ? Number(userId) : null,
            action: 'project:modified',
            message: 'Project modified; requires approval before publishing changes.',
            metadata: metadata && typeof metadata === 'object' ? metadata : {},
          });
        } catch (e) {}
        return true;
      }
    } catch (e) {
      // Best-effort; do not break the caller.
    }
    return false;
  }

  return {
    markProjectModifiedIfPublished,
  };
}

module.exports = createProjectWorkflowService;

