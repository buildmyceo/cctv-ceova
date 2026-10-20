/**
 * CEOVA CCTV // Automated Test Suite
 * tests/test_bots_suite.js
 * 
 * Comprehensive Unit, Integration & Performance Tests for:
 * 1. BaseBot & Bot Registry
 * 2. Person Tracking Bot (ByteTrack, Stable IDs, Deduplication, Occlusion)
 * 3. Adaptive Inference Bot (Motion Optimization, Dynamic FPS, Backoff)
 * 4. Hardware Detection Bot (CPU/RAM/GPU Profiling, Telemetry)
 * 5. Performance Scheduler Bot (Multi-Camera Prioritization, Starvation Guard)
 */

const assert = require('assert');
const {
  registry,
  TrackingBot,
  AdaptiveInferenceBot,
  HardwareBot,
  PerformanceSchedulerBot
} = require('../bots');

async function runSuite() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('       CEOVA CCTV — MODULAR BOT ARCHITECTURE TEST SUITE    ');
  console.log('═══════════════════════════════════════════════════════════\n');

  let passed = 0;
  let total = 0;

  async function test(name, fn) {
    total++;
    try {
      await fn();
      console.log(`✅ [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`❌ [FAIL] ${name}`);
      console.error(`   Reason: ${err.message}`);
      if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 1. BaseBot & Registry Lifecycle Tests
  // ─────────────────────────────────────────────────────────────
  console.log('--- 1. BaseBot & Registry Lifecycle ---');
  await test('Bot registry manages all 4 core bots', async () => {
    assert(registry.get('tracking_bot') instanceof TrackingBot, 'TrackingBot not registered');
    assert(registry.get('adaptive_inference_bot') instanceof AdaptiveInferenceBot, 'AdaptiveInferenceBot not registered');
    assert(registry.get('hardware_bot') instanceof HardwareBot, 'HardwareBot not registered');
    assert(registry.get('performance_scheduler_bot') instanceof PerformanceSchedulerBot, 'SchedulerBot not registered');
  });

  await test('registry.initializeAll() brings all bots ONLINE with healthy heartbeats', async () => {
    const initResults = await registry.initializeAll();
    assert.strictEqual(initResults['tracking_bot'], 'ONLINE');
    assert.strictEqual(initResults['hardware_bot'], 'ONLINE');
    assert.strictEqual(initResults['adaptive_inference_bot'], 'ONLINE');
    assert.strictEqual(initResults['performance_scheduler_bot'], 'ONLINE');

    const health = registry.getAllHealth();
    for (const botId of Object.keys(health)) {
      assert.strictEqual(health[botId].status, 'ONLINE');
      assert(health[botId].last_heartbeat, 'Missing heartbeat');
      assert.strictEqual(health[botId].error_count, 0);
    }
  });

  // ─────────────────────────────────────────────────────────────
  // 2. Person Tracking Bot Tests
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 2. Person Tracking Bot (Phase 2) ---');
  await test('Generates stable formatted track IDs (e.g. P-000001)', async () => {
    const tracker = new TrackingBot({ startId: 1 });
    await tracker.initialize();

    const t0 = 1000000;
    const res1 = await tracker.execute({
      camera_id: 'CAM-01',
      timestamp: t0,
      wall_clock: t0,
      detections: [
        { bbox: [100, 100, 80, 180], score: 0.95 }
      ]
    });

    assert.strictEqual(res1.active_count, 1);
    assert.strictEqual(res1.tracks[0].track_id, 'P-000001');
    assert.strictEqual(res1.tracks[0].motion_state, 'STEADY');
  });

  await test('Temporal continuity: Maintains same track ID across consecutive frames', async () => {
    const tracker = new TrackingBot({ startId: 42 });
    await tracker.initialize();

    let t = 1000000;
    // Frame 1
    const r1 = await tracker.execute({
      camera_id: 'CAM-01',
      timestamp: t,
      detections: [{ bbox: [100, 100, 80, 180], score: 0.95 }]
    });
    assert.strictEqual(r1.tracks[0].track_id, 'P-000042');

    // Frame 2 (slight movement)
    t += 100;
    const r2 = await tracker.execute({
      camera_id: 'CAM-01',
      timestamp: t,
      detections: [{ bbox: [104, 101, 80, 180], score: 0.93 }]
    });
    assert.strictEqual(r2.tracks.length, 1);
    assert.strictEqual(r2.tracks[0].track_id, 'P-000042', 'Track ID changed between frames!');
    assert.strictEqual(r2.total_unique_count, 1);
  });

  await test('ByteTrack Stage 2 recovery: Recovers occluded/blurred person using low-confidence detection', async () => {
    const tracker = new TrackingBot({ highScoreThreshold: 0.50, lowScoreThreshold: 0.20 });
    await tracker.initialize();

    let t = 1000000;
    // Frame 1: Clear detection
    await tracker.execute({
      camera_id: 'CAM-01',
      timestamp: t,
      detections: [{ bbox: [200, 200, 100, 200], score: 0.92 }]
    });

    // Frame 2: Person partially occluded / turning (score drops to 0.28, below high threshold)
    t += 100;
    const r2 = await tracker.execute({
      camera_id: 'CAM-01',
      timestamp: t,
      detections: [{ bbox: [205, 202, 95, 195], score: 0.28 }]
    });

    assert.strictEqual(r2.active_count, 1);
    assert.strictEqual(r2.tracks[0].track_id, 'P-000001');
    assert.strictEqual(r2.tracks[0].is_live, true, 'Low confidence detection was not recovered via Stage 2!');
  });

  await test('Deduplication: Prevents duplicate tracks on the exact same person (Solves "2 humans showing as 4")', async () => {
    const tracker = new TrackingBot();
    await tracker.initialize();

    const t = 1000000;
    // Model erroneously returns 3 overlapping boxes for 1 person (e.g. torso + full body + arms)
    const res = await tracker.execute({
      camera_id: 'CAM-01',
      timestamp: t,
      detections: [
        { bbox: [300, 200, 120, 240], score: 0.96 }, // Full body
        { bbox: [310, 205, 100, 140], score: 0.75 }, // Torso/upper body (contained inside full body)
        { bbox: [305, 210, 115, 235], score: 0.82 }  // Shifted duplicate
      ]
    });

    assert.strictEqual(res.active_count, 1, `Expected strictly 1 track for overlapping person, got ${res.active_count}!`);
  });

  await test('Multi-person independence: Tracks 2 distinct people as strictly 2 distinct tracks', async () => {
    const tracker = new TrackingBot();
    await tracker.initialize();

    const t = 1000000;
    // Two distinct people (Person A on left, Person B on right)
    const res = await tracker.execute({
      camera_id: 'CAM-01',
      timestamp: t,
      detections: [
        { bbox: [100, 150, 90, 200], score: 0.91 }, // Person A (left)
        { bbox: [600, 150, 95, 210], score: 0.94 }  // Person B (right)
      ]
    });

    assert.strictEqual(res.active_count, 2);
    assert.strictEqual(res.tracks[0].track_id, 'P-000001');
    assert.strictEqual(res.tracks[1].track_id, 'P-000002');
  });

  await test('Occlusion tolerance: Remembers track during complete detection blackout', async () => {
    const tracker = new TrackingBot({ interiorGraceMs: 3000 });
    await tracker.initialize();

    let t = 1000000;
    await tracker.execute({
      camera_id: 'CAM-01',
      timestamp: t,
      detections: [{ bbox: [400, 300, 80, 180], score: 0.88 }]
    });

    // Frame 2: Person occluded (0 detections)
    t += 500;
    const r2 = await tracker.execute({
      camera_id: 'CAM-01',
      timestamp: t,
      detections: []
    });
    assert.strictEqual(r2.active_count, 1, 'Track was dropped prematurely during temporary occlusion!');
    assert.strictEqual(r2.tracks[0].is_live, false);

    // Frame 3: Person reappears
    t += 500;
    const r3 = await tracker.execute({
      camera_id: 'CAM-01',
      timestamp: t,
      detections: [{ bbox: [405, 300, 80, 180], score: 0.90 }]
    });
    assert.strictEqual(r3.tracks[0].track_id, 'P-000001', 'Reappearing person got a new ID!');
  });

  // ─────────────────────────────────────────────────────────────
  // 3. Adaptive Inference Bot Tests
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 3. Adaptive Inference Bot (Phase 3) ---');
  await test('Throttles detection rate to idle when room is empty and motionless', async () => {
    const adaptiveBot = new AdaptiveInferenceBot({ baseDetectionFps: 8, idleDetectionFps: 1.5 });
    await adaptiveBot.initialize();

    let t = 1000000;
    // Feed 15 consecutive static frames with 0 people
    let lastDecision = null;
    for (let i = 0; i < 15; i++) {
      lastDecision = await adaptiveBot.execute({
        timestamp: t,
        active_track_count: 0,
        frame_diff_percent: 0.2 // Minimal noise
      });
      t += 40; // 25 FPS video stream interval
    }

    assert.strictEqual(lastDecision.effective_fps, 1.5);
    assert(lastDecision.interval_ms >= 600, 'Interval was not lengthened for idle room');
  });

  await test('Bursts detection rate when meaningful motion occurs in scene', async () => {
    const adaptiveBot = new AdaptiveInferenceBot({ baseDetectionFps: 8, motionPercentTrigger: 2.5 });
    await adaptiveBot.initialize();

    const decision = await adaptiveBot.execute({
      timestamp: 1000000,
      active_track_count: 0,
      frame_diff_percent: 5.4 // Significant motion trigger
    });

    assert.strictEqual(decision.motion_detected, true);
    assert.strictEqual(decision.effective_fps, 8);
  });

  await test('Overload backoff: Automatically reduces FPS when system latency exceeds budget', async () => {
    const adaptiveBot = new AdaptiveInferenceBot({ baseDetectionFps: 10, maxLatencyBudgetMs: 120 });
    await adaptiveBot.initialize();

    const decision = await adaptiveBot.execute({
      timestamp: 1000000,
      active_track_count: 2,
      system_latency_ms: 180 // Latency spike
    });

    assert.strictEqual(decision.reason, 'OVERLOAD_BACKOFF');
    assert(decision.effective_fps < 10, 'Did not backoff detection rate under high latency');
  });

  // ─────────────────────────────────────────────────────────────
  // 4. Hardware Detection Bot Tests
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 4. Hardware Detection Bot (Phase 4) ---');
  await test('Scans host hardware and determines concrete profile', async () => {
    const hwBot = new HardwareBot();
    const res = await hwBot.execute({});

    assert(res.profile, 'Missing hardware profile');
    assert(['LOW', 'STANDARD', 'HIGH', 'GPU'].includes(res.profile), `Invalid profile: ${res.profile}`);
    assert(res.hardware.cpu_cores >= 1, 'Invalid CPU core count');
    assert(res.hardware.total_ram_gb > 0, 'Invalid RAM count');
    assert(res.configuration.recommended_detection_fps >= 4, 'Invalid recommended FPS');
    assert(res.telemetry.memory_usage_percent >= 0, 'Invalid telemetry memory percent');
    console.log(`   Host Profile: [${res.profile}] on ${res.hardware.cpu_cores}-core ${res.hardware.architecture} with ${res.hardware.gpu_name}`);
  });

  await test('Respects forced hardware profile configuration for testing and constraints', async () => {
    const hwLow = new HardwareBot({ forceProfile: 'LOW' });
    const rLow = await hwLow.execute({});
    assert.strictEqual(rLow.profile, 'LOW');

    const hwGpu = new HardwareBot({ forceProfile: 'GPU' });
    const rGpu = await hwGpu.execute({});
    assert.strictEqual(rGpu.profile, 'GPU');
  });

  // ─────────────────────────────────────────────────────────────
  // 5. Performance Scheduler Bot Tests
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 5. Performance Scheduler Bot (Phase 4) ---');
  await test('Allocates higher compute share to HIGH priority camera vs LOW priority camera', async () => {
    const scheduler = new PerformanceSchedulerBot({ totalFpsBudget: 20 });
    await scheduler.initialize();

    scheduler.registerCamera('CAM-ENTRANCE', { priority: 'HIGH' });
    scheduler.registerCamera('CAM-STORAGE', { priority: 'LOW' });

    const status = scheduler.getSchedulerStatus();
    const entrance = status.cameras.find(c => c.camera_id === 'CAM-ENTRANCE');
    const storage = status.cameras.find(c => c.camera_id === 'CAM-STORAGE');

    assert(entrance.allocated_fps > storage.allocated_fps, 'HIGH priority camera was not allocated more FPS than LOW priority camera!');
    console.log(`   CAM-ENTRANCE (HIGH): ${entrance.allocated_fps} FPS vs CAM-STORAGE (LOW): ${storage.allocated_fps} FPS`);
  });

  await test('Starvation prevention: Ensures low-priority camera is granted execution if waiting too long', async () => {
    const scheduler = new PerformanceSchedulerBot({ starvationIntervalMs: 2000 });
    await scheduler.initialize();

    scheduler.registerCamera('CAM-EMPTY', { priority: 'LOW' });

    // Request at t = 0
    await scheduler.execute({ camera_id: 'CAM-EMPTY', timestamp: 1000 });

    // Request at t = 5000 (exceeds 2000ms starvation threshold)
    const decision = await scheduler.execute({
      camera_id: 'CAM-EMPTY',
      timestamp: 6000,
      last_latency_ms: 200
    });

    assert.strictEqual(decision.allowed, true);
    assert.strictEqual(decision.reason, 'STARVATION_PREVENTION');
  });

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(` RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('═══════════════════════════════════════════════════════════\n');

  if (passed !== total) {
    process.exit(1);
  }
}

runSuite().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
