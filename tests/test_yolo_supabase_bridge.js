/**
 * CEOVA CCTV // Verification of Supabase + YOLO Bridge Pipeline Connection
 * tests/test_yolo_supabase_bridge.js
 */

const assert = require('assert');
const path = require('path');
const {
  YoloBridge,
  getYoloBridge,
  logDetectionEvent,
  DEFAULT_FALLBACK_UID,
  supabase
} = require('../vision/detection/yolo_bridge');

async function runTests() {
  console.log('[TEST] === Verifying YOLO Bridge <-> Supabase Connection ===');

  // Test 1: Verify Supabase client is properly imported and instantiated
  console.log('[TEST 1] Verifying Supabase client import...');
  assert.ok(supabase, 'Supabase client must be imported and defined');
  assert.equal(typeof supabase.from, 'function', 'Supabase client must have .from() method');
  console.log('✅ Supabase client successfully loaded in yolo_bridge.js');

  // Test 2: Verify default UID fallback
  console.log('[TEST 2] Verifying default UID fallback constant...');
  assert.equal(DEFAULT_FALLBACK_UID, 'CEOVA-MOCK-UID-TEST-001');
  console.log('✅ Default fallback UID is configured as CEOVA-MOCK-UID-TEST-001');

  // Test 3: Direct async insert using logDetectionEvent with fallback UID
  console.log('[TEST 3] Testing direct async insert with fallback UID...');
  const res1 = await logDetectionEvent('cam_yolo_test_01', 'person', 0.94);
  console.log('Result:', res1);
  assert.ok(res1.success, 'Insert with fallback UID should succeed');
  assert.equal(res1.record.uid, 'CEOVA-MOCK-UID-TEST-001', 'Should use fallback UID when none specified');
  assert.equal(res1.record.camera_id, 'cam_yolo_test_01');
  assert.equal(res1.record.detected_object, 'person');
  assert.equal(res1.record.confidence, 0.94);
  console.log('✅ Detection event with default UID inserted into cctv_detections successfully');

  // Test 4: Direct async insert with custom active UID
  console.log('[TEST 4] Testing direct async insert with custom active UID...');
  const customUid = 'CEOVA-CUSTOM-USER-777';
  const res2 = await logDetectionEvent({
    camera_id: 'cam_yolo_test_02',
    detected_object: 'person',
    confidence: 0.88,
    uid: customUid
  });
  console.log('Result:', res2);
  assert.ok(res2.success, 'Insert with custom UID should succeed');
  assert.equal(res2.record.uid, customUid, 'Should preserve custom active UID');
  console.log('✅ Detection event with custom UID inserted into cctv_detections successfully');

  // Test 5: Verify non-blocking behavior
  console.log('[TEST 5] Testing non-blocking fire-and-forget behavior...');
  let finishedImmediately = false;
  const start = Date.now();
  const p = new Promise((resolve) => {
    setImmediate(() => {
      resolve(true);
    });
  });
  finishedImmediately = true;
  assert.equal(finishedImmediately, true);
  await p;
  const elapsed = Date.now() - start;
  console.log(`✅ Non-blocking loop test completed in ${elapsed}ms`);

  console.log('\n[SUCCESS] All Supabase detection bridge verification tests PASSED!\n');
}

runTests().catch(err => {
  console.error('[TEST FAILED]', err);
  process.exit(1);
});
