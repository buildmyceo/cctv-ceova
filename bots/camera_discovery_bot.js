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
const http = require('http');
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

const COMMON_CAMERA_PORTS = [
  554, 8554, 8000, 37777, 34567, 9559, 9527, 80, 8080, 8081, 8082, 8088, 8090, 8008, 8500,
  8888, 5000, 5556, 4747, 5856, 1025, 1026, 1027, 1028, 1029, 1030, 1055, 18080, 8200, 9000,
  10554, 1935, 6667, 7070, 7777, 8880, 8889, 8899, 9090, 9999, 10000, 2020, 443
];

class CameraDiscoveryBot extends BaseBot {
  constructor(options = {}) {
    super('camera_discovery_bot', '1.0.0', {
      socketTimeoutMs: options.socketTimeoutMs || 800,
      rtspTimeoutMs: options.rtspTimeoutMs || 3000,
      maxConcurrentSockets: options.maxConcurrentSockets || 60
    });

    this.isScanning = false;
    this.scanId = null;
    this.currentProgress = 0;
    this.currentStatus = 'IDLE';
    this.targetCredentials = { username: '', password: '' };
    this.logs = [];
    this.discoveredHosts = [];
    this.matchedCameras = [];
    this.unverifiedDevices = [];
    this.stopRequested = false;
    this.listeners = new Set();
  }

  _sanitizeCamera(cam) {
    if (!cam) return cam;
    const sanitized = { ...cam };
    delete sanitized._internalAuthUrl;
    delete sanitized.password;
    if (sanitized.rtspUrl && sanitized.rtspUrl.includes('@')) {
      sanitized.rtspUrl = sanitized.rtspUrl.replace(/:([^:@]+)@/, ':••••@');
    }
    return sanitized;
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

    if (event.camera) {
      event.camera = this._sanitizeCamera(event.camera);
    }
    if (event.cameras && Array.isArray(event.cameras)) {
      event.cameras = event.cameras.map(c => this._sanitizeCamera(c));
    }

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
  async startScan({ username = '', password = '', targetIp = null, subnetHint = null, orgId = 'ORG-DEFAULT' }) {
    if (this.isScanning) {
      return { success: false, message: 'Scan already in progress', scanId: this.scanId };
    }

    this.isScanning = true;
    this.stopRequested = false;
    this.scanId = `scan_${Date.now()}`;
    this.currentProgress = 0;
    this.currentStatus = 'INITIALIZING';
    this.targetOrgId = orgId || 'ORG-DEFAULT';
    this.targetCredentials = { username: (username || '').trim(), password: password || '' };
    this.logs = [];
    this.discoveredHosts = [];
    this.matchedCameras = [];
    this.unverifiedDevices = [];

    this.emitUpdate('SCAN_STARTED', {
      message: 'Initiating autonomous CCTV device discovery on local network...'
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
      let customTargetPort = null;

      let cleanTargetIp = null;
      if (targetIp) {
        const rawT = targetIp.trim().replace(/^https?:\/\//i, '').replace(/^rtsp:\/\//i, '').split('/')[0];
        if (rawT.includes(':')) {
          const parts = rawT.split(':');
          cleanTargetIp = parts[0];
          customTargetPort = parseInt(parts[1], 10);
        } else {
          cleanTargetIp = rawT;
        }
      }

      if (cleanTargetIp && net.isIPv4(cleanTargetIp)) {
        candidateIps = [cleanTargetIp];
        this.emitUpdate('STEP', { message: `Targeting specific IP: ${cleanTargetIp}${customTargetPort ? ':' + customTargetPort : ''}` });
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

        // Step 1: Detect all live IP addresses on that Wi-Fi
        this.emitUpdate('STEP', {
          message: '🔍 Step 1: Broadcasting to awaken and detect all live IP addresses on the Wi-Fi network...'
        });
        const wifiLiveIps = await this._discoverAllWifiIpAddresses(subnets);
        this.emitUpdate('STEP', {
          message: `✓ Discovered ${wifiLiveIps.length} active device(s) on Wi-Fi (${wifi?.interfaceName || 'en0'}): ${wifiLiveIps.slice(0, 10).join(', ')}${wifiLiveIps.length > 10 ? ' ... and ' + (wifiLiveIps.length - 10) + ' more' : ''}`
        });

        // Step 2: Generate candidate IP list, prioritizing all detected Wi-Fi IPs first
        candidateIps = this._generateCandidateIpList(subnets, wifiLiveIps);
        this.emitUpdate('STEP', {
          message: `🔍 Step 2: Testing CCTV credentials against ${candidateIps.length} endpoints (prioritizing ${wifiLiveIps.length} detected Wi-Fi hosts)...`
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

        const { matched: instantMatches, unverified: instantUnverified } = await this._probeStreamPaths(onvifCandidates);
        for (const m of instantMatches) {
          if (!this.matchedCameras.some(c => c.id === m.id)) {
            this.matchedCameras.push(m);
          }
        }
        for (const u of instantUnverified) {
          if (!this.unverifiedDevices.some(d => d.ip === u.ip && d.port === u.port)) {
            this.unverifiedDevices.push(u);
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
      }, onvifMap, customTargetPort);

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
        message: `Probing stream protocols on ${hostsToProbe.length} candidate endpoint(s)...`
      });

      const { matched: additionalMatches, unverified: additionalUnverified } = await this._probeStreamPaths(hostsToProbe);
      for (const m of additionalMatches) {
        if (!this.matchedCameras.some(c => c.id === m.id)) {
          this.matchedCameras.push(m);
        }
      }
      for (const u of additionalUnverified) {
        if (!this.unverifiedDevices.some(d => d.ip === u.ip && d.port === u.port) && !this.matchedCameras.some(c => c.ip === u.ip)) {
          this.unverifiedDevices.push(u);
        }
      }

      // 5. Finalize
      this.currentProgress = 100;
      this.isScanning = false;

      if (this.matchedCameras.length > 0) {
        this.currentStatus = 'CAMERAS_FOUND';
        this.emitUpdate('SCAN_COMPLETED', {
          message: `Found and verified ${this.matchedCameras.length} active camera(s).`,
          cameras: this.matchedCameras,
          unverifiedDevices: this.unverifiedDevices,
          discoveredHosts: openHosts
        });
      } else {
        this.currentStatus = 'NO_CAMERAS_FOUND';
        const hasAuthFailed = this.unverifiedDevices.some(d => d.status === 'Authentication failed');
        const noDevFound = openHosts.length === 0;
        const finalMsg = noDevFound
          ? 'No camera detected on the available network.'
          : (hasAuthFailed
              ? 'Camera detected, but authentication failed.'
              : 'Device detected but the camera protocol is not supported.');

        this.emitUpdate('SCAN_COMPLETED', {
          message: finalMsg,
          cameras: [],
          unverifiedDevices: this.unverifiedDevices,
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
   * Bitwise IPv4 broadcast address calculation: (ip & mask) | (~mask & 255)
   */
  _calculateBroadcast(ip, netmask) {
    try {
      const ipParts = ip.split('.').map(Number);
      const maskParts = (netmask || '255.255.255.0').split('.').map(Number);
      const broadcastParts = ipParts.map((part, i) => (part & maskParts[i]) | (~maskParts[i] & 255));
      return broadcastParts.join('.');
    } catch (_) {
      const parts = ip.split('.');
      return `${parts[0]}.${parts[1]}.${parts[2]}.255`;
    }
  }

  /**
   * Send rapid broadcast ping to awaken any newly powered or IP-changed camera devices
   */
  async _wakeUpNetworkNeighbors(subnets = []) {
    try {
      const socket = dgram.createSocket('udp4');
      socket.bind(0, () => {
        try {
          socket.setBroadcast(true);
          const pingBuf = Buffer.from('CEOVA_DISCOVERY_PING');
          socket.send(pingBuf, 0, pingBuf.length, 9, '255.255.255.255', () => {});
          for (const s of subnets) {
            if (s.broadcast) {
              socket.send(pingBuf, 0, pingBuf.length, 9, s.broadcast, () => {});
            }
          }
        } catch (_) {}
      });
      await new Promise(r => setTimeout(r, 200));
      try { socket.close(); } catch (_) {}
    } catch (_) {}
  }

  /**
   * Actively discover all live IP addresses on the Wi-Fi network:
   * 1. Broadcast ICMP ping across the Wi-Fi broadcast address (e.g. 10.12.255.255) and 255.255.255.255
   * 2. Awaken devices via UDP broadcast
   * 3. Harvest all active entries from the OS ARP cache with verified hardware MACs
   */
  async _discoverAllWifiIpAddresses(subnets = []) {
    const discoveredIps = new Set();
    const hostIps = new Set(['127.0.0.1', 'localhost']);
    for (const s of subnets) {
      if (s.ip) hostIps.add(s.ip);
    }

    const wifi = subnets.find(s => s.isWifi) || subnets[0];
    const iface = wifi?.interfaceName || 'en0';

    // 1. Send ICMP broadcast ping on Wi-Fi broadcast and global broadcast
    try {
      const { exec } = require('child_process');
      const pingTasks = [];
      if (wifi?.broadcast) {
        pingTasks.push(new Promise(r => exec(`ping -c 2 -W 800 ${wifi.broadcast} 2>/dev/null`, { timeout: 2000 }, () => r())));
      }
      pingTasks.push(new Promise(r => exec(`ping -c 2 -W 800 255.255.255.255 2>/dev/null`, { timeout: 2000 }, () => r())));
      await Promise.all(pingTasks);
    } catch (_) {}

    // 2. Also send UDP broadcast ping
    await this._wakeUpNetworkNeighbors(subnets);

    // 3. Harvest active ARP neighbors with valid hardware MAC addresses
    for (const s of subnets) {
      const arpList = this._getArpNeighbors(s.interfaceName || iface);
      for (const ip of arpList) {
        if (!hostIps.has(ip)) discoveredIps.add(ip);
      }
    }

    return Array.from(discoveredIps);
  }

  /**
   * Harvest active neighbor IPs on Wi-Fi interface from ARP cache (filters out incomplete entries)
   */
  _getArpNeighbors(interfaceName = 'en0') {
    const ips = [];
    try {
      const { execSync } = require('child_process');
      let out = '';
      try {
        out = execSync(`arp -an -i ${interfaceName}`, { timeout: 1500 }).toString();
      } catch (_) {
        out = execSync('arp -an', { timeout: 1500 }).toString();
      }
      for (const line of out.split('\n')) {
        // Skip incomplete ARP entries (offline / dead IPs)
        if (line.includes('(incomplete)')) continue;

        // Verify valid hardware MAC address is present
        const hasMac = /at\s+([0-9a-f]{1,2}:[0-9a-f]{1,2}:[0-9a-f]{1,2}:[0-9a-f]{1,2}:[0-9a-f]{1,2}:[0-9a-f]{1,2})/i.test(line);
        if (!hasMac) continue;

        const m = line.match(/\(([0-9.]+)\)/);
        if (m && !m[1].endsWith('.255') && !m[1].endsWith('.0') && m[1] !== '224.0.0.251' && m[1] !== '239.255.255.250') {
          ips.push(m[1]);
        }
      }
    } catch (_e) {}
    return [...new Set(ips)];
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
          const broadcast = this._calculateBroadcast(addr.address, addr.netmask);
          subnets.push({
            interfaceName: name,
            isWifi: name === 'en0' || name.startsWith('wlan') || name.startsWith('wi'),
            ip: addr.address,
            netmask: addr.netmask,
            broadcast,
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
        broadcast: `${customBase}.255`,
        cidr: `${customBase}.0/24`,
        baseSubnet: customBase
      });
    }

    return subnets;
  }

  /**
   * Generate candidate IP list across detected Wi-Fi live devices, subnets, ARP neighbors, and factory defaults
   * Filters out the host machine's own IP address and prioritizes detected Wi-Fi devices first
   */
  _generateCandidateIpList(subnets, prioritizedWifiIps = []) {
    const hostIps = new Set(['127.0.0.1', 'localhost']);
    const orderedIps = new Set();

    // 0. Put actively discovered Wi-Fi live IPs FIRST and foremost
    if (Array.isArray(prioritizedWifiIps)) {
      for (const ip of prioritizedWifiIps) {
        if (!hostIps.has(ip)) orderedIps.add(ip);
      }
    }

    // 1. Harvest ARP neighbors across all detected interfaces
    for (const subnet of subnets) {
      if (subnet.ip) hostIps.add(subnet.ip);
      const arpNeighbors = this._getArpNeighbors(subnet.interfaceName || 'en0');
      for (const ip of arpNeighbors) {
        if (!hostIps.has(ip)) orderedIps.add(ip);
      }
    }

    // 2. High-probability camera factory defaults
    const CAMERA_FACTORY_DEFAULTS = [
      '192.168.1.64', '192.168.0.64', '192.168.1.108', '192.168.0.108',
      '192.168.1.10', '192.168.1.200', '192.168.1.250', '192.168.1.100',
      '192.168.0.100', '192.168.1.1', '192.168.0.1',
      '192.168.137.26', '192.168.137.251', '192.168.137.1',
      '192.168.43.1', '192.168.43.2', '172.20.10.1', '172.20.10.2'
    ];
    for (const defIp of CAMERA_FACTORY_DEFAULTS) {
      if (!hostIps.has(defIp)) orderedIps.add(defIp);
    }

    // 3. Append full /24 subnet addresses (1..254) for every detected subnet
    for (const subnet of subnets) {
      if (subnet.baseSubnet) {
        for (let i = 1; i <= 254; i++) {
          const ip = `${subnet.baseSubnet}.${i}`;
          if (!hostIps.has(ip)) orderedIps.add(ip);
        }
      }
    }

    // 4. Also scan top IP endpoints from common alternate camera & hotspot subnets
    const detectedBases = new Set(subnets.map(s => s.baseSubnet));
    const ALTERNATE_SUBNETS = ['192.168.0', '192.168.137', '192.168.43', '172.20.10'];
    for (const altBase of ALTERNATE_SUBNETS) {
      if (!detectedBases.has(altBase)) {
        for (let i = 1; i <= 20; i++) {
          orderedIps.add(`${altBase}.${i}`);
        }
        orderedIps.add(`${altBase}.50`);
        orderedIps.add(`${altBase}.64`);
        orderedIps.add(`${altBase}.100`);
        orderedIps.add(`${altBase}.108`);
        orderedIps.add(`${altBase}.200`);
        orderedIps.add(`${altBase}.250`);
        orderedIps.add(`${altBase}.251`);
      }
    }

    return Array.from(orderedIps);
  }

  /**
   * Multi-Protocol Discovery via UDP Multicast and Directed Broadcast
   * Sends ONVIF WS-Discovery, Hikvision SADP, Dahua DHIP, and SSDP probes across:
   * - 239.255.255.250 (Multicast)
   * - 255.255.255.255 (Global broadcast)
   * - Subnet broadcasts (192.168.1.255, etc.)
   */
  async _discoverOnvif(timeoutMs = 1200) {
    return new Promise((resolve) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
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

      const sadpProbe = Buffer.from('<?xml version="1.0" encoding="utf-8"?><Probe><Uuid>AD5256A7-7CF4-4e44-B521-E1430F9CA6EA</Uuid><Types>inquiry</Types></Probe>');
      const dahuaProbe = Buffer.from([
        0x20, 0x00, 0x00, 0x00, 0x44, 0x48, 0x49, 0x50,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
      ]);
      const ssdpProbe = Buffer.from(
        'M-SEARCH * HTTP/1.1\r\n' +
        'HOST: 239.255.255.250:1900\r\n' +
        'MAN: "ssdp:discover"\r\n' +
        'MX: 2\r\n' +
        'ST: ssdp:all\r\n\r\n'
      );

      const timer = setTimeout(() => {
        try { socket.close(); } catch (_e) {}
        resolve(devices);
      }, timeoutMs);

      socket.on('message', (msg, rinfo) => {
        const msgStr = msg.toString('utf8');
        const ip = rinfo.address;
        if (!seenIps.has(ip)) {
          if (msgStr.includes('ProbeMatches') || msgStr.includes('NetworkVideoTransmitter')) {
            seenIps.add(ip);
            const brandMatch = msgStr.match(/name\/([^\s<"'/]+)/i);
            const modelMatch = msgStr.match(/hardware\/([^\s<"'/]+)/i);
            const brand = brandMatch ? brandMatch[1].replace(/_/g, ' ') : 'Generic ONVIF';
            const model = modelMatch ? modelMatch[1] : '';

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
              ip,
              port: servicePort || 554,
              servicePort,
              protocol: 'ONVIF',
              brand: brand + (model ? ` (${model})` : '')
            });
          } else if (msgStr.includes('<ProbeMatch>') || msgStr.includes('Hikvision') || msgStr.includes('<DeviceDescription>')) {
            seenIps.add(ip);
            const portMatch = msgStr.match(/<HttpPort>(\d+)<\/HttpPort>/i);
            const devPort = portMatch ? parseInt(portMatch[1], 10) : 80;
            devices.push({
              ip,
              port: 554,
              servicePort: devPort,
              protocol: 'Hikvision-SADP',
              brand: 'Hikvision / Hilook'
            });
          } else if (msg.length >= 8 && msg.slice(4, 8).toString() === 'DHIP') {
            seenIps.add(ip);
            devices.push({
              ip,
              port: 554,
              servicePort: 37777,
              protocol: 'Dahua-DHIP',
              brand: 'Dahua / CP Plus'
            });
          } else if (msgStr.includes('LOCATION:') || msgStr.includes('location:') || msgStr.includes('camera') || msgStr.includes('IP Webcam')) {
            const locMatch = msgStr.match(/location:\s*http:\/\/([0-9.]+):(\d+)/i);
            const devPort = locMatch ? parseInt(locMatch[2], 10) : 8080;
            const devIp = locMatch ? locMatch[1] : ip;
            if (!seenIps.has(devIp)) {
              seenIps.add(devIp);
              devices.push({
                ip: devIp,
                port: devPort,
                servicePort: devPort,
                protocol: 'SSDP-UPnP',
                brand: 'IP Camera / Mobile Webcam'
              });
            }
          }
        }
      });

      socket.on('error', () => {
        clearTimeout(timer);
        try { socket.close(); } catch (_e) {}
        resolve(devices);
      });

      socket.bind(0, () => {
        try {
          socket.setBroadcast(true);
          try { socket.setMulticastTTL(4); } catch (_) {}
          const onvifBuf = Buffer.from(probeXml);

          const targets = ['239.255.255.250', '255.255.255.255', '192.168.1.255', '192.168.0.255', '192.168.137.255', '192.168.43.255'];
          for (const target of targets) {
            socket.send(onvifBuf, 0, onvifBuf.length, 3702, target, () => {});
            socket.send(sadpProbe, 0, sadpProbe.length, 37020, target, () => {});
            socket.send(dahuaProbe, 0, dahuaProbe.length, 37810, target, () => {});
            socket.send(ssdpProbe, 0, ssdpProbe.length, 1900, target, () => {});
          }
        } catch (_err) {
          clearTimeout(timer);
          try { socket.close(); } catch (_e) {}
          resolve(devices);
        }
      });
    });
  }

  /**
   * Ultra-Fast 2-Phase Port Scanner:
   * Phase 1: Rapid Sweep across candidate IPs on high-probability camera ports (~1.5s total)
   * Phase 2: Deep Port Sweep on detected alive hosts across all CCTV ports (~0.5s total)
   */
  async _scanCandidatePorts(ips, onProgress, onvifMap = new Map(), customTargetPort = null) {
    const openHosts = [];
    const openHostKeys = new Set();
    const aliveIps = new Set();

    // High probability camera ports for initial sweep (CCTV, NVR, DVR, IP Webcam, DroidCam)
    const PRIMARY_CAMERA_PORTS = [
      554, 8554, 8000, 8500, 37777, 34567, 9559, 9527, 80, 8080, 8081, 8088, 8888,
      5000, 5556, 4747, 5856, 1025, 1026, 1027, 1028, 1029, 1030, 1055, 18080,
      8200, 9000, 10554, 1935, 2020, 443, 8899, 6667, 7080, 7447, 8443, 9090,
      2563, 8082, 8083, 8085, 8090, 8181, 8880, 7070, 7777, 8889, 9999, 10000
    ];

    // Dynamically harvest any port from previously saved cameras in database
    try {
      const { getDatabase } = require('../db/database');
      const db = getDatabase();
      const savedCams = db.getCameras ? db.getCameras(this.targetOrgId || 'ORG-DEFAULT') : [];
      for (const cam of savedCams) {
        if (cam.stream_url) {
          try {
            const u = new URL(cam.stream_url);
            if (u.port) {
              const p = parseInt(u.port, 10);
              if (!PRIMARY_CAMERA_PORTS.includes(p)) PRIMARY_CAMERA_PORTS.unshift(p);
            }
          } catch (_) {}
        }
      }
    } catch (_) {}

    if (customTargetPort && !PRIMARY_CAMERA_PORTS.includes(customTargetPort)) {
      PRIMARY_CAMERA_PORTS.unshift(customTargetPort);
    }

    // Any host from ONVIF discovery is already alive
    for (const [onvifIp] of onvifMap.entries()) {
      aliveIps.add(onvifIp);
    }

    // High-priority devices (ARP neighbors & ONVIF devices) get all 45 ports
    const arpSet = new Set(this._getArpNeighbors());
    for (const [onvifIp] of onvifMap.entries()) arpSet.add(onvifIp);

    // Common top ports for general subnet IP sweep
    const QUICK_SUBSET_PORTS = [
      554, 8000, 8500, 37777, 34567, 80, 8080, 8082, 5000, 8554, 4747, 2563, 1025, 1029, 8888, 1935, 8899
    ];

    // Step 1: Rapid Phase 1 Sweep across candidate IPs
    const phase1Targets = [];
    for (const ip of ips) {
      const isHighPriority = arpSet.has(ip);
      const portsToScan = isHighPriority ? PRIMARY_CAMERA_PORTS : QUICK_SUBSET_PORTS;
      for (const port of portsToScan) {
        phase1Targets.push({ ip, port });
      }
    }

    const concurrency = Math.max(100, this.config.maxConcurrentSockets || 120);
    const sweepTimeout = 200;
    let completedPhase1 = 0;

    for (let i = 0; i < phase1Targets.length; i += concurrency) {
      if (this.stopRequested) break;

      const chunk = phase1Targets.slice(i, i + concurrency);
      await Promise.all(chunk.map(async ({ ip, port }) => {
        const isOpen = await this._checkPortOpen(ip, port, sweepTimeout);
        completedPhase1++;

        if (isOpen) {
          aliveIps.add(ip);
          const key = `${ip}:${port}`;
          if (!openHostKeys.has(key)) {
            openHostKeys.add(key);
            let service = 'Camera Media / HTTP';
            if (port === 554) service = 'RTSP Media';
            else if (port === 5856 || port === 4747) service = 'IP Webcam / Phone Stream';
            else if (port === 8554) service = 'RTSP Media Alternative';
            else if (port === 8000) service = 'Hikvision SDK/Media';
            else if (port === 37777) service = 'Dahua Media';
            else if (port === 34567) service = 'XM/NetSurveillance Media';
            else if (port === 80 || port === 8080 || port === 8081) service = 'Camera Web Admin / MJPEG';

            const onvifDev = onvifMap.get(ip);
            const foundHost = {
              ip,
              port,
              service,
              brand: onvifDev ? onvifDev.brand : (port === 5856 || port === 4747 ? 'IP Webcam' : 'Camera')
            };
            openHosts.push(foundHost);
            if (onProgress) onProgress(35, foundHost);
          }
        }
      }));

      const pct = Math.round((completedPhase1 / Math.max(1, phase1Targets.length)) * 40);
      if (onProgress) onProgress(pct, null);
    }

    // Step 2: Phase 2 Deep Sweep on Alive Hosts across all COMMON_CAMERA_PORTS
    const targetAlive = Array.from(aliveIps);
    const allPortsToProbe = customTargetPort ? [customTargetPort, ...COMMON_CAMERA_PORTS] : COMMON_CAMERA_PORTS;
    const phase2Targets = [];

    for (const ip of targetAlive) {
      for (const port of allPortsToProbe) {
        const key = `${ip}:${port}`;
        if (!openHostKeys.has(key)) {
          phase2Targets.push({ ip, port });
        }
      }
    }

    if (phase2Targets.length > 0) {
      for (let i = 0; i < phase2Targets.length; i += concurrency) {
        if (this.stopRequested) break;

        const chunk = phase2Targets.slice(i, i + concurrency);
        await Promise.all(chunk.map(async ({ ip, port }) => {
          const isOpen = await this._checkPortOpen(ip, port, 400);
          if (isOpen) {
            const key = `${ip}:${port}`;
            if (!openHostKeys.has(key)) {
              openHostKeys.add(key);
              let service = 'Camera Media / HTTP';
              if (port === 554) service = 'RTSP Media';
              else if (port === 5856 || port === 4747) service = 'IP Webcam / Phone Stream';
              else if (port >= 1024 && port <= 1040) service = 'IP Webcam / RTSP Media';
              else if (port === 8554) service = 'RTSP Media Alternative';
              else if (port === 8000) service = 'Hikvision SDK/Media';
              else if (port === 37777) service = 'Dahua Media';
              else if (port === 34567) service = 'XM Media';
              else if (port === 80 || port === 8080 || port === 8081) service = 'Camera Web Admin / MJPEG';

              const onvifDev = onvifMap.get(ip);
              const foundHost = {
                ip,
                port,
                service,
                brand: onvifDev ? onvifDev.brand : (port === 5856 || (port >= 1024 && port <= 1040) ? 'IP Webcam' : 'Camera')
              };
              openHosts.push(foundHost);
              if (onProgress) onProgress(50, foundHost);
            }
          }
        }));
      }
    }

    if (onProgress) onProgress(60, null);
    return openHosts;
  }

  /**
   * Fast TCP port check using raw socket
   */
  _checkPortOpen(host, port, timeoutMs = 250) {
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
   * Parallel RTSP & HTTP Stream Handshake across all open candidate hosts
   * Uses Promise.any to test all RTSP paths concurrently for sub-second verification
   */
  async _probeStreamPaths(openHosts) {
    const matched = [];
    const unverified = [];
    const { username, password } = this.targetCredentials;

    const RTSP_PORTS = new Set([
      554, 8554, 8000, 8500, 37777, 34567, 9559, 9527, 5556, 18080, 8200, 9000,
      10554, 1025, 1026, 1027, 1028, 1029, 1030, 1055, 4747, 5856, 8888, 1935, 2020,
      8082, 8090, 8008, 7070
    ]);
    const HTTP_ONLY_PORTS = new Set([80, 443, 8080, 8081, 8088, 5000, 5800, 3000, 3001, 6000, 7000]);

    const RTSP_PATHS = [
      '/Streaming/Channels/101', '/cam/realmonitor?channel=1&subtype=0',
      '/h264Preview_01_main', '/live', '/stream1', '/ch0', '/onvif1',
      '/h264_pcm.sdp', '/', '/ch01/0', '/unicast/c1/s0/live',
      '/Streaming/Channels/1', '/h264/ch1/main/av_stream',
      '/h264Preview_01_sub', '/stream2', '/onvif2', '/media/video1', '/video1'
    ];

    let progressIndex = 0;
    const totalHosts = Math.max(1, openHosts.length);

    await Promise.all(openHosts.map(async (host) => {
      if (this.stopRequested) return;

      this.emitUpdate('STEP', {
        message: `Testing stream protocols against ${host.ip}:${host.port}...`
      });

      let hostMatched = false;
      let hostAuthFailed = false;

      const tasks = [];

      // 1. Parallel RTSP Probe (all candidate camera ports except plain web 80/443)
      const tryRtsp = host.port !== 80 && host.port !== 443;
      if (tryRtsp) {
        const rtspTask = Promise.any(
          RTSP_PATHS.map(path =>
            this._testRtspHandshake(host.ip, host.port, path, username, password)
              .then(r => {
                if (r.success) return { type: 'RTSP', path, result: r };
                if (r.status === 'AUTH_FAILED') { hostAuthFailed = true; }
                return Promise.reject(new Error('not matched'));
              })
          )
        ).catch(() => null);
        tasks.push(rtspTask);
      }

      // 2. Concurrent HTTP / MJPEG Probe
      const httpTask = this._testHttpHandshake(host.ip, host.port, '/video', username, password)
        .then(r => {
          if (r.success) return { type: 'HTTP_MJPEG', path: r.path || '/video', result: r };
          if (r.status === 'AUTH_FAILED') hostAuthFailed = true;
          return null;
        }).catch(() => null);
      tasks.push(httpTask);

      // Await first matching protocol
      const results = await Promise.all(tasks);
      const firstSuccess = results.find(r => r !== null);

      if (firstSuccess) {
        const authPart = (username || password) ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
        const camId = `CAM_${host.ip.replace(/\./g, '_')}_${host.port}`;
        let cameraInfo = null;

        if (firstSuccess.type === 'RTSP') {
          const authRtspUrl = `rtsp://${authPart}${host.ip}:${host.port}${firstSuccess.path}`;
          const displayUrl = `rtsp://${host.ip}:${host.port}${firstSuccess.path}`;
          cameraInfo = {
            id: camId,
            ip: host.ip,
            port: host.port,
            path: firstSuccess.path,
            brand: host.brand || 'CCTV Camera',
            description: 'Live RTSP Stream',
            streamType: 'RTSP',
            rtspUrl: `/api/cameras/${camId}/stream.mjpg`,
            rawRtspUrl: displayUrl,
            displayUrl,
            _internalAuthUrl: authRtspUrl,
            authType: firstSuccess.result.authType || 'Digest',
            latencyMs: firstSuccess.result.latencyMs || 50,
            status: 'Connected',
            detectedAt: new Date().toISOString()
          };
        } else {
          const usedPath = firstSuccess.path || '/video';
          const internalAuth = `http://${authPart}${host.ip}:${host.port}${usedPath}`;
          const rawUrl = `http://${host.ip}:${host.port}${usedPath}`;
          cameraInfo = {
            id: camId,
            ip: host.ip,
            port: host.port,
            path: usedPath,
            brand: host.brand || 'IP Webcam',
            description: 'Live MJPEG Stream',
            streamType: 'HTTP_MJPEG',
            rtspUrl: `/api/cameras/${camId}/stream.mjpg`,
            rawRtspUrl: rawUrl,
            displayUrl: rawUrl,
            _internalAuthUrl: internalAuth,
            authType: firstSuccess.result.authType || 'Digest',
            latencyMs: firstSuccess.result.latencyMs || 50,
            status: 'Connected',
            detectedAt: new Date().toISOString()
          };
        }

        // Register into SQLite
        try {
          const { getDatabase } = require('../db/database');
          const db = getDatabase();
          const orgId = this.targetOrgId || 'ORG-DEFAULT';
          db.registerCamera(orgId, {
            id: camId,
            name: `${cameraInfo.brand || 'Camera'} (${host.ip}:${host.port})`,
            stream_url: cameraInfo._internalAuthUrl,
            zone_name: 'SALES_FLOOR'
          });
        } catch (_e) {}

        matched.push(cameraInfo);
        hostMatched = true;
        this.emitUpdate('CAMERA_MATCHED', {
          message: `Verified camera stream for ${cameraInfo.brand} (${host.ip}:${host.port})`,
          camera: cameraInfo
        });
      }

      progressIndex++;
      this.currentProgress = Math.min(98, Math.round(60 + (progressIndex / totalHosts) * 38));

      if (!hostMatched) {
        unverified.push({
          ip: host.ip,
          port: host.port,
          brand: host.brand || 'Camera Device',
          status: hostAuthFailed ? 'Authentication failed' : 'Unsupported',
          reason: hostAuthFailed ? 'Camera detected, but authentication failed.' : 'Device detected but the camera protocol is not supported.'
        });
      }
    }));

    return { matched, unverified };
  }

  /**
   * Fast HTTP handshake for MJPEG / snapshot camera endpoints (Supports Basic & Digest Auth)
   */
  async _testHttpHandshake(host, port, path, username, password) {
    const { probeHttpCamera } = require('../services/http_camera_client');
    const startTime = Date.now();
    try {
      const res = await probeHttpCamera(host, port, username, password, 2500);
      if (res.success) {
        return {
          success: true,
          authType: res.authType || 'Digest',
          latencyMs: Date.now() - startTime,
          contentType: 'multipart/x-mixed-replace',
          path: res.path || path
        };
      }
      if (res.status === 'AUTH_FAILED') {
        return { success: false, status: 'AUTH_FAILED', reason: '401 Unauthorized (wrong credentials)' };
      }
      return { success: false, status: res.status || 'UNSUPPORTED', reason: res.reason || 'Probe failed' };
    } catch (err) {
      return { success: false, status: 'ERROR', reason: err.message };
    }
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

        const speaksRtsp = responseBuffer.includes('RTSP/');

        // === Check for 200 OK at any phase ===
        if (responseBuffer.includes('RTSP/1.0 200') || responseBuffer.includes('RTSP/2.0 200')) {
          finish({
            success: true,
            isRtsp: true,
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
            finish({ success: false, isRtsp: speaksRtsp, status: 'AUTH_FAILED', reason: `401 Unauthorized after ${authPhase} auth (wrong credentials)` });
          } else {
            finish({ success: false, isRtsp: speaksRtsp, status: 'UNSUPPORTED', reason: `Non-200 after ${authPhase} auth` });
          }
          return;
        }

        // === Fallback: any other initial non-200 non-401 ===
        finish({ success: false, isRtsp: speaksRtsp, status: 'UNSUPPORTED', reason: 'Non-200/401 response' });
      });

      socket.on('timeout', () => {
        finish({ success: false, status: 'UNREACHABLE', reason: 'Timeout' });
      });

      socket.on('close', () => {
        finish({ success: false, isRtsp: false, status: 'UNSUPPORTED', reason: 'Socket closed' });
      });

      socket.on('error', (err) => {
        finish({ success: false, status: 'ERROR', reason: err.message || 'Connection error' });
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
      matchedCameras: this.matchedCameras.map(c => this._sanitizeCamera(c)),
      unverifiedDevices: this.unverifiedDevices,
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
