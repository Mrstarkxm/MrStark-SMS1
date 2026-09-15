// Password hashing using Node's built-in crypto.scrypt (no external deps).
// Format stored: "<saltHex>:<hashHex>"
const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hashHex] = stored.split(':');
  const hashBuffer = Buffer.from(hashHex, 'hex');
  const suppliedBuffer = crypto.scryptSync(password, salt, 64);
  if (hashBuffer.length !== suppliedBuffer.length) return false;
  return crypto.timingSafeEqual(hashBuffer, suppliedBuffer);
}

module.exports = { hashPassword, verifyPassword };
