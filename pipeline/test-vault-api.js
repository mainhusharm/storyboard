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

test('script generation returns its result without filling the vault', async () => {
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
    assert.equal(result.vault_saved, undefined);
    assert.match(result.script, /Sunrise/);
    const listed = await (await request('/api/vault?source=sjinn&kind=script&q=Sunrise', alice)).json();
    assert.equal(listed.vault.length, 0);
  } finally { global.fetch = nativeFetch; }
});

test('accounts cannot list, stream or delete another account\'s assets; ranges and HEAD work', async () => {
  const asset = await owned(alice, 'flashloop', () => vault.capture({ kind: 'video', buffer: Buffer.from('0123456789'), filename: 'Scene 1.mp4', mimeType: 'video/mp4', title: 'Range sample', metadata: { stage: 'final' } }));
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
  const file = path.join(root, 'video', 'final_story.mp4');
  await fs.writeFile(file, png);
  const saved = await owned(alice, 'storyboard', () => vault.captureFile(file, 'video', 'Original film', { stage: 'final' }));
  assert.ok(saved);
  await fs.writeFile(file, 'replaced by a different generation');
  await fs.unlink(file);
  const response = await request(saved.url, alice);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
});

test('parallel generation contexts preserve owner and tool labels', async () => {
  const results = await Promise.all([
    owned(alice, 'flashloop', async () => { await new Promise(resolve => setTimeout(resolve, 25)); return vault.capture({ kind: 'video', buffer: Buffer.from('alice-only'), title: 'Alice scene', filename: 'alice.mp4', metadata: { stage: 'final' } }); }),
    owned(bob, 'sjinn', () => vault.capture({ kind: 'video', buffer: Buffer.from('bob-only'), title: 'Bob scene', filename: 'bob.mp4', metadata: { stage: 'final' } }))
  ]);
  assert.equal(results[0].source, 'flashloop');
  assert.equal(results[1].source, 'sjinn');
  assert.equal((await request(results[1].url, alice)).status, 404);
  const listed = await (await request('/api/vault?source=sjinn', bob)).json();
  assert.equal(listed.vault.length, 1);
  assert.equal(listed.vault[0].title, 'Bob scene');
});

test('only final combined videos are captured; intermediates perform no storage work', async () => {
  const saved = [];
  const fake = createVault({ store: { save: async input => { saved.push(input); return { id: 'final', ...input }; } } });
  await fake.run(async () => {
    fake.setUser(alice.user, '/api/flashloop/combine-videos');
    fake.setBody({ source: 'sjinn' });
    for (const [kind, stage] of [['script','storyboard'],['image','frame-image'],['audio','narration'],['video','scene-video'],['video',undefined],['image','final']]) {
      assert.equal(await fake.captureFile('/missing/intermediate', kind, 'Intermediate', { stage }), null);
    }
    assert.equal(saved.length, 0);
    const final = await fake.capture({ kind: 'video', buffer: Buffer.from('combined'), filename: 'final.mp4', metadata: { stage: 'final' } });
    assert.equal(final.source, 'sjinn');
    assert.equal(saved.length, 1);
    const response = await fake.prepareResponse(200, { ok: true, url: '/video/final.mp4' });
    assert.deepEqual(response.vault_saved, ['final']);
  });
});

test('repeat final-film completion deduplicates within each studio', async () => {
  for (const source of ['storyboard','flashloop','sjinn']) {
    const input = { kind: 'video', buffer: Buffer.from('same final '+source), filename: 'final.mp4', metadata: { stage: 'final' } };
    const first = await owned(alice, source, () => vault.capture(input));
    const second = await owned(alice, source, () => vault.capture(input));
    assert.ok(first); assert.equal(first.id,second.id); assert.equal(first.source,source);
  }
});

test('failed storage does not discard a finished generation and returns an explicit warning', async () => {
  const fake = createVault({ store: { save: async () => { throw new Error('Cloud storage unavailable'); } }, getSecret: () => 'test' });
  await fake.run(async () => {
    fake.setUser(alice.user, '/api/flashloop/generate-prompt');
    fake.setBody({ source: 'flashloop', title: 'Failed archive' });
    await fake.capture({ kind: 'video', buffer: Buffer.from('finished'), filename: 'final.mp4', metadata: { stage: 'final' } });
    const result = await fake.prepareResponse(200, { ok: true, url: '/video/final.mp4' });
    assert.equal(result.url, '/video/final.mp4');
    assert.match(result.vault_warning, /could not be saved/);
    assert.match(result.vault_warning, /Cloud storage unavailable/);
    assert.equal(result.vault_saved, undefined);
  });
});

test('background save warnings reach only their owner through status polling', async () => {
  await owned(alice, 'storyboard', () => vault.captureFile(path.join(root, 'missing-final.mp4'), 'video', 'Missing final movie', { stage: 'final' }));
  const first = await (await request('/api/status', alice)).json();
  assert.match(first.vault_warning, /could not be saved/);
  const other = await (await request('/api/status', bob)).json();
  assert.equal(other.vault_warning, undefined, 'shared job objects cannot carry another account\'s warning');
  const anonymous = await (await request('/api/status')).json();
  assert.equal(anonymous.vault_warning, undefined);
});

test('image task responses create neither vault tickets nor archive warnings', async () => {
  const fake = createVault({ store: {}, getSecret: () => 'test' });
  await fake.run(async () => {
    fake.setUser(alice.user, '/api/flashloop/generate-i2i');
    const result = await fake.prepareResponse(200, { ok: true, taskUrl: 'https://other-provider.test/task/1' });
    assert.equal(result.ok, true);
    assert.equal(result.vault_warning, undefined);
    assert.equal(result.vault_ticket, undefined);
    assert.equal(result.taskUrl, 'https://other-provider.test/task/1');
  });
});


test('daily cleanup rejects public/session requests and deletes only expired files with cron authorization', async () => {
  const crypto = require('node:crypto');
  const old = [];
  for (const user of [alice,bob]) {
    const saved = await vault.store.save({ userId:user.user.id, source:'storyboard', kind:'video', title:'Expired cron fixture', filename:'old.mp4', mimeType:'video/mp4', buffer:Buffer.from('expired '+user.user.id) });
    const hash = crypto.createHash('sha256').update(user.user.id).digest('hex');
    const indexPath = path.join(root,'vault/v2',hash,'index.json');
    const entries = JSON.parse(await fs.readFile(indexPath,'utf8'));
    entries.find(row=>row.id===saved.id).created_at = new Date(Date.now()-8*86400000).toISOString();
    await fs.writeFile(indexPath,JSON.stringify(entries));
    old.push({user,saved,assetPath:path.join(root,'vault/v2',hash,saved.id+'.asset')});
  }
  delete process.env.CRON_SECRET;
  assert.equal((await request('/api/vault-cleanup')).status, 401);
  process.env.CRON_SECRET = 'offline-cron-secret';
  try {
    assert.equal((await request('/api/vault-cleanup',alice)).status, 401);
    assert.equal((await request('/api/vault-cleanup',null,{headers:{Authorization:'Bearer wrong'}})).status, 401);
    assert.equal((await request('/api/vault-cleanup',null,{method:'POST',headers:{Authorization:'Bearer offline-cron-secret'}})).status, 405);
    const response = await request('/api/vault-cleanup?days=0',null,{headers:{Authorization:'Bearer offline-cron-secret'}});
    assert.equal(response.status,200);
    const result = await response.json();
    assert.equal(result.deleted,2); assert.equal(result.retention_days,7);
    for(const item of old) {
      assert.equal(await vault.store.get(item.user.user.id,item.saved.id),null);
      await assert.rejects(fs.access(item.assetPath), {code:'ENOENT'});
    }
    const remaining = await (await request('/api/vault',alice)).json();
    assert.ok(remaining.vault.length>0,'Keep files younger than seven days');
    assert.equal(remaining.retention_days,7);
    assert.equal(remaining.background_cleanup,false,'Local development has no Vercel scheduler');
    assert.ok(remaining.usage.bytes>0);
  } finally { delete process.env.CRON_SECRET; }
});
