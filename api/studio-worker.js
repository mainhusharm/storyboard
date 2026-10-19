// This queue trigger is private: Vercel invokes it without a browser session.
const { QueueClient } = require('@vercel/queue');
const { processStudioJob } = require('../web/server');
module.exports = new QueueClient().handleNodeCallback(processStudioJob, {
  visibilityTimeoutSeconds: 360,
  retry: () => ({ afterSeconds: 60 })
});
module.exports.config = { maxDuration: 300 };
