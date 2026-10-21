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

// 1. Import verified Supabase client from root supabaseClient.js
let supabase;
try {
  const clientModule = require(path.resolve(__dirname, '../../supabaseClient'));
  supabase = clientModule.supabase || clientModule.supabaseClient || clientModule;
} catch (e) {
  console.warn('[YOLO_BRIDGE] Warning: Failed to load supabaseClient:', e.message);
}

// Default fallback UID for CEOVA detections
const DEFAULT_FALLBACK_UID = 'CEOVA-MOCK-UID-TEST-001';

/**
 * Helper function to log detection events to Supabase table 'cctv_detections'
 * Schema: (camera_id, detected_object, confidence, uid)
 * @param {Object|string} cameraOrEvent - Camera ID (string) or detection event object
 * @param {string} [detectedObject] - Name of detected object (default: 'person')
 * @param {number} [confidence] - Detection confidence score (0.0 to 1.0)
 * @param {string} [uid] - Unique CEOVA user / entity identifier (default: 'CEOVA-MOCK-UID-TEST-001')
 * @returns {Promise<{success: boolean, data?: any, error?: any, record?: any}>}
 */
async function logDetectionEvent(cameraOrEvent, detectedObject, confidence, uid) {
  let record;
  const activeFallbackUid = process.env.ACTIVE_UID || DEFAULT_FALLBACK_UID;

  if (typeof cameraOrEvent === 'object' && cameraOrEvent !== null) {
    const assignedUid = cameraOrEvent.uid || cameraOrEvent.userId || cameraOrEvent.user_id || uid || activeFallbackUid;
    record = {
      camera_id: cameraOrEvent.camera_id || cameraOrEvent.cameraId || 'camera_1',
      detected_object: cameraOrEvent.detected_object || cameraOrEvent.detectedObject || cameraOrEvent.class || 'person',
      confidence: Number(cameraOrEvent.confidence ?? cameraOrEvent.score ?? 0),
      uid: String(assignedUid)
    };
    if (cameraOrEvent.created_at) {
      record.created_at = cameraOrEvent.created_at;
    }
  } else {
    const assignedUid = uid || activeFallbackUid;
    record = {
      camera_id: cameraOrEvent || 'camera_1',
      detected_object: detectedObject || 'person',
      confidence: Number(confidence ?? 0),
      uid: String(assignedUid)
    };
  }

  if (!supabase || typeof supabase.from !== 'function') {
    const err = new Error('Supabase client is not available');
    console.warn('[YOLO_BRIDGE] Supabase logging skipped:', err.message);
    return { success: false, error: err };
  }

  try {
    let { data, error } = await supabase
      .from('cctv_detections')
      .insert([record]);

    // Backward-compatibility: if the 'uid' column has not been added to cctv_detections in Supabase yet
    if (error && error.code === 'PGRST204' && String(error.message).includes("'uid'")) {
      console.warn('[YOLO_BRIDGE] Notice: Supabase cctv_detections table does not have "uid" column yet. Retrying insert without uid...');
      const fallbackRecord = { ...record };
      delete fallbackRecord.uid;
      const fallbackResult = await supabase.from('cctv_detections').insert([fallbackRecord]);
      if (!fallbackResult.error) {
        return { success: true, data: fallbackResult.data, record, fallback: true };
      }
      error = fallbackResult.error;
    }

    if (error) {
      console.warn('[YOLO_BRIDGE] Supabase insert warning:', error.message || error);
      return { success: false, error, record };
    }
    return { success: true, data, record };
  } catch (err) {
    console.warn('[YOLO_BRIDGE] Supabase insert failed:', err.message || err);
    return { success: false, error: err, record };
  }
}

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
    this.httpAgent = new http.Agent({
      keepAlive: true,
      maxSockets: 16,
      keepAliveMsecs: 10000
    });
  }

  /**
   * Check if YOLO service is running
   */
  async checkHealth() {
    return new Promise((resolve) => {
      const req = http.get(`${this.baseUrl}/health`, { agent: this.httpAgent, timeout: 1500 }, (res) => {
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
      const { resolvePythonBinary } = require('../../services/runtime_resolver');
      const pythonCmd = resolvePythonBinary(path.join(__dirname, '..', '..'));
      this.pythonProcess = spawn(pythonCmd, [serviceScript], {
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
        agent: this.httpAgent,
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
   * Log a detection event to Supabase 'cctv_detections' table
   */
  async logDetectionEvent(cameraOrEvent, detectedObject, confidence, uid) {
    return logDetectionEvent(cameraOrEvent, detectedObject, confidence, uid);
  }

  /**
   * Detect humans in an image frame (Base64)
   * @param {string} base64Image - Frame dataURL or raw Base64
   * @param {Object} [options] - Configuration and context options:
   *   - conf: YOLO detection confidence floor (default: 0.40)
   *   - iou: Intersection-over-Union NMS threshold (default: 0.45)
   *   - threshold: Min confidence threshold to trigger Supabase insert (default: conf or 0.40)
   *   - targetObjects: List of target objects to record (default: ['person', 'human'])
   *   - camera_id: Camera identifier (default: 'camera_1')
   *   - uid: Active user / entity UID (default/fallback: 'CEOVA-MOCK-UID-TEST-001')
   */
  async detectHumans(base64Image, options = {}) {
    const conf = options.conf || 0.40;
    const iou = options.iou || 0.45;
    const cameraId = options.camera_id || options.cameraId || this.cameraId || 'camera_1';
    const assignedUid = options.uid || options.userId || options.user_id || process.env.ACTIVE_UID || DEFAULT_FALLBACK_UID;
    const threshold = Number(options.threshold ?? options.confidenceThreshold ?? options.minScore ?? conf);
    const targetObjects = (options.targetObjects || ['person', 'human']).map(s => String(s).toLowerCase());

    const payload = { image: base64Image, conf, iou, classes: [0] };
    const result = await this._postJson('/detect', payload, 2500);

    // Whenever a target object (e.g. 'person') is detected above the confidence threshold,
    // trigger an asynchronous, non-blocking insert to 'cctv_detections'.
    // Executed via setImmediate background promise (fire-and-forget) to ensure
    // frame rates are never degraded and inference streams are never throttled.
    if (result && Array.isArray(result.detections) && result.detections.length > 0) {
      for (const det of result.detections) {
        const detected_object = det.class || det.detected_object || 'person';
        const confidenceScore = typeof det.score === 'number' ? det.score : Number(det.confidence ?? conf);

        const isTargetMatch = targetObjects.includes(String(detected_object).toLowerCase());
        const isAboveThreshold = confidenceScore >= threshold;

        if (isTargetMatch && isAboveThreshold) {
          setImmediate(() => {
            logDetectionEvent({
              camera_id: cameraId,
              detected_object,
              confidence: confidenceScore,
              uid: assignedUid
            }).catch(err => {
              console.warn('[YOLO_BRIDGE] Background Supabase insert error:', err.message || err);
            });
          });
        }
      }
    }

    return result;
  }

  /**
   * General detection method alias
   */
  async detect(base64Image, options = {}) {
    return this.detectHumans(base64Image, options);
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
  getYoloBridge,
  logDetectionEvent,
  DEFAULT_FALLBACK_UID,
  supabase
};
