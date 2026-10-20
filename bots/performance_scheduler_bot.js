/**
 * CEOVA CCTV // Bot-Based AI Architecture
 * bots/performance_scheduler_bot.js
 * 
 * Performance Scheduler Bot (Phase 4)
 * 
 * Central AI execution scheduler for multi-camera CCTV installations.
 * - Allocates compute budget across multiple video streams based on:
 *   - Camera priority (HIGH / NORMAL / LOW)
 *   - Motion activity & detected people
 *   - Current host latency & available CPU/GPU headroom
 * - Prevents system choking by load-shedding low-priority cameras during peak bursts.
 * - Enforces minimum starvation guarantees so every camera receives periodic scans.
 */

const { BaseBot } = require('./base_bot');

const PRIORITY_WEIGHTS = {
  CRITICAL: 4.0,
  HIGH: 2.5,
  NORMAL: 1.0,
  LOW: 0.4
};

class PerformanceSchedulerBot extends BaseBot {
  constructor(options = {}) {
    super('performance_scheduler_bot', '1.0.0', {
      totalFpsBudget: options.totalFpsBudget || 30, // Aggregate detection FPS across all cameras
      latencyTargetMs: options.latencyTargetMs || 100, // Maximum acceptable latency before backoff
      starvationIntervalMs: options.starvationIntervalMs || 4000 // Guarantee scan at least every 4s
    });

    this.cameras = new Map(); // cameraId -> { priority, activePeople, motionDetected, lastInferenceTime, allocatedFps, ... }
    this.totalDispatched = 0;
    this.totalShed = 0;
    this.latencyHistory = [];
  }

  /**
   * Register or update a camera in the scheduler
   * @param {string} cameraId 
   * @param {Object} options - { priority: 'HIGH'|'NORMAL'|'LOW', zoneName: 'Entrance' }
   */
  registerCamera(cameraId, options = {}) {
    const priority = (options.priority || 'NORMAL').toUpperCase();
    const existing = this.cameras.get(cameraId) || {};
    this.cameras.set(cameraId, {
      cameraId,
      priority: PRIORITY_WEIGHTS[priority] ? priority : 'NORMAL',
      zoneName: options.zoneName || 'General',
      activePeople: 0,
      motionDetected: false,
      lastInferenceTime: 0,
      allocatedFps: 5,
      dispatchedCount: 0,
      shedCount: 0,
      ...existing,
      ...options
    });
    this.recomputeAllocations();
    this.log(`Camera registered: ${cameraId} [Priority: ${priority}]`);
  }

  /**
   * Unregister camera on disconnect
   * @param {string} cameraId 
   */
  unregisterCamera(cameraId) {
    if (this.cameras.has(cameraId)) {
      this.cameras.delete(cameraId);
      this.recomputeAllocations();
      this.log(`Camera unregistered: ${cameraId}`);
    }
  }

  /**
   * Recompute dynamic FPS allocations across all cameras based on priority & activity
   */
  recomputeAllocations() {
    const camCount = this.cameras.size;
    if (camCount === 0) return;

    let totalWeight = 0;
    for (const cam of this.cameras.values()) {
      let weight = PRIORITY_WEIGHTS[cam.priority] || 1.0;
      if (cam.activePeople > 0) {
        weight *= 1.5; // Boost weight if people are in view
      }
      if (cam.motionDetected) {
        weight *= 1.25; // Boost weight on active motion
      }
      cam.dynamicWeight = weight;
      totalWeight += weight;
    }

    // Allocate share of total FPS budget
    const budget = this.config.totalFpsBudget;
    for (const cam of this.cameras.values()) {
      const share = cam.dynamicWeight / totalWeight;
      const allocated = Math.max(1, Math.min(15, Number((budget * share).toFixed(1))));
      cam.allocatedFps = allocated;
      cam.intervalMs = Math.round(1000 / allocated);
    }
  }

  /**
   * Process a scheduling request from a camera
   * Input format:
   * {
   *   camera_id: 'CAM-01',
   *   timestamp: 1726300000000,
   *   active_people: 2,
   *   motion_detected: true,
   *   last_latency_ms: 45
   * }
   */
  async process(input = {}) {
    const cameraId = input.camera_id || 'CAM-01';
    const now = input.timestamp || Date.now();
    const activePeople = input.active_people || 0;
    const motionDetected = Boolean(input.motion_detected);
    const lastLatency = input.last_latency_ms || 0;

    if (lastLatency > 0) {
      this.latencyHistory.push(lastLatency);
      if (this.latencyHistory.length > 20) {
        this.latencyHistory.shift();
      }
    }

    if (!this.cameras.has(cameraId)) {
      this.registerCamera(cameraId, { priority: 'NORMAL' });
    }

    const cam = this.cameras.get(cameraId);
    let stateChanged = false;

    if (cam.activePeople !== activePeople || cam.motionDetected !== motionDetected) {
      cam.activePeople = activePeople;
      cam.motionDetected = motionDetected;
      stateChanged = true;
    }

    if (stateChanged) {
      this.recomputeAllocations();
    }

    const timeSinceLast = now - cam.lastInferenceTime;
    const isStarved = timeSinceLast >= this.config.starvationIntervalMs;

    // Check recent average latency for load-shedding
    const avgLatency = this.latencyHistory.length > 0
      ? (this.latencyHistory.reduce((a, b) => a + b, 0) / this.latencyHistory.length)
      : 0;

    let allowExecution = false;
    let reason = 'WAIT_INTERVAL';

    if (isStarved) {
      allowExecution = true;
      reason = 'STARVATION_PREVENTION';
    } else if (timeSinceLast >= cam.intervalMs) {
      if (avgLatency > this.config.latencyTargetMs && cam.priority === 'LOW') {
        // Shed low-priority camera to protect overall system responsiveness
        allowExecution = false;
        reason = 'LOAD_SHED_LATENCY';
        cam.shedCount++;
        this.totalShed++;
      } else {
        allowExecution = true;
        reason = 'SCHEDULED_SLOT';
      }
    }

    if (allowExecution) {
      cam.lastInferenceTime = now;
      cam.dispatchedCount++;
      this.totalDispatched++;
    }

    return {
      bot: this.botId,
      type: 'schedule_decision',
      camera_id: cameraId,
      timestamp: now,
      allowed: allowExecution,
      allocated_fps: cam.allocatedFps,
      interval_ms: cam.intervalMs,
      reason,
      average_latency_ms: Number(avgLatency.toFixed(1)),
      total_cameras: this.cameras.size
    };
  }

  /**
   * Get complete scheduler status & camera allocations
   */
  getSchedulerStatus() {
    const cameraList = [];
    for (const cam of this.cameras.values()) {
      cameraList.push({
        camera_id: cam.cameraId,
        zone: cam.zoneName,
        priority: cam.priority,
        allocated_fps: cam.allocatedFps,
        interval_ms: cam.intervalMs,
        active_people: cam.activePeople,
        motion: cam.motionDetected,
        dispatched: cam.dispatchedCount,
        shed: cam.shedCount
      });
    }

    const avgLatency = this.latencyHistory.length > 0
      ? (this.latencyHistory.reduce((a, b) => a + b, 0) / this.latencyHistory.length)
      : 0;

    return {
      total_cameras: this.cameras.size,
      total_fps_budget: this.config.totalFpsBudget,
      average_latency_ms: Number(avgLatency.toFixed(1)),
      total_dispatched: this.totalDispatched,
      total_shed: this.totalShed,
      cameras: cameraList
    };
  }
}

module.exports = {
  PerformanceSchedulerBot
};
