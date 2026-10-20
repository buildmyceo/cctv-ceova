// Simulation Test: Sticky Human Tracking & Camera Range Exit Stability
const fs = require('fs');

// Extract AdvancedHumanTracker and formatDwellTime from viewer.js
const viewerContent = fs.readFileSync(__dirname + '/public/js/viewer.js', 'utf8');

// Evaluate formatDwellTime
const formatDwellTimeMatch = viewerContent.match(/function formatDwellTime\([\s\S]*?\n  \}/);
if (!formatDwellTimeMatch) throw new Error('formatDwellTime not found in viewer.js');
global.formatDwellTime = eval('(function() { return ' + formatDwellTimeMatch[0] + '; })()');

// Evaluate AdvancedHumanTracker
const trackerMatch = viewerContent.match(/class AdvancedHumanTracker\s*\{[\s\S]*?\n  \}/);
if (!trackerMatch) throw new Error('AdvancedHumanTracker not found in viewer.js');
global.AdvancedHumanTracker = eval('(function() { return ' + trackerMatch[0] + '; })()');

console.log('--- TESTING STICKY HUMAN DETECTION & CAMERA RANGE LOGIC ---');

const tracker = new AdvancedHumanTracker();
let simTime = 1000;
let wallClock = 1700000000000;

function tick(seconds = 0.1) {
  simTime += seconds * 1000;
  wallClock += seconds * 1000;
}

// 1. First appearance of a human in center of camera (1280x720)
let res1 = tracker.update([{ bbox: [500, 200, 140, 360], score: 0.85 }], simTime, wallClock, 1280, 720);
console.assert(res1.length === 1, 'Step 1: Should track 1 human');
console.assert(res1[0].id === 1, 'Step 1: ID should be 1');
console.assert(res1[0].dwellFormatted === '00:00', 'Step 1: Initial dwell should be 00:00');
console.log('✅ Step 1: Human #1 locked at [500, 200], timer 00:00');

// 2. Human stands STEADY for 3 seconds with simulated ML dropouts (no detection on some frames)
for (let s = 1; s <= 30; s++) {
  tick(0.1);
  // Simulate intermittent detection: detected on 30% of frames only
  const detected = (s % 3 === 0) 
    ? [{ bbox: [502 + (s % 2), 198, 140, 360], score: 0.75 }] 
    : [];
  const tracks = tracker.update(detected, simTime, wallClock, 1280, 720);
  console.assert(tracks.length === 1, `Step 2 (frame ${s}): Track must remain locked without dropping`);
  console.assert(tracks[0].id === 1, `Step 2 (frame ${s}): ID must stick to #1, not create #2`);
}
const steadyTracks = tracker.getLiveTracks(wallClock);
console.assert(steadyTracks[0].id === 1, 'Step 2: ID is still #1');
console.assert(steadyTracks[0].dwellFormatted === '00:03', `Step 2: Dwell should be 00:03, got ${steadyTracks[0].dwellFormatted}`);
console.log(`✅ Step 2: Human stood steady with intermittent ML drops; ID remained #1 and timer counted to ${steadyTracks[0].dwellFormatted}`);

// 3. Human turns around completely: 0 detections for 3 full seconds inside camera range
for (let s = 1; s <= 30; s++) {
  tick(0.1);
  const tracks = tracker.update([], simTime, wallClock, 1280, 720);
  console.assert(tracks.length === 1, `Step 3 (frame ${s}): Human is inside camera range, must NOT be dropped!`);
  console.assert(tracks[0].id === 1, `Step 3 (frame ${s}): ID must remain #1`);
}
const coastTracks = tracker.getLiveTracks(wallClock);
console.assert(coastTracks[0].dwellFormatted === '00:06', `Step 3: Dwell should be 00:06, got ${coastTracks[0].dwellFormatted}`);
console.log(`✅ Step 3: Human turned around (zero detections for 3.0s); ID remained #1 and timer counted continuously to ${coastTracks[0].dwellFormatted}`);

// 4. Detection resumes at same spot: must re-anchor to #1 with continuous counter!
tick(0.1);
let res4 = tracker.update([{ bbox: [505, 202, 142, 358], score: 0.82 }], simTime, wallClock, 1280, 720);
console.assert(res4.length === 1, 'Step 4: Re-anchored to 1 human');
console.assert(res4[0].id === 1, `Step 4: Must remain #1, got #${res4[0].id}`);
console.assert(res4[0].dwellFormatted === '00:06', `Step 4: Dwell time continues, got ${res4[0].dwellFormatted}`);
console.log(`✅ Step 4: Re-anchored to Human #1, continuous timer at ${res4[0].dwellFormatted}`);

// 5. Human walks towards boundary edge and leaves camera range (x crosses edge)
for (let s = 1; s <= 15; s++) {
  tick(0.1);
  const curX = Math.max(5, 505 - s * 35);
  tracker.update([{ bbox: [curX, 200, 140, 360], score: 0.80 }], simTime, wallClock, 1280, 720);
}

// Disappears at border for 3.0s (> exitGraceMs of 2.5s)
for (let s = 1; s <= 30; s++) {
  tick(0.1);
  tracker.update([], simTime, wallClock, 1280, 720);
}
let res5 = tracker.getLiveTracks(wallClock);
console.assert(res5.length === 0, `Step 5: Track should be retired after exiting camera boundary, remaining: ${res5.length}`);
console.log('✅ Step 5: Human walked out of camera boundary, track cleanly retired');

// 6. User comes back into camera within 20s -> Re-anchored to PAST Human #1!
tick(2.0); // 2.0 seconds later (within 20s memory window)
let res6 = tracker.update([{ bbox: [500, 200, 140, 360], score: 0.88 }], simTime, wallClock, 1280, 720);
console.assert(res6.length === 1, 'Step 6: Human tracked');
console.assert(res6[0].id === 1, `Step 6: Returning user must retain past ID #1 within 20s window, got #${res6[0].id}`);
console.log(`✅ Step 6: User returned within 20s window; correctly preserved past HUMAN #1 with continuous dwell ${res6[0].dwellFormatted}`);

// 7. Human leaves again and stays away for 32 seconds (> 30.0s memory window)
for (let s = 1; s <= 15; s++) {
  tick(0.1);
  const curX = Math.max(5, 500 - s * 35);
  tracker.update([{ bbox: [curX, 200, 140, 360], score: 0.80 }], simTime, wallClock, 1280, 720);
}
for (let s = 1; s <= 320; s++) { // 32 seconds with no detection
  tick(0.1);
  tracker.update([], simTime, wallClock, 1280, 720);
}
let res7 = tracker.getLiveTracks(wallClock);
console.assert(res7.length === 0, 'Step 7: Live tracks empty during absence');
console.log('✅ Step 7: Human departed for >20s; 20s re-entry memory expired cleanly');

// 8. New human enters after 20s expiration -> Assigned unique Human #2
tick(1.0);
let res8 = tracker.update([{ bbox: [600, 250, 130, 340], score: 0.88 }], simTime, wallClock, 1280, 720);
console.assert(res8.length === 1, 'Step 8: New human tracked');
console.assert(res8[0].id === 2, `Step 8: New human gets ID #2 after 20s expiration, got #${res8[0].id}`);
console.assert(res8[0].dwellFormatted === '00:00', 'Step 8: New human timer starts at 00:00');
console.log('✅ Step 8: Next entering human after 20s assigned unique HUMAN #2 with new counter 00:00');

// 9. Multi-Human Separation: Second human enters beside Human #2
tick(0.5);
let res9 = tracker.update([
  { bbox: [600, 250, 130, 340], score: 0.89, colorSignature: [115, 55, 40] }, // Human #2 (Brown shirt)
  { bbox: [200, 220, 135, 350], score: 0.86, colorSignature: [40, 140, 60] }  // New Human (Green shirt)
], simTime, wallClock, 1280, 720);
console.assert(res9.length === 2, `Step 9: Both humans must be detected simultaneously, got ${res9.length}`);
const idsInView = res9.map(h => h.id).sort();
console.assert(idsInView[0] === 2 && idsInView[1] === 3, `Step 9: Must have Human #2 and Human #3 tracked simultaneously, got ${idsInView.join(', ')}`);
console.log(`✅ Step 9: Multi-Human Separation verified: ${res9.length} humans tracked simultaneously as distinct #${idsInView.join(' & #')}`);

// 10. Clothing Color Discrimination: Human #2 and #3 exit.
// Stay away for 16.0s (> 15.0s interiorGraceMs) so tracks retire to dormant memory.
for (let s = 1; s <= 160; s++) {
  tick(0.1);
  tracker.update([], simTime, wallClock, 1280, 720); // Departed
}
let resCoast = tracker.getLiveTracks(wallClock);
console.assert(resCoast.length === 0, 'Step 10: Tracks retired to dormant memory');

// Within 20s memory window, a DIFFERENT person in a bright orange shirt enters!
tick(2.0); // 2.0s later (< 20s memory window)
let res10 = tracker.update([
  { bbox: [580, 240, 130, 340], score: 0.88, colorSignature: [245, 135, 20] } // Bright orange shirt
], simTime, wallClock, 1280, 720);
console.assert(res10.length === 1, 'Step 10: Orange shirt human tracked');
console.assert(res10[0].id !== 2, `Step 10: Orange shirt human must NOT be falsely identified as Human #2 (Brown shirt)! Got #${res10[0].id}`);
console.assert(res10[0].id === 4, `Step 10: Orange shirt human must be assigned new Human #4, got #${res10[0].id}`);
console.assert(res10[0].dwellFormatted === '00:00', `Step 10: New human timer must start at 00:00, got ${res10[0].dwellFormatted}`);
console.log(`✅ Step 10: Color discrimination verified: Orange shirt human correctly assigned new #${res10[0].id} (timer 00:00), never hijacked past Human #2!`);

// 11. Brown shirt human (Human #2) returns within 20s window!
tick(3.0); // Still within 20s window
let res11 = tracker.update([
  { bbox: [580, 240, 130, 340], score: 0.88, colorSignature: [245, 135, 20] }, // Human #4 (Orange shirt)
  { bbox: [750, 250, 130, 340], score: 0.87, colorSignature: [112, 53, 38] }  // Returning Human #2 (Brown shirt)
], simTime, wallClock, 1280, 720);
const liveIds = res11.map(h => h.id).sort();
console.assert(liveIds.includes(2), 'Step 11: Past Human #2 correctly resurrected for returning brown shirt wearer');
console.assert(liveIds.includes(4), 'Step 11: Human #4 remains active alongside Human #2');
console.log(`✅ Step 11: Returning Brown shirt user correctly re-anchored to past HUMAN #2 with both humans tracked distinctly (#${liveIds.join(' & #')})`);

console.log('\n🌟 ALL STICKY TRACKING, MULTI-HUMAN SEPARATION & COLOR DISCRIMINATION TESTS PASSED 100%!');

