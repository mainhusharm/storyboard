// test-combine-audio.js
// Regression: "after the video gets combined, audio is not coming".
//
// Two bugs caused a silent final film:
//   1. combineFilm probed the clips' audio with raw `execFile('ffprobe', …)`.
//      ffprobe is NOT on PATH in Vercel's runtime (and can be missing locally),
//      so the probe always resolved "no audio" and every clip was re-encoded with
//      a SILENT audio track — replacing the real clip audio (veo/omni generate
//      sound). Fix: probeHasAudio()/probeDuration() via ffmpegBin() (ffmpeg-static).
//   2. The narration track (full_narration.mp3) lives in the /tmp of the instance
//      that ran the narration step. A combine on another instance found no audio
//      and no sig file, so the voice track was silently dropped. Fix: the client
//      passes the hosted `narrationUrl`; combine recovers the track from it.
//
// The test self-hosts the handler in Vercel mode (like test-vercel-video.js) with
// PATH stripped so bare `ffprobe` resolves to nothing — exactly the serverless
// situation — and asserts the combined film still contains audible audio.
//
// Usage: node pipeline/test-combine-audio.js
// Outputs land in /tmp/video (Vercel mode) — the project's own frames/ + video/
// are untouched.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = require(path.join(ROOT, 'node_modules', 'ffmpeg-static'));
const RESPONSE_TIMEOUT_MS = 420000; // combine + optional catbox/uguu upload of the finished film

// ---- build the fixture clips FIRST (uses PATH ffmpeg), then strip PATH so the
// server runs exactly like Vercel: only the ffmpeg-static binary is resolvable,
// bare `ffprobe` resolves to nothing. ----
const TMP = path.join('/tmp');
const TMP_VIDEO = path.join(TMP, 'video');
fs.mkdirSync(TMP_VIDEO, { recursive: true });

function ff(args) {
  const r = spawnSync(FFMPEG, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${String(r.stderr || '').slice(-200)}`);
}
// ffmpeg writes stream info to stderr even on success — capture it via spawnSync.
function ffOut(args) {
  const r = spawnSync(FFMPEG, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  return String(r.stderr || '') + String(r.stdout || '');
}
// 2s clip WITH an audible tone as its audio track (24fps, 640x360).
function makeClip(outPath, freq) {
  ff(['-y',
    '-f', 'lavfi', '-i', `testsrc=size=640x360:rate=24:duration=2`,
    '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=2`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
    '-shortest', outPath]);
}
const clip1 = path.join(TMP_VIDEO, 'frame_01.mp4');
const clip2 = path.join(TMP_VIDEO, 'frame_02.mp4');
makeClip(clip1, 440);
makeClip(clip2, 660);
// narration voice stand-in (audible tone), served over local http
const narrPath = path.join(TMP, 'test_narration.mp3');
ff(['-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-c:a', 'libmp3lame', '-b:a', '128k', narrPath]);
console.log('fixtures: 2 clips with audio + narration.mp3 built');

// Strip PATH AFTER building fixtures — the server must not find bare ffprobe.
process.env.PATH = path.dirname(FFMPEG); // only the ffmpeg-static dir (has ffmpeg.exe, NO ffprobe.exe)

// ---- Vercel-mode env BEFORE requiring the server ----
process.env.VERCEL = '1';
process.env.PORT = '0';

const handler = require(path.join(ROOT, 'web', 'server'));

function probeHasAudioAbs(p) {
  return /Audio:/.test(ffOut(['-i', p]));
}
function meanVolume(p) {
  const m = /mean_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(ffOut(['-i', p, '-af', 'volumedetect', '-f', 'null', '-']));
  return m ? parseFloat(m[1]) : -99;
}

async function req(base, method, p, body, cookie) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers['Cookie'] = cookie;
  const res = await fetch(`${base}${p}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(RESPONSE_TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text: text.slice(0, 400), headers: res.headers };
}

let failed = 0;
function check(name, cond) {
  console.log(`  ${cond ? 'ok ' : 'FAIL'}  ${name}`);
  if (!cond) failed++;
}

(async () => {
  // tiny http server for the hosted narration track (stands in for catbox)
  const narrSrv = http.createServer((rq, rs) => {
    rs.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    rs.end(fs.readFileSync(narrPath));
  });
  await new Promise(r => narrSrv.listen(0, '127.0.0.1', r));
  const narrUrl = `http://127.0.0.1:${narrSrv.address().port}/narration.mp3`;

  const srv = http.createServer(handler);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  console.log(`\n=== combine audio regression (VERCEL=1, PATH stripped — bare ffprobe unavailable) ===`);
  console.log(`self-hosted handler on ${base}`);

  // signup → session cookie
  const email = `audiotest${Date.now()}@x.com`;
  const su = await req(base, 'POST', '/api/_route?p=/api/auth/signup', { email, name: 'AudioTest', password: 'secret123' });
  const sc = su.headers.get('set-cookie');
  const cookie = sc ? sc.split(';')[0] : null;
  if (!cookie) { console.log('FAIL: no session cookie. body:', su.text); process.exit(1); }

  const framesData = [
    { frame: 1, scene: 1, duration_sec: 2, summary: 'test scene one', narration: 'Once upon a time.', dialogue: '', animation_prompt: 'slow push in', image_prompt: 'test', characters_present: [] },
    { frame: 2, scene: 2, duration_sec: 2, summary: 'test scene two', narration: 'And then it ended.', dialogue: '', animation_prompt: 'slow pull out', image_prompt: 'test', characters_present: [] },
  ];

  // ---- scenario A: no narration anywhere — the clips' OWN audio must survive ----
  console.log('\n[A] combine with clips that have real audio (no narration)');
  const a = await req(base, 'POST', '/api/_route?p=/api/combine', {
    framesData, ratio: '16:9', narrationMode: 'tts', narrationUrl: '',
  }, cookie);
  check('combine answers ok', !!(a.json && a.json.ok));
  const finalPath = path.join(TMP_VIDEO, 'final_story.mp4');
  check('final_story.mp4 exists', fs.existsSync(finalPath));
  const finalHasAudio = probeHasAudioAbs(finalPath);
  check('final film has an audio stream', finalHasAudio);
  const vol = meanVolume(finalPath);
  check(`final film audio is NOT silence (mean ${vol} dB > -60)`, vol > -60);

  // ---- scenario B: narration was rendered on ANOTHER instance (only its hosted
  // URL is known) — combine must recover it and overlay the voice track ----
  console.log('\n[B] combine with cross-instance narration URL');
  try { fs.unlinkSync(path.join(TMP_VIDEO, 'full_narration.mp3')); } catch {}
  const b = await req(base, 'POST', '/api/_route?p=/api/combine', {
    framesData, ratio: '16:9', narrationMode: 'tts', narrationUrl: narrUrl,
  }, cookie);
  check('combine answers ok', !!(b.json && b.json.ok));
  check('final film still has an audio stream', probeHasAudioAbs(finalPath));
  const st = await req(base, 'GET', '/api/_route?p=/api/status', null, cookie);
  const logLines = (st.json && st.json.log) || [];
  check('combine recovered narration from the hosted URL', logLines.some(l => /recovering from hosted URL/.test(l)));
  check('narration voice track was overlaid', logLines.some(l => /re-overlaying voice track/.test(l)));

  // ---- scenario C: prompt-vocalized mode — the clips carry the VOICE themselves
  // (the video model spoke the narration into the clip). Combine must pass that
  // audio through untouched and must NOT mix in any separate TTS track — not even
  // a stale hosted narrationUrl left over from a previous TTS run (the user's
  // "Prompt Vocalized selection gives a silent video" report).
  console.log('\n[C] prompt-vocalized mode: the clips\' own vocal audio must survive combine');
  const c = await req(base, 'POST', '/api/_route?p=/api/combine', {
    framesData, ratio: '16:9', narrationMode: 'prompt', narrationUrl: narrUrl,
  }, cookie);
  check('combine answers ok', !!(c.json && c.json.ok));
  check('final film still has an audio stream', probeHasAudioAbs(finalPath));
  const cvol = meanVolume(finalPath);
  check(`final film vocals are NOT silence (mean ${cvol} dB > -60)`, cvol > -60);
  const st2 = await req(base, 'GET', '/api/_route?p=/api/status', null, cookie);
  const logC = (st2.json && st2.json.log) || [];
  check('prompt mode never overlays a separate narration track', !logC.some(l => /re-overlaying voice track/.test(l)));
  check('prompt mode never pulls in a stale hosted narration', !logC.some(l => /recovering from hosted URL/.test(l)));

  narrSrv.close();
  srv.close();
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('harness crash:', e); process.exit(1); });
