/**
 * CEOVA CCTV // Loopback Background Agent Service
 * services/loopback_agent.js
 * 
 * Binds strictly to 127.0.0.1:8085.
 * Provides health checks, telemetry, and monitoring controls to CEOVA Desktop.
 * 
 * Security Guardrails:
 * - Binds to loopback (127.0.0.1) exclusively.
 * - Authenticated via local loopback bearer token.
 * - Strict origin & client validation.
 * - Decoupled: Never leaks raw credentials or accesses main app storage directly.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { getDatabase, resolveDataDir } = require('../db/database');
const { getYoloBridge } = require('../vision/detection/yolo_bridge');
const pkg = require('../package.json');

const LOOPBACK_PORT = process.env.CCTV_AGENT_PORT ? parseInt(process.env.CCTV_AGENT_PORT, 10) : 8085;
const LOOPBACK_HOST = '127.0.0.1';

class LoopbackAgent {
  constructor(options = {}) {
    this.port = options.port || LOOPBACK_PORT;
    this.host = LOOPBACK_HOST;
    this.server = null;
    this.isMonitoring = true;
    this.startTime = Date.now();
    this.token = this._loadOrCreateToken();
    this.db = null;
    this.yoloBridge = getYoloBridge();
  }

  _loadOrCreateToken() {
    try {
      const dataDir = resolveDataDir();
      const configDir = path.join(dataDir, 'config');
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
      }
      const tokenPath = path.join(configDir, 'loopback.token');
      if (fs.existsSync(tokenPath)) {
        const existing = fs.readFileSync(tokenPath, 'utf8').trim();
        if (existing && existing.length >= 32) {
          return existing;
        }
      }
      // Generate 32-byte cryptographically secure token
      const newToken = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(tokenPath, newToken, { mode: 0o600, encoding: 'utf8' });
      try { fs.chmodSync(tokenPath, 0o600); } catch (_e) {}
      return newToken;
    } catch (err) {
      console.error('[AGENT_8085] Critical error managing loopback token:', err.message);
      // Generate ephemeral high-entropy token in memory
      return crypto.randomBytes(32).toString('hex');
    }
  }

  _isLoopback(req) {
    const remoteIp = req.socket.remoteAddress || '';
    return remoteIp === '127.0.0.1' || 
           remoteIp === '::1' || 
           remoteIp === '::ffff:127.0.0.1' ||
           remoteIp.endsWith('127.0.0.1');
  }

  _validateHost(req) {
    const hostHeader = (req.headers['host'] || '').toLowerCase();
    if (!hostHeader) return false;
    const allowed = [
      `127.0.0.1:${this.port}`,
      `localhost:${this.port}`,
      '127.0.0.1',
      'localhost'
    ];
    return allowed.includes(hostHeader);
  }

  _validateOrigin(req) {
    const origin = req.headers['origin'];
    if (!origin) {
      // Non-browser direct IPC (curl, Node script, native CLI) is permitted
      return { allowed: true, origin: null };
    }
    const originLower = origin.toLowerCase();
    const allowedPrefixes = [
      'tauri://localhost',
      `http://127.0.0.1:`,
      `http://localhost:`,
      `https://127.0.0.1:`,
      `https://localhost:`
    ];
    const isAllowed = allowedPrefixes.some(prefix => originLower.startsWith(prefix));
    return { allowed: isAllowed, origin: isAllowed ? origin : null };
  }

  _verifyAuth(req) {
    // 1. Check loopback IP binding
    if (!this._isLoopback(req)) {
      return { ok: false, status: 403, error: 'Forbidden: Loopback interface only' };
    }

    // 2. DNS Rebinding Protection: Verify Host header
    if (!this._validateHost(req)) {
      return { ok: false, status: 403, error: 'Forbidden: Invalid Host header (DNS rebinding rejected)' };
    }

    // 3. Origin & CSRF Protection
    const originCheck = this._validateOrigin(req);
    if (!originCheck.allowed) {
      return { ok: false, status: 403, error: 'Forbidden: Untrusted Origin' };
    }

    // 4. Client header check if provided
    const clientHeader = req.headers['x-ceova-client'];
    if (clientHeader && clientHeader !== 'ceova-main-app' && clientHeader !== 'ceova-test-suite') {
      return { ok: false, status: 403, error: 'Forbidden: Invalid client header' };
    }

    // 5. Strict Bearer token verification using constant-time comparison
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      return { ok: false, status: 401, error: 'Unauthorized: Missing Authorization header' };
    }

    if (!authHeader.startsWith('Bearer ')) {
      return { ok: false, status: 401, error: 'Unauthorized: Invalid Authorization scheme' };
    }

    const providedToken = authHeader.slice(7).trim();
    const tokenBuf = Buffer.from(providedToken, 'utf8');
    const secretBuf = Buffer.from(this.token, 'utf8');

    if (tokenBuf.length !== secretBuf.length || !crypto.timingSafeEqual(tokenBuf, secretBuf)) {
      return { ok: false, status: 401, error: 'Unauthorized: Invalid authentication token' };
    }

    return { ok: true, origin: originCheck.origin };
  }

  async getHealthStatus() {
    let aiEngineHealthy = false;
    let cameraCount = 0;

    try {
      if (!this.db) {
        this.db = getDatabase();
      }
      const cameras = this.db.getCameras('ORG-DEFAULT');
      cameraCount = Array.isArray(cameras) ? cameras.length : 0;
    } catch (_err) {
      // DB not ready or empty
    }

    try {
      const yoloHealth = await this.yoloBridge.checkHealth();
      aiEngineHealthy = !!yoloHealth.ok;
    } catch (_err) {
      aiEngineHealthy = false;
    }

    return {
      running: true,
      monitoring: this.isMonitoring,
      aiEngineHealthy,
      cameraCount,
      version: pkg.version || '1.0.0',
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      timestamp: new Date().toISOString(),
      service: 'ceova-cctv-agent',
      port: this.port
    };
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        const originCheck = this._validateOrigin(req);
        if (originCheck.origin) {
          res.setHeader('Access-Control-Allow-Origin', originCheck.origin);
          res.setHeader('Vary', 'Origin');
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Ceova-Client, X-Ceova-Origin');
        }

        if (req.method === 'OPTIONS') {
          if (!originCheck.allowed) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Forbidden: Untrusted Origin' }));
          }
          res.writeHead(204);
          return res.end();
        }

        const auth = this._verifyAuth(req);
        if (!auth.ok) {
          res.writeHead(auth.status, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: auth.error }));
        }

        const url = req.url.split('?')[0];

        // 1. GET /api/status or /health
        if (req.method === 'GET' && (url === '/api/status' || url === '/health')) {
          const status = await this.getHealthStatus();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(status));
        }

        // 2. POST /api/monitoring/start
        if (req.method === 'POST' && url === '/api/monitoring/start') {
          this.isMonitoring = true;
          console.log('[AGENT_8085] Monitoring mode resumed');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true, monitoring: true }));
        }

        // 3. POST /api/monitoring/pause
        if (req.method === 'POST' && url === '/api/monitoring/pause') {
          this.isMonitoring = false;
          console.log('[AGENT_8085] Monitoring mode paused');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true, monitoring: false }));
        }

        // 4. POST /api/service/stop
        if (req.method === 'POST' && url === '/api/service/stop') {
          console.log('[AGENT_8085] Received authorized stop command');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Stopping service' }));

          setTimeout(() => {
            this.stop();
            process.exit(0);
          }, 300);
          return;
        }

        // 5. POST /api/service/restart
        if (req.method === 'POST' && url === '/api/service/restart') {
          console.log('[AGENT_8085] Received authorized restart command');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Restarting service' }));

          setTimeout(() => {
            this.stop();
            // Exit code 42 indicates intentional restart to supervisor
            process.exit(42);
          }, 300);
          return;
        }

        // Fallback 404
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Endpoint not found' }));
      });

      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.warn(`[AGENT_8085] Port ${this.port} is already in use.`);
        }
        reject(err);
      });

      this.server.listen(this.port, this.host, () => {
        console.log(`[AGENT_8085] CEOVA CCTV Loopback Agent active on http://${this.host}:${this.port}`);
        resolve(this);
      });
    });
  }

  stop() {
    if (this.server) {
      try {
        this.server.close();
      } catch (_e) {}
      this.server = null;
    }
  }
}

let agentInstance = null;
function getLoopbackAgent(port = LOOPBACK_PORT) {
  if (!agentInstance) {
    agentInstance = new LoopbackAgent({ port });
  }
  return agentInstance;
}

module.exports = {
  LoopbackAgent,
  getLoopbackAgent
};

if (require.main === module) {
  const agent = getLoopbackAgent();
  agent.start().catch((err) => {
    console.error('[AGENT_8085] Failed to start:', err.message);
    process.exit(1);
  });
}
