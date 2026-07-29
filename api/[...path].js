// Vercel catch-all: /api/* → web/server.js requestHandler
// Preserves original req.url so route matching works.
module.exports = require('../web/server');
