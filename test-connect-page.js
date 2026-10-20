/**
 * Automated Verification for CCTV Connect & AI Human Detection Page
 * test-connect-page.js
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

console.log('--- STARTING CCTV CONNECT & HUMAN DETECTION VERIFICATION ---');

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

// 1. Static file presence and content verification
const connectHtmlPath = path.join(__dirname, 'public', 'connect.html');
const connectJsPath = path.join(__dirname, 'public', 'js', 'connect.js');
const connectCssPath = path.join(__dirname, 'public', 'css', 'connect.css');

check('connect.html exists on disk', fs.existsSync(connectHtmlPath));
check('connect.js exists on disk', fs.existsSync(connectJsPath));
check('connect.css exists on disk', fs.existsSync(connectCssPath));

const connectHtml = fs.readFileSync(connectHtmlPath, 'utf8');
const connectJs = fs.readFileSync(connectJsPath, 'utf8');
const connectCss = fs.readFileSync(connectCssPath, 'utf8');

// 2. HTML Markup Verifications
check('connect.html contains CCTV username input #inputUsername', connectHtml.includes('id="inputUsername"'));
check('connect.html contains CCTV password input #inputPassword', connectHtml.includes('id="inputPassword"'));
check('connect.html contains Connect button #btnLaunchScan', connectHtml.includes('id="btnLaunchScan"'));
check('connect.html contains demo / test button #btnDemoStream', connectHtml.includes('id="btnDemoStream"'));
check('connect.html contains live stream element #cctvFeedImg', connectHtml.includes('id="cctvFeedImg"'));
check('connect.html contains video element #cctvFeedVideo', connectHtml.includes('id="cctvFeedVideo"'));
check('connect.html contains human detection canvas #detectionCanvas', connectHtml.includes('id="detectionCanvas"'));
check('connect.html contains glowing human count badge #humanCountBadge', connectHtml.includes('id="humanCountBadge"'));
check('connect.html contains human count number #humanCountNumber', connectHtml.includes('id="humanCountNumber"'));
check('connect.html contains AI bot toggle button #btnToggleHumanBot', connectHtml.includes('id="btnToggleHumanBot"'));
check('connect.html contains sensitivity slider #rangeSensitivity', connectHtml.includes('id="rangeSensitivity"'));
check('connect.html contains human activity feed #activityFeedList', connectHtml.includes('id="activityFeedList"'));
check('connect.html contains audio alert chime #humanAlertChime', connectHtml.includes('id="humanAlertChime"'));
check('connect.html contains reset button #btnResetCreds', connectHtml.includes('id="btnResetCreds"'));
check('connect.html loads vendor/tf.min.js', connectHtml.includes('src="vendor/tf.min.js"'));
check('connect.html loads vendor/coco-ssd.min.js', connectHtml.includes('src="vendor/coco-ssd.min.js"'));

// 3. JavaScript Logic Verifications
check('connect.js implements AdvancedHumanTracker class', connectJs.includes('class AdvancedHumanTracker'));
check('connect.js tracks IoU overlap for person bounding boxes', connectJs.includes('getIoU') || connectJs.includes('iou'));
check('connect.js implements loadHumanModel with MobileNetV2', connectJs.includes('loadHumanModel') && connectJs.includes('mobilenet_v2'));
check('connect.js implements real-time detection frame loop', connectJs.includes('runDetectionFrame') || connectJs.includes('startDetectionLoop'));
check('connect.js formats dwell time (formatDwellTime)', connectJs.includes('formatDwellTime'));
check('connect.js attaches live camera stream (attachLiveCameraStream)', connectJs.includes('attachLiveCameraStream'));
check('connect.js implements snapshot capture (takeSnapshot)', connectJs.includes('takeSnapshot'));
check('connect.js handles camera discovery SSE events (initEventStream)', connectJs.includes('initEventStream'));
check('connect.js handles demo stream testing (btnDemoStream)', connectJs.includes('btnDemoStream'));
check('connect.js handles credentials reset (btnResetCreds)', connectJs.includes('btnResetCreds'));

// 4. CSS Styling Verifications
check('connect.css styles human count badge', connectCss.includes('.human-count-badge'));
check('connect.css styles detection detected state', connectCss.includes('.human-count-badge.detected'));
check('connect.css styles CCTV monitor stage', connectCss.includes('.cctv-monitor-card'));
check('connect.css styles HUD canvas', connectCss.includes('.cctv-hud-canvas'));
check('connect.css styles reset credentials button', connectCss.includes('.btn-reset-creds'));

// 5. Test Live Server HTTP Endpoints
const PORT = 3080;

function runHttpTests() {
  http.get(`http://127.0.0.1:${PORT}/connect.html`, (res) => {
    check('/connect.html returns HTTP 200', res.statusCode === 200);

    http.get(`http://127.0.0.1:${PORT}/connect`, (resConnect) => {
      check('/connect route returns HTTP 200', resConnect.statusCode === 200);

      http.get(`http://127.0.0.1:${PORT}/vendor/tf.min.js`, (resTf) => {
        check('/vendor/tf.min.js returns HTTP 200', resTf.statusCode === 200);

        http.get(`http://127.0.0.1:${PORT}/vendor/coco-ssd.min.js`, (resCoco) => {
          check('/vendor/coco-ssd.min.js returns HTTP 200', resCoco.statusCode === 200);

          http.get(`http://127.0.0.1:${PORT}/models/mobilenet_v2/model.json`, (resModel) => {
            check('/models/mobilenet_v2/model.json returns HTTP 200', resModel.statusCode === 200);

            console.log(`\n============================================================`);
            console.log(`🎉 TEST SUMMARY: ${passCount} PASSED, ${failCount} FAILED`);
            console.log(`============================================================`);
            process.exit(failCount === 0 ? 0 : 1);
          });
        });
      });
    });
  }).on('error', (err) => {
    console.error('HTTP request failed:', err.message);
    process.exit(1);
  });
}

runHttpTests();
