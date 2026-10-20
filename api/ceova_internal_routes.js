/**
 * CEOVA CCTV // Internal Ecosystem & SSO API Routes
 * api/ceova_internal_routes.js
 * 
 * Provides:
 * 1. Private Ceova Internal API (Pairing, Entitlement Updates, AI Queries, Telemetry)
 * 2. SSO Handshake & Launch Session Exchange
 * 3. Camera Management with Plan Quota Enforcement
 * 4. User Session Telemetry & Context
 */

const express = require('express');
const { getDatabase } = require('../db/database');
const { verifyCeovaInternalProtocol, requireEntitlement } = require('../security/ceova_protocol');
const { authenticate } = require('../security/auth');

function createCeovaInternalRouter(options = {}) {
  const router = express.Router();
  const db = options.db || getDatabase();

  // =========================================================================
  // 1. Private Internal API Endpoints (Ceova Main App -> Ceova CCTV)
  // Protected strictly by Ceova Internal Protocol (HMAC signature / shared secret)
  // =========================================================================

  /**
   * POST /api/v1/internal/pair
   * Step 3 of installation flow: Ceova Main securely pairs and establishes the CCTV profile.
   */
  router.post('/api/v1/internal/pair', verifyCeovaInternalProtocol, (req, res) => {
    try {
      const {
        ceova_user_id,
        organization_id,
        cctv_account_id,
        plan = 'starter',
        entitlements = {},
        main_webhook_url
      } = req.body;

      if (!ceova_user_id || !organization_id) {
        return res.status(400).json({
          error: 'BadRequest',
          message: 'ceova_user_id and organization_id are required for pairing'
        });
      }

      // Default entitlements based on plan if omitted
      const finalEntitlements = {
        max_cameras: plan === 'enterprise' ? 50 : (plan === 'professional' ? 16 : 5),
        analytics: plan !== 'starter',
        reports: plan !== 'starter',
        ai_query: true,
        ...entitlements
      };

      const account = db.upsertCctvAccount({
        organization_id,
        ceova_user_id,
        cctv_account_id: cctv_account_id || `cctv_${organization_id.slice(-6)}`,
        plan,
        entitlements: finalEntitlements,
        status: 'ACTIVE',
        main_webhook_url: main_webhook_url || null
      });

      console.log(`[CEOVA_INTERNAL] Successfully paired organization ${organization_id} (User: ${ceova_user_id}, Plan: ${plan})`);

      res.status(200).json({
        success: true,
        message: 'Ceova CCTV paired successfully with Ceova Main',
        account: {
          organization_id: account.organization_id,
          ceova_user_id: account.ceova_user_id,
          cctv_account_id: account.cctv_account_id,
          plan: account.plan,
          entitlements: account.entitlements,
          status: account.status,
          paired_at: account.paired_at
        },
        endpoints: {
          sso_launch_url: '/api/v1/internal/sso/launch-token',
          ai_query_url: '/api/v1/internal/ai/query',
          status_url: '/api/v1/internal/status'
        }
      });
    } catch (err) {
      console.error('[CEOVA_INTERNAL] Pairing failed:', err);
      res.status(500).json({ error: 'PairingError', message: err.message });
    }
  });

  /**
   * POST /api/v1/internal/entitlements
   * Plan Change Handshake: Ceova Main is authoritative for billing.
   * When user upgrades/downgrades in Main, this updates CCTV permissions.
   */
  router.post('/api/v1/internal/entitlements', verifyCeovaInternalProtocol, (req, res) => {
    try {
      const { organization_id, plan, entitlements } = req.body;

      if (!organization_id) {
        return res.status(400).json({ error: 'BadRequest', message: 'organization_id is required' });
      }

      const existing = db.getCctvAccount(organization_id);
      if (!existing) {
        return res.status(404).json({ error: 'NotFound', message: `Organization ${organization_id} not paired with CCTV` });
      }

      const updated = db.updateAccountEntitlements(organization_id, plan, entitlements);
      console.log(`[CEOVA_INTERNAL] Updated entitlements for ${organization_id}: Plan = ${updated.plan}`);

      res.json({
        success: true,
        message: 'Entitlements updated successfully',
        account: {
          organization_id: updated.organization_id,
          plan: updated.plan,
          entitlements: updated.entitlements,
          updated_at: updated.updated_at
        }
      });
    } catch (err) {
      res.status(500).json({ error: 'InternalError', message: err.message });
    }
  });

  /**
   * POST /api/v1/internal/sso/launch-token
   * Generates a secure, single-use launch token for Ceova Main to open CCTV in a webview / browser.
   */
  router.post('/api/v1/internal/sso/launch-token', verifyCeovaInternalProtocol, (req, res) => {
    try {
      const { organization_id, ceova_user_id, role = 'OPERATOR', expires_in_sec = 300 } = req.body;

      if (!organization_id || !ceova_user_id) {
        return res.status(400).json({ error: 'BadRequest', message: 'organization_id and ceova_user_id required' });
      }

      const account = db.getCctvAccount(organization_id);
      if (!account || account.status !== 'ACTIVE') {
        return res.status(403).json({ error: 'Forbidden', message: 'Account is not active or not paired' });
      }

      const tokenRecord = db.createLaunchToken(organization_id, ceova_user_id, role, expires_in_sec);
      const launchUrl = `/auth/sso?token=${tokenRecord.token}`;

      res.json({
        success: true,
        launch_token: tokenRecord.token,
        launch_url: launchUrl,
        expires_at: tokenRecord.expires_at
      });
    } catch (err) {
      res.status(500).json({ error: 'InternalError', message: err.message });
    }
  });

  /**
   * GET /api/v1/internal/status
   * Telemetry endpoint for Ceova Main App to monitor CCTV system health.
   */
  router.get('/api/v1/internal/status', verifyCeovaInternalProtocol, (req, res) => {
    try {
      const organizationId = req.query.organization_id;
      const account = organizationId ? db.getCctvAccount(organizationId) : db.getActiveAccount();
      const cameraCount = account ? db.getCameraCount(account.organization_id) : 0;

      res.json({
        status: 'ONLINE',
        service: 'Ceova CCTV System',
        paired: !!account,
        organization: account ? {
          organization_id: account.organization_id,
          plan: account.plan,
          camera_count: cameraCount,
          max_cameras: account.entitlements?.max_cameras || 5,
          analytics_enabled: account.entitlements?.analytics || false
        } : null,
        engines: {
          database: 'ready',
          yolo_service: 'active'
        },
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      res.status(500).json({ error: 'InternalError', message: err.message });
    }
  });

  /**
   * POST /api/v1/internal/ai/query
   * Ceova Main AI Integration:
   * Ceova Main AI calls this endpoint when user asks CCTV questions
   * (e.g. "How many people are inside my store?", "Any security alerts today?").
   */
  router.post('/api/v1/internal/ai/query', verifyCeovaInternalProtocol, (req, res) => {
    try {
      const { organization_id, query_type = 'occupancy' } = req.body;
      const orgId = organization_id || db.getActiveAccount()?.organization_id || 'ORG-DEFAULT';

      // 1. Gather active occupancy / human counts
      const activeTracks = db.all(
        "SELECT COUNT(*) as cnt FROM global_tracks WHERE organization_id = ? AND status = 'ACTIVE'",
        [orgId]
      );
      const activePeopleCount = (activeTracks && activeTracks[0]) ? activeTracks[0].cnt : 0;

      // 2. Fetch popular times / today's peak
      const now = new Date();
      const dayOfWeek = now.getDay();
      const currentHour = now.getHours();
      const occupancyStats = db.get(
        'SELECT * FROM hourly_people_occupancy WHERE day_of_week = ? AND hour_of_day = ?',
        [dayOfWeek, currentHour]
      );
      const peakToday = occupancyStats?.peak_people || activePeopleCount;

      // 3. Active cameras
      const cameraCount = db.getCameraCount(orgId);

      // 4. Recent identity / security events
      const recentEvents = db.all(
        'SELECT event_type, role, confidence, created_at FROM identity_events WHERE organization_id = ? ORDER BY created_at DESC LIMIT 5',
        [orgId]
      );

      // Formulate natural language response for Ceova Main AI
      let summaryText = '';
      if (query_type === 'occupancy') {
        summaryText = `There are currently ${activePeopleCount} people detected across ${cameraCount} cameras. Today's peak at this hour was ${peakToday} people.`;
      } else if (query_type === 'alerts') {
        summaryText = recentEvents.length === 0 
          ? 'No security alerts or anomalous activity detected today. All zones secure.'
          : `There are ${recentEvents.length} recent activity events recorded. Latest event: ${recentEvents[0].event_type} (${recentEvents[0].role}).`;
      } else {
        summaryText = `Facility Status: ${activePeopleCount} people inside, ${cameraCount} cameras online. System running smoothly.`;
      }

      res.json({
        success: true,
        query_type,
        organization_id: orgId,
        timestamp: now.toISOString(),
        result: {
          current_occupancy: activePeopleCount,
          peak_today: peakToday,
          active_cameras: cameraCount,
          recent_events: recentEvents
        },
        natural_language_summary: summaryText
      });
    } catch (err) {
      console.error('[CEOVA_INTERNAL] AI query error:', err);
      res.status(500).json({ error: 'AIQueryError', message: err.message });
    }
  });

  /**
   * POST /api/v1/internal/account/revoke
   * Revoke pairing when subscription is cancelled or app uninstalled in Ceova Main.
   */
  router.post('/api/v1/internal/account/revoke', verifyCeovaInternalProtocol, (req, res) => {
    try {
      const { organization_id } = req.body;
      if (!organization_id) {
        return res.status(400).json({ error: 'BadRequest', message: 'organization_id required' });
      }

      db.revokeCctvAccount(organization_id);
      console.log(`[CEOVA_INTERNAL] Revoked account for ${organization_id}`);

      res.json({ success: true, message: `Account for ${organization_id} has been revoked` });
    } catch (err) {
      res.status(500).json({ error: 'InternalError', message: err.message });
    }
  });

  // =========================================================================
  // 2. SSO Handshake & Launch Endpoints (Browser / Webview Navigation)
  // =========================================================================

  /**
   * GET /auth/sso
   * Consumes single-use launch token, sets session cookie, and redirects into CCTV app.
   */
  router.get('/auth/sso', (req, res) => {
    const token = req.query.token;
    if (!token) {
      return res.status(400).send('<h3>Ceova CCTV: Missing SSO Launch Token</h3>');
    }

    const result = db.consumeLaunchToken(token);
    if (!result.valid) {
      return res.status(401).send(`<h3>Ceova CCTV Authentication Failed</h3><p>${result.error}</p>`);
    }

    // Set secure HTTP session cookie
    const isHttps = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', [
      `ceova_cctv_session=${result.session.session_token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}${isHttps ? '; Secure' : ''}`
    ]);

    // Redirect to main CCTV console
    const redirectUrl = req.query.redirect || '/';
    res.redirect(redirectUrl);
  });

  /**
   * POST /api/auth/sso/exchange
   * API version of SSO token exchange (for mobile/desktop app client wrappers)
   */
  router.post('/api/auth/sso/exchange', (req, res) => {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'BadRequest', message: 'Missing token' });
    }

    const result = db.consumeLaunchToken(token);
    if (!result.valid) {
      return res.status(401).json({ error: 'AuthFailed', message: result.error });
    }

    res.json({
      success: true,
      session_token: result.session.session_token,
      expires_at: result.session.expires_at,
      account: {
        organization_id: result.account.organization_id,
        plan: result.account.plan,
        entitlements: result.account.entitlements
      }
    });
  });

  /**
   * GET /api/auth/me
   * Returns current user identity, organization context, and entitlements
   */
  router.get('/api/auth/me', authenticate, (req, res) => {
    const account = req.user?.account || db.getCctvAccount(req.organization_id) || db.getActiveAccount();
    const cameraCount = account ? db.getCameraCount(account.organization_id) : 0;

    res.json({
      authenticated: true,
      user_id: req.user?.id || 'local-console',
      role: req.user?.role || 'OPERATOR',
      organization_id: req.organization_id || account?.organization_id || 'ORG-DEFAULT',
      plan: account?.plan || 'starter',
      entitlements: account?.entitlements || { max_cameras: 5, analytics: false, reports: false },
      camera_usage: {
        current: cameraCount,
        max: account?.entitlements?.max_cameras || 5,
        available: Math.max(0, (account?.entitlements?.max_cameras || 5) - cameraCount)
      },
      status: account?.status || 'ACTIVE'
    });
  });

  /**
   * POST /api/auth/logout
   * Destroys active session
   */
  router.post('/api/auth/logout', authenticate, (req, res) => {
    if (req.session?.session_token) {
      db.deleteSession(req.session.session_token);
    }
    res.setHeader('Set-Cookie', ['ceova_cctv_session=; Path=/; HttpOnly; Max-Age=0']);
    res.json({ success: true, message: 'Logged out successfully' });
  });

  // =========================================================================
  // 3. Camera Management Endpoints with Entitlement Enforcement
  // =========================================================================

  /**
   * GET /api/cctv/cameras
   * List registered cameras for current organization
   */
  router.get('/api/cctv/cameras', authenticate, (req, res) => {
    try {
      const orgId = req.organization_id || 'ORG-DEFAULT';
      const cameras = db.getCameras(orgId);
      const account = db.getCctvAccount(orgId) || db.getActiveAccount();
      const maxCameras = account?.entitlements?.max_cameras || 5;

      res.json({
        total: cameras.length,
        max_cameras: maxCameras,
        cameras
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/cctv/cameras
   * Register a new camera, enforcing max_cameras plan entitlement
   */
  router.post('/api/cctv/cameras', authenticate, (req, res) => {
    try {
      const orgId = req.organization_id || 'ORG-DEFAULT';
      const { id, name, stream_url, zone_name } = req.body;

      const registered = db.registerCamera(orgId, {
        id,
        name,
        stream_url,
        zone_name
      });

      res.status(201).json({
        success: true,
        message: 'Camera registered successfully',
        camera: registered
      });
    } catch (err) {
      if (err.code === 'QUOTA_EXCEEDED') {
        return res.status(403).json({
          error: 'CameraQuotaExceeded',
          message: err.message,
          current_count: err.current_count,
          max_cameras: err.max_cameras,
          upgrade_url: 'ceova://apps/subscription'
        });
      }
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = {
  createCeovaInternalRouter
};
