/**
 * CEOVA CCTV // Outbound Event Dispatcher to Ceova Main App
 * services/ceova_main_dispatcher.js
 * 
 * Implements bidirectional communication from CCTV -> Ceova Main:
 * - Camera offline / disconnected notifications
 * - Critical security events & restricted zone alerts
 * - YOLO deep vision status changes
 * - Occupancy thresholds / spikes
 * 
 * Every webhook dispatch is cryptographically signed using the shared internal protocol secret.
 */

const http = require('http');
const https = require('https');
const { getDatabase } = require('../db/database');
const { computeSignature, CEOVA_INTERNAL_SECRET } = require('../security/ceova_protocol');

class CeovaMainDispatcher {
  constructor(options = {}) {
    this.db = options.db || getDatabase();
    this.secret = options.secret || process.env.CEOVA_INTERNAL_SECRET || CEOVA_INTERNAL_SECRET;
  }

  /**
   * Dispatch an event to Ceova Main App
   */
  async dispatchEvent(organizationId, eventType, data = {}) {
    try {
      const account = this.db.getCctvAccount(organizationId);
      if (!account || !account.main_webhook_url) {
        // No webhook registered or organization not paired yet
        return { delivered: false, reason: 'No webhook registered' };
      }

      const timestamp = Math.floor(Date.now() / 1000).toString();
      const payload = {
        event_id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        event_type: eventType,
        organization_id: organizationId,
        ceova_user_id: account.ceova_user_id,
        timestamp: new Date().toISOString(),
        data
      };

      const payloadString = JSON.stringify(payload);
      const url = new URL(account.main_webhook_url);
      const signature = computeSignature(this.secret, timestamp, 'POST', url.pathname, payload);

      const requestOptions = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payloadString),
          'X-Ceova-Internal-Signature': signature,
          'X-Ceova-Timestamp': timestamp,
          'X-Ceova-Event-Type': eventType,
          'User-Agent': 'Ceova-CCTV-Dispatcher/1.0'
        },
        timeout: 5000
      };

      const transport = url.protocol === 'https:' ? https : http;

      return new Promise((resolve) => {
        const req = transport.request(requestOptions, (res) => {
          let responseBody = '';
          res.on('data', chunk => { responseBody += chunk; });
          res.on('end', () => {
            const success = res.statusCode >= 200 && res.statusCode < 300;
            console.log(`[DISPATCHER] Event ${eventType} sent to Main (Status ${res.statusCode})`);
            
            // Record in audit log
            this.db.run(
              'INSERT INTO audit_logs (organization_id, action, actor, details, created_at) VALUES (?, ?, ?, ?, ?)',
              [organizationId, `DISPATCH_${eventType}`, 'CCTV_ENGINE', `Status: ${res.statusCode}`, new Date().toISOString()]
            );

            resolve({ delivered: success, statusCode: res.statusCode });
          });
        });

        req.on('error', (err) => {
          console.warn(`[DISPATCHER] Failed to deliver event ${eventType} to Main:`, err.message);
          resolve({ delivered: false, error: err.message });
        });

        req.write(payloadString);
        req.end();
      });
    } catch (err) {
      console.error('[DISPATCHER] Dispatch error:', err);
      return { delivered: false, error: err.message };
    }
  }

  // Pre-configured dispatch helpers
  async notifyCameraOffline(organizationId, cameraId, reason = 'Connection timeout') {
    return this.dispatchEvent(organizationId, 'camera.offline', {
      camera_id: cameraId,
      status: 'OFFLINE',
      reason,
      offline_at: new Date().toISOString()
    });
  }

  async notifyCriticalSecurityAlert(organizationId, alertDetails) {
    return this.dispatchEvent(organizationId, 'security.critical_alert', {
      alert_id: `alt_${Date.now()}`,
      severity: 'CRITICAL',
      ...alertDetails,
      detected_at: new Date().toISOString()
    });
  }

  async notifyOccupancySpike(organizationId, count, threshold) {
    return this.dispatchEvent(organizationId, 'occupancy.threshold_exceeded', {
      current_occupancy: count,
      threshold,
      exceeded_at: new Date().toISOString()
    });
  }
}

let dispatcherInstance = null;
function getCeovaMainDispatcher() {
  if (!dispatcherInstance) {
    dispatcherInstance = new CeovaMainDispatcher();
  }
  return dispatcherInstance;
}

module.exports = {
  CeovaMainDispatcher,
  getCeovaMainDispatcher
};
