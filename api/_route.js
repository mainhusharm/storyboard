// Single entry for multi-segment /api/* routes (Vercel catch-all only matches 1 segment).
// vercel.json rewrites /api/a/b → /api/_route?p=/api/a/b
module.exports = require('../web/server');
module.exports.config = { maxDuration: 60 };
