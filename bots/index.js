/**
 * CEOVA CCTV // Bot-Based AI Architecture
 * bots/index.js
 * 
 * Central Bot Registry and Lifecycle Manager.
 * Orchestrates the specialized bots, health reporting, and telemetry.
 */

const { BaseBot } = require('./base_bot');
const { TrackingBot } = require('./tracking_bot');
const { AdaptiveInferenceBot } = require('./adaptive_inference_bot');
const { HardwareBot } = require('./hardware_bot');
const { PerformanceSchedulerBot } = require('./performance_scheduler_bot');

class BotRegistry {
  constructor() {
    this.bots = new Map();
  }

  register(botInstance) {
    if (!botInstance || !(botInstance instanceof BaseBot)) {
      throw new Error('Can only register instances extending BaseBot');
    }
    this.bots.set(botInstance.botId, botInstance);
    return botInstance;
  }

  get(botId) {
    return this.bots.get(botId);
  }

  async initializeAll() {
    const results = {};
    for (const [botId, bot] of this.bots.entries()) {
      try {
        await bot.initialize();
        results[botId] = 'ONLINE';
      } catch (err) {
        results[botId] = 'OFFLINE';
      }
    }
    return results;
  }

  getAllHealth() {
    const health = {};
    for (const [botId, bot] of this.bots.entries()) {
      health[botId] = bot.getHealth();
    }
    return health;
  }

  async shutdownAll() {
    for (const bot of this.bots.values()) {
      await bot.shutdown();
    }
  }
}

// Default singleton registry pre-populated with Phase 1-4 Bots
const registry = new BotRegistry();

const hardwareBot = registry.register(new HardwareBot());
const performanceSchedulerBot = registry.register(new PerformanceSchedulerBot());
const trackingBot = registry.register(new TrackingBot());
const adaptiveInferenceBot = registry.register(new AdaptiveInferenceBot());

module.exports = {
  registry,
  BaseBot,
  TrackingBot,
  AdaptiveInferenceBot,
  HardwareBot,
  PerformanceSchedulerBot,
  hardwareBot,
  performanceSchedulerBot,
  trackingBot,
  adaptiveInferenceBot
};
