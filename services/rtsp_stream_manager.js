/**
 * CEOVA CCTV // RTSP Stream Manager & Transcoding Engine
 * services/rtsp_stream_manager.js
 * 
 * Ingests live RTSP feeds from physical IP cameras (Hikvision, Dahua, ONVIF, CP Plus, etc.)
 * using FFmpeg hardware-accelerated transcoding.
 * - Extracts real-time JPEG frames via stdout pipe
 * - Serves low-latency HTTP Multipart MJPEG streams (/api/cameras/:id/stream.mjpg)
 * - Broadcasts frames over WebSockets for instant browser display
 * - Handles Digest/Basic auth, automatic reconnection, and diagnostic error states
 */

const { spawn } = require('child_process');
const EventEmitter = require('events');
const jpeg = require('jpeg-js');

function createPlaceholderFrame() {
  const width = 640;
  const height = 360;
  const buffer = Buffer.alloc(width * height * 4);
  for (let i = 0; i < buffer.length; i += 4) {
    buffer[i] = 15;     // R
    buffer[i + 1] = 23; // G
    buffer[i + 2] = 42; // B
    buffer[i + 3] = 255;// A
  }
  return jpeg.encode({ data: buffer, width, height }, 65).data;
}
const DEFAULT_PLACEHOLDER = createPlaceholderFrame();

class RtspStreamInstance extends EventEmitter {
  constructor(cameraId, rtspUrl, options = {}) {
    super();
    this.cameraId = cameraId;
    this.rtspUrl = rtspUrl;
    this.options = options;
    this.process = null;
    this.isRunning = false;
    this.lastFrame = null;
    this.lastFrameTime = 0;
    this.fps = 0;
    this.frameCount = 0;
    this.fpsTimer = null;
    this.clients = new Set();
    this.lastError = null;
    this.restartAttempts = 0;
    this.maxRestartAttempts = 5;
    this.reconnectTimer = null;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastError = null;

    // Find ffmpeg in system PATH (works on Windows, Mac, Linux)
    const ffmpegPath = this.options.ffmpegPath ||
      (process.platform === 'win32' ? 'ffmpeg' : '/usr/local/bin/ffmpeg');

    // Low-latency RTSP to MJPEG pipe arguments
    const args = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-rtsp_transport', 'tcp',
      '-reorder_queue_size', '5',
      '-buffer_size', '1024000',
      '-i', this.rtspUrl,
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-q:v', '3',
      '-vf', 'fps=15,scale=1280:-1',
      '-'
    ];

    try {
      this.process = spawn(ffmpegPath, args);
    } catch (err) {
      this.lastError = `Failed to spawn FFmpeg: ${err.message}`;
      this.emit('error', this.lastError);
      return;
    }

    let buffer = Buffer.alloc(0);

    this.process.stdout.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      // Look for JPEG markers: SOI = 0xFF, 0xD8 and EOI = 0xFF, 0xD9
      let soi = buffer.indexOf(Buffer.from([0xFF, 0xD8]));
      while (soi !== -1) {
        const eoi = buffer.indexOf(Buffer.from([0xFF, 0xD9]), soi + 2);
        if (eoi !== -1) {
          const frame = buffer.slice(soi, eoi + 2);
          buffer = buffer.slice(eoi + 2);

          this._handleNewFrame(frame);
          soi = buffer.indexOf(Buffer.from([0xFF, 0xD8]));
        } else {
          // If we have SOI but haven't received EOI yet, keep remaining buffer
          if (soi > 0) {
            buffer = buffer.slice(soi);
          }
          break;
        }
      }

      // Safety guard against memory leak if buffer grows too large without valid JPEG
      if (buffer.length > 5 * 1024 * 1024) {
        buffer = Buffer.alloc(0);
      }
    });

    this.process.stderr.on('data', (chunk) => {
      const errStr = chunk.toString();
      if (errStr.includes('401') || errStr.includes('Unauthorized') || errStr.includes('authorization failed')) {
        this.lastError = 'RTSP 401 Unauthorized: Invalid camera username or password.';
        this.emit('auth-failed', this.lastError);
      } else if (errStr.includes('Connection refused') || errStr.includes('No route to host')) {
        this.lastError = 'Camera offline or unreachable on network.';
      } else if (errStr.includes('404') || errStr.includes('Not Found')) {
        this.lastError = 'RTSP 404: Stream channel or path not found on camera.';
      }
    });

    this.process.on('close', (code) => {
      this.isRunning = false;
      this.process = null;

      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

      // Auto-reconnect if not explicitly stopped
      if (!this.stoppedByUser && this.restartAttempts < this.maxRestartAttempts) {
        this.restartAttempts++;
        const delay = Math.min(10000, this.restartAttempts * 2000);
        this.reconnectTimer = setTimeout(() => {
          if (!this.stoppedByUser) this.start();
        }, delay);
      }
    });

    this.process.on('error', (err) => {
      this.lastError = err.message;
      // Log gracefully — do not re-emit so Node doesn't crash on unhandled error event
      console.warn(`[RtspStreamInstance] FFmpeg error for ${this.cameraId}: ${err.message}`);
      this.isRunning = false;
    });

    // Start FPS counter
    this.fpsTimer = setInterval(() => {
      this.fps = this.frameCount;
      this.frameCount = 0;
    }, 1000);
  }

  _handleNewFrame(frameBuffer) {
    this.lastFrame = frameBuffer;
    this.lastFrameTime = Date.now();
    this.frameCount++;
    this.restartAttempts = 0; // Reset restart counter on successful frame

    // 1. Deliver to active HTTP Multipart MJPEG clients
    if (this.clients.size > 0) {
      const header = Buffer.from(
        `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frameBuffer.length}\r\n\r\n`
      );
      const footer = Buffer.from('\r\n');

      for (const res of this.clients) {
        try {
          res.write(header);
          res.write(frameBuffer);
          res.write(footer);
        } catch (_err) {
          this.clients.delete(res);
        }
      }
    }

    // 2. Emit event for WebSocket broadcaster
    this.emit('frame', frameBuffer);
  }

  stop() {
    this.stoppedByUser = true;
    this.isRunning = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.fpsTimer) clearInterval(this.fpsTimer);

    if (this.process) {
      try {
        this.process.kill('SIGTERM');
      } catch (_e) {}
      this.process = null;
    }

    // Close any active client HTTP responses
    for (const res of this.clients) {
      try {
        res.end();
      } catch (_e) {}
    }
    this.clients.clear();
  }

  addClient(res) {
    this.clients.add(res);

    // If we have a cached frame, send it immediately; otherwise send placeholder for zero-wait display
    const frameToSend = this.lastFrame || DEFAULT_PLACEHOLDER;
    try {
      res.write(Buffer.from(
        `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frameToSend.length}\r\n\r\n`
      ));
      res.write(frameToSend);
      res.write(Buffer.from('\r\n'));
    } catch (_e) {}
  }

  removeClient(res) {
    this.clients.delete(res);
  }
}

class RtspStreamManager {
  constructor(options = {}) {
    this.options = options;
    this.streams = new Map(); // cameraId -> RtspStreamInstance
    this.activeCameraId = null;
    this.wsBroadcastCallback = null;
  }

  setWsBroadcastCallback(callback) {
    this.wsBroadcastCallback = callback;
  }

  /**
   * Start or retrieve an active RTSP stream for a camera
   */
  startStream(cameraId, rtspUrl) {
    if (!rtspUrl) throw new Error('RTSP URL is required to start stream');

    let stream = this.streams.get(cameraId);
    if (stream) {
      if (stream.rtspUrl !== rtspUrl) {
        stream.stop();
        this.streams.delete(cameraId);
      } else {
        if (!stream.isRunning) stream.start();
        this.activeCameraId = cameraId;
        return stream;
      }
    }

    stream = new RtspStreamInstance(cameraId, rtspUrl, this.options);
    
    // Forward frames to WebSocket broadcaster if registered
    stream.on('frame', (frameBuffer) => {
      if (this.wsBroadcastCallback) {
        const dataUri = `data:image/jpeg;base64,${frameBuffer.toString('base64')}`;
        this.wsBroadcastCallback({
          type: 'frame',
          cameraId,
          image: dataUri,
          fps: stream.fps
        });
      }
    });

    stream.start();
    this.streams.set(cameraId, stream);
    this.activeCameraId = cameraId;
    return stream;
  }

  getStream(cameraId) {
    return this.streams.get(cameraId);
  }

  stopStream(cameraId) {
    const stream = this.streams.get(cameraId);
    if (stream) {
      stream.stop();
      this.streams.delete(cameraId);
      if (this.activeCameraId === cameraId) {
        this.activeCameraId = null;
      }
    }
  }

  stopAll() {
    for (const [id, stream] of this.streams.entries()) {
      stream.stop();
    }
    this.streams.clear();
    this.activeCameraId = null;
  }

  /**
   * Express HTTP Handler for multipart MJPEG streaming:
   * GET /api/cameras/:id/stream.mjpg
   */
  handleMjpegRequest(req, res, cameraId, fallbackRtspUrl = null) {
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=frame'
      });
      return res.end();
    }

    let stream = this.streams.get(cameraId);

    if (!stream && fallbackRtspUrl) {
      // Only start FFmpeg for real RTSP streams — skip HTTP/proxy URLs
      const isRtsp = fallbackRtspUrl.startsWith('rtsp://') || fallbackRtspUrl.startsWith('rtsps://');
      if (isRtsp) {
        stream = this.startStream(cameraId, fallbackRtspUrl);
      } else {
        // For HTTP streams, redirect the browser directly to the proxy URL
        res.redirect(302, fallbackRtspUrl);
        return;
      }
    }

    if (!stream) {
      return res.status(404).json({
        error: 'StreamNotFound',
        message: `Camera ${cameraId} has no active stream configured.`
      });
    }

    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Connection': 'close',
      'Pragma': 'no-cache'
    });

    stream.addClient(res);

    req.on('close', () => {
      stream.removeClient(res);
    });
  }

  /**
   * Get single latest snapshot:
   * GET /api/cameras/:id/snapshot.jpg
   */
  handleSnapshotRequest(req, res, cameraId) {
    const stream = this.streams.get(cameraId);
    if (!stream || !stream.lastFrame) {
      return res.status(404).send('No snapshot available yet');
    }

    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': stream.lastFrame.length,
      'Cache-Control': 'no-cache'
    });
    res.end(stream.lastFrame);
  }
}

// Singleton instance
const rtspStreamManager = new RtspStreamManager();

module.exports = {
  RtspStreamManager,
  rtspStreamManager
};
