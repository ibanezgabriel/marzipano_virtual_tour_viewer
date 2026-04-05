function createRealtimeService({ db, io }) {
  /**
   * Emits a `projects:changed` realtime event to all connected Socket.IO clients.
   * This is called after project mutations so dashboards update without refresh.
   *
   * @returns {Promise<void>}
   */
  async function emitProjectsChanged() {
    try {
      const res = await db.query('SELECT * FROM projects ORDER BY created_at ASC');
      io.emit('projects:changed', res.rows);
    } catch (e) {
      console.error('Socket emit error:', e);
    }
  }

  function registerSocketHandlers() {
    io.on('connection', (socket) => {
      socket.on('joinProject', (projectId) => {
        try {
          if (typeof projectId === 'string' && projectId.length > 0) socket.join(`project:${projectId}`);
        } catch (e) {}
      });
      socket.on('leaveProject', (projectId) => {
        try {
          if (typeof projectId === 'string' && projectId.length > 0) socket.leave(`project:${projectId}`);
        } catch (e) {}
      });
    });
  }

  return {
    emitProjectsChanged,
    registerSocketHandlers,
  };
}

module.exports = createRealtimeService;

