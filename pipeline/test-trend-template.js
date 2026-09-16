// test-trend-template.js
// Regression test for the SJinn / Flashloop "trend template" layer.
//
// Why it exists: prompts for those sections used to be invented from nothing but
// a trend NAME + a scraped tagline, so the output was irrelevant to the trend.
// The fix reads the trend's OWN example material (Flashloop wants example videos
// + publishes the actual prompts that produced them; SJinn publishes a demo video
// + a prose description), samples real frames, and turns it all into one template
// every generated prompt must follow.
//
// This test proves, against the LIVE sites:
//   1. Flashloop examples resolve to real videos AND their real prompts.
//   2. Frames are actually extracted from the trend's example videos (ffmpeg).
//   3. buildTrendTemplate() produces a usable template for both sources.
//   4. The template renders into a prompt block and the relevance guard fires.
//
// Usage:
//   node pipeline/test-trend-template.js                 # both sources
//   node pipeline/test-trend-template.js sjinn slime-face
//   node pipeline/test-trend-template.js flashloop sports-anime-cv
//
// The vision step uses pipeline/apikey.txt when present; without a key the
// curated-fallback template path is exercised instead.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
process.env.PORT = '0'; // don't collide with a running dev server

if (!process.env.PAXSENIX_API_KEY) {
  try { process.env.PAXSENIX_API_KEY = fs.readFileSync(path.join(ROOT, 'pipeline', 'apikey.txt'), 'utf8').trim(); } catch {}
}

const server = require(path.join(ROOT, 'web', 'server'));
const T = server.__internal;

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

const SRC = (process.argv[2] || '').toLowerCase();
const SLUG = process.argv[3] || '';

async function flashloopSource() {
  console.log('\n=== Flashloop trend examples ===');
  const formats = await T.scrapeFlashloop();
  check('scraped formats', formats.length > 0, `${formats.length} formats`);
  const slug = SLUG || 'sports-anime-cv';
  const fmt = formats.find(f => f.slug === slug);
  check(`format "${slug}" present`, !!fmt);
  if (!fmt) return null;
  const withVideo = (fmt.examples || []).filter(e => e.videoUrl);
  const withPrompt = (fmt.examples || []).filter(e => e.prompt);
  check('examples carry video URLs', withVideo.length > 0, `${withVideo.length} video(s)`);
  check('example prompts resolved from the flight payload', withPrompt.length > 0,
    withPrompt.length ? `${withPrompt.length} prompt(s), e.g. "${withPrompt[0].prompt.slice(0, 80)}…"` : 'none (site layout changed?)');

  const detail = await T.fetchFlashloopTrendDetail(slug);
  console.log(detail
    ? `  detail page: ${detail.examples.length} examples, tagline "${(detail.tagline || '').slice(0, 60)}"`
    : '  detail page unavailable (optional)');

  // Real frame extraction from the trend's first example video (HLS).
  if (withVideo.length) {
    const { frames, sources } = await T.sampleTrendFrames([{ kind: 'video', url: withVideo[0].videoUrl, label: 'test example video' }], { maxFrames: 3 });
    check('frames sampled from the trend example video', frames.length > 0, `${frames.length} frame(s) ${sources[0] || ''}`);
    check('frames are real JPEG data URLs', frames.every(f => /^data:image\/jpeg;base64,/.test(f)));
  }
  return fmt;
}

async function sjinnSource() {
  console.log('\n=== SJinn trend page ===');
  const slug = SLUG || 'slime-face';
  const detail = await T.fetchSjinnTrendDetail(slug);
  check(`detail page for "${slug}" fetched`, !!detail);
  if (!detail) return null;
  check('page carries a demo video for the trend', detail.media.length > 0, detail.media[0] || 'none');
  check('page prose describes the trend', detail.prose.length > 100, `"${detail.prose.slice(0, 80)}…"`);
  const video = detail.media.find(u => /\.(mp4|mov|webm)$/i.test(u));
  if (video) {
    const { frames } = await T.sampleTrendFrames([{ kind: 'video', url: video, label: 'sjinn demo video' }], { maxFrames: 3 });
    check('frames sampled from the SJinn demo video', frames.length > 0, `${frames.length} frame(s)`);
  }
  return detail;
}

async function templateFor(source, slug, name, thumbnail) {
  console.log(`\n=== buildTrendTemplate(${source}:${slug}) ===`);
  const t0 = Date.now();
  const template = await T.buildTrendTemplate({ source, slug, name, thumbnail, refresh: true });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  check('template returned', !!template, `${secs}s`);
  if (!template) return null;
  check('concept present', !!template.concept, (template.concept || '').slice(0, 120));
  check('signature action present', !!template.signatureAction, (template.signatureAction || '').slice(0, 120));
  check('ordered beats present', Array.isArray(template.beats) && template.beats.length >= 2, `${(template.beats || []).length} beats`);
  check('style present', !!template.style, (template.style || '').slice(0, 100));
  const g = template.meta.groundedOn;
  console.log(`  grounded: ${template.meta.grounded} (videos ${g.examples}, frames ${g.frames}, prompts ${g.prompts}, prose ${g.prose})`);

  const block = T.trendTemplateBlock(template);
  check('prompt block renders', block.includes('THE TREND TEMPLATE') && block.includes(template.name));

  // Relevance guard: an off-trend prompt must be pulled back onto the trend;
  // an on-trend prompt must pass through untouched.
  const off = 'A generic person sitting on a park bench looking at the horizon.';
  const guarded = T.enforceTrendTemplate(off, template, 'image');
  check('off-trend prompt is corrected', guarded !== off, guarded.slice(0, 110));
  const onTrend = `${template.concept} ${template.signatureAction} ${(template.mustInclude || []).join(' ')}`;
  check('on-trend prompt is untouched', T.enforceTrendTemplate(onTrend, template, 'image') === onTrend);
  return template;
}

(async () => {
  console.log('trend template regression test');
  try {
    if (!SRC || SRC === 'flashloop') {
      const f = await flashloopSource();
      await templateFor('flashloop', SLUG || 'sports-anime-cv', (f && f.name) || 'Sports Anime', (f && f.thumbnail) || '');
    }
    if (!SRC || SRC === 'sjinn') {
      const s = await sjinnSource();
      await templateFor('sjinn', SLUG || 'slime-face', 'Slime Face', (s && s.images && s.images[0]) || '');
    }
    console.log(`\ncache file: ${T.TREND_TEMPLATES_FILE}`);
    const store = T.loadTrendTemplateStore();
    console.log(`cached templates: ${Object.keys(store).join(', ') || 'none'}`);
  } catch (e) {
    console.error('\nTEST ERROR: ' + e.message);
    failures++;
  }
  console.log(failures ? `\nFAILED: ${failures} check(s)` : '\nPASSED: all checks passed');
  process.exit(failures ? 1 : 0);
})();