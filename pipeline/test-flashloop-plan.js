// test-flashloop-plan.js
// Offline regression test for the Flashloop / SJinn scene plan.
//
// Why it exists: "~1 min" and "~2 min" both came back as ONE 30-second prompt.
// Two things caused it:
//   1. the route read `duration` while the UI posts the total length as
//      `sceneDuration`, so the Video Length dropdown was ignored entirely; and
//   2. a 30s Scene Length locked the plan to a single prompt, and the UI left
//      that select stuck on 30s after a trip through the 30s-total mode.
// The total length is now the authority for the scene count and only the
// explicit 30s total option yields a single prompt.
//
// No network / no LLM calls — this only exercises the pure scene plan.
//
// Usage: node pipeline/test-flashloop-plan.js
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
process.env.PORT = '0'; // don't collide with a running dev server

const { flashloopScenePlan } = require(path.join(ROOT, 'web', 'server')).__internal;

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

// [totalVideoLength, sceneLength, expectedScenes, expectedSecondsPerScene]
const CASES = [
  [15, 8, 8, 8],    // ~1 min at 8s (the default) → 8 scenes
  [30, 8, 15, 8],   // ~2 min at 8s → 15 scenes
  [30, 15, 8, 15],  // ~2 min at 15s → 8 scenes (120s)
  [30, 30, 4, 30],  // ~2 min at 30s → 4 scenes (120s), NOT one prompt
  [15, 30, 2, 30],  // ~1 min at 30s → 2 scenes (60s), NOT one prompt
  [15, 5, 13, 5],   // ~1 min at 5s → 12.8 → 13 scenes
  [5, 8, 1, 30],    // 30s total → exactly one 30s prompt, whatever scene length
  [5, 30, 1, 30],   // 30s total with 30s scene length → still one prompt
  [undefined, 8, 8, 8], // missing total → ~1 min default
];

console.log('\n=== Flashloop scene plan ===');
for (const [total, sceneLen, wantScenes, wantPer] of CASES) {
  const plan = flashloopScenePlan(total, sceneLen);
  const label = `total=${total === undefined ? 'unset' : total}s scene=${sceneLen}s`;
  check(`${label} → ${wantScenes} × ${wantPer}s`,
    plan.sceneCount === wantScenes && plan.perScene === wantPer,
    `got ${plan.sceneCount} × ${plan.perScene}s (${plan.totalSec}s)`);
}

// A 1 min / 2 min request must never collapse into the single-prompt plan.
for (const total of [15, 30]) {
  const plan = flashloopScenePlan(total, 30);
  check(`total=${total}s never returns a single prompt`, plan.sceneCount > 1 && !plan.singlePrompt,
    `${plan.sceneCount} scene(s)`);
}

console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
