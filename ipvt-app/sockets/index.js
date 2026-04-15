/* Registers websocket listeners for project updates. */
function registerSocketHandlers(io) {
  io.on('connection', (socket) => {
    socket.on('joinProject', (projectId) => {
      try {
        if (typeof projectId === 'string' && projectId.length > 0) {
          socket.join(`project:${projectId}`);
        }
      } catch (_error) {}
    });

    socket.on('leaveProject', (projectId) => {
      try {
        if (typeof projectId === 'string' && projectId.length > 0) {
          socket.leave(`project:${projectId}`);
        }
      } catch (_error) {}
    });
  });
}

module.exports = {
  registerSocketHandlers,
};
