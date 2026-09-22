/**
 * CEOVA CCTV // Bot-Based AI Architecture
 * bots/hardware_bot.js
 * 
 * Hardware Detection Bot (Phase 4)
 * 
 * Inspects system hardware capabilities and classifies the host environment into
 * definitive runtime tiers: LOW, STANDARD, HIGH, or GPU.
 * Provides recommended configuration parameters for model execution, detection FPS,
 * inference buffers, and tracking capacity.
 */

const os = require('os');
const { execSync } = require('child_process');
const { BaseBot } = require('./base_bot');

class HardwareBot extends BaseBot {
  constructor(options = {}) {
    super('hardware_bot', '1.0.0', {
      forceProfile: options.forceProfile || null, // Allow overriding for testing
      vramThresholdGpuMb: options.vramThresholdGpuMb || 3500
    });

    this.profile = null;
    this.hardwareDetails = null;
    this.recommendedConfig = null;
  }

  async initialize() {
    await super.initialize();
    this.scanHardware();
    return true;
  }

  /**
   * Scan host hardware specifications
   */
  scanHardware() {
    const cpus = os.cpus() || [];
    const cpuCount = cpus.length || 1;
    const cpuModel = cpus[0] ? cpus[0].model : 'Generic CPU';
    const totalRamBytes = os.totalmem();
    const freeRamBytes = os.freemem();
    const totalRamGb = Number((totalRamBytes / (1024 ** 3)).toFixed(1));
    const freeRamGb = Number((freeRamBytes / (1024 ** 3)).toFixed(1));
    const platform = os.platform();
    const arch = os.arch();

    let cudaAvailable = false;
    let gpuName = 'Integrated / None';
    let vramMb = 0;

    // Check for NVIDIA GPU / CUDA via nvidia-smi
    try {
      const smiOutput = execSync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits', {
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore']
      }).toString().trim();

      if (smiOutput) {
        const [name, memory] = smiOutput.split(',');
        gpuName = (name || 'NVIDIA GPU').trim();
        vramMb = parseInt((memory || '0').trim(), 10);
        cudaAvailable = true;
      }
    } catch (_err) {
      // Check for Apple Silicon GPU (Metal)
      if (platform === 'darwin' && (arch === 'arm64' || arch === 'arm')) {
        gpuName = `Apple Silicon GPU (${cpuModel})`;
        vramMb = Math.round((totalRamBytes / (1024 ** 2)) * 0.70); // Unified memory architecture
      }
    }

    // Determine Hardware Profile Tier
    let profile = 'STANDARD';
    let detectionFps = 8;
    let maxTracks = 12;
    let bufferResolution = { width: 640, height: 360 };
    let modelVariant = 'mobilenet_v2';
    let acceleration = 'CPU_WASM';

    if (this.config.forceProfile) {
      profile = this.config.forceProfile.toUpperCase();
    } else if (cudaAvailable && vramMb >= this.config.vramThresholdGpuMb) {
      profile = 'GPU';
      detectionFps = 18;
      maxTracks = 32;
      bufferResolution = { width: 960, height: 540 };
      modelVariant = 'yolo_v8_or_tensorrt';
      acceleration = 'NVIDIA_CUDA';
    } else if (platform === 'darwin' && arch === 'arm64') {
      profile = 'GPU';
      detectionFps = 15;
      maxTracks = 24;
      bufferResolution = { width: 854, height: 480 };
      modelVariant = 'mobilenet_v2_webgl';
      acceleration = 'APPLE_METAL';
    } else if (cpuCount >= 8 && totalRamGb >= 16) {
      profile = 'HIGH';
      detectionFps = 12;
      maxTracks = 20;
      bufferResolution = { width: 640, height: 360 };
      modelVariant = 'mobilenet_v2';
      acceleration = 'MULTI_CORE_CPU';
    } else if (cpuCount <= 2 || totalRamGb <= 4.5) {
      profile = 'LOW';
      detectionFps = 4;
      maxTracks = 6;
      bufferResolution = { width: 480, height: 270 };
      modelVariant = 'mobilenet_v1_lite';
      acceleration = 'CPU_CONSTRAINED';
    }

    this.profile = profile;
    this.hardwareDetails = {
      cpu_model: cpuModel,
      cpu_cores: cpuCount,
      total_ram_gb: totalRamGb,
      free_ram_gb: freeRamGb,
      platform,
      architecture: arch,
      gpu_name: gpuName,
      vram_mb: vramMb,
      cuda_available: cudaAvailable
    };

    this.recommendedConfig = {
      profile,
      acceleration,
      recommended_detection_fps: detectionFps,
      recommended_max_tracks: maxTracks,
      buffer_resolution: bufferResolution,
      recommended_model: modelVariant
    };

    this.log(`Hardware profiled as ${profile} (${gpuName})`);
  }

  /**
   * Real-time system telemetry check (CPU & RAM utilization)
   */
  getSystemTelemetry() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memUsagePercent = Number((((totalMem - freeMem) / totalMem) * 100).toFixed(1));

    // Fast CPU load estimate via 1-minute load avg or cpu times
    const loadAvg = os.loadavg();
    const cpus = os.cpus();
    const cpuCount = cpus.length || 1;
    const cpuPercent = Number(Math.min(100, (loadAvg[0] / cpuCount) * 100).toFixed(1));

    return {
      cpu_usage_percent: cpuPercent,
      memory_usage_percent: memUsagePercent,
      free_ram_gb: Number((freeMem / (1024 ** 3)).toFixed(1)),
      total_ram_gb: Number((totalMem / (1024 ** 3)).toFixed(1)),
      timestamp: Date.now()
    };
  }

  async process(_input = {}) {
    if (!this.profile) {
      this.scanHardware();
    }
    const telemetry = this.getSystemTelemetry();

    return {
      bot: this.botId,
      type: 'hardware_profile',
      timestamp: Date.now(),
      profile: this.profile,
      hardware: this.hardwareDetails,
      configuration: this.recommendedConfig,
      telemetry
    };
  }
}

module.exports = {
  HardwareBot
};
