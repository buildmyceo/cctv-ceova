/**
 * CEOVA CCTV // Test Suite
 * tests/test_remind_memory.js
 * 
 * Verifies REMIND Dual-Bank Multi-Prototype Memory,
 * Anti-Drift Consolidation, Ambiguity Safeguards, and Zero-Lag Latency.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { ReidExtractor } = require('../vision/reid/reid_extractor');
const { GlobalIdentityManager } = require('../identity/cross_camera/global_identity_manager');
const { CeovaDatabase } = require('../db/database');

// Helper to generate a normalized 128-d synthetic embedding
function createSyntheticEmbedding(baseSeed = 1.0, variationSeed = 0.0) {
  const vec = new Float32Array(128);
  let norm = 0;
  for (let i = 0; i < 128; i++) {
    // Generate patterned harmonic values
    const val = Math.sin((i + baseSeed) * 0.4) + Math.cos((i + variationSeed) * 0.2);
    vec[i] = val;
    norm += val * val;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < 128; i++) vec[i] /= norm;
  }
  return Array.from(vec);
}

// Helper to create an embedding that has a controlled cosine similarity with a base vector
function createRotatedEmbedding(baseVec, angleRad = 0.3) {
  const orthogonal = new Float32Array(128);
  let norm = 0;
  for (let i = 0; i < 128; i++) {
    orthogonal[i] = Math.cos(i * 1.7) * (128 - i);
    norm += orthogonal[i] * orthogonal[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < 128; i++) orthogonal[i] /= norm;

  // Gram-Schmidt orthogonalization against baseVec
  let dot = 0;
  for (let i = 0; i < 128; i++) dot += baseVec[i] * orthogonal[i];
  let orthoNorm = 0;
  for (let i = 0; i < 128; i++) {
    orthogonal[i] -= dot * baseVec[i];
    orthoNorm += orthogonal[i] * orthogonal[i];
  }
  orthoNorm = Math.sqrt(orthoNorm);
  for (let i = 0; i < 128; i++) orthogonal[i] /= orthoNorm;

  // Combine: cos(angle) * base + sin(angle) * ortho
  const out = new Float32Array(128);
  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);
  for (let i = 0; i < 128; i++) {
    out[i] = cosA * baseVec[i] + sinA * orthogonal[i];
  }
  return Array.from(out);
}

async function runRemindTests() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('   CEOVA CCTV // REMIND DUAL-BANK MEMORY & SAFEGUARDS TEST SUITE   ');
  console.log('   (Multi-Prototype Bank + Ambiguity Gating + Zero-Lag Benchmark)  ');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  let passed = 0;
  let total = 0;

  function testAssert(name, condition, extra = '') {
    total++;
    if (condition) {
      console.log(`✅ [PASS] ${name}${extra ? ' (' + extra + ')' : ''}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${name}${extra ? ' (' + extra + ')' : ''}`);
    }
  }

  // Set up temporary test database
  const testDbPath = path.join(__dirname, 'test_remind_temp.db');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  const testDb = new CeovaDatabase(testDbPath);
  const reidExtractor = new ReidExtractor();
  const globalManager = new GlobalIdentityManager({ db: testDb });

  try {
    // -------------------------------------------------------------
    // Test 1: Multi-Prototype Similarity Computation
    // -------------------------------------------------------------
    const protoFront = createSyntheticEmbedding(10, 0);
    const protoSide = createRotatedEmbedding(protoFront, 0.60); // ~0.82 similarity (side view)
    const protoBack = createRotatedEmbedding(protoFront, 0.85); // ~0.66 similarity (back view)

    const multiProtoBank = [protoFront, protoSide, protoBack];

    // Query with side view
    const sideQuery = createRotatedEmbedding(protoSide, 0.05); // Very close to side view
    const simResult = reidExtractor.computeMultiPrototypeSimilarity(sideQuery, multiProtoBank);

    testAssert(
      'Multi-prototype similarity matches closest viewpoint',
      simResult.bestIndex === 1,
      `Matched index: ${simResult.bestIndex}, Expected: 1 (Side View)`
    );
    testAssert(
      'Multi-prototype score is high for side view',
      simResult.maxSimilarity >= 0.95,
      `Score: ${(simResult.maxSimilarity * 100).toFixed(1)}%`
    );

    // -------------------------------------------------------------
    // Test 2: Dual-Bank Registration & Viewpoint Prototype Addition
    // -------------------------------------------------------------
    const now = Date.now();
    // Step 2a: First sighting (Front View)
    const person1 = globalManager.processObservation({
      cameraId: 'CAM-01',
      localTrackId: 1,
      bbox: [100, 100, 100, 200],
      embedding: protoFront,
      cropImage: 'data:image/jpeg;base64,mockFront',
      timestamp: now
    });

    testAssert('New person registered with initial prototype', person1.prototypeCount === 1);
    const initialGid = person1.globalTrackId;

    // Verify database stored prototypes_json
    const dbRecord1 = testDb.getKnownPerson(initialGid);
    testAssert('Database contains prototypes array', Array.isArray(dbRecord1.prototypes));
    testAssert('Database prototypes length is 1', dbRecord1.prototypes.length === 1);

    // Step 2b: Sighting from Side View (Diverse angle, score ~0.80) after 2 minutes
    const person2 = globalManager.processObservation({
      cameraId: 'CAM-02',
      localTrackId: 2,
      bbox: [100, 100, 100, 200],
      embedding: protoSide,
      cropImage: 'data:image/jpeg;base64,mockSide',
      timestamp: now + 120000
    });

    testAssert('Side view re-identifies same person', person2.globalTrackId === initialGid);
    testAssert(
      'REMIND added a 2nd viewpoint prototype for novel angle',
      person2.prototypeCount === 2,
      `Prototype count: ${person2.prototypeCount}`
    );

    const dbRecord2 = testDb.getKnownPerson(initialGid);
    testAssert('Database now persists both viewpoint prototypes', dbRecord2.prototypes.length === 2);

    // Step 2c: Returning sighting from Front View (very close, score > 0.95)
    // Should refine the existing prototype without adding an unnecessary 3rd duplicate
    const nearFront = createRotatedEmbedding(protoFront, 0.03);
    const person3 = globalManager.processObservation({
      cameraId: 'CAM-01',
      localTrackId: 3,
      bbox: [100, 100, 100, 200],
      embedding: nearFront,
      cropImage: 'data:image/jpeg;base64,mockFront2',
      timestamp: now + 240000
    });

    testAssert('Near-identical sighting refines without adding duplicate prototype', person3.prototypeCount === 2);

    // -------------------------------------------------------------
    // Test 3: Anti-Drift Consolidation Over 20 Frames
    // -------------------------------------------------------------
    let driftCheckGid = person3.globalTrackId;
    for (let f = 1; f <= 15; f++) {
      const noisySample = createRotatedEmbedding(protoFront, 0.05 * Math.sin(f));
      globalManager.processObservation({
        cameraId: 'CAM-01',
        localTrackId: 10 + f,
        bbox: [100, 100, 100, 200],
        embedding: noisySample,
        cropImage: 'data:image/jpeg;base64,mockDrift',
        timestamp: now + 300000 + (f * 5000)
      });
    }

    const dbRecordAfterDrift = testDb.getKnownPerson(driftCheckGid);
    testAssert('Prototype count remains bounded (<= 5)', dbRecordAfterDrift.prototypes.length <= 5);

    // Verify anchor front prototype still accurately recognizes original front view
    const testOriginalFront = reidExtractor.computeMultiPrototypeSimilarity(protoFront, dbRecordAfterDrift.prototypes);
    testAssert(
      'Original anchor identity preserved without drift',
      testOriginalFront.maxSimilarity >= 0.95,
      `Similarity: ${(testOriginalFront.maxSimilarity * 100).toFixed(1)}%`
    );

    // -------------------------------------------------------------
    // Test 4: Ambiguity & Provisional Safeguard Gating
    // -------------------------------------------------------------
    // Simulate two candidates wearing almost identical uniforms
    const candidateA = { id: 'P-000091', name: 'Officer Alice', score: 0.812 };
    const candidateB = { id: 'P-000092', name: 'Officer Bob', score: 0.801 }; // Delta = 0.011 (< 0.04 threshold)

    const ambiguityEval = reidExtractor.evaluateAmbiguity([candidateA, candidateB], {
      ambiguityMargin: 0.04,
      confirmedThreshold: 0.76,
      provisionalThreshold: 0.68
    });

    testAssert('Identical appearance triggers ambiguity detection', ambiguityEval.isAmbiguous === true);
    testAssert('Ambiguous candidate is held as provisional', ambiguityEval.isProvisional === true);
    testAssert('Status reported as AMBIGUOUS', ambiguityEval.status === 'AMBIGUOUS');
    testAssert('Margin correctly computed', ambiguityEval.margin === 0.011);

    // Clear distinct match (Margin = 0.12 > 0.04)
    const distinctEval = reidExtractor.evaluateAmbiguity([
      { id: 'P-000001', name: 'Distinct Person', score: 0.88 },
      { id: 'P-000002', name: 'Other Person', score: 0.76 }
    ]);
    testAssert('Distinct match is confirmed without ambiguity', distinctEval.status === 'CONFIRMED');
    testAssert('Distinct match is not ambiguous', distinctEval.isAmbiguous === false);

    // -------------------------------------------------------------
    // Test 5: Edge Latency & Microsecond Benchmark (Zero Device Impact)
    // -------------------------------------------------------------
    console.log('\n--- Running Edge Microsecond Latency Benchmark (1,000 matches) ---');
    const galleryProtos = [];
    for (let p = 0; p < 20; p++) {
      // 20 registered people with 3 prototypes each = 60 prototypes
      galleryProtos.push([
        createSyntheticEmbedding(p * 5, 0),
        createSyntheticEmbedding(p * 5, 1),
        createSyntheticEmbedding(p * 5, 2)
      ]);
    }

    const benchmarkQuery = createSyntheticEmbedding(45, 0.5);
    const tStart = process.hrtime.bigint();

    const iterations = 1000;
    for (let i = 0; i < iterations; i++) {
      for (let p = 0; p < galleryProtos.length; p++) {
        reidExtractor.computeMultiPrototypeSimilarity(benchmarkQuery, galleryProtos[p]);
      }
    }

    const tEnd = process.hrtime.bigint();
    const totalMs = Number(tEnd - tStart) / 1000000;
    const avgUsPerMatch = (totalMs * 1000) / (iterations * galleryProtos.length);

    console.log(`    Total time for ${iterations * galleryProtos.length} prototype evaluations: ${totalMs.toFixed(2)} ms`);
    console.log(`    Average latency per gallery evaluation: ${avgUsPerMatch.toFixed(2)} microseconds`);

    testAssert(
      'Execution latency per match is under 50 microseconds (< 0.05 ms)',
      avgUsPerMatch < 50.0,
      `${avgUsPerMatch.toFixed(2)} µs/eval`
    );

  } catch (err) {
    console.error('Test execution error:', err);
  } finally {
    testDb.close();
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (e) {}
    }
  }

  console.log(`\n═══════════════════════════════════════════════════════════════════`);
  console.log(`TEST RESULTS: ${passed} / ${total} ASSERTIONS PASSED (${Math.round((passed/total)*100)}%)`);
  console.log(`═══════════════════════════════════════════════════════════════════\n`);

  if (passed === total) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runRemindTests();
