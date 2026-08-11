#!/usr/bin/env node
// One-off utility: generate Fish Audio TTS narration for the current storyboard
// (storyboard/frames.json) and overlay it onto video/final_story.mp4.
//
// Mirrors generateFullNarration() in web/server.js so behaviour matches the app:
// same chunking, same signature file, same ffmpeg overlay (mix vs replace).
//
// Usage:
//   node pipeline/narrate-now.js [--voice female|male] [--language hi|en|...] [--force]
//
// Language auto-detects (romanized Hindi → hi) when omitted. If narration for the
// same text already exists (signature match), it is reused unless --force.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const VIDEO_DIR = path.join(ROOT, 'video');
const FRAMES_JSON = path.join(ROOT, 'storyboard', 'frames.json');

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf('--' + name);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const voice = arg('voice', 'female') === 'male' ? 'male' : 'female';
const force = args.includes('--force');
// Mix volumes for the overlay (same defaults as the app: 1.5× narration, 0.4× film).
// Number.isFinite (not `||`) so passing 0 actually mutes instead of falling back.
const volOf = (v, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(3, Math.max(0, n)) : def; };
const narrVol = volOf(arg('narr-volume', 1.5), 1.5);
const origVol = volOf(arg('orig-volume', 0.4), 0.4);

// ---- constants (match web/server.js) ----
const FISH_API = 'https://api.fish.audio';
const FISH_TTS_MODEL = 's2.1-pro-free';
const TTS_FISH_REFERENCES = {
  female: '9a9cf47702da476aa4629e2506d4a857', // Hannah — female
  male: 'bf322df2096a46f18c579d0baa36f41d'      // Adrian — male
};
let FISH_API_KEY = process.env.FISH_API_KEY || '';
try { FISH_API_KEY = FISH_API_KEY || fs.readFileSync(path.join(ROOT, 'pipeline', 'fish_apikey.txt'), 'utf8').trim(); } catch {}
const LANG_CODES = { en: 'en', hi: 'hi', es: 'es', fr: 'fr', ja: 'ja', ar: 'ar', pt: 'pt', de: 'de', ta: 'ta', te: 'te' };

function ffmpegBin() { try { return require('ffmpeg-static'); } catch { return 'ffmpeg'; } }

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

function buildNarrationText(frames) {
  return frames.filter(f => f.narration || f.dialogue)
    .map(f => [f.narration, f.dialogue].filter(Boolean).join('. '))
    .join('. ... ');
}

// Romanized-Hindi heuristic — the TTS speaks with correct pronunciation when the
// language code is sent (only needed for non-English text).
function detectLanguage(text) {
  if (/[\u0900-\u097F]/.test(text)) return 'hi';
  if (/\b(ki|ke|ka|ko|hai|tha|thi|mein|aur|se|ne|apne|apni|par|nahi|raha|rahi|gaya|gayi|ek|woh|usne|unka|unki|kaise|kya|hain|the|jo|yeh|wo)\b/i.test(text)) return 'hi';
  return 'en';
}

async function main() {
  if (!FISH_API_KEY) { console.error('✖ FISH_API_KEY not found (env or pipeline/fish_apikey.txt)'); process.exit(1); }
  if (!fs.existsSync(FRAMES_JSON)) { console.error(`✖ ${FRAMES_JSON} not found — generate a storyboard first`); process.exit(1); }

  const frames = JSON.parse(fs.readFileSync(FRAMES_JSON, 'utf8'));
  const fullText = buildNarrationText(frames);
  if (!fullText) { console.error('✖ no narration text in frames.json'); process.exit(1); }

  const language = LANG_CODES[arg('language', '')] || detectLanguage(fullText);
  const referenceId = TTS_FISH_REFERENCES[voice];
  const sig = JSON.stringify({
    voice,
    language,
    engine: 'fish',
    hash: crypto.createHash('sha1').update(fullText).digest('hex')
  });
  const sigFile = path.join(VIDEO_DIR, 'narr_chunk_sig.txt');
  const fullAudioPath = path.join(VIDEO_DIR, 'full_narration.mp3');
  const finalPath = path.join(VIDEO_DIR, 'final_story.mp4');

  // Skip when an identical narration already exists (matches the app's stale-chunk guard)
  if (!force && fs.existsSync(sigFile) && fs.existsSync(fullAudioPath)) {
    const existing = fs.readFileSync(sigFile, 'utf8');
    if (existing === sig) { console.log('✔ identical narration already generated — reusing'); await overlay(finalPath, fullAudioPath); return; }
  }

  const chunks = splitTextIntoChunks(fullText);
  console.log(`→ ${fullText.length} chars, ${chunks.length} chunk(s), ${voice} voice, language ${language}`);

  // Clean stale chunk files, then generate
  for (const f of fs.readdirSync(VIDEO_DIR)) {
    if (f.startsWith('narr_chunk_') && f.endsWith('.mp3')) { try { fs.unlinkSync(path.join(VIDEO_DIR, f)); } catch {} }
  }

  const chunkFiles = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunkPath = path.join(VIDEO_DIR, `narr_chunk_${String(i + 1).padStart(2, '0')}.mp3`);
    console.log(`→ chunk ${i + 1}/${chunks.length}: calling Fish Audio...`);
    const body = { text: chunks[i], reference_id: referenceId, format: 'mp3' };
    if (language !== 'en') body.language = language;
    let saved = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(`${FISH_API}/v1/tts`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${FISH_API_KEY}`, 'Content-Type': 'application/json', model: FISH_TTS_MODEL },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120000)
        });
        if (res.ok) {
          const ct = res.headers.get('content-type') || '';
          if (!/audio|octet-stream/i.test(ct)) { console.error(`✖ unexpected content-type "${ct}"`); break; }
          await fsp.writeFile(chunkPath, Buffer.from(await res.arrayBuffer()));
          saved = true;
          break;
        }
        const j = await res.json().catch(() => ({}));
        console.error(`✖ HTTP ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
        if (res.status === 429) await new Promise(r => setTimeout(r, 10000 * attempt));
        else if (attempt < 3) await new Promise(r => setTimeout(r, 3000 * attempt));
      } catch (e) {
        console.error(`✖ fetch error: ${e.message}`);
        if (attempt < 3) await new Promise(r => setTimeout(r, 3000 * attempt));
      }
    }
    if (!saved) { console.error('✖ chunk failed after 3 attempts'); process.exit(1); }
    chunkFiles.push(chunkPath);
    console.log(`  ✔ chunk ${i + 1} saved (${fs.statSync(chunkPath).size} bytes)`);
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 3000));
  }

  // Assemble full narration (concat or single-copy)
  if (chunkFiles.length === 1) {
    fs.copyFileSync(chunkFiles[0], fullAudioPath);
  } else {
    const listPath = path.join(VIDEO_DIR, 'narr_concat.txt');
    await fsp.writeFile(listPath, chunkFiles.map(p => `file '${path.basename(p)}'`).join('\n'));
    await new Promise((resolve) => {
      execFile(ffmpegBin(), ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', fullAudioPath],
        { cwd: VIDEO_DIR, timeout: 30000 }, () => { try { fs.unlinkSync(listPath); } catch {} resolve(); });
    });
  }
  if (!fs.existsSync(fullAudioPath)) { console.error('✖ concat failed'); process.exit(1); }
  fs.writeFileSync(sigFile, sig);
  console.log(`✔ narration audio assembled (${(fs.statSync(fullAudioPath).size / 1024).toFixed(0)} KB)`);

  await overlay(finalPath, fullAudioPath);
}

async function overlay(finalPath, fullAudioPath) {
  if (!fs.existsSync(finalPath)) { console.error(`✖ ${finalPath} not found — combine the film first`); process.exit(1); }
  // Same probe as web/server.js's probeHasAudio — ffmpeg -i stderr parsing works
  // even where ffprobe isn't on PATH (e.g. Vercel). Keep both in sync.
  const hasAudio = await new Promise((resolve) => {
    execFile(ffmpegBin(), ['-i', finalPath], { timeout: 15000 }, (e, stdout, stderr) => {
      const out = String(stderr || '') + String(stdout || '');
      resolve(/Stream #\d+:\d+.*Audio|Audio:/.test(out));
    });
  });
  const tempPath = finalPath + '.narr.mp4';
  const args = hasAudio
    ? ['-y', '-i', finalPath, '-i', fullAudioPath,
       '-filter_complex', `[0:a]volume=${origVol}[orig];[1:a]volume=${narrVol}[narr];[orig][narr]amix=inputs=2:duration=first[a]`,
       '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', tempPath]
    : ['-y', '-i', finalPath, '-i', fullAudioPath,
       '-filter_complex', '[1:a]apad[a]',
       '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-map', '0:v:0', '-map', '[a]', '-shortest', tempPath];
  console.log(`→ overlaying narration on final film (${hasAudio ? 'mix with original audio' : 'replace'}, narration ${narrVol}×, film audio ${origVol}×)...`);
  const ok = await new Promise((resolve) => {
    execFile(ffmpegBin(), args, { timeout: 120000 }, (e) => resolve(!e));
  });
  if (ok && fs.existsSync(tempPath)) {
    try { fs.unlinkSync(finalPath); fs.renameSync(tempPath, finalPath); } catch {}
    console.log(`✔ DONE — ${finalPath} now has narration (${(fs.statSync(finalPath).size / 1048576).toFixed(1)} MB)`);
  } else {
    console.error('✖ overlay failed'); try { fs.unlinkSync(tempPath); } catch {}
    process.exit(1);
  }
}

main().catch(e => { console.error('✖', e); process.exit(1); });
