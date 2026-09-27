// =========================================================
// CEOVA CCTV VIEWER & COMMAND CENTER ENGINE
// =========================================================

(function () {
  // State variables
  let ws = null;
  let peerConnection = null;
  let localStream = null;
  let isConnected = false;
  let activeRoomId = 'CAM-1';
  let isTorchOn = false;
  let isFrontCamera = false;
  
  // Recording state
  let mediaRecorder = null;
  let recordedChunks = [];
  let recordingStartTime = 0;
  let recordingTimerInterval = null;

  // In-stream QR Scanner state
  let qrScannerActive = false;
  let qrScanInterval = null;
  let barcodeDetector = null;

  // AI Human Detection Bot state (Detects ONLY humans with green targeting box)
  let humanBotActive = false;
  let humanModel = null;
  let humanModelLoading = false;
  let humanDetectionAnimId = null;
  let lastHumanDetectionTime = 0;
  let humanDetectionConfidence = 0.30; // default 30% for high sensitivity to seated/distant humans
  let currentDetectedHumans = [];

  // DOM Elements
  const remoteVideo = document.getElementById('remoteVideo');
  const motionCanvas = document.getElementById('motionCanvas');
  const standbyOverlay = document.getElementById('standbyOverlay');
  const pairingQrImg = document.getElementById('pairingQrImg');
  const networkIpSelect = document.getElementById('networkIpSelect');
  const cameraUrlInput = document.getElementById('cameraUrlInput');
  const btnCopyLink = document.getElementById('btnCopyLink');
  const btnOpenTab = document.getElementById('btnOpenTab');
  const systemStatusPill = document.getElementById('systemStatusPill');
  const systemPulse = document.getElementById('systemPulse');
  const systemStatusText = document.getElementById('systemStatusText');
  const streamProtocolText = document.getElementById('streamProtocolText');
  const liveClock = document.getElementById('liveClock');
  const osdTimestamp = document.getElementById('osdTimestamp');
  const osdStatus = document.getElementById('osdStatus');
  const fpsMeter = document.getElementById('fpsMeter');
  const pingMeter = document.getElementById('pingMeter');
  const resMeter = document.getElementById('resMeter');
  const osdBattery = document.getElementById('osdBattery');
  const osdTorch = document.getElementById('osdTorch');
  const recBadge = document.getElementById('recBadge');
  const recTimer = document.getElementById('recTimer');
  const btnSnapshot = document.getElementById('btnSnapshot');
  const btnRecord = document.getElementById('btnRecord');
  const recordBtnText = document.getElementById('recordBtnText');
  const btnRemoteTorch = document.getElementById('btnRemoteTorch');
  const btnRemoteFlip = document.getElementById('btnRemoteFlip');
  const btnRemoteVibrate = document.getElementById('btnRemoteVibrate');
  const vibrateBtnText = document.getElementById('vibrateBtnText');
  const osdVibrate = document.getElementById('osdVibrate');
  const btnQrScanToggle = document.getElementById('btnQrScanToggle');
  const btnShowQr = document.getElementById('btnShowQr');
  const btnFullscreen = document.getElementById('btnFullscreen');
  const monitorWrapper = document.getElementById('monitorWrapper');
  const osdAspectBadge = document.getElementById('osdAspectBadge');
  const btnAspectToggle = document.getElementById('btnAspectToggle');
  const aspectBtnText = document.getElementById('aspectBtnText');
  const btnFitToggle = document.getElementById('btnFitToggle');
  const fitBtnText = document.getElementById('fitBtnText');
  const btnRotateToggle = document.getElementById('btnRotateToggle');
  const rotateBtnText = document.getElementById('rotateBtnText');
  const eventsList = document.getElementById('eventsList');
  const emptyLogState = document.getElementById('emptyLogState');
  const logCount = document.getElementById('logCount');
  const telemetryRoom = document.getElementById('telemetryRoom');
  const telemetryWs = document.getElementById('telemetryWs');
  const telemetryIce = document.getElementById('telemetryIce');
  const alertChime = document.getElementById('alertChime');
  const qrResultCard = document.getElementById('qrResultCard');
  const qrResultContent = document.getElementById('qrResultContent');
  const btnOpenQrUrl = document.getElementById('btnOpenQrUrl');
  const btnCloseQrResult = document.getElementById('btnCloseQrResult');

  // AI Human Detection Bot & Engine DOM Elements
  const btnAiEngineToggle = document.getElementById('btnAiEngineToggle');
  const aiEngineBtnText = document.getElementById('aiEngineBtnText');
  const btnOpenMemoryGallery = document.getElementById('btnOpenMemoryGallery');
  let aiEngineMode = 'yolo'; // 'yolo' (YOLOv8 + OpenCV) or 'mobilenet' (Browser COCO-SSD)

  const btnHumanBotToggle = document.getElementById('btnHumanBotToggle');
  const humanBotBtnText = document.getElementById('humanBotBtnText');
  const osdHumanBot = document.getElementById('osdHumanBot');
  const humanCountMeter = document.getElementById('humanCountMeter');
  const telemetryBotStatus = document.getElementById('telemetryBotStatus');
  const telemetryHumanCount = document.getElementById('telemetryHumanCount');
  const telemetryTotalTracked = document.getElementById('telemetryTotalTracked');
  const confidenceValText = document.getElementById('confidenceValText');
  const botConfidence = document.getElementById('botConfidence');
  const botTelemetryDot = document.getElementById('botTelemetryDot');

  let incidentCounter = 0;

  // Initialize Room ID from URL if provided (e.g. ?room=CAM-2)
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('room')) {
    activeRoomId = urlParams.get('room');
  }
  telemetryRoom.textContent = activeRoomId;

  // 1. Live Timestamp Clock
  function updateClock() {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().split(' ')[0];
    const millis = String(now.getMilliseconds()).padStart(3, '0');
    const fullTime = `${dateStr} ${timeStr}.${millis}`;

    liveClock.textContent = `${timeStr} UTC`;
    osdTimestamp.textContent = fullTime;
  }
  setInterval(updateClock, 50);

  // 2. Fetch Network Info & Generate Pairing QR Code
  async function setupNetworkAndQR() {
    if (!networkIpSelect) return;
    try {
      const res = await fetch('/api/info');
      const info = await res.json();
      
      // Populate IP Selector
      networkIpSelect.innerHTML = '';
      
      // Add detected local IPs
      const ips = info.ips || [];
      if (ips.length === 0) ips.push(info.primaryIp || window.location.hostname);

      ips.forEach(ip => {
        const opt = document.createElement('option');
        opt.value = `${info.protocol || 'https'}://${ip}:${info.port || window.location.port}`;
        opt.textContent = `${ip} (WiFi / LAN)`;
        networkIpSelect.appendChild(opt);
      });

      // Add localhost option
      const localOpt = document.createElement('option');
      localOpt.value = `${window.location.protocol}//${window.location.host}`;
      localOpt.textContent = `Current Host (${window.location.host})`;
      networkIpSelect.appendChild(localOpt);

      // Default select current origin if on LAN IP, or first LAN IP
      if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
        localOpt.selected = true;
      }

      updatePairingUrl();
    } catch (e) {
      console.warn('Could not fetch /api/info, using current host', e);
      if (networkIpSelect) {
        const opt = document.createElement('option');
        opt.value = window.location.origin;
        opt.textContent = window.location.host;
        networkIpSelect.appendChild(opt);
        updatePairingUrl();
      }
    }
  }

  async function updatePairingUrl() {
    if (!networkIpSelect || !pairingQrImg) return;
    const hostBase = networkIpSelect.value || window.location.origin;
    const cameraUrl = `${hostBase}/camera.html?room=${encodeURIComponent(activeRoomId)}`;
    if (cameraUrlInput) cameraUrlInput.value = cameraUrl;
    if (btnOpenTab) btnOpenTab.href = cameraUrl;

    try {
      const qrRes = await fetch(`/api/qr?text=${encodeURIComponent(cameraUrl)}`);
      const qrData = await qrRes.json();
      if (qrData.dataUrl && pairingQrImg) {
        pairingQrImg.src = qrData.dataUrl;
      }
    } catch (err) {
      console.error('Failed to load QR code image', err);
    }
  }

  if (networkIpSelect) {
    networkIpSelect.addEventListener('change', updatePairingUrl);
  }

  if (btnCopyLink && cameraUrlInput) {
    btnCopyLink.addEventListener('click', () => {
      navigator.clipboard.writeText(cameraUrlInput.value).then(() => {
        btnCopyLink.textContent = 'Copied!';
        setTimeout(() => {
          btnCopyLink.innerHTML = `
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
            </svg> Copy`;
        }, 2000);
      });
    });
  }

  // -------------------------------------------------------------
  // CCTV Camera Login & Autonomous Discovery Handler
  // -------------------------------------------------------------
  const overlayCctvForm = document.getElementById('overlayCctvForm');
  const overlayCctvUsername = document.getElementById('overlayCctvUsername');
  const overlayCctvPassword = document.getElementById('overlayCctvPassword');
  const overlayBotStatusText = document.getElementById('overlayBotStatusText');
  const overlayBotPulse = document.getElementById('overlayBotPulse');
  const btnOverlayConnect = document.getElementById('btnOverlayConnect');
  const btnSimulateOverlay = document.getElementById('btnSimulateOverlay');

  if (overlayCctvForm) {
    overlayCctvForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = overlayCctvUsername?.value.trim() || 'admin';
      const password = overlayCctvPassword?.value || '';
      const targetIp = document.getElementById('overlayCctvIp')?.value.trim() || null;

      if (btnOverlayConnect) {
        btnOverlayConnect.disabled = true;
        btnOverlayConnect.innerHTML = '<span class="pulse-dot"></span> Bot Scanning Network...';
      }
      if (overlayBotPulse) overlayBotPulse.style.background = '#38bdf8';
      if (overlayBotStatusText) overlayBotStatusText.textContent = 'Bot Status: Sweeping local network & testing codes...';

      try {
        const res = await fetch('/api/cameras/discover', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password, targetIp })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to start bot discovery');

        // Listen to SSE progress
        const evtSource = new EventSource('/api/cameras/discover/events');
        evtSource.onmessage = async (evtMsg) => {
          try {
            const ev = JSON.parse(evtMsg.data);
            if (ev.message && overlayBotStatusText) {
              overlayBotStatusText.textContent = ev.message;
            }
            if (ev.type === 'CAMERA_MATCHED' && ev.camera) {
              evtSource.close();
              if (overlayBotPulse) overlayBotPulse.style.background = '#22c55e';
              if (overlayBotStatusText) overlayBotStatusText.textContent = `✓ Connected: ${ev.camera.brand} (${ev.camera.ip})`;
              
              // Auto-register camera into active surveillance and launch RTSP stream
              try {
                const regRes = await fetch('/api/cameras/connect-matched', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    id: ev.camera.id,
                    name: `${ev.camera.brand} (${ev.camera.ip})`,
                    rtspUrl: ev.camera.rtspUrl,
                    zoneName: 'SALES_FLOOR'
                  })
                });
                const regData = await regRes.json();
                const streamUrl = (regData && regData.streamUrl) || `/api/cameras/${ev.camera.id}/stream.mjpg`;

                displayRtspStream(ev.camera.id, `${ev.camera.brand} (${ev.camera.ip})`, streamUrl);
              } catch (regErr) {
                console.error('Error registering matched camera:', regErr);
                displayRtspStream(ev.camera.id, `${ev.camera.brand} (${ev.camera.ip})`);
              }
            } else if (ev.type === 'SCAN_COMPLETED') {
              evtSource.close();
              if (btnOverlayConnect) {
                btnOverlayConnect.disabled = false;
                btnOverlayConnect.innerHTML = '⚡ Auto-Detect & Connect Camera';
              }
              if (ev.matchedCount === 0 && overlayBotStatusText) {
                if (ev.discoveredHosts && ev.discoveredHosts.length > 0) {
                  const firstH = ev.discoveredHosts[0];
                  overlayBotStatusText.innerHTML = `Found ${ev.discoveredHosts.length} camera(s) on LAN (<a href="/connect.html" style="color:#38bdf8;text-decoration:underline;">Click to connect ${firstH.ip}</a>)`;
                  if (overlayBotPulse) overlayBotPulse.style.background = '#eab308';
                } else {
                  overlayBotStatusText.textContent = 'Scan finished: No cameras found with these credentials.';
                  if (overlayBotPulse) overlayBotPulse.style.background = '#ef4444';
                }
              }
            }
          } catch (_err) {}
        };
      } catch (err) {
        if (overlayBotStatusText) overlayBotStatusText.textContent = `Error: ${err.message}`;
        if (btnOverlayConnect) {
          btnOverlayConnect.disabled = false;
          btnOverlayConnect.innerHTML = '⚡ Auto-Detect & Connect Camera';
        }
      }
    });
  }

  // Live CCTV Synthetic Stream Generator (for demo / simulation mode)
  let simStreamInterval = null;
  function startSimulatedCctvStream() {
    const simCanvas = document.createElement('canvas');
    simCanvas.width = 1280;
    simCanvas.height = 720;
    const ctx = simCanvas.getContext('2d');
    
    let frame = 0;
    const people = [
      { x: 340, y: 380, vx: 1.6, vy: 0.15, color: '#38bdf8', label: 'STAFF #1' },
      { x: 820, y: 410, vx: -1.3, vy: -0.1, color: '#f59e0b', label: 'CUSTOMER' },
      { x: 580, y: 440, vx: 0.9, vy: 0.25, color: '#10b981', label: 'STAFF #2' }
    ];

    function drawCctvFrame() {
      frame++;
      // Background gradient
      const grad = ctx.createLinearGradient(0, 0, 0, 720);
      grad.addColorStop(0, '#0a0f1d');
      grad.addColorStop(0.45, '#162032');
      grad.addColorStop(1, '#060a12');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 1280, 720);

      // Perspective floor lines
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
      ctx.lineWidth = 1;
      for (let x = 0; x <= 1280; x += 80) {
        ctx.beginPath();
        ctx.moveTo(x, 260);
        ctx.lineTo((x - 640) * 2.5 + 640, 720);
        ctx.stroke();
      }
      for (let y = 260; y <= 720; y += 45) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(1280, y);
        ctx.stroke();
      }

      // Moving human silhouettes
      people.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 150 || p.x > 1120) p.vx *= -1;
        if (p.y < 340 || p.y > 540) p.vy *= -1;

        const bob = Math.sin(frame * 0.18) * 4;
        ctx.fillStyle = 'rgba(226, 232, 240, 0.88)';
        // Head
        ctx.beginPath();
        ctx.arc(p.x, p.y - 75 + bob, 18, 0, Math.PI * 2);
        ctx.fill();
        // Torso
        ctx.beginPath();
        ctx.ellipse(p.x, p.y - 20 + bob, 22, 42, 0, 0, Math.PI * 2);
        ctx.fill();
        // Legs
        ctx.fillRect(p.x - 16, p.y + 22 + bob, 10, 48);
        ctx.fillRect(p.x + 6, p.y + 22 + bob, 10, 48);

        // Security tag
        ctx.fillStyle = p.color;
        ctx.font = 'bold 12px "JetBrains Mono", monospace';
        ctx.fillText(`● ${p.label}`, p.x - 30, p.y - 105 + bob);
      });

      // CCTV Camera OSD Overlay
      ctx.fillStyle = '#22c55e';
      ctx.font = 'bold 16px "JetBrains Mono", monospace';
      const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
      ctx.fillText(`REC ● CAM-01 [SALES FLOOR]  ${nowStr}  25.0 FPS`, 30, 40);

      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.font = '12px "JetBrains Mono", monospace';
      ctx.fillText(`H.264 / 1080p / 4096kbps / RTSP HIKVISION OVER ONVIF`, 30, 62);

      // Light scanline effect
      ctx.fillStyle = 'rgba(255, 255, 255, 0.015)';
      for (let y = 0; y < 720; y += 4) {
        ctx.fillRect(0, y, 1280, 1);
      }
    }

    if (simCanvas.captureStream) {
      const stream = simCanvas.captureStream(25);
      remoteVideo.srcObject = stream;
      remoteVideo.style.display = 'block';
      remoteVideo.play().catch(() => {});
      if (simStreamInterval) clearInterval(simStreamInterval);
      simStreamInterval = setInterval(drawCctvFrame, 40);
    }
  }

  // Simulation test mode button
  if (btnSimulateOverlay) {
    btnSimulateOverlay.addEventListener('click', async () => {
      if (overlayBotStatusText) overlayBotStatusText.textContent = 'Simulating verified CCTV stream (Demo Mode)...';
      if (overlayBotPulse) overlayBotPulse.style.background = '#38bdf8';
      startSimulatedCctvStream();
      setTimeout(() => {
        if (overlayBotPulse) overlayBotPulse.style.background = '#22c55e';
        if (overlayBotStatusText) overlayBotStatusText.textContent = '✓ Connected: Hikvision 1080p (Simulated)';
        setTimeout(() => {
          standbyOverlay.classList.add('hidden');
          if (systemStatusText) systemStatusText.textContent = 'LIVE: Hikvision 1080p (Simulated)';
          if (systemPulse) systemPulse.classList.add('active');
        }, 800);
      }, 1000);
    });
  }

  // 3. WebSocket & WebRTC Signaling
  function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('Connected to CCTV signaling server');
      telemetryWs.textContent = 'CONNECTED';
      telemetryWs.style.color = 'var(--accent-green)';

      // Join room as viewer
      ws.send(JSON.stringify({
        type: 'join',
        role: 'viewer',
        roomId: activeRoomId
      }));

      // Ping interval for latency
      startPingInterval();
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleSignalingMessage(msg);
      } catch (e) {
        console.error('Error parsing WS message', e);
      }
    };

    ws.onclose = () => {
      console.warn('Signaling server closed. Reconnecting in 2s...');
      telemetryWs.textContent = 'RECONNECTING';
      telemetryWs.style.color = 'var(--accent-amber)';
      setTimeout(initWebSocket, 2000);
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };
  }

  let pingStart = 0;
  function startPingInterval() {
    setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        pingStart = performance.now();
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 3000);
  }

  const fallbackImgFeed = document.getElementById('fallbackImgFeed');
  let iceCandidatesQueue = [];

  // 4. WebRTC Peer Connection Management
  function createPeerConnection() {
    if (peerConnection) {
      try { peerConnection.close(); } catch(e) {}
    }
    iceCandidatesQueue = [];

    const peerConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
      ]
    };

    peerConnection = new RTCPeerConnection(peerConfig);

    // Track state
    peerConnection.onconnectionstatechange = () => {
      telemetryIce.textContent = peerConnection.connectionState.toUpperCase();
      console.log('WebRTC Connection State:', peerConnection.connectionState);
      if (peerConnection.connectionState === 'connected') {
        onStreamConnected('WebRTC P2P');
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'webrtc-active', roomId: activeRoomId }));
        }
      } else if (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed') {
        if (fallbackImgFeed && fallbackImgFeed.style.display === 'block') {
          streamProtocolText.textContent = 'WebSocket Relay';
        } else {
          onStreamDisconnected();
        }
      }
    };

    peerConnection.onicecandidate = (event) => {
      if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'candidate',
          candidate: event.candidate,
          roomId: activeRoomId
        }));
      }
    };

    // When remote media track arrives from phone!
    peerConnection.ontrack = (event) => {
      console.log('Received remote media stream track:', event.track.kind);
      
      // Safari / Chrome cross-browser track attachment
      if (event.streams && event.streams[0]) {
        remoteVideo.srcObject = event.streams[0];
      } else {
        if (!remoteVideo.srcObject) {
          remoteVideo.srcObject = new MediaStream();
        }
        remoteVideo.srcObject.addTrack(event.track);
      }

      remoteVideo.muted = true;
      remoteVideo.setAttribute('playsinline', '');
      remoteVideo.setAttribute('autoplay', '');

      remoteVideo.play().then(() => {
        console.log('Remote video playing');
        remoteVideo.style.display = 'block';
        if (fallbackImgFeed) fallbackImgFeed.style.display = 'none';
        onStreamConnected('WebRTC P2P');
      }).catch(e => {
        console.warn('Video play error (Safari autoplay):', e);
        remoteVideo.style.display = 'block';
        if (fallbackImgFeed) fallbackImgFeed.style.display = 'none';
        onStreamConnected('WebRTC P2P');
      });
    };

    return peerConnection;
  }

  function boostSdpBitrate(sdp, bitrateKbps = 5000) {
    if (!sdp) return sdp;
    return sdp.replace(/m=video (.*)\r\n/g, `m=video $1\r\nb=AS:${bitrateKbps}\r\nb=TIAS:${bitrateKbps * 1000}\r\n`);
  }

  async function handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'pong': {
        const pingTime = Math.round(performance.now() - pingStart);
        pingMeter.textContent = `${pingTime} ms`;
        break;
      }

      case 'status':
      case 'peer-joined': {
        if (msg.source === 'rtsp' && msg.streamUrl) {
          console.log(`[RTSP] Received active camera stream: ${msg.cameraId}`);
          displayRtspStream(msg.cameraId, 'CCTV Camera', msg.streamUrl);
        } else if (msg.role === 'broadcaster' || msg.status === 'broadcaster-ready') {
          console.log('Camera joined the room.');
          // Don't recreate peer connection here; wait for broadcaster's offer
        }
        break;
      }

      case 'peer-left': {
        if (msg.role === 'broadcaster') {
          console.log('Phone camera disconnected.');
          onStreamDisconnected();
        }
        break;
      }

      // Structured Identity Recognition Events from Server
      case 'identity-event': {
        if (typeof handleLiveIdentityEvent === 'function') {
          handleLiveIdentityEvent(msg.event);
        }
        break;
      }

      case 'offer': {
        console.log('Received WebRTC offer from phone camera');
        const pc = createPeerConnection();
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          
          // Flush queued candidates
          while (iceCandidatesQueue.length > 0) {
            const cand = iceCandidatesQueue.shift();
            try {
              await pc.addIceCandidate(new RTCIceCandidate(cand));
            } catch(e) {
              console.warn('Queued candidate error:', e);
            }
          }

          const answer = await pc.createAnswer();
          const boostedAnswerSdp = boostSdpBitrate(answer.sdp, 5000);
          await pc.setLocalDescription(new RTCSessionDescription({ type: answer.type, sdp: boostedAnswerSdp }));

          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'answer',
              sdp: pc.localDescription,
              roomId: activeRoomId
            }));
            console.log('Sent WebRTC answer to phone camera (5 Mbps boosted)');
          }
        } catch (err) {
          console.error('Error handling WebRTC offer:', err);
        }
        break;
      }

      case 'candidate': {
        if (msg.candidate) {
          if (peerConnection && peerConnection.remoteDescription) {
            try {
              await peerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate));
            } catch (e) {
              console.error('Error adding ICE candidate', e);
            }
          } else {
            iceCandidatesQueue.push(msg.candidate);
          }
        }
        break;
      }

      // Hardware status report from phone (battery, torch state, camera orientation)
      case 'camera-info': {
        if (msg.battery !== undefined) {
          osdBattery.textContent = `🔋 PHONE: ${msg.battery}%`;
        }
        if (msg.torch !== undefined) {
          isTorchOn = msg.torch;
          osdTorch.textContent = `🔦 FLASH: ${isTorchOn ? 'ON' : 'OFF'}`;
          btnRemoteTorch.classList.toggle('btn-active', isTorchOn);
        }
        if (msg.facingMode !== undefined) {
          isFrontCamera = msg.facingMode === 'user';
          document.getElementById('osdCameraName').textContent = 
            `CAM-01 [PHONE ${isFrontCamera ? 'FRONT' : 'REAR'} CAMERA]`;
        }
        if (msg.aspectRatio !== undefined || msg.orientation !== undefined) {
          if (currentAspectMode === 'auto') {
            const isPort = msg.orientation === 'portrait' || msg.aspectRatio === '9:16';
            applyAspectMode(isPort ? '9:16' : '16:9', false);
          }
        }
        if (msg.action === 'vibrate-ack') {
          if (osdVibrate) {
            osdVibrate.classList.remove('hidden');
            osdVibrate.textContent = msg.hardwareVibrated ? '📳 PHONE VIBRATED!' : '📳 PHONE ALERTED!';
            setTimeout(() => {
              if (osdVibrate) osdVibrate.classList.add('hidden');
            }, 3000);
          }
          addLogEvent('camera', 'PHONE VIBRATED', msg.hardwareVibrated ? 'Phone vibration motor activated' : 'Phone visual & audio alert triggered');
        }
        break;
      }

      // Fallback frame receiver (instant display over WebSockets)
      case 'frame': {
        if (msg.image) {
          renderFallbackFrame(msg.image);
        }
        break;
      }
    }
  }

  // 5. Fallback Frame Renderer (over WebSockets)
  let fallbackFrameCount = 0;
  let lastFpsCalcTime = performance.now();

  function renderFallbackFrame(dataUri) {
    if (!fallbackImgFeed) return;
    fallbackImgFeed.src = dataUri;

    if (!remoteVideo.srcObject || remoteVideo.videoWidth === 0) {
      fallbackImgFeed.style.display = 'block';
      remoteVideo.style.display = 'none';
      if (fallbackImgFeed.naturalWidth) {
        resMeter.textContent = `${fallbackImgFeed.naturalWidth} x ${fallbackImgFeed.naturalHeight}`;
      } else {
        resMeter.textContent = '640 x 360';
      }
    }

    fallbackFrameCount++;
    const now = performance.now();
    if (now - lastFpsCalcTime >= 1000) {
      if (!remoteVideo.srcObject || remoteVideo.videoWidth === 0) {
        fpsMeter.textContent = String(fallbackFrameCount);
      }
      fallbackFrameCount = 0;
      lastFpsCalcTime = now;
    }

    onStreamConnected('WebSocket Relay');
  }

  // 6. Connected / Disconnected State Handler
  function onStreamConnected(protocolName) {
    if (!isConnected) {
      isConnected = true;
      standbyOverlay.classList.add('hidden');
      systemPulse.className = 'pulse-dot online';
      systemStatusText.textContent = 'ONLINE // LIVE FEED ACTIVE';
      osdStatus.textContent = 'ONLINE';
      osdStatus.style.color = 'var(--accent-green)';
      addLogEvent('camera-connect', 'CCTV Camera Connected', 'Live video stream initialized');
    }
    streamProtocolText.textContent = protocolName;
    startFpsMeter();
  }

  // Display Live RTSP Video Stream
  function displayRtspStream(cameraId, cameraName = 'CCTV Camera', customStreamUrl = null) {
    const streamUrl = customStreamUrl || `/api/cameras/${cameraId}/stream.mjpg`;
    if (!fallbackImgFeed) return;

    if (systemStatusText) systemStatusText.textContent = `CONNECTING: ${cameraName}...`;
    if (systemPulse) systemPulse.className = 'pulse-dot active';

    let firstFrameArrived = false;

    fallbackImgFeed.onload = () => {
      if (!firstFrameArrived) {
        firstFrameArrived = true;
        standbyOverlay.classList.add('hidden');
        if (systemStatusText) systemStatusText.textContent = `LIVE: ${cameraName}`;
        if (systemPulse) systemPulse.className = 'pulse-dot online';
        if (streamProtocolText) streamProtocolText.textContent = 'RTSP MJPEG';
        onStreamConnected('RTSP MJPEG');
      }
    };

    fallbackImgFeed.onerror = () => {
      console.warn(`[Viewer] Failed to load stream from ${streamUrl}`);
      if (!firstFrameArrived) {
        standbyOverlay.classList.remove('hidden');
        if (overlayBotStatusText) {
          overlayBotStatusText.textContent = `Stream connection failed for ${cameraName}. Check camera credentials & network.`;
        }
        if (overlayBotPulse) overlayBotPulse.style.background = '#ef4444';
        if (systemStatusText) systemStatusText.textContent = `OFFLINE // ${cameraName}`;
        if (systemPulse) systemPulse.className = 'pulse-dot';
      }
    };

    // Direct the fallback image to the live MJPEG stream
    fallbackImgFeed.src = streamUrl;
    fallbackImgFeed.style.display = 'block';
    remoteVideo.style.display = 'none';
  }

  // Auto-connect to active camera in database on page load
  async function checkActiveCameraOnLoad() {
    try {
      const res = await fetch('/api/cameras');
      const data = await res.json();
      if (data && data.cameras && data.cameras.length > 0) {
        const cam = data.cameras[0];
        console.log(`[Viewer] Found registered camera on startup: ${cam.name} (${cam.id})`);
        displayRtspStream(cam.id, cam.name, `/api/cameras/${cam.id}/stream.mjpg`);
      }
    } catch (_e) {}
  }

  function onStreamDisconnected() {
    isConnected = false;
    standbyOverlay.classList.remove('hidden');
    systemPulse.className = 'pulse-dot';
    systemStatusText.textContent = 'STANDBY // WAITING FOR PHONE';
    osdStatus.textContent = 'DISCONNECTED';
    osdStatus.style.color = 'var(--accent-red)';
    fpsMeter.textContent = '0';
    resMeter.textContent = '-- x --';
    remoteVideo.srcObject = null;
    remoteVideo.style.display = 'none';
    if (fallbackImgFeed) fallbackImgFeed.style.display = 'none';
    
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      stopRecording();
    }
  }

  // 7. Live FPS and Resolution Meter
  let fpsTimerRunning = false;
  function startFpsMeter() {
    if (fpsTimerRunning) return;
    fpsTimerRunning = true;

    let vFrameCount = 0;
    let lastTime = performance.now();

    function checkStats() {
      if (!isConnected) {
        fpsTimerRunning = false;
        return;
      }

      if (remoteVideo.videoWidth > 0 && remoteVideo.style.display !== 'none') {
        resMeter.textContent = `${remoteVideo.videoWidth} x ${remoteVideo.videoHeight}`;
      } else if (fallbackImgFeed && fallbackImgFeed.style.display !== 'none' && fallbackImgFeed.naturalWidth > 0) {
        resMeter.textContent = `${fallbackImgFeed.naturalWidth} x ${fallbackImgFeed.naturalHeight}`;
      }

      if ('requestVideoFrameCallback' in remoteVideo && remoteVideo.style.display !== 'none') {
        remoteVideo.requestVideoFrameCallback(() => {
          vFrameCount++;
        });
      }

      const now = performance.now();
      if (now - lastTime >= 1000) {
        if (remoteVideo.style.display !== 'none') {
          const fps = Math.round((vFrameCount * 1000) / (now - lastTime));
          fpsMeter.textContent = String(fps || 30);
        } else if (fallbackImgFeed && fallbackImgFeed.style.display !== 'none') {
          fpsMeter.textContent = '15';
        }
        vFrameCount = 0;
        lastTime = now;
      }

      requestAnimationFrame(checkStats);
    }
    requestAnimationFrame(checkStats);
  }

  // 8. Remote Phone Controls (Viewer -> Phone)
  btnRemoteTorch.addEventListener('click', () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    isTorchOn = !isTorchOn;
    ws.send(JSON.stringify({
      type: 'command',
      action: 'toggle-torch',
      roomId: activeRoomId,
      state: isTorchOn
    }));
    btnRemoteTorch.classList.toggle('btn-active', isTorchOn);
    osdTorch.textContent = `🔦 FLASH: ${isTorchOn ? 'ON' : 'OFF'}`;
  });

  btnRemoteFlip.addEventListener('click', () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: 'command',
      action: 'switch-camera',
      roomId: activeRoomId
    }));
  });

  // Remote Vibrate Phone
  if (btnRemoteVibrate) {
    btnRemoteVibrate.addEventListener('click', () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        alert('Cannot vibrate phone: Camera connection is not active.');
        return;
      }

      // Send vibrate command to connected phone
      ws.send(JSON.stringify({
        type: 'command',
        action: 'vibrate',
        roomId: activeRoomId,
        pattern: [300, 150, 300, 150, 400]
      }));

      // Immediate visual feedback on viewer button and OSD
      btnRemoteVibrate.classList.add('vibrating-btn');
      if (vibrateBtnText) vibrateBtnText.textContent = 'Vibrating...';
      if (osdVibrate) {
        osdVibrate.classList.remove('hidden');
        osdVibrate.textContent = '📳 VIBRATE: SENT';
      }

      setTimeout(() => {
        btnRemoteVibrate.classList.remove('vibrating-btn');
        if (vibrateBtnText) vibrateBtnText.textContent = 'Vibrate';
      }, 1300);

      setTimeout(() => {
        if (osdVibrate && osdVibrate.textContent === '📳 VIBRATE: SENT') {
          osdVibrate.classList.add('hidden');
        }
      }, 3000);
    });
  }


  // 10. Instant Snapshot Capture
  btnSnapshot.addEventListener('click', () => {
    captureSnapshot();
  });

  function captureSnapshot(isAutomaticAlert = false, customTitle = null, customDesc = null) {
    const isVideoMode = remoteVideo.videoWidth > 0 && remoteVideo.style.display !== 'none';
    const sourceEl = isVideoMode ? remoteVideo : fallbackImgFeed;
    const width = (isVideoMode ? remoteVideo.videoWidth : fallbackImgFeed.naturalWidth) || 1280;
    const height = (isVideoMode ? remoteVideo.videoHeight : fallbackImgFeed.naturalHeight) || 720;
    
    const snapCanvas = document.createElement('canvas');
    snapCanvas.width = width;
    snapCanvas.height = height;
    const ctx = snapCanvas.getContext('2d');

    // Draw current video or image frame
    try {
      ctx.drawImage(sourceEl, 0, 0, width, height);
    } catch(e) {
      console.warn('Canvas drawImage error during snapshot:', e);
    }

    // Burn CCTV timestamp watermark
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(16, height - 48, 460, 36);
    ctx.fillStyle = '#00f0ff';
    ctx.font = 'bold 16px monospace';
    ctx.fillText(`CEOVA CCTV // ${osdTimestamp.textContent}`, 26, height - 24);

    const dataUrl = snapCanvas.toDataURL('image/png');

    // Auto download if manual click
    if (!isAutomaticAlert) {
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `CCTV_SNAPSHOT_${Date.now()}.png`;
      a.click();
    }

    const title = customTitle || (isAutomaticAlert ? '🚨 Automatic Alert Snapshot' : '📸 Manual Snapshot');
    const desc = customDesc || `Saved ${width}x${height} HD Frame`;

    addLogEvent(
      isAutomaticAlert ? 'motion' : 'snapshot',
      title,
      desc,
      dataUrl
    );
  }

  // 11. Video Recording (MediaRecorder API)
  btnRecord.addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      stopRecording();
    } else {
      startRecording();
    }
  });

  function startRecording() {
    let streamToRecord = remoteVideo.srcObject;
    if (!streamToRecord && remoteVideo.captureStream) {
      streamToRecord = remoteVideo.captureStream();
    }
    if (!streamToRecord && motionCanvas.captureStream) {
      streamToRecord = motionCanvas.captureStream(20);
    }

    if (!streamToRecord) {
      alert('Cannot start recording: No active camera stream found.');
      return;
    }

    recordedChunks = [];
    let options = { mimeType: 'video/webm;codecs=vp8,opus' };
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
      options = { mimeType: 'video/webm' };
    }

    try {
      mediaRecorder = new MediaRecorder(streamToRecord, options);
    } catch (e) {
      console.warn('Fallback media recorder setup', e);
      mediaRecorder = new MediaRecorder(streamToRecord);
    }

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: 'video/webm' });
      const videoUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = videoUrl;
      a.download = `CCTV_RECORDING_${Date.now()}.webm`;
      a.click();

      addLogEvent('recording', '🔴 Video Recording Saved', `Duration: ${recTimer.textContent}`, null, videoUrl);
    };

    mediaRecorder.start(1000); // 1-second chunks
    recordingStartTime = Date.now();

    // UI Updates
    btnRecord.classList.add('btn-danger');
    recordBtnText.textContent = 'Stop Rec';
    recBadge.classList.remove('hidden');
    systemPulse.className = 'pulse-dot recording';

    recordingTimerInterval = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - recordingStartTime) / 1000);
      const m = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
      const s = String(elapsedSec % 60).padStart(2, '0');
      recTimer.textContent = `${m}:${s}`;
    }, 1000);
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
    }
    clearInterval(recordingTimerInterval);
    btnRecord.classList.remove('btn-danger');
    recordBtnText.textContent = 'Record';
    recBadge.classList.add('hidden');
    recTimer.textContent = '00:00';
    systemPulse.className = 'pulse-dot online';
  }


  // 13. In-Stream QR / Barcode Recognition
  btnQrScanToggle.addEventListener('click', async () => {
    qrScannerActive = !qrScannerActive;
    btnQrScanToggle.classList.toggle('btn-active', qrScannerActive);

    if (qrScannerActive) {
      startInStreamQrScanner();
    } else {
      stopInStreamQrScanner();
    }
  });

  async function startInStreamQrScanner() {
    if ('BarcodeDetector' in window) {
      try {
        barcodeDetector = new BarcodeDetector({ formats: ['qr_code', 'ean_13', 'code_128'] });
      } catch (e) {
        console.warn('BarcodeDetector format init fallback:', e);
      }
    }

    qrScanInterval = setInterval(async () => {
      if (!isConnected || !barcodeDetector) return;
      const isVideoMode = remoteVideo.videoWidth > 0 && remoteVideo.style.display !== 'none';
      const sourceEl = isVideoMode ? remoteVideo : fallbackImgFeed;
      if (isVideoMode && remoteVideo.readyState < 2) return;
      if (!isVideoMode && !fallbackImgFeed.complete) return;

      try {
        const barcodes = await barcodeDetector.detect(sourceEl);
        if (barcodes && barcodes.length > 0) {
          const firstCode = barcodes[0];
          showQrScanResult(firstCode.rawValue);
        }
      } catch (e) {
        // Ignored frame error
      }
    }, 500);
  }

  function stopInStreamQrScanner() {
    clearInterval(qrScanInterval);
    qrResultCard.classList.remove('visible');
  }

  function showQrScanResult(text) {
    qrResultContent.textContent = text;
    qrResultCard.classList.add('visible');

    btnOpenQrUrl.onclick = () => {
      if (text.startsWith('http://') || text.startsWith('https://')) {
        window.open(text, '_blank');
      } else {
        navigator.clipboard.writeText(text);
        alert(`Copied to clipboard: ${text}`);
      }
    };
  }

  btnCloseQrResult.addEventListener('click', () => {
    qrResultCard.classList.remove('visible');
  });

  // =========================================================
  // 13b. ADVANCED AI HUMAN BOT: DISTANT SCAN, UNIQUE IDs, DWELL TIMER & MOTION STATE
  // =========================================================

  // Dedicated offscreen buffer for full frame AI scans
  const aiBufferCanvas = document.createElement('canvas');
  const aiBufferCtx = aiBufferCanvas.getContext('2d', { willReadFrequently: true });

  // Format dwell duration into MM:SS or HH:MM:SS
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
      this.tracks = []; // Array of active tracks
      this.nextId = (options && options.startId) || 1;
      this.totalUniqueCount = 0;

      // Interior grace — how long a track stays alive while undetected (occluded / seated).
      // 15 seconds: covers realistic occlusion events like walking behind another person,
      // ducking under a desk, or momentarily leaving the camera edge.
      // The OLD value of 6500ms was too short — people hidden behind others for >6.5s
      // would lose their track and re-appear with a brand-new ID.
      this.interiorGraceMs = (options && options.interiorGraceMs) || 15000;

      // Border exit persistence: human at camera edge retires after 2.5s
      this.exitGraceMs = (options && options.exitGraceMs) || 2500;

      // Re-entry memory: remember departed tracks for 30 seconds.
      // 30s gives enough buffer for someone who leaves the frame briefly and returns.
      this.reentryMemoryMs = (options && options.reentryMemoryMs !== undefined) ? options.reentryMemoryMs : 30000;
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

      function getInterArea(b1, b2) {
        const x1 = Math.max(b1.x, b2.x);
        const y1 = Math.max(b1.y, b2.y);
        const x2 = Math.min(b1.x + b1.w, b2.x + b2.w);
        const y2 = Math.min(b1.y + b1.h, b2.y + b2.h);
        return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
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
            // Strong IoU overlap → high confidence same person
            affinity = (iou * 2.2) + Math.max(0, 1.0 - normDist) * 0.7 + (areaSim * 0.3);
          } else if (normDist < 0.90) {
            // Proximity-only match — tightened from 1.4→0.90 to prevent cross-frame
            // matches where one track claims a detection that's actually a different person.
            affinity = Math.max(0, 1.0 - (normDist / 0.90)) + (areaSim * 0.25);
          }

          // Established track lock bonus: lock on firmly to existing confirmed humans
          if ((tr.totalDetections || 0) > 2) {
            affinity += 0.15; // Reduced from 0.20 to keep fair competition between tracks
          }

          // Color consistency gating — strict rejection if clothing looks different
          if (det.colorSignature && tr.colorSignature) {
            const cd = Math.hypot(
              det.colorSignature[0] - tr.colorSignature[0],
              det.colorSignature[1] - tr.colorSignature[1],
              det.colorSignature[2] - tr.colorSignature[2]
            );
            if (cd > 55) {
              // Hard reject: clearly different clothing color → different person
              continue;
            } else {
              const colorSim = Math.max(0, 1.0 - (cd / 110));
              affinity += colorSim * 0.30;
            }
          }

          // Raise minimum affinity gate from 0.28→0.35 to reduce false associations
          if (affinity > 0.35) {
            candidates.push({ tIdx, dIdx, affinity });
          }
        }
      }

      // Sort candidate pairs by highest affinity first (Global optimal match assignment)
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

          // Estimate motion velocity with clamping to avoid unnatural spikes
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

          // Smooth exponential position & dimension interpolation (absorbs frame noise)
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

          const detArea = hw * hh;
          const detAspect = hw / Math.max(1, hh);
          const detCx = hx + hw / 2;
          const detCy = hy + hh / 2;

          // Reject if this detection overlaps ANY active track (prevents ghost doubles/torsos on the same human)
          let overlapsActiveTrack = false;
          for (const tr of this.tracks) {
            const trIoU = getIoU(
              { x: tr.x, y: tr.y, w: tr.width, h: tr.height },
              { x: hx, y: hy, w: hw, h: hh }
            );
            const trInter = getInterArea(
              { x: tr.x, y: tr.y, w: tr.width, h: tr.height },
              { x: hx, y: hy, w: hw, h: hh }
            );
            const minArea = Math.min(tr.width * tr.height, detArea);
            const ioMin = minArea > 0 ? trInter / minArea : 0;
            const trCx = tr.x + tr.width / 2;
            const trCy = tr.y + tr.height / 2;
            const dist = Math.hypot(detCx - trCx, detCy - trCy);
            const refDim = Math.min(Math.max(tr.width, tr.height), Math.max(hw, hh), 120);

            if (trIoU > 0.22 || ioMin > 0.45 || (dist / refDim) < 0.45) {
              overlapsActiveTrack = true;
              break;
            }
          }

          if (overlapsActiveTrack) {
            continue;
          }

          let bestDormantIdx = -1;
          let bestDormantScore = 0;

          for (let k = 0; k < this.dormantTracks.length; k++) {
            const d = this.dormantTracks[k];
            const timeAwaySec = (now - d.departedTime) / 1000;
            if (timeAwaySec > (this.reentryMemoryMs / 1000)) continue;

            // ── Clothing color gating ─────────────────────────────────────────────
            // If we have color signatures for both, use them. If color is very
            // different (cd > 55) this is a different person — hard reject.
            // If no color signature is available at all, don't penalise — rely on
            // position + size instead (happens in low-light / first detection).
            let colorSim = 0.5; // neutral default when no color data
            let hasColorData = false;
            if (det.colorSignature && d.colorSignature) {
              const cd = Math.hypot(
                det.colorSignature[0] - d.colorSignature[0],
                det.colorSignature[1] - d.colorSignature[1],
                det.colorSignature[2] - d.colorSignature[2]
              );
              if (cd > 55) continue; // Hard reject: clearly different person
              colorSim = Math.max(0, 1.0 - (cd / 110));
              hasColorData = true;
            }

            // ── Size and aspect ratio similarity ──────────────────────────────────
            const dormArea = d.width * d.height;
            const dormAspect = d.width / Math.max(1, d.height);
            const areaSim = Math.min(detArea, dormArea) / Math.max(detArea, dormArea || 1);
            const aspectSim = Math.min(detAspect, dormAspect) / Math.max(detAspect, dormAspect || 1);

            // ── Position proximity ───────────────────────────────────────────────
            // Use velocity-projected position: where would the track be NOW if it
            // kept moving at its last known velocity? This handles someone who was
            // occluded while walking — they reappear a few frames ahead.
            const projDt = Math.min(timeAwaySec, 1.5); // cap projection to 1.5s
            const projCx = (d.x + d.width / 2) + (d.vx || 0) * projDt;
            const projCy = (d.y + d.height / 2) + (d.vy || 0) * projDt;
            const dist = Math.hypot(detCx - projCx, detCy - projCy);

            // Normalise distance against average person width (not frame diagonal)
            // so the proximity score is meaningful regardless of camera FOV.
            const personRef = Math.max(d.width, d.height, 60);
            const normDist = dist / personRef;
            // posProximity = 1.0 when centres overlap, 0.0 when >2 person-widths apart
            const posProximity = Math.max(0, 1.0 - normDist / 2.0);

            const recencyFactor = Math.max(0, 1.0 - (timeAwaySec / (this.reentryMemoryMs / 1000)));

            // ── Composite re-entry score ──────────────────────────────────────────
            // Weights: color (if available) > position > size > recency
            let score;
            if (hasColorData) {
              score = (colorSim * 0.40) + (posProximity * 0.30) + (areaSim * 0.15) + (aspectSim * 0.10) + (recencyFactor * 0.05);
            } else {
              // No clothing data: lean more on position + size
              score = (posProximity * 0.50) + (areaSim * 0.25) + (aspectSim * 0.15) + (recencyFactor * 0.10);
            }

            // Threshold lowered 0.48 → 0.30 so occluded persons reappearing near
            // their last known position always reclaim their ID.
            if (score > bestDormantScore && score >= 0.30) {
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
            // Seamless dwell timer continuation from accumulated past dwell time
            resurrected.firstSeenWallClock = wallClockNow - (resurrected.accumulatedDwellMs || 0);

            if (det.colorSignature) {
              resurrected.colorSignature = det.colorSignature;
            }

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
            colorSignature: det.colorSignature || null,
            accumulatedDwellMs: 0
          };
          this.tracks.push(newTrack);
        }
      }

      // Track-to-Track Deduplication: Ensure strictly ONE track per physical human
      for (let i = 0; i < this.tracks.length; i++) {
        for (let j = this.tracks.length - 1; j > i; j--) {
          const t1 = this.tracks[i];
          const t2 = this.tracks[j];
          const trIoU = getIoU(
            { x: t1.x, y: t1.y, w: t1.width, h: t1.height },
            { x: t2.x, y: t2.y, w: t2.width, h: t2.height }
          );
          const trInter = getInterArea(
            { x: t1.x, y: t1.y, w: t1.width, h: t1.height },
            { x: t2.x, y: t2.y, w: t2.width, h: t2.height }
          );
          const minArea = Math.min(t1.width * t1.height, t2.width * t2.height);
          const ioMin = minArea > 0 ? trInter / minArea : 0;
          const t1Cx = t1.x + t1.width / 2;
          const t1Cy = t1.y + t1.height / 2;
          const t2Cx = t2.x + t2.width / 2;
          const t2Cy = t2.y + t2.height / 2;
          const dist = Math.hypot(t1Cx - t2Cx, t1Cy - t2Cy);
          const refDim = Math.min(Math.max(t1.width, t1.height), Math.max(t2.width, t2.height), 120);

          if (trIoU > 0.22 || ioMin > 0.45 || (dist / refDim) < 0.45) {
            // Keep the more established track
            if ((t2.totalDetections || 0) > (t1.totalDetections || 0) && t2.misses <= t1.misses) {
              this.tracks[i] = t2;
            }
            this.tracks.splice(j, 1);
          }
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

        // Check if track is at the camera boundary (exiting range)
        const isAtBoundary = (
          t.x <= borderMarginX ||
          t.y <= borderMarginY ||
          (t.x + t.width) >= (frameW - borderMarginX) ||
          (t.y + t.height) >= (frameH - borderMarginY)
        );

        // Generous interior grace (6.5s) keeps counter ticking steady; boundary exit retires after 1.5s
        const allowedGrace = isAtBoundary ? this.exitGraceMs : this.interiorGraceMs;

        if (elapsedSinceSeen > allowedGrace) {
          // Human departed or out of camera range -> Save to 20s Re-Entry Memory!
          t.departedTime = now;
          t.departedWallClock = wallClockNow;
          t.accumulatedDwellMs = (t.accumulatedDwellMs || 0) + (wallClockNow - t.firstSeenWallClock);
          t.exitBbox = { x: t.x, y: t.y, w: t.width, h: t.height };
          t.isAtBoundary = isAtBoundary;
          
          // Replace any older entry with same id
          this.dormantTracks = this.dormantTracks.filter(d => d.id !== t.id);
          this.dormantTracks.push(t);

          this.tracks.splice(i, 1);
          continue;
        }

        // Forward project walking track if temporarily occluded
        if (!isMatched && t.motionState === 'WALKING' && t.misses < 12) {
          t.x += t.vx * 0.03;
          t.y += t.vy * 0.03;
        }

        // Live continuous dwell timer
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

  const humanTracker = new AdvancedHumanTracker();

  let scanFrameCount = 0;

  // Multi-Scale Human Scanner — Accurate people counter for retail / office scenes
  // Strategy: raise score floor high enough to reject chairs/shadows, validate box
  // geometry, then two-stage dedup: IoU-based + center-proximity for cross-pass doubles.
  async function scanHumansMultiScale(arg1, arg2, arg3, arg4, arg5) {
    let aiW, aiH, sW, sH, confidenceThreshold;
    if (arg4 !== undefined && arg5 !== undefined) {
      aiW = arg1; aiH = arg2; sW = arg3; sH = arg4; confidenceThreshold = arg5;
    } else {
      sW = arg1; sH = arg2; confidenceThreshold = arg3;
      aiW = aiBufferCanvas.width || sW;
      aiH = aiBufferCanvas.height || sH;
    }

    scanFrameCount++;

    // ─── Score floor: fixed at 0.38 regardless of the user slider ───────────────────
    // The slider (confidenceThreshold) used to bleed into this value, causing
    // slider > 38% to raise the floor above 0.38 and miss real people.
    // Now: model always runs at 0.38. The slider only affects track retention
    // downstream (how long an unmatched track survives before being retired).
    const scanScoreFloor = 0.38;

    const scaleX = sW / (aiW || sW || 1);
    const scaleY = sH / (aiH || sH || 1);
    const canvasIsReady = (c) => c && c.width > 0 && c.height > 0;

    // ─── Geometry validator — reject detections that cannot be a full person ───
    // A real standing/seated person bbox must be:
    //   • Height >= 7% of frame (min ~50px on 720p) — filters tiny fragments
    //   • Height >= Width (portrait orientation) — a person is taller than wide
    //   • Area >= 0.4% of frame — filters hairline slivers
    const minHeightFrac = 0.07;   // 7% of source frame height
    const frameArea = sW * sH;
    function isValidPersonBox(bx, by, bw, bh) {
      if (bh < sH * minHeightFrac) return false;        // Too short
      if (bw > bh * 2.2) return false;                  // Way wider than tall (not a person)
      if ((bw * bh) < frameArea * 0.004) return false;  // Too tiny overall
      return true;
    }

    // ─── Pass 1: Full-frame scan (YOLOv8 Deep AI or Browser MobileNet) ───
    let raw = [];
    if (canvasIsReady(aiBufferCanvas)) {
      let yoloSucceeded = false;

      // 1. High-Precision YOLOv8 + OpenCV Microservice Scan
      if (aiEngineMode === 'yolo') {
        try {
          const frameJpeg = aiBufferCanvas.toDataURL('image/jpeg', 0.80);
          const yoloRes = await fetch('/api/vision/yolo/detect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: frameJpeg, conf: scanScoreFloor, iou: 0.45 })
          });
          if (yoloRes.ok) {
            const data = await yoloRes.json();
            if (data.success && Array.isArray(data.detections)) {
              data.detections.forEach(det => {
                const bx = det.bbox[0] * scaleX;
                const by = det.bbox[1] * scaleY;
                const bw = det.bbox[2] * scaleX;
                const bh = det.bbox[3] * scaleY;
                if (isValidPersonBox(bx, by, bw, bh)) {
                  raw.push({ bbox: [bx, by, bw, bh], aiBbox: det.bbox, score: det.score, source: 'yolov8' });
                }
              });
              yoloSucceeded = true;
            }
          }
        } catch (_yoloErr) {
          // Gracefully fall through to browser MobileNet
        }
      }

      // 2. Browser MobileNetV2 Scan (used if selected or as automatic fallback)
      if (!yoloSucceeded && humanModel) {
        try {
          const preds = await humanModel.detect(aiBufferCanvas, 20, scanScoreFloor);
          (preds || []).forEach(p => {
            if (p.class.toLowerCase() !== 'person') return;
            const bx = p.bbox[0] * scaleX, by = p.bbox[1] * scaleY;
            const bw = p.bbox[2] * scaleX, bh = p.bbox[3] * scaleY;
            if (isValidPersonBox(bx, by, bw, bh)) {
              raw.push({ bbox: [bx, by, bw, bh], aiBbox: p.bbox, score: p.score, source: 'mobilenet' });
            }
          });
        } catch (_e) { return []; }
      }
    } else { return []; }

    return applyNms(raw, scanScoreFloor);
  }

  // Multi-Criteria NMS: IoU + Containment (IoMin) + Center Proximity
  function applyNms(boxes, threshold) {
    if (!boxes || boxes.length === 0) return [];

    // Sort highest confidence first
    boxes.sort((a, b) => b.score - a.score);

    function iou(b1, b2) {
      const x1 = Math.max(b1[0], b2[0]);
      const y1 = Math.max(b1[1], b2[1]);
      const x2 = Math.min(b1[0] + b1[2], b2[0] + b2[2]);
      const y2 = Math.min(b1[1] + b1[3], b2[1] + b2[3]);
      const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
      const union = (b1[2] * b1[3]) + (b2[2] * b2[3]) - inter;
      return union > 0 ? inter / union : 0;
    }

    function ioMin(b1, b2) {
      const x1 = Math.max(b1[0], b2[0]);
      const y1 = Math.max(b1[1], b2[1]);
      const x2 = Math.min(b1[0] + b1[2], b2[0] + b2[2]);
      const y2 = Math.min(b1[1] + b1[3], b2[1] + b2[3]);
      const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
      const minArea = Math.min(b1[2] * b1[3], b2[2] * b2[3]);
      return minArea > 0 ? inter / minArea : 0;
    }

    const results = [];
    for (const item of boxes) {
      if (item.score < threshold) continue;
      let dup = false;
      const [ix, iy, iw, ih] = item.bbox;
      const icx = ix + iw / 2;
      const icy = iy + ih / 2;

      for (const kept of results) {
        const [kx, ky, kw, kh] = kept.bbox;
        const kcx = kx + kw / 2;
        const kcy = ky + kh / 2;

        const iouVal = iou(item.bbox, kept.bbox);
        const ioMinVal = ioMin(item.bbox, kept.bbox);
        const dist = Math.hypot(icx - kcx, icy - kcy);
        const refDim = Math.min(Math.max(iw, ih), Math.max(kw, kh));

        // Duplicate person if:
        // 1. Moderate/High IoU overlap (>0.32)
        // 2. High Containment (>0.45, e.g. torso inside full body or overlapping boxes on same seated person)
        // 3. Close centers (<0.40 of person dimension)
        if (iouVal > 0.32 || ioMinVal > 0.45 || (dist / refDim) < 0.40) {
          dup = true;
          break;
        }
      }
      if (!dup) results.push(item);
    }

    return results;
  }

  // Fast torso color extractor to maintain identity consistency across exits/re-entries
  function extractTorsoColor(ctx, bbox, frameW, frameH) {
    if (!ctx || !bbox) return null;
    const [x, y, w, h] = bbox;
    const sx = Math.round(Math.max(0, Math.min(frameW - 2, x + w * 0.25)));
    const sy = Math.round(Math.max(0, Math.min(frameH - 2, y + h * 0.25)));
    const sw = Math.max(2, Math.min(frameW - sx, Math.round(w * 0.50)));
    const sh = Math.max(2, Math.min(frameH - sy, Math.round(h * 0.35)));
    try {
      const imgData = ctx.getImageData(sx, sy, sw, sh);
      const data = imgData.data;
      let r = 0, g = 0, b = 0, cnt = 0;
      const step = Math.max(1, Math.floor((sw * sh) / 100)); // Sample ~100 points maximum for blazing speed
      for (let i = 0; i < data.length; i += step * 4) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        cnt++;
      }
      return cnt > 0 ? [Math.round(r / cnt), Math.round(g / cnt), Math.round(b / cnt)] : null;
    } catch (e) {
      return null;
    }
  }

  // Coordinate mapping for letterboxed object-fit: contain video
  function getRenderTransformation(sourceWidth, sourceHeight, canvasEl) {
    const sWidth = sourceWidth || canvasEl.width;
    const sHeight = sourceHeight || canvasEl.height;
    const cWidth = canvasEl.width;
    const cHeight = canvasEl.height;

    if (!sWidth || !sHeight || !cWidth || !cHeight) {
      return { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };
    }

    const sourceRatio = sWidth / sHeight;
    const canvasRatio = cWidth / cHeight;

    let renderW, renderH, offsetX, offsetY;

    if (currentFitMode === 'cover') {
      // In cover mode (Fill), video fills canvas and excess is cropped
      if (canvasRatio > sourceRatio) {
        renderW = cWidth;
        renderH = cWidth / sourceRatio;
        offsetX = 0;
        offsetY = (cHeight - renderH) / 2;
      } else {
        renderH = cHeight;
        renderW = cHeight * sourceRatio;
        offsetX = (cWidth - renderW) / 2;
        offsetY = 0;
      }
    } else {
      // In contain mode (Fit), video is letterboxed/pillarboxed
      if (canvasRatio > sourceRatio) {
        renderH = cHeight;
        renderW = cHeight * sourceRatio;
        offsetX = (cWidth - renderW) / 2;
        offsetY = 0;
      } else {
        renderW = cWidth;
        renderH = cWidth / sourceRatio;
        offsetX = 0;
        offsetY = (cHeight - renderH) / 2;
      }
    }

    return {
      offsetX,
      offsetY,
      renderW,
      renderH,
      scaleX: renderW / sWidth,
      scaleY: renderH / sHeight
    };
  }

  // Draw futuristic neon bounding box with Role State, Global ID, Dwell Timer, and Motion State
  function drawHumanTargetBox(ctx, x, y, width, height, human) {
    const role = human.roleType || 'UNKNOWN';
    let themeColor = '#00ff88'; // Default neon green
    let tintColor = 'rgba(0, 255, 136, 0.08)';

    if (role === 'STAFF') {
      themeColor = '#00ff88'; // Green for Verified Staff
      tintColor = 'rgba(0, 255, 136, 0.12)';
    } else if (role === 'CUSTOMER') {
      themeColor = '#38bdf8'; // Sky Blue for Customers
      tintColor = 'rgba(56, 189, 248, 0.09)';
    } else if (role === 'VISITOR') {
      themeColor = '#c084fc'; // Purple for Visitors
      tintColor = 'rgba(192, 132, 252, 0.09)';
    } else if (role === 'DELIVERY') {
      themeColor = '#fb923c'; // Orange for Delivery
      tintColor = 'rgba(251, 146, 60, 0.09)';
    } else if (role === 'SECURITY') {
      themeColor = '#f87171'; // Red for Security
      tintColor = 'rgba(248, 113, 113, 0.12)';
    } else {
      themeColor = '#facc15'; // Amber/Yellow for UNKNOWN
      tintColor = 'rgba(250, 204, 21, 0.09)';
    }

    if (human.isRecognized) {
      themeColor = '#38bdf8'; // Electric Cyan for Recognized Returning Human
      tintColor = 'rgba(56, 189, 248, 0.16)';
    }

    ctx.save();

    // 1. Semi-transparent body highlight fill
    ctx.fillStyle = tintColor;
    ctx.fillRect(x, y, width, height);

    // 2. Glowing box boundary
    ctx.shadowColor = themeColor;
    ctx.shadowBlur = human.isRecognized ? 16 : 10;
    ctx.strokeStyle = themeColor;
    ctx.lineWidth = human.isRecognized ? 2.8 : 2.4;
    ctx.strokeRect(x, y, width, height);

    // 3. Cybernetic targeting corner brackets (4 corners)
    const bracketLen = Math.max(10, Math.min(26, width * 0.20, height * 0.20));
    ctx.lineWidth = 3.8;
    ctx.shadowBlur = 14;

    // Top-Left corner
    ctx.beginPath();
    ctx.moveTo(x, y + bracketLen); ctx.lineTo(x, y); ctx.lineTo(x + bracketLen, y);
    // Top-Right corner
    ctx.moveTo(x + width - bracketLen, y); ctx.lineTo(x + width, y); ctx.lineTo(x + width, y + bracketLen);
    // Bottom-Left corner
    ctx.moveTo(x, y + height - bracketLen); ctx.lineTo(x, y + height); ctx.lineTo(x + bracketLen, y + height);
    // Bottom-Right corner
    ctx.moveTo(x + width - bracketLen, y + height); ctx.lineTo(x + width, y + height); ctx.lineTo(x + width, y + height - bracketLen);
    ctx.stroke();

    // 4. Center Targeting Reticle
    const cx = x + width / 2;
    const cy = y + height / 2;
    const reticleSize = 7;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - reticleSize, cy); ctx.lineTo(cx + reticleSize, cy);
    ctx.moveTo(cx, cy - reticleSize); ctx.lineTo(cx, cy + reticleSize);
    ctx.stroke();

    // 5. Header HUD Pill Badges (Role / Staff Identity + Live Dwell Timer)
    const confPercent = Math.round((human.matchScore || human.roleConfidence || human.score) * 100);
    const roleLabel = human.assignedRole || 'UNKNOWN';
    const localIdStr = `HUMAN #${human.id}`;
    const gid = human.globalTrackId ? `${human.globalTrackId} (${localIdStr})` : localIdStr;
    const namePrefix = human.personName ? `[${human.personName}] ` : '';
    const visitSuffix = (human.visitCount && human.visitCount > 1) ? ` // V#${human.visitCount}` : '';
    const idText = `${namePrefix}${gid} // ${roleLabel} [${confPercent}%]${visitSuffix}`;
    const timerText = `⏱️ ${human.dwellFormatted}`;

    ctx.font = 'bold 11px "Courier New", monospace';
    const idWidth = ctx.measureText(idText).width + 18;
    const timerWidth = ctx.measureText(timerText).width + 14;
    const badgeHeight = 22;
    const badgeY = Math.max(0, y - badgeHeight - 3);

    // Badge 1: Role, Staff Identity & Confidence Pill
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(10, 14, 20, 0.94)';
    ctx.fillRect(x, badgeY, idWidth, badgeHeight);
    ctx.strokeStyle = themeColor;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, badgeY, idWidth, badgeHeight);

    // Status dot
    ctx.fillStyle = themeColor;
    ctx.beginPath();
    ctx.arc(x + 8, badgeY + badgeHeight / 2, 3.5, 0, Math.PI * 2);
    ctx.fill();

    // ID Text
    ctx.fillStyle = themeColor;
    ctx.fillText(idText, x + 16, badgeY + 15);

    // Badge 2: Dwell Timer on the Box
    const timerX = x + idWidth + 4;
    ctx.fillStyle = 'rgba(10, 14, 20, 0.94)';
    ctx.fillRect(timerX, badgeY, timerWidth, badgeHeight);
    ctx.strokeStyle = themeColor;
    ctx.lineWidth = 1.2;
    ctx.strokeRect(timerX, badgeY, timerWidth, badgeHeight);

    // Dwell Time text
    ctx.fillStyle = '#ffffff';
    ctx.fillText(timerText, timerX + 7, badgeY + 15);

    // 6. Bottom Coordinates & Motion State Tag
    const motionStr = human.motionState === 'WALKING'
      ? `WALKING ${human.direction}`
      : 'STEADY';
    const recTag = human.isRecognized ? 'RE-ID MATCHED // ' : '';
    const subText = `${recTag}[#${human.id}] ${motionStr} // [${Math.round(x)},${Math.round(y)}]`;

    ctx.font = '9px "Courier New", monospace';
    ctx.fillStyle = themeColor;
    ctx.fillText(subText, x + 4, y + height - 6);

    ctx.restore();
  }

  // Load COCO-SSD Human Model (Local offline model with CDN fallback)
  async function loadHumanModel() {
    if (humanModel) return humanModel;
    if (humanModelLoading) return null;
    humanModelLoading = true;
    updateBotUIState('loading');

    try {
      if (typeof cocoSsd !== 'undefined') {
        console.log('Loading local COCO-SSD Human Bot AI model...');
        humanModel = await cocoSsd.load({
          modelUrl: '/models/mobilenet_v2/model.json'
        });
        console.log('Local Human Bot AI model loaded successfully!');
      }
    } catch (err) {
      console.warn('Local model weights load failed, trying default/CDN fallback:', err);
      try {
        humanModel = await cocoSsd.load();
        console.log('Default COCO-SSD Human Bot AI model loaded successfully!');
      } catch (fallbackErr) {
        console.error('Failed to load human detection model:', fallbackErr);
        alert('Could not initialize Human Bot AI model: ' + fallbackErr.message);
        humanModelLoading = false;
        updateBotUIState('error');
        return null;
      }
    }

    humanModelLoading = false;
    updateBotUIState(humanBotActive ? 'active' : 'ready');
    return humanModel;
  }

  function updateBotUIState(state) {
    if (!btnHumanBotToggle) return;
    if (state === 'loading') {
      btnHumanBotToggle.classList.remove('btn-active');
      humanBotBtnText.textContent = 'Loading AI...';
      btnHumanBotToggle.disabled = true;
      if (telemetryBotStatus) {
        telemetryBotStatus.textContent = 'LOADING...';
        telemetryBotStatus.style.color = 'var(--accent-amber)';
      }
      if (osdHumanBot) osdHumanBot.textContent = '🤖 BOT: LOADING...';
    } else if (state === 'active') {
      btnHumanBotToggle.classList.add('btn-active');
      humanBotBtnText.textContent = 'Human Bot: ON';
      btnHumanBotToggle.disabled = false;
      if (telemetryBotStatus) {
        telemetryBotStatus.textContent = 'ACTIVE (SCANNING)';
        telemetryBotStatus.style.color = 'var(--accent-green)';
      }
      if (botTelemetryDot) botTelemetryDot.classList.add('active');
      if (osdHumanBot) {
        osdHumanBot.textContent = '🤖 BOT: ACTIVE';
        osdHumanBot.style.color = 'var(--accent-green)';
      }
    } else if (state === 'ready' || state === 'off') {
      btnHumanBotToggle.classList.remove('btn-active');
      humanBotBtnText.textContent = 'Human Bot';
      btnHumanBotToggle.disabled = false;
      if (telemetryBotStatus) {
        telemetryBotStatus.textContent = humanModel ? 'READY (OFF)' : 'OFF';
        telemetryBotStatus.style.color = 'var(--accent-green)';
      }
      if (botTelemetryDot) botTelemetryDot.classList.remove('active');
      if (osdHumanBot) {
        osdHumanBot.textContent = '🤖 BOT: OFF';
        osdHumanBot.style.color = '';
      }
      clearHumanCanvas();
    } else if (state === 'error') {
      btnHumanBotToggle.classList.remove('btn-active');
      humanBotBtnText.textContent = 'Bot Error';
      btnHumanBotToggle.disabled = false;
      if (telemetryBotStatus) {
        telemetryBotStatus.textContent = 'ERROR';
        telemetryBotStatus.style.color = 'var(--accent-red)';
      }
      if (botTelemetryDot) botTelemetryDot.classList.remove('active');
      if (osdHumanBot) osdHumanBot.textContent = '🤖 BOT: ERROR';
    }
  }

  function clearHumanCanvas() {
    if (!motionCanvas) return;
    const ctx = motionCanvas.getContext('2d');
    ctx.clearRect(0, 0, motionCanvas.width, motionCanvas.height);
    if (humanCountMeter) humanCountMeter.textContent = '0';
    if (telemetryHumanCount) telemetryHumanCount.textContent = '0';
    if (humanTracker) humanTracker.clear();
  }

  // Real-time Decoupled Detection & 60 FPS Sticky HUD Rendering Architecture
  let isInferring = false;
  let inferenceTimeoutId = null;

  // 60 FPS Buttery-Smooth HUD Rendering Loop (Eliminates Jitter & Screen Freezes)
  function renderHumanHUDLoop() {
    if (!humanBotActive) return;

    // Sync motionCanvas dimensions with monitorWrapper
    const rect = monitorWrapper.getBoundingClientRect();
    if (motionCanvas.width !== Math.round(rect.width) || motionCanvas.height !== Math.round(rect.height)) {
      motionCanvas.width = Math.round(rect.width);
      motionCanvas.height = Math.round(rect.height);
    }

    const isVideoMode = remoteVideo.videoWidth > 0 && remoteVideo.style.display !== 'none';
    const sW = isVideoMode ? remoteVideo.videoWidth : (fallbackImgFeed?.naturalWidth || 1280);
    const sH = isVideoMode ? remoteVideo.videoHeight : (fallbackImgFeed?.naturalHeight || 720);

    const ctx = motionCanvas.getContext('2d');
    ctx.clearRect(0, 0, motionCanvas.width, motionCanvas.height);

    const wallClockNow = Date.now();
    const liveTracks = humanTracker.getLiveTracks(wallClockNow);
    const currentCount = liveTracks.length;

    if (humanCountMeter) humanCountMeter.textContent = String(currentCount);
    if (telemetryHumanCount) telemetryHumanCount.textContent = String(currentCount);
    if (telemetryTotalTracked) telemetryTotalTracked.textContent = String(humanTracker.totalUniqueCount);

    if (osdHumanBot) {
      osdHumanBot.textContent = currentCount > 0 
        ? `🤖 BOT: ${currentCount} IN VIEW [${humanTracker.totalUniqueCount} TOTAL]` 
        : '🤖 BOT: ACTIVE (SCANNING)';
    }

    if (sW > 0 && sH > 0 && currentCount > 0) {
      const transform = getRenderTransformation(sW, sH, motionCanvas);

      // Render glowing green target boxes with unique numbers and continuous live dwell timers
      liveTracks.forEach((human) => {
        const bx = transform.offsetX + (human.x * transform.scaleX);
        const by = transform.offsetY + (human.y * transform.scaleY);
        const bw = human.width * transform.scaleX;
        const bh = human.height * transform.scaleY;

        drawHumanTargetBox(ctx, bx, by, bw, bh, human);
      });
    }

    if (humanBotActive) {
      humanDetectionAnimId = requestAnimationFrame(renderHumanHUDLoop);
    }
  }

  // Background Neural Inference Loop (Runs asynchronously without blocking UI rendering)
  async function triggerNextInference() {
    if (!humanBotActive) return;

    if (isInferring || !humanModel) {
      inferenceTimeoutId = setTimeout(triggerNextInference, 40);
      return;
    }

    const isVideoMode = remoteVideo.videoWidth > 0 && remoteVideo.style.display !== 'none';
    const sourceEl = isVideoMode ? remoteVideo : fallbackImgFeed;

    if (!sourceEl || (isVideoMode && remoteVideo.readyState < 2) || (!isVideoMode && (!fallbackImgFeed?.complete || !fallbackImgFeed?.naturalWidth))) {
      inferenceTimeoutId = setTimeout(triggerNextInference, 50);
      return;
    }

    isInferring = true;
    const now = performance.now();
    const wallClockNow = Date.now();

    try {
      const sW = isVideoMode ? remoteVideo.videoWidth : fallbackImgFeed.naturalWidth;
      const sH = isVideoMode ? remoteVideo.videoHeight : fallbackImgFeed.naturalHeight;

      if (sW > 0 && sH > 0) {
        // High-speed downscaled AI resolution (Capped at 640px to eliminate WebGL transfer lag)
        const maxAiDim = 640;
        let aiW = sW;
        let aiH = sH;
        if (sW > maxAiDim || sH > maxAiDim) {
          if (sW >= sH) {
            aiW = maxAiDim;
            aiH = Math.round((sH / sW) * maxAiDim);
          } else {
            aiH = maxAiDim;
            aiW = Math.round((sW / sH) * maxAiDim);
          }
        }

        if (aiBufferCanvas.width !== aiW || aiBufferCanvas.height !== aiH) {
          aiBufferCanvas.width = aiW;
          aiBufferCanvas.height = aiH;
        }
        aiBufferCtx.drawImage(sourceEl, 0, 0, aiW, aiH);

        // Execute multi-scale scan for both close & distant humans
        const instantHumans = await scanHumansMultiScale(aiW, aiH, sW, sH, humanDetectionConfidence);

        // Attach lightweight torso color signatures for re-entry recognition
        if (instantHumans && instantHumans.length > 0) {
          instantHumans.forEach(h => {
            const aiBox = h.aiBbox || [h.bbox[0] * (aiW / sW), h.bbox[1] * (aiH / sH), h.bbox[2] * (aiW / sW), h.bbox[3] * (aiH / sH)];
            h.colorSignature = extractTorsoColor(aiBufferCtx, aiBox, aiW, aiH);
          });
        }

        // Update advanced sticky tracker with 20s re-entry memory and boundary exit detection
        const activeTracks = humanTracker.update(instantHumans, now, wallClockNow, sW, sH);

        // Run multi-modal Staff / Customer / Visitor recognition pipeline on active tracks
        processTracksRecognition(activeTracks, sW, sH, wallClockNow);
      }
    } catch (err) {
      // Transient frame error
    } finally {
      isInferring = false;
      if (humanBotActive) {
        inferenceTimeoutId = setTimeout(triggerNextInference, 35);
      }
    }
  }

  function runHumanDetectionCycle() {
    if (humanDetectionAnimId) cancelAnimationFrame(humanDetectionAnimId);
    if (inferenceTimeoutId) clearTimeout(inferenceTimeoutId);
    renderHumanHUDLoop();
    triggerNextInference();
  }

  // Automatic HD Snapshot on Human Detection with burned Green Target Boxes, Unique IDs and Dwell Timers
  function captureHumanSnapshot(trackedHumans, sW, sH) {
    const width = sW || 1280;
    const height = sH || 720;

    const snapCanvas = document.createElement('canvas');
    snapCanvas.width = width;
    snapCanvas.height = height;
    const ctx = snapCanvas.getContext('2d');

    try {
      ctx.drawImage(aiBufferCanvas, 0, 0, width, height);
    } catch (e) {
      return;
    }

    // Burn green bounding boxes on the snapshot frame
    trackedHumans.forEach((human) => {
      drawHumanTargetBox(ctx, human.x, human.y, human.width, human.height, human);
    });

    // Burn CCTV watermark
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(16, height - 52, 580, 38);
    ctx.fillStyle = '#00ff88';
    ctx.font = 'bold 15px monospace';
    ctx.fillText(`CEOVA CCTV // 🤖 HUMAN BOT [${trackedHumans.length} IN VIEW, ${humanTracker.totalUniqueCount} TOTAL] // ${osdTimestamp.textContent}`, 26, height - 26);

    const dataUrl = snapCanvas.toDataURL('image/png');
    addLogEvent(
      'human',
      `👤 Human Locked: #${trackedHumans[0]?.id || 1} (${trackedHumans.length} in view)`,
      `Dwell: ${trackedHumans[0]?.dwellFormatted || '00:00'} • ${trackedHumans[0]?.motionState || 'STEADY'}`,
      dataUrl
    );
  }

  // Human Bot Toggle Button
  if (btnHumanBotToggle) {
    btnHumanBotToggle.addEventListener('click', async () => {
      humanBotActive = !humanBotActive;
      if (humanBotActive) {
        if (aiEngineMode === 'yolo') {
          // Instant start via server YOLOv8
          updateBotUIState('active');
          runHumanDetectionCycle();
          // Pre-load MobileNet in background for seamless offline fallback
          loadHumanModel().catch(() => {});
        } else {
          // Client-side MobileNetV2
          const model = await loadHumanModel();
          if (model) {
            updateBotUIState('active');
            runHumanDetectionCycle();
          } else {
            humanBotActive = false;
            updateBotUIState('off');
          }
        }
      } else {
        if (humanDetectionAnimId) {
          cancelAnimationFrame(humanDetectionAnimId);
          humanDetectionAnimId = null;
        }
        if (inferenceTimeoutId) {
          clearTimeout(inferenceTimeoutId);
          inferenceTimeoutId = null;
        }
        clearHumanCanvas();
        updateBotUIState('off');
      }
    });
  }

  // AI Detection Engine Mode Switcher (YOLOv8 vs MobileNetV2)
  function updateAiEngineUI() {
    if (!btnAiEngineToggle || !aiEngineBtnText) return;
    if (aiEngineMode === 'yolo') {
      btnAiEngineToggle.classList.add('active-yolo');
      aiEngineBtnText.innerHTML = '🚀 YOLOv8 AI';
      btnAiEngineToggle.title = 'Current Engine: YOLOv8 Deep AI (Server GPU/MPS) — Click to switch to MobileNetV2';
    } else {
      btnAiEngineToggle.classList.remove('active-yolo');
      aiEngineBtnText.innerHTML = '⚡ MobileNet AI';
      btnAiEngineToggle.title = 'Current Engine: MobileNetV2 (Browser Local) — Click to switch to YOLOv8';
    }
  }

  if (btnAiEngineToggle) {
    btnAiEngineToggle.addEventListener('click', () => {
      aiEngineMode = aiEngineMode === 'yolo' ? 'mobilenet' : 'yolo';
      updateAiEngineUI();
      console.log('[AI_ENGINE] Mode switched to:', aiEngineMode);
    });
    updateAiEngineUI();
  }

  // Bot Confidence Slider Listener
  if (botConfidence) {
    botConfidence.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      humanDetectionConfidence = val / 100;
      if (confidenceValText) confidenceValText.textContent = `${val}%`;
    });
  }

  // 14. Incident & Capture Log Management
  function addLogEvent(type, title, description, thumbnailDataUrl = null, videoUrl = null) {
    emptyLogState.style.display = 'none';
    incidentCounter++;
    logCount.textContent = String(incidentCounter);

    const now = new Date();
    const timeStr = now.toLocaleTimeString();

    const item = document.createElement('div');
    item.className = 'event-item';

    let thumbHtml = '';
    if (thumbnailDataUrl) {
      thumbHtml = `<img src="${thumbnailDataUrl}" class="event-thumb" alt="thumb" title="Click to view full image" />`;
    } else {
      thumbHtml = `<div class="event-thumb" style="display:flex;align-items:center;justify-content:center;color:#666;">🎥</div>`;
    }

    item.innerHTML = `
      ${thumbHtml}
      <div class="event-details">
        <span class="event-type ${type === 'motion' ? 'motion' : (type === 'human' ? 'human' : '')}">${title}</span>
        <span class="event-time">${timeStr} • ${description}</span>
      </div>
    `;

    // Click to view thumbnail
    if (thumbnailDataUrl) {
      const imgEl = item.querySelector('.event-thumb');
      imgEl.onclick = () => {
        const win = window.open();
        win.document.write(`<img src="${thumbnailDataUrl}" style="max-width:100vw; background:#000;"/>`);
      };
    }

    eventsList.prepend(item);
  }

  // 15. Standby / Pair Dialog Toggle
  btnShowQr.addEventListener('click', () => {
    standbyOverlay.classList.toggle('hidden');
  });

  const btnCloseStandby = document.getElementById('btnCloseStandby');
  if (btnCloseStandby) {
    btnCloseStandby.addEventListener('click', (e) => {
      e.stopPropagation();
      standbyOverlay.classList.add('hidden');
    });
  }

  standbyOverlay.addEventListener('click', (e) => {
    if (e.target === standbyOverlay) {
      standbyOverlay.classList.add('hidden');
    }
  });

  // 16. Fullscreen Toggle
  btnFullscreen.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      monitorWrapper.requestFullscreen().catch(err => {
        alert(`Error attempting to enable full-screen mode: ${err.message}`);
      });
    } else {
      document.exitFullscreen();
    }
  });

  // 17. Aspect Ratio, Scaling & Rotation Controls
  let currentAspectMode = localStorage.getItem('ceova_aspect_mode') || 'auto'; // 'auto' | '16:9' | '9:16'
  let currentFitMode = localStorage.getItem('ceova_fit_mode') || 'contain';    // 'contain' (Fit) | 'cover' (Fill)
  let currentRotation = parseInt(localStorage.getItem('ceova_rotation') || '0', 10); // 0 | 90 | 180 | 270
  let lastAutoDetectedAspect = null;

  function syncCanvasDimensions() {
    if (!motionCanvas || !monitorWrapper) return;
    const rect = monitorWrapper.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const rw = Math.round(rect.width);
      const rh = Math.round(rect.height);
      if (motionCanvas.width !== rw || motionCanvas.height !== rh) {
        motionCanvas.width = rw;
        motionCanvas.height = rh;
      }
    }
  }

  function applyAspectMode(mode, save = true) {
    if (save) {
      currentAspectMode = mode;
      localStorage.setItem('ceova_aspect_mode', mode);
    }

    const isVideoMode = remoteVideo.videoWidth > 0 && remoteVideo.style.display !== 'none';
    const vW = isVideoMode ? remoteVideo.videoWidth : (fallbackImgFeed?.naturalWidth || 1280);
    const vH = isVideoMode ? remoteVideo.videoHeight : (fallbackImgFeed?.naturalHeight || 720);
    const isStreamPortrait = vH > vW;

    let targetRatio = mode;
    if (mode === 'auto') {
      targetRatio = isStreamPortrait ? '9:16' : '16:9';
      lastAutoDetectedAspect = targetRatio;
    }

    monitorWrapper.classList.remove('aspect-16-9', 'aspect-9-16');
    if (targetRatio === '9:16') {
      monitorWrapper.classList.add('aspect-9-16');
    } else {
      monitorWrapper.classList.add('aspect-16-9');
    }

    if (aspectBtnText) {
      if (currentAspectMode === 'auto') {
        aspectBtnText.textContent = `Aspect: Auto (${targetRatio})`;
      } else {
        aspectBtnText.textContent = `Aspect: ${currentAspectMode}`;
      }
    }

    if (osdAspectBadge) {
      osdAspectBadge.textContent = `📐 ${currentAspectMode === 'auto' ? 'AUTO ' : ''}${targetRatio}`;
    }

    // Sync canvas dimensions after layout transition
    syncCanvasDimensions();
    setTimeout(syncCanvasDimensions, 100);
    setTimeout(syncCanvasDimensions, 350);
  }

  function toggleAspectMode() {
    const modes = ['auto', '16:9', '9:16'];
    const nextIdx = (modes.indexOf(currentAspectMode) + 1) % modes.length;
    applyAspectMode(modes[nextIdx]);
  }

  function applyFitMode(mode, save = true) {
    currentFitMode = mode;
    if (save) localStorage.setItem('ceova_fit_mode', mode);

    if (currentFitMode === 'cover') {
      remoteVideo.classList.add('fit-cover');
      fallbackImgFeed.classList.add('fit-cover');
      if (fitBtnText) fitBtnText.textContent = 'Fill';
      btnFitToggle?.classList.add('btn-active');
    } else {
      remoteVideo.classList.remove('fit-cover');
      fallbackImgFeed.classList.remove('fit-cover');
      if (fitBtnText) fitBtnText.textContent = 'Fit';
      btnFitToggle?.classList.remove('btn-active');
    }
    syncCanvasDimensions();
  }

  function toggleFitMode() {
    applyFitMode(currentFitMode === 'contain' ? 'cover' : 'contain');
  }

  function applyRotation(deg, save = true) {
    currentRotation = deg % 360;
    if (save) localStorage.setItem('ceova_rotation', String(currentRotation));

    [remoteVideo, fallbackImgFeed].forEach(el => {
      el.classList.remove('rotate-90', 'rotate-180', 'rotate-270');
      if (currentRotation === 90) el.classList.add('rotate-90');
      else if (currentRotation === 180) el.classList.add('rotate-180');
      else if (currentRotation === 270) el.classList.add('rotate-270');
    });

    if (rotateBtnText) {
      rotateBtnText.textContent = `${currentRotation}°`;
    }
    if (btnRotateToggle) {
      btnRotateToggle.classList.toggle('btn-active', currentRotation !== 0);
    }
    syncCanvasDimensions();
  }

  function toggleRotation() {
    applyRotation((currentRotation + 90) % 360);
  }

  function handleVideoDimensionUpdate() {
    const vW = remoteVideo.videoWidth;
    const vH = remoteVideo.videoHeight;
    if (vW > 0 && vH > 0) {
      resMeter.textContent = `${vW} x ${vH}`;
      if (currentAspectMode === 'auto') {
        const streamRatio = vH > vW ? '9:16' : '16:9';
        if (lastAutoDetectedAspect !== streamRatio) {
          applyAspectMode('auto', false);
        }
      }
    }
  }

  if (btnAspectToggle) btnAspectToggle.addEventListener('click', toggleAspectMode);
  if (btnFitToggle) btnFitToggle.addEventListener('click', toggleFitMode);
  if (btnRotateToggle) btnRotateToggle.addEventListener('click', toggleRotation);

  remoteVideo.addEventListener('loadedmetadata', handleVideoDimensionUpdate);
  remoteVideo.addEventListener('resize', handleVideoDimensionUpdate);

  if (fallbackImgFeed) {
    fallbackImgFeed.addEventListener('load', () => {
      if (remoteVideo.style.display === 'none' || !remoteVideo.srcObject) {
        if (currentAspectMode === 'auto') {
          const streamRatio = fallbackImgFeed.naturalHeight > fallbackImgFeed.naturalWidth ? '9:16' : '16:9';
          if (lastAutoDetectedAspect !== streamRatio) {
            applyAspectMode('auto', false);
          }
        }
      }
    });
  }

  window.addEventListener('resize', () => {
    syncCanvasDimensions();
  });

  // ==========================================================================
  // STAFF / CUSTOMER / VISITOR RECOGNITION ENGINE & LIVE DASHBOARD HUD
  // ==========================================================================

  const recognitionCropCanvas = document.createElement('canvas');
  const recognitionCropCtx = recognitionCropCanvas.getContext('2d');
  let isRecognitionInferring = false;
  let lastRecognitionTime = 0;

  // UI Elements for Role Summary
  const summaryStaffCount = document.getElementById('summaryStaffCount');
  const summaryStaffMembers = document.getElementById('summaryStaffMembers');
  const summaryUnknownCount = document.getElementById('summaryUnknownCount');
  const summaryCustomerCount = document.getElementById('summaryCustomerCount');
  const summaryVisitorCount = document.getElementById('summaryVisitorCount');
  const summaryDeliveryCount = document.getElementById('summaryDeliveryCount');
  const summarySecurityCount = document.getElementById('summarySecurityCount');

  // UI Elements for Live People Table
  const livePeopleContainer = document.getElementById('livePeopleContainer');
  const emptyPeopleState = document.getElementById('emptyPeopleState');
  const livePeopleTable = document.getElementById('livePeopleTable');
  const livePeopleTbody = document.getElementById('livePeopleTbody');
  const livePeopleCountBadge = document.getElementById('livePeopleCountBadge');

  // UI Elements for Staff Admin Modal
  const btnOpenStaffModal = document.getElementById('btnOpenStaffModal');
  const btnCloseStaffModal = document.getElementById('btnCloseStaffModal');
  const staffModal = document.getElementById('staffModal');
  const tabBtnEnroll = document.getElementById('tabBtnEnroll');
  const tabBtnStaffList = document.getElementById('tabBtnStaffList');
  const tabBtnMemory = document.getElementById('tabBtnMemory');
  const tabBtnHardware = document.getElementById('tabBtnHardware');
  const paneEnroll = document.getElementById('paneEnroll');
  const paneStaffList = document.getElementById('paneStaffList');
  const paneMemory = document.getElementById('paneMemory');
  const paneHardware = document.getElementById('paneHardware');

  const formEnrollStaff = document.getElementById('formEnrollStaff');
  const btnEnrollCancel = document.getElementById('btnEnrollCancel');
  const enrollFeedback = document.getElementById('enrollFeedback');

  const cardFrontPhoto = document.getElementById('cardFrontPhoto');
  const fileFrontPhoto = document.getElementById('fileFrontPhoto');
  const prevFrontPhoto = document.getElementById('prevFrontPhoto');
  const phFrontPhoto = document.getElementById('phFrontPhoto');

  const cardSidePhoto = document.getElementById('cardSidePhoto');
  const fileSidePhoto = document.getElementById('fileSidePhoto');
  const prevSidePhoto = document.getElementById('prevSidePhoto');
  const phSidePhoto = document.getElementById('phSidePhoto');

  const cardBackPhoto = document.getElementById('cardBackPhoto');
  const fileBackPhoto = document.getElementById('fileBackPhoto');
  const prevBackPhoto = document.getElementById('prevBackPhoto');
  const phBackPhoto = document.getElementById('phBackPhoto');

  const checkEnableFace = document.getElementById('checkEnableFace');
  const tableStaffList = document.getElementById('tableStaffList');
  const tbodyStaffList = document.getElementById('tbodyStaffList');
  const staffListCountBadge = document.getElementById('staffListCountBadge');
  const btnRefreshStaffList = document.getElementById('btnRefreshStaffList');

  // Stored Base64 Photos for Enrollment
  let enrolledPhotos = {
    frontImage: null,
    sideImage: null,
    backImage: null
  };

  /**
   * Process active human tracks through server recognition pipeline
   */
  async function processTracksRecognition(activeTracks, sW, sH, wallClockNow) {
    if (isRecognitionInferring || !activeTracks || activeTracks.length === 0) return;
    if (wallClockNow - lastRecognitionTime < 700) return; // Throttle to conserve bandwidth & GPU

    // Find first track that needs recognition (new or not updated in > 1500ms)
    const candidate = activeTracks.find(t => (
      !t.lastRecognizedTime || (wallClockNow - t.lastRecognizedTime > 1500)
    ));

    if (!candidate) return;

    candidate.lastRecognizedTime = wallClockNow;
    lastRecognitionTime = wallClockNow;

    const cropW = Math.max(32, Math.min(sW, Math.round(candidate.width)));
    const cropH = Math.max(64, Math.min(sH, Math.round(candidate.height)));
    const cropX = Math.max(0, Math.min(sW - cropW, Math.round(candidate.x)));
    const cropY = Math.max(0, Math.min(sH - cropH, Math.round(candidate.y)));

    if (recognitionCropCanvas.width !== cropW || recognitionCropCanvas.height !== cropH) {
      recognitionCropCanvas.width = cropW;
      recognitionCropCanvas.height = cropH;
    }

    try {
      const sourceEl = isVideoMode ? remoteVideo : fallbackImgFeed;
      if (sourceEl) {
        recognitionCropCtx.drawImage(sourceEl, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
      } else {
        recognitionCropCtx.drawImage(aiBufferCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
      }
      const dataUrl = recognitionCropCanvas.toDataURL('image/jpeg', 0.85);

      isRecognitionInferring = true;
      const resp = await fetch('/api/vision/process-track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cameraId: activeRoomId || 'CAM-01',
          localTrackId: candidate.id,
          cropImage: dataUrl,
          bbox: [candidate.x, candidate.y, candidate.width, candidate.height],
          dwellMs: candidate.dwellMs || 0
        })
      });

      if (resp.ok) {
        const result = await resp.json();
        if (result.processed) {
          candidate.globalTrackId = result.globalTrackId;
          candidate.roleType = result.role;
          candidate.assignedRole = (result.role === 'STAFF' && result.staffId)
            ? `STAFF — ${result.staffId}`
            : result.role;
          candidate.roleConfidence = result.confidence;
          candidate.personName = result.name;
          candidate.isRecognized = Boolean(result.isRecognized);
          candidate.matchScore = result.matchScore;
          candidate.visitCount = result.visitCount;
          candidate.thumbnail = result.thumbnail || dataUrl;

          updateLivePeopleTableUI();
          updateRoleSummaryCounts();
        }
      }
    } catch (err) {
      // Ignore transient network errors
    } finally {
      isRecognitionInferring = false;
    }
  }

  /**
   * Handle real-time structured identity events from WebSocket
   */
  function handleLiveIdentityEvent(event) {
    if (!event) return;

    let icon = '👤';
    let title = event.event_type.toUpperCase().replace('_', ' ');

    if (event.role === 'STAFF') {
      icon = '💼';
      title = `STAFF RECOGNIZED: ${event.staff_id || 'STAFF'}`;
    } else if (event.role === 'SECURITY') {
      icon = '🛡️';
      title = `SECURITY ON DUTY: ${event.staff_id || 'GUARD'}`;
    } else if (event.role === 'CUSTOMER') {
      icon = '🛒';
      title = `CUSTOMER DETECTED [${event.global_track_id}]`;
    } else if (event.role === 'DELIVERY') {
      icon = '📦';
      title = `DELIVERY ARRIVAL [${event.camera_id}]`;
    } else if (event.role === 'UNKNOWN') {
      icon = '❓';
      title = `UNVERIFIED PERSON [${event.global_track_id}]`;
    }

    const confText = `Confidence: ${(event.confidence * 100).toFixed(0)}% • Cam: ${event.camera_id}`;
    addLogEvent('human', `${icon} ${title}`, confText);

    // Refresh live summary
    fetchLivePeopleSummary();
  }

  /**
   * Update Live People Table in the side panel
   */
  function updateLivePeopleTableUI() {
    if (!livePeopleTbody || !humanTracker) return;

    const liveTracks = humanTracker.getLiveTracks();
    if (!liveTracks || liveTracks.length === 0) {
      if (emptyPeopleState) emptyPeopleState.style.display = 'block';
      if (livePeopleTable) livePeopleTable.style.display = 'none';
      if (livePeopleCountBadge) livePeopleCountBadge.textContent = '0';
      return;
    }

    if (emptyPeopleState) emptyPeopleState.style.display = 'none';
    if (livePeopleTable) livePeopleTable.style.display = 'table';
    if (livePeopleCountBadge) livePeopleCountBadge.textContent = String(liveTracks.length);

    livePeopleTbody.innerHTML = '';

    liveTracks.forEach((t) => {
      const tr = document.createElement('tr');
      const role = t.roleType || 'UNKNOWN';
      const conf = Math.round((t.roleConfidence || t.score) * 100);
      const gid = t.globalTrackId || `T#${t.id}`;
      const roleText = t.assignedRole || 'UNKNOWN';

      let badgeClass = 'role-unknown';
      if (role === 'STAFF') badgeClass = 'role-staff';
      else if (role === 'CUSTOMER') badgeClass = 'role-customer';
      else if (role === 'VISITOR') badgeClass = 'role-visitor';
      else if (role === 'DELIVERY') badgeClass = 'role-delivery';
      else if (role === 'SECURITY') badgeClass = 'role-security';

      const thumbHtml = t.thumbnail
        ? `<img src="${t.thumbnail}" class="live-table-thumb" alt="Human" onerror="this.style.display='none'"/>`
        : `<div class="live-table-thumb-placeholder">👤</div>`;

      const personDisplay = t.personName
        ? `<strong style="color:var(--accent-cyan); font-size:0.82rem;">${t.personName}</strong><div style="font-size:0.68rem; color:#888;">${gid}</div>`
        : `<strong style="color:#fff; font-size:0.82rem;">${gid}</strong>`;

      const visitsCount = t.visitCount ? `V#${t.visitCount}` : 'V#1';

      tr.innerHTML = `
        <td style="width:42px; padding:4px 6px;">${thumbHtml}</td>
        <td>${personDisplay}</td>
        <td><span class="role-badge ${badgeClass}">${roleText}</span></td>
        <td>${activeRoomId || 'CAM-01'}</td>
        <td><span style="color:var(--accent-cyan); font-weight:600;">${conf}%</span></td>
        <td><span class="visit-badge">${visitsCount}</span></td>
      `;
      livePeopleTbody.appendChild(tr);
    });
  }

  /**
   * Update top Role Summary Bar from active tracks and server poll
   */
  function updateRoleSummaryCounts() {
    if (!humanTracker) return;

    const tracks = humanTracker.getLiveTracks();
    const counts = { STAFF: 0, CUSTOMER: 0, VISITOR: 0, DELIVERY: 0, SECURITY: 0, UNKNOWN: 0 };
    const staffIds = [];

    tracks.forEach((t) => {
      const role = t.roleType || 'UNKNOWN';
      counts[role] = (counts[role] || 0) + 1;
      if (role === 'STAFF' && t.assignedRole) {
        const parts = t.assignedRole.split('—');
        const empId = parts[1] ? parts[1].trim() : 'STAFF';
        if (!staffIds.includes(empId)) staffIds.push(empId);
      }
    });

    if (summaryStaffCount) summaryStaffCount.textContent = String(counts.STAFF);
    if (summaryStaffMembers) {
      summaryStaffMembers.textContent = staffIds.length > 0
        ? staffIds.join(', ')
        : 'None currently detected';
    }
    if (summaryUnknownCount) summaryUnknownCount.textContent = String(counts.UNKNOWN);
    if (summaryCustomerCount) summaryCustomerCount.textContent = String(counts.CUSTOMER);
    if (summaryVisitorCount) summaryVisitorCount.textContent = String(counts.VISITOR);
    if (summaryDeliveryCount) summaryDeliveryCount.textContent = String(counts.DELIVERY);
    if (summarySecurityCount) summarySecurityCount.textContent = String(counts.SECURITY);
  }

  /**
   * Fetch live summary from server (ensures multi-camera cross synchronization)
   */
  async function fetchLivePeopleSummary() {
    try {
      const res = await fetch('/api/people/live');
      if (!res.ok) return;
      const data = await res.json();
      const s = data.summary;

      if (summaryStaffCount && s.staffCount !== undefined) {
        summaryStaffCount.textContent = String(s.staffCount);
      }
      if (summaryStaffMembers && s.staffMembers) {
        summaryStaffMembers.textContent = s.staffMembers.length > 0
          ? s.staffMembers.join(', ')
          : 'None currently detected';
      }
      if (summaryUnknownCount && s.unknownCount !== undefined) {
        summaryUnknownCount.textContent = String(s.unknownCount);
      }
      if (summaryCustomerCount && s.customerCount !== undefined) {
        summaryCustomerCount.textContent = String(s.customerCount);
      }
      if (summaryVisitorCount && s.visitorCount !== undefined) {
        summaryVisitorCount.textContent = String(s.visitorCount);
      }
      if (summaryDeliveryCount && s.deliveryCount !== undefined) {
        summaryDeliveryCount.textContent = String(s.deliveryCount);
      }
      if (summarySecurityCount && s.securityCount !== undefined) {
        summarySecurityCount.textContent = String(s.securityCount);
      }
    } catch (e) {}
  }

  // Poll server live status every 4 seconds
  setInterval(fetchLivePeopleSummary, 4000);

  // -------------------------------------------------------------
  // Staff Admin Modal & Enrollment Controller
  // -------------------------------------------------------------

  if (btnOpenStaffModal && staffModal) {
    btnOpenStaffModal.addEventListener('click', () => {
      staffModal.classList.remove('hidden');
      loadStaffList();
      loadHardwareDiagnostics();
      loadSystemConfig();
    });
  }

  if (btnCloseStaffModal && staffModal) {
    btnCloseStaffModal.addEventListener('click', () => {
      staffModal.classList.add('hidden');
    });
  }

  if (btnEnrollCancel && staffModal) {
    btnEnrollCancel.addEventListener('click', () => {
      staffModal.classList.add('hidden');
    });
  }

  // Tab switching
  function switchTab(tab) {
    [tabBtnEnroll, tabBtnStaffList, tabBtnMemory, tabBtnHardware].forEach(b => b?.classList.remove('active'));
    [paneEnroll, paneStaffList, paneMemory, paneHardware].forEach(p => p?.classList.remove('active'));

    if (tab === 'enroll') {
      tabBtnEnroll?.classList.add('active');
      paneEnroll?.classList.add('active');
    } else if (tab === 'staffList') {
      tabBtnStaffList?.classList.add('active');
      paneStaffList?.classList.add('active');
      loadStaffList();
    } else if (tab === 'memory') {
      tabBtnMemory?.classList.add('active');
      paneMemory?.classList.add('active');
      loadKnownGallery();
    } else if (tab === 'hardware') {
      tabBtnHardware?.classList.add('active');
      paneHardware?.classList.add('active');
      loadHardwareDiagnostics();
    }
  }

  if (tabBtnEnroll) tabBtnEnroll.addEventListener('click', () => switchTab('enroll'));
  if (tabBtnStaffList) tabBtnStaffList.addEventListener('click', () => switchTab('staffList'));
  if (tabBtnMemory) tabBtnMemory.addEventListener('click', () => switchTab('memory'));
  if (tabBtnHardware) tabBtnHardware.addEventListener('click', () => switchTab('hardware'));

  // Photo Upload Helpers
  function setupPhotoUpload(card, input, preview, placeholder, photoKey) {
    if (!card || !input) return;

    card.addEventListener('click', () => input.click());

    input.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;

      if (!['image/jpeg', 'image/png'].includes(file.type)) {
        alert('Unsupported file format. Please upload a JPEG or PNG image.');
        return;
      }

      if (file.size > 10 * 1024 * 1024) {
        alert(`File size ${(file.size / 1024 / 1024).toFixed(1)}MB exceeds 10MB limit.`);
        return;
      }

      const reader = new FileReader();
      reader.onload = (evt) => {
        enrolledPhotos[photoKey] = evt.target.result;
        if (preview && placeholder) {
          preview.src = evt.target.result;
          preview.style.display = 'block';
          placeholder.style.display = 'none';
          card.classList.add('has-photo');
        }
      };
      reader.readAsDataURL(file);
    });
  }

  setupPhotoUpload(cardFrontPhoto, fileFrontPhoto, prevFrontPhoto, phFrontPhoto, 'frontImage');
  setupPhotoUpload(cardSidePhoto, fileSidePhoto, prevSidePhoto, phSidePhoto, 'sideImage');
  setupPhotoUpload(cardBackPhoto, fileBackPhoto, prevBackPhoto, phBackPhoto, 'backImage');

  // Submit Staff Enrollment Form
  if (formEnrollStaff) {
    formEnrollStaff.addEventListener('submit', async (e) => {
      e.preventDefault();

      if (!enrolledPhotos.frontImage) {
        alert('Please upload a mandatory front full-body reference image.');
        return;
      }

      const fullName = document.getElementById('enrollFullName').value.trim();
      const employeeId = document.getElementById('enrollEmployeeId').value.trim();
      const role = document.getElementById('enrollRole').value;
      const department = document.getElementById('enrollDepartment').value.trim();
      const scheduleId = document.getElementById('enrollSchedule').value;
      const zonesSelection = document.getElementById('enrollZones').value;

      let authorizedZones = ['ZONE_SALES_FLOOR'];
      if (zonesSelection === 'ALL') {
        authorizedZones = ['ZONE_SALES_FLOOR', 'ZONE_STOCK_ROOM', 'ZONE_LOADING_BAY'];
      } else if (zonesSelection === 'RESTRICTED') {
        authorizedZones = ['ZONE_STOCK_ROOM', 'ZONE_LOADING_BAY'];
      }

      const btnSubmit = document.getElementById('btnSubmitEnroll');
      if (btnSubmit) {
        btnSubmit.disabled = true;
        btnSubmit.textContent = 'Validating & Enrolling...';
      }

      if (enrollFeedback) {
        enrollFeedback.style.display = 'block';
        enrollFeedback.style.color = 'var(--accent-amber)';
        enrollFeedback.textContent = 'Processing photos, checking quality & extracting Re-ID features...';
      }

      try {
        const resp = await fetch('/api/staff/enroll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fullName,
            employeeId,
            role,
            department,
            scheduleId,
            authorizedZones,
            photos: enrolledPhotos
          })
        });

        const data = await resp.json();

        if (resp.ok && data.success) {
          enrollFeedback.style.color = 'var(--accent-green)';
          enrollFeedback.textContent = `✅ Successfully enrolled ${data.profile.fullName} (${data.profile.employeeId})! Body Re-ID features generated and encrypted.`;

          // Reset form
          setTimeout(() => {
            formEnrollStaff.reset();
            enrolledPhotos = { frontImage: null, sideImage: null, backImage: null };
            [prevFrontPhoto, prevSidePhoto, prevBackPhoto].forEach(p => { if (p) p.style.display = 'none'; });
            [phFrontPhoto, phSidePhoto, phBackPhoto].forEach(ph => { if (ph) ph.style.display = 'block'; });
            [cardFrontPhoto, cardSidePhoto, cardBackPhoto].forEach(c => { if (c) c.classList.remove('has-photo'); });
            switchTab('staffList');
          }, 1500);
        } else {
          enrollFeedback.style.color = '#ef4444';
          enrollFeedback.textContent = `❌ Enrollment failed: ${data.error || 'Unknown error'}`;
        }
      } catch (err) {
        enrollFeedback.style.color = '#ef4444';
        enrollFeedback.textContent = `❌ Network error: ${err.message}`;
      } finally {
        if (btnSubmit) {
          btnSubmit.disabled = false;
          btnSubmit.textContent = 'Enroll Staff Member';
        }
      }
    });
  }

  // Enrolled Staff List
  async function loadStaffList() {
    if (!tbodyStaffList) return;
    try {
      const res = await fetch('/api/staff');
      if (!res.ok) return;
      const data = await res.json();
      const list = data.staff || [];

      if (staffListCountBadge) staffListCountBadge.textContent = String(list.length);
      tbodyStaffList.innerHTML = '';

      if (list.length === 0) {
        tbodyStaffList.innerHTML = `<tr><td colspan="6" style="text-align:center; color:#888; padding:1.5rem;">No staff members currently enrolled. Use the "Add Staff" tab to enroll.</td></tr>`;
        return;
      }

      list.forEach(s => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><strong style="color:var(--accent-cyan);">${s.employeeId}</strong></td>
          <td>${s.fullName}</td>
          <td><span class="role-badge role-staff">${s.role}</span></td>
          <td>${s.department || '--'}</td>
          <td>${s.scheduleId}</td>
          <td>
            <button class="btn btn-secondary btn-delete-staff" data-id="${s.id}" style="padding:2px 8px; font-size:0.7rem; color:#ef4444; border-color:rgba(239,68,68,0.3);">
              Delete
            </button>
          </td>
        `;
        tbodyStaffList.appendChild(tr);
      });

      // Attach delete button listeners
      tbodyStaffList.querySelectorAll('.btn-delete-staff').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const id = e.target.getAttribute('data-id');
          if (!confirm(`Are you sure you want to delete this staff profile? Biometric features will be permanently purged.`)) return;

          try {
            const delRes = await fetch(`/api/staff/${id}`, { method: 'DELETE' });
            if (delRes.ok) {
              loadStaffList();
              fetchLivePeopleSummary();
            } else {
              alert('Failed to delete staff member');
            }
          } catch (err) {
            alert('Network error deleting staff member');
          }
        });
      });
    } catch (e) {}
  }

  if (btnRefreshStaffList) btnRefreshStaffList.addEventListener('click', loadStaffList);

  // Hardware Diagnostics & Recommendations
  async function loadHardwareDiagnostics() {
    try {
      const res = await fetch('/api/hardware/status');
      if (!res.ok) return;
      const data = await res.json();
      const hw = data.hardware;
      const cfg = data.configuration;

      const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

      setEl('diagCpuModel', hw.cpuModel);
      setEl('diagCpuCores', `${hw.cpuCores} Cores`);
      setEl('diagRamTotal', `${hw.totalRamGb} GB`);
      setEl('diagRamFree', `${hw.freeRamGb} GB`);
      setEl('diagGpu', `${hw.gpu}${hw.vramMb > 0 ? ` (${hw.vramMb} MB VRAM)` : ''}`);
      setEl('diagCuda', hw.cudaAvailable ? 'ENABLED (NVIDIA CUDA)' : 'FALLBACK (Metal/CPU)');

      setEl('diagMode', cfg.processingMode);
      setEl('diagFps', `${cfg.detectionFps} FPS`);
      setEl('diagReidInterval', `${cfg.reidIntervalMs} ms`);
      setEl('diagFaceInterval', `${cfg.faceIntervalMs} ms`);
      setEl('diagMaxPeople', `${cfg.maxTrackedPeople} Persons`);
    } catch (e) {}
  }

  // Load and Toggle Face Recognition Configuration
  async function loadSystemConfig() {
    try {
      const res = await fetch('/api/identity/status');
      if (!res.ok) return;
      const data = await res.json();
      if (checkEnableFace) {
        checkEnableFace.checked = Boolean(data.faceRecognitionEnabled);
      }
    } catch (e) {}
  }

  if (checkEnableFace) {
    checkEnableFace.addEventListener('change', async (e) => {
      const enabled = e.target.checked;
      try {
        await fetch('/api/identity/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ faceRecognitionEnabled: enabled })
        });
      } catch (err) {
        alert('Failed to update face recognition setting');
      }
    });
  }

  // -------------------------------------------------------------
  // Body Recognition Memory Gallery Controller
  // -------------------------------------------------------------

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  const memoryGalleryGrid = document.getElementById('memoryGalleryGrid');
  const memorySearchInput = document.getElementById('memorySearchInput');
  const memoryFilterRole = document.getElementById('memoryFilterRole');
  const memoryCountBadge = document.getElementById('memoryCountBadge');
  const btnRefreshMemory = document.getElementById('btnRefreshMemory');

  async function loadKnownGallery() {
    if (!memoryGalleryGrid) return;

    try {
      const q = (memorySearchInput?.value || '').trim();
      const role = (memoryFilterRole?.value || 'ALL').trim();
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (role && role !== 'ALL') params.set('role', role);

      const res = await fetch(`/api/persons?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const total = data.total !== undefined ? data.total : (data.persons ? data.persons.length : 0);
      if (memoryCountBadge) memoryCountBadge.textContent = String(total);
      renderKnownGallery(data.persons || []);
    } catch (err) {
      console.error('Failed to load memory gallery:', err);
      memoryGalleryGrid.innerHTML = `<div class="empty-state" style="grid-column: 1 / -1; padding: 2rem; color: #f87171;">Failed to load remembered persons: ${err.message}</div>`;
    }
  }

  function renderKnownGallery(persons) {
    if (!memoryGalleryGrid) return;
    memoryGalleryGrid.innerHTML = '';

    if (!persons || persons.length === 0) {
      memoryGalleryGrid.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1; padding: 2.5rem 1rem; text-align: center; color: var(--text-muted);">
          <div style="font-size: 2.2rem; margin-bottom: 0.8rem;">🧠</div>
          <strong style="color: #fff; font-size: 0.95rem;">No Remembered Humans Found</strong>
          <p style="margin-top: 0.4rem; font-size: 0.8rem; max-width: 380px; margin-left: auto; margin-right: auto;">
            As people appear in the CCTV camera feed, CEOVA Vision AI automatically builds 128-d body signatures and remembers them across visits.
          </p>
        </div>
      `;
      return;
    }

    persons.forEach(p => {
      const card = document.createElement('div');
      card.className = 'person-card';
      card.id = `person-card-${p.id}`;

      const roleClass = (p.role || 'UNKNOWN').toLowerCase();
      const firstSeenStr = p.first_seen_at ? new Date(p.first_seen_at).toLocaleString() : '--';
      const lastSeenStr = p.last_seen_at ? new Date(p.last_seen_at).toLocaleTimeString() : '--';
      const dwellFormatted = formatDwellTime(p.total_dwell_ms || 0);

      const thumbImg = p.thumbnail
        ? `<img src="${p.thumbnail}" class="person-card-thumb" alt="${escapeHtml(p.name)}" />`
        : `<div class="person-card-thumb-placeholder">👤</div>`;

      card.innerHTML = `
        <div class="person-card-thumb-wrapper">
          ${thumbImg}
          <span class="person-role-tag ${roleClass}">${p.role}</span>
          <span class="person-visits-badge">Visits: <strong>${p.visit_count || 1}</strong></span>
        </div>
        <div class="person-card-body">
          <div class="person-name-row">
            <input type="text" class="form-control person-name-input" value="${escapeHtml(p.name || '')}" placeholder="Name this human..." data-id="${p.id}" />
            <button class="btn btn-secondary btn-save-person" data-id="${p.id}" title="Save Name">💾</button>
          </div>
          <div class="person-meta-grid">
            <div><span class="meta-label">ID:</span> <strong style="color:var(--accent-cyan);">#${p.id}</strong></div>
            <div><span class="meta-label">Dwell:</span> <strong>${dwellFormatted}</strong></div>
            <div style="grid-column: 1 / -1;"><span class="meta-label">First Seen:</span> ${firstSeenStr}</div>
            <div style="grid-column: 1 / -1;"><span class="meta-label">Last Sighting:</span> ${lastSeenStr}</div>
          </div>
          <div class="person-card-actions">
            <button class="btn btn-danger btn-delete-person" data-id="${p.id}" style="font-size:0.72rem; padding: 4px 10px; width: 100%;">
              🗑️ Forget Person
            </button>
          </div>
        </div>
      `;

      // Save button event
      const saveBtn = card.querySelector('.btn-save-person');
      const nameInput = card.querySelector('.person-name-input');
      const doSave = async () => {
        const newName = nameInput.value.trim();
        if (!newName) return;
        try {
          saveBtn.textContent = '⏳';
          const res = await fetch(`/api/persons/${p.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName })
          });
          if (res.ok) {
            saveBtn.textContent = '✅';
            setTimeout(() => { saveBtn.textContent = '💾'; }, 1500);
          } else {
            saveBtn.textContent = '❌';
            setTimeout(() => { saveBtn.textContent = '💾'; }, 1500);
          }
        } catch (_err) {
          saveBtn.textContent = '❌';
          setTimeout(() => { saveBtn.textContent = '💾'; }, 1500);
        }
      };

      saveBtn?.addEventListener('click', doSave);
      nameInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          doSave();
        }
      });

      // Delete button event
      const delBtn = card.querySelector('.btn-delete-person');
      delBtn?.addEventListener('click', async () => {
        if (!confirm(`Are you sure you want to forget "${p.name || 'Human #' + p.id}" from persistent memory?`)) return;
        try {
          delBtn.disabled = true;
          delBtn.textContent = 'Deleting...';
          const res = await fetch(`/api/persons/${p.id}`, { method: 'DELETE' });
          if (res.ok) {
            card.remove();
            const curr = parseInt(memoryCountBadge?.textContent || '1', 10);
            if (memoryCountBadge) memoryCountBadge.textContent = String(Math.max(0, curr - 1));
          } else {
            alert('Failed to delete person from memory');
            delBtn.disabled = false;
            delBtn.textContent = '🗑️ Forget Person';
          }
        } catch (_err) {
          delBtn.disabled = false;
          delBtn.textContent = '🗑️ Forget Person';
        }
      });

      memoryGalleryGrid.appendChild(card);
    });
  }

  // Quick open gallery button from control bar
  if (btnOpenMemoryGallery && staffModal) {
    btnOpenMemoryGallery.addEventListener('click', () => {
      staffModal.classList.remove('hidden');
      switchTab('memory');
    });
  }

  if (btnRefreshMemory) {
    btnRefreshMemory.addEventListener('click', () => loadKnownGallery());
  }

  if (memorySearchInput) {
    let debounceTimer = null;
    memorySearchInput.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(loadKnownGallery, 300);
    });
  }

  if (memoryFilterRole) {
    memoryFilterRole.addEventListener('change', () => loadKnownGallery());
  }

  // =========================================================
  // PEOPLE COUNT RESPECT TO TIME (REAL-TIME TIMELINE GRAPH)
  // =========================================================
  const peopleCanvas = document.getElementById('peopleOccupancyCanvas');
  const graphWrapper = document.getElementById('graphCanvasWrapper');
  const graphTooltip = document.getElementById('graphTooltip');
  const miniSparkline = document.getElementById('miniPeopleSparkline');
  const miniSparklinePeak = document.getElementById('miniSparklinePeak');

  const gMetricCurrent = document.getElementById('gMetricCurrent');
  const gMetricCurrentSub = document.getElementById('gMetricCurrentSub');
  const gMetricPeak = document.getElementById('gMetricPeak');
  const gMetricPeakTime = document.getElementById('gMetricPeakTime');
  const gMetricAvg = document.getElementById('gMetricAvg');
  const gMetricTotal = document.getElementById('gMetricTotal');
  const graphOccupancyDensity = document.getElementById('graphOccupancyDensity');
  const graphDataPointCount = document.getElementById('graphDataPointCount');

  const graphLiveStatus = document.getElementById('graphLiveStatus');
  const graphLiveStatusText = document.getElementById('graphLiveStatusText');
  const graphPulseDot = document.getElementById('graphPulseDot');

  const chkSeriesTotal = document.getElementById('chkSeriesTotal');
  const chkSeriesStaff = document.getElementById('chkSeriesStaff');
  const chkSeriesVisitors = document.getElementById('chkSeriesVisitors');

  const btnToggleSimulate = document.getElementById('btnToggleSimulate');
  const btnPauseGraph = document.getElementById('btnPauseGraph');
  const btnExportCsv = document.getElementById('btnExportCsv');
  const btnExportGraphPng = document.getElementById('btnExportGraphPng');
  const btnClearGraph = document.getElementById('btnClearGraph');

  const TIMELINE_STORAGE_KEY = 'ceova_people_timeline_v2';
  let peopleTimeline = [];
  try {
    const saved = localStorage.getItem(TIMELINE_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) {
        const twoHoursAgo = Date.now() - 2 * 3600 * 1000;
        peopleTimeline = parsed.filter(p => p && p.timestamp > twoHoursAgo);
      }
    }
  } catch (_) {}

  // Populate baseline 30s so the graph starts with a clean baseline
  if (peopleTimeline.length === 0) {
    const baseNow = Date.now();
    for (let i = 30; i >= 0; i--) {
      peopleTimeline.push({
        timestamp: baseNow - (i * 1000),
        totalCount: 0,
        staffCount: 0,
        visitorCount: 0,
        cumulativeCount: 0
      });
    }
  }

  let selectedRange = 60; // 60, 300, 900, 3600, or 'all'
  let isGraphPaused = false;
  let pauseFreezeTime = null;
  let isSimulating = false;
  let simCycleStep = 0;
  let simCounts = { total: 0, staff: 0, visitors: 0 };
  let hoverState = null; // { mouseX, mouseY }

  // Simulate Traffic Wave Generator
  const simWaves = [
    { total: 0, staff: 0, visitors: 0 },
    { total: 1, staff: 1, visitors: 0 },
    { total: 1, staff: 1, visitors: 0 },
    { total: 2, staff: 1, visitors: 1 },
    { total: 2, staff: 1, visitors: 1 },
    { total: 3, staff: 1, visitors: 2 },
    { total: 4, staff: 1, visitors: 3 }, // Peak surge
    { total: 5, staff: 2, visitors: 3 }, // Maximum peak
    { total: 4, staff: 2, visitors: 2 },
    { total: 3, staff: 1, visitors: 2 },
    { total: 2, staff: 1, visitors: 1 },
    { total: 1, staff: 0, visitors: 1 },
    { total: 0, staff: 0, visitors: 0 },
    { total: 0, staff: 0, visitors: 0 }
  ];

  function tickSimulation() {
    if (!isSimulating) return;
    simCycleStep = (simCycleStep + 1) % simWaves.length;
    simCounts = { ...simWaves[simCycleStep] };
  }

  // 1-Second Sampling Engine
  function samplePeopleTimeData() {
    const now = Date.now();
    let total = 0;
    let staff = 0;
    let visitors = 0;
    let cumulative = humanTracker ? humanTracker.totalUniqueCount : 0;

    if (isSimulating) {
      total = simCounts.total;
      staff = simCounts.staff;
      visitors = simCounts.visitors;
      cumulative = Math.max(cumulative, 6);
    } else if (humanTracker) {
      const liveTracks = humanTracker.getLiveTracks(now);
      total = liveTracks.length;
      for (const t of liveTracks) {
        if (t.assignedRole === 'STAFF') staff++;
        else visitors++;
      }
      cumulative = humanTracker.totalUniqueCount;
    }

    const sample = {
      timestamp: now,
      totalCount: total,
      staffCount: staff,
      visitorCount: visitors,
      cumulativeCount: cumulative
    };

    peopleTimeline.push(sample);

    // Keep max 7200 points (2 hours of 1-sec data)
    if (peopleTimeline.length > 7200) {
      peopleTimeline.shift();
    }

    // Debounced persist to localStorage
    if (peopleTimeline.length % 5 === 0) {
      try {
        localStorage.setItem(TIMELINE_STORAGE_KEY, JSON.stringify(peopleTimeline.slice(-600)));
      } catch (_) {}
    }

    // Sync with backend API
    if (peopleTimeline.length % 3 === 0) {
      fetch('/api/people/timeline/sample', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sample)
      }).catch(() => {});
    }

    // Sync with Popular Times hourly aggregator (every 5 samples)
    if (peopleTimeline.length % 5 === 0 && typeof recordLivePopularSample === 'function') {
      recordLivePopularSample(total);
    }

    updateMetricsDisplay();
  }

  // Calculate & Update Metrics
  function updateMetricsDisplay() {
    if (peopleTimeline.length === 0) return;
    const now = isGraphPaused && pauseFreezeTime ? pauseFreezeTime : Date.now();

    // Determine current window points
    let windowStart;
    if (selectedRange === 'all') {
      windowStart = peopleTimeline[0].timestamp;
    } else {
      windowStart = now - (selectedRange * 1000);
    }

    const windowPoints = peopleTimeline.filter(p => p.timestamp >= windowStart && p.timestamp <= now);
    const pts = windowPoints.length > 0 ? windowPoints : peopleTimeline.slice(-30);

    const latest = peopleTimeline[peopleTimeline.length - 1];
    const current = latest ? latest.totalCount : 0;

    let peak = 0;
    let peakPt = null;
    let sum = 0;

    for (const p of pts) {
      if (p.totalCount >= peak) {
        peak = p.totalCount;
        peakPt = p;
      }
      sum += p.totalCount;
    }

    const avg = pts.length > 0 ? (sum / pts.length).toFixed(1) : '0.0';
    const totalUnique = humanTracker ? humanTracker.totalUniqueCount : (latest ? latest.cumulativeCount : 0);

    if (gMetricCurrent) gMetricCurrent.textContent = String(current);
    if (gMetricCurrentSub) {
      gMetricCurrentSub.textContent = isSimulating ? 'simulated traffic' : (current === 1 ? '1 person in frame' : `${current} people in frame`);
    }
    if (gMetricPeak) gMetricPeak.textContent = String(peak);
    if (gMetricPeakTime) {
      gMetricPeakTime.textContent = peakPt ? new Date(peakPt.timestamp).toLocaleTimeString() : '--:--:--';
    }
    if (gMetricAvg) gMetricAvg.textContent = String(avg);
    if (gMetricTotal) gMetricTotal.textContent = String(Math.max(totalUnique, peak));

    if (graphDataPointCount) {
      graphDataPointCount.textContent = `${peopleTimeline.length} points recorded (1s sample rate)`;
    }

    // Occupancy Density Badge
    if (graphOccupancyDensity) {
      graphOccupancyDensity.className = 'density-pill';
      if (current === 0) {
        graphOccupancyDensity.classList.add('density-vacant');
        graphOccupancyDensity.textContent = 'STATUS: VACANT (0 PEOPLE)';
      } else if (current <= 2) {
        graphOccupancyDensity.classList.add('density-normal');
        graphOccupancyDensity.textContent = `STATUS: NORMAL OCCUPANCY (${current} IN VIEW)`;
      } else if (current <= 4) {
        graphOccupancyDensity.classList.add('density-busy');
        graphOccupancyDensity.textContent = `STATUS: MODERATE TRAFFIC (${current} IN VIEW)`;
      } else {
        graphOccupancyDensity.classList.add('density-surge');
        graphOccupancyDensity.textContent = `STATUS: HIGH DENSITY SURGE (${current} IN VIEW)`;
      }
    }
  }

  // Draw Spline / Smooth Line Curve
  function drawSmoothSeries(ctx, coords, strokeColor, fillColor = null, lineWidth = 2) {
    if (!coords || coords.length === 0) return;

    if (coords.length === 1) {
      ctx.beginPath();
      ctx.arc(coords[0].x, coords[0].y, 3, 0, Math.PI * 2);
      ctx.fillStyle = strokeColor;
      ctx.fill();
      return;
    }

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(coords[0].x, coords[0].y);

    for (let i = 0; i < coords.length - 1; i++) {
      const p0 = coords[i === 0 ? i : i - 1];
      const p1 = coords[i];
      const p2 = coords[i + 1];
      const p3 = coords[i + 2 < coords.length ? i + 2 : i + 1];

      // Catmull-Rom to Cubic Bezier control points conversion
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;

      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
    }

    if (fillColor) {
      ctx.save();
      const fillPath = new Path2D();
      fillPath.moveTo(coords[0].x, coords[0].y);

      for (let i = 0; i < coords.length - 1; i++) {
        const p0 = coords[i === 0 ? i : i - 1];
        const p1 = coords[i];
        const p2 = coords[i + 1];
        const p3 = coords[i + 2 < coords.length ? i + 2 : i + 1];

        const cp1x = p1.x + (p2.x - p0.x) / 6;
        const cp1y = p1.y + (p2.y - p0.y) / 6;
        const cp2x = p2.x - (p3.x - p1.x) / 6;
        const cp2y = p2.y - (p3.y - p1.y) / 6;

        fillPath.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
      }

      // Close path to bottom of chart
      const bottomY = coords[coords.length - 1].bottomY;
      fillPath.lineTo(coords[coords.length - 1].x, bottomY);
      fillPath.lineTo(coords[0].x, bottomY);
      fillPath.closePath();

      ctx.fillStyle = fillColor;
      ctx.fill(fillPath);
      ctx.restore();
    }

    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = strokeColor;
    ctx.shadowBlur = 6;
    ctx.stroke();
    ctx.restore();
  }

  // Main Canvas Rendering Function
  function renderPeopleGraph() {
    if (!peopleCanvas || !graphWrapper) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = graphWrapper.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    if (w <= 0 || h <= 0) return;

    if (peopleCanvas.width !== Math.round(w * dpr) || peopleCanvas.height !== Math.round(h * dpr)) {
      peopleCanvas.width = Math.round(w * dpr);
      peopleCanvas.height = Math.round(h * dpr);
    }

    const ctx = peopleCanvas.getContext('2d');
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const pad = { top: 25, right: 65, bottom: 35, left: 45 };
    const pw = w - pad.left - pad.right;
    const ph = h - pad.top - pad.bottom;

    if (pw <= 0 || ph <= 0) {
      ctx.restore();
      return;
    }

    const now = isGraphPaused && pauseFreezeTime ? pauseFreezeTime : Date.now();
    let leftTime;
    if (selectedRange === 'all') {
      leftTime = peopleTimeline.length > 0 ? peopleTimeline[0].timestamp : (now - 60000);
      if (now - leftTime < 60000) leftTime = now - 60000;
    } else {
      leftTime = now - (selectedRange * 1000);
    }
    const rightTime = now;
    const timeSpan = Math.max(10000, rightTime - leftTime);

    // Filter points in visible window
    const pts = peopleTimeline.filter(p => p.timestamp >= (leftTime - 2000) && p.timestamp <= (rightTime + 2000));

    // Calculate maximum Y
    let maxVal = 0;
    let peakVal = 0;
    let peakPt = null;
    let sum = 0;

    for (const p of pts) {
      if (p.totalCount > maxVal) maxVal = p.totalCount;
      if (p.totalCount > peakVal) {
        peakVal = p.totalCount;
        peakPt = p;
      }
      sum += p.totalCount;
    }

    const avgVal = pts.length > 0 ? sum / pts.length : 0;
    const yMax = Math.max(5, Math.ceil(maxVal * 1.2));

    const getX = t => pad.left + ((t - leftTime) / timeSpan) * pw;
    const getY = v => pad.top + ph - (v / yMax) * ph;

    // 1. Grid Background & Axes
    ctx.lineWidth = 1;
    ctx.font = '10px JetBrains Mono, monospace';

    // Horizontal grid lines
    const yStep = yMax <= 6 ? 1 : (yMax <= 12 ? 2 : Math.ceil(yMax / 6));
    for (let y = 0; y <= yMax; y += yStep) {
      const py = Math.round(getY(y)) + 0.5;

      ctx.save();
      ctx.beginPath();
      ctx.strokeStyle = y === 0 ? 'rgba(255, 255, 255, 0.18)' : 'rgba(255, 255, 255, 0.06)';
      if (y !== 0) ctx.setLineDash([3, 4]);
      ctx.moveTo(pad.left, py);
      ctx.lineTo(pad.left + pw, py);
      ctx.stroke();
      ctx.restore();

      // Y Label
      ctx.fillStyle = y === 0 ? '#d4d4d8' : '#71717a';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(y), pad.left - 10, py);
    }

    // Y Axis unit title
    ctx.save();
    ctx.fillStyle = '#71717a';
    ctx.font = '9px JetBrains Mono, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('PEOPLE', pad.left - 36, pad.top - 12);
    ctx.restore();

    // Vertical time grid lines
    const numTicks = w > 600 ? 6 : 4;
    for (let i = 0; i <= numTicks; i++) {
      const tickTime = leftTime + (i / numTicks) * timeSpan;
      const px = Math.round(getX(tickTime)) + 0.5;

      ctx.save();
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.setLineDash([2, 4]);
      ctx.moveTo(px, pad.top);
      ctx.lineTo(px, pad.top + ph);
      ctx.stroke();
      ctx.restore();

      // Time label
      const d = new Date(tickTime);
      const timeStr = d.toTimeString().split(' ')[0];
      ctx.fillStyle = '#71717a';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(timeStr, px, pad.top + ph + 8);
    }

    // 2. Reference Lines (Peak & Average)
    if (peakVal > 0) {
      const py = getY(peakVal);
      ctx.save();
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.55)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.moveTo(pad.left, py);
      ctx.lineTo(pad.left + pw, py);
      ctx.stroke();

      // Peak Badge on right margin
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(245, 158, 11, 0.18)';
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.5)';
      ctx.beginPath();
      ctx.roundRect(pad.left + pw + 4, py - 9, 56, 18, 4);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#f59e0b';
      ctx.font = '9px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`PEAK: ${peakVal}`, pad.left + pw + 32, py);
      ctx.restore();
    }

    if (avgVal > 0 && Math.abs(getY(avgVal) - getY(peakVal)) > 14) {
      const ay = getY(avgVal);
      ctx.save();
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.5)';
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.moveTo(pad.left, ay);
      ctx.lineTo(pad.left + pw, ay);
      ctx.stroke();

      // Avg Badge on right margin
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(56, 189, 248, 0.15)';
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
      ctx.beginPath();
      ctx.roundRect(pad.left + pw + 4, ay - 9, 56, 18, 4);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#38bdf8';
      ctx.font = '9px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`AVG: ${avgVal.toFixed(1)}`, pad.left + pw + 32, ay);
      ctx.restore();
    }

    // 3. Prepare Series Coordinate Lists
    const totalCoords = [];
    const staffCoords = [];
    const visitorCoords = [];

    const bottomY = pad.top + ph;

    for (const p of pts) {
      const px = getX(p.timestamp);
      totalCoords.push({ x: px, y: getY(p.totalCount), bottomY, raw: p });
      staffCoords.push({ x: px, y: getY(p.staffCount), bottomY, raw: p });
      visitorCoords.push({ x: px, y: getY(p.visitorCount), bottomY, raw: p });
    }

    // Clip rendering strictly to plot area
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.left - 2, pad.top - 5, pw + 4, ph + 10);
    ctx.clip();

    // Series 1: Total People (with gradient fill)
    if (chkSeriesTotal && chkSeriesTotal.checked && totalCoords.length > 0) {
      const totalGrad = ctx.createLinearGradient(0, pad.top, 0, pad.top + ph);
      totalGrad.addColorStop(0, 'rgba(56, 189, 248, 0.28)');
      totalGrad.addColorStop(0.7, 'rgba(56, 189, 248, 0.05)');
      totalGrad.addColorStop(1, 'rgba(56, 189, 248, 0.0)');

      drawSmoothSeries(ctx, totalCoords, '#38bdf8', totalGrad, 2.5);

      // Pulse Radar indicator at rightmost point
      const lastCoord = totalCoords[totalCoords.length - 1];
      if (lastCoord) {
        const pulse = (Math.sin(Date.now() / 200) + 1) / 2;
        ctx.save();
        ctx.beginPath();
        ctx.arc(lastCoord.x, lastCoord.y, 4 + pulse * 6, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(56, 189, 248, ${0.45 - pulse * 0.35})`;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(lastCoord.x, lastCoord.y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = '#38bdf8';
        ctx.shadowBlur = 8;
        ctx.fill();
        ctx.restore();
      }
    }

    // Series 2: Enrolled Staff (Green)
    if (chkSeriesStaff && chkSeriesStaff.checked && staffCoords.length > 0) {
      drawSmoothSeries(ctx, staffCoords, '#22c55e', null, 1.8);
    }

    // Series 3: Unknown / Visitors (Purple)
    if (chkSeriesVisitors && chkSeriesVisitors.checked && visitorCoords.length > 0) {
      drawSmoothSeries(ctx, visitorCoords, '#a855f7', null, 1.8);
    }

    // 4. Interactive Hover Crosshair & Dots
    if (hoverState && hoverState.mouseX >= pad.left && hoverState.mouseX <= (pad.left + pw)) {
      const hx = hoverState.mouseX;

      // Vertical scanner crosshair line
      ctx.save();
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.6)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.moveTo(hx, pad.top);
      ctx.lineTo(hx, pad.top + ph);
      ctx.stroke();

      // Find closest point
      let closestPt = null;
      let minDistance = Infinity;

      for (const c of totalCoords) {
        const d = Math.abs(c.x - hx);
        if (d < minDistance) {
          minDistance = d;
          closestPt = c;
        }
      }

      if (closestPt && minDistance < 40) {
        // Draw glow circles on curves
        if (chkSeriesTotal && chkSeriesTotal.checked) {
          ctx.beginPath();
          ctx.arc(closestPt.x, closestPt.y, 5, 0, Math.PI * 2);
          ctx.fillStyle = '#38bdf8';
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.setLineDash([]);
          ctx.fill();
          ctx.stroke();
        }

        // Update HTML Tooltip
        if (graphTooltip) {
          const raw = closestPt.raw;
          const timeStr = new Date(raw.timestamp).toLocaleTimeString();
          let statusText = 'Vacant';
          if (raw.totalCount >= 5) statusText = 'Crowd Surge';
          else if (raw.totalCount >= 3) statusText = 'Moderate Occupancy';
          else if (raw.totalCount >= 1) statusText = 'Normal Occupancy';

          graphTooltip.innerHTML = `
            <div class="graph-tooltip-time">🕒 ${timeStr}</div>
            <div class="graph-tooltip-row">
              <span style="color:var(--accent-sky);">👥 Total People:</span>
              <strong>${raw.totalCount}</strong>
            </div>
            <div class="graph-tooltip-row">
              <span style="color:var(--accent-grass);">👔 Staff:</span>
              <strong>${raw.staffCount}</strong>
            </div>
            <div class="graph-tooltip-row">
              <span style="color:#a855f7;">🚶 Visitors:</span>
              <strong>${raw.visitorCount}</strong>
            </div>
            <div class="graph-tooltip-row" style="margin-top:4px; font-size:0.68rem; color:var(--text-muted); border-top:1px dashed rgba(255,255,255,0.1); padding-top:2px;">
              <span>Status:</span>
              <span style="color:#fff;">${statusText}</span>
            </div>
          `;

          // Clamp tooltip position inside canvas wrapper
          const ttX = Math.max(70, Math.min(w - 70, closestPt.x));
          const ttY = Math.max(50, closestPt.y - 15);
          graphTooltip.style.left = `${ttX}px`;
          graphTooltip.style.top = `${ttY}px`;
          graphTooltip.classList.remove('hidden');
        }
      } else {
        if (graphTooltip) graphTooltip.classList.add('hidden');
      }
      ctx.restore();
    } else {
      if (graphTooltip) graphTooltip.classList.add('hidden');
    }

    ctx.restore(); // Undo clip
    ctx.restore(); // Undo setTransform

    // 5. Draw Mini Sparkline in Side Panel
    renderMiniSparkline(pts, peakVal);
  }

  // Draw Side-Panel Mini Sparkline
  function renderMiniSparkline(pts, peakVal) {
    if (!miniSparkline) return;
    const sW = miniSparkline.width;
    const sH = miniSparkline.height;
    const sCtx = miniSparkline.getContext('2d');
    sCtx.clearRect(0, 0, sW, sH);

    if (miniSparklinePeak) {
      miniSparklinePeak.textContent = `PEAK: ${peakVal}`;
    }

    if (!pts || pts.length === 0) return;

    const last60 = pts.slice(-45);
    let sMax = Math.max(3, ...last60.map(p => p.totalCount));

    const coords = [];
    for (let i = 0; i < last60.length; i++) {
      const x = (i / (last60.length - 1 || 1)) * sW;
      const y = sH - 4 - (last60[i].totalCount / sMax) * (sH - 8);
      coords.push({ x, y, bottomY: sH });
    }

    const grad = sCtx.createLinearGradient(0, 0, 0, sH);
    grad.addColorStop(0, 'rgba(34, 197, 94, 0.4)');
    grad.addColorStop(1, 'rgba(34, 197, 94, 0.0)');

    drawSmoothSeries(sCtx, coords, '#22c55e', grad, 1.8);
  }

  // Animation Loop (60 FPS smooth rendering)
  let lastSampleCheck = 0;
  function graphAnimationLoop() {
    const now = Date.now();

    // 1-second regular sampler
    if (now - lastSampleCheck >= 1000) {
      lastSampleCheck = now;
      if (isSimulating) tickSimulation();
      samplePeopleTimeData();
    }

    renderPeopleGraph();
    requestAnimationFrame(graphAnimationLoop);
  }

  // UI Event Listeners for Controls
  function setupGraphControls() {
    // Time Range buttons
    const rangeBtns = document.querySelectorAll('.time-range-btn');
    rangeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        rangeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const r = btn.dataset.range;
        selectedRange = r === 'all' ? 'all' : parseInt(r, 10);
        updateMetricsDisplay();
      });
    });

    // Pause / Resume Toggle
    if (btnPauseGraph) {
      btnPauseGraph.addEventListener('click', () => {
        isGraphPaused = !isGraphPaused;
        if (isGraphPaused) {
          pauseFreezeTime = Date.now();
          btnPauseGraph.textContent = '▶ Resume';
          btnPauseGraph.classList.add('btn-primary');
          btnPauseGraph.classList.remove('btn-secondary');
          if (graphLiveStatus) {
            graphLiveStatus.classList.add('paused');
            graphLiveStatusText.textContent = 'PAUSED';
            graphPulseDot.className = 'pulse-dot';
          }
        } else {
          pauseFreezeTime = null;
          btnPauseGraph.textContent = '⏸ Pause';
          btnPauseGraph.classList.remove('btn-primary');
          btnPauseGraph.classList.add('btn-secondary');
          if (graphLiveStatus) {
            graphLiveStatus.classList.remove('paused');
            graphLiveStatusText.textContent = 'LIVE TRACKING';
            graphPulseDot.className = 'pulse-dot online';
          }
        }
      });
    }

    // Simulate Traffic Wave Toggle
    if (btnToggleSimulate) {
      btnToggleSimulate.addEventListener('click', () => {
        isSimulating = !isSimulating;
        if (isSimulating) {
          simCycleStep = 0;
          btnToggleSimulate.textContent = '⚡ Stop Sim';
          btnToggleSimulate.classList.add('btn-primary');
          btnToggleSimulate.classList.remove('btn-secondary');
        } else {
          btnToggleSimulate.textContent = '⚡ Simulate Traffic';
          btnToggleSimulate.classList.remove('btn-primary');
          btnToggleSimulate.classList.add('btn-secondary');
          simCounts = { total: 0, staff: 0, visitors: 0 };
        }
      });
    }

    // Export CSV
    if (btnExportCsv) {
      btnExportCsv.addEventListener('click', () => {
        if (peopleTimeline.length === 0) {
          alert('No timeline data to export yet.');
          return;
        }

        let csv = 'Timestamp_MS,DateTime_ISO,Time_Local,Total_People,Staff_Count,Visitor_Count\n';
        for (const pt of peopleTimeline) {
          const d = new Date(pt.timestamp);
          csv += `${pt.timestamp},${d.toISOString()},"${d.toLocaleTimeString()}",${pt.totalCount},${pt.staffCount},${pt.visitorCount}\n`;
        }

        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ceova_people_occupancy_timeline_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      });
    }

    // Export Snapshot PNG
    if (btnExportGraphPng && peopleCanvas) {
      btnExportGraphPng.addEventListener('click', () => {
        try {
          const snapCanvas = document.createElement('canvas');
          snapCanvas.width = 1200;
          snapCanvas.height = 630;
          const sCtx = snapCanvas.getContext('2d');

          // Dark cyber background
          sCtx.fillStyle = '#08080c';
          sCtx.fillRect(0, 0, 1200, 630);

          // Top Header Banner
          sCtx.fillStyle = '#38bdf8';
          sCtx.font = 'bold 22px Plus Jakarta Sans, sans-serif';
          sCtx.fillText('CEOVA VISION CCTV // PEOPLE OCCUPANCY OVER TIME', 40, 48);

          sCtx.fillStyle = '#8e8e93';
          sCtx.font = '14px JetBrains Mono, monospace';
          sCtx.fillText(`Report Generated: ${new Date().toLocaleString()} | CCTV CAM-01`, 40, 76);

          // Summary Stats Pill Bar
          sCtx.fillStyle = 'rgba(255, 255, 255, 0.06)';
          sCtx.fillRect(40, 96, 1120, 60);

          sCtx.fillStyle = '#22c55e';
          sCtx.font = 'bold 15px JetBrains Mono, monospace';
          sCtx.fillText(`CURRENT: ${gMetricCurrent?.textContent || 0}`, 60, 132);

          sCtx.fillStyle = '#f59e0b';
          sCtx.fillText(`PEAK: ${gMetricPeak?.textContent || 0} (${gMetricPeakTime?.textContent || '--'})`, 280, 132);

          sCtx.fillStyle = '#38bdf8';
          sCtx.fillText(`AVG OCCUPANCY: ${gMetricAvg?.textContent || 0} / min`, 580, 132);

          sCtx.fillStyle = '#c084fc';
          sCtx.fillText(`TOTAL UNIQUE IDs: ${gMetricTotal?.textContent || 0}`, 880, 132);

          // Draw main chart into snapshot
          sCtx.drawImage(peopleCanvas, 40, 175, 1120, 410);

          const dataUrl = snapCanvas.toDataURL('image/png');
          const a = document.createElement('a');
          a.href = dataUrl;
          a.download = `ceova_people_graph_${Date.now()}.png`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        } catch (e) {
          alert('Snapshot failed: ' + e.message);
        }
      });
    }

    // Reset Timeline
    if (btnClearGraph) {
      btnClearGraph.addEventListener('click', () => {
        if (confirm('Clear all recorded people timeline data?')) {
          peopleTimeline = [];
          const baseNow = Date.now();
          for (let i = 20; i >= 0; i--) {
            peopleTimeline.push({
              timestamp: baseNow - (i * 1000),
              totalCount: 0,
              staffCount: 0,
              visitorCount: 0,
              cumulativeCount: 0
            });
          }
          try {
            localStorage.removeItem(TIMELINE_STORAGE_KEY);
          } catch (_) {}
          fetch('/api/people/timeline', { method: 'DELETE' }).catch(() => {});
          updateMetricsDisplay();
        }
      });
    }

    // Mouse Tracking for Interactive Tooltip & Crosshair
    if (graphWrapper) {
      graphWrapper.addEventListener('mousemove', (e) => {
        const rect = graphWrapper.getBoundingClientRect();
        hoverState = {
          mouseX: e.clientX - rect.left,
          mouseY: e.clientY - rect.top
        };
      });

      graphWrapper.addEventListener('mouseleave', () => {
        hoverState = null;
        if (graphTooltip) graphTooltip.classList.add('hidden');
      });
    }

    // Series Checkbox listeners
    if (chkSeriesTotal) chkSeriesTotal.addEventListener('change', () => renderPeopleGraph());
    if (chkSeriesStaff) chkSeriesStaff.addEventListener('change', () => renderPeopleGraph());
    if (chkSeriesVisitors) chkSeriesVisitors.addEventListener('change', () => renderPeopleGraph());

    // Window Resize Handler
    window.addEventListener('resize', () => {
      renderPeopleGraph();
      renderPopularTimesGraph();
    });
  }

  // =========================================================
  // POPULAR TIMES (DAY & HOURLY HISTOGRAM ENGINE)
  // =========================================================
  const popularTimesCanvas = document.getElementById('popularTimesCanvas');
  const popularChartWrapper = document.getElementById('popularChartWrapper');
  const popularTooltip = document.getElementById('popularTooltip');
  const popularDaySelect = document.getElementById('popularDaySelect');
  const btnPrevDay = document.getElementById('btnPrevDay');
  const btnNextDay = document.getElementById('btnNextDay');
  const popPeakHour = document.getElementById('popPeakHour');
  const popDailyTotal = document.getElementById('popDailyTotal');
  const popCurrentStatus = document.getElementById('popCurrentStatus');
  const btnSeedPopular = document.getElementById('btnSeedPopular');
  const btnExportPopularCsv = document.getElementById('btnExportPopularCsv');

  const btnTabPopularTimes = document.getElementById('btnTabPopularTimes');
  const btnTabLiveGraph = document.getElementById('btnTabLiveGraph');
  const popularTimesSection = document.getElementById('popularTimesSection');
  const liveGraphSection = document.getElementById('liveGraphSection');

  const POPULAR_STORAGE_KEY = 'ceova_popular_times_cache_v3';
  const DAY_NAMES = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
  let popularTimesData = {};
  let currentPopularDay = new Date().getDay(); // 0 = Sun, 1 = Mon, ..., 4 = Thu
  let hoveredPopularSlot = null; // index 0..16

  if (popularDaySelect) {
    popularDaySelect.value = String(currentPopularDay);
  }

  // Purge deprecated mock cache from localStorage
  try {
    localStorage.removeItem('ceova_popular_times_cache_v2');
    const cached = localStorage.getItem(POPULAR_STORAGE_KEY);
    if (cached) {
      popularTimesData = JSON.parse(cached);
    }
  } catch (_) {}

  // Fetch from server SQLite database
  async function loadPopularTimesData(day = currentPopularDay) {
    try {
      const res = await fetch(`/api/people/popular-times?day_of_week=${day}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.allDays) {
        popularTimesData = data.allDays;
        try {
          localStorage.setItem(POPULAR_STORAGE_KEY, JSON.stringify(popularTimesData));
        } catch (_) {}
      }
      renderPopularTimesGraph();
    } catch (_) {
      renderPopularTimesGraph();
    }
  }

  // Record a live detection sample to the current day & hour
  function recordLivePopularSample(count) {
    const now = new Date();
    const day = now.getDay();
    const hour = now.getHours();

    if (popularTimesData && popularTimesData[day] && popularTimesData[day].hours) {
      const hrObj = popularTimesData[day].hours.find(h => h.hour === hour);
      if (hrObj) {
        const prevSamples = hrObj.sampleCount || 0;
        if (prevSamples === 0) {
          hrObj.sampleCount = 1;
          hrObj.avgPeople = count;
          hrObj.peakPeople = count;
        } else {
          hrObj.sampleCount = prevSamples + 1;
          hrObj.avgPeople = Math.round(((hrObj.avgPeople * prevSamples + count) / hrObj.sampleCount));
          hrObj.peakPeople = Math.max(hrObj.peakPeople || 0, count);
        }

        try {
          localStorage.setItem(POPULAR_STORAGE_KEY, JSON.stringify(popularTimesData));
        } catch (_) {}
      }
    }

    // Also persist to SQLite backend
    fetch('/api/people/popular-times/record', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ day_of_week: day, hour_of_day: hour, count })
    }).catch(() => {});

    if (day === currentPopularDay) {
      renderPopularTimesGraph();
    }
  }

  // Render Popular Times Histogram Canvas
  function renderPopularTimesGraph() {
    if (!popularTimesCanvas || !popularChartWrapper) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = popularChartWrapper.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    if (w <= 0 || h <= 0) return;

    if (popularTimesCanvas.width !== Math.round(w * dpr) || popularTimesCanvas.height !== Math.round(h * dpr)) {
      popularTimesCanvas.width = Math.round(w * dpr);
      popularTimesCanvas.height = Math.round(h * dpr);
    }

    const ctx = popularTimesCanvas.getContext('2d');
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Visible hours range: 6 AM (6) to 10 PM (22) = 17 bars matching 6a, 9a, 12p, 3p, 6p, 9p
    const startHour = 6;
    const endHour = 22;
    const totalBars = endHour - startHour + 1; // 17 bars

    const dayObj = popularTimesData[currentPopularDay];
    const allHours = dayObj && dayObj.hours ? dayObj.hours : [];

    const chartHours = [];
    let maxCount = 0;
    let busiestHourObj = null;
    let dailySum = 0;

    for (let hr = startHour; hr <= endHour; hr++) {
      const found = allHours.find(h => h.hour === hr);
      const avg = found ? Math.round(found.avgPeople) : 0;
      const peak = found ? found.peakPeople : 0;
      const period = hr >= 12 ? 'PM' : 'AM';
      const dispH = hr % 12 === 0 ? 12 : hr % 12;
      const label = `${dispH} ${period}`;
      const short = `${dispH}${period.toLowerCase()[0]}`;

      if (avg > maxCount) {
        maxCount = avg;
        busiestHourObj = { hour: hr, label, avg, peak };
      }
      dailySum += avg;

      chartHours.push({
        hour: hr,
        label,
        short,
        avg,
        peak
      });
    }

    // Update Summary Strip
    if (popPeakHour) {
      if (busiestHourObj && busiestHourObj.avg > 0) {
        const nextH = (busiestHourObj.hour + 1) % 12 === 0 ? 12 : (busiestHourObj.hour + 1) % 12;
        const nextPeriod = (busiestHourObj.hour + 1) >= 12 ? 'PM' : 'AM';
        popPeakHour.textContent = `${busiestHourObj.label} - ${nextH} ${nextPeriod} (${busiestHourObj.avg} People Avg)`;
      } else {
        popPeakHour.textContent = '--';
      }
    }
    if (popDailyTotal) {
      popDailyTotal.textContent = `${dailySum} People Total`;
    }
    if (popCurrentStatus) {
      const now = new Date();
      const isToday = now.getDay() === currentPopularDay;
      if (isToday) {
        const currHour = now.getHours();
        const currObj = chartHours.find(h => h.hour === currHour);
        const liveCount = (peopleTimeline.length > 0) ? peopleTimeline[peopleTimeline.length - 1].totalCount : 0;
        const typical = currObj ? currObj.avg : 0;
        if (typical > 0) {
          popCurrentStatus.textContent = `Live: ${liveCount} in view (usually ~${typical} at ${currHour % 12 || 12} ${currHour >= 12 ? 'PM' : 'AM'})`;
        } else {
          popCurrentStatus.textContent = `Live: ${liveCount} in view (recording real live detections)`;
        }
      } else {
        popCurrentStatus.textContent = `Day View: ${DAY_NAMES[currentPopularDay]} (Recorded Traffic)`;
      }
    }

    // Chart margins
    const pad = { left: 16, right: 16, top: 22, bottom: 8 };
    const chartW = w - pad.left - pad.right;
    const chartH = h - pad.top - pad.bottom;
    const slotW = chartW / totalBars;
    const barW = Math.max(6, Math.min(26, slotW * 0.72));
    const scaleMax = Math.max(10, Math.ceil(maxCount * 1.15));

    const now = new Date();
    const isToday = now.getDay() === currentPopularDay;
    const currentHour = now.getHours();

    // If completely clean (0 data across the day), display subtle live status notice
    if (maxCount === 0) {
      ctx.save();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.font = '500 12px Plus Jakarta Sans, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No people recorded yet • Ready to track live CCTV detections', w / 2, pad.top + chartH / 2 - 6);
      ctx.restore();
    }

    // Render bars
    for (let i = 0; i < totalBars; i++) {
      const item = chartHours[i];
      const slotX = pad.left + i * slotW;
      const barX = slotX + (slotW - barW) / 2;

      let barH = 0;
      if (item.avg > 0) {
        barH = Math.max(4, (item.avg / scaleMax) * (chartH - 8));
      }
      const barY = pad.top + chartH - barH;

      const isCurrentHour = isToday && (item.hour === currentHour);
      const isHovered = hoveredPopularSlot === i;

      ctx.save();

      if (barH > 0) {
        // Rounded bar top
        const r = Math.min(4, barW / 2);
        ctx.beginPath();
        ctx.moveTo(barX, pad.top + chartH);
        ctx.lineTo(barX, barY + r);
        ctx.quadraticCurveTo(barX, barY, barX + r, barY);
        ctx.lineTo(barX + barW - r, barY);
        ctx.quadraticCurveTo(barX + barW, barY, barX + barW, barY + r);
        ctx.lineTo(barX + barW, pad.top + chartH);
        ctx.closePath();

        if (isCurrentHour) {
          // Vibrant Glowing Green for Live Current Hour
          ctx.fillStyle = isHovered ? '#4ade80' : '#22c55e';
          ctx.shadowColor = 'rgba(34, 197, 94, 0.7)';
          ctx.shadowBlur = 10;
        } else if (isHovered) {
          // Highlighted Teal
          ctx.fillStyle = '#38bdf8';
          ctx.shadowColor = 'rgba(56, 189, 248, 0.6)';
          ctx.shadowBlur = 8;
        } else {
          // Signature Google Maps teal color (#2a9d8f)
          ctx.fillStyle = '#2a9d8f';
        }

        ctx.fill();

        // If current hour, draw a small live pulsing beacon above it
        if (isCurrentHour) {
          const pulse = (Math.sin(Date.now() / 200) + 1) / 2;
          ctx.beginPath();
          ctx.arc(barX + barW / 2, barY - 7, 3 + pulse * 2, 0, Math.PI * 2);
          ctx.fillStyle = '#4ade80';
          ctx.shadowColor = '#22c55e';
          ctx.shadowBlur = 6;
          ctx.fill();
        }
      } else {
        if (isCurrentHour) {
          // Subtle glowing live dot on the baseline for the current hour
          const pulse = (Math.sin(Date.now() / 200) + 1) / 2;
          ctx.beginPath();
          ctx.arc(barX + barW / 2, pad.top + chartH - 3, 3 + pulse, 0, Math.PI * 2);
          ctx.fillStyle = '#22c55e';
          ctx.shadowColor = 'rgba(34, 197, 94, 0.8)';
          ctx.shadowBlur = 8;
          ctx.fill();
        } else {
          // Subtle dot for 0 count
          ctx.beginPath();
          ctx.arc(barX + barW / 2, pad.top + chartH - 2, 1.5, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
          ctx.fill();
        }
      }

      ctx.restore();
    }

    // Tooltip update
    if (hoveredPopularSlot !== null && hoveredPopularSlot >= 0 && hoveredPopularSlot < totalBars) {
      const item = chartHours[hoveredPopularSlot];
      const slotX = pad.left + hoveredPopularSlot * slotW;
      const barCenterX = slotX + slotW / 2;

      let barH = item.avg > 0 ? Math.max(4, (item.avg / scaleMax) * (chartH - 8)) : 0;
      const barTopY = pad.top + chartH - barH;

      if (popularTooltip) {
        const isCurrent = isToday && (item.hour === currentHour);
        popularTooltip.innerHTML = `
          <div style="font-weight:700; color:var(--accent-cyan); border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:3px; margin-bottom:3px;">
            🕒 ${item.label} ${isCurrent ? '<span style="color:var(--accent-grass); font-size:0.65rem;">● LIVE</span>' : ''}
          </div>
          <div style="display:flex; justify-content:space-between; gap:10px;">
            <span style="color:#a1a1aa;">Average People:</span>
            <strong style="color:#fff;">${item.avg}</strong>
          </div>
          <div style="display:flex; justify-content:space-between; gap:10px;">
            <span style="color:#a1a1aa;">Peak Occupancy:</span>
            <strong style="color:#f59e0b;">${item.peak}</strong>
          </div>
        `;

        const ttX = Math.max(60, Math.min(w - 60, barCenterX));
        const ttY = Math.max(40, barTopY - 10);
        popularTooltip.style.left = `${ttX}px`;
        popularTooltip.style.top = `${ttY}px`;
        popularTooltip.classList.remove('hidden');
      }
    } else {
      if (popularTooltip) popularTooltip.classList.add('hidden');
    }

    ctx.restore();
  }

  // Popular Times Event Listeners
  function setupPopularTimesControls() {
    // Mode Switcher Tabs
    if (btnTabPopularTimes && btnTabLiveGraph) {
      btnTabPopularTimes.addEventListener('click', () => {
        btnTabPopularTimes.classList.add('active');
        btnTabLiveGraph.classList.remove('active');
        if (popularTimesSection) popularTimesSection.style.display = 'flex';
        if (liveGraphSection) liveGraphSection.style.display = 'none';
        renderPopularTimesGraph();
      });

      btnTabLiveGraph.addEventListener('click', () => {
        btnTabLiveGraph.classList.add('active');
        btnTabPopularTimes.classList.remove('active');
        if (popularTimesSection) popularTimesSection.style.display = 'none';
        if (liveGraphSection) liveGraphSection.style.display = 'flex';
        renderPeopleGraph();
      });
    }

    // Day dropdown selector
    if (popularDaySelect) {
      popularDaySelect.addEventListener('change', () => {
        currentPopularDay = parseInt(popularDaySelect.value, 10);
        loadPopularTimesData(currentPopularDay);
      });
    }

    // Previous day arrow
    if (btnPrevDay) {
      btnPrevDay.addEventListener('click', () => {
        currentPopularDay = (currentPopularDay + 6) % 7;
        if (popularDaySelect) popularDaySelect.value = String(currentPopularDay);
        loadPopularTimesData(currentPopularDay);
      });
    }

    // Next day arrow
    if (btnNextDay) {
      btnNextDay.addEventListener('click', () => {
        currentPopularDay = (currentPopularDay + 1) % 7;
        if (popularDaySelect) popularDaySelect.value = String(currentPopularDay);
        loadPopularTimesData(currentPopularDay);
      });
    }

    // Clear data button
    if (btnSeedPopular) {
      btnSeedPopular.addEventListener('click', async () => {
        if (confirm('Clear all recorded people occupancy data and reset to 0?')) {
          try {
            await fetch('/api/people/popular-times/reset', { method: 'POST' });
            try {
              localStorage.removeItem(POPULAR_STORAGE_KEY);
            } catch (_) {}
            popularTimesData = {};
            await loadPopularTimesData(currentPopularDay);
            alert('All local occupancy data cleared and reset to 0.');
          } catch (e) {
            alert('Reset failed: ' + e.message);
          }
        }
      });
    }

    // Export Popular Times CSV
    if (btnExportPopularCsv) {
      btnExportPopularCsv.addEventListener('click', () => {
        const dayObj = popularTimesData[currentPopularDay];
        if (!dayObj || !dayObj.hours || dayObj.hours.length === 0) {
          alert('No hourly data available to export.');
          return;
        }

        let csv = 'Day,Hour_24,Hour_Label,Average_People,Peak_People,Sample_Count\n';
        for (const h of dayObj.hours) {
          csv += `"${dayObj.dayName}",${h.hour},"${h.label}",${h.avgPeople},${h.peakPeople},${h.sampleCount || 10}\n`;
        }

        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ceova_popular_times_${dayObj.dayName.toLowerCase()}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      });
    }

    // Mouse Tracking on Popular Times Canvas
    if (popularChartWrapper) {
      popularChartWrapper.addEventListener('mousemove', (e) => {
        const rect = popularChartWrapper.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const padLeft = 16;
        const padRight = 16;
        const chartW = rect.width - padLeft - padRight;
        const slotW = chartW / 17;

        if (mouseX >= padLeft && mouseX <= (padLeft + chartW)) {
          const slot = Math.floor((mouseX - padLeft) / slotW);
          hoveredPopularSlot = Math.max(0, Math.min(16, slot));
        } else {
          hoveredPopularSlot = null;
        }
        renderPopularTimesGraph();
      });

      popularChartWrapper.addEventListener('mouseleave', () => {
        hoveredPopularSlot = null;
        if (popularTooltip) popularTooltip.classList.add('hidden');
        renderPopularTimesGraph();
      });
    }
  }

  // Apply initial saved preferences
  applyAspectMode(currentAspectMode, false);
  applyFitMode(currentFitMode, false);
  applyRotation(currentRotation, false);

  // Startup Initialization
  setupNetworkAndQR();
  initWebSocket();
  checkActiveCameraOnLoad();
  fetchLivePeopleSummary();
  setupGraphControls();
  setupPopularTimesControls();
  loadPopularTimesData();
  graphAnimationLoop();
})();
