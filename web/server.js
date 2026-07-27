// Storyboard Studio — zero-dependency Node server (Node 18+; built for v24)
// Run:  node web/server.js   →  http://localhost:5173
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const { URL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(__dirname, 'public');
const FRAMES_DIR = path.join(ROOT, 'frames');
const VIDEO_DIR = path.join(ROOT, 'video');
const STORYBOARD_DIR = path.join(ROOT, 'storyboard');
const FRAMES_JSON = path.join(STORYBOARD_DIR, 'frames.json');
const CHARS_JSON = path.join(STORYBOARD_DIR, 'characters.json');
const INFLUENCERS_JSON = path.join(STORYBOARD_DIR, 'influencers.json');
const API_KEY = fs.readFileSync(path.join(ROOT, 'pipeline', 'apikey.txt'), 'utf8').trim();
const AQUA_API_KEY = fs.readFileSync(path.join(ROOT, 'pipeline', 'aqua_apikey.txt'), 'utf8').trim();
const API = 'https://api.paxsenix.org';
const AQUA_API = 'https://api.aquadevs.com';
const PORT = process.env.PORT || 5173;
// omkar.cloud trending API (TikTok trending + search)
let OMKAR_KEY = '';
try { OMKAR_KEY = fs.readFileSync(path.join(ROOT, 'pipeline', 'omkar-key.txt'), 'utf8').trim(); } catch {}
const OMKAR_API = 'https://tiktok-scraper.omkar.cloud';

let TRENDSMCP_KEY = '';
try { TRENDSMCP_KEY = fs.readFileSync(path.join(ROOT, 'pipeline', 'trendsmcp-key.txt'), 'utf8').trim(); } catch {}
const TRENDSMCP_API = 'https://api.trendsmcp.ai/api';

// Official REST: POST /api with mode get_top_trends (live feeds only, no hardcoded lists)
async function trendsMcpTop(type, limit = 25, offset = 0) {
  if (!TRENDSMCP_KEY) throw new Error('TrendsMCP key missing');
  const r = await fetch(TRENDSMCP_API, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TRENDSMCP_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'get_top_trends', type, limit, offset }),
    signal: AbortSignal.timeout(30000)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || j.error || ('HTTP ' + r.status));
  // API returns { statusCode, body: "<json string>" } or direct payload
  let payload = j;
  if (typeof j.body === 'string') {
    try { payload = JSON.parse(j.body); } catch { throw new Error('TrendsMCP: bad body'); }
  }
  if (!payload || !Array.isArray(payload.data)) throw new Error('TrendsMCP: no data for ' + type);
  return payload; // { as_of_ts, type, limit, offset, count, data: [[rank, name], ...] }
}


// yt-dlp search: get real SHORT-FORM video data for trending content (<= 60s)
async function ytSearch(query, limit = 5) {
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    const args = [
      '-m', 'yt_dlp',
      '--dump-json', '--flat-playlist', '--no-download',
      '--playlist-items', '1:' + (limit * 2),
      '--match-filter', 'duration < 61',
      'ytsearch' + (limit * 2) + ':' + query
    ];
    execFile('python', args, { timeout: 25000 }, (err, stdout) => {
      if (err) return resolve([]);
      const lines = stdout.trim().split('\n').filter(Boolean);
      const videos = [];
      const seen = new Set();
      for (const line of lines) {
        try {
          const d = JSON.parse(line);
          const vid = d.id || '';
          if (!vid || seen.has(vid)) continue;
          seen.add(vid);
          videos.push({
            id: vid,
            title: d.title || '',
            thumbnail: vid ? 'https://i.ytimg.com/vi/' + vid + '/hqdefault.jpg' : '',
            url: d.url || ('https://www.youtube.com/watch?v=' + vid),
            views: d.view_count || 0,
            likes: d.like_count || 0,
            duration: d.duration || 0,
            author: d.uploader || d.channel || '',
            platform: 'youtube'
          });
          if (videos.length >= limit) break;
        } catch {}
      }
      videos.sort((a, b) => (b.views || 0) - (a.views || 0));
      resolve(videos);
    });
  });
}

// Back-compat wrapper used by older call sites
async function trendsMcpCall(toolName, args) {
  if (toolName === 'trendsMCP___get_top_trends' || args?.type) {
    return trendsMcpTop(args.type, args.limit || 25, args.offset || 0);
  }
  throw new Error('TrendsMCP: unsupported tool ' + toolName);
}


for (const d of [FRAMES_DIR, VIDEO_DIR, STORYBOARD_DIR]) fs.mkdirSync(d, { recursive: true });

const MODELS = ['kimi-k3', 'gpt-5.6-sol', 'claude-opus-4-8', 'qwen3.8-max', 'gemini-3.1-pro', 'kimi-2.7-code', 'glm-5.2', 'mimo-v2.5', 'claude-sonnet-4-5', 'deepseek-v3.2', 'gemini-2.5-pro'];
const IMAGE_MODELS = ['nano-banana-pro', 'nano-banana', 'nano-banana-2', 'seedream-5', 'seedream-4', 'seedream-4.5', 'gpt-image-2'];
const VIDEO_MODELS = [
  { id: 'grok-video', label: 'Grok Video (fast, cinematic)' },
  { id: 'veo-3.1', label: 'Veo 3.1 (Google, high quality)' }
];
const DEFAULT_VIDEO_MODEL = 'grok-video';
// MIMO TTS voices (AquaDevs API) — simple male / female selection
const VOICES = [
  { id: 'female', label: 'Female narrator (warm, expressive)' },
  { id: 'male', label: 'Male narrator (deep, cinematic)' }
];
const DEFAULT_VOICE = 'female';
const TTS_MODEL = 'mimo-v2.5-tts';
const TTS_VOICE_INSTRUCTIONS = {
  female: 'A warm, expressive, cinematic female narrator voice. Clear diction, natural pacing, emotional and engaging, like a professional audiobook storyteller.',
  male: 'A deep, rich, cinematic male narrator voice. Authoritative yet warm, clear diction, natural pacing, like a professional movie trailer narrator.'
};
const LANGUAGES = [
  { id: 'en', label: 'English', ttsCode: 'en' },
  { id: 'hi', label: 'Hindi', ttsCode: 'hi' },
  { id: 'es', label: 'Spanish', ttsCode: 'es' },
  { id: 'fr', label: 'French', ttsCode: 'fr' },
  { id: 'ja', label: 'Japanese', ttsCode: 'ja' },
  { id: 'ar', label: 'Arabic', ttsCode: 'ar' },
  { id: 'pt', label: 'Portuguese', ttsCode: 'pt' },
  { id: 'de', label: 'German', ttsCode: 'de' },
  { id: 'ta', label: 'Tamil', ttsCode: 'ta' },
  { id: 'te', label: 'Telugu', ttsCode: 'te' }
];
const DEFAULT_LANGUAGE = 'en';
const NARRATION_MODES = [
  { id: 'tts', label: 'TTS Voice — MIMO generates spoken narration audio' },
  { id: 'prompt', label: 'Prompt Vocalized — narration embedded in video prompts, no separate audio' }
];
const DEFAULT_NARRATION_MODE = 'tts';

// Map image model name → PaxSenix API endpoint path
function imageEndpoint(model) {
  if (model.startsWith('seedream')) return '/ai-image/seedream';
  if (model.startsWith('gpt-image')) return '/ai-image/gpt-image-2';
  return '/ai-image/nano-banana';
}
function img2ImgEndpoint(model) {
  if (model.startsWith('seedream')) return '/ai-img2img/seedream';
  if (model.startsWith('gpt-image')) return '/ai-img2img/gpt-image-2';
  return '/ai-img2img/nano-banana';
}

const STYLES = {
  cinematic:    { label:'Cinematic', prefix:'cinematic film still, photorealistic, 8K HDR, professional color grading, ', suffix:', cinematic lighting, anamorphic lens flare, film grain, ultra detailed', neg_extra:'flat lighting, amateur, video game, cartoon' },
  anime:        { label:'Anime', prefix:'anime key visual, cel-shaded, vibrant saturated colors, manga aesthetic, ', suffix:', clean lineart, detailed background, sakuga quality, anime 8K', neg_extra:'photorealistic, 3D render, western cartoon, ugly, deformed' },
  realistic:    { label:'Realistic', prefix:'documentary photography, hyperrealistic, unfiltered, ', suffix:', natural available light, photojournalistic, RAW image, 8K detail', neg_extra:'stylized, artistic, painterly, oversaturated, HDR' },
  fantasy:      { label:'Fantasy', prefix:'fantasy art, epic, magical, ', suffix:', ethereal glow, painterly detail, concept art quality, 8K', neg_extra:'modern, urban, photorealistic, mundane, flat' },
  scifi:        { label:'Sci-Fi', prefix:'sci-fi concept art, futuristic, ', suffix:', holographic UI, neon accents, hard surface detail, 8K', neg_extra:'medieval, natural, organic, vintage, low-tech' },
  noir:         { label:'Film Noir', prefix:'film noir, high-contrast black and white, ', suffix:', venetian blind shadows, cigarette smoke, hard shadows, 4K', neg_extra:'color, bright, cheerful, saturated, cartoon' },
  horror:       { label:'Horror', prefix:'horror aesthetic, unsettling, ', suffix:', desaturated, heavy grain, dread atmosphere, dark corners, 4K', neg_extra:'bright, cheerful, colorful, cartoon, cute' },
  pixar:        { label:'Pixar 3D', prefix:'3D animated, Pixar style, ', suffix:', subsurface scattering, soft global illumination, stylized proportions, 8K render', neg_extra:'2D, flat, realistic, dark, gritty' },
  ghibli:       { label:'Ghibli', prefix:'Studio Ghibli style, watercolor background, ', suffix:', soft warm palette, hand-painted texture, pastoral, anime 4K', neg_extra:'3D, photorealistic, dark, gritty, neon' },
  cyberpunk:    { label:'Cyberpunk', prefix:'cyberpunk, neon-noir, rain-soaked streets, ', suffix:', holographic ads, chrome reflections, Blade Runner atmosphere, 8K', neg_extra:'natural, pastoral, bright daylight, medieval, fantasy' },
  vintage:      { label:'Vintage Film', prefix:'vintage film photography, Kodak Portra 400 color science, ', suffix:', light leaks, warm tones, soft focus, 1970s film grain, 4K', neg_extra:'digital, sharp, cold, modern, HDR' },
  watercolor:   { label:'Watercolor', prefix:'watercolor painting, soft washes, ', suffix:', visible paper texture, wet-on-wet bleed, gentle edges, fine art', neg_extra:'photorealistic, digital, sharp edges, 3D, dark' },
  comic:        { label:'Comic Book', prefix:'comic book art, bold ink outlines, ', suffix:', halftone dots, vivid flat colors, dynamic panel composition, 4K', neg_extra:'photorealistic, watercolor, soft, muted, 3D render' },
  oilpainting:  { label:'Oil Painting', prefix:'oil painting, rich impasto brushstrokes, ', suffix:', classical technique, warm glazing layers, gallery quality, fine art', neg_extra:'photorealistic, digital, flat, smooth, cartoon' },
  minimalist:   { label:'Minimalist', prefix:'minimalist photography, clean composition, ', suffix:', generous negative space, muted palette, geometric forms, 4K', neg_extra:'cluttered, busy, HDR, oversaturated, noisy' }
};
const STYLE_KEYS = Object.keys(STYLES);

function applyStyle(prompt, styleKey) {
  const s = STYLES[styleKey] || STYLES.cinematic;
  // Style keywords at the END (image models weight the end more heavily)
  return prompt + ' — ' + s.suffix.slice(2) + ', ' + s.prefix.trim().slice(0, -2);
}

// ---------------- in-memory job state ----------------
const job = { phase: 'idle', total: 0, done: 0, ok: 0, failed: [], log: [], startedAt: null };
function logLine(msg) {
  job.log.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
  if (job.log.length > 500) job.log.shift();
}
function setPhase(phase, total = 0) {
  job.phase = phase; job.total = total; job.done = 0; job.ok = 0; job.failed = [];
  job.startedAt = Date.now(); job.log = [];
}

// ---------------- SEPARATE job state for AI Influencer (fully independent from storyboard) ----------------
const inflJob = { phase: 'idle', total: 0, done: 0, ok: 0, failed: [], log: [], startedAt: null };
function inflLogLine(msg) {
  inflJob.log.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
  if (inflJob.log.length > 500) inflJob.log.shift();
}
function inflSetPhase(phase, total = 0) {
  inflJob.phase = phase; inflJob.total = total; inflJob.done = 0; inflJob.ok = 0; inflJob.failed = [];
  inflJob.startedAt = Date.now(); inflJob.log = [];
}
function inflJobDone(n = 1) { inflJob.done += n; inflJob.ok += n; }

// ---------------- helpers ----------------
function stripHtml(t) { return String(t).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }

// Sanitize prompts — remove words blocked by PaxSenix image/video APIs
const BLOCKED_WORDS = ['nude', 'naked', 'nudity', 'nsfw', 'topless', 'undressed', 'bare breasts', 'erect nipples', 'genitals', 'explicit', 'porn', 'xxx', 'hentai', 'uncensored'];
const BLOCKED_REPLACEMENTS = { 'nude': 'neutral', 'naked': 'bare', 'nudity': 'minimalist', 'topless': 'sleeveless', 'undressed': 'casual', 'bare breasts': 'elegant silhouette', 'genitals': 'minimal', 'explicit': 'elegant', 'porn': 'art', 'xxx': 'art', 'hentai': 'anime', 'uncensored': 'clean' };
function sanitizePrompt(p) {
  let result = p;
  for (const word of BLOCKED_WORDS) {
    const re = new RegExp(`\\b${word}\\b`, 'gi');
    const replacement = BLOCKED_REPLACEMENTS[word] || 'clean';
    result = result.replace(re, replacement);
  }
  return result;
}
function frameFile(n) { return path.join(FRAMES_DIR, `frame_${String(n).padStart(2, '0')}.png`); }
function videoFile(n) { return path.join(VIDEO_DIR, `frame_${String(n).padStart(2, '0')}.mp4`); }
function charRefFile(id) { return path.join(FRAMES_DIR, `char_${id.replace(/\s+/g, '_')}_ref.png`); }
function ttsFile(n) { return path.join(VIDEO_DIR, `narration_${String(n).padStart(2, '0')}.mp3`); }
function narratedVideoFile(n) { return path.join(VIDEO_DIR, `narrated_${String(n).padStart(2, '0')}.mp4`); }

// ---- AI Influencer helpers ----
function influencerDir(id) { return path.join(FRAMES_DIR, id); }
function inflRefFile(id, n) { return path.join(influencerDir(id), `ref_${String(n).padStart(2, '0')}.png`); }
function inflContentFile(id, cid, ext) { return path.join(influencerDir(id), `${cid}.${ext}`); }
async function readInfluencers() { return await readJson(INFLUENCERS_JSON) || []; }
async function writeInfluencers(arr) { await writeJson(INFLUENCERS_JSON, arr); }
async function findInfluencer(id) { const all = await readInfluencers(); return all.find(i => i.id === id) || null; }
async function saveInfluencer(infl) {
  const all = await readInfluencers();
  const idx = all.findIndex(i => i.id === infl.id);
  if (idx >= 0) all[idx] = infl; else all.push(infl);
  await writeInfluencers(all);
  return infl;
}

async function isAccessibleImageUrl(url) {
  if (!/^https?:\/\//i.test(url || '')) return false;
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(20000) });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.startsWith('image/')) return false;
    await res.body?.cancel().catch(() => {});
    return true;
  } catch { return false; }
}

// Upload a local image file to catbox.moe → returns a stable public URL with
// proper .png/.jpg extension. Used for: (1) uploaded ref photos so img2img can
// use them, and (2) generated content images so Grok video accepts them.
async function uploadToImageHost(filePath, logFn = inflLogLine) {
  const buf = await fsp.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase() === '.jpg' ? 'jpg' : 'png';
  const mime = ext === 'jpg' ? 'image/jpeg' : 'image/png';
  const form = new FormData();
  form.append('files[]', new Blob([buf], { type: mime }), `image.${ext}`);
  const res = await fetch('https://uguu.se/upload', { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
  const j = await res.json().catch(() => ({}));
  if (j.files && j.files[0] && j.files[0].url) {
    const url = j.files[0].url;
    logFn(`uploaded to uguu: ${url}`);
    return url;
  }
  throw new Error(`uguu upload failed: ${JSON.stringify(j).slice(0, 200)}`);
}
// Keep old name as alias for backwards compat
const uploadToCatbox = uploadToImageHost;

// PaxSenix img2img accepts only publicly accessible HTTP image URLs. Uploaded
// refs are local files uploaded by the user; we prefer them over AI-generated
// refs. Migrate any uploaded ref missing a public URL by uploading to uguu.se.
// Resolve a public URL for the influencer's reference image.
// Simple: use the uploaded photo's public URL (uguu.se). If missing, re-upload.
async function resolveInfluencerRefUrl(infl) {
  infl.refs = infl.refs || [];

  // Use the uploaded ref's public URL directly
  for (const ref of infl.refs.filter(r => r?.url)) {
    inflLogLine(`using reference: ${ref.path} → ${ref.url.slice(0, 60)}`);
    return ref.url;
  }

  // No URL — re-upload the local file to uguu.se
  for (const ref of infl.refs.filter(r => r?.path)) {
    const localPath = path.join(influencerDir(infl.id), ref.path);
    if (!fs.existsSync(localPath)) continue;
    try {
      ref.url = await uploadToImageHost(localPath);
      await saveInfluencer(infl);
      inflLogLine(`re-uploaded ${ref.path} → ${ref.url}`);
      return ref.url;
    } catch (e) {
      inflLogLine(`re-upload failed: ${e.message}`);
    }
  }

  inflLogLine('no reference image available');
  return null;
}
async function readJson(f) { try { return JSON.parse(await fsp.readFile(f, 'utf8')); } catch { return null; } }
async function writeJson(f, d) { await fsp.writeFile(f, JSON.stringify(d, null, 2)); }

// ---------------- PaxSenix helpers ----------------
async function paxFetch(url, opts = {}, timeoutMs = 120000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal, headers: { Authorization: `Bearer ${API_KEY}`, ...(opts.headers || {}) } });
    return res;
  } finally { clearTimeout(t); }
}

async function submitTask(pathAndQuery, logFn = logLine) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await paxFetch(`${API}${pathAndQuery}`);
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok && j.task_url) return j.task_url;
      logFn(`submit attempt ${attempt}: HTTP ${res.status} ${JSON.stringify(j).slice(0, 200)}`);
    } catch (e) { logFn(`submit attempt ${attempt}: ${e.message}`); }
    await new Promise(r => setTimeout(r, 4000 * attempt));
  }
  return null;
}

// PaxSenix prompt enhancer — improves prompts before image/video generation
async function enhancePrompt(prompt) {
  if (!prompt || prompt.length < 20) return prompt; // skip short prompts
  try {
    const res = await paxFetch(`${API}/ai-tools/prompt-enhancer?prompt=${encodeURIComponent(prompt)}`, {}, 60000);
    const j = await res.json().catch(() => ({}));
    if (j.ok && j.enhanced_prompt && j.enhanced_prompt.length > prompt.length) {
      return j.enhanced_prompt;
    }
  } catch (e) { logLine(`prompt enhance failed: ${e.message}`); }
  return prompt; // fallback to original
}

// img2img with reference image(s) — anchors character identity
// Only use seedream-5 — nano-banana img2img gets stuck forever
async function submitImg2ImgTask(prompt, refUrls, imageModel = 'seedream-5', ratio = '16:9') {
  const postBody = JSON.stringify({ prompt, model: 'seedream-5', ratio, image_urls: refUrls });
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await paxFetch(`${API}/ai-img2img/seedream`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: postBody
      }, 120000);
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok && j.task_url) return j.task_url;
      logLine(`img2img seedream-5 attempt ${attempt}: HTTP ${res.status} ${JSON.stringify(j).slice(0, 120)}`);
    } catch (e) { logLine(`img2img seedream-5 attempt ${attempt}: ${e.message}`); }
    await new Promise(r => setTimeout(r, 3000 * attempt));
  }
  logLine('img2img: seedream-5 failed after 3 attempts');
  return null;
}

async function waitTask(taskUrl, maxMin = 25, logFn = logLine) {
  const deadline = Date.now() + maxMin * 60000;
  let networkErrors = 0;
  let lastStatus = 'pending';
  while (Date.now() < deadline) {
    try {
      const res = await paxFetch(taskUrl, {}, 90000);
      const j = await res.json().catch(() => ({}));
      networkErrors = 0;
      if (j.status === 'done' && j.ok) return j.url || (j.urls && j.urls[0]) || j.video_url || null;
      if (/fail|error/i.test(j.status || '')) { logFn(`task failed: ${JSON.stringify(j).slice(0, 300)}`); return null; }
      lastStatus = j.status || lastStatus;
    } catch (e) {
      networkErrors++;
      // PaxSenix polling can disconnect while a large img2img job runs. Only
      // give up after sustained failures, not one dropped connection.
      logFn(`poll network error ${networkErrors}/6 (${lastStatus})`);
      if (networkErrors >= 6) { logFn(`polling stopped after repeated network errors: ${e.message}`); return null; }
    }
    await new Promise(r => setTimeout(r, 10000));
  }
  logFn('task timed out'); return null;
}

async function download(fileUrl, outPath) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(fileUrl, { signal: AbortSignal.timeout(180000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await fsp.writeFile(outPath, buf);
      return true;
    } catch (e) { logLine(`download attempt ${attempt}: ${e.message}`); }
  }
  return false;
}

// ---------------- streaming chat ----------------
async function chatCompletion(model, messages, maxTokens = 16384) {
  const body = { model, messages, temperature: 0.7, max_tokens: maxTokens, stream: true };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 120000);
  let raw = '';
  try {
    const res = await fetch(`${API}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: ac.signal
    });
    if (!res.ok) throw new Error(`chat HTTP ${res.status}: ${stripHtml(await res.text()).slice(0, 160)}`);
    raw = await res.text();
  } finally { clearTimeout(timer); }

  let content = '';
  let parseErrors = 0;
  if (raw.includes('data:')) {
    for (const line of raw.split('\n')) {
      const l = line.trim();
      if (!l.startsWith('data:')) continue;
      const p = l.slice(5).trim();
      if (p === '[DONE]') continue;
      try {
        const j = JSON.parse(p);
        if (j.error) { logLine(`API error: ${JSON.stringify(j.error).slice(0,200)}`); throw new Error(`API: ${j.error.message || 'unknown'}`); }
        content += j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content ?? '';
      } catch (e) { if (e.message?.startsWith('API:')) throw e; parseErrors++; }
    }
    if (parseErrors > 0) logLine(`SSE: ${parseErrors} unparseable chunks`);
  } else if (raw.trim()) {
    try {
      const j = JSON.parse(raw);
      if (j.error) { logLine(`API error: ${JSON.stringify(j.error).slice(0,200)}`); throw new Error(`API: ${j.error.message || 'unknown'}`); }
      content = j.choices?.[0]?.message?.content ?? '';
    } catch (e) {
      if (e.message?.startsWith('API:')) throw e;
      const m = raw.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
      if (m) content = m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
    }
  }
  logLine(`chat: ${content.length} chars from ${raw.length}B`);
  return content;
}

// Gemini visual analysis for a trend. Actual MP4 frames are preferred; the
// cover image and caption metadata remain fallback inputs.
async function analyzeTrendVisual(coverUrl, trendDetails, characterDescription, logFn = inflLogLine, videoUrl = '') {
  if (!coverUrl && !videoUrl) return null;
  const media = [];
  let tempDir = '';
  if (videoUrl) {
    try {
      tempDir = path.join(STORYBOARD_DIR, `.trend_${Date.now()}`);
      await fsp.mkdir(tempDir, { recursive: true });
      const videoPath = path.join(tempDir, 'source.mp4');
      const response = await fetch(videoUrl, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`video download HTTP ${response.status}`);
      const video = Buffer.from(await response.arrayBuffer());
      if (video.length > 40 * 1024 * 1024) throw new Error('video exceeds 40MB analysis limit');
      await fsp.writeFile(videoPath, video);
      await new Promise((resolve, reject) => {
        execFile('ffmpeg', ['-y', '-i', videoPath, '-vf', 'fps=1/2,scale=640:-2', '-frames:v', '3', '-q:v', '5', path.join(tempDir, 'frame_%02d.jpg')], { timeout: 120000 }, err => err ? reject(err) : resolve());
      });
      const frames = (await fsp.readdir(tempDir)).filter(name => /^frame_\d+\.jpg$/i.test(name)).sort().slice(0, 3);
      for (const name of frames) {
        const image = await fsp.readFile(path.join(tempDir, name));
        media.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image.toString('base64')}` } });
      }
      if (media.length) logFn(`Gemini: analyzing ${media.length} frames from the selected reel`);
    } catch (e) {
      logFn(`video frame analysis unavailable: ${e.message}`);
    }
  }
  if (!media.length && coverUrl) {
    media.push({ type: 'image_url', image_url: { url: coverUrl } });
    logFn('Gemini: analyzing selected reel cover');
  }
  if (!media.length) return null;
  const messages = [
    {
      role: 'system',
      content: `You are a short-form video creative director. Analyze the supplied TikTok or Instagram Reel cover image carefully. Identify the visible setting, subject action/pose, outfit silhouette, framing, camera angle, lighting, color palette, composition, and the likely video motion. Then adapt the format for the supplied AI influencer.

Return ONLY valid JSON:
{
  "visual_analysis": "brief factual analysis of the supplied cover image",
  "scene_prompt": "80-140 words. A photorealistic candid smartphone-frame recreation of the visual format for the supplied character. Include the character description verbatim. Do not name the original creator. Keep all content safe and fully clothed.",
  "animation_prompt": "one sentence describing believable 6-second camera and subject movement matching the visible format",
  "caption": "short original caption in a similar style, without copying the original caption verbatim"
}`
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: `Trend metadata:\n${trendDetails}\n\nCharacter description:\n${characterDescription}` },
        ...media
      ]
    }
  ];

  try {
    // Only use models known to support image/vision input
    const models = ['gemini-2.5-pro', 'gemini-3.1-pro', 'gpt-5.5'];
    for (const model of models) {
      try {
        const content = await chatCompletion(model, messages, 4000);
        const start = content.indexOf('{');
        const end = content.lastIndexOf('}');
        if (start !== -1 && end > start) return parseJsonLenient(content.slice(start, end + 1));
      } catch (e) {
        logFn(`visual analysis (${model}) failed: ${e.message}`);
      }
    }
    return null;
  } finally {
    if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function parseJsonLenient(str) {
  // Strategy 1: direct parse
  try { return JSON.parse(str); } catch {}

  // Strategy 2: fix trailing commas + strip markdown fences
  let fixed = str.replace(/,\s*([\]}])/g, '$1').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(fixed); } catch {}

  // Strategy 3: aggressive truncation repair — iteratively drop incomplete trailing lines
  for (let pass = 0; pass < 5; pass++) {
    let repaired = fixed;

    // Drop incomplete trailing lines (lines that don't end with valid JSON tokens)
    for (let drop = 0; drop < 10; drop++) {
      const nl = repaired.lastIndexOf('\n');
      if (nl < 0) break;
      const tail = repaired.slice(nl + 1).trim();
      if (!tail || tail.endsWith('"') || tail.endsWith('}') || tail.endsWith(']') || tail.endsWith(',') || tail.endsWith(':')) break;
      repaired = repaired.slice(0, nl);
    }

    // Close any unclosed string (odd unescaped quote count)
    const quoteCount = (repaired.match(/(?<!\\)"/g) || []).length;
    if (quoteCount % 2 !== 0) repaired += '"';

    // Remove trailing comma or colon
    repaired = repaired.replace(/[,:]\s*$/, '');

    // Count unmatched braces/brackets
    let braces = 0, brackets = 0, inStr = false, escaped = false;
    for (let i = 0; i < repaired.length; i++) {
      const ch = repaired[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { if (inStr) escaped = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') braces++;
      else if (ch === '}') braces--;
      else if (ch === '[') brackets++;
      else if (ch === ']') brackets--;
    }
    if (brackets > 0) repaired += ']'.repeat(brackets);
    if (braces > 0) repaired += '}'.repeat(braces);

    try { return JSON.parse(repaired); } catch {}

    // Strategy 3b: find the last complete frame/character object and truncate there
    if (pass === 0) {
      const lastCompleteObj = repaired.lastIndexOf('},');
      if (lastCompleteObj > 0) {
        let candidate = repaired.slice(0, lastCompleteObj + 1);
        // Close any remaining open arrays/objects
        let b2 = 0, bk2 = 0, s2 = false, e2 = false;
        for (let i = 0; i < candidate.length; i++) {
          const ch = candidate[i];
          if (e2) { e2 = false; continue; }
          if (ch === '\\') { if (s2) e2 = true; continue; }
          if (ch === '"') { s2 = !s2; continue; }
          if (s2) continue;
          if (ch === '{') b2++;
          else if (ch === '}') b2--;
          else if (ch === '[') bk2++;
          else if (ch === ']') bk2--;
        }
        if (bk2 > 0) candidate += ']'.repeat(bk2);
        if (b2 > 0) candidate += '}'.repeat(b2);
        try { return JSON.parse(candidate); } catch {}
      }
    }

    // Strategy 3c: try finding last closing brace and truncate
    if (pass === 1) {
      const lastBrace = repaired.lastIndexOf('}');
      if (lastBrace > 0) {
        let candidate = repaired.slice(0, lastBrace + 1);
        let b3 = 0, bk3 = 0, s3 = false, e3 = false;
        for (let i = 0; i < candidate.length; i++) {
          const ch = candidate[i];
          if (e3) { e3 = false; continue; }
          if (ch === '\\') { if (s3) e3 = true; continue; }
          if (ch === '"') { s3 = !s3; continue; }
          if (s3) continue;
          if (ch === '{') b3++;
          else if (ch === '}') b3--;
          else if (ch === '[') bk3++;
          else if (ch === ']') bk3--;
        }
        if (bk3 > 0) candidate += ']'.repeat(bk3);
        if (b3 > 0) candidate += '}'.repeat(b3);
        try { return JSON.parse(candidate); } catch {}
      }
    }
  }

  throw new Error('JSON repair failed');
}

// ================================ STORYBOARD GENERATION ================================

function trySalvagePartialJson(text) {
  // Extract whatever complete character and frame objects we can find via regex
  const characters = [];
  const frames = [];

  // Find all complete character objects
  const charPattern = /\{\s*"id"\s*:\s*"([^"]+)"\s*,\s*"name"\s*:\s*"([^"]+)"\s*,\s*"age"\s*:\s*(\d+|null)\s*,\s*"description"\s*:\s*"((?:[^"\\]|\\.)*)"\s*(?:,\s*"reference_prompt"\s*:\s*"((?:[^"\\]|\\.)*)")?\s*\}/g;
  let m;
  while ((m = charPattern.exec(text)) !== null) {
    characters.push({ id: m[1], name: m[2], age: m[3] === 'null' ? null : Number(m[3]), description: m[4], reference_prompt: m[5] || '' });
  }

  // Find all complete frame objects (look for "frame": N pattern)
  const framePattern = /\{\s*"frame"\s*:\s*(\d+)[^}]*"image_prompt"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  while ((m = framePattern.exec(text)) !== null) {
    // Try to get the full object up to the closing brace
    const startIdx = m.index;
    let depth = 0, endIdx = startIdx;
    for (let i = startIdx; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') { depth--; if (depth === 0) { endIdx = i + 1; break; } }
    }
    const objStr = text.slice(startIdx, endIdx);
    try {
      const obj = parseJsonLenient(objStr);
      if (obj && obj.image_prompt) frames.push(obj);
    } catch {}
  }

  if (characters.length || frames.length) return { characters, frames };
  return null;
}

const CHARACTERS_PROMPT = `You are an elite AI Storyboard Director. Given a script, define ALL characters with hyper-detailed physical descriptions for AI image generation.

CHARACTER CONSISTENCY IS THE #1 PRIORITY. Each character description must include: face shape, skin tone, hair color/style/length, eye color, age, build, height, distinguishing features (scars/tattoos/jewelry), EXACT clothing from top to bottom, accessories.

OUTPUT FORMAT — a single JSON object:
{
  "characters": [
    {
      "id": "Character A",
      "name": "Elias",
      "age": 70,
      "description": "A 70-year-old man, tall and lean with a weathered gaunt face, deep wrinkles around his eyes and forehead, a thick bushy white beard that reaches his chest, short white hair swept back, piercing pale blue eyes with heavy brows, sun-darkened leathery skin with age spots on his cheeks, wearing a faded mustard-yellow hip-length oilskin coat with brass buttons and a high collar over a dark charcoal wool fisherman's sweater, dark brown corduroy trousers, heavy tan leather lace-up boots with steel toe caps, a worn leather belt with a brass buckle, no jewelry except a simple silver wedding band on his left ring finger, carrying a brass oil lantern with a glass chimney",
      "reference_prompt": "cinematic character portrait, waist-up 3/4 view, a 70-year-old man with a thick bushy white beard, weathered face with deep wrinkles, piercing pale blue eyes, sun-darkened leathery skin, wearing a faded mustard-yellow oilskin coat with brass buttons over a dark charcoal wool sweater, neutral grey studio background, soft directional key light from the left, 85mm portrait lens, shallow depth of field, 8K photorealistic, ultra detailed skin texture, professional studio lighting"
    }
  ]
}

RULES:
- description: 100-200 words, hyper-detailed. Include face, hair, eyes, skin, build, clothing, accessories
- reference_prompt: a detailed portrait prompt for generating a character reference image (waist-up, neutral background)
- id format: "Character A", "Character B", etc.`;

function buildFramesPrompt(frameCount, secPerFrame) {
  return `You are an elite AI Cinematographer. Given a script and locked character descriptions, generate a production-ready storyboard (frames only).

The characters are ALREADY DEFINED. In every frame's "image_prompt" where a character appears, you MUST paste their FULL description VERBATIM. Do NOT paraphrase or shorten. The image model has no memory.

OUTPUT FORMAT — a single JSON object:
{
  "frames": [
    {
      "frame": 1,
      "scene": 1,
      "timestamp": "00:00",
      "narration": "...",
      "dialogue": "",
      "summary": "one line",
      "shot_type": "Wide Establishing Shot",
      "camera_angle": "Low Angle",
      "lens": "24mm",
      "lighting": "...",
      "mood": "...",
      "location": "...",
      "characters_present": ["Character A"],
      "continuity_notes": "...",
      "image_prompt": "150-300 words. MUST include the FULL VERBATIM character description from the characters array for every character present. Describe the scene, subject, action, lighting, composition, camera angle, and mood. Do NOT include style keywords like 'photorealistic', 'cinematic', or '8K' — the visual style is applied separately by the user.",
      "negative_prompt": "...",
      "animation_prompt": "one sentence of camera movement for AI video (6 second clip)",
      "sound_design": "...",
      "transition": "cut",
      "duration_sec": ${secPerFrame},
      "importance": "hero"
    }
  ]
}

RULES:
- Return EXACTLY ${frameCount} frames covering the full arc (hook, setup, conflict, climax, ending)
- Each frame will be a ${secPerFrame}-second video clip (image-to-video), so animation_prompt should describe ${secPerFrame}s of camera/subject movement
- image_prompt: 150-300 words each. Include subject, action, lighting, composition, camera angle, lens, mood, wardrobe
- CRITICAL: Every image_prompt must contain the FULL character description verbatim for every character in that frame
- animation_prompt: describe camera movement and subject action for a ${secPerFrame}-second clip
- importance: low | medium | high | hero
- Estimate timestamps cumulatively (mm:ss) — each frame is ${secPerFrame}s
- duration_sec MUST be ${secPerFrame} for every frame`;
}

async function parseOrSalvage(content, label) {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end === -1) { logLine(`${label}: no JSON found`); return null; }
  try { return parseJsonLenient(content.slice(start, end + 1)); }
  catch (e) {
    logLine(`${label}: JSON repair failed — snippet: ${content.slice(start, start + 200).replace(/\n/g, '\\n')}`);
    const salvaged = trySalvagePartialJson(content.slice(start));
    if (salvaged) logLine(`${label}: salvaged partial JSON`);
    return salvaged;
  }
}

async function generateStoryboard(script, model, targetDuration = 120, look = '', language = DEFAULT_LANGUAGE, secPerFrame = 6) {
  const frameCount = Math.max(3, Math.ceil(targetDuration / secPerFrame));
  const modelsToTry = [model];
  const lookBlock = look && look.trim()
    ? `\n\nDIRECTOR'S CREATIVE DIRECTION (MANDATORY — the entire film must match this look):\n${look.trim()}`
    : '';
  const langObj = LANGUAGES.find(l => l.id === language);
  const langName = langObj ? langObj.label : 'English';
  const langBlock = language !== 'en'
    ? `\n\nLANGUAGE: Write ALL narration and dialogue in ${langName}. IMPORTANT: Write the ${langName} text using ROMAN/ENGLISH LETTERS ONLY (transliterated romanized ${langName}), NOT the native script. For example, Hindi should be "aur ek raat gayi" not "एक रात गई". This is needed for the text-to-speech system. All other fields (image_prompt, animation_prompt, etc.) remain in English.`
    : '';

  logLine(`target: ${targetDuration}s → ${frameCount} frames × ${secPerFrame}s each${lookBlock ? ' — with creative direction' : ''}${langBlock ? ` — narration in ${langName}` : ''}`);

  // ---- PHASE 1: Generate characters ----
  logLine('phase 1: generating characters...');
  const charMsgs = [
    { role: 'system', content: CHARACTERS_PROMPT },
    { role: 'user', content: `SCRIPT:\n${script}${lookBlock}${langBlock}\n\nReturn ONLY the JSON object with "characters" key. Nothing else.` }
  ];
  let characters = [], charModel = model;
  for (const m of modelsToTry) {
    try {
      const rawContent = await chatCompletion(m, charMsgs);
      if (!rawContent) { logLine(`${m}: empty response, next`); continue; }
      const parsed = await parseOrSalvage(rawContent, `characters (${m})`);
      const found = Array.isArray(parsed?.characters) ? parsed.characters : [];
      if (found.length) { characters = found; charModel = m; break; }
      logLine(`${m}: no valid characters JSON, next`);
    } catch (e) {
      logLine(`${m}: ${e.message}, next`);
    }
  }
  if (!characters.length) throw new Error('all models failed for characters');

  characters = characters.filter(c => c.description).map((c, i) => ({
    id: c.id || `Character ${String.fromCharCode(65 + i)}`,
    name: c.name || `Character ${String.fromCharCode(65 + i)}`,
    age: c.age || null,
    description: c.description,
    reference_prompt: c.reference_prompt || `cinematic portrait of ${c.description}, neutral background, 85mm lens, 8K photorealistic`
  }));
  logLine(`phase 1 done: ${characters.length} characters locked (model: ${charModel})`);
  await writeJson(CHARS_JSON, characters);

  // ---- PHASE 2: Generate frames ----
  logLine(`phase 2: generating ${frameCount} frames...`);
  const charSummary = characters.map(c => `[${c.id}] ${c.name}: ${c.description}`).join('\n');
  const frameMsgs = [
    { role: 'system', content: buildFramesPrompt(frameCount, secPerFrame) },
    { role: 'user', content: `SCRIPT:\n${script}${lookBlock}${langBlock}\n\nLOCKED CHARACTERS:\n${charSummary}\n\nReturn ONLY the JSON object with "frames" key. Generate exactly ${frameCount} frames. Nothing else.` }
  ];
  let frames = [], frameModel = model;
  for (const m of modelsToTry) {
    try {
      const rawContent = await chatCompletion(m, frameMsgs);
      if (!rawContent) { logLine(`${m}: empty response, next`); continue; }
      const parsed = await parseOrSalvage(rawContent, `frames (${m})`);
      let found = Array.isArray(parsed?.frames) ? parsed.frames : [];
      if (!found.length && Array.isArray(parsed)) found = parsed;
      found = found.filter(f => f.image_prompt || f.prompt);
      if (found.length) { frames = found; frameModel = m; break; }
      logLine(`${m}: no valid frames JSON, next`);
    } catch (e) {
      logLine(`${m}: ${e.message}, next`);
    }
  }
  if (!frames.length) throw new Error('all models failed for frames');

  frames = frames.map((f, i) => ({
    frame: i + 1, scene: f.scene || 1, timestamp: f.timestamp || '00:00',
    narration: f.narration || '', dialogue: f.dialogue || '', summary: f.summary || '',
    shot_type: f.shot_type || 'Medium Shot', camera_angle: f.camera_angle || 'Eye Level',
    lens: f.lens || '35mm', lighting: f.lighting || 'Natural', mood: f.mood || '',
    location: f.location || '', characters_present: f.characters_present || f.characters || [],
    continuity_notes: f.continuity_notes || '', image_prompt: f.image_prompt || f.prompt || '',
    negative_prompt: f.negative_prompt || 'low quality, blurry, watermark, text, bad anatomy, distorted face',
    animation_prompt: f.animation_prompt || 'slow cinematic push-in',
    sound_design: f.sound_design || '', transition: f.transition || 'cut',
    duration_sec: f.duration_sec || secPerFrame, importance: f.importance || 'medium'
  })).filter(f => f.image_prompt);

  logLine(`phase 2 done: ${frames.length} frames (model: ${frameModel})`);
  await writeJson(FRAMES_JSON, frames);
  return { characters, frames };
}

// ================================ IMAGE GENERATION ================================

async function generateCharRefs(characters, imageModel = 'seedream-5', style = 'cinematic') {
  setPhase('char-refs', characters.length);
  logLine(`generating character reference images for ${characters.length} character(s) — model: ${imageModel} — style: ${STYLES[style]?.label || 'Cinematic'}`);
  for (const c of characters) {
    const out = charRefFile(c.id);
    if (fs.existsSync(out)) { logLine(`${c.id}: ref exists, skip`); job.done++; job.ok++; continue; }
    const styledRefPrompt = applyStyle(c.reference_prompt, style);
    logLine(`${c.id}: enhancing ref prompt...`);
    const enhancedRef = await enhancePrompt(styledRefPrompt);
    const q = `${imageEndpoint(imageModel)}?prompt=${encodeURIComponent(enhancedRef)}&model=${encodeURIComponent(imageModel)}&ratio=1:1`;
    const task = await submitTask(q);
    if (!task) { job.failed.push(c.id); job.done++; logLine(`${c.id}: SUBMIT FAILED`); continue; }
    logLine(`${c.id}: submitted ref portrait (enhanced)`);
    const url = await waitTask(task);
    if (url && await download(url, out)) { c.reference_image_url = url; job.ok++; logLine(`${c.id}: REF DONE`); }
    else { job.failed.push(c.id); logLine(`${c.id}: REF FAILED`); }
    job.done++;
    await new Promise(r => setTimeout(r, 700));
  }
  await writeJson(CHARS_JSON, characters);
  logLine(`char-refs finished: ${job.ok} ok, ${job.failed.length} failed`);
  job.phase = 'idle';
}

// ================================ IMAGE GENERATION ================================

async function generateCharRefs(characters, imageModel = 'seedream-5', style = 'cinematic') {
  setPhase('char-refs', characters.length);
  logLine(`generating character reference images for ${characters.length} character(s) — model: ${imageModel} — style: ${STYLES[style]?.label || 'Cinematic'}`);
  
  const work = characters.filter(c => !fs.existsSync(charRefFile(c.id)));
  for (const c of characters.filter(c => fs.existsSync(charRefFile(c.id)))) { job.done++; job.ok++; }
  if (work.length === 0) { logLine('all char refs exist, skipping'); job.phase = 'idle'; return; }

  // Enhance all prompts in parallel
  logLine(`enhancing ${work.length} ref prompts in parallel...`);
  const enhanced = await Promise.all(work.map(async (c) => {
    const styled = applyStyle(c.reference_prompt, style);
    const enh = await enhancePrompt(styled);
    return { c, prompt: enh };
  }));

  // Submit all tasks in parallel (no delays)
  logLine(`submitting ${enhanced.length} ref tasks in parallel...`);
  const submitted = await Promise.all(enhanced.map(async ({ c, prompt }) => {
    const q = `${imageEndpoint(imageModel)}?prompt=${encodeURIComponent(prompt)}&model=${encodeURIComponent(imageModel)}&ratio=1:1`;
    const task = await submitTask(q);
    if (!task) { job.failed.push(c.id); job.done++; logLine(`${c.id}: SUBMIT FAILED`); return null; }
    logLine(`${c.id}: submitted ref portrait (enhanced)`);
    return { c, task };
  }));

  // Wait for all renders in parallel
  const results = submitted.filter(Boolean);
  logLine(`waiting for ${results.length} ref renders in parallel...`);
  await Promise.all(results.map(async ({ c, task }) => {
    const url = await waitTask(task);
    if (url && await download(url, charRefFile(c.id))) { c.reference_image_url = url; job.ok++; logLine(`${c.id}: REF DONE`); }
    else { job.failed.push(c.id); logLine(`${c.id}: REF FAILED`); }
    job.done++;
  }));

  await writeJson(CHARS_JSON, characters);
  logLine(`char-refs finished: ${job.ok} ok, ${job.failed.length} failed`);
  job.phase = 'idle';
}

async function generateImages(frames, imageModel, ratio, style, consistency = true, characters = []) {
  const styleLabel = STYLES[style]?.label || 'Cinematic';
  setPhase('images', frames.length);
  const refById = new Map((characters || []).map(c => [c.id, c.reference_image_url]).filter(([, u]) => !!u));
  const useRefs = consistency && refById.size > 0;
  logLine(`image phase: ${frames.length} frame(s) — ${imageModel} @ ${ratio} — style: ${styleLabel} — character lock: ${useRefs ? 'ON' : 'off'}`);
  
  const work = frames.filter(f => !fs.existsSync(frameFile(f.frame)));
  for (const f of frames.filter(f => fs.existsSync(frameFile(f.frame)))) { job.done++; job.ok++; }
  if (work.length === 0) { logLine('all images exist, skipping'); job.phase = 'idle'; return; }

  // Enhance all prompts in parallel
  logLine(`enhancing ${work.length} prompts in parallel...`);
  const enhanced = await Promise.all(work.map(async (f) => {
    const styled = applyStyle(f.image_prompt, style);
    const enh = await enhancePrompt(styled);
    return { f, prompt: enh };
  }));

  // Submit all tasks in parallel (no delays)
  logLine(`submitting ${enhanced.length} image tasks in parallel...`);
  const submitted = await Promise.all(enhanced.map(async ({ f, prompt }) => {
    let task = null;
    if (useRefs) {
      const refs = (f.characters_present || []).map(id => refById.get(id)).filter(Boolean).slice(0, 3);
      if (refs.length) {
        const anchorPrompt = `${prompt} — IMPORTANT: keep the exact same faces, hair, skin tone and wardrobe as the reference portrait(s). Do not change character identity.`;
        task = await submitImg2ImgTask(anchorPrompt, refs, imageModel, ratio);
      }
    }
    if (!task) {
      const q = `${imageEndpoint(imageModel)}?prompt=${encodeURIComponent(prompt)}&model=${encodeURIComponent(imageModel)}&ratio=${encodeURIComponent(ratio)}`;
      task = await submitTask(q);
    }
    if (task) { logLine(`frame ${f.frame}: submitted (${useRefs && f.characters_present?.length ? 'img2img' : 't2i'})`); return { f, task }; }
    else { job.failed.push(f.frame); job.done++; logLine(`frame ${f.frame}: SUBMIT FAILED`); return null; }
  }));

  // Wait for all renders in parallel
  const results = submitted.filter(Boolean);
  logLine(`waiting for ${results.length} image renders in parallel...`);
  const urlMap = new Map();
  await Promise.all(results.map(async ({ f, task }) => {
    const url = await waitTask(task);
    if (url && await download(url, frameFile(f.frame))) { f.generated_image_url = url; urlMap.set(f.frame, url); job.ok++; logLine(`frame ${f.frame}: DONE`); }
    else { job.failed.push(f.frame); logLine(`frame ${f.frame}: FAILED`); }
    job.done++;
  }));

  // Save image URLs to frames.json
  if (urlMap.size > 0) {
    const allFrames = await readJson(FRAMES_JSON) || frames;
    for (const af of allFrames) { if (urlMap.has(af.frame)) af.generated_image_url = urlMap.get(af.frame); }
    await writeJson(FRAMES_JSON, allFrames);
  }
  logLine(`images finished: ${job.ok} ok, ${job.failed.length} failed`);
  job.phase = 'idle';
}

// ================================ VIDEO GENERATION (Grok Video) ================================

async function generateVideos(frames, ratio, videoModel = DEFAULT_VIDEO_MODEL) {
  const withAnim = frames.filter(f => f.animation_prompt);
  setPhase('videos', withAnim.length);
  logLine(`video phase: ${withAnim.length} frame(s) — ${videoModel} @ ${ratio}`);
  
  const work = withAnim.filter(f => !fs.existsSync(videoFile(f.frame)));
  for (const f of withAnim.filter(f => fs.existsSync(videoFile(f.frame)))) { job.done++; job.ok++; }
  if (work.length === 0) { logLine('all videos exist, skipping'); job.phase = 'idle'; return; }

  // Enhance all prompts in parallel
  logLine(`enhancing ${work.length} animation prompts in parallel...`);
  const enhanced = await Promise.all(work.map(async (f) => {
    const enh = await enhancePrompt(f.animation_prompt);
    return { f, prompt: enh };
  }));

  // Submit all tasks in parallel (no delays)
  logLine(`submitting ${enhanced.length} video tasks in parallel...`);
  const submitted = await Promise.all(enhanced.map(async ({ f, prompt }) => {
    const img = f.generated_image_url;
    const mode = img ? 'image-to-video' : 'text-to-video';
    const imgParam = img ? `&imageUrls=${encodeURIComponent(img)}` : '';
    const q = `/ai-video/${videoModel}?prompt=${encodeURIComponent(prompt)}&ratio=${encodeURIComponent(ratio)}&type=${mode}${imgParam}`;
    const task = await submitTask(q);
    if (task) { logLine(`frame ${f.frame}: submitted (${mode})`); return { f, task }; }
    else { job.failed.push(f.frame); job.done++; logLine(`frame ${f.frame}: SUBMIT FAILED`); return null; }
  }));

  // Wait for all renders in parallel
  const results = submitted.filter(Boolean);
  logLine(`waiting for ${results.length} video renders in parallel (can take several minutes)...`);
  await Promise.all(results.map(async ({ f, task }) => {
    const url = await waitTask(task, 25);
    if (url && await download(url, videoFile(f.frame))) { job.ok++; logLine(`frame ${f.frame}: VIDEO DONE`); }
    else { job.failed.push(f.frame); logLine(`frame ${f.frame}: VIDEO FAILED`); }
    job.done++;
  }));

  logLine(`videos finished: ${job.ok} ok, ${job.failed.length} failed`);
  job.phase = 'idle';
}

// ================================ TTS NARRATION (full film, single call) ================================

// Split text into chunks at sentence boundaries (to avoid API limits on long text)
function splitTextIntoChunks(text, maxLen = 1500) {
  const sentences = text.match(/[^.!?]+[.!?]+|\S+$/g) || [text];
  const chunks = [];
  let current = '';
  for (const s of sentences) {
    if ((current + s).length > maxLen) {
      if (current) chunks.push(current.trim());
      current = s;
    } else {
      current += s;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

// Generate ONE TTS for the entire film narration and overlay it on the final video
async function generateFullNarration(frames, voice = DEFAULT_VOICE, language = DEFAULT_LANGUAGE) {
  const withSpeech = frames.filter(f => f.narration || f.dialogue);
  if (!withSpeech.length) { logLine('no narration text found'); return false; }

  const voiceLabel = voice === 'male' ? 'male' : 'female';
  const langObj = LANGUAGES.find(l => l.id === language);
  const langName = langObj ? langObj.label : 'English';
  const baseInstructions = TTS_VOICE_INSTRUCTIONS[voice] || TTS_VOICE_INSTRUCTIONS.female;
  const langInstructions = language !== 'en' ? ` Speak entirely in ${langName}. Pronounce all ${langName} words naturally and fluently.` : '';
  const instructions = baseInstructions + langInstructions;

  // Assemble full narration script from all frames
  const fullText = withSpeech.map(f => {
    const parts = [f.narration, f.dialogue].filter(Boolean);
    return parts.join('. ');
  }).join('. ... ');

  logLine(`full narration: ${fullText.length} chars from ${withSpeech.length} frames — ${voiceLabel} voice, ${langName}`);

  // Split into chunks if text is long
  const chunks = splitTextIntoChunks(fullText);
  logLine(`split into ${chunks.length} chunk(s)`);

  const chunkFiles = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunkPath = path.join(VIDEO_DIR, `narr_chunk_${String(i + 1).padStart(2, '0')}.mp3`);
    if (fs.existsSync(chunkPath)) { chunkFiles.push(chunkPath); logLine(`chunk ${i+1}: exists, skip`); continue; }

    let chunkUrl = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        logLine(`chunk ${i+1}/${chunks.length}: generating TTS (attempt ${attempt})...`);
        const res = await fetch(`${AQUA_API}/v1/audio/speech`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${AQUA_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: TTS_MODEL,
            input: chunks[i],
            instructions,
            audio: { voice: 'mimo_default' }
          }),
          signal: AbortSignal.timeout(300000)
        });
        const j = await res.json().catch(() => ({}));
        if (res.ok && j.success && j.url) { chunkUrl = j.url; break; }
        else if (res.status === 429) {
          const wait = 15000 * attempt;
          logLine(`chunk ${i+1}: rate limited (429), waiting ${wait/1000}s...`);
          await new Promise(r => setTimeout(r, wait));
        } else {
          logLine(`chunk ${i+1}: API failed — ${JSON.stringify(j).slice(0,100)}`);
          break;
        }
      } catch (e) {
        logLine(`chunk ${i+1}: ERROR — ${e.message}`);
        if (attempt < 3) await new Promise(r => setTimeout(r, 5000 * attempt));
      }
    }

    if (chunkUrl) {
      if (await download(chunkUrl, chunkPath)) {
        chunkFiles.push(chunkPath);
        logLine(`chunk ${i+1}: DONE`);
      } else { logLine(`chunk ${i+1}: download failed`); }
    } else { logLine(`chunk ${i+1}: no URL received`); }

    // Longer delay between chunks to avoid rate limiting
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 3000));
  }

  if (chunkFiles.length === 0) { logLine('full narration: all chunks failed'); return false; }

  // Concatenate all chunk audio files into one narration file
  const fullAudioPath = path.join(VIDEO_DIR, 'full_narration.mp3');
  if (chunkFiles.length === 1) {
    fs.copyFileSync(chunkFiles[0], fullAudioPath);
  } else {
    logLine(`concatenating ${chunkFiles.length} narration chunks...`);
    const listPath = path.join(VIDEO_DIR, 'narr_concat.txt');
    await fsp.writeFile(listPath, chunkFiles.map(p => `file '${path.basename(p)}'`).join('\n'));
    await new Promise((resolve) => {
      execFile('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', fullAudioPath],
        { cwd: VIDEO_DIR, timeout: 30000 }, () => { try { fs.unlinkSync(listPath); } catch {} resolve(); });
    });
  }

  if (!fs.existsSync(fullAudioPath)) { logLine('full narration: concat failed'); return false; }
  logLine('full narration: audio assembled');

  // Get final video duration
  const finalPath = path.join(VIDEO_DIR, 'final_story.mp4');
  if (!fs.existsSync(finalPath)) { logLine('full narration: final_story.mp4 not found, overlay skipped'); return false; }

  // Check if final video already has audio
  const hasAudio = await new Promise((resolve) => {
    execFile('ffprobe', ['-v','error','-show_entries','stream=codec_type','-of','csv=p=0', finalPath], {timeout:10000}, (e, out) => {
      resolve(out && out.includes('audio'));
    });
  });

  const tempPath = finalPath + '.narr.mp4';
  logLine(`overlaying narration on final video (original audio: ${hasAudio ? 'mix' : 'replace'})...`);

  const success = await new Promise((resolve) => {
    if (hasAudio) {
      // Mix original audio + narration
      execFile('ffmpeg', [
        '-y', '-i', finalPath, '-i', fullAudioPath,
        '-filter_complex', '[0:a]volume=0.4[orig];[1:a]volume=1.5[narr];[orig][narr]amix=inputs=2:duration=first[a]',
        '-map', '0:v', '-map', '[a]',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
        '-shortest', tempPath
      ], {timeout: 120000}, (err) => { resolve(!err); });
    } else {
      // No original audio — just add narration
      execFile('ffmpeg', [
        '-y', '-i', finalPath, '-i', fullAudioPath,
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
        '-map', '0:v:0', '-map', '1:a:0',
        '-shortest', tempPath
      ], {timeout: 120000}, (err) => { resolve(!err); });
    }
  });

  if (success && fs.existsSync(tempPath)) {
    try { fs.unlinkSync(finalPath); fs.renameSync(tempPath, finalPath); } catch {}
    const size = (fs.statSync(finalPath).size / 1048576).toFixed(1);
    logLine(`full narration: OVERLAY COMPLETE — final film ${size}MB with narration`);
    return true;
  } else {
    logLine('full narration: overlay failed');
    try { fs.unlinkSync(tempPath); } catch {}
    return false;
  }
}

// Overlay TTS audio onto a video clip (returns path to narrated video or null)
function overlayAudioOnClip(videoPath, audioPath, outPath) {
  return new Promise((resolve) => {
    execFile('ffmpeg', [
      '-y', '-i', videoPath, '-i', audioPath,
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
      '-map', '0:v:0', '-map', '1:a:0',
      '-shortest', outPath
    ], { timeout: 120000 }, (err) => {
      if (err) { logLine(`audio overlay failed: ${err.message}`); resolve(null); }
      else resolve(outPath);
    });
  });
}

// Pad a video to a target duration by freezing the last frame (or create from still image)
function padVideoToDuration(inputPath, targetSec, outputPath) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', inputPath], { timeout: 15000 }, (err, stdout) => {
      const actual = parseFloat(stdout) || 0;
      const gap = targetSec - actual;
      if (gap <= 0.5) {
        // Close enough — copy and ensure audio track exists
        execFile('ffmpeg', ['-y', '-i', inputPath, '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
          '-t', String(actual), '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
          '-map', '0:v:0', '-map', '1:a:0', '-shortest', outputPath], { timeout: 60000 }, (e) => {
          if (e) try { fs.copyFileSync(inputPath, outputPath); } catch {}
          resolve(actual);
        });
        return;
      }
      // Pad: freeze last frame for the gap duration
      execFile('ffmpeg', [
        '-y', '-i', inputPath,
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-vf', `tpad=stop_mode=clone:stop_duration=${gap.toFixed(1)}`,
        '-c:v', 'libx264', '-crf', '18', '-preset', 'fast',
        '-c:a', 'aac', '-b:a', '128k',
        '-map', '0:v:0', '-map', '1:a:0', '-shortest',
        outputPath
      ], { timeout: 120000 }, (e) => {
        if (e) {
          logLine(`tpad failed for ${path.basename(inputPath)}, trying stream_loop fallback: ${e.message.slice(0,80)}`);
          // Fallback: loop the video
          execFile('ffmpeg', [
            '-y', '-stream_loop', '-1', '-i', inputPath,
            '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
            '-t', String(targetSec),
            '-c:v', 'libx264', '-crf', '18', '-preset', 'fast',
            '-c:a', 'aac', '-b:a', '128k',
            '-map', '0:v:0', '-map', '1:a:0',
            outputPath
          ], { timeout: 120000 }, (e2) => {
            if (e2) { logLine(`loop fallback also failed: ${e2.message.slice(0,80)}`); try { fs.copyFileSync(inputPath, outputPath); } catch {} resolve(actual); }
            else resolve(targetSec);
          });
        } else {
          resolve(targetSec);
        }
      });
    });
  });
}

// Add a silent audio track to a video (for consistent concat when no TTS available)
function addSilentAudio(inputPath, outputPath) {
  return new Promise((resolve) => {
    execFile('ffmpeg', [
      '-y', '-i', inputPath,
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
      '-map', '0:v:0', '-map', '1:a:0', '-shortest',
      outputPath
    ], { timeout: 60000 }, (err) => {
      if (err) { logLine(`addSilentAudio failed: ${err.message.slice(0,80)}`); try { fs.copyFileSync(inputPath, outputPath); } catch {} }
      resolve(!err);
    });
  });
}

// Create a video from a still image for a given duration (placeholder for missing video)
function stillImageToVideo(imagePath, targetSec, outputPath) {
  return new Promise((resolve) => {
    execFile('ffmpeg', [
      '-y', '-loop', '1', '-i', imagePath,
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-c:v', 'libx264', '-crf', '18', '-preset', 'fast',
      '-t', String(targetSec), '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:a', 'aac', '-b:a', '128k',
      '-map', '0:v:0', '-map', '1:a:0',
      outputPath
    ], { timeout: 120000 }, (err) => {
      if (err) { logLine(`still-to-video failed: ${err.message}`); resolve(0); }
      else resolve(targetSec);
    });
  });
}

// ================================ FINAL FILM CONCATENATION ================================

async function combineFilm(frames, ratio = '16:9') {
  setPhase('combining', 1);
  const finalPath = path.join(VIDEO_DIR, 'final_story.mp4');
  try { fs.unlinkSync(finalPath); } catch {}

  if (frames.length === 0) { logLine('no frames to combine'); job.phase = 'idle'; return null; }

  // Calculate target dimensions from ratio
  const ratioParts = ratio.split(':');
  const rw = parseInt(ratioParts[0]) || 16;
  const rh = parseInt(ratioParts[1]) || 9;
  const normW = rw >= rh ? 1280 : 720;
  const normH = rw >= rh ? 720 : 1280;
  const squareW = rw === rh ? 1080 : normW;
  const squareH = rw === rh ? 1080 : normH;
  const targetW = rw === rh ? 1080 : normW;
  const targetH = rw === rh ? 1080 : normH;
  logLine(`combine: target resolution ${targetW}x${targetH} (${ratio})`);

  const sorted = [...frames].sort((a, b) => a.frame - b.frame);
  const workDir = path.join(VIDEO_DIR, 'clips');
  fs.mkdirSync(workDir, { recursive: true });
  const normClips = [];

  logLine(`preparing ${sorted.length} clips (audio + normalize in one pass)...`);
  for (const f of sorted) {
    const vf = videoFile(f.frame);
    const tf = ttsFile(f.frame);
    const clipPath = path.join(workDir, `clip_${String(f.frame).padStart(2, '0')}.mp4`);
    const targetDur = f.duration_sec || 6;  // Grok Video generates 6-second clips
    const vfArgs = [`scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease`, `pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2`, 'setsar=1', 'fps=24'];

    let sourceVideo = null;
    if (fs.existsSync(vf)) {
      sourceVideo = vf;
    } else {
      const img = frameFile(f.frame);
      if (fs.existsSync(img)) {
        logLine(`frame ${f.frame}: no video, creating from still image`);
        // Still image → normalized video with silent audio
        await new Promise((resolve) => {
          execFile('ffmpeg', [
            '-y', '-loop', '1', '-i', img,
            '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
            '-t', String(targetDur), '-vf', vfArgs.join(','),
            '-c:v', 'libx264', '-crf', '20', '-preset', 'ultrafast',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '128k',
            '-map', '0:v:0', '-map', '1:a:0',
            clipPath
          ], { timeout: 60000 }, (e) => {
            if (e) logLine(`frame ${f.frame}: still-to-video failed: ${e.message.slice(0,80)}`);
            resolve();
          });
        });
        if (fs.existsSync(clipPath)) normClips.push(clipPath);
        else logLine(`frame ${f.frame}: skipped — still image creation failed`);
        continue;
      }
      logLine(`frame ${f.frame}: skipped — no video or image`);
      continue;
    }

    // ONE pass: normalize video + audio (keep original or add silent)
    // TTS narration is now added AFTER combine, not per-frame
    const hasAudio = await new Promise((resolve) => {
      execFile('ffprobe', ['-v','error','-show_entries','stream=codec_type','-of','csv=p=0', sourceVideo], { timeout: 10000 }, (e, out) => {
        resolve(out && out.includes('audio'));
      });
    });
    if (hasAudio) {
      logLine(`frame ${f.frame}: normalize + original audio`);
      await new Promise((resolve) => {
        execFile('ffmpeg', [
          '-y', '-i', sourceVideo,
          '-vf', vfArgs.join(','),
          '-c:v', 'libx264', '-crf', '20', '-preset', 'ultrafast',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
          '-map', '0:v:0', '-map', '0:a:0',
          clipPath
        ], { timeout: 60000 }, (e) => { if (e) logLine(`frame ${f.frame}: normalize failed: ${e.message.slice(0,80)}`); resolve(); });
      });
    } else {
      logLine(`frame ${f.frame}: normalize + silent audio`);
      await new Promise((resolve) => {
        execFile('ffmpeg', [
          '-y', '-i', sourceVideo,
          '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
          '-vf', vfArgs.join(','),
          '-c:v', 'libx264', '-crf', '20', '-preset', 'ultrafast',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '128k',
          '-map', '0:v:0', '-map', '1:a:0', '-shortest',
          clipPath
        ], { timeout: 60000 }, (e) => { if (e) logLine(`frame ${f.frame}: normalize failed: ${e.message.slice(0,80)}`); resolve(); });
      });
    }
    if (fs.existsSync(clipPath)) normClips.push(clipPath);
  }

  if (normClips.length === 0) { logLine('no clips to combine'); job.phase = 'idle'; return null; }

  // Final concat — copy mode (instant, no re-encoding)
  logLine(`concatenating ${normClips.length} clips (copy mode)...`);
  const listPath = path.join(VIDEO_DIR, 'concat_list.txt');
  await fsp.writeFile(listPath, normClips.map(p => `file '${path.relative(VIDEO_DIR, p).replace(/\\/g, '/')}'`).join('\n'));

  return new Promise((resolve) => {
    execFile('ffmpeg', [
      '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c', 'copy', '-movflags', '+faststart',
      finalPath
    ], { cwd: VIDEO_DIR, timeout: 120000 }, async (err) => {
      try { fs.unlinkSync(listPath); } catch {}
      const outExists = fs.existsSync(finalPath) && fs.statSync(finalPath).size > 10000;
      if (outExists) {
        const stats = await fsp.stat(finalPath).catch(() => null);
        const dur = await new Promise(r => execFile('ffprobe', ['-v','error','-show_entries','format=duration','-of','csv=p=0', finalPath], {timeout:10000}, (e,o)=>r(parseFloat(o)||0)));
        logLine(`final film: ${stats ? (stats.size/1048576).toFixed(1)+'MB' : 'created'} — ${normClips.length} clips — ${dur.toFixed(1)}s`);
        job.done = 1; job.ok = 1;
      } else if (err) {
        logLine(`concat copy failed, trying re-encode: ${err.message.slice(0,80)}`);
        // Fallback: re-encode concat
        execFile('ffmpeg', ['-y','-f','concat','-safe','0','-i',listPath,
          '-c:v','libx264','-crf','20','-preset','ultrafast',
          '-c:a','aac','-b:a','128k','-movflags','+faststart', finalPath],
          { cwd: VIDEO_DIR, timeout: 120000 }, async (e2) => {
            if (e2) { logLine(`final film failed: ${e2.message.slice(0,120)}`); job.failed.push('final'); }
            else { const s = await fsp.stat(finalPath).catch(()=>null); logLine(`final film created (re-encode mode): ${s?(s.size/1048576).toFixed(1)+'MB':''} — ${normClips.length} clips`); }
            job.done = 1; job.ok = job.failed.length ? 0 : 1;
            job.phase = 'idle'; resolve(fs.existsSync(finalPath) ? finalPath : null);
          });
        return;
      }
      job.phase = 'idle'; resolve(finalPath);
    });
  });
}

// ================================ CLEAN STALE OUTPUTS ================================

function patternToRegex(pattern) {
  const re = pattern
    .replace(/\./g, '\\.')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp('^' + re + '$', 'i');
}

function moveMatches(dir, pattern, destDir) {
  const regex = patternToRegex(pattern);
  const moved = [];
  for (const item of fs.readdirSync(dir)) {
    if (regex.test(item)) {
      try {
        fs.renameSync(path.join(dir, item), path.join(destDir, item));
        moved.push(item);
      } catch (e) { logLine(`clean: could not move ${item}: ${e.message}`); }
    }
  }
  return moved;
}

async function cleanOutputs() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fb = path.join(FRAMES_DIR, `backup_${ts}`);
  const vb = path.join(VIDEO_DIR, `backup_${ts}`);
  fs.mkdirSync(fb, { recursive: true });
  fs.mkdirSync(vb, { recursive: true });

  const movedFrames = [];
  for (const pat of ['frame_*.png', 'char_*.png']) {
    movedFrames.push(...moveMatches(FRAMES_DIR, pat, fb));
  }
  const movedVideo = [];
  for (const pat of ['frame_*.mp4', 'narrated_*.mp4', 'narration_*.mp3', 'final_story.mp4']) {
    movedVideo.push(...moveMatches(VIDEO_DIR, pat, vb));
  }

  logLine(`cleaned outputs -> ${fb} (${movedFrames.length} files), ${vb} (${movedVideo.length} files)`);
  return { backedUpTo: { frames: fb, video: vb }, moved: { frames: movedFrames, video: movedVideo } };
}

// ================================ AI INFLUENCER STUDIO ================================

const INFLUENCER_PROMPT = `You are a character designer for AI influencer generation. Given simple profile inputs, write ONE hyper-detailed physical description paragraph (200-300 words) that will be used VERBATIM in every image prompt to keep the person identical across all photos.

Include: exact face shape, ethnicity/skin tone with undertone, precise hair color+style+length, eye color+shape+lash detail, age, height/build/body shape, nose/lip/ jawline specifics, any distinguishing marks (moles, freckles, scars, tattoos), EXACT default wardrobe from top to bottom with colors/materials, accessories (jewelry, watches, piercings), and a one-line personality vibe. Do NOT include the character's name or backstory. Write as a continuous descriptive paragraph of physical appearance only. No preamble, no markdown, no headings — just the description text.`;

// LLM-expand the profile inputs into a locked physical description
async function expandInfluencerDescription(profile, model) {
  const inputs = Object.entries(profile).filter(([k]) => !['description', 'id', 'createdAt'].includes(k)).map(([k, v]) => `${k}: ${v}`).join('\n');
  const messages = [
    { role: 'system', content: INFLUENCER_PROMPT },
    { role: 'user', content: `Profile inputs:\n${inputs}\n\nWrite the locked physical description paragraph now.` }
  ];
  let content = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { content = await chatCompletion(model, messages, 2000); if (content && content.length > 100) break; }
    catch (e) { inflLogLine(`influencer expand attempt ${attempt}: ${e.message}`); }
  }
  return content.trim();
}

// Generate 4 reference portraits to lock the character's look
async function generateInfluencerRefs(infl) {
  fs.mkdirSync(influencerDir(infl.id), { recursive: true });
  const refPrompts = [
    `candid smartphone selfie portrait, natural daylight, looking at camera with a soft genuine smile, slight head tilt, casual real-life influencer vibe, shot on iPhone front camera, shallow depth of field`,
    `candid 3/4 body street-style photo, natural window light from the left, relaxed confident pose, everyday influencer outfit, shot on phone, 50mm equivalent`,
    `candid full body outfit-of-the-day photo standing outdoors, golden hour glow, confident natural pose, real-life influencer aesthetic, photorealistic phone photography`,
    `candid close-up beauty portrait, head tilted slightly, soft golden-hour glow, freckle and pore detail visible, intimate warm real-life photo, 100mm macro look`
  ];
  inflSetPhase('infl-refs', refPrompts.length);
  inflLogLine(`generating ${refPrompts.length} reference portraits for "${infl.name}"`);
  infl.refs = infl.refs || [];
  for (let i = 0; i < refPrompts.length; i++) {
    const out = inflRefFile(infl.id, i + 1);
    if (fs.existsSync(out)) { inflLogLine(`ref ${i + 1}: exists, skip`); if (!infl.refs[i] || !infl.refs[i].path) infl.refs[i] = { path: `ref_${String(i + 1).padStart(2, '0')}.png` }; inflJob.done++; inflJob.ok++; continue; }
    const rawPrompt = `${infl.description} ${refPrompts[i]}, ultra realistic photorealistic 8K, natural skin texture, professional photography`;
    const prompt = sanitizePrompt(rawPrompt);
    const q = `${imageEndpoint(IMAGE_MODELS[0])}?prompt=${encodeURIComponent(prompt)}&model=${encodeURIComponent(IMAGE_MODELS[0])}&ratio=1:1`;
    let url = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const task = await submitTask(q, inflLogLine);
      if (!task) { inflLogLine(`ref ${i + 1}: submit attempt ${attempt} failed, retrying in 10s...`); await new Promise(r => setTimeout(r, 10000)); continue; }
      inflLogLine(`ref ${i + 1}: rendering (attempt ${attempt})...`);
      url = await waitTask(task, 25, inflLogLine);
      if (url) break;
      inflLogLine(`ref ${i + 1}: attempt ${attempt} failed, retrying in 10s...`);
      await new Promise(r => setTimeout(r, 10000));
    }
    if (url && await download(url, out)) { infl.refs[i] = { path: `ref_${String(i + 1).padStart(2, '0')}.png`, url }; inflJob.ok++; inflLogLine(`ref ${i + 1}: DONE`); }
    else { inflJob.failed.push(i + 1); inflLogLine(`ref ${i + 1}: FAILED`); }
    inflJob.done++;
    await saveInfluencer(infl);  // save after each ref so progress isn't lost on crash
  }
  await saveInfluencer(infl);
  inflLogLine(`influencer refs finished: ${inflJob.ok} ok, ${inflJob.failed.length} failed`);
  inflJob.phase = 'idle';
}

// Generate a content image for an influencer (with verbatim character description prepended)
async function generateInfluencerContent(infl, userPrompt, style, ratio, imageModel) {
  fs.mkdirSync(influencerDir(infl.id), { recursive: true });
  inflSetPhase('infl-image', 1);
  inflLogLine(`generating content image for "${infl.name}"`);
  const styled = applyStyle(userPrompt, style);
  const hasDesc = userPrompt.includes(infl.description.slice(0, 50));
  const rawPrompt = hasDesc ? `${styled}, ultra realistic photorealistic 8K, natural skin texture` : `${infl.description} ${styled}, ultra realistic photorealistic 8K, natural skin texture`;
  const fullPrompt = sanitizePrompt(rawPrompt);
  inflLogLine(`prompt length: ${fullPrompt.length} chars`);
  const q = `${imageEndpoint(imageModel)}?prompt=${encodeURIComponent(fullPrompt)}&model=${encodeURIComponent(imageModel)}&ratio=${encodeURIComponent(ratio)}`;

  // Retry up to 4 times — "All providers failed" is intermittent on PaxSenix
  let url = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const task = await submitTask(q, inflLogLine);
    if (!task) { inflLogLine(`content image: submit attempt ${attempt} failed, retrying in 10s...`); await new Promise(r => setTimeout(r, 10000)); continue; }
    inflLogLine(`content image: rendering (attempt ${attempt})...`);
    url = await waitTask(task, 25, inflLogLine);
    if (url) break;
    inflLogLine(`content image: attempt ${attempt} failed, retrying in 10s...`);
    await new Promise(r => setTimeout(r, 10000));
  }
  if (!url) { inflJob.failed.push('content'); inflJob.done = 1; inflLogLine('content image: FAILED after 4 attempts'); inflJob.phase = 'idle'; return null; }
  const cid = `c_${Date.now()}`;
  const out = inflContentFile(infl.id, cid, 'png');
  if (await download(url, out)) {
    // Upload to catbox.moe for a stable public URL (Grok video requires .png/.jpg URL)
    let publicUrl = url;
    try { publicUrl = await uploadToCatbox(out); } catch (e) { inflLogLine(`upload failed: ${e.message}, using original URL`); }
    infl.content = infl.content || [];
    infl.content.unshift({ id: cid, prompt: userPrompt, style, ratio, imagePath: `${cid}.png`, imageUrl: publicUrl, videoPath: null, createdAt: Date.now() });
    await saveInfluencer(infl);
    inflJob.ok = 1; inflJob.done = 1; inflLogLine(`content image: DONE — ${cid}`);
  } else { inflJob.failed.push('content'); inflJob.done = 1; inflLogLine('content image: DOWNLOAD FAILED'); }
  inflJob.phase = 'idle';
  return cid;
}

// Generate content using img2img (transform a reference image based on prompt)
// Generate content using img2img. seedream-5 works (~70s). nano-banana gets stuck — skip it.
// Reference MUST be on PaxSenix servers (tmpfiles.paxsenix.org).
async function generateInfluencerContentImg2Img(infl, refUrl, userPrompt, style, ratio, imageModel) {
  fs.mkdirSync(influencerDir(infl.id), { recursive: true });
  inflSetPhase('infl-img2img', 1);
  inflLogLine(`generating img2img content for "${infl.name}"`);
  const styled = applyStyle(userPrompt, style);
  const fullPrompt = sanitizePrompt(styled);

  let url = null;
  // Try seedream-5 up to 3 times — it works but "All providers failed" is intermittent
  for (let attempt = 1; attempt <= 3; attempt++) {
    inflLogLine(`img2img: seedream-5 attempt ${attempt}/3...`);
    const postBody = JSON.stringify({ prompt: fullPrompt, model: 'seedream-5', ratio, image_urls: [refUrl] });
    let task = null;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 30000);
      const res = await fetch(`${API}/ai-img2img/seedream`, {
        method: 'POST', headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' }, body: postBody, signal: ac.signal
      });
      clearTimeout(timer);
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok && j.task_url) { task = j.task_url; }
      else { inflLogLine(`img2img submit: ${JSON.stringify(j).slice(0, 120)}`); }
    } catch (e) { inflLogLine(`img2img submit: ${e.message}`); }

    if (task) {
      inflLogLine(`img2img: rendering...`);
      url = await waitTask(task, 5, inflLogLine);
      if (url) { inflLogLine(`img2img: SUCCESS`); break; }
      inflLogLine(`img2img: render failed`);
    }
    if (attempt < 3) await new Promise(r => setTimeout(r, 10000));
  }

  if (!url) {
    inflLogLine('img2img failed — falling back to text-to-image with character description...');
    return await generateInfluencerContent(infl, userPrompt, style, ratio, imageModel);
  }

  const cid = `c_${Date.now()}`;
  const out = inflContentFile(infl.id, cid, 'png');
  if (await download(url, out)) {
    infl.content = infl.content || [];
    infl.content.unshift({ id: cid, prompt: userPrompt, style, ratio, imagePath: `${cid}.png`, imageUrl: url, videoPath: null, img2img: true, createdAt: Date.now() });
    await saveInfluencer(infl);
    inflJob.ok = 1; inflJob.done = 1; inflLogLine(`img2img content: DONE — ${cid}`);
  } else { inflJob.failed.push('img2img'); inflJob.done = 1; inflLogLine('img2img: DOWNLOAD FAILED'); }
  inflJob.phase = 'idle';
  return cid;
}

// Animate an existing influencer content image into video via Grok Video
async function generateInfluencerVideo(infl, contentId, ratio, videoDuration = 6) {
  const item = (infl.content || []).find(c => c.id === contentId);
  if (!item) { inflLogLine('video: content not found'); return; }
  fs.mkdirSync(influencerDir(infl.id), { recursive: true });
  inflSetPhase('infl-video', 1);
  inflLogLine(`generating ${videoDuration}s video for "${infl.name}" — ${contentId}`);

  let videoImageUrl = item.imageUrl;
  const localImagePath = inflContentFile(infl.id, contentId, 'png');
  if (!videoImageUrl && fs.existsSync(localImagePath)) {
    try {
      videoImageUrl = await uploadToImageHost(localImagePath);
      item.imageUrl = videoImageUrl;
      await saveInfluencer(infl);
    } catch (e) {
      inflLogLine(`upload for video failed: ${e.message}, trying stored URL`);
    }
  }

  const mode = videoImageUrl ? 'image-to-video' : 'text-to-video';
  const imgParam = videoImageUrl ? `&imageUrls=${encodeURIComponent(videoImageUrl)}` : '';
  // Keep the same person — emphasize identity preservation in animation
  const animPrompt = sanitizePrompt(`animate this exact person with natural subtle movement. Keep the same face, hair, skin, and clothing exactly as shown. ${item.prompt}. Smooth ${videoDuration}-second camera movement, natural animation, maintain visual consistency.`);
  const q = `/ai-video/grok-video?prompt=${encodeURIComponent(animPrompt)}&ratio=${encodeURIComponent(ratio)}&type=${mode}${imgParam}`;
  let url = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const task = await submitTask(q, inflLogLine);
    if (!task) { inflLogLine(`video: submit attempt ${attempt} failed, retrying in 10s...`); await new Promise(r => setTimeout(r, 10000)); continue; }
    inflLogLine(`video: rendering (attempt ${attempt}, targeting ${videoDuration}s clip)...`);
    url = await waitTask(task, 25, inflLogLine);
    if (url) break;
    inflLogLine(`video: attempt ${attempt} failed, retrying in 10s...`);
    await new Promise(r => setTimeout(r, 10000));
  }
  if (!url) { inflJob.failed.push(contentId); inflJob.done = 1; inflLogLine('video: FAILED after 3 attempts'); inflJob.phase = 'idle'; return; }
  if (await download(url, inflContentFile(infl.id, contentId, 'mp4'))) {
    item.videoPath = `${contentId}.mp4`;
    await saveInfluencer(infl);
    inflJob.ok = 1; inflLogLine(`video: DONE — ${contentId}`);
  } else { inflJob.failed.push(contentId); inflJob.done = 1; inflLogLine('video: FAILED'); }
  inflJob.done = 1;
  inflJob.phase = 'idle';
}

// ================================ HTTP SERVER ================================

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.json': 'application/json' };
function sendJson(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function readBody(req) { return new Promise((resolve, reject) => { let s = ''; req.on('data', c => { s += c; if (s.length > 15e6) req.destroy(); }); req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } }); req.on('error', reject); }); }

// Save uploaded base64 image as a reference photo.
// Uploads to uguu.se for a public URL that PaxSenix img2img can use directly.
async function saveUploadedRef(infl, dataUrl) {
  const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)/);
  if (!match) throw new Error('invalid image data URL');
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  fs.mkdirSync(influencerDir(infl.id), { recursive: true });
  const filename = `ref_01.${ext}`;
  const outPath = path.join(influencerDir(infl.id), filename);
  const buf = Buffer.from(match[2], 'base64');
  await fsp.writeFile(outPath, buf);
  inflLogLine(`photo saved: ${filename} (${(buf.length / 1024).toFixed(0)}KB)`);

  // Upload to uguu.se for a public URL
  let publicUrl = null;
  try {
    publicUrl = await uploadToImageHost(outPath);
    inflLogLine(`uploaded to uguu.se: ${publicUrl}`);
  } catch (e) {
    inflLogLine(`uguu.se upload failed: ${e.message}`);
  }

  // Clear ALL old refs — replace with this one uploaded photo + its public URL
  infl.refs = [{ path: filename, uploaded: true, ...(publicUrl ? { url: publicUrl } : {}) }];
  await saveInfluencer(infl);
  return filename;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;
  try {
    // --- API ---
    if (p === '/api/status') return sendJson(res, 200, job);
    if (p === '/api/models') return sendJson(res, 200, { chat: MODELS, image: IMAGE_MODELS, video: VIDEO_MODELS, voices: VOICES, languages: LANGUAGES, narrationModes: NARRATION_MODES, styles: STYLE_KEYS.map(k => ({ key: k, label: STYLES[k].label })) });

    if (p === '/api/characters') {
      const chars = await readJson(CHARS_JSON) || [];
      for (const c of chars) { c.hasRef = fs.existsSync(charRefFile(c.id)); }
      return sendJson(res, 200, { characters: chars });
    }

    if (p === '/api/frames') {
      const frames = await readJson(FRAMES_JSON) || [];
      const chars = await readJson(CHARS_JSON) || [];
      for (const f of frames) { f.hasImage = fs.existsSync(frameFile(f.frame)); f.hasVideo = fs.existsSync(videoFile(f.frame)); }
      const hasFinal = fs.existsSync(path.join(VIDEO_DIR, 'final_story.mp4'));
      return sendJson(res, 200, { characters: chars, frames, hasFinal });
    }

    if (p === '/api/storyboard' && req.method === 'POST') {
      if (job.phase !== 'idle') return sendJson(res, 409, { error: 'busy' });
      const { script, model, duration, look, language, clipDuration } = await readBody(req);
      if (!script || script.trim().length < 10) return sendJson(res, 400, { error: 'script too short' });
      const targetDuration = Math.max(10, Math.min(600, Number(duration) || 120));
      const secPerFrame = Number(clipDuration) || 6;
      setPhase('storyboard', 1); logLine(`storyboard generation: ${model || MODELS[0]} — target ${targetDuration}s — ${secPerFrame}s per clip`);
      (async () => {
        try {
          const { characters, frames } = await generateStoryboard(script, model || MODELS[0], targetDuration, look || '', language || DEFAULT_LANGUAGE, secPerFrame);
          job.ok = 1; job.done = 1;
          const totalDur = frames.reduce((s, f) => s + (f.duration_sec || 0), 0);
          logLine(`storyboard ready: ${characters.length} characters, ${frames.length} frames (${totalDur}s total)`);
        } catch (e) { job.failed.push(0); logLine(`storyboard FAILED: ${e.message}`); }
        job.phase = 'idle';
      })();
      return sendJson(res, 202, { started: true });
    }

    if (p === '/api/run-all' && req.method === 'POST') {
      if (job.phase !== 'idle') return sendJson(res, 409, { error: 'busy' });
      const body = await readBody(req);
      const script = (body.script || '').trim();
      if (script.length < 10) return sendJson(res, 400, { error: 'script too short' });
      const targetDuration = Math.max(10, Math.min(600, Number(body.duration) || 120));
      const narrationMode = body.narrationMode || DEFAULT_NARRATION_MODE;
      const language = body.language || DEFAULT_LANGUAGE;
      const secPerFrame = Number(body.clipDuration) || 6;
      (async () => {
        let characters = [], frames = [];
        try {
          setPhase('cleanup', 1); logLine('auto pipeline: archiving old outputs...');
          await cleanOutputs(); job.done = 1; job.ok = 1;

          setPhase('storyboard', 1); logLine(`auto pipeline: storyboard — ${body.model || MODELS[0]} — target ${targetDuration}s — ${secPerFrame}s per clip — narration: ${narrationMode} — language: ${language}`);
          const sb = await generateStoryboard(script, body.model || MODELS[0], targetDuration, body.look || '', language, secPerFrame);
          characters = sb.characters; frames = sb.frames;
          job.done = 1; job.ok = 1;
          logLine(`auto pipeline: storyboard ready — ${characters.length} characters, ${frames.length} frames`);
        } catch (e) { logLine(`auto pipeline FAILED at storyboard: ${e.message}`); job.phase = 'idle'; return; }

        // If prompt-vocalized mode: embed narration into video animation prompts
        let videoFrames = frames;
        if (narrationMode === 'prompt') {
          logLine('prompt-vocalized mode: embedding narration into video prompts');
          videoFrames = frames.map(f => {
            const clone = { ...f };
            const narr = [clone.narration, clone.dialogue].filter(Boolean).join('. ');
            if (narr) {
              clone.animation_prompt = `${clone.animation_prompt} The character narrates aloud: "${narr}". Lip-sync and natural speaking gestures should be visible.`;
            }
            return clone;
          });
        }

        const steps = [
          ['char-refs', () => generateCharRefs(characters, body.imageModel || IMAGE_MODELS[0], body.style || 'cinematic')],
          ['images', () => generateImages(frames, body.imageModel || IMAGE_MODELS[0], body.ratio || '16:9', body.style || 'cinematic', body.consistency !== false, characters)]
        ];
        if (narrationMode === 'prompt') {
          logLine('prompt-vocalized mode: narration embedded in video prompts, no TTS');
        }
        steps.push(['videos', () => generateVideos(videoFrames, body.ratio || '16:9', body.videoModel || DEFAULT_VIDEO_MODEL)]);
        steps.push(['combine', () => combineFilm(frames, body.ratio || '16:9')]);
        // After combine: generate full narration TTS and overlay on final video
        if (narrationMode === 'tts') {
          steps.push(['narration', () => { setPhase('narration', 1); return generateFullNarration(frames, body.voice || DEFAULT_VOICE, language).then(() => { job.phase = 'idle'; }); }]);
        }

        for (const [name, fn] of steps) {
          try { await fn(); }
          catch (e) { logLine(`auto pipeline: ${name} failed: ${e.message} — continuing`); job.phase = 'idle'; }
        }
        const finalPath = path.join(VIDEO_DIR, 'final_story.mp4');
        logLine(fs.existsSync(finalPath)
          ? `auto pipeline COMPLETE — final film ready (${(fs.statSync(finalPath).size / 1048576).toFixed(1)} MB)`
          : 'auto pipeline finished but final film is missing');
        job.phase = 'idle';
      })();
      return sendJson(res, 202, { started: true });
    }

    if (p === '/api/char-refs' && req.method === 'POST') {
      if (job.phase !== 'idle') return sendJson(res, 409, { error: 'busy' });
      const chars = await readJson(CHARS_JSON) || [];
      if (!chars.length) return sendJson(res, 400, { error: 'no characters — generate storyboard first' });
      const body = await readBody(req).catch(() => ({}));
      // Force re-render if requested (true = all, array = specific IDs)
      if (body.force === true) { for (const c of chars) { try { fs.unlinkSync(charRefFile(c.id)); } catch {} } }
      else if (Array.isArray(body.force)) { for (const id of body.force) { try { fs.unlinkSync(charRefFile(id)); } catch {} } }
      generateCharRefs(chars, body.imageModel || IMAGE_MODELS[0], body.style || 'cinematic').catch(e => { logLine(`char-refs crash: ${e.message}`); job.phase = 'idle'; });
      return sendJson(res, 202, { started: true, count: chars.length });
    }

    if (p === '/api/images' && req.method === 'POST') {
      if (job.phase !== 'idle') return sendJson(res, 409, { error: 'busy' });
      const body = await readBody(req).catch(() => ({}));
      let frames = await readJson(FRAMES_JSON) || [];
      if (!frames.length) return sendJson(res, 400, { error: 'no frames — generate storyboard first' });
      if (Array.isArray(body.frames) && body.frames.length) {
        const wanted = new Set(body.frames.map(Number));
        frames = frames.filter(f => wanted.has(f.frame));
        for (const f of frames) { try { fs.unlinkSync(frameFile(f.frame)); } catch {} }
      }
      const chars = await readJson(CHARS_JSON) || [];
      generateImages(frames, body.imageModel || IMAGE_MODELS[0], body.ratio || '16:9', body.style || 'cinematic', body.consistency !== false, chars).catch(e => { logLine(`images crash: ${e.message}`); job.phase = 'idle'; });
      return sendJson(res, 202, { started: true, count: frames.length });
    }

    if (p === '/api/videos' && req.method === 'POST') {
      if (job.phase !== 'idle') return sendJson(res, 409, { error: 'busy' });
      const body = await readBody(req).catch(() => ({}));
      const frames = await readJson(FRAMES_JSON) || [];
      if (!frames.length) return sendJson(res, 400, { error: 'no frames' });
      if (body.force) { for (const f of frames) { if (f.animation_prompt) { try { fs.unlinkSync(videoFile(f.frame)); } catch {} } } }
      generateVideos(frames, body.ratio || '16:9', body.videoModel || DEFAULT_VIDEO_MODEL).catch(e => { logLine(`videos crash: ${e.message}`); job.phase = 'idle'; });
      return sendJson(res, 202, { started: true, count: frames.filter(f => f.animation_prompt).length });
    }

    if (p === '/api/combine' && req.method === 'POST') {
      if (job.phase !== 'idle') return sendJson(res, 409, { error: 'busy' });
      const body = await readBody(req).catch(() => ({}));
      const frames = await readJson(FRAMES_JSON) || [];
      combineFilm(frames, body.ratio || '16:9').then(fp => { if (!fp) logLine('combine: no output'); }).catch(e => { logLine(`combine crash: ${e.message}`); job.phase = 'idle'; });
      return sendJson(res, 202, { started: true });
    }

    if (p === '/api/clean-outputs' && req.method === 'POST') {
      const info = await cleanOutputs();
      return sendJson(res, 200, info);
    }

    if (p === '/api/narration' && req.method === 'POST') {
      if (job.phase !== 'idle') return sendJson(res, 409, { error: 'busy' });
      const body = await readBody(req).catch(() => ({}));
      const frames = await readJson(FRAMES_JSON) || [];
      if (!frames.length) return sendJson(res, 400, { error: 'no frames' });
      // Delete old chunk files + full narration for fresh generation
      for (const f of frames) { try { fs.unlinkSync(ttsFile(f.frame)); } catch {} }
      for (const f of fs.readdirSync(VIDEO_DIR).filter(f => f.startsWith('narr_chunk_') || f === 'full_narration.mp3')) { try { fs.unlinkSync(path.join(VIDEO_DIR, f)); } catch {} }
      setPhase('narration', 1);
      (async () => {
        try { await generateFullNarration(frames, body.voice || DEFAULT_VOICE, body.language || DEFAULT_LANGUAGE); }
        catch (e) { logLine(`narration crash: ${e.message}`); }
        job.phase = 'idle';
      })();
      return sendJson(res, 202, { started: true, count: frames.filter(f => f.narration || f.dialogue).length });
    }

    // =================== AI INFLUENCER ROUTES ===================
    if (p === '/api/influencers' && req.method === 'GET') {
      const all = await readInfluencers();
      const list = all.map(i => ({
        id: i.id, name: i.name, age: i.age, vibe: i.vibe,
        hasRefs: i.refs && i.refs.length > 0 && fs.existsSync(inflRefFile(i.id, 1)),
        refCount: (i.refs || []).filter(r => fs.existsSync(influencerDir(i.id) + '/' + r.path)).length,
        contentCount: (i.content || []).filter(c => fs.existsSync(inflContentFile(i.id, c.id, 'png'))).length,
        videoCount: (i.content || []).filter(c => c.videoPath && fs.existsSync(inflContentFile(i.id, c.id, 'mp4'))).length,
        createdAt: i.createdAt
      }));
      return sendJson(res, 200, { influencers: list });
    }

    if (p === '/api/influencer' && req.method === 'GET') {
      const id = u.searchParams.get('id');
      if (!id) return sendJson(res, 400, { error: 'id required' });
      const infl = await findInfluencer(id);
      if (!infl) return sendJson(res, 404, { error: 'not found' });
      // attach exists flags
      for (const r of (infl.refs || [])) r.exists = fs.existsSync(influencerDir(id) + '/' + r.path);
      for (const c of (infl.content || [])) { c.hasImage = fs.existsSync(inflContentFile(id, c.id, 'png')); c.hasVideo = c.videoPath && fs.existsSync(inflContentFile(id, c.id, 'mp4')); }
      return sendJson(res, 200, { influencer: infl });
    }

    if (p === '/api/influencer/save' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.name) return sendJson(res, 400, { error: 'name required' });
      let infl;
      if (body.id) {
        infl = await findInfluencer(body.id);
        if (!infl) {
          // New influencer with a client-generated ID — create it instead of 404
          infl = { id: body.id, createdAt: Date.now(), refs: [], content: [] };
        }
        for (const k of ['name', 'age', 'gender', 'ethnicity', 'hair', 'eyes', 'bodyType', 'defaultWardrobe', 'signatureTrait', 'vibe', 'description', 'model']) {
          if (body[k] !== undefined) infl[k] = body[k];
        }
        if (!infl.refs) infl.refs = [];
        if (!infl.content) infl.content = [];
      } else {
        infl = { id: `infl_${Date.now()}`, createdAt: Date.now(), refs: [], content: [] };
        for (const k of ['name', 'age', 'gender', 'ethnicity', 'hair', 'eyes', 'bodyType', 'defaultWardrobe', 'signatureTrait', 'vibe', 'description', 'model']) {
          if (body[k] !== undefined) infl[k] = body[k];
        }
      }
      await saveInfluencer(infl);
      return sendJson(res, 200, { influencer: infl });
    }

    if (p === '/api/influencer/expand' && req.method === 'POST') {
      if (inflJob.phase !== 'idle') return sendJson(res, 409, { error: 'busy' });
      const body = await readBody(req);
      const { profile, model } = body;
      if (!profile || !profile.name) return sendJson(res, 400, { error: 'profile.name required' });
      inflSetPhase('infl-expand', 1);
      inflLogLine(`expanding character description for "${profile.name}"`);
      (async () => {
        try {
          const description = await expandInfluencerDescription(profile, model || 'gemini-2.5-pro');
          if (description) { profile.description = description; inflLogLine(`description expanded (${description.length} chars)`); }
          else { inflLogLine('description expand: empty'); }
          if (body.id) {
            let infl = await findInfluencer(body.id);
            if (!infl) {
              infl = { id: body.id, createdAt: Date.now(), refs: [], content: [] };
              Object.assign(infl, profile);
            }
            infl.description = description;
            infl.model = model;
            await saveInfluencer(infl);
          }
        } catch (e) { inflLogLine(`expand crash: ${e.message}`); }
        inflJob.done = 1; inflJob.ok = 1; inflJob.phase = 'idle';
      })();
      return sendJson(res, 202, { started: true });
    }

    if (p === '/api/influencer/refs' && req.method === 'POST') {
      if (inflJob.phase !== 'idle') return sendJson(res, 409, { error: 'busy' });
      const body = await readBody(req);
      if (!body.id) return sendJson(res, 400, { error: 'id required' });
      const infl = await findInfluencer(body.id);
      if (!infl) return sendJson(res, 404, { error: 'not found' });
      if (!infl.description) return sendJson(res, 400, { error: 'no description — expand profile first' });
      if (body.force) { for (let i = 1; i <= 4; i++) { try { fs.unlinkSync(inflRefFile(body.id, i)); } catch {} } infl.refs = []; }
      generateInfluencerRefs(infl).catch(e => { inflLogLine(`infl-refs crash: ${e.message}`); inflJob.phase = 'idle'; });
      return sendJson(res, 202, { started: true });
    }

    if (p === '/api/influencer/upload-ref' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.id) return sendJson(res, 400, { error: 'id required' });
      if (!body.image || !body.image.startsWith('data:image/')) return sendJson(res, 400, { error: 'image data URL required' });
      let infl = await findInfluencer(body.id);
      if (!infl) {
        infl = { id: body.id, createdAt: Date.now(), name: body.name || 'Untitled', refs: [], content: [] };
        await saveInfluencer(infl);
        inflLogLine(`created influencer ${body.id} on upload`);
      }
      try {
        const filename = await saveUploadedRef(infl, body.image);
        inflLogLine(`uploaded ref ${filename} for ${body.id}`);
        // Re-read the influencer to get updated description
        const updated = await findInfluencer(body.id) || infl;
        return sendJson(res, 200, { ok: true, filename, influencer: updated });
      } catch (e) { return sendJson(res, 500, { error: e.message }); }
    }

    if (p === '/api/influencer/delete-ref' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.id || !body.index) return sendJson(res, 400, { error: 'id and index required' });
      const infl = await findInfluencer(body.id);
      if (!infl) return sendJson(res, 404, { error: 'not found' });
      const idx = body.index - 1;
      if (infl.refs && infl.refs[idx]) {
        try { fs.unlinkSync(path.join(influencerDir(body.id), infl.refs[idx].path)); } catch {}
        infl.refs.splice(idx, 1);
        await saveInfluencer(infl);
      }
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/influencer/image' && req.method === 'POST') {
      if (inflJob.phase !== 'idle') return sendJson(res, 409, { error: 'busy' });
      const body = await readBody(req);
      if (!body.id || !body.prompt) return sendJson(res, 400, { error: 'id and prompt required' });
      const infl = await findInfluencer(body.id);
      if (!infl) return sendJson(res, 404, { error: 'not found' });
      if (!infl.description) return sendJson(res, 400, { error: 'no description' });
      generateInfluencerContent(infl, body.prompt, body.style || 'realistic', body.ratio || '1:1', body.imageModel || IMAGE_MODELS[0]).catch(e => { inflLogLine(`infl-image crash: ${e.message}`); inflJob.phase = 'idle'; });
      return sendJson(res, 202, { started: true });
    }

    // ---- img2img: transform a reference image ----
    if (p === '/api/influencer/img2img' && req.method === 'POST') {
      if (inflJob.phase !== 'idle') return sendJson(res, 409, { error: 'busy' });
      const body = await readBody(req);
      if (!body.id || !body.prompt) return sendJson(res, 400, { error: 'id and prompt required' });
      const infl = await findInfluencer(body.id);
      if (!infl) return sendJson(res, 404, { error: 'not found' });
      
      // Get reference URL for img2img (uploaded photo on uguu.se)
      let refUrl = body.refUrl;
      if (!refUrl) {
        refUrl = await resolveInfluencerRefUrl(infl);
      }
      
      if (refUrl) {
        // img2img with the uploaded photo's public URL (uguu.se)
        inflLogLine(`img2img using reference: ${refUrl.slice(0, 60)}`);
        generateInfluencerContentImg2Img(infl, refUrl, body.prompt, body.style || 'realistic', body.ratio || '1:1', body.imageModel || IMAGE_MODELS[0]).catch(e => { inflLogLine(`infl-img2img crash: ${e.message}`); inflJob.phase = 'idle'; });
      } else {
        // No reference URL — use text-to-image with character description
        inflLogLine('no reference URL — using text-to-image with character description');
        generateInfluencerContent(infl, body.prompt, body.style || 'realistic', body.ratio || '1:1', body.imageModel || IMAGE_MODELS[0]).catch(e => { inflLogLine(`infl-image crash: ${e.message}`); inflJob.phase = 'idle'; });
      }
      return sendJson(res, 202, { started: true });
    }

    if (p === '/api/influencer/video' && req.method === 'POST') {
      if (inflJob.phase !== 'idle') return sendJson(res, 409, { error: 'busy' });
      const body = await readBody(req);
      if (!body.id || !body.contentId) return sendJson(res, 400, { error: 'id and contentId required' });
      const infl = await findInfluencer(body.id);
      if (!infl) return sendJson(res, 404, { error: 'not found' });
      generateInfluencerVideo(infl, body.contentId, body.ratio || '1:1').catch(e => { inflLogLine(`infl-video crash: ${e.message}`); inflJob.phase = 'idle'; });
      return sendJson(res, 202, { started: true });
    }

    // ---- AUTO CREATE: one-click full pipeline (desc → refs → scene → img2img → video) ----
    if (p === '/api/influencer/auto-create' && req.method === 'POST') {
      if (inflJob.phase !== 'idle') return sendJson(res, 409, { error: 'busy' });
      const body = await readBody(req);
      if (!body.id) return sendJson(res, 400, { error: 'id required' });
      const infl = await findInfluencer(body.id);
      if (!infl) return sendJson(res, 404, { error: 'not found' });
      const style = body.style || 'realistic';
      const ratio = body.ratio || '1:1';
      const imageModel = body.imageModel || IMAGE_MODELS[0];
      const fallbackModels = ['kimi-2.7-code', 'glm-5.2', 'mimo-v2.5', 'gemini-2.5-pro'];
      function nextModel(prev) { return fallbackModels.find(m => m !== prev) || fallbackModels[0]; }
      inflSetPhase('auto-create', 5);
      const restorePhase = (step) => { inflJob.phase = 'auto-create'; inflJob.total = 5; inflJob.done = step; };
      (async () => {
        try {
          // --- STEP 1: Generate description if missing ---
          if (!infl.description) {
            inflLogLine('step 1/5: generating character description...');
            const profile = {
              name: infl.name, age: infl.age, gender: infl.gender, ethnicity: infl.ethnicity,
              hair: infl.hair, eyes: infl.eyes, bodyType: infl.bodyType,
              defaultWardrobe: infl.defaultWardrobe, signatureTrait: infl.signatureTrait, vibe: infl.vibe
            };
            let model = 'gemini-3.1-pro';
            let desc = '';
            for (let attempt = 0; attempt < 4; attempt++) {
              try { desc = await expandInfluencerDescription(profile, model); if (desc && desc.length > 100) break; }
              catch (e) { inflLogLine(`desc attempt ${attempt+1} (${model}): ${e.message}`); }
              model = nextModel(model);
            }
            if (!desc) throw new Error('failed to generate description on all models');
            infl.description = desc;
            await saveInfluencer(infl);
            inflLogLine(`description generated (${desc.length} chars)`);
          } else { inflLogLine('step 1/5: description exists, skip'); }
          restorePhase(1);

          // --- STEP 2: Generate reference portraits if missing URLs ---
          const hasRefUrl = (infl.refs || []).some(r => r && r.url);
          if (!hasRefUrl) {
            inflLogLine('step 2/5: generating reference portraits (no URLs found, regenerating)...');
            // Force regeneration: delete old ref files so they aren't skipped
            for (let i = 1; i <= 4; i++) { try { fs.unlinkSync(inflRefFile(infl.id, i)); } catch {} }
            infl.refs = [];
            await generateInfluencerRefs(infl);
          } else { inflLogLine('step 2/5: refs with URLs exist, skip'); }
          restorePhase(2);

          // --- STEP 3: Generate real-life influencer scene via LLM ---
          inflLogLine('step 3/5: generating scene concept...');
          const scenePrompt = `You are a creative director for real-life social media influencers on Instagram/TikTok.
Given a character description, write ONE candid everyday scene that looks like a REAL influencer post — NOT cinematic, NOT staged, NOT movie-like.
Think: morning coffee routine, golden hour street walk, cozy cafe work session, gym mirror selfie, shopping haul, sunset balcony moment, weekend brunch, casual mirror selfie, park picnic, rainy window vibes, lazy morning in bed, cooking in kitchen, yoga in garden.

Return ONLY a JSON object:
{
  "scene_prompt": "60-120 words. Photorealistic smartphone photo quality. Candid, natural, everyday-life feel. Describe the character doing a casual real-life activity. Include the character description verbatim. Mention natural lighting (window light, golden hour, overcast, cafe ambient).",
  "animation_prompt": "one sentence: describe natural subtle motion for a 6s smartphone video (e.g., she lifts the coffee cup, takes a sip, smiles softly; gentle handheld phone sway)",
  "caption": "a short Instagram caption with 2-3 relevant hashtags"
}`;
          const sceneMsgs = [
            { role: 'system', content: scenePrompt },
            { role: 'user', content: `Character description:\n${infl.description}\n\nCreate ONE real-life influencer scene. Return ONLY the JSON.` }
          ];
          let sceneContent = '', sceneModel = 'gemini-3.1-pro';
          for (let attempt = 0; attempt < 4; attempt++) {
            try { sceneContent = await chatCompletion(sceneModel, sceneMsgs, 3000); if (sceneContent) break; }
            catch (e) { inflLogLine(`scene attempt ${attempt+1} (${sceneModel}): ${e.message}`); sceneModel = nextModel(sceneModel); }
          }
          if (!sceneContent) throw new Error('LLM returned no scene');
          let scene;
          try {
            const s = sceneContent.indexOf('{');
            const e = sceneContent.lastIndexOf('}');
            scene = JSON.parse(sceneContent.slice(s, e + 1));
          } catch { throw new Error('failed to parse scene JSON'); }
          inflLogLine(`scene: "${scene.scene_prompt?.slice(0, 80)}..."`);
          restorePhase(3);

          // --- STEP 4: Generate image ---
          inflLogLine('step 4/5: generating image...');
          let cid = null;
          // Use custom prompt if provided, otherwise use scene prompt
          const finalImgPrompt = customImgPrompt || scene.scene_prompt;
          const resolvedRefUrl = await resolveInfluencerRefUrl(infl);
          if (resolvedRefUrl) {
            cid = await generateInfluencerContentImg2Img(infl, resolvedRefUrl, finalImgPrompt, style, ratio, imageModel);
          }
          if (!cid) {
            inflLogLine('img2img failed — using text-to-image with character description');
            cid = await generateInfluencerContent(infl, finalImgPrompt, style, ratio, imageModel);
          }
          if (!cid) throw new Error('image generation failed');
          inflLogLine('step 4/5: image DONE');
          restorePhase(4);

          // --- STEP 5: Animate to video ---
          inflLogLine('step 5/5: generating video...');
          const animItem = infl.content.find(c => c.id === cid);
          if (animItem) {
            animItem.animation_prompt = customVidPrompt || scene.animation_prompt;
            if (scene.caption) animItem.caption = scene.caption;
            await saveInfluencer(infl);
          }
          await generateInfluencerVideo(infl, cid, ratio, 6);
          inflLogLine('auto-create COMPLETE — scene → image → video done');
          inflJob.done = 5; inflJob.ok = 5;
        } catch (e) {
          inflLogLine(`auto-create FAILED: ${e.message}`);
        }
        inflJob.phase = 'idle';
      })();
      return sendJson(res, 202, { started: true });
    }

    if (p === '/api/influencer/delete' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.id) return sendJson(res, 400, { error: 'id required' });
      const all = await readInfluencers();
      const filtered = all.filter(i => i.id !== body.id);
      await writeInfluencers(filtered);
      try { fs.rmSync(influencerDir(body.id), { recursive: true, force: true }); } catch {}
      return sendJson(res, 200, { ok: true });
    }

    // Separate status endpoint for influencer jobs (independent from storyboard)
    if (p === '/api/infl/status') return sendJson(res, 200, inflJob);

    // ================================ TRENDING SYSTEM (TikTok AI Influencer + Instagram) ================================

        // Live TikTok trends only — no hardcoded query lists.
    // Primary: TrendsMCP live feeds. Optional: omkar video search using those live terms.
    const mapTrendRows = (rows, platform = 'tiktok') => (rows || []).map(([rank, name]) => ({
      id: platform + '_trend_' + rank + '_' + Date.now(),
      platform,
      caption: name,
      title: name,
      author: 'trending',
      authorName: 'Live Trends',
      views: null, likes: null, comments: null,
      cover: null, videoUrl: null, duration: null,
      fresh: true,
      fetchedAt: Date.now()
    }));

        // Live trending influencer content — no hardcoded lists, fresh every call
    if (p === '/api/trending/tiktok' && req.method === 'GET') {
      const max = Math.min(parseInt(u.searchParams.get('max') || '12'), 20);
      try {
        // 1) Get LIVE trending topics from TrendsMCP to build search queries
        let liveTerms = [];
        let liveAsOf = null;
        if (TRENDSMCP_KEY) {
          try {
            const [searches, hashtags] = await Promise.all([
              trendsMcpTop('TikTok Trending Searches', 20),
              trendsMcpTop('TikTok Trending Hashtags', 20)
            ]);
            liveAsOf = searches.as_of_ts || hashtags.as_of_ts || null;
            const seen = new Set();
            for (const row of [...(searches.data || []), ...(hashtags.data || [])]) {
              const name = String(row[1] || '').trim();
              if (!name || seen.has(name.toLowerCase())) continue;
              seen.add(name.toLowerCase());
              liveTerms.push(name);
            }
          } catch (e) { logLine('TrendsMCP: ' + e.message); }
        }

        // 2) Build influencer-focused queries from LIVE trends
        const influencerQueries = [
          'beauty influencer grwm trending ' + new Date().getFullYear(),
          'fashion haul ootd female influencer trending',
          'female lifestyle influencer vlog trending',
          'makeup tutorial viral beauty trend ' + new Date().getFullYear(),
          'get ready with me trending influencer'
        ];
        // Mix live trend terms into influencer queries for freshness
        if (liveTerms.length) {
          const top3 = liveTerms.slice(0, 3);
          for (const t of top3) {
            influencerQueries.push(t + ' influencer beauty');
            influencerQueries.push(t + ' grwm makeup');
          }
        }

        // 3) Search YouTube for real videos (yt-dlp, free, no API key)
        const perQ = Math.ceil(max / Math.min(influencerQueries.length, 5)) + 1;
        const topQueries = influencerQueries.slice(0, 5);
        const results = await Promise.all(topQueries.map(q => ytSearch(q, perQ)));

        // 4) Dedupe, sort by views, take top N
        const seen = new Set();
        const allVideos = results.flat().filter(v => {
          if (!v.id || seen.has(v.id)) return false;
          seen.add(v.id); return true;
        }).sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, max);

        return sendJson(res, 200, {
          source: 'trendsmcp-live+yt-influencer',
          as_of_ts: liveAsOf || null,
          liveTerms: liveTerms.slice(0, 5),
          videos: allVideos.map(v => ({
            id: v.id, platform: 'tiktok', caption: v.title, title: v.title,
            author: v.author, authorName: v.author,
            views: v.views, likes: v.likes, comments: null, shares: null,
            duration: v.duration, cover: v.thumbnail, videoUrl: v.url,
            audio: null, createdAt: null, fresh: true, fetchedAt: Date.now()
          }))
        });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }
if (p === '/api/trending/tiktok/search' && req.method === 'GET') {
      const q = u.searchParams.get('q') || '';
      const sort = u.searchParams.get('sort') || 'most_liked';
      const market = u.searchParams.get('market') || 'us';
      const max = Math.min(parseInt(u.searchParams.get('max') || '12'), 30);
      if (!q) return sendJson(res, 400, { error: 'q (query) required' });
      try {
        const r = await fetch(`${OMKAR_API}/tiktok/videos/search?search_query=${encodeURIComponent(q)}&market=${market}&max_results=${max}&sort_by=${sort}`, { headers: { 'API-Key': OMKAR_KEY } });
        const j = await r.json();
        return sendJson(res, 200, { videos: (j.videos || []).map(v => ({ id: v.video_id, platform: 'tiktok', caption: v.caption, author: v.author?.handle, authorName: v.author?.display_name, views: v.stats?.views, likes: v.stats?.likes, comments: v.stats?.comments, shares: v.stats?.shares, duration: v.duration_seconds, cover: v.thumbnails?.cover_url, videoUrl: v.media?.video_url, audio: v.audio?.title, createdAt: v.created_at })) });
      } catch (e) {
        // Fallback: TrendsMCP TikTok Trending Searches
        if (TRENDSMCP_KEY) {
          try {
            const data = await trendsMcpCall('trendsMCP___get_top_trends', { type: 'TikTok Trending Searches', limit: max });
            const videos = (data.data || []).map(([rank, name]) => ({
              id: 'trend_' + rank,
              platform: 'tiktok',
              caption: name,
              title: name,
              author: { handle: 'trending', display_name: 'TikTok Trends' },
              views: null, likes: null, comments: null,
              cover: null, videoUrl: null, duration: null
            }));
            return sendJson(res, 200, { videos, source: 'trendsmcp' });
          } catch (e2) { return sendJson(res, 500, { error: 'omkar: ' + e.message + ' | trendsmcp: ' + e2.message }); }
        }
        return sendJson(res, 500, { error: e.message });
      }
    }

    // ================================ TRENDS TAB (anime, AI-generated, lifestyle, etc.) ================================
    // Pulls LIVE trending terms from TrendsMCP and finds real videos via yt-dlp
    // Works without login, no rate limits. Cached 5 min per category.
    const trendsCache = new Map();
    if (p === '/api/trends' && req.method === 'GET') {
      const category = (u.searchParams.get('category') || 'anime').toLowerCase();
      const max = Math.min(parseInt(u.searchParams.get('max') || '20'), 30);
      const cacheKey = `${category}:${max}`;
      const cached = trendsCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < 300000) {
        return sendJson(res, 200, { ...cached.data, cached: true });
      }

      // Category-specific search queries tuned for yt-dlp + TrendsMCP
      // Short-form queries for both TikTok and YouTube Shorts (<= 60s)
      // Each query gets passed to BOTH yt-dlp (YouTube Shorts) and omkar (TikTok) in parallel
      const CATEGORY_QUERIES = {
        anime: ['anime edits', 'anime amv', 'anime dance trend', 'anime cosplay', 'anime meme', 'anime opening'],
        'ai-generated': ['ai generated video', 'ai art trend', 'ai animation', 'midjourney animation', 'ai influencer', 'sora ai'],
        grwm: ['grwm', 'get ready with me', 'morning routine', 'makeup routine', 'grwm viral'],
        ootd: ['ootd', 'outfit of the day', 'fashion haul', 'styling outfit', 'fit check'],
        lifestyle: ['lifestyle influencer', 'aesthetic vlog', 'day in my life', 'morning routine viral', 'soft life'],
        fitness: ['gym workout', 'fitness routine', 'workout motivation', 'gym check', 'home workout'],
        beauty: ['makeup tutorial', 'skincare routine', 'beauty hack', 'glow up', 'get ready with me'],
        food: ['recipe', 'what i eat in a day', 'food aesthetic', 'easy recipe', 'food trend'],
        travel: ['travel vlog', 'travel aesthetic', 'wanderlust', 'weekend trip', 'travel shorts'],
        dance: ['dance trend', 'tiktok dance', 'dance challenge', 'choreo trend', 'dance viral']
      };
      const queries = CATEGORY_QUERIES[category] || CATEGORY_QUERies?.anime || CATEGORY_QUERIES.anime;

      // 1) Try TrendsMCP for live trending terms in this category
      let liveTerms = [];
      let liveAsOf = null;
      if (TRENDSMCP_KEY) {
        try {
          const types = ['TikTok Trending Searches', 'TikTok Trending Hashtags', 'YouTube Trending Searches'];
          const results = await Promise.allSettled(types.map(t => trendsMcpTop(t, 15)));
          for (const r of results) {
            if (r.status === 'fulfilled' && r.value.data) {
              liveAsOf = liveAsOf || r.value.as_of_ts;
              for (const row of r.value.data) {
                const name = String(row[1] || '').trim();
                if (name) liveTerms.push(name);
              }
            }
          }
          // Dedupe + filter by category keywords
          const seen = new Set();
          const categoryKeywords = {
            anime: ['anime', 'otaku', 'waifu', 'manga', 'naruto', 'goku', 'demon slayer', 'jujutsu', 'one piece', 'titan'],
            'ai-generated': ['ai', 'midjourney', 'stable diffusion', 'ai art', 'ai video', 'ai influencer', 'sora'],
            grwm: ['grwm', 'get ready', 'makeup', 'morning routine'],
            ootd: ['ootd', 'outfit', 'fashion', 'styling', 'fit check'],
            lifestyle: ['lifestyle', 'aesthetic', 'vlog', 'routine'],
            fitness: ['gym', 'workout', 'fitness', 'training', 'exercise'],
            beauty: ['beauty', 'makeup', 'skincare', 'glow'],
            food: ['recipe', 'food', 'cooking', 'meal'],
            travel: ['travel', 'trip', 'destination', 'vacation'],
            dance: ['dance', 'choreo', 'moves']
          };
          const keywords = categoryKeywords[category] || [];
          liveTerms = liveTerms.filter(t => {
            const lower = t.toLowerCase();
            if (seen.has(lower)) return false;
            seen.add(lower);
            return keywords.length === 0 || keywords.some(k => lower.includes(k));
          }).slice(0, 5);
        } catch (e) { logLine('TrendsMCP fetch: ' + e.message); }
      }

      // 2) Build final query list (live terms + base queries)
      const finalQueries = [...liveTerms, ...queries].slice(0, 5);

      // 3) Search YouTube Shorts (yt-dlp) AND TikTok shorts (omkar) in PARALLEL
      let ytVideos = [];
      let ttVideos = [];
      const perQ = Math.max(2, Math.ceil(max / finalQueries.length));
      try {
        const ytResults = await Promise.all(finalQueries.slice(0, 5).map(q => ytSearch(q, perQ)));
        ytVideos = ytResults.flat();
      } catch (e) { logLine('ytSearch trends: ' + e.message); }
      if (OMKAR_KEY) {
        try {
          const ttResults = await Promise.allSettled(finalQueries.slice(0, 5).map(async (q) => {
            const r = await fetch(`${OMKAR_API}/tiktok/videos/search?search_query=${encodeURIComponent(q)}&market=us&max_results=${perQ + 2}&sort_by=most_liked`, { headers: { 'API-Key': OMKAR_KEY }, signal: AbortSignal.timeout(20000) });
            const j = await r.json().catch(() => ({}));
            if (!j.videos) return [];
            return j.videos.filter(v => (v.duration_seconds || 0) <= 60).map(v => ({
              id: v.video_id, platform: 'tiktok',
              title: v.caption || '', caption: v.caption,
              author: v.author?.display_name || v.author?.handle,
              views: v.stats?.views, likes: v.stats?.likes,
              duration: v.duration_seconds,
              thumbnail: v.thumbnails?.cover_url,
              url: v.media?.video_url,
              fetchedAt: Date.now()
            }));
          }));
          ttVideos = ttResults.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
        } catch (e) { logLine('omkar trends: ' + e.message); }

        // If omkar rate-limited or empty, try trending feed instead
        if (ttVideos.length === 0) {
          try {
            const r = await fetch(`${OMKAR_API}/tiktok/videos/trending?market=us&max_results=${max}`, { headers: { 'API-Key': OMKAR_KEY }, signal: AbortSignal.timeout(20000) });
            const j = await r.json().catch(() => ({}));
            ttVideos = (j.videos || []).filter(v => (v.duration_seconds || 0) <= 60).map(v => ({
              id: v.video_id, platform: 'tiktok',
              title: v.caption || '', caption: v.caption,
              author: v.author?.display_name || v.author?.handle,
              views: v.stats?.views, likes: v.stats?.likes,
              duration: v.duration_seconds,
              thumbnail: v.thumbnails?.cover_url,
              url: v.media?.video_url,
              fetchedAt: Date.now()
            }));
          } catch (e2) { logLine('omkar trending fallback: ' + e2.message); }
        }
      }

      // 4) Interleave YT Shorts + TikTok shorts, dedupe, sort by views, take top N
      const seen = new Set();
      const allVideos = [];
      const ytPool = [...ytVideos].sort((a, b) => (b.views || 0) - (a.views || 0));
      const ttPool = [...ttVideos].sort((a, b) => (b.views || 0) - (a.views || 0));
      // Interleave so each platform gets representation (50/50 balance like flashloop)
      while (allVideos.length < max && (ytPool.length || ttPool.length)) {
        if (ytPool.length) {
          const v = ytPool.shift();
          if (!seen.has(v.id)) { seen.add(v.id); allVideos.push(v); }
        }
        if (allVideos.length >= max) break;
        if (ttPool.length) {
          const v = ttPool.shift();
          if (!seen.has(v.id)) { seen.add(v.id); allVideos.push(v); }
        }
      }
      // Final dedupe pass
      const finalSeen = new Set();
      const deduped = allVideos.filter(v => { if (finalSeen.has(v.id)) return false; finalSeen.add(v.id); return true; });

      const result = {
        source: liveTerms.length ? 'trendsmcp+yt-shorts+tiktok-shorts' : 'yt-shorts+tiktok-shorts',
        category,
        as_of_ts: liveAsOf,
        liveTerms,
        videos: allVideos
      };
      trendsCache.set(cacheKey, { ts: Date.now(), data: result });
      return sendJson(res, 200, result);
    }

    // Instagram reel fetch — uses parth-dl Python module (no login required)
    if (p === '/api/trending/instagram' && req.method === 'POST') {
      const body = await readBody(req);
      const reelUrl = body.url;
      if (!reelUrl || !reelUrl.includes('instagram.com')) return sendJson(res, 400, { error: 'Instagram reel URL required' });
      try {
        const { execFile } = require('child_process');
        const script = `import json\nfrom parth_dl.core import InstagramDownloader\ndl = InstagramDownloader()\ninfo = dl.get_info(${JSON.stringify(reelUrl)})\nprint(json.dumps({\"ok\": True, \"data\": str(info)[:2000]}) if info else json.dumps({\"ok\": False}))`;
        const result = await new Promise((resolve) => {
          execFile('python', ['-c', script], { timeout: 25000 }, (err, stdout, stderr) => {
            if (err) { resolve({ ok: false, error: (stderr || err.message || '').slice(0, 200) }); return; }
            try { resolve(JSON.parse(stdout.trim().split('\n').pop())); }
            catch { resolve({ ok: false, error: 'parse failed: ' + stdout.slice(0, 200) }); }
          });
        });
        return sendJson(res, 200, result);
      } catch (e) { return sendJson(res, 500, { error: e.message }); }
    }

    // Get local viral templates (fallback when no API)
    if (p === '/api/templates' && req.method === 'GET') {
      const TPL_FILE = path.join(STORYBOARD_DIR, 'viral-templates.json');
      try {
        const templates = JSON.parse(await fsp.readFile(TPL_FILE, 'utf8'));
        return sendJson(res, 200, { templates });
      } catch { return sendJson(res, 200, { templates: [] }); }
    }

        // Instagram Reels trends from Later.com blog (free, no login)
    if (p === '/api/trending/instagram' && req.method === 'GET') {
      try {
        const r = await fetch('https://later.com/blog/instagram-reels-trends/', {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        const html = await r.text();
        const trends = [];
        const h3Matches = html.match(/<h3[^>]*>[\s\S]*?<\/h3>/gi) || [];
        for (const h3 of h3Matches) {
          const text = h3.replace(/<[^>]+>/g, '').trim();
          if (!text.toLowerCase().includes('trend')) continue;
          const parts = text.split('—');
          if (parts.length < 2) continue;
          const name = parts[0].replace(/^trend:\s*/i, '').trim();
          const dateStr = parts[1].trim();
          const idx = html.indexOf(h3);
          const after = html.slice(idx, idx + 2000);
          const dm = after.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
          const desc = dm ? dm[1].replace(/<[^>]+>/g, '').trim().slice(0, 300) : '';
          trends.push({ name, date: dateStr, description: desc, platform: 'instagram' });
        }
        return sendJson(res, 200, { videos: trends });
      } catch (e) { return sendJson(res, 500, { error: e.message }); }
    }

// Generate content from a trending video or template
        // Analyze video with Gemini 3.1 Pro vision — downloads video, extracts frames + subtitles,
    // sends everything to Gemini for a complete visual + audio analysis
    async function analyzeVideo(videoUrl) {
      const tempDir = path.join(ROOT, 'storyboard', '.va_' + Date.now());
      fs.mkdirSync(tempDir, { recursive: true });
      const videoPath = path.join(tempDir, 'video.mp4');
      let transcription = '';
      let visualAnalysis = '';

      try {
        // 1. Download video (first 20 seconds, 480p to keep it small and fast)
        inflLogLine('video analysis: downloading...');
        await new Promise((resolve, reject) => {
          execFile('python', ['-m', 'yt_dlp',
            '-f', 'best[height<=480]',
            '--download-sections', '*0:00-0:20',
            '--max-filesize', '30M',
            '-o', videoPath,
            '--no-playlist', '--no-warnings',
            videoUrl
          ], { timeout: 90000 }, (err, stdout, stderr) => {
            if (err) { inflLogLine('yt-dlp error: ' + (stderr || err.message).slice(0, 200)); reject(err); }
            else resolve();
          });
        });
        if (!fs.existsSync(videoPath)) throw new Error('video file not created');
        inflLogLine('video analysis: downloaded ' + (fs.statSync(videoPath).size / 1024 / 1024).toFixed(1) + 'MB');

        // 2. Extract subtitles (YouTube auto-captions)
        inflLogLine('video analysis: extracting subtitles...');
        try {
          const subPath = path.join(tempDir, 'subs');
          await new Promise((resolve) => {
            execFile('python', ['-m', 'yt_dlp',
              '--write-auto-sub', '--sub-lang', 'en,hi',
              '--skip-download', '--sub-format', 'vtt',
              '-o', subPath, '--no-playlist', '--no-warnings',
              videoUrl
            ], { timeout: 30000 }, () => resolve());
          });
          const files = fs.readdirSync(tempDir);
          const subFile = files.find(f => f.endsWith('.vtt'));
          if (subFile) {
            const vtt = fs.readFileSync(path.join(tempDir, subFile), 'utf8');
            const lines = vtt.split('\n')
              .filter(l => l.trim() && !l.includes('-->') && !l.startsWith('WEBVTT') && !l.startsWith('NOTE') && !/^\d+$/.test(l.trim()) && !l.includes('align:') && !l.includes('position:'))
              .map(l => l.replace(/<[^>]+>/g, '').trim())
              .filter((l, i, arr) => l && l !== arr[i - 1]);
            transcription = lines.join(' ').slice(0, 3000);
            inflLogLine('video analysis: transcription ' + transcription.length + ' chars');
          }
        } catch (e) { inflLogLine('video analysis: subtitle extraction failed: ' + e.message); }

        // 3. Extract 10 key frames (1 every 2 seconds for 20s video)
        inflLogLine('video analysis: extracting frames...');
        const framesDir = path.join(tempDir, 'frames');
        fs.mkdirSync(framesDir, { recursive: true });
        await new Promise((resolve, reject) => {
          execFile('ffmpeg', ['-y', '-i', videoPath,
            '-vf', 'fps=0.5,scale=640:-2',
            '-q:v', '3',
            path.join(framesDir, 'frame_%03d.jpg')
          ], { timeout: 30000 }, (err) => err ? reject(err) : resolve());
        });
        const frameFiles = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort().slice(0, 10);
        inflLogLine('video analysis: extracted ' + frameFiles.length + ' frames');

        if (!frameFiles.length) throw new Error('no frames extracted');

        // 4. Send frames to Gemini 3.1 Pro vision for complete analysis
        inflLogLine('video analysis: sending to Gemini 3.1 Pro vision...');
        const content = [
          { type: 'text', text: 'You are a professional video analyst. I am showing you ' + frameFiles.length + ' sequential frames extracted from a 20-second influencer video (1 frame every 2 seconds). Frame 1 is at 0:00, Frame 2 at 0:02, Frame 3 at 0:04, etc.\n\n' +
            (transcription ? 'TRANSCRIPTION (what the person says):\n"' + transcription + '"\n\n' : '') +
            'Analyze this video COMPLETELY and write a detailed report covering:\n\n' +
            '1. SETTING & ENVIRONMENT: Exact location, background details, props, colors, architecture, nature elements\n' +
            '2. PERSON\'S ACTIONS (frame by frame): What they do in EACH frame — describe the progression chronologically\n' +
            '3. EXPRESSIONS: How their facial expressions change throughout the video\n' +
            '4. CAMERA WORK: Angle, distance, movement style (selfie/tripod/handheld), framing\n' +
            '5. LIGHTING: Type, direction, color temperature, time of day feel\n' +
            '6. CONTENT TYPE: What kind of influencer content is this? (GRWM, OOTD, vlog, tutorial, haul, etc.)\n' +
            '7. MOOD & ENERGY: The overall vibe and energy level\n' +
            '8. KEY MOMENTS: The most important/interesting moments in the video\n\n' +
            'Be extremely specific and detailed. This analysis will be used to recreate similar content with AI.' }
        ];
        for (const f of frameFiles) {
          const buf = fs.readFileSync(path.join(framesDir, f));
          content.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + buf.toString('base64') } });
        }

        const visionModels = ['gemini-3.1-pro', 'gemini-2.5-pro', 'gpt-5.5'];
        for (const model of visionModels) {
          try {
            visualAnalysis = await chatCompletion(model, [{ role: 'user', content }], 4000);
            if (visualAnalysis && visualAnalysis.length > 200) {
              inflLogLine('video analysis: Gemini vision analysis done (' + visualAnalysis.length + ' chars) via ' + model);
              break;
            }
          } catch (e) { inflLogLine('video analysis: ' + model + ' failed: ' + e.message); }
        }

      } catch (e) {
        inflLogLine('video analysis FAILED: ' + e.message);
      }

      // Cleanup
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      return { transcription, visualAnalysis };
    }

    // Generate img2img + img2video prompts for a trend video (user can edit before generating)
    // Generate img2img + img2video prompts for a trend video (user can edit before generating)
    // Generate img2img + img2video prompts — analyzes actual video content (transcription + visuals)
    if (p === '/api/influencer/trend-prompts' && req.method === 'POST') {
      const body = await readBody(req);
      const caption = body.caption || '';
      const author = body.author || '';
      const views = body.views || 0;
      const platform = body.platform || 'tiktok';
      const videoUrl = body.videoUrl || '';
      if (!caption && !body.cover && !videoUrl) return sendJson(res, 400, { error: 'No trend data provided' });

      try {
        // 1. Analyze the actual video if URL is available
        let transcription = '';
        let frameDescs = '';
        if (videoUrl) {
          inflLogLine('analyzing video content for prompt generation...');
          const analysis = await analyzeVideo(videoUrl);
          transcription = analysis.transcription || '';
          frameDescs = analysis.visualAnalysis || '';
          inflLogLine('video analysis complete — transcription: ' + transcription.length + ' chars, visuals: ' + frameDescs.length + ' chars');
        }

        // 2. Build the prompt generation request with all available info
        const analysisBlock = (transcription ? '\n\nTRANSCRIPTION (what the person actually says in the video):\n' + transcription : '') +
          (frameDescs ? '\n\nVISUAL ANALYSIS (detailed description of what happens in the video):\n' + frameDescs : '');

        const sysPrompt = `You are an expert AI influencer content prompt engineer. Given detailed analysis of a trending video, generate TWO prompts that recreate the exact same content format, vibe, and style.

CRITICAL RULES:
- Do NOT describe how the person looks — the user will provide their own reference image
- Do NOT mention specific clothing items, brands, or restricted/suggestive content
- Focus on: scene, setting, atmosphere, pose, action, expression, lighting, camera style
- Make it feel like authentic influencer user-generated content, not studio photography
- The person should be performing a natural, candid activity
- If transcription is provided, incorporate what they say into the img2video prompt's action sequence
- Match the EXACT format and energy of the analyzed video

For the IMG2IMG prompt, use this format:
Use the provided reference image as the exact identity reference.
Maintain identical facial features, hairstyle, skin tone, body proportions, accessories, and overall appearance. Preserve identity perfectly.

Scene:
[Detailed environment description matching the analyzed video]

Pose:
[What the person is doing — match the analyzed video's actions]

Expression:
[Match the expressions from the visual analysis]

Lighting:
[Match the lighting from the visual analysis]

Photography:
[Match the camera style from the visual analysis]

For the IMG2VIDEO prompt, use this format:
Use the provided reference image as the exact identity reference.
Maintain identical identity throughout the animation.

Duration:
5-6 seconds

Style:
[Match the video style from analysis]

Scene:
[What the person is doing]

Action Sequence:
[CRITICAL: Break down into 6 timecoded segments (00:00-00:01 through 00:05-00:06). If transcription is available, include what they're saying at each moment. Match the actual video's progression.]

00:00-00:01
[action + speech if available]

00:01-00:02
[action + speech if available]

... through 00:05-00:06

Facial Animation:
[Match what you see in the frames]

Camera Motion:
[Match the actual camera style]

Hair Physics:
[Describe hair movement if visible]

VISUAL STYLE (MANDATORY - include this entire section verbatim in the img2video prompt):
Natural smartphone video quality. Slight realistic handheld shake. Smooth normal frame-rate motion. Authentic casual interactions and physics. Realistic sunlight and exposure adaptation. Stable main character consistency. Unpolished home phone recording aesthetics. No professional stabilization. No cinematic color grading. No beauty filters. No artificial effects. No AI artifacts or glitches.

IMPORTANT GENERATION REQUIREMENTS:
Consistent identity throughout the video. Realistic human anatomy and hand interactions. Natural body movement. Physically correct lighting and shadows. No duplicated people or objects. No facial distortions. No impossible movements. Preserve the casual smartphone home-video feeling from beginning to end. Photorealistic. Indistinguishable from a genuine smartphone selfie video recorded by a real lifestyle influencer.

Quality:
Looks exactly like a real Instagram Story recorded by a lifestyle influencer. No robotic movement. No AI artifacts.

${analysisBlock}

TREND INFO:
- Caption: ${caption}
- Creator: ${author}
- Platform: ${platform}
- Views: ${views}

Return ONLY valid JSON: {"imgPrompt":"...","vidPrompt":"..."}
`;

        const models = ['gemini-2.5-pro', 'gemini-3.1-pro', 'gpt-5.5'];
        let imgPrompt = '';
        let vidPrompt = '';
        for (const model of models) {
          try {
            const messages = [{ role: 'user', content: sysPrompt }];
            const raw = await chatCompletion(model, messages, 4000);
            const s = raw.indexOf('{');
            const e = raw.lastIndexOf('}');
            if (s !== -1 && e > s) {
              const parsed = JSON.parse(raw.slice(s, e + 1));
              imgPrompt = parsed.imgPrompt || '';
              vidPrompt = parsed.vidPrompt || '';
              if (imgPrompt && vidPrompt) break;
            }
          } catch (e) { inflLogLine('prompt gen ' + model + ' failed: ' + e.message); }
        }

        if (!imgPrompt) {
          imgPrompt = 'Use the provided reference image as the exact identity reference.\nMaintain identical facial features, hairstyle, skin tone, body proportions. Preserve identity perfectly.\n\nScene:\nA stylish urban cafe with warm ambient lighting, exposed brick walls, and lush green plants.\n\nPose:\nSitting comfortably at a table, holding phone in selfie mode, body relaxed.\n\nExpression:\nConfident. Friendly. Relaxed. Natural genuine smile.\n\nLighting:\nWarm natural sunlight through large windows. Soft golden tones.\n\nPhotography:\nUltra realistic. Lifestyle influencer. Natural iPhone selfie. No studio lighting.';
          vidPrompt = 'Use the provided reference image as the exact identity reference.\nMaintain identical identity throughout.\n\nDuration: 5-6 seconds\nStyle: Ultra-realistic lifestyle influencer vlog. Vertical 9:16.\n\n00:00-00:01: Begins speaking naturally while smiling at camera.\n00:01-00:02: Lightly laughs. Shoulders relax naturally.\n00:02-00:03: Glances away briefly then looks back.\n00:03-00:04: Tucks loose strand of hair behind ear.\n00:04-00:05: Nods naturally. Smile becomes bigger.\n00:05-00:06: Gives playful wink and ends recording.\n\nCamera Motion: Handheld selfie. Small wrist adjustments.\nQuality: Looks like a real Instagram Story.';
        }
        return sendJson(res, 200, { imgPrompt, vidPrompt, hasTranscription: !!transcription, hasVisualAnalysis: !!frameDescs });
      } catch (e) { return sendJson(res, 500, { error: e.message }); }
    }

    if (p === '/api/influencer/generate-from-trend' && req.method === 'POST') {
      if (inflJob.phase !== 'idle') return sendJson(res, 409, { error: 'busy' });
      const body = await readBody(req);
      if (!body.id) return sendJson(res, 400, { error: 'influencer id required' });
      const infl = await findInfluencer(body.id);
      if (!infl) return sendJson(res, 404, { error: 'influencer not found' });
      const style = body.style || 'realistic';
      const ratio = body.ratio || '1:1';
      const imageModel = body.imageModel || IMAGE_MODELS[0];
      let trendCaption = body.caption || '';
      let trendHashtags = body.hashtags || '';
      let trendDuration = body.duration || 0;
      let trendViews = body.views || 0;
      let trendPlatform = body.platform || 'tiktok';
      let trendCover = body.cover || '';
      let trendVideoUrl = body.videoUrl || '';
      const customImgPrompt = body.customImgPrompt || '';
      const customVidPrompt = body.customVidPrompt || '';
      const fallbackModels = ['kimi-2.7-code', 'glm-5.2', 'mimo-v2.5', 'gemini-2.5-pro'];
      function nextModel(prev) { return fallbackModels.find(m => m !== prev) || fallbackModels[0]; }

      inflSetPhase('trend-create', 3);
      (async () => {
        try {
                    // Nothing selected: pick a FRESH live TrendsMCP term (no hardcoded list)
          if (!trendCaption && !trendCover) {
            inflLogLine('no trend selected — fetching live TrendsMCP trends...');
            let liveTerm = '';
            if (TRENDSMCP_KEY) {
              try {
                const data = await trendsMcpTop('TikTok Trending Searches', 20);
                const rows = data.data || [];
                if (rows.length) liveTerm = String(rows[Math.floor(Math.random() * rows.length)][1] || '').trim();
              } catch (e) { inflLogLine('TrendsMCP live pick failed: ' + e.message); }
            }
            if (!liveTerm) throw new Error('could not fetch a fresh live trend');
            inflLogLine('live trend picked: "' + liveTerm + '"');
            trendCaption = liveTerm;
            trendPlatform = 'tiktok';
            if (OMKAR_KEY) {
              try {
                const r = await fetch(`${OMKAR_API}/tiktok/videos/search?search_query=${encodeURIComponent(liveTerm)}&market=us&max_results=12&sort_by=most_liked`, { headers: { 'API-Key': OMKAR_KEY }, signal: AbortSignal.timeout(10000) });
                const j = await r.json();
                const candidates = (j.videos || []).filter(v => v.thumbnails?.cover_url);
                const chosen = candidates[Math.floor(Math.random() * candidates.length)];
                if (chosen) {
                  trendCaption = chosen.caption || liveTerm;
                  trendDuration = chosen.duration_seconds || 0;
                  trendViews = chosen.stats?.views || 0;
                  trendCover = chosen.thumbnails?.cover_url || '';
                  trendVideoUrl = chosen.media?.video_url || '';
                }
              } catch (e) { inflLogLine('omkar live video fetch failed: ' + e.message); }
            }
          }

          // Lock identity before visual analysis so Gemini can adapt the real
          // source format to the selected influencer in one prompt.
          if (!infl.description) {
            inflLogLine('no locked description — generating identity first...');
            const profile = { name: infl.name, age: infl.age, gender: infl.gender, ethnicity: infl.ethnicity, hair: infl.hair, eyes: infl.eyes, bodyType: infl.bodyType, defaultWardrobe: infl.defaultWardrobe, signatureTrait: infl.signatureTrait, vibe: infl.vibe };
            let model = 'gemini-3.1-pro';
            let desc = '';
            for (let i = 0; i < 3; i++) {
              try { desc = await expandInfluencerDescription(profile, model); if (desc && desc.length > 100) break; }
              catch { model = nextModel(model); }
            }
            if (!desc) throw new Error('could not generate locked influencer description');
            infl.description = desc;
            await saveInfluencer(infl);
          }

          // --- STEP 1: LLM analyzes the trending video → generates matching scene ---
          inflLogLine(`step 1/3: analyzing trending ${trendPlatform} video...`);
          if (trendViews > 0) inflLogLine(`  trend: ${trendViews.toLocaleString()} views, "${trendCaption.slice(0, 60)}..."`);
          const trendDetails = `Platform: ${trendPlatform}\nCaption: ${trendCaption}\nHashtags: ${trendHashtags}\nDuration: ${trendDuration}s\nViews: ${trendViews.toLocaleString()}`;
          const visualScene = await analyzeTrendVisual(trendCover, trendDetails, infl.description || '(no description - describe a beautiful confident influencer)', inflLogLine, trendVideoUrl);
          const analyzePrompt = `You are a creative director for real-life Instagram/TikTok influencers.
A trending ${trendPlatform} video has these details:
- Caption: "${trendCaption}"
- Hashtags: "${trendHashtags}"
- Duration: ${trendDuration}s
- Views: ${trendViews.toLocaleString()}

Analyze this viral content and create a MATCHING scene for an AI influencer that captures the same viral appeal.
Make it look like a REAL-LIFE influencer post — candid, everyday, natural. NOT cinematic or staged.

Return ONLY a JSON object:
{
  "scene_prompt": "60-120 words. Photorealistic smartphone photo quality. POSING as the influencer character in a scene inspired by the trend. Imagine the character description is the paragraph below. Natural/daylight lighting. Candid phone-photo aesthetic.",
  "animation_prompt": "one sentence: natural subtle motion for a 6s video matching the trend's vibe",
  "caption": "a short Instagram caption echoing the viral caption style"
}

CHARACTER DESCRIPTION (use verbatim in scene_prompt):
${infl.description || '(no description - describe a beautiful confident influencer)'}`;
          let scene = visualScene;
          if (scene) {
            inflLogLine(`Gemini visual analysis: ${scene.visual_analysis?.slice(0, 120) || 'cover analyzed'}`);
          } else {
            inflLogLine('cover analysis unavailable — using caption/hashtag analysis fallback');
            const sceneMsgs = [{ role: 'system', content: analyzePrompt }, { role: 'user', content: 'Return ONLY the JSON object now.' }];
            let sceneContent = '', sceneModel = 'gemini-3.1-pro';
            for (let attempt = 0; attempt < 4; attempt++) {
              try { sceneContent = await chatCompletion(sceneModel, sceneMsgs, 3000); if (sceneContent) break; }
              catch (e) { inflLogLine(`scene attempt ${attempt+1} (${sceneModel}): ${e.message}`); sceneModel = nextModel(sceneModel); }
            }
            if (!sceneContent) throw new Error('LLM returned no scene');
            try { const s = sceneContent.indexOf('{'); const e = sceneContent.lastIndexOf('}'); scene = JSON.parse(sceneContent.slice(s, e + 1)); }
            catch { throw new Error('failed to parse scene JSON from LLM'); }
          }
          inflLogLine(`scene generated: "${scene.scene_prompt?.slice(0, 80)}..."`);
          inflJob.phase = 'trend-create'; inflJob.total = 3; inflJob.done = 1;

          // --- STEP 2: Generate image ---
          inflLogLine('step 2/3: generating image...');
          let cid = null;
          const resolvedRefUrl = await resolveInfluencerRefUrl(infl);
          if (resolvedRefUrl) {
            cid = await generateInfluencerContentImg2Img(infl, resolvedRefUrl, scene.scene_prompt, style, ratio, imageModel);
          }
          if (!cid) {
            inflLogLine('img2img failed — using text-to-image with character description');
            cid = await generateInfluencerContent(infl, scene.scene_prompt, style, ratio, imageModel);
          }
          if (!cid) throw new Error('image generation failed');
          inflLogLine('step 2/3: image DONE');
          inflJob.phase = 'trend-create'; inflJob.total = 3; inflJob.done = 2;

          // --- STEP 3: Video ---
          inflLogLine('step 3/3: generating video...');
          const animItem = infl.content.find(c => c.id === cid);
          if (animItem) { animItem.animation_prompt = scene.animation_prompt; if (scene.caption) animItem.caption = scene.caption; if (trendPlatform) animItem.source = `${trendPlatform}_trend`; await saveInfluencer(infl); }
          await generateInfluencerVideo(infl, cid, ratio, 6);
          inflLogLine('trend generation COMPLETE');
          inflJob.done = 3; inflJob.ok = 3;
        } catch (e) { inflLogLine(`trend generation FAILED: ${e.message}`); }
        inflJob.phase = 'idle';
      })();
      return sendJson(res, 202, { started: true });
    }

    // --- static files (supports subdirectories for influencer assets) ---
    let filePath;
    if (p.startsWith('/frames/')) filePath = path.join(FRAMES_DIR, decodeURIComponent(p.slice('/frames/'.length)));
    else if (p.startsWith('/video/')) filePath = path.join(VIDEO_DIR, decodeURIComponent(p.slice('/video/'.length)));
    else if (p === '/') filePath = path.join(PUBLIC, 'index.html');
    else if (p === '/influencer') filePath = path.join(PUBLIC, 'influencer.html');
    else if (p === '/trends') filePath = path.join(PUBLIC, 'trends.html');
    else filePath = path.join(PUBLIC, path.normalize(p).replace(/^([/\\])+/, ''));

    if (!filePath.startsWith(FRAMES_DIR) && !filePath.startsWith(VIDEO_DIR) && !filePath.startsWith(PUBLIC)) {
      res.writeHead(403); return res.end('forbidden');
    }
    const data = await fsp.readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch (e) {
    if (e.code === 'ENOENT') { res.writeHead(404); res.end('not found'); }
    else { res.writeHead(500); res.end(String(e.message || e)); }
  }
});

server.listen(PORT, () => console.log(`Storyboard Studio → http://localhost:${PORT}`));
