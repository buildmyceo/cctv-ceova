/**
 * CEOVA CCTV // Vision Engine
 * vision/detection/yolo_bridge.js
 * 
 * Node.js bridge to the high-performance Python YOLOv8 & OpenCV Service.
 * Manages service lifecycle, health checks, frame detection, and feature extraction.
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

class YoloBridge {
  constructor(options = {}) {
    this.port = options.port || 5055;
    this.host = options.host || '127.0.0.1';
    this.baseUrl = `http://${this.host}:${this.port}`;
    this.pythonProcess = null;
    this.isAvailable = false;
    this.device = 'unknown';
    this.modelName = 'yolov8n';
    this.autoStart = options.autoStart !== false;
    this.lastHealthCheck = 0;
  }

  /**
   * Check if YOLO service is running
   */
  async checkHealth() {
    return new Promise((resolve) => {
      const req = http.get(`${this.baseUrl}/health`, { timeout: 1500 }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const json = JSON.parse(data);
              this.isAvailable = true;
              this.device = json.device || 'cpu';
              this.modelName = json.model || 'yolov8n';
              this.lastHealthCheck = Date.now();
              return resolve({ ok: true, info: json });
            } catch (e) {
              this.isAvailable = false;
              return resolve({ ok: false, error: 'Invalid JSON' });
            }
          }
          this.isAvailable = false;
          resolve({ ok: false, status: res.statusCode });
        });
      });

      req.on('error', (err) => {
        this.isAvailable = false;
        resolve({ ok: false, error: err.message });
      });

      req.on('timeout', () => {
        req.destroy();
        this.isAvailable = false;
        resolve({ ok: false, error: 'Timeout' });
      });
    });
  }

  /**
   * Start the YOLO service if not already running
   */
  async start() {
    const health = await this.checkHealth();
    if (health.ok) {
      console.log(`[YOLO_BRIDGE] Connected to existing YOLOv8 service on ${this.baseUrl} (${this.device.toUpperCase()})`);
      return true;
    }

    if (!this.autoStart) {
      console.log('[YOLO_BRIDGE] YOLO service not running and autoStart disabled.');
      return false;
    }

    console.log('[YOLO_BRIDGE] Spawning Python YOLOv8 & OpenCV Service on port', this.port);
    const serviceScript = path.join(__dirname, '..', 'yolo_service.py');

    try {
      this.pythonProcess = spawn('python3', [serviceScript], {
        cwd: path.join(__dirname, '..', '..'),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false
      });

      this.pythonProcess.stdout.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) console.log(`[YOLO_PROC] ${msg}`);
      });

      this.pythonProcess.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg && !msg.includes('INFO:') && !msg.includes('WARNING:')) {
          console.warn(`[YOLO_PROC_ERR] ${msg}`);
        }
      });

      this.pythonProcess.on('exit', (code, signal) => {
        console.log(`[YOLO_BRIDGE] YOLO Python process exited with code ${code} (${signal})`);
        this.isAvailable = false;
        this.pythonProcess = null;
      });

      // Poll until ready (up to 8 seconds)
      for (let i = 0; i < 16; i++) {
        await new Promise(r => setTimeout(r, 500));
        const res = await this.checkHealth();
        if (res.ok) {
          console.log(`[YOLO_BRIDGE] YOLOv8 service is READY on ${this.baseUrl} (${this.device.toUpperCase()})`);
          return true;
        }
      }

      console.warn('[YOLO_BRIDGE] Timed out waiting for YOLO service to initialize');
      return false;
    } catch (err) {
      console.error('[YOLO_BRIDGE] Failed to spawn YOLO service:', err);
      return false;
    }
  }

  /**
   * Stop the child process
   */
  stop() {
    if (this.pythonProcess) {
      console.log('[YOLO_BRIDGE] Stopping YOLO service process...');
      this.pythonProcess.kill('SIGTERM');
      this.pythonProcess = null;
    }
    this.isAvailable = false;
  }

  /**
   * Perform HTTP POST to YOLO service
   */
  async _postJson(endpoint, body, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const options = {
        hostname: this.host,
        port: this.port,
        path: endpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: timeoutMs
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(data);
              resolve(parsed);
            } catch (err) {
              reject(new Error(`Invalid JSON response: ${err.message}`));
            }
          } else {
            reject(new Error(`YOLO service HTTP ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('YOLO service request timed out'));
      });

      req.write(payload);
      req.end();
    });
  }

  /**
   * Detect humans in an image frame (Base64)
   * @param {string} base64Image - Frame dataURL or raw Base64
   * @param {Object} [options] - { conf: 0.35, iou: 0.45 }
   */
  async detectHumans(base64Image, options = {}) {
    const conf = options.conf || 0.35;
    const iou = options.iou || 0.45;
    return this._postJson('/detect', { image: base64Image, conf, iou }, 2500);
  }

  /**
   * Extract 128-dimensional multi-part appearance features from a person crop
   * @param {string} base64Crop - Crop dataURL or raw Base64
   */
  async extractFeatures(base64Crop) {
    return this._postJson('/extract-features', { image: base64Crop }, 2500);
  }

  /**
   * Match embedding against gallery
   * @param {Array<number>} embedding - 128-d feature array
   * @param {Array<Object>} gallery - List of known candidates with embeddings
   * @param {number} [threshold=0.78]
   */
  async matchBody(embedding, gallery, threshold = 0.78) {
    return this._postJson('/match-body', { embedding, gallery, threshold }, 2000);
  }

  getStatus() {
    return {
      available: this.isAvailable,
      device: this.device,
      model: this.modelName,
      url: this.baseUrl,
      managedProcess: Boolean(this.pythonProcess)
    };
  }
}

// Global singleton instance
let instance = null;
function getYoloBridge() {
  if (!instance) {
    instance = new YoloBridge();
  }
  return instance;
}

module.exports = {
  YoloBridge,
  getYoloBridge
};
