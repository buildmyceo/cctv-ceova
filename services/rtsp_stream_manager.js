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
const path = require('path');
const fs = require('fs');
const jpeg = require('jpeg-js');

/**
 * Safely redact credentials from RTSP URLs to prevent leaking passwords
 */
function redactRtspUrl(url) {
  if (!url || typeof url !== 'string') return '';
  return url.replace(/:\/\/([^:@/]+):([^@/]+)@/, '://$1:***@');
}

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
    this.transport = options.transport || 'tcp'; // 'tcp' | 'udp'
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

    // 1. Resolve FFmpeg: prioritize bundled runtime/bin/ffmpeg
    let ffmpegPath = this.options.ffmpegPath;
    if (!ffmpegPath) {
      const bundledFfmpeg = path.resolve(__dirname, '..', 'runtime', 'bin', 'ffmpeg');
      if (fs.existsSync(bundledFfmpeg)) {
        ffmpegPath = bundledFfmpeg;
      } else if (process.platform === 'darwin') {
        if (fs.existsSync('/opt/homebrew/bin/ffmpeg')) {
          ffmpegPath = '/opt/homebrew/bin/ffmpeg';
        } else if (fs.existsSync('/usr/local/bin/ffmpeg')) {
          ffmpegPath = '/usr/local/bin/ffmpeg';
        } else {
          ffmpegPath = 'ffmpeg';
        }
      } else if (process.platform !== 'win32') {
        if (fs.existsSync('/usr/local/bin/ffmpeg')) {
          ffmpegPath = '/usr/local/bin/ffmpeg';
        } else if (fs.existsSync('/usr/bin/ffmpeg')) {
          ffmpegPath = '/usr/bin/ffmpeg';
        } else {
          ffmpegPath = 'ffmpeg';
        }
      } else {
        ffmpegPath = 'ffmpeg';
      }
    }

    // 2. Prepare low-latency RTSP to MJPEG pipe arguments
    let inputUrl = this.rtspUrl;
    const args = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-rtsp_transport', this.transport,
      '-reorder_queue_size', '10',
      '-buffer_size', '4096000',
      '-timeout', '12000000',
      '-i', inputUrl,
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-q:v', '3',
      '-vf', 'fps=15,scale=1280:-2',
      '-'
    ];

    try {
      this.process = spawn(ffmpegPath, args);
    } catch (err) {
      this.lastError = `Failed to spawn FFmpeg: ${redactRtspUrl(err.message)}`;
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
          // If we have SOI but haven't received EOI yet, keep remaining buffer from SOI
          if (soi > 0) {
            buffer = buffer.slice(soi);
          }
          break;
        }
      }

      // Drop stale bytes if no SOI found and buffer exceeds 512KB
      if (soi === -1 && buffer.length > 512 * 1024) {
        const lastByte = buffer[buffer.length - 1];
        buffer = lastByte === 0xFF ? buffer.slice(-1) : Buffer.alloc(0);
      }
    });

    this.process.stderr.on('data', (chunk) => {
      const rawText = chunk.toString();
      const errStr = redactRtspUrl(rawText);
      if (errStr.trim()) {
        console.warn(`[RtspStreamInstance ${this.cameraId}] FFmpeg (${this.transport}): ${errStr.trim()}`);
      }

      if (errStr.includes('401') || errStr.includes('Unauthorized') || errStr.includes('authorization failed')) {
        this.lastError = 'RTSP 401 Unauthorized: Invalid camera username or password.';
        this.emit('auth-failed', this.lastError);
      } else if (errStr.includes('461') || errStr.includes('Unsupported Transport') || errStr.includes('method SETUP failed')) {
        this.lastError = 'Camera requires UDP transport. Switching transport to UDP...';
        this.transport = 'udp';
      } else if (errStr.includes('Connection refused') || errStr.includes('No route to host')) {
        this.lastError = 'Camera offline or unreachable on network.';
      } else if (errStr.includes('404') || errStr.includes('Not Found')) {
        this.lastError = 'RTSP 404: Stream channel or path not found on camera.';
      } else if (errStr.includes('Connection timed out') || errStr.includes('timed out')) {
        this.lastError = 'Camera connection timed out waiting for video keyframe.';
      } else if (!this.lastError) {
        this.lastError = errStr.trim().split('\n').pop();
      }
    });

    this.process.on('close', (code) => {
      this.isRunning = false;
      this.process = null;

      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

      // Auto-reconnect if not explicitly stopped
      if (!this.stoppedByUser && this.restartAttempts < this.maxRestartAttempts) {
        this.restartAttempts++;
        // If TCP failed on first attempt, try UDP on second attempt
        if (this.restartAttempts === 1 && this.transport === 'tcp') {
          console.log(`[RtspStreamInstance ${this.cameraId}] Retrying stream with UDP transport fallback...`);
          this.transport = 'udp';
        }
        const delay = Math.min(8000, this.restartAttempts * 1500);
        this.reconnectTimer = setTimeout(() => {
          if (!this.stoppedByUser) this.start();
        }, delay);
      }
    });

    this.process.on('error', (err) => {
      this.lastError = redactRtspUrl(err.message);
      console.warn(`[RtspStreamInstance] FFmpeg spawn error for ${this.cameraId}: ${this.lastError}`);
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
      const proc = this.process;
      this.process = null;
      try {
        proc.kill('SIGTERM');
        setTimeout(() => {
          try { process.kill(proc.pid, 0); proc.kill('SIGKILL'); } catch (_e) {}
        }, 1500).unref();
      } catch (_e) {}
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
      const isRtsp = fallbackRtspUrl.startsWith('rtsp://') || fallbackRtspUrl.startsWith('rtsps://');
      if (isRtsp) {
        stream = this.startStream(cameraId, fallbackRtspUrl);
      } else {
        const { pipeHttpCameraStream } = require('./http_camera_client');
        return pipeHttpCameraStream(fallbackRtspUrl, res, req);
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
      'Connection': 'keep-alive',
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
  handleSnapshotRequest(req, res, cameraId, fallbackRtspUrl = null) {
    let stream = this.streams.get(cameraId);
    if (!stream && fallbackRtspUrl) {
      const isRtsp = fallbackRtspUrl.startsWith('rtsp://') || fallbackRtspUrl.startsWith('rtsps://');
      if (isRtsp) {
        stream = this.startStream(cameraId, fallbackRtspUrl);
      }
    }

    const frame = (stream && stream.lastFrame) ? stream.lastFrame : DEFAULT_PLACEHOLDER;
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': frame.length,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache'
    });
    res.end(frame);
  }
}

// Singleton instance
const rtspStreamManager = new RtspStreamManager();

module.exports = {
  RtspStreamManager,
  rtspStreamManager
};
