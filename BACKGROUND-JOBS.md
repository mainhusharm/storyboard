# Background generation in Flashloop and SJinn

Previously the browser wrote each scene, polled providers, started subsequent
renders and requested final assembly. Vercel hosted the APIs, but laptop sleep
suspended the browser that drove those requests.

The three generation buttons now submit saved, authenticated jobs. Vercel Queues
advances script planning/writing, standalone images, or image → video → scene
preparation → final film. The browser only observes progress. Closing the page,
sleeping the laptop, or losing its network does not stop an accepted cloud job.
Reopen the same studio/source to load Saved generations, including finished
scripts/images and the final film. Cancel stops subsequent work; a provider task
already accepted may continue on its provider.

## Vercel deployment

- Deploy this commit with npm install and npm run build (normal Git integration).
- Use the existing project Postgres DATABASE_URL; the app creates sb_studio_runs.
  Cloud mode refuses temporary disk as a job database.
- vercel.json declares the private studio-generation queue trigger on
  api/studio-worker.js, maxDuration 300. @vercel/queue uses deployment OIDC;
  no queue token or browser session token is persisted in a job.
- Keep existing provider environment variables and private Blob vault setup.
  No provider is changed to make background processing work.
- Check that the deployment succeeds and the queue trigger appears in Vercel.
  If Queues/OIDC access is unavailable, submission returns an explicit error;
  it does not pretend a browser-driven run can continue offline. A failed
  publish retains the job and the same request key can safely retry acceptance.

Official references: https://vercel.com/docs/queues/quickstart and
https://vercel.com/docs/queues/sdk. Queues supports Hobby; published included
usage and limits: https://vercel.com/docs/queues/pricing. Queue operations and
worker function compute consume the project's normal platform allowances.
This implementation uses no cron polling and needs no always-on laptop for
Vercel jobs. It does not alter Storyboard's separate browser queue.

## Durability and limits

Jobs are account-scoped and retained for seven days. A user can have three
active generations. Provider tasks are checkpointed before future polls; up to
four independent video renders can be in flight when chaining is disabled.
Chained films use the prior scene's final frame. Every scene must finish before
assembly; failures do not silently shorten the film. Normalization runs once
per clip to avoid one invocation encoding an entire long film.

The queue provides at-least-once delivery. Database leases prevent simultaneous
steps on one job. Submitted task IDs survive worker cold starts. An expired
lease during an ambiguous paid submission is reported as failed and is not
blindly submitted again. A failed provider, exhausted credit balance or a
platform time limit still requires attention; closing the laptop does not
cause these failures. Jobs have a 24-hour execution ceiling. Source clips and
reference images use existing provider/media hosts and must remain reachable
for subsequent steps. Only final combined videos enter the private vault,
with its existing seven-day expiry and manual deletion.

Old browser-driven generations cannot be adopted retroactively. Refresh after
deployment and start a new saved generation. A queued confirmation means the
server has saved the job and published its first queue message.

Local development persists private jobs beneath ignored studio-jobs/ and runs
steps in the Node server. They recover when that server restarts. A local
server itself cannot run while its host laptop is asleep or powered off.

## Verification

npm run test:studio-jobs runs offline state-machine/restart/lease/cancellation
and real HTTP auth/provider-adapter/ffmpeg/vault tests. Paid provider traffic is
stubbed. The integration test closes every API connection after acceptance,
drives private worker deliveries, reopens the API and streams the resulting
account-owned MP4. Live cloud queue delivery requires a deployed authenticated
job; offline success alone is not a production provider smoke test.
