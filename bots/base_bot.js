/**
 * CEOVA CCTV // Bot-Based AI Architecture
 * bots/base_bot.js
 * 
 * BaseBot: Abstract contract and standard interface for all specialized bots.
 * Each bot provides:
 * - Clear input & clear output
 * - Independent configuration
 * - Logging & error handling
 * - Confidence scores where applicable
 * - Standardized health metrics: status, last_heartbeat, error_count, processing_latency_ms, version
 */

class BaseBot {
  /**
   * @param {string} botId - Unique identifier, e.g. 'tracking_bot'
   * @param {string} version - Semantic version
   * @param {Object} defaultConfig - Default configuration parameters
   */
  constructor(botId, version = '1.0.0', defaultConfig = {}) {
    if (!botId) {
      throw new Error('BaseBot requires a valid botId');
    }
    this.botId = botId;
    this.version = version;
    this.config = { ...defaultConfig };
    this.status = 'INITIALIZING'; // 'INITIALIZING', 'ONLINE', 'DEGRADED', 'OFFLINE'
    this.lastHeartbeat = Date.now();
    this.errorCount = 0;
    this.lastError = null;
    this.processingLatencyMs = 0;
    this.processedFramesCount = 0;
    this.initialized = false;
  }

  /**
   * Initialize resources, load models or caches
   */
  async initialize() {
    try {
      this.lastHeartbeat = Date.now();
      this.status = 'ONLINE';
      this.initialized = true;
      this.log('Initialized successfully');
      return true;
    } catch (err) {
      this.recordError(err);
      this.status = 'OFFLINE';
      throw err;
    }
  }

  /**
   * Configure or update bot parameters
   * @param {Object} options 
   */
  configure(options = {}) {
    this.config = { ...this.config, ...options };
    this.lastHeartbeat = Date.now();
    this.log('Configuration updated');
    return this.config;
  }

  /**
   * Process a single input cycle (must be implemented by child bot)
   * @param {Object} input 
   * @returns {Promise<Object>|Object}
   */
  async process(input) {
    throw new Error(`process() must be implemented by ${this.botId}`);
  }

  /**
   * Safe execution wrapper measuring latency and catching errors
   * @param {Object} input 
   * @returns {Promise<Object>}
   */
  async execute(input) {
    const startTime = Date.now();
    this.lastHeartbeat = startTime;
    try {
      if (!this.initialized && this.status !== 'ONLINE') {
        await this.initialize();
      }

      const result = await this.process(input);
      this.processingLatencyMs = Date.now() - startTime;
      this.processedFramesCount++;
      if (this.status === 'DEGRADED' && this.errorCount === 0) {
        this.status = 'ONLINE';
      }
      return result;
    } catch (err) {
      this.processingLatencyMs = Date.now() - startTime;
      this.recordError(err);
      return this.handleFailure(err, input);
    }
  }

  /**
   * Graceful failure handler preventing complete pipeline crashes
   */
  handleFailure(err, input) {
    return {
      bot: this.botId,
      status: 'error',
      error: err.message,
      timestamp: Date.now()
    };
  }

  /**
   * Record error telemetry
   */
  recordError(err) {
    this.errorCount++;
    this.lastError = {
      message: err.message,
      stack: err.stack,
      time: Date.now()
    };
    this.status = this.errorCount > 5 ? 'OFFLINE' : 'DEGRADED';
    this.logError(err);
  }

  /**
   * Standardized health monitor payload (Section 43)
   */
  getHealth() {
    this.lastHeartbeat = Date.now();
    return {
      bot_id: this.botId,
      status: this.status,
      version: this.version,
      last_heartbeat: new Date(this.lastHeartbeat).toISOString(),
      error_count: this.errorCount,
      processing_latency_ms: Number(this.processingLatencyMs.toFixed(2)),
      processed_count: this.processedFramesCount,
      last_error: this.lastError ? this.lastError.message : null
    };
  }

  /**
   * Structured logging
   */
  log(message, data = null) {
    const prefix = `[BOT:${this.botId}]`;
    if (data) {
      console.log(`${prefix} ${message}`, data);
    } else {
      console.log(`${prefix} ${message}`);
    }
  }

  logError(err) {
    console.error(`[BOT:${this.botId}] ERROR: ${err.message}`);
  }

  /**
   * Shutdown and release resources
   */
  async shutdown() {
    this.status = 'OFFLINE';
    this.log('Shutdown complete');
    return true;
  }
}

module.exports = {
  BaseBot
};
