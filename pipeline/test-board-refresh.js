// Reproduce a Vercel instance carrying an unrelated old storyboard. Reload and
// idle refresh must retain the board returned inline to this browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../web/public/storyboard.html'), 'utf8');
const refreshSource = source.slice(source.indexOf('async function refresh(d){'), source.indexOf('function openModal('));
const correct = {
  characters: [{ id: 'A', name: 'Ram', description: 'Ram', reference_image_url: 'https://cdn.example.test/ram.png' },
    { id: 'B', name: 'Hanuman', description: 'Hanuman' }],
  frames: [{ frame: 1, image_prompt: 'Ram meets Hanuman', characters_present: ['A', 'B'], generated_image_url: 'https://cdn.example.test/meeting.png' }]
};
const stale = { characters: [{ id: 'A', name: 'Unrelated 72-year-old man', description: 'Other story' }],
  frames: [{ frame: 1, image_prompt: 'Other story' }], hasFinal: true };

function browser(storage, vercel = true) {
  const nodes = new Map();
  let reads = 0;
  const context = {
    CHARS: [], FRAMES: [], IS_VERCEL_CLIENT: vercel, OFFLINE_BOARD: false,
    $: id => { if (!nodes.has(id)) nodes.set(id, { style: {}, innerHTML: '' }); return nodes.get(id); },
    esc: s => String(s || ''), pad: n => String(n).padStart(2, '0'),
    refreshNarrStatus() {}, renderFinalFilm() {},
    api: async () => { reads++; return stale; },
    localStorage: { getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v) }
  };
  vm.createContext(context);
  vm.runInContext(refreshSource, context);
  return { context, reads: () => reads };
}

async function main() {
  const storage = new Map();
  const active = browser(storage);
  await active.context.refresh(correct);
  await active.context.refresh();
  assert.equal(active.reads(), 0, 'an idle refresh must not query an unscoped serverless board');
  assert.equal(active.context.CHARS[0].name, 'Ram');
  assert.equal(active.context.CHARS[1].name, 'Hanuman');
  assert.equal(active.context.FRAMES[0].generated_image_url, correct.frames[0].generated_image_url);
  console.log('ok: idle refresh preserves the current characters and hosted image');

  const reloaded = browser(storage);
  await reloaded.context.refresh();
  assert.equal(reloaded.reads(), 0);
  assert.equal(reloaded.context.CHARS[0].name, 'Ram');
  assert.equal(reloaded.context.CHARS[1].name, 'Hanuman');
  assert.equal(reloaded.context.OFFLINE_BOARD, true);
  console.log('ok: a hard reload restores the browser board, never the older instance board');

  const empty = browser(new Map());
  await empty.context.refresh();
  assert.equal(empty.context.CHARS.length, 0, 'a new browser never imports an unrelated instance board');
  assert.equal(empty.reads(), 0);
  const next = { characters: [{ id: 'C', name: 'New character', description: 'New board' }], frames: [] };
  await reloaded.context.refresh(next);
  assert.equal(reloaded.context.CHARS[0].name, 'New character', 'explicit new generation results still replace the board');
  console.log('ok: empty browsers stay empty and explicit generation results can replace the board');

  const local = browser(new Map(), false);
  await local.context.refresh();
  assert.equal(local.reads(), 1);
  assert.equal(local.context.CHARS[0].name, stale.characters[0].name, 'local development retains its disk-backed workflow');
  console.log('ok: local server board loading is preserved');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
