// Vercel daily retention job; authentication and deletion are handled server-side.
module.exports = require('../web/server');
module.exports.config = { maxDuration: 300 };
