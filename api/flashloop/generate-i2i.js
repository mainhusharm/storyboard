// Explicit multi-segment route — required on Vercel (catch-all only matches 1 segment)
module.exports = require('../../web/server');
module.exports.config = { maxDuration: 60 };
