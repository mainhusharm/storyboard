'use strict';

// Offline durability/security regression checks. No provider calls or credentials.
// Run: node --test pipeline/test-vault-store.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createVaultStore } = require('../web/vault-store');

async function contents(opened) {
  assert.ok(opened);
  const stream = opened.stream?.getReader ? Readable.fromWeb(opened.stream) : opened.stream;
  const chunks = [];
  if (stream) for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

async function temporary(t) {
  // Windows AppContainer denies atomic renames in its redirected OS temp folder;
  // use a test-owned directory under the writable checkout instead.
  const parent = path.resolve(__dirname, '..');
  const root = await fs.mkdtemp(path.join(parent, '.vault-store-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('.vault-store-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

const asset = (overrides = {}) => ({ userId: 'alice', source: 'storyboard', kind: 'video',
  title: 'My first film', filename: 'film.mp4', mimeType: 'video/mp4', buffer: Buffer.from('0123456789'), ...overrides });

function fakeDatabase() {
  const rows = new Map();
  const database = {
    rows, failInsert: false, calls: [],
    async query(sql, params = []) {
      sql = sql.replace(/\s+/g, ' ').trim();
      database.calls.push({ sql, params });
      if (sql.startsWith('CREATE ')) return { rows: [] };
      if (sql.startsWith('INSERT ')) {
        if (database.failInsert) throw new Error('database write failed');
        const [id, owner_id, source, kind, title, filename, mime_type, size_bytes, created_at, metadata, sha256, blob_url] = params;
        if ([...rows.values()].some(row => row.owner_id === owner_id && row.source === source && row.kind === kind && row.sha256 === sha256)) return { rows: [] };
        const row = { id, owner_id, source, kind, title, filename, mime_type, size_bytes, created_at, metadata: JSON.parse(metadata), sha256, blob_url };
        rows.set(id, row); return { rows: [row] };
      }
      assert.match(sql, /WHERE owner_id = \$1/, 'Every metadata read/delete must be owner scoped');
      let result = [...rows.values()].filter(row => row.owner_id === params[0]);
      if (sql.startsWith('DELETE ')) {
        const row = result.find(row => row.id === params[1]);
        if (row) rows.delete(row.id);
        return { rows: row ? [{ id: row.id }] : [] };
      }
      if (/AND id = \$2/.test(sql)) result = result.filter(row => row.id === params[1]);
      else {
        for (const column of ['source', 'kind', 'sha256']) {
          const match = new RegExp(`AND ${column} = \\$(\\d+)`).exec(sql);
          if (match) result = result.filter(row => row[column] === params[Number(match[1]) - 1]);
        }
        const query = /title ILIKE \$(\d+)/.exec(sql);
        if (query) {
          const needle = params[Number(query[1]) - 1].slice(1, -1).replace(/\\([\\%_])/g, '$1').toLowerCase();
          result = result.filter(row => `${row.title} ${row.filename}`.toLowerCase().includes(needle));
        }
        const cursor = /\(created_at, id\) < \(\$(\d+)::timestamptz, \$(\d+)::uuid\)/.exec(sql);
        if (cursor) {
          const at = params[Number(cursor[1]) - 1]; const id = params[Number(cursor[2]) - 1];
          result = result.filter(row => row.created_at < at || (row.created_at === at && row.id < id));
        }
      }
      result.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
      const limit = /LIMIT \$(\d+)/.exec(sql);
      if (limit) result = result.slice(0, params[Number(limit[1]) - 1]);
      return { rows: result };
    },
  };
  return database;
}

function fakeBlob() {
  const blobs = new Map();
  const api = {
    blobs, uploads: 0, downloads: 0, failPut: false, failDelete: false, ignoreRange: false, publicStore: false,
    async put(name, body, options) {
      assert.equal(options.access, 'private');
      assert.equal(options.allowOverwrite, false);
      if (api.failPut) throw new Error('upload failed');
      let buffer;
      if (Buffer.isBuffer(body)) buffer = Buffer.from(body);
      else {
        const chunks = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk));
        buffer = Buffer.concat(chunks);
      }
      const url = `https://test.${api.publicStore ? 'public' : 'private'}.blob.vercel-storage.com/${name}`;
      assert.ok(!blobs.has(url), 'Uploads must never overwrite');
      blobs.set(url, buffer); api.uploads++;
      return { url };
    },
    async get(url, options) {
      assert.equal(options.access, 'private'); assert.equal(options.useCache, false);
      api.downloads++;
      let buffer = blobs.get(url);
      if (!buffer) return null;
      const headers = new Headers();
      const range = options.headers?.range;
      if (range && !api.ignoreRange) {
        const [, from, to] = /^bytes=(\d+)-(\d+)$/.exec(range);
        headers.set('content-range', `bytes ${from}-${to}/${buffer.length}`);
        buffer = buffer.subarray(Number(from), Number(to) + 1);
      }
      // Real SDK normalizes partial upstream success to statusCode 200.
      return { statusCode: 200, headers, stream: Readable.toWeb(Readable.from([buffer])), blob: { size: buffer.length } };
    },
    async del(url) {
      if (api.failDelete) throw new Error('delete failed');
      blobs.delete(url);
    },
  };
  return api;
}

test('local saves immutable versions, survives restart and never exposes storage paths', async t => {
  const root = await temporary(t);
  const filePath = path.join(root, 'working-film.mp4');
  await fs.writeFile(filePath, 'original film');
  const first = createVaultStore({ root });
  const entry = await first.save(asset({ filePath, buffer: undefined, filename: '../../unsafe\\film.mp4', metadata: { frame: 2 } }));
  assert.equal(entry.filename, 'film.mp4');
  assert.equal(entry.metadata.frame, 2);
  for (const key of ['owner_id', 'sha256', 'blob_url', 'filePath', '_local_path']) assert.ok(!(key in entry));
  assert.equal(entry.url, `/api/vault/${entry.id}/content`);
  await fs.writeFile(filePath, 'next film');
  const restarted = createVaultStore({ root });
  assert.equal(await contents(await restarted.open('alice', entry.id)), 'original film');
  const second = await restarted.save(asset({ buffer: 'a different film' }));
  assert.notEqual(second.id, entry.id);
  assert.equal((await restarted.list('alice')).vault.length, 2);
  assert.equal(await restarted.get('bob', entry.id), null);
  assert.equal(await restarted.open('bob', entry.id), null);
  assert.equal(await restarted.remove('bob', entry.id), false);
  assert.equal((await restarted.list('bob')).vault.length, 0);
});

test('local independent instances serialize concurrent writes and deduplicate repeated polls', async t => {
  const root = await temporary(t);
  const a = createVaultStore({ root }); const b = createVaultStore({ root });
  await Promise.all(Array.from({ length: 35 }, (_, n) => (n % 2 ? a : b).save(asset({ buffer: `version ${n}` }))));
  const repeats = await Promise.all(Array.from({ length: 12 }, (_, n) => (n % 2 ? a : b).save(asset({ buffer: 'the same poll result' }))));
  assert.equal(new Set(repeats.map(entry => entry.id)).size, 1);
  assert.equal((await a.list('alice', { limit: 100 })).vault.length, 36);
  await b.save(asset({ buffer: 'the same poll result', source: 'sjinn' }));
  await b.save(asset({ userId: 'bob', buffer: 'the same poll result' }));
  assert.equal((await a.list('alice', { source: 'sjinn' })).vault.length, 1);
  assert.equal((await a.list('bob')).vault.length, 1);
});

test('local content supports bounded, suffix, open-ended and unsatisfiable Range', async t => {
  const store = createVaultStore({ root: await temporary(t) });
  const entry = await store.save(asset());
  const partial = await store.open('alice', entry.id, { range: 'bytes=2-5' });
  assert.equal(partial.statusCode, 206); assert.equal(partial.length, 4);
  assert.equal(partial.contentRange, 'bytes 2-5/10');
  assert.equal(await contents(partial), '2345');
  assert.equal(await contents(await store.open('alice', entry.id, { range: 'bytes=-3' })), '789');
  assert.equal(await contents(await store.open('alice', entry.id, { range: 'bytes=8-' })), '89');
  assert.equal(await contents(await store.open('alice', entry.id, { range: 'bytes=0-500' })), '0123456789');
  for (const range of ['bytes=30-40', 'bytes=5-4', 'bytes=0-1,4-5', 'bytes=-0', 'words=0-1']) {
    const response = await store.open('alice', entry.id, { range });
    assert.equal(response.statusCode, 416); assert.equal(response.stream, null);
    assert.equal(response.contentRange, 'bytes */10');
  }
  assert.equal(await store.remove('alice', entry.id), true);
  assert.equal(await store.remove('alice', entry.id), false);
  assert.equal(await store.open('alice', entry.id), null);
});

test('local filters, stable pagination, literal search and input validation', async t => {
  const store = createVaultStore({ root: await temporary(t) });
  await Promise.all(Array.from({ length: 9 }, (_, n) => store.save(asset({
    source: n % 2 ? 'flashloop' : 'storyboard', buffer: `entry-${n}`, title: n === 2 ? '100%_Complete' : `Entry ${n}`,
  }))));
  let cursor; const seen = [];
  do {
    const result = await store.list('alice', { limit: 2, cursor });
    seen.push(...result.vault.map(entry => entry.id)); cursor = result.nextCursor;
  } while (cursor);
  assert.equal(seen.length, 9); assert.equal(new Set(seen).size, 9);
  assert.equal((await store.list('alice', { q: '%_' })).vault.length, 1);
  assert.equal((await store.list('alice', { source: 'flashloop', kind: 'video' })).vault.length, 4);
  await assert.rejects(store.list('alice', { cursor: 'bad' }), /cursor/);
  await assert.rejects(store.save(asset({ userId: '' })), /signed-in/);
  await assert.rejects(store.save(asset({ source: 'unknown' })), /source/);
  await assert.rejects(store.save(asset({ mimeType: 'video/mp4\r\nHeader: injected' })), /media type/);
  assert.equal(await store.open('alice', '../../index.json'), null);
});

test('Vercel fails closed without database or private Blob token', async t => {
  const root = await temporary(t);
  delete process.env.BLOB_READ_WRITE_TOKEN;
  const missingToken = createVaultStore({ root, isVercel: true, getDb: async () => fakeDatabase(), blob: fakeBlob() });
  assert.deepEqual(await missingToken.status(), { mode: 'cloud', ready: false, message: 'Vault storage needs BLOB_READ_WRITE_TOKEN from a private Vercel Blob store.' });
  await assert.rejects(missingToken.save(asset()), { code: 'VAULT_NOT_CONFIGURED', statusCode: 503 });
  process.env.BLOB_READ_WRITE_TOKEN = 'test-only-token';
  const missingDb = createVaultStore({ root, isVercel: true, getDb: async () => null, blob: fakeBlob() });
  assert.equal((await missingDb.status()).ready, false);
  await assert.rejects(missingDb.list('alice'), /persistent Postgres/);
  await assert.rejects(fs.access(path.join(root, 'vault')), { code: 'ENOENT' });
});

test('cloud survives fresh instances, protects every owner, paginates and streams private ranges', async t => {
  process.env.BLOB_READ_WRITE_TOKEN = 'test-only-token';
  const root = await temporary(t); const db = fakeDatabase(); const blob = fakeBlob();
  const create = () => createVaultStore({ root, isVercel: true, getDb: async () => db, blob });
  const first = create();
  assert.deepEqual(await first.status(), { mode: 'cloud', ready: true });
  const saved = await first.save(asset());
  const restarted = create();
  assert.equal((await restarted.list('alice')).vault[0].id, saved.id);
  assert.equal(await contents(await restarted.open('alice', saved.id)), '0123456789');
  assert.equal(await restarted.get('bob', saved.id), null);
  assert.equal(await restarted.open('bob', saved.id), null);
  assert.equal(await restarted.remove('bob', saved.id), false);
  assert.equal((await restarted.list('bob')).vault.length, 0);
  const partial = await restarted.open('alice', saved.id, { range: 'bytes=3-6' });
  assert.equal(partial.statusCode, 206); assert.equal(partial.contentRange, 'bytes 3-6/10');
  assert.equal(await contents(partial), '3456');
  blob.ignoreRange = true;
  assert.equal(await contents(await restarted.open('alice', saved.id, { range: 'bytes=4-5' })), '45');
  const downloads = blob.downloads;
  assert.equal((await restarted.open('alice', saved.id, { range: 'bytes=99-' })).statusCode, 416);
  assert.equal(blob.downloads, downloads, 'Reject invalid ranges before fetching');
  await Promise.all(Array.from({ length: 6 }, (_, n) => create().save(asset({ source: 'sjinn', buffer: `cloud ${n}`, title: n === 2 ? '100%_Complete' : `Cloud ${n}` }))));
  let cursor; const seen = [];
  do {
    const result = await restarted.list('alice', { source: 'sjinn', limit: 2, cursor });
    seen.push(...result.vault.map(entry => entry.id)); cursor = result.nextCursor;
  } while (cursor);
  assert.equal(new Set(seen).size, 6); assert.equal(seen.length, 6);
  assert.equal((await restarted.list('alice', { q: '%_' })).vault.length, 1);
  assert.ok(!JSON.stringify(await restarted.list('alice')).includes('.blob.vercel-storage.com'));
  assert.equal(await restarted.remove('alice', saved.id), true);
  assert.equal(await create().get('alice', saved.id), null);
  assert.equal(blob.blobs.size, 6);
});

test('cloud racing polls are idempotent, failed writes clean blobs, failed uploads do not index', async t => {
  process.env.BLOB_READ_WRITE_TOKEN = 'test-only-token';
  const root = await temporary(t); const db = fakeDatabase(); const blob = fakeBlob();
  const store = createVaultStore({ root, isVercel: true, getDb: async () => db, blob });
  const copies = await Promise.all(Array.from({ length: 10 }, () => store.save(asset())));
  assert.equal(new Set(copies.map(entry => entry.id)).size, 1);
  assert.equal(db.rows.size, 1); assert.equal(blob.blobs.size, 1);
  await store.save(asset());
  assert.equal(db.rows.size, 1); assert.equal(blob.blobs.size, 1);
  db.failInsert = true;
  await assert.rejects(store.save(asset({ buffer: 'failed database asset' })), /database write failed/);
  assert.equal(db.rows.size, 1); assert.equal(blob.blobs.size, 1);
  db.failInsert = false; blob.failPut = true;
  await assert.rejects(store.save(asset({ buffer: 'failed upload asset' })), /upload failed/);
  assert.equal(db.rows.size, 1); assert.equal(blob.blobs.size, 1);
  blob.failPut = false; blob.publicStore = true;
  await assert.rejects(store.save(asset({ buffer: 'accidental public bucket' })), /private Vercel Blob/);
  assert.equal(db.rows.size, 1); assert.equal(blob.blobs.size, 1);
  blob.publicStore = false; blob.failDelete = true;
  await assert.rejects(store.remove('alice', copies[0].id), /delete failed/);
  assert.ok(await store.get('alice', copies[0].id), 'Storage failure keeps the metadata for a retry');
});

test('cloud file uploads use an immutable snapshot and close failed upload streams', async t => {
  process.env.BLOB_READ_WRITE_TOKEN = 'test-only-token';
  const root = await temporary(t); const db = fakeDatabase(); const blob = fakeBlob();
  const filePath = path.join(root, 'working.mp4');
  await fs.writeFile(filePath, 'original render bytes');
  const put = blob.put;
  blob.put = async (...args) => {
    // A new render replaces the mutable working file before Blob reads its body.
    await fs.writeFile(filePath, 'the next render');
    return put(...args);
  };
  const store = createVaultStore({ root, isVercel: true, getDb: async () => db, blob });
  const entry = await store.save(asset({ filePath, buffer: undefined }));
  assert.equal(await contents(await store.open('alice', entry.id)), 'original render bytes');
  assert.equal(entry.size_bytes, Buffer.byteLength('original render bytes'));
  blob.failPut = true;
  await assert.rejects(store.save(asset({ filePath, buffer: undefined })), /upload failed/);
  assert.equal(db.rows.size, 1);
});
