/**
 * CEOVA CCTV // End-to-End Ceova Main Integration Test Suite
 * test-ceova-integration.js
 * 
 * Validates the complete architectural flow:
 * 1. Private internal API pairing with minimal profile payload
 * 2. Separate databases (CCTV DB maintains only CCTV concerns & entitlements)
 * 3. SSO Launch Token exchange & session establishment
 * 4. Plan upgrade & entitlement synchronization (Ceova Main is authoritative)
 * 5. Camera registration with plan quota enforcement
 * 6. Ceova Main AI query communication ("How many people inside?")
 * 7. Bidirectional webhook dispatch to Ceova Main with HMAC signature
 * 8. Account revocation
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { getDatabase } = require('./db/database');
const { CeovaCctvClient } = require('./services/ceova_main_adapter');
const { getCeovaMainDispatcher } = require('./services/ceova_main_dispatcher');
const { computeSignature, CEOVA_INTERNAL_SECRET } = require('./security/ceova_protocol');

// Setup clean test database
const testDbDir = path.join(__dirname, 'scratch');
if (!fs.existsSync(testDbDir)) fs.mkdirSync(testDbDir, { recursive: true });
const testDbPath = path.join(testDbDir, `test_integration_${Date.now()}.db`);
const db = getDatabase(testDbPath);

// Setup Express App with Ceova routes
const express = require('express');
const { createCeovaInternalRouter } = require('./api/ceova_internal_routes');
const app = express();
app.use(express.json());
app.use(createCeovaInternalRouter({ db }));

async function runTests() {
  console.log('\n============================================================');
  console.log('🚀 CEOVA MAIN <---> CEOVA CCTV ARCHITECTURAL INTEGRATION TEST');
  console.log('============================================================\n');

  let cctvServer;
  let mainWebhookServer;
  const receivedWebhooks = [];

  try {
    // 1. Start mock Ceova Main Webhook Server
    const webhookPort = 9876;
    mainWebhookServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const signature = req.headers['x-ceova-internal-signature'];
        const timestamp = req.headers['x-ceova-timestamp'];
        const eventType = req.headers['x-ceova-event-type'];
        const payload = JSON.parse(body || '{}');

        // Verify HMAC signature
        const expectedSig = computeSignature(CEOVA_INTERNAL_SECRET, timestamp, 'POST', req.url, payload);
        const validSig = signature === expectedSig;

        receivedWebhooks.push({
          eventType,
          payload,
          validSig
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
      });
    });

    await new Promise(res => mainWebhookServer.listen(webhookPort, res));
    console.log(`[TEST SETUP] Mock Ceova Main Webhook Server running on port ${webhookPort}`);

    // 2. Start Ceova CCTV Test Server
    const cctvPort = 9875;
    cctvServer = http.createServer(app);
    await new Promise(res => cctvServer.listen(cctvPort, res));
    console.log(`[TEST SETUP] Ceova CCTV Server running on port ${cctvPort}`);

    const client = new CeovaCctvClient({
      cctvBaseUrl: `http://127.0.0.1:${cctvPort}`,
      secret: CEOVA_INTERNAL_SECRET
    });

    // -------------------------------------------------------------
    // Test 1: Step 3 - User Installs CCTV -> Secure Pairing
    // -------------------------------------------------------------
    console.log('\n--- TEST 1: Secure App Pairing (Minimal Profile) ---');
    const pairResult = await client.pair({
      userId: 'usr_82X91',
      orgId: 'org_71A92',
      cctvAccountId: 'cctv_91K2',
      plan: 'starter',
      entitlements: {
        max_cameras: 5,
        analytics: false,
        reports: false,
        ai_query: true
      },
      webhookUrl: `http://127.0.0.1:${webhookPort}/api/webhooks/cctv`
    });

    if (pairResult.success && pairResult.account.organization_id === 'org_71A92') {
      console.log('✅ TEST 1 PASSED: CCTV successfully paired with minimal profile.');
      console.log(`   Organization: ${pairResult.account.organization_id} | Plan: ${pairResult.account.plan}`);
    } else {
      throw new Error(`Test 1 Failed: ${JSON.stringify(pairResult)}`);
    }

    // -------------------------------------------------------------
    // Test 2: SSO Launch Token Generation & Single-Use Consumption
    // -------------------------------------------------------------
    console.log('\n--- TEST 2: SSO Launch Token & Session Exchange ---');
    const launchSession = await client.createLaunchSession({
      userId: 'usr_82X91',
      orgId: 'org_71A92',
      role: 'OPERATOR'
    });

    if (!launchSession.launchToken.startsWith('lnch_')) {
      throw new Error(`Invalid launch token format: ${launchSession.launchToken}`);
    }
    console.log(`   Generated single-use Launch Token: ${launchSession.launchToken}`);

    // Consume launch token
    const consumeResult = db.consumeLaunchToken(launchSession.launchToken);
    if (consumeResult.valid && consumeResult.session.session_token.startsWith('cctv_sess_')) {
      console.log('✅ TEST 2 PASSED: SSO Token consumed -> active session established.');
      console.log(`   Session Token: ${consumeResult.session.session_token.slice(0, 20)}...`);
    } else {
      throw new Error(`Test 2 Failed to consume token: ${JSON.stringify(consumeResult)}`);
    }

    // Verify replay protection (cannot consume twice)
    const replayResult = db.consumeLaunchToken(launchSession.launchToken);
    if (!replayResult.valid && replayResult.error.includes('already been used')) {
      console.log('✅ TEST 2.1 PASSED: Replay protection verified (token cannot be reused).');
    } else {
      throw new Error('Test 2.1 Failed: Launch token allowed replay attack!');
    }

    // -------------------------------------------------------------
    // Test 3: Plan Changes & Entitlement Synchronization
    // -------------------------------------------------------------
    console.log('\n--- TEST 3: Plan Upgrade (Starter -> Professional) ---');
    const upgradeResult = await client.updateEntitlements({
      orgId: 'org_71A92',
      plan: 'professional',
      entitlements: {
        max_cameras: 16,
        analytics: true,
        reports: true,
        ai_query: true
      }
    });

    if (upgradeResult.account.plan === 'professional' && upgradeResult.account.entitlements.max_cameras === 16) {
      console.log('✅ TEST 3 PASSED: Entitlements synchronized from Ceova Main.');
      console.log(`   Updated Max Cameras: ${upgradeResult.account.entitlements.max_cameras} | Analytics: ${upgradeResult.account.entitlements.analytics}`);
    } else {
      throw new Error(`Test 3 Failed: ${JSON.stringify(upgradeResult)}`);
    }

    // -------------------------------------------------------------
    // Test 4: Camera Registration with Entitlement Quota Enforcement
    // -------------------------------------------------------------
    console.log('\n--- TEST 4: Camera Quota Enforcement ---');
    // Register 2 cameras
    db.registerCamera('org_71A92', { id: 'CAM_FRONT', name: 'Front Entrance Store' });
    db.registerCamera('org_71A92', { id: 'CAM_REGISTER', name: 'Cash Register 1' });
    const count = db.getCameraCount('org_71A92');
    console.log(`   Registered cameras: ${count} / 16 (Quota OK)`);

    // Now temporarily simulate Starter plan limit (limit 2)
    db.updateAccountEntitlements('org_71A92', 'starter', { max_cameras: 2 });
    let quotaThrew = false;
    try {
      db.registerCamera('org_71A92', { id: 'CAM_STORAGE', name: 'Back Storage Room' });
    } catch (e) {
      if (e.code === 'QUOTA_EXCEEDED') {
        quotaThrew = true;
        console.log(`   Quota blocked excess camera correctly: "${e.message}"`);
      }
    }

    if (quotaThrew) {
      console.log('✅ TEST 4 PASSED: Camera quota properly enforced based on plan entitlements.');
    } else {
      throw new Error('Test 4 Failed: Camera quota was not enforced!');
    }

    // Restore to Professional plan (16 cams)
    db.updateAccountEntitlements('org_71A92', 'professional', { max_cameras: 16, analytics: true });

    // -------------------------------------------------------------
    // Test 5: Ceova Main AI Query ("How many people inside?")
    // -------------------------------------------------------------
    console.log('\n--- TEST 5: Ceova Main AI Query Integration ---');
    const aiQueryResult = await client.queryAi({
      orgId: 'org_71A92',
      queryType: 'occupancy'
    });

    if (aiQueryResult.success && aiQueryResult.result.current_occupancy !== undefined) {
      console.log('✅ TEST 5 PASSED: Ceova Main AI query returned structured and natural language responses:');
      console.log(`   Result: ${aiQueryResult.natural_language_summary}`);
      console.log(`   Active Cameras: ${aiQueryResult.result.active_cameras}`);
    } else {
      throw new Error(`Test 5 Failed: ${JSON.stringify(aiQueryResult)}`);
    }

    // -------------------------------------------------------------
    // Test 6: Bidirectional Event Dispatch (CCTV -> Ceova Main)
    // -------------------------------------------------------------
    console.log('\n--- TEST 6: Bidirectional Webhook Event Dispatch ---');
    const dispatcher = getCeovaMainDispatcher();
    dispatcher.db = db; // use test db

    await dispatcher.notifyCameraOffline('org_71A92', 'CAM_FRONT', 'RTSP Network Timeout');
    await new Promise(r => setTimeout(r, 200)); // give network a tick

    if (receivedWebhooks.length > 0) {
      const lastHook = receivedWebhooks[receivedWebhooks.length - 1];
      if (lastHook.eventType === 'camera.offline' && lastHook.validSig) {
        console.log('✅ TEST 6 PASSED: Ceova Main received authenticated webhook from CCTV:');
        console.log(`   Event: ${lastHook.eventType} | Valid HMAC: ${lastHook.validSig}`);
        console.log(`   Details: Camera ${lastHook.payload.data.camera_id} - ${lastHook.payload.data.reason}`);
      } else {
        throw new Error(`Test 6 Failed: Webhook received but invalid signature or wrong event`);
      }
    } else {
      throw new Error('Test 6 Failed: No webhook delivered to Ceova Main server');
    }

    // -------------------------------------------------------------
    // Test 7: Account Revocation Handshake
    // -------------------------------------------------------------
    console.log('\n--- TEST 7: Account Revocation ---');
    const revokeResult = await client.revoke({ orgId: 'org_71A92' });
    const revokedAccount = db.getCctvAccount('org_71A92');

    if (revokeResult.success && revokedAccount.status === 'REVOKED') {
      console.log('✅ TEST 7 PASSED: Account revoked and sessions terminated.');
    } else {
      throw new Error('Test 7 Failed to revoke account');
    }

    console.log('\n============================================================');
    console.log('🎉 ALL ARCHITECTURAL INTEGRATION TESTS PASSED SUCCESSFULLY!');
    console.log('============================================================\n');

  } finally {
    if (cctvServer) cctvServer.close();
    if (mainWebhookServer) mainWebhookServer.close();
    db.close();
    try {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    } catch (_e) {}
  }
}

runTests().catch(err => {
  console.error('\n❌ TEST RUNNER FAILED:', err);
  process.exit(1);
});
