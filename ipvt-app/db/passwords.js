const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const SCRYPT_KEY_LENGTH = 64;
const HASH_PREFIX = 'scrypt';

async function hashPassword(password) {
  const secret = String(password || '');
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = await scrypt(secret, salt, SCRYPT_KEY_LENGTH);
  return `${HASH_PREFIX}$${salt}$${Buffer.from(derivedKey).toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') return false;
  const [prefix, salt, expectedHex] = storedHash.split('$');
  if (prefix !== HASH_PREFIX || !salt || !expectedHex) return false;
  const derivedKey = await scrypt(String(password || ''), salt, SCRYPT_KEY_LENGTH);
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(derivedKey);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

module.exports = {
  hashPassword,
  verifyPassword,
};
