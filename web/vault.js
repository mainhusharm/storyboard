// Request-scoped capture and authenticated delivery for the shared asset library.
const { AsyncLocalStorage } = require('node:async_hooks');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const { createVaultStore } = require('./vault-store');

const SOURCES = new Set(['storyboard', 'flashloop', 'sjinn']);
const MIME = { '.json': 'application/json', '.txt': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4' };

function createVault(options) {
  const context = new AsyncLocalStorage();
  const store = options.store || createVaultStore(options);
  const warnings = new Map();
  const log = options.log || (() => {});

  function warning(error) {
    const scope = context.getStore();
    const message = 'This output could not be saved to your vault. ' + String(error.message || error);
    if (scope) {
      scope.warning = message;
      if (scope.userId) {
        warnings.set(scope.userId, { message, at: Date.now() });
        if (warnings.size > 500) warnings.delete(warnings.keys().next().value);
      }
    }
    log('vault: ' + message);
  }

  async function capture(input) {
    if (input.kind !== 'video' || input.metadata?.stage !== 'final') return null;
    const scope = context.getStore();
    if (!scope?.userId) return null; // Never infer ownership from shared disk or global job state.
    try {
      const remaining = scope.deadline - Date.now();
      if (options.isVercel && remaining < 3000) throw new Error('The render used the available server time. Download this result now.');
      const entry = await store.save({ ...input, userId: scope.userId, source: scope.source,
        title: input.title || scope.title || 'Untitled creation',
        abortSignal: options.isVercel ? AbortSignal.timeout(Math.max(1, Math.min(45000, remaining - 1500))) : undefined });
      scope.saved.push(entry);
      return entry;
    } catch (error) { warning(error); return null; }
  }

  function captureFile(filePath, kind, title, metadata = {}) {
    return capture({ filePath, kind, title, filename: path.basename(filePath), mimeType: MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream', metadata });
  }

  function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  async function handle(req, res, url) {
    const p = url.pathname.replace(/\/$/, '');
    if (!p.startsWith('/api/vault')) return false;
    const userId = req.user?.id;
    if (!userId) { json(res, 401, { error: 'auth required' }); return true; }
    try {
      if (p === '/api/vault/status' && req.method === 'GET') {
        const storage = await store.status();
        const recent = warnings.get(userId);
        json(res, 200, { ...storage, last_warning: recent && Date.now() - recent.at < 86400000 ? recent.message : undefined });
      } else if (p === '/api/vault' && req.method === 'GET') {
        json(res, 200, await store.list(userId, Object.fromEntries(url.searchParams)));
      } else if (p === '/api/vault/capture-task' && req.method === 'POST') {
        // Older browser tabs may still send completion tickets for images.
        json(res, 200, { ok: true, skipped: true });
      } else {
        const match = /^\/api\/vault\/([a-zA-Z0-9_-]+)(\/content)?$/.exec(p);
        if (!match) { json(res, 404, { error: 'Vault endpoint not found.' }); return true; }
        if (!match[2] && req.method === 'DELETE') {
          const removed = await store.remove(userId, match[1]);
          json(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'Asset not found.' });
        } else if (match[2] && (req.method === 'GET' || req.method === 'HEAD')) {
          const result = await store.open(userId, match[1], { range: req.headers.range });
          if (!result) { json(res, 404, { error: 'Asset not found.' }); return true; }
          const filename = String(result.entry.filename || 'download').replace(/[\r\n]/g, '');
          const headers = { 'Content-Type': result.entry.mime_type, 'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes', 'Content-Length': result.length,
            'Content-Disposition': (url.searchParams.get('download') === '1' ? 'attachment' : 'inline')
              + '; filename="' + filename.replace(/[^\x20-\x7e]|["\\]/g, '_') + '"; filename*=UTF-8\'\'' + encodeURIComponent(filename) };
          if (result.contentRange) headers['Content-Range'] = result.contentRange;
          res.writeHead(result.statusCode || 200, headers);
          let stream = result.stream;
          if (stream && typeof stream.getReader === 'function') stream = Readable.fromWeb(stream);
          if (req.method === 'HEAD' || !stream) { stream?.destroy(); res.end(); }
          else await pipeline(stream, res);
        } else json(res, 405, { error: 'Method not allowed.' });
      }
    } catch (error) {
      if (res.headersSent) res.destroy(error);
      else json(res, error.statusCode || error.status || 503, { error: error.message, code: error.code || 'VAULT_UNAVAILABLE' });
    }
    return true;
  }

  async function handleCleanup(req, res) {
    if (req.method !== 'GET') { json(res, 405, { error: 'Method not allowed.' }); return; }
    const secret = process.env.CRON_SECRET || '';
    const expected = Buffer.from('Bearer ' + secret);
    const supplied = Buffer.from(typeof req.headers.authorization === 'string' ? req.headers.authorization : '');
    if (!secret || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      json(res, 401, { error: 'Unauthorized cleanup request.' }); return;
    }
    try {
      const result = await store.purgeExpired(undefined, { limit: 2000, deadline: Date.now() + 240000 });
      json(res, result.failed || result.has_more ? 503 : 200, { ok: !result.failed && !result.has_more, ...result });
    } catch { json(res, 503, { error: 'Vault cleanup could not finish. It will retry on the next scheduled run.' }); }
  }

  async function prepareResponse(code, data) {
    const scope = context.getStore();
    if (!scope || !scope.userId || !data || typeof data !== 'object') return data;
    // Job/status objects are reused by the legacy pipeline. Do not attach one
    // account's save results to a shared object and leak them in a later request.
    data = { ...data };
    const recent = warnings.get(scope.userId);
    if (scope.warning || (scope.route === '/api/status' && recent && Date.now() - recent.at < 86400000)) {
      data.vault_warning = scope.warning || recent.message;
    }
    if (scope.saved.length) data.vault_saved = scope.saved.map(e => e.id);
    return data;
  }

  return { store, context, handle, handleCleanup, capture, captureFile, prepareResponse,
    run: fn => context.run({ userId: null, source: 'storyboard', title: '', saved: [], deadline: Date.now() + 285000 }, fn),
    setUser(user, route) { Object.assign(context.getStore(), { userId: user.id, route, source: route.startsWith('/api/flashloop/') ? 'flashloop' : 'storyboard' }); },
    setBody(body) {
      const scope = context.getStore();
      if (!scope || !body || typeof body !== 'object') return;
      if (scope.route?.startsWith('/api/flashloop/') && SOURCES.has(body.source)) scope.source = body.source;
      scope.title = String(body.title || body.trendName || body.name || body.script || body.idea || scope.title || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    }
  };
}

module.exports = { createVault };
