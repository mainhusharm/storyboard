// Offline provider regressions. Runs the actual Vercel handler with mocked
// upstreams and an isolated filesystem; no real credentials or paid calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-providers-'));
const serverFile = path.join(root, 'web/server.js');
const source = fs.readFileSync(serverFile, 'utf8');
const client = fs.readFileSync(path.join(root, 'web/public/storyboard.html'), 'utf8');
let imageCalls = 0, submits = 0, imageMode = 'filtered', failUploads = false;
let forceCopyFailure = false, forceConcatFailure = false, fallbackCount = 0;
let statusCode = 200, statusBody = { status: 'RUNNING' };
let png, clip, submitted;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
async function upstream(url, options = {}) {
  url = String(url);
  if (url.endsWith('/images/generations') || url.endsWith('/images/edits')) {
    imageCalls++;
    if (imageMode === 'filtered') return json({ error: { message: JSON.stringify({
      errors: [{ message: 'AiError: Your output has been flagged.', code: 3030 }], success: false
    }) } }, 400);
    return json({ data: [{ b64_json: png.toString('base64') }] });
  }
  if (url.endsWith('/v1/submit')) {
    submits++; submitted = JSON.parse(options.body);
    return json({ ok: true, taskId: 'test-task', status: 'PENDING' });
  }
  if (url.includes('/v1/status/')) return json(statusBody, statusCode);
  if (url === 'https://cdn.example.test/clip.mp4') return new Response(clip);
  if (url === 'https://cdn.example.test/still.png') return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  if (url === 'https://catbox.moe/user/api.php') {
    if (failUploads) return new Response('upload unavailable', { status: 503 });
    const file = options.body.get('fileToUpload');
    return new Response('https://cdn.example.test/' + (file.type.startsWith('video/') ? 'clip.mp4' : 'still.png'));
  }
  if (url === 'https://uguu.se/upload' && failUploads) return json({ success: false }, 503);
  throw new Error('Unexpected upstream request: ' + url);
}

const mod = { exports: {} };
const serverRequire = createRequire(serverFile);
function isolatedRequire(name) {
  if (name !== 'child_process') return serverRequire(name);
  const childProcess = serverRequire(name);
  return { ...childProcess, execFile(file, args, opts, callback) {
    if (args.includes('concat')) {
      if (forceConcatFailure || (forceCopyFailure && args.includes('copy'))) {
        forceCopyFailure = false;
        return setImmediate(() => callback(new Error('simulated concat failure')));
      }
      if (!args.includes('copy')) {
        fallbackCount++;
        assert.ok(fs.existsSync(path.join(tmp, 'video/concat_list.txt')), 'fallback still needs the concat manifest');
      }
    }
    return childProcess.execFile(file, args, opts, callback);
  } };
}
vm.runInNewContext(source.replace("const ROOT = IS_VERCEL ? '/tmp' : path.resolve(__dirname, '..');", `const ROOT = ${JSON.stringify(tmp)};`), {
  module: mod, exports: mod.exports, require: isolatedRequire, __dirname: path.dirname(serverFile),
  process: { env: { VERCEL: '1', NOVITA_API_KEY: 'fake', NOVITA_BASE_URL: 'https://novita.example.test',
    LOGFARE_API_KEY: 'fake', SESSION_SECRET: 'offline-test-session-secret' } },
  Buffer, URL, fetch: upstream, AbortController, AbortSignal, Blob, FormData,
  setTimeout, clearTimeout, setInterval, clearInterval, console
}, { filename: serverFile });
const handler = mod.exports;
const T = handler.__internal;
const srv = http.createServer(handler);

async function main() {
  const ffmpeg = require('ffmpeg-static');
  const pngPath = path.join(tmp, 'fixture.png');
  const clipPath = path.join(tmp, 'fixture.mp4');
  execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64', '-frames:v', '1', pngPath], { stdio: 'ignore' });
  execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clipPath], { stdio: 'ignore' });
  png = fs.readFileSync(pngPath); clip = fs.readFileSync(clipPath);

  assert.equal(T.logfareImageError({ errors: [{ code: 3030, message: 'flagged' }] }, 200).permanent, true);
  assert.equal(T.logfareImageError({ error: { message: 'rate limit' } }, 429).permanent, false);
  assert.equal(T.logfareImageError({ error: { message: 'bad key' } }, 401).permanent, true);
  assert.equal(T.novitaPollResult({ status: 'RUNNING', output: { task_status: 'SUCCEEDED', video_url: 'https://cdn.example.test/clip.mp4' } }).url, 'https://cdn.example.test/clip.mp4');
  assert.equal(T.novitaPollResult({ status: 'COMPLETED', output: {} }).failed, true);
  assert.equal(T.novitaPollResult({ error: 'expired key' }, 401).failed, true);
  assert.equal(T.novitaPollResult({}, 503).failed, false);
  assert.equal(T.novitaPollResult({}, 200).failed, true);
  console.log('ok: nested image errors and terminal/transient Wan status classification');

  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  let cookie = '';
  async function api(endpoint, body) {
    const res = await fetch(base + '/api' + endpoint, {
      method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    return { status: res.status, body: await res.json() };
  }
  assert.equal((await api('/auth/signup', { email: 'offline@example.test', password: 'secret123', name: 'Offline' })).status, 200);
  const frame = { frame: 1, duration_sec: 1, image_prompt: 'A blue ceramic vase on a table', animation_prompt: 'Slow camera push-in', narration: 'A quiet morning.' };
  let result = await api('/images', { frames: [1], framesData: [frame], characters: [], imageModel: 'flux-2-klein-9b' });
  assert.equal(result.body.ok, false);
  assert.equal(result.body.errors[0].code, 'IMAGE_CONTENT_FILTERED');
  assert.equal(imageCalls, 1, 'filter rejections must not trigger duplicate submissions or silent prompt changes');
  console.log('ok: actual /images reports 3030 once, including the frame and actionable error');

  imageMode = 'success';
  result = await api('/images', { frames: [1], framesData: [result.body.frames[0]], characters: [], imageModel: 'flux-2-klein-9b', ratio: '16:9' });
  assert.equal(result.body.ok, true, JSON.stringify(result.body));
  assert.equal(result.body.frames[0].generated_image_url, 'https://cdn.example.test/still.png');
  assert.equal(result.body.frames[0].image_error, undefined);
  assert.ok(fs.existsSync(path.join(tmp, 'frames/frame_01.png')));
  console.log('ok: successful Flux still is hosted and returned inline, clearing the previous error');

  const videoBody = { frames: [2], framesData: [{ ...frame, frame: 2 }], characters: [],
    videoModel: 'wan3.0-video-prime', narrationMode: 'prompt', chainContinuity: false };
  result = await api('/videos', videoBody);
  assert.equal(result.status, 202);
  assert.equal(result.body.pending, true);
  assert.ok(submitted.input.prompt.startsWith(frame.animation_prompt));
  assert.ok(submitted.input.prompt.includes('The character narrates aloud: "A quiet morning."'), 'Wan receives the narration inside the prompt');
  const pollBody = { ...videoBody, pollTask: result.body.task, force: true };
  const existingClip = path.join(tmp, 'video/frame_02.mp4');
  fs.writeFileSync(existingClip, clip);
  const before = (await api('/credits')).body.credits;
  for (let i = 0; i < 2; i++) {
    result = await api('/videos', pollBody);
    assert.equal(result.body.pending, true);
    assert.ok(fs.existsSync(existingClip), 'polls must never purge an existing video');
  }
  assert.equal((await api('/credits')).body.credits, before, 'polls are free');
  assert.equal(submits, 1, 'polls never submit another paid render');
  const log = (await api('/status')).body.log.join('\n');
  assert.equal(log.split('prompt-vocalized mode').length-1, 1, 'narration is embedded on submit only, never repeated on polls');
  statusBody = { status: 'SUCCEEDED', output: { results: [{ url: 'https://cdn.example.test/clip.mp4' }] } };
  result = await api('/videos', pollBody);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.clipUrl, 'https://cdn.example.test/clip.mp4');
  assert.equal(result.body.frame.frame, 2);
  console.log('ok: submit → repeated free polls → hosted clip; no narration spam or forced deletion');

  statusCode = 401; statusBody = { error: 'invalid provider key' };
  result = await api('/videos', pollBody);
  assert.equal(result.body.ok, false);
  assert.match(result.body.error, /HTTP 401/);
  assert.equal(result.body.pending, undefined);
  statusCode = 200; statusBody = { status: 'SUCCEEDED', output: {} };
  result = await api('/videos', pollBody);
  assert.equal(result.body.ok, false);
  assert.match(result.body.error, /without a media URL/);
  assert.equal(submits, 1);
  console.log('ok: authentication failure and missing completed asset stop polling without resubmission');

  const i2vFrame = { ...frame, frame: 5, dialogue: 'Hello there.', generated_image_url: 'https://cdn.example.test/still.png' };
  result = await api('/videos', { ...videoBody, frames: [5], framesData: [i2vFrame], videoModel: 'wan2.7-i2v' });
  assert.equal(result.status, 202);
  assert.equal(submitted.imageUrls[0], i2vFrame.generated_image_url, 'the image anchor is kept with prompt vocalization');
  assert.ok(submitted.input.prompt.includes('A quiet morning.. Hello there.'), 'narration and dialogue both reach the I2V model');
  assert.equal(submitted.parameters.generate_audio, undefined, 'prompt vocalization needs no extra audio parameters');
  assert.equal(submits, 2);
  console.log('ok: Wan T2V and I2V receive spoken text directly in the prompt without changing image anchors');

  const combineBody = { framesData: [{ ...frame, frame: 3, clip_url: 'https://cdn.example.test/clip.mp4' },
    { ...frame, frame: 4, clip_url: 'https://cdn.example.test/clip.mp4' }], narrationMode: 'prompt' };
  forceCopyFailure = true;
  result = await api('/combine', combineBody);
  assert.equal(result.body.ok, true, JSON.stringify(result.body));
  assert.equal(result.body.finalUrl, 'https://cdn.example.test/clip.mp4');
  assert.equal(fallbackCount, 1, 'copy failure must successfully re-encode using the retained manifest');
  assert.ok(fs.statSync(path.join(tmp, 'video/final_story.mp4')).size > 0);
  assert.equal(fs.existsSync(path.join(tmp, 'video/concat_list.txt')), false, 'manifest is cleaned up after both attempts');
  failUploads = true;
  result = await api('/combine', combineBody);
  assert.equal(result.status, 502);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.code, 'FINAL_UPLOAD_FAILED');
  assert.equal(result.body.finalUrl, undefined, 'publishing failures never return an empty success URL');
  failUploads = false;
  forceConcatFailure = true;
  result = await api('/combine', combineBody);
  assert.equal(result.status, 422);
  assert.equal(result.body.ok, false, 'failed concat is never reported as a finished film');
  assert.equal(fs.existsSync(path.join(tmp, 'video/final_story.mp4')), false);
  forceConcatFailure = false;
  result = await api('/combine', { framesData: [], narrationMode: 'prompt' });
  assert.equal(result.status, 422);
  assert.equal(result.body.ok, false);
  console.log('ok: real ffmpeg combine, concat fallback, failed publishing, and absent output return truthful results');

  // Execute the real browser poll loop with a virtual clock. A healthy long
  // render must refresh the watchdog, log only transitions, and count request time.
  let now = 0, calls = 0;
  const messages = [];
  const browser = {
    Date: { now: () => now }, USER_CANCELLED: false, LOCAL_LAST_ACTIVITY: 0,
    LOCAL_PHASE: '', sbPayload: b => b, logLocal: m => messages.push(m),
    setTimeout: fn => { now += 15000; fn(); },
    callPhase: async () => { calls++; now += 20 * 60000; return { pending: true, status: 'RUNNING' }; }
  };
  vm.createContext(browser);
  vm.runInContext(client.slice(client.indexOf('async function pollVideoTask('), client.indexOf('// On Vercel, render videos ONE FRAME')), browser);
  const polled = await browser.pollVideoTask(1, 'novita:task:test', {}, 1, 1);
  assert.equal(calls, 3, '45-minute cap must include time spent inside requests');
  assert.equal(browser.LOCAL_LAST_ACTIVITY, now, 'healthy status responses refresh the watchdog');
  assert.equal(messages.length, 1, 'unchanged status is quiet');
  assert.match(polled.error, /Check this task/);
  console.log('ok: browser polling uses wall time and keeps the watchdog alive without log spam');

  for (const [failImages, narrationMode] of [[true, 'prompt'], [false, 'tts'], [false, 'prompt']]) {
    const phases = [], logs = [], storage = new Map();
    const values = { videoModel: 'wan3.0-video-prime', imageModel: 'flux-2-klein-9b', narrationMode,
      ratio: '16:9', duration: '1', clipDuration: '1', narrVolume: '1', origVolume: '1' };
    const auto = {
      CHARS: [], FRAMES: [], IS_VERCEL_CLIENT: true, USER_CANCELLED: false,
      $: id => ({ value: values[id] || '', checked: true, style: {}, load() {} }),
      localStorage: { setItem: (k, v) => storage.set(k, v), getItem: k => storage.get(k) },
      resetStoryboardAssets() { storage.clear(); }, rememberFinalFilm: url => assert.ok(url),
      logLocal: msg => logs.push(msg), poll() {}, refresh() {}, refreshCredits() {}, withTimeout: b => b,
      api: async () => ({ ok: true, characters: [{ id: 'hero' }], frames: [frame] }),
      callPhase: async (route, body) => {
        phases.push(route);
        if (route === '/char-refs') return { ok: true, characters: [{ id: 'hero', reference_image_url: 'https://cdn.example.test/ref.png' }] };
        if (route === '/images') {
          assert.equal(body.characters[0].reference_image_url, 'https://cdn.example.test/ref.png', 'images receive the finished reference');
          return failImages ? { ok: false, failed: [1], errors: [{ frame: 1, message: 'Filtered' }], frames: [{ ...frame, image_error: { message: 'Filtered' } }] }
            : { ok: true, frames: [{ ...frame, generated_image_url: 'https://cdn.example.test/still.png' }] };
        }
        if (route === '/narration') return { ok: true, narrationUrl: 'https://cdn.example.test/voice.mp3' };
        if (route === '/videos') {
          assert.equal(body.narrationMode, narrationMode);
          assert.equal(body.framesData[0].generated_image_url, 'https://cdn.example.test/still.png');
          return { ok: true, frame: { ...body.framesData[0], clip_url: 'https://cdn.example.test/clip.mp4' }, clipUrl: 'https://cdn.example.test/clip.mp4' };
        }
        if (route === '/combine') {
          assert.equal(body.clipUrls[1], 'https://cdn.example.test/clip.mp4');
          assert.equal(body.narrationUrl, narrationMode==='tts'?'https://cdn.example.test/voice.mp3':'');
          return { ok: true, finalUrl: 'https://cdn.example.test/final.mp4' };
        }
        throw new Error('Unexpected auto phase: ' + route);
      }
    };
    vm.createContext(auto);
    vm.runInContext(client.slice(client.indexOf('function sbPayload('), client.indexOf('async function poll(){')), auto);
    vm.runInContext(client.slice(client.indexOf('async function runAutoVercel('), client.indexOf("$('btnCharRefs').onclick")), auto);
    await auto.runAutoVercel('An ordinary test scene.');
    assert.deepEqual(phases, failImages ? ['/char-refs', '/images'] : narrationMode==='tts'
      ? ['/char-refs', '/images', '/narration', '/videos', '/combine']
      : ['/char-refs', '/images', '/videos', '/combine']);
    assert.equal(logs.some(msg => msg.includes('FINAL FILM READY')), !failImages);
    assert.equal(auto.LOCAL_BUSY, false);
  }
  console.log('ok: automatic pipeline waits for references, stops on failed images, and hands hosted assets to video/combine');

  const pickers = { videoModel: { value: 'wan3.0-video-prime' }, clipDuration: { value: '8' },
    narrationMode: { value: 'prompt', options: [{ value: 'prompt', disabled: false }] } };
  const selection = { $: id => pickers[id] };
  vm.createContext(selection);
  const modelChange = client.match(/\$\('videoModel'\)\.onchange=\(\)=>\{[\s\S]*?\r?\n  \};/);
  assert.ok(modelChange);
  vm.runInContext(modelChange[0], selection);
  for (const model of ['wan3.0-video-prime', 'wan3.0-video', 'wan2.7-i2v']) {
    pickers.videoModel.value = model;
    pickers.videoModel.onchange();
    assert.equal(pickers.narrationMode.value, 'prompt', 'changing to Wan preserves Prompt Vocalized');
    assert.equal(pickers.narrationMode.options[0].disabled, false);
  }
  console.log('ok: selecting any Wan model keeps Prompt Vocalized enabled and selected');
}

main().then(() => console.log('all provider regressions passed')).catch(e => {
  console.error(e); process.exitCode = 1;
}).finally(async () => {
  if (srv.listening) await new Promise(r => srv.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});
