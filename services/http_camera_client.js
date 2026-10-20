/**
 * CEOVA CCTV // HTTP Camera Client & Digest Auth Engine
 * services/http_camera_client.js
 *
 * Supports both HTTP Basic and RFC 2617 / 7616 HTTP Digest Authentication
 * with keep-alive socket reuse for IP Webcam (Android), DroidCam, and mobile IP cameras.
 */

const net = require('net');
const crypto = require('crypto');
const { URL } = require('url');

/**
 * Compute RFC 2617 HTTP Digest Authorization Header
 */
function computeDigestHeader(username, password, method, uri, authHeader, nc = '00000001', cnonce = null) {
  const params = {};
  const re = /(\w+)=(?:\"([^\"]*)\"|([^,]*))/g;
  let match;
  while ((match = re.exec(authHeader)) !== null) {
    params[match[1]] = match[2] || match[3];
  }

  const md5 = str => crypto.createHash('md5').update(str).digest('hex');
  const realm = params.realm || 'IP Webcam';
  const nonce = params.nonce || '';
  const qop = params.qop;

  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);

  if (!cnonce) {
    cnonce = crypto.randomBytes(8).toString('hex');
  }

  let response;
  if (qop === 'auth' || (qop && qop.includes('auth'))) {
    response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`);
  } else {
    response = md5(`${ha1}:${nonce}:${ha2}`);
  }

  let header = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
  if (qop) {
    header += `, qop=auth, nc=${nc}, cnonce="${cnonce}"`;
  }
  if (params.opaque) {
    header += `, opaque="${params.opaque}"`;
  }
  return header;
}

/**
 * Fast TCP probe to find open ports on a host
 */
function findOpenPorts(host, portList = [554, 8500, 5856, 8080, 8081, 8082, 8090, 4747, 8000, 8888, 1025, 1029, 1055, 80, 8554, 5000, 8088], timeoutMs = 800) {
  return new Promise((resolve) => {
    const openPorts = [];
    let pending = portList.length;
    if (pending === 0) return resolve([]);

    portList.forEach(port => {
      const sock = new net.Socket();
      sock.setTimeout(timeoutMs);
      sock.on('connect', () => {
        openPorts.push(port);
        sock.destroy();
      });
      sock.on('error', () => { sock.destroy(); });
      sock.on('timeout', () => { sock.destroy(); });
      sock.on('close', () => {
        pending--;
        if (pending === 0) resolve(openPorts);
      });
      sock.connect(port, host);
    });
  });
}

/**
 * Probe an HTTP Camera endpoint supporting Basic & Digest Authentication
 * Returns: { success: true/false, status: 'CONNECTED'|'AUTH_FAILED'|'UNREACHABLE'|'UNSUPPORTED', ... }
 */
function probeHttpCamera(host, port, username = '', password = '', timeoutMs = 2500) {
  return new Promise((resolve) => {
    const pathsToTry = [
      '/video', '/shot.jpg', '/live', '/mjpeg', '/mjpg/video.mjpg',
      '/videostream.cgi', '/axis-cgi/mjpg/video.cgi', '/image.jpg', '/snapshot.jpg', '/'
    ];
    let pathIdx = 0;
    let isResolved = false;

    const finish = (result) => {
      if (!isResolved) {
        isResolved = true;
        resolve(result);
      }
    };

    function tryNextPath() {
      if (isResolved) return;
      if (pathIdx >= pathsToTry.length) {
        return finish({ success: false, status: 'UNSUPPORTED', reason: 'No valid camera stream path found' });
      }

      const targetPath = pathsToTry[pathIdx++];
      const sock = new net.Socket();
      let headerBuf = '';
      let timer = null;

      const cleanupSock = () => {
        if (timer) clearTimeout(timer);
        try { sock.destroy(); } catch (_) {}
      };

      timer = setTimeout(() => {
        cleanupSock();
        tryNextPath();
      }, timeoutMs);

      sock.on('error', () => {
        cleanupSock();
        tryNextPath();
      });

      sock.on('close', () => {
        cleanupSock();
        if (!isResolved && headerBuf === '') {
          tryNextPath();
        }
      });

      sock.connect(port, host, () => {
        let req = `GET ${targetPath} HTTP/1.1\r\nHost: ${host}:${port}\r\nUser-Agent: Ceova/1.0\r\nAccept: image/jpeg, multipart/x-mixed-replace, */*\r\n`;
        if (username || password) {
          const basic = Buffer.from(`${username}:${password}`).toString('base64');
          req += `Authorization: Basic ${basic}\r\n`;
        }
        req += '\r\n';
        sock.write(req);
      });

      sock.on('data', (chunk) => {
        headerBuf += chunk.toString('latin1');
        const headerEnd = headerBuf.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;

        const rawHeaders = headerBuf.slice(0, headerEnd);
        const firstLine = rawHeaders.split('\r\n')[0] || '';
        const statusCode = parseInt(firstLine.split(' ')[1], 10);

        // Digest Auth Challenge on 401
        if (statusCode === 401 && headerBuf.toLowerCase().includes('digest') && (username || password)) {
          cleanupSock();
          // Connect fresh socket with calculated Digest Authorization
          const authHdr = computeDigestHeader(username, password, 'GET', targetPath, rawHeaders);
          const digestSock = new net.Socket();
          let digestBuf = '';

          const digestTimer = setTimeout(() => {
            try { digestSock.destroy(); } catch (_) {}
            tryNextPath();
          }, timeoutMs);

          digestSock.on('error', () => {
            clearTimeout(digestTimer);
            try { digestSock.destroy(); } catch (_) {}
            tryNextPath();
          });

          digestSock.on('data', (dChunk) => {
            digestBuf += dChunk.toString('latin1');
            const dEnd = digestBuf.indexOf('\r\n\r\n');
            if (dEnd === -1) return;

            clearTimeout(digestTimer);
            try { digestSock.destroy(); } catch (_) {}

            const dHeaders = digestBuf.slice(0, dEnd);
            const dLine = dHeaders.split('\r\n')[0] || '';
            const dCode = parseInt(dLine.split(' ')[1], 10);

            if (dCode === 200) {
              const lower = dHeaders.toLowerCase();
              return finish({
                success: true,
                status: 'CONNECTED',
                brand: lower.includes('ip webcam') ? 'IP Webcam' : 'HTTP MJPEG Camera',
                path: targetPath,
                port,
                authType: 'Digest'
              });
            } else if (dCode === 401) {
              return finish({
                success: false,
                status: 'AUTH_FAILED',
                reason: 'Authentication failed: Invalid camera username or password (401 Unauthorized).'
              });
            } else {
              tryNextPath();
            }
          });

          digestSock.connect(port, host, () => {
            const authReq = `GET ${targetPath} HTTP/1.1\r\nHost: ${host}:${port}\r\nAuthorization: ${authHdr}\r\nUser-Agent: Ceova/1.0\r\nAccept: image/jpeg, multipart/x-mixed-replace, */*\r\n\r\n`;
            digestSock.write(authReq);
          });
          return;
        }

        cleanupSock();

        if (statusCode === 200) {
          const lowerHeaders = rawHeaders.toLowerCase();
          const isCamera = lowerHeaders.includes('multipart') ||
                           lowerHeaders.includes('image') ||
                           lowerHeaders.includes('video') ||
                           lowerHeaders.includes('ip webcam') ||
                           lowerHeaders.includes('boundary=') ||
                           targetPath === '/video' ||
                           targetPath === '/shot.jpg';

          if (isCamera) {
            const isIpWebcam = lowerHeaders.includes('ip webcam');
            finish({
              success: true,
              status: 'CONNECTED',
              brand: isIpWebcam ? 'IP Webcam' : 'HTTP MJPEG Camera',
              path: targetPath,
              port,
              authType: username ? 'Basic' : 'None'
            });
          } else {
            tryNextPath();
          }
        } else if (statusCode === 401) {
          finish({
            success: false,
            status: 'AUTH_FAILED',
            reason: 'Authentication failed: Invalid camera username or password (401 Unauthorized).'
          });
        } else {
          tryNextPath();
        }
      });
    }

    tryNextPath();
  });
}

/**
 * Stream an HTTP MJPEG / IP Webcam feed directly into Express response
 * Handles 401 Digest Auth re-challenge on the same connection seamlessly.
 */
function pipeHttpCameraStream(streamUrl, res, req) {
  let parsedUrl;
  try {
    parsedUrl = new URL(streamUrl);
  } catch (err) {
    if (!res.headersSent) res.status(400).json({ error: 'Invalid camera stream URL' });
    return;
  }

  const host = parsedUrl.hostname;
  const port = parseInt(parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80), 10);
  const targetPath = parsedUrl.pathname + (parsedUrl.search || '') || '/video';
  const username = decodeURIComponent(parsedUrl.username || '');
  const password = decodeURIComponent(parsedUrl.password || '');

  const sock = new net.Socket();
  let state = 0; // 0: initial, 1: authenticating, 2: streaming
  let headerBuf = '';

  sock.setTimeout(8000);
  sock.on('timeout', () => {
    try { sock.destroy(); } catch (_) {}
    if (!res.headersSent) res.status(504).json({ error: 'Camera connection timed out' });
  });

  sock.on('error', (err) => {
    if (!res.headersSent) res.status(502).json({ error: `Camera stream error: ${err.message}` });
  });

  sock.connect(port, host, () => {
    let initialReq = `GET ${targetPath} HTTP/1.1\r\nHost: ${host}:${port}\r\nUser-Agent: Ceova/1.0\r\nAccept: */*\r\n`;
    if (username || password) {
      const basic = Buffer.from(`${username}:${password}`).toString('base64');
      initialReq += `Authorization: Basic ${basic}\r\n`;
    }
    initialReq += '\r\n';
    sock.write(initialReq);
  });

  sock.on('data', (chunk) => {
    if (state === 2) {
      res.write(chunk);
      return;
    }

    headerBuf += chunk.toString('latin1');
    const headerEnd = headerBuf.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;

    const rawHeaders = headerBuf.slice(0, headerEnd);
    const firstLine = rawHeaders.split('\r\n')[0] || '';
    const statusCode = parseInt(firstLine.split(' ')[1], 10);

    // Digest Challenge
    if (statusCode === 401 && state === 0 && headerBuf.toLowerCase().includes('digest') && (username || password)) {
      state = 1;
      const authHdr = computeDigestHeader(username, password, 'GET', targetPath, rawHeaders);
      try { sock.destroy(); } catch (_) {}

      const authSock = new net.Socket();
      authSock.setTimeout(8000);
      authSock.on('timeout', () => {
        try { authSock.destroy(); } catch (_) {}
        if (!res.headersSent) res.status(504).json({ error: 'Camera connection timed out' });
      });
      authSock.on('error', (err) => {
        if (!res.headersSent) res.status(502).json({ error: `Camera stream error: ${err.message}` });
      });

      req.on('close', () => {
        try { authSock.destroy(); } catch (_) {}
      });

      let aBuf = '';
      let aStreaming = false;

      authSock.connect(port, host, () => {
        const authReq = `GET ${targetPath} HTTP/1.1\r\nHost: ${host}:${port}\r\nAuthorization: ${authHdr}\r\nUser-Agent: Ceova/1.0\r\nAccept: */*\r\n\r\n`;
        authSock.write(authReq);
      });

      authSock.on('data', (cChunk) => {
        if (aStreaming) {
          res.write(cChunk);
          return;
        }

        aBuf += cChunk.toString('latin1');
        const aEnd = aBuf.indexOf('\r\n\r\n');
        if (aEnd === -1) return;

        const aHeaders = aBuf.slice(0, aEnd);
        const aLine = aHeaders.split('\r\n')[0] || '';
        const aCode = parseInt(aLine.split(' ')[1], 10);

        if (aCode === 200) {
          aStreaming = true;
          authSock.setTimeout(0);
          let cType = 'multipart/x-mixed-replace;boundary=frame';
          aHeaders.split('\r\n').slice(1).forEach(line => {
            const colon = line.indexOf(':');
            if (colon > 0) {
              const k = line.slice(0, colon).trim().toLowerCase();
              const v = line.slice(colon + 1).trim();
              if (k === 'content-type') cType = v;
            }
          });

          res.writeHead(200, {
            'Content-Type': cType,
            'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0',
            'Access-Control-Allow-Origin': '*',
            'X-Accel-Buffering': 'no',
            'Connection': 'keep-alive'
          });

          const rem = cChunk.slice(Buffer.from(aHeaders, 'latin1').length + 4);
          if (rem.length > 0) res.write(rem);
        } else {
          try { authSock.destroy(); } catch (_) {}
          if (!res.headersSent) res.status(aCode || 401).json({ error: 'Camera authentication failed' });
        }
      });
      return;
    }

    if (statusCode === 200) {
      state = 2;
      sock.setTimeout(0); // Stream indefinitely

      // Parse headers from camera
      let contentType = 'multipart/x-mixed-replace;boundary=frame';
      rawHeaders.split('\r\n').slice(1).forEach(line => {
        const colon = line.indexOf(':');
        if (colon > 0) {
          const k = line.slice(0, colon).trim().toLowerCase();
          const v = line.slice(colon + 1).trim();
          if (k === 'content-type') contentType = v;
        }
      });

      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no',
        'Connection': 'keep-alive'
      });

      const remainingBody = chunk.slice(Buffer.from(rawHeaders, 'latin1').length + 4);
      if (remainingBody.length > 0) {
        res.write(remainingBody);
      }
    } else if (statusCode === 401) {
      try { sock.destroy(); } catch (_) {}
      if (!res.headersSent) {
        res.status(401).json({ error: 'Camera authentication failed. Invalid username or password.' });
      }
    } else {
      try { sock.destroy(); } catch (_) {}
      if (!res.headersSent) {
        res.status(statusCode || 502).json({ error: `Camera returned HTTP ${statusCode}` });
      }
    }
  });

  req.on('close', () => {
    try { sock.destroy(); } catch (_) {}
  });
}

module.exports = {
  computeDigestHeader,
  findOpenPorts,
  probeHttpCamera,
  pipeHttpCameraStream
};
