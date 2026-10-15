// Regression tests for the two storyboard-stall bugs:
//   1. Cross-instance polling: a poll landing on an instance that never saw the
//      job must answer "pending", not 404 (404 killed a healthy run).
//   2. Short frame output: a model returning 1 of 3 frames must trigger a top-up.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'server.js'), 'utf8');
const client = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'storyboard.html'), 'utf8');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { console.log('  PASS', name); pass++; } else { console.log('  FAIL', name); fail++; } };

console.log('\n[1] cross-instance polling');
check('timeout constant defined (8 min)', /STORYBOARD_JOB_TIMEOUT_MS = 8 \* 60 \* 1000/.test(src));
check('submit writes a pending marker to storage', /await saveStoryboardJob\(userId, \{ pending: true, jobId, startedAt: Date\.now\(\)/.test(src));
// The poll handler must branch on saved.pending before consuming the record.
const pollBlock = src.slice(src.indexOf('if (body.pollStoryboard) {'), src.indexOf("if (!(await requireCredits(req, res, pipelineCost, 'create full film')))"));
check('poll handles a pending marker', /if \(saved\.pending\)/.test(pollBlock));
check('pending poll answers 202 pending', /sendJson\(res, 202, \{ pending: true, jobId: saved\.jobId/.test(pollBlock));
check('pending past timeout is cleared, not waited on', /storyboard job timed out/.test(pollBlock));
check('pending marker is NOT cleared while running', !/if \(saved\.pending\)[\s\S]{0,400}clearStoryboardJob\(req\.user\.id\);\s*\n\s*return sendJson\(res, 202/.test(pollBlock));
check('completed result still clears storage', /await clearStoryboardJob\(req\.user\.id\);\s*\n\s*if \(saved\.ok === false\)/.test(pollBlock));
check('404 retained for the pre-submit probe', /No storyboard job found/.test(pollBlock));

console.log('\n[2] short frame output top-up');
check('top-up triggered when frames < frameCount', /if \(frames\.length < frameCount/.test(src));
check('top-up asks for the remainder', /remaining \$\{missing\} frame/.test(src) || /remaining/.test(src));
check('top-up frames are renumbered', /frame: frames\.length \+ i \+ 1/.test(src));
check('top-up respects the time budget', /phase 2 short by \$\{missing\}/.test(src));
check('top-up failure is non-fatal (keeps what we have)', /keeping \$\{frames\.length\} frame\(s\)/.test(src));
check('FRAMES_JSON written after the top-up', /top-up added|frames = frames\.concat/.test(src));

console.log('\n[3] client keeps polling instead of dying');
// The client must not treat a transient poll failure as fatal.
const pollLoop = client.slice(client.indexOf('const pollInterval=15000'), client.indexOf('if(!FRAMES.length)throw'));
check('client loops on pending', /poll\.pending/.test(pollLoop));
check('client retries a transient poll error instead of throwing', /catch/.test(pollLoop));

console.log('\n[4] transient "busy" on follow-up phases is waited out, not fatal');
check('callPhase helper exists', /async function callPhase\(/.test(client));
check('callPhase retries on error==="busy"', /r\.error === 'busy'/.test(client));
check('callPhase waits between busy retries', /setTimeout\(r, 3000\)/.test(client));
check('callPhase rethrows a real 401/402 immediately', /session expired\|Free trial\|credits/i.test(client));
check('callPhase gives up with a clear message', /busy \(waited/.test(client));
// Every follow-up phase must route through callPhase, not raw api().
const followUps = ['/char-refs', '/images', '/videos', '/narration', '/combine'];
for (const p of followUps) {
  const used = new RegExp("callPhase\\('" + p.replace('/', '\\/') + "'").test(client);
  check('phase ' + p + ' goes through callPhase', used);
}
// Server must clear sbJobId on success too, or the instance that ran the job keeps
// reporting it as running and the next phase hits a busy guard.
const successBlock = src.slice(src.indexOf('job.sbResult = result;'), src.indexOf('await saveStoryboardJob(userId, result);'));
check('sbJobId cleared on success (not just on failure)', /job\.sbJobId = null;/.test(successBlock));

console.log('\n[5] renders cannot outlive the Vercel function budget');
// waitTask defaults to a 25-minute deadline. A provider that never answers kept
// the promise alive past Vercel's 300s kill, so the request died with no
// response and the pipeline looked frozen forever.
check('char-refs parallel wait is budgeted', /waitTask\(task, perTaskMin\)/.test(src));
check('per-task budget derived from the request budget', /IS_VERCEL \? Math\.max\(1, Math\.floor\(budgetMs \/ 60000\)\) : 25/.test(src));
check('frame image wait is budgeted on Vercel', /waitTask\(task, IS_VERCEL \? 4 : 25\)/.test(src));
check('client bounds the request with a manual abort timer', /setTimeout\(\(\) => \{ timedOut = true; ac\.abort\(\); \}, timeoutMs\)/.test(client));
check('client timeout sits under the 300s kill', /timeoutMs = opts\.timeoutMs \|\| 280000/.test(client));
check('client reports a timeout distinctly', /timed out/.test(client));

console.log('\n[6] no submission or render can outlive the function budget');
// paxFetch defaults to a 120s timeout. submitTask retried 4x with backoff, so a
// single hung submission burned ~9min and the invocation was killed at 300s with
// no response — the UI froze before any image appeared.
check('submitTask attempts capped on Vercel', /submitAttempts = IS_VERCEL \? 2 : 4/.test(src));
check('submitTask timeout bounded on Vercel', /submitTimeoutMs = IS_VERCEL \? 45000 : 120000/.test(src));
check('submitTask uses the bounded timeout', /paxFetch\(`\$\{API\}\$\{pq\}`, \{\}, submitTimeoutMs\)/.test(src));
check('img2img attempts capped on Vercel', /i2iAttempts = IS_VERCEL \? 2 : 3/.test(src));
check('img2img timeout bounded on Vercel', /i2iTimeoutMs = IS_VERCEL \? 45000 : 120000/.test(src));
check('img2img uses the bounded timeout', /\}, i2iTimeoutMs\);/.test(src));
check('image phase has a hard deadline', /phaseDeadline = Date\.now\(\) \+ \(IS_VERCEL \? 240000/.test(src));
check('out-of-budget frames are reported, not hung', /image phase out of budget/.test(src));

console.log('\n[7] no blocking "Pipeline failed" popup');
check('auto pipeline catch does not alert', !/alert\('Pipeline failed/.test(client));
check('auto pipeline catch logs guidance instead', /Force Clean, then run again/.test(client));

console.log('\n[8] cancel actually stops the run');
// The cancel handler used to force phase='idle' while renders were still in
// flight, so the UI reported done, the user clicked again, and a second job
// stacked on top of the first.
check('job tracks a cancelling state', /cancelling: false/.test(src));
check('releaseJob centralises the release', /function releaseJob\(/.test(src));
check('cancel sets cancelling rather than plain idle', /releaseJob\(\{ cancelling: true \}\)/.test(src));
check('status clears cancelling once quiet', /job\.cancelling && job\.lastProgressAt/.test(src));
check('force-clean clears cancelling too', /job\.cancelling = false;/.test(src));
check('client aborts the in-flight phase request', /PHASE_ABORT&&PHASE_ABORT\.abort/.test(client));
check('client stops retrying after a user cancel', /if \(USER_CANCELLED\) throw new Error\('cancelled'\)/.test(client));
check('UI shows CANCELLING instead of idle', /CANCELLING…/.test(client));
check('cancel button hides while cancelling', /busy&&!cancelling/.test(client));

console.log('\n[9] independent phases run concurrently');
check('char-refs, images and narration start together', /await Promise\.all\(\[charRefsP,imagesP,narrP\]\)/.test(client));
check('parallel batch is announced', /running in parallel/.test(client));
check('videos stay sequential for the chain anchor', /chainAnchor=prevChain/.test(client));
check('videos still one frame per request', /callPhase\('\/videos',body\)/.test(client));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);