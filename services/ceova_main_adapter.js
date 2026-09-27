/**
 * CEOVA CCTV // Main App Client Adapter
 * services/ceova_main_adapter.js
 * 
 * Client SDK library designed for Ceova Main App to communicate with Ceova CCTV App.
 * Handles:
 * 1. App Installation / Secure Pairing
 * 2. Plan & Subscription Entitlement Synchronization
 * 3. SSO Launch Token Generation
 * 4. Ceova Main AI Queries ("How many people inside my store?")
 * 5. Telemetry & Health Checks
 */

const http = require('http');
const https = require('https');
const { computeSignature, CEOVA_INTERNAL_SECRET } = require('../security/ceova_protocol');

class CeovaCctvClient {
  constructor(options = {}) {
    this.cctvBaseUrl = options.cctvBaseUrl || process.env.CEOVA_CCTV_URL || 'https://127.0.0.1:3443';
    this.secret = options.secret || process.env.CEOVA_INTERNAL_SECRET || CEOVA_INTERNAL_SECRET;
  }

  async _request(method, path, body = null) {
    const url = new URL(path, this.cctvBaseUrl);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const payloadString = body ? JSON.stringify(body) : '';
    const signature = computeSignature(this.secret, timestamp, method, url.pathname, body || '');

    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    const requestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: method.toUpperCase(),
      headers: {
        'Content-Type': 'application/json',
        'X-Ceova-Internal-Signature': signature,
        'X-Ceova-Timestamp': timestamp,
        'X-Ceova-Internal-Key': this.secret,
        'User-Agent': 'Ceova-Main-Client/1.0'
      },
      // Allow self-signed certs for local development/private network
      rejectUnauthorized: false,
      timeout: 10000
    };

    if (body) {
      requestOptions.headers['Content-Length'] = Buffer.byteLength(payloadString);
    }

    return new Promise((resolve, reject) => {
      const req = transport.request(requestOptions, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              const err = new Error(parsed.message || `CCTV request failed with status ${res.statusCode}`);
              err.statusCode = res.statusCode;
              err.data = parsed;
              reject(err);
            }
          } catch (e) {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(data);
            } else {
              reject(new Error(`Failed with status ${res.statusCode}: ${data}`));
            }
          }
        });
      });

      req.on('error', reject);
      if (body) req.write(payloadString);
      req.end();
    });
  }

  /**
   * Step 3 of installation: Securely pair CCTV with user's organization & entitlements
   */
  async pair({ userId, orgId, cctvAccountId, plan = 'starter', entitlements = {}, webhookUrl = null }) {
    return this._request('POST', '/api/v1/internal/pair', {
      ceova_user_id: userId,
      organization_id: orgId,
      cctv_account_id: cctvAccountId || `cctv_${orgId.slice(-6)}`,
      plan,
      entitlements,
      main_webhook_url: webhookUrl
    });
  }

  /**
   * Update entitlements when subscription changes (e.g. Starter -> Professional -> Enterprise)
   */
  async updateEntitlements({ orgId, plan, entitlements }) {
    return this._request('POST', '/api/v1/internal/entitlements', {
      organization_id: orgId,
      plan,
      entitlements
    });
  }

  /**
   * Generate SSO Launch Token for Ceova Main to launch CCTV App
   */
  async createLaunchSession({ userId, orgId, role = 'OPERATOR' }) {
    const res = await this._request('POST', '/api/v1/internal/sso/launch-token', {
      organization_id: orgId,
      ceova_user_id: userId,
      role
    });

    const fullLaunchUrl = new URL(res.launch_url, this.cctvBaseUrl).toString();
    return {
      launchToken: res.launch_token,
      launchUrl: fullLaunchUrl,
      expiresAt: res.expires_at
    };
  }

  /**
   * Check CCTV System Status & Connected Organization
   */
  async getStatus(orgId = null) {
    const path = orgId ? `/api/v1/internal/status?organization_id=${encodeURIComponent(orgId)}` : '/api/v1/internal/status';
    return this._request('GET', path);
  }

  /**
   * Query CCTV from Ceova Main AI
   * Example: "How many people are inside my store?" -> queryAi({ orgId, queryType: 'occupancy' })
   */
  async queryAi({ orgId, queryType = 'occupancy' }) {
    return this._request('POST', '/api/v1/internal/ai/query', {
      organization_id: orgId,
      query_type: queryType
    });
  }

  /**
   * Revoke pairing on subscription cancellation / account deletion
   */
  async revoke({ orgId }) {
    return this._request('POST', '/api/v1/internal/account/revoke', {
      organization_id: orgId
    });
  }
}

module.exports = {
  CeovaCctvClient
};
