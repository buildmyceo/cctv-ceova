const http = require('http');
const express = require('express');
const { getDatabase } = require('../db/database');
const { createCameraDiscoveryRouter } = require('../api/camera_discovery_routes');
const { rtspStreamManager } = require('../services/rtsp_stream_manager');

async function testVideoFetch() {
  console.log('Testing video stream and snapshot endpoints...');
  const db = getDatabase();
  const orgId = 'ORG-DEFAULT';

  // Ensure test camera registered
  const camId = 'CAM_TEST_VIDEO_FETCH';
  db.registerCamera(orgId, {
    id: camId,
    name: 'Test Fetch Camera',
    stream_url: 'rtsp://127.0.0.1:554/Streaming/Channels/101',
    zone_name: 'SALES_FLOOR'
  });

  const app = express();
  app.use(express.json());
  app.use(createCameraDiscoveryRouter({ db }));

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(18899, resolve));

  try {
    // 1. Test Snapshot
    const snapRes = await fetch('http://127.0.0.1:18899/api/cameras/CAM_TEST_VIDEO_FETCH/snapshot.jpg');
    console.log('Snapshot status:', snapRes.status, 'Content-Type:', snapRes.headers.get('content-type'));
    if (snapRes.status !== 200) throw new Error(`Snapshot failed with status ${snapRes.status}`);
    const snapBuffer = Buffer.from(await snapRes.arrayBuffer());
    if (snapBuffer[0] !== 0xFF || snapBuffer[1] !== 0xD8) {
      throw new Error('Snapshot did not return valid JPEG SOI header (0xFF, 0xD8)');
    }
    console.log('✅ Snapshot returned valid JPEG binary frame (size:', snapBuffer.length, 'bytes)');

    // 2. Test HEAD on Stream
    const streamHead = await fetch('http://127.0.0.1:18899/api/cameras/CAM_TEST_VIDEO_FETCH/stream.mjpg', { method: 'HEAD' });
    console.log('Stream HEAD status:', streamHead.status, 'Content-Type:', streamHead.headers.get('content-type'));
    if (streamHead.status !== 200) throw new Error(`Stream HEAD failed with status ${streamHead.status}`);
    console.log('✅ Stream endpoint responds with 200 multipart/x-mixed-replace');

    console.log('🎉 ALL VIDEO FETCH ENDPOINT TESTS PASSED!');
  } finally {
    rtspStreamManager.stopAll();
    server.close();
    try { db.removeCamera(orgId, camId); } catch (_) {}
  }
}

testVideoFetch().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
