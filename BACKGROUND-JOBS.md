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
Vercel jobs. Storyboard full-film jobs now use the same queue.

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

## Multiple stories at once

Use New story in Flashloop or SJinn to open another draft while accepted jobs
keep running. Name each story and switch between saved stories in the selector.
Generate several stories at once accepts up to three ideas separated by --- on
its own line. The account limit remains three active background jobs across both
studios; a rejected fourth request leaves accepted jobs running. Image jobs save
their parent script so reopening a result restores the correct story context.

Storyboard has a separate Parallel stories page at /generations. It accepts
bulk scripts with the same separator and runs three films together on Vercel
(one locally), isolating output files, board caches and progress by account/run.
Accepted Vercel films run in cloud workers. Keep that page open only to submit drafts still waiting for a free slot.
Use /tasks for named progress and cancellation across the studios.

## Storyboard full films and recovery

New Vercel Create Full Film and Combine actions save a Storyboard cloud job.
Every reference, image, scene narration, submitted video task and prepared clip
is checkpointed in Postgres. The browser can close and the laptop can turn off
after acceptance. Reopen the film through /tasks or /generations to view its
saved board, settings, progress and result. Cloud jobs share the three-active-job
limit with Flashloop/SJinn. Individual manual phase actions remain browser calls.

Normalization runs once per scene in its own delivery. It retains source audio,
bounds the cut to the selected scene duration and fits narration without extending
the video. Assembly joins these prepared clips without normalizing the entire
film again. A provider or host failure is still actionable; offline fixture
success cannot prove live provider access or production queue delivery.

Old Browser connection / connection lost cards describe older browser-driven
runs. They cannot become durable automatically. If the original page still has
all hosted scene clips, refresh and click Combine to queue recovery without
regenerating images or videos. Missing clip URLs need attention first. Previously
finished images and clips cannot change visual style without being re-rendered.
