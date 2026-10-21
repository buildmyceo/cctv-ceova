/**
 * CEOVA CCTV // Electron Desktop Main Process
 * electron/main.js
 * 
 * Embedded desktop wrapper for macOS (MacBook) and Windows.
 * Launches the internal Express / WebSocket CCTV server inside Electron's Node runtime
 * and provides a native, hardware-accelerated desktop viewer window.
 */

const { app, BrowserWindow, shell, session, Menu } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');

let mainWindow = null;
const PORT = process.env.PORT || 3443;
const HTTP_PORT = process.env.HTTP_PORT || 3080;

// Prevent multiple instances of CCTV app running concurrently
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

/**
 * Start the backend server within Electron's embedded Node.js runtime
 */
function startBackendServer() {
  try {
    console.log('[ELECTRON] Initializing embedded CCTV backend server...');
    // server.js starts Express, WebSocket, RTSP proxy, SQLite DB, and Supabase client
    require('../server.js');
    console.log('[ELECTRON] Embedded CCTV server started successfully.');
  } catch (err) {
    console.error('[ELECTRON] Error starting embedded CCTV server:', err);
  }
}

/**
 * Poll localhost until server is accepting connections
 */
async function waitForServer(port, isHttps = true, maxAttempts = 30, intervalMs = 400) {
  const client = isHttps ? https : http;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await new Promise((resolve, reject) => {
        const req = client.get({
          hostname: '127.0.0.1',
          port: port,
          path: '/',
          rejectUnauthorized: false,
          timeout: 1000
        }, (res) => {
          resolve(true);
        });
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('timeout'));
        });
      });
      return true;
    } catch (_err) {
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }
  return false;
}

/**
 * Create native desktop application window
 */
async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'CEOVA CCTV // Autonomous Surveillance Hub',
    icon: path.join(__dirname, '../build/icon.png'),
    backgroundColor: '#0a0e17',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // Automatically bypass certificate verification for self-signed local HTTPS
  mainWindow.webContents.session.setCertificateVerifyProc((request, callback) => {
    const { hostname } = request;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0') {
      callback(0); // Trust local cert
    } else {
      callback(-3); // Default verification for other hosts
    }
  });

  // Automatically allow camera, microphone, and notifications for CCTV streams
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowedPermissions = ['media', 'camera', 'microphone', 'notifications', 'fullscreen'];
    if (allowedPermissions.includes(permission)) {
      callback(true);
    } else {
      callback(false);
    }
  });

  // Open external links in user's default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://localhost:') || url.startsWith('http://localhost:')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Show window when ready to display to prevent white flash
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Wait for server to become responsive
  const httpsReady = await waitForServer(PORT, true, 25, 400);
  const targetUrl = httpsReady ? `https://localhost:${PORT}` : `http://localhost:${HTTP_PORT}`;

  console.log(`[ELECTRON] Loading CCTV Web Interface from: ${targetUrl}`);
  mainWindow.loadURL(targetUrl);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Electron lifecycle management
app.whenReady().then(() => {
  startBackendServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // On macOS apps commonly remain active until the user quits explicitly with Cmd + Q
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
