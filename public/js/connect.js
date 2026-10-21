/**
 * CEOVA CCTV // Autonomous Camera Discovery & AI Human Detection Controller
 * public/js/connect.js
 * 
 * - Autonomous Camera Discovery via Username & Password
 * - High-speed RTSP/MJPEG Live CCTV Video Streaming
 * - Real-Time Offline Client-Side AI Human Detection (TensorFlow.js / COCO-SSD)
 * - Persistent Person Tracking with IoU & Dwell Time Measurement
 * - Live HUD Overlays, Glowing Person Counter, Activity Logging & Snapshots
 */

(function () {
  'use strict';

  // ── Global State ──────────────────────────────────────────────────────────
  let eventSource = null;
  let isScanning = false;
  let activeCamera = null;
  let currentStreamType = null; // 'mjpeg' | 'video' | 'webcam'
  let webcamStream = null;

  // AI Human Detection State
  let humanModel = null;
  let humanModelLoading = false;
  let humanBotActive = true; // Active by default as requested
  let detectionAnimId = null;
  let confidenceThreshold = 0.30; // 30% for high sensitivity to seated/distant humans
  let chimeEnabled = false;
  let lastChimeTime = 0;

  // FPS & Metric Tracking
  let frameCount = 0;
  let lastFpsCalcTime = performance.now();
  let currentFps = 0;
  let uniqueHumanIds = new Set();

  // ── DOM Elements ──────────────────────────────────────────────────────────
  const form = document.getElementById('cameraConnectForm');
  const inputUsername = document.getElementById('inputUsername');
  const inputPassword = document.getElementById('inputPassword');
  const inputTargetIp = document.getElementById('inputTargetIp');
  const inputSubnetHint = document.getElementById('inputSubnetHint');
  const btnLaunch = document.getElementById('btnLaunchScan');
  const btnLaunchText = document.getElementById('btnLaunchText');
  const btnStop = document.getElementById('btnStopScan');
  const btnDemoStream = document.getElementById('btnDemoStream');
  const btnToggleAdvanced = document.getElementById('btnToggleAdvanced');
  const advancedDrawer = document.getElementById('advancedDrawer');
  const togglePassBtn = document.getElementById('togglePasswordBtn');
  const credentialsBadge = document.getElementById('credentialsBadge');

  // Active Camera Card
  const activeCameraBox = document.getElementById('activeCameraBox');
  const activeCamName = document.getElementById('activeCamName');
  const activeCamEndpoint = document.getElementById('activeCamEndpoint');
  const activeCamProtocol = document.getElementById('activeCamProtocol');
  const btnDisconnectCam = document.getElementById('btnDisconnectCam');

  // Monitor Stage Elements
  const monitorStage = document.getElementById('monitorStage');
  const cctvMonitorCard = document.getElementById('cctvMonitorCard');
  const cctvFeedImg = document.getElementById('cctvFeedImg');
  const cctvFeedVideo = document.getElementById('cctvFeedVideo');
  const detectionCanvas = document.getElementById('detectionCanvas');
  const cctvPlaceholder = document.getElementById('cctvPlaceholder');
  const osdCamLabel = document.getElementById('osdCamLabel');
  const osdRecDot = document.getElementById('osdRecDot');
  const humanCountBadge = document.getElementById('humanCountBadge');
  const humanCountNumber = document.getElementById('humanCountNumber');
  const osdLiveTime = document.getElementById('osdLiveTime');
  const osdResolution = document.getElementById('osdResolution');
  const osdFpsMeter = document.getElementById('osdFpsMeter');
  const osdSensitivityVal = document.getElementById('osdSensitivityVal');
  const monitorStatusBadge = document.getElementById('monitorStatusBadge');
  const rightPanelTitle = document.getElementById('rightPanelTitle');
  const headerStatusText = document.getElementById('headerStatusText');
  const headerPulseDot = document.getElementById('headerPulseDot');

  // Control Strip Elements
  const btnToggleHumanBot = document.getElementById('btnToggleHumanBot');
  const humanBotLabel = document.getElementById('humanBotLabel');
  const rangeSensitivity = document.getElementById('rangeSensitivity');
  const lblSensitivity = document.getElementById('lblSensitivity');
  const btnToggleChime = document.getElementById('btnToggleChime');
  const chimeIcon = document.getElementById('chimeIcon');
  const chimeLabel = document.getElementById('chimeLabel');
  const btnSnapshot = document.getElementById('btnSnapshot');
  const btnFullscreen = document.getElementById('btnFullscreen');

  // Scanner & Radar Stage
  const scannerStage = document.getElementById('scannerStage');
  const radarWrapper = document.getElementById('radarWrapper');
  const scanProgressBar = document.getElementById('scanProgressBar');
  const scanPercentText = document.getElementById('scanPercentText');
  const scanStatusText = document.getElementById('scanStatusText');
  const telemetryTerminal = document.getElementById('telemetryTerminal');
  const matchedCamerasContainer = document.getElementById('matchedCamerasContainer');
  const matchedCamerasList = document.getElementById('matchedCamerasList');

  // Activity Log
  const activityFeedList = document.getElementById('activityFeedList');
  const totalUniqueHumansSeen = document.getElementById('totalUniqueHumansSeen');
  const humanAlertChime = document.getElementById('humanAlertChime');

  // ── Advanced Human Tracker with Multi-Frame Persistence ────────────────────
  class AdvancedHumanTracker {
    constructor() {
      this.tracks = [];
      this.nextId = 1;
      this.totalUniqueCount = 0;
      this.confirmThreshold = 2; // confirmed after 2 consecutive detection frames
      this.gracePeriodMs = 4500; // retain track for 4.5s during brief turns or occlusions
    }

    update(detectedBoxes, now = performance.now(), wallClock = Date.now()) {
      const getIoU = (b1, b2) => {
        const x1 = Math.max(b1.x, b2.x);
        const y1 = Math.max(b1.y, b2.y);
        const x2 = Math.min(b1.x + b1.w, b2.x + b2.w);
        const y2 = Math.min(b1.y + b1.h, b2.y + b2.h);
        const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
        const union = (b1.w * b1.h) + (b2.w * b2.h) - inter;
        return union > 0 ? inter / union : 0;
      };

      // Match detections to existing tracks
      const matchedDetections = new Set();
      const matchedTracks = new Set();

      for (let tIdx = 0; tIdx < this.tracks.length; tIdx++) {
        const tr = this.tracks[tIdx];
        let bestIoU = 0;
        let bestDIdx = -1;

        for (let dIdx = 0; dIdx < detectedBoxes.length; dIdx++) {
          if (matchedDetections.has(dIdx)) continue;
          const det = detectedBoxes[dIdx];
          const [dx, dy, dw, dh] = det.bbox;
          const iou = getIoU(
            { x: tr.x, y: tr.y, w: tr.width, h: tr.height },
            { x: dx, y: dy, w: dw, h: dh }
          );

          if (iou > 0.15 && iou > bestIoU) {
            bestIoU = iou;
            bestDIdx = dIdx;
          }
        }

        if (bestDIdx >= 0) {
          const det = detectedBoxes[bestDIdx];
          const [dx, dy, dw, dh] = det.bbox;
          // Smooth box coordinates (exponential moving average)
          const alpha = 0.65;
          tr.x = (tr.x * (1 - alpha)) + (dx * alpha);
          tr.y = (tr.y * (1 - alpha)) + (dy * alpha);
          tr.width = (tr.width * (1 - alpha)) + (dw * alpha);
          tr.height = (tr.height * (1 - alpha)) + (dh * alpha);
          tr.score = det.score;
          tr.lastSeen = now;
          tr.lastSeenWallClock = wallClock;
          tr.consecutiveFrames++;

          if (!tr.confirmed && tr.consecutiveFrames >= this.confirmThreshold) {
            tr.confirmed = true;
            this.totalUniqueCount++;
            uniqueHumanIds.add(tr.id);
            totalUniqueHumansSeen.textContent = this.totalUniqueCount;
            addActivityLog(`👤 Human #${tr.id} detected (${Math.round(det.score * 100)}% confidence)`, 'detected');
            playChimeIfEnabled();
          }

          matchedTracks.add(tIdx);
          matchedDetections.add(bestDIdx);
        }
      }

      // Create new tracks for unmatched detections
      for (let dIdx = 0; dIdx < detectedBoxes.length; dIdx++) {
        if (!matchedDetections.has(dIdx)) {
          const det = detectedBoxes[dIdx];
          const [dx, dy, dw, dh] = det.bbox;
          const newTrack = {
            id: this.nextId++,
            x: dx,
            y: dy,
            width: dw,
            height: dh,
            score: det.score,
            createdAt: now,
            firstSeenWallClock: wallClock,
            lastSeen: now,
            lastSeenWallClock: wallClock,
            consecutiveFrames: 1,
            confirmed: false
          };
          this.tracks.push(newTrack);
        }
      }

      // Check for departed tracks
      for (let i = this.tracks.length - 1; i >= 0; i--) {
        const tr = this.tracks[i];
        if (now - tr.lastSeen > this.gracePeriodMs) {
          if (tr.confirmed) {
            const dwellSec = Math.max(1, Math.round((tr.lastSeen - tr.createdAt) / 1000));
            addActivityLog(`🚪 Human #${tr.id} departed camera view (Dwell: ${formatDwellTime(dwellSec * 1000)})`, 'departed');
          }
          this.tracks.splice(i, 1);
        }
      }

      return this.tracks.filter(t => t.confirmed || t.consecutiveFrames >= 2);
    }
  }

  const humanTracker = new AdvancedHumanTracker();

  function formatDwellTime(ms) {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  function playChimeIfEnabled() {
    if (!chimeEnabled || !humanAlertChime) return;
    const now = Date.now();
    if (now - lastChimeTime > 2500) { // Limit chime frequency
      lastChimeTime = now;
      humanAlertChime.currentTime = 0;
      humanAlertChime.play().catch(() => {});
    }
  }

  function addActivityLog(message, type = '') {
    const entry = document.createElement('div');
    entry.className = `activity-entry ${type}`;
    const timeStr = new Date().toTimeString().slice(0, 8);
    entry.innerHTML = `
      <span class="activity-text">${message}</span>
      <span class="activity-time">${timeStr}</span>
    `;
    activityFeedList.prepend(entry);
    while (activityFeedList.children.length > 25) {
      activityFeedList.removeChild(activityFeedList.lastChild);
    }
  }

  // ── Load AI Human Model (TensorFlow.js + COCO-SSD) ─────────────────────────
  async function loadHumanModel() {
    if (humanModel) return humanModel;
    if (humanModelLoading) return null;
    humanModelLoading = true;
    updateMonitorBadge('LOADING AI MODEL...', 'warning');

    try {
      if (typeof cocoSsd !== 'undefined') {
        appendTerminalLine('Loading offline MobileNetV2 Human Detection weights...', 'host');
        try {
          humanModel = await cocoSsd.load({
            modelUrl: '/models/mobilenet_v2/model.json'
          });
          appendTerminalLine('✓ Local MobileNetV2 Human Model loaded.', 'success');
        } catch (_localErr) {
          appendTerminalLine('Local weights fallback: initializing default COCO-SSD...', 'host');
          humanModel = await cocoSsd.load();
          appendTerminalLine('✓ Default COCO-SSD Model initialized.', 'success');
        }
        humanModelLoading = false;
        return humanModel;
      } else {
        throw new Error('COCO-SSD library not detected in browser');
      }
    } catch (err) {
      console.error('[AI] Model load error:', err);
      appendTerminalLine(`AI model warning: ${err.message}`, 'error');
      humanModelLoading = false;
      return null;
    }
  }

  // ── Real-Time Detection Loop ──────────────────────────────────────────────
  async function runDetectionFrame() {
    if (!humanBotActive || (!cctvFeedImg.src && !cctvFeedVideo.src && !cctvFeedVideo.srcObject)) {
      detectionAnimId = requestAnimationFrame(runDetectionFrame);
      return;
    }

    const mediaEl = currentStreamType === 'mjpeg' ? cctvFeedImg : cctvFeedVideo;
    const isReady = currentStreamType === 'mjpeg' 
      ? (mediaEl.complete && mediaEl.naturalWidth > 0)
      : (mediaEl.readyState >= 2 && mediaEl.videoWidth > 0);

    if (!isReady || !humanModel) {
      detectionAnimId = requestAnimationFrame(runDetectionFrame);
      return;
    }

    // Measure FPS
    frameCount++;
    const now = performance.now();
    if (now - lastFpsCalcTime >= 1000) {
      currentFps = Math.round((frameCount * 1000) / (now - lastFpsCalcTime));
      frameCount = 0;
      lastFpsCalcTime = now;
      if (osdFpsMeter) osdFpsMeter.textContent = currentFps;
    }

    // Synchronize canvas size to visual video wrapper
    const rect = cctvMonitorCard.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (detectionCanvas.width !== Math.round(rect.width * dpr) || detectionCanvas.height !== Math.round(rect.height * dpr)) {
      detectionCanvas.width = Math.round(rect.width * dpr);
      detectionCanvas.height = Math.round(rect.height * dpr);
    }

    const ctx = detectionCanvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);

    // Compute letterbox / aspect-fit coordinates for media inside 16:9 card
    const naturalW = currentStreamType === 'mjpeg' ? mediaEl.naturalWidth : mediaEl.videoWidth;
    const naturalH = currentStreamType === 'mjpeg' ? mediaEl.naturalHeight : mediaEl.videoHeight;

    if (osdResolution) {
      osdResolution.innerHTML = `RES: ${naturalW}x${naturalH} | FPS: <span style="color:#ffffff;">${currentFps}</span>`;
    }

    const cardRatio = rect.width / rect.height;
    const mediaRatio = naturalW / naturalH;
    let drawW = rect.width;
    let drawH = rect.height;
    let offsetX = 0;
    let offsetY = 0;

    if (mediaRatio > cardRatio) {
      drawW = rect.width;
      drawH = rect.width / mediaRatio;
      offsetY = (rect.height - drawH) / 2;
    } else {
      drawH = rect.height;
      drawW = rect.height * mediaRatio;
      offsetX = (rect.width - drawW) / 2;
    }

    const scaleX = drawW / naturalW;
    const scaleY = drawH / naturalH;

    try {
      // Run detection on raw media element
      const predictions = await humanModel.detect(mediaEl);
      const humans = predictions.filter(p => p.class === 'person' && p.score >= confidenceThreshold);

      // Update tracker
      const activeTracks = humanTracker.update(humans, now, Date.now());

      // Update HUD Counter Badge
      const humanCount = activeTracks.length;
      humanCountNumber.textContent = humanCount;
      if (humanCount > 0) {
        humanCountBadge.classList.add('detected');
      } else {
        humanCountBadge.classList.remove('detected');
      }

      // Render crisp neon-green bounding boxes with corner targeting reticles
      for (const tr of activeTracks) {
        const bx = offsetX + (tr.x * scaleX);
        const by = offsetY + (tr.y * scaleY);
        const bw = tr.width * scaleX;
        const bh = tr.height * scaleY;

        // Skip degenerate boxes
        if (bw < 15 || bh < 25) continue;

        // 1. Glowing Bounding Box Body
        ctx.save();
        ctx.strokeStyle = '#22c55e';
        ctx.lineWidth = 2;
        ctx.shadowColor = 'rgba(34, 197, 94, 0.65)';
        ctx.shadowBlur = 10;
        ctx.strokeRect(bx, by, bw, bh);

        // 2. Corner Target Brackets
        const cornerLen = Math.min(18, bw * 0.25, bh * 0.25);
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = '#ffffff';

        // Top-Left
        ctx.beginPath();
        ctx.moveTo(bx, by + cornerLen);
        ctx.lineTo(bx, by);
        ctx.lineTo(bx + cornerLen, by);
        ctx.stroke();

        // Top-Right
        ctx.beginPath();
        ctx.moveTo(bx + bw - cornerLen, by);
        ctx.lineTo(bx + bw, by);
        ctx.lineTo(bx + bw, by + cornerLen);
        ctx.stroke();

        // Bottom-Left
        ctx.beginPath();
        ctx.moveTo(bx, by + bh - cornerLen);
        ctx.lineTo(bx, by + bh);
        ctx.lineTo(bx + cornerLen, by + bh);
        ctx.stroke();

        // Bottom-Right
        ctx.beginPath();
        ctx.moveTo(bx + bw - cornerLen, by + bh);
        ctx.lineTo(bx + bw, by + bh);
        ctx.lineTo(bx + bw, by + bh - cornerLen);
        ctx.stroke();

        // 3. Identification Header Pill (ID + Confidence Score)
        const labelText = `HUMAN #${tr.id} • ${Math.round(tr.score * 100)}%`;
        ctx.font = '700 11px "JetBrains Mono", monospace';
        const textWidth = ctx.measureText(labelText).width;
        const pillW = textWidth + 14;
        const pillH = 20;
        const pillY = Math.max(offsetY, by - pillH - 4);

        ctx.fillStyle = 'rgba(0, 0, 0, 0.88)';
        ctx.fillRect(bx, pillY, pillW, pillH);
        ctx.strokeStyle = '#22c55e';
        ctx.lineWidth = 1;
        ctx.strokeRect(bx, pillY, pillW, pillH);

        ctx.fillStyle = '#4ade80';
        ctx.fillText(labelText, bx + 7, pillY + 14);

        // 4. Dwell Time Badge at bottom of box
        const dwellMs = now - tr.createdAt;
        const dwellStr = `⏱ ${formatDwellTime(dwellMs)}`;
        ctx.font = '600 10px "JetBrains Mono", monospace';
        const dwellW = ctx.measureText(dwellStr).width + 10;
        const dwellY = Math.min(offsetY + drawH - 16, by + bh + 3);

        ctx.fillStyle = 'rgba(0, 0, 0, 0.82)';
        ctx.fillRect(bx, dwellY, dwellW, 16);
        ctx.fillStyle = '#cbd5e1';
        ctx.fillText(dwellStr, bx + 5, dwellY + 12);

        ctx.restore();
      }
    } catch (err) {
      console.warn('[AI] Frame detection error:', err);
    }

    detectionAnimId = requestAnimationFrame(runDetectionFrame);
  }

  function startDetectionLoop() {
    if (!detectionAnimId) {
      detectionAnimId = requestAnimationFrame(runDetectionFrame);
    }
  }

  function stopDetectionLoop() {
    if (detectionAnimId) {
      cancelAnimationFrame(detectionAnimId);
      detectionAnimId = null;
    }
    const ctx = detectionCanvas.getContext('2d');
    ctx.clearRect(0, 0, detectionCanvas.width, detectionCanvas.height);
  }

  // ── Auto-Fill Saved Credentials from Device ────────────────────────────────
  try {
    const rawLocal = localStorage.getItem('ceova_cctv_local_credentials');
    if (rawLocal) {
      const saved = JSON.parse(rawLocal);
      if (inputUsername && saved.username) inputUsername.value = saved.username;
      if (inputPassword && saved.password) inputPassword.value = saved.password;
      if (inputTargetIp && saved.ip) {
        inputTargetIp.value = (saved.port && saved.port !== 554) ? `${saved.ip}:${saved.port}` : saved.ip;
      }
    } else {
      fetch('/api/cctv/credentials').then(r => r.json()).then(data => {
        if (data?.credentials?.username) {
          const c = data.credentials;
          if (inputUsername && c.username) inputUsername.value = c.username;
          if (inputPassword && c.password) inputPassword.value = c.password;
          if (inputTargetIp && c.ip) {
            inputTargetIp.value = (c.port && c.port !== 554) ? `${c.ip}:${c.port}` : c.ip;
          }
        }
      }).catch(() => {});
    }
  } catch (_e) {}

  // Reset Saved Credentials & IP
  const btnResetCreds = document.getElementById('btnResetCreds');
  btnResetCreds?.addEventListener('click', async () => {
    try {
      localStorage.removeItem('ceova_cctv_local_credentials');
      if (inputUsername) inputUsername.value = '';
      if (inputPassword) inputPassword.value = '';
      if (inputTargetIp) inputTargetIp.value = '';
      if (inputSubnetHint) inputSubnetHint.value = '';
      await fetch('/api/cameras', { method: 'DELETE' });
      appendTerminalLine('Saved credentials and target IP cleared. System ready for fresh Wi-Fi scan.', 'success');
      alert('Saved credentials and target IP have been reset. You can now enter your new username/password to scan the Wi-Fi network.');
    } catch (_err) {}
  });

  // Check if there is already an active camera in database
  checkActiveCameraOnLoad();

  async function checkActiveCameraOnLoad() {
    try {
      const res = await fetch('/api/cameras');
      if (res.ok) {
        const raw = await res.json();
        const cameras = Array.isArray(raw) ? raw : (raw.cameras || []);
        if (cameras.length > 0) {
          const cam = cameras[0];
          // Check if stream is actually responsive before locking onto it
          try {
            const probeRes = await fetch(`/api/cameras/${cam.id}/stream-status`, { signal: AbortSignal.timeout(1500) });
            const statusData = await probeRes.json();
            if (statusData && statusData.isStreaming) {
              appendTerminalLine(`Found active camera stream: ${cam.name} (${cam.id})`, 'host');
              attachLiveCameraStream({
                id: cam.id,
                name: cam.name,
                streamUrl: `/api/cameras/${cam.id}/stream.mjpg`,
                ip: cam.name.match(/\(([^)]+)\)/)?.[1] || 'Local Network',
                port: 554
              });
              return;
            }
          } catch (_) {}
          appendTerminalLine(`Previous camera (${cam.name}) is offline or its IP changed. Ready to scan Wi-Fi for active camera.`, 'host');
        }
      }
    } catch (_e) {}
  }

  // ── Form Submit: Connect Camera with ONLY Username & Password ──────────────
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (isScanning) return;

    const username = inputUsername.value.trim();
    const password = inputPassword.value || '';

    // Only use target IP if user explicitly opened the Advanced drawer and entered it
    const isAdvancedOpen = advancedDrawer && advancedDrawer.classList.contains('open');
    const targetIp = (isAdvancedOpen && inputTargetIp?.value.trim()) ? inputTargetIp.value.trim() : null;
    const subnetHint = (isAdvancedOpen && inputSubnetHint?.value.trim()) ? inputSubnetHint.value.trim() : null;

    if (!username) {
      alert('Please enter your CCTV / NVR username.');
      return;
    }

    setScanningState(true);
    scannerStage.style.display = 'block';

    // If a target IP was explicitly provided in open advanced drawer: test direct
    if (targetIp) {
      appendTerminalLine(`Initiating direct connection test to ${targetIp}...`, 'host');
      updateProgress(35);
      scanStatusText.textContent = `TESTING CAMERA AT ${targetIp}...`;
      updateMonitorBadge('CONNECTING...', 'warning');

      try {
        const testRes = await fetch('/api/cameras/test-connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target: targetIp, username, password })
        });
        const testData = await testRes.json();

        if (testRes.ok && testData.success) {
          updateProgress(100);
          appendTerminalLine(`✓ ${testData.message}`, 'success');
          scanStatusText.textContent = 'CAMERA CONNECTED & VERIFIED';
          setScanningState(false);

          const camObj = {
            id: testData.camera.id,
            name: testData.camera.name || `CCTV (${targetIp})`,
            ip: targetIp.split(':')[0],
            port: targetIp.includes(':') ? parseInt(targetIp.split(':')[1], 10) : 554,
            streamUrl: testData.streamUrl || `/api/cameras/${testData.camera.id}/stream.mjpg`
          };

          saveCredentials(username, password, camObj.ip, camObj.port, camObj.id);
          attachLiveCameraStream(camObj);
          return;
        } else {
          updateProgress(0);
          appendTerminalLine(`❌ ${testData.error || 'Connection failed'}`, 'error');
          if (testData.hint) appendTerminalLine(`ℹ️ ${testData.hint}`, 'host');
          scanStatusText.textContent = 'CAMERA UNREACHABLE - CHECK CREDENTIALS';
          setScanningState(false);
          return;
        }
      } catch (err) {
        updateProgress(0);
        appendTerminalLine(`Connection error: ${err.message}`, 'error');
        scanStatusText.textContent = 'CONNECTION FAILED';
        setScanningState(false);
        return;
      }
    }

    // Launch Autonomous Network Discovery Bot (Using ONLY Username & Password)
    // First detects all live IP addresses on that Wi-Fi, then tries user credentials!
    appendTerminalLine('Launching Autonomous Discovery Bot...', 'host');
    appendTerminalLine('Step 1: Discovering all active IP addresses on your local Wi-Fi...', 'host');
    updateProgress(5);
    scanStatusText.textContent = 'DETECTING ALL WI-FI IP ADDRESSES...';
    updateMonitorBadge('DISCOVERING WI-FI IPS...', 'warning');
    initEventStream(username, password);

    try {
      const res = await fetch('/api/cameras/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, targetIp: null, subnetHint })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to start autonomous discovery');
      }
    } catch (err) {
      appendTerminalLine(`Discovery failed to start: ${err.message}`, 'error');
      setScanningState(false);
    }
  });

  // ── Server-Sent Events (SSE) Stream ───────────────────────────────────────
  function initEventStream(username, password) {
    if (eventSource) {
      eventSource.close();
    }

    eventSource = new EventSource('/api/cameras/discover/events');

    eventSource.onmessage = async (e) => {
      try {
        const event = JSON.parse(e.data);
        handleBotEvent(event, username, password);
      } catch (err) {
        console.error('SSE JSON error:', err);
      }
    };

    eventSource.onerror = () => {
      console.warn('SSE stream closed.');
    };
  }

  // ── Snapshot Fallback Polling Engine ──────────────────────────────────────
  let snapshotFallbackTimer = null;
  let isUsingSnapshotFallback = false;
  const discoveredHostsCache = [];

  function stopSnapshotFallback() {
    if (snapshotFallbackTimer) {
      clearInterval(snapshotFallbackTimer);
      snapshotFallbackTimer = null;
    }
    isUsingSnapshotFallback = false;
  }

  function startSnapshotFallback(cameraObj) {
    if (snapshotFallbackTimer || !cameraObj) return;
    isUsingSnapshotFallback = true;
    console.log('[Connect] Activating real-time snapshot polling fallback for', cameraObj.id);
    appendTerminalLine('Direct MJPEG stream pending. Fetching real-time JPEG frames from camera...', 'host');

    const pollFrame = () => {
      if (!activeCamera || activeCamera.id !== cameraObj.id) {
        stopSnapshotFallback();
        return;
      }
      const img = new Image();
      img.onload = () => {
        if (!activeCamera || activeCamera.id !== cameraObj.id) return;
        cctvFeedImg.src = img.src;
        cctvFeedImg.style.display = 'block';
        cctvPlaceholder.style.display = 'none';
        updateMonitorBadge('LIVE MONITORING', 'active');
      };
      img.src = `/api/cameras/${cameraObj.id}/snapshot.jpg?t=${Date.now()}`;
    };

    pollFrame();
    snapshotFallbackTimer = setInterval(pollFrame, 500);
  }

  // ── Render Discovered Cameras & Candidate Hosts ───────────────────────────
  function renderMatchedCamerasList(cameras, discoveredHosts, username, password) {
    if (!matchedCamerasContainer || !matchedCamerasList) return;

    if (Array.isArray(discoveredHosts)) {
      for (const h of discoveredHosts) {
        if (!discoveredHostsCache.some(existing => existing.ip === h.ip && existing.port === h.port)) {
          discoveredHostsCache.push(h);
        }
      }
    }

    const verified = Array.isArray(cameras) ? cameras : [];
    const allHosts = [...discoveredHostsCache];

    if (verified.length === 0 && allHosts.length === 0) {
      matchedCamerasContainer.style.display = 'none';
      return;
    }

    matchedCamerasContainer.style.display = 'block';
    matchedCamerasList.innerHTML = '';

    // 1. Render Verified Cameras
    verified.forEach(cam => {
      const card = document.createElement('div');
      card.className = 'camera-match-card';
      card.innerHTML = `
        <div class="camera-info">
          <div class="camera-brand-tag">
            <span class="dot"></span>
            ${cam.brand || 'CCTV CAMERA'} • VERIFIED & READY
          </div>
          <div class="camera-title">${cam.name || `${cam.brand || 'Camera'} (${cam.ip})`}</div>
          <div class="camera-rtsp-url">${cam.ip}:${cam.port || 554}</div>
        </div>
        <button type="button" class="btn-connect-cam">
          ▶ View Live Stream
        </button>
      `;
      card.querySelector('.btn-connect-cam').addEventListener('click', () => {
        connectMatchedCamera(cam, username, password);
      });
      matchedCamerasList.appendChild(card);
    });

    // 2. Render Discovered Network Hosts
    allHosts.forEach(host => {
      if (verified.some(v => v.ip === host.ip)) return;

      const card = document.createElement('div');
      card.className = 'camera-match-card';
      card.style.borderColor = 'rgba(245, 158, 11, 0.4)';
      card.style.background = 'rgba(245, 158, 11, 0.05)';

      const brandLabel = host.brand || host.service || 'CCTV Service';
      card.innerHTML = `
        <div class="camera-info">
          <div class="camera-brand-tag" style="color:#f59e0b;">
            <span class="dot" style="background:#f59e0b;"></span>
            ${brandLabel} • PORT ${host.port || 554} OPEN
          </div>
          <div class="camera-title">${host.ip}:${host.port || 554}</div>
          <div class="camera-rtsp-url">Detected IP on Local Network</div>
        </div>
        <button type="button" class="btn-connect-cam" style="background:#f59e0b; color:#000000; border-color:#f59e0b;">
          ▶ Connect & Fetch Video
        </button>
      `;
      card.querySelector('.btn-connect-cam').addEventListener('click', () => {
        connectCandidateHost(host, username, password);
      });
      matchedCamerasList.appendChild(card);
    });
  }

  async function connectCandidateHost(host, username, password) {
    try {
      appendTerminalLine(`Connecting to discovered camera at ${host.ip}:${host.port || 554}...`, 'host');
      updateMonitorBadge('CONNECTING...', 'warning');

      // 1. Try test-connect first
      const testRes = await fetch('/api/cameras/test-connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: `${host.ip}:${host.port || 554}`, username, password })
      });
      const testData = await testRes.json();

      if (testRes.ok && testData.success) {
        appendTerminalLine(`✓ Connected: ${testData.message}`, 'success');
        const camObj = {
          id: testData.camera.id,
          name: testData.camera.name || `CCTV (${host.ip})`,
          ip: host.ip,
          port: host.port || 554,
          streamUrl: testData.streamUrl || `/api/cameras/${testData.camera.id}/stream.mjpg`
        };
        saveCredentials(username, password, camObj.ip, camObj.port, camObj.id);
        attachLiveCameraStream(camObj);
        return;
      }

      // 2. Direct RTSP stream registration fallback
      appendTerminalLine(`Registering stream for ${host.ip}:${host.port || 554}...`, 'host');
      const regRes = await fetch('/api/cameras/connect-matched', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: `CAM_${host.ip.replace(/\./g, '_')}_${host.port || 554}`,
          name: `${host.brand || 'CCTV Camera'} (${host.ip})`,
          ip: host.ip,
          port: host.port || 554,
          username,
          password,
          streamType: (host.port === 8080 || host.port === 80) ? 'HTTP_MJPEG' : 'RTSP',
          zoneName: 'SALES_FLOOR'
        })
      });
      const regData = await regRes.json();

      if (regRes.ok && regData.success) {
        appendTerminalLine(`✓ Live stream ready: ${regData.streamUrl}`, 'success');
        saveCredentials(username, password, host.ip, host.port || 554, regData.camera?.id);
        attachLiveCameraStream({
          id: regData.camera?.id || `CAM_${host.ip.replace(/\./g, '_')}_${host.port || 554}`,
          name: `${host.brand || 'CCTV Camera'} (${host.ip})`,
          ip: host.ip,
          port: host.port || 554,
          streamUrl: regData.streamUrl
        });
      } else {
        appendTerminalLine(`Failed to fetch video: ${testData.error || regData.message || 'Stream handshake failed'}`, 'error');
        updateMonitorBadge('CONNECT FAILED', 'error');
      }
    } catch (err) {
      appendTerminalLine(`Connection error: ${err.message}`, 'error');
      updateMonitorBadge('CONNECT ERROR', 'error');
    }
  }

  function handleBotEvent(event, username, password) {
    if (event.progress !== undefined) {
      updateProgress(event.progress);
    }

    if (event.status) {
      scanStatusText.textContent = formatBotStatus(event.status);
    }

    if (event.message) {
      let typeClass = '';
      if (event.type === 'CAMERA_MATCHED' || event.type === 'SCAN_COMPLETED') typeClass = 'success';
      else if (event.type === 'HOST_FOUND') typeClass = 'host';
      else if (event.type === 'SCAN_FAILED') typeClass = 'error';

      appendTerminalLine(event.message, typeClass);
    }

    // When an active host is detected on the network, render it immediately
    if (event.type === 'HOST_FOUND' && event.host) {
      renderMatchedCamerasList([], [event.host], username, password);
    }

    // Auto-connect first matched camera!
    if (event.type === 'CAMERA_MATCHED' && event.camera) {
      renderMatchedCamerasList([event.camera], [], username, password);
      appendTerminalLine(`✓ Auto-connecting matched camera: ${event.camera.ip}:${event.camera.port}...`, 'success');
      connectMatchedCamera(event.camera, username, password);
    }

    if (event.type === 'SCAN_COMPLETED') {
      setScanningState(false);
      renderMatchedCamerasList(event.cameras || [], event.discoveredHosts || [], username, password);

      if (event.cameras && event.cameras.length > 0 && !activeCamera) {
        connectMatchedCamera(event.cameras[0], username, password);
      } else if (event.discoveredHosts && event.discoveredHosts.length > 0 && !activeCamera) {
        const primaryHost = event.discoveredHosts[0];
        appendTerminalLine(`✓ Found ${event.discoveredHosts.length} candidate CCTV host(s). Auto-connecting to ${primaryHost.ip}:${primaryHost.port || 554}...`, 'success');
        connectCandidateHost(primaryHost, username, password);
      } else if (!activeCamera) {
        appendTerminalLine('No hardware camera responded. Try entering a specific IP or use Demo Mode.', 'error');
        scanStatusText.textContent = 'SCAN COMPLETE - NO CAMERA FOUND';
        updateMonitorBadge('NO CAMERA FOUND', 'error');
      }
    }

    if (event.type === 'SCAN_FAILED') {
      setScanningState(false);
      scanStatusText.textContent = 'SCAN FAILED';
      updateMonitorBadge('SCAN FAILED', 'error');
    }
  }

  async function connectMatchedCamera(camera, username, password) {
    try {
      appendTerminalLine(`Registering camera ${camera.brand || 'CCTV'} (${camera.ip}) into live surveillance...`, 'host');
      const res = await fetch('/api/cameras/connect-matched', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: camera.id,
          name: `${camera.brand || 'CCTV'} (${camera.ip})`,
          rtspUrl: camera.rawRtspUrl || camera.rtspUrl,
          streamType: camera.streamType,
          path: camera.path,
          ip: camera.ip,
          port: camera.port,
          username,
          password,
          zoneName: 'SALES_FLOOR'
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        appendTerminalLine(`✓ Live stream ready: ${data.streamUrl}`, 'success');
        saveCredentials(username, password, camera.ip, camera.port, camera.id);
        attachLiveCameraStream({
          id: camera.id,
          name: `${camera.brand || 'CCTV Camera'} (${camera.ip})`,
          ip: camera.ip,
          port: camera.port || 554,
          streamUrl: data.streamUrl
        });
      } else {
        appendTerminalLine(`Failed to connect camera stream: ${data.message || data.error}`, 'error');
      }
    } catch (err) {
      appendTerminalLine(`Connect error: ${err.message}`, 'error');
    }
  }

  // ── Attach Live Stream to Video Stage & Start Human AI ─────────────────────
  async function attachLiveCameraStream(cameraObj) {
    activeCamera = cameraObj;
    currentStreamType = 'mjpeg';
    stopSnapshotFallback();

    // Stop any running webcam stream
    if (webcamStream) {
      webcamStream.getTracks().forEach(t => t.stop());
      webcamStream = null;
    }

    // UI Updates
    cctvPlaceholder.style.display = 'none';
    cctvFeedVideo.style.display = 'none';
    cctvFeedImg.style.display = 'block';

    let firstFrameLoaded = false;
    cctvFeedImg.onload = () => {
      firstFrameLoaded = true;
      updateMonitorBadge('LIVE MONITORING', 'active');
      headerStatusText.textContent = 'STREAMING LIVE • AI HUMAN BOT ACTIVE';
      headerPulseDot.style.background = '#22c55e';
      headerPulseDot.style.boxShadow = '0 0 10px #22c55e';
    };

    cctvFeedImg.onerror = () => {
      console.warn('[Connect] cctvFeedImg error on stream URL:', cameraObj.streamUrl);
      if (!isUsingSnapshotFallback) {
        startSnapshotFallback(cameraObj);
      }
    };

    // If no MJPEG frame renders within 3.5 seconds, activate snapshot fallback
    setTimeout(() => {
      if (!firstFrameLoaded && activeCamera && activeCamera.id === cameraObj.id && !isUsingSnapshotFallback) {
        console.log('[Connect] MJPEG wait timeout reached; initiating snapshot fallback...');
        startSnapshotFallback(cameraObj);
      }
    }, 3500);

    cctvFeedImg.src = cameraObj.streamUrl;

    osdCamLabel.textContent = `CAM-01 [${cameraObj.name.toUpperCase()}]`;
    osdRecDot.style.display = 'inline-block';
    updateMonitorBadge('LIVE MONITORING', 'active');
    rightPanelTitle.textContent = `LIVE CCTV: ${cameraObj.name}`;
    headerStatusText.textContent = 'STREAMING LIVE • AI HUMAN BOT ACTIVE';
    headerPulseDot.style.background = '#22c55e';
    headerPulseDot.style.boxShadow = '0 0 10px #22c55e';

    // Active Card in left column
    activeCameraBox.classList.add('visible');
    activeCamName.textContent = cameraObj.name;
    activeCamEndpoint.textContent = `${cameraObj.ip}:${cameraObj.port}`;
    activeCamProtocol.textContent = cameraObj.streamUrl.includes('mjpg') ? 'HTTP MJPEG / RTSP H.264' : 'LIVE FEED';

    addActivityLog(`🟢 Camera connected: ${cameraObj.name}`, 'camera');

    // Load AI Model & Launch Detection Loop
    await loadHumanModel();
    startDetectionLoop();
  }

  // ── Instant Demo / Webcam Mode ─────────────────────────────────────────────
  btnDemoStream.addEventListener('click', async () => {
    if (isScanning) return;
    const choice = confirm('Choose Test Stream:\n\nClick [OK] to use your Built-in Webcam.\nClick [Cancel] to use High-Definition Simulated CCTV Video.');

    if (choice) {
      // Use Local Webcam
      try {
        appendTerminalLine('Requesting local webcam access for testing...', 'host');
        updateMonitorBadge('STARTING WEBCAM...', 'warning');
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false
        });

        webcamStream = stream;
        currentStreamType = 'webcam';
        activeCamera = { id: 'WEBCAM_LOCAL', name: 'Built-in Webcam (HD 720p)', ip: '127.0.0.1', port: 0 };

        cctvPlaceholder.style.display = 'none';
        cctvFeedImg.style.display = 'none';
        cctvFeedVideo.style.display = 'block';
        cctvFeedVideo.srcObject = stream;
        await cctvFeedVideo.play();

        setupDemoUI('Built-in Webcam (Live Feed)');
      } catch (camErr) {
        alert('Webcam access was denied or not available. Switching to Simulated Video Feed.');
        launchSimulatedVideoFeed();
      }
    } else {
      launchSimulatedVideoFeed();
    }
  });

  function launchSimulatedVideoFeed() {
    currentStreamType = 'video';
    activeCamera = { id: 'SIM_CCTV_01', name: 'Simulated CCTV Feed (4K Demo)', ip: '127.0.0.1', port: 554 };

    if (webcamStream) {
      webcamStream.getTracks().forEach(t => t.stop());
      webcamStream = null;
    }

    cctvPlaceholder.style.display = 'none';
    cctvFeedImg.style.display = 'none';
    cctvFeedVideo.style.display = 'block';
    cctvFeedVideo.srcObject = null;
    cctvFeedVideo.src = 'assets/video/sky.mp4';
    cctvFeedVideo.loop = true;
    cctvFeedVideo.muted = true;
    cctvFeedVideo.play().catch(() => {});

    setupDemoUI('Simulated CCTV Video Feed (Continuous Loop)');
  }

  async function setupDemoUI(name) {
    osdCamLabel.textContent = `CAM-01 [${name.toUpperCase()}]`;
    osdRecDot.style.display = 'inline-block';
    updateMonitorBadge('DEMO STREAM ACTIVE', 'active');
    rightPanelTitle.textContent = `TEST STREAM: ${name}`;
    headerStatusText.textContent = 'DEMO FEED ACTIVE • HUMAN BOT ONLINE';

    activeCameraBox.classList.add('visible');
    activeCamName.textContent = name;
    activeCamEndpoint.textContent = 'Local Media Stream';
    activeCamProtocol.textContent = 'WebRTC / HTML5 Video (Real-Time)';

    addActivityLog(`🎥 Test stream started: ${name}`, 'camera');
    appendTerminalLine(`✓ Test stream started: ${name}`, 'success');

    await loadHumanModel();
    startDetectionLoop();
  }

  // ── Disconnect Camera ─────────────────────────────────────────────────────
  btnDisconnectCam.addEventListener('click', async () => {
    if (!confirm('Disconnect current CCTV camera?')) return;

    if (webcamStream) {
      webcamStream.getTracks().forEach(t => t.stop());
      webcamStream = null;
    }

    stopDetectionLoop();
    stopSnapshotFallback();

    cctvFeedImg.src = '';
    cctvFeedImg.style.display = 'none';
    cctvFeedVideo.pause();
    cctvFeedVideo.src = '';
    cctvFeedVideo.srcObject = null;
    cctvFeedVideo.style.display = 'none';
    cctvPlaceholder.style.display = 'flex';

    activeCameraBox.classList.remove('visible');
    activeCamera = null;
    currentStreamType = null;

    osdCamLabel.textContent = 'CAM-01 [STANDBY]';
    osdRecDot.style.display = 'none';
    humanCountNumber.textContent = '0';
    humanCountBadge.classList.remove('detected');
    updateMonitorBadge('STANDBY / AWAITING CREDENTIALS', '');
    rightPanelTitle.textContent = 'Live CCTV Monitor & Human AI';
    headerStatusText.textContent = 'SYSTEM READY';
    headerPulseDot.style.background = '#38bdf8';
    headerPulseDot.style.boxShadow = 'none';

    addActivityLog('⏹ Camera disconnected.', 'departed');

    try {
      await fetch('/api/cameras', { method: 'DELETE' });
    } catch (_e) {}
  });

  // ── Controls Strip Actions ────────────────────────────────────────────────
  btnToggleHumanBot.addEventListener('click', () => {
    humanBotActive = !humanBotActive;
    if (humanBotActive) {
      btnToggleHumanBot.classList.add('active');
      humanBotLabel.textContent = 'Human Bot: ON';
      addActivityLog('🤖 AI Human Detection Bot activated.', 'camera');
      startDetectionLoop();
    } else {
      btnToggleHumanBot.classList.remove('active');
      humanBotLabel.textContent = 'Human Bot: OFF';
      humanCountNumber.textContent = '0';
      humanCountBadge.classList.remove('detected');
      stopDetectionLoop();
      addActivityLog('⏹ AI Human Detection Bot paused.', 'departed');
    }
  });

  rangeSensitivity.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    confidenceThreshold = val / 100;
    lblSensitivity.textContent = `${val}%`;
    if (osdSensitivityVal) osdSensitivityVal.textContent = `${val}%`;
  });

  btnToggleChime.addEventListener('click', () => {
    chimeEnabled = !chimeEnabled;
    if (chimeEnabled) {
      btnToggleChime.classList.add('active');
      chimeIcon.textContent = '🔔';
      chimeLabel.textContent = 'Chime: ON';
      playChimeIfEnabled();
    } else {
      btnToggleChime.classList.remove('active');
      chimeIcon.textContent = '🔕';
      chimeLabel.textContent = 'Chime: OFF';
    }
  });

  btnSnapshot.addEventListener('click', () => {
    takeSnapshot();
  });

  function takeSnapshot() {
    const mediaEl = currentStreamType === 'mjpeg' ? cctvFeedImg : cctvFeedVideo;
    if (!mediaEl || (currentStreamType === 'mjpeg' && !mediaEl.naturalWidth) || (currentStreamType !== 'mjpeg' && !mediaEl.videoWidth)) {
      alert('No active stream to capture.');
      return;
    }

    const sw = currentStreamType === 'mjpeg' ? mediaEl.naturalWidth : mediaEl.videoWidth;
    const sh = currentStreamType === 'mjpeg' ? mediaEl.naturalHeight : mediaEl.videoHeight;

    const snapCanvas = document.createElement('canvas');
    snapCanvas.width = sw;
    snapCanvas.height = sh;
    const snapCtx = snapCanvas.getContext('2d');

    // Draw raw camera frame
    snapCtx.drawImage(mediaEl, 0, 0, sw, sh);

    // Overlay current bounding boxes scaled to raw frame resolution
    const rect = cctvMonitorCard.getBoundingClientRect();
    const scaleX = sw / detectionCanvas.width;
    const scaleY = sh / detectionCanvas.height;
    snapCtx.drawImage(detectionCanvas, 0, 0, sw, sh);

    // Watermark
    snapCtx.fillStyle = 'rgba(0, 0, 0, 0.75)';
    snapCtx.fillRect(10, sh - 35, 420, 25);
    snapCtx.fillStyle = '#22c55e';
    snapCtx.font = '700 13px "JetBrains Mono", monospace';
    snapCtx.fillText(`CEOVA CCTV • ${new Date().toISOString()} • HUMANS: ${humanCountNumber.textContent}`, 18, sh - 18);

    const dataUrl = snapCanvas.toDataURL('image/jpeg', 0.92);
    const link = document.createElement('a');
    link.download = `cctv_human_detection_${Date.now()}.jpg`;
    link.href = dataUrl;
    link.click();
    addActivityLog('📸 Frame snapshot downloaded with AI bounding boxes.', 'camera');
  }

  btnFullscreen.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      cctvMonitorCard.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });

  // ── UI Helpers ────────────────────────────────────────────────────────────
  function setScanningState(scanning) {
    isScanning = scanning;
    btnLaunch.disabled = scanning;
    btnLaunchText.textContent = scanning ? 'Autonomous Bot Sweeping Network...' : 'Connect CCTV & Detect Humans';
    btnStop.style.display = scanning ? 'inline-block' : 'none';

    if (scanning) {
      radarWrapper.classList.add('active');
      headerPulseDot.style.background = '#f59e0b';
      headerStatusText.textContent = 'SWEEPING LOCAL NETWORK FOR CCTV...';
    } else {
      radarWrapper.classList.remove('active');
    }
  }

  function updateProgress(percent) {
    const val = Math.min(100, Math.max(0, Math.round(percent)));
    scanProgressBar.style.width = `${val}%`;
    scanPercentText.textContent = `${val}%`;
  }

  function updateMonitorBadge(text, type = '') {
    monitorStatusBadge.textContent = text;
    monitorStatusBadge.className = `badge ${type}`;
  }

  function formatBotStatus(status) {
    switch (status) {
      case 'SCANNING_PORTS': return 'PROBING CAMERA RTSP & ONVIF PORTS (554, 8000, 37777)';
      case 'ONVIF_DISCOVERY': return 'DISPATCHING ONVIF MULTICAST DISCOVERY';
      case 'RESOLVING_NETWORK': return 'ANALYZING NETWORK INTERFACES & SUBNETS';
      case 'TESTING_CREDENTIALS': return 'AUTHENTICATING RTSP WITH USERNAME & PASSWORD';
      case 'CAMERAS_FOUND': return 'CAMERA IDENTIFIED & STREAM READY';
      case 'NO_CAMERAS_FOUND': return 'SCAN FINISHED - NO CAMERAS MATCHED';
      case 'FAILED': return 'SCAN FAILED';
      default: return status.replace(/_/g, ' ');
    }
  }

  function appendTerminalLine(text, className = '') {
    const line = document.createElement('div');
    line.className = `terminal-line ${className}`;
    line.textContent = `> ${text}`;
    telemetryTerminal.appendChild(line);
    telemetryTerminal.scrollTop = telemetryTerminal.scrollHeight;
  }

  function saveCredentials(username, password, ip, port, cameraId) {
    try {
      const creds = { username, password, ip, port, cameraId, savedAt: new Date().toISOString() };
      localStorage.setItem('ceova_cctv_local_credentials', JSON.stringify(creds));
      fetch('/api/cctv/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(creds)
      }).catch(() => {});
    } catch (_e) {}
  }

  // Toggle Password Visibility
  togglePassBtn?.addEventListener('click', () => {
    if (inputPassword.type === 'password') {
      inputPassword.type = 'text';
      togglePassBtn.textContent = '👁️';
    } else {
      inputPassword.type = 'password';
      togglePassBtn.textContent = '🔒';
    }
  });

  // Advanced Scope Drawer Toggle
  btnToggleAdvanced?.addEventListener('click', (e) => {
    e.preventDefault();
    advancedDrawer.classList.toggle('open');
    btnToggleAdvanced.textContent = advancedDrawer.classList.contains('open')
      ? '▲ Hide Network Scope Options'
      : '▼ Advanced: Specific IP or Subnet Scope (Optional)';
  });

  // Stop Scan Action
  btnStop?.addEventListener('click', async () => {
    try {
      await fetch('/api/cameras/discover/stop', { method: 'POST' });
      appendTerminalLine('Autonomous scan cancelled by user.', 'error');
      setScanningState(false);
      updateMonitorBadge('SCAN CANCELLED', '');
    } catch (e) {
      console.warn('Failed to stop scan:', e);
    }
  });

  // Live Clock Tick
  setInterval(() => {
    const d = new Date();
    const utcStr = d.toUTCString().slice(17, 25) + ' UTC';
    const liveClock = document.getElementById('liveClock');
    if (liveClock) liveClock.textContent = utcStr;
    if (osdLiveTime) osdLiveTime.textContent = `${d.getFullYear()}-${(d.getMonth()+1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')} ${d.toTimeString().slice(0, 8)}`;
  }, 1000);

})();
