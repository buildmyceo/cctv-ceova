/**
 * CEOVA CCTV // Hardware Diagnostics
 * hardware/hardware_detector.js
 * 
 * Hardware Telemetry & Runtime Configuration Recommender.
 * 
 * Detects CPU, RAM, GPU, VRAM, and CUDA acceleration availability.
 * Automatically recommends optimal video processing parameters (FPS, Re-ID interval, max tracks)
 * ensuring CPU-only fallback on small devices and GPU acceleration on high-end nodes.
 */

const os = require('os');
const { execSync } = require('child_process');

class HardwareDetector {
  /**
   * Run runtime hardware detection
   * @returns {Object} Hardware diagnostics & recommended processing config
   */
  static detect() {
    const cpus = os.cpus();
    const cpuCount = cpus.length;
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
    } catch (e) {
      // Check for Apple Silicon GPU
      if (platform === 'darwin' && (arch === 'arm64' || arch === 'arm')) {
        gpuName = `Apple Silicon GPU (${cpuModel})`;
        vramMb = Math.round(totalRamBytes / (1024 ** 2) * 0.70); // Unified memory architecture
      }
    }

    // Determine processing mode & recommendations
    let processingMode = 'CPU_FALLBACK';
    let recommendedDetectionFps = 6;
    let recommendedReidIntervalMs = 1500;
    let recommendedFaceIntervalMs = 2000;
    let recommendedMaxTrackedPeople = 8;

    if (cudaAvailable && vramMb >= 4000) {
      processingMode = 'CUDA_ACCELERATED';
      recommendedDetectionFps = 15;
      recommendedReidIntervalMs = 500;
      recommendedFaceIntervalMs = 800;
      recommendedMaxTrackedPeople = 32;
    } else if (platform === 'darwin' && arch === 'arm64') {
      processingMode = 'METAL_ACCELERATED';
      recommendedDetectionFps = 12;
      recommendedReidIntervalMs = 800;
      recommendedFaceIntervalMs = 1200;
      recommendedMaxTrackedPeople = 20;
    } else if (cpuCount >= 8 && totalRamGb >= 16) {
      processingMode = 'HIGH_PERF_CPU';
      recommendedDetectionFps = 8;
      recommendedReidIntervalMs = 1000;
      recommendedFaceIntervalMs = 1500;
      recommendedMaxTrackedPeople = 12;
    }

    return {
      hardware: {
        cpuModel,
        cpuCores: cpuCount,
        totalRamGb,
        freeRamGb,
        platform,
        architecture: arch,
        gpu: gpuName,
        vramMb,
        cudaAvailable
      },
      configuration: {
        processingMode,
        detectionFps: recommendedDetectionFps,
        reidIntervalMs: recommendedReidIntervalMs,
        faceIntervalMs: recommendedFaceIntervalMs,
        maxTrackedPeople: recommendedMaxTrackedPeople
      }
    };
  }
}

module.exports = {
  HardwareDetector
};
