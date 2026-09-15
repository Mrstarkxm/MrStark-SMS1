// Vercel entrypoint for the existing Node HTTP server.
// Vercel expects a request handler function, not the raw http.Server object.
const server = require('../server');

module.exports = function handler(req, res) {
  return server.emit('request', req, res);
};
