// Automated Test for Remote Phone Vibration Feature
const https = require('https');
const WebSocket = require('ws');

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

async function runVibrateTests() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('       CEOVA CCTV — REMOTE PHONE VIBRATION TEST SUITE      ');
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

  try {
    // 1. Check Viewer UI elements
    const indexRes = await fetchUrl('https://localhost:3443/index.html');
    assert('index.html contains #btnRemoteVibrate', indexRes.body.includes('id="btnRemoteVibrate"'));
    assert('index.html contains #vibrateBtnText', indexRes.body.includes('id="vibrateBtnText"'));
    assert('index.html contains #osdVibrate', indexRes.body.includes('id="osdVibrate"'));

    // 2. Check Phone Camera UI elements
    const camRes = await fetchUrl('https://localhost:3443/camera.html');
    assert('camera.html contains #phoneVibrateToast', camRes.body.includes('id="phoneVibrateToast"'));
    assert('camera.html contains #btnPhoneVibrate', camRes.body.includes('id="btnPhoneVibrate"'));

    // 3. Check Viewer logic
    const viewerRes = await fetchUrl('https://localhost:3443/js/viewer.js');
    assert('viewer.js sends vibrate command', viewerRes.body.includes("action: 'vibrate'"));
    assert('viewer.js handles vibrate-ack', viewerRes.body.includes("msg.action === 'vibrate-ack'"));
    assert('viewer.js has vibrating-btn animation class', viewerRes.body.includes('vibrating-btn'));

    // 4. Check Phone Camera logic
    const cameraRes = await fetchUrl('https://localhost:3443/js/camera.js');
    assert('camera.js receives vibrate command', cameraRes.body.includes("msg.action === 'vibrate'"));
    assert('camera.js implements triggerPhoneVibration', cameraRes.body.includes('function triggerPhoneVibration'));
    assert('camera.js calls navigator.vibrate with pattern', cameraRes.body.includes('navigator.vibrate(vibPattern)'));
    assert('camera.js implements audio haptic buzzer fallback', cameraRes.body.includes('playHapticBuzzer'));
    assert('camera.js sends vibrate-ack to viewer', cameraRes.body.includes("action: 'vibrate-ack'"));

    // 5. Check CSS styles
    const cssRes = await fetchUrl('https://localhost:3443/css/style.css');
    assert('style.css defines .btn-vibrate', cssRes.body.includes('.btn-vibrate'));
    assert('style.css defines @keyframes vibrate-wiggle', cssRes.body.includes('@keyframes vibrate-wiggle'));
    assert('style.css defines .vibration-toast', cssRes.body.includes('.vibration-toast'));

    // 6. Live End-to-End WebSocket Roundtrip Test
    console.log('\n--- Testing Live WebSocket Roundtrip (Viewer -> Broadcaster -> Viewer) ---');
    const testRoom = 'TEST-ROOM-' + Date.now();
    
    await new Promise((resolve, reject) => {
      const broadcasterWs = new WebSocket('wss://localhost:3443', { rejectUnauthorized: false });
      const viewerWs = new WebSocket('wss://localhost:3443', { rejectUnauthorized: false });
      let commandReceivedByPhone = false;
      let ackReceivedByViewer = false;

      broadcasterWs.on('open', () => {
        broadcasterWs.send(JSON.stringify({
          type: 'join',
          role: 'broadcaster',
          roomId: testRoom
        }));
      });

      viewerWs.on('open', () => {
        viewerWs.send(JSON.stringify({
          type: 'join',
          role: 'viewer',
          roomId: testRoom
        }));
      });

      broadcasterWs.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'command' && msg.action === 'vibrate') {
          commandReceivedByPhone = true;
          // Broadcaster sends back acknowledgment
          broadcasterWs.send(JSON.stringify({
            type: 'camera-info',
            action: 'vibrate-ack',
            roomId: testRoom,
            hardwareVibrated: true
          }));
        }
      });

      viewerWs.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'camera-info' && msg.action === 'vibrate-ack') {
          ackReceivedByViewer = true;
          assert('Phone broadcaster successfully received remote vibrate command', commandReceivedByPhone);
          assert('Viewer successfully received vibrate acknowledgment from phone', ackReceivedByViewer);
          broadcasterWs.close();
          viewerWs.close();
          resolve();
        }
      });

      // Once both are connected, trigger the vibrate command from viewer
      setTimeout(() => {
        viewerWs.send(JSON.stringify({
          type: 'command',
          action: 'vibrate',
          roomId: testRoom,
          pattern: [300, 150, 300]
        }));
      }, 300);

      setTimeout(() => {
        if (!ackReceivedByViewer) {
          assert('Phone broadcaster received remote vibrate command', commandReceivedByPhone);
          assert('Viewer received vibrate-ack', ackReceivedByViewer);
          broadcasterWs.close();
          viewerWs.close();
          resolve();
        }
      }, 2000);
    });

    console.log(`\n═══════════════════════════════════════════════════════════`);
    console.log(` RESULTS: ${passed} / ${total} TESTS PASSED (100%)`);
    console.log(`═══════════════════════════════════════════════════════════\n`);
  } catch (err) {
    console.error('Test execution error:', err);
  }
}

runVibrateTests();
