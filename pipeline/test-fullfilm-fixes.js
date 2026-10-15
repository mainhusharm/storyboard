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

const { storyboardFrameCount, emergencyImageChain, isLogfareImageModel } =
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
check('/api/combine (vercel) threads imageModel', /const fp = await combineFilm\(frames, body\.ratio \|\| '16:9', body\.narrationMode, \{ narrVol: body\.narrVolume, origVol: body\.origVolume, clipUrls: body\.clipUrls, imageModel: body\.imageModel \}\)/.test(src));
check('/api/combine (vercel) still hosts the finished film (remote fix kept)', /final film hosted: \$\{finalUrl\}/.test(src));
check('/api/combine (local) threads imageModel', /combineFilm\(frames, body\.ratio \|\| '16:9', body\.narrationMode, \{ narrVol: body\.narrVolume, origVol: body\.origVolume, clipUrls: body\.clipUrls, imageModel: body\.imageModel \}\)\.then/.test(src));
check('auto pipeline combine sends imageModel', /origVolume:opts\.origVolume,clipUrls,imageModel:opts\.imageModel/.test(client));
check('manual combine button sends imageModel', /origVolume:Number\(\$\('origVolume'\)\.value\),imageModel:\$\('imageModel'\)\.value/.test(src) || /origVolume:Number\(\$\('origVolume'\)\.value\),imageModel:\$\('imageModel'\)\.value\}/.test(client));

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

console.log('\n' + (failures ? failures + ' FAILED' : 'all passed'));
process.exit(failures ? 1 : 0);
