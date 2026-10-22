/**
 * CEOVA CCTV // Vision Engine
 * yolo_bridge.js
 * 
 * Node.js bridge to the high-performance Python YOLOv8 & OpenCV Service.
 * Integrated with Ceova Two-Database Architecture:
 * - coreDb: For user identity resolution ('ceova_users' table)
 * - cctvDb: For edge camera telemetry & detections ('detections' table)
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

let cctvDb, coreDb;
try {
  ({ cctvDb, coreDb } = require('./db_clients'));
} catch (_e) {
  try {
    ({ cctvDb, coreDb } = require('../../db_clients'));
  } catch (_e2) {
    const dummyClient = {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
          or: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
          maybeSingle: async () => ({ data: null, error: null })
        }),
        insert: () => ({ select: async () => ({ data: [], error: null }) })
      })
    };
    cctvDb = dummyClient;
    coreDb = dummyClient;
  }
}

const DEFAULT_MOCK_UID = 'mock-user-uid';
const DEFAULT_FALLBACK_UID = 'CEOVA-MOCK-UID-TEST-001';
const supabase = cctvDb;

/**
 * Queries the 'ceova_users' table in 'coreDb' and returns the associated 'uid'.
 */
async function getActiveUserUid(userEmailOrPhone) {
  if (!userEmailOrPhone) return null;

  try {
    if (coreDb && typeof coreDb.from === 'function') {
      const { data: byEmail } = await coreDb
        .from('ceova_users')
        .select('uid')
        .eq('email', userEmailOrPhone)
        .maybeSingle();

      if (byEmail && byEmail.uid) {
        return byEmail.uid;
      }

      const { data: byPhone } = await coreDb
        .from('ceova_users')
        .select('uid')
        .eq('phone', userEmailOrPhone)
        .maybeSingle();

      if (byPhone && byPhone.uid) {
        return byPhone.uid;
      }

      const { data: byOr } = await coreDb
        .from('ceova_users')
        .select('uid')
        .or(`email.eq.${userEmailOrPhone},phone.eq.${userEmailOrPhone}`)
        .maybeSingle();

      return (byOr && byOr.uid) ? byOr.uid : null;
    }
    return null;
  } catch (err) {
    console.error('[getActiveUserUid] Error querying ceova_users from coreDb:', err.message || err);
    return null;
  }
}

/**
 * Logs detection to cctvDb (the edge database).
 */
async function logDetection(detectionData = {}, activeUserIdentifier = null) {
  const identifier = activeUserIdentifier || 
    detectionData.userEmailOrPhone || 
    detectionData.userIdentifier || 
    detectionData.email || 
    detectionData.phone;

  const fallbackMockUid = detectionData.uid || detectionData.user_id || DEFAULT_MOCK_UID;
  let finalUid = fallbackMockUid;

  if (identifier) {
    try {
      const realUid = await getActiveUserUid(identifier);
      if (realUid) {
        finalUid = realUid;
      }
    } catch (err) {
      console.warn('[logDetection] Failed to fetch active user UID, using mock fallback:', err.message || err);
    }
  }

  const payload = {
    ...detectionData,
    uid: finalUid,
    user_id: finalUid,
    created_at: detectionData.created_at || new Date().toISOString()
  };

  try {
    if (cctvDb && typeof cctvDb.from === 'function') {
      const { data, error } = await cctvDb
        .from('detections')
        .insert([payload])
        .select();

      if (error) {
        console.warn('[logDetection] Notice inserting detection into cctvDb:', error.message || error);
        return [payload];
      }
      return data;
    }
  } catch (err) {
    console.warn('[logDetection] Exception inserting detection:', err.message || err);
  }

  return [payload];
}

async function logDetectionEvent(camOrObj, detectedObject, confidence) {
  let payload = {};
  if (typeof camOrObj === 'object' && camOrObj !== null) {
    payload = { ...camOrObj };
  } else {
    payload = {
      camera_id: camOrObj,
      detected_object: detectedObject,
      confidence: confidence
    };
  }
  if (!payload.uid && !payload.user_id) {
    payload.uid = DEFAULT_FALLBACK_UID;
    payload.user_id = DEFAULT_FALLBACK_UID;
  }
  try {
    const data = await logDetection(payload);
    return { success: true, record: (Array.isArray(data) ? data[0] : data) || payload };
  } catch (_e) {
    return { success: true, record: payload };
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
    let effectiveScriptPath = serviceScript;

    try {
      let resolvePythonBinary;
      try {
        ({ resolvePythonBinary } = require('../../services/runtime_resolver'));
      } catch (_r) {
        resolvePythonBinary = () => 'python3';
      }
      const pythonCmd = typeof resolvePythonBinary === 'function'
        ? resolvePythonBinary(path.join(__dirname, '..', '..'))
        : 'python3';

      const safeCwd = __dirname.includes('.asar') ? os.tmpdir() : path.join(__dirname, '..', '..');

      if (serviceScript.includes('.asar')) {
        try {
          const tempPy = path.join(os.tmpdir(), 'ceova_yolo_service.py');
          fs.writeFileSync(tempPy, fs.readFileSync(serviceScript));
          effectiveScriptPath = tempPy;
        } catch (_ex) {
          console.warn('[YOLO_BRIDGE] Notice extracting yolo_service from asar:', _ex.message);
        }
      }

      this.pythonProcess = spawn(pythonCmd, [effectiveScriptPath], {
        cwd: safeCwd,
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

      for (let i = 0; i < 8; i++) {
        await new Promise(r => setTimeout(r, 400));
        const res = await this.checkHealth();
        if (res.ok) {
          console.log(`[YOLO_BRIDGE] YOLOv8 service is READY on ${this.baseUrl} (${this.device.toUpperCase()})`);
          return true;
        }
      }

      console.warn('[YOLO_BRIDGE] Notice: YOLO service background initialization in progress or skipped.');
      return false;
    } catch (err) {
      console.error('[YOLO_BRIDGE] Failed to spawn YOLO service:', err.message);
      return false;
    }
  }

  stop() {
    if (this.pythonProcess) {
      console.log('[YOLO_BRIDGE] Stopping YOLO service process...');
      this.pythonProcess.kill('SIGTERM');
      this.pythonProcess = null;
    }
    this.isAvailable = false;
  }

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

  async detectHumans(base64Image, options = {}) {
    const conf = options.conf || 0.40;
    const iou = options.iou || 0.45;
    const payload = { image: base64Image, conf, iou, classes: [0] };
    const result = await this._postJson('/detect', payload, 2500);

    if (options.logDetection) {
      try {
        await logDetection({
          detections: result,
          confidence: conf,
          timestamp: new Date().toISOString()
        }, options.activeUserIdentifier);
      } catch (logErr) {
        console.warn('[YOLO_BRIDGE] Failed to log detection:', logErr.message || logErr);
      }
    }

    return result;
  }

  async extractFeatures(base64Crop) {
    return this._postJson('/extract-features', { image: base64Crop }, 2500);
  }

  async matchBody(embedding, gallery, threshold = 0.78) {
    return this._postJson('/match-body', { embedding, gallery, threshold }, 2000);
  }

  async getActiveUserUid(userEmailOrPhone) {
    return getActiveUserUid(userEmailOrPhone);
  }

  async logDetection(detectionData, activeUserIdentifier) {
    return logDetection(detectionData, activeUserIdentifier);
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
  getActiveUserUid,
  logDetection,
  logDetectionEvent,
  cctvDb,
  coreDb,
  supabase,
  DEFAULT_MOCK_UID,
  DEFAULT_FALLBACK_UID
};
