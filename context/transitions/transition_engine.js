/**
 * CEOVA CCTV // Context Engine
 * context/transitions/transition_engine.js
 * 
 * Transition Evaluator for Cross-Camera Movement.
 * Evaluates whether movement of a person between two cameras is physically plausible.
 */

const { TopologyGraph } = require('../camera_topology/topology_graph');

class TransitionEngine {
  constructor(topology = null) {
    this.topology = topology || new TopologyGraph();
  }

  /**
   * Evaluate travel time plausibility between two camera observations
   * @param {string} fromCam 
   * @param {number} fromTimeMs 
   * @param {string} toCam 
   * @param {number} toTimeMs 
   * @returns {Object} { plausible: boolean, score: number, elapsedSec, reason }
   */
  evaluateTransition(fromCam, fromTimeMs, toCam, toTimeMs) {
    if (fromCam === toCam) {
      return { plausible: true, score: 1.0, elapsedSec: 0, reason: 'Same camera tracking' };
    }

    const elapsedSec = Math.max(0, (toTimeMs - fromTimeMs) / 1000);
    const conn = this.topology.getConnection(fromCam, toCam);

    if (!conn) {
      // Non-adjacent cameras: impossible teleportation if under 15 seconds
      if (elapsedSec < 15) {
        return {
          plausible: false,
          score: 0.1,
          elapsedSec,
          reason: `No direct topology path between ${fromCam} and ${toCam}; teleportation in ${elapsedSec.toFixed(1)}s rejected`
        };
      }
      return {
        plausible: true,
        score: 0.5,
        elapsedSec,
        reason: `Indirect transit across facility (${elapsedSec.toFixed(1)}s)`
      };
    }

    // Direct edge exists: verify transit time bounds
    if (elapsedSec < conn.minSeconds) {
      return {
        plausible: false,
        score: 0.15,
        elapsedSec,
        reason: `Physically impossible transit speed: ${elapsedSec.toFixed(1)}s < min bound (${conn.minSeconds}s)`
      };
    }

    if (elapsedSec > conn.maxSeconds) {
      // Plausible but decay confidence after prolonged absence
      const decay = Math.max(0.4, 1.0 - ((elapsedSec - conn.maxSeconds) / 300));
      return {
        plausible: true,
        score: Number(decay.toFixed(2)),
        elapsedSec,
        reason: `Delayed transit between ${fromCam} and ${toCam} (${elapsedSec.toFixed(1)}s)`
      };
    }

    // Optimal transit window
    return {
      plausible: true,
      score: 0.95,
      elapsedSec,
      reason: `Optimal physical transit time (${elapsedSec.toFixed(1)}s within [${conn.minSeconds}s - ${conn.maxSeconds}s])`
    };
  }
}

module.exports = {
  TransitionEngine
};
