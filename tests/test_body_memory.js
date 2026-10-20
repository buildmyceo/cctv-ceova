// Automated Test Suite: Body Recognition & Human Memory Gallery (YOLOv8 + OpenCV + Re-ID)
const https = require('https');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

function postJson(url, data) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (_e) {
          resolve({ status: res.statusCode, rawBody: body });
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (_e) {
          resolve({ status: res.statusCode, rawBody: body });
        }
      });
    }).on('error', reject);
  });
}

function patchJson(url, data) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (_e) {
          resolve({ status: res.statusCode, rawBody: body });
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function deleteReq(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'DELETE'
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (_e) {
          resolve({ status: res.statusCode, rawBody: body });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function getText(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

const jpeg = require('jpeg-js');

// Generate a valid base64 JPEG image representation of a person crop (head, torso, legs)
function createSyntheticPersonBase64(torsoR = 30, torsoG = 140, torsoB = 230) {
  const w = 120, h = 240;
  const frameData = Buffer.alloc(w * h * 4);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      let r = 240, g = 240, b = 240;
      if (y < 40 && x > 30 && x < 90) {
        r = 230; g = 180; b = 150; // Face/Head
      } else if (y >= 40 && y < 140 && x > 20 && x < 100) {
        // Striped torso shirt with primary color
        r = (x % 10 < 5) ? Math.max(0, torsoR - 15) : torsoR;
        g = torsoG;
        b = torsoB;
      } else if (y >= 140 && y < 150 && x > 25 && x < 95) {
        r = 20; g = 20; b = 20; // Dark belt
      } else if (y >= 150 && y < 220 && x > 25 && x < 95) {
        r = 50; g = 50; b = 70; // Pants
      } else if (y >= 220 && x > 20 && x < 100) {
        r = 15; g = 15; b = 15; // Shoes
      }
      frameData[idx] = r;
      frameData[idx + 1] = g;
      frameData[idx + 2] = b;
      frameData[idx + 3] = 255;
    }
  }

  const jpegImageData = jpeg.encode({ data: frameData, width: w, height: h }, 90);
  return `data:image/jpeg;base64,${jpegImageData.data.toString('base64')}`;
}

async function runBodyMemoryTests() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('   CEOVA CCTV // BODY RECOGNITION & HUMAN MEMORY TEST SUITE        ');
  console.log('   (YOLOv8 + OpenCV + Long-Term Persistent Gallery in SQLite)      ');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  let passed = 0;
  let total = 0;

  function assert(name, condition, extra = '') {
    total++;
    if (condition) {
      console.log(`✅ [PASS] ${name}${extra ? ' (' + extra + ')' : ''}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${name}${extra ? ' (' + extra + ')' : ''}`);
    }
  }

  try {
    // 1. YOLO Service Health & Status
    const yoloStatus = await getJson('https://localhost:3443/api/vision/yolo/status');
    assert('YOLO status endpoint returns HTTP 200', yoloStatus.status === 200);
    assert('YOLO service reports available: true', yoloStatus.body?.available === true);
    assert('YOLO service reports healthy: true', yoloStatus.body?.healthy === true);
    assert('YOLO service reports acceleration device (mps or cpu)', Boolean(yoloStatus.body?.device), `Device: ${yoloStatus.body?.device}`);

    // 2. YOLO Human Detection Endpoint
    const testCrop = createSyntheticPersonBase64(30, 140, 230);
    const yoloDetect = await postJson('https://localhost:3443/api/vision/yolo/detect', {
      image: testCrop,
      conf: 0.25,
      iou: 0.45
    });
    assert('POST /api/vision/yolo/detect returns HTTP 200', yoloDetect.status === 200);
    assert('POST /api/vision/yolo/detect returns success: true', yoloDetect.body?.success === true);
    assert('YOLO returns width and height', yoloDetect.body?.width > 0 && yoloDetect.body?.height > 0);

    // 3. Process Track & Persistent Person Registration
    const trackResp1 = await postJson('https://localhost:3443/api/vision/process-track', {
      cameraId: 'CAM-01',
      localTrackId: 101,
      cropImage: testCrop,
      bbox: [100, 100, 120, 240],
      dwellMs: 2500
    });
    assert('process-track returns HTTP 200', trackResp1.status === 200);
    assert('process-track processed: true', trackResp1.body?.processed === true);
    assert('process-track assigns a globalTrackId', Boolean(trackResp1.body?.globalTrackId));
    assert('process-track includes visitCount', trackResp1.body?.visitCount >= 1);

    const initialGid = trackResp1.body?.globalTrackId;
    console.log(`    → Human registered as: ${initialGid} (Name: ${trackResp1.body?.name})`);

    // 4. Query Known Persons Gallery API
    const galleryRes = await getJson('https://localhost:3443/api/persons');
    assert('GET /api/persons returns HTTP 200', galleryRes.status === 200);
    assert('GET /api/persons returns at least 1 person', galleryRes.body?.total >= 1);

    const matchedPerson = (galleryRes.body?.persons || []).find(p => p.id === initialGid);
    assert('Gallery contains newly registered person', Boolean(matchedPerson));

    // 5. Re-Identification on Return Visit (Same body appearance)
    const returnCrop = createSyntheticPersonBase64(30, 140, 230); // Identical appearance signature
    const trackResp2 = await postJson('https://localhost:3443/api/vision/process-track', {
      cameraId: 'CAM-02', // Different camera
      localTrackId: 202,
      cropImage: returnCrop,
      bbox: [150, 120, 100, 200],
      dwellMs: 1500
    });

    assert('Returning person matches existing globalTrackId', trackResp2.body?.globalTrackId === initialGid);
    assert('Returning person isRecognized flag is true', trackResp2.body?.isRecognized === true);
    assert('Re-ID match score is >= 0.75', (trackResp2.body?.matchScore || 0) >= 0.75, `Score: ${(trackResp2.body?.matchScore * 100).toFixed(1)}%`);

    // 6. Inline Rename Person
    const renameRes = await patchJson(`https://localhost:3443/api/persons/${initialGid}`, {
      name: 'Agent Smith (Security Patrol)'
    });
    assert('PATCH /api/persons/:id returns HTTP 200', renameRes.status === 200);
    assert('PATCH returns updated name', renameRes.body?.person?.name === 'Agent Smith (Security Patrol)');

    // Verify name persists in live recognition
    const trackResp3 = await postJson('https://localhost:3443/api/vision/process-track', {
      cameraId: 'CAM-01',
      localTrackId: 303,
      cropImage: returnCrop,
      bbox: [110, 100, 100, 200],
      dwellMs: 3000
    });
    assert('Subsequent sightings use the custom person name', trackResp3.body?.name === 'Agent Smith (Security Patrol)');

    // 7. UI Template Verifications
    const indexHtml = await getText('https://localhost:3443/index.html');
    assert('index.html contains #btnAiEngineToggle', indexHtml.body.includes('id="btnAiEngineToggle"'));
    assert('index.html contains #btnOpenMemoryGallery', indexHtml.body.includes('id="btnOpenMemoryGallery"'));
    assert('index.html contains #tabBtnMemory', indexHtml.body.includes('id="tabBtnMemory"'));
    assert('index.html contains #paneMemory', indexHtml.body.includes('id="paneMemory"'));
    assert('index.html contains #memoryGalleryGrid', indexHtml.body.includes('id="memoryGalleryGrid"'));
    assert('index.html livePeopleTable has PHOTO column', indexHtml.body.includes('<th>PHOTO</th>'));
    assert('index.html livePeopleTable has VISITS column', indexHtml.body.includes('<th>VISITS</th>'));

    const viewerJs = await getText('https://localhost:3443/js/viewer.js');
    assert('viewer.js implements aiEngineMode', viewerJs.body.includes('aiEngineMode'));
    assert('viewer.js calls /api/vision/yolo/detect', viewerJs.body.includes('/api/vision/yolo/detect'));
    assert('viewer.js implements loadKnownGallery', viewerJs.body.includes('loadKnownGallery'));
    assert('viewer.js implements renderKnownGallery', viewerJs.body.includes('renderKnownGallery'));
    assert('viewer.js displays V# visit count in HUD', viewerJs.body.includes('// V#'));

    // 8. Delete / Forget Person from Memory
    const delRes = await deleteReq(`https://localhost:3443/api/persons/${initialGid}`);
    assert('DELETE /api/persons/:id returns HTTP 200', delRes.status === 200);

    const getAfterDel = await getJson(`https://localhost:3443/api/persons/${initialGid}`);
    assert('Person no longer found after deletion (404)', getAfterDel.status === 404);

  } catch (err) {
    console.error('Unhandled test exception:', err);
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

runBodyMemoryTests();
