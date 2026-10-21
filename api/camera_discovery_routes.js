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
const net = require('net');
const http = require('http');
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
      const username = (req.body.username || '').trim();
      const password = req.body.password || '';
      const targetIp = req.body.targetIp ? req.body.targetIp.trim() : null;
      const subnetHint = req.body.subnetHint ? req.body.subnetHint.trim() : null;

      if (!username) {
        return res.status(400).json({ error: 'CCTV / NVR username is required' });
      }

      const orgId = req.organization_id || db.getActiveAccount()?.organization_id || 'ORG-DEFAULT';
      // Stop existing streams before starting fresh network discovery
      try {
        const existingCameras = db.getCameras(orgId);
        for (const existing of existingCameras) {
          rtspStreamManager.stopStream(existing.id);
        }
      } catch (_e) {}

      const result = await cameraDiscoveryBot.startScan({
        username,
        password,
        targetIp,
        subnetHint,
        orgId
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
   * POST /api/cameras/test-connect
   * Fast probe and connection for a specific IP or camera URL
   */
  router.post('/api/cameras/test-connect', async (req, res) => {
    try {
      const { target, ip, port, password = '' } = req.body;
      const username = (req.body.username || '').trim();
      const raw = (target || ip || '').trim();
      if (!raw) {
        return res.status(400).json({ success: false, error: 'Target IP or Camera endpoint is required.' });
      }
      if (!username) {
        return res.status(400).json({ success: false, error: 'CCTV / NVR username is required.' });
      }

      // Parse host, port, protocol
      let host = raw;
      let customPort = port ? parseInt(port, 10) : null;

      if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('rtsp://')) {
        try {
          const u = new URL(raw);
          host = u.hostname;
          if (u.port) customPort = parseInt(u.port, 10);
        } catch (_e) {
          host = raw.replace(/^[a-z]+:\/\//i, '');
        }
      } else if (raw.includes(':')) {
        const parts = raw.split(':');
        host = parts[0];
        customPort = parseInt(parts[1], 10);
      }

      host = host.split('/')[0];
      const { probeHttpCamera } = require('../services/http_camera_client');

      const orgId = req.organization_id || db.getActiveAccount()?.organization_id || 'ORG-DEFAULT';

      // Comprehensive port list: all known camera/NVR/DVR ports
      const FULL_CAMERA_PORTS = [
        554, 8554, 8000, 8500, 37777, 34567, 9559, 9527, 80, 8080, 8081, 8082, 8088, 8090, 8008, 8888,
        5000, 5556, 5800, 1935, 4747, 5856, 1025, 1026, 1027, 1028, 1029, 1030,
        1055, 6667, 7070, 7080, 7447, 7777, 8880, 8889, 18080, 8200, 9000, 9090, 10000, 10554,
        443, 8443, 2020, 3000, 3001, 6000, 7000
      ];

      const testTcpPort = (testHost, testPort, ms = 2000) => {
        return new Promise((resolve) => {
          const sock = new net.Socket();
          sock.setTimeout(ms);
          sock.on('connect', () => { sock.destroy(); resolve(true); });
          sock.on('timeout', () => { sock.destroy(); resolve(false); });
          sock.on('error', () => { sock.destroy(); resolve(false); });
          sock.connect(testPort, testHost);
        });
      };

      let anyPortOpen = false;
      let authFailedDetected = false;
      let openPortsFound = [];

      if (customPort) {
        // Scan user-specified port + ALL comprehensive list (in parallel, fast)
        const allPortsToScan = [...new Set([customPort, ...FULL_CAMERA_PORTS])];
        const results = await Promise.all(allPortsToScan.map(p => testTcpPort(host, p, 2000).then(ok => ({ p, ok }))));
        openPortsFound = results.filter(r => r.ok).map(r => r.p);
        // Make sure custom port is tried first
        openPortsFound.sort((a, b) => (a === customPort ? -1 : b === customPort ? 1 : 0));
      } else {
        // No port specified: scan all camera ports in parallel
        const results = await Promise.all(FULL_CAMERA_PORTS.map(p => testTcpPort(host, p, 2000).then(ok => ({ p, ok }))));
        openPortsFound = results.filter(r => r.ok).map(r => r.p);
      }

      // Probe all open ports concurrently: RTSP paths in parallel + HTTP in parallel
      // Hard timeout: each port resolved within ~4s total
      const RTSP_PORTS = new Set([
        554, 8554, 8000, 8500, 37777, 34567, 9559, 9527, 5556, 18080, 8200, 9000, 10554,
        1025, 1026, 1027, 1028, 1029, 1030, 1055, 4747, 5856, 8888, 1935, 8082, 8090, 8008, 7070
      ]);
      const HTTP_ONLY_PORTS = new Set([80, 443, 8080, 8081, 8088, 5000, 5800, 3000, 3001, 6000, 7000]);

      const RTSP_PATHS = [
        // Hikvision / Hilook / Annke / Ezviz
        '/Streaming/Channels/101',
        '/Streaming/Channels/102',
        '/Streaming/Channels/1',
        '/h264/ch1/main/av_stream',
        '/h264/ch1/sub/av_stream',

        // Dahua / CP Plus / Amcrest / Lorex / IMOU
        '/cam/realmonitor?channel=1&subtype=0',
        '/cam/realmonitor?channel=1&subtype=1',
        '/live',
        '/ch01/0',

        // TP-Link Tapo / Kasa
        '/stream1',
        '/stream2',

        // Xiongmai (XM) / NetSurveillance / Tuya / Goke / Anyka
        '/live/ch0',
        '/ch0',
        '/ch0_0',
        '/media/video1',
        '/media/video2',

        // Reolink
        '/h264Preview_01_main',
        '/h264Preview_01_sub',
        '/Preview_01_main',

        // Uniview
        '/unicast/c1/s0/live',

        // IP Webcam / Phone camera
        '/h264_pcm.sdp',
        '/video',
        '/shot.jpg',

        // Generic ONVIF / RTSP
        '/onvif1',
        '/onvif2',
        '/video1',
        '/live.sdp',
        '/'
      ];

      // Helper: probe a single port for both RTSP and HTTP, return first match
      const probePort = async (p) => {
        const tasks = [];

        // Try RTSP on likely-RTSP ports (or custom port)
        const tryRtsp = RTSP_PORTS.has(p) || (customPort === p) || !HTTP_ONLY_PORTS.has(p);
        if (tryRtsp) {
          // Probe in batches of 4 to avoid overwhelming the camera
          const rtspTask = (async () => {
            const batchSize = 4;
            for (let b = 0; b < RTSP_PATHS.length; b += batchSize) {
              const batch = RTSP_PATHS.slice(b, b + batchSize);
              const batchResults = await Promise.all(
                batch.map(path =>
                  cameraDiscoveryBot._testRtspHandshake(host, p, path, username, password)
                    .then(r => {
                      if (r.success) return { type: 'rtsp', path, result: r };
                      if (r.status === 'AUTH_FAILED') { authFailedDetected = true; }
                      return null;
                    }).catch(() => null)
                )
              );
              const found = batchResults.find(r => r !== null);
              if (found) return found;
            }
            return null;
          })();
          tasks.push(rtspTask);
        }

        // HTTP probe always runs concurrently
        const httpTask = probeHttpCamera(host, p, username, password, 3500)
          .then(r => {
            if (r.success) return { type: 'http', result: r };
            if (r.status === 'AUTH_FAILED') authFailedDetected = true;
            return null;
          }).catch(() => null);
        tasks.push(httpTask);

        const results = await Promise.all(tasks);
        for (const r of results) if (r) return { port: p, ...r };
        return null;
      };

      // Probe all open ports concurrently
      anyPortOpen = openPortsFound.length > 0;
      const portResults = await Promise.all(openPortsFound.map(p => probePort(p)));
      const firstMatch = portResults.find(r => r !== null);

      if (firstMatch) {
        const p = firstMatch.port;
        if (firstMatch.type === 'rtsp') {
          const path = firstMatch.path;
          const authPart = (username || password) ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
          const internalUrl = `rtsp://${authPart}${host}:${p}${path}`;
          const camId = `CAM_${host.replace(/\./g, '_')}_${p}`;

          try {
            const existingCameras = db.getCameras(orgId);
            for (const existing of existingCameras) {
              rtspStreamManager.stopStream(existing.id);
              db.removeCamera(orgId, existing.id);
            }
          } catch (_e) {}

          const registered = db.registerCamera(orgId, {
            id: camId,
            name: `CCTV Camera (${host}:${p})`,
            stream_url: internalUrl,
            zone_name: 'SALES_FLOOR'
          });
          try {
            if (typeof db.saveLocalCredentials === 'function') {
              db.saveLocalCredentials({ username: username || '', password: password || '', ip: host, port: p, cameraId: camId });
            }
          } catch (_e) {}
          try { rtspStreamManager.startStream(registered.id, registered.stream_url); } catch (_e) {}

          const clientStreamUrl = `/api/cameras/${registered.id}/stream.mjpg`;
          return res.json({
            success: true, status: 'Connected', mode: 'RTSP',
            message: `Connected successfully to RTSP camera at ${host}:${p}!`,
            camera: { ...registered, stream_url: clientStreamUrl },
            streamUrl: clientStreamUrl
          });

        } else if (firstMatch.type === 'http') {
          const httpProbe = firstMatch.result;
          const authPart = (username || password) ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
          const internalUrl = `http://${authPart}${host}:${p}${httpProbe.path || '/video'}`;
          const camId = `CAM_${host.replace(/\./g, '_')}_${p}`;

          try {
            const existingCameras = db.getCameras(orgId);
            for (const existing of existingCameras) { db.removeCamera(orgId, existing.id); }
          } catch (_e) {}

          const registered = db.registerCamera(orgId, {
            id: camId,
            name: `${httpProbe.brand || 'IP Webcam'} (${host}:${p})`,
            stream_url: internalUrl,
            zone_name: 'SALES_FLOOR'
          });
          try {
            if (typeof db.saveLocalCredentials === 'function') {
              db.saveLocalCredentials({ username: username || '', password: password || '', ip: host, port: p, cameraId: camId });
            }
          } catch (_e) {}
          const clientStreamUrl = `/api/cameras/${registered.id}/stream.mjpg`;
          return res.json({
            success: true, status: 'Connected', mode: 'HTTP_MJPEG',
            message: `Connected successfully to ${httpProbe.brand || 'camera'} at ${host}:${p}!`,
            camera: { ...registered, stream_url: clientStreamUrl },
            streamUrl: clientStreamUrl
          });
        }
      }

      if (!anyPortOpen) {
        return res.status(404).json({
          success: false,
          status: 'Unreachable',
          error: 'Camera could not be reached.',
          hint: `Host ${host} did not respond on any of ${FULL_CAMERA_PORTS.length} scanned ports. Verify the device is powered on and connected to the same network. Check the NVR/camera menu for the correct IP.`
        });
      }

      if (authFailedDetected) {
        return res.status(401).json({
          success: false,
          status: 'Authentication failed',
          error: 'Camera detected, but authentication failed.',
          hint: 'The camera responded, but the username or password was rejected. Please verify your CCTV/NVR credentials.'
        });
      }

      // If port 554, 8554, or user-specified customPort is open, connect directly via FFmpeg RTSP
      const rtspFallbackPort = openPortsFound.find(p => p === 554 || p === 8554 || p === customPort);
      if (rtspFallbackPort && !authFailedDetected) {
        const p = rtspFallbackPort;
        const defaultPath = '/Streaming/Channels/101';
        const authPart = (username || password) ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
        const internalUrl = `rtsp://${authPart}${host}:${p}${defaultPath}`;
        const camId = `CAM_${host.replace(/\./g, '_')}_${p}`;

        try {
          const existingCameras = db.getCameras(orgId);
          for (const existing of existingCameras) {
            rtspStreamManager.stopStream(existing.id);
            db.removeCamera(orgId, existing.id);
          }
        } catch (_e) {}

        const registered = db.registerCamera(orgId, {
          id: camId,
          name: `CCTV Camera (${host}:${p})`,
          stream_url: internalUrl,
          zone_name: 'SALES_FLOOR'
        });
        try {
          if (typeof db.saveLocalCredentials === 'function') {
            db.saveLocalCredentials({ username: username || '', password: password || '', ip: host, port: p, cameraId: camId });
          }
        } catch (_e) {}
        try { rtspStreamManager.startStream(registered.id, registered.stream_url); } catch (_e) {}

        const clientStreamUrl = `/api/cameras/${registered.id}/stream.mjpg`;
        return res.json({
          success: true, status: 'Connected', mode: 'RTSP',
          message: `Connected to camera at ${host}:${p}! Initializing video stream...`,
          camera: { ...registered, stream_url: clientStreamUrl },
          streamUrl: clientStreamUrl
        });
      }

      return res.status(422).json({
        success: false,
        status: 'Unsupported',
        error: 'Device detected but the camera protocol is not supported.',
        hint: `Host ${host} responded on open ports, but neither RTSP nor HTTP camera video streams could be authenticated.`
      });
    } catch (err) {
      res.status(500).json({ success: false, status: 'Connection error', error: err.message });
    }
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
      const isHttp = req.body.streamType === 'HTTP_MJPEG' || 
                     (rtspUrl && (rtspUrl.startsWith('http://') || rtspUrl.startsWith('https://'))) || 
                     (camPath && (camPath.includes('video') || camPath.includes('shot.jpg'))) ||
                     (name && name.includes('IP Webcam'));

      if ((!finalRtspUrl || finalRtspUrl.startsWith('/api/') || !finalRtspUrl.includes('://')) && ip) {
        const u = username ? encodeURIComponent(username) : '';
        const p = password ? encodeURIComponent(password) : '';
        const authPart = (u || p) ? `${u}:${p}@` : '';
        const portPart = port ? `:${port}` : '';
        const defaultPath = isHttp ? '/video' : '/Streaming/Channels/101';
        const pathPart = camPath ? (camPath.startsWith('/') ? camPath : `/${camPath}`) : defaultPath;
        finalRtspUrl = isHttp ? `http://${authPart}${ip}${portPart}${pathPart}` : `rtsp://${authPart}${ip}${portPart}${pathPart}`;
      } else if (isHttp && ip && !finalRtspUrl.includes('@') && (username || password)) {
        const u = username ? encodeURIComponent(username) : '';
        const p = password ? encodeURIComponent(password) : '';
        const authPart = (u || p) ? `${u}:${p}@` : '';
        const portPart = port ? `:${port}` : '';
        finalRtspUrl = `http://${authPart}${ip}${portPart}${camPath || '/video'}`;
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
      try {
        if (typeof db.saveLocalCredentials === 'function') {
          db.saveLocalCredentials({ username: username || '', password: password || '', ip: ip || targetHost || '', port: port || 554, cameraId: camId });
        }
      } catch (_e) {}

      // Only launch FFmpeg/RTSP ingest for actual RTSP streams (not HTTP proxy streams)
      const isRtspStream = finalRtspUrl.startsWith('rtsp://') || finalRtspUrl.startsWith('rtsps://');
      if (isRtspStream) {
        try {
          rtspStreamManager.startStream(registered.id, registered.stream_url);
        } catch (streamErr) {
          console.warn(`[RtspStreamManager] Could not start stream for ${registered.id}:`, streamErr.message);
        }
      }

      const clientStreamUrl = `/api/cameras/${registered.id}/stream.mjpg`;

      res.status(201).json({
        success: true,
        message: 'Camera connected and added to surveillance system',
        camera: {
          ...registered,
          stream_url: clientStreamUrl
        },
        streamUrl: clientStreamUrl
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
      const sanitized = cameras.map(cam => ({
        id: cam.id,
        organization_id: cam.organization_id,
        name: cam.name,
        stream_url: `/api/cameras/${cam.id}/stream.mjpg`,
        zone_name: cam.zone_name,
        status: cam.status,
        last_active_at: cam.last_active_at,
        created_at: cam.created_at
      }));
      res.json({ success: true, count: sanitized.length, cameras: sanitized });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/cameras/:id/stream.mjpg
   * High-speed multipart MJPEG stream from physical camera
   */
  router.get('/api/cameras/:id/stream.mjpg', (req, res) => {
    try {
      const orgId = req.organization_id || db.getActiveAccount()?.organization_id || 'ORG-DEFAULT';
      const camera = db.getCamera(req.params.id) || db.getCameras(orgId).find(c => c.id === req.params.id);

      if (!camera) {
        return res.status(404).json({ error: 'CameraNotFound', message: `Camera ${req.params.id} not found.` });
      }

      const streamUrl = camera.stream_url || '';
      const isHttp = streamUrl.startsWith('http://') || streamUrl.startsWith('https://') || streamUrl.startsWith('/api/proxy-stream');

      if (isHttp) {
        const { pipeHttpCameraStream } = require('../services/http_camera_client');
        return pipeHttpCameraStream(streamUrl, res, req);
      }

      rtspStreamManager.handleMjpegRequest(req, res, req.params.id, streamUrl);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/cameras/:id/snapshot.jpg
   * Latest full-resolution JPEG snapshot from camera
   */
  router.get('/api/cameras/:id/snapshot.jpg', (req, res) => {
    try {
      const orgId = req.organization_id || db.getActiveAccount()?.organization_id || 'ORG-DEFAULT';
      const camera = db.getCamera(req.params.id) || db.getCameras(orgId).find(c => c.id === req.params.id);
      if (camera && camera.stream_url && (camera.stream_url.startsWith('http://') || camera.stream_url.startsWith('https://'))) {
        const shotUrl = camera.stream_url.replace(/\/video$/, '/shot.jpg');
        const { pipeHttpCameraStream } = require('../services/http_camera_client');
        return pipeHttpCameraStream(shotUrl, res, req);
      }
      rtspStreamManager.handleSnapshotRequest(req, res, req.params.id, camera?.stream_url);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
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
   * DELETE /api/cameras
   * Remove ALL cameras from surveillance and terminate their streams (Full Reset)
   */
  router.delete('/api/cameras', (req, res) => {
    try {
      const orgId = req.organization_id || db.getActiveAccount()?.organization_id || 'ORG-DEFAULT';
      const existingCameras = db.getCameras(orgId);
      for (const cam of existingCameras) {
        rtspStreamManager.stopStream(cam.id);
        db.removeCamera(orgId, cam.id);
      }
      if (typeof db.clearLocalCredentials === 'function') {
        db.clearLocalCredentials();
      }
      res.json({ success: true, message: 'All cameras and saved credentials cleared from database' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
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

  /**
   * GET /api/cctv/credentials
   * Retrieve locally saved CCTV credentials strictly from local SQLite DB
   */
  router.get('/api/cctv/credentials', (req, res) => {
    try {
      const creds = typeof db.getLocalCredentials === 'function' ? db.getLocalCredentials() : null;
      res.json({
        success: true,
        credentials: {
          username: creds?.username || '',
          password: creds?.password || '',
          ip: creds?.ip || '',
          port: creds?.port || 554,
          cameraId: creds?.camera_id || '',
          storageLocation: 'Local SQLite (ceova_cctv.db) - Never sent to external cloud'
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/cctv/credentials
   * Save user CCTV credentials strictly into local SQLite DB
   */
  /**
   * DELETE /api/cctv/credentials
   * Clear locally saved CCTV credentials from SQLite DB
   */
  router.delete('/api/cctv/credentials', (req, res) => {
    try {
      if (typeof db.clearLocalCredentials === 'function') {
        db.clearLocalCredentials();
      }
      res.json({ success: true, message: 'Local credentials cleared' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.post('/api/cctv/credentials', (req, res) => {
    try {
      const { username, password, ip, port, cameraId, action } = req.body || {};
      if (action === 'clear' || action === 'disconnect') {
        if (typeof db.clearLocalCredentials === 'function') {
          db.clearLocalCredentials();
        }
        return res.json({ success: true, message: 'Local credentials cleared' });
      }
      let saved = null;
      if (typeof db.saveLocalCredentials === 'function') {
        saved = db.saveLocalCredentials({ username, password, ip, port, cameraId });
      }
      res.json({ success: true, credentials: saved, message: 'Saved locally on device' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/cctv/details
   * Live CCTV details for CEOVA Desktop AI Assistant (Cameras, Credentials, Local IP)
   */
  router.get('/api/cctv/details', (req, res) => {
    try {
      const orgId = req.organization_id || db.getActiveAccount()?.organization_id || 'ORG-DEFAULT';
      const cameras = db.getCameras(orgId);
      const creds = typeof db.getLocalCredentials === 'function' ? db.getLocalCredentials() : null;
      
      const targetIp = creds?.ip || (cameras[0]?.name?.match(/(\d{1,3}(?:\.\d{1,3}){3})/)?.[1]) || (cameras[0]?.ip) || 'Local Network';
      const targetPort = creds?.port || (cameras[0]?.name?.match(/:(\d+)\)/)?.[1]) || 554;
      const latestReport = typeof db.getLatestBackgroundReport === 'function' ? db.getLatestBackgroundReport() : null;

      res.json({
        success: true,
        connected: cameras.length > 0,
        cameraCount: cameras.length,
        cameras: cameras.map(c => ({
          id: c.id,
          name: c.name,
          ip: c.ip || (c.name?.match(/(\d{1,3}(?:\.\d{1,3}){3})/)?.[1]) || targetIp,
          port: targetPort,
          stream_url: c.stream_url,
          zone_name: c.zone_name,
          status: c.status
        })),
        credentials: {
          username: creds?.username || 'admin',
          hasPassword: !!(creds?.password),
          ip: `${targetIp}:${targetPort}`,
          storage: 'Local device only (Strictly NOT on server)'
        },
        occupancy: {
          activePeople: 0,
          peakToday: 0
        },
        latestReport: latestReport?.summary || null
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/cctv/token
   * Serves loopback token strictly to local machine clients
   */
    /**
   * GET /api/cctv/reports/latest
   * Latest background surveillance report
   */
  router.get('/api/cctv/reports/latest', (req, res) => {
    try {
      const latest = typeof db.getLatestBackgroundReport === 'function' ? db.getLatestBackgroundReport() : null;
      res.json({
        success: true,
        report: latest
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/cctv/reports
   * List background surveillance reports
   */
  router.get('/api/cctv/reports', (req, res) => {
    try {
      const limit = parseInt(req.query.limit, 10) || 10;
      const reports = typeof db.getBackgroundReports === 'function' ? db.getBackgroundReports(limit) : [];
      res.json({
        success: true,
        reports
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/api/cctv/token', (req, res) => {
    const remoteIp = req.socket.remoteAddress || '';
    const isLoopback = remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1';
    if (!isLoopback) {
      return res.status(403).json({ error: 'Forbidden: Loopback only' });
    }
    try {
      const { resolveDataDir } = require('../db/database');
      const tokenPath = require('path').join(resolveDataDir(), 'config', 'loopback.token');
      if (require('fs').existsSync(tokenPath)) {
        const token = require('fs').readFileSync(tokenPath, 'utf8').trim();
        return res.json({ success: true, token });
      }
      res.status(404).json({ error: 'Token not found' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = {
  createCameraDiscoveryRouter
};
