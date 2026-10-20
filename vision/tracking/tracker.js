/**
 * CEOVA CCTV // Vision Engine
 * vision/tracking/tracker.js
 * 
 * Multi-Human Sticky Person Tracker with Boundary Exit Awareness,
 * Velocity Estimation, Live Dwell Timers, and Cross-Camera Track State.
 */

function formatDwellTime(elapsedMs) {
  const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function getIoU(b1, b2) {
  const x1 = Math.max(b1.x, b2.x);
  const y1 = Math.max(b1.y, b2.y);
  const x2 = Math.min(b1.x + b1.w, b2.x + b2.w);
  const y2 = Math.min(b1.y + b1.h, b2.y + b2.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = (b1.w * b1.h) + (b2.w * b2.h) - inter;
  return union > 0 ? inter / union : 0;
}

class PersonTracker {
  constructor(options = {}) {
    this.cameraId = options.cameraId || 'CAM-01';
    this.tracks = []; // Array of active tracks
    this.nextId = options.startId || 1;
    this.totalUniqueCount = 0;
    // Interior grace: keep track locked for 6.5s during occlusions or steady state
    this.interiorGraceMs = options.interiorGraceMs || 6500;
    // Exit grace: if human touches camera boundary and leaves, retire after 1.5s
    this.exitGraceMs = options.exitGraceMs || 1500;
    // 20-Second User Re-Entry Memory Window:
    // Remember departed users for 20 seconds. If they re-enter the camera within 20s,
    // restore their past human number, identity, and continuous dwell timer.
    this.reentryMemoryMs = options.reentryMemoryMs !== undefined ? options.reentryMemoryMs : 20000;
    this.dormantTracks = [];
    // Position & dimension smoothing factors
    this.posAlpha = options.posAlpha || 0.30;
    this.sizeAlpha = options.sizeAlpha || 0.22;
  }

  /**
   * Update tracker with instantaneous detections from human detector
   * @param {Array<{bbox: [x, y, w, h], score: number}>} detectedHumans 
   * @param {number} now - performance.now() or high-res timestamp
   * @param {number} wallClockNow - Date.now() timestamp
   * @param {number} frameW - camera frame width
   * @param {number} frameH - camera frame height
   * @returns {Array<Object>} Active updated tracks
   */
  update(detectedHumans = [], now = Date.now(), wallClockNow = Date.now(), frameW = 1280, frameH = 720) {
    // Prune expired dormant tracks older than 20 seconds
    this.dormantTracks = this.dormantTracks.filter(d => (now - d.departedTime) <= this.reentryMemoryMs);

    // 1. Build pairwise match candidates with adaptive affinity metric
    const candidates = [];
    for (let tIdx = 0; tIdx < this.tracks.length; tIdx++) {
      const tr = this.tracks[tIdx];
      const trCx = tr.x + tr.width / 2;
      const trCy = tr.y + tr.height / 2;
      const trRefDim = Math.max(tr.width, tr.height, 60);

      for (let dIdx = 0; dIdx < detectedHumans.length; dIdx++) {
        const det = detectedHumans[dIdx];
        const [dx, dy, dw, dh] = det.bbox;
        const detCx = dx + dw / 2;
        const detCy = dy + dh / 2;

        const dist = Math.hypot(trCx - detCx, trCy - detCy);
        const normDist = dist / trRefDim;
        const iou = getIoU(
          { x: tr.x, y: tr.y, w: tr.width, h: tr.height },
          { x: dx, y: dy, w: dw, h: dh }
        );

        const trArea = tr.width * tr.height;
        const detArea = dw * dh;
        const areaSim = Math.min(trArea, detArea) / Math.max(trArea, detArea || 1);

        let affinity = 0;
        if (iou > 0.08) {
          affinity = (iou * 2.2) + Math.max(0, 1.0 - normDist) * 0.7 + (areaSim * 0.3);
        } else if (normDist < 1.4) {
          affinity = Math.max(0, 1.0 - (normDist / 1.4)) + (areaSim * 0.25);
        }

        // Established track lock bonus: lock on firmly to existing tracks
        if ((tr.totalDetections || 0) > 2) {
          affinity += 0.20;
        }

        // Color consistency check between active track and detection
        if (det.colorSignature && tr.colorSignature) {
          const cd = Math.hypot(
            det.colorSignature[0] - tr.colorSignature[0],
            det.colorSignature[1] - tr.colorSignature[1],
            det.colorSignature[2] - tr.colorSignature[2]
          );
          if (cd > 60) {
            // Completely different clothing: NEVER match this detection to this track!
            continue;
          } else {
            const colorSim = Math.max(0, 1.0 - (cd / 120));
            affinity += colorSim * 0.30;
          }
        }

        if (affinity > 0.28) {
          candidates.push({ tIdx, dIdx, affinity });
        }
      }
    }

    // Sort candidate pairs by highest affinity first (Global optimal match assignment)
    candidates.sort((a, b) => b.affinity - a.affinity);

    const matchedTrackIndices = new Set();
    const matchedDetIndices = new Set();

    for (const cand of candidates) {
      if (!matchedTrackIndices.has(cand.tIdx) && !matchedDetIndices.has(cand.dIdx)) {
        matchedTrackIndices.add(cand.tIdx);
        matchedDetIndices.add(cand.dIdx);

        const t = this.tracks[cand.tIdx];
        const det = detectedHumans[cand.dIdx];
        const [hx, hy, hw, hh] = det.bbox;

        const dt = Math.max(0.02, (now - t.lastUpdateTime) / 1000);
        const currentCx = hx + hw / 2;
        const currentCy = hy + hh / 2;
        const prevCx = t.x + t.width / 2;
        const prevCy = t.y + t.height / 2;

        // Estimate motion velocity with clamping to avoid unnatural spikes
        const maxSpeed = 320;
        const instantVx = Math.min(maxSpeed, Math.max(-maxSpeed, (currentCx - prevCx) / dt));
        const instantVy = Math.min(maxSpeed, Math.max(-maxSpeed, (currentCy - prevCy) / dt));
        t.vx = t.vx * 0.70 + instantVx * 0.30;
        t.vy = t.vy * 0.70 + instantVy * 0.30;

        const speed = Math.hypot(t.vx, t.vy);
        if (speed > 20) {
          t.motionState = 'WALKING';
          t.direction = Math.abs(t.vx) > Math.abs(t.vy) ? (t.vx > 0 ? '→' : '←') : (t.vy > 0 ? '↓' : '↑');
        } else {
          t.motionState = 'STEADY';
          t.direction = '';
        }

        // Smooth exponential position & dimension interpolation
        t.x = t.x * (1 - this.posAlpha) + hx * this.posAlpha;
        t.y = t.y * (1 - this.posAlpha) + hy * this.posAlpha;
        t.width = t.width * (1 - this.sizeAlpha) + hw * this.sizeAlpha;
        t.height = t.height * (1 - this.sizeAlpha) + hh * this.sizeAlpha;

        t.score = Math.max(t.score * 0.7, det.score);
        t.lastSeenTime = now;
        t.lastUpdateTime = now;
        t.lastSeenWallClock = wallClockNow;
        t.misses = 0;
        t.totalDetections = (t.totalDetections || 0) + 1;
        if (det.colorSignature) {
          t.colorSignature = det.colorSignature;
        }
      }
    }

    // 2. Unmatched detections -> First check 20-Second Re-Entry Memory for returning past human!
    for (let dIdx = 0; dIdx < detectedHumans.length; dIdx++) {
      if (!matchedDetIndices.has(dIdx)) {
        const det = detectedHumans[dIdx];
        const [hx, hy, hw, hh] = det.bbox;

        let bestDormantIdx = -1;
        let bestDormantScore = 0;

        const detArea = hw * hh;
        const detAspect = hw / Math.max(1, hh);
        const detCx = hx + hw / 2;
        const detCy = hy + hh / 2;

        for (let k = 0; k < this.dormantTracks.length; k++) {
          const d = this.dormantTracks[k];
          const timeAwaySec = (now - d.departedTime) / 1000;
          if (timeAwaySec > (this.reentryMemoryMs / 1000)) continue;

          // Strict Appearance Gating: If clothing colors differ, CANNOT be the same human!
          let hasColorMatch = false;
          let colorSim = 0.5;
          if (det.colorSignature && d.colorSignature) {
            const cd = Math.hypot(
              det.colorSignature[0] - d.colorSignature[0],
              det.colorSignature[1] - d.colorSignature[1],
              det.colorSignature[2] - d.colorSignature[2]
            );
            if (cd > 55) {
              // HARD REJECT: Completely different clothing color (e.g. orange vs brown shirt)
              // This is a DIFFERENT person who entered, MUST NOT resurrect!
              continue;
            }
            colorSim = Math.max(0, 1.0 - (cd / 110));
            hasColorMatch = true;
          }

          const dormArea = d.width * d.height;
          const dormAspect = d.width / Math.max(1, d.height);
          const areaSim = Math.min(detArea, dormArea) / Math.max(detArea, dormArea || 1);
          const aspectSim = Math.min(detAspect, dormAspect) / Math.max(detAspect, dormAspect || 1);

          const dCx = d.x + d.width / 2;
          const dCy = d.y + d.height / 2;
          const dist = Math.hypot(detCx - dCx, detCy - dCy);
          const frameDiag = Math.hypot(frameW, frameH);
          const normDist = dist / frameDiag;
          const posProximity = Math.max(0, 1.0 - normDist);

          const recencyFactor = Math.max(0, 1.0 - (timeAwaySec / (this.reentryMemoryMs / 1000)));

          let score = 0;
          const isSoleDormant = (this.dormantTracks.length === 1 && this.tracks.length === 0);

          if (hasColorMatch) {
            // High-confidence clothing color match:
            score = (colorSim * 0.45) + (areaSim * 0.20) + (aspectSim * 0.15) + (posProximity * 0.10) + (recencyFactor * 0.10);
          } else if (isSoleDormant) {
            score = (areaSim * 0.35) + (aspectSim * 0.25) + (posProximity * 0.25) + (recencyFactor * 0.15);
          } else {
            score = (areaSim * 0.35) + (aspectSim * 0.25) + (posProximity * 0.25) + (recencyFactor * 0.15);
          }

          if (score > bestDormantScore && score >= 0.48) {
            bestDormantScore = score;
            bestDormantIdx = k;
          }
        }

        if (bestDormantIdx >= 0) {
          // Re-activate past human number!
          const resurrected = this.dormantTracks.splice(bestDormantIdx, 1)[0];
          resurrected.x = hx;
          resurrected.y = hy;
          resurrected.width = hw;
          resurrected.height = hh;
          resurrected.score = det.score;
          resurrected.vx = 0;
          resurrected.vy = 0;
          resurrected.motionState = 'STEADY';
          resurrected.direction = '';
          resurrected.misses = 0;
          resurrected.lastSeenTime = now;
          resurrected.lastUpdateTime = now;
          resurrected.lastSeenWallClock = wallClockNow;
          resurrected.totalDetections = (resurrected.totalDetections || 0) + 1;
          resurrected.firstSeenWallClock = wallClockNow - (resurrected.accumulatedDwellMs || 0);

          if (det.colorSignature) {
            resurrected.colorSignature = det.colorSignature;
          }

          this.tracks.push(resurrected);
          matchedDetIndices.add(dIdx);
          continue;
        }

        // Not in 20-second memory: assign brand new Human ID
        const newId = this.nextId++;
        this.totalUniqueCount++;

        const newTrack = {
          id: newId,
          cameraId: this.cameraId,
          x: hx,
          y: hy,
          width: hw,
          height: hh,
          vx: 0,
          vy: 0,
          motionState: 'STEADY',
          direction: '',
          score: det.score,
          firstSeenWallClock: wallClockNow,
          lastSeenWallClock: wallClockNow,
          lastSeenTime: now,
          lastUpdateTime: now,
          misses: 0,
          totalDetections: 1,
          globalTrackId: null, // Linked via CrossCameraIdentityManager
          assignedRole: 'UNKNOWN',
          roleConfidence: 0.0,
          accumulatedDwellMs: 0
        };
        this.tracks.push(newTrack);
      }
    }

    // 3. Evaluate active tracks & boundary exit logic
    const activeResults = [];
    const borderMarginX = Math.max(40, frameW * 0.08);
    const borderMarginY = Math.max(40, frameH * 0.08);

    for (let i = this.tracks.length - 1; i >= 0; i--) {
      const t = this.tracks[i];
      const isMatched = matchedTrackIndices.has(i);

      if (!isMatched) {
        t.misses++;
      }

      const elapsedSinceSeen = now - t.lastSeenTime;

      // Check if track is at the camera boundary (exiting range)
      const isAtBoundary = (
        t.x <= borderMarginX ||
        t.y <= borderMarginY ||
        (t.x + t.width) >= (frameW - borderMarginX) ||
        (t.y + t.height) >= (frameH - borderMarginY)
      );

      const allowedGrace = isAtBoundary ? this.exitGraceMs : this.interiorGraceMs;

      if (elapsedSinceSeen > allowedGrace) {
        // Human departed or out of active camera range -> Save to 20s Re-Entry Memory!
        t.departedTime = now;
        t.departedWallClock = wallClockNow;
        t.accumulatedDwellMs = (t.accumulatedDwellMs || 0) + (wallClockNow - t.firstSeenWallClock);
        t.exitBbox = { x: t.x, y: t.y, w: t.width, h: t.height };
        t.isAtBoundary = isAtBoundary;

        this.dormantTracks = this.dormantTracks.filter(d => d.id !== t.id);
        this.dormantTracks.push(t);

        this.tracks.splice(i, 1);
        continue;
      }

      // Forward project walking track if temporarily occluded
      if (!isMatched && t.motionState === 'WALKING' && t.misses < 12) {
        t.x += t.vx * 0.03;
        t.y += t.vy * 0.03;
      }

      // Live continuous dwell timer
      const dwellMs = wallClockNow - t.firstSeenWallClock;
      activeResults.push({
        ...t,
        isLive: isMatched,
        dwellMs,
        dwellFormatted: formatDwellTime(dwellMs)
      });
    }

    activeResults.sort((a, b) => a.id - b.id);
    return activeResults;
  }

  getLiveTracks(wallClockNow = Date.now()) {
    return this.tracks.map(t => {
      const dwellMs = wallClockNow - t.firstSeenWallClock;
      return {
        ...t,
        dwellMs,
        dwellFormatted: formatDwellTime(dwellMs)
      };
    });
  }

  getTrackById(id) {
    return this.tracks.find(t => t.id === id) || null;
  }

  clear() {
    this.tracks = [];
    this.dormantTracks = [];
  }
}

module.exports = {
  PersonTracker,
  formatDwellTime,
  getIoU
};
