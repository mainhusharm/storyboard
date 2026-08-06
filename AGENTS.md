# Storyboard Production Project

Transforms scripts into production-ready cinematic storyboards with **locked character
consistency**, generates frame images, animates them via Grok Video / Omni Flash (8s)
/ Veo 3.1 with auto-fallback, and combines everything into a single story film via ffmpeg.

## Layout

- `script.txt`              — source script (user-provided)
- `storyboard/characters.json` — locked character profiles (id, name, age, description, reference_prompt)
- `storyboard/frames.json`  — master storyboard: one object per frame
- `web/server.js`           — zero-dep Node web server (the app)
- `web/public/index.html`   — SPA frontend
- `pipeline/PaxGen.ps1`     — CLI pipeline for single phases (alternative to web)
- `pipeline/Continue-Full.ps1` — CLI full pipeline: clean, char refs, images, videos, combine
- `pipeline/apikey.txt`     — PaxSenix API key (never commit)
- `frames/`                 — character ref PNGs (`char_Elias_ref.png`) + frame PNGs (`frame_01.png`)
- `video/`                  — frame MP4s (`frame_01.mp4`) + `final_story.mp4`

## Pipeline Flow

1. **Storyboard** — LLM generates `characters.json` (locked profiles) + `frames.json`
   (each frame's `image_prompt` includes verbatim character descriptions)
2. **Character Refs** — 1:1 portrait per character via nano-banana-pro (visual anchor)
3. **Frame Images** — 16:9 cinematic stills via nano-banana-pro (character desc repeated every prompt)
   - **Character consistency**: when enabled (default ON), every frame image is generated via
     img2img anchored to the character reference portraits, keeping faces/wardrobe identical
4. **TTS Narration** — per-frame narration/dialogue audio via PaxSenix TTS (voice selectable)
5. **Frame Videos** — Grok Video / Omni Flash / Veo 3.1 image-to-video or text-to-video
   per frame (grok-video & omni-flash auto-fallback to Veo 3.1). With **Seamless Scene
   Chaining** ON (default), each scene's video is anchored to the LAST FRAME extracted
   from the previous scene's video (`chain_NN.png` in `frames/`), so scene N starts exactly
   where scene N-1 ended — scenes render sequentially in that mode.
6. **Final Film** — ffmpeg concatenates all frame MP4s into `final_story.mp4`

## Website Features

- **Creative Direction** — text field describing how the story should look; injected into the
  storyboard prompt so the LLM shapes shots, lighting, and mood accordingly
- **Narration Voices** — voice dropdown (10 options: US/UK/Indian male/female)
- **Character Consistency toggle** — when ON, frame images use img2img anchored to the character
  reference portraits (faces, hair, skin tone, wardrobe stay identical across all shots)
- **Seamless Scene Chaining toggle** — when ON (default), each scene's video starts from the last
  frame of the previous scene's video (extracted with ffmpeg and re-hosted to a public URL), so the
  story flows continuously across cuts. Renders scenes sequentially.
- **🚀 Create Full Film — auto** — one-click button that runs the entire pipeline:
  clean → storyboard → character refs → images → narration → videos → final combine
- **Per-frame re-render** — individual frame re-render buttons still work with consistency

## PaxSenix API (v3.3.1)

Base: `https://api.paxsenix.org` — Auth: `Authorization: Bearer <key>`

Verified endpoints:
- `POST /v1/chat/completions` (OpenAI-compatible, streaming supported)
- `GET /ai-image/nano-banana?prompt=..&model=nano-banana-pro&ratio=16:9`
  - models: `nano-banana`, `nano-banana-pro`, `nano-banana-2`
- `GET /ai-video/grok-video?prompt=..&ratio=16:9&type=text-to-video`
  - `type=image-to-video&imageUrls=<url>` for frame animation
- `GET /ai-video/omni-flash?prompt=..&ratio=16:9&type=text-to-video` (8-second clips)
  - `type=image-to-video&imageUrl=<url>` (singular `imageUrl`)
- `GET /ai-video/veo-3.1?prompt=..&ratio=16:9&type=text-to-video` (8-second clips)
  - `type=image-to-video&imageUrl=<url>` (singular `imageUrl` — differs from grok's plural)
- **Video ratios**: `grok-video` accepts `16:9` / `9:16` / `1:1`; `omni-flash` and `veo-3.1` accept
  ONLY `16:9` / `9:16`; no video model accepts `4:3`. The app auto-snaps an unsupported ratio to the
  closest supported one (portrait-ish → `9:16`, otherwise → `16:9`) with a log note, so a frame never
  dies at submit time. The storyboard UI hides `4:3` for this reason.
- **Video model auto-fallback**: when `grok-video` or `omni-flash` is selected and a frame fails
  to submit/render, it automatically retries that frame with `veo-3.1`. If `veo-3.1` is selected
  directly, no fallback runs. The dropdown lists each model as a separate standalone option.
- **Image-to-video asset hardening**: before submitting image-to-video, the frame's stored image
  URL is verified reachable; if it is dead/expired (e.g. old `tmpfiles.paxsenix.org` links), the
  local frame PNG is re-hosted to catbox/uguu for a fresh URL. If a video task still dies with
  PaxSenix's `Uploaded asset ... not ready within 120000ms` error (a server-side asset-pipeline
  failure that retrying does not cure), a per-run circuit breaker skips that model for the rest of
  the run so remaining frames fall straight through to the next model (veo-3.1) without burning
  ~2.5 min per frame. The LAST model in the chain is never skipped — it is always attempted.
  With seamless chaining ON, frames render sequentially, so a broken omni-flash i2v pipeline can
  otherwise add ~25 min of dead time to an 11-frame run.
- **Seamless chaining**: `POST /api/videos` (and `/api/run-all`) accept `chainContinuity: true` —
  videos then render sequentially, each anchored to the previous scene's last frame.

## Fresh trends (Tavily)

`tavilySearch()` queries `topic: 'news'` with a 7-day `days` recency window first so trend terms
come from freshly-published articles (not evergreen listicles), then falls back to `general` web
search when news returns nothing (niche categories). Results are additionally filtered by
`published_date` when present. `tavilyTrendTerms()` queries for "this week" trends and pulls from
up to 10 results.
- `GET /tools/tts/v2?text=..&language=en&voice=en-US-AriaNeural`
  - voices: en-US-AriaNeural, en-US-JennyNeural, en-US-GuyNeural, en-US-ChristopherNeural,
    en-US-EricNeural, en-GB-SoniaNeural, en-GB-RyanNeural, en-IN-NeerjaNeural,
    en-IN-PrabhatNeural, alloy

## Narration TTS engines (MIMO default · PaxSenix · Qwen3-TTS)

Storyboard narration picks an engine from the **Narration engine** dropdown
(`/api/models` → `narrationEngines`): `mimo` (default) | `paxsenix` | `qwen`.
- `mimo` — AquaDevs MIMO via `POST /v1/audio/speech` on `api.aquadevs.com` (see below).
- `paxsenix` — the verified `/tools/tts/v2` endpoint used as the fallback engine directly.
- `qwen` — **Qwen3-TTS** ModelScope Gradio space: POST `/gradio_api/call/v2/generate_tts`
  (named params or `{data:[text, language, speaker, speed, pitch, emotion, custom_instruct,
  preset_name]}`) → `{event_id}` → GET `/gradio_api/call/generate_tts/<event_id>` (SSE) →
  the completion block carries the audio file (gradio v5 sends a raw array of FileData objects
  `{path, url}`; gradio v4 wraps it as `{"output":{"data":[...]}}`) → download via
  `/gradio_api/file=<path>` (wav → ffmpeg → mp3).
  - Base URL: `QWEN_TTS_BASE` env. Default (NO token needed): the public studio host
    `https://mama8054-qwen3-tts-domen.ms.show` — requires a browser **User-Agent header**
    (anti-bot 403 without it). When `MODELSCOPE_TOKEN` is set (env or
    `pipeline/modelscope_token.txt`) it automatically switches to the api-inference host
    `https://studio-mama8054-qwen3-tts-domen.api-inference.modelscope.net`.
    Speakers: Vivian, Ryan (default), Aiden, Eric, Serena.
  - Payload shapes are tried in both orders on both paths (named params first — the
    tokenless v2 path rejects `data[]` with HTTP 500; the api-inference host wants `data[]`).
  - Response parsing handles gradio v4 (`{"output":{"data":[...]}}` string path) AND
    gradio v5 (raw array of FileData `{path,url}` objects); nested arrays are unwrapped
    and the `/mnt/workspace/...` status `value` is never mistaken for audio.
  - Total Qwen wall-clock budget: 200s on Vercel (fits inside the 300s maxDuration,
    leaving headroom for ffmpeg + chunk concat) / 900s locally.
  - On failure each chunk falls back to PaxSenix, so narration never breaks.

### ffmpeg on Vercel

Vercel's Node runtime has NO ffmpeg on PATH, but the whole pipeline (Qwen wav→mp3,
chunk concat, narration overlay, frame extraction, final combine) shells out to
`execFile('ffmpeg', …)`. All 19 call sites go through `ffmpegBin()` which resolves:
`require('ffmpeg-static')` (bundled per-OS binary, installed via npm — linux-x64 on
Vercel) and falls back to `ffmpeg` on PATH for local dev. `ffmpeg-static` is a regular
dependency (bundled size ~76MB, well under Vercel's 250MB uncompressed function limit).

### MIMO (with PaxSenix fallback)

Storyboard narration uses **AquaDevs MIMO TTS** (`mimo-v2.5-tts` via `POST /v1/audio/speech`
on `api.aquadevs.com`):
- An explicit language instruction is ALWAYS sent (even for English) — the MIMO default
  voice `mimo_default` is Chinese-biased and will drift into the wrong language otherwise.
- English uses English-native MIMO voices (`Chloe` female / `Milo` male) instead of `mimo_default`.
- When MIMO fails (non-200 / no URL / download failure), each chunk automatically falls back
  to the verified PaxSenix endpoint above with proper en-US voices (`en-US-AriaNeural` female /
  `en-US-GuyNeural` male) and the language code (`language=hi|es|fr|...`), so narration never breaks.
- **PaxSenix text limit**: `/tools/tts/v2` rejects text over ~200 chars (404 "Failed to retrieve
  this content"). The fallback sub-splits narration into <=180-char pieces (sentence-aware, then
  hard-capped), generates each, and ffmpeg-concatenates the mp3s into the chunk file.

Async job: submit → `{jobId, task_url}` → poll task_url (202 pending, 200 done) → `{url}` on tmpfiles.paxsenix.org.

## Authentication (login / signup)

Zero-framework auth built into `web/server.js` — scrypt password hashing + random session tokens.

- **Users/sessions** live in Postgres when `DATABASE_URL` is set (Vercel Postgres / Neon via the
  `pg` driver — auto-creates `sb_users` + `sb_sessions` tables). Otherwise a local JSON fallback
  (`storyboard/users.json` + `storyboard/sessions.json`, gitignored) keeps local dev zero-setup.
- **Pages**: `/` → `home.html` (portal to all tools), `/login` (login + signup), `/storyboard` →
  `index.html`, plus `/influencer`, `/trends`, `/flashloop-studio`. All tool pages are protected.
- **Local server**: tool pages are gated server-side (`requirePageAuth` → 302 to `/login`), and
  every `/api/*` route (except `/api/health`, `/api/models`, `/api/status`, `/api/auth/*`) requires
  a valid session via `requireApiAuth`.
- **Vercel**: pages are served statically, so protection is client-side — each tool page checks
  `/api/auth/me` on load and redirects to `/login?next=...` when 401; the API stays server-gated.
- **Endpoints**: `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/logout`,
  `GET /api/auth/me` (cookie or `Authorization: Bearer <token>`), `PUT /api/auth/user` (rename).
- Session cookie: `sb_session` (HttpOnly, SameSite=Lax, 30-day TTL; `Secure` on Vercel).

## Running

### Website (primary)
```
node web/server.js          # → http://localhost:5173
```
Zero dependencies (pure Node stdlib). Full flow: paste script → Generate Storyboard →
Character Refs → Images → Videos → Combine Final Film. Live progress + per-frame re-render.

Clicking **Generate Storyboard** archives old renders (`frames/backup_*` and `video/backup_*`)
so the new storyboard never gets stuck behind skipped existing files. The **Images** and
**Videos** buttons always regenerate every current frame. Combine always rebuilds
`final_story.mp4`.

Storyboard generation: streaming chat with 3 retries + JSON repair for robustness.
Default model: `gemini-2.5-pro` (reliable). `gpt-5.5` available but may timeout on PaxSenix.

### CLI pipeline (alternative)

Single phases (skips existing files; delete a file to force regeneration):
```
powershell -File pipeline\PaxGen.ps1 -Phase images
powershell -File pipeline\PaxGen.ps1 -Phase videos
```

Full end-to-end run (cleans old outputs, then char refs → images → videos → combine):
```
powershell -ExecutionPolicy Bypass -File pipeline\Continue-Full.ps1
```

`Continue-Full.ps1` backs up stale assets, starts the web server if needed, and drives
`/api/char-refs`, `/api/images`, `/api/videos`, and `/api/combine` automatically.
