'use strict';

// Content is immutable; only the per-owner index changes. Vercel never writes a
// vault into /tmp: both the database and a private Blob store must be configured.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Readable } = require('stream');
const { finished } = require('stream/promises');

const SOURCES = new Set(['storyboard', 'flashloop', 'sjinn']);
const KINDS = new Set(['script', 'image', 'audio', 'video']);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIME = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:; ?charset=[a-z0-9-]+)?$/i;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function ensureDirectory(directory) {
  for (let attempt = 0; ; attempt++) {
    try { await fsp.mkdir(directory, { recursive: true }); return; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EEXIST'].includes(error.code) || attempt >= 4) throw error;
      if ((await fsp.stat(directory).catch(() => null))?.isDirectory()) return;
      // Windows can transiently reject simultaneous recursive mkdir calls.
      await sleep(15 * (attempt + 1));
    }
  }
}

function unavailable(message) {
  const error = new Error(message);
  error.code = 'VAULT_NOT_CONFIGURED';
  error.statusCode = 503;
  return error;
}

function invalid(message) {
  const error = new Error(message);
  error.code = 'VAULT_INVALID_INPUT';
  error.statusCode = 400;
  return error;
}

function owner(userId) {
  if (typeof userId !== 'string' || !userId.trim() || userId.length > 256) throw invalid('A signed-in user is required.');
  return userId;
}

function ownerHash(userId) { return crypto.createHash('sha256').update(owner(userId)).digest('hex'); }

function filename(value, kind) {
  return String(value || `asset.${kind === 'script' ? 'json' : 'bin'}`)
    .split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').slice(0, 180) || 'asset.bin';
}

function publicEntry(entry) {
  return {
    id: entry.id, source: entry.source, kind: entry.kind, title: entry.title,
    filename: entry.filename, mime_type: entry.mime_type, size_bytes: Number(entry.size_bytes),
    created_at: new Date(entry.created_at).toISOString(), metadata: entry.metadata || {},
    url: `/api/vault/${entry.id}/content`, download_url: `/api/vault/${entry.id}/content?download=1`,
  };
}

function privateBlobUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /^[a-z0-9-]+\.private\.blob\.vercel-storage\.com$/i.test(url.hostname)
      && !url.username && !url.password && !url.port && !url.search && !url.hash;
  } catch { return false; }
}

function metadata(value) {
  let json;
  try { json = JSON.stringify(value || {}); } catch { throw invalid('Vault metadata must be JSON.'); }
  if (Buffer.byteLength(json) > 65536) throw invalid('Vault metadata is too large.');
  const result = JSON.parse(json);
  if (!result || Array.isArray(result) || typeof result !== 'object') throw invalid('Vault metadata must be an object.');
  return result;
}

function filters(options = {}) {
  if (options.source && !SOURCES.has(options.source)) throw invalid('Unknown vault source.');
  if (options.kind && !KINDS.has(options.kind)) throw invalid('Unknown vault type.');
  const limit = Math.min(100, Math.max(1, Number.parseInt(options.limit, 10) || 48));
  let cursor = null;
  if (options.cursor) {
    try {
      cursor = JSON.parse(Buffer.from(String(options.cursor), 'base64url').toString('utf8'));
      if (!ID.test(cursor.id) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cursor.at)
        || !Number.isFinite(Date.parse(cursor.at))) throw new Error();
    } catch { throw invalid('Invalid vault page cursor.'); }
  }
  return { source: options.source, kind: options.kind, q: String(options.q || '').trim().slice(0, 200), limit, cursor };
}

function page(entries, limit, storage) {
  const hasMore = entries.length > limit;
  const result = entries.slice(0, limit).map(publicEntry);
  const last = result[result.length - 1];
  return { vault: result, nextCursor: hasMore ? Buffer.from(JSON.stringify({ at: last.created_at, id: last.id })).toString('base64url') : null, storage };
}

// Only one byte range is accepted. Unknown/multi-range requests receive 416.
function byteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (!match[1] && !match[2]) || !size) return false;
  let start; let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return false;
    end = Math.min(end, size - 1);
  }
  return { start, end, length: end - start + 1, header: `bytes ${start}-${end}/${size}` };
}

function nodeStream(stream) {
  return typeof stream?.getReader === 'function' ? Readable.fromWeb(stream) : stream;
}

// Used only if an origin ignores Range. Streaming avoids buffering large films.
function sliceStream(stream, start, length) {
  return Readable.from((async function* () {
    let offset = 0; let remaining = length;
    for await (const chunk of nodeStream(stream)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const skip = Math.max(0, start - offset);
      offset += buffer.length;
      if (skip >= buffer.length) continue;
      const part = buffer.subarray(skip, skip + remaining);
      if (part.length) { yield part; remaining -= part.length; }
      if (!remaining) break;
    }
  })());
}

function createVaultStore({ root, isVercel = false, getDb = async () => null, blob: injectedBlob } = {}) {
  if (!root) throw new Error('Vault root is required.');
  const base = path.resolve(root, 'vault', 'v2');
  let databaseReady;

  function sdk() { return injectedBlob || require('@vercel/blob'); }

  // Vercel now connects stores using OIDC. The second name supports the
  // custom prefix selected when this project's store was connected.
  function blobOptions() {
    const storeId = (process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN_STORE_ID || '').trim();
    return storeId ? { storeId } : {};
  }

  async function cloud() {
    const hasToken = !!process.env.BLOB_READ_WRITE_TOKEN;
    let hasOidc = false;
    if (blobOptions().storeId) {
      try {
        // Functions receive OIDC in Vercel's request context, not necessarily
        // process.env. Check availability without caching or passing the token;
        // the Blob SDK obtains and refreshes it separately on every operation.
        hasOidc = !!require('@vercel/oidc').getVercelOidcTokenSync();
      } catch { /* A real static read/write token remains a supported fallback. */ }
    }
    if (!hasToken && !hasOidc) throw unavailable('Connect a private Vercel Blob store with BLOB_STORE_ID and Vercel OIDC authentication, or set BLOB_READ_WRITE_TOKEN.');
    if (!databaseReady) {
      databaseReady = (async () => {
        const db = await getDb();
        if (!db?.query) throw unavailable('Vault storage needs a persistent Postgres database (DATABASE_URL).');
        const api = sdk();
        if (!api.put || !api.get || !api.del) throw unavailable('Vault storage needs @vercel/blob with private storage support.');
        await db.query(`CREATE TABLE IF NOT EXISTS sb_vault_assets (
          id UUID PRIMARY KEY, owner_id TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL,
          title TEXT NOT NULL, filename TEXT NOT NULL, mime_type TEXT NOT NULL,
          size_bytes BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL, metadata JSONB NOT NULL DEFAULT '{}',
          sha256 TEXT NOT NULL, blob_url TEXT NOT NULL
        )`);
        await db.query('CREATE INDEX IF NOT EXISTS sb_vault_owner_created ON sb_vault_assets (owner_id, created_at DESC, id DESC)');
        await db.query('CREATE UNIQUE INDEX IF NOT EXISTS sb_vault_owner_content ON sb_vault_assets (owner_id, source, kind, sha256)');
        return { db, api };
      })().catch(error => { databaseReady = null; throw error; });
    }
    return databaseReady;
  }

  async function status() {
    if (!isVercel) return { mode: 'local', ready: true };
    try { await cloud(); return { mode: 'cloud', ready: true }; }
    catch (error) {
      return { mode: 'cloud', ready: false, message: error.code === 'VAULT_NOT_CONFIGURED' ? error.message : 'Cloud vault storage is unavailable. Check the database and private Blob connection.' };
    }
  }

  function userDir(userId) { return path.join(base, ownerHash(userId)); }
  async function readIndex(directory) {
    try {
      const value = JSON.parse(await fsp.readFile(path.join(directory, 'index.json'), 'utf8'));
      if (!Array.isArray(value)) throw new Error('Vault index is corrupt.');
      return value;
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async function writeIndex(directory, entries) {
    const temporary = path.join(directory, `index.${crypto.randomUUID()}.tmp`);
    try {
      await fsp.writeFile(temporary, JSON.stringify(entries), { flag: 'wx', mode: 0o600 });
      for (let attempt = 0; ; attempt++) {
        try { await fsp.rename(temporary, path.join(directory, 'index.json')); break; }
        catch (error) {
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 9) throw error;
          // Antivirus/read handles can briefly prevent atomic replacement on Windows.
          await sleep(25 * (attempt + 1));
        }
      }
    } finally { await fsp.unlink(temporary).catch(() => {}); }
  }
  async function locked(directory, action) {
    await ensureDirectory(directory);
    const lockPath = path.join(directory, 'index.lock');
    const deadline = Date.now() + 35000;
    let lock;
    while (!lock) {
      try { lock = await fsp.open(lockPath, 'wx', 0o600); }
      catch (error) {
        // Windows may report a held/replaced file as EPERM instead of EEXIST.
        if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        // Metadata locks are brief; recover a crashed process's abandoned lock.
        const stat = await fsp.stat(lockPath).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > 120000) await fsp.unlink(lockPath).catch(() => {});
        if (Date.now() > deadline) throw new Error('Vault is busy; please retry.');
        await sleep(15 + Math.random() * 30);
      }
    }
    try { return await action(); }
    finally { await lock.close(); await fsp.unlink(lockPath).catch(() => {}); }
  }

  async function get(userId, id) {
    owner(userId);
    if (!ID.test(String(id))) return null;
    if (isVercel) {
      const { db } = await cloud();
      const result = await db.query('SELECT * FROM sb_vault_assets WHERE owner_id = $1 AND id = $2', [userId, id]);
      return result.rows[0] || null;
    }
    const entry = (await readIndex(userDir(userId))).find(item => item.id === id);
    return entry ? { ...entry, _local_path: path.join(userDir(userId), `${id}.asset`) } : null;
  }

  async function save(input = {}) {
    // Snapshot generated files first: a subsequent render may overwrite the
    // working filename while its previous version is still being archived.
    let temporary;
    try {
      if (input.filePath) {
        owner(input.userId);
        if (isVercel) await cloud();
        temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-vault-'));
        const snapshot = path.join(temporary, 'asset');
        await fsp.copyFile(input.filePath, snapshot, fs.constants.COPYFILE_EXCL);
        input = { ...input, filePath: snapshot };
      }
      return await saveSnapshot(input);
    } finally {
      if (temporary) {
        const resolvedTemp = path.resolve(os.tmpdir());
        if (path.dirname(temporary) !== resolvedTemp || !path.basename(temporary).startsWith('sb-vault-')) throw new Error('Invalid vault staging directory.');
        await fsp.rm(temporary, { recursive: true, force: true });
      }
    }
  }

  async function saveSnapshot(input = {}) {
    const userId = owner(input.userId);
    if (!SOURCES.has(input.source) || !KINDS.has(input.kind)) throw invalid('Unknown vault source or type.');
    if (!MIME.test(String(input.mimeType || 'application/octet-stream'))) throw invalid('Invalid vault media type.');
    if (!!input.filePath === !!(input.buffer !== undefined)) throw invalid('Provide either a file or a buffer to save.');
    const entry = {
      id: crypto.randomUUID(), source: input.source, kind: input.kind,
      title: String(input.title || 'Untitled creation').replace(/[\u0000-\u001f]/g, ' ').slice(0, 240),
      filename: filename(input.filename, input.kind), mime_type: input.mimeType || 'application/octet-stream',
      created_at: new Date().toISOString(), metadata: metadata(input.metadata),
    };
    let buffer;
    const hash = crypto.createHash('sha256');
    if (input.filePath) {
      const stat = await fsp.stat(input.filePath);
      if (!stat.isFile()) throw invalid('The vault source is not a file.');
      entry.size_bytes = stat.size;
      for await (const chunk of fs.createReadStream(input.filePath)) hash.update(chunk);
    } else {
      if (!Buffer.isBuffer(input.buffer) && !(input.buffer instanceof Uint8Array) && typeof input.buffer !== 'string') throw invalid('Invalid vault buffer.');
      buffer = Buffer.from(input.buffer);
      entry.size_bytes = buffer.length;
      hash.update(buffer);
    }
    entry.sha256 = hash.digest('hex');
    if (isVercel) {
      const { db, api } = await cloud();
      const values = [userId, entry.source, entry.kind, entry.sha256];
      const existing = await db.query('SELECT * FROM sb_vault_assets WHERE owner_id = $1 AND source = $2 AND kind = $3 AND sha256 = $4', values);
      if (existing.rows[0]) return publicEntry(existing.rows[0]);
      let uploaded;
      try {
        const uploadBody = buffer || fs.createReadStream(input.filePath);
        try {
          uploaded = await api.put(`vault/v2/${ownerHash(userId)}/${entry.id}/${entry.filename}`, uploadBody, {
            ...blobOptions(), access: 'private', addRandomSuffix: false, allowOverwrite: false, contentType: entry.mime_type,
            ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
          });
        } finally {
          if (!buffer) { uploadBody.destroy(); await finished(uploadBody).catch(() => {}); }
        }
        if (!privateBlobUrl(uploaded?.url)) throw new Error('Vault requires a private Vercel Blob store.');
        const result = await db.query(`INSERT INTO sb_vault_assets
          (id, owner_id, source, kind, title, filename, mime_type, size_bytes, created_at, metadata, sha256, blob_url)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
          ON CONFLICT (owner_id,source,kind,sha256) DO NOTHING RETURNING *`,
        [entry.id, userId, entry.source, entry.kind, entry.title, entry.filename, entry.mime_type, entry.size_bytes,
          entry.created_at, JSON.stringify(entry.metadata), entry.sha256, uploaded.url]);
        if (result.rows[0]) return publicEntry(result.rows[0]);
        // Another request finished the same output while this upload was running.
        await api.del(uploaded.url, blobOptions());
        uploaded = null;
        const winner = await db.query('SELECT * FROM sb_vault_assets WHERE owner_id = $1 AND source = $2 AND kind = $3 AND sha256 = $4', values);
        if (!winner.rows[0]) throw new Error('Vault could not finish saving this asset. Please retry.');
        return publicEntry(winner.rows[0]);
      } catch (error) {
        if (uploaded?.url) await api.del(uploaded.url, blobOptions()).catch(() => {});
        throw error;
      }
    }
    const directory = userDir(userId);
    await ensureDirectory(directory);
    const destination = path.join(directory, `${entry.id}.asset`);
    // Copy before taking the short metadata lock so large files do not block lists/saves.
    try {
      if (input.filePath) await fsp.copyFile(input.filePath, destination, fs.constants.COPYFILE_EXCL);
      else await fsp.writeFile(destination, buffer, { flag: 'wx', mode: 0o600 });
      return await locked(directory, async () => {
        const entries = await readIndex(directory);
        const duplicate = entries.find(item => item.source === entry.source && item.kind === entry.kind && item.sha256 === entry.sha256);
        if (duplicate) { await fsp.unlink(destination); return publicEntry(duplicate); }
        entries.push(entry);
        await writeIndex(directory, entries);
        return publicEntry(entry);
      });
    } catch (error) { await fsp.unlink(destination).catch(() => {}); throw error; }
  }

  async function list(userId, options = {}) {
    owner(userId);
    const filter = filters(options);
    if (isVercel) {
      const { db } = await cloud();
      const clauses = ['owner_id = $1']; const values = [userId];
      if (filter.source) { values.push(filter.source); clauses.push(`source = $${values.length}`); }
      if (filter.kind) { values.push(filter.kind); clauses.push(`kind = $${values.length}`); }
      if (filter.q) {
        values.push(`%${filter.q.replace(/[\\%_]/g, '\\$&')}%`);
        clauses.push(`(title ILIKE $${values.length} OR filename ILIKE $${values.length})`);
      }
      if (filter.cursor) {
        values.push(filter.cursor.at, filter.cursor.id);
        clauses.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
      }
      values.push(filter.limit + 1);
      const result = await db.query(`SELECT * FROM sb_vault_assets WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT $${values.length}`, values);
      return page(result.rows, filter.limit, { mode: 'cloud', ready: true });
    }
    const query = filter.q.toLowerCase();
    const entries = (await readIndex(userDir(userId))).filter(entry =>
      (!filter.source || entry.source === filter.source) && (!filter.kind || entry.kind === filter.kind)
      && (!query || `${entry.title} ${entry.filename}`.toLowerCase().includes(query))
      && (!filter.cursor || entry.created_at < filter.cursor.at || (entry.created_at === filter.cursor.at && entry.id < filter.cursor.id)))
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
    return page(entries, filter.limit, { mode: 'local', ready: true });
  }

  async function remove(userId, id) {
    owner(userId);
    if (!ID.test(String(id))) return false;
    if (isVercel) {
      const entry = await get(userId, id);
      if (!entry) return false;
      if (!privateBlobUrl(entry.blob_url)) throw new Error('Vault content location is invalid.');
      const { db, api } = await cloud();
      // Keep the row on storage failure so a user can retry rather than lose access.
      await api.del(entry.blob_url, blobOptions());
      const result = await db.query('DELETE FROM sb_vault_assets WHERE owner_id = $1 AND id = $2 RETURNING id', [userId, id]);
      return result.rows.length > 0;
    }
    const directory = userDir(userId);
    return locked(directory, async () => {
      const entries = await readIndex(directory);
      if (!entries.some(item => item.id === id)) return false;
      await writeIndex(directory, entries.filter(item => item.id !== id));
      await fsp.unlink(path.join(directory, `${id}.asset`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      return true;
    });
  }

  async function open(userId, id, options = {}) {
    const entry = await get(userId, id);
    if (!entry) return null;
    const range = byteRange(options.range, Number(entry.size_bytes));
    if (range === false) return { entry: publicEntry(entry), stream: null, length: 0, statusCode: 416, contentRange: `bytes */${entry.size_bytes}` };
    const result = { entry: publicEntry(entry), length: range ? range.length : Number(entry.size_bytes), statusCode: range ? 206 : 200 };
    if (range) result.contentRange = range.header;
    if (isVercel) {
      if (!privateBlobUrl(entry.blob_url)) throw new Error('Vault content location is invalid.');
      const { api } = await cloud();
      const content = await api.get(entry.blob_url, { ...blobOptions(), access: 'private', useCache: false,
        ...(range ? { headers: { range: `bytes=${range.start}-${range.end}` } } : {}) });
      if (!content?.stream) return null;
      const returnedRange = content.headers?.get?.('content-range');
      if (returnedRange && (!range || returnedRange !== range.header)) {
        await nodeStream(content.stream).destroy();
        throw new Error('Vault storage returned an unexpected byte range.');
      }
      result.stream = range && !returnedRange ? sliceStream(content.stream, range.start, range.length) : content.stream;
    } else {
      try { await fsp.access(entry._local_path, fs.constants.R_OK); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      result.stream = fs.createReadStream(entry._local_path, range ? { start: range.start, end: range.end } : {});
    }
    return result;
  }

  return { status, save, list, get, remove, open };
}

module.exports = { createVaultStore };
