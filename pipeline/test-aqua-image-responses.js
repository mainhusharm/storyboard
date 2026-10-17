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
  aquaStatus: { lastError: '', lastModel: '', lastOkAt: 0 },
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
  reply = async () => new Response(JSON.stringify({ data: { task_id: 'already-paid' } }));
  let submits = 0;
  reply = async requested => {
    if (!requested.includes('/tasks/')) { submits++; return new Response(JSON.stringify({ data: { task_id: 'already-paid' } })); }
    return new Response(JSON.stringify({ error: 'task unavailable' }), { status: 404 });
  };
  await assert.rejects(context.generateAquaImage('aqua:agnes-image', 'portrait'), /Aqua task HTTP 404/);
  assert.equal(submits, 1, 'failed polling must not create another paid task');
  requests = [];
  reply = async () => new Response(JSON.stringify({ error: 'invalid key' }), { status: 401 });
   await assert.rejects(context.generateAquaImage('aqua:agnes-image', 'portrait'), /HTTP 401.*invalid key/);
   assert.equal(requests.length, 1, 'permanent failures do not resubmit paid image requests');
  requests = [];
  reply = async () => new Response('<html><title>Just a moment...</title></html>', { status: 403, headers: { 'cf-mitigated': 'challenge', 'cf-ray': 'test-ray', 'Content-Type': 'text/html' } });
  await assert.rejects(context.generateAquaImage('aqua:agnes-image', 'portrait'), error => error.code === 'AQUA_CLOUDFLARE_BLOCKED' && error.terminal && !error.permanent && /test-ray/.test(error.message));
  assert.equal(requests.length, 1, 'a browser challenge is not solved by resubmission');
  await assert.rejects(context.generateAquaImage('aqua:nanobanana-pro', 'another portrait'), /Cloudflare blocked this server request/);
  assert.equal(requests.length, 1, 'queued models on the same API observe the cooldown');
  assert.match(context.aquaStatus.lastError, /allow authenticated server API requests/);
  vm.runInContext('aquaImageBlock.until = Date.now() - 1', context);
  reply = async () => new Response(JSON.stringify({ images: [{ url }] }));
  assert.equal(await context.generateAquaImage('aqua:nanobanana-pro', 'portrait'), url);
  assert.equal(context.aquaStatus.lastError, '', 'success clears the latest error');
  const headersContext = { AQUA_API_KEY: 'fake' };
  vm.createContext(headersContext);
  vm.runInContext(source.slice(source.indexOf('function aquaHeaders('), source.indexOf('const AQUA_IMAGE_MODELS')), headersContext);
  const headers = headersContext.aquaHeaders({ 'Content-Type': undefined });
  assert.equal(headers.Authorization, 'Bearer fake');
  for (const name of ['Content-Type','Origin','Referer','sec-fetch-site','sec-ch-ua','User-Agent']) assert.equal(headers[name], undefined);
  console.log('PASS: Aqua responses, task polling without duplicate generation, API headers, challenge detection and cooldown');
})().catch(error => { console.error(error); process.exitCode = 1; });
