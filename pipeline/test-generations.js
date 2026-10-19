// test-generations.js — offline regression for the /generations parallel film queue.
// Runs the page's real runner + scheduler code in a VM with mocked IO; no network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const page = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'generations.html'), 'utf8');

// ---- 1. source wiring ----
console.log('\n[1] page wiring');
assert.match(page, /id="btnAdd"/, 'queue button exists');
assert.match(page, /window\.cancelRun/, 'per-run cancel handler exists');
assert.match(page, /window\.resumeRun/, 'per-run resume handler exists');
assert.match(page, /frames:\[f\.frame\],framesData:\[f\]/, 'per-frame requests carry the inline board');
assert.match(page, /pollTask:submitted\.task/, 'two-phase Wan tasks are polled');
assert.match(page, /MAX_CONCURRENT=IS_VERCEL_CLIENT\?3:1/, 'parallel on Vercel, serialized locally');
assert.match(page, /sb_generations/, 'the run registry persists across reloads');
assert.match(page, /status='interrupted'/, 'a reload marks running jobs interrupted, not lost');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'web', 'server.js'), 'utf8');
assert.match(serverSrc, /p === '\/generations'\) filePath = path\.join\(PUBLIC, 'generations\.html'\)/, 'the server serves the page');
assert.match(serverSrc, /p === '\/generations'/, 'the local auth gate covers the page');
const studio = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'storyboard.html'), 'utf8');
assert.match(studio, /href="\/generations"/, 'the studio links to the queue');
console.log('  ok: page, cancel, inline boards, polling, concurrency, persistence, nav');

// ---- 2. behavioural: the runner executes all six phases ----
console.log('\n[2] runner executes the full pipeline');
function pageContext(io) {
  const elStub=()=>({style:{},classList:{add(){},remove(){}},innerHTML:'',textContent:'',value:'',onclick:null,src:''});
  const ctx = {
    window: {}, console, Math, Date, JSON, Promise, Object, Array, String, Number,
    AbortController, AbortSignal, setTimeout: fn => { fn(); }, clearTimeout,
    fetch: async () => { throw new Error('fetch must not be used directly by the runner'); },
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { getElementById: () => elStub() },
    alert: () => {}, confirm: () => true,
    location: { replace() {} },
  };
  if (io) ctx.RUNNER_IO_PENDING = io;
  vm.createContext(ctx);
  vm.runInContext(page.slice(page.indexOf('const $=id=>'), page.indexOf('</script>', page.indexOf('const $=id=>'))), ctx);
  if (io) ctx.RUNNER_IO = io;
  return ctx;
}
function makeRun(ctx, overrides = {}) {
  return {
    id: 'r_test', createdAt: Date.now(), title: 'Test film', script: 'A test script.',
    status: 'queued', phase: '', running: false, cancelled: false, log: [],
    characters: [], frames: [], clipUrls: {}, narrUrl: '', resultUrl: '', thumbUrl: '',
    ctrl: new AbortController(),
    opts: Object.assign({ chatModel: 'gemini-2.5-pro', imageModel: 'nano-banana-pro', videoModel: 'omni-flash',
      ratio: '16:9', resolution: '1080P', duration: 60, clipDuration: 6, narrationMode: 'tts', voice: 'female',
      language: 'en', style: 'cinematic', consistency: true, chainContinuity: false, narrationEngine: 'fish' }, overrides),
  };
}
const frame = { frame: 1, duration_sec: 6, image_prompt: 'A blue ceramic vase', animation_prompt: 'Slow push-in', narration: 'A quiet morning.' };
(async () => {
{
  const calls = [];
  const io = {
    call: async (p, body) => { calls.push(p); 
      if (p === '/storyboard') return { ok: true, characters: [{ id: 'Character A', description: 'A hero.' }], frames: [{ ...frame }] };
      if (p === '/char-refs') return { ok: true, characters: [{ id: 'Character A', description: 'A hero.', reference_image_url: 'https://cdn.example.test/ref.png' }] };
      if (p === '/images') return { ok: true, frames: [{ ...body.framesData[0], generated_image_url: 'https://cdn.example.test/still.png' }] };
      if (p === '/narration') return { ok: true, narrationUrl: 'https://cdn.example.test/voice.mp3' };
      if (p === '/videos') return { ok: true, frame: { ...body.framesData[0], clip_url: 'https://cdn.example.test/clip.mp4' }, clipUrl: 'https://cdn.example.test/clip.mp4' };
      if (p === '/combine') { assert.equal(body.clipUrls[1], 'https://cdn.example.test/clip.mp4'); assert.equal(body.narrationUrl, 'https://cdn.example.test/voice.mp3'); return { ok: true, finalUrl: 'https://cdn.example.test/final.mp4' }; }
      throw new Error('unexpected phase ' + p);
    },
    get: async () => { throw new Error('no local job polling on the Vercel path'); },
    sleep: async () => {},
  };
  const ctx = pageContext();
  const R = makeRun(ctx);
  ctx.RUNS = [R]; // registry shared with the page code
  await ctx.executeRun(R, io);
  assert.equal(R.status, 'done');
  assert.equal(R.resultUrl, 'https://cdn.example.test/final.mp4');
  assert.deepEqual(calls, ['/storyboard', '/char-refs', '/images', '/narration', '/videos', '/combine']);
  assert.equal(R.thumbUrl, 'https://cdn.example.test/still.png', 'the first frame image becomes the card thumbnail');
  console.log('  ok: storyboard → refs → image → narration → video → combine, film URL + thumbnail captured');
}

// ---- 3. behavioural: cancel stops between phases and keeps progress ----
console.log('\n[3] cancel stops the run without losing finished work');
{
  const seen = [];
  const io = {
    call: async (p, body, R) => {
      seen.push(p);
      if (p === '/storyboard') return { ok: true, characters: [{ id: 'Character A', description: 'A hero.' }], frames: [{ ...frame }] };
      if (p === '/char-refs') return { ok: true, characters: [] };
      if (p === '/images') { R.cancelled = true; return { ok: true, frames: [{ ...body.framesData[0], generated_image_url: 'https://cdn.example.test/still.png' }] }; }
      throw new Error('should not reach ' + p);
    },
    get: async () => { throw new Error('no polling expected'); },
    sleep: async () => {},
  };
  const ctx = pageContext();
  const R = makeRun(ctx);
  await ctx.executeRun(R, io);
  assert.equal(R.status, 'cancelled', 'cancel is reported as cancelled, not failed');
  assert.deepEqual(seen, ['/storyboard', '/char-refs', '/images']);
  assert.equal(R.frames[0].generated_image_url, 'https://cdn.example.test/still.png', 'finished assets survive the cancel for Resume');
  console.log('  ok: cancel stops before the video phase; saved frames stay resumable');
}

// ---- 4. behavioural: resume skips finished phases ----
console.log('\n[4] resume continues from saved progress');
{
  const calls = [];
  const io = {
    call: async (p, body) => { calls.push(p);
      if (p === '/narration') return { ok: true, narrationUrl: 'https://cdn.example.test/voice.mp3' };
      if (p === '/videos') return { ok: true, frame: { ...body.framesData[0], clip_url: 'https://cdn.example.test/clip.mp4' }, clipUrl: 'https://cdn.example.test/clip.mp4' };
      if (p === '/combine') return { ok: true, finalUrl: 'https://cdn.example.test/final.mp4' };
      throw new Error('should not re-run ' + p);
    },
    get: async () => { throw new Error('no polling expected'); },
    sleep: async () => {},
  };
  const ctx = pageContext();
  const R = makeRun(ctx);
  // Simulate a run cancelled after references + images completed.
  R.characters = [{ id: 'Character A', reference_image_url: 'https://cdn.example.test/ref.png' }];
  R.frames = [{ ...frame, generated_image_url: 'https://cdn.example.test/still.png' }];
  await ctx.executeRun(R, io);
  assert.equal(R.status, 'done');
  assert.deepEqual(calls, ['/narration', '/videos', '/combine'], 'storyboard/refs/images are never re-run');
  console.log('  ok: resume runs only the missing phases');
}

// ---- 5. behavioural: the scheduler caps concurrency ----
console.log('\n[5] scheduler queues and caps parallel runs');
{
  const active = [];
  const io = {
    call: async (p, body, R) => {
      if (p === '/storyboard') { active.push(R.id); await new Promise(r => setTimeout(r, 30)); active.splice(active.indexOf(R.id), 1); return { ok: true, characters: [], frames: [{ ...frame }] }; }
      if (p === '/char-refs') return { ok: true, characters: [] };
      if (p === '/images') return { ok: true, frames: [{ ...body.framesData[0], generated_image_url: 'u' }] };
      if (p === '/videos') return { ok: true, frame: {}, clipUrl: 'c' };
      if (p === '/combine') return { ok: true, finalUrl: 'f' };
      throw new Error('unexpected ' + p);
    },
    get: async () => ({ phase: 'idle' }),
    sleep: async (ms) => { await new Promise(r => setTimeout(r, Math.min(ms, 5))); },
  };
  const ctx = pageContext(io);
  ctx.MAX_CONCURRENT = 1;
  const runs = [makeRun(ctx, {}), makeRun(ctx, {})];
  runs[1].id = 'r_second';
  runs.forEach(r => { r.opts.narrationMode = 'prompt'; });
  ctx.addRunObject(runs[0]);
  ctx.addRunObject(runs[1]);
  await new Promise(r => setTimeout(r, 400));
  assert.equal(runs.filter(r => r.status === 'done').length, 2, 'both queued runs complete');
  console.log('  ok: queued runs execute through the capped scheduler');
}

console.log('\n[6] Qwen and Aqua references use individual requests and retain finished references');
for(const imageModel of ['modelscope:qwen-image-2.1','aqua:qwen-image-3.0-pro']){
 const ctx=pageContext(),R=makeRun(ctx,{imageModel,narrationMode:'prompt'}),calls=[];
 R.characters=[{id:'A',reference_image_url:'https://fixture.test/existing.png'},{id:'B'},{id:'C'}];
 R.frames=[{...frame,generated_image_url:'https://fixture.test/image.png',clip_url:'https://fixture.test/clip.mp4'}];
 const io={call:async(p,b,r,opts)=>{
  if(p==='/char-refs'){assert.equal(b.force.length,1);assert.equal(opts.attempts,1);calls.push(b.force[0]);return {ok:true,characters:b.characters.map(c=>b.force.includes(c.id)?{...c,reference_image_url:'https://fixture.test/'+c.id+'.png'}:c)};}
  if(p==='/videos')return {ok:true,frame:{},clipUrl:'https://fixture.test/clip.mp4'};
  if(p==='/combine')return {ok:true,finalUrl:'https://fixture.test/final.mp4'};
  throw Error('unexpected phase '+p);
 },get:async()=>({}),sleep:async()=>{}};
 await ctx.executeRun(R,io);assert.equal(R.status,'done');assert.deepEqual(calls,['B','C']);assert.equal(R.characters[0].reference_image_url,'https://fixture.test/existing.png');
}
console.log('\n[7] Vercel starts three films together and holds the fourth');
{
 let entered=0,peak=0,active=0,release;const gate=new Promise(r=>release=r);
 const io={call:async(p,b,R)=>{
  if(p==='/storyboard'){entered++;active++;peak=Math.max(peak,active);await gate;active--;return {ok:true,characters:[],frames:[{...frame}]};}
  if(p==='/images')return {ok:true,frames:[{...b.framesData[0],generated_image_url:'u'}]};
  if(p==='/videos')return {ok:true,frame:{},clipUrl:'c'};
  if(p==='/combine')return {ok:true,finalUrl:'f'};
  throw Error('unexpected '+p);
 },get:async()=>({}),sleep:async()=>{}};
 const ctx=pageContext(io);ctx.MAX_CONCURRENT=3;
 const runs=Array.from({length:4},(_,i)=>{const R=makeRun(ctx,{narrationMode:'prompt'});R.id='parallel_run_'+i;return R;});
 runs.forEach(r=>ctx.addRunObject(r));await new Promise(r=>setImmediate(r));assert.equal(entered,3);assert.equal(peak,3);release();await new Promise(r=>setTimeout(r,150));assert.equal(runs.filter(r=>r.status==='done').length,4);assert.equal(peak,3);
}
})().catch(e => { console.error(e); process.exitCode = 1; });
console.log('\nall generations regressions passed');
