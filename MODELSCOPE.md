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

The preset dropdown matches the ModelScope studio: Custom, all five 2K choices, then all five 1K choices with their dimensions and aspect ratios. **2K** is selected initially, following the current studio aspect ratio. Choosing a preset also updates the studio aspect ratio. Previous saved 1K/2K settings are retained. Custom dimensions override the aspect ratio for generated images; final movies keep their selected movie ratio. Each dimension must be a multiple of 8 from 256 to 2688. Character-reference requests use the square preset unless custom dimensions are selected.

Other controls: seed (0–2147483647), randomize seed, enhance prompt, and negative prompt. Turn off seed randomization to reuse a specific seed. Settings are remembered in this browser; no credentials are stored in browser settings. The provider reports the actual generated seed in server progress logs and the Flashloop/SJinn API response.

## Vercel and completion

Storyboard sends each Qwen character/frame in a separate Vercel invocation and carries completed results into the next request. Manual batches and the automatic film pipeline use the same handling. Upload, submission and SSE completion share a bounded time budget. Intermediate images are ignored, because Gradio can emit a placeholder before finishing.

An explicit Gradio error event confirms that an image task failed. Temporary failures now receive up to two automatic retries, after 8 and 20 seconds, using the same prompt, reference uploads, dimensions, seed and other controls. A rejected submission HTTP 429 also retries and respects Retry-After. Authentication, validation, moderation and explicit exhausted-quota errors stop immediately. The generic error event does not prove that a quota was reached; upstream error details are shown when available, with credentials redacted.

A lost or truncated result stream receives up to two GET reconnects to its existing event ID, after 1.5 and 4 seconds. Stream reconnects never submit another generation. Accepted jobs are not automatically resubmitted after a timeout, unresolved stream failure, browser disconnect, ambiguous submission 5xx or lost acknowledgement; the original task may still be running. Uploads, streams, retries and backoff share one bounded request budget, and a new attempt starts only when at least 45 seconds remain after its backoff. A slow request may therefore stop before using both retries.

Successful retry counts appear in the Storyboard console. Completed frames and character references remain intact as the single-image batch continues. Errors preserve the storyboard and finished assets; persistent failures stop the pipeline before videos. ModelScope failures do not change image providers or rewrite prompts.

Only final combined movies are automatically saved to the vault. Qwen images and Gradio links remain working generation assets and are not added to Blob storage individually.

## Verification

Run npm run test:modelscope for offline provider, authenticated HTTP integration, reference uploads, settings, request isolation, Vercel batching, bounded retry/reconnect and frame-4 recovery tests. Existing vault tests remain npm run test:vault. A real reference upload and image-to-image render through web/modelscope.js succeeded on 2026-10-18; Vercel requires its own environment token before deployment can generate.
