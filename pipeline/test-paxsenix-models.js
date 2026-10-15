// Test the three new PaxSenix models with the current API key
const fs = require('fs');
const https = require('https');

const API = 'https://api.paxsenix.org';
let API_KEY = process.env.PAXSENIX_API_KEY;
if (!API_KEY) {
  try {
    API_KEY = fs.readFileSync('pipeline/apikey.txt', 'utf8').trim();
  } catch (e) {
    console.error('❌ No API key found (env PAXSENIX_API_KEY or pipeline/apikey.txt)');
    process.exit(1);
  }
}

const MODELS = [
  'gemini-3.8-flash',
  'deepseek-v4-flash',
  'claude-haiku-5-5'
];

function fetch(url, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      timeout: 30000
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, text: data });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function testModel(model) {
  console.log(`\n🧪 Testing ${model}...`);
  try {
    const result = await fetch(`${API}/v1/chat/completions`, {
      model,
      messages: [{ role: 'user', content: 'Say "OK" if you can read this.' }],
      max_tokens: 50
    });

    if (result.status === 200 && result.json?.choices?.[0]?.message?.content) {
      console.log(`✅ ${model} works`);
      console.log(`   Response: ${result.json.choices[0].message.content.trim()}`);
      return { model, success: true };
    } else {
      console.log(`❌ ${model} failed`);
      console.log(`   HTTP ${result.status}: ${JSON.stringify(result.json || result.text).slice(0, 200)}`);
      return { model, success: false, error: result.json || result.text };
    }
  } catch (e) {
    console.log(`❌ ${model} error: ${e.message}`);
    return { model, success: false, error: e.message };
  }
}

(async () => {
  console.log('🔑 Testing PaxSenix models with your API key...');
  const results = [];
  for (const model of MODELS) {
    results.push(await testModel(model));
  }
  
  console.log('\n📊 Summary:');
  const working = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  console.log(`✅ Working: ${working.length}/${MODELS.length}`);
  if (working.length) console.log(`   ${working.map(r => r.model).join(', ')}`);
  if (failed.length) {
    console.log(`❌ Failed: ${failed.length}/${MODELS.length}`);
    console.log(`   ${failed.map(r => r.model).join(', ')}`);
  }
  
  process.exit(failed.length > 0 ? 1 : 0);
})();
