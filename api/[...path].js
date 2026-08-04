// Vercel catch-all: /api/* → web/server.js requestHandler
// Preserves original req.url so route matching works.
module.exports = require('../web/server');
module.exports.config = { maxDuration: 300 }; // fluid compute: Hobby allows up to 300s
