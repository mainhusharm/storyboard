// Request-scoped capture and authenticated delivery for the shared asset library.
const { AsyncLocalStorage } = require('node:async_hooks');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const dns = require('node:dns').promises;
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

  function captureJSON(data, title, filename = 'script.json', metadata = {}) {
    return capture({ kind: 'script', title, filename, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data, null, 2)), metadata });
  }

  // Only called on generated provider results. Validate redirect targets as well;
  // clients cannot submit arbitrary URLs or local file paths to this interface.
  async function fetchImage(url) {
    const inline = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(url));
    if (inline) {
      if (inline[2].length > 40 * 1024 * 1024) throw new Error('Generated image is too large to archive.');
      return { buffer: Buffer.from(inline[2], 'base64'), mimeType: inline[1] };
    }
    for (let hop = 0; hop < 5; hop++) {
      const target = new URL(url);
      if (target.protocol !== 'https:' || target.username || target.password || (target.port && target.port !== '443')) throw new Error('Invalid generated image address.');
      const addresses = await dns.lookup(target.hostname, { all: true });
      if (!addresses.length || addresses.some(a => /^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|224\.|::|f[cd]|fe[89ab]|::ffff:)/i.test(a.address))) throw new Error('Private image addresses are not allowed.');
      const remaining = options.isVercel ? context.getStore().deadline - Date.now() - 3000 : 60000;
      if (remaining < 1000) throw new Error('The render used the available server time. Download this image now.');
      const response = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(Math.min(60000, remaining)) });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        await response.body?.cancel();
        url = new URL(response.headers.get('location'), target).href;
        continue;
      }
      if (!response.ok) throw new Error('Generated image download failed (HTTP ' + response.status + ').');
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 30 * 1024 * 1024) throw new Error('Generated image exceeds the 30 MB archive limit.');
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      let mimeType;
      if (buffer[0] === 0x89 && buffer.subarray(1, 4).toString() === 'PNG') mimeType = 'image/png';
      else if (buffer[0] === 0xff && buffer[1] === 0xd8) mimeType = 'image/jpeg';
      else if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') mimeType = 'image/webp';
      else throw new Error('The generated result is not a supported image.');
      return { buffer, mimeType };
    }
    throw new Error('Too many image download redirects.');
  }

  async function captureImage(url, title, metadata = {}) {
    if (!context.getStore()?.userId) return null;
    try {
      const data = await fetchImage(url);
      return await capture({ ...data, kind: 'image', title,
        filename: 'scene-image.' + ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[data.mimeType]), metadata });
    } catch (error) { warning(error); return null; }
  }

  function ticket(taskUrl, metadata = {}) {
    const scope = context.getStore();
    const target = new URL(taskUrl, 'https://api.paxsenix.org');
    if (!scope?.userId || target.origin !== 'https://api.paxsenix.org') throw new Error('Unsupported image task address.');
    const payload = Buffer.from(JSON.stringify({ userId: scope.userId, source: scope.source, title: scope.title,
      taskUrl: target.href, expires: Date.now() + 48 * 60 * 60 * 1000, metadata })).toString('base64url');
    return payload + '.' + crypto.createHmac('sha256', options.getSecret()).update(payload).digest('base64url');
  }

  function verifyTicket(value, userId) {
    const [payload, signature, extra] = String(value || '').split('.');
    if (!payload || !signature || extra || payload.length > 16000) return null;
    const expected = crypto.createHmac('sha256', options.getSecret()).update(payload).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(expected, actual)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
      return data.userId === userId && data.expires > Date.now() && SOURCES.has(data.source)
        && new URL(data.taskUrl).origin === 'https://api.paxsenix.org' ? data : null;
    } catch { return null; }
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
        const body = await options.readBody(req);
        const task = verifyTicket(body.ticket, userId);
        if (!task) { json(res, 403, { error: 'Invalid or expired image task.' }); return true; }
        Object.assign(context.getStore(), { source: task.source, title: task.title });
        const result = await options.pollImageTask(task.taskUrl);
        if (!result) { json(res, 409, { error: 'Image task has not finished yet.' }); return true; }
        const asset = await captureImage(result, task.title, task.metadata);
        json(res, asset ? 200 : 503, { ok: !!asset, asset, vault_warning: context.getStore()?.warning });
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

  async function prepareResponse(code, data) {
    const scope = context.getStore();
    if (!scope || !scope.userId || !data || typeof data !== 'object') return data;
    // Job/status objects are reused by the legacy pipeline. Do not attach one
    // account's save results to a shared object and leak them in a later request.
    data = { ...data };
    if (code === 200 && data.ok && scope.route?.startsWith('/api/flashloop/')) {
      const route = scope.route.split('/').pop();
      if (['generate-outline', 'generate-scene', 'generate-prompt', 'edit-prompt'].includes(route)) {
        await captureJSON(data, data.title || scope.title || 'Generated script', route + '.json', { stage: route });
      } else if (route === 'generate-i2i') {
        if (data.imageUrl && !scope.saved.some(e => e.kind === 'image')) await captureImage(data.imageUrl, scope.title || 'Scene image', { model: data.model });
        if (data.taskUrl) {
          try { data.vault_ticket = ticket(data.taskUrl, { model: data.model }); }
          catch (error) { warning(error); }
        }
      }
    }
    const recent = warnings.get(scope.userId);
    if (scope.warning || (scope.route === '/api/status' && recent && Date.now() - recent.at < 86400000)) {
      data.vault_warning = scope.warning || recent.message;
    }
    if (scope.saved.length) data.vault_saved = scope.saved.map(e => e.id);
    return data;
  }

  return { store, context, handle, capture, captureFile, captureJSON, captureImage, ticket, verifyTicket, prepareResponse,
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
