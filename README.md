# Storyboard Studio

Transforms scripts into production-ready cinematic storyboards with **locked character consistency**, generates frame images, animates them via Grok Video, and combines everything into a single story film via ffmpeg.

## Features

### Storyboard Production
- Multi-phase AI pipeline: script → characters → frames → videos → final film
- Locked character descriptions kept verbatim across every frame for visual consistency
- AI reference portraits via nano-banana-pro
- Frame image generation with img2img anchored to character refs (consistent faces, hair, skin tone, wardrobe)
- Grok Video image-to-video animation per frame
- ffmpeg concatenation into final film
- Multiple LLM fallbacks (Gemini, Kimi, GLM, Mimo) for reliability
- TTS narration via **Fish Audio** (free s2.1-pro-free, default) or **MIMO** (multi-language, male/female voices)

### AI Influencer Studio (`/influencer`)
- Character profile creation with locked description generation
- Reference photo upload + AI portrait generation
- **Auto Create**: one-click Scene → Image → Video pipeline
- Real female influencer trend discovery (TikTok + YouTube Shorts)
- Gemini Vision analysis of trending video frames + captions
- Catbox.moe hosting for img2img/Grok-Video compatible URLs

### Trends Tab (`/trends`)
- Live trending short-form content from TikTok + YouTube Shorts
- Categories: 🎌 Anime, 🤖 AI Generated
- Powered by TrendsMCP live data + yt-dlp + omkar.cloud
- 5-minute cache per category

## Run

```
node web/server.js
```

### Vercel

The API runs as a serverless function (`api/_route.js` → `web/server.js`). Set these env vars
in the Vercel dashboard (Project → Settings → Environment Variables), or via the CLI:

```
vercel env add FISH_API_KEY production
vercel env add PAXSENIX_API_KEY production
```

Without `FISH_API_KEY`, narration falls back to MIMO instead of Fish Audio.

Opens at `http://localhost:5173`.

## Requirements
- Node.js 18+
- Python 3 with `yt-dlp` and `parth-dl` (for trend fetching + Instagram reels)
- ffmpeg on PATH (for video combination + frame extraction)
- API keys in `pipeline/`:
  - `apikey.txt` — PaxSenix (images, video, chat)
  - `fish_apikey.txt` — Fish Audio (TTS, default narration engine)
  - `aqua_apikey.txt` — AquaDevs (MIMO TTS option + fallback)
  - `omkar-key.txt` — TikTok trending API
  - `trendsmcp-key.txt` — TrendsMCP live trends

## Architecture

- `web/server.js` — Zero-dependency Node server (chat, image, video, TTS, trends)
- `web/public/` — SPA frontend (Storyboard, AI Influencer, Trends)
- `pipeline/PaxGen.ps1` — PowerShell CLI for single phases
- `pipeline/Continue-Full.ps1` — Full pipeline CLI
- `storyboard/` — Character/frame state + trend templates
- `frames/` — Generated character refs and frame images
- `video/` — Frame MP4s and final story MP4