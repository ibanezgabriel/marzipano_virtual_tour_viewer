const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3152;

const sslOptions = {
  key: fs.readFileSync(path.join(__dirname, '..', 'certificates/key.pem')),
  cert: fs.readFileSync(path.join(__dirname, '..', 'certificates/cert.pem')),
};
module.exports = {
  PORT,
  sslOptions,
};
