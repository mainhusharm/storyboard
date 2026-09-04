# Discord Video Bot Bridge

Turns ANY third-party Discord video bot (wan3, happy horse, etc.) into a local HTTP API
without touching the bot or the storyboard code.

Your own bridge bot joins the same server, @-mentions the target bot with your prompt,
watches the channel for its reply, downloads the mp4, and serves it over HTTP.

## One-time Discord setup (~5 min)

1. Go to https://discord.com/developers/applications → **New Application** → name it e.g. `video-bridge`
2. In your app: **Bot** tab → **Reset Token** → copy the token (this goes in `config.json`)
3. On the same Bot tab, enable **MESSAGE CONTENT INTENT** (privileged — required to read the
   target bot's replies). Save.
4. **OAuth2 → URL Generator**: check `bot` scope, permissions `Send Messages` + `Read Message History`,
   open the generated URL and invite the bot into the server where the target video bot lives.
   (You need **Manage Server** permission there — or invite the target bot into your own test server
   if it has a public invite link.)
5. In Discord: Settings → Advanced → **Developer Mode = ON**. Then:
   - Right-click the channel where you talk to the video bot → **Copy Channel ID**
   - Right-click the video bot's profile/avatar → **Copy User ID**

## Configure & run

```
cd discord-bridge
copy config.example.json config.json
:: fill in token, channelId, targetBotId
npm install
npm start
```

## API

### `GET /health`
```json
{ "ok": true, "user": "video-bridge#0123" }
```

### `POST /generate`
```json
{ "prompt": "a cat surfing a big wave, cinematic", "model": "wan3" }
```
→ sends `@videobot make a video with wan3: ...` in the configured channel, waits for the
target bot's reply (mp4 attachment or link), downloads it to `discord-bridge/out/`:

```json
{ "ok": true, "file": "...\\discord-bridge\\out\\video_1725340000000.mp4", "url": "https://cdn.discordapp.com/...", "reply": "..." }
```

Failures return `502` with `{ "ok": false, "error": "..." }`.

Quick test (PowerShell):
```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:5174/generate -ContentType 'application/json' -Body '{"prompt":"a cat surfing a big wave","model":"wan3"}'
```

## Tuning

- `messageTemplate` — how the bridge phrases the request. `@bot` is replaced with a real
  mention of the target bot; adjust the wording to whatever the bot reliably responds to
  (test manually in Discord first). Use `{model}` and `{prompt}` placeholders.
- `timeoutMs` — how long to wait for the video (default 10 min).
- `defaultModel` — used when the request omits `model` (e.g. `wan3`, `happy horse`).
- `apiKey` — if set, requests must send header `x-api-key: <same value>`.
- Requests run one-at-a-time (queued) so bot replies can't get mixed up between generations.

## Wiring into the storyboard later (when you're ready)

The main app stays untouched for now. When you want to integrate, the spot is the video
render call in `web/server.js` (`renderVideo`): POST the frame's motion prompt to
`http://localhost:5174/generate` and copy the returned mp4 into `video/frame_NN.mp4`.
Ask Kilo to do it when ready — it's a small change.

## Caveats

- A bot cannot invoke another bot's `/` slash commands — the @-mention flow is the way.
- Automating your **user** account (self-bot) violates Discord ToS; this bridge uses your
  own bot account, which is the supported path.
- Subject to the target bot's own queue/rate limits — don't hammer it; it's someone else's service.
- Discord CDN links expire — the bridge downloads immediately, so use the local `file` path.
