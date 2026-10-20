const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const selfsigned = require('selfsigned');

const app = express();
const PORT = process.env.PORT || 3443;
const HTTP_PORT = process.env.HTTP_PORT || 3080;

// Auto-detect local network IPv4 address
function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

const { resolveDataDir } = require('./db/database');

const localIps = getLocalIpAddresses();
const primaryIp = localIps[0] || '127.0.0.1';

// Setup or load SSL certificates for HTTPS (Stored in application data dir)
const dataDir = resolveDataDir();
const sslDir = path.join(dataDir, 'ssl');
if (!fs.existsSync(sslDir)) {
  fs.mkdirSync(sslDir, { recursive: true });
}

const keyPath = path.join(sslDir, 'server.key');
const certPath = path.join(sslDir, 'server.cert');

let sslOptions;
if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  sslOptions = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
  };
} else {
  console.log('Generating self-signed SSL certificate for local HTTPS...');
  const attrs = [{ name: 'commonName', value: primaryIp }];
  const pems = selfsigned.generate(attrs, {
    days: 365,
    keySize: 2048,
    algorithm: 'sha256'
  });
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  sslOptions = {
    key: pems.private,
    cert: pems.cert
  };
}

// Dedicated CCTV connect & human detection route
app.get('/connect', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'connect.html'));
});

// CORS middleware for desktop app and cross-origin embedding
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// API: Network info for frontend configuration
app.get('/api/info', (req, res) => {
  res.json({
    primaryIp,
    ips: localIps,
    port: PORT,
    httpPort: HTTP_PORT,
    protocol: 'https'
  });
});

// API: Generate QR Code data URL for any custom URL or Room
app.get('/api/qr', async (req, res) => {
  const text = req.query.text;
  if (!text) {
    return res.status(400).json({ error: 'Missing text query parameter' });
  }
  try {
    const dataUrl = await QRCode.toDataURL(text, {
      margin: 1.5,
      width: 380,
      color: {
        dark: '#000000',
        light: '#ffffff'
      }
    });
    res.json({ dataUrl });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// Create HTTPS Server (Primary)
const httpsServer = https.createServer(sslOptions, app);

// Create HTTP Server (Direct serving for loopback / desktop app; redirect remote LAN to HTTPS for camera access)
const httpServer = http.createServer((req, res) => {
  const host = req.headers.host ? req.headers.host.split(':')[0] : primaryIp;
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (isLoopback) {
    return app(req, res);
  }
  res.writeHead(301, { Location: `https://${host}:${PORT}${req.url}` });
  res.end();
});

// WebSocket Signaling Server attached to both HTTPS and HTTP
const wss = new WebSocketServer({ noServer: true });

function handleUpgrade(request, socket, head) {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
}

httpsServer.on('upgrade', handleUpgrade);
httpServer.on('upgrade', handleUpgrade);

// Rooms map: roomId -> { viewers: Set(ws), broadcasters: Set(ws) }
const rooms = new Map();

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      viewers: new Set(),
      broadcasters: new Set(),
      meta: { createdAt: Date.now() }
    });
  }
  return rooms.get(roomId);
}

function broadcastToRoom(roomId, senderWs, data, targetRole = null) {
  const room = rooms.get(roomId);
  if (!room) return;

  const targets = [];
  if (!targetRole || targetRole === 'viewer') {
    room.viewers.forEach(ws => targets.push(ws));
  }
  if (!targetRole || targetRole === 'broadcaster') {
    room.broadcasters.forEach(ws => targets.push(ws));
  }

  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  for (const client of targets) {
    if (client !== senderWs && client.readyState === 1) { // WebSocket.OPEN
      client.send(payload);
    }
  }
}

// Broadcast identity events over WebSocket to all active viewer monitors
function broadcastIdentityEvent(eventPayload) {
  for (const [roomId, room] of rooms.entries()) {
    broadcastToRoom(roomId, null, {
      type: 'identity-event',
      event: eventPayload
    }, 'viewer');
  }
}

// Mount Recognition & Identity Engine API Routes
const { createIdentityRouter } = require('./api/identity_routes');
const { getYoloBridge } = require('./vision/detection/yolo_bridge');
const yoloBridge = getYoloBridge();

// Start YOLOv8 & OpenCV deep vision engine in the background
yoloBridge.start().catch(err => {
  console.warn('[SERVER] YOLO service notice:', err.message);
});

const identityModule = createIdentityRouter({ broadcastCallback: broadcastIdentityEvent });
app.use('/api', identityModule.router);

// Mount Ceova Ecosystem Private API & SSO Routes
const { createCeovaInternalRouter } = require('./api/ceova_internal_routes');
const ceovaInternalRouter = createCeovaInternalRouter();
app.use(ceovaInternalRouter);

// Mount Autonomous Camera Discovery Bot Routes
const { createCameraDiscoveryRouter } = require('./api/camera_discovery_routes');
const { rtspStreamManager } = require('./services/rtsp_stream_manager');
const cameraDiscoveryRouter = createCameraDiscoveryRouter();
app.use(cameraDiscoveryRouter);

app.get('/api/cctv/token', (req, res) => {
  try {
    const agent = require('./services/loopback_agent').getLoopbackAgent();
    res.json({ success: true, token: agent.token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const { pipeHttpCameraStream } = require('./services/http_camera_client');

// HTTP Video Stream Proxy — forwards IP Webcam (Android) streams to the browser
// Supports both Basic Auth and RFC 2617 Digest Auth seamlessly
app.get('/api/proxy-stream', (req, res) => {
  let streamUrl = req.query.url;
  const camId = req.query.camId;

  if (!streamUrl && camId) {
    try {
      const { getDatabase } = require('./db/database');
      const db = getDatabase();
      const cam = db.getCamera(camId);
      if (cam && cam.stream_url) {
        streamUrl = cam.stream_url;
      }
    } catch (_e) {}
  }

  if (!streamUrl) return res.status(400).json({ error: 'Missing stream endpoint or camera ID' });

  if (streamUrl.startsWith('/api/proxy-stream?url=')) {
    streamUrl = decodeURIComponent(streamUrl.replace('/api/proxy-stream?url=', ''));
  }

  try {
    pipeHttpCameraStream(streamUrl, res, req);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to proxy camera stream', details: err.message });
    }
  }
});

// Forward live RTSP camera frames over WebSockets to all viewer rooms
rtspStreamManager.setWsBroadcastCallback((msg) => {
  for (const [roomId, room] of rooms.entries()) {
    broadcastToRoom(roomId, null, msg, 'viewer');
  }
});

// Auto-start primary camera RTSP stream from database if available
setTimeout(() => {
  try {
    const { getDatabase } = require('./db/database');
    const db = getDatabase();
    const defaultOrg = 'ORG-DEFAULT';
    const cameras = db.getCameras(defaultOrg);
    if (cameras && cameras.length > 0) {
      const primaryCam = cameras[0];
      const isRtsp = primaryCam.stream_url && (primaryCam.stream_url.startsWith('rtsp://') || primaryCam.stream_url.startsWith('rtsps://'));
      if (isRtsp) {
        console.log(`[RTSP] Auto-starting primary camera: ${primaryCam.name} (${primaryCam.id})`);
        rtspStreamManager.startStream(primaryCam.id, primaryCam.stream_url);
      } else {
        console.log(`[RTSP] Skipping auto-start for HTTP camera: ${primaryCam.name}`);
      }
    }
  } catch (err) {
    console.warn('[RTSP] Failed to auto-start primary camera:', err.message);
  }
}, 1500);

// Mount CEOVA AI Bot Architecture
const { registry, hardwareBot, performanceSchedulerBot, trackingBot, adaptiveInferenceBot } = require('./bots');

// Initialize all bots on startup
registry.initializeAll().catch(err => {
  console.error('[BotRegistry] Error initializing bots:', err);
});

// Clean shutdown handler
function cleanShutdown() {
  try { rtspStreamManager.stopAll(); } catch (_e) {}
  try { yoloBridge.stop(); } catch (_e) {}
  try {
    const { getLoopbackAgent } = require('./services/loopback_agent');
    getLoopbackAgent().stop();
  } catch (_e) {}
  try { wss.close(); } catch (_e) {}
  try { httpsServer.close(); } catch (_e) {}
  try { httpServer.close(); } catch (_e) {}
  setTimeout(() => process.exit(0), 100);
}

process.on('SIGINT', cleanShutdown);
process.on('SIGTERM', cleanShutdown);

// Bot Management & Telemetry APIs
app.get('/api/bots/health', (req, res) => {
  res.json({
    timestamp: Date.now(),
    bots: registry.getAllHealth()
  });
});

app.get('/api/hardware/profile', async (req, res) => {
  const result = await hardwareBot.execute({});
  res.json(result);
});

app.get('/api/scheduler/status', (req, res) => {
  res.json({
    status: performanceSchedulerBot.getSchedulerStatus()
  });
});

app.post('/api/scheduler/camera', (req, res) => {
  const { cameraId, priority, zoneName } = req.body;
  if (!cameraId) {
    return res.status(400).json({ error: 'Missing cameraId' });
  }
  performanceSchedulerBot.registerCamera(cameraId, { priority, zoneName });
  res.json({
    success: true,
    camera: performanceSchedulerBot.cameras.get(cameraId)
  });
});

wss.on('connection', (ws, req) => {
  let currentRoomId = null;
  let clientRole = null; // 'viewer' or 'broadcaster'

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case 'join': {
          currentRoomId = data.roomId;
          clientRole = data.role; // 'viewer' or 'broadcaster'
          ws.roomId = currentRoomId;
          ws.role = clientRole;

          const room = getOrCreateRoom(currentRoomId);
          if (clientRole === 'viewer') {
            room.viewers.add(ws);
            console.log(`[Room ${currentRoomId}] Viewer connected. Total viewers: ${room.viewers.size}`);
            
            // Check if RTSP camera stream or phone broadcaster is already active
            if (rtspStreamManager.activeCameraId) {
              const activeStream = rtspStreamManager.getStream(rtspStreamManager.activeCameraId);
              ws.send(JSON.stringify({
                type: 'status',
                status: 'broadcaster-ready',
                source: 'rtsp',
                cameraId: rtspStreamManager.activeCameraId,
                streamUrl: `/api/cameras/${rtspStreamManager.activeCameraId}/stream.mjpg`,
                fps: activeStream ? activeStream.fps : 15
              }));
            } else if (room.broadcasters.size > 0) {
              ws.send(JSON.stringify({
                type: 'status',
                status: 'broadcaster-ready',
                broadcasterCount: room.broadcasters.size
              }));
            }
          } else if (clientRole === 'broadcaster') {
            room.broadcasters.add(ws);
            console.log(`[Room ${currentRoomId}] Phone camera connected. Total broadcasters: ${room.broadcasters.size}`);
            
            // Notify viewers that phone camera is online
            broadcastToRoom(currentRoomId, ws, {
              type: 'peer-joined',
              role: 'broadcaster'
            }, 'viewer');

            ws.send(JSON.stringify({
              type: 'status',
              status: 'connected',
              viewerCount: room.viewers.size
            }));
          }
          break;
        }

        // WebRTC Signaling: Offer, Answer, ICE Candidates
        case 'offer':
        case 'answer':
        case 'candidate': {
          if (currentRoomId) {
            // Route WebRTC messages to the opposite role in the room
            const targetRole = clientRole === 'viewer' ? 'broadcaster' : 'viewer';
            broadcastToRoom(currentRoomId, ws, data, targetRole);
          }
          break;
        }

        // Remote Camera Controls (Viewer -> Broadcaster)
        // action: 'toggle-torch', 'switch-camera', 'set-resolution', etc.
        case 'command': {
          if (currentRoomId && clientRole === 'viewer') {
            broadcastToRoom(currentRoomId, ws, data, 'broadcaster');
          }
          break;
        }

        // Broadcaster camera status update (Broadcaster -> Viewer)
        // e.g. torchStatus, battery, activeLens, facingMode
        case 'camera-info': {
          if (currentRoomId && clientRole === 'broadcaster') {
            broadcastToRoom(currentRoomId, ws, data, 'viewer');
          }
          break;
        }

        // Fallback frame streaming (Broadcaster -> Viewer) when WebRTC cannot establish
        case 'frame': {
          if (currentRoomId && clientRole === 'broadcaster') {
            broadcastToRoom(currentRoomId, ws, data, 'viewer');
          }
          break;
        }

        // Ping / Heartbeat
        case 'ping': {
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;
        }

        default:
          break;
      }
    } catch (e) {
      console.error('Error handling WebSocket message:', e.message);
    }
  });

  ws.on('close', () => {
    if (currentRoomId && rooms.has(currentRoomId)) {
      const room = rooms.get(currentRoomId);
      if (clientRole === 'viewer') {
        room.viewers.delete(ws);
        console.log(`[Room ${currentRoomId}] Viewer disconnected.`);
      } else if (clientRole === 'broadcaster') {
        room.broadcasters.delete(ws);
        console.log(`[Room ${currentRoomId}] Phone camera disconnected.`);
        // Notify viewers
        broadcastToRoom(currentRoomId, ws, {
          type: 'peer-left',
          role: 'broadcaster'
        }, 'viewer');
      }

      // Clean up empty room
      if (room.viewers.size === 0 && room.broadcasters.size === 0) {
        rooms.delete(currentRoomId);
        console.log(`[Room ${currentRoomId}] Room closed.`);
      }
    }
  });
});

// Start Servers
httpsServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.warn(`[SERVER] HTTPS Port ${PORT} already in use. Exiting cleanly.`);
    process.exit(0);
  }
});
httpServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.warn(`[SERVER] HTTP Port ${HTTP_PORT} already in use. Exiting cleanly.`);
    process.exit(0);
  }
});

httpsServer.listen(PORT, '0.0.0.0', () => {
  const localUrl = `https://localhost:${PORT}`;
  const lanUrl = `https://${primaryIp}:${PORT}`;
  const defaultCameraUrl = `https://${primaryIp}:${PORT}/camera.html?room=CAM-1`;

  console.log('\n=============================================================');
  console.log('  🎥 CEOVA VISION CCTV // AUTONOMOUS SURVEILLANCE ENGINE');
  console.log('=============================================================');
  console.log(`  🖥️  Desktop Web CCTV Hub:    ${localUrl}`);
  console.log(`  📡  Camera Discovery Radar:  ${localUrl}/connect.html`);
  console.log(`  📶  LAN Network URL:         ${lanUrl}`);
  console.log('=============================================================');
  console.log('  🔐 MODE: Autonomous CCTV Admin & Password Bot Discovery');
  console.log('  ⚡ Network Sweeper & RTSP Stream Authenticator Active');
  console.log('=============================================================\n');
});

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`  🔄  HTTP to HTTPS Redirector running on port ${HTTP_PORT}`);
});

// Start CEOVA Desktop Loopback Agent (Port 8085)
const { getLoopbackAgent } = require('./services/loopback_agent');
const loopbackAgent = getLoopbackAgent();
loopbackAgent.start().catch(err => {
  console.warn('[AGENT_8085] Notice:', err.message);
});

// Background Surveillance Report Generator
function runBackgroundReportTask() {
  try {
    const { getDatabase } = require('./db/database');
    const db = getDatabase();
    const creds = typeof db.getLocalCredentials === 'function' ? db.getLocalCredentials() : null;
    const cameras = typeof db.getCameras === 'function' ? db.getCameras('ORG-DEFAULT') : [];
    const primaryCam = cameras[0];
    const ip = creds?.ip || (primaryCam?.name?.match(/\(([^\:]+)/)?.[1]) || (primaryCam?.ip) || 'Local Network';
    const name = primaryCam?.name || 'Main Camera';

    let totalDetections = 0;
    let peakOccupancy = 0;
    try {
      const recentSamples = db.all("SELECT * FROM occupancy_history_samples WHERE timestamp > ? ORDER BY timestamp DESC", [Date.now() - 3600000]) || [];
      if (recentSamples.length > 0) {
        totalDetections = recentSamples.reduce((sum, s) => sum + (s.total_count || 0), 0);
        peakOccupancy = Math.max(...recentSamples.map(s => s.total_count || 0));
      }
    } catch (_e) {}

    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const isConn = cameras.length > 0;
    const summary = isConn
      ? `Surveillance report (${timeStr}): Camera "${name}" (IP: ${ip}) is ONLINE & CONNECTED. Total recent detections: ${totalDetections}, Peak occupancy: ${peakOccupancy} person(s). Credentials and stream data are secured locally on this device.`
      : `Surveillance report (${timeStr}): Background CCTV daemon is active in standby mode. No camera is currently streaming. Target IP: ${ip}.`;

    if (typeof db.saveBackgroundReport === 'function') {
      db.saveBackgroundReport({
        id: `rep_${Date.now()}`,
        timestamp: now.toISOString(),
        camera_ip: ip,
        camera_name: name,
        total_detections: totalDetections,
        peak_occupancy: peakOccupancy,
        incident_count: 0,
        summary,
        report_data: {
          cameraCount: cameras.length,
          cameras: cameras.map(c => ({ id: c.id, name: c.name, stream_url: c.stream_url })),
          savedIp: ip,
          savedUsername: creds?.username || 'admin',
          generatedAt: now.toISOString()
        }
      });
      console.log(`[CCTV-REPORT] ${summary}`);
    }
  } catch (err) {
    console.warn('[CCTV-REPORT] Background report notice:', err.message);
  }
}

// Initial report 2 seconds after startup, then recurring every 10 minutes
setTimeout(runBackgroundReportTask, 2000);
setInterval(runBackgroundReportTask, 10 * 60 * 1000);

