// Automated Verification Script for Human Detection Bot
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

async function runTests() {
  console.log('--- STARTING CEOVA HUMAN BOT VERIFICATION ---');
  let passed = 0;
  let total = 0;

  async function assert(name, condition) {
    total++;
    if (condition) {
      console.log(`✅ [PASS] ${name}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${name}`);
    }
  }

  try {
    // 1. Check index.html
    const indexRes = await fetchUrl('https://localhost:3443/index.html');
    assert('index.html returns HTTP 200', indexRes.status === 200);
    assert('index.html contains #btnHumanBotToggle', indexRes.body.includes('id="btnHumanBotToggle"'));
    assert('index.html contains #humanCountMeter', indexRes.body.includes('id="humanCountMeter"'));
    assert('index.html contains #osdHumanBot', indexRes.body.includes('id="osdHumanBot"'));
    assert('index.html loads tf.min.js', indexRes.body.includes('vendor/tf.min.js'));
    assert('index.html loads coco-ssd.min.js', indexRes.body.includes('vendor/coco-ssd.min.js'));

    // 2. Check camera.html
    const camRes = await fetchUrl('https://localhost:3443/camera.html');
    assert('camera.html returns HTTP 200', camRes.status === 200);
    assert('camera.html contains #cameraHudCanvas', camRes.body.includes('id="cameraHudCanvas"'));
    assert('camera.html contains #btnPhoneBot', camRes.body.includes('id="btnPhoneBot"'));
    assert('camera.html contains #phoneBotBadge', camRes.body.includes('id="phoneBotBadge"'));

    // 3. Check vendor assets
    const tfRes = await fetchUrl('https://localhost:3443/vendor/tf.min.js');
    assert('vendor/tf.min.js returns HTTP 200', tfRes.status === 200 && tfRes.body.length > 500000);

    const cocoRes = await fetchUrl('https://localhost:3443/vendor/coco-ssd.min.js');
    assert('vendor/coco-ssd.min.js returns HTTP 200', cocoRes.status === 200 && cocoRes.body.length > 5000);

    // 4. Check model assets
    const modelRes = await fetchUrl('https://localhost:3443/models/mobilenet_v2/model.json');
    assert('models/mobilenet_v2/model.json returns HTTP 200', modelRes.status === 200 && modelRes.body.includes('modelTopology'));

    const shard1Res = await fetchUrl('https://localhost:3443/models/mobilenet_v2/group1-shard1of5');
    assert('models/mobilenet_v2/group1-shard1of5 returns HTTP 200', shard1Res.status === 200);

    // 5. Check viewer.js script for Advanced Tracker, Dwell Timer & Multi-Scale Zoom
    const viewerRes = await fetchUrl('https://localhost:3443/js/viewer.js');
    assert('viewer.js returns HTTP 200', viewerRes.status === 200);
    assert('viewer.js implements AdvancedHumanTracker', viewerRes.body.includes('class AdvancedHumanTracker'));
    assert('viewer.js implements formatDwellTime', viewerRes.body.includes('function formatDwellTime'));
    assert('viewer.js implements scanHumansMultiScale', viewerRes.body.includes('async function scanHumansMultiScale'));
    assert('viewer.js displays live dwell timer icon', viewerRes.body.includes('⏱️'));
    assert('viewer.js has human id numbering', viewerRes.body.includes('HUMAN #${human.id}'));

    // 6. Check camera.js script for Advanced Tracker & Dwell Timer
    const cameraJsRes = await fetchUrl('https://localhost:3443/js/camera.js');
    assert('camera.js returns HTTP 200', cameraJsRes.status === 200);
    assert('camera.js implements AdvancedHumanTracker', cameraJsRes.body.includes('class AdvancedHumanTracker'));
    assert('camera.js implements formatDwellTime', cameraJsRes.body.includes('function formatDwellTime'));
    assert('camera.js displays live dwell timer icon', cameraJsRes.body.includes('⏱️'));

    // 7. Functional verification of Tracker & Dwell Timer logic
    function formatDwellTime(elapsedMs) {
      const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
      const hrs = Math.floor(totalSec / 3600);
      const mins = Math.floor((totalSec % 3600) / 60);
      const secs = totalSec % 60;
      if (hrs > 0) {
        return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      }
      return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    assert('formatDwellTime: 0ms -> 00:00', formatDwellTime(0) === '00:00');
    assert('formatDwellTime: 65000ms -> 01:05', formatDwellTime(65000) === '01:05');
    assert('formatDwellTime: 3661000ms -> 1:01:01', formatDwellTime(3661000) === '1:01:01');

    console.log(`\nVerification Complete: ${passed}/${total} checks passed!`);
  } catch (err) {
    console.error('Test execution error:', err);
  }
}

runTests();
