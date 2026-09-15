// Vercel catch-all entrypoint for the existing Node HTTP server.
// This preserves the original /api/... request path so the project's
// internal router can match routes such as POST /api/auth/login.
const server = require('../server');

module.exports = function handler(req, res) {
  return server.emit('request', req, res);
};
