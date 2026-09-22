// =========================================================
// CEOVA MOBILE PHONE CAMERA BROADCASTER ENGINE
// =========================================================

(function () {
  let ws = null;
  let peerConnection = null;
  let currentStream = null;
  let currentFacingMode = 'environment'; // Default to rear camera
  let isTorchOn = false;
  let wakeLock = null;
  let fallbackInterval = null;

  // URL Parameters
  const urlParams = new URLSearchParams(window.location.search);
  const activeRoomId = urlParams.get('room') || 'CAM-1';

  // DOM Elements
  const cameraPreview = document.getElementById('cameraPreview');
  const fallbackCanvas = document.getElementById('fallbackCanvas');
  const mobilePulse = document.getElementById('mobilePulse');
  const mobileStatusText = document.getElementById('mobileStatusText');
  const mobileRoomBadge = document.getElementById('mobileRoomBadge');
  const mobileResText = document.getElementById('mobileResText');
  const mobileBitrateText = document.getElementById('mobileBitrateText');
  const btnFlipCam = document.getElementById('btnFlipCam');
  const btnTorch = document.getElementById('btnTorch');
  const btnDimmer = document.getElementById('btnDimmer');
  const batterySaverScreen = document.getElementById('batterySaverScreen');
  const btnWakeScreen = document.getElementById('btnWakeScreen');
  const cameraHudCanvas = document.getElementById('cameraHudCanvas');
  const btnPhoneBot = document.getElementById('btnPhoneBot');
  const btnPhoneVibrate = document.getElementById('btnPhoneVibrate');
  const phoneBotBadge = document.getElementById('phoneBotBadge');
  const phoneBotText = document.getElementById('phoneBotText');
  const btnFullscreen = document.getElementById('btnFullscreen');
  const btnFullscreenPill = document.getElementById('btnFullscreenPill');
  const fsTextPill = document.getElementById('fsTextPill');
  const fsIconPill = document.getElementById('fsIconPill');
  const fsIconSvg = document.getElementById('fsIconSvg');

  // Mobile Human Bot state
  let phoneBotActive = false;
  let phoneHumanModel = null;
  let phoneBotAnimId = null;
  let lastPhoneInferenceTime = 0;

  mobileRoomBadge.textContent = activeRoomId;

  // 1. Keep Screen Awake (WakeLock API)
  async function requestWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        console.log('Screen Wake Lock acquired.');
      } catch (err) {
        console.warn('Wake Lock error:', err);
      }
    }
  }

  let manualOrientation = 'auto'; // 'auto' | '16:9' | '9:16'

  function getEffectiveIsPortrait() {
    if (manualOrientation === '9:16') return true;
    if (manualOrientation === '16:9') return false;
    return window.innerHeight >= window.innerWidth;
  }

  // 2. High-Quality Camera Stream Initialization (Prioritizes 1080p FHD / 720p HD)
  async function startCamera() {
    mobileStatusText.textContent = 'STARTING HD CAMERA...';

    // Stop previous tracks if switching
    if (currentStream) {
      currentStream.getTracks().forEach(track => track.stop());
    }

    // Adapt to phone orientation (portrait vs landscape) for optimal camera sensor capture
    const isPortrait = getEffectiveIsPortrait();
    const targetWidth = isPortrait ? 1080 : 1920;
    const targetHeight = isPortrait ? 1920 : 1080;

    const constraintTiers = [
      // Tier 1: 1080p Full HD with continuous autofocus and sensor optimization
      {
        video: {
          facingMode: { ideal: currentFacingMode },
          width: { ideal: targetWidth, min: isPortrait ? 720 : 1280 },
          height: { ideal: targetHeight, min: isPortrait ? 1280 : 720 },
          frameRate: { ideal: 30, min: 24 },
          advanced: [
            { focusMode: 'continuous' },
            { exposureMode: 'continuous' },
            { whiteBalanceMode: 'continuous' }
          ]
        },
        audio: false
      },
      // Tier 2: 720p HD
      {
        video: {
          facingMode: { ideal: currentFacingMode },
          width: { ideal: isPortrait ? 720 : 1280 },
          height: { ideal: isPortrait ? 1280 : 720 },
          frameRate: { ideal: 30 }
        },
        audio: false
      },
      // Tier 3: Standard fallback
      {
        video: {
          facingMode: { ideal: currentFacingMode }
        },
        audio: false
      }
    ];

    currentStream = null;
    for (const tier of constraintTiers) {
      try {
        currentStream = await navigator.mediaDevices.getUserMedia(tier);
        if (currentStream) break;
      } catch (err) {
        try {
          currentStream = await navigator.mediaDevices.getUserMedia({
            video: tier.video,
            audio: false
          });
          if (currentStream) break;
        } catch (vErr) {
          // try next tier
        }
      }
    }

    if (!currentStream) {
      alert('Camera access error: Could not access camera.\nPlease allow camera permissions and reload.');
      mobileStatusText.textContent = 'PERMISSION DENIED';
      return;
    }

    // Set contentHint to 'detail' for maximum sharpness
    const videoTrack = currentStream.getVideoTracks()[0];
    if (videoTrack && 'contentHint' in videoTrack) {
      videoTrack.contentHint = 'detail';
    }

    cameraPreview.srcObject = currentStream;
    await cameraPreview.play();

    // Check resolution
    const settings = videoTrack && videoTrack.getSettings ? videoTrack.getSettings() : {};
    const actualW = settings.width || cameraPreview.videoWidth || 1280;
    const actualH = settings.height || cameraPreview.videoHeight || 720;
    const isFhd = actualW >= 1920 || actualH >= 1920;
    const actualIsPortrait = actualH > actualW;
    mobileResText.textContent = `${actualW}x${actualH} ${isFhd ? '1080p FHD' : '720p HD'} [${actualIsPortrait ? '9:16' : '16:9'}]`;

    // Request Wake Lock
    requestWakeLock();

    // Start instant fallback streaming and initiate WebRTC offer
    startFallbackStreaming();
    if (ws && ws.readyState === WebSocket.OPEN) {
      initiateOffer();
    }

    // Report hardware capabilities
    sendCameraInfo();
  }

  // 3. WebRTC Peer Connection & Signaling
  function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('Broadcaster connected to signaling server');
      mobileStatusText.textContent = 'CONNECTED // READY';
      mobilePulse.className = 'pulse-dot online';

      // Join room as broadcaster
      ws.send(JSON.stringify({
        type: 'join',
        role: 'broadcaster',
        roomId: activeRoomId
      }));

      // Report battery status
      sendBatteryInfo();
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleMessage(msg);
      } catch (e) {
        console.error('Error parsing signaling message', e);
      }
    };

    ws.onclose = () => {
      mobileStatusText.textContent = 'DISCONNECTED (RETRYING)';
      mobilePulse.className = 'pulse-dot';
      setTimeout(initWebSocket, 2000);
    };
  }

  let iceCandidateQueue = [];
  let isWebRtcConnected = false;

  function createPeerConnection() {
    if (peerConnection) {
      try { peerConnection.close(); } catch(e) {}
    }
    iceCandidateQueue = [];

    const peerConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
      ]
    };

    peerConnection = new RTCPeerConnection(peerConfig);

    // Add local camera tracks with 5 Mbps bitrate boost
    if (currentStream) {
      currentStream.getTracks().forEach(track => {
        try {
          const sender = peerConnection.addTrack(track, currentStream);
          console.log('Added track to peerConnection:', track.kind);

          if (track.kind === 'video' && sender && sender.getParameters) {
            try {
              const params = sender.getParameters();
              if (!params.encodings || params.encodings.length === 0) {
                params.encodings = [{}];
              }
              params.encodings[0].maxBitrate = 5000000; // 5 Mbps HD Bitrate
              params.encodings[0].networkPriority = 'high';
              params.encodings[0].priority = 'high';
              sender.setParameters(params).catch(() => {});
            } catch (e) {}
          }
        } catch (e) {
          console.error('Error adding track:', e);
        }
      });
    }

    peerConnection.onicecandidate = (event) => {
      if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'candidate',
          candidate: event.candidate,
          roomId: activeRoomId
        }));
      }
    };

    peerConnection.onconnectionstatechange = () => {
      console.log('PeerConnection state:', peerConnection.connectionState);
      if (peerConnection.connectionState === 'connected') {
        isWebRtcConnected = true;
        mobileStatusText.textContent = 'STREAMING LIVE (P2P)';
        mobileBitrateText.textContent = 'WebRTC 60 FPS • HD';
        mobilePulse.className = 'pulse-dot online';
        // When WebRTC is rock solid, we can reduce fallback rate
        reduceFallbackRate();
      } else if (peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'disconnected') {
        isWebRtcConnected = false;
        mobileStatusText.textContent = 'STREAMING LIVE (RELAY)';
        mobileBitrateText.textContent = 'WebSocket 20 FPS';
        startFallbackStreaming();
      }
    };

    return peerConnection;
  }

  function boostSdpBitrate(sdp, bitrateKbps = 5000) {
    if (!sdp) return sdp;
    return sdp.replace(/m=video (.*)\r\n/g, `m=video $1\r\nb=AS:${bitrateKbps}\r\nb=TIAS:${bitrateKbps * 1000}\r\n`);
  }

  async function initiateOffer() {
    if (!currentStream) {
      console.log('Camera stream not ready yet. Waiting for startCamera...');
      return;
    }

    console.log('Creating WebRTC offer with active stream tracks (5 Mbps boosted)...');
    const pc = createPeerConnection();
    try {
      const offer = await pc.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false
      });
      const boostedSdp = boostSdpBitrate(offer.sdp, 5000);
      await pc.setLocalDescription(new RTCSessionDescription({ type: offer.type, sdp: boostedSdp }));

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'offer',
          sdp: pc.localDescription,
          roomId: activeRoomId
        }));
        console.log('High-Quality WebRTC offer sent to viewer (5 Mbps).');
      }
    } catch (e) {
      console.error('Error creating WebRTC offer:', e);
      startFallbackStreaming();
    }
  }

  async function handleMessage(msg) {
    switch (msg.type) {
      case 'status':
      case 'peer-joined': {
        // Viewer is present
        if (msg.role === 'viewer' || msg.viewerCount > 0) {
          console.log('Viewer is in the room. Initiating offer and starting stream...');
          startFallbackStreaming();
          if (currentStream) {
            initiateOffer();
          }
        }
        break;
      }

      case 'answer': {
        if (peerConnection) {
          console.log('Setting remote description from answer...');
          await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          
          // Flush queued candidates
          while (iceCandidateQueue.length > 0) {
            const cand = iceCandidateQueue.shift();
            try {
              await peerConnection.addIceCandidate(new RTCIceCandidate(cand));
            } catch (e) {
              console.warn('Queued ICE error:', e);
            }
          }
        }
        break;
      }

      case 'candidate': {
        if (msg.candidate) {
          if (peerConnection && peerConnection.remoteDescription) {
            try {
              await peerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate));
            } catch (e) {
              console.error('Error adding ICE candidate:', e);
            }
          } else {
            iceCandidateQueue.push(msg.candidate);
          }
        }
        break;
      }

      case 'webrtc-active': {
        isWebRtcConnected = true;
        reduceFallbackRate();
        break;
      }

      // Remote commands received from Desktop Viewer
      case 'command': {
        if (msg.action === 'toggle-torch') {
          toggleTorch(msg.state !== undefined ? msg.state : !isTorchOn);
        } else if (msg.action === 'switch-camera') {
          flipCamera();
        } else if (msg.action === 'vibrate') {
          triggerPhoneVibration(msg.pattern);
        }
        break;
      }
    }
  }

  // 3b. Phone Vibration (Physical motor + audio buzzer fallback & visual toast)
  let vibrateToastTimeout = null;

  function triggerPhoneVibration(pattern) {
    const vibPattern = pattern || [300, 150, 300, 150, 400];
    let hardwareVibrated = false;

    // 1. Hardware Vibration Motor (Android Chrome, Firefox, Opera, etc.)
    if ('vibrate' in navigator && typeof navigator.vibrate === 'function') {
      try {
        hardwareVibrated = navigator.vibrate(vibPattern);
      } catch (e) {
        console.warn('Physical navigator.vibrate error:', e);
      }
    }

    // 2. Audio Haptic Buzzer Fallback (Low-frequency tactile tone for iOS / webkit)
    playHapticBuzzer();

    // 3. Visual On-Screen Toast & Body Flash
    const toast = document.getElementById('phoneVibrateToast');
    if (toast) {
      toast.classList.remove('hidden');
      toast.classList.add('active');
    }
    document.body.classList.add('vibrating-flash');

    clearTimeout(vibrateToastTimeout);
    vibrateToastTimeout = setTimeout(() => {
      if (toast) {
        toast.classList.remove('active');
        toast.classList.add('hidden');
      }
      document.body.classList.remove('vibrating-flash');
    }, 1500);

    // 4. Send acknowledgment back to Viewer
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'camera-info',
        action: 'vibrate-ack',
        roomId: activeRoomId,
        hardwareVibrated: hardwareVibrated,
        timestamp: Date.now()
      }));
    }
  }

  function playHapticBuzzer() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      if (ctx.state === 'suspended') {
        ctx.resume();
      }
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(130, ctx.currentTime);
      gain.gain.setValueAtTime(0.35, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
    } catch (err) {
      // Audio context might be restricted before first touch
    }
  }

  // 4. Fallback WebSocket Frame Streaming with Adaptive HD Canvas & Quality
  let frameDelayMs = 80; // Default ~12-15 fps

  function startFallbackStreaming() {
    if (fallbackInterval) return;
    console.log('Activating high-definition live frame streaming over WebSockets...');
    const ctx = fallbackCanvas.getContext('2d');

    fallbackInterval = setInterval(() => {
      if (!currentStream || !ws || ws.readyState !== WebSocket.OPEN) return;
      if (cameraPreview.videoWidth === 0) return;

      const vW = cameraPreview.videoWidth;
      const vH = cameraPreview.videoHeight;
      const isPort = vH > vW;

      const outW = isPort ? 720 : 1280;
      const outH = isPort ? 1280 : 720;

      if (fallbackCanvas.width !== outW || fallbackCanvas.height !== outH) {
        fallbackCanvas.width = outW;
        fallbackCanvas.height = outH;
      }

      ctx.drawImage(cameraPreview, 0, 0, outW, outH);
      const frameData = fallbackCanvas.toDataURL('image/jpeg', 0.85);
      ws.send(JSON.stringify({
        type: 'frame',
        image: frameData,
        roomId: activeRoomId
      }));
    }, frameDelayMs);
  }

  function reduceFallbackRate() {
    // When WebRTC is active, slow down fallback to 2 fps as a backup heartbeat
    if (fallbackInterval) {
      clearInterval(fallbackInterval);
      fallbackInterval = null;
    }
    frameDelayMs = 500;
    startFallbackStreaming();
  }

  function stopFallbackStreaming() {
    if (fallbackInterval) {
      clearInterval(fallbackInterval);
      fallbackInterval = null;
    }
  }

  // 5. Flashlight / Torch Control
  async function toggleTorch(forceState = null) {
    if (!currentStream) return;
    const track = currentStream.getVideoTracks()[0];
    if (!track) return;

    try {
      const capabilities = track.getCapabilities ? track.getCapabilities() : {};
      if (!capabilities.torch) {
        console.warn('Torch is not supported by this camera/browser.');
        return;
      }

      isTorchOn = forceState !== null ? forceState : !isTorchOn;
      await track.applyConstraints({
        advanced: [{ torch: isTorchOn }]
      });

      btnTorch.classList.toggle('active', isTorchOn);
      sendCameraInfo();
    } catch (e) {
      console.warn('Torch toggle error:', e);
    }
  }

  btnTorch.addEventListener('click', () => toggleTorch());

  // 6. Flip Camera (Front / Rear)
  async function flipCamera() {
    currentFacingMode = currentFacingMode === 'environment' ? 'user' : 'environment';
    await startCamera();
  }

  btnFlipCam.addEventListener('click', flipCamera);


  // 8. Battery Saver / Screen Dimmer
  btnDimmer.addEventListener('click', () => {
    batterySaverScreen.classList.add('active');
  });

  btnWakeScreen.addEventListener('click', () => {
    batterySaverScreen.classList.remove('active');
  });

  if (btnPhoneVibrate) {
    btnPhoneVibrate.addEventListener('click', () => {
      triggerPhoneVibration();
    });
  }

  // 9. Hardware & Battery Telemetry
  function sendCameraInfo() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const isPortrait = getEffectiveIsPortrait();
    const settings = currentStream && currentStream.getVideoTracks().length > 0 && currentStream.getVideoTracks()[0].getSettings ? currentStream.getVideoTracks()[0].getSettings() : {};
    const actualW = settings.width || cameraPreview.videoWidth || (isPortrait ? 1080 : 1920);
    const actualH = settings.height || cameraPreview.videoHeight || (isPortrait ? 1920 : 1080);
    ws.send(JSON.stringify({
      type: 'camera-info',
      torch: isTorchOn,
      facingMode: currentFacingMode,
      orientation: isPortrait ? 'portrait' : 'landscape',
      aspectRatio: isPortrait ? '9:16' : '16:9',
      width: actualW,
      height: actualH,
      roomId: activeRoomId
    }));
  }

  // Orientation Toggle Button
  const btnOrientation = document.getElementById('btnOrientation');
  if (btnOrientation) {
    btnOrientation.addEventListener('click', () => {
      const modes = ['auto', '16:9', '9:16'];
      const nextIdx = (modes.indexOf(manualOrientation) + 1) % modes.length;
      manualOrientation = modes[nextIdx];
      btnOrientation.classList.toggle('active', manualOrientation !== 'auto');
      console.log(`Orientation mode toggled to: ${manualOrientation}`);
      startCamera();
    });
  }

  // Auto-Detect Physical Phone Orientation Changes
  let orientationChangeTimeout = null;
  function handleScreenOrientationChange() {
    if (manualOrientation === 'auto') {
      const isPortraitNow = window.innerHeight >= window.innerWidth;
      if (currentStream) {
        const tracks = currentStream.getVideoTracks();
        if (tracks.length > 0) {
          const settings = tracks[0].getSettings ? tracks[0].getSettings() : {};
          const trackIsPortrait = (settings.height || 720) > (settings.width || 1280);
          if (trackIsPortrait !== isPortraitNow) {
            console.log(`Phone rotated to ${isPortraitNow ? '9:16 Portrait' : '16:9 Landscape'}. Reconfiguring HD stream...`);
            startCamera();
          }
        }
      }
    }
  }

  window.addEventListener('resize', () => {
    clearTimeout(orientationChangeTimeout);
    orientationChangeTimeout = setTimeout(handleScreenOrientationChange, 350);
  });

  if (screen.orientation) {
    screen.orientation.addEventListener('change', () => {
      clearTimeout(orientationChangeTimeout);
      orientationChangeTimeout = setTimeout(handleScreenOrientationChange, 250);
    });
  }

  async function sendBatteryInfo() {
    if ('getBattery' in navigator) {
      try {
        const battery = await navigator.getBattery();
        const update = () => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'camera-info',
              battery: Math.round(battery.level * 100),
              roomId: activeRoomId
            }));
          }
        };
        update();
        battery.addEventListener('levelchange', update);
      } catch (e) {}
    }
  }

  // =========================================================
  // 10. MOBILE AI HUMAN DETECTION BOT (GREEN BOX HUD & TRACKER)
  // =========================================================

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

  // Advanced Multi-Human Sticky Tracker with Boundary Exit Awareness, Unique IDs & Live Dwell Timers
  class AdvancedHumanTracker {
    constructor(options = {}) {
      this.tracks = [];
      this.nextId = (options && options.startId) || 1;
      this.totalUniqueCount = 0;
      // In-range persistence: keep human locked for 6.5s even if occluded or seated steady
      this.interiorGraceMs = (options && options.interiorGraceMs) || 6500;
      // Border exit persistence: if human reaches the camera boundary and leaves, retire after 1.5s
      this.exitGraceMs = (options && options.exitGraceMs) || 1500;
      // 20-Second User Re-Entry Memory Window:
      // Remember every departed user for 20 seconds. If they re-enter the camera within 20s,
      // restore their past human number, identity, and continuous dwell timer.
      this.reentryMemoryMs = (options && options.reentryMemoryMs !== undefined) ? options.reentryMemoryMs : 20000;
      this.dormantTracks = [];
    }

    update(detectedHumans, now = performance.now(), wallClockNow = Date.now(), frameW = 1280, frameH = 720) {
      // Prune expired dormant tracks older than 20 seconds
      this.dormantTracks = this.dormantTracks.filter(d => (now - d.departedTime) <= this.reentryMemoryMs);

      function getIoU(b1, b2) {
        const x1 = Math.max(b1.x, b2.x);
        const y1 = Math.max(b1.y, b2.y);
        const x2 = Math.min(b1.x + b1.w, b2.x + b2.w);
        const y2 = Math.min(b1.y + b1.h, b2.y + b2.h);
        const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
        const union = (b1.w * b1.h) + (b2.w * b2.h) - inter;
        return union > 0 ? inter / union : 0;
      }

      // 1. Build pairwise match candidates with adaptive affinity metric
      const candidates = [];
      for (let tIdx = 0; tIdx < this.tracks.length; tIdx++) {
        const tr = this.tracks[tIdx];
        const trCx = tr.x + tr.width / 2;
        const trCy = tr.y + tr.height / 2;
        const trRefDim = Math.max(tr.width, tr.height, 60);

        for (let dIdx = 0; dIdx < detectedHumans.length; dIdx++) {
          const det = detectedHumans[dIdx];
          const [dx, dy, dw, dh] = det.bbox;
          const detCx = dx + dw / 2;
          const detCy = dy + dh / 2;

          const dist = Math.hypot(trCx - detCx, trCy - detCy);
          const normDist = dist / trRefDim;
          const iou = getIoU(
            { x: tr.x, y: tr.y, w: tr.width, h: tr.height },
            { x: dx, y: dy, w: dw, h: dh }
          );

          const trArea = tr.width * tr.height;
          const detArea = dw * dh;
          const areaSim = Math.min(trArea, detArea) / Math.max(trArea, detArea);
          let affinity = 0;
          if (iou > 0.08) {
            affinity = (iou * 2.2) + Math.max(0, 1.0 - normDist) * 0.7 + (areaSim * 0.3);
          } else if (normDist < 1.4) {
            affinity = Math.max(0, 1.0 - (normDist / 1.4)) + (areaSim * 0.25);
          }

          if ((tr.totalDetections || 0) > 2) {
            affinity += 0.20;
          }

          // Color consistency check between active track and detection
          if (det.colorSignature && tr.colorSignature) {
            const cd = Math.hypot(
              det.colorSignature[0] - tr.colorSignature[0],
              det.colorSignature[1] - tr.colorSignature[1],
              det.colorSignature[2] - tr.colorSignature[2]
            );
            if (cd > 60) {
              // Completely different clothing: NEVER match this detection to this track!
              continue;
            } else {
              const colorSim = Math.max(0, 1.0 - (cd / 120));
              affinity += colorSim * 0.30;
            }
          }

          if (affinity > 0.28) {
            candidates.push({ tIdx, dIdx, affinity });
          }
        }
      }

      // Sort candidate pairs by highest affinity first (Global optimal assignment)
      candidates.sort((a, b) => b.affinity - a.affinity);

      const matchedTrackIndices = new Set();
      const matchedDetIndices = new Set();

      for (const cand of candidates) {
        if (!matchedTrackIndices.has(cand.tIdx) && !matchedDetIndices.has(cand.dIdx)) {
          matchedTrackIndices.add(cand.tIdx);
          matchedDetIndices.add(cand.dIdx);

          const t = this.tracks[cand.tIdx];
          const det = detectedHumans[cand.dIdx];
          const [hx, hy, hw, hh] = det.bbox;

          const dt = Math.max(0.02, (now - t.lastUpdateTime) / 1000);
          const currentCx = hx + hw / 2;
          const currentCy = hy + hh / 2;
          const prevCx = t.x + t.width / 2;
          const prevCy = t.y + t.height / 2;

          // Estimate motion velocity
          const maxSpeed = 320;
          const instantVx = Math.min(maxSpeed, Math.max(-maxSpeed, (currentCx - prevCx) / dt));
          const instantVy = Math.min(maxSpeed, Math.max(-maxSpeed, (currentCy - prevCy) / dt));
          t.vx = t.vx * 0.70 + instantVx * 0.30;
          t.vy = t.vy * 0.70 + instantVy * 0.30;

          const speed = Math.hypot(t.vx, t.vy);
          if (speed > 20) {
            t.motionState = 'WALKING';
            t.direction = Math.abs(t.vx) > Math.abs(t.vy) ? (t.vx > 0 ? '→' : '←') : (t.vy > 0 ? '↓' : '↑');
          } else {
            t.motionState = 'STEADY';
            t.direction = '';
          }

          // Smooth exponential position & dimension interpolation
          const posAlpha = 0.30;
          const sizeAlpha = 0.22;
          t.x = t.x * (1 - posAlpha) + hx * posAlpha;
          t.y = t.y * (1 - posAlpha) + hy * posAlpha;
          t.width = t.width * (1 - sizeAlpha) + hw * sizeAlpha;
          t.height = t.height * (1 - sizeAlpha) + hh * sizeAlpha;

          t.score = Math.max(t.score * 0.7, det.score);
          t.lastSeenTime = now;
          t.lastUpdateTime = now;
          t.misses = 0;
          t.totalDetections = (t.totalDetections || 0) + 1;
          if (det.colorSignature) {
            t.colorSignature = det.colorSignature;
          }
        }
      }

      // 2. Unmatched detections -> First check 20-Second Re-Entry Memory for returning past human!
      for (let dIdx = 0; dIdx < detectedHumans.length; dIdx++) {
        if (!matchedDetIndices.has(dIdx)) {
          const det = detectedHumans[dIdx];
          const [hx, hy, hw, hh] = det.bbox;

          let bestDormantIdx = -1;
          let bestDormantScore = 0;

          const detArea = hw * hh;
          const detAspect = hw / Math.max(1, hh);
          const detCx = hx + hw / 2;
          const detCy = hy + hh / 2;

          for (let k = 0; k < this.dormantTracks.length; k++) {
            const d = this.dormantTracks[k];
            const timeAwaySec = (now - d.departedTime) / 1000;
            if (timeAwaySec > (this.reentryMemoryMs / 1000)) continue;

            // Strict Appearance Gating: If clothing colors differ, CANNOT be the same human!
            let hasColorMatch = false;
            let colorSim = 0.5;
            if (det.colorSignature && d.colorSignature) {
              const cd = Math.hypot(
                det.colorSignature[0] - d.colorSignature[0],
                det.colorSignature[1] - d.colorSignature[1],
                det.colorSignature[2] - d.colorSignature[2]
              );
              if (cd > 55) {
                // HARD REJECT: Completely different clothing color (e.g. orange vs brown shirt)
                // This is a DIFFERENT person who entered, MUST NOT resurrect!
                continue;
              }
              colorSim = Math.max(0, 1.0 - (cd / 110));
              hasColorMatch = true;
            }

            const dormArea = d.width * d.height;
            const dormAspect = d.width / Math.max(1, d.height);
            const areaSim = Math.min(detArea, dormArea) / Math.max(detArea, dormArea || 1);
            const aspectSim = Math.min(detAspect, dormAspect) / Math.max(detAspect, dormAspect || 1);

            const dCx = d.x + d.width / 2;
            const dCy = d.y + d.height / 2;
            const dist = Math.hypot(detCx - dCx, detCy - dCy);
            const frameDiag = Math.hypot(frameW, frameH);
            const normDist = dist / frameDiag;
            const posProximity = Math.max(0, 1.0 - normDist);

            const recencyFactor = Math.max(0, 1.0 - (timeAwaySec / (this.reentryMemoryMs / 1000)));

            let score = 0;
            const isSoleDormant = (this.dormantTracks.length === 1 && this.tracks.length === 0);

            if (hasColorMatch) {
              // High-confidence clothing color match:
              score = (colorSim * 0.45) + (areaSim * 0.20) + (aspectSim * 0.15) + (posProximity * 0.10) + (recencyFactor * 0.10);
            } else if (isSoleDormant) {
              score = (areaSim * 0.35) + (aspectSim * 0.25) + (posProximity * 0.25) + (recencyFactor * 0.15);
            } else {
              score = (areaSim * 0.35) + (aspectSim * 0.25) + (posProximity * 0.25) + (recencyFactor * 0.15);
            }

            if (score > bestDormantScore && score >= 0.48) {
              bestDormantScore = score;
              bestDormantIdx = k;
            }
          }

          if (bestDormantIdx >= 0) {
            // Re-activate past human number!
            const resurrected = this.dormantTracks.splice(bestDormantIdx, 1)[0];
            resurrected.x = hx;
            resurrected.y = hy;
            resurrected.width = hw;
            resurrected.height = hh;
            resurrected.score = det.score;
            resurrected.vx = 0;
            resurrected.vy = 0;
            resurrected.motionState = 'STEADY';
            resurrected.direction = '';
            resurrected.misses = 0;
            resurrected.lastSeenTime = now;
            resurrected.lastUpdateTime = now;
            resurrected.lastSeenWallClock = wallClockNow;
            resurrected.totalDetections = (resurrected.totalDetections || 0) + 1;
            resurrected.firstSeenWallClock = wallClockNow - (resurrected.accumulatedDwellMs || 0);

            this.tracks.push(resurrected);
            matchedDetIndices.add(dIdx);
            continue;
          }

          // Not in 20-second memory: assign brand new Human ID
          const newId = this.nextId++;
          this.totalUniqueCount++;

          const newTrack = {
            id: newId,
            x: hx,
            y: hy,
            width: hw,
            height: hh,
            vx: 0,
            vy: 0,
            motionState: 'STEADY',
            direction: '',
            score: det.score,
            firstSeenWallClock: wallClockNow,
            lastSeenTime: now,
            lastUpdateTime: now,
            misses: 0,
            totalDetections: 1,
            accumulatedDwellMs: 0
          };
          this.tracks.push(newTrack);
        }
      }

      // 3. Evaluate active tracks & boundary exit logic
      const activeResults = [];
      const borderMarginX = Math.max(40, frameW * 0.08);
      const borderMarginY = Math.max(40, frameH * 0.08);

      for (let i = this.tracks.length - 1; i >= 0; i--) {
        const t = this.tracks[i];
        const isMatched = matchedTrackIndices.has(i);

        if (!isMatched) {
          t.misses++;
        }

        const elapsedSinceSeen = now - t.lastSeenTime;

        const isAtBoundary = (
          t.x <= borderMarginX ||
          t.y <= borderMarginY ||
          (t.x + t.width) >= (frameW - borderMarginX) ||
          (t.y + t.height) >= (frameH - borderMarginY)
        );

        const allowedGrace = isAtBoundary ? this.exitGraceMs : this.interiorGraceMs;

        if (elapsedSinceSeen > allowedGrace) {
          // Move departed track to 20-second re-entry memory!
          t.departedTime = now;
          t.departedWallClock = wallClockNow;
          t.accumulatedDwellMs = (t.accumulatedDwellMs || 0) + (wallClockNow - t.firstSeenWallClock);
          t.exitBbox = { x: t.x, y: t.y, w: t.width, h: t.height };
          t.isAtBoundary = isAtBoundary;

          this.dormantTracks = this.dormantTracks.filter(d => d.id !== t.id);
          this.dormantTracks.push(t);

          this.tracks.splice(i, 1);
          continue;
        }

        if (!isMatched && t.motionState === 'WALKING' && t.misses < 12) {
          t.x += t.vx * 0.03;
          t.y += t.vy * 0.03;
        }

        const dwellMs = wallClockNow - t.firstSeenWallClock;
        activeResults.push({
          ...t,
          isLive: isMatched,
          dwellMs,
          dwellFormatted: formatDwellTime(dwellMs)
        });
      }

      activeResults.sort((a, b) => a.id - b.id);
      return activeResults;
    }

    getLiveTracks(wallClockNow = Date.now()) {
      return this.tracks.map(t => {
        const dwellMs = wallClockNow - t.firstSeenWallClock;
        return {
          ...t,
          dwellMs,
          dwellFormatted: formatDwellTime(dwellMs)
        };
      });
    }

    clear() {
      this.tracks = [];
      this.dormantTracks = [];
    }
  }

  const phoneTracker = new AdvancedHumanTracker();

  function getMobileCoverTransformation(videoEl, canvasEl) {
    const vWidth = videoEl.videoWidth || canvasEl.width;
    const vHeight = videoEl.videoHeight || canvasEl.height;
    const cWidth = canvasEl.width;
    const cHeight = canvasEl.height;

    const videoRatio = vWidth / vHeight;
    const canvasRatio = cWidth / cHeight;

    let renderW, renderH, offsetX, offsetY;

    if (canvasRatio > videoRatio) {
      renderW = cWidth;
      renderH = cWidth / videoRatio;
      offsetX = 0;
      offsetY = (cHeight - renderH) / 2;
    } else {
      renderH = cHeight;
      renderW = cHeight * videoRatio;
      offsetX = (cWidth - renderW) / 2;
      offsetY = 0;
    }

    return {
      offsetX,
      offsetY,
      scaleX: renderW / vWidth,
      scaleY: renderH / vHeight
    };
  }

  function drawMobileHumanBox(ctx, x, y, width, height, human) {
    const green = '#00ff88';
    const isLive = human.isLive;

    ctx.save();
    // Green tint fill
    ctx.fillStyle = 'rgba(0, 255, 136, 0.08)';
    ctx.fillRect(x, y, width, height);

    // Glowing green stroke
    ctx.shadowColor = green;
    ctx.shadowBlur = 10;
    ctx.strokeStyle = green;
    ctx.lineWidth = 2.4;
    ctx.strokeRect(x, y, width, height);

    // Corner brackets
    const bLen = Math.max(10, Math.min(24, width * 0.2, height * 0.2));
    ctx.lineWidth = 3.6;
    ctx.beginPath();
    ctx.moveTo(x, y + bLen); ctx.lineTo(x, y); ctx.lineTo(x + bLen, y);
    ctx.moveTo(x + width - bLen, y); ctx.lineTo(x + width); ctx.lineTo(x + width, y + bLen);
    ctx.moveTo(x, y + height - bLen); ctx.lineTo(x, y + height); ctx.lineTo(x + bLen, y + height);
    ctx.moveTo(x + width - bLen, y + height); ctx.lineTo(x + width, y + height); ctx.lineTo(x + width, y + height - bLen);
    ctx.stroke();

    // Center reticle
    const cx = x + width / 2;
    const cy = y + height / 2;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.stroke();

    // Badges: Unique Number + Live Dwell Timer
    const percent = Math.round(human.score * 100);
    const idText = `HUMAN #${human.id} [${percent}%]`;
    const timerText = `⏱️ ${human.dwellFormatted}`;

    ctx.font = 'bold 11px monospace';
    const idWidth = ctx.measureText(idText).width + 16;
    const timerWidth = ctx.measureText(timerText).width + 14;
    const bHeight = 22;
    const bY = Math.max(0, y - bHeight - 2);

    ctx.shadowBlur = 0;
    // Pill 1: ID
    ctx.fillStyle = 'rgba(0, 20, 10, 0.94)';
    ctx.fillRect(x, bY, idWidth, bHeight);
    ctx.strokeStyle = green;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, bY, idWidth, bHeight);

    ctx.fillStyle = green;
    ctx.fillText(idText, x + 8, bY + 15);

    // Pill 2: Live Dwell Timer
    const timerX = x + idWidth + 4;
    ctx.fillStyle = 'rgba(0, 32, 16, 0.94)';
    ctx.fillRect(timerX, bY, timerWidth, bHeight);
    ctx.strokeStyle = green;
    ctx.lineWidth = 1.2;
    ctx.strokeRect(timerX, bY, timerWidth, bHeight);

    ctx.fillStyle = '#ffffff';
    ctx.fillText(timerText, timerX + 7, bY + 15);

    // Motion State footer
    const motionStr = human.motionState === 'WALKING'
      ? `WALKING ${human.direction}`
      : 'STEADY';
    const subText = `[#${human.id}] ${motionStr}`;
    ctx.font = '9px monospace';
    ctx.fillStyle = human.motionState === 'WALKING' ? '#00ffcc' : 'rgba(0, 255, 136, 0.85)';
    ctx.fillText(subText, x + 4, y + height - 6);

    ctx.restore();
  }

  async function loadPhoneHumanModel() {
    if (phoneHumanModel) return phoneHumanModel;
    try {
      if (typeof cocoSsd !== 'undefined') {
        phoneHumanModel = await cocoSsd.load({ modelUrl: '/models/mobilenet_v2/model.json' });
      }
    } catch (e) {
      try {
        phoneHumanModel = await cocoSsd.load();
      } catch (err) {
        console.error('Phone human model error:', err);
        return null;
      }
    }
    return phoneHumanModel;
  }

  let isPhoneInferring = false;
  let phoneInferenceTimeoutId = null;

  // 60 FPS Smooth HUD Loop
  function renderPhoneHUDLoop() {
    if (!phoneBotActive) return;

    if (cameraHudCanvas && cameraPreview) {
      const rect = cameraPreview.getBoundingClientRect();
      if (cameraHudCanvas.width !== Math.round(rect.width) || cameraHudCanvas.height !== Math.round(rect.height)) {
        cameraHudCanvas.width = Math.round(rect.width);
        cameraHudCanvas.height = Math.round(rect.height);
      }

      const ctx = cameraHudCanvas.getContext('2d');
      ctx.clearRect(0, 0, cameraHudCanvas.width, cameraHudCanvas.height);

      const wallClockNow = Date.now();
      const liveTracks = phoneTracker.getLiveTracks(wallClockNow);

      liveTracks.forEach(human => {
        drawMobileHumanBox(ctx, human.x, human.y, human.width, human.height, human);
      });

      if (phoneBotText) {
        phoneBotText.textContent = `HUMANS: ${liveTracks.length} | TOTAL: #${phoneTracker.totalUniqueCount}`;
      }
    }

    if (phoneBotActive) {
      phoneBotAnimId = requestAnimationFrame(renderPhoneHUDLoop);
    }
  }

  // Background Asynchronous Inference Loop
  async function triggerNextPhoneInference() {
    if (!phoneBotActive) return;
    if (isPhoneInferring || !phoneHumanModel || !cameraPreview || cameraPreview.readyState < 2) {
      phoneInferenceTimeoutId = setTimeout(triggerNextPhoneInference, 40);
      return;
    }

    isPhoneInferring = true;
    const now = performance.now();
    const wallClockNow = Date.now();

    try {
      const raw = await phoneHumanModel.detect(cameraPreview, 25, 0.20);
      const rawHumans = (raw || []).filter(p => p.class.toLowerCase() === 'person' && p.score >= 0.25);

      const transform = getMobileCoverTransformation(cameraPreview, cameraHudCanvas);
      const detectedScreenHumans = rawHumans.map(h => ({
        bbox: [
          transform.offsetX + (h.bbox[0] * transform.scaleX),
          transform.offsetY + (h.bbox[1] * transform.scaleY),
          h.bbox[2] * transform.scaleX,
          h.bbox[3] * transform.scaleY
        ],
        score: h.score
      }));

      const cH = cameraHudCanvas ? cameraHudCanvas.height : 720;
      const cW = cameraHudCanvas ? cameraHudCanvas.width : 1280;
      phoneTracker.update(detectedScreenHumans, now, wallClockNow, cW, cH);
    } catch (e) {
      console.warn('Phone bot detection error:', e);
    } finally {
      isPhoneInferring = false;
      if (phoneBotActive) {
        phoneInferenceTimeoutId = setTimeout(triggerNextPhoneInference, 40);
      }
    }
  }

  function runPhoneBotCycle() {
    if (phoneBotAnimId) cancelAnimationFrame(phoneBotAnimId);
    if (phoneInferenceTimeoutId) clearTimeout(phoneInferenceTimeoutId);
    renderPhoneHUDLoop();
    triggerNextPhoneInference();
  }

  if (btnPhoneBot) {
    btnPhoneBot.addEventListener('click', async () => {
      phoneBotActive = !phoneBotActive;
      btnPhoneBot.classList.toggle('bot-active', phoneBotActive);

      if (phoneBotActive) {
        if (phoneBotBadge) phoneBotBadge.style.display = 'flex';
        const model = await loadPhoneHumanModel();
        if (model) {
          runPhoneBotCycle();
        } else {
          phoneBotActive = false;
          btnPhoneBot.classList.remove('bot-active');
          if (phoneBotBadge) phoneBotBadge.style.display = 'none';
        }
      } else {
        if (phoneBotBadge) phoneBotBadge.style.display = 'none';
        if (phoneBotAnimId) {
          cancelAnimationFrame(phoneBotAnimId);
          phoneBotAnimId = null;
        }
        if (phoneInferenceTimeoutId) {
          clearTimeout(phoneInferenceTimeoutId);
          phoneInferenceTimeoutId = null;
        }
        phoneTracker.clear();
        if (cameraHudCanvas) {
          const ctx = cameraHudCanvas.getContext('2d');
          ctx.clearRect(0, 0, cameraHudCanvas.width, cameraHudCanvas.height);
        }
      }
    });
  }

  // 11. Fullscreen Management for Mobile Browsers
  function isFullscreen() {
    return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function toggleFullscreen() {
    if (!isFullscreen()) {
      if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else if (document.documentElement.webkitRequestFullscreen) {
        document.documentElement.webkitRequestFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
    }
  }

  function updateFullscreenUI() {
    const active = isFullscreen();
    if (fsTextPill) fsTextPill.textContent = active ? 'EXIT FULL' : 'FULLSCREEN';
    if (fsIconPill) fsIconPill.textContent = active ? '✕' : '⛶';
    if (btnFullscreen) btnFullscreen.classList.toggle('active', active);
  }

  if (btnFullscreen) btnFullscreen.addEventListener('click', toggleFullscreen);
  if (btnFullscreenPill) btnFullscreenPill.addEventListener('click', toggleFullscreen);

  document.addEventListener('fullscreenchange', updateFullscreenUI);
  document.addEventListener('webkitfullscreenchange', updateFullscreenUI);

  // Seamless auto-fullscreen on first user interaction (browser gesture requirement)
  window.addEventListener('click', () => {
    if (!isFullscreen()) {
      if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else if (document.documentElement.webkitRequestFullscreen) {
        document.documentElement.webkitRequestFullscreen();
      }
    }
  }, { once: true });

  // Auto Start
  startCamera();
  initWebSocket();
})();
