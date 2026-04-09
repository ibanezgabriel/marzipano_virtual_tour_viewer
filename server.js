require('dotenv').config();
const https = require('https');
const { Server } = require('socket.io');
const { clearAllSessions } = require('./db/users');
const { createApp } = require('./app');
const { PORT, sslOptions } = require('./config/server');
const { registerSocketHandlers } = require('./sockets');

async function startServer() {
  const app = createApp();
  const server = https.createServer(sslOptions, app);
  const io = new Server(server);

  app.set('io', io);
  registerSocketHandlers(io);

  await clearAllSessions();

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at https://localhost:${PORT}`);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error('Server startup failed:', error);
    process.exit(1);
  });
}

module.exports = {
  startServer,
};
