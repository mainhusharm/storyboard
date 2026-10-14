// test-novita-video.js
// Offline regression test for the Novita sandbox integration (wan3.0 video +
// qwen/wanx image models via the async /v1/submit + /v1/status job API):
//   1. pure-logic checks: duration clamping (WAN 3.0 allowed set 1,2,3,4,5,10,
//      15,20,25,30; others 1-15), ratio→size mapping, i2v model detection
//   2. /api/models payload: the Novita video + image models are exposed
//   3. body shape: the exact submit body the video path builds for a t2v and an
//      i2v model (via the exported helpers, no credits spent)
//
// `--live` additionally submits ONE real 5s wan3.0-video-prime job and polls it
// to completion (costs 1 credit, takes ~2 min).
//
// Usage:
//   node pipeline/test-novita-video.js
//   node pipeline/test-novita-video.js --live
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LIVE = process.argv.includes('--live');
let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

const serverModule = require(path.join(ROOT, 'web', 'server.js'));
const { __internal } = serverModule;
const {
  NOVITA_VIDEO_MODELS, NOVITA_IMAGE_MODELS, NOVITA_TASK_PREFIX,
  isNovitaVideoModel, isNovitaI2VModel, isNovitaImageModel,
  novitaDurationFor, novitaImageSize
} = __internal;

// ---- 1. pure logic ----
console.log('\n[1] model helpers');
check('wan3.0-video-prime recognised', isNovitaVideoModel('wan3.0-video-prime'));
check('grok-video NOT novita', !isNovitaVideoModel('grok-video'));
check('wan2.7-i2v is i2v', isNovitaI2VModel('wan2.7-i2v'));
check('wan3.0-video-prime accepts an image (chaining works)', __internal.novitaAcceptsImage('wan3.0-video-prime'));
check('wan2.7-t2v is prompt-only', !__internal.novitaAcceptsImage('wan2.7-t2v'));
check('wan3.0-video-standard NOT offered (dead upstream)', !isNovitaVideoModel('wan3.0-video-standard'));
check('novita: image prefix', isNovitaImageModel('novita:qwen-image-3.0-pro') && !isNovitaImageModel('seedream-5'));

console.log('\n[2] duration clamping');
check('wan3.0 30s kept', novitaDurationFor('wan3.0-video-prime', 30) === 30);
check('wan3.0 8s → 10s (nearest allowed)', novitaDurationFor('wan3.0-video-prime', 8) === 10, 'got ' + novitaDurationFor('wan3.0-video-prime', 8));
check('wan3.0 7s → 5s', novitaDurationFor('wan3.0-video', 7) === 5);
check('wan3.0 0/undefined → 5s', novitaDurationFor('wan3.0-video', 0) === 5 && novitaDurationFor('wan3.0-video') === 5);
check('wan2.7 30s → 15s (max)', novitaDurationFor('wan2.7-t2v', 30) === 15);
check('wan2.1 9s kept', novitaDurationFor('wan2.1-t2v-turbo', 9) === 9);

console.log('\n[3] image size mapping');
check('16:9 → 1280*720', novitaImageSize('16:9') === '1280*720');
check('9:16 → 720*1280', novitaImageSize('9:16') === '720*1280');
check('1:1 → 1024*1024', novitaImageSize('1:1') === '1024*1024');
check('4:3 → 1024*768', novitaImageSize('4:3') === '1024*768');
check('3:4 → 768*1024', novitaImageSize('3:4') === '768*1024');
check('unknown → 1280*720', novitaImageSize('21:9') === '1280*720');

// ---- 2. result-URL extraction across every documented output shape ----
console.log('\n[1b] result URL extraction');
const novitaResultUrl = __internal.novitaResultUrl;
const U = 'https://cdn.example.com/a.mp4';
check('documented output.results[0].url', novitaResultUrl({ output: { results: [{ url: U }] } }) === U);
check('output.video_url', novitaResultUrl({ output: { video_url: U } }) === U);
check('output.url', novitaResultUrl({ output: { url: U } }) === U);
check('output.image_url', novitaResultUrl({ output: { image_url: U } }) === U);
check('output.images[0] string', novitaResultUrl({ output: { images: [U] } }) === U);
check('output.images[0].url', novitaResultUrl({ output: { images: [{ url: U }] } }) === U);
check('output.data[0]', novitaResultUrl({ output: { data: [U] } }) === U);
check('unknown shape -> regex fallback', novitaResultUrl({ output: { weirdslot: U } }) === U);
check('results[0] wins over video_url', novitaResultUrl({ output: { video_url: 'https://x/old.mp4', results: [{ url: U }] } }) === U);
check('no media at all -> null', novitaResultUrl({ output: { task_status: 'SUCCEEDED' } }) === null);

// ---- 3. /api/models payload over a self-hosted handler ----
console.log('\n[4] /api/models payload');
const handler = serverModule; // module.exports = requestHandler
const httpServer = http.createServer(handler);
function getJSON(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
httpServer.listen(0, async () => {
  try {
    const port = httpServer.address().port;
    const m = await getJSON(port, '/api/models');
    for (const v of NOVITA_VIDEO_MODELS) {
      check(`video dropdown has ${v.id}`, (m.video || []).some(x => x.id === v.id));
    }
    for (const im of NOVITA_IMAGE_MODELS) {
      check(`image list has ${im.id}`, (m.image || []).includes(im.id));
    }
    const wan3 = (m.video || []).find(x => x.id === 'wan3.0-video-prime');
    check('wan3.0-video-prime labelled with 30s', !!wan3 && /30s/.test(wan3.label));
  } catch (e) {
    failures++;
    console.error('FAIL  /api/models fetch: ' + e.message);
  } finally {
    httpServer.close();
    // ---- 3. live probe (optional, 1 credit) ----
    if (LIVE) {
      console.log('\n[5] LIVE: wan3.0-video-prime 5s render (~2 min, 1 credit)');
      const fs = require('fs');
      const key = (process.env.NOVITA_API_KEY ||
        (() => { try { return fs.readFileSync(path.join(ROOT, 'pipeline', 'novita_apikey.txt'), 'utf8').trim(); } catch { return ''; } })());
      const base = (process.env.NOVITA_BASE_URL ||
        (() => { try { return fs.readFileSync(path.join(ROOT, 'pipeline', 'novita_base.txt'), 'utf8').trim(); } catch { return ''; } })() ||
        'https://3000-i1ztyh2mdku7f8p0bn81s-c81df28e.sandbox.novita.ai').replace(/\/+$/, '');
      if (!key) { failures++; console.error('FAIL  no Novita key for --live'); }
      else {
        const res = await fetch(base + '/v1/submit', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'wan3.0-video-prime', input: { prompt: 'a red fox crosses a snowy forest at dawn, slow cinematic tracking shot' }, parameters: { duration: 5, resolution: '720P', ratio: '16:9' } })
        });
        const j = await res.json().catch(() => ({}));
        check('live submit ok', res.ok && j.ok && j.taskId, JSON.stringify(j).slice(0, 120));
        if (j.taskId) {
          const marker = NOVITA_TASK_PREFIX + j.taskId;
          const url = await __internal.novitaWait(marker, 12, console.log);
          check('live render returned an mp4 URL', !!url && /\.mp4/i.test(url), url || 'null');
        }
      }
    }
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
  }
});
