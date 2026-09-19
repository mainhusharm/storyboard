// test-logfare-models.js
// Regression test for the Logfare media integration:
//   • the image models (flux-2-klein-9b / lucid-origin / phoenix-1.0) reach the
//     model pickers, i.e. /api/models lists them AND the server recognises them;
//   • Logfare renders are square, so every image is centre-cropped to the frame
//     ratio before it is stored (16:9 → 1024x576, 9:16 → 576x1024, 1:1 → as-is);
//   • a Logfare render is handed back as an already-finished local file behind
//     the `logfare-local:` marker (there is no task to poll);
//   • Deepgram Aura-2 (aura-2-en) is offered as a narration engine next to Fish
//     Audio and MIMO, with a speaker per voice dropdown option.
//
// Default run is OFFLINE (no network, no credits): it exercises the model lists,
// the crop filter with a synthetic image and the /api/models payload.
// Pass --live to additionally render one image per model and one TTS chunk.
//
// Usage:
//   node pipeline/test-logfare-models.js
//   node pipeline/test-logfare-models.js --live
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
process.env.PORT = '0'; // don't collide with a running dev server

const server = require(path.join(ROOT, 'web', 'server'));
const T = server.__internal;
const ffmpeg = require('ffmpeg-static');

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

const WANT_IMAGES = ['flux-2-klein-9b', 'lucid-origin', 'phoenix-1.0'];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-test-'));

function ffmpegRun(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, args, { timeout: 60000 }, e => (e ? reject(e) : resolve()));
  });
}
function dims(file) {
  return new Promise((resolve) => {
    execFile(ffmpeg, ['-i', file], (e, so, se) => {
      const m = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(se || '');
      resolve(m ? `${m[1]}x${m[2]}` : '?');
    });
  });
}

(async () => {
  console.log('\n=== model registry ===');
  for (const m of WANT_IMAGES) {
    check(`${m} is a Logfare image model`, T.isLogfareImageModel(m) === true);
  }
  check('PaxSenix models are not mistaken for Logfare ones',
    T.isLogfareImageModel('nano-banana-pro') === false && T.isLogfareImageModel('seedream-5') === false);
  check('a Logfare render is marked as an already-finished local file',
    T.isLogfareLocal(T.LOGFARE_LOCAL_PREFIX + '/tmp/x.png') && !T.isLogfareLocal('https://x/y.png'));

  console.log('\n=== narration engines ===');
  const engineIds = T.narrationEngines.map(e => e.id);
  check('fish stays the default engine', engineIds[0] === 'fish');
  check('mimo still offered', engineIds.includes('mimo'));
  check('logfare (Deepgram Aura-2) offered', engineIds.includes('logfare'), engineIds.join(', '));
  check('aura-2-en is the TTS model', T.LOGFARE_TTS_MODEL === 'aura-2-en');
  check('both voice options map to an Aura-2 speaker',
    !!T.LOGFARE_TTS_VOICES.female && !!T.LOGFARE_TTS_VOICES.male,
    JSON.stringify(T.LOGFARE_TTS_VOICES));

  console.log('\n=== /api/models payload (what the pickers render) ===');
  const srv = http.createServer(server);
  await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const r = await fetch(base + '/api/models');
    const j = await r.json().catch(() => ({}));
    check('/api/models responds', r.ok, 'HTTP ' + r.status);
    for (const m of WANT_IMAGES) check(`picker list contains ${m}`, Array.isArray(j.image) && j.image.includes(m));
    check('narration engine list served to the UI contains logfare',
      Array.isArray(j.narrationEngines) && j.narrationEngines.some(e => e.id === 'logfare'));
    check('existing PaxSenix image models kept',
      Array.isArray(j.image) && j.image.includes('nano-banana-pro') && j.image.includes('seedream-5'));
  } catch (e) { check('/api/models responds', false, e.message); }
  finally { srv.close(); }

  console.log('\n=== square → ratio crop ===');
  const square = path.join(tmp, 'square.png');
  await ffmpegRun(['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=1024x1024', '-frames:v', '1', square]);
  check('test image is 1024x1024', (await dims(square)) === '1024x1024');
  for (const [ratio, want] of [['16:9', '1024x576'], ['9:16', '576x1024'], ['1:1', '1024x1024'], ['4:3', '1024x768']]) {
    // A square source must come out at exactly the target shape.
    const out = path.join(tmp, `out_${ratio.replace(':', '_')}.png`);
    await T.cropToRatio(square, ratio, out);
    check(`ratio ${ratio} → ${want}`, (await dims(out)) === want, await dims(out));
  }

  if (process.argv.includes('--live')) {
    console.log('\n=== live Logfare renders (costs a few credits) ===');
    // Some Logfare models already answer in the requested ratio (Leonardo's
    // lucid-origin returns 1120x630) and some are square; either way the stored
    // frame must match the requested ratio, so compare the SHAPE, not the size.
    const shape = (d) => { const [w, h] = d.split('x').map(Number); return w / h; };
    for (const m of WANT_IMAGES) {
      try {
        const file = await T.generateLogfareImage(m, 'a single blue ceramic vase on a white table', '16:9');
        const d = await dims(file);
        check(`${m} renders at 16:9`, fs.existsSync(file) && Math.abs(shape(d) - 16 / 9) < 0.02, d);
        fs.unlinkSync(file);
      } catch (e) { check(`${m} renders at 16:9`, false, e.message); }
    }
    const chunk = path.join(tmp, 'aura.mp3');
    const ok = await T.logfareTtsChunk(chunk, 'This is a narration test for the Logfare Aura 2 engine.', 'female');
    check('aura-2-en returns mp3 audio', ok && fs.existsSync(chunk) && fs.statSync(chunk).size > 1000,
      fs.existsSync(chunk) ? fs.statSync(chunk).size + ' bytes' : 'no file');
  } else {
    console.log('\n(skipping live renders — pass --live to exercise the paid calls)');
  }

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
})();
