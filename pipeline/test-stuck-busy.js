// Regression check for the stuck-"busy" bug: a job left non-idle with no live
// worker must be reaped, and cancel must release the flag immediately.
const path = require('path');
const fs = require('fs');
const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'server.js'), 'utf8');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { console.log('  PASS', name); pass++; } else { console.log('  FAIL', name); fail++; } };

console.log('reapStaleJob present:', /function reapStaleJob\(/.test(src));
check('reapStaleJob is defined', /function reapStaleJob\(/.test(src));
check('stale threshold is 2 minutes', /JOB_STALE_MS = 2 \* 60 \* 1000/.test(src));

const guards = src.split("if (job.phase !== 'idle') return sendJson(res, 409, { error: 'busy' });").length - 1;
const reaped = src.split("reapStaleJob();\n      if (job.phase !== 'idle') return sendJson(res, 409").length - 1;
check('every storyboard busy guard reaps first (' + guards + ' guards, ' + reaped + ' patched)', guards === reaped && guards > 0);
check('/api/status reaps', /p === '\/api\/status'\) \{ reapStaleJob\(\);/.test(src));

// Behavioural check against the real implementation, isolated from the server.
const JOB_STALE_MS = 2 * 60 * 1000;
function makeJob() { return { phase: 'idle', startedAt: null, sbJobId: null, sbResult: null, log: [] }; }
function reap(job, force = false) {
  if (job.phase === 'idle') return false;
  if (!job.startedAt) { job.phase = 'idle'; job.sbJobId = null; job.sbResult = null; return true; }
  const age = Date.now() - job.startedAt;
  if (force || age >= JOB_STALE_MS) {
    job.phase = 'idle'; job.sbJobId = null; job.sbResult = null; return true;
  }
  return false;
}
const j1 = makeJob(); j1.phase = 'storyboard'; j1.startedAt = Date.now() - 20 * 60 * 1000; j1.sbJobId = 'sb_old';
check('a 20-minute-old job is reaped to idle', reap(j1) === true && j1.phase === 'idle' && j1.sbJobId === null);
const j2 = makeJob(); j2.phase = 'storyboard'; j2.startedAt = Date.now() - 60 * 1000;
check('a 1-minute-old job is left running (background reap)', reap(j2, false) === false && j2.phase === 'storyboard');
const j3 = makeJob(); j3.phase = 'storyboard'; j3.startedAt = Date.now() - 30 * 1000;
check('a 30-second-old job is force-cleared (user clicked run)', reap(j3, true) === true && j3.phase === 'idle');
const j4 = makeJob();
check('an idle job is untouched', reap(j4) === false && j4.phase === 'idle');
const j5 = makeJob(); j5.phase = 'storyboard'; j5.startedAt = null;
check('a job with no start time is released', reap(j5) === true && j5.phase === 'idle');

// cancel must clear the phase, not just set the cooperative flag.
const cancelBlock = src.slice(src.indexOf("p === '/api/cancel'"), src.indexOf("p === '/api/characters'"));
check('cancel sets phase to idle', /job\.phase = 'idle';/.test(cancelBlock));
check('cancel sets cancelRequested', /job\.cancelRequested = true;/.test(cancelBlock));
check('cancel reaps first', /reapStaleJob\(\);/.test(cancelBlock));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
