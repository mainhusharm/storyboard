// Trend templates — ground Flashloop/SJinn prompt generation in each trend's OWN
// example material instead of inventing a scene from the name alone.
//
// Why: prompts for those sections used to be written from just a trend NAME plus a
// scraped tagline, so the output was frequently irrelevant to the trend. Here we
// read the trend's real example material — Flashloop publishes example videos AND
// the actual prompts that produced them; SJinn publishes a demo video plus prose —
// and distil it into one template (concept, subject type, signature action, ordered
// beats, setting, style, must-include/avoid) that every generated prompt must follow.
//
// Everything here is best-effort: if a site changes layout, the caller still gets a
// curated/heuristic template rather than an error.
//
// The module is created with a factory so it can reuse the server's ffmpeg binary,
// logging, JSON parsing and LLM chain without duplicating them.
'use strict';

module.exports = function createTrendTemplates(deps) {
  const {
    fs, fsp, path, execFile, ffmpegBin, STORYBOARD_DIR,
    logLine = () => {}, chatText, isVercel = false, parseJsonLenient,
    extractTrendContent = () => null, resolveTrendConcept = () => '', kebabToTitle
  } = deps;

  const TREND_TEMPLATES_FILE = path.join(STORYBOARD_DIR, 'trend-templates.json');
  const TEMPLATE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // a week
  // Bump when the extraction/distillation changes so stale cache entries rebuild.
  const TEMPLATE_VERSION = 4; // v4: templates grounded in the example video (vision)
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  const MAX_VIDEO_BYTES = 40 * 1024 * 1024;

  const fetchText = async (url, ms = 20000) => {
    // Trend pages can rate-limit (429) or blip; retry before degrading the template.
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/json,*/*' }, signal: AbortSignal.timeout(ms) });
        if (res.ok) return await res.text();
        lastErr = new Error(`HTTP ${res.status}`);
        if (res.status !== 429 && res.status < 500) break;
      } catch (e) { lastErr = e; }
      await new Promise(r => setTimeout(r, 1200 * attempt));
    }
    throw lastErr || new Error('fetch failed');
  };

  // ---------- Flashloop flight payload ----------
  // React Server Components split the page payload across `self.__next_f.push([1,"…"])`
  // chunks, each escaped separately. Flashloop stores each example's REAL prompt in a
  // text row referenced as "$42" from trendContent — that is what makes the trend's
  // actual example prompts readable.
  function decodeFlightPayload(html) {
    const pushRe = /self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g;
    let m; let all = '';
    while ((m = pushRe.exec(html)) !== null) {
      try { all += JSON.parse('"' + m[1] + '"'); } catch { /* skip malformed chunk */ }
    }
    return all;
  }

  function parseFlightRows(flightText) {
    const rows = {};
    if (!flightText) return rows;
    const re = /(^|\n)([0-9a-f]+):T([0-9a-f]+),/g;
    let m;
    while ((m = re.exec(flightText)) !== null) {
      const id = m[2];
      const len = parseInt(m[3], 16);
      if (!isFinite(len) || len <= 0) continue;
      rows[id] = flightText.substr(re.lastIndex, len);
    }
    return rows;
  }

  function resolveFlightRef(value, rows) {
    const s = String(value == null ? '' : value).trim();
    const m = s.match(/^\$([0-9a-f]+)$/i);
    if (!m) return s.startsWith('$') ? '' : s;
    return (rows && rows[m[1]]) || '';
  }

  function normalizeTrendExamples(examples, rows) {
    return (Array.isArray(examples) ? examples : [])
      .map(e => ({
        videoUrl: String((e && (e.videoUrl || e.video_url)) || '').trim(),
        posterUrl: String((e && (e.posterUrl || e.poster)) || '').trim(),
        prompt: resolveFlightRef(e && e.prompt, rows).trim(),
        duration: Number(e && e.duration) || 0,
        aspectRatio: String((e && e.aspectRatio) || '')
      }))
      .filter(e => e.videoUrl || e.posterUrl || e.prompt);
  }

  // ---------- SJinn / generic detail extraction ----------
  function extractMediaUrls(html) {
    const out = new Set();
    const add = u => { if (u && /^https?:\/\//.test(u)) out.add(u.replace(/\\u0026/g, '&')); };
    let m;
    const patterns = [
      /"(?:videoUrl|video_url|video|mp4Url|url)"\s*:\s*"(https?:[^"]+?)"/g,
      /src="(https?:[^"]+?\.(?:mp4|webm|mov))"/g,
      /<video[^>]+src="([^"]+)"/g
    ];
    for (const re of patterns) while ((m = re.exec(html)) !== null) add(m[1]);
    return [...out].filter(u => /\.(mp4|webm|mov)(\?|$)/i.test(u) || /video/i.test(u));
  }

  function extractImageUrls(html) {
    const out = new Set();
    const add = u => { if (u && /^https?:\/\//.test(u)) out.add(u.replace(/\\u0026/g, '&')); };
    let m;
    const patterns = [
      /"(?:posterUrl|poster|thumbnail|image|cover|imageUrl|resultImage|result_image)"\s*:\s*"(https?:[^"]+?)"/g,
      /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/g,
      /src="(https?:[^"]+?\.(?:jpg|jpeg|png|webp))"/g
    ];
    for (const re of patterns) while ((m = re.exec(html)) !== null) add(m[1]);
    return [...out];
  }

  function extractProse(html) {
    const parts = [];
    let m;
    const stripTags = (t) => String(t || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ').trim();

    // 1) The page's own headings/paragraphs carry HOW the trend works (subject rules,
    //    what the prompts produce, what the video shows) — that is the real grounding.
    const blocks = [];
    for (const b of html.matchAll(/<(h1|h2|h3|h4|p|li)[^>]*>([\s\S]*?)<\/\1>/gi)) {
      const t = stripTags(b[2]);
      if (t.length > 40) blocks.push(t);
    }
    if (blocks.length) parts.push(blocks.slice(0, 40).join(' \u2022 '));

    // 2) Meta / structured descriptions.
    for (const re of [
      /<meta[^>]+name="description"[^>]+content="([^"]+)"/g,
      /<meta[^>]+property="og:description"[^>]+content="([^"]+)"/g,
      /"(?:description|summary|about|prose|prompt|instructions|details)"\s*:\s*"((?:[^"\\]|\\.)*)"/g
    ]) {
      while ((m = re.exec(html)) !== null) {
        let t = m[1];
        try { t = JSON.parse('"' + t + '"'); } catch { /* keep raw */ }
        t = stripTags(t);
        if (t.length > 40) parts.push(t);
      }
    }

    // 3) Last resort: the visible page text.
    if (!blocks.length) {
      const text = stripTags(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' '));
      if (text.length > 120) parts.push(text.slice(0, 4000));
    }
    return [...new Set(parts)].join(' \u2014 ').slice(0, 6000);
  }

  async function fetchFlashloopTrendDetail(slug) {
    if (!slug) return null;
    try {
      const html = await fetchText(`https://www.flashloop.app/effects/${encodeURIComponent(slug)}`);
      const rows = parseFlightRows(decodeFlightPayload(html));
      const content = extractTrendContent(decodeFlightPayload(html)) || {};
      const entry = content[slug] || (Object.values(content).find(v => v && Array.isArray(v.examples))) || {};
      const examples = normalizeTrendExamples(entry.examples, rows);
      return {
        slug,
        tagline: String(entry.tagline || ''),
        examples,
        media: examples.map(e => e.videoUrl).filter(Boolean),
        images: examples.map(e => e.posterUrl).filter(Boolean),
        prose: extractProse(html)
      };
    } catch (e) {
      logLine(`trend template: flashloop detail for "${slug}" unavailable (${e.message})`);
      return null;
    }
  }

  async function fetchSjinnTrendDetail(slug) {
    if (!slug) return null;
    try {
      const html = await fetchText(`https://sjinn.ai/trend-prompts/${encodeURIComponent(slug)}`);
      const media = extractMediaUrls(html);
      const images = extractImageUrls(html);
      const prose = extractProse(html);
      return { slug, media, images, prose, tagline: '' };
    } catch (e) {
      logLine(`trend template: sjinn detail for "${slug}" unavailable (${e.message})`);
      return null;
    }
  }

  // ---------- frame sampling (best effort; skipped on Vercel to protect the budget) ----------
  async function sampleTrendFrames(mediaList, opts = {}) {
    const maxFrames = Math.max(1, Math.min(6, Number(opts.maxFrames) || 3));
    const frames = [];
    const sources = [];
    if (isVercel) return { frames, sources };
    for (const item of (Array.isArray(mediaList) ? mediaList : []).slice(0, 2)) {
      if (!item || !item.url || frames.length >= maxFrames) break;
      const tempDir = path.join(STORYBOARD_DIR, `.trend_frame_${Date.now()}_${frames.length}`);
      try {
        await fsp.mkdir(tempDir, { recursive: true });
        if (item.kind === 'image') {
          const res = await fetch(item.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          const mime = buf[0] === 0x89 ? 'image/png' : (buf[0] === 0x52 ? 'image/webp' : 'image/jpeg');
          frames.push(`data:${mime};base64,${buf.toString('base64')}`);
          sources.push(`${item.label || 'reference image'}`);
        } else {
          const res = await fetch(item.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          // Flashloop publishes example videos as HLS playlists (.m3u8): ffmpeg must
          // read the stream by URL, not a downloaded playlist file.
          const isPlaylist = /\.m3u8(\?|$)/i.test(item.url) || buf.slice(0, 7).toString('latin1').startsWith('#EXTM3U');
          const want = Math.max(1, Math.min(3, maxFrames - frames.length));
          const outPattern = path.join(tempDir, 'f_%02d.jpg');
          const ffArgs = ['-y'];
          const videoPath = path.join(tempDir, 'source.mp4');
          let input = videoPath;
          if (isPlaylist) {
            input = item.url;
            ffArgs.push('-user_agent', UA);
          } else {
            if (buf.length > MAX_VIDEO_BYTES) throw new Error('video exceeds 40MB frame-sampling limit');
            await fsp.writeFile(videoPath, buf);
          }
          ffArgs.push('-i', input, '-vf', 'fps=1/3,scale=512:-2', '-frames:v', String(want), '-q:v', '5', outPattern);
          await new Promise((resolve, reject) => {
            execFile(ffmpegBin(), ffArgs, { timeout: 90000 }, err => err ? reject(err) : resolve());
          });
          const names = (await fsp.readdir(tempDir)).filter(n => /^f_\d+\.jpg$/i.test(n)).sort().slice(0, want);
          for (const n of names) {
            const img = await fsp.readFile(path.join(tempDir, n));
            frames.push(`data:image/jpeg;base64,${img.toString('base64')}`);
            sources.push(`${item.label || 'example video'} frame ${n}`);
          }
        }
      } catch (e) {
        logLine(`trend template: frame sampling failed (${e.message})`);
      } finally {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      }
    }
    return { frames, sources };
  }

  // Ask the vision model what the trend OWN example video actually shows. This is
  // the strongest grounding for SJinn (which publishes no example prompts): it turns
  // the sampled frames into concrete subject / action / setting / style facts.
  async function describeExampleFrames(frames, opts) {
    const o = opts || {};
    if (!Array.isArray(frames) || !frames.length) return "";
    const prompt = "These frames are sampled from the \"" + o.name + "\" trend's OWN example video"
      + (o.tagline ? " (" + o.tagline + ")" : "") + ".\n"
      + "Describe factually what this trend's video shows, so a different clip could be produced that sits next to it and looks like the same trend. Cover:\n"
      + "- the exact subject(s) and what they are made of\n"
      + "- the setting/background and any props\n"
      + "- the action, and its ORDER across the frames (first, next, last)\n"
      + "- camera framing and movement, lighting and colour palette\n"
      + "- any on-screen text, captions or logos\n"
      + "- the overall look (live action, 3D render, anime, macro, etc.)\n"
      + "Also state what this trend is NOT - what would make a clip look off-trend.\n"
      + "Return plain prose, 120-220 words, no markdown.";
    try {
      const content = [{ type: "text", text: prompt }].concat(frames.slice(0, 3).map(function (f) { return { type: "image_url", image_url: { url: f } }; }));
      const out = await chatText([{ role: "user", content: content }], 8000, 0.4);
      const txt = String(out || "").trim().slice(0, 2200);
      if (txt) logLine("trend template \"" + o.name + "\": example video described from " + Math.min(frames.length, 3) + " frame(s)");
      return txt;
    } catch (e) {
      logLine("trend template \"" + o.name + "\": example-video vision failed (" + e.message + ")");
      return "";
    }
  }

  // ---------- store ----------
  function loadTrendTemplateStore() {
    try { return JSON.parse(fs.readFileSync(TREND_TEMPLATES_FILE, 'utf8')) || {}; } catch { return {}; }
  }
  function saveTrendTemplateStore(store) {
    try {
      fs.mkdirSync(STORYBOARD_DIR, { recursive: true });
      fs.writeFileSync(TREND_TEMPLATES_FILE, JSON.stringify(store, null, 1));
    } catch (e) { logLine('trend template store save failed: ' + e.message); }
  }

  // ---------- template parsing / validation ----------
  function parseTrendTemplateJson(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    let j = null;
    try { j = parseJsonLenient(text); } catch { j = null; }
    if (!j) {
      const s = text.indexOf('{'); const e = text.lastIndexOf('}');
      if (s >= 0 && e > s) { try { j = parseJsonLenient(text.slice(s, e + 1)); } catch { j = null; } }
    }
    return j && typeof j === 'object' ? j : null;
  }

  function normalizeTrendTemplate(j, { source, slug, name }) {
    if (!j || typeof j !== 'object') return null;
    const arr = v => (Array.isArray(v) ? v : (typeof v === 'string' && v.trim() ? [v.trim()] : []))
      .map(x => String(x).trim()).filter(Boolean).slice(0, 8);
    const t = {
      source, slug, name,
      concept: String(j.concept || j.what || j.summary || '').trim().slice(0, 400),
      subjectType: String(j.subjectType || j.subject || '').trim().slice(0, 200),
      signatureAction: String(j.signatureAction || j.action || j.signature || '').trim().slice(0, 300),
      beats: arr(j.beats || j.beatStructure || j.structure),
      setting: String(j.setting || '').trim().slice(0, 200),
      style: String(j.style || j.look || '').trim().slice(0, 300),
      dialogue: String(j.dialogue || j.audio || '').trim().slice(0, 200),
      mustInclude: arr(j.mustInclude || j.must_include || j.include),
      avoid: arr(j.avoid || j.never || j.exclude)
    };
    return okTrendTemplate(t) ? t : null;
  }

  // A template is usable when it explains the trend and gives an ordered action.
  function okTrendTemplate(t) {
    if (!t || typeof t !== 'object') return false;
    return !!(t.concept && t.concept.length > 24) && !!(t.signatureAction && t.signatureAction.length > 12) && Array.isArray(t.beats) && t.beats.length >= 2;
  }

  // Curated fallback: still trend-shaped, built from the name/tagline/curated concept
  // and any prose we could read, so the caller never gets nothing.
  function heuristicTrendTemplate({ source, slug, name, tagline, prose, examplePrompts, concept }) {
    const curated = (concept || resolveTrendConcept(slug, name, '') || '').trim();
    const proseText = String(prose || '').replace(/\s+/g, ' ').trim();
    const promptText = (Array.isArray(examplePrompts) ? examplePrompts : []).join(' | ').replace(/\s+/g, ' ').trim();
    const base = curated || proseText.split(/(?<=\.)\s/)[0] || `${name}${tagline ? ' — ' + tagline : ''}`;
    const sentences = (proseText.match(/[^.!?]+[.!?]/g) || []).map(s => s.trim()).filter(s => s.length > 30);
    const beats = (sentences.length >= 2 ? sentences.slice(0, 4) : [
      `Open on the signature ${name} moment — instantly recognisable from the trend's own examples.`,
      'The core action of the trend plays out in one clear, continuous beat.',
      'Escalate with the trend\u2019s most distinctive visual flourish.',
      'Resolve on a satisfying final frame that still reads as this trend.'
    ]).map(b => b.slice(0, 200));
    return {
      source, slug, name,
      concept: (base + (promptText ? ' Observed in the trend\u2019s own examples: ' + promptText.slice(0, 200) : '')).slice(0, 400),
      subjectType: name,
      signatureAction: sentences[0] ? sentences[0].slice(0, 300) : `The defining action of the ${name} trend, exactly as its example videos show it.`,
      beats,
      setting: '',
      style: 'Match the visual style, colour palette, lighting and framing of this trend\u2019s own example videos.',
      dialogue: '',
      mustInclude: [],
      avoid: []
    };
  }

  // ---------- build ----------
  async function buildTrendTemplate({ source, slug, name, tagline = '', thumbnail = '', refresh = false, concept = '' } = {}) {
    const src = String(source || 'flashloop').toLowerCase();
    const key = `${src}:${slug || name}`;
    const store = loadTrendTemplateStore();
    const cached = store[key];
    if (!refresh && cached && cached.template && cached.ver === TEMPLATE_VERSION && Date.now() - (cached.builtAt || 0) < TEMPLATE_TTL_MS) {
      return { ...cached.template, meta: { ...(cached.meta || {}), fromCache: true } };
    }

    let examples = [];
    let media = [];
    let images = [];
    let prose = '';
    let detailTagline = '';

    if (src === 'flashloop') {
      // The listing already carries examples (video + the real prompt).
      try {
        const formats = typeof deps.scrapeFlashloop === 'function' ? await deps.scrapeFlashloop() : [];
        const fmt = (formats || []).find(f => f.slug === slug) || (formats || []).find(f => f.name && name && f.name.toLowerCase() === String(name).toLowerCase());
        if (fmt && Array.isArray(fmt.examples)) examples = fmt.examples;
        if (fmt && fmt.tagline) detailTagline = fmt.tagline;
        if (fmt && fmt.thumbnail) images.push(fmt.thumbnail);
      } catch (e) { logLine('trend template: flashloop listing unavailable (' + e.message + ')'); }
      const detail = await fetchFlashloopTrendDetail(slug);
      if (detail) {
        if (detail.examples && detail.examples.length > examples.length) examples = detail.examples;
        if (detail.tagline) detailTagline = detailTagline || detail.tagline;
        media = [...media, ...(detail.media || [])];
        images = [...images, ...(detail.images || [])];
        prose = prose || detail.prose || '';
      }
    } else {
      const detail = await fetchSjinnTrendDetail(slug);
      if (detail) {
        media = [...media, ...(detail.media || [])];
        images = [...images, ...(detail.images || [])];
        prose = detail.prose || '';
      }
      // SJinn does not publish the generating prompt; the demo video + prose are the material.
      try {
        const formats = typeof deps.scrapeSjinn === 'function' ? await deps.scrapeSjinn() : [];
        const fmt = (formats || []).find(f => f.slug === slug);
        if (fmt && fmt.thumbnail) images.push(fmt.thumbnail);
        if (fmt && fmt.tagline) detailTagline = fmt.tagline;
      } catch { /* optional */ }
    }

    const examplePrompts = [...new Set(examples.map(e => e.prompt).filter(Boolean))].slice(0, 10);
    const videoUrls = [...new Set([...examples.map(e => e.videoUrl).filter(Boolean), ...media])].slice(0, 3);
    const imageUrls = [...new Set([...images.filter(Boolean), ...(thumbnail ? [thumbnail] : [])])].slice(0, 4);

    const sampled = await sampleTrendFrames([
      ...videoUrls.map((u, i) => ({ kind: 'video', url: u, label: `${name} example video ${i + 1}` })),
      ...imageUrls.map((u, i) => ({ kind: 'image', url: u, label: `${name} reference image ${i + 1}` }))
    ], { maxFrames: 3 });

    const videoDescription = await describeExampleFrames(sampled.frames, { name: name, tagline: tagline || detailTagline });
    if (videoDescription) logLine('trend template: example-video description grounded the template');
    const grounded = !!(videoUrls.length || sampled.frames.length || examplePrompts.length || prose || videoDescription);
    let template = null;

    // Distil from the trend's own material (text-only: works with the Logfare chain).
    if (examplePrompts.length || prose || sampled.frames.length || videoDescription) {
      const evidence = [
        videoDescription ? ("WHAT THE TREND'S OWN EXAMPLE VIDEO ACTUALLY SHOWS (authoritative - every field must match this):\n" + videoDescription) : "",
        examplePrompts.length ? `REAL PROMPTS THAT PRODUCED THIS TREND'S EXAMPLE VIDEOS:\n- ` + examplePrompts.map(p => p.slice(0, 700)).join('\n- ') : '',
        prose ? `PAGE / TREND DESCRIPTION:\n${prose.slice(0, 2000)}` : '',
        videoUrls.length ? `EXAMPLE MEDIA: ${videoUrls.length} video(s)${sampled.frames.length ? `, ${sampled.frames.length} frame(s) sampled` : ''}` : ''
      ].filter(Boolean).join('\n\n');
      const system = `You are a viral short-form video trend analyst. You are given a real trend's OWN material (the prompts that generated its example videos, the page description, and how many example videos exist). Distil ONE reusable template that a scriptwriter must follow to make a NEW video that is unmistakably this trend.

OUTPUT — return ONLY a JSON object, no markdown:
{
  "concept": "2-3 sentences: what this trend IS — the exact subject, what happens, and what makes it recognisable.",
  "subjectType": "who/what the subject is (e.g. 'a tiny kitten filmed with a macro micro-camera')",
  "signatureAction": "the one action/image that must be visible for the video to read as this trend",
  "beats": ["ordered beat 1 as it appears in the examples", "beat 2", "beat 3", "beat 4"],
  "setting": "the typical environment/backdrop",
  "style": "rendering style, camera treatment, lighting and colour palette",
  "dialogue": "any typical audio/voice pattern, else empty string",
  "mustInclude": ["specific elements that appear in this trend's examples"],
  "avoid": ["things that would make it look like a different trend"]
}

RULES:
- Base every field ONLY on the supplied material. Do not invent a different subject.
- If a description of the trend's OWN example video is supplied it OUTRANKS the page copy: subject, setting, action order and look must match it exactly.
- beats must describe the ORDER of moments seen in the examples, at least 3 beats.
- If the material explains HOW this trend's prompts work (subject rules, what the image prompt describes vs what the video prompt describes, steps, what happens in the video), encode those mechanics exactly into concept/signatureAction/beats/mustInclude.
- Be concrete and specific (materials, scale, lighting, motion), not generic.`;
      const user = `Trend: "${name}"${(tagline || detailTagline) ? ' — ' + (tagline || detailTagline) : ''}
Source: ${src}
${concept ? 'Known summary: ' + concept + '\n' : ''}
${evidence}`;
      try {
        const raw = await chatText([{ role: 'system', content: system }, { role: 'user', content: user }], 4000, 0.7);
        template = normalizeTrendTemplate(parseTrendTemplateJson(raw), { source: src, slug, name });
        if (template) logLine(`trend template "${name}": built from real examples (${template.beats.length} beats, ${sampled.frames.length} frame(s), ${examplePrompts.length} prompt(s))`);
        else logLine(`trend template "${name}": model returned an unusable template — using curated fallback`);
      } catch (e) {
        logLine(`trend template "${name}": LLM distillation failed (${e.message}) — using curated fallback`);
      }
    }

    if (!template) {
      template = heuristicTrendTemplate({ source: src, slug, name, tagline: tagline || detailTagline, prose: (videoDescription ? videoDescription + (prose ? " \u2014 " + prose : "") : prose), examplePrompts, concept });
      logLine(`trend template "${name}": curated fallback (no usable example material)`);
    }

    template.meta = {
      builtAt: Date.now(),
      fromCache: false,
      grounded,
      groundedOn: {
        examples: videoUrls.length,
        frames: sampled.frames.length,
        prompts: examplePrompts.length,
        prose: !!prose,
        vision: !!videoDescription,
        sources: sampled.sources.slice(0, 6)
      }
    };
    store[key] = { ver: TEMPLATE_VERSION, builtAt: Date.now(), meta: template.meta, template: { ...template, meta: undefined } };
    saveTrendTemplateStore(store);
    return template;
  }

  // ---------- prompt block + relevance guard ----------
  function trendTemplateBlock(template) {
    if (!template) return '';
    const lines = [];
    if (template.concept) lines.push(`- WHAT THIS TREND IS: ${template.concept}`);
    if (template.subjectType) lines.push(`- SUBJECT TYPE: ${template.subjectType}`);
    if (template.signatureAction) lines.push(`- SIGNATURE ACTION (must be visible): ${template.signatureAction}`);
    if (Array.isArray(template.beats) && template.beats.length) lines.push(`- BEAT STRUCTURE (keep this ORDER of moments/shots): ${template.beats.map((b, i) => `(${i + 1}) ${b}`).join(' ')}`);
    if (template.setting) lines.push(`- TYPICAL SETTING: ${template.setting}`);
    if (template.style) lines.push(`- LOOK / RENDERING STYLE: ${template.style}`);
    if (template.dialogue) lines.push(`- AUDIO / DIALOGUE PATTERN: ${template.dialogue}`);
    if (template.mustInclude && template.mustInclude.length) lines.push(`- MUST INCLUDE: ${template.mustInclude.join(', ')}`);
    if (template.avoid && template.avoid.length) lines.push(`- NEVER DRIFT INTO: ${template.avoid.join(', ')}`);
    if (!lines.length) return '';
    const g = (template.meta && template.meta.groundedOn) || {};
    const from = template.meta && template.meta.grounded
      ? ` — built by reading this trend's OWN examples (${g.examples || 0} example video(s), ${g.frames || 0} sampled frame(s)${g.prompts ? `, ${g.prompts} real example prompt(s)` : ''}${g.prose ? ', page description' : ''})`
      : ' — curated fallback (no example material readable)';
    return `\n\nTHE TREND TEMPLATE — "${template.name}"${from}. Every scene/prompt MUST follow this template:
${lines.join('\n')}`;
  }

  // If a generated prompt drifts off the trend, pull it back by prefixing the
  // template's own definition; an on-trend prompt passes through untouched.
  function enforceTrendTemplate(prompt, template, kind = 'image') {
    const p = String(prompt || '').trim();
    if (!p || !template) return p;
    const words = `${template.concept || ''} ${template.signatureAction || ''} ${template.subjectType || ''} ${(template.mustInclude || []).join(' ')} ${template.name || ''}`
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 4 && !['trend', 'video', 'scene', 'style', 'which', 'their', 'there', 'these', 'those', 'about', 'every', 'shows', 'makes', 'using', 'built', 'example'].includes(w));
    const uniq = [...new Set(words)].slice(0, 60);
    const hay = p.toLowerCase();
    const hits = uniq.filter(w => hay.includes(w)).length;
    if (hits >= 2) return p;
    const beats = Array.isArray(template.beats) ? template.beats.slice(0, 3).join(' Then: ') : '';
    const lead = [
      template.concept ? `This is the "${template.name}" trend: ${template.concept}` : '',
      template.signatureAction ? `Signature moment: ${template.signatureAction}.` : '',
      beats ? `Beat order: ${beats}.` : ''
    ].filter(Boolean).join(' ');
    return `${lead} ${p}`.replace(/\s+/g, ' ').trim();
  }

  return {
    TREND_TEMPLATES_FILE,
    loadTrendTemplateStore, saveTrendTemplateStore,
    buildTrendTemplate, trendTemplateBlock, enforceTrendTemplate,
    heuristicTrendTemplate, parseTrendTemplateJson, normalizeTrendTemplate, okTrendTemplate,
    fetchFlashloopTrendDetail, fetchSjinnTrendDetail, sampleTrendFrames,
    decodeFlightPayload, parseFlightRows, resolveFlightRef, normalizeTrendExamples
  };
};
