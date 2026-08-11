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
- `pipeline/fish_apikey.txt` — Fish Audio TTS API key (never commit; env `FISH_API_KEY` on Vercel)
- `frames/`                 — character ref PNGs (`char_Elias_ref.png`) + frame PNGs (`frame_01.png`)
- `video/`                  — frame MP4s (`frame_01.mp4`) + `final_story.mp4`

## Pipeline Flow

1. **Storyboard** — LLM generates `characters.json` (locked profiles) + `frames.json`
   (each frame's `image_prompt` includes verbatim character descriptions)
2. **Character Refs** — 1:1 portrait per character via nano-banana-pro (visual anchor)
3. **Frame Images** — 16:9 cinematic stills via nano-banana-pro (character desc repeated every prompt)
   - **Character consistency**: when enabled (default ON), every frame image is generated via
     img2img anchored to the character reference portraits, keeping faces/wardrobe identical
4. **TTS Narration** — per-frame narration/dialogue audio via Fish Audio TTS (voice selectable)
5. **Frame Videos** — Grok Video / Omni Flash / Veo 3.1 image-to-video or text-to-video
   per frame. With **Seamless Scene Chaining** ON (default), each scene's video is anchored
   to the LAST FRAME extracted from the previous scene's video (`chain_NN.png` in `frames/`),
   so scene N starts exactly where scene N-1 ended — scenes render sequentially in that mode.
6. **Final Film** — ffmpeg concatenates all frame MP4s into `final_story.mp4`

## Website Features

- **Creative Direction** — text field describing how the story should look; injected into the
  storyboard prompt so the LLM shapes shots, lighting, and mood accordingly
- **Narration Voices** — voice dropdown (Female narrator / Male narrator)
- **Character Consistency toggle** — when ON, frame images use img2img anchored to the character
  reference portraits (faces, hair, skin tone, wardrobe stay identical across all shots)
- **Seamless Scene Chaining toggle** — when ON (default), each scene's video starts from the last
  frame of the previous scene's video (extracted with ffmpeg and re-hosted to a public URL), so the
  story flows continuously across cuts. Renders scenes sequentially.
- **Vercel: videos render ONE FRAME PER REQUEST** — on Vercel a serverless invocation dies at
  300s, so a whole-board synchronous `/api/videos` always times out. The client detects Vercel via
  `/api/health` and loops frames one-per-request (`runVideosVercel`), passing the previous frame's
  `chain_image_url` back as `chainAnchor` so seamless chaining survives across invocations. The
  server caps the render wait at ~270s of the budget (`vercelBudgetDeadline`), truth-checks the
  mp4 on disk before reporting success (`video_path`), and returns `{ok:false, failed}` when the
  budget was exhausted; the client then retries the frame once. `vercel.json` rewrites `/frames/*`
  and `/video/*` to `/api/_route?p=...` so rendered assets are reachable. Regression-test with
  `node pipeline/test-vercel-video.js` (self-hosts the handler in Vercel mode).
- **🚀 Create Full Film — auto** — one-click button that runs the entire pipeline:
  clean → storyboard → character refs → images → narration → videos → final combine
- **Per-frame re-render** — individual frame re-render buttons still work with consistency
- **✕ Cancel button** — shown in the header while a task runs; `POST /api/cancel` sets a
  `cancelRequested` flag that the pipeline loops (storyboard, char refs, images, videos,
  narration, combine, auto run-all) and task polls (`waitTask`/`submitTask`) check between
  frames, aborting quickly so the job returns to `idle`. Run buttons stay ENABLED while busy:
  clicking one prompts to cancel the running task first (`guardBusy` in the SPA), then starts
  the new job — so a pending task never blocks a fresh run. Cancellation is scoped to the
  storyboard job only (the influencer job is independent).

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
- **Standalone video models (no auto-fallback)**: the video model dropdown lists `grok-video`,
  `omni-flash`, and `veo-3.1` as separate, explicit choices. The selected model runs ALONE — a
  failed frame is reported failed; it is NOT silently retried with another model.
- **Prompt-repair retry ladder**: a failed frame is never silently dropped to a static image —
  `renderVideo` FIXES the prompt and resubmits on the same model: (1) softened wording (the
  omni-flash softening table, applied to any model), (2) an LLM rewrite (`repairVideoPrompt`)
  that keeps the scene but rephrases violence/abduction wording into safe cinematic action, then
  (3) a final text-to-video attempt that bypasses the image-to-video asset pipeline. Only after
  every attempt fails does `combineFilm` fall back to the frame still (logged as "all render
  attempts failed").
- **omni-flash i2v PNG→JPG fix**: PaxSenix's omni-flash image-to-video asset pipeline REJECTS
  PNG files (`Uploaded asset ... not ready within 120000ms, last status errored`) but accepts
  JPG — verified live (same image: .png → fail, .jpg → done; veo-3.1/grok accept PNG fine).
  When omni-flash is selected, `resolveVideoImage()`/`uploadVideoImage()` re-encode the local
  frame PNG (and seamless-chain anchors) to JPG via ffmpeg before hosting, so omni-flash i2v
  works. The app also **softens the submitted prompt** for omni-flash only (`softenOmniPrompt`)
  — omni-flash's text filter 400s on violence/abduction/struggle wording (e.g. "grabs Siya"
  enhanced → "graphic violence and non-consensual action"), while veo-3.1/grok accept the
  same language. veo-3.1 remains the safest choice for gory/violent scripts.
- **Image-to-video asset hardening**: before submitting image-to-video, the frame's stored image
  URL is verified reachable; if it is dead/expired (e.g. old `tmpfiles.paxsenix.org` links), the
  local frame PNG is re-hosted to catbox/uguu for a fresh URL.
- **Seamless chaining**: `POST /api/videos` (and `/api/run-all`) accept `chainContinuity: true` —
  videos then render sequentially, each anchored to the previous scene's last frame.

## Fresh trends (Tavily)

`tavilySearch()` queries `topic: 'news'` with a 7-day `days` recency window first so trend terms
come from freshly-published articles (not evergreen listicles), then falls back to `general` web
search when news returns nothing (niche categories). Results are additionally filtered by
`published_date` when present. `tavilyTrendTerms()` queries for "this week" trends and pulls from
up to 10 results.

## Narration TTS engines (Fish Audio default · MIMO option)

Storyboard narration picks an engine from the **Narration engine** dropdown
(`/api/models` → `narrationEngines`): `fish` (default) | `mimo`.
- `fish` — **Fish Audio** free TTS: `POST https://api.fish.audio/v1/tts` with the model passed
  as a custom `model: s2.1-pro-free` HTTP header and the voice chosen via `reference_id`:
  female = `9a9cf47702da476aa4629e2506d4a857` ("Hannah"), male = `bf322df2096a46f18c579d0baa36f41d`
  ("Adrian") — verified live against `GET /model/{id}` (the IDs were previously SWAPPED, so
  male selection played the female voice and vice-versa). The call retries with backoff on
  429/5xx (3 attempts) before handing off to the fallback engine.
  - **Stale-chunk guard**: narration is generated in cached chunks (`narr_chunk_*.mp3`)
    plus the assembled `full_narration.mp3`. A signature file (`narr_chunk_sig.txt`,
    voice + language + engine + text hash) is written only after all chunks succeed;
    if the request differs from the stored signature the old chunks are deleted so a
    new film NEVER reuses a previous film's audio. `cleanOutputs()` also archives
    `narr_chunk_*.mp3` / `full_narration.mp3` / `narr_chunk_sig.txt` on full runs.
  - Body: `{ "text", "reference_id", "format": "mp3" }` + `"language": "<iso>"` for non-English
    narration (verified live: en + hi both return `audio/mpeg` mp3 bytes).
  - The response is the raw mp3 audio (no polling, no task URL) — saved straight to the chunk file.
  - Key: env `FISH_API_KEY` or `pipeline/fish_apikey.txt` (gitignored).
- `mimo` — AquaDevs MIMO via `POST /v1/audio/speech` on `api.aquadevs.com` (see below).
- When the selected engine fails (missing key / non-200 / bad content-type), each chunk
  automatically falls back to the other engine (`mimo` ↔ `fish`), so narration never breaks.

### ffmpeg on Vercel

Vercel's Node runtime has NO ffmpeg on PATH, but the whole pipeline (audio conversion,
chunk concat, narration overlay, frame extraction, final combine) shells out to
`execFile('ffmpeg', …)`. All 19 call sites go through `ffmpegBin()` which resolves:
`require('ffmpeg-static')` (bundled per-OS binary, installed via npm — linux-x64 on
Vercel) and falls back to `ffmpeg` on PATH for local dev. `ffmpeg-static` is a regular
dependency (bundled size ~76MB, well under Vercel's 250MB uncompressed function limit).

### MIMO (option + fallback)

MIMO is an explicit **Narration engine** dropdown option and the automatic fallback when
Fish Audio fails. **AquaDevs MIMO TTS** (`mimo-v2.5-tts` via `POST /v1/audio/speech` on
`api.aquadevs.com`):
- An explicit language instruction is ALWAYS sent (even for English) — the MIMO default
  voice `mimo_default` is Chinese-biased and will drift into the wrong language otherwise.
- English uses English-native MIMO voices (`Chloe` female / `Milo` male) instead of `mimo_default`.

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
