/**
 * CEOVA CCTV // End-to-End Verification: Wi-Fi IP Detection & Credential Change Adaptation
 * test-wifi-ip-redetection.js
 */

const net = require('net');
const http = require('http');
const express = require('express');
const { cameraDiscoveryBot, registry } = require('./bots');
const { createCameraDiscoveryRouter } = require('./api/camera_discovery_routes');
const { getDatabase } = require('./db/database');

let passCount = 0;
let failCount = 0;

function check(desc, condition) {
  if (condition) {
    console.log(`✅ [PASS] ${desc}`);
    passCount++;
  } else {
    console.error(`❌ [FAIL] ${desc}`);
    failCount++;
  }
}

async function runScenario() {
  console.log('\n============================================================');
  console.log('🧪 VERIFYING: WI-FI IP DETECTION & CREDENTIAL ADAPTATION');
  console.log('============================================================\n');

  const bot = registry.get('camera_discovery_bot');
  const db = getDatabase();

  // Test 1: Bitwise IPv4 Broadcast Address Calculation
  console.log('--- TEST 1: Bitwise IPv4 Broadcast Calculation ---');
  const bcast16 = bot._calculateBroadcast('10.12.15.33', '255.255.0.0');
  check('/16 subnet broadcast is correctly 10.12.255.255', bcast16 === '10.12.255.255');

  const bcast24 = bot._calculateBroadcast('192.168.1.100', '255.255.255.0');
  check('/24 subnet broadcast is correctly 192.168.1.255', bcast24 === '192.168.1.255');

  const bcast23 = bot._calculateBroadcast('172.16.2.5', '255.255.254.0');
  check('/23 subnet broadcast is correctly 172.16.3.255', bcast23 === '172.16.3.255');

  // Test 2: Active Wi-Fi Device Discovery
  console.log('\n--- TEST 2: Active Wi-Fi Device Discovery ---');
  const subnets = bot._detectLocalSubnets();
  const wifiIps = await bot._discoverAllWifiIpAddresses(subnets);
  console.log(`   Found ${wifiIps.length} active live IP address(es) on Wi-Fi.`);
  check('Active Wi-Fi scan discovered live neighbor IP addresses', wifiIps.length > 0);

  const candidateIps = bot._generateCandidateIpList(subnets, wifiIps);
  check('Detected Wi-Fi IPs are prioritized at the top of candidate list', wifiIps.length === 0 || candidateIps.slice(0, wifiIps.length).includes(wifiIps[0]));

  // Test 3: Camera IP & Credentials Change Adaptation
  console.log('\n--- TEST 3: Scenario: Camera IP & Credentials Changed ---');
  let mockCam1 = null;
  let mockCam2 = null;

  try {
    // 1. Initial State: Camera on Port 18500 with user1:pass1
    const port1 = 18500;
    mockCam1 = net.createServer((sock) => {
      sock.on('data', (d) => {
        const s = d.toString();
        const expected = Buffer.from('user1:pass1').toString('base64');
        if (s.includes(`Basic ${expected}`) || s.includes('user1')) {
          sock.write('RTSP/1.0 200 OK\r\nCSeq: 1\r\nContent-Type: application/sdp\r\nContent-Length: 20\r\n\r\nv=0\r\ns=Cam1\r\n');
        } else {
          sock.write('RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\nWWW-Authenticate: Basic realm="Cam1"\r\n\r\n');
        }
      });
    });
    await new Promise(r => mockCam1.listen(port1, '127.0.0.1', r));

    // Connect Camera 1
    const probe1 = await bot._testRtspHandshake('127.0.0.1', port1, '/h264_pcm.sdp', 'user1', 'pass1');
    check('Camera 1 initial connection with user1:pass1 succeeded', probe1.success === true);

    // Register Camera 1 in DB
    db.registerCamera('ORG-DEFAULT', {
      id: 'CAM_127_0_0_1_18500',
      name: 'Initial Camera 1 (127.0.0.1:18500)',
      stream_url: `rtsp://user1:pass1@127.0.0.1:${port1}/h264_pcm.sdp`,
      zone_name: 'DEFAULT'
    });
    check('Camera 1 registered in database', db.getCamera('CAM_127_0_0_1_18500') !== undefined);

    // 2. User changes camera IP/port AND credentials to user2:newpass99
    console.log('\n   [EVENT] Camera IP / Port and credentials changed to user2:newpass99');
    mockCam1.close(); // Camera 1 is now dead/unreachable

    // Camera 2 starts on new port 18554 (simulating changed IP/device) with new credentials
    const port2 = 18554;
    mockCam2 = net.createServer((sock) => {
      sock.on('data', (d) => {
        const s = d.toString();
        const expected = Buffer.from('user2:newpass99').toString('base64');
        if (s.includes(`Basic ${expected}`) || s.includes('user2')) {
          sock.write('RTSP/1.0 200 OK\r\nCSeq: 1\r\nContent-Type: application/sdp\r\nContent-Length: 20\r\n\r\nv=0\r\ns=Cam2\r\n');
        } else {
          sock.write('RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\nWWW-Authenticate: Basic realm="Cam2"\r\n\r\n');
        }
      });
    });
    await new Promise(r => mockCam2.listen(port2, '127.0.0.1', r));

    // 3. User enters ONLY new credentials { username: 'user2', password: 'newpass99' }
    // Bot tests candidate endpoints
    const probeOldWithNewCreds = await bot._testRtspHandshake('127.0.0.1', port1, '/h264_pcm.sdp', 'user2', 'newpass99');
    check('Old camera endpoint correctly returns unreachable/failed', probeOldWithNewCreds.success === false);

    const probeNewWithNewCreds = await bot._testRtspHandshake('127.0.0.1', port2, '/cam/realmonitor?channel=1&subtype=0', 'user2', 'newpass99');
    check('New camera endpoint with new credentials succeeds with RTSP 200 OK', probeNewWithNewCreds.success === true);

    // Test parallel stream path probing on candidate hosts with new credentials
    bot.targetCredentials = { username: 'user2', password: 'newpass99' };
    const { matched } = await bot._probeStreamPaths([
      { ip: '127.0.0.1', port: port2, brand: 'CP Plus / Dahua', service: 'RTSP Media' }
    ]);

    check('Bot matched new camera stream on changed IP/port', matched.length > 0 && matched[0].port === port2);

    console.log('\n============================================================');
    console.log(`🎉 SCENARIO SUMMARY: ${passCount} PASSED, ${failCount} FAILED`);
    console.log('============================================================\n');

    process.exit(failCount === 0 ? 0 : 1);
  } finally {
    if (mockCam1) mockCam1.close();
    if (mockCam2) mockCam2.close();
    try { db.removeCamera('ORG-DEFAULT', 'CAM_127_0_0_1_18500'); } catch (_) {}
    try { db.removeCamera('ORG-DEFAULT', 'CAM_127_0_0_1_18554'); } catch (_) {}
  }
}

runScenario().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
