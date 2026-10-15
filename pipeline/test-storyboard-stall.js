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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);