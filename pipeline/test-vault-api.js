'use strict';
// Offline HTTP tests: no provider calls, cloud credentials, or generation credits.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { test, before, after } = require('node:test');
const { createVault } = require('../web/vault');

let root, server, base, handler, vault, alice, bob;
const nativeFetch = global.fetch;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3XcAAAAASUVORK5CYII=', 'base64');

async function request(route, user, options = {}) {
  const headers = { ...(user ? { Authorization: 'Bearer ' + user.token } : {}), ...options.headers };
  const response = await nativeFetch(base + route, { ...options, headers });
  return response;
}
async function signup(email) {
  const response = await request('/api/auth/signup', null, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: email.split('@')[0], email, password: 'offline-test-password' }) });
  assert.equal(response.status, 200);
  return response.json();
}
async function owned(user, source, fn) {
  return vault.run(async () => {
    vault.setUser(user.user, '/api/flashloop/generate-scene');
    vault.setBody({ source, title: 'A saved creation' });
    return fn();
  });
}

before(async () => {
  root = await fs.mkdtemp(path.join(__dirname, '../.vault-api-test-'));
  process.env.STORYBOARD_DATA_DIR = root;
  delete process.env.VERCEL;
  delete process.env.DATABASE_URL;
  process.env.SESSION_SECRET = 'offline-vault-integration-secret';
  process.env.LOGFARE_API_KEY = 'offline-provider-stub';
  handler = require('../web/server');
  vault = handler.__internal.assetVault;
  server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  alice = await signup('alice@vault.test');
  bob = await signup('bob@vault.test');
});

after(async () => {
  global.fetch = nativeFetch;
  if (server) await new Promise(resolve => server.close(resolve));
  if (root) await fs.rm(root, { recursive: true, force: true });
});

test('vault pages and every content operation require a signed-in account', async () => {
  assert.equal((await request('/api/vault')).status, 401);
  assert.equal((await request('/api/vault/status')).status, 401);
  const response = await nativeFetch(base + '/vault', { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /login/);
  const page = await request('/vault', alice);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /YOUR CREATIVE LIBRARY/);
  assert.equal((await request('/vault/film_old.mp4', alice)).status, 404);
});

test('script generation automatically archives the real endpoint response under its source', async () => {
  global.fetch = async (url, options) => {
    if (String(url).startsWith('https://logfare.ai/v1/chat/completions')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: 'SCENE 1 — Sunrise\nThe camera rises over the sea.' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return nativeFetch(url, options);
  };
  try {
    const response = await request('/api/flashloop/edit-prompt', alice, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'sjinn', title: 'Sunrise film', model: 'logfare:auto', script: 'SCENE 1 — Original', instruction: 'Add a sunrise' }) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.ok(result.vault_saved?.length);
    const listed = await (await request('/api/vault?source=sjinn&kind=script&q=Sunrise', alice)).json();
    assert.equal(listed.vault.length, 1);
    assert.equal(listed.vault[0].source, 'sjinn');
    const download = await request(listed.vault[0].download_url, alice);
    assert.equal((await download.json()).script, result.script);
    assert.match(download.headers.get('content-disposition'), /^attachment/);
    assert.equal(download.headers.get('cache-control'), 'private, no-store');
  } finally { global.fetch = nativeFetch; }
});

test('accounts cannot list, stream or delete another account\'s assets; ranges and HEAD work', async () => {
  const asset = await owned(alice, 'flashloop', () => vault.capture({ kind: 'video', buffer: Buffer.from('0123456789'), filename: 'Scene 1.mp4', mimeType: 'video/mp4', title: 'Range sample' }));
  assert.ok(asset);
  const response = await request(asset.url, alice, { headers: { Range: 'bytes=2-5' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await response.text(), '2345');
  const invalidRange = await request(asset.url, alice, { headers: { Range: 'bytes=99-' } });
  assert.equal(invalidRange.status, 416);
  assert.equal(invalidRange.headers.get('content-range'), 'bytes */10');
  const head = await request(asset.url, alice, { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(await head.text(), '');
  assert.equal((await request(asset.url)).status, 401);
  assert.equal((await request(asset.url, bob)).status, 404);
  assert.equal((await request('/api/vault/' + asset.id, bob, { method: 'DELETE' })).status, 404);
  assert.equal((await (await request('/api/vault', bob)).json()).vault.length, 0);
  assert.equal((await request(asset.url, alice)).status, 200);
  assert.equal((await request('/api/vault/' + asset.id, alice, { method: 'DELETE' })).status, 200);
  assert.equal((await request(asset.url, alice)).status, 404);
});

test('captures retain independent bytes when working outputs are overwritten or cleaned', async () => {
  const file = path.join(root, 'frames', 'frame_01.png');
  await fs.writeFile(file, png);
  const saved = await owned(alice, 'storyboard', () => vault.captureFile(file, 'image', 'Original frame'));
  assert.ok(saved);
  await fs.writeFile(file, 'replaced by a different generation');
  await fs.unlink(file);
  const response = await request(saved.url, alice);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
});

test('parallel generation contexts preserve owner and tool labels', async () => {
  const results = await Promise.all([
    owned(alice, 'flashloop', async () => { await new Promise(resolve => setTimeout(resolve, 25)); return vault.captureJSON({ scene: 'alice-only' }, 'Alice scene'); }),
    owned(bob, 'sjinn', () => vault.captureJSON({ scene: 'bob-only' }, 'Bob scene'))
  ]);
  assert.equal(results[0].source, 'flashloop');
  assert.equal(results[1].source, 'sjinn');
  assert.equal((await request(results[1].url, alice)).status, 404);
  const listed = await (await request('/api/vault?source=sjinn', bob)).json();
  assert.equal(listed.vault.length, 1);
  assert.equal(listed.vault[0].title, 'Bob scene');
});

test('unsigned, tampered, wrong-owner and expired completion tickets are rejected', async () => {
  const token = await owned(alice, 'sjinn', () => vault.ticket('https://api.paxsenix.org/task/example'));
  assert.equal((await request('/api/vault/capture-task', bob, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: token }) })).status, 403);
  assert.equal((await request('/api/vault/capture-task', alice, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: token + 'x' }) })).status, 403);
  assert.equal(vault.verifyTicket(token, alice.user.id).source, 'sjinn');
  assert.equal(vault.verifyTicket('not-a-ticket', alice.user.id), null);
  await assert.rejects(() => owned(alice, 'sjinn', () => vault.ticket('https://127.0.0.1/task')), /Unsupported/);
});

test('completed async images are saved before replying; repeated completion is idempotent', async () => {
  const fake = createVault({ root, isVercel: false, getSecret: () => 'test-secret', readBody: async req => req.testBody,
    pollImageTask: async () => 'data:image/png;base64,' + png.toString('base64') });
  const ticket = await fake.run(async () => {
    fake.setUser(alice.user, '/api/flashloop/generate-i2i');
    fake.setBody({ source: 'sjinn', title: 'Async image' });
    const result = await fake.prepareResponse(200, { ok: true, taskUrl: 'https://api.paxsenix.org/task/image-test' });
    return result.vault_ticket;
  });
  const ids = [];
  for (let i = 0; i < 2; i++) {
    await fake.run(async () => {
      fake.setUser(alice.user, '/api/vault/capture-task');
      const result = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
      await fake.handle({ method: 'POST', headers: {}, user: alice.user, testBody: { ticket } }, result, new URL('http://localhost/api/vault/capture-task'));
      assert.equal(result.status, 200);
      assert.equal(result.body.asset.source, 'sjinn');
      ids.push(result.body.asset.id);
    });
  }
  assert.equal(ids[0], ids[1]);
});

test('failed storage does not discard a finished generation and returns an explicit warning', async () => {
  const fake = createVault({ store: { save: async () => { throw new Error('Cloud storage unavailable'); } }, getSecret: () => 'test' });
  await fake.run(async () => {
    fake.setUser(alice.user, '/api/flashloop/generate-prompt');
    fake.setBody({ source: 'flashloop', title: 'Failed archive' });
    const result = await fake.prepareResponse(200, { ok: true, script: 'The finished generated script' });
    assert.equal(result.script, 'The finished generated script');
    assert.match(result.vault_warning, /could not be saved/);
    assert.match(result.vault_warning, /Cloud storage unavailable/);
    assert.equal(result.vault_saved, undefined);
  });
});

test('background save warnings reach only their owner through status polling', async () => {
  await owned(alice, 'storyboard', () => vault.captureFile(path.join(root, 'missing-output.png'), 'image', 'Missing output'));
  const first = await (await request('/api/status', alice)).json();
  assert.match(first.vault_warning, /could not be saved/);
  const other = await (await request('/api/status', bob)).json();
  assert.equal(other.vault_warning, undefined, 'shared job objects cannot carry another account\'s warning');
  const anonymous = await (await request('/api/status')).json();
  assert.equal(anonymous.vault_warning, undefined);
});

test('an unsupported provider task still returns its generation result with an archive warning', async () => {
  const fake = createVault({ store: {}, getSecret: () => 'test' });
  await fake.run(async () => {
    fake.setUser(alice.user, '/api/flashloop/generate-i2i');
    const result = await fake.prepareResponse(200, { ok: true, taskUrl: 'https://other-provider.test/task/1' });
    assert.equal(result.ok, true);
    assert.match(result.vault_warning, /Unsupported image task/);
  });
});
