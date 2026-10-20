// Test Suite: Seated Back-to-Back & Moving Multi-Person Tracking Stability
// Simulates 5 people sitting in a room (two pairs sitting back-to-back, one person moving)
// Validates that totalUniqueCount stays strictly at 5 and never inflates to 42!

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
let total = 0;
function assert(desc, condition) {
  total++;
  if (condition) {
    passed++;
    console.log(`✅ [PASS] ${desc}`);
  } else {
    console.error(`❌ [FAIL] ${desc}`);
  }
}

// Extract AdvancedHumanTracker and applyNms from viewer.js
const viewerContent = fs.readFileSync(path.join(__dirname, '../public/js/viewer.js'), 'utf8');

// Build sandbox context with minimal DOM/browser mocks
const sandbox = {
  console,
  performance: { now: () => Date.now() },
  Date,
  Math,
  Set,
  Map,
  Array,
  String,
  Number,
  addLogEvent: () => {}
};

// Extract class AdvancedHumanTracker and functions
const trackerStart = viewerContent.indexOf('class AdvancedHumanTracker {');
const trackerEnd = viewerContent.indexOf('const humanTracker = new AdvancedHumanTracker();');
const trackerCode = viewerContent.slice(trackerStart, trackerEnd);

const nmsStart = viewerContent.indexOf('function applyNms(');
const nmsEnd = viewerContent.indexOf('// Multi-zone body color extractor');
const nmsCode = viewerContent.slice(nmsStart, nmsEnd);

const colorSimStart = viewerContent.indexOf('function getColorSimilarity(');
const colorSimEnd = viewerContent.indexOf('// Advanced Multi-Human Sticky Tracker');
const colorSimCode = colorSimStart !== -1 ? viewerContent.slice(colorSimStart, colorSimEnd) : '';

const execCode = `
  function formatDwellTime() { return "0s"; }
  ${colorSimCode}
  ${trackerCode}
  ${nmsCode}
  this.AdvancedHumanTracker = AdvancedHumanTracker;
  this.applyNms = applyNms;
`;

vm.createContext(sandbox);
vm.runInContext(execCode, sandbox);

const AdvancedHumanTracker = sandbox.AdvancedHumanTracker;
const applyNms = sandbox.applyNms;

console.log(`\n═══════════════════════════════════════════════════════════════════`);
console.log(`  CCTV TEST: SEATED BACK-TO-BACK MULTI-PERSON TRACKING ACCURACY   `);
console.log(`═══════════════════════════════════════════════════════════════════\n`);

// 1. TEST NMS WITH BACK-TO-BACK DETECTIONS
console.log('--- Test 1: NMS with back-to-back seated people ---');
// Two people sitting back-to-back:
// Person 1: [100, 100, 90, 180] (center: 145, 190)
// Person 2: [150, 100, 90, 180] (center: 195, 190) -> distance between centers is 50px, refDim is 180px, dist/refDim = 0.27 (<0.40!)
// In the old code, Person 2 was suppressed. In the fixed code, both must be preserved!
const backToBackDets = [
  { bbox: [100, 100, 90, 180], score: 0.92, entityClass: 'person' },
  { bbox: [150, 100, 90, 180], score: 0.88, entityClass: 'person' }
];
const nmsResult = applyNms(backToBackDets, 0.25);
assert('applyNms preserves both people sitting back-to-back (does not suppress on center distance)', nmsResult.length === 2);

// 2. TEST TRACK CONFIRMATION THRESHOLD (NO JITTER +1 COUNT)
console.log('\n--- Test 2: Track confirmation prevents count inflation from single-frame noise ---');
const tracker = new AdvancedHumanTracker();
let simTime = 1000;
let wallTime = 1700000000000;

// Frame 1: Noise / brief flicker detection
tracker.update([{ bbox: [500, 200, 80, 160], score: 0.35 }], simTime, wallTime);
assert('Single-frame detection does NOT immediately increment totalUniqueCount', tracker.totalUniqueCount === 0);
assert('Track is created in unconfirmed state', tracker.tracks.length === 1 && !tracker.tracks[0].confirmed);

// Frame 2: Noise disappears
simTime += 100;
wallTime += 100;
tracker.update([], simTime, wallTime);
assert('Total unique count remains 0 after noise disappears', tracker.totalUniqueCount === 0);

// Frame 3 & 4: Noise missed again -> should be discarded without ever incrementing count
simTime += 100; wallTime += 100; tracker.update([], simTime, wallTime);
simTime += 100; wallTime += 100; tracker.update([], simTime, wallTime);
assert('Unconfirmed noise track is completely pruned', tracker.tracks.length === 0);
assert('Total unique count is still 0', tracker.totalUniqueCount === 0);

// 3. TEST 5 SEATED PEOPLE (INCLUDING 2 BACK-TO-BACK PAIRS) ACROSS 100 FRAMES WITH FIDGETING/MOTION
console.log('\n--- Test 3: 5 people sitting back-to-back moving/fidgeting across 100 frames ---');
const groupTracker = new AdvancedHumanTracker();

// Ground truth 5 people:
// Person 1 (Desk A, front): [100, 150, 80, 170], Blue shirt [30, 60, 200]
// Person 2 (Desk A, back-to-back with 1): [145, 150, 80, 170], Red shirt [210, 40, 40]
// Person 3 (Desk B, front): [350, 150, 80, 170], White shirt [240, 240, 240]
// Person 4 (Desk B, back-to-back with 3): [395, 150, 80, 170], Black shirt [20, 20, 20]
// Person 5 (Side chair, shifts & moves around): [600, 180, 85, 175], Yellow shirt [220, 200, 30]

const basePeople = [
  { id: 1, base: [100, 150, 80, 170], color: [30, 60, 200] },
  { id: 2, base: [145, 150, 80, 170], color: [210, 40, 40] },
  { id: 3, base: [350, 150, 80, 170], color: [240, 240, 240] },
  { id: 4, base: [395, 150, 80, 170], color: [20, 20, 20] },
  { id: 5, base: [600, 180, 85, 175], color: [220, 200, 30] }
];

let simClock = 5000;
let wallClock = 1700000000000;

for (let frame = 0; frame < 100; frame++) {
  simClock += 80;
  wallClock += 80;

  const currentDets = [];
  for (let pIdx = 0; pIdx < basePeople.length; pIdx++) {
    const p = basePeople[pIdx];

    // Simulate occasional brief detector drop (1-2 frames missed during a shift)
    if (p.id === 2 && frame >= 25 && frame <= 27) continue; // Person 2 briefly occluded
    if (p.id === 4 && frame >= 60 && frame <= 62) continue; // Person 4 turns head

    // Natural seated fidgeting: small jitter +/- 4 pixels
    const jitterX = Math.sin(frame * 0.3 + p.id) * 3;
    const jitterY = Math.cos(frame * 0.2 + p.id) * 2;
    // Person 5 moves around more actively
    const moveX = (p.id === 5) ? Math.sin(frame * 0.1) * 30 : 0;

    const bx = p.base[0] + jitterX + moveX;
    const by = p.base[1] + jitterY;
    const bw = p.base[2];
    const bh = p.base[3];

    currentDets.push({
      bbox: [bx, by, bw, bh],
      score: 0.88,
      colorSignature: p.color,
      entityClass: 'person'
    });
  }

  groupTracker.update(currentDets, simClock, wallClock);
}

console.log(`Total unique count after 100 frames of back-to-back motion: ${groupTracker.totalUniqueCount}`);
console.log(`Active tracks count: ${groupTracker.tracks.length}`);

assert('Total unique count is exactly 5 (NOT inflated to 42!)', groupTracker.totalUniqueCount === 5);
assert('All 5 physical people are stably confirmed', groupTracker.tracks.filter(t => t.confirmed).length === 5);
assert('Seated people established stationary seat anchors', groupTracker.tracks.filter(t => t.isSeated).length >= 4);

// 4. TEST SEAT RE-ENTRY: PERSON LEAVES SEAT AND RETURNS AFTER 20s
console.log('\n--- Test 4: Person leaves seat and returns within 60s memory window ---');
// Person 3 steps away for 20 seconds (250 frames at 80ms = 20,000ms > 15s interior grace)
for (let frame = 0; frame < 250; frame++) {
  simClock += 80;
  wallClock += 80;

  // Person 3 is absent
  const presentDets = basePeople.filter(p => p.id !== 3).map(p => ({
    bbox: [p.base[0], p.base[1], p.base[2], p.base[3]],
    score: 0.90,
    colorSignature: p.color,
    entityClass: 'person'
  }));

  groupTracker.update(presentDets, simClock, wallClock);
}

assert('Person 3 transitioned to dormant memory after absence', groupTracker.dormantTracks.some(d => d.colorSignature && d.colorSignature[0] === 240));

// Now Person 3 returns to their seat!
simClock += 80;
wallClock += 80;
const returningDets = basePeople.map(p => ({
  bbox: [p.base[0], p.base[1], p.base[2], p.base[3]],
  score: 0.90,
  colorSignature: p.color,
  entityClass: 'person'
}));

groupTracker.update(returningDets, simClock, wallClock);

console.log(`Total unique count after Person 3 returned: ${groupTracker.totalUniqueCount}`);
assert('Person 3 reclaimed their original ID upon returning to their seat', groupTracker.totalUniqueCount === 5);
assert('Live tracks still contains 5 people with persistent IDs', groupTracker.getLiveTracks(wallClock).length === 5);

console.log(`\n═══════════════════════════════════════════════════════════════════`);
console.log(`TEST SUMMARY: ${passed} / ${total} ASSERTIONS PASSED (${Math.round((passed/total)*100)}%)`);
console.log(`═══════════════════════════════════════════════════════════════════\n`);

if (passed === total) {
  process.exit(0);
} else {
  process.exit(1);
}
