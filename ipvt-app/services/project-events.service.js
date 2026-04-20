/* Broadcasts project-related socket events. */
/* Gets get io. */
function getIo(app) {
  return app && typeof app.get === 'function' ? app.get('io') : null;
}

/* Notifies listeners about emit projects changed. */
function emitProjectsChanged(app, { projectId = null, type = 'changed' } = {}) {
  try {
    const io = getIo(app);
    if (!io) return;
    io.emit('projects:changed', {
      type: String(type || 'changed'),
      projectId: projectId ? String(projectId) : null,
    });
  } catch (error) {
    console.error('Socket emit error:', error);
  }
}

/* Notifies listeners about emit to project. */
function emitToProject(app, projectId, eventName, payload) {
  try {
    if (!projectId || !eventName) return;
    const io = getIo(app);
    if (!io) return;
    io.to(`project:${projectId}`).emit(eventName, payload);
  } catch (error) {
    console.error('Socket emit error:', error);
  }
}

module.exports = {
  emitProjectsChanged,
  emitToProject,
};
