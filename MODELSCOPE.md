# Qwen Image 2.1 on ModelScope

Select **Qwen Image 2.1 — ModelScope** under Image model in Storyboard, or i2i Model in Flashloop/SJinn. The latter two share the same studio page. The provider supports text-to-image and image-to-image; existing character-reference photos, scene references and trend images are uploaded as image bytes before generation. Up to 10 references are supported. A failed reference upload is reported instead of silently switching to text-to-image.

## Server configuration

Set **MODELSCOPE_API_TOKEN** to your ModelScope token in Vercel Project → Settings → Environment Variables. Enable Production (and Preview if you use it), then redeploy. MODELSCOPE_TOKEN is accepted as an alias. The token stays on the server; it is never returned in the model list or browser settings.

Local development also reads pipeline/modelscope_token.txt, which is gitignored. It has been configured on this computer. Never commit that file or paste a real token into source code.

The configured studio is https://studio-qwen-qwen-image-2-1.api-inference.modelscope.net. The token must have access to this studio. Provider quotas and availability apply.

## Controls

| Aspect ratio | 1K preset | 2K preset |
| --- | --- | --- |
| 16:9 | 1344 × 768 | 2688 × 1536 |
| 9:16 | 768 × 1344 | 1536 × 2688 |
| 1:1 | 1024 × 1024 | 2048 × 2048 |
| 4:3 | 1184 × 864 | 2368 × 1728 |
| 3:4 | 864 × 1184 | 1728 × 2368 |

These are the studio's named ratio presets. **1K** is the default. Custom dimensions override the aspect ratio for generated images; final movies keep their selected movie ratio. Each dimension must be a multiple of 8 from 256 to 2688. Character-reference requests use the square preset unless custom dimensions are selected.

Other controls: seed (0–2147483647), randomize seed, enhance prompt, and negative prompt. Turn off seed randomization to reuse a specific seed. Settings are remembered in this browser; no credentials are stored in browser settings. The provider reports the actual generated seed in server progress logs and the Flashloop/SJinn API response.

## Vercel and completion

Storyboard sends each Qwen character/frame in a separate Vercel invocation and carries completed results into the next request. Manual batches and the automatic film pipeline use the same handling. Upload, submission and SSE completion share a bounded time budget. Intermediate images are ignored, because Gradio can emit a placeholder before finishing.

Accepted jobs are not automatically resubmitted after a timeout, stream failure or browser disconnect; the original task may still be running. Errors preserve the storyboard and finished assets. Choose a failed phase/frame to retry. ModelScope failures do not silently change image providers.

Only final combined movies are automatically saved to the vault. Qwen images and Gradio links remain working generation assets and are not added to Blob storage individually.

## Verification

Run npm run test:modelscope for offline provider, authenticated HTTP integration, reference uploads, settings, request isolation and Vercel batching tests. Existing vault tests remain npm run test:vault. A real reference upload and image-to-image render through web/modelscope.js succeeded on 2026-10-18; Vercel requires its own environment token before deployment can generate.
