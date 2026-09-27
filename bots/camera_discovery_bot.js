/**
 * CEOVA CCTV // Bot-Based AI Architecture
 * bots/camera_discovery_bot.js
 * 
 * Camera Discovery & Connection Bot (Phase 5)
 * 
 * Automatically detects IP cameras, NVRs, and CCTV streams on the local network.
 * Requires ONLY the CCTV username and password from the user:
 * 1. Discovers local subnet & active IP ranges.
 * 2. Sends ONVIF WS-Discovery probes (UDP 3702 multicast).
 * 3. Fast concurrent socket scans on camera ports (554, 8000, 37777, 80, 8080, 8899).
 * 4. Exhaustively probes manufacturer RTSP paths (Hikvision, Dahua, Uniview, Reolink, Tapo, ONVIF).
 * 5. Handles RTSP Basic & Digest authentication handshakes.
 * 6. Emits real-time scanning telemetry for the connect page.
 */

const net = require('net');
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');
const { BaseBot } = require('./base_bot');

const STREAM_PATTERNS = [
  // Hikvision / Hilook / Annke
  { brand: 'Hikvision', path: '/Streaming/Channels/101', port: 554, desc: 'Main Stream 1080p/4K' },
  { brand: 'Hikvision', path: '/Streaming/Channels/102', port: 554, desc: 'Sub Stream' },
  { brand: 'Hikvision', path: '/h264/ch1/main/av_stream', port: 554, desc: 'Legacy H.264 Stream' },
  { brand: 'Hikvision', path: '/Streaming/Channels/1', port: 554, desc: 'Channel 1 Stream' },
  
  // Dahua / CP Plus / Amcrest / Lorex / IMOU
  { brand: 'CP Plus / Dahua', path: '/cam/realmonitor?channel=1&subtype=0', port: 554, desc: 'Main Stream 1080p' },
  { brand: 'CP Plus / Dahua', path: '/cam/realmonitor?channel=1&subtype=1', port: 554, desc: 'Sub Stream' },
  { brand: 'CP Plus', path: '/live', port: 554, desc: 'Direct Live Stream' },
  { brand: 'CP Plus', path: '/ch01/0', port: 554, desc: 'Channel 1 Stream' },
  { brand: 'Dahua', path: '/cam/realmonitor?channel=1&subtype=0', port: 554, desc: 'Main Stream' },
  { brand: 'Dahua', path: '/cam/realmonitor?channel=1&subtype=1', port: 554, desc: 'Sub Stream' },
  
  // Uniview / UNV
  { brand: 'Uniview', path: '/unicast/c1/s0/live', port: 554, desc: 'Unicast Main Stream' },
  { brand: 'Uniview', path: '/media/video1', port: 554, desc: 'Media Video 1' },
  
  // Reolink
  { brand: 'Reolink', path: '/h264Preview_01_main', port: 554, desc: 'Main 4MP/5MP Stream' },
  { brand: 'Reolink', path: '/h264Preview_01_sub', port: 554, desc: 'Sub Stream' },
  
  // TP-Link Tapo / Kasa
  { brand: 'TP-Link Tapo', path: '/stream1', port: 554, desc: 'High Quality Stream' },
  { brand: 'TP-Link Tapo', path: '/stream2', port: 554, desc: 'Low Quality Stream' },
  
  // IP Webcam / Mobile CCTV / Phone RTSP (Works on ANY custom port e.g. 1025, 1029, 8080)
  { brand: 'IP Webcam', path: '/h264_pcm.sdp', desc: 'H.264 Live Stream' },
  { brand: 'IP Webcam', path: '/video', desc: 'Live MJPEG Stream' },
  { brand: 'IP Webcam', path: '/live', desc: 'Direct Live Stream' },
  { brand: 'IP Webcam', path: '/h264', desc: 'H.264 Stream' },

  // Generic ONVIF / RTSP / Axis / Bosch / CP Plus
  { brand: 'Generic ONVIF', path: '/onvif1', port: 554, desc: 'ONVIF Profile 1' },
  { brand: 'Generic ONVIF', path: '/onvif2', port: 554, desc: 'ONVIF Profile 2' },
  { brand: 'Generic RTSP', path: '/ch0', port: 554, desc: 'Channel 0 Stream' },
  { brand: 'Generic RTSP', path: '/live/ch0', port: 554, desc: 'Live Channel 0' },
  { brand: 'Generic RTSP', path: '/live.sdp', port: 554, desc: 'Live SDP Stream' },
  { brand: 'Generic RTSP', path: '/video1', port: 554, desc: 'Video Stream 1' },
  { brand: 'Generic RTSP', path: '/', port: 554, desc: 'Root RTSP Stream' }
];

const COMMON_CAMERA_PORTS = [554, 1025, 1026, 1027, 1028, 1029, 1030, 8000, 37777, 80, 8080, 8554, 8899, 8081];

class CameraDiscoveryBot extends BaseBot {
  constructor(options = {}) {
    super('camera_discovery_bot', '1.0.0', {
      socketTimeoutMs: options.socketTimeoutMs || 350,
      rtspTimeoutMs: options.rtspTimeoutMs || 1500,
      maxConcurrentSockets: options.maxConcurrentSockets || 50
    });

    this.isScanning = false;
    this.scanId = null;
    this.currentProgress = 0;
    this.currentStatus = 'IDLE';
    this.targetCredentials = { username: 'admin', password: '' };
    this.logs = [];
    this.discoveredHosts = [];
    this.matchedCameras = [];
    this.stopRequested = false;
    this.listeners = new Set();
  }

  async initialize() {
    await super.initialize();
    this.log('Camera Discovery Bot online and ready.');
    return true;
  }

  /**
   * Subscribe to live progress updates
   */
  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  emitUpdate(type, data = {}) {
    const event = {
      type,
      timestamp: new Date().toISOString(),
      scanId: this.scanId,
      progress: this.currentProgress,
      status: this.currentStatus,
      matchedCount: this.matchedCameras.length,
      ...data
    };

    if (data.message) {
      const logEntry = `[${new Date().toLocaleTimeString()}] ${data.message}`;
      this.logs.push(logEntry);
      if (this.logs.length > 200) this.logs.shift();
      event.log = logEntry;
    }

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[CameraDiscoveryBot] Listener error:', err);
      }
    }
  }

  /**
   * Start autonomous scanning for CCTV cameras using provided credentials
   */
  async startScan({ username = 'admin', password = '', targetIp = null, subnetHint = null }) {
    if (this.isScanning) {
      return { success: false, message: 'Scan already in progress', scanId: this.scanId };
    }

    this.isScanning = true;
    this.stopRequested = false;
    this.scanId = `scan_${Date.now()}`;
    this.currentProgress = 0;
    this.currentStatus = 'INITIALIZING';
    this.targetCredentials = { username: username.trim(), password: password || '' };
    this.logs = [];
    this.discoveredHosts = [];
    this.matchedCameras = [];

    this.emitUpdate('SCAN_STARTED', {
      message: `Initiating autonomous CCTV discovery for user '${this.targetCredentials.username}'...`
    });

    // Run asynchronously in the background
    this._runScanPipeline({ targetIp, subnetHint }).catch(err => {
      this.recordError(err);
      this.currentStatus = 'FAILED';
      this.isScanning = false;
      this.emitUpdate('SCAN_FAILED', { message: `Discovery error: ${err.message}` });
    });

    return {
      success: true,
      scanId: this.scanId,
      status: 'SCANNING'
    };
  }

  /**
   * Stop active scan
   */
  stopScan() {
    if (this.isScanning) {
      this.stopRequested = true;
      this.isScanning = false;
      this.currentStatus = 'STOPPED';
      this.emitUpdate('SCAN_STOPPED', { message: 'Camera discovery stopped by user.' });
      return { success: true, message: 'Scan stopped' };
    }
    return { success: false, message: 'No scan running' };
  }

  /**
   * Full Discovery Pipeline
   */
  async _runScanPipeline({ targetIp, subnetHint }) {
    try {
      // 1. Resolve Target IP List
      this.currentStatus = 'RESOLVING_NETWORK';
      this.currentProgress = 5;
      
      let candidateIps = [];

      if (targetIp && net.isIPv4(targetIp.trim())) {
        candidateIps = [targetIp.trim()];
        this.emitUpdate('STEP', { message: `Targeting specific IP: ${targetIp}` });
      } else {
        const subnets = this._detectLocalSubnets(subnetHint);
        const wifi = subnets.find(s => s.isWifi) || subnets[0];
        if (wifi) {
          this.emitUpdate('STEP', {
            message: `📡 Active Wi-Fi Interface: ${wifi.interfaceName} (Host IP: ${wifi.ip}, Subnet: ${wifi.cidr})`
          });
        } else {
          this.emitUpdate('STEP', {
            message: `Detected local network interfaces: ${subnets.map(s => s.cidr).join(', ')}`
          });
        }

        // Generate IP list
        candidateIps = this._generateCandidateIpList(subnets);
        this.emitUpdate('STEP', {
          message: `Prepared ${candidateIps.length} candidate addresses from Wi-Fi ARP neighbors, local subnet & camera factory defaults.`
        });
      }

      if (this.stopRequested) return;

      // 2. ONVIF WS-Discovery (UDP Multicast)
      this.currentStatus = 'ONVIF_DISCOVERY';
      this.currentProgress = 15;
      this.emitUpdate('STEP', { message: 'Dispatching ONVIF WS-Discovery probe (UDP 239.255.255.250:3702)...' });

      const onvifDevices = await this._discoverOnvif(1200);
      const onvifMap = new Map();
      if (onvifDevices.length > 0) {
        for (const d of onvifDevices) {
          onvifMap.set(d.ip, d);
        }
        this.emitUpdate('STEP', {
          message: `✓ Found ${onvifDevices.length} ONVIF-compliant device(s): ${onvifDevices.map(d => `${d.ip}${d.servicePort ? ':' + d.servicePort : ''} (${d.brand})`).join(', ')}`
        });

        // Fast-path: immediately probe discovered ONVIF camera(s) with user credentials
        this.emitUpdate('STEP', { message: 'Fast-verifying discovered ONVIF device(s) with provided credentials...' });
        const onvifCandidates = [];
        for (const d of onvifDevices) {
          const mainPort = d.servicePort || 554;
          onvifCandidates.push({ ip: d.ip, port: mainPort, service: 'ONVIF / RTSP Media', brand: d.brand });
          if ((mainPort === 80 || mainPort === 8080) && !onvifCandidates.some(h => h.ip === d.ip && h.port === 554)) {
            onvifCandidates.push({ ip: d.ip, port: 554, service: 'RTSP Media', brand: d.brand });
          }
        }

        const instantMatches = await this._probeStreamPaths(onvifCandidates);
        for (const m of instantMatches) {
          if (!this.matchedCameras.some(c => c.rtspUrl === m.rtspUrl)) {
            this.matchedCameras.push(m);
          }
        }

        // Prioritize ONVIF devices at top of candidate list
        const onvifIps = onvifDevices.map(d => d.ip);
        candidateIps = [...new Set([...onvifIps, ...candidateIps])];
      } else {
        this.emitUpdate('STEP', { message: 'No ONVIF multicast reply received (will perform direct socket probe).' });
      }

      if (this.stopRequested) return;

      // 3. Concurrent Port Sweep — ALWAYS run to find non-ONVIF cameras (e.g., phone on custom port)
      this.currentStatus = 'SCANNING_PORTS';
      this.emitUpdate('STEP', { message: `Sweeping camera media ports across candidate hosts...` });

      let openHosts = await this._scanCandidatePorts(candidateIps, (progressPercent, hostFound) => {
        this.currentProgress = Math.round(15 + progressPercent * 0.45); // 15% -> 60%
        if (hostFound) {
          this.discoveredHosts.push(hostFound);
          this.emitUpdate('HOST_FOUND', {
            message: `⚡ Discovered active CCTV service at ${hostFound.ip}:${hostFound.port} (${hostFound.service}${hostFound.brand ? ' - ' + hostFound.brand : ''})`,
            host: hostFound
          });
        }
      }, onvifMap);

      this.discoveredHosts = openHosts;
      this.emitUpdate('STEP', {
        message: `Port sweep complete. Found ${openHosts.length} candidate host(s) with open camera ports.`
      });

      if (this.stopRequested) return;

      // 4. Exhaustive RTSP Stream & Credential Handshake
      // Skip hosts already verified via ONVIF fast-path
      const alreadyMatchedIps = new Set(this.matchedCameras.map(c => c.ip));
      const hostsToProbe = openHosts.filter(h => !alreadyMatchedIps.has(h.ip));

      this.currentStatus = 'TESTING_CREDENTIALS';
      this.currentProgress = 60;
      this.emitUpdate('STEP', {
        message: `Probing manufacturer stream paths with credentials for '${this.targetCredentials.username}' on ${hostsToProbe.length} host(s)...`
      });

      const additionalMatches = await this._probeStreamPaths(hostsToProbe);
      for (const m of additionalMatches) {
        if (!this.matchedCameras.some(c => c.rtspUrl === m.rtspUrl)) {
          this.matchedCameras.push(m);
        }
      }

      // 5. Finalize
      this.currentProgress = 100;
      this.isScanning = false;

      if (this.matchedCameras.length > 0) {
        this.currentStatus = 'CAMERAS_FOUND';
        this.emitUpdate('SCAN_COMPLETED', {
          message: `🎉 Discovery Successful! Found and verified ${this.matchedCameras.length} CCTV camera(s)!`,
          cameras: this.matchedCameras,
          discoveredHosts: openHosts
        });
      } else {
        this.currentStatus = 'NO_CAMERAS_FOUND';
        this.emitUpdate('SCAN_COMPLETED', {
          message: `Scan finished. Discovered ${openHosts.length} active camera host(s), but password verification failed. You can connect directly below.`,
          cameras: [],
          discoveredHosts: openHosts
        });
      }

    } catch (err) {
      this.isScanning = false;
      this.currentStatus = 'FAILED';
      this.emitUpdate('SCAN_FAILED', { message: `Discovery error: ${err.message}` });
      throw err;
    }
  }

  /**
   * Harvest active neighbor IPs on Wi-Fi interface from ARP cache
   */
  _getArpNeighbors(interfaceName = 'en0') {
    const ips = [];
    try {
      const { execSync } = require('child_process');
      const out = execSync(`arp -an -i ${interfaceName}`, { timeout: 1500 }).toString();
      for (const line of out.split('\n')) {
        const m = line.match(/\((10\.[0-9.]+|192\.168\.[0-9.]+|172\.(?:1[6-9]|2[0-9]|3[0-1])\.[0-9.]+)\)/);
        if (m && !m[1].endsWith('.255') && !m[1].endsWith('.0')) {
          ips.push(m[1]);
        }
      }
    } catch (_e) {}
    return ips;
  }

  /**
   * Detect active IPv4 network interfaces (prioritizes Wi-Fi)
   */
  _detectLocalSubnets(subnetHint = null) {
    const interfaces = os.networkInterfaces();
    const subnets = [];

    // Prioritize Wi-Fi (en0 on macOS, wlan0 on Linux)
    const sortedEntries = Object.entries(interfaces).sort(([a], [b]) => {
      if (a === 'en0' || a.startsWith('wlan') || a.startsWith('wi')) return -1;
      if (b === 'en0' || b.startsWith('wlan') || b.startsWith('wi')) return 1;
      return 0;
    });

    for (const [name, addrs] of sortedEntries) {
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          const parts = addr.address.split('.');
          const baseSubnet = `${parts[0]}.${parts[1]}.${parts[2]}`;
          subnets.push({
            interfaceName: name,
            isWifi: name === 'en0' || name.startsWith('wlan') || name.startsWith('wi'),
            ip: addr.address,
            netmask: addr.netmask,
            cidr: addr.netmask === '255.255.0.0' ? `${parts[0]}.${parts[1]}.0.0/16` : `${baseSubnet}.0/24`,
            baseSubnet
          });
        }
      }
    }

    if (subnetHint && subnetHint.includes('.')) {
      const parts = subnetHint.trim().split('.');
      const customBase = `${parts[0]}.${parts[1]}.${parts[2]}`;
      subnets.unshift({
        interfaceName: 'custom_hint',
        isWifi: false,
        ip: `${customBase}.1`,
        netmask: '255.255.255.0',
        cidr: `${customBase}.0/24`,
        baseSubnet: customBase
      });
    }

    return subnets;
  }

  /**
   * Generate candidate IP list across Wi-Fi ARP neighbors + local subnet + camera factory defaults
   */
  _generateCandidateIpList(subnets) {
    const ips = new Set();
    const primary = subnets[0];

    // 1. Include previously registered cameras from database
    try {
      const { getDatabase } = require('../db/database');
      const db = getDatabase();
      const existing = db.getCameras('ORG-DEFAULT');
      for (const cam of existing) {
        const m = (cam.stream_url || '').match(/@([^:/]+)/);
        if (m && net.isIPv4(m[1])) ips.add(m[1]);
      }
    } catch (_e) {}

    // 2. Wi-Fi ARP neighbors (filtered & bounded to prevent campus ARP flooding)
    const arpNeighbors = this._getArpNeighbors(primary ? primary.interfaceName : 'en0');
    if (primary) {
      const pParts = primary.ip.split('.');
      const classBPrefix = `${pParts[0]}.${pParts[1]}.`;
      const classCPrefix = `${pParts[0]}.${pParts[1]}.${pParts[2]}.`;

      const classC = arpNeighbors.filter(ip => ip.startsWith(classCPrefix));
      const classB = arpNeighbors.filter(ip => ip.startsWith(classBPrefix) && !ip.startsWith(classCPrefix));
      const others = arpNeighbors.filter(ip => !ip.startsWith(classBPrefix));

      classC.forEach(ip => ips.add(ip));
      classB.slice(0, 50).forEach(ip => ips.add(ip));
      others.slice(0, 20).forEach(ip => ips.add(ip));

      // Local /24 subnet addresses (1..254)
      for (let i = 1; i <= 254; i++) {
        ips.add(`${primary.baseSubnet}.${i}`);
      }
    } else {
      arpNeighbors.slice(0, 80).forEach(ip => ips.add(ip));
    }

    // 3. Common factory defaults for major CCTV brands
    const factoryDefaults = [
      '192.168.1.64',   // Hikvision Default
      '192.168.1.108',  // Dahua Default
      '192.168.0.100',  // Generic IP Camera
      '192.168.1.100',  // Generic IP Camera
      '192.168.1.10',   // Uniview Default
      '192.168.0.10',   // CP Plus Default
      '192.168.1.20',   // Axis Default
      '192.168.1.250'   // Tapo/Kasa AP
    ];

    factoryDefaults.forEach(ip => ips.add(ip));

    return Array.from(ips);
  }

  /**
   * ONVIF WS-Discovery Probe via UDP Multicast (239.255.255.250:3702)
   */
  async _discoverOnvif(timeoutMs = 1200) {
    return new Promise((resolve) => {
      const socket = dgram.createSocket('udp4');
      const devices = [];
      const seenIps = new Set();

      const messageId = `uuid:${crypto.randomUUID()}`;
      const probeXml = `<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"
            xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"
            xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
            xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <e:Header>
    <w:MessageID>${messageId}</w:MessageID>
    <w:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>
    <w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>
  </e:Header>
  <e:Body>
    <d:Probe>
      <d:Types>dn:NetworkVideoTransmitter</d:Types>
    </d:Probe>
  </e:Body>
</e:Envelope>`;

      const timer = setTimeout(() => {
        try { socket.close(); } catch (_e) {}
        resolve(devices);
      }, timeoutMs);

      socket.on('message', (msg, rinfo) => {
        const msgStr = msg.toString();
        if (msgStr.includes('ProbeMatches') || msgStr.includes('NetworkVideoTransmitter')) {
          if (!seenIps.has(rinfo.address)) {
            seenIps.add(rinfo.address);
            const brandMatch = msgStr.match(/name\/([^\s<"'/]+)/i);
            const modelMatch = msgStr.match(/hardware\/([^\s<"'/]+)/i);
            const brand = brandMatch ? brandMatch[1].replace(/_/g, ' ') : 'Generic ONVIF';
            const model = modelMatch ? modelMatch[1] : '';

            // Extract service port from XAddrs URL if present
            const xaddrMatch = msgStr.match(/<(?:\w+:)?XAddrs>([^<]+)<\/(?:\w+:)?XAddrs>/i);
            let servicePort = null;
            if (xaddrMatch) {
              try {
                const u = new URL(xaddrMatch[1].trim().split(/\s+/)[0]);
                if (u.port) servicePort = parseInt(u.port, 10);
                else if (u.protocol === 'https:') servicePort = 443;
                else if (u.protocol === 'http:') servicePort = 80;
              } catch (_e) {}
            }

            devices.push({
              ip: rinfo.address,
              port: servicePort || 554,
              servicePort,
              protocol: 'ONVIF',
              brand: brand + (model ? ` (${model})` : '')
            });
          }
        }
      });

      socket.on('error', () => {
        clearTimeout(timer);
        try { socket.close(); } catch (_e) {}
        resolve(devices);
      });

      socket.bind(() => {
        try {
          socket.setBroadcast(true);
          socket.setMulticastTTL(2);
          const buf = Buffer.from(probeXml);
          socket.send(buf, 0, buf.length, 3702, '239.255.255.250');
        } catch (_err) {
          clearTimeout(timer);
          try { socket.close(); } catch (_e) {}
          resolve(devices);
        }
      });
    });
  }

  /**
   * Scan candidate IPs for open camera ports concurrently
   */
  async _scanCandidatePorts(ips, onProgress, onvifMap = new Map()) {
    const openHosts = [];
    const portsToScan = COMMON_CAMERA_PORTS;
    let completedChecks = 0;

    const targets = [];
    const seenTargets = new Set();

    for (const ip of ips) {
      const ports = new Set(portsToScan);
      const onvifDev = onvifMap.get(ip);
      if (onvifDev && onvifDev.servicePort) {
        ports.add(onvifDev.servicePort);
      }
      for (const port of ports) {
        const key = `${ip}:${port}`;
        if (!seenTargets.has(key)) {
          seenTargets.add(key);
          targets.push({ ip, port });
        }
      }
    }

    const totalChecks = targets.length;
    const concurrency = this.config.maxConcurrentSockets || 25;

    // Process targets in concurrent chunks
    for (let i = 0; i < targets.length; i += concurrency) {
      if (this.stopRequested) break;

      const chunk = targets.slice(i, i + concurrency);
      await Promise.all(chunk.map(async ({ ip, port }) => {
        const isOpen = await this._checkPortOpen(ip, port, this.config.socketTimeoutMs);
        completedChecks++;
        
        let foundHost = null;
        if (isOpen) {
          let service = 'Unknown';
          if (port === 554) service = 'RTSP Media';
          else if (port >= 1024 && port <= 1040) service = 'IP Webcam / RTSP Media';
          else if (port === 8554) service = 'RTSP Media Alternative';
          else if (port === 8000) service = 'Hikvision SDK/Media';
          else if (port === 37777) service = 'Dahua Media';
          else if (port === 80 || port === 8080 || port === 8081) service = 'Camera Web Admin';

          const onvifDev = onvifMap.get(ip);
          foundHost = {
            ip,
            port,
            service,
            brand: onvifDev ? onvifDev.brand : (port >= 1024 && port <= 1040 ? 'IP Webcam' : null)
          };
          openHosts.push(foundHost);
        }

        const percent = (completedChecks / Math.max(1, totalChecks)) * 100;
        if (onProgress) onProgress(percent, foundHost);
      }));
    }

    return openHosts;
  }

  /**
   * Fast TCP port check using raw socket
   */
  _checkPortOpen(host, port, timeoutMs = 600) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(timeoutMs);

      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });

      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });

      socket.connect(port, host);
    });
  }

  /**
   * Test manufacturer RTSP stream paths with user credentials on open hosts
   */
  async _probeStreamPaths(openHosts) {
    const matched = [];
    const seenUrls = new Set();
    const { username, password } = this.targetCredentials;

    // Filter hosts to media/RTSP endpoints (excluding pure HTTP web admin ports like 80/8080 from direct RTSP DESCRIBE)
    const rtspHosts = openHosts.filter(h => {
      if (h.port === 80 || h.port === 8080 || h.port === 8081 || h.port === 443) return false;
      return (
        h.port === 554 || 
        h.port === 8554 || 
        h.port === 8000 || 
        (h.port >= 1024 && h.port <= 1040) ||
        Boolean(h.brand) || 
        (h.service && (
          h.service.toLowerCase().includes('rtsp') || 
          h.service.toLowerCase().includes('webcam') || 
          h.service.toLowerCase().includes('media')
        ))
      );
    });
    
    // If no explicit RTSP port open but HTTP 80/8080/8081 open, also test standard port 554 on that IP
    const httpIps = openHosts.filter(h => h.port === 80 || h.port === 8080 || h.port === 8081).map(h => h.ip);
    for (const ip of httpIps) {
      if (!rtspHosts.some(h => h.ip === ip)) {
        rtspHosts.push({ ip, port: 554, service: 'RTSP (Inferred)' });
      }
    }

    let progressIndex = 0;
    const totalProbes = rtspHosts.length * STREAM_PATTERNS.length;

    for (const host of rtspHosts) {
      if (this.stopRequested) break;

      this.emitUpdate('STEP', {
        message: `Testing stream paths against ${host.ip}:${host.port} (${host.service}${host.brand ? ' - ' + host.brand : ''})...`
      });

      // Prioritize stream patterns based on detected host brand/service for instant matching
      const hostBrand = (host.brand || '').toLowerCase();
      const hostService = (host.service || '').toLowerCase();
      const isWebcam = hostBrand.includes('webcam') || hostService.includes('webcam') || (host.port >= 1024 && host.port <= 1040);
      const isDahua = hostBrand.includes('plus') || hostBrand.includes('dahua') || host.port === 37777;
      const isHikvision = hostBrand.includes('hikvision') || hostBrand.includes('hilook') || host.port === 8000;
      const isUniview = hostBrand.includes('uniview') || hostBrand.includes('unv');
      const isTapo = hostBrand.includes('tapo') || hostBrand.includes('tp-link');

      const prioritizedPatterns = [...STREAM_PATTERNS].sort((a, b) => {
        if (isWebcam) {
          if (a.brand === 'IP Webcam' && b.brand !== 'IP Webcam') return -1;
          if (b.brand === 'IP Webcam' && a.brand !== 'IP Webcam') return 1;
        } else if (isDahua) {
          const aDahua = a.brand.includes('CP Plus') || a.brand.includes('Dahua');
          const bDahua = b.brand.includes('CP Plus') || b.brand.includes('Dahua');
          if (aDahua && !bDahua) return -1;
          if (bDahua && !aDahua) return 1;
        } else if (isHikvision) {
          if (a.brand === 'Hikvision' && b.brand !== 'Hikvision') return -1;
          if (b.brand === 'Hikvision' && a.brand !== 'Hikvision') return 1;
        } else if (isUniview) {
          if (a.brand === 'Uniview' && b.brand !== 'Uniview') return -1;
          if (b.brand === 'Uniview' && a.brand !== 'Uniview') return 1;
        } else if (isTapo) {
          if (a.brand === 'TP-Link Tapo' && b.brand !== 'TP-Link Tapo') return -1;
          if (b.brand === 'TP-Link Tapo' && a.brand !== 'TP-Link Tapo') return 1;
        }
        return 0;
      });

      for (const pattern of prioritizedPatterns) {
        if (this.stopRequested) break;

        progressIndex++;
        this.currentProgress = Math.min(98, Math.round(60 + (progressIndex / Math.max(1, totalProbes)) * 38));

        const probePort = host.port || pattern.port || 554;
        const testUrl = `rtsp://${host.ip}:${probePort}${pattern.path}`;
        if (seenUrls.has(testUrl)) continue;
        seenUrls.add(testUrl);

        const result = await this._testRtspHandshake(host.ip, probePort, pattern.path, username, password);

        if (result.success) {
          const authRtspUrl = `rtsp://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host.ip}:${probePort}${pattern.path}`;
          const cameraInfo = {
            id: `CAM_${host.ip.replace(/\./g, '_')}_${probePort}`,
            ip: host.ip,
            port: probePort,
            path: pattern.path,
            brand: host.brand || pattern.brand,
            description: pattern.desc,
            rtspUrl: authRtspUrl,
            rawRtspUrl: testUrl,
            authType: result.authType,
            latencyMs: result.latencyMs,
            detectedAt: new Date().toISOString()
          };

          matched.push(cameraInfo);
          this.emitUpdate('CAMERA_MATCHED', {
            message: `🎯 Verified ${cameraInfo.brand} stream at ${testUrl}!`,
            camera: cameraInfo
          });

          // If we found a working main stream for this host, don't spam other paths on the same host
          break;
        }
      }
    }

    return matched;
  }

  /**
   * Execute real RTSP DESCRIBE probe over TCP with proper auth negotiation.
   *
   * Flow:
   *  1. Send DESCRIBE **without** any auth header to solicit the camera's challenge.
   *  2. If camera returns 200 OK → no auth required, success.
   *  3. If camera returns 401 + WWW-Authenticate: Digest → compute Digest response and retry.
   *  4. If camera returns 401 + WWW-Authenticate: Basic → retry with Basic auth.
   *  5. If camera returns bare 401 (no WWW-Authenticate) → try Basic auth as last resort.
   */
  _testRtspHandshake(host, port, path, username, password) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const socket = new net.Socket();
      socket.setTimeout(this.config.rtspTimeoutMs || 2000);
      let resolved = false;

      const finish = (result) => {
        if (resolved) return;
        resolved = true;
        socket.destroy();
        resolve(result);
      };

      let responseBuffer = '';
      let authPhase = 'initial'; // 'initial' | 'digest' | 'basic'
      const uri = `rtsp://${host}:${port}${path}`;

      // Step 1: DESCRIBE with NO auth (solicit challenge)
      const initialReq =
        `DESCRIBE ${uri} RTSP/1.0\r\n` +
        `CSeq: 1\r\n` +
        `User-Agent: CEOVA-DiscoveryBot/1.0\r\n` +
        `Accept: application/sdp\r\n\r\n`;

      socket.on('connect', () => {
        socket.write(initialReq);
      });

      socket.on('data', (chunk) => {
        responseBuffer += chunk.toString();

        // Wait until we have a complete RTSP response (header ends with \r\n\r\n)
        if (!responseBuffer.includes('\r\n\r\n')) return;

        // === Check for 200 OK at any phase ===
        if (responseBuffer.includes('RTSP/1.0 200')) {
          finish({
            success: true,
            authType: authPhase === 'digest' ? 'Digest' : (authPhase === 'basic' ? 'Basic' : 'None'),
            latencyMs: Date.now() - startTime
          });
          return;
        }

        // === Phase: Initial (no auth sent yet) ===
        if (authPhase === 'initial' && responseBuffer.includes('401')) {
          // Try Digest first if the camera offers it
          if (responseBuffer.includes('WWW-Authenticate: Digest') || responseBuffer.includes('WWW-Authenticate:Digest')) {
            const realmMatch = responseBuffer.match(/realm="([^"]+)"/);
            const nonceMatch = responseBuffer.match(/nonce="([^"]+)"/);
            const qopMatch = responseBuffer.match(/qop="?([^",\s]+)"?/i);

            if (realmMatch && nonceMatch) {
              authPhase = 'digest';
              const realm = realmMatch[1];
              const nonce = nonceMatch[1];
              const qop = qopMatch ? qopMatch[1] : null;

              const ha1 = crypto.createHash('md5').update(`${username}:${realm}:${password}`).digest('hex');
              const ha2 = crypto.createHash('md5').update(`DESCRIBE:${uri}`).digest('hex');

              let authHeader;
              if (qop && qop.toLowerCase().includes('auth')) {
                const nc = '00000001';
                const cnonce = crypto.randomBytes(4).toString('hex');
                const digestResp = crypto.createHash('md5').update(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`).digest('hex');
                authHeader = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${digestResp}", qop=auth, nc=${nc}, cnonce="${cnonce}"`;
              } else {
                const digestResp = crypto.createHash('md5').update(`${ha1}:${nonce}:${ha2}`).digest('hex');
                authHeader = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${digestResp}"`;
              }

              responseBuffer = '';
              socket.write(
                `DESCRIBE ${uri} RTSP/1.0\r\n` +
                `CSeq: 2\r\n` +
                `Authorization: ${authHeader}\r\n` +
                `User-Agent: CEOVA-DiscoveryBot/1.0\r\n` +
                `Accept: application/sdp\r\n\r\n`
              );
              return;
            }
          }

          // Camera returned 401 with Basic challenge, or bare 401 with no WWW-Authenticate → try Basic
          authPhase = 'basic';
          const basicAuth = Buffer.from(`${username}:${password}`).toString('base64');
          responseBuffer = '';
          socket.write(
            `DESCRIBE ${uri} RTSP/1.0\r\n` +
            `CSeq: 2\r\n` +
            `Authorization: Basic ${basicAuth}\r\n` +
            `User-Agent: CEOVA-DiscoveryBot/1.0\r\n` +
            `Accept: application/sdp\r\n\r\n`
          );
          return;
        }

        // === Phase: After Digest or Basic retry ===
        if (authPhase === 'digest' || authPhase === 'basic') {
          if (responseBuffer.includes('401')) {
            finish({ success: false, reason: `401 Unauthorized after ${authPhase} auth (wrong credentials)` });
          } else {
            // 404, 403, 500 etc.
            finish({ success: false, reason: `Non-200 after ${authPhase} auth` });
          }
          return;
        }

        // === Fallback: any other initial non-200 non-401 ===
        finish({ success: false, reason: 'Non-200/401 response' });
      });

      socket.on('timeout', () => {
        finish({ success: false, reason: 'Timeout' });
      });

      socket.on('error', () => {
        finish({ success: false, reason: 'Connection error' });
      });

      socket.connect(port, host);
    });
  }

  /**
   * Current bot status summary
   */
  getStatus() {
    return {
      isScanning: this.isScanning,
      scanId: this.scanId,
      status: this.currentStatus,
      progress: this.currentProgress,
      discoveredHostsCount: this.discoveredHosts.length,
      discoveredHosts: this.discoveredHosts,
      matchedCamerasCount: this.matchedCameras.length,
      matchedCameras: this.matchedCameras,
      logs: this.logs.slice(-50)
    };
  }

  /**
   * Health metrics implementation for BaseBot
   */
  getHealth() {
    return {
      ...super.getHealth(),
      isScanning: this.isScanning,
      currentStatus: this.currentStatus,
      progress: this.currentProgress,
      matchedCamerasCount: this.matchedCameras.length
    };
  }
}

module.exports = {
  CameraDiscoveryBot,
  STREAM_PATTERNS
};
