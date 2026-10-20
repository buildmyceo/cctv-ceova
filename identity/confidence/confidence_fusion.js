/**
 * CEOVA CCTV // Identity Engine
 * identity/confidence/confidence_fusion.js
 * 
 * Dedicated Multi-Signal Confidence Fusion Engine.
 * 
 * Fuses Body Re-ID, Optional Face, Uniform Analysis, Staff Zone, Schedule,
 * Camera Transition, Tracking Consistency, and Image Quality into a single
 * calibrated identity confidence score.
 * 
 * CRITICAL RULE:
 * Never forces a classification when evidence is weak or contradictory.
 * If final confidence < threshold -> Safe UNKNOWN fallback.
 */

class ConfidenceFusion {
  constructor(options = {}) {
    // Configurable thresholds
    this.staffDecisionThreshold = options.staffThreshold || 0.78;
    this.uncertainFloor = options.uncertainFloor || 0.60;
  }

  /**
   * Fuse multiple independent evidence signals into a final role confidence
   * @param {Object} signals 
   * @returns {Object} Fusion decision { finalStaffConfidence, isStaff, roleCandidate, reasoning, weightsUsed }
   */
  fuseEvidence(signals = {}) {
    const {
      bodyReidScore = 0.0,
      faceScore = null, // null if disabled or no face visible
      uniformScore = 0.0,
      staffZoneScore = 0.5, // 1.0 if inside staff zone, 0.5 if neutral, 0.2 if off-limits
      scheduleScore = 0.5, // 1.0 if inside shift, 0.3 if off-hours
      cameraTransitionScore = 0.8, // from topology
      trackingConsistency = 0.7, // based on track dwell & stability
      imageQuality = 0.8 // from quality checker
    } = signals;

    // Determine weight distribution based on whether face recognition is active
    let weights;
    const hasFace = (faceScore !== null && faceScore !== undefined && !isNaN(faceScore));

    if (hasFace) {
      weights = {
        reid: 0.30,
        face: 0.25,
        uniform: 0.15,
        zone: 0.10,
        schedule: 0.08,
        transition: 0.07,
        tracking: 0.05
      };
    } else {
      // Re-normalize weights when face is unavailable
      weights = {
        reid: 0.42,
        face: 0.0,
        uniform: 0.22,
        zone: 0.14,
        schedule: 0.10,
        transition: 0.07,
        tracking: 0.05
      };
    }

    // Weighted linear combination
    let rawScore = (
      bodyReidScore * weights.reid +
      (hasFace ? faceScore * weights.face : 0) +
      uniformScore * weights.uniform +
      staffZoneScore * weights.zone +
      scheduleScore * weights.schedule +
      cameraTransitionScore * weights.transition +
      trackingConsistency * weights.tracking
    );

    // Apply image quality scaling factor: poor image quality dampens confidence
    if (imageQuality < 0.60) {
      const damping = Math.max(0.70, imageQuality / 0.60);
      rawScore *= damping;
    }

    // Guard rails: Contradiction penalties
    // 1. High uniform alone (e.g. customer in similar shirt) with poor Re-ID & off-schedule
    if (uniformScore > 0.85 && bodyReidScore < 0.45) {
      rawScore *= 0.65; // Heavily penalize uniform-only appearance
    }

    // 2. High Re-ID but prohibited zone or off-schedule
    if (bodyReidScore > 0.85 && staffZoneScore < 0.3) {
      rawScore *= 0.85;
    }

    // 3. Strict rule: Uniform is strictly supporting evidence!
    // Without strong body Re-ID (>= 0.76) or verified face match (>= 0.75), cap below staff threshold
    if (bodyReidScore < 0.76 && (!hasFace || faceScore < 0.75)) {
      rawScore = Math.min(rawScore, this.staffDecisionThreshold - 0.05);
    }

    const finalStaffConfidence = Number(Math.max(0.0, Math.min(1.0, rawScore)).toFixed(3));

    // Decision Logic
    let roleCandidate = 'UNKNOWN';
    let isStaff = false;
    let reasoning = '';

    if (finalStaffConfidence >= this.staffDecisionThreshold) {
      isStaff = true;
      roleCandidate = 'STAFF';
      reasoning = `Strong multi-evidence convergence (Confidence: ${(finalStaffConfidence * 100).toFixed(1)}%). Re-ID: ${bodyReidScore.toFixed(2)}, Uniform: ${uniformScore.toFixed(2)}${hasFace ? `, Face: ${faceScore.toFixed(2)}` : ''}.`;
    } else if (finalStaffConfidence >= this.uncertainFloor) {
      roleCandidate = 'UNKNOWN';
      reasoning = `Plausible staff similarity but confidence (${(finalStaffConfidence * 100).toFixed(1)}%) below required threshold (${(this.staffDecisionThreshold * 100).toFixed(0)}%). Defaulting safely to UNKNOWN.`;
    } else {
      roleCandidate = 'UNKNOWN';
      reasoning = `Insufficient evidence for staff recognition (Confidence: ${(finalStaffConfidence * 100).toFixed(1)}%). Classified as UNKNOWN.`;
    }

    return {
      finalStaffConfidence,
      isStaff,
      roleCandidate,
      reasoning,
      weightsUsed: weights,
      evidenceSummary: {
        bodyReid: bodyReidScore,
        face: hasFace ? faceScore : 'UNAVAILABLE',
        uniform: uniformScore,
        staffZone: staffZoneScore,
        schedule: scheduleScore,
        cameraTransition: cameraTransitionScore,
        trackingConsistency,
        imageQuality
      }
    };
  }
}

module.exports = {
  ConfidenceFusion
};
