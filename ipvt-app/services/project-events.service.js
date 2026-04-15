/* Broadcasts project-related socket events. */
const { getProjectsManifest } = require('./project-manifest.service');

/* Gets get io. */
function getIo(app) {
  return app && typeof app.get === 'function' ? app.get('io') : null;
}

/* Notifies listeners about emit projects changed. */
function emitProjectsChanged(app) {
  try {
    const io = getIo(app);
    if (!io) return;
    io.emit('projects:changed', getProjectsManifest());
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
