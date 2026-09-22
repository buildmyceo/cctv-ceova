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

const localIps = getLocalIpAddresses();
const primaryIp = localIps[0] || '127.0.0.1';

// Setup or load SSL certificates for HTTPS (Required for phone camera getUserMedia access)
const sslDir = path.join(__dirname, 'ssl');
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

// Create HTTP Server (Secondary / Redirect or local fallback)
const httpServer = http.createServer((req, res) => {
  // Redirect HTTP to HTTPS for camera security compatibility
  const host = req.headers.host ? req.headers.host.split(':')[0] : primaryIp;
  res.writeHead(301, { Location: `https://${host}:${PORT}${req.url}` });
  res.end();
});

// WebSocket Signaling Server attached to HTTPS
const wss = new WebSocketServer({ server: httpsServer });

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

// Mount CEOVA AI Bot Architecture
const { registry, hardwareBot, performanceSchedulerBot, trackingBot, adaptiveInferenceBot } = require('./bots');

// Initialize all bots on startup
registry.initializeAll().catch(err => {
  console.error('[BotRegistry] Error initializing bots:', err);
});

// Clean shutdown handler
process.on('SIGINT', () => {
  yoloBridge.stop();
  process.exit(0);
});
process.on('SIGTERM', () => {
  yoloBridge.stop();
  process.exit(0);
});

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
            
            // Check if broadcaster is already active
            if (room.broadcasters.size > 0) {
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
httpsServer.listen(PORT, '0.0.0.0', () => {
  const localUrl = `https://localhost:${PORT}`;
  const lanUrl = `https://${primaryIp}:${PORT}`;
  const defaultCameraUrl = `https://${primaryIp}:${PORT}/camera.html?room=CAM-1`;

  console.log('\n=============================================================');
  console.log('  🎥 CEOVA CCTV CAMERA & PHONE STREAMING SERVER STARTED');
  console.log('=============================================================');
  console.log(`  🖥️  Desktop Web CCTV Hub:    ${localUrl}`);
  console.log(`  📶  LAN Network URL:         ${lanUrl}`);
  console.log(`  📱  Direct Phone Stream:     ${defaultCameraUrl}`);
  console.log('=============================================================');
  console.log('  📲 SCAN THIS QR CODE WITH YOUR PHONE CAMERA TO CONNECT:');
  console.log('-------------------------------------------------------------');
  qrcodeTerminal.generate(defaultCameraUrl, { small: true });
  console.log('-------------------------------------------------------------');
  console.log('  💡 NOTE: When opening on your phone for the first time,');
  console.log('     tap "Advanced" -> "Proceed" to accept local HTTPS cert.');
  console.log('=============================================================\n');
});

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`  🔄  HTTP to HTTPS Redirector running on port ${HTTP_PORT}`);
});
