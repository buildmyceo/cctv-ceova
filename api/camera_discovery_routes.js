/**
 * CEOVA CCTV // Autonomous Camera Discovery API Routes
 * api/camera_discovery_routes.js
 * 
 * Exposes endpoints for the CameraDiscoveryBot:
 * - Start autonomous discovery with username & password
 * - Real-time SSE streaming logs & progress
 * - Register discovered camera into database
 */

const express = require('express');
const { cameraDiscoveryBot } = require('../bots');
const { getDatabase } = require('../db/database');
const { rtspStreamManager } = require('../services/rtsp_stream_manager');

function createCameraDiscoveryRouter(options = {}) {
  const router = express.Router();
  const db = options.db || getDatabase();

  /**
   * POST /api/cameras/discover
   * Start background autonomous scan using user's CCTV username and password
   */
  router.post('/api/cameras/discover', async (req, res) => {
    try {
      const { username = 'admin', password = '', targetIp = null, subnetHint = null } = req.body;

      if (!username || typeof username !== 'string') {
        return res.status(400).json({ error: 'CCTV admin username is required' });
      }

      const result = await cameraDiscoveryBot.startScan({
        username: username.trim(),
        password: password || '',
        targetIp: targetIp ? targetIp.trim() : null,
        subnetHint: subnetHint ? subnetHint.trim() : null
      });

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/cameras/discover/status
   * Poll current discovery progress, logs, and matched cameras
   */
  router.get('/api/cameras/discover/status', (req, res) => {
    res.json(cameraDiscoveryBot.getStatus());
  });

  /**
   * POST /api/cameras/discover/stop
   * Terminate active scan
   */
  router.post('/api/cameras/discover/stop', (req, res) => {
    const result = cameraDiscoveryBot.stopScan();
    res.json(result);
  });

  /**
   * GET /api/cameras/discover/events
   * Server-Sent Events (SSE) stream for real-time progress and live terminal telemetry
   */
  router.get('/api/cameras/discover/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Send initial status
    const initialStatus = cameraDiscoveryBot.getStatus();
    res.write(`data: ${JSON.stringify({ type: 'STATUS_SYNC', ...initialStatus })}\n\n`);

    // Subscribe to live bot updates
    const unsubscribe = cameraDiscoveryBot.subscribe((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    req.on('close', () => {
      unsubscribe();
    });
  });

  /**
   * POST /api/cameras/connect-matched
   * Register a discovered camera directly into CCTV active surveillance database and launch RTSP stream
   */
  router.post('/api/cameras/connect-matched', (req, res) => {
    try {
      const { id, name, rtspUrl, ip, port, path: camPath, username, password, zoneName = 'DEFAULT_ZONE' } = req.body;
      const orgId = req.organization_id || db.getActiveAccount()?.organization_id || 'ORG-DEFAULT';

      let finalRtspUrl = rtspUrl;
      if (!finalRtspUrl && ip) {
        const u = username ? encodeURIComponent(username) : '';
        const p = password ? encodeURIComponent(password) : '';
        const authPart = (u || p) ? `${u}:${p}@` : '';
        const portPart = port ? `:${port}` : '';
        const pathPart = camPath ? (camPath.startsWith('/') ? camPath : `/${camPath}`) : '/';
        finalRtspUrl = `rtsp://${authPart}${ip}${portPart}${pathPart}`;
      }

      if (!finalRtspUrl) {
        return res.status(400).json({ error: 'rtspUrl or camera IP details required' });
      }

      const camId = id || `CAM_${(ip || 'cctv').replace(/\./g, '_')}_${port || '554'}`;
      const camName = name || `CCTV Camera (${ip || finalRtspUrl.split('@')[1] || 'Network'})`;

      // Extract target IP for cleanup of previous/stale instances of the same camera
      const targetHost = ip || (finalRtspUrl.match(/@([^:/]+)/) ? finalRtspUrl.match(/@([^:/]+)/)[1] : null);
      if (targetHost) {
        try {
          const existingCameras = db.getCameras(orgId);
          for (const existing of existingCameras) {
            const isMatch = existing.id === camId || (existing.stream_url && existing.stream_url.includes(targetHost));
            if (isMatch) {
              console.log(`[CameraRoutes] Replacing previous stale camera stream: ${existing.id} (${existing.name})`);
              rtspStreamManager.stopStream(existing.id);
              db.removeCamera(orgId, existing.id);
            }
          }
        } catch (cleanupErr) {
          console.warn('[CameraRoutes] Cleanup warning for stale cameras:', cleanupErr.message);
        }
      }

      const registered = db.registerCamera(orgId, {
        id: camId,
        name: camName,
        stream_url: finalRtspUrl,
        zone_name: zoneName
      });

      // Only launch FFmpeg/RTSP ingest for actual RTSP streams (not HTTP proxy streams)
      const isRtspStream = finalRtspUrl.startsWith('rtsp://') || finalRtspUrl.startsWith('rtsps://');
      if (isRtspStream) {
        try {
          rtspStreamManager.startStream(registered.id, registered.stream_url);
        } catch (streamErr) {
          console.warn(`[RtspStreamManager] Could not start stream for ${registered.id}:`, streamErr.message);
        }
      } else {
        console.log(`[CameraRoutes] HTTP stream registered (no FFmpeg needed): ${registered.id} -> ${finalRtspUrl}`);
      }

      res.status(201).json({
        success: true,
        message: 'Camera connected and added to surveillance system',
        camera: registered,
        streamUrl: `/api/cameras/${registered.id}/stream.mjpg`
      });
    } catch (err) {
      if (err.code === 'QUOTA_EXCEEDED') {
        return res.status(403).json({
          error: 'CameraQuotaExceeded',
          message: err.message
        });
      }
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/cameras
   * List all registered CCTV cameras for active organization
   */
  router.get('/api/cameras', (req, res) => {
    try {
      const orgId = req.organization_id || db.getActiveAccount()?.organization_id || 'ORG-DEFAULT';
      const cameras = db.getCameras(orgId);
      res.json({ success: true, count: cameras.length, cameras });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/cameras/:id/stream.mjpg
   * High-speed multipart MJPEG stream from physical RTSP camera
   */
  router.get('/api/cameras/:id/stream.mjpg', (req, res) => {
    try {
      const orgId = req.organization_id || db.getActiveAccount()?.organization_id || 'ORG-DEFAULT';
      const camera = db.getCamera(req.params.id) || db.getCameras(orgId).find(c => c.id === req.params.id);

      const fallbackUrl = camera ? camera.stream_url : null;
      rtspStreamManager.handleMjpegRequest(req, res, req.params.id, fallbackUrl);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/cameras/:id/snapshot.jpg
   * Latest full-resolution JPEG snapshot from camera
   */
  router.get('/api/cameras/:id/snapshot.jpg', (req, res) => {
    rtspStreamManager.handleSnapshotRequest(req, res, req.params.id);
  });

  /**
   * GET /api/cameras/:id/stream-status
   * Telemetry status of active RTSP stream
   */
  router.get('/api/cameras/:id/stream-status', (req, res) => {
    const stream = rtspStreamManager.getStream(req.params.id);
    if (!stream) {
      return res.json({ isStreaming: false, cameraId: req.params.id });
    }
    res.json({
      isStreaming: stream.isRunning,
      cameraId: req.params.id,
      fps: stream.fps,
      lastError: stream.lastError,
      lastFrameTime: stream.lastFrameTime,
      rtspUrl: stream.rtspUrl
    });
  });

  /**
   * DELETE /api/cameras/:id
   * Remove a camera from surveillance and terminate its RTSP stream
   */
  router.delete('/api/cameras/:id', (req, res) => {
    try {
      const orgId = req.organization_id || db.getActiveAccount()?.organization_id || 'ORG-DEFAULT';
      rtspStreamManager.stopStream(req.params.id);
      db.removeCamera(orgId, req.params.id);
      res.json({ success: true, message: `Camera ${req.params.id} removed` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = {
  createCameraDiscoveryRouter
};
