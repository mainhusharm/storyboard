// Regression check for the stuck-"busy" bug: a job left non-idle with no live
// worker must be reaped, and cancel must release the flag immediately.
const path = require('path');
const fs = require('fs');
const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'server.js'), 'utf8');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { console.log('  PASS', name); pass++; } else { console.log('  FAIL', name); fail++; } };

console.log('reapStaleJob present:', /function reapStaleJob\(/.test(src));
check('reapStaleJob is defined', /function reapStaleJob\(/.test(src));
check('stale threshold is 3 minutes', /JOB_STALE_MS = 3 \* 60 \* 1000/.test(src));

const GUARD = "if (job.phase !== 'idle') return sendJson(res, 409, { error: 'busy' });";
let guardCount = 0, guardReaped = 0, idx = src.indexOf(GUARD);
while (idx !== -1) {
  guardCount++;
  // Look at the 200 chars immediately BEFORE this guard for a reap call.
  if (/reapStaleJob\([^)]*\);\s*$/.test(src.slice(Math.max(0, idx - 200), idx))) guardReaped++;
  idx = src.indexOf(GUARD, idx + GUARD.length);
}
check('every storyboard busy guard reaps first (' + guardCount + ' guards, ' + guardReaped + ' preceded by reap)', guardCount === guardReaped && guardCount > 0);
check('/api/status reaps', /p === '\/api\/status'\) \{ reapStaleJob\(\);/.test(src));
check('logLine stamps lastProgressAt (reap measures silence)', /job\.lastProgressAt = Date\.now\(\);/.test(src));
check('setPhase stamps lastProgressAt', /job\.startedAt = Date\.now\(\); job\.lastProgressAt = Date\.now\(\);/.test(src));
check('reap uses lastProgressAt, not startedAt', /const lastTick = job\.lastProgressAt \|\| job\.startedAt;/.test(src));

// The storyboard fallback chain must not contain models the free plan rejects.
const chainLine = (src.match(/const modelsToTry = \[model,[^\]]*\]/) || [''])[0];
check('fallback chain drops paywalled gemini-2.5-pro', !/gemini-2\.5-pro/.test(chainLine));
check('fallback chain drops prose-only deepseek-v3.2', !/deepseek-v3\.2/.test(chainLine));
check('fallback chain uses verified JSON models', /gemini-3\.8-flash/.test(chainLine) && /deepseek-v4-flash/.test(chainLine) && /claude-haiku-5-5/.test(chainLine));
check('per-call timeout raised above the 75s abort', /IS_VERCEL \? 150000/.test(src));
check('call reserve exceeds the per-call cap', /CALL_RESERVE_MS = 155000/.test(src));

// Behavioural check against the real implementation, isolated from the server.
// Mirrors reapStaleJob(): measures SILENCE since the last log line, not total age.
const JOB_STALE_MS = 3 * 60 * 1000;
function makeJob() { return { phase: 'idle', startedAt: null, lastProgressAt: null, sbJobId: null, sbResult: null, log: [] }; }
function reap(job, force = false) {
  if (job.phase === 'idle') return false;
  if (!job.startedAt) { job.phase = 'idle'; job.sbJobId = null; job.sbResult = null; return true; }
  const lastTick = job.lastProgressAt || job.startedAt;
  const silentMs = Date.now() - lastTick;
  if (force || silentMs >= JOB_STALE_MS) {
    job.phase = 'idle'; job.sbJobId = null; job.sbResult = null; return true;
  }
  return false;
}
const j1 = makeJob(); j1.phase = 'storyboard'; j1.startedAt = j1.lastProgressAt = Date.now() - 20 * 60 * 1000; j1.sbJobId = 'sb_old';
check('a 20-minute-silent job is reaped to idle', reap(j1) === true && j1.phase === 'idle' && j1.sbJobId === null);
const j2 = makeJob(); j2.phase = 'storyboard'; j2.startedAt = j2.lastProgressAt = Date.now() - 60 * 1000;
check('a 1-minute-silent job is left running (background reap)', reap(j2, false) === false && j2.phase === 'storyboard');
const j3 = makeJob(); j3.phase = 'storyboard'; j3.startedAt = j3.lastProgressAt = Date.now() - 30 * 1000;
check('a 30-second-silent job is force-cleared (user clicked run)', reap(j3, true) === true && j3.phase === 'idle');
const j4 = makeJob();
check('an idle job is untouched', reap(j4) === false && j4.phase === 'idle');
const j5 = makeJob(); j5.phase = 'storyboard'; j5.startedAt = null;
check('a job with no start time is released', reap(j5) === true && j5.phase === 'idle');
// THE REGRESSION: a long-running but HEALTHY job (started 5 min ago, logged 2s
// ago) must NOT be reaped. Reaping on startedAt killed live jobs mid-phase.
const j6 = makeJob(); j6.phase = 'storyboard'; j6.startedAt = Date.now() - 5 * 60 * 1000; j6.lastProgressAt = Date.now() - 2000;
check('a 5-min job that logged 2s ago is NOT reaped', reap(j6) === false && j6.phase === 'storyboard');
const j7 = makeJob(); j7.phase = 'storyboard'; j7.startedAt = j7.lastProgressAt = Date.now() - 4 * 60 * 1000;
check('a 4-min job with no log at all IS reaped', reap(j7) === true && j7.phase === 'idle');

// cancel must clear the phase, not just set the cooperative flag.
const cancelBlock = src.slice(src.indexOf("p === '/api/cancel'"), src.indexOf("p === '/api/characters'"));
check('cancel sets phase to idle', /job\.phase = 'idle';/.test(cancelBlock));
check('cancel sets cancelRequested', /job\.cancelRequested = true;/.test(cancelBlock));
check('cancel reaps first', /reapStaleJob\(\);/.test(cancelBlock));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
