const { getProjectsManifest } = require('./project-manifest.service');

function emitProjectsChanged(app) {
  try {
    const io = app && typeof app.get === 'function' ? app.get('io') : null;
    if (!io) return;
    io.emit('projects:changed', getProjectsManifest());
  } catch (error) {
    console.error('Socket emit error:', error);
  }
}

module.exports = {
  emitProjectsChanged,
};
