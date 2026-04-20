/* Starts the HTTP/HTTPS server and websocket layer. */
require('dotenv').config();
const fs = require('fs');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const { clearAllSessions } = require('./db/users');
const { createApp } = require('./app');
const { PORT, SSL_KEY_PATH, SSL_CERT_PATH, getSslOptions } = require('./config/server');
const { registerSocketHandlers } = require('./sockets');

/* Starts the server and attaches realtime updates. */
async function startServer() {
  const app = createApp();
  const hasKey = fs.existsSync(SSL_KEY_PATH);
  const hasCert = fs.existsSync(SSL_CERT_PATH);
  const useHttps = hasKey && hasCert;
  const isProduction = String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';

  if (!useHttps) {
    if (isProduction) {
      console.error('SSL Certificates missing: Refusing to start in Production mode');
      throw new Error('SSL Certificates missing in production');
    }
    console.warn('SSL Certificates missing: Starting in HTTP mode for development');
  }

  const server = useHttps
    ? https.createServer(getSslOptions(), app)
    : http.createServer(app);
  const io = new Server(server);

  app.set('io', io);
  registerSocketHandlers(io);

  if (String(process.env.CLEAR_ALL_SESSIONS_ON_START || '').trim() === 'true') {
    await clearAllSessions();
  }

  server.listen(PORT, '0.0.0.0', () => {
    const protocol = useHttps ? 'https' : 'http';
    console.log(`Server running at ${protocol}://localhost:${PORT}`);
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
