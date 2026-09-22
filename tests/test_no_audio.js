// Verification script: Ensure all audio input & microphone captures are completely removed
const https = require('https');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    }).on('error', reject);
  });
}

async function verifyAudioRemoved() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('    VERIFYING AUDIO INPUT COMPLETELY REMOVED FROM CCTV     ');
  console.log('═══════════════════════════════════════════════════════════\n');

  let passed = 0;
  let total = 0;

  function assert(name, condition) {
    total++;
    if (condition) {
      console.log(`✅ [PASS] ${name}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${name}`);
    }
  }

  // 1. Camera Broadcaster HTML
  const camHtml = await fetchUrl('https://localhost:3443/camera.html');
  assert('camera.html does not contain btnMic', !camHtml.body.includes('id="btnMic"'));
  assert('camera.html does not contain micIcon', !camHtml.body.includes('id="micIcon"'));

  // 2. Camera Broadcaster JS
  const camJs = await fetchUrl('https://localhost:3443/js/camera.js');
  assert('camera.js does not contain isMicMuted', !camJs.body.includes('isMicMuted'));
  assert('camera.js does not contain btnMic', !camJs.body.includes('btnMic'));
  assert('camera.js does not contain micIcon', !camJs.body.includes('micIcon'));
  assert('camera.js does not request audio: true', !camJs.body.includes('audio: true'));
  assert('camera.js explicitly sets audio: false', camJs.body.includes('audio: false'));

  // 3. Viewer HTML
  const indexHtml = await fetchUrl('https://localhost:3443/index.html');
  assert('index.html does not contain osdAudio badge', !indexHtml.body.includes('id="osdAudio"'));
  assert('index.html does not contain btnAudioToggle', !indexHtml.body.includes('id="btnAudioToggle"'));
  assert('index.html does not contain audioBtnText', !indexHtml.body.includes('id="audioBtnText"'));

  // 4. Viewer JS
  const viewerJs = await fetchUrl('https://localhost:3443/js/viewer.js');
  assert('viewer.js does not contain osdAudio', !viewerJs.body.includes('osdAudio'));
  assert('viewer.js does not contain btnAudioToggle', !viewerJs.body.includes('btnAudioToggle'));
  assert('viewer.js does not contain audioBtnText', !viewerJs.body.includes('audioBtnText'));
  assert('viewer.js remoteVideo is explicitly muted', viewerJs.body.includes('remoteVideo.muted = true;'));

  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(` RESULTS: ${passed} / ${total} CHECKS PASSED`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  if (passed !== total) {
    process.exit(1);
  }
}

verifyAudioRemoved();
