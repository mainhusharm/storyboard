const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../web/server.js'), 'utf8');
const start = source.indexOf('async function generateStoryboard(');
const end = source.indexOf('// ================================ IMAGE GENERATION', start);

async function runScenario(slowCharacters) {
  let now = 0;
  const calls = [];
  const context = {
    IS_VERCEL: true, DEFAULT_LANGUAGE: 'en', LANGUAGES: [],
    STYLES: { cinematic: { label: 'Cinematic', prefix: '' } },
    CHARACTERS_PROMPT: '', CHARS_JSON: 'characters', FRAMES_JSON: 'frames',
    Date: { now: () => now }, job: { cancelRequested: false },
    storyboardFrameCount: () => 2, logLine: () => {},
    assetVault: { captureJSON: async () => {}, captureFile: async () => {} },
    buildFramesPrompt: () => '', lockSacredCharacter: c => c,
    capProviderImagePrompt: p => p, writeJson: async () => {},
    parseOrSalvage: async value => value,
    chatCompletion: async (model, messages, tokens, temperature, options) => {
      calls.push({ model, options, now });
      assert(options.timeoutMs <= 90000);
      assert(now + options.timeoutMs < 270000);
      if (calls.length === 1) {
        if (slowCharacters) {
          now += options.timeoutMs;
          throw new Error('model timed out');
        }
        now += 70000;
        return { characters: [{ name: 'Hanuman ji', description: 'Divine vanara.' }] };
      }
      if (slowCharacters && calls.length === 2) {
        now += 40000;
        return { characters: [{ name: 'Hanuman ji', description: 'Divine vanara.' }] };
      }
      if (!slowCharacters && calls.length === 2) {
        now += options.timeoutMs;
        throw new Error('frame model timed out');
      }
      now += 1000;
      return { frames: [{ image_prompt: 'Hanuman meets Rama.' }, { image_prompt: 'Hanuman bows respectfully.' }] };
    }
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const result = await context.generateStoryboard('Hanuman meets Rama.', 'selected-model');
  assert.equal(result.frames.length, 2);
  assert.equal(calls.length, 3);
  if (slowCharacters) assert(calls[2].now > 115000, 'frames must start after the old 115s cutoff');
  else assert.equal(calls[2].model, 'gemini-3.8-flash', 'frame timeout must reach the next model');
}

(async () => {
  await runScenario(true);
  console.log('PASS: slow character failover still allows frame generation');
  await runScenario(false);
  console.log('PASS: frame timeout reaches fallback within the remaining budget');
})().catch(error => { console.error(error); process.exitCode = 1; });
