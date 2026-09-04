const http = require('http');
const prompt = process.argv[2];
const model = process.argv[3] || 'wan3';
if (!prompt) {
  console.error('usage: node test-generate.js "prompt text" [model]');
  process.exit(1);
}
const body = JSON.stringify({ prompt, model });
const req = http.request(
  { host: '127.0.0.1', port: 5174, path: '/generate', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
  (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => { console.log(res.statusCode + ' ' + data); process.exit(0); });
  }
);
req.on('error', (e) => { console.error('request failed: ' + e.message); process.exit(1); });
req.end(body);
