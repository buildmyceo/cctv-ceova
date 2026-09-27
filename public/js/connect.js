/**
 * CEOVA CCTV // Autonomous Camera Discovery Controller
 * public/js/connect.js
 * 
 * Handles user credential input, launches background discovery bot,
 * streams real-time SSE terminal logs, and connects verified camera streams.
 */

(function () {
  'use strict';

  let eventSource = null;
  let isScanning = false;

  // DOM Elements
  const form = document.getElementById('cameraConnectForm');
  const inputUsername = document.getElementById('inputUsername');
  const inputPassword = document.getElementById('inputPassword');
  const inputTargetIp = document.getElementById('inputTargetIp');
  const inputSubnetHint = document.getElementById('inputSubnetHint');
  const btnLaunch = document.getElementById('btnLaunchScan');
  const btnStop = document.getElementById('btnStopScan');
  const btnToggleAdvanced = document.getElementById('btnToggleAdvanced');
  const advancedDrawer = document.getElementById('advancedDrawer');
  const togglePassBtn = document.getElementById('togglePasswordBtn');

  const radarWrapper = document.getElementById('radarWrapper');
  const scanProgressBar = document.getElementById('scanProgressBar');
  const scanPercentText = document.getElementById('scanPercentText');
  const scanStatusText = document.getElementById('scanStatusText');
  const telemetryTerminal = document.getElementById('telemetryTerminal');
  const matchedCamerasContainer = document.getElementById('matchedCamerasContainer');
  const matchedCamerasList = document.getElementById('matchedCamerasList');

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

  // Toggle Advanced Settings Drawer
  btnToggleAdvanced?.addEventListener('click', (e) => {
    e.preventDefault();
    advancedDrawer.classList.toggle('open');
    btnToggleAdvanced.textContent = advancedDrawer.classList.contains('open')
      ? '▲ Hide Network Scope Options'
      : '▼ Advanced: Specific IP or Subnet Scope (Optional)';
  });

  // Form Submit: Launch Background Bot Scan
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (isScanning) return;

    const username = inputUsername.value.trim() || 'admin';
    const password = inputPassword.value;
    const targetIp = inputTargetIp?.value.trim() || null;
    const subnetHint = inputSubnetHint?.value.trim() || null;

    setScanningState(true);
    appendTerminalLine(`Initiating discovery bot for user '${username}'...`, 'host');

    try {
      const res = await fetch('/api/cameras/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          password,
          targetIp,
          subnetHint
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to start camera discovery');
      }

      appendTerminalLine(`Bot scan task ${data.scanId} running in background.`, 'success');
      initEventStream();
    } catch (err) {
      appendTerminalLine(`Error starting discovery: ${err.message}`, 'error');
      setScanningState(false);
    }
  });

  // Stop Scan
  btnStop?.addEventListener('click', async () => {
    try {
      await fetch('/api/cameras/discover/stop', { method: 'POST' });
      appendTerminalLine('Stopping scan...', 'error');
      setScanningState(false);
    } catch (e) {
      console.warn('Failed to stop scan:', e);
    }
  });

  // Initialize Server-Sent Events (SSE) Stream
  function initEventStream() {
    if (eventSource) {
      eventSource.close();
    }

    eventSource = new EventSource('/api/cameras/discover/events');

    eventSource.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        handleBotEvent(event);
      } catch (err) {
        console.error('Error parsing SSE event:', err);
      }
    };

    eventSource.onerror = () => {
      console.warn('SSE connection closed or lost.');
    };
  }

  // Handle Incoming Bot Events
  function handleBotEvent(event) {
    if (event.progress !== undefined) {
      updateProgress(event.progress);
    }

    if (event.status) {
      scanStatusText.textContent = formatStatus(event.status);
    }

    if (event.message) {
      let typeClass = '';
      if (event.type === 'CAMERA_MATCHED' || event.type === 'SCAN_COMPLETED') typeClass = 'success';
      else if (event.type === 'HOST_FOUND') typeClass = 'host';
      else if (event.type === 'SCAN_FAILED') typeClass = 'error';

      appendTerminalLine(event.message, typeClass);
    }

    if (event.type === 'HOST_FOUND' && event.host) {
      addDetectedHostCard(event.host);
    }

    if (event.type === 'CAMERA_MATCHED' && event.camera) {
      addMatchedCameraCard(event.camera);
    }

    if (event.type === 'SCAN_COMPLETED' || event.type === 'SCAN_FAILED') {
      setScanningState(false);
      if (event.cameras && Array.isArray(event.cameras)) {
        event.cameras.forEach(addMatchedCameraCard);
      }
      if (event.discoveredHosts && Array.isArray(event.discoveredHosts)) {
        event.discoveredHosts.forEach(host => {
          addDetectedHostCard(host);
        });
      }
    }
  }

  function setScanningState(scanning) {
    isScanning = scanning;
    btnLaunch.disabled = scanning;
    btnLaunch.innerHTML = scanning 
      ? '<span class="pulse-dot"></span> Autonomous Bot Scanning...' 
      : '⚡ Launch Autonomous Discovery Bot';
    
    if (btnStop) {
      btnStop.style.display = scanning ? 'inline-block' : 'none';
    }

    if (scanning) {
      radarWrapper.classList.add('active');
    } else {
      radarWrapper.classList.remove('active');
    }
  }

  function updateProgress(percent) {
    const val = Math.min(100, Math.max(0, Math.round(percent)));
    scanProgressBar.style.width = `${val}%`;
    scanPercentText.textContent = `${val}%`;
  }

  function formatStatus(status) {
    switch (status) {
      case 'SCANNING_PORTS': return 'SWEEPING CAMERA PORTS (554, 1025, 8000, 37777)';
      case 'ONVIF_DISCOVERY': return 'DISPATCHING ONVIF MULTICAST PROBE';
      case 'RESOLVING_NETWORK': return 'ANALYZING NETWORK INTERFACES';
      case 'TESTING_CREDENTIALS': return 'PROBING MANUFACTURER RTSP STREAM CODES';
      case 'CAMERAS_FOUND': return 'CAMERA(S) VERIFIED & CONNECTED';
      case 'NO_CAMERAS_FOUND': return 'SCAN FINISHED - CHECK DETECTED CAMERAS BELOW';
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

  function addMatchedCameraCard(camera) {
    matchedCamerasContainer.style.display = 'block';

    // Prevent duplicates
    if (document.getElementById(`camCard_${camera.id}`)) return;

    // Remove unverified card for same IP if it exists
    const existingHostCard = document.getElementById(`hostCard_${camera.ip.replace(/\./g, '_')}_${camera.port}`);
    if (existingHostCard) existingHostCard.remove();

    const card = document.createElement('div');
    card.id = `camCard_${camera.id}`;
    card.className = 'camera-match-card';
    card.setAttribute('data-ip', camera.ip);

    // Mask password in displayed URL
    const displayUrl = camera.rtspUrl ? camera.rtspUrl.replace(/:([^:@]+)@/, ':••••@') : camera.rawRtspUrl;

    card.innerHTML = `
      <div class="camera-info">
        <div class="camera-brand-tag">
          <span class="dot"></span>
          ${camera.brand || 'IP CAMERA'} • PORT ${camera.port || 554}
        </div>
        <div class="camera-title">${camera.description || 'Verified Live Stream'} (${camera.ip})</div>
        <div class="camera-rtsp-url" title="${displayUrl}">${displayUrl}</div>
      </div>
      <div>
        <button class="btn-connect-cam" data-id="${camera.id}" data-url="${camera.rtspUrl}">
          📹 Connect & Start Monitoring
        </button>
      </div>
    `;

    matchedCamerasList.appendChild(card);

    // Bind Connect & Monitor Action
    card.querySelector('.btn-connect-cam').addEventListener('click', async () => {
      try {
        const res = await fetch('/api/cameras/connect-matched', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: camera.id,
            name: `${camera.brand} (${camera.ip})`,
            rtspUrl: camera.rtspUrl,
            zoneName: 'SALES_FLOOR'
          })
        });

        if (res.ok) {
          alert(`✅ Camera successfully connected!\nNavigating to CCTV Surveillance Hub...`);
          window.location.href = '/index.html';
        } else {
          const errData = await res.json();
          alert(`Failed to add camera: ${errData.message || 'Quota exceeded'}`);
        }
      } catch (err) {
        alert(`Error connecting camera: ${err.message}`);
      }
    });
  }

  function addDetectedHostCard(host) {
    matchedCamerasContainer.style.display = 'block';

    const cardId = `hostCard_${host.ip.replace(/\./g, '_')}_${host.port}`;
    if (document.getElementById(cardId)) return;

    // Check if this IP is already matched in a green verified card
    const existingMatched = document.querySelector(`[data-ip="${host.ip}"]`);
    if (existingMatched) return;

    const card = document.createElement('div');
    card.id = cardId;
    card.className = 'camera-match-card host-detected-card';
    card.style.background = 'rgba(255, 255, 255, 0.04)';
    card.style.borderColor = 'rgba(56, 189, 248, 0.35)';
    card.style.flexDirection = 'column';
    card.style.alignItems = 'stretch';
    card.style.gap = '12px';

    const isWebcam = (host.brand && host.brand.toLowerCase().includes('webcam')) || (host.port >= 1024 && host.port <= 1040);
    const isDahua = (host.brand && (host.brand.toLowerCase().includes('plus') || host.brand.toLowerCase().includes('dahua'))) || host.port === 554;
    const brandDisplay = host.brand || (isWebcam ? 'IP Webcam' : (host.port === 554 ? 'CCTV Camera' : 'IP Camera'));
    const defaultPath = isWebcam ? '/h264_pcm.sdp' : (isDahua ? '/cam/realmonitor?channel=1&subtype=0' : '/Streaming/Channels/101');

    card.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:flex-start;">
        <div class="camera-info">
          <div class="camera-brand-tag" style="color:var(--accent-sky);">
            <span class="dot" style="background:#0ea5e9;"></span>
            ${brandDisplay} • PORT ${host.port} (${host.service || 'Camera Service'})
          </div>
          <div class="camera-title" style="font-size:0.95rem;">Detected Device: ${host.ip}</div>
          <div style="font-size:0.75rem; color:#94a3b8;">
            Active camera service online on your network. Verify credentials below to stream.
          </div>
        </div>
        <span class="badge" style="background:rgba(56,189,248,0.15); color:#38bdf8; border:1px solid rgba(56,189,248,0.3); font-size:0.7rem; padding:3px 8px; border-radius:6px;">DETECTED</span>
      </div>

      <div style="display:grid; grid-template-columns: 1fr 1fr 1.2fr auto; gap:8px; align-items:center;">
        <div>
          <label style="display:block; font-size:0.68rem; color:#94a3b8; font-weight:600; margin-bottom:3px; text-transform:uppercase;">Username</label>
          <input type="text" class="custom-input card-user-input" value="${inputUsername.value.trim() || 'admin'}" placeholder="Username" style="padding:6px 10px; font-size:0.82rem; height:34px; box-sizing:border-box;" />
        </div>
        <div>
          <label style="display:block; font-size:0.68rem; color:#94a3b8; font-weight:600; margin-bottom:3px; text-transform:uppercase;">Password</label>
          <input type="password" class="custom-input card-pass-input" value="${inputPassword.value}" placeholder="Password" style="padding:6px 10px; font-size:0.82rem; height:34px; box-sizing:border-box;" />
        </div>
        <div>
          <label style="display:block; font-size:0.68rem; color:#94a3b8; font-weight:600; margin-bottom:3px; text-transform:uppercase;">Stream Path</label>
          <input type="text" class="custom-input card-path-input" value="${defaultPath}" placeholder="/path" style="padding:6px 10px; font-size:0.82rem; height:34px; font-family:'JetBrains Mono',monospace; box-sizing:border-box;" />
        </div>
        <div style="align-self:flex-end;">
          <button type="button" class="btn-connect-cam btn-direct-connect" style="padding:7px 16px; font-size:0.82rem; height:34px; white-space:nowrap; display:flex; align-items:center; gap:6px;">
            📹 Connect Stream
          </button>
        </div>
      </div>
      <div class="card-status-msg" style="font-size:0.75rem; color:#ef4444; display:none;"></div>
    `;

    matchedCamerasList.appendChild(card);

    // Bind Direct Connect Button
    const btnDirect = card.querySelector('.btn-direct-connect');
    const inputUser = card.querySelector('.card-user-input');
    const inputPass = card.querySelector('.card-pass-input');
    const inputP = card.querySelector('.card-path-input');
    const statusMsg = card.querySelector('.card-status-msg');

    btnDirect.addEventListener('click', async () => {
      btnDirect.disabled = true;
      btnDirect.innerHTML = '<span class="pulse-dot"></span> Connecting...';
      statusMsg.style.display = 'none';

      try {
        const u = inputUser.value.trim();
        const p = inputPass.value;
        const targetPath = inputP.value.trim();

        const res = await fetch('/api/cameras/connect-matched', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ip: host.ip,
            port: host.port,
            path: targetPath,
            username: u,
            password: p,
            name: `${brandDisplay} (${host.ip})`,
            zoneName: 'SALES_FLOOR'
          })
        });

        const data = await res.json();
        if (res.ok) {
          appendTerminalLine(`✓ Successfully connected stream for ${brandDisplay} (${host.ip})!`, 'success');
          alert(`✅ Camera connected successfully!\nStreaming live video at CCTV Surveillance Hub.`);
          window.location.href = '/index.html';
        } else {
          statusMsg.textContent = data.message || data.error || 'Connection failed';
          statusMsg.style.display = 'block';
          btnDirect.disabled = false;
          btnDirect.innerHTML = '📹 Connect Stream';
        }
      } catch (err) {
        statusMsg.textContent = err.message;
        statusMsg.style.display = 'block';
        btnDirect.disabled = false;
        btnDirect.innerHTML = '📹 Connect Stream';
      }
    });
  }

  // Quick Demo Simulation Trigger (if no physical camera currently on network)
  document.getElementById('btnSimulateCamera')?.addEventListener('click', () => {
    appendTerminalLine('Simulating local CCTV stream verification (Demo Mode)...', 'host');
    setTimeout(() => {
      addMatchedCameraCard({
        id: 'CAM_DEMO_1080P',
        ip: '10.12.56.168',
        port: 554,
        brand: 'Hikvision',
        description: 'Main Stream 1080p (Simulated Stream)',
        rtspUrl: `rtsp://${encodeURIComponent(inputUsername.value || 'admin')}:${encodeURIComponent(inputPassword.value || 'pass123')}@10.12.56.168:554/Streaming/Channels/101`,
        rawRtspUrl: 'rtsp://10.12.56.168:554/Streaming/Channels/101'
      });
      appendTerminalLine('🎯 Verified Hikvision stream at rtsp://10.12.56.168:554/Streaming/Channels/101!', 'success');
      scanStatusText.textContent = 'CAMERA(S) VERIFIED & CONNECTED';
      updateProgress(100);
      setScanningState(false);
    }, 1200);
  });

  // Check initial bot status on page load
  fetch('/api/cameras/discover/status')
    .then(r => r.json())
    .then(data => {
      if (data.isScanning) {
        setScanningState(true);
        updateProgress(data.progress);
        scanStatusText.textContent = formatStatus(data.status);
        if (data.logs) {
          data.logs.forEach(l => appendTerminalLine(l));
        }
        if (data.matchedCameras) {
          data.matchedCameras.forEach(addMatchedCameraCard);
        }
        initEventStream();
      } else {
        if (data.matchedCameras && data.matchedCameras.length > 0) {
          data.matchedCameras.forEach(addMatchedCameraCard);
        }
        if (data.discoveredHosts && data.discoveredHosts.length > 0) {
          data.discoveredHosts.forEach(addDetectedHostCard);
        }
      }
    })
    .catch(() => {});

})();
