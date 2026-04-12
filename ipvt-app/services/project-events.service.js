const { getProjectsManifest } = require('./project-manifest.service');

function getIo(app) {
  return app && typeof app.get === 'function' ? app.get('io') : null;
}

function emitProjectsChanged(app) {
  try {
    const io = getIo(app);
    if (!io) return;
    io.emit('projects:changed', getProjectsManifest());
  } catch (error) {
    console.error('Socket emit error:', error);
  }
}

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
