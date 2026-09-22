/**
 * CEOVA CCTV // Bot-Based AI Architecture
 * bots/adaptive_inference_bot.js
 * 
 * Adaptive Inference Bot (Phase 3)
 * 
 * Compute optimization governor that interleaves lightweight tracking and heavy detection.
 * - Camera feeds at 25-30 FPS.
 * - Detector runs adaptively at 2-12 FPS.
 * - Tracking bot updates continuous trajectories between detections.
 * - Motion-Aware Gating:
 *   - No activity & 0 people: throttles detector to idle refresh (1-2 FPS), cutting CPU usage up to 80%.
 *   - Motion detected or active tracks: raises detection rate to optimal target (8-12 FPS).
 * - Load-Aware Backoff: throttles detector if system latency exceeds budget to prevent frame freezes.
 */

const { BaseBot } = require('./base_bot');

class AdaptiveInferenceBot extends BaseBot {
  constructor(options = {}) {
    super('adaptive_inference_bot', '1.0.0', {
      baseDetectionFps: options.baseDetectionFps || 8, // Target detection rate under normal activity
      idleDetectionFps: options.idleDetectionFps || 1.5, // Reduced rate when scene is motionless & empty
      maxDetectionFps: options.maxDetectionFps || 15, // Burst rate for crowded/fast scenes on capable hardware
      motionPixelDiffThreshold: options.motionPixelDiffThreshold || 25, // Sensitivity for frame diffing
      motionPercentTrigger: options.motionPercentTrigger || 2.5, // % changed pixels considered meaningful visual change
      maxLatencyBudgetMs: options.maxLatencyBudgetMs || 150 // Backoff threshold if inference takes too long
    });

    this.lastInferenceTime = 0;
    this.lastFrameData = null;
    this.consecutiveStaticFrames = 0;
    this.currentEffectiveFps = this.config.baseDetectionFps;
  }

  /**
   * Process frame activity and decide whether to trigger expensive AI detection
   * Input format:
   * {
   *   camera_id: 'CAM-01',
   *   timestamp: 1726300000000,
   *   active_track_count: 2,
   *   frame_diff_percent: 4.2, // Optional pre-calculated diff
   *   system_latency_ms: 32,   // Optional current inference latency
   *   force_detection: false
   * }
   */
  async process(input = {}) {
    const now = input.timestamp || Date.now();
    const activePeopleCount = input.active_track_count || 0;
    const forceDetection = Boolean(input.force_detection);
    const systemLatency = input.system_latency_ms || 0;
    const diffPercent = typeof input.frame_diff_percent === 'number'
      ? input.frame_diff_percent
      : null;

    let meaningfulMotion = false;
    if (diffPercent !== null) {
      meaningfulMotion = diffPercent >= this.config.motionPercentTrigger;
    }

    // 1. Dynamic FPS Budget Allocation based on visual state & scene complexity
    let targetFps = this.config.baseDetectionFps;
    let strategyReason = 'NORMAL_ACTIVITY';

    // Latency Backoff: If system is lagging behind budget, shed detector load
    if (systemLatency > this.config.maxLatencyBudgetMs) {
      targetFps = Math.max(2, this.config.baseDetectionFps * 0.5);
      strategyReason = 'OVERLOAD_BACKOFF';
    } else if (activePeopleCount === 0 && !meaningfulMotion) {
      // Idle Scene Gating: Room is completely empty and static
      this.consecutiveStaticFrames++;
      if (this.consecutiveStaticFrames > 10) {
        targetFps = this.config.idleDetectionFps;
        strategyReason = 'IDLE_THROTTLE';
      }
    } else {
      this.consecutiveStaticFrames = 0;
      if (activePeopleCount >= 3 || (meaningfulMotion && diffPercent > 6.0)) {
        // High scene complexity or fast crowd motion: boost detection rate
        targetFps = Math.min(this.config.maxDetectionFps, this.config.baseDetectionFps * 1.5);
        strategyReason = 'COMPLEXITY_BOOST';
      } else if (meaningfulMotion) {
        targetFps = this.config.baseDetectionFps;
        strategyReason = 'MOTION_TRIGGER';
      }
    }

    this.currentEffectiveFps = Number(targetFps.toFixed(1));
    const targetIntervalMs = Math.round(1000 / targetFps);
    const timeSinceLastInference = now - this.lastInferenceTime;

    let shouldRunDetector = false;
    let decisionReason = strategyReason;

    if (forceDetection) {
      shouldRunDetector = true;
      decisionReason = 'FORCED_KEYFRAME';
    } else if (timeSinceLastInference >= targetIntervalMs) {
      shouldRunDetector = true;
      this.lastInferenceTime = now;
    } else {
      shouldRunDetector = false;
      decisionReason = 'INTERLEAVED_TRACK_ONLY';
    }

    return {
      bot: this.botId,
      type: 'adaptive_decision',
      camera_id: input.camera_id || 'CAM-01',
      timestamp: now,
      should_detect: shouldRunDetector,
      effective_fps: this.currentEffectiveFps,
      interval_ms: targetIntervalMs,
      time_since_last_ms: timeSinceLastInference,
      active_people: activePeopleCount,
      motion_detected: meaningfulMotion,
      reason: decisionReason
    };
  }

  /**
   * Helper to compute fast frame-difference on downscaled raw pixel data (e.g. 64x36)
   * @param {Uint8ClampedArray|Buffer} currentPixels - RGBA byte buffer
   * @param {Uint8ClampedArray|Buffer} prevPixels - RGBA byte buffer
   * @param {number} threshold 
   * @returns {number} percentage of changed pixels (0 - 100)
   */
  static computePixelDiff(currentPixels, prevPixels, threshold = 25) {
    if (!currentPixels || !prevPixels || currentPixels.length !== prevPixels.length) {
      return 0;
    }
    let changed = 0;
    const totalPixels = currentPixels.length / 4;

    for (let i = 0; i < currentPixels.length; i += 4) {
      const rDiff = Math.abs(currentPixels[i] - prevPixels[i]);
      const gDiff = Math.abs(currentPixels[i + 1] - prevPixels[i + 1]);
      const bDiff = Math.abs(currentPixels[i + 2] - prevPixels[i + 2]);
      const avg = (rDiff + gDiff + bDiff) / 3;
      if (avg > threshold) {
        changed++;
      }
    }
    return (changed / totalPixels) * 100;
  }
}

module.exports = {
  AdaptiveInferenceBot
};
