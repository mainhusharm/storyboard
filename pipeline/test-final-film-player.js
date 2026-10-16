// Execute the browser's real final-film helpers and manual Combine handler.
// No browser, external provider, or paid generation is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../web/public/storyboard.html'), 'utf8');
const helpers = source.slice(source.indexOf('let FINAL_FILM=null;'), source.indexOf('// Client-side log buffer:'));
const manualCombine = source.slice(source.indexOf("$('btnCombine').onclick"), source.indexOf('async function regenFrame('));

function environment(storage = new Map()) {
  const elements = new Map(), logs = [], alerts = [];
  const context = {
    FRAMES: [{ frame: 1, image_prompt: 'A vase', animation_prompt: 'Push in', duration_sec: 1, clip_url: 'https://cdn.example.test/scene.mp4' }],
    IS_VERCEL_CLIENT: true,
    localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    $: id => {
      if (!elements.has(id)) {
        const attributes = new Map();
        elements.set(id, { style: {}, value: '1', loads: 0, pauses: 0,
          get src() { return attributes.get('src') || ''; }, set src(v) { attributes.set('src', v); },
          getAttribute: key => attributes.get(key) || null, removeAttribute: key => attributes.delete(key),
          load() { this.loads++; }, pause() { this.pauses++; }
        });
      }
      return elements.get(id);
    },
    loadClipUrls: () => ({}), sbPayload: b => b, logLocal: m => logs.push(m), alert: m => alerts.push(m)
  };
  vm.createContext(context);
  vm.runInContext(helpers, context);
  vm.runInContext(manualCombine, context);
  return { context, elements, logs, alerts, storage };
}

async function main() {
  const state = environment();
  const browser = state.context;
  const url = 'https://cdn.example.test/final.mp4';
  browser.postJob = async (route, body) => {
    assert.equal(route, '/combine');
    assert.equal(body.clipUrls[1], 'https://cdn.example.test/scene.mp4');
    return { ok: true, finalUrl: url };
  };
  await browser.$('btnCombine').onclick();
  assert.equal(browser.$('finalVideo').src, url, 'manual Combine must consume the returned hosted URL');
  assert.equal(browser.$('finalDownload').href, url);
  assert.equal(browser.$('finalSection').style.display, '');
  assert.equal(state.storage.get('sb_final_url'), url);
  const loads = browser.$('finalVideo').loads;
  browser.renderFinalFilm({ hasFinal: false });
  browser.renderFinalFilm({ hasFinal: true });
  assert.equal(browser.$('finalSection').style.display, '', 'cold instances cannot hide a hosted film');
  assert.equal(browser.$('finalVideo').src, url);
  assert.equal(browser.$('finalVideo').loads, loads, 'refresh must not restart playback');
  console.log('ok: manual Combine uses its hosted URL and cross-instance refresh preserves playback');

  const reloaded = environment(state.storage);
  reloaded.context.renderFinalFilm({ hasFinal: false });
  assert.equal(reloaded.context.$('finalVideo').src, url, 'reload restores a film even when this instance has no local final');
  reloaded.context.FRAMES = [{ frame: 1, image_prompt: 'A different story' }];
  reloaded.context.renderFinalFilm({ hasFinal: true });
  assert.equal(reloaded.context.$('finalSection').style.display, 'none', 'new storyboards never show the old film');
  assert.equal(reloaded.context.$('finalVideo').src, '');
  console.log('ok: page reload restores the matching film, and a changed storyboard hides stale films');

  browser.resetStoryboardAssets();
  assert.equal(state.storage.has('sb_final_url'), false);
  browser.postJob = async () => ({ ok: true, finalUrl: '' });
  const readyBefore = state.logs.length;
  await browser.$('btnCombine').onclick();
  assert.equal(state.logs.length, readyBefore, 'empty URLs must not log FINAL FILM READY');
  assert.match(state.alerts[0], /playable film URL/);
  assert.equal(browser.$('finalSection').style.display, 'none');
  browser.renderFinalFilm({ hasFinal: true });
  assert.equal(browser.$('finalVideo').src, '', 'serverless clients never use the instance-local MP4 as a fallback');
  console.log('ok: missing hosted links cannot produce blank success players');

  browser.IS_VERCEL_CLIENT = false;
  browser.renderFinalFilm({ hasFinal: true });
  assert.equal(browser.$('finalVideo').src, '/video/final_story.mp4', 'local development still uses the local film');
  browser.renderFinalFilm({ hasFinal: true, finalVersion: 123 });
  assert.equal(browser.$('finalVideo').src, '/video/final_story.mp4?v=123', 'a freshly rebuilt local film reloads');
  console.log('ok: local final-film playback is preserved');
}

main().catch(e => { console.error(e); process.exitCode = 1; });
