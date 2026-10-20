/**
 * CEOVA CCTV // Bot-Based AI Architecture
 * bots/tracking_bot.js
 * 
 * Person Tracking Bot (Phase 2)
 * 
 * ByteTrack-style two-stage association multi-object tracker for CCTV.
 * - Stage 1: High-confidence detection matching against active tracks.
 * - Stage 2: Low-confidence detection matching against remaining tracks for occlusion recovery.
 * - Stable global track IDs: 'P-000183'.
 * - Active track collision gating: prevents spurious duplicate tracks on the same person.
 * - Real-time track-to-track coalescence: guarantees strictly one track per physical human.
 * - Velocity-based position extrapolation for walking subjects during occlusions.
 * - Continuous dwell timing and motion state tracking.
 */

const { BaseBot } = require('./base_bot');

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

function calculateIoU(b1, b2) {
  const x1 = Math.max(b1[0], b2[0]);
  const y1 = Math.max(b1[1], b2[1]);
  const x2 = Math.min(b1[0] + b1[2], b2[0] + b2[2]);
  const y2 = Math.min(b1[1] + b1[3], b2[1] + b2[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = (b1[2] * b1[3]) + (b2[2] * b2[3]) - inter;
  return union > 0 ? inter / union : 0;
}

function calculateInterArea(b1, b2) {
  const x1 = Math.max(b1[0], b2[0]);
  const y1 = Math.max(b1[1], b2[1]);
  const x2 = Math.min(b1[0] + b1[2], b2[0] + b2[2]);
  const y2 = Math.min(b1[1] + b1[3], b2[1] + b2[3]);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

class TrackingBot extends BaseBot {
  constructor(options = {}) {
    super('tracking_bot', '1.0.0', {
      highScoreThreshold: options.highScoreThreshold || 0.45,
      lowScoreThreshold: options.lowScoreThreshold || 0.20,
      interiorGraceMs: options.interiorGraceMs || 15000,
      exitGraceMs: options.exitGraceMs || 2500,
      reentryMemoryMs: options.reentryMemoryMs || 30000,
      posAlpha: options.posAlpha || 0.30,
      sizeAlpha: options.sizeAlpha || 0.22,
      maxSpeed: options.maxSpeed || 320,
      minAffinityHigh: options.minAffinityHigh || 0.32,
      minAffinityLow: options.minAffinityLow || 0.25
    });

    this.tracks = []; // Active tracks: { id, trackId, x, y, width, height, ... }
    this.dormantTracks = []; // Past tracks remembered for re-entry
    this.nextNumericId = options.startId || 1;
    this.totalUniqueCount = 0;
  }

  /**
   * Format numeric ID to stable 'P-000183' string format
   * @param {number} id 
   * @returns {string}
   */
  formatTrackId(id) {
    return `P-${String(id).padStart(6, '0')}`;
  }

  /**
   * Process incoming detections for a camera frame
   * Input format:
   * {
   *   camera_id: 'CAM-01',
   *   timestamp: 1726300000000,
   *   frame_width: 1280,
   *   frame_height: 720,
   *   detections: [ { bbox: [x, y, w, h], score: 0.94, colorSignature: [...] } ]
   * }
   */
  async process(input = {}) {
    const cameraId = input.camera_id || 'CAM-01';
    const now = input.timestamp || Date.now();
    const wallClockNow = input.wall_clock || Date.now();
    const frameW = input.frame_width || 1280;
    const frameH = input.frame_height || 720;
    const rawDetections = Array.isArray(input.detections) ? input.detections : [];

    // Clean dormant tracks past memory threshold
    this.dormantTracks = this.dormantTracks.filter(
      d => (now - d.departedTime) <= this.config.reentryMemoryMs
    );

    // ByteTrack Stage Partitioning: High vs Low confidence detections
    const highDets = [];
    const lowDets = [];

    for (let i = 0; i < rawDetections.length; i++) {
      const d = rawDetections[i];
      if (!d || !Array.isArray(d.bbox) || d.bbox.length < 4) continue;
      const score = typeof d.score === 'number' ? d.score : 0.5;
      const detItem = {
        index: i,
        bbox: d.bbox,
        score,
        colorSignature: d.colorSignature || null
      };

      if (score >= this.config.highScoreThreshold) {
        highDets.push(detItem);
      } else if (score >= this.config.lowScoreThreshold) {
        lowDets.push(detItem);
      }
    }

    const matchedTrackIndices = new Set();
    const matchedDetIndices = new Set();

    // ─────────────────────────────────────────────────────────────
    // STAGE 1: Match High-Confidence Detections with Active Tracks
    // ─────────────────────────────────────────────────────────────
    this._matchTrackCandidates(
      this.tracks,
      highDets,
      matchedTrackIndices,
      matchedDetIndices,
      now,
      this.config.minAffinityHigh
    );

    // ─────────────────────────────────────────────────────────────
    // STAGE 2: Match Low-Confidence Detections with Remaining Tracks
    // (Recovers occlusions & motion blur without creating new false tracks)
    // ─────────────────────────────────────────────────────────────
    const unmatchedTrackIndices = [];
    for (let tIdx = 0; tIdx < this.tracks.length; tIdx++) {
      if (!matchedTrackIndices.has(tIdx)) {
        unmatchedTrackIndices.push(tIdx);
      }
    }

    if (unmatchedTrackIndices.length > 0 && lowDets.length > 0) {
      const remainingTracks = unmatchedTrackIndices.map(tIdx => ({
        track: this.tracks[tIdx],
        originalIndex: tIdx
      }));

      const matchedLowIndices = new Set();
      const candidatesLow = [];

      for (let rIdx = 0; rIdx < remainingTracks.length; rIdx++) {
        const { track: tr, originalIndex: tIdx } = remainingTracks[rIdx];
        const trBbox = [tr.x, tr.y, tr.width, tr.height];
        const trCx = tr.x + tr.width / 2;
        const trCy = tr.y + tr.height / 2;
        const trRefDim = Math.max(tr.width, tr.height, 60);

        for (let lIdx = 0; lIdx < lowDets.length; lIdx++) {
          const det = lowDets[lIdx];
          const [dx, dy, dw, dh] = det.bbox;
          const detCx = dx + dw / 2;
          const detCy = dy + dh / 2;
          const dist = Math.hypot(trCx - detCx, trCy - detCy);
          const normDist = dist / trRefDim;
          const iou = calculateIoU(trBbox, det.bbox);

          // For recovery, require positive spatial overlap or close proximity
          if (iou > 0.10 || normDist < 0.85) {
            const affinity = (iou * 2.0) + Math.max(0, 1.0 - normDist);
            if (affinity >= this.config.minAffinityLow) {
              candidatesLow.push({ tIdx, lIdx, affinity, det });
            }
          }
        }
      }

      candidatesLow.sort((a, b) => b.affinity - a.affinity);

      for (const cand of candidatesLow) {
        if (!matchedTrackIndices.has(cand.tIdx) && !matchedLowIndices.has(cand.lIdx)) {
          matchedTrackIndices.add(cand.tIdx);
          matchedLowIndices.add(cand.lIdx);
          this._updateTrackWithDetection(this.tracks[cand.tIdx], cand.det, now);
        }
      }
    }

    // ─────────────────────────────────────────────────────────────
    // STAGE 3: Unmatched High-Detections (New Tracks or Re-Entries)
    // ─────────────────────────────────────────────────────────────
    for (let dIdx = 0; dIdx < highDets.length; dIdx++) {
      if (!matchedDetIndices.has(dIdx)) {
        const det = highDets[dIdx];
        const [hx, hy, hw, hh] = det.bbox;
        const detArea = hw * hh;
        const detCx = hx + hw / 2;
        const detCy = hy + hh / 2;

        // Active Track Collision Gating:
        // Strictly reject if this detection heavily overlaps ANY track already active this frame
        let overlapsActiveTrack = false;
        for (const tr of this.tracks) {
          const trBbox = [tr.x, tr.y, tr.width, tr.height];
          const trIoU = calculateIoU(trBbox, det.bbox);
          const trInter = calculateInterArea(trBbox, det.bbox);
          const minArea = Math.min(tr.width * tr.height, detArea);
          const ioMin = minArea > 0 ? trInter / minArea : 0;
          const trCx = tr.x + tr.width / 2;
          const trCy = tr.y + tr.height / 2;
          const dist = Math.hypot(detCx - trCx, detCy - trCy);
          const refDim = Math.min(Math.max(tr.width, tr.height), Math.max(hw, hh), 120);

          if (trIoU > 0.22 || ioMin > 0.45 || (dist / refDim) < 0.45) {
            overlapsActiveTrack = true;
            break;
          }
        }

        if (overlapsActiveTrack) {
          continue; // Prevent phantom double on the same human
        }

        // Check Re-Entry Memory for returning person
        let bestDormantIdx = -1;
        let bestDormantScore = 0;

        for (let k = 0; k < this.dormantTracks.length; k++) {
          const d = this.dormantTracks[k];
          const timeAwaySec = (now - d.departedTime) / 1000;
          if (timeAwaySec > (this.config.reentryMemoryMs / 1000)) continue;

          let colorSim = 0.5;
          let hasColorData = false;
          if (det.colorSignature && d.colorSignature) {
            const cd = Math.hypot(
              det.colorSignature[0] - d.colorSignature[0],
              det.colorSignature[1] - d.colorSignature[1],
              det.colorSignature[2] - d.colorSignature[2]
            );
            if (cd > 55) continue; // Hard reject different clothing
            colorSim = Math.max(0, 1.0 - (cd / 110));
            hasColorData = true;
          }

          const dormArea = d.width * d.height;
          const dormAspect = d.width / Math.max(1, d.height);
          const areaSim = Math.min(detArea, dormArea) / Math.max(detArea, dormArea || 1);
          const aspectSim = Math.min(hw / Math.max(1, hh), dormAspect) / Math.max(hw / Math.max(1, hh), dormAspect || 1);

          const projDt = Math.min(timeAwaySec, 1.5);
          const projCx = (d.x + d.width / 2) + (d.vx || 0) * projDt;
          const projCy = (d.y + d.height / 2) + (d.vy || 0) * projDt;
          const dist = Math.hypot(detCx - projCx, detCy - projCy);
          const personRef = Math.max(d.width, d.height, 60);
          const posProximity = Math.max(0, 1.0 - (dist / personRef) / 2.0);
          const recencyFactor = Math.max(0, 1.0 - (timeAwaySec / (this.config.reentryMemoryMs / 1000)));

          let score;
          if (hasColorData) {
            score = (colorSim * 0.40) + (posProximity * 0.30) + (areaSim * 0.15) + (aspectSim * 0.10) + (recencyFactor * 0.05);
          } else {
            score = (posProximity * 0.50) + (areaSim * 0.25) + (aspectSim * 0.15) + (recencyFactor * 0.10);
          }

          if (score > bestDormantScore && score >= 0.30) {
            bestDormantScore = score;
            bestDormantIdx = k;
          }
        }

        if (bestDormantIdx >= 0) {
          // Re-activate past identity & preserve continuous dwell timer
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

        // Brand-new Person Track Assignment
        const numId = this.nextNumericId++;
        this.totalUniqueCount++;
        const newTrack = {
          id: numId,
          trackId: this.formatTrackId(numId),
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
          lastSeenTime: now,
          lastUpdateTime: now,
          misses: 0,
          totalDetections: 1,
          colorSignature: det.colorSignature || null,
          accumulatedDwellMs: 0
        };
        this.tracks.push(newTrack);
      }
    }

    // ─────────────────────────────────────────────────────────────
    // STAGE 4: Real-Time Track-to-Track Deduplication (Coalescence)
    // Guarantees that two tracks NEVER occupy the same human
    // ─────────────────────────────────────────────────────────────
    for (let i = 0; i < this.tracks.length; i++) {
      for (let j = this.tracks.length - 1; j > i; j--) {
        const t1 = this.tracks[i];
        const t2 = this.tracks[j];
        const b1 = [t1.x, t1.y, t1.width, t1.height];
        const b2 = [t2.x, t2.y, t2.width, t2.height];
        const trIoU = calculateIoU(b1, b2);
        const trInter = calculateInterArea(b1, b2);
        const minArea = Math.min(t1.width * t1.height, t2.width * t2.height);
        const ioMin = minArea > 0 ? trInter / minArea : 0;
        const t1Cx = t1.x + t1.width / 2;
        const t1Cy = t1.y + t1.height / 2;
        const t2Cx = t2.x + t2.width / 2;
        const t2Cy = t2.y + t2.height / 2;
        const dist = Math.hypot(t1Cx - t2Cx, t1Cy - t2Cy);
        const refDim = Math.min(Math.max(t1.width, t1.height), Math.max(t2.width, t2.height), 120);

        if (trIoU > 0.22 || ioMin > 0.45 || (dist / refDim) < 0.45) {
          // Merge duplicate track into the more established track
          if ((t2.totalDetections || 0) > (t1.totalDetections || 0) && t2.misses <= t1.misses) {
            this.tracks[i] = t2;
          }
          this.tracks.splice(j, 1);
        }
      }
    }

    // ─────────────────────────────────────────────────────────────
    // STAGE 5: Evaluate Track Lifecycle & Boundary Exits
    // ─────────────────────────────────────────────────────────────
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
      const isAtBoundary = (
        t.x <= borderMarginX ||
        t.y <= borderMarginY ||
        (t.x + t.width) >= (frameW - borderMarginX) ||
        (t.y + t.height) >= (frameH - borderMarginY)
      );

      const allowedGrace = isAtBoundary ? this.config.exitGraceMs : this.config.interiorGraceMs;

      if (elapsedSinceSeen > allowedGrace) {
        // Departed or out of camera range -> Save to Re-entry memory
        t.departedTime = now;
        t.departedWallClock = wallClockNow;
        t.accumulatedDwellMs = (t.accumulatedDwellMs || 0) + (wallClockNow - t.firstSeenWallClock);
        t.isAtBoundary = isAtBoundary;

        this.dormantTracks = this.dormantTracks.filter(d => d.id !== t.id);
        this.dormantTracks.push(t);

        this.tracks.splice(i, 1);
        continue;
      }

      // Forward position extrapolation for walking subjects during occlusions
      if (!isMatched && t.motionState === 'WALKING' && t.misses < 12) {
        t.x += t.vx * 0.03;
        t.y += t.vy * 0.03;
      }

      const dwellMs = wallClockNow - t.firstSeenWallClock;
      activeResults.push({
        track_id: t.trackId,
        numeric_id: t.id,
        camera_id: cameraId,
        bbox: [Math.round(t.x), Math.round(t.y), Math.round(t.width), Math.round(t.height)],
        confidence: Number(t.score.toFixed(3)),
        velocity: {
          vx: Number((t.vx || 0).toFixed(2)),
          vy: Number((t.vy || 0).toFixed(2))
        },
        motion_state: t.motionState || 'STEADY',
        direction: t.direction || '',
        dwell_ms: dwellMs,
        dwell_formatted: formatDwellTime(dwellMs),
        is_live: isMatched,
        misses: t.misses
      });
    }

    activeResults.sort((a, b) => a.numeric_id - b.numeric_id);

    // Standardized Bot JSON Output Message (Section 36)
    return {
      bot: this.botId,
      type: 'person_track',
      camera_id: cameraId,
      timestamp: now,
      active_count: activeResults.length,
      total_unique_count: this.totalUniqueCount,
      tracks: activeResults
    };
  }

  _matchTrackCandidates(tracks, detections, matchedTrackIndices, matchedDetIndices, now, minAffinity) {
    const candidates = [];

    for (let tIdx = 0; tIdx < tracks.length; tIdx++) {
      const tr = tracks[tIdx];
      const trBbox = [tr.x, tr.y, tr.width, tr.height];
      const trCx = tr.x + tr.width / 2;
      const trCy = tr.y + tr.height / 2;
      const trRefDim = Math.max(tr.width, tr.height, 60);

      for (let dIdx = 0; dIdx < detections.length; dIdx++) {
        const det = detections[dIdx];
        const [dx, dy, dw, dh] = det.bbox;
        const detCx = dx + dw / 2;
        const detCy = dy + dh / 2;

        const dist = Math.hypot(trCx - detCx, trCy - detCy);
        const normDist = dist / trRefDim;
        const iou = calculateIoU(trBbox, det.bbox);

        const trArea = tr.width * tr.height;
        const detArea = dw * dh;
        const areaSim = Math.min(trArea, detArea) / Math.max(trArea, detArea || 1);

        let affinity = 0;
        if (iou > 0.08) {
          affinity = (iou * 2.2) + Math.max(0, 1.0 - normDist) * 0.7 + (areaSim * 0.3);
        } else if (normDist < 0.90) {
          affinity = Math.max(0, 1.0 - (normDist / 0.90)) + (areaSim * 0.25);
        }

        if ((tr.totalDetections || 0) > 2) {
          affinity += 0.15;
        }

        if (det.colorSignature && tr.colorSignature) {
          const cd = Math.hypot(
            det.colorSignature[0] - tr.colorSignature[0],
            det.colorSignature[1] - tr.colorSignature[1],
            det.colorSignature[2] - tr.colorSignature[2]
          );
          if (cd > 55) {
            continue; // Color mismatch -> different person
          } else {
            const colorSim = Math.max(0, 1.0 - (cd / 110));
            affinity += colorSim * 0.30;
          }
        }

        if (affinity >= minAffinity) {
          candidates.push({ tIdx, dIdx, affinity, det });
        }
      }
    }

    candidates.sort((a, b) => b.affinity - a.affinity);

    for (const cand of candidates) {
      if (!matchedTrackIndices.has(cand.tIdx) && !matchedDetIndices.has(cand.dIdx)) {
        matchedTrackIndices.add(cand.tIdx);
        matchedDetIndices.add(cand.dIdx);
        this._updateTrackWithDetection(tracks[cand.tIdx], cand.det, now);
      }
    }
  }

  _updateTrackWithDetection(track, det, now) {
    const [hx, hy, hw, hh] = det.bbox;
    const dt = Math.max(0.02, (now - track.lastUpdateTime) / 1000);
    const currentCx = hx + hw / 2;
    const currentCy = hy + hh / 2;
    const prevCx = track.x + track.width / 2;
    const prevCy = track.y + track.height / 2;

    const instantVx = Math.min(this.config.maxSpeed, Math.max(-this.config.maxSpeed, (currentCx - prevCx) / dt));
    const instantVy = Math.min(this.config.maxSpeed, Math.max(-this.config.maxSpeed, (currentCy - prevCy) / dt));
    track.vx = (track.vx || 0) * 0.70 + instantVx * 0.30;
    track.vy = (track.vy || 0) * 0.70 + instantVy * 0.30;

    const speed = Math.hypot(track.vx, track.vy);
    if (speed > 20) {
      track.motionState = 'WALKING';
      track.direction = Math.abs(track.vx) > Math.abs(track.vy)
        ? (track.vx > 0 ? '→' : '←')
        : (track.vy > 0 ? '↓' : '↑');
    } else {
      track.motionState = 'STEADY';
      track.direction = '';
    }

    // Exponential moving average smoothing for position & bounding box
    track.x = track.x * (1 - this.config.posAlpha) + hx * this.config.posAlpha;
    track.y = track.y * (1 - this.config.posAlpha) + hy * this.config.posAlpha;
    track.width = track.width * (1 - this.config.sizeAlpha) + hw * this.config.sizeAlpha;
    track.height = track.height * (1 - this.config.sizeAlpha) + hh * this.config.sizeAlpha;

    track.score = Math.max(track.score * 0.7, det.score);
    track.lastSeenTime = now;
    track.lastUpdateTime = now;
    track.misses = 0;
    track.totalDetections = (track.totalDetections || 0) + 1;

    if (det.colorSignature) {
      track.colorSignature = det.colorSignature;
    }
  }

  /**
   * Reset tracking state
   */
  clear() {
    this.tracks = [];
    this.dormantTracks = [];
  }
}

module.exports = {
  TrackingBot,
  calculateIoU,
  formatDwellTime
};
