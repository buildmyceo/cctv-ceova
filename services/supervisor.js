/**
 * CEOVA CCTV // Native Background Supervisor & Process Manager
 * services/supervisor.js
 * 
 * Provides:
 * - Independent background execution outside the CEOVA UI.
 * - Continuous dual supervision for Node.js CCTV Agent (port 8085/3443) and Python YOLO (port 5055).
 * - Automatic process crash detection and auto-recovery with backoff protection.
 * - Native system service integration (macOS LaunchAgent / Windows Task / systemd).
 * - Clean start, stop, restart, and status CLI commands.
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const { resolveDataDir } = require('../db/database');
const { resolveNodeBinary, resolvePythonBinary } = require('./runtime_resolver');

const DATA_DIR = resolveDataDir();
const RUN_DIR = path.join(DATA_DIR, 'run');
const LOGS_DIR = path.join(DATA_DIR, 'logs');

// Ensure directories exist
for (const dir of [RUN_DIR, LOGS_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const SUPERVISOR_PID_FILE = path.join(RUN_DIR, 'supervisor.pid');
const AGENT_PID_FILE = path.join(RUN_DIR, 'agent.pid');
const YOLO_PID_FILE = path.join(RUN_DIR, 'yolo.pid');
const SUPERVISOR_LOG_FILE = path.join(LOGS_DIR, 'supervisor.log');
const AGENT_LOG_FILE = path.join(LOGS_DIR, 'agent.log');
const YOLO_LOG_FILE = path.join(LOGS_DIR, 'yolo.log');

const LAUNCHD_PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.ceova.cctv.plist');

const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB per log file
const MAX_LOG_BACKUPS = 3;

/**
 * Bounded log file rotation: rotates file.log -> file.log.1 -> file.log.2 -> file.log.3
 */
function rotateLogIfNeeded(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.size < MAX_LOG_SIZE_BYTES) return;

    for (let i = MAX_LOG_BACKUPS - 1; i >= 1; i--) {
      const src = `${filePath}.${i}`;
      const dst = `${filePath}.${i + 1}`;
      if (fs.existsSync(src)) {
        if (i === MAX_LOG_BACKUPS - 1 && fs.existsSync(dst)) {
          fs.unlinkSync(dst);
        }
        try { fs.renameSync(src, dst); } catch (_e) {}
      }
    }
    const backup1 = `${filePath}.1`;
    if (fs.existsSync(backup1)) fs.unlinkSync(backup1);
    fs.renameSync(filePath, backup1);
  } catch (_e) {}
}

class ProcessSupervisor {
  constructor() {
    this.agentProcess = null;
    this.yoloProcess = null;
    this.isShuttingDown = false;
    this.heartbeatInterval = null;
    this.restartCounts = { agent: 0, yolo: 0 };
    this.lastRestartTimes = { agent: 0, yolo: 0 };
  }

  log(msg) {
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] [SUPERVISOR] ${msg}\n`;
    try {
      rotateLogIfNeeded(SUPERVISOR_LOG_FILE);
      fs.appendFileSync(SUPERVISOR_LOG_FILE, entry);
    } catch (_e) {}
    console.log(`[SUPERVISOR] ${msg}`);
  }

  isProcessAlive(pid) {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (_e) {
      return false;
    }
  }

  getPid(file) {
    try {
      if (fs.existsSync(file)) {
        const content = fs.readFileSync(file, 'utf8').trim();
        const pid = parseInt(content, 10);
        return isNaN(pid) ? null : pid;
      }
    } catch (_e) {}
    return null;
  }

  writePid(file, pid) {
    try {
      fs.writeFileSync(file, String(pid), 'utf8');
    } catch (e) {
      this.log(`Failed to write PID file ${file}: ${e.message}`);
    }
  }

  removePid(file) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (_e) {}
  }

  /**
   * Start Node.js CCTV Agent child process
   */
  startAgent() {
    if (this.isShuttingDown) return;

    const serverScript = path.join(__dirname, '..', 'server.js');
    this.log(`Starting CCTV Agent server (${serverScript})...`);

    rotateLogIfNeeded(AGENT_LOG_FILE);
    const agentOut = fs.openSync(AGENT_LOG_FILE, 'a');
    const agentErr = fs.openSync(AGENT_LOG_FILE, 'a');

    const env = {
      ...process.env,
      CEOVA_CCTV_DATA_DIR: DATA_DIR,
      CEOVA_CCTV_INSTALLED: 'true'
    };

    const nodeBin = resolveNodeBinary(path.join(__dirname, '..'));
    this.agentProcess = spawn(nodeBin, [serverScript], {
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', agentOut, agentErr],
      env,
      detached: false
    });

    const pid = this.agentProcess.pid;
    this.writePid(AGENT_PID_FILE, pid);
    this.log(`CCTV Agent server spawned with PID: ${pid} using node: ${nodeBin}`);

    this.agentProcess.on('exit', (code, signal) => {
      this.log(`CCTV Agent process (PID ${pid}) exited with code ${code} (${signal})`);
      this.removePid(AGENT_PID_FILE);
      this.agentProcess = null;

      if (!this.isShuttingDown) {
        this.handleProcessCrash('agent', () => this.startAgent());
      }
    });

    this.agentProcess.on('error', (err) => {
      this.log(`CCTV Agent process error: ${err.message}`);
    });
  }

  /**
   * Start Python YOLOv8 microservice child process
   */
  startYolo() {
    if (this.isShuttingDown) return;

    const yoloScript = path.join(__dirname, '..', 'vision', 'yolo_service.py');
    const pythonCmd = resolvePythonBinary(path.join(__dirname, '..'), DATA_DIR);
    this.log(`Starting Python YOLO Vision Service (${yoloScript}) using: ${pythonCmd}...`);

    rotateLogIfNeeded(YOLO_LOG_FILE);
    const yoloOut = fs.openSync(YOLO_LOG_FILE, 'a');
    const yoloErr = fs.openSync(YOLO_LOG_FILE, 'a');

    const env = {
      ...process.env,
      CEOVA_CCTV_DATA_DIR: DATA_DIR
    };

    this.yoloProcess = spawn(pythonCmd, [yoloScript], {
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', yoloOut, yoloErr],
      env,
      detached: false
    });

    const pid = this.yoloProcess.pid;
    this.writePid(YOLO_PID_FILE, pid);
    this.log(`Python YOLO service spawned with PID: ${pid}`);

    this.yoloProcess.on('exit', (code, signal) => {
      this.log(`Python YOLO process (PID ${pid}) exited with code ${code} (${signal})`);
      this.removePid(YOLO_PID_FILE);
      this.yoloProcess = null;

      if (!this.isShuttingDown) {
        this.handleProcessCrash('yolo', () => this.startYolo());
      }
    });

    this.yoloProcess.on('error', (err) => {
      this.log(`Python YOLO process error: ${err.message}`);
    });
  }

  /**
   * Automatic process recovery with backoff
   */
  handleProcessCrash(name, restartFn) {
    const now = Date.now();
    const lastTime = this.lastRestartTimes[name] || 0;

    // Reset crash counter if last crash was more than 60 seconds ago
    if (now - lastTime > 60000) {
      this.restartCounts[name] = 0;
    }

    this.restartCounts[name] = (this.restartCounts[name] || 0) + 1;
    this.lastRestartTimes[name] = now;

    if (this.restartCounts[name] > 5) {
      this.log(`CRITICAL: ${name} process crashed more than 5 times in 60s. Pausing auto-restart for 30s to prevent spin...`);
      setTimeout(() => {
        this.restartCounts[name] = 0;
        restartFn();
      }, 30000);
      return;
    }

    const delayMs = Math.min(1000 * Math.pow(2, this.restartCounts[name] - 1), 8000);
    this.log(`Auto-recovering ${name} (attempt ${this.restartCounts[name]}) in ${delayMs}ms...`);
    setTimeout(() => {
      if (!this.isShuttingDown) {
        restartFn();
      }
    }, delayMs);
  }

  /**
   * Periodic health checking for both processes
   */
  startHealthMonitor() {
    this.heartbeatInterval = setInterval(async () => {
      if (this.isShuttingDown) return;

      // 1. Probe Agent 8085
      try {
        const agentReq = http.get('http://127.0.0.1:8085/api/status', { timeout: 2000 }, (res) => {
          if (res.statusCode !== 200 && !this.agentProcess) {
            this.log('Agent status unhealthy, triggering restart...');
            this.startAgent();
          }
        });
        agentReq.on('error', () => {
          if (!this.agentProcess && !this.isShuttingDown) {
            this.startAgent();
          }
        });
      } catch (_e) {}

      // 2. Probe YOLO 5055
      try {
        const yoloReq = http.get('http://127.0.0.1:5055/health', { timeout: 2000 }, (res) => {
          if (res.statusCode !== 200 && !this.yoloProcess) {
            this.log('YOLO status unhealthy, triggering restart...');
            this.startYolo();
          }
        });
        yoloReq.on('error', () => {
          if (!this.yoloProcess && !this.isShuttingDown) {
            this.startYolo();
          }
        });
      } catch (_e) {}
    }, 10000);
  }

  /**
   * Run the supervisor in foreground/daemon loop
   */
  run() {
    this.writePid(SUPERVISOR_PID_FILE, process.pid);
    this.log(`Process Supervisor active (PID: ${process.pid})`);

    // Clean signal traps
    const handleShutdown = (signal) => {
      this.log(`Received ${signal}. Shutting down supervised services...`);
      this.stop();
      process.exit(0);
    };

    process.on('SIGTERM', () => handleShutdown('SIGTERM'));
    process.on('SIGINT', () => handleShutdown('SIGINT'));
    process.on('exit', () => {
      this.stop();
    });

    this.startAgent();
    this.startYolo();
    this.startHealthMonitor();
  }

  /**
   * Stop all supervised processes
   */
  stop() {
    this.isShuttingDown = true;
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.agentProcess) {
      try {
        this.agentProcess.kill('SIGTERM');
      } catch (_e) {}
    }

    if (this.yoloProcess) {
      try {
        this.yoloProcess.kill('SIGTERM');
      } catch (_e) {}
    }

    // Kill any orphaned PIDs from files
    const agentPid = this.getPid(AGENT_PID_FILE);
    if (agentPid && this.isProcessAlive(agentPid)) {
      try { process.kill(agentPid, 'SIGTERM'); } catch (_e) {}
    }

    const yoloPid = this.getPid(YOLO_PID_FILE);
    if (yoloPid && this.isProcessAlive(yoloPid)) {
      try { process.kill(yoloPid, 'SIGTERM'); } catch (_e) {}
    }

    this.removePid(AGENT_PID_FILE);
    this.removePid(YOLO_PID_FILE);
    this.removePid(SUPERVISOR_PID_FILE);

    this.log('All supervised services stopped cleanly.');
  }

  /**
   * Install native macOS LaunchAgent so service automatically starts on system boot
   */
  installLaunchAgent() {
    if (process.platform !== 'darwin') {
      this.log('LaunchAgent is only supported on macOS');
      return false;
    }

    const supervisorScript = path.resolve(__filename);
    const nodeBin = resolveNodeBinary(path.join(__dirname, '..'));
    const launchAgentsDir = path.dirname(LAUNCHD_PLIST_PATH);

    if (!fs.existsSync(launchAgentsDir)) {
      fs.mkdirSync(launchAgentsDir, { recursive: true });
    }

    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.ceova.cctv</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodeBin}</string>
        <string>${supervisorScript}</string>
        <string>run</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${SUPERVISOR_LOG_FILE}</string>
    <key>StandardErrorPath</key>
    <string>${SUPERVISOR_LOG_FILE}</string>
    <key>WorkingDirectory</key>
    <string>${path.resolve(__dirname, '..')}</string>
</dict>
</plist>`;

    fs.writeFileSync(LAUNCHD_PLIST_PATH, plistContent, 'utf8');
    this.log(`Installed LaunchAgent plist to ${LAUNCHD_PLIST_PATH}`);

    try {
      execSync(`launchctl unload "${LAUNCHD_PLIST_PATH}" 2>/dev/null || true`);
      execSync(`launchctl load "${LAUNCHD_PLIST_PATH}"`);
      this.log('Loaded LaunchAgent service into launchd.');
      return true;
    } catch (e) {
      this.log(`Notice during launchctl load: ${e.message}`);
      return false;
    }
  }

  uninstallLaunchAgent() {
    if (process.platform === 'darwin' && fs.existsSync(LAUNCHD_PLIST_PATH)) {
      try {
        execSync(`launchctl unload "${LAUNCHD_PLIST_PATH}" 2>/dev/null || true`);
        fs.unlinkSync(LAUNCHD_PLIST_PATH);
        this.log('Uninstalled and unloaded LaunchAgent plist.');
        return true;
      } catch (e) {
        this.log(`Error removing LaunchAgent: ${e.message}`);
      }
    }
    return false;
  }
}

// ─── CLI Management Interface ──────────────────────────────────────
const supervisor = new ProcessSupervisor();

async function main() {
  const command = process.argv[2] || 'status';

  if (command === 'run') {
    supervisor.run();
  } else if (command === 'start') {
    const existingPid = supervisor.getPid(SUPERVISOR_PID_FILE);
    if (existingPid && supervisor.isProcessAlive(existingPid)) {
      console.log(`Supervisor is already running with PID ${existingPid}`);
      process.exit(0);
    }

    // Spawn detached daemon process
    const nodeBin = resolveNodeBinary(path.join(__dirname, '..'));
    const child = spawn(nodeBin, [__filename, 'run'], {
      detached: true,
      stdio: 'ignore',
      cwd: path.join(__dirname, '..'),
      env: process.env
    });
    child.unref();
    console.log(`CEOVA CCTV Supervisor launched in background daemon mode (PID: ${child.pid})`);
    process.exit(0);
  } else if (command === 'stop') {
    const existingPid = supervisor.getPid(SUPERVISOR_PID_FILE);
    if (existingPid && supervisor.isProcessAlive(existingPid)) {
      console.log(`Stopping supervisor process ${existingPid}...`);
      try {
        process.kill(existingPid, 'SIGTERM');
        // Wait up to 3 seconds for supervisor process to terminate
        for (let i = 0; i < 30; i++) {
          if (!supervisor.isProcessAlive(existingPid)) break;
          require('child_process').execSync('sleep 0.1');
        }
      } catch (_e) {}
    }
    const agentPid = supervisor.getPid(AGENT_PID_FILE);
    if (agentPid && supervisor.isProcessAlive(agentPid)) {
      try { process.kill(agentPid, 'SIGTERM'); } catch (_e) {}
    }
    const yoloPid = supervisor.getPid(YOLO_PID_FILE);
    if (yoloPid && supervisor.isProcessAlive(yoloPid)) {
      try { process.kill(yoloPid, 'SIGTERM'); } catch (_e) {}
    }
    supervisor.stop();
    console.log('CEOVA CCTV background service stopped.');
    process.exit(0);
  } else if (command === 'restart') {
    console.log('Restarting CEOVA CCTV background service...');
    const existingPid = supervisor.getPid(SUPERVISOR_PID_FILE);
    if (existingPid && supervisor.isProcessAlive(existingPid)) {
      try { process.kill(existingPid, 'SIGTERM'); } catch (_e) {}
      await new Promise(r => setTimeout(r, 1000));
    }
    supervisor.stop();

    const nodeBin = resolveNodeBinary(path.join(__dirname, '..'));
    const child = spawn(nodeBin, [__filename, 'run'], {
      detached: true,
      stdio: 'ignore',
      cwd: path.join(__dirname, '..'),
      env: process.env
    });
    child.unref();
    console.log(`CEOVA CCTV Supervisor restarted (PID: ${child.pid})`);
    process.exit(0);
  } else if (command === 'install-service') {
    const ok = supervisor.installLaunchAgent();
    console.log(`Service installation ${ok ? 'successful' : 'completed with notices'}.`);
    process.exit(ok ? 0 : 1);
  } else if (command === 'uninstall-service') {
    supervisor.uninstallLaunchAgent();
    supervisor.stop();
    console.log('Service uninstalled.');
    process.exit(0);
  } else if (command === 'status') {
    const supervisorPid = supervisor.getPid(SUPERVISOR_PID_FILE);
    const agentPid = supervisor.getPid(AGENT_PID_FILE);
    const yoloPid = supervisor.getPid(YOLO_PID_FILE);

    const supervisorAlive = supervisor.isProcessAlive(supervisorPid);
    const agentAlive = supervisor.isProcessAlive(agentPid);
    const yoloAlive = supervisor.isProcessAlive(yoloPid);

    console.log('\n======================================================');
    console.log('  CEOVA CCTV // BACKGROUND SERVICE STATUS');
    console.log('======================================================');
    console.log(`  Supervisor Daemon:   ${supervisorAlive ? `RUNNING (PID ${supervisorPid})` : 'STOPPED'}`);
    console.log(`  Node.js CCTV Agent:  ${agentAlive ? `RUNNING (PID ${agentPid})` : 'STOPPED'}`);
    console.log(`  Python YOLO Service: ${yoloAlive ? `RUNNING (PID ${yoloPid})` : 'STOPPED'}`);
    console.log(`  Data Directory:      ${DATA_DIR}`);
    console.log(`  Agent Port:          8085 (Loopback)`);
    console.log(`  YOLO Port:           5055 (Microservice)`);
    console.log(`  Web & WebRTC Port:   3443 (HTTPS) / 3080 (HTTP)`);
    console.log(`  LaunchAgent Service: ${fs.existsSync(LAUNCHD_PLIST_PATH) ? 'INSTALLED (Reboot Recovery Enabled)' : 'NOT INSTALLED'}`);
    console.log('======================================================\n');
    process.exit(0);
  } else {
    console.log(`Unknown command: ${command}`);
    console.log('Usage: node supervisor.js [start|stop|restart|status|install-service|uninstall-service|run]');
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Supervisor error:', err);
    process.exit(1);
  });
}

module.exports = {
  ProcessSupervisor
};
