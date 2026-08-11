// test-vercel-video.js
// Exercises the Vercel per-frame video path end-to-end:
//   POST /api/videos with frames:[n] + inline framesData + a dead image URL
//   (forces the re-host path) and verifies the rendered mp4 lands in the
//   Vercel-mode output dir (/tmp/video).
//
// Because web/server.js only calls listen() when NOT in Vercel mode (on real
// Vercel the platform invokes the handler directly), this script self-hosts the
// handler in-process with VERCEL=1 so the exact production code path runs.
//
// Usage:
//   node pipeline/test-vercel-video.js [frameNumber] [model] [chain]
//   e.g. node pipeline/test-vercel-video.js 6 grok-video
//        node pipeline/test-vercel-video.js 6 grok-video chain
//
// Requires: pipeline/apikey.txt (PaxSenix key) and frames/frame_NN.png present.
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FRAME_N = Number(process.argv[2] || 6);
const MODEL = process.argv[3] || 'grok-video';
const CHAIN = process.argv[4] === 'chain';
const RESPONSE_TIMEOUT_MS = 340000; // render must answer within Vercel's ~250s budget + margin

// ---- set Vercel-mode env BEFORE requiring the server ----
process.env.VERCEL = '1';
process.env.PORT = '0';
if (!process.env.PAXSENIX_API_KEY) {
  process.env.PAXSENIX_API_KEY = fs.readFileSync(path.join(ROOT, 'pipeline', 'apikey.txt'), 'utf8').trim();
}

// Pre-copy the frame PNG into the /tmp path NODE resolves (path.join('/tmp') on
// Windows = C:\tmp while Git Bash /tmp is the user Temp dir — on Linux Vercel
// they are the same). This makes the local test faithful to production.
function prepTmp(frameN) {
  const pad = String(frameN).padStart(2, '0');
  const src = path.join(ROOT, 'frames', `frame_${pad}.png`);
  const tmpFrames = path.join('/tmp', 'frames');
  fs.mkdirSync(tmpFrames, { recursive: true });
  fs.mkdirSync(path.join('/tmp', 'video'), { recursive: true });
  fs.copyFileSync(src, path.join(tmpFrames, `frame_${pad}.png`));
  console.log(`prepped ${path.join(tmpFrames, `frame_${pad}.png`)}`);
}

const handler = require(path.join(ROOT, 'web', 'server'));

function loadFrame(n) {
  const frames = JSON.parse(fs.readFileSync(path.join(ROOT, 'storyboard', 'frames.json'), 'utf8'));
  const f = frames.find(x => x.frame === n);
  if (!f) throw new Error(`frame ${n} not found in storyboard/frames.json`);
  return f;
}

async function req(base, method, p, body, cookie) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers['Cookie'] = cookie;
  const res = await fetch(`${base}${p}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(RESPONSE_TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text: text.slice(0, 400), headers: res.headers };
}

(async () => {
  prepTmp(FRAME_N);
  // ---- self-host the handler exactly like Vercel does ----
  const srv = http.createServer(handler);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  const frame = loadFrame(FRAME_N);
  console.log(`\n=== Vercel per-frame video test ===`);
  console.log(`self-hosted handler on ${base}  (VERCEL=1, ROOT=/tmp)`);
  console.log(`frame: ${FRAME_N}  model: ${MODEL}`);

  // 1) signup → session cookie
  const email = `vtest${Date.now()}@x.com`;
  const su = await req(base, 'POST', '/api/_route?p=/api/auth/signup', { email, name: 'VTest', password: 'secret123' });
  const sc = su.headers.get('set-cookie');
  const cookie = sc ? sc.split(';')[0] : null;
  if (!cookie) { console.log('FAIL: no session cookie. body:', su.text); process.exit(1); }
  console.log(`auth: cookie obtained (signup HTTP ${su.status})`);

  // 2) force the re-host path: point the stored image URL at a dead host
  frame.generated_image_url = 'https://expired.invalid/frame_dead.png';

  // 3) per-frame videos request — exactly what the Vercel client loop sends
  console.log(`\nPOST /api/videos frames:[${FRAME_N}] (inline framesData, dead image URL, no chaining)…`);
  const t0 = Date.now();
  const r = await req(base, 'POST', '/api/_route?p=/api/videos', {
    frames: [FRAME_N],
    framesData: [frame],
    ratio: '16:9',
    videoModel: MODEL,
    force: true,
    chainContinuity: CHAIN,
  }, cookie);
  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`response: HTTP ${r.status} after ${elapsed}s`);
  if (r.json) {
    const out = { ok: r.json.ok, failed: r.json.failed, error: r.json.error, frame: r.json.frame ? {
      frame: r.json.frame.frame,
      video_path: r.json.frame.video_path || null,
      video_url: r.json.frame.video_url ? r.json.frame.video_url.slice(0, 90) : null,
      chain_image_url: r.json.frame.chain_image_url ? r.json.frame.chain_image_url.slice(0, 90) : null,
    } : null };
    console.log('result:', JSON.stringify(out, null, 2));
  } else {
    console.log('raw:', r.text);
  }

  // 4) verify the mp4 landed in the Vercel-mode output dir
  const vid = path.join('/tmp', 'video', `frame_${String(FRAME_N).padStart(2, '0')}.mp4`);
  if (fs.existsSync(vid)) {
    const st = fs.statSync(vid);
    console.log(`\n✓ ${vid} exists (${(st.size / 1024 / 1024).toFixed(1)} MB)`);
  } else {
    console.log(`\n✗ ${vid} NOT found — render did not complete`);
  }

  // 4b) chaining: the extracted chain anchor PNG must exist + be returned on the frame
  if (CHAIN) {
    const chainPng = path.join('/tmp', 'frames', `chain_${String(FRAME_N).padStart(2, '0')}.png`);
    if (fs.existsSync(chainPng)) {
      console.log(`✓ ${chainPng} exists (${(fs.statSync(chainPng).size / 1024).toFixed(0)} KB) — next scene can start from this frame`);
    } else {
      console.log(`✗ ${chainPng} NOT found — chain anchor extraction failed`);
    }
  }

  // 5) asset serving through the /api/_route?p= rewrite (mirrors vercel.json)
  const assets = [
    ['frames rewrite', `/api/_route?p=/frames/frame_${String(FRAME_N).padStart(2, '0')}.png`],
    ['video rewrite ', `/api/_route?p=/video/frame_${String(FRAME_N).padStart(2, '0')}.mp4`],
  ];
  for (const [label, p] of assets) {
    try {
      const a = await req(base, 'GET', p);
      console.log(`${label}: HTTP ${a.status} (${a.headers.get('content-type') || '?'})`);
    } catch (e) { console.log(`${label}: ${e.message}`); }
  }

  srv.close();
  console.log('\n=== done ===');
  process.exit(r.json && r.json.ok && fs.existsSync(vid) ? 0 : 1);
})().catch(e => { console.log('TEST CRASH:', e.message); process.exit(1); });
