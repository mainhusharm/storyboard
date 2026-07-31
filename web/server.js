// Storyboard Studio — zero-dependency Node server (Node 18+; built for v24)
// Run:  node web/server.js   →  http://localhost:5173
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const { URL } = require('url');

const IS_VERCEL = !!process.env.VERCEL;
const VERCEL_TIMEOUT = IS_VERCEL ? 5000 : 25000;
const ROOT = IS_VERCEL ? '/tmp' : path.resolve(__dirname, '..');
const PUBLIC = path.join(__dirname, 'public');
const FRAMES_DIR = path.join(ROOT, 'frames');
const VIDEO_DIR = path.join(ROOT, 'video');
const STORYBOARD_DIR = path.join(ROOT, 'storyboard');
const FRAMES_JSON = path.join(STORYBOARD_DIR, 'frames.json');
const CHARS_JSON = path.join(STORYBOARD_DIR, 'characters.json');
const INFLUENCERS_JSON = path.join(STORYBOARD_DIR, 'influencers.json');

let API_KEY = process.env.PAXSENIX_API_KEY || '';
if (!IS_VERCEL) { try { API_KEY = API_KEY || fs.readFileSync(path.join(ROOT, 'pipeline', 'apikey.txt'), 'utf8').trim(); } catch {} }
let AQUA_API_KEY = process.env.AQUA_API_KEY || '';
if (!IS_VERCEL) { try { AQUA_API_KEY = AQUA_API_KEY || fs.readFileSync(path.join(ROOT, 'pipeline', 'aqua_apikey.txt'), 'utf8').trim(); } catch {} }
const API = 'https://api.paxsenix.org';
const AQUA_API = 'https://api.aquadevs.com';
const PORT = process.env.PORT || 5173;
// omkar.cloud trending API (TikTok trending + search)
let OMKAR_KEY = process.env.OMKAR_KEY || '';
if (!IS_VERCEL) { try { OMKAR_KEY = OMKAR_KEY || fs.readFileSync(path.join(ROOT, 'pipeline', 'omkar-key.txt'), 'utf8').trim(); } catch {} }
const OMKAR_API = 'https://tiktok-scraper.omkar.cloud';

// Tavily API key for live trend term discovery (replaces TrendsMCP).
// Reads from env first; falls back to pipeline/tavily-key.txt. Either source works.
let TAVILY_API_KEY = process.env.TAVILY_API_KEY || '';
if (!IS_VERCEL) { try { TAVILY_API_KEY = TAVILY_API_KEY || fs.readFileSync(path.join(ROOT, 'pipeline', 'tavily-key.txt'), 'utf8').trim(); } catch {} }
const TAVILY_API = 'https://api.tavily.com';

// Optional YouTube Data API v3 key for reliable YouTube Shorts search
let YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
if (!IS_VERCEL) { try { YOUTUBE_API_KEY = YOUTUBE_API_KEY || fs.readFileSync(path.join(ROOT, 'pipeline', 'youtube-api-key.txt'), 'utf8').trim(); } catch {} }

if (TAVILY_API_KEY) console.log('[Tavily] API key loaded — live trend discovery enabled');
else console.log('[Tavily] no API key found — live trend terms will be skipped (yt-dlp + TikWM fallbacks still serve videos)');

// Tavily search: general web search used for live trend discovery (replaces TrendsMCP).
async function tavilySearch(query, limit = 5) {
  if (!TAVILY_API_KEY) {
    console.log('[Tavily] TAVILY_API_KEY is not set, skipping live trend lookup');
    return { answer: '', results: [] };
  }
  console.log('[Tavily] searching:', query);
  try {
    const res = await fetch(`${TAVILY_API}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query,
        search_depth: 'basic',
        include_answer: true,
        max_results: limit
      }),
      signal: AbortSignal.timeout(VERCEL_TIMEOUT)
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { console.log('[Tavily] HTTP error:', res.status, j); logLine('Tavily error: ' + (j.error || res.status)); return { answer: '', results: [] }; }
    console.log('[Tavily] got response, answer length:', (j.answer || '').length, 'results:', (j.results || []).length);
    return j || { answer: '', results: [] };
  } catch (e) { logLine('Tavily search failed: ' + e.message); }
  return { answer: '', results: [] };
}

// Use Tavily to discover current trending terms for a category.
// Returns a list of short trend phrases/hashtags suitable for video search.
async function tavilyTrendTerms(category, limit = 5) {
  const query = `top trending ${category} TikTok hashtags and YouTube Shorts trends ${new Date().getFullYear()}`;
  const data = await tavilySearch(query, 5);
  const texts = [];
  if (data.answer) texts.push(data.answer);
  for (const r of data.results || []) {
    if (r.title) texts.push(r.title);
    if (r.content) texts.push(r.content);
  }
  const text = texts.join(' ');
  const candidates = [];

  // 1) Hashtags are strongest signals
  for (const m of text.matchAll(/#([A-Za-z0-9_]+)/g)) candidates.push(m[1]);

  // 2) Quoted / parenthesized short phrases
  for (const m of text.matchAll(/["'"]([^"'"]{3,40})["'"]/g)) candidates.push(m[1]);

  // 3) Title-case multi-word phrases that look like trend names
  for (const m of text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,4})\b/g)) candidates.push(m[1]);

  // 4) Fallback: short sentence fragments
  const phrases = text.split(/[.,;!?]/).map(s => s.trim()).filter(s => s.length > 3 && s.length < 45);
  for (const p of phrases) candidates.push(p.replace(/[^A-Za-z0-9 _-]/g, '').trim());

  // Deduplicate, normalize, and de-noise
  const stopWords = new Set(['the', 'and', 'for', 'with', 'you', 'this', 'that', 'from', 'are', 'was', 'were', 'trending', 'trend', 'trends', 'hashtag', 'hashtags', 'youtube', 'tiktok', 'shorts', 'video', 'videos']);
  const seen = new Set();
  const result = [];
  for (const t of candidates) {
    const key = t.toLowerCase().trim();
    const words = key.split(/\s+/).filter(Boolean);
    if (!key || seen.has(key) || words.length > 6 || (words.length === 1 && stopWords.has(key))) continue;
    seen.add(key);
    result.push(key);
    if (result.length >= limit) break;
  }
  return result;
}


// yt-dlp search: get real SHORT-FORM video data for trending content (<= 60s)
// Search YouTube Shorts for short-form videos only (<= 60s).
async function ytSearch(query, limit = 5) {
  if (IS_VERCEL) return [];
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    const q = `${query} shorts #shorts`.trim();
    const args = [
      '-m', 'yt_dlp',
      '--dump-json', '--flat-playlist', '--no-download',
      '--playlist-items', '1:' + (limit * 3),
      '--match-filter', 'duration <= 60',
      'ytsearch' + (limit * 3) + ':' + q
    ];
    execFile('python3', args, { timeout: VERCEL_TIMEOUT }, (err, stdout) => {
      if (err) return resolve([]);
      const lines = stdout.trim().split('\n').filter(Boolean);
      const videos = [];
      const seen = new Set();
      for (const line of lines) {
        try {
          const d = JSON.parse(line);
          const vid = d.id || '';
          if (!vid || seen.has(vid)) continue;
          let url = d.original_url || d.webpage_url || d.url || '';
          // Hard short-form guard: must be 0 < duration <= 60s (the query already biases to shorts)
          if (typeof d.duration !== 'number' || d.duration <= 0 || d.duration > 60) continue;
          // yt-dlp search returns watch?v= URLs; normalize to /shorts/ for display
          if (vid && !url.includes('/shorts/')) url = 'https://www.youtube.com/shorts/' + vid;
          seen.add(vid);
          const thumb = d.thumbnail && d.thumbnail.startsWith('http')
            ? d.thumbnail
            : (vid ? 'https://i.ytimg.com/vi/' + vid + '/hqdefault.jpg' : '');
          videos.push({
            id: vid,
            title: d.title || '',
            thumbnail: thumb,
            url: url,
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

// Real TikTok video search via TikWM free public mirror.
// Filters to short-form videos (<= 60s) and returns real tiktok.com URLs.
async function ttSearch(query, limit = 5) {
  try {
    const url = `https://www.tikwm.com/api/feed/search?keywords=${encodeURIComponent(query)}&count=${Math.min(limit * 5, 50)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'application/json' },
      signal: AbortSignal.timeout(VERCEL_TIMEOUT)
    });
    const json = await res.json().catch(() => ({}));
    // TikWM shapes: { data: [...] } | { data: { videos: [...] } } | { videos: [...] }
    let videos = [];
    if (Array.isArray(json.data)) videos = json.data;
    else if (Array.isArray(json.data?.videos)) videos = json.data.videos;
    else if (Array.isArray(json.videos)) videos = json.videos;
    else if (Array.isArray(json.data?.data)) videos = json.data.data;
    const result = [];
    const seen = new Set();
    for (const v of videos) {
      const id = v.video_id || v.id || v.aweme_id;
      const authorId = v.author?.unique_id || v.author?.uniqueId || v.author?.id || 'user';
      const duration = Number(v.duration || v.video?.duration || 0);
      if (!id || seen.has(id)) continue;
      // Accept missing duration (some mirrors omit it); skip only if clearly long-form
      if (duration > 60) continue;
      seen.add(id);
      result.push({
        id: String(id),
        title: v.title || v.desc || '',
        thumbnail: v.origin_cover || v.cover || v.video?.cover || v.thumbnail || '',
        url: v.play || v.wmplay || (authorId !== 'user' ? `https://www.tiktok.com/@${authorId}/video/${id}` : `https://www.tiktok.com/video/${id}`),
        views: v.play_count || v.playCount || v.stats?.playCount || 0,
        likes: v.digg_count || v.diggCount || v.stats?.diggCount || 0,
        duration: duration || 15,
        author: v.author?.nickname || v.author?.unique_id || v.author?.uniqueId || authorId || '',
        platform: 'tiktok'
      });
      if (result.length >= limit) break;
    }
    return result;
  } catch (e) { logLine('TikTok search failed: ' + e.message); }
  return [];
}

// Scrape Flashloop.app — viral AI format catalog.
// The /effects page embeds a JSON payload with format slugs, taglines and poster URLs.
// We extract that payload, map slugs to human-readable names, and use the first
// example's posterUrl as the format thumbnail.
//
// Cached 10 minutes per process to be polite (no public API exists).
const flashloopCache = { data: null, until: 0 };

function kebabToTitle(slug) {
  return slug
    .replace(/-cv$/, '')
    .split('-')
    .map(w => w ? w[0].toUpperCase() + w.slice(1) : '')
    .join(' ')
    .replace(/ And /g, ' & ')
    .replace(/ Asmr /g, ' ASMR ');
}

function extractTrendContent(raw) {
  const key = '"trendContent"';
  const idx = raw.indexOf(key);
  if (idx === -1) return null;
  let braceIdx = raw.indexOf('{', idx + key.length);
  if (braceIdx === -1) return null;
  let depth = 0, inString = false, escape = false;
  for (let i = braceIdx; i < raw.length; i++) {
    const ch = raw[i];
    if (!inString) {
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { return JSON.parse(raw.slice(braceIdx, i + 1)); } }
      else if (ch === '"') inString = true;
    } else {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
    }
  }
  return null;
}

async function scrapeFlashloop() {
  if (flashloopCache.data && Date.now() < flashloopCache.until) return flashloopCache.data;
  let formats = [];
  try {
    const res = await fetch('https://www.flashloop.app/effects', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(VERCEL_TIMEOUT)
    });
    if (!res.ok) { logLine('flashloop scrape: HTTP ' + res.status); return []; }
    const html = await res.text();

    // 1) Try to extract the embedded Next.js payload(s) and locate trendContent.
    let trendContent = null;
    // The payload is a JS string literal; we must allow escaped quotes/backslashes.
    const pushRe = /self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g;
    let m;
    while ((m = pushRe.exec(html)) !== null) {
      let raw;
      try {
        // The captured group is a JS/JSON-escaped string; decode it first.
        raw = JSON.parse('"' + m[1] + '"');
      } catch { continue; }
      trendContent = extractTrendContent(raw);
      if (trendContent) break;
    }

    // 2) Fallback: search the raw HTML for poster URLs grouped by slug.
    if (!trendContent) {
      const slugRe = /([a-z0-9-]+-cv)[\s\S]{0,1000}?"posterUrl"\s*:\s*"(https:\/\/assets\.flashloop\.app\/[^"]+)"/g;
      while ((m = slugRe.exec(html)) !== null) {
        const slug = m[1];
        const posterUrl = m[2];
        const name = kebabToTitle(slug);
        formats.push({ slug, name, thumbnail: posterUrl, tagline: '' });
      }
    } else {
      for (const [slug, data] of Object.entries(trendContent)) {
        const examples = Array.isArray(data?.examples) ? data.examples : [];
        const thumbnail = examples.find(e => e?.posterUrl)?.posterUrl || '';
        const tagline = data?.tagline || '';
        formats.push({ slug, name: kebabToTitle(slug), thumbnail, tagline });
      }
    }

    // Deduplicate by slug, keep first found.
    const seen = new Set();
    formats = formats.filter(f => { if (seen.has(f.slug)) return false; seen.add(f.slug); return true; });
    logLine(`flashloop scrape: ${formats.length} viral formats captured`);
    flashloopCache.data = formats;
    flashloopCache.until = Date.now() + 10 * 60 * 1000;
    return formats;
  } catch (e) { logLine('flashloop scrape failed: ' + e.message); return []; }
}

// Build a 'flashloop' video-shaped object suitable for the trends UI
function flashloopAsVideo(fmt) {
  return {
    id: 'flashloop_' + fmt.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
    slug: fmt.slug,
    name: fmt.name,
    title: fmt.name + ' — viral AI format',
    platform: 'flashloop',
    url: 'https://www.flashloop.app/effects',
    videoUrl: 'https://www.flashloop.app/effects',
    views: fmt.views || 0,
    viewsDisplay: fmt.viewsDisplay || '',
    likes: 0, duration: 0, author: 'Flashloop',
    thumbnail: fmt.thumbnail || null,
    cover: fmt.thumbnail || null,
    tagline: fmt.tagline || '',
    flashloop: true, fetchedAt: Date.now()
  };
}

// ─── SJinn Trend Prompts ──────────────────────────────────────────────────
// Scrapes https://sjinn.ai/trend-prompts for viral AI video prompt templates.
// Each trend has a name, slug, and result thumbnail from the SJinn platform.
// Cached 10 minutes per process.
const sjinnCache = { data: null, until: 0 };

async function scrapeSjinn() {
  if (sjinnCache.data && Date.now() < sjinnCache.until) return sjinnCache.data;
  try {
    const res = await fetch('https://sjinn.ai/trend-prompts', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(VERCEL_TIMEOUT)
    });
    if (!res.ok) { logLine('sjinn scrape: HTTP ' + res.status); return []; }
    const html = await res.text();

    const trends = [];
    const chunks = html.split(/<a\b/);
    for (let i = 1; i < chunks.length; i++) {
      const chunk = chunks[i];
      const hrefM = chunk.match(/href="\/trend-prompts\/([^"]+)"/);
      if (!hrefM) continue;
      const slug = hrefM[1];
      const srcM = chunk.match(/src="(https:\/\/[^"]+)"/);
      const altM = chunk.match(/alt="([^"]*)"/);
      const thumbnail = srcM ? srcM[1] : '';
      const name = (altM && altM[1]) || slug.split('-').map(w => w ? w[0].toUpperCase() + w.slice(1) : '').join(' ');
      trends.push({ slug, name, thumbnail, tagline: '' });
    }

    const seen = new Set();
    const deduped = trends.filter(t => { if (seen.has(t.slug)) return false; seen.add(t.slug); return true; });
    logLine(`sjinn scrape: ${deduped.length} viral prompts captured`);
    sjinnCache.data = deduped;
    sjinnCache.until = Date.now() + 10 * 60 * 1000;
    return deduped;
  } catch (e) { logLine('sjinn scrape failed: ' + e.message); return []; }
}

function sjinnAsVideo(trend) {
  return {
    id: 'sjinn_' + trend.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
    slug: trend.slug,
    name: trend.name,
    title: trend.name + ' — viral AI video prompt',
    platform: 'sjinn',
    url: 'https://sjinn.ai/trend-prompts/' + trend.slug,
    videoUrl: 'https://sjinn.ai/trend-prompts/' + trend.slug,
    views: 0, viewsDisplay: '', likes: 0, duration: 0, author: 'SJinn',
    thumbnail: trend.thumbnail || null,
    cover: trend.thumbnail || null,
    tagline: trend.tagline || '',
    sjinn: true, fetchedAt: Date.now()
  };
}

// Example prompts for one-shot Flashloop scene generation.
// NOTE: These examples are ONLY for structure, detail level, and tone. The LLM must NOT copy the crystal-fruit subject.
const FLASHLOOP_EXAMPLE_IMAGE_PROMPT = `A photorealistic macro close-up of a single original imaginary crystal-glass fruit resting motionless on a dark slate cutting board. The fruit has a rounded teardrop shape with five gently twisted ribs, a short curled stem, translucent teal glass skin, thin coral-colored veins inside, and six dark crystal seeds arranged symmetrically around a small central core. A polished steel chef's knife lies beside it on the same board, and the background is a soft neutral grey. Soft controlled studio lighting from the left creates realistic caustics and reflections inside the glass. Shallow but stable depth of field keeps the entire fruit tack sharp. Camera positioned 25 degrees above the board, looking down at the fruit from the front. No hands are visible. Premium photorealistic macro food cinematography, realistic ray-traced glass, physically accurate reflections and refraction, 8K, 16:9, first frame only.`;

const FLASHLOOP_EXAMPLE_VIDEO_PROMPT = `Create an exactly 15-second photorealistic ASMR video featuring one crystal-glass fruit. Use the supplied first-frame image as the strict visual reference. Preserve the fruit's exact shape, colors, position, and transparency in every frame.

CAMERA: One continuous locked macro shot, no cuts. Camera 25° above the cutting board. Keep the entire fruit visible throughout.

ACTION TIMELINE:
0.0–2.0s: Fruit rests motionless. A hand enters from the left and gently stabilizes it.
2.0–4.0s: A chef's knife enters from the right, positions above the fruit's centerline.
4.0–5.0s: Knife touches the top center. One crystal-tapping sound.
5.0–10.5s: Slow continuous downward cut. Clean separation beneath the blade. Crystal-slicing sound with subtle crackling.
10.5–12.0s: Knife lifts straight up. Two halves remain touching.
12.0–14.0s: Right hand gently slides the right half 3cm right. Reveals clean cross-section with glass flesh, seeds, and veins.
14.0–15.0s: Hold on separated halves. One soft glass clink.

AUDIO: Close binaural ASMR — fingertip on glass, blade tap, crystal-slice texture, particle sounds, glass clink. No music or voice.

STYLE: Photorealistic macro food cinematography, ray-traced glass, studio lighting, shallow DOF, 4K, 16:9.`;

// Ensure a generated prompt actually references the requested effect, not the hardcoded example.
function enforceEffectRelevance(text, effectName, tagline, userIdea, duration = 15, ratio = '9:16', type = 'image') {
  if (!text) return text;
  const normalizedEffect = String(effectName || '').toLowerCase();
  const normalizedTagline = String(tagline || '').toLowerCase();

  // Strip common markdown fences so the guard inspects the actual prompt content.
  let cleanText = String(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // Build keyword set from effect name, tagline, and user idea.
  const stopWords = new Set(['and', 'the', 'for', 'with', 'you', 'this', 'that', 'from', 'are', 'was', 'were', 'shorts', 'tiktok', 'youtube']);
  const keywords = [...new Set(
    [...normalizedEffect.split(/\s+/), ...normalizedTagline.split(/\s+/), ...String(userIdea || '').toLowerCase().split(/\s+/)]
      .filter(w => w.length > 2 && !stopWords.has(w))
  )];
  const textLower = cleanText.toLowerCase();
  const hasMatch = keywords.some(k => textLower.includes(k));

  // Words that strongly signal the LLM copied the hardcoded glass-fruit example.
  const exampleSignals = ['crystal-glass', 'crystal glass', 'cutting board', 'cutting-board', 'glass fruit', 'glassfruit', 'chef\'s knife'];
  const copiedExample = exampleSignals.some(s => textLower.includes(s));

  // Prompt is on-topic only if it matches the effect AND does not copy the example.
  if (hasMatch && !copiedExample) return cleanText;

  // If the prompt doesn't copy the example, trust it even if keywords don't match exactly.
  // The LLM was told to write about this effect — keyword matching is too aggressive for
  // creative prompts (e.g. "cozy family breakfast" is about "Everyday Life" but doesn't
  // contain the literal word "everyday").
  if (!copiedExample) return cleanText;

  // Prompt copied the example: return a clean, effect-aware fallback.
  const base = `A visually striking "${effectName}" scene${tagline ? ' — ' + tagline : ''}.${userIdea ? ' ' + userIdea : ''}`;
  if (type === 'video') {
    return `${base} Create an exactly ${duration}-second video anchored to the supplied first-frame image. Preserve the exact subject, style, lighting, and composition. Smooth continuous motion, camera continuity. Cinematic, photorealistic, ${ratio}.`;
  }
  return `${base} First-frame reference image, cinematic, photorealistic, highly detailed, ${ratio}, first frame only.`;
}

// Build a production-ready AI scene for a Flashloop-style effect using GPT-5.5.
// Returns both a first-frame/reference image prompt (img2img) and a motion
// prompt for image-to-video (img2video) that preserves the generated frame.
// Shared helper to clean character references for Flashloop prompts.
function cleanFlashloopRefs(references) {
  return (references || []).slice(0, 10).map(r => ({
    name: String(r.name || '').replace(/^@/, '').replace(/[^\w-]/g, '').slice(0, 40),
    description: String(r.description || '').slice(0, 600)
  })).filter(r => r.name);
}

function formatFlashloopRefs(cleanRefs) {
  return cleanRefs.length
    ? '\n\nCHARACTER REFERENCES — preserve these identities whenever @Name appears in the prompts. Expand them naturally in both prompts:\n' + cleanRefs.map(r => `- @${r.name}: ${r.description}`).join('\n')
    : '';
}

// Analyze a trend reference image and extract ONLY its visual style as text.
// Returns a style description that can be injected into prompts WITHOUT attaching
// the image — this prevents the LLM from copying the subject/scene from the ref.
async function analyzeTrendStyle(trendThumbnail, effectName, model = 'gpt-5.5') {
  if (!trendThumbnail) return '';
  try {
    const system = `You are a visual style analyst. You will be shown a reference image from a viral AI video trend. Your job is to describe ONLY the visual style, technique, and aesthetic of the image — NOT its subject, characters, objects, or scene content.

OUTPUT RULES:
- Describe ONLY: rendering technique (photorealistic / 3D claymation / cel-shaded anime / hand-drawn / etc.), color palette (specific colors and grading), lighting style, texture quality, camera/lens feel, mood, and overall aesthetic.
- DO NOT mention: people, characters, animals, objects, locations, actions, or any scene content.
- DO NOT say "the image shows..." or describe what is happening in the scene.
- Output a single dense paragraph of 60-120 words of pure style keywords and descriptions.
- End with a short "Style tag:" line summarizing the aesthetic in 8-15 keywords.`;
    const userContent = [
      { type: 'text', text: `Analyze the visual style of this "${effectName}" trend reference image. Remember: describe ONLY style, colors, lighting, textures, rendering technique, and mood. Do NOT describe the subject or scene content.` },
      { type: 'image_url', image_url: { url: trendThumbnail } }
    ];
    const raw = await chatCompletion(model, [{ role: 'system', content: system }, { role: 'user', content: userContent }], 1500);
    return (raw || '').trim();
  } catch (e) {
    logLine(`trend style analysis failed: ${e.message}`);
    return '';
  }
}

// Generate only the first-frame / reference image prompt (img2img).
// styleText is a pre-extracted style description (from analyzeTrendStyle) — the image
// itself is NOT attached to this call, so the LLM cannot copy the reference's subject.
async function generateFlashloopImagePrompt(effectName, tagline, userIdea, ratio, model = 'gpt-5.5', cleanRefs = [], styleText = '') {
  const refBlock = formatFlashloopRefs(cleanRefs);
  const hasStyle = !!styleText;
  const visionBlock = hasStyle
    ? `\n\nVISUAL STYLE REFERENCE (extracted from the "${effectName}" trend reference image):\n${styleText}\n\nYour prompt MUST be rendered in this exact visual style — same rendering technique, color palette, lighting, textures, and mood. The SUBJECT of your prompt must come from the effect name "${effectName}" and the user's idea below — NOT from any scene implied by the style description. The style tells you HOW to render, not WHAT to render.`
    : '';
  const system = `You are an expert prompt engineer for short-form AI video generation. Given an effect name, an optional tagline, and a short user idea, write a CONCISE first-frame / reference image prompt for img2img generation.

CRITICAL RULES:
- The EFFECT NAME is the core concept of the scene. "Everyday Life" means depict a relatable human everyday moment — family, morning routine, cooking, reading, etc. "Old Cartoon Style" means depict a scene in retro cartoon aesthetic. ALWAYS interpret the effect name as the scene's THEME and subject matter.
- You MUST generate a SPECIFIC scene with specific subjects, actions, and setting. Do NOT write generic descriptions like "a scene matching this effect." Instead write something like "A family of four sitting around a breakfast table, mother pouring coffee, children reaching for toast."
- The example below is ONLY for structure and tone. Do NOT copy its subject (crystal-glass fruit).
- Keep the prompt CONCISE: 80-150 words max. This is just a single frozen frame anchor.
- Focus ONLY on: (1) WHO is in the scene and WHAT they're doing, (2) camera angle and framing, (3) lighting and color palette, (4) key materials/textures, (5) style keywords.
- If a user idea is provided, incorporate it naturally. If no user idea, invent a specific compelling scene that represents the effect name as a viral trend.
${visionBlock}

Return ONLY a JSON object with "title" and "imagePrompt". Do not output any explanation outside the JSON.`;

  const userText = `Effect: ${effectName}${tagline ? ' — ' + tagline : ''}
The effect "${effectName}" is a viral trend — your scene MUST depict a concept that matches this name. For "Everyday Life", show a cozy relatable daily moment (family, morning routine, cooking together). For "Old Cartoon Style", show a scene in retro cartoon aesthetic.
${refBlock}
User idea: ${userIdea || 'Invent a specific compelling scene that represents "' + effectName + '" as a viral trend — pick specific subjects, a specific setting, and a specific action.'}
Aspect ratio: ${ratio}

Example (match its CONCISENESS, NOT its subject):

A photorealistic macro close-up of a crystal-glass fruit on a dark slate cutting board. Translucent teal glass skin, coral veins, six dark crystal seeds. Chef's knife beside it. Soft studio lighting from the left, realistic caustics. Camera 25° above, shallow DOF. No hands. 8K, 16:9, first frame only.

${hasStyle ? 'Render your scene in the exact visual style described in the VISUAL STYLE REFERENCE above. Your SUBJECT must be "' + effectName + '" — depict a scene that matches this trend name.' : 'Generate { "title": "...", "imagePrompt": "..." } for "' + effectName + '".'} Keep imagePrompt under 150 words. Do not output any explanation outside the JSON.`;

  const raw = await chatCompletion(model, [{ role: 'system', content: system }, { role: 'user', content: userText }], 4000);
  let parsed = {};
  try { parsed = parseJsonLenient(raw); } catch (e) { parsed = {}; }
  const imagePrompt = enforceEffectRelevance(parsed.imagePrompt || raw, effectName, tagline, userIdea, 0, ratio, 'image');
  return {
    title: parsed.title || effectName,
    imagePrompt
  };
}

// Generate only the motion / video prompt (img2video), using the generated image prompt as context.
async function generateFlashloopVideoPrompt(effectName, tagline, userIdea, duration, ratio, model = 'gpt-5.5', cleanRefs = [], imagePrompt = '', styleText = '') {
  const refBlock = formatFlashloopRefs(cleanRefs);
  const hasStyle = !!styleText;
  const visionBlock = hasStyle
    ? `\n\nVISUAL STYLE REFERENCE (extracted from the "${effectName}" trend reference image):\n${styleText}\n\nThe video MUST maintain this exact visual style throughout all frames — same rendering technique, color palette, lighting, textures, and mood. Camera movements and pacing should match this aesthetic. Audio description should complement the vibe. The SUBJECT comes from the effect name and user idea — NOT from any scene implied by the style description.`
    : '';
  const system = `You are an expert prompt engineer for short-form AI video generation. Given an effect name, an optional tagline, a short user idea, and a first-frame image prompt, write a detailed img2video / image-to-video prompt.

CRITICAL RULES:
- The EFFECT NAME is the core concept. "Everyday Life" means animate a relatable human everyday moment. "Old Cartoon Style" means animate in retro cartoon aesthetic. ALWAYS interpret the effect name as the scene's THEME and subject matter.
- You MUST describe specific actions, movements, and interactions. Do NOT write generic descriptions. The timeline must have concrete actions like "the mother lifts the coffee pot and pours" not "motion occurs."
- The example below is ONLY for structure and tone. Do NOT copy its subject.
- Keep the prompt 200-400 words. Do NOT include negative instructions — only describe what SHOULD happen.
- MUST include: (1) second-by-second action timeline with specific movements, (2) camera setup and continuity, (3) brief audio description, (4) style/technical specs.
- Preserve the exact subject, position, colors, lighting, and composition of the supplied first-frame image while animating.
${visionBlock}

Return ONLY a JSON object with "title" and "videoPrompt". Do not output any explanation outside the JSON.`;

  const userText = `Effect: ${effectName}${tagline ? ' — ' + tagline : ''}
The effect "${effectName}" is a viral trend — your scene MUST depict a concept that matches this name. For "Everyday Life", animate a cozy relatable daily moment. For "Old Cartoon Style", animate in retro cartoon aesthetic.
${refBlock}
User idea: ${userIdea || 'Invent a specific compelling scene that represents "' + effectName + '" as a viral trend — pick specific subjects, a specific setting, and a specific action.'}
Duration: ${duration} seconds
Aspect ratio: ${ratio}

First-frame image prompt (your video prompt must describe motion anchored to this exact frame):

${imagePrompt || 'No image prompt provided.'}

Example (match its STRUCTURE and TONE, NOT its subject. 200-400 words, no negative instructions):

${FLASHLOOP_EXAMPLE_VIDEO_PROMPT}

${hasStyle ? 'Render in the exact visual style described in the VISUAL STYLE REFERENCE above. Your SUBJECT must be "' + effectName + '" — animate a scene that matches this trend name.' : 'Generate { "title": "...", "videoPrompt": "..." } for "' + effectName + '".'} Keep videoPrompt 200-400 words. No negative instructions. Do not output any explanation outside the JSON.`;

  const raw = await chatCompletion(model, [{ role: 'system', content: system }, { role: 'user', content: userText }], 16000);
  let parsed = {};
  try { parsed = parseJsonLenient(raw); } catch (e) { parsed = {}; }
  const videoPrompt = enforceEffectRelevance(parsed.videoPrompt || raw, effectName, tagline, userIdea, duration, ratio, 'video');
  return {
    title: parsed.title || effectName,
    videoPrompt
  };
}

// Build a production-ready AI scene for a Flashloop-style effect using GPT-5.5.
// Returns both a first-frame/reference image prompt (img2img) and a motion
// prompt for image-to-video (img2video) that preserves the generated frame.
async function generateFlashloopScene(effectName, tagline, userIdea, duration, ratio, model = 'gpt-5.5', references = [], trendThumbnail = '') {
  const cleanRefs = cleanFlashloopRefs(references);

  // STEP 1: If we have a trend reference image, analyze it for STYLE ONLY first.
  // This extracts style as text so the LLM never sees the image subject.
  let styleText = '';
  if (trendThumbnail) {
    styleText = await analyzeTrendStyle(trendThumbnail, effectName, model);
    logLine(`trend style extracted for "${effectName}": ${styleText.length} chars`);
  }

  // STEP 2: Generate prompts using styleText (no image attached — LLM can't copy subject)
  const imageResult = await generateFlashloopImagePrompt(effectName, tagline, userIdea, ratio, model, cleanRefs, styleText);

  // Ensure the image prompt is never empty; if the LLM returned nothing useful, build a minimal anchor.
  if (!imageResult.imagePrompt || !imageResult.imagePrompt.trim()) {
    imageResult.imagePrompt = `First-frame reference image for "${effectName}"${tagline ? ' — ' + tagline : ''}.${userIdea ? ' User intent: ' + userIdea : ''} Cinematic, photorealistic, high detail, ${ratio}, first frame only.`;
  }

  let videoResult = {};
  try {
    videoResult = await generateFlashloopVideoPrompt(effectName, tagline, userIdea, duration, ratio, model, cleanRefs, imageResult.imagePrompt, styleText);
  } catch (e) { logLine('flashloop video prompt failed: ' + e.message); }

  // Ensure the video prompt is never empty — build a detailed fallback.
  if (!videoResult.videoPrompt || !videoResult.videoPrompt.trim()) {
    videoResult.videoPrompt = `Create an exactly ${duration}-second video for "${effectName}"${tagline ? ' — ' + tagline : ''}. Use the supplied first-frame image as the strict visual reference.

CAMERA: One continuous shot, no cuts. Preserve the exact subject, position, colors, lighting, and composition from the first-frame image.

ACTION TIMELINE:
0.0–${Math.floor(duration * 0.2)}s: Hold on the first-frame composition. Subtle ambient motion.
${Math.floor(duration * 0.2)}–${Math.floor(duration * 0.6)}s: Primary action unfolds — describe the main motion relevant to "${effectName}". Smooth, natural movement.
${Math.floor(duration * 0.6)}–${Math.floor(duration * 0.85)}s: Action reaches its peak or turning point.
${Math.floor(duration * 0.85)}–${duration}s: Settle into the final pose. Gentle deceleration. Hold on concluding frame.

AUDIO: Realistic audio synced to the action. Ambient room tone. No music unless required.
STYLE: Cinematic, photorealistic, ${ratio}. Preserve visual style from first-frame image. No text or logos.`;
  }

  return {
    title: videoResult.title || imageResult.title || effectName,
    imagePrompt: imageResult.imagePrompt,
    videoPrompt: videoResult.videoPrompt
  };
}

// TikWM direct trending feed (free, no login). Returns real trending TikTok videos.
async function ttTrendingFeed(limit = 10) {
  try {
    const res = await fetch('https://www.tikwm.com/api/feed/list?region=US&count=' + Math.min(limit * 2, 30), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'application/json' },
      signal: AbortSignal.timeout(VERCEL_TIMEOUT)
    });
    const json = await res.json().catch(() => ({}));
    let videos = [];
    if (Array.isArray(json.data)) videos = json.data;
    else if (Array.isArray(json.data?.videos)) videos = json.data.videos;
    else if (Array.isArray(json.videos)) videos = json.videos;
    const result = [];
    const seen = new Set();
    for (const v of videos) {
      const id = v.video_id || v.id || v.aweme_id;
      const authorId = v.author?.unique_id || v.author?.uniqueId || 'user';
      const duration = Number(v.duration || 0);
      if (!id || seen.has(id)) continue;
      if (duration > 60) continue;
      seen.add(id);
      result.push({
        id: String(id),
        title: v.title || v.desc || '',
        thumbnail: v.origin_cover || v.cover || '',
        url: authorId !== 'user' ? `https://www.tiktok.com/@${authorId}/video/${id}` : `https://www.tiktok.com/video/${id}`,
        views: v.play_count || 0,
        likes: v.digg_count || 0,
        duration: duration || 15,
        author: v.author?.nickname || v.author?.unique_id || authorId || '',
        platform: 'tiktok'
      });
      if (result.length >= limit) break;
    }
    return result;
  } catch (e) { logLine('TikTok trending feed failed: ' + e.message); }
  return [];
}

// Search YouTube Shorts via the official YouTube Data API v3 (free, stable, no scraping).
// Requires YOUTUBE_API_KEY. Returns short-form videos (<= 60s) only.
async function ytApiSearch(query, limit = 5) {
  const result = [];
  if (!YOUTUBE_API_KEY) return result;
  try {
    const maxResults = Math.min(limit * 3, 50);
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=${maxResults}&q=${encodeURIComponent(query)}&type=video&videoDuration=short&key=${YOUTUBE_API_KEY}`;
    const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(15000) });
    const searchJson = await searchRes.json().catch(() => ({}));
    if (searchJson.error) { logLine('YouTube API error: ' + (searchJson.error.message || 'unknown')); return result; }
    const items = searchJson.items || [];
    if (!items.length) return result;
    const ids = items.map(i => i.id?.videoId).filter(Boolean).slice(0, 50);
    if (!ids.length) return result;
    const detailsUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics&id=${ids.join(',')}&key=${YOUTUBE_API_KEY}`;
    const detailsRes = await fetch(detailsUrl, { signal: AbortSignal.timeout(15000) });
    const detailsJson = await detailsRes.json().catch(() => ({}));
    if (detailsJson.error) { logLine('YouTube API details error: ' + (detailsJson.error.message || 'unknown')); return result; }
    const detailsMap = new Map((detailsJson.items || []).map(d => [d.id, d]));      const seen = new Set();
    for (const item of items) {
      const id = item.id?.videoId;
      if (!id || seen.has(id)) continue;
      const d = detailsMap.get(id);
      if (!d) continue;
      const seconds = parseIsoDuration(d.contentDetails?.duration);
      if (!seconds || seconds > 60) continue;
      seen.add(id);
      result.push({
        id,
        title: item.snippet?.title || '',
        thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url || '',
        url: 'https://www.youtube.com/shorts/' + id,
        views: Number(d.statistics?.viewCount || 0),
        likes: Number(d.statistics?.likeCount || 0),
        duration: seconds,
        author: item.snippet?.channelTitle || '',
        platform: 'youtube'
      });
    }
    result.sort((a, b) => b.views - a.views);
    return result.slice(0, limit);
  } catch (e) { logLine('YouTube API search failed'); }
  return result;
}

function parseIsoDuration(dur) {
  if (!dur) return 0;
  const m = String(dur).toUpperCase().match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  const h = Number(m[1] || 0), min = Number(m[2] || 0), s = Number(m[3] || 0);
  return h * 3600 + min * 60 + s;
}

// Back-compat wrapper used by older call sites
for (const d of [FRAMES_DIR, VIDEO_DIR, STORYBOARD_DIR]) fs.mkdirSync(d, { recursive: true });

const MODELS = ['kimi-k3', 'gpt-5.6-sol', 'gpt-5.6-terra', 'claude-opus-4-8', 'qwen3.8-max', 'gemini-3.1-pro', 'kimi-2.7-code', 'glm-5.2', 'mimo-v2.5', 'claude-sonnet-4-5', 'deepseek-v3.2', 'gemini-2.5-pro'];
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

// ---------------- trends cache ----------------
// No server-side cache for /api/trends — always fetch fresh results

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
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(VERCEL_TIMEOUT) });
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

  // Try catbox.moe first — permanent direct links (no expiration)
  try {
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('fileToUpload', new Blob([buf], { type: mime }), `image.${ext}`);
    const res = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
    const text = await res.text();
    if (res.ok && text && text.startsWith('https://')) {
      logFn(`uploaded to catbox: ${text}`);
      return text.trim();
    }
  } catch (e) { logFn(`catbox upload failed: ${e.message}`); }

  // Fallback to uguu.se (temporary, expires ~1hr) if catbox fails
  try {
    const form = new FormData();
    form.append('files[]', new Blob([buf], { type: mime }), `image.${ext}`);
    const res = await fetch('https://uguu.se/upload', { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
    const j = await res.json().catch(() => ({}));
    if (j.files && j.files[0] && j.files[0].url) {
      const url = j.files[0].url;
      logFn(`uploaded to uguu: ${url}`);
      return url;
    }
  } catch (e) { logFn(`uguu fallback upload failed: ${e.message}`); }

  throw new Error('image upload failed: catbox and uguu both failed');
}
// Keep old name as alias for backwards compat
const uploadToCatbox = uploadToImageHost;

// PaxSenix img2img accepts only publicly accessible HTTP image URLs. Uploaded
// refs are local files uploaded by the user. Catbox URLs are permanent.
// Resolve a public URL for the influencer's reference image, verifying it is
// still reachable; if the stored URL is dead, re-upload the local file.
async function resolveInfluencerRefUrl(infl) {
  infl.refs = infl.refs || [];

  // Verify stored URL is alive before using it
  for (const ref of infl.refs.filter(r => r?.url)) {
    const alive = await isAccessibleImageUrl(ref.url);
    if (alive) {
      inflLogLine(`using verified reference: ${ref.path} → ${ref.url.slice(0, 60)}`);
      return ref.url;
    }
    inflLogLine(`stored reference URL is dead, re-uploading: ${ref.path}`);
  }

  // No usable URL — re-upload the local file to catbox.moe
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
async function writeJson(f, d) { await fsp.mkdir(path.dirname(f), { recursive: true }); await fsp.writeFile(f, JSON.stringify(d, null, 2)); }

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
  const timer = setTimeout(() => ac.abort(), IS_VERCEL ? 18000 : 120000);
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
  const imgQuality = ' Photorealistic smartphone photo quality. Natural lighting and shadows. Realistic human anatomy and hand interactions. No beauty filters. No artificial effects. No AI artifacts. Unpolished home phone recording aesthetics. Indistinguishable from a genuine smartphone photo taken by a real lifestyle influencer.';
  const rawPrompt = hasDesc ? `${styled}, ultra realistic photorealistic 8K, natural skin texture${imgQuality}` : `${infl.description} ${styled}, ultra realistic photorealistic 8K, natural skin texture${imgQuality}`;
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
// The reference IMAGE is the ground truth for appearance. The text prompt must
// ONLY describe the scene/action — NEVER the person's face/body, or the text
// overrides the image and breaks likeness preservation.
async function generateInfluencerContentImg2Img(infl, refUrl, userPrompt, style, ratio, imageModel) {
  fs.mkdirSync(influencerDir(infl.id), { recursive: true });
  inflSetPhase('infl-img2img', 1);
  inflLogLine(`generating img2img content for "${infl.name}"`);
  inflLogLine(`reference image: ${refUrl.slice(0, 80)}`);

  // The reference IMAGE is the identity. Strip any "Identity Consistency" blocks
  // (which often contain detailed text descriptions that override the photo)
  // and keep only scene/camera/lighting/outfit/photography instructions.
  let sceneOnly = userPrompt
    .replace(/Identity Consistency:?[\s\S]*?(?=\n\n[A-Z][a-zA-Z ]*:|$)/i, '')
    .replace(/Negative Prompt:?[\s\S]*?(?=\n\n[A-Z][a-zA-Z ]*:|$)/i, '')
    .trim();
  // Also remove hardcoded facial-feature paragraphs the LLM sometimes injects
  sceneOnly = sceneOnly.replace(/A woman in her (late twenties|twenties|.*?) with[\s\S]*?(?=\n\n|Scene:|Pose:|Camera:|Lighting:|Outfit:|Environment:|Photography:)/gi, '');
  sceneOnly = applyStyle(sceneOnly || 'doing an everyday lifestyle activity', style);
  const identityLock = 'CRITICAL: Preserve the EXACT face, hair, skin tone, and identity from the provided reference image. Do not alter or beautify facial features. ';
  const imgQuality = 'Photorealistic smartphone photo. Natural lighting. Realistic anatomy. No beauty filters. No AI artifacts.';
  const fullPrompt = sanitizePrompt(identityLock + sceneOnly + ' ' + imgQuality);
  inflLogLine(`cleaned scene prompt length: ${fullPrompt.length} chars`);

  let url = null;
  // Try seedream-5 up to 3 times. Add image_strength to keep output close to ref.
  for (let attempt = 1; attempt <= 3; attempt++) {
    inflLogLine(`img2img: seedream-5 attempt ${attempt}/3...`);
    const postBody = JSON.stringify({ prompt: fullPrompt, model: 'seedream-5', ratio, image_urls: [refUrl], strength: 0.35, image_strength: 0.35 });
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
      url = await waitTask(task, 15, inflLogLine);
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
async function generateInfluencerVideo(infl, contentId, ratio, videoDuration = 6, customVideoPrompt = '') {
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
  const mandatoryStyle = ` VISUAL STYLE: Natural smartphone video quality. Slight realistic handheld shake. Smooth normal frame-rate motion. Authentic casual interactions and physics. Realistic sunlight and exposure adaptation. Stable main character consistency. Unpolished home phone recording aesthetics. No professional stabilization. No cinematic color grading. No beauty filters. No artificial effects. No AI artifacts or glitches. IMPORTANT GENERATION REQUIREMENTS: Consistent identity throughout the video. Realistic human anatomy and hand interactions. Natural walking and body movement. Physically correct lighting and shadows. Rapid memory-style jump cuts every 1-2 seconds. No duplicated people or objects. No facial distortions. No impossible movements. Preserve the casual smartphone home-video feeling from beginning to end.`;
  // Use custom video prompt if provided, otherwise build from item prompt
  const basePrompt = customVideoPrompt || `animate this exact person with natural subtle movement. Keep the same face, hair, skin, and clothing exactly as shown. ${item.prompt}. Smooth ${videoDuration}-second camera movement, natural animation, maintain visual consistency.`;
  const animPrompt = sanitizePrompt(basePrompt + mandatoryStyle);
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
async function runJobOnVercel(res, jobFn, successData = { ok: true }) {
  try { await jobFn(); return sendJson(res, 200, successData); }
  catch (e) { return sendJson(res, 500, { error: String(e.message || e) }); }
}

// Save uploaded base64 image as a reference photo.
// Uploads to catbox.moe for a permanent public URL that PaxSenix img2img can use directly.
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

  // Upload to catbox.moe for a permanent public URL
  let publicUrl = null;
  try {
    publicUrl = await uploadToImageHost(outPath);
    inflLogLine(`uploaded to catbox: ${publicUrl}`);
  } catch (e) {
    inflLogLine(`catbox upload failed: ${e.message}`);
  }

  // Clear ALL old refs — replace with this one uploaded photo + its public URL
  infl.refs = [{ path: filename, uploaded: true, ...(publicUrl ? { url: publicUrl } : {}) }];
  await saveInfluencer(infl);
  return filename;
}

const requestHandler = async (req, res) => {
  // Normalize URL for Vercel (catch-all / rewrites may alter req.url)
  let rawUrl = req.url || '/';
  if (IS_VERCEL) {
    const hdrPath = req.headers['x-invoke-path'] || req.headers['x-matched-path'] || req.headers['x-vercel-original-path'];
    if (hdrPath && typeof hdrPath === 'string') {
      const qs = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?')) : '';
      rawUrl = hdrPath.startsWith('/') ? hdrPath + qs : '/' + hdrPath + qs;
    }
    // Catch-all sometimes yields /api/[...path] or path without /api prefix
    if (!rawUrl.startsWith('/api') && !rawUrl.startsWith('/frames') && !rawUrl.startsWith('/video') && !rawUrl.startsWith('/public')) {
      const bare = rawUrl.startsWith('/') ? rawUrl : '/' + rawUrl;
      if (bare !== '/' && !bare.startsWith('/?')) rawUrl = '/api' + bare;
    }
  }
  const u = new URL(rawUrl, `http://localhost:${PORT}`);
  let p = u.pathname;
  // Strip trailing slash except root
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  try {
    // --- API ---
    if (p === '/api/status') return sendJson(res, 200, job);
    if (p === '/api/health' || p === '/api/ping') return sendJson(res, 200, { ok: true, vercel: IS_VERCEL, path: p, url: rawUrl, hasKey: !!API_KEY });
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
      if (IS_VERCEL) return runJobOnVercel(res, async () => {
        const { characters, frames } = await generateStoryboard(script, model || MODELS[0], targetDuration, look || '', language || DEFAULT_LANGUAGE, secPerFrame);
        job.ok = 1; job.done = 1;
        const totalDur = frames.reduce((s, f) => s + (f.duration_sec || 0), 0);
        logLine(`storyboard ready: ${characters.length} characters, ${frames.length} frames (${totalDur}s total)`);
        job.phase = 'idle';
      });
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
      if (body.force === true) { for (const c of chars) { try { fs.unlinkSync(charRefFile(c.id)); } catch {} } }
      else if (Array.isArray(body.force)) { for (const id of body.force) { try { fs.unlinkSync(charRefFile(id)); } catch {} } }
      if (IS_VERCEL) return runJobOnVercel(res, async () => { await generateCharRefs(chars, body.imageModel || IMAGE_MODELS[0], body.style || 'cinematic'); job.phase = 'idle'; });
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
      if (IS_VERCEL) return runJobOnVercel(res, async () => { await generateImages(frames, body.imageModel || IMAGE_MODELS[0], body.ratio || '16:9', body.style || 'cinematic', body.consistency !== false, chars); job.phase = 'idle'; });
      generateImages(frames, body.imageModel || IMAGE_MODELS[0], body.ratio || '16:9', body.style || 'cinematic', body.consistency !== false, chars).catch(e => { logLine(`images crash: ${e.message}`); job.phase = 'idle'; });
      return sendJson(res, 202, { started: true, count: frames.length });
    }

    if (p === '/api/videos' && req.method === 'POST') {
      if (job.phase !== 'idle') return sendJson(res, 409, { error: 'busy' });
      const body = await readBody(req).catch(() => ({}));
      const frames = await readJson(FRAMES_JSON) || [];
      if (!frames.length) return sendJson(res, 400, { error: 'no frames' });
      if (body.force) { for (const f of frames) { if (f.animation_prompt) { try { fs.unlinkSync(videoFile(f.frame)); } catch {} } } }
      if (IS_VERCEL) return runJobOnVercel(res, async () => { await generateVideos(frames, body.ratio || '16:9', body.videoModel || DEFAULT_VIDEO_MODEL); job.phase = 'idle'; });
      generateVideos(frames, body.ratio || '16:9', body.videoModel || DEFAULT_VIDEO_MODEL).catch(e => { logLine(`videos crash: ${e.message}`); job.phase = 'idle'; });
      return sendJson(res, 202, { started: true, count: frames.filter(f => f.animation_prompt).length });
    }

    if (p === '/api/combine' && req.method === 'POST') {
      if (job.phase !== 'idle') return sendJson(res, 409, { error: 'busy' });
      const body = await readBody(req).catch(() => ({}));
      const frames = await readJson(FRAMES_JSON) || [];
      if (IS_VERCEL) return runJobOnVercel(res, async () => { await combineFilm(frames, body.ratio || '16:9'); job.phase = 'idle'; });
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
      for (const f of frames) { try { fs.unlinkSync(ttsFile(f.frame)); } catch {} }
      for (const f of fs.readdirSync(VIDEO_DIR).filter(f => f.startsWith('narr_chunk_') || f === 'full_narration.mp3')) { try { fs.unlinkSync(path.join(VIDEO_DIR, f)); } catch {} }
      setPhase('narration', 1);
      if (IS_VERCEL) return runJobOnVercel(res, async () => { await generateFullNarration(frames, body.voice || DEFAULT_VOICE, body.language || DEFAULT_LANGUAGE); job.phase = 'idle'; });
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
      if (IS_VERCEL) return runJobOnVercel(res, async () => {
        const description = await expandInfluencerDescription(profile, model || 'gemini-2.5-pro');
        if (description) { profile.description = description; }
        if (body.id) { let infl = await findInfluencer(body.id); if (!infl) { infl = { id: body.id, createdAt: Date.now(), refs: [], content: [] }; Object.assign(infl, profile); } infl.description = description; infl.model = model; await saveInfluencer(infl); }
        inflJob.done = 1; inflJob.ok = 1; inflJob.phase = 'idle';
      });
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
      if (IS_VERCEL) return runJobOnVercel(res, async () => { await generateInfluencerRefs(infl); inflJob.phase = 'idle'; });
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
      const refUrl = body.refUrl || await resolveInfluencerRefUrl(infl);
      if (IS_VERCEL) return runJobOnVercel(res, async () => {
        if (refUrl) { await generateInfluencerContentImg2Img(infl, refUrl, body.prompt, body.style || 'realistic', body.ratio || '1:1', body.imageModel || IMAGE_MODELS[0]); }
        else { await generateInfluencerContent(infl, body.prompt, body.style || 'realistic', body.ratio || '1:1', body.imageModel || IMAGE_MODELS[0]); }
        inflJob.phase = 'idle';
      });
      if (refUrl) {
        inflLogLine(`image: auto-upgrading to img2img (ref found: ${refUrl.slice(0, 60)})`);
        generateInfluencerContentImg2Img(infl, refUrl, body.prompt, body.style || 'realistic', body.ratio || '1:1', body.imageModel || IMAGE_MODELS[0]).catch(e => { inflLogLine(`infl-img2img crash: ${e.message}`); inflJob.phase = 'idle'; });
      } else {
        inflLogLine('image: no reference available — using text-to-image');
        generateInfluencerContent(infl, body.prompt, body.style || 'realistic', body.ratio || '1:1', body.imageModel || IMAGE_MODELS[0]).catch(e => { inflLogLine(`infl-image crash: ${e.message}`); inflJob.phase = 'idle'; });
      }
      return sendJson(res, 202, { started: true });
    }

    // ---- img2img: transform a reference image ----
    if (p === '/api/influencer/img2img' && req.method === 'POST') {
      if (inflJob.phase !== 'idle') return sendJson(res, 409, { error: 'busy' });
      const body = await readBody(req);
      if (!body.id || !body.prompt) return sendJson(res, 400, { error: 'id and prompt required' });
      const infl = await findInfluencer(body.id);
      if (!infl) return sendJson(res, 404, { error: 'not found' });
      let refUrl = body.refUrl;
      if (!refUrl) { refUrl = await resolveInfluencerRefUrl(infl); }
      if (IS_VERCEL) return runJobOnVercel(res, async () => {
        if (refUrl) { await generateInfluencerContentImg2Img(infl, refUrl, body.prompt, body.style || 'realistic', body.ratio || '1:1', body.imageModel || IMAGE_MODELS[0]); }
        else { await generateInfluencerContent(infl, body.prompt, body.style || 'realistic', body.ratio || '1:1', body.imageModel || IMAGE_MODELS[0]); }
        inflJob.phase = 'idle';
      });
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
      if (IS_VERCEL) return runJobOnVercel(res, async () => { await generateInfluencerVideo(infl, body.contentId, body.ratio || '1:1', 6, body.videoPrompt || ''); inflJob.phase = 'idle'; });
      generateInfluencerVideo(infl, body.contentId, body.ratio || '1:1', 6, body.videoPrompt || '').catch(e => { inflLogLine(`infl-video crash: ${e.message}`); inflJob.phase = 'idle'; });
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
    // Primary: Tavily live trend discovery. Optional: omkar video search using those live terms.
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
        if (IS_VERCEL) {
          const queries = ['beauty influencer grwm', 'fashion haul ootd', 'lifestyle influencer vlog', 'get ready with me'];
          const [searchResults, feed] = await Promise.all([
            Promise.all(queries.map(q => ttSearch(q, Math.ceil(max / 4) + 1))).then(r => r.flat()).catch(() => []),
            ttTrendingFeed(max).catch(() => [])
          ]);
          const seen = new Set();
          const all = [];
          for (const v of [...searchResults, ...feed]) {
            if (!v || !v.id || seen.has(v.id)) continue;
            seen.add(v.id);
            all.push(v);
          }
          return sendJson(res, 200, {
            source: 'tiktok',
            videos: all.slice(0, max).map(v => ({
              id: v.id, platform: v.platform || 'tiktok', caption: v.title, title: v.title,
              author: v.author, authorName: v.author, views: v.views, likes: v.likes,
              duration: v.duration, cover: v.thumbnail, videoUrl: v.url, fresh: true, fetchedAt: Date.now()
            }))
          });
        }
        // 1) Get LIVE trending topics from Tavily to build search queries
        let liveTerms = [];
        let liveAsOf = null;
        if (TAVILY_API_KEY) {
          try {
            liveTerms = await tavilyTrendTerms('TikTok influencer trending', 20);
            liveAsOf = new Date().toISOString();
          } catch (e) { logLine('Tavily: ' + e.message); }
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

        // 3) Search BOTH YouTube Shorts and TikTok-style shorts (via yt-dlp, free, no API key)
        const perQ = Math.max(2, Math.ceil(max / Math.min(influencerQueries.length, 5)) + 1);
        const topQueries = influencerQueries.slice(0, 5);
        const [ytResults, ttResultsRaw] = await Promise.all([
          Promise.all(topQueries.map(q => ytSearch(q, perQ))).then(r => r.flat()),
          Promise.all(topQueries.map(q => ttSearch(q, perQ))).then(r => r.flat())
        ]);
        let ttResults = [...ttResultsRaw];

        // Optional: supplement with omkar if a key is configured, but merge instead of replace
        if (OMKAR_KEY) {
          try {
            const omkarResults = await Promise.allSettled(topQueries.map(async (q) => {
              const r = await fetch(`${OMKAR_API}/tiktok/videos/search?search_query=${encodeURIComponent(q)}&market=us&max_results=${perQ + 2}&sort_by=most_liked`, { headers: { 'API-Key': OMKAR_KEY }, signal: AbortSignal.timeout(VERCEL_TIMEOUT) });
              const j = await r.json().catch(() => ({}));
              return (j.videos || []).filter(v => (v.duration_seconds || 0) <= 60).map(v => ({
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
            const omkarVideos = omkarResults.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
            const seenIds = new Set(ttResults.map(v => v.id));
            for (const v of omkarVideos) { if (!seenIds.has(v.id)) { seenIds.add(v.id); ttResults.push(v); } }
          } catch (e) { logLine('omkar /api/trending/tiktok: ' + e.message); }
        }

        // 4) Interleave YouTube Shorts + TikTok-style shorts, dedupe, sort by views, take top N
        const seen = new Set();
        const allVideos = [];
        const ytPool = [...ytResults].sort((a, b) => (b.views || 0) - (a.views || 0));
        const ttPool = [...ttResults].sort((a, b) => (b.views || 0) - (a.views || 0));
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

        return sendJson(res, 200, {
          source: 'tavily-live+yt-shorts+tiktok-shorts',
          as_of_ts: liveAsOf || null,
          liveTerms: liveTerms.slice(0, 5),
          videos: allVideos.map(v => ({
            id: v.id, platform: v.platform || 'tiktok', caption: v.title, title: v.title,
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
      const max = Math.min(parseInt(u.searchParams.get('max') || '12'), 30);
      if (!q) return sendJson(res, 400, { error: 'q (query) required' });

      // Try omkar.cloud first if a key is configured; otherwise go straight to yt-dlp short-form fallback.
      if (OMKAR_KEY) {
        try {
          const sort = u.searchParams.get('sort') || 'most_liked';
          const market = u.searchParams.get('market') || 'us';
          const r = await fetch(`${OMKAR_API}/tiktok/videos/search?search_query=${encodeURIComponent(q)}&market=${market}&max_results=${max}&sort_by=${sort}`, { headers: { 'API-Key': OMKAR_KEY } });
          const j = await r.json();
          if (j.videos && j.videos.length) {
            return sendJson(res, 200, {
              videos: (j.videos || []).map(v => ({
                id: v.video_id, platform: 'tiktok', caption: v.caption,
                author: v.author?.handle, authorName: v.author?.display_name,
                views: v.stats?.views, likes: v.stats?.likes, comments: v.stats?.comments, shares: v.stats?.shares,
                duration: v.duration_seconds, cover: v.thumbnails?.cover_url, videoUrl: v.media?.video_url,
                audio: v.audio?.title, createdAt: v.created_at
              })),
              source: 'omkar'
            });
          }
        } catch (e) { logLine('omkar search failed: ' + e.message); }
      }

      // Fallback: short-form results from yt-dlp (YouTube Shorts + TikTok-style shorts)
      try {
        const [tt, yt] = await Promise.all([
          ttSearch(q, Math.ceil(max / 2) + 2),
          ytSearch(q, Math.ceil(max / 2) + 2)
        ]);
        const seen = new Set();
        const videos = [];
        const ytPool = [...yt].sort((a, b) => (b.views || 0) - (a.views || 0));
        const ttPool = [...tt].sort((a, b) => (b.views || 0) - (a.views || 0));
        while (videos.length < max && (ytPool.length || ttPool.length)) {
          if (ytPool.length) { const v = ytPool.shift(); if (!seen.has(v.id)) { seen.add(v.id); videos.push(v); } }
          if (videos.length >= max) break;
          if (ttPool.length) { const v = ttPool.shift(); if (!seen.has(v.id)) { seen.add(v.id); videos.push(v); } }
        }
        return sendJson(res, 200, {
          videos: videos.map(v => ({
            id: v.id, platform: v.platform || 'youtube', caption: v.title, title: v.title,
            author: v.author, authorName: v.author,
            views: v.views, likes: v.likes, comments: null, shares: null,
            duration: v.duration, cover: v.thumbnail, videoUrl: v.url,
            audio: null, createdAt: null, fresh: true, fetchedAt: Date.now()
          })),
          source: 'yt-dlp-shorts'
        });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // ================================ TRENDS TAB (anime, AI-generated, lifestyle, etc.) ================================
    // Pulls LIVE trending terms from Tavily and finds real short-form videos via yt-dlp.
    // Works without login, no rate limits. No server-side cache.
    if (p === '/api/trends' && req.method === 'GET') {
      try {
      const category = (u.searchParams.get('category') || 'anime').toLowerCase();
      const max = Math.min(parseInt(u.searchParams.get('max') || '20'), 30);
      const forceRefresh = u.searchParams.get('refresh') === '1' || u.searchParams.get('nocache') === '1';
      const searchQuery = (u.searchParams.get('q') || '').trim();

      if (IS_VERCEL) {
        // Trend Loop (flashloop category): scrape Flashloop formats — not TikTok search
        if (category === 'flashloop' || category === 'ai-formats') {
          let flashloopFormats = [];
          try { flashloopFormats = await scrapeFlashloop(); } catch (e) { logLine('vercel flashloop: ' + e.message); }
          if (!flashloopFormats.length) {
            // Minimal fallback so UI is never empty if scrape is blocked
            flashloopFormats = [
              { slug: 'crystal-fruit-cv', name: 'Crystal Fruit', thumbnail: '', tagline: 'ASMR crystal fruit cut' },
              { slug: 'claymation-cv', name: 'Claymation', thumbnail: '', tagline: '3D clay viral style' },
              { slug: 'anime-edit-cv', name: 'Anime Edit', thumbnail: '', tagline: 'Viral anime edit format' },
              { slug: 'product-reveal-cv', name: 'Product Reveal', thumbnail: '', tagline: 'Cinematic product unbox' },
              { slug: 'face-morph-cv', name: 'Face Morph', thumbnail: '', tagline: 'Identity morph trend' },
              { slug: 'mini-world-cv', name: 'Mini World', thumbnail: '', tagline: 'Tiny world diorama' },
              { slug: 'food-asmr-cv', name: 'Food ASMR', thumbnail: '', tagline: 'Macro food ASMR' },
              { slug: 'outfit-transform-cv', name: 'Outfit Transform', thumbnail: '', tagline: 'Wardrobe change viral' }
            ];
          }
          return sendJson(res, 200, {
            source: 'flashloop',
            category,
            as_of_ts: new Date().toISOString(),
            liveTerms: [],
            videos: flashloopFormats.slice(0, max).map(flashloopAsVideo),
            flashloopFormats: flashloopFormats.slice(0, 30),
            tavilyConnected: !!TAVILY_API_KEY,
            flashloopConnected: flashloopFormats.length > 0
          });
        }
        // SJinn viral prompts: scrape SJinn trend-prompts — not TikTok search
        if (category === 'sjinn') {
          let sjinnTrends = [];
          try { sjinnTrends = await scrapeSjinn(); } catch (e) { logLine('vercel sjinn: ' + e.message); }
          if (!sjinnTrends.length) {
            sjinnTrends = [
              { slug: 'slime-face', name: 'Slime Face', thumbnail: 'https://edit.comfyonline.app/result/c0f72f12-1c59-481b-8153-63507a0cf861.jpg', tagline: 'Slime portrait ASMR' },
              { slug: 'micro-camera-animal', name: 'Micro Camera Animal', thumbnail: 'https://edit.comfyonline.app/result/21414077-1074-4697-8e82-f88014e9e804.jpg', tagline: 'Tiny animal macro lens' },
              { slug: 'topiary-shorts', name: 'Topiary Shorts', thumbnail: 'https://edit.comfyonline.app/result/79e06e43-7a8c-44b4-b0b8-933c450f74e7.jpg', tagline: 'Plant sculpture viral' },
              { slug: 'food-eating-itself', name: 'Food Eating Itself', thumbnail: 'https://edit.comfyonline.app/result/7405f2e3-b236-4346-91a7-5ed4e3b87ebb.jpg', tagline: 'Food cannibalism trend' },
              { slug: 'fruit-avatar', name: 'Fruit Avatar', thumbnail: 'https://edit.comfyonline.app/result/de450048-be72-4533-88a2-12482c19ba61.png', tagline: 'Human-fruit hybrid portrait' },
              { slug: 'matchstick-shorts', name: 'Matchstick Shorts', thumbnail: 'https://edit.comfyonline.app/result/38da8934-a505-4a1e-bbba-4c817e9f0e91.png', tagline: 'Tiny matchstick world' },
              { slug: 'rust-removal', name: 'Rust Removal', thumbnail: 'https://edit.comfyonline.app/result/3c89e4f4-254b-48b7-89e7-2d0c7d532727.png', tagline: 'Satisfying rust cleaning' },
              { slug: 'object-talk', name: 'Object Talk', thumbnail: 'https://edit.comfyonline.app/result/33d64f76-d761-4748-897d-1d221e68372f.jpg', tagline: 'Objects with human faces' },
              { slug: 'time-travel-vlog', name: 'Time Travel Vlog', thumbnail: 'https://edit.comfyonline.app/result/a2675b88-d086-4a64-a925-993944aee29d.jpg', tagline: 'Era-hopping vlog' },
              { slug: 'fruit-movie-maker', name: 'Fruit Movie Maker', thumbnail: 'https://edit.comfyonline.app/result/6451c532-7df1-41cd-bfa2-135a16b4e979.jpg', tagline: 'Fruit-directed films' },
              { slug: 'flying-dragon', name: 'Flying Dragon', thumbnail: 'https://edit.comfyonline.app/result/15a562cb-50b4-4a01-9511-d55b9ab769f1.png', tagline: 'Dragon soaring cinematic' },
              { slug: 'mechanical-toy', name: 'Mechanical Toy', thumbnail: 'https://edit.comfyonline.app/result/78749edc-7e14-4f62-9e85-34b7d35f0355.png', tagline: 'Steampunk toy animation' },
              { slug: 'mini-rescue', name: 'Mini Rescue', thumbnail: 'https://edit.comfyonline.app/result/2bd49c53-98bd-4834-8f25-c0f537b2bd9b.png', tagline: 'Tiny rescue mission' },
              { slug: 'pov-roller-coaster', name: 'POV Roller Coaster', thumbnail: 'https://edit.comfyonline.app/result/d500621a-8a29-48f6-9355-b67f5e67fc23.png', tagline: 'First-person coaster ride' }
            ];
          }
          return sendJson(res, 200, {
            source: 'sjinn',
            category,
            as_of_ts: new Date().toISOString(),
            liveTerms: [],
            videos: sjinnTrends.slice(0, max).map(sjinnAsVideo),
            sjinnTrends: sjinnTrends.slice(0, 30),
            tavilyConnected: !!TAVILY_API_KEY,
            sjinnConnected: sjinnTrends.length > 0
          });
        }
        // Regular trends: TikWM search + trending feed in parallel (short timeout)
        const queries = searchQuery
          ? [searchQuery]
          : (category === 'trending'
            ? ['viral', 'fyp', 'trending']
            : [category, category + ' shorts', category + ' viral']);
        let ttVideos = [];
        try {
          const [searchResults, feed] = await Promise.all([
            Promise.all(queries.slice(0, 3).map(q => ttSearch(q, Math.ceil(max / 2) + 1))).then(r => r.flat()).catch(() => []),
            ttTrendingFeed(max).catch(() => [])
          ]);
          const seen = new Set();
          for (const v of [...searchResults, ...feed]) {
            if (!v || !v.id || seen.has(v.id)) continue;
            seen.add(v.id);
            ttVideos.push(v);
          }
        } catch (e) { logLine('vercel trends: ' + e.message); }
        return sendJson(res, 200, {
          source: 'tiktok',
          category,
          as_of_ts: new Date().toISOString(),
          videos: ttVideos.slice(0, max),
          liveTerms: [],
          flashloopFormats: [],
          tavilyConnected: !!TAVILY_API_KEY,
          flashloopConnected: false
        });
      }

      // Category-specific search queries tuned for yt-dlp + Tavily
      // Short-form queries for both TikTok and YouTube Shorts (<= 60s)
      const CATEGORY_QUERIES = {
        anime: ['anime edits', 'anime amv', 'anime dance trend', 'anime cosplay', 'anime meme', 'anime opening'],
        'ai-generated': ['ai generated video', 'ai art trend', 'ai animation', 'midjourney animation', 'ai influencer', 'sora ai'],
        'ai-formats': [], // populated dynamically from flashloop scrape below
        grwm: ['grwm', 'get ready with me', 'morning routine', 'makeup routine', 'grwm viral'],
        ootd: ['ootd', 'outfit of the day', 'fashion haul', 'styling outfit', 'fit check'],
        lifestyle: ['lifestyle influencer', 'aesthetic vlog', 'day in my life', 'morning routine viral', 'soft life'],
        fitness: ['gym workout', 'fitness routine', 'workout motivation', 'gym check', 'home workout'],
        beauty: ['makeup tutorial', 'skincare routine', 'beauty hack', 'glow up', 'get ready with me'],
        food: ['recipe', 'what i eat in a day', 'food aesthetic', 'easy recipe', 'food trend'],
        travel: ['travel vlog', 'travel aesthetic', 'wanderlust', 'weekend trip', 'travel shorts'],
        dance: ['dance trend', 'tiktok dance', 'dance challenge', 'choreo trend', 'dance viral'],
        trending: ['trending', 'viral', 'for you page', 'trending now', 'popular']
      };

      // 1) Fetch LIVE trending terms from Tavily for this category
      let liveTerms = [];
      let liveAsOf = null;
      if (TAVILY_API_KEY) {
        try {
          liveTerms = await tavilyTrendTerms(category, 5);
          liveAsOf = new Date().toISOString();
        } catch (e) { logLine('Tavily fetch: ' + e.message); }
      }

      // For 'flashloop' tab: return the curated Flashloop formats directly.
      if (category === 'flashloop') {
        const flashloopFormats = await scrapeFlashloop();
        return sendJson(res, 200, {
          source: 'flashloop',
          category,
          as_of_ts: liveAsOf || new Date().toISOString(),
          liveTerms,
          videos: flashloopFormats.slice(0, max).map(flashloopAsVideo),
          flashloopFormats: flashloopFormats.slice(0, 30)
        });
      }

      // For 'sjinn' tab: return SJinn viral prompt templates directly.
      if (category === 'sjinn') {
        let sjinnTrends = [];
        try { sjinnTrends = await scrapeSjinn(); } catch (e) { logLine('sjinn trends: ' + e.message); }
        return sendJson(res, 200, {
          source: 'sjinn',
          category,
          as_of_ts: liveAsOf || new Date().toISOString(),
          liveTerms,
          videos: sjinnTrends.slice(0, max).map(sjinnAsVideo),
          sjinnTrends: sjinnTrends.slice(0, 30)
        });
      }

      // 3) Search YouTube Shorts (yt-dlp) AND TikTok real shorts in PARALLEL
      // For 'ai-formats': pull the curated viral format catalog from Flashloop and
      // use the top format names as the query list for yt-dlp / TikWM. This gives
      // users both the curated templates AND real matching short-form videos.
      let flashloopFormats = [];
      if (category === 'ai-formats' || category === 'ai-generated') {
        flashloopFormats = await scrapeFlashloop();
      }
      // Build the final query list. For 'ai-formats' override CATEGORY_QUERIES so
      // we search yt-dlp / TikWM with the actual format names from flashloop.
      let queries;
      if (category === 'ai-formats') {
        queries = flashloopFormats.slice(0, Math.min(5, flashloopFormats.length)).map(f => f.name);
        if (queries.length === 0) queries = CATEGORY_QUERIES['ai-generated'];
      } else {
        queries = CATEGORY_QUERIES[category] || CATEGORY_QUERIES.anime;
      }

      const finalQueries = searchQuery
        ? [searchQuery, ...queries, ...liveTerms].slice(0, 5).sort(() => Math.random() - 0.5)
        : [...queries, ...liveTerms].slice(0, 5).sort(() => Math.random() - 0.5);

      let ytVideos = [];
      let ttVideos = [];
      const perQ = Math.max(3, Math.ceil(max / finalQueries.length));
      try {
        if (YOUTUBE_API_KEY) {
          const ytResults = await Promise.all(finalQueries.slice(0, 5).map(q => ytApiSearch(q, perQ)));
          ytVideos = ytResults.flat();
          // Fallback to yt-dlp if the API key is set but returned no shorts
          if (ytVideos.length === 0) {
            const ytResults = await Promise.all(finalQueries.slice(0, 5).map(q => ytSearch(q, perQ)));
            ytVideos = ytResults.flat();
          }
        } else {
          const ytResults = await Promise.all(finalQueries.slice(0, 5).map(q => ytSearch(q, perQ)));
          ytVideos = ytResults.flat();
        }
      } catch (e) { logLine('ytSearch trends: ' + e.message); }

      try {
        if (category === 'trending') {
          // Dedicated trending tab: use TikWM's real trending feed
          ttVideos = await ttTrendingFeed(max);
        } else {
          const ttResults = await Promise.all(finalQueries.slice(0, 5).map(q => ttSearch(q, perQ)));
          ttVideos = ttResults.flat();
          // Fallback to the real trending feed only if search produced no TikToks
          if (ttVideos.length === 0) {
            const feed = await ttTrendingFeed(max * 2);
            const seen = new Set(ttVideos.map(v => v.id));
            for (const v of feed) if (!seen.has(v.id)) { seen.add(v.id); ttVideos.push(v); }
          }
        }
      } catch (e) { logLine('ttSearch trends: ' + e.message); }

      // Optional: also try omkar if a key is configured, but merge with the yt-dlp fallback
      if (OMKAR_KEY) {
        try {
          const omkarResults = await Promise.allSettled(finalQueries.slice(0, 5).map(async (q) => {
            const r = await fetch(`${OMKAR_API}/tiktok/videos/search?search_query=${encodeURIComponent(q)}&market=us&max_results=${perQ + 2}&sort_by=most_liked`, { headers: { 'API-Key': OMKAR_KEY }, signal: AbortSignal.timeout(VERCEL_TIMEOUT) });
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
          const omkarVideos = omkarResults.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
          const seenIds = new Set(ttVideos.map(v => v.id));
          for (const v of omkarVideos) { if (!seenIds.has(v.id)) { seenIds.add(v.id); ttVideos.push(v); } }
        } catch (e) { logLine('omkar trends: ' + e.message); }
      }

      // 4) Interleave YT Shorts + TikTok shorts, dedupe, shuffle, take top N
      function shuffle(arr) { return arr.sort(() => Math.random() - 0.5); }
      const seen = new Set();
      let allVideos = [];
      const ytPool = shuffle([...ytVideos]);
      const ttPool = shuffle([...ttVideos]);
      // Interleave so each platform gets representation (50/50 balance)
      while (allVideos.length < max && (ytPool.length || ttPool.length)) {
        if (ytPool.length) {
          const v = ytPool.shift();
          if (!seen.has(v.id) && Number(v.duration || 0) > 0 && Number(v.duration || 0) <= 60) { seen.add(v.id); allVideos.push(v); }
        }
        if (allVideos.length >= max) break;
        if (ttPool.length) {
          const v = ttPool.shift();
          if (!seen.has(v.id) && Number(v.duration || 0) > 0 && Number(v.duration || 0) <= 60) { seen.add(v.id); allVideos.push(v); }
        }
      }
      // Final shuffle so trending feed videos don't always sit at the top
      shuffle(allVideos);

      // Interleave Flashloop curated formats alongside real videos so users see both
      if (flashloopFormats.length) {
        const flashItemsAll = flashloopFormats.map(flashloopAsVideo);
        const tl = [...flashItemsAll, ...allVideos];
        allVideos = shuffle(tl);
      }

      const result = {
        source: (liveTerms.length ? 'tavily+' : '') + (flashloopFormats.length ? 'flashloop+' : '') + 'yt-shorts+tiktok-shorts',
        category,
        as_of_ts: liveAsOf,
        liveTerms,
        flashloopFormats: flashloopFormats.slice(0, 30),
        videos: allVideos,
        tavilyConnected: !!TAVILY_API_KEY,
        flashloopConnected: flashloopFormats.length > 0
      };
      return sendJson(res, 200, result);
      } catch (trendsErr) { return sendJson(res, 200, { source: 'error', category: (u.searchParams.get('category') || 'anime'), videos: [], liveTerms: [], flashloopFormats: [], error: trendsErr.message }); }
    }

    // Generate detailed image + video prompts for a selected Flashloop viral AI format.
    if (p === '/api/flashloop/generate-prompt' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const { slug = '', name = '', tagline = '', idea = '', duration = 15, ratio = '9:16', model = 'gpt-5.5', references = [], trendThumbnail = '' } = body || {};
        const effectName = String(name || slug).trim();
        if (!effectName) return sendJson(res, 400, { error: 'effect name or slug required' });
        const selectedModel = MODELS.includes(model) ? model : 'gpt-5.5';
        const refs = Array.isArray(references) ? references.filter(r => r && String(r.name || '').trim()) : [];
        const scene = await generateFlashloopScene(effectName, String(tagline || ''), String(idea || ''), Number(duration), String(ratio), selectedModel, refs, String(trendThumbnail || ''));
        return sendJson(res, 200, { ok: true, slug, name: effectName, duration, ratio, model: selectedModel, ...scene });
      } catch (e) { logLine('flashloop prompt: ' + e.message); return sendJson(res, 500, { error: e.message }); }
    }

    // Generate i2i image anchored to a trend reference image
    if (p === '/api/flashloop/generate-i2i' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const { prompt = '', refImageUrl = '', ratio = '9:16', model = 'seedream-5', trendName = '', tagline = '' } = body || {};
        if (!prompt) return sendJson(res, 400, { error: 'prompt required' });
        if (!refImageUrl) return sendJson(res, 400, { error: 'refImageUrl required (trend reference image)' });

        const selectedModel = IMAGE_MODELS.includes(model) ? model : 'seedream-5';
        const endpoint = img2ImgEndpoint(selectedModel);

        // Proxy external images (e.g. SJinn thumbnails from edit.comfyonline.app) through
        // a public temp host so PaxSenix can fetch them server-side.
        let finalImageUrl = refImageUrl;
        try {
          const imgRes = await fetch(refImageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
          if (imgRes.ok) {
            const imgBuf = Buffer.from(await imgRes.arrayBuffer());
            if (imgBuf.length > 1000) {
              const { FormData, File } = await import('undici').catch(() => ({ FormData: globalThis.FormData, File: globalThis.File }));
              const fd = new FormData();
              fd.append('file', new File([imgBuf], 'ref.jpg', { type: 'image/jpeg' }));
              const uploadRes = await fetch('https://tmpfiles.org/api/v1/upload', { method: 'POST', body: fd, signal: AbortSignal.timeout(30000) });
              const uj = await uploadRes.json().catch(() => ({}));
              if (uj.data && uj.data.url) {
                finalImageUrl = uj.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
                logLine(`flashloop i2i: proxied ref image to ${finalImageUrl.slice(0, 80)}`);
              }
            }
          }
        } catch (proxyErr) { logLine(`flashloop i2i: image proxy failed (${proxyErr.message}), using original URL`); }

        // Build a style-anchored prompt so the i2i model matches the trend reference image
        // instead of just generating the scene described in the text literally.
        let stylePrefix = '';
        if (trendName) {
          stylePrefix = `MATCH THE REFERENCE IMAGE STYLE EXACTLY. The reference image shows the "${trendName}" trend${tagline ? ' — ' + tagline : ''}. Replicate its exact visual style: color palette, lighting, texture, rendering technique, materials, mood, and aesthetic. `;
        }
        const anchoredPrompt = stylePrefix + prompt;
        const sanitized = sanitizePrompt(anchoredPrompt);
        const postBody = JSON.stringify({ prompt: sanitized, model: selectedModel, ratio: String(ratio), image_urls: [finalImageUrl] });
        logLine(`flashloop i2i: submitting ${selectedModel}${trendName ? ' for "' + trendName + '"' : ''} with ref ${finalImageUrl.slice(0, 80)}…`);

        let taskUrl = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const res2 = await paxFetch(`${API}${endpoint}`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: postBody
            }, 120000);
            const j2 = await res2.json().catch(() => ({}));
            if (res2.ok && j2.ok && j2.task_url) { taskUrl = j2.task_url; break; }
            logLine(`flashloop i2i ${selectedModel} attempt ${attempt}: HTTP ${res2.status} ${JSON.stringify(j2).slice(0, 120)}`);
          } catch (e2) { logLine(`flashloop i2i ${selectedModel} attempt ${attempt}: ${e2.message}`); }
          await new Promise(r => setTimeout(r, 3000 * attempt));
        }

        if (!taskUrl) return sendJson(res, 500, { error: `Failed to submit i2i task with ${selectedModel} after 3 attempts` });
        return sendJson(res, 200, { ok: true, taskUrl, model: selectedModel });
      } catch (e) { logLine('flashloop i2i: ' + e.message); return sendJson(res, 500, { error: e.message }); }
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
          execFile('python3', ['-c', script], { timeout: 25000 }, (err, stdout, stderr) => {
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
          execFile('python3', ['-m', 'yt_dlp',
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
            execFile('python3', ['-m', 'yt_dlp',
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

    // Generate img2img + img2video prompts for an AI influencer activity (random if none given)
    if (p === '/api/influencer/generate-prompt' && req.method === 'POST') {
      const body = await readBody(req);
      const { id, activity = '', idea = '', ratio = '1:1', model = 'gemini-2.5-pro' } = body || {};
      if (!id) return sendJson(res, 400, { error: 'influencer id required' });

      const randomActivities = [
        'morning skincare routine in bathroom mirror — applying moisturizer and serum, natural window light, messy bun hair, cozy robe',
        'poolside selfie at luxury resort — lying on pool lounger, sunglasses, summer vibes, turquoise water background',
        'GRWM makeup routine — sitting at vanity mirror, applying foundation and lip gloss, ring light glow',
        'coffee shop laptop session — sitting by window with iced latte, typing on MacBook, cozy cafe interior',
        'gym mirror selfie after workout — sweaty post-exercise glow, sports bra and leggings, gym equipment background',
        'cooking pasta in kitchen — stirring pot, tasting sauce, casual home clothes, warm kitchen lighting',
        'outfit of the day full body mirror — standing in bedroom, showing full outfit, natural daylight from window',
        'beach sunset walk — walking along shoreline, barefoot on sand, golden hour backlight, summer dress',
        'car singing selfie — driving with window down, singing to camera, golden hour sunlight through windshield',
        'reading on cozy couch — curled up with book, blanket, rainy window, warm lamp light, hot tea',
        'travel airport selfie — pulling suitcase, terminal background, excited expression, travel outfit',
        'night skincare routine — face mask on, bathroom counter, candles lit, cozy pajamas, self-care energy',
        'grocery store haul reaction — unpacking bags on kitchen counter, excited face showing products',
        'study with me desk setup — notebooks open, coffee cup, desk lamp, focused concentration face',
        'dancing in bedroom — moving to music, phone propped on desk, fun energy, casual clothes',
        'smoothie making tutorial — blending fruits, kitchen counter, pouring into glass, healthy lifestyle',
        'trying on thrift finds — bedroom mirror, holding up vintage clothes, excited reaction faces',
        'plant watering morning — tending to indoor plants, apartment window, natural sunlight, peaceful vibes',
        'getting ready for date night — doing hair in mirror, applying perfume, jewelry, excited energy',
        'sunset balcony moment — sitting on apartment balcony, golden hour, city skyline, peaceful expression',
        'flat lay product organizing — top-down view on bed, arranging skincare or makeup products aesthetically',
        'pet cuddle time — sitting on couch with dog or cat, cozy living room, genuine smile',
        'rainy day window aesthetic — watching rain, holding hot chocolate, blanket wrapped, cozy indoor vibes',
        'after gym protein shake — gym bathroom mirror selfie, proud post-workout energy, water bottle',
        'breakfast making morning — scrambling eggs or making pancakes, kitchen morning sunlight, casual clothes',
        'bookstore browsing — walking between shelves, picking up books, cozy aesthetic, tote bag',
        'flower market shopping — carrying bouquet, exploring stalls, natural daylight, happy expression',
        'packing for vacation — bed covered with clothes, open suitcase, deciding outfits, excited energy',
        'late night fridge raid — kitchen at midnight, fridge light illuminating face, guilty pleasure snack',
        'yoga stretching on mat — living room floor, morning sunlight through window, peaceful mindfulness',
        'hair styling tutorial — bathroom mirror, blow drying or curling, before and after energy',
        'car trunk grocery unload — carrying bags, driveway, casual errand run outfit',
        'selfie with morning coffee — holding mug, kitchen counter, just woke up look, natural light',
        'mirror outfit check — turning to check back of outfit, hallway mirror, confident energy',
        'applying sunscreen at beach — pool or beach, summer vibes, casual swimwear, vacation mood',
        'desk snack break — eating chips or fruit at desk, laptop in background, casual work-from-home',
        'walking dog neighborhood — sidewalk, autumn leaves or sunny day, casual athleisure, leash in hand',
        'trying viral recipe — following phone tutorial in kitchen, reaction to taste, authentic excitement',
        'nail painting close-up — focused expression, nail polish, desk with products, detail shot',
        'sunset rooftop moment — standing on rooftop, city skyline, wind in hair, golden hour glow'
      ];

      let actInput = (activity || idea || '').trim();
      if (!actInput) {
        actInput = randomActivities[Math.floor(Math.random() * randomActivities.length)];
        inflLogLine('random activity picked: ' + actInput.slice(0, 60));
      }

      try {
        const infl = await findInfluencer(id);
        if (!infl) return sendJson(res, 404, { error: 'influencer not found' });

        const charDesc = infl.description || '';
        const charName = infl.name || 'the person';
        const wardrobe = infl.defaultWardrobe || '';
        const vibe = infl.vibe || '';
        const hasUploadedRef = (infl.refs || []).some(r => r && r.path && r.uploaded);
        // If the user uploaded a real reference photo, the image IS the identity.
        // Do NOT inject a text character description — it overrides the reference image.
        const profileBlock = hasUploadedRef
          ? `Name: ${charName}\nNOTE: A real reference photo of ${charName} is supplied. The prompt must ONLY describe the scene, pose, camera, lighting and outfit. NEVER describe the face, hair, skin tone or body proportions in text.`
          : `Name: ${charName}${charDesc ? '\nDescription:\n' + charDesc : ''}${wardrobe ? '\nDefault Wardrobe: ' + wardrobe : ''}${vibe ? '\nVibe: ' + vibe : ''}`;

        // ---- STEP 1: Generate IMAGE prompt (first frame) ----
        inflLogLine('generating image prompt for: ' + actInput.slice(0, 50));
        const identityBlock = hasUploadedRef
          ? `Identity Consistency:\nA real reference photo of the influencer is supplied. Preserve the EXACT face, hair, skin tone and identity from that reference image. Do not describe or change facial features in the prompt text. Do not beautify or stylize.\n`
          : `Identity Consistency:\nUse the provided reference image as the exact identity reference. Preserve exact facial features, hairstyle, skin tone, body proportions, and overall appearance. Do not beautify or stylize the face.\n`;
        const imgSystem = `You are an expert prompt engineer for AI influencer content. Write one detailed first-frame image prompt for img2img generation.

THE PERSON IS THE MAIN SUBJECT. The prompt must describe a REAL PERSON (the influencer) doing the activity. This is a selfie or phone recording OF the person — NOT a still life or object shot. The person MUST be visible in the frame.

CHARACTER PROFILE:
${profileBlock}

ACTIVITY: ${actInput}
ASPECT RATIO: ${ratio}

Write the prompt using EXACTLY this structure:

${identityBlock}
Scene:
[Where is the person? What environment are they in? What's visible behind them?]

Pose:
[What is the person DOING? Their exact body position. What are they holding? How are they sitting/standing? Be very specific about their physical action.]

Expression:
[What facial expression do they have? Smile, focused, relaxed, excited, laughing?]

Camera:
[Is this a selfie front-camera shot? Mirror selfie? Phone propped up? Describe the camera angle relative to the person.]

Lighting:
[What kind of light hits the person? Natural sunlight, indoor warm light, golden hour? How do shadows fall on their face/body?]

Hair:
[How does their hair look? Natural, loose, tied up, wind-blown?]

Outfit:
[What are they wearing? Describe the clothing style — casual, athleisure, dress, etc. Keep it general, no brands.]

Environment:
[What's in the background? Furniture, nature, architecture? Secondary to the person.]

Photography:
Smartphone photo quality. Ultra-realistic. Natural skin texture. Visible pores. No beauty filter. No CGI. No AI look. Shot on iPhone front camera.

Negative Prompt:
cartoon, CGI, painting, anime, overprocessed skin, beauty filter, doll face, plastic skin, extra fingers, deformed hands, warped anatomy, low quality, blurry, watermark, text, logo, unrealistic lighting, still life, no people, empty scene, object-only shot`;

        let imgPrompt = '';
        const selectedModel = MODELS.includes(model) ? model : 'gemini-2.5-pro';
        for (const m of [selectedModel, 'gemini-2.5-pro', 'gemini-3.1-pro']) {
          try {
            const raw = await chatCompletion(m, [{ role: 'user', content: imgSystem }], 12000);
            imgPrompt = raw.trim();
            if (imgPrompt.length > 50) break;
          } catch (e) { inflLogLine('img prompt gen ' + m + ' failed: ' + e.message); }
        }

        if (!imgPrompt) {
          imgPrompt = `Use the provided reference image as the exact identity reference. Preserve exact facial features, hairstyle, skin tone, body proportions.\n\nScene:\n${actInput} — the person is the main subject, visible in frame.\n\nPose:\nThe person is performing the activity in a natural candid moment, holding phone in selfie mode.\n\nExpression:\nRelaxed, genuine, natural smile.\n\nCamera:\nReal iPhone front-camera perspective. Close-up selfie framing from chest upward. Slight handheld angle.\n\nLighting:\nNatural lighting. Warm realistic skin highlights. Soft shadows.\n\nOutfit:\nCasual everyday clothing appropriate for the activity.\n\nPhotography:\nSmartphone photo quality. Ultra-realistic. Natural skin texture. No beauty filter. No CGI. No AI look.\n\nNegative Prompt:\ncartoon, CGI, painting, anime, beauty filter, doll face, plastic skin, extra fingers, deformed hands, warped anatomy, low quality, blurry, still life, no people`;
        }

        // ---- STEP 2: Generate VIDEO prompt (second-by-second timeline) ----
        inflLogLine('generating video prompt...');
        const vidSystem = `You are an expert prompt engineer for AI influencer content. Write one detailed img2video prompt with a second-by-second action timeline.

THE PERSON IS THE MAIN SUBJECT. The video must show a REAL PERSON (the influencer) doing the activity. This is a phone video OF the person — NOT a scenery or object video. The person MUST be visible and active throughout.

CHARACTER PROFILE:
${profileBlock}

ACTIVITY: ${actInput}
ASPECT RATIO: ${ratio}
DURATION: 5-6 seconds

FIRST FRAME CONTEXT:
${imgPrompt.slice(0, 600)}

Write the prompt using EXACTLY this structure:

Use the provided reference image as the exact identity reference.
Maintain identical facial features, hairstyle, skin tone, body proportions, and appearance throughout. Do not change identity.

Duration:
5-6 seconds

Style:
Ultra-photorealistic lifestyle influencer vlog. ${ratio}. 4K.

Scene:
[What is the person doing? Full description of their activity. They are the main focus.]

Action Sequence:

00:00-00:01
[What is the person doing RIGHT NOW? Body position, expression, action, what they say/do.]

00:01-00:02
[What movement do they make? A gesture, glance, shift. Be very specific about body mechanics.]

00:02-00:03
[Next action. Real people blink, breathe, shift weight. Describe it.]

00:03-00:04
[Continuation of activity. Any natural gesture — tucking hair, adjusting position, speaking.]

00:04-00:05
[Activity continues. Expression change? Reaction?]

00:05-00:06
[Final moment — natural conclusion. Smile, look away, stop recording, put something down.]

Facial Animation:
[Lip movement if speaking, blinking pattern, micro-expressions, cheek movement, eyebrow motion.]

Camera Motion:
Handheld iPhone selfie. Tiny wrist corrections. Natural breathing movement. Small vertical bobbing. No robotic stabilization.

Hair Physics:
[How does hair move naturally? Breeze? When they move their head?]

Body Motion:
Natural breathing. Shoulder movement. Arm movement. Small posture adjustments. Realistic finger movement.

Lighting:
[Consistent lighting on the person. Realistic highlights on skin.]

Environment:
[Same environment as first frame. Background visible but secondary to person.]

Quality:
Looks like authentic Instagram Story footage shot on an iPhone by a real lifestyle influencer.

Negative Prompt:
AI motion, robotic movement, jitter, morphing face, frozen smile, bad lip-sync, extra fingers, deformed hands, flickering, warped anatomy, unrealistic physics, low quality, beauty filter, CGI appearance, still life, no people, object-only shot, empty scene`;

        let vidPrompt = '';
        for (const m of [selectedModel, 'gemini-2.5-pro', 'gemini-3.1-pro']) {
          try {
            const raw = await chatCompletion(m, [{ role: 'user', content: vidSystem }], 16000);
            vidPrompt = raw.trim();
            if (vidPrompt.length > 50) break;
          } catch (e) { inflLogLine('vid prompt gen ' + m + ' failed: ' + e.message); }
        }

        if (!vidPrompt) {
          vidPrompt = `Use the provided reference image as the exact identity reference. Maintain identical identity throughout.\n\nDuration: 5-6 seconds\nStyle: Ultra-photorealistic lifestyle influencer vlog. ${ratio}.\n\nScene:\n${actInput} — captured casually on phone.\n\n00:00-00:01: Person is at the start of the activity, natural relaxed position, looking at camera, begins speaking naturally.\n00:01-00:02: Begins the activity, slight movement, natural expression change, blinks once.\n00:02-00:03: Mid-action, body shifting naturally, genuine expression, hair moves slightly.\n00:03-00:04: Continuing activity, small gesture like tucking hair or adjusting position.\n00:04-00:05: Activity peak moment, authentic reaction, slight smile.\n00:05-00:06: Final moment, natural laugh or look away, reaching to stop recording.\n\nCamera: Handheld iPhone selfie. Tiny wrist corrections. Natural breathing movement.\nHair: Natural movement from breeze or motion.\nBody: Natural breathing. Shoulder movement. Small posture adjustments.\n\nQuality: Looks like authentic Instagram Story footage.\n\nNegative Prompt: AI motion, robotic movement, jitter, morphing face, frozen smile, bad lip-sync, extra fingers, deformed hands, flickering, warped anatomy, low quality, beauty filter, CGI appearance`;
        }

        // Enforce mandatory blocks if LLM skipped them
        const mandatoryBlock = `\n\nVISUAL STYLE:\nNatural smartphone video quality. Slight realistic handheld shake. Smooth normal frame-rate motion. Authentic casual interactions and physics. Realistic sunlight and exposure adaptation. Stable main character consistency. Unpolished home phone recording aesthetics. No professional stabilization. No cinematic color grading. No beauty filters. No artificial effects. No AI artifacts or glitches.\n\nIMPORTANT GENERATION REQUIREMENTS:\nConsistent identity throughout the video. Realistic human anatomy and hand interactions. Natural walking and body movement. Physically correct lighting and shadows. No duplicated people or objects. No facial distortions. No impossible movements. Preserve the casual smartphone home-video feeling from beginning to end. Photorealistic. Indistinguishable from a genuine smartphone selfie video recorded by a real lifestyle influencer.`;

        if (imgPrompt && !imgPrompt.includes('VISUAL STYLE')) imgPrompt += mandatoryBlock;
        if (vidPrompt && !vidPrompt.includes('VISUAL STYLE')) vidPrompt += mandatoryBlock;

        inflLogLine('prompts generated OK — img: ' + imgPrompt.length + ' chars, vid: ' + vidPrompt.length + ' chars');
        return sendJson(res, 200, { ok: true, imgPrompt, vidPrompt, activity: actInput });
      } catch (e) { inflLogLine('influencer generate-prompt: ' + e.message); return sendJson(res, 500, { error: e.message }); }
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

VISUAL STYLE (MANDATORY - include this ENTIRE section VERBATIM in BOTH prompts):
Natural smartphone video quality. Slight realistic handheld shake. Smooth normal frame-rate motion. Authentic casual interactions and physics. Realistic sunlight and exposure adaptation. Stable main character consistency. Unpolished home phone recording aesthetics. No professional stabilization. No cinematic color grading. No beauty filters. No artificial effects. No AI artifacts or glitches.

IMPORTANT GENERATION REQUIREMENTS (MANDATORY - include this ENTIRE section VERBATIM in BOTH prompts):
Consistent identity throughout the video. Realistic human anatomy and hand interactions. Natural walking and body movement. Physically correct lighting and shadows. Rapid memory-style jump cuts every 1-2 seconds. No duplicated people or objects. No facial distortions. No impossible movements. Preserve the casual smartphone home-video feeling from beginning to end. Photorealistic. Indistinguishable from a genuine smartphone selfie video recorded by a real lifestyle influencer.

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

        // Enforce mandatory VISUAL STYLE + GENERATION REQUIREMENTS blocks in both prompts
        const mandatoryBlock = `\n\nVISUAL STYLE:\nNatural smartphone video quality. Slight realistic handheld shake. Smooth normal frame-rate motion. Authentic casual interactions and physics. Realistic sunlight and exposure adaptation. Stable main character consistency. Unpolished home phone recording aesthetics. No professional stabilization. No cinematic color grading. No beauty filters. No artificial effects. No AI artifacts or glitches.\n\nIMPORTANT GENERATION REQUIREMENTS:\nConsistent identity throughout the video. Realistic human anatomy and hand interactions. Natural walking and body movement. Physically correct lighting and shadows. Rapid memory-style jump cuts every 1-2 seconds. No duplicated people or objects. No facial distortions. No impossible movements. Preserve the casual smartphone home-video feeling from beginning to end. Photorealistic. Indistinguishable from a genuine smartphone selfie video recorded by a real lifestyle influencer.`;

        if (imgPrompt && !imgPrompt.includes('VISUAL STYLE')) imgPrompt += mandatoryBlock;
        if (vidPrompt && !vidPrompt.includes('VISUAL STYLE')) vidPrompt += mandatoryBlock;

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

      if (IS_VERCEL) {
        inflSetPhase('trend-create', 3);
        return runJobOnVercel(res, async () => {
          try {
            if (!infl.description) {
              const profile = { name: infl.name, age: infl.age, gender: infl.gender, ethnicity: infl.ethnicity, hair: infl.hair, eyes: infl.eyes, bodyType: infl.bodyType, defaultWardrobe: infl.defaultWardrobe, signatureTrait: infl.signatureTrait, vibe: infl.vibe };
              let model = 'gemini-3.1-pro'; let desc = '';
              for (let i = 0; i < 3; i++) { try { desc = await expandInfluencerDescription(profile, model); if (desc && desc.length > 100) break; } catch { model = nextModel(model); } }
              if (!desc) throw new Error('could not generate locked influencer description');
              infl.description = desc; await saveInfluencer(infl);
            }
            if (!trendCaption && !trendCover) {
              if (TAVILY_API_KEY) { try { const terms = await tavilyTrendTerms('TikTok trending', 20); if (terms.length) trendCaption = terms[Math.floor(Math.random() * terms.length)]; } catch {} }
              if (!trendCaption) throw new Error('could not fetch a fresh live trend');
              trendPlatform = 'tiktok';
            }
            const analyzePrompt = `Create a matching scene for an AI influencer. Platform: ${trendPlatform}. Caption: "${trendCaption}". Return ONLY JSON: {"scene_prompt":"60-120 words photorealistic scene","animation_prompt":"one sentence motion","caption":"Instagram caption"}. CHARACTER:\n${infl.description}`;
            const sceneMsgs = [{ role: 'system', content: analyzePrompt }, { role: 'user', content: 'Return ONLY the JSON.' }];
            let sceneContent = '', sceneModel = 'gemini-3.1-pro';
            for (let attempt = 0; attempt < 3; attempt++) { try { sceneContent = await chatCompletion(sceneModel, sceneMsgs, 3000); if (sceneContent) break; } catch { sceneModel = nextModel(sceneModel); } }
            if (!sceneContent) throw new Error('LLM returned no scene');
            let scene; try { const s = sceneContent.indexOf('{'); const e = sceneContent.lastIndexOf('}'); scene = JSON.parse(sceneContent.slice(s, e + 1)); } catch { throw new Error('failed to parse scene JSON'); }
            let cid = null;
            const resolvedRefUrl = await resolveInfluencerRefUrl(infl);
            if (resolvedRefUrl) { cid = await generateInfluencerContentImg2Img(infl, resolvedRefUrl, scene.scene_prompt, style, ratio, imageModel); }
            if (!cid) { cid = await generateInfluencerContent(infl, scene.scene_prompt, style, ratio, imageModel); }
            if (!cid) throw new Error('image generation failed');
            const animItem = infl.content.find(c => c.id === cid);
            if (animItem) { animItem.animation_prompt = scene.animation_prompt; if (scene.caption) animItem.caption = scene.caption; await saveInfluencer(infl); }
            await generateInfluencerVideo(infl, cid, ratio, 6);
            inflJob.done = 3; inflJob.ok = 3;
          } catch (e) { inflLogLine(`trend generation FAILED: ${e.message}`); throw e; }
          inflJob.phase = 'idle';
        });
      }

      inflSetPhase('trend-create', 3);
      (async () => {
        try {
                    // Nothing selected: pick a FRESH live Tavily term (no hardcoded list)
          if (!trendCaption && !trendCover) {
            inflLogLine('no trend selected — fetching live Tavily trends...');
            let liveTerm = '';
            if (TAVILY_API_KEY) {
              try {
                const terms = await tavilyTrendTerms('TikTok trending', 20);
                if (terms.length) liveTerm = terms[Math.floor(Math.random() * terms.length)];
              } catch (e) { inflLogLine('Tavily live pick failed: ' + e.message); }
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

    if (p === '/api/proxy-image') {
      const imgUrl = u.searchParams.get('url');
      if (!imgUrl) return sendJson(res, 400, { error: 'missing url param' });
      try {
        const imgRes = await fetch(imgUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
        if (!imgRes.ok) return sendJson(res, 502, { error: 'upstream ' + imgRes.status });
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const ct = imgRes.headers.get('content-type') || 'image/jpeg';
        res.writeHead(200, { 'Content-Type': ct, 'Content-Disposition': 'attachment; filename="reference.jpg"', 'Cache-Control': 'public, max-age=86400' });
        return res.end(buf);
      } catch (e) { return sendJson(res, 502, { error: e.message }); }
    }

    // --- static files (supports subdirectories for influencer assets) ---
    let filePath;
    if (p.startsWith('/frames/')) filePath = path.join(FRAMES_DIR, decodeURIComponent(p.slice('/frames/'.length)));
    else if (p.startsWith('/video/')) filePath = path.join(VIDEO_DIR, decodeURIComponent(p.slice('/video/'.length)));
    else if (p === '/') filePath = path.join(PUBLIC, 'index.html');
    else if (p === '/influencer') filePath = path.join(PUBLIC, 'influencer.html');
    else if (p === '/trends') filePath = path.join(PUBLIC, 'trends.html');
    else if (p === '/flashloop-studio' || /^\/effects\/[^/]+$/.test(p)) filePath = path.join(PUBLIC, 'flashloop-studio.html');
    else filePath = path.join(PUBLIC, path.normalize(p).replace(/^([/\\])+/, ''));

    if (!filePath.startsWith(FRAMES_DIR) && !filePath.startsWith(VIDEO_DIR) && !filePath.startsWith(PUBLIC)) {
      res.writeHead(403); return res.end('forbidden');
    }
    const data = await fsp.readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch (e) {
    if (p && p.startsWith('/api/')) return sendJson(res, 500, { error: String(e.message || e) });
    if (e.code === 'ENOENT') { res.writeHead(404); res.end('not found'); }
    else { res.writeHead(500); res.end(String(e.message || e)); }
  }
};

module.exports = requestHandler;

if (!IS_VERCEL) {
  const server = http.createServer(requestHandler);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n❌ Port ${PORT} is already in use.`);
      console.error(`Run one of the following, then try again:`);
      console.error(`  1. Kill the process on port ${PORT}:  lsof -ti :${PORT} | xargs kill -9`);
      console.error(`  2. Start on a different port:          PORT=5174 node web/server.js\n`);
      process.exit(1);
    } else {
      console.error('\n❌ Server error:', err);
      process.exit(1);
    }
  });
  server.listen(PORT, () => {
    console.log(`Storyboard Studio → http://localhost:${PORT}`);
  });
}
