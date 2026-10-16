// test-fullfilm-fixes.js
// Offline regression test for the two "Create Full Film" bugs:
//   1. combineFilm skipped frames whose image existed only as a STORED URL (each
//      Vercel instance has its own /tmp), then its emergency still hardcoded
//      PaxSenix nano-banana — which 429s with "image_quota_exceeded" while the
//      user's selected Logfare model (flux-2-klein-9b) renders fine.
//   2. the storyboard forced a MINIMUM of 3 frames, so a 1-minute target with 30s
//      Wan 3.0 clips rendered THREE 30s videos (a 1:30 film) instead of the
//      requested two.
//
// Usage: node pipeline/test-fullfilm-fixes.js
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'web', 'server.js'), 'utf8');
const client = fs.readFileSync(path.join(ROOT, 'web', 'public', 'storyboard.html'), 'utf8');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

const { storyboardFrameCount, emergencyImageChain, isLogfareImageModel, vocalizeAnimationPrompts } =
  require(path.join(ROOT, 'web', 'server.js')).__internal;

console.log('\n[1] combine restores the frame image before generating anything');
// The frame WAS rendered — only the local file is missing (cold instance / archived
// run). Its own stored URL must be re-downloaded, no credits spent.
check('stored URL is tried before the emergency still', /no local image — restoring from stored URL/.test(src));
check('restore uses the stored generated_image_url', /const stored = f\.generated_image_url \|\| f\.chain_image_url/.test(src));
check('restore downloads into the frame file', /try \{ await download\(stored, img\); \} catch/.test(src));
check('emergency still only runs when the restore failed', /if \(!fs\.existsSync\(img\)\) logLine\(`frame \$\{f\.frame\}: no video AND no image/.test(src));

console.log('\n[2] emergency still walks an image-model chain (no hardcoded PaxSenix)');
check('chain helper exists', /function emergencyImageChain\(preferred\)/.test(src));
check('user-selected model comes first', /\[preferred, 'flux-2-klein-9b', 'nano-banana-pro'\]/.test(src));
check('chain honours the combine opts imageModel', /for \(const chainModel of emergencyImageChain\(opts\.imageModel\)\)/.test(src));
check('old hardcoded nano-banana emergency is gone', !/const fbModel = safeImageModel\('nano-banana'\)/.test(src));
check('cancel is respected inside the chain', /if \(job\.cancelRequested\) break;/.test(src));
// Behavioural: preferred first, Logfare fallback present, no duplicates.
const chain = emergencyImageChain('flux-2-klein-9b');
check('preferred model is first', chain[0] === 'flux-2-klein-9b', 'got ' + JSON.stringify(chain));
check('PaxSenix default still reachable as last resort', chain.includes('nano-banana-pro'), 'got ' + JSON.stringify(chain));
check('chain has no duplicates', new Set(chain).size === chain.length);
check('unknown models are filtered out', !emergencyImageChain('totally-bogus-model').includes('totally-bogus-model'));
check('novita image models pass through', emergencyImageChain('novita:qwen-image-3.0-pro')[0] === 'novita:qwen-image-3.0-pro');

console.log('\n[3] imageModel travels from the client to combine');
check('run-all combine step threads imageModel', /clipUrls: body\.clipUrls, imageModel: body\.imageModel/.test(src));
check('/api/combine (vercel) threads imageModel', /const fp = await combineFilm\(frames, body\.ratio \|\| '16:9', body\.narrationMode, \{ narrVol: body\.narrVolume, origVol: body\.origVolume, clipUrls: body\.clipUrls, imageModel: body\.imageModel, narrationUrl: body\.narrationUrl \}\)/.test(src));
check('/api/combine (vercel) threads narrationUrl (cross-instance voice track)', /narrationUrl: body\.narrationUrl/.test(src));
check('/api/combine (vercel) still hosts the finished film (remote fix kept)', /final film hosted: \$\{finalUrl\}/.test(src));
check('/api/combine (local) threads imageModel', /combineFilm\(frames, body\.ratio \|\| '16:9', body\.narrationMode, \{ narrVol: body\.narrVolume, origVol: body\.origVolume, clipUrls: body\.clipUrls, imageModel: body\.imageModel, narrationUrl: body\.narrationUrl \}\)\.then/.test(src));
check('auto pipeline combine sends imageModel', /origVolume:opts\.origVolume,clipUrls,imageModel:opts\.imageModel/.test(client));
check('manual combine button sends imageModel', /origVolume:Number\(\$\('origVolume'\)\.value\),imageModel:\$\('imageModel'\)\.value/.test(src) || /origVolume:Number\(\$\('origVolume'\)\.value\),imageModel:\$\('imageModel'\)\.value[,}]/.test(client));
check('manual combine button sends clipUrls + narrationUrl (cross-instance audio/clips)', /imageModel:\$\('imageModel'\)\.value,clipUrls,narrationUrl\}/.test(client));

console.log('\n[4] storyboard frame count honours target ÷ clip');
// The user's exact selection must win: 1 min + 30s Wan clips = 2 videos, not 3.
check('no forced minimum of 3 frames', !/Math\.max\(3, Math\.ceil\(targetDuration \/ secPerFrame\)\)/.test(src));
check('generateStoryboard uses the helper', /const frameCount = storyboardFrameCount\(targetDuration, secPerFrame\)/.test(src));
check('1 min target + 30s clips → 2 frames', storyboardFrameCount(60, 30) === 2, 'got ' + storyboardFrameCount(60, 30));
check('30s target + 30s clips → 1 frame', storyboardFrameCount(30, 30) === 1, 'got ' + storyboardFrameCount(30, 30));
check('2 min target + 30s clips → 4 frames', storyboardFrameCount(120, 30) === 4, 'got ' + storyboardFrameCount(120, 30));
check('10 min target + 6s clips → 100 frames', storyboardFrameCount(600, 6) === 100, 'got ' + storyboardFrameCount(600, 6));
check('defaults still apply for bad input', storyboardFrameCount(0, 0) === 20, 'got ' + storyboardFrameCount(0, 0));
check('UI explains the shot math', /Shots = target duration ÷ clip duration/.test(client));

console.log('\n[5] wan renders never hit the 280s request timeout (two-phase /videos)');
// A wan clip renders 4-30 min — longer than any serverless request. The old sync
// path burned the whole budget and the client's "timed out (n/12) — retrying…"
// loop re-submitted a NEW paid render every retry, so long clips could never land.
check('novitaPollOnce helper exists', /async function novitaPollOnce\(marker\)/.test(src));
check('poll answers immediately (no blocking wait)', !/novitaPollOnce[\s\S]{0,400}while \(Date\.now\(\) < deadline\)/.test(src));
check('transient poll errors report PENDING, not failure', /client will poll again`\); return \{ status: 'PENDING' \}/.test(src));
check('/videos poll is never rejected as busy', /if \(!body\.pollTask && job\.phase !== 'idle'\) return sendJson\(res, 409, \{ error: 'busy' \}\);/.test(src));
check('credit gate skipped while polling (charged on submit only)', /if \(!body\.pollTask && \!\(await requireCredits\(req, res, vidCost, 'generate videos'\)\)\) return;/.test(src));
check('two-phase block only for novita models', /if \(isNovitaVideoModel\(vidModel\) && frames\[0\] && frames\[0\]\.animation_prompt\)/.test(src));
check('submit answers pending+task immediately', /return sendJson\(res, 202, \{ ok: true, pending: true, task, frame: f\.frame, model: vidModel \}\)/.test(src));
check('poll of a live task answers pending again', /return sendJson\(res, 202, \{ pending: true, task: body\.pollTask, status: st\.status \}\)/.test(src));
check('completion still saves the chain anchor', /chain anchor saved → next scene starts from its last frame/.test(src));
check('completion still hosts the clip for combine', /clipUrl = await uploadVideoClip\(videoFile\(f\.frame\)\)/.test(src));
check('wan3.0 start frame passed via imageUrls', /\.\.\.\(useImg \? \{ imageUrls: \[anchor\] \} : \{\}\)/.test(src));
check('client polls pending renders (45-min ceiling)', /while\(waited<2700000\)/.test(client));
check('client polls every 15s', /setTimeout\(r,15000\)\);\s*\r?\n\s*waited\+=15000;/.test(client));
check('client treats pending as keep-waiting, not failure', /if\(!j\|\|!j\.pending\)break;/.test(client) || /if\(j&&j\.pending\)continue;/.test(client));
check('client cancel still stops the poll loop', /if\(USER_CANCELLED\)throw new Error\('cancelled'\);/.test(client));
check('sync path kept for PaxSenix models', /PaxSenix models \(grok \/ omni-flash \/ veo\) render inside the 300s budget/.test(src));

console.log('\n[6] prompt-vocalized mode: narration rides inside the video prompts');
// Regression: "Prompt Vocalized" came out as a SILENT film. The spoken text was
// only ever embedded in the local /api/run-all pipeline — the manual Videos
// button and the client-driven auto pipeline rendered plain animation_prompts,
// so the video model never heard the narration and the clips had no vocals.
check('/api/videos embeds narration in prompt mode', /if \(body\.narrationMode === 'prompt'\) \{[\s\S]{0,400}?frames = vocalizeAnimationPrompts\(frames\)/.test(src));
check('/api/run-all uses the same helper', /videoFrames = vocalizeAnimationPrompts\(frames\)/.test(src));
check('no leftover inline embedding in run-all', !/clone\.animation_prompt = `\$\{clone\.animation_prompt\} The character narrates aloud/.test(src));
check('client auto pipeline sends narrationMode with /videos', /chainContinuity:opts\.chainContinuity,narrationMode:opts\.narrationMode/.test(client));
check('client Vercel per-frame render sends narrationMode', /chainAnchor:prevChain,narrationMode:\$\('narrationMode'\)\.value/.test(client));
check('client manual Videos button sends narrationMode', /postJob\('\/videos',sbPayload\(\{ratio:\$\('ratio'\)\.value,videoModel:\$\('videoModel'\)\.value,force:true,chainContinuity:\$\('chainContinuity'\)\.checked,narrationMode:\$\('narrationMode'\)\.value\}\)\)/.test(client));
// Behavioural: the helper embeds narration + dialogue, leaves speechless frames
// alone, and never double-embeds when a poll re-sends the same frames.
const vInput = [
  { frame: 1, narration: 'Once upon a time.', dialogue: 'Hello!', animation_prompt: 'slow push in' },
  { frame: 2, narration: '', dialogue: '', animation_prompt: 'slow pull out' },
];
const vFrames = vocalizeAnimationPrompts(vInput);
check('narration + dialogue embedded verbatim', /narrates aloud: "Once upon a time\.\. Hello!"/.test(vFrames[0].animation_prompt), vFrames[0].animation_prompt);
check('original motion prompt kept', vFrames[0].animation_prompt.startsWith('slow push in'));
check('frame without narration is untouched', vFrames[1].animation_prompt === 'slow pull out');
const vAgain = vocalizeAnimationPrompts(vFrames);
check('idempotent on re-render/poll retries', vAgain[0].animation_prompt === vFrames[0].animation_prompt);
check('original frame objects are not mutated', vInput[0].animation_prompt === 'slow push in');

console.log('\n' + (failures ? failures + ' FAILED' : 'all passed'));
process.exit(failures ? 1 : 0);
