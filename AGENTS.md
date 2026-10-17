# Storyboard Production Project

Transforms scripts into production-ready cinematic storyboards with **locked character
consistency**, generates frame images, animates them via Grok Video / Omni Flash (8s)
/ Veo 3.1 with auto-fallback, and combines everything into a single story film via ffmpeg.

## Layout

- `script.txt`              — source script (user-provided)
- `storyboard/characters.json` — locked character profiles (id, name, age, description, reference_prompt)
- `storyboard/frames.json`  — master storyboard: one object per frame
- `web/server.js`           — zero-dep Node web server (the app)
- `web/public/home.html`     — public landing page (served at `/`)
- `web/public/storyboard.html` — Storyboard SPA (`/storyboard`); no `index.html` so `/` is not shadowed
- `web/public/auth.js`       — shared client auth guard (retry + bearer fallback)
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
- **Shared asset vault** — /vault automatically stores scripts/storyboard JSON,
  character references, generated scene images/videos, full narration and final films
  from Storyboard, Flashloop and SJinn. web/vault.js owns AsyncLocalStorage request
  ownership, capture hooks, signed provider-task completion and authenticated delivery;
  web/vault-store.js owns immutable storage and metadata. Local development uses
  per-account files beneath gitignored vault/v2/; Vercel requires Postgres
  (DATABASE_URL) + a PRIVATE Vercel Blob store (OIDC + BLOB_STORE_ID, or legacy
  BLOB_READ_WRITE_TOKEN; custom BLOB_READ_WRITE_TOKEN_STORE_ID is supported). It never
  falls back to /tmp or browser localStorage for durable cloud assets. Saves complete
  before synchronous responses; failures preserve generation output and surface
  vault_warning. GET /api/vault lists the signed-in account only; DELETE
  /api/vault/:id and GET /api/vault/:id/content enforce the same owner, including
  byte-range reads. All distinct bytes are retained until deleted; exact duplicate
  polls deduplicate per owner/source/type. The old unowned vault index is left intact
  and not automatically assigned. Setup and tests: VAULT.md, npm run test:vault.
- **AquaDevs image models in Storyboard** — the image-model dropdown offers `aqua:nanobanana-pro`
  ("Nano Banana Pro — AquaDevs") and `aqua:agnes-image` ("Agnes Image — AquaDevs").
  `submitTask`/`submitImg2ImgTask` intercept `aqua:` ids before the PaxSenix path and render via
  `generateAquaImage` (POST /v1/images/generations; ratio maps 1:1→square, 16:9/4:3→landscape,
  9:16/3:4→portrait; direct models answer with a URL, task models poll — both handled). Per the
  AquaDevs docs the `image` param accepts a URL **or base64**, so img2img character-consistency
  anchors pass the reference BYTES inline (no re-host round-trip). The finished bytes come back
  behind the `logfare-local:` marker, so the whole submit→wait→download ladder, the emergency
  still chain, and the hosting-on-Vercel behaviour are unchanged.
- **Vercel: videos render ONE FRAME PER REQUEST** — on Vercel a serverless invocation dies at
  300s, so a whole-board synchronous `/api/videos` always times out. The client detects Vercel via
  `/api/health` and loops frames one-per-request (`runVideosVercel`), passing the previous frame's
  `chain_image_url` back as `chainAnchor` so seamless chaining survives across invocations. The
  server caps the render wait at ~270s of the budget (`vercelBudgetDeadline`), truth-checks the
  mp4 on disk before reporting success (`video_path`), and returns `{ok:false, failed}` when the
  budget was exhausted; the client then retries the frame once. `vercel.json` rewrites `/frames/*`
  and `/video/*` to `/api/_route?p=...` so rendered assets are reachable. Regression-test with
  `node pipeline/test-vercel-video.js` (self-hosts the handler in Vercel mode).
- **Two-phase video render for Wan models (no more `/videos: timed out (n/12)`)**:
  a wan clip renders 4-30 min — far past a serverless request — so on Vercel
  `/api/videos` never awaits it for Novita models. It submits and answers
  `202 {pending:true, task:"novita:task:<id>"}`; the client re-posts `{pollTask}`
  every 15s (45-min ceiling per frame) and each poll is a fresh invocation
  (`novitaPollOnce` answers immediately — no blocking wait). Polls skip the busy
  guard AND the credit gate (charged on submit only — the old timeout-retry loop
  re-submitted a NEW paid render every retry). Completion extracts + hosts the
  chain anchor and the clip exactly like the synchronous path, so seamless
  chaining and the clipUrls handoff to combine are unchanged. PaxSenix models
  (grok/omni/veo) keep the synchronous per-frame path (they fit the budget).
- **Combine never loses a frame's image** — when a frame has no local video AND no
  local image (typical on Vercel, where every invocation has its own `/tmp`, or after
  an archived run), `combineFilm` first re-downloads the frame's OWN stored
  `generated_image_url` (the real rendered still — zero credits) and only if that
  fails generates an emergency still through an IMAGE MODEL CHAIN
  (`emergencyImageChain(opts.imageModel)`): the user's selected image model → Logfare
  `flux-2-klein-9b` (independent quota — keeps working on a day when PaxSenix answers
  `image_quota_exceeded`) → `nano-banana-pro`. The old code hardcoded PaxSenix
  nano-banana, so a quota-blocked day turned every un-locatable frame into a skipped
  blank. The client sends `imageModel` with `/api/combine` and the run-all combine step.
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

## Novita sandbox (wan3.0 video + qwen/wanx image models)

Async-job API used as an ADDITIONAL video/image provider (models appear alongside the
PaxSenix ones in every dropdown; the selected model still runs ALONE — no hidden fallback).

- **Key/base**: env `NOVITA_API_KEY` or `pipeline/novita_apikey.txt` (gitignored). The base is an
  ephemeral sandbox host (`https://3000-….sandbox.novita.ai`) — override with env `NOVITA_BASE_URL`
  (Vercel) or `pipeline/novita_base.txt` (local, gitignored) when it rotates.
- **API shape** (docs 2026-10): `POST {base}/v1/submit` (1 credit) → `{ok, taskId, status:"PENDING"}`;
  `GET {base}/v1/status/{taskId}` (free) → `{taskId, status: PENDING|RUNNING|SUCCEEDED|FAILED,
  elapsed, output:{…}}`. The documented result location is **`output.results[0].url`**, but models
  differ (`output.video_url`, `output.url`, `output.image_url`, `output.images[]`), so
  `novitaResultUrl()` checks all of them and falls back to a media-URL regex. Submit failures ≥400
  are permanent (fail fast, no retry — the sandbox's flaky TLS gets exactly one retry). Submitted
  jobs are returned as a `novita:task:<id>` marker that `waitTask` routes to `novitaWait` (mirrors
  the `logfare-local:` pattern), so all existing submit→wait→download call sites work unchanged.
- **Video models** (`VIDEO_MODELS`): `wan3.0-video-prime`, `wan3.0-video-standard`, `wan3.0-video`
  (durations 1,2,3,4,5,10,15,20,25,30 — any other value snaps to the nearest allowed), `wan2.7-t2v`,
  `wan2.1-t2v-turbo`, `wan2.1-t2v-plus` (1-15s), plus I2V models `wan2.7-i2v`, `wan2.1-i2v-turbo`,
  `wan2.1-i2v-plus`. Body: `{model, input:{prompt}, parameters:{duration, resolution:"720P", ratio}}` —
  the ratio param is `parameters.ratio` (NOT `aspect_ratio`); ratios 1:1, 16:9, 9:16, 4:3, 3:4 all
  accepted (the storyboard UI gained 4:3/3:4 options; PaxSenix models still snap them to 16:9).
- **I2V**: the start frame goes in a TOP-LEVEL `imageUrls` array and ONLY with an I2V model —
  t2v wan models have NO image input, so selecting one disables the image anchor and seamless
  chaining degrades to prompt-only (logged). Flashloop/SJinn Make Video passes the scene length
  as `duration` and honours the chain anchor with i2v engines.
- **Make Video clip persistence (serverless-safe)**: `/api/flashloop/generate-video` now uploads the
  finished clip and returns a hosted `clip_url`; the client passes `clipUrls` to
  `/api/flashloop/combine`, which re-downloads any clip missing from its own instance. Without
  this, combine hit `no scene clips found on this instance` whenever the two requests landed on
  different Vercel instances (each writes `video/flash_scene_NN.mp4` to its own `/tmp`).
- **Final film is hosted too**: combine uploads `flash_final.mp4` and returns it as `clip_url` /
  `hosted_url`; the studio plays that URL, not `/video/flash_final.mp4`. Same serverless reason —
  the local path exists only on the instance that ran combine. Combine honours every ratio
  (16:9→1280x720, 9:16→720x1280, 1:1→1024x1024, 4:3→1024x768, 3:4→768x1024) instead of forcing
  everything except 9:16 to 16:9.
- **Duration / ratio controls**: Make Video has a three-column picker — **① Model** (grouped by
  family: Omni Flash, Wan 3.0, Wan 2.x T2V, Wan 2.x I2V), **② Aspect Ratio** and
  **③ Duration (per scene)**. Scene Length lists the full Wan 3.0 set (1,2,3,4,5,10,15,20,25,30)
  and the engine picker auto-clamps it (omni-flash fixed 8s, Wan 3.0 snaps to the nearest allowed
  value, Wan 2.x capped at 15s), with a live one-line summary of scenes × duration × ratio × total
  runtime. ③ Duration is the source of truth and mirrors into the hidden `#sceneLength` the scene
  planner reads, so prompts and renders always agree on clip length.
- **Two-phase Vercel render (no 504s)**: a wan clip renders for 4-30 minutes, far past a
  serverless request, so on Vercel `generate-video` never awaits the render. It submits the job and
  answers `202 {pending:true, task:"novita:task:<id>"}`; the client re-posts `{pollTask}` every 15s
  (cap 45 min) and each poll is a fresh invocation, so no single request times out. A poll that
  finds the job still rendering answers `504 {pending:true}` — the client treats `pending` as "keep
  waiting", not as a failure. Locally (and for omni-flash) the old synchronous path is kept.
  Credits are charged on submit only, never again while polling.
- **Parallel or chained**: Make Video has a "Seamless chaining" checkbox. OFF (default) renders all
  scenes in PARALLEL (max 4 concurrent) from their own first-frame images, shows every scene clip
  inline for inspection, then combines. ON renders sequentially with each scene anchored to the
  previous scene's last frame.
- **Image models** (`novita:` prefix, e.g. `novita:qwen-image-3.0-pro`): `qwen-image-3.0-pro`,
  `wan2.7-image-pro`, `wanx2.1-t2i-turbo`, `wanx2.1-t2i-plus`. Sizes are W*H strings mapped from
  the app ratio (16:9→`1280*720`, 9:16→`720*1280`, 1:1→`1024*1024`, 4:3→`1024*768`, 3:4→`768*1024`);
  image-to-image references go in top-level `imageUrls` (local `/frames/` + logfare-local refs are
  re-hosted first). Storyboard images (t2i + consistency img2img) and the Flashloop i2i route both
  support them; the Flashloop route awaits the task server-side and answers `{imageUrl}` directly.
- **Verified live**: t2v render (1280x720 h264, 5s ≈ 99s render), 30s duration accepted, i2v submit
  accepted, qwen image render (1280*720 PNG). Note: a wan3.0 30s clip can outgrow Vercel's 300s
  function budget — long wan renders are a local-pipeline feature.
- Regression test: `node pipeline/test-novita-video.js` (offline: model lists, duration clamping,
  ratio→size mapping, `/api/models` payload; `--live` submits one 5s wan3.0-video-prime render).

## Logfare media (image models + narration TTS)

Logfare is also a **chat/prompt backend** available from the Storyboard, not just SJinn/Flashloop:
`chatCompletion()` routes any `logfare:<model>` id through `chatWithLogfareFallback()` (pinned
model → `logfare/auto` → `gemma-4-26b` → PaxSenix as last resort), so the Storyboard's chat-model
dropdown offers `logfare:deepseek-v4.1-flash` — displayed as "DeepSeek V4.1 Flash — Logfare" with
the raw id as the option value — and behaves exactly like the SJinn/Flashloop picker. Without that
branch the raw id would be POSTed to PaxSenix and 400. Note the gateway logs request content, so
nothing reaches it unless a Logfare model is explicitly selected.

Logfare's OpenAI-compatible gateway also serves the image models and Deepgram
Aura-2 TTS that the **image model** dropdowns offer — Logfare is no longer a
prompt-writing-only backend. Shapes verified live against `logfare.ai/v1`:
- `POST /images/generations` `{ model, prompt }` → `{ data:[{ b64_json }] }` (JPEG,
  base64 only — there is **no URL** to fetch).
- `POST /images/edits` **multipart** (`model`, `prompt`, `image` file) → same shape.
  This is the Logfare img2img path (character consistency anchors). A JSON body
  with an image URL is rejected (`Missing 'model' field`).
- `POST /audio/speech` `{ model:'aura-2-en', input, voice, response_format:'mp3' }`
  → raw mp3 bytes.
- **Aspect ratio**: `size` / `ratio` / `aspect_ratio` are IGNORED — most models
  answer 1024x1024 (`lucid-origin` happens to return 1120x630), so every render is
  centre-cropped to the requested ratio with ffmpeg (`cropToRatio`) before storage.
- Models: `flux-2-klein-9b`, `lucid-origin`, `phoenix-1.0` (`LOGFARE_IMAGE_MODELS`,
  added to `/api/models` → `image`). `/v1/models` also lists `flux-2-klein-4b`,
  `flux-2-dev`, `flux-1-schnell`, `sdxl-lightning` and `melotts` (unused so far).
- **No task to poll**: a Logfare render is one blocking POST that returns the
  finished bytes, so `submitTask`/`submitImg2ImgTask` hand the pipeline an
  already-finished local file behind the `logfare-local:<path>` marker; `waitTask`
  returns it as-is and `download()` copies it into place. The Flashloop/SJinn i2i
  route re-hosts the render to catbox/uguu instead, because the browser `<img>` and
  the Make Video stage need a public URL.
- `imageEndpoint()`/`img2ImgEndpoint()` know nothing about these ids — the Logfare
  branch intercepts before them, so the PaxSenix paths are untouched.
- Regression test: `node pipeline/test-logfare-models.js` (offline: model lists,
  `/api/models` payload, crop shapes, engine list; `--live` also renders one image
  per model and one TTS chunk).

## Flashloop/SJinn character references

The Flashloop studio's **Character References** list (name + description + optional
photo) is posted to `/api/flashloop/generate-prompt`; the names/descriptions are
injected into both the img2img and img2video prompts.
- `POST /api/flashloop/upload-ref` `{ dataUrl }` (png/jpg/webp base64, ≤8MB) stores the
  photo as `frames/ref_*.png`, re-hosts it to catbox/uguu and returns `{ url, local }`.
  `refImageBuffer()` reads the local `/frames/...` path straight off disk (or a
  `logfare-local:` render, or an http URL), so a reference works offline and on a
  Vercel cold instance; `cleanOutputs()` never archives `ref_*.png`.
- The first NAMED reference with a photo becomes the i2i anchor for the scene image
  and for every Make Video scene (`refAnchorUrl()`); with no photo the trend
  thumbnail anchors the style, exactly as before.
- The **+ Add @Reference** button had NO click handler (the list only ever rendered
  its empty state); it now appends a row with a 📷 photo picker.

## Fresh trends (Tavily)

`tavilySearch()` queries `topic: 'news'` with a 7-day `days` recency window first so trend terms
come from freshly-published articles (not evergreen listicles), then falls back to `general` web
search when news returns nothing (niche categories). Results are additionally filtered by
`published_date` when present. `tavilyTrendTerms()` queries for "this week" trends and pulls from
up to 10 results.

## Narration TTS engines (Fish Audio default · MIMO · Logfare Aura-2)

Storyboard narration picks an engine from the **Narration engine** dropdown
(`/api/models` → `narrationEngines`): `fish` (default) | `mimo` | `logfare`.
Every chunk runs through an **engine chain**: the selected engine first, then the
other engines as automatic fallbacks, so narration never breaks.
- `logfare` — **Deepgram Aura-2** (`aura-2-en`) through Logfare
  (`POST https://logfare.ai/v1/audio/speech` with `{ model, input, voice,
  response_format:'mp3' }` → raw mp3 bytes, no polling). Voices: female `luna`,
  male `orion`. **English only** — Aura-2-en is an English model, so non-English
  narration skips this engine and uses Fish Audio / MIMO.
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
  walks the rest of the engine chain (`fish` → `mimo` → `logfare`), so narration never breaks.

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
- **Pages**: `/` → `home.html` (PUBLIC landing page; visitors see the product + a signup
  funnel, no auth), `/login` (login + signup tabs; `?mode=signup` opens Create-account),
  `/storyboard` → `storyboard.html`, plus `/influencer`, `/trends`, `/flashloop-studio`.
  All tool pages are protected. There is NO `index.html` (a static index would shadow `/`).
- **Signup funnel**: home's tool cards are gated and link to `/login?mode=signup&next=<tool>`;
  anonymous deep-links to a tool also land on the signup tab. Signed-in users get the cards
  unlocked, a "Welcome back" hero and an "Open Studio" header instead.
- **Local server**: tool pages are gated server-side (`requirePageAuth` → 302 to
  `/login?mode=signup&next=...`), and every `/api/*` route (except `/api/health`, `/api/models`,
  `/api/status`, `/api/auth/*`) requires a valid session via `requireApiAuth`.
- **Vercel**: pages are served statically, so protection is client-side — each tool page uses
  the shared `auth.js` guard (retries transient failures, redirects only on a real 401, and
  falls back to a Bearer token if the cookie is dropped); the API stays server-gated.
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

Storyboard frame count is `storyboardFrameCount(target, clipDuration)` = exactly
target ÷ clip duration with a minimum of 1 (1-minute target + 30s Wan 3.0 clips →
**2** frames/renders). The old hard minimum of 3 silently overrode small picks — a
60s/30s board rendered three 30s clips (a 1:30 film instead of the requested 1:00).
Regression test: `node pipeline/test-fullfilm-fixes.js` (offline).

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
