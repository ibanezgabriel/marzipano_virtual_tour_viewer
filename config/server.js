const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const sslOptions = {
  key: fs.readFileSync(path.join(__dirname, '..', 'key.pem')),
  cert: fs.readFileSync(path.join(__dirname, '..', 'cert.pem')),
};

module.exports = {
  PORT,
  sslOptions,
};
