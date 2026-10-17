# Shared asset vault

Open **/vault** from Storyboard, Flashloop or SJinn. The library automatically
saves generated storyboard/script JSON, character references, scene images,
scene videos, full narration audio and finished films. Filter by tool and file
type, search by title, preview, download, or delete an item.

Each entry belongs to the signed-in account. Media delivery and deletion check
that account on the server. Source labels and filenames cannot grant access to
another account's content. Every file is copied before it is indexed; generating
again or cleaning working outputs cannot overwrite an archived version. Exact
duplicate bytes from the same tool and file type share one entry, including
repeated completion polls. Files are kept for **7 days from creation** and can be deleted manually sooner.
The UI shows expiry dates and the total bytes belonging to your account. This is
not the total usage of a Blob store shared with other accounts or applications.

## Local development

Run `npm install`, then `npm start`. Sign in and generate normally. The library
stores files and per-account metadata beneath the gitignored `vault/v2/` folder.
Local storage persists across server restarts on this computer. It does not sync
automatically to the deployed app. `STORYBOARD_DATA_DIR` can select another local
data directory; back it up along with the app's account data.

## Vercel setup

1. Connect a Postgres database (for example Neon) to the Vercel project and set
   **DATABASE_URL**. This is also the existing application's account database.
2. In the project's **Storage** tab, create and connect a **private Vercel Blob**
   store for Production and Preview. Vercel authenticates with its automatically
   refreshed OIDC token and **BLOB_STORE_ID**. In Functions the token is supplied
   through the request context; it does not have to appear as a manually added
   VERCEL_OIDC_TOKEN environment variable. The official runtime helper detects it. The custom-prefix name
   **BLOB_READ_WRITE_TOKEN_STORE_ID** is also supported. Keep those generated
   names unchanged; neither the store id nor a webhook public key is a secret
   read/write token. Legacy **BLOB_READ_WRITE_TOKEN** authentication still works.
   A public Blob store is rejected by the vault.
3. Keep **SESSION_SECRET** stable across deployments and instances so account
   sessions and signed image-completion tickets remain valid.
4. Deploy the changes using the existing `npm run build` command and Node 24
   (Node 20 or later is required by the Blob SDK).
5. Sign in and open `/vault`. Its status should report cloud storage ready.
   Generate a small output, confirm it appears, then check it again after a
   deployment or from another browser signed into the same account.

The application creates `sb_vault_assets` and its indexes automatically. Your
database role needs schema creation permission. Postgres holds searchable,
account-scoped metadata; private Blob holds the actual immutable bytes. No
permanent asset relies on Vercel `/tmp`, localStorage or a provider's temporary
download link. `/tmp` is used only while the generation request is active.

The server streams authenticated media, including byte-range responses for video
seeking. Browser previews use authenticated fetches and temporary object URLs,
which also support the existing bearer-token fallback when cookies are missing.
Generating media still uses the app's existing provider-hosting paths for
generation/chaining; vault copies are separately protected.

Missing cloud configuration or a failed save is shown explicitly. A generation
that succeeds but cannot be archived still returns its output with a
`vault_warning`; download that result before leaving the page and fix storage
before relying on automatic archiving. Storage is not provisioned by this code.

Existing unscoped `vault/index.json` records and browser `sb_vault` history are
left intact but are not assigned to an account automatically: the old format has
no reliable ownership information. The new library automatically captures new
outputs; it does not scan unrelated files or recover expired temporary links.

## Seven-day retention and freeing storage

Every asset has a seven-day lifetime, including existing v2 assets. Cleanup deletes
both the stored Blob/file bytes and metadata; removing a card is not the cleanup.
Newer files are retained. Identical bytes generated again after expiration receive
a new entry and seven-day lifetime.

Expired files are removed when you open the vault or save a new generation.
The application also declares a daily Vercel Cron job at /api/vault-cleanup.
Daily execution works on the Hobby plan. Files become eligible after seven days
and the daily run removes them afterwards, so physical deletion can occur on the
next day's run. Failed deletions keep their records and retry on later cleanup.
Requests and batches are bounded so large backlogs resume across runs.

**Enable cleanup while the app is closed:**

1. In Vercel, open Project → Settings → Environment Variables.
2. Add **CRON_SECRET** for **Production**, using a random value of at least 16
   characters. Do not use an account password or a provider API key.
3. Redeploy. Vercel automatically sends the secret to its daily cleanup invocation.
4. The vault will show that daily background cleanup is active. Scheduled runs
   appear under Project Settings → Cron Jobs.

Without CRON_SECRET the cleanup endpoint rejects every request; opening/saving
still clears expired assets for the signed-in account. A normal login/session
cannot call the cross-account cleanup route. Its cutoff is fixed on the server;
callers cannot provide a shorter age or delete younger files through query inputs.

Use the visible **Delete** button on a card to free storage immediately. Download
anything you want to keep before its expiry. Manual deletion updates the displayed
usage. This policy does not guarantee that every workload fits within 1 GB during
the seven-day window; you can delete larger items earlier.

Vercel references: [securing cron jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs)
and [Hobby scheduling limits](https://vercel.com/docs/cron-jobs/usage-and-pricing).

## Verification

`npm run test:vault` runs offline storage and HTTP integration tests. They cover
account isolation, authenticated downloads, filters/pagination, immutable bytes,
concurrent saves, cold-instance cloud recovery, deletion, partial reads, signed
image tasks and explicit misconfiguration/failure handling. Cloud tests use
injected Postgres/Blob doubles and do not spend generation credits.

Storage API references: [Vercel Blob SDK](https://vercel.com/docs/vercel-blob/using-blob-sdk)
and [private storage](https://vercel.com/docs/vercel-blob/private-storage).
