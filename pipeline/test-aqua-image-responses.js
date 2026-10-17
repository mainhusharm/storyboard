const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../web/server.js'), 'utf8');
const code = source.slice(source.indexOf('function aquaUrlFrom('), source.indexOf('// Persist a finished Aqua render'));
let requests = [], reply;
const context = {
  AQUA_API: 'https://api.aquadevs.com', AQUA_API_KEY: 'fake',
  AQUA_IMAGE_MODELS: ['nanobanana-pro', 'agnes-image'],
  aquaHeaders: () => ({}), aquaRatio: () => 'square', aquaTaskUrl: s => String(s || ''),
  logLine() {}, AbortSignal, Date, JSON, encodeURIComponent,
  setTimeout: fn => { fn(); },
  fetch: async (url, options) => { requests.push({ url, options }); return reply(url); }
};
vm.createContext(context);
vm.runInContext(code, context);
const url = 'https://cdn.example.test/image.png';
for (const shape of [url, { image_url: url }, { images: [{ url }] }, { data: { images: [url] } }, { result: url }]) {
  assert.equal(context.aquaUrlFrom(shape), url);
}
assert.equal(context.aquaUrlFrom({ result: { b64_json: 'YWJj' } }), 'data:image/png;base64,YWJj');
(async () => {
  reply = async () => new Response(JSON.stringify({ images: [{ url }] }));
  assert.equal(await context.generateAquaImage('aqua:agnes-image', 'portrait'), url);
  requests = [];
  reply = async requested => new Response(JSON.stringify(requested.includes('/tasks/') ? { status: 'completed', image_url: url } : { data: { task_id: 'task-123' } }));
  assert.equal(await context.generateAquaImage('aqua:nanobanana-pro', 'portrait'), url);
  assert.equal(requests.length, 2, 'a task is submitted only once before polling');
  requests = [];
  let challengeHits = 0;
  reply = async () => {
    if (challengeHits < 2) { challengeHits++; return new Response('<html><title>Just a moment...</title></html>', { status: 403, headers: { 'Content-Type': 'text/html' } }); }
    return new Response(JSON.stringify({ images: [{ url }] }));
  };
  assert.equal(await context.generateAquaImage('aqua:agnes-image', 'portrait'), url);
  assert.equal(challengeHits, 2, 'transient Cloudflare challenges are retried, not failed permanently');
  requests = [];
  reply = async () => new Response(JSON.stringify({ error: 'invalid key' }), { status: 401 });
   await assert.rejects(context.generateAquaImage('aqua:agnes-image', 'portrait'), /HTTP 401.*invalid key/);
   assert.equal(requests.length, 1, 'permanent failures do not resubmit paid image requests');
-  console.log('PASS: Aqua direct URLs, arrays, nested base64, task polling, and actionable permanent errors');
+  console.log('PASS: Aqua direct URLs, arrays, nested base64, task polling, challenge backoff, and actionable permanent errors');
})().catch(error => { console.error(error); process.exitCode = 1; });
