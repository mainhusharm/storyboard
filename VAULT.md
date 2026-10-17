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
repeated completion polls. Files are retained until explicitly deleted.

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
   refreshed OIDC token and **BLOB_STORE_ID**. The custom-prefix name
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

## Verification

`npm run test:vault` runs offline storage and HTTP integration tests. They cover
account isolation, authenticated downloads, filters/pagination, immutable bytes,
concurrent saves, cold-instance cloud recovery, deletion, partial reads, signed
image tasks and explicit misconfiguration/failure handling. Cloud tests use
injected Postgres/Blob doubles and do not spend generation credits.

Storage API references: [Vercel Blob SDK](https://vercel.com/docs/vercel-blob/using-blob-sdk)
and [private storage](https://vercel.com/docs/vercel-blob/private-storage).
