/* Loads server settings such as ports and SSL options. */
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3152;

const SSL_KEY_PATH = path.join(__dirname, '..', 'certificates', 'key.pem');
const SSL_CERT_PATH = path.join(__dirname, '..', 'certificates', 'cert.pem');

function getSslOptions() {
  return {
    key: fs.readFileSync(SSL_KEY_PATH),
    cert: fs.readFileSync(SSL_CERT_PATH),
  };
}
module.exports = {
  PORT,
  SSL_KEY_PATH,
  SSL_CERT_PATH,
  getSslOptions,
};
